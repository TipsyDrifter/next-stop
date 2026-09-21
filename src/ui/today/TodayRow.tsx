/**
 * TodayRow——今日視圖的一列＝一張完整車票（M3 ③ WP2）。
 *
 * 視覺真相＝prototypes/m3-mood-c2-pastel.html 的今日清單（:691-809）與誤點票（:818-836），逐字移植：
 *   .ticket > .stub（.badge 路線代碼／.line-name 路線名／.serial No.MMDD-NN）
 *          ＋ .body（.fare-class 票種／.title 標題／.meta）
 *          ＋（誤點）.late-seal 延着 ＋ .stamp-zone（検印／済）
 * **與大綱列的差別（雷區 1）**：今日列的票根是「路線代碼」不是 kind 字（大綱 OutlineRow 是「列／廂／票」），
 *   路線名取代類型名，無路線＝虛線「臨」＋「無路線」；票種多一種「臨時券」。故不共用 OutlineRow 的
 *   Stub／fareClass，改在本檔各寫一份（結構與 class 完全相同，只換資料）。
 *
 * 印章（a38／氛4）：
 *   status=doing → 票根左緣鋏痕（PunchNick，入鋏）      status=paused → 検印位「途中下車」角印
 *   carried_from → 票面右下「繰越」角印（済蓋下後淡到 .38＝結局上前、來歷退後）
 *   誤點票 → 延着角印；補済後由 techo.css:464-475 讓済進検印欄、延着退右下（沿用既有 class，不重寫），
 *     同時「來歷退後」的另一半在本檔：`.late-t`（暖光底＋赭外框）與手寫「晚了 N 天」隨 done 收掉，
 *     meta 換成「已完成 ✓ ・ 赭 chip 原定 M/D」——樣張＝件一 prototypes/m3-ext-routemap.html:1192-1208
 *   運休角印（M3 ④ WP2）→ 只有定期券蓋得到（一般任務運休＝清執行日移出今日，票走了章無處蓋）。
 *     樣張＝prototypes/m3-mood-a-stamps.html:546-568（墨色角印 -7° 蓋在検印位、整張轉淡 .68、
 *     狀態字換「今日停駛」＝A :920 的 `.lbl-susp`），本檔的 class 叫 `.is-suspended`／`.susp-label`。
 *
 * **定期券口徑（M3 ④，全站同一把尺）**：
 *   是不是定期券 ＝ `parseRule(row.repeat_rule) !== null`（**不看欄位非空**——legacy 文字規則要顯示成乘車券）
 *   済了沒       ＝ `row.occurrence ? occurrence.status === 'done' : row.status === 'done'`
 *   運休了沒     ＝ `row.occurrence?.status === 'skipped'`
 *   這一列在講哪一天（分區／「原定 M/D」）＝ `row.occurrence?.due_on ?? row.scheduled_on`
 *     （定期券蓋済後 `scheduled_on` 已被引擎推到下一班，印它就會變成「已完成・原定 9/12」的錯覺）
 *
 * 原型沒有的控件（一律 hover／選中才現身或不佔版面）：票種小字＝側板入口、執行日 chip＝推遲入口。
 */
import { useEffect, useRef, type ReactNode } from "react";
import { describeRule, parseRule, type NodeRow, type NodeStatus } from "../../domain";
import type { TodayRow as TodayRowData } from "../../data";
import { PunchNick, SealCarryOver, SealStopover, SealSuspended } from "../stamps";

/** MMDD-NN 之外的 M/D 顯示（票面 chip 用） */
function mmdd(key: string): string {
  const p = key.split("-");
  return p.length === 3 ? `${Number(p[1])}/${Number(p[2])}` : key;
}

/** 兩個日期 key（YYYY-MM-DD）相差幾天（a − b） */
function diffDays(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((new Date(ay, am - 1, ad).getTime() - new Date(by, bm - 1, bd).getTime()) / 86_400_000);
}

const STATUS_LABEL: Record<NodeStatus, { text: string; idle: boolean }> = {
  todo: { text: "未開始", idle: true },
  doing: { text: "進行中", idle: false },
  paused: { text: "暫停", idle: true },
  done: { text: "已完成", idle: false },
};

/**
 * 誤點註記（件一 .late-hw／.late-plain）：兩枚都畫，CSS 依主題只顯示一枚——
 * 粉彩＝手寫「晚了 N 天」（C2 手寫三處之一）、銀河＝排印「延誤 N 天」。
 */
