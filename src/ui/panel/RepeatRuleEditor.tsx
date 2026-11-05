/**
 * 側板「重複」區段（M3 ④ WP3）——掛／改／清除重複規則的**唯一 UI 入口**，以及定期券的班次検印。
 *
 * 沒有原型可逐字移植（原型時代還沒有重複引擎）→ 只拼既有元件（模式／頻率＝共用 Segmented 經 ./Choice、起算日＝共用 DateChip〔UI 丙-3〕、NumberField／
 * FieldRow／SectionRule）與 techo 語彙（`.opts .status` 小方標當星期 chip），不自創視覺。
 * 區段小標右側的淡注記（SectionRule 的 aside）＝ describeRule 的一句話收據，與今日列／大綱列同一句。
 *
 * 規則與草稿只有一份（手機殼班 D-主-82）：純規則在 `./panelRules`、草稿的寫回在 `./useRepeatDraft`，手機詳情頁的重複段用同一份。
 * 資料流：草稿（Draft）→ buildRule → 去抖 400ms → `nodeStore.setRepeatRule`（ActionResult 失敗吐 toast 並還原草稿）。
 *   ⚠ 規則不完整（每週還沒選星期／每月沒填日／完成後沒填天數／結束條件沒填好）**不送**——送出去 parseRule 會 null，
 *     等於把票清成乘車券。這種狀態在 aside 印一句提示，等主人補齊。
 *   ⚠ 「是不是定期券」一律 `parseRule(repeat_rule) !== null`，不看欄位非空
 *     （種子的 legacy 文字票「量體重記錄」必須顯示為「不重複」的乘車券）。
 *
 * 班次的済／運休不走 nodes.status：済＝`setCompleted`（repository 自動落在目前班次上）、
 * 運休＝`skipOccurrence`（不動 status、不寫済事件）；目前班次結局讀 `nodeStore.currentOccurrences[id]`
 * （undefined＝這班還沒交代），與今日列的 `TodayRow.occurrence` 是同一把尺。
 * 只改這一班的日期（⑥ D-主-295）＝検印區的「本班日期」列，寫入走 nodeFlows.moveRunFlow（推遲小卡、手機 ⋯、行程表拖曳同一支）。
 *
 * 列車／車廂有子項也能掛重複（⑥ D-主-298：子項＝每一班要做的步驟）；定期券底下不能再掛定期券由 repository 擋，useRepeatDraft 把原句 toast 出來。
 */
