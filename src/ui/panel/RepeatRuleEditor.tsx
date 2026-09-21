/**
 * 側板「重複」區段（M3 ④ WP3）——掛／改／清除重複規則的**唯一 UI 入口**，以及定期券的班次検印。
 *
 * 沒有原型可逐字移植（原型時代還沒有重複引擎）→ 只拼 fields.tsx 既有元件（Segmented／NumberField／
 * DateField／FieldRow／SectionRule）與 techo 語彙（`.opts .status` 小方標當星期 chip），不自創視覺。
 * 區段小標右側的淡注記（SectionRule 的 aside）＝ describeRule 的一句話收據，與今日列／大綱列同一句。
 *
 * 資料流：草稿（Draft）→ buildRule → 去抖 400ms → `nodeStore.setRepeatRule`（ActionResult 失敗吐 toast 並還原草稿）。
 *   ⚠ 規則不完整（每週還沒選星期／每月沒填日／完成後沒填天數）**不送**——送出去 parseRule 會 null，
 *     等於把票清成乘車券。這種狀態在 aside 印一句提示，等主人補齊。
 *   ⚠ 「是不是定期券」一律 `parseRule(repeat_rule) !== null`，不看欄位非空
 *     （種子的 legacy 文字票「量體重記錄」必須顯示為「不重複」的乘車券）。
 *
 * 班次的済／運休不走 nodes.status：済＝`setCompleted`（repository 自動落在目前班次上）、
 * 運休＝`skipOccurrence`（不動 status、不寫済事件）；目前班次結局讀 `nodeStore.currentOccurrences[id]`
 * （undefined＝這班還沒交代），與今日列的 `TodayRow.occurrence` 是同一把尺。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  WEEKDAY_LABEL,
  WEEKDAY_ORDER,
  afterRule,
  describeRule,
  fixedRule,
  parseRule,
  serializeRule,
  type NodeRow,
  type RepeatFreq,
  type RepeatRule,
} from "../../domain";
import { REPEATABLE_KINDS } from "../../data";
import { todayKey } from "../../lib/date";
import { useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";
import { DateField, FieldRow, NumberField, SectionRule, Segmented, useDebouncedCommit } from "./fields";

/* ───────────── 草稿模型 ───────────── */

type EditMode = "none" | "fixed" | "after";

interface Draft {
  mode: EditMode;
  freq: RepeatFreq;
  /** getDay() 索引（0＝日）；畫面排列順序另看 WEEKDAY_ORDER */
  byweekday: number[];
  /** v1 只給一個日子（規則 JSON 仍是陣列，引擎認多個） */
  monthday: number | null;
  days: number | null;
  start: string;
}

const MODE_OPTIONS: { value: EditMode; label: string }[] = [
  { value: "none", label: "不重複" },
  { value: "fixed", label: "固定排程" },
  { value: "after", label: "完成後間隔" },
];

const FREQ_OPTIONS: { value: RepeatFreq; label: string }[] = [
  { value: "daily", label: "每日" },
  { value: "weekly", label: "每週" },
  { value: "monthly", label: "每月" },
];

/** 節點現況 → 草稿。起算日：規則裡的 start ＞ 執行日 ＞ 今天（D-④-6） */
function draftOf(node: NodeRow, today: string): Draft {
  const rule = parseRule(node.repeat_rule);
  const start = rule?.start ?? node.scheduled_on ?? today;
  if (!rule) return { mode: "none", freq: "daily", byweekday: [], monthday: null, days: null, start };
  if (rule.mode === "after") {
    return { mode: "after", freq: "daily", byweekday: [], monthday: null, days: rule.days, start: rule.start };
  }
  return {
    mode: "fixed",
    freq: rule.freq,
    byweekday: rule.byweekday ?? [],
    monthday: rule.bymonthday?.[0] ?? null,
    days: null,
    start: rule.start,
  };
}

/** 草稿 → 規則；`null` ＝「不重複」或**規則還不完整**（兩者由 draft.mode 分辨，見 pushDraft） */
function buildRule(d: Draft): RepeatRule | null {
  if (d.mode === "none") return null;
  if (d.mode === "after") return d.days && d.days >= 1 ? afterRule(d.days, d.start) : null;
  if (d.freq === "weekly") {
    return d.byweekday.length ? fixedRule("weekly", d.start, { byweekday: [...d.byweekday].sort((a, b) => a - b) }) : null;
  }
  if (d.freq === "monthly") return d.monthday ? fixedRule("monthly", d.start, { bymonthday: [d.monthday] }) : null;
  return fixedRule("daily", d.start);
}

/** 日期 key 的星期（getDay 索引）；只用本地 new Date(y,m-1,d)，不經 Date.parse（④ 的坑） */
function weekdayOfKey(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  return y && m && d ? new Date(y, m - 1, d).getDay() : new Date().getDay();
}