function LateNote({ days }: { days: number }) {
  return (
    <>
      <span className="late-hw">晚了 {days} 天</span>
      <span className="late-plain">延誤 {days} 天</span>
    </>
  );
}

function CheckGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
      <path d="M2 6.5 5 9.5 10 3" />
    </svg>
  );
}

function RepeatGlyph() {
  return (
    <svg className="icon" width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden>
      <path d="M11.8 7A4.8 4.8 0 1 1 9.6 3" />
      <path d="M9.4 1.2 9.7 3.2 7.7 3.6" />
    </svg>
  );
}

/** 車廂格（直屬子項進度；≤5 格畫格子，超過只給數字）——今日列的子項數由 repository 帶出來 */
function Cars({ total, done, label }: { total: number; done: number; label: string }) {
  return (
    <span className="cars" role="img" aria-label={`${label} ${done}／${total}`} title="已完成／全部直屬子項">
      {total <= 5 && Array.from({ length: total }, (_, i) => <i key={i} className={i < done ? "full" : undefined} />)}
      <em>
        {label} {done}/{total}
      </em>
    </span>
  );
}

/** 把 meta 項目用「・」串起來（只在相鄰可見項之間放分隔） */
function MetaItems({ items }: { items: ReactNode[] }) {
  const out: ReactNode[] = [];
  items.forEach((it, i) => {
    if (it === null || it === undefined || it === false) return;
    if (out.length) out.push(<span key={`sep-${i}`} className="sep">・</span>);
    out.push(<span key={`it-${i}`} className="mi">{it}</span>);
  });
  return <>{out}</>;
}

/**
 * 票種（C2 :738）：**規則 parse 得出來**＝定期券（金）／臨時車票（parent_id 為 null）＝臨時券／其餘＝乘車券。
 * 大綱的 fareClass 多一種「支線」，今日清單不會有支線 → 另寫一份。
 * ⚠ 判定只認 parseRule 的結果：欄位裡塞著 legacy 自由文字（種子的「量體重記錄」）的票**是乘車券**。
 */
function fareOf(rule: ReturnType<typeof parseRule>, row: TodayRowData): { label: string; teiki: boolean } {
  if (rule) return { label: "定期券", teiki: true };
  if (row.parent_id === null) return { label: "臨時券", teiki: false };
  return { label: "乘車券", teiki: false };
}

/**
 * 車廂格的名稱：repository 只帶直屬子項的「數量」，沒帶種類 →
 * 依自己的 kind 推（列車底下多半是車廂、車廂底下多半是車票）。純顯示字，算錯不影響資料。
 */
function carsLabel(kind: TodayRowData["kind"]): string {
  return kind === "train" ? "車廂" : "車票";
}

export interface TodayRowActions {
  select(id: string): void;
  /** 済単擊（完成／取消完成） */
  complete(id: string): void;
  /** 票種小字＝詳情側板入口（鍵盤「.」） */
  openPanel(id: string): void;
  /** 執行日 chip＝推遲小卡入口（取代原生 date input；D-③-6） */
  openDefer(id: string, anchor: HTMLElement | null): void;
  focusContainer(): void;
}

export interface TodayRowProps {
  row: TodayRowData;
  /** 票根的路線（代碼／色／名）；undefined＝無路線的臨時車票 */
  route: NodeRow | undefined;
  selected: boolean;
  /** 剛蓋章 → 播 stampIn */
  fresh: boolean;
  /** 這份今日資料算的是哪一天（依日界線） */
  dateKey: string;
  actions: TodayRowActions;
  onFreshEnd(): void;
  /** WP5 拖曳：useTodayDnd 的 rowProps（WP2 是空物件） */
  dndProps?: Record<string, unknown>;
}