import { useEffect, useRef, useState } from "react";
import { WEEKDAY_LABEL, WEEKDAY_ORDER, parseRule, runOrigin, type NodeRow } from "../../domain";
import { REPEATABLE_KINDS } from "../../data";
import { todayKey } from "../../lib/date";
import { useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";
import { FieldRow, NumberField, SectionRule } from "./fields";
import { Choice } from "./Choice";
import { DateChip } from "../common/DateChip";
import { shortDayKey } from "../common/DatePicker";
import { RunTimeRow } from "./TimeField";
import { moveRunFlow, panelStampFlow, panelSuspendFlow } from "../outline/nodeFlows";
import {
  COUNT_MAX,
  END_OPTIONS,
  FREQ_OPTIONS,
  INTERVAL_UNIT,
  LAST_WEEKDAY_WHY,
  MODE_OPTIONS,
  intervalMax,
  pickEnd,
  pickFreq,
  repeatAside,
  runDateBounds,
  stampViewOf,
  switchFare,
  switchMode,
  toggleWeekday,
  type RepeatDraft,
} from "./panelRules";
import { useDoneRuns, useRepeatDraft } from "./useRepeatDraft";
import { fareClass } from "../outline/OutlineRow";

/* ───────────── 兩殼共用的小規則 ───────────── */

/* ───────────── 票種＋重複（草稿共用） ───────────── */

/**
 * 側板的重複規則草稿（收官磨光 Q1）：「票種」列與「重複」段吃同一份草稿——兩份各自去抖寫回會互相蓋掉。
 * 手機詳情頁同一個形狀（TaskFields 呼叫 useRepeatDraft、往下傳給票種列與 MobileRepeatSection）。
 */
export function usePanelRepeat(node: NodeRow): PanelRepeat {
  return useRepeatDraft(node);
}

export interface PanelRepeat {
  draft: RepeatDraft;
  push(next: RepeatDraft): void;
}

/**
 * 「票種」列（收官磨光 Q1；語義＝手機詳情頁的票種分段鈕）：乘車券／臨時券⇄定期券＝有沒有重複規則。
 * 切定期券＝草稿換成「固定排程」（switchFare，手機同一支），下面的重複段跟著展開；切回＝清規則（toast「已改回乘車券…」）。
 * 不可重複的 kind（支線／路線…）不畫。
 */
export function FareRow({ node, repeat }: { node: NodeRow; repeat: PanelRepeat }) {
  if (!REPEATABLE_KINDS.includes(node.kind)) return null;
  const { draft, push } = repeat;
  // 一般那一格的字＝大綱那支共用的 fareClass（臨時券／乘車券），手機同一份
  const plain = fareClass({ ...node, repeat_rule: null }).label;
  return (
    <FieldRow label="票種">
      <Choice
        value={draft.mode === "none" ? "plain" : "teiki"}
        options={[
          { value: "plain", label: plain },
          { value: "teiki", label: "定期券" },
        ]}
        onChange={(v) => push(switchFare(draft, v === "teiki"))}
        ariaLabel="票種"
      />
    </FieldRow>
  );
}

/* ───────────── 重複區段 ───────────── */

/**
 * 「重複」區段（⑥ D-主-297 多間隔與結束；手機同一份草稿）。
 * 不可重複的 kind（支線／路線…）直接不畫。草稿由呼叫端的 usePanelRepeat 給（與「票種」列共用一份）。
 */
export function RepeatSection({ node, repeat }: { node: NodeRow; repeat: PanelRepeat }) {
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const { draft, push } = repeat;
  const done = useDoneRuns(node);

  if (!REPEATABLE_KINDS.includes(node.kind)) return null;

  /**
   * 規則不完整時**不送**（送出去會把票清成乘車券），票就仍照庫裡那一條發車——aside 把這個真相說出口，
   * 別讓主人關掉側板後以為已經改好（M3 ④ 評審 should-8；預帶值已讓這種狀態很難撞上，這是最後一道保險）。不重複＝段頭不印字。
   */
  const aside = draft.mode === "none" ? undefined : repeatAside(draft, node.repeat_rule, done);

  return (
    <>
      <SectionRule title="重複" aside={aside} />
      <div className="fields">
        <FieldRow label="模式">
          <Choice
            value={draft.mode}
            options={MODE_OPTIONS}
            onChange={(v) => {
              if (v !== draft.mode) push(switchMode(draft, v));
            }}
            ariaLabel="重複方式"
          />
        </FieldRow>

        {draft.mode === "fixed" && (
          <FieldRow label="頻率">
            <Choice
              value={draft.freq}
              options={FREQ_OPTIONS}
              onChange={(v) => {
                if (v !== draft.freq) push(pickFreq(draft, v));
              }}
              ariaLabel="重複頻率"
            />
          </FieldRow>
        )}

        {draft.mode === "fixed" && (
          <FieldRow label="間隔">
            <IntervalField draft={draft} push={push} />
          </FieldRow>
        )}

        {draft.mode === "fixed" && draft.freq === "weekly" && (
          <FieldRow label="星期">
            <WeekdayChips value={draft.byweekday} onChange={(v) => push({ ...draft, byweekday: v })} />
          </FieldRow>
        )}

        {draft.mode === "fixed" && draft.freq === "monthly" && (
          <FieldRow label="每月">
            <NumberField
              value={draft.monthday}
              onCommit={(v) => push({ ...draft, monthday: v })}
              ariaLabel="每月幾日"
              unit="日"
              min={1}
              max={31}
              placeholder="1"
            />
          </FieldRow>
        )}

        {draft.mode === "after" && (
          <FieldRow label="完成後">
            <NumberField
              value={draft.days}
              onCommit={(v) => push({ ...draft, days: v })}
              ariaLabel="完成後幾天"
              unit="天"
              min={1}
              placeholder="3"
            />
          </FieldRow>
        )}

        {draft.mode !== "none" && (
          <FieldRow label="起算日">
            {/* 起算日一定有值（清掉＝今天），所以不給清除；過去日照舊可挑（舊 DateField 也沒有 min） */}
            <DateChip
              date={draft.start}
              onPick={(v) => push({ ...draft, start: v ?? todayKey(dayStartHour) })}
              allowPast
              label="起算日"
            />
          </FieldRow>
        )}

        {draft.mode !== "none" && (
          <FieldRow label="結束">
            <Choice
              value={draft.endMode}
              options={END_OPTIONS}
              onChange={(v) => {
                if (v !== draft.endMode) push(pickEnd(draft, v, todayKey(dayStartHour), done));
              }}
              ariaLabel="結束條件"
            />
          </FieldRow>
        )}

        {draft.mode !== "none" && draft.endMode === "until" && (
          <FieldRow label="結束日">
            <DateChip
              date={draft.until}
              onPick={(v) => {
                if (v) push({ ...draft, until: v });
              }}
              min={draft.start}
              label="結束日"
            />
          </FieldRow>
        )}

        {draft.mode !== "none" && draft.endMode === "count" && (
          <FieldRow label="次數">
            <div className="num-row">
              <NumberField
                value={draft.count}
                onCommit={(v) => push({ ...draft, count: v })}
                ariaLabel="做滿幾次"
                unit="次"
                min={done + 1}
                max={COUNT_MAX}
              />
              <span className="meta">已做 {done} 次</span>
            </div>
          </FieldRow>
        )}
      </div>
    </>
  );
}

/**
 * 間隔：每 [N] 週（N＝1 也顯示）。間隔一定有值，清空＝不算數、還原——
 * NumberField 清空後外面的值沒變就不會跟回來，所以換一個 key 重掛（同一個值）。
 */
function IntervalField({ draft, push }: { draft: RepeatDraft; push(next: RepeatDraft): void }) {
  const [rev, setRev] = useState(0);
  const unit = INTERVAL_UNIT[draft.freq];
  return (
    <div className="num-row">
      <span className="meta">每</span>
      <NumberField
        key={rev}
        value={draft.interval}
        onCommit={(v) => {
          if (v === null) setRev((r) => r + 1);
          else push({ ...draft, interval: v });
        }}
        ariaLabel={`每幾${unit}`}
        unit={unit}
        min={1}
        max={intervalMax(draft.freq)}
      />
    </div>
  );
}

/** 七顆星期 chip（多選）＝原型 `.status` 小方標；排列一…六・日，存的是 getDay() 索引 */
function WeekdayChips({ value, onChange }: { value: number[]; onChange: (v: number[]) => void }) {
  return (
    <div role="group" aria-label="星期" className="opts week">
      {WEEKDAY_ORDER.map((d) => {
        const on = value.includes(d);
        return (
          <button
            key={d}
            type="button"
            aria-label={`每週${WEEKDAY_LABEL[d]}`}
            aria-pressed={on}
            // 最後一顆不給熄（toggleWeekday 原樣回傳＝沒變）：每週至少要有一個星期，熄了規則就不完整、寫不回去——
            // 點了 toast 說為什麼（同手機；第三輪，原本點了什麼都不發生）
            onClick={() => {
              const next = toggleWeekday(value, d);
              if (next !== value) onChange(next);
              else useUiStore.getState().showToast({ message: LAST_WEEKDAY_WHY }, 3600);
            }}
            className={`status ${on ? "on" : "idle"}`}
          >
            {WEEKDAY_LABEL[d]}
          </button>
        );
      })}
    </div>
  );
}

/* ───────────── 定期券的検印（本班：済／運休） ───────────── */

/**
 * 定期券版検印區：蓋的是**這一班**，不是整張票。
 *   済   → `setCompleted`（repository 把章落在目前班次上，並把 scheduled_on 推到下一班）
 *   運休 → `skipOccurrence`（不動 status、不寫済事件；再按一次取消，不留痕）
 * 班次日取 `currentOccurrences[id]?.due_on ?? scheduled_on`——交代完的票 scheduled_on 已指向下一班，
 * 直接印它會說謊（WP2 的口徑）。段頭不再印日期：底下「本班日期」列就是它。
 */
export function TeikiStampRow({ node }: { node: NodeRow }) {
  const occ = useNodeStore((s) => s.currentOccurrences[node.id]);
  const [fresh, setFresh] = useState(false);
  const { done, suspended, railDate, meta, action } = stampViewOf(node, occ);

  // 運休中點検印位＝取消運休（A 原型 :60-62／:1061 的輪替「…→運休→空欄」最後一步），要蓋済就再點一次——
  // 直接蓋済會蓋到引擎已推走的「下一班」頭上；取消不留痕，故不出收據（M3 ④ 評審 should-4）。規則在 nodeFlows.panelStampFlow。
  const stamp = () => {
    const r = panelStampFlow(node, occ);
    if (r !== null) setFresh(r);
  };

  return (
    <>
      <SectionRule title="検印" />
      <div className={`stamp-row ${done ? "stamped" : ""} ${fresh ? "fresh" : ""}`}>
        <button
          type="button"
          aria-label={action}
          aria-pressed={done}
          title={suspended ? "再按一次取消運休" : done ? "再按一次取消本班済章" : "蓋章：本班完成"}
          onClick={stamp}
          className="stamp"
        >
          <span className="hint">検印</span>
          <span className="seal">済</span>
        </button>
        <span className="meta">{meta}</span>
        <button
          type="button"
          aria-label={suspended ? "取消運休" : "本班運休"}
          aria-pressed={suspended}
          title={suspended ? "這一班改回照常開" : "這一班不開（不影響下一班）"}
          onClick={() => panelSuspendFlow(node.id, !suspended)}
          className={`status susp ${suspended ? "on" : "idle"}`}
        >
          {suspended ? "取消運休" : "運休"}
        </button>
      </div>
      {/* 本班日期（⑥ D-主-295）＋本班時刻（主線②）：只改這一班；railDate 拿不到（沒有班次）就不畫 */}
      {railDate && <RunDateRow node={node} railDate={railDate} locked={done || suspended} />}
      {railDate && <RunTimeRow node={node} date={railDate} />}
    </>
  );
}

/**
 * 本班日期（⑥ D-主-295）：日期 chip 挑一天＝只改這一班；改過的標「原定 M/D」並給「改回原日」。
 * 已済、運休的班不給改（locked；repository 也會擋）：要改先取消。手機同一列在 MobileStateRows。
 */
function RunDateRow({ node, railDate, locked }: { node: NodeRow; railDate: string; locked: boolean }) {
  const today = todayKey(useUiStore((s) => s.dayStartHour));
  const rule = parseRule(node.repeat_rule);
  const origin = rule ? runOrigin(rule, railDate) : null;
  const { min, max } = runDateBounds(rule, today);
  const wrapRef = useRef<HTMLDivElement>(null);
  /** 「改回原日」按下去那顆鈕就消失：寫完把焦點交回日期 chip，鍵盤流才不掉到 body（同 RunTimeRow） */
  const pendingFocus = useRef(false);
  useEffect(() => {
    if (!pendingFocus.current || origin) return;
    pendingFocus.current = false;
    wrapRef.current?.querySelector("button")?.focus();
  });

  return (
    <div className="occ is-date">
      <span className="lbl">本班日期</span>
      <div className="ov" ref={wrapRef}>
        <DateChip
          date={railDate}
          onPick={(d) => {
            if (d) void moveRunFlow(node.id, railDate, d);
          }}
          min={min}
          max={max}
          disabled={locked}
          today={today}
          label="本班日期"
        />
        {origin && <span className="why on">原定 {shortDayKey(origin)}</span>}
        {origin && !locked && (
          <button
            type="button"
            className="linkbtn"
            onClick={() => {
              pendingFocus.current = true;
              void moveRunFlow(node.id, railDate, origin).then((ok) => {
                if (!ok) pendingFocus.current = false;
              });
            }}
          >
            改回原日
          </button>
        )}
      </div>
    </div>
  );
}