/**
 * 切進「固定排程」時把缺的欄位預帶成一條**完整**規則（M3 ④ 評審 should-8）：
 * 每週＝起算日那個星期、每月＝起算日的號數（原本就是這樣做）。一點就是完整規則＝零未完成態，
 * 不會出現「編輯器說每週、票還照每日發車」的縫。
 */
function fillFixed(d: Draft): Draft {
  if (d.freq === "weekly" && !d.byweekday.length) return { ...d, byweekday: [weekdayOfKey(d.start)] };
  if (d.freq === "monthly" && !d.monthday) return { ...d, monthday: Number(d.start.slice(8, 10)) || 1 };
  return d;
}

/** 規則還缺什麼（aside 的提示語；完整時回 null） */
function missingHint(d: Draft): string | null {
  if (d.mode === "none") return null;
  if (d.mode === "after") return d.days && d.days >= 1 ? null : "填一個天數";
  if (d.freq === "weekly") return d.byweekday.length ? null : "選一個星期";
  if (d.freq === "monthly") return d.monthday ? null : "填一個日子";
  return null;
}

/** 日期 key → 「9/11（週五）」；只用本地 new Date(y,m-1,d)，不經 Date.parse（④ 的坑） */
function fmtRail(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  if (!y || !m || !d) return key;
  return `${m}/${d}（週${WEEKDAY_LABEL[new Date(y, m - 1, d).getDay()]}）`;
}

/* ───────────── 重複區段 ───────────── */

/**
 * 「重複」區段。列車／車廂有存活子項時整段換成一句灰字（v1 的約束，repository 也會擋）。
 * 不可重複的 kind（支線／路線…）直接不畫。
 */