export function TodayRow({ row, route, selected, fresh, dateKey, actions, onFreshEnd, dndProps }: TodayRowProps) {
  const ref = useRef<HTMLLIElement>(null);
  /** 定期券的唯一判定（見檔頭「定期券口徑」）；null＝乘車券／臨時券 */
  const rule = parseRule(row.repeat_rule);
  /** 済了沒：活著的定期券看班次結局，非定期券（含退役定期券，occurrence 恆 null）看 nodes.status */
  const done = row.occurrence ? row.occurrence.status === "done" : row.status === "done";
  /** 本班運休（只有定期券蓋得到） */
  const suspended = row.occurrence?.status === "skipped";
  /** 済／運休都是「結局」：暖光底與延着都要讓位（結局上前、來歷退後） */
  const settled = done || suspended;
  const late = row.bucket === "late";
  const due = row.bucket === "due";
  const paused = row.status === "paused" && !settled;
  /**
   * 這一列在講的那一天（分區與「原定 M/D」的取法；見檔頭）。定期券交代完之後 scheduled_on
   * 已經指向下一班，印它會變成「已完成・原定 9/12」——要印的是**這一班**的日子。
   */
  const railDate = row.occurrence?.due_on ?? row.scheduled_on;

  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const fare = fareOf(rule, row);
  const status = STATUS_LABEL[row.status];
  const accent = route?.color ?? "var(--route-none)";
  const badge = route?.code ?? (route ? route.name.slice(0, 1) : "臨");
  const lineName = route?.name ?? "無路線";
  const dueLate = !!row.due_on && row.due_on <= dateKey;
  /** 執行日 chip 印的日子＝這一列在講的那一天（定期券吃班次日，其餘吃 scheduled_on） */
  const chipDate = rule ? railDate : row.scheduled_on;

  /** 執行日 chip＝推遲入口（原型沒有的控件；與頁首日期重複的那一枚只在 hover／選中現身） */
  const deferChip = (label: string, warn: boolean) => (
    <button
      type="button"
      tabIndex={-1}
      aria-label="執行日——點擊推遲"
      title="推遲（T 排今天・Shift+T 明天）"
      onClick={(e) => {
        e.stopPropagation();
        actions.openDefer(row.id, e.currentTarget);
      }}
      className={"chip chip-btn" + (warn ? " late" : "")}
    >
      {label}
    </button>
  );

  /** 狀態欄（done／運休時 CSS 隱藏 .status、改顯示 .done-label／.susp-label——與原型同一套規則） */
  const statusItem = (
    <>
      <span className={"status" + (status.idle ? " idle" : "")}>{status.text}</span>
      <span className="done-label">
        已完成 <CheckGlyph />
      </span>
      <span className="susp-label">今日停駛</span>
    </>
  );

  const metaItems: ReactNode[] = late
    ? settled
      ? // 補済態（件一 :1192-1208 逐字＝ `.ticket.done.late-done`）：來歷退後——
        // 暖光底（.late-t）與手寫「晚了 N 天」隨結局收掉，只留「已完成 ✓ ・ 赭 chip 原定 M/D」
        // （運休走同一條：運休也是結局，延着一樣退到右下）
        [statusItem, <span className="chip late">原定 {railDate ? mmdd(railDate) : "—"}</span>]
      : [
          // 誤點票（C2 :826-832 逐字）：赭「原定 M/D」＋誤點註記
          <span className="late-note">原定 {railDate ? mmdd(railDate) : "—"}</span>,
          railDate ? <LateNote days={diffDays(dateKey, railDate)} /> : null,
        ]
    : due
      ? // D-③-7：沒排執行日、締切已到／已過 → 誤點區尾段，赭 chip「締切 M/D」、不蓋延着。
        // 「＋執行日」是原型沒有的控件 → 收進下方 .meta-hover（hover／選中才現身），有結局時不畫。
        settled
        ? [statusItem, <span className="chip late">締切 {row.due_on ? mmdd(row.due_on) : "—"}</span>]
        : [<span className="chip late">締切 {row.due_on ? mmdd(row.due_on) : "—"}</span>]
      : [
          statusItem,
          // 定期券的一句話規則（C2 :745「每日重複」那一格）——印 describeRule，不印 JSON
          rule ? (
            <span>
              <RepeatGlyph />
              {describeRule(rule)}
            </span>
          ) : null,
          row.child_total > 0 ? <Cars total={row.child_total} done={row.child_done} label={carsLabel(row.kind)} /> : null,
          row.estimate_min ? <span>預計 {row.estimate_min} 分</span> : null,
          row.parent_id === null ? <span>臨時車票</span> : null,
          // 執行日不是「今天」時（例：昨天排、今天補済留原位）常駐顯示，否則收進 hover 群組。
          // 定期券吃 railDate：蓋済／運休留原位的那一列講的是今天，不是引擎推到的下一班。
          chipDate && chipDate !== dateKey ? deferChip(`執行 ${mmdd(chipDate)}`, false) : null,
          row.due_on ? <span className={"chip" + (dueLate ? " late" : "")}>締切 {mmdd(row.due_on)}</span> : null,
        ];

  return (
    <li
      ref={ref}
      role="option"
      aria-selected={selected}
      data-selected={selected}
      data-node-id={row.id}
      className="ticket-li"
      onMouseDown={(e) => {
        const t = e.target as HTMLElement;
        if (t.closest("input")) return; // 行內輸入框要自己的 caret
        // 只有列內按鈕才 preventDefault（控件不搶焦點）。票面本體不能擋——mousedown 的預設動作
        // 同時是原生拖曳的起手式，一律 preventDefault 會讓 draggable 元素永遠發不出 dragstart
        // （WP5 實證）。不選字改由 today.css 的 `user-select:none` 負責。
        if (t.closest("button")) e.preventDefault();
        actions.select(row.id);
        actions.focusContainer();
      }}
      {...dndProps}
    >
      <article
        className={
          "ticket" +
          // 暖光底＋赭外框只在「還沒有結局」時亮著（件一：補済＝來歷退後，樣張 .ticket.done.late-done 無 .late-t）
          ((late || due) && !settled ? " late-t" : "") +
          (selected ? " selected" : "") +
          (done ? " done" : "") +
          (suspended ? " is-suspended" : "") +
          (paused ? " is-paused" : "") +
          (fresh ? " fresh" : "")
        }
      >
        {/* 票根：路線代碼／路線名／票號（無路線＝虛線「臨」） */}
        <div className="stub" style={{ color: accent }}>
          {row.status === "doing" && <PunchNick title="入鋏（進行中）" />}
          <span aria-hidden className={route ? "badge" : "badge dashed"}>
            {badge}
          </span>
          <span className="line-name">{lineName}</span>
          <span className="serial">No.{row.serial}</span>
        </div>

        {/* 票面 */}
        <div className="body">
          <button
            type="button"
            tabIndex={-1}
            aria-label="打開詳情側板"
            title="詳情（.）"
            onClick={(e) => {
              e.stopPropagation();
              actions.openPanel(row.id);
            }}
            className={"fare-class" + (fare.teiki ? " teiki" : "")}
          >
            {fare.label}
          </button>

          {/* 臨時車票的標題走手寫（C2：真實鐵道的補充券就是手寫的）；銀河主題由 CSS 退回排印 */}
          <p className={"title" + (row.parent_id === null ? " hw" : "")}>{row.name}</p>

          <div className="meta">
            <MetaItems items={metaItems} />
            {/* 原型沒有的控件：締切段的「＋執行日」（T 鍵才是主要入口），hover／選中才現身；done 時不畫 */}
            {due && !done && <span className="meta-hover">{deferChip("＋執行日", false)}</span>}
            {/* 原型沒有的控件：與頁首日期重複的那一枚執行日 chip，hover／選中才現身 */}
            {!late && !due && (!chipDate || chipDate === dateKey) && (
              <span className="meta-hover">
                {deferChip(chipDate ? `執行 ${mmdd(chipDate)}` : "＋執行日", false)}
              </span>
            )}
          </div>

          {/* 繰越角印（M3-1：只隨手動改期出現） */}
          {row.carried_from && (
            <SealCarryOver className="carry-seal" title={`自 ${mmdd(row.carried_from)} 繰越`} />
          )}
        </div>

        {/* 誤點票的延着角印（締切浮上來的那一段不蓋——D-③-7） */}
        {late && <span className="late-seal">延着</span>}

        {/* 検印欄：「済」単擊（a40）；paused ＝ 途中下車角印、運休 ＝ 運休角印，兩枚都蓋在検印位 */}
        <div className="stamp-zone">
          <button
            type="button"
            tabIndex={-1}
            aria-label={suspended ? "取消本班運休" : done ? "取消完成" : "蓋章完成"}
            aria-pressed={done}
            title={suspended ? "本班運休中——再點一次取消（或按 U）" : done ? "取消済章" : "蓋章：完成（Space）"}
            onClick={(e) => {
              e.stopPropagation();
              actions.complete(row.id);
            }}
            className="stamp"
          >
            <span className="hint" aria-hidden>
              検印
            </span>
            <span className="seal" aria-hidden onAnimationEnd={fresh ? onFreshEnd : undefined}>
              済
            </span>
          </button>
          {suspended && (
            <span className="stopover-slot">
              <SealSuspended title="運休（本班停駛）" />
            </span>
          )}
          {paused && !suspended && (
            <span className="stopover-slot">
              <SealStopover title="途中下車（暫停）" />
            </span>
          )}
        </div>
      </article>
    </li>
  );
}