export function RepeatSection({ node }: { node: NodeRow }) {
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const showToast = useUiStore((s) => s.showToast);
  const setRepeatRule = useNodeStore((s) => s.setRepeatRule);
  const kidCount = useLiveChildCount(node.id);

  const today = todayKey(dayStartHour);
  const [draft, setDraft] = useState<Draft>(() => draftOf(node, today));
  /** 最後一次「我方送出」的欄位值；與 props 進來的值相同＝這筆是自己寫回來的，不覆蓋草稿 */
  const sent = useRef<string | null>(node.repeat_rule ?? null);
  const nodeRef = useRef(node);
  nodeRef.current = node;

  const commit = useCallback(
    (rule: RepeatRule | null) => {
      const payload = rule ? serializeRule(rule) : null;
      if (payload === sent.current) return;
      sent.current = payload;
      void setRepeatRule(nodeRef.current.id, rule).then((r) => {
        if (!r.ok) {
          // 被 repository 擋下（有子項／kind 不對）→ 原句 toast，草稿還原成庫裡的樣子
          const cur = nodeRef.current;
          sent.current = cur.repeat_rule ?? null;
          setDraft(draftOf(cur, todayKey(dayStartHour)));
          showToast({ message: r.reason ?? "無法設定重複規則" }, 4000);
          return;
        }
        if (rule === null) showToast({ message: "已改回乘車券——過去的班次記錄保留" });
      });
    },
    [setRepeatRule, showToast, dayStartHour],
  );
  const { schedule } = useDebouncedCommit<RepeatRule | null>(commit, 400);

  // 外部改動（別處清了規則／引擎推了班次）才重置草稿；自己送出去的那一筆不重置
  useEffect(() => {
    const incoming = node.repeat_rule ?? null;
    if (incoming === sent.current) return;
    sent.current = incoming;
    setDraft(draftOf(node, todayKey(dayStartHour)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.repeat_rule, node.id]);

  /** 改草稿＋（規則完整時才）排程寫回 */
  const push = (next: Draft) => {
    setDraft(next);
    if (next.mode === "none") {
      schedule(null);
      return;
    }
    const rule = buildRule(next);
    if (rule) schedule(rule);
  };

  if (!REPEATABLE_KINDS.includes(node.kind)) return null;

  if (kidCount > 0) {
    return (
      <>
        <SectionRule title="重複" />
        <p className="empty">有子項的列車不能設重複（v1）</p>
      </>
    );
  }

  const rule = buildRule(draft);
  const hint = missingHint(draft);
  /**
   * 規則不完整時**不送**（送出去會把票清成乘車券），票就仍照庫裡那一條發車——把這個真相說出口，
   * 別讓主人關掉側板後以為已經改好（M3 ④ 評審 should-8；預帶值已讓這種狀態很難撞上，這是最後一道保險）。
   */
  const saved = parseRule(node.repeat_rule);
  const aside = rule
    ? describeRule(rule)
    : hint && saved
      ? `仍照「${describeRule(saved)}」發車——${hint}後生效`
      : hint;

  return (
    <>
      <SectionRule title="重複" aside={aside ?? undefined} />
      <div className="fields">
        <FieldRow label="模式">
          <Segmented
            value={draft.mode}
            options={MODE_OPTIONS}
            onChange={(v) => {
              if (!v || v === draft.mode) return;
              if (v === "after") push({ ...draft, mode: "after", days: draft.days ?? 1 });
              else if (v === "fixed") push(fillFixed({ ...draft, mode: "fixed" }));
              else push({ ...draft, mode: v });
            }}
            ariaLabel="重複模式"
          />
        </FieldRow>

        {draft.mode === "fixed" && (
          <FieldRow label="頻率">
            <Segmented
              value={draft.freq}
              options={FREQ_OPTIONS}
              onChange={(v) => {
                if (!v || v === draft.freq) return;
                // 每週／每月都預帶起算日的星期／號數：一選就是一條完整規則，馬上生效（改一下再點別的就好）
                push(fillFixed({ ...draft, freq: v }));
              }}
              ariaLabel="重複頻率"
            />
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
            <DateField
              value={draft.start}
              onCommit={(v) => push({ ...draft, start: v ?? todayKey(dayStartHour) })}
              ariaLabel="起算日"
            />
          </FieldRow>
        )}
      </div>
    </>
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
            // 最後一顆不給熄：每週至少要有一個星期，熄了規則就不完整、寫不回去（票會停在舊規則上）
            onClick={() => {
              if (on && value.length === 1) return;
              onChange(on ? value.filter((x) => x !== d) : [...value, d].sort((a, b) => a - b));
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

/** 存活的直屬子項數：當前路線樹裡查得到就用樹，否則退回今日切片帶來的 child_total */
function useLiveChildCount(id: string): number {
  const inTree = useNodeStore((s) => s.tree.byId[id] !== undefined);
  const treeKids = useNodeStore((s) => s.tree.childrenOf[id]?.length ?? 0);
  const todayKids = useNodeStore((s) => s.today.byId[id]?.child_total ?? 0);
  return inTree ? treeKids : todayKids;
}

/* ───────────── 定期券的検印（本班：済／運休） ───────────── */

/**
 * 定期券版検印區：蓋的是**這一班**，不是整張票。
 *   済   → `setCompleted`（repository 把章落在目前班次上，並把 scheduled_on 推到下一班）
 *   運休 → `skipOccurrence`（不動 status、不寫済事件；再按一次取消，不留痕）
 * 班次日取 `currentOccurrences[id]?.due_on ?? scheduled_on`——交代完的票 scheduled_on 已指向下一班，
 * 直接印它會說謊（WP2 的口徑）。
 */
export function TeikiStampRow({ node }: { node: NodeRow }) {
  const occ = useNodeStore((s) => s.currentOccurrences[node.id]);
  const setCompleted = useNodeStore((s) => s.setCompleted);
  const skipOccurrence = useNodeStore((s) => s.skipOccurrence);
  const showToast = useUiStore((s) => s.showToast);
  const [fresh, setFresh] = useState(false);

  const done = occ?.status === "done";
  const suspended = occ?.status === "skipped";
  const railDate = occ?.due_on ?? node.scheduled_on;

  const suspend = (skip: boolean) => {
    void skipOccurrence(node.id, skip).then((r) => {
      if (!r.ok) showToast({ message: r.reason ?? "無法運休" }, 4000);
    });
  };

  const stamp = () => {
    // 運休中點検印位＝取消運休（A 原型 :60-62／:1061 的輪替「…→運休→空欄」最後一步），要蓋済就再點一次。
    // 直接蓋済會蓋到引擎已推走的「下一班」頭上，所以先撤運休；取消不留痕，故不出收據（M3 ④ 評審 should-4）。
    if (suspended) {
      suspend(false);
      return;
    }
    setFresh(!done);
    void setCompleted(node.id, !done);
  };

  return (
    <>
      <SectionRule title="検印" aside={railDate ? `本班 ${fmtRail(railDate)}` : undefined} />
      <div className={`stamp-row ${done ? "stamped" : ""} ${fresh ? "fresh" : ""}`}>
        <button
          type="button"
          aria-label={suspended ? "取消本班運休" : done ? "取消本班済章" : "蓋本班済章"}
          aria-pressed={done}
          title={suspended ? "再按一次取消運休" : done ? "再按一次取消本班済章" : "蓋章：本班完成"}
          onClick={stamp}
          className="stamp"
        >
          <span className="hint">検印</span>
          <span className="seal">済</span>
        </button>
        <span className="meta">{done ? "本班已済" : suspended ? "本班運休" : "點一下蓋本班"}</span>
        <button
          type="button"
          aria-label={suspended ? "取消運休" : "本班運休"}
          aria-pressed={suspended}
          title={suspended ? "這一班改回照常開" : "這一班不開（不影響下一班）"}
          onClick={() => suspend(!suspended)}
          className={`status susp ${suspended ? "on" : "idle"}`}
        >
          {suspended ? "取消運休" : "運休"}
        </button>
      </div>
    </>
  );
}
