/**
 * OutlineRow／DraftRow——大綱的一列＝一張完整車票（結構與 class 1:1 照抄 prototypes/m1-c-techo.html 的 .ticket；CSS 在 styles/techo.css）：
 * .stub（.badge 類型徽章＝點擊聚焦／.line-name 類型／.serial 票號 No.MMDD-NN）＋ .body（.fare-class 票種＝點擊開詳情／.title 標題＝雙擊改名／
 * .meta 狀態・車廂格・預計・執行日／締切 chip）＋（誤點）.late-seal 延着 ＋ .stamp-zone（検印／済章）＋ 右下常駐淡態 ⋯。
 * 摺疊＝票根左邊的 ▸／▾ 鈕（磨光⑤ K5）或雙擊票根（鍵盤 ←／→ 另有）。DraftRow＝同款票、虛線邊、輸入在 .title 位置。
 * 對應 UI Flow 2.0／2.0b／2.0d。取捨：列內按鈕 tabIndex=-1 且 mousedown 不搶焦點——焦點永遠留在大綱容器，鍵盤流不中斷；
 * 原型沒有的控件（空日期入口）hover／選中才現身；優先級不在票面（詳情側板看）。
 *
 * **誤點（UI 丙-3 B4：與今日列同一把尺，today/TodayRow.tsx）**：這一班的日子（railDate）在今天以前、而且
 *   還沒有結局（済／運休），或結局是**今天**才補上的（＝今日列「補済留原位」那一張）⇒ 票面蓋「延着」、検印欄留空；
 *   結局之後延着退到票面右下小號（techo.css `.ticket.done .late-seal`；運休在 outline.css 補同一組座標）。
 *   早就交代完的舊票（例：上週準時済掉）不算誤點。頁尾的誤點區已拿掉——同一張票同一頁只列一次。
 * **日期 chip（UI 丙-3 B5）**：共用 `common/DateChip`，一律 `allowPast`（執行日選到今天以前＝補記，磨光⑦ D-主-67；
 *   補記本身在 useOutlineController.setDate 帶 `{backfill:true}`）；執行日 `flag="backfill"`（旗子），過期改 `flag="late"`（赭）。
 *
 * **定期券口徑（M3 ④，全站同一把尺；與 today/TodayRow.tsx 檔頭同一份）**：
 *   是不是定期券 ＝ `parseRule(node.repeat_rule) !== null`（**不看欄位非空**——legacy 自由文字要顯示成乘車券）
 *   済了沒       ＝ `occurrence ? occurrence.status === 'done' : node.status === 'done'`（退役定期券 occurrence 恆 null）
 *   運休了沒     ＝ `occurrence?.status === 'skipped'`
 *   **大綱與今日列的差別**：今日列「留原位講今天」（chip 印班次日）；大綱是計畫視角，
 *     済／運休之後 chip 印的是 `scheduled_on` ＝引擎推出來的**下一班**；只有「過期」那一枚
 *     （原定 M/D ＋誤點註記）講的是這一班（`occurrence?.due_on ?? scheduled_on`）。
 *   執行日對定期券唯讀（D-④-3）：chip 不開日期輸入，點了吐 REPEAT_RESCHEDULE_MSG。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode, type SyntheticEvent } from "react";
import { KIND_LABEL, describeRule, parseRule, type NodeKind, type NodeRow, type NodeStatus } from "../../domain";
import type { CurrentOccurrence } from "../../data";
import { SealSuspended } from "../stamps";
import { Chevron } from "../common/Chevron";
import { IconDots } from "../common/icons";
import { PopMenu, hotkeyCaps, type PopMenuItem } from "../common/PopMenu";
import { DateChip } from "../common/DateChip";
import { useUiStore } from "../../store/uiStore";
import { isInDay } from "../../lib/date";
import { InlineInput } from "../common/InlineInput";
import type { EditHandlers, RowActions } from "./useOutlineController";

/** 層級縮排（票的 margin-left）：每層 28px */
export function indentPx(depth: number): number {
  return depth * 28;
}

/** 票根徽章上的單字：列車／車廂／支線＝虛線圈襯線字、車票＝實線圈（詳情側板票頭共用） */
export const KIND_GLYPH: Record<NodeKind, string> = {
  line: "幹",
  route: "路",
  branch: "支",
  train: "列",
  car: "廂",
  ticket: "票",
  station: "站",
};

export function badgeClass(kind: NodeKind): string {
  return kind === "ticket" ? "badge" : "badge dashed";
}

/**
 * 票種：**規則 parse 得出來**＝定期券；支線＝支線；臨時車票＝臨時券；其餘（列車／車廂／車票）＝乘車券。
 * ⚠ 判定只認 parseRule 的結果（M3 ④ 全站口徑）：欄位裡塞著 legacy 自由文字（種子的「量體重記錄」）
 *   的票**是乘車券**——那是刻意留下的容錯樣本，不能因為欄位非空就發成定期券。
 */
export function fareClass(node: Pick<NodeRow, "kind" | "repeat_rule"> & { parent_id?: string | null }): {
  label: string;
  teiki: boolean;
} {
  if (parseRule(node.repeat_rule)) return { label: "定期券", teiki: true };
  if (node.kind === "branch") return { label: "支線", teiki: false };
  // 臨時車票（不掛在任何一棵樹上）＝臨時券，與今日列的 fareOf 同一口徑（整合席：WP3 回報 5）。
  // 樹內節點的 parent_id 是路線或上層節點，永遠非 null；沒傳 parent_id 的呼叫端行為不變。
  if (node.parent_id === null) return { label: "臨時券", teiki: false };
  return { label: "乘車券", teiki: false };
}

const STATUS_LABEL: Record<NodeStatus, { text: string; idle: boolean }> = {
  todo: { text: "未開始", idle: true },
  doing: { text: "進行中", idle: false },
  paused: { text: "途中下車", idle: true },
  done: { text: "已完成", idle: false },
};

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

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

/**
 * 誤點註記（件一 .late-hw／.late-plain）：兩枚都畫，CSS 依主題只顯示一枚——
 * 粉彩＝手寫「晚了 N 天」（C2 手寫三處量級內）、銀河＝排印「延誤 N 天」。
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

/** 事件是不是從 portal 出去的浮層（DatePicker 掛 body）沿 React 樹冒上來的——DOM 上不在這個容器裡 */
function fromPortal(e: SyntheticEvent<HTMLElement>): boolean {
  return !e.currentTarget.contains(e.target as Node);
}

/**
 * 票面的日期 chip＝「前綴字＋共用 DateChip」（UI 丙-3 B5）。前綴（執行／原定／締切）是本頁自己畫的：
 * 共用 chip 只印「10/22（四）」，一列同時有執行日與締切時要靠前綴分辨。
 * 大綱容器的鍵盤流規矩在這裡補齊（共用元件不知道它身在大綱裡）：
 *   - chip 不進 Tab 順序（同列內其他鈕 tabIndex=-1）；點它不搶焦點（mousedown 照常冒到列上：選列＋焦點回大綱容器）。
 *   - 挑選器收起後 DatePicker 會把焦點還給 chip ⇒ 轉手還給大綱容器（同舊 outline/DateChip 的 onClose）。
 *   - 挑選器掛 body，但點擊仍沿 React 樹冒到列上（列的 mousedown 會選列＋搶焦點）——只擋 portal 來的那些。
 *   - `clearable` 只為了浮層裡的「清除」（舊 chip 就有）；chip 旁那顆 × 在票面上太吵，outline.css 收掉。
 */
function RowDate({
  prefix,
  date,
  flag,
  label,
  emptyText,
  today,
  onPick,
  onFocusBack,
}: {
  prefix?: string;
  date: string | null;
  flag?: "late" | "backfill";
  label: string;
  emptyText?: string;
  today: string;
  onPick(date: string | null): void;
  onFocusBack(): void;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  // 共用 DateChip 沒有 tabIndex 參數：每次畫完把裡面的鈕退出 Tab 順序（React 不管這個屬性，不會被蓋回去）
  useLayoutEffect(() => {
    ref.current?.querySelectorAll("button").forEach((b) => {
      b.tabIndex = -1;
    });
  });
  const stopPortal = (e: SyntheticEvent<HTMLElement>) => {
    if (fromPortal(e)) e.stopPropagation();
  };
  return (
    <span
      ref={ref}
      className="row-date"
      onMouseDown={stopPortal}
      // 點擊（chip 本身或浮層裡）都不冒到票面——同舊 chip 的 stopPropagation
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={stopPortal}
      onFocus={(e) => {
        if (!fromPortal(e) && (e.target as HTMLElement).classList.contains("ns-datechip")) onFocusBack();
      }}
    >
      {prefix && date && <span className="row-date-pre">{prefix}</span>}
      <DateChip date={date} onPick={onPick} allowPast clearable flag={flag} label={label} emptyText={emptyText} today={today} />
    </span>
  );
}

/** 直屬子項進度（車廂格；≤5 格畫格子，超過只給數字） */
export interface CarStats {
  total: number;
  done: number;
  /** 格子的名稱：列車／車廂／車票 */
  label: string;
}

function Cars({ total, done, label }: CarStats) {
  return (
    <span className="cars" role="img" aria-label={`${label} ${done}／${total}`} title="已完成／全部子項">
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

/** 票根（.stub）：類型徽章（點擊聚焦）＋類型＋票號 */
function Stub({
  kind,
  serial,
  accent,
  onZoom,
  zoomLabel,
  onDoubleClick,
  title,
}: {
  kind: NodeKind;
  serial?: string;
  accent?: string;
  onZoom?: () => void;
  zoomLabel?: string;
  onDoubleClick?: (e: MouseEvent<HTMLDivElement>) => void;
  title?: string;
}) {
  return (
    <div className="stub" style={{ color: accent ?? "var(--color-ink-soft)" }} onDoubleClick={onDoubleClick} title={title}>
      {onZoom ? (
        <button
          type="button"
          tabIndex={-1}
          title={`${KIND_LABEL[kind]}・點擊聚焦`}
          aria-label={zoomLabel ?? "聚焦"}
          onClick={(e) => {
            e.stopPropagation();
            onZoom();
          }}
          className={badgeClass(kind)}
        >
          {KIND_GLYPH[kind]}
        </button>
      ) : (
        <span aria-hidden className={badgeClass(kind)}>
          {KIND_GLYPH[kind]}
        </span>
      )}
      <span className="line-name">{KIND_LABEL[kind]}</span>
      {serial && <span className="serial">No.{serial}</span>}
    </div>
  );
}

export interface OutlineRowProps {
  node: NodeRow;
  depth: number;
  hasChildren: boolean;
  collapsed: boolean;
  selected: boolean;
  /** 剛蓋章 → 播済章動畫 */
  fresh: boolean;
  today: string;
  cars: CarStats | null;
  /** 票根色（路線色）；沒有就走注記色 */
  accent?: string;
  /** 票號「MMDD-NN」 */
  serial?: string;
  /**
   * 定期券「目前班次」的結局（`useNodeStore(s => s.currentOccurrences[id])`；M3 ④）：
   * `{status:'done'}`＝這班済了、`{status:'skipped'}`＝這班運休、null＝這班還沒交代。
   * 非定期券與**退役的定期券**恆 null——那種列的完成仍然看 `node.status === 'done'`。
   */
  occurrence: CurrentOccurrence | null;
  /** 非 null ＝ 這列正在行內改名 */
  rename: EditHandlers | null;
  actions: RowActions;
  onFreshEnd(): void;
  /** 列的 ⋯ 選單項目（10-20 磨光②）：開卡那一刻才算，停用狀態跟著當下的樹 */
  menu?: () => PopMenuItem[];
}

/**
 * 列的 ⋯ 鈕＋小選單（10-20 磨光②）：常駐淡態 `--dim`（UI 丙-3 B3、視覺規範 §3.1 #1），hover／選中（鍵盤聚焦那一列）／選單開著轉實；
 * 位置＝票右下角（與右上角票種小字對稱）。
 * 跟列內其他鈕一樣 tabIndex=-1＋mousedown 不搶焦點；開卡後焦點進卡，Esc 收卡焦點回大綱容器。
 */
function RowMore({ name, menu, onReturnFocus }: { name: string; menu: () => PopMenuItem[]; onReturnFocus: () => void }) {
  const btn = useRef<HTMLButtonElement>(null);
  const [items, setItems] = useState<PopMenuItem[] | null>(null);
  const close = useCallback(() => setItems(null), []);
  return (
    <>
      <button
        ref={btn}
        type="button"
        tabIndex={-1}
        aria-haspopup="menu"
        aria-expanded={items !== null}
        aria-label={`「${name}」的更多動作`}
        title="更多動作"
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          e.stopPropagation();
          setItems((cur) => (cur ? null : menu()));
        }}
        className="row-more"
      >
        <IconDots size={14} />
      </button>
      {items && (
        <PopMenu
          anchor={btn.current}
          overline={{ zh: "這一列", latin: "Row" }}
          label={`「${name}」的更多動作`}
          items={items}
          onClose={close}
          returnFocus={() => {
            onReturnFocus();
            return null;
          }}
        />
      )}
    </>
  );
}

export function OutlineRow({
  node,
  depth,
  hasChildren,
  collapsed,
  selected,
  fresh,
  today,
  cars,
  accent,
  serial,
  occurrence,
  rename,
  actions,
  onFreshEnd,
  menu,
}: OutlineRowProps) {
  const ref = useRef<HTMLLIElement>(null);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  /** 定期券的唯一判定（見檔頭「定期券口徑」）；null＝乘車券／支線／臨時券 */
  const rule = parseRule(node.repeat_rule);
  /** 済了沒：活著的定期券看班次結局，其餘（含退役定期券）看 nodes.status */
  const done = occurrence ? occurrence.status === "done" : node.status === "done";
  /** 本班運休（只有定期券蓋得到） */
  const suspended = occurrence?.status === "skipped";
  /** 済／運休都是「結局」：過期判定與誤點註記都要讓位 */
  const settled = done || suspended;

  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  /** 這一班在講的那一天（過期 chip／誤點註記用它；沒有結局時就等於 scheduled_on） */
  const railDate = occurrence?.due_on ?? node.scheduled_on;
  const pastRun = !!railDate && railDate < today;
  /** 過期且還沒有結局（暖光底＋赭「原定」＋誤點註記） */
  const schedLate = !settled && pastRun;
  /**
   * 結局是今天才補上的：定期券＝這一班有結局（currentOccurrences 只收今天寫下的或目前那一班）；
   * 其餘＝今天的日界線視窗內蓋的済（同今日列「補済留原位」的取法）。
   */
  const settledToday = settled && (occurrence ? true : isInDay(node.completed_at, today, dayStartHour));
  /** 延着章（B4，同今日列 `bucket === "late"`）：過期且未交代，或今天才交代——結局後退到右下（CSS） */
  const lateSeal = pastRun && (!settled || settledToday);
  const dueLate = !settled && !!node.due_on && node.due_on < today;
  /**
   * 執行日 chip 印的日子：過期時講「這一班」（railDate），沒過期時講 `scheduled_on`——
   * 定期券交代完之後引擎已把 scheduled_on 推到**下一班**，大綱要顯示的正是它（計畫視角）。
   */
  const chipDate = schedLate ? railDate : node.scheduled_on;
  /**
   * 定期券 chip 的前綴（M3 ④ 評審 should-2）：本班已交代（occurrence 非 null＝済／運休）時
   * `scheduled_on` 已被引擎推到**下一班**，前綴就得跟著說「下一班」——沿用 QuickJump 的同一個字，
   * 否則「執行 9/12」與旁邊的済章並排會讀成「9/12 已済」。誤點＝「原定」（講這一班）、未交代＝「執行」。
   */
  const railPrefix = schedLate ? "原定" : occurrence ? "下一班" : "執行";
  const fare = fareClass(node);
  const status = STATUS_LABEL[node.status];

  const metaItems: ReactNode[] = [
    // 狀態（done／運休時 CSS 隱藏 .status、改顯示 .done-label／.susp-label——與原型同一套規則）
    <>
      <span className={"status" + (status.idle ? " idle" : "")}>{status.text}</span>
      <span className="done-label">
        已完成 <CheckGlyph />
      </span>
      <span className="susp-label">今日停駛</span>
    </>,
    // 定期券印一句話規則（describeRule，不印 JSON）；legacy 自由文字（parse 不出來的容錯樣本）
    // 照原樣印——票種已經退回乘車券，這行就是「這張規則壞了」的線索。
    rule ? (
      <span>
        <RepeatGlyph />
        {describeRule(rule)}
      </span>
    ) : node.repeat_rule ? (
      <span>
        <RepeatGlyph />
        {node.repeat_rule}
      </span>
    ) : null,
    cars && cars.total > 0 ? <Cars {...cars} /> : null,
    node.estimate_min ? <span>預計 {node.estimate_min} 分</span> : null,
    // 執行日：定期券唯讀（班次由規則排定），其餘可直改
    chipDate ? (
      rule ? (
        <button
          type="button"
          tabIndex={-1}
          aria-label={`${railPrefix} ${mmdd(chipDate)}（定期券，自動排定）`}
          title="定期券：自動排定"
          onClick={(e) => {
            e.stopPropagation();
            actions.noteRepeatDate();
          }}
          className={"date chip locked" + (schedLate ? " late" : "")}
        >
          {railPrefix} {mmdd(chipDate)}
        </button>
      ) : (
        // 延着那一張（含今天才補済的）印「原定」＋赭；其餘印「執行」＋補記旗（選到今天以前＝補記）
        <RowDate
          prefix={lateSeal ? "原定" : "執行"}
          date={chipDate}
          flag={lateSeal ? "late" : "backfill"}
          label="執行日"
          today={today}
          onPick={(v) => actions.setDate(node.id, "scheduled_on", v)}
          onFocusBack={actions.focusContainer}
        />
      )
    ) : null,
    // 過期票在大綱：赭 chip「原定 M/D」之後接誤點註記（件一 d3 樣張逐字）
    schedLate && chipDate ? <LateNote days={diffDays(today, chipDate)} /> : null,
    node.due_on ? (
      <RowDate
        prefix="締切"
        date={node.due_on}
        flag={dueLate ? "late" : undefined}
        label="締切日"
        today={today}
        onPick={(v) => actions.setDate(node.id, "due_on", v)}
        onFocusBack={actions.focusContainer}
      />
    ) : null,
    hasChildren && collapsed ? <span className="fold-note">已收合</span> : null,
  ];

  return (
    <li
      ref={ref}
      role="treeitem"
      aria-level={depth + 1}
      aria-selected={selected}
      aria-expanded={hasChildren ? !collapsed : undefined}
      data-selected={selected}
      data-node-id={node.id}
      style={{ marginLeft: indentPx(depth) }}
      className="ticket-li"
      onMouseDown={(e) => {
        if ((e.target as HTMLElement).closest("input")) return; // 行內輸入框要自己的 caret
        e.preventDefault(); // 不讓列內按鈕搶焦點、不選字
        actions.select(node.id);
        actions.focusContainer();
      }}
    >
      {/* 摺疊／展開鈕（磨光⑤ K5）：有子項才畫，畫在票根左邊的縮排溝（outline.css .row-fold，絕對定位、票不挪位）。
          單擊切換、不搶列的選取（mousedown 擋掉 li 的選列＋不搶焦點）；雙擊票根與鍵盤 ←／→ 照舊 */}
      {hasChildren && (
        <button
          type="button"
          tabIndex={-1}
          className="row-fold"
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? "展開" : "收合"}「${node.name}」`}
          title={collapsed ? `展開（${hotkeyCaps("outline.expand")}）` : `收合（${hotkeyCaps("outline.collapse")}）`}
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onClick={(e) => {
            e.stopPropagation();
            actions.toggleCollapse(node.id);
          }}
        >
          <Chevron open={!collapsed} size={14} />
        </button>
      )}
      <article
        className={
          "ticket" +
          // 暖光底＋赭外框只在「還沒有結局」時亮著（同今日列：補済＝來歷退後）
          (schedLate ? " late-t" : "") +
          (selected ? " selected" : "") +
          (done ? " done" : "") +
          (suspended ? " is-suspended" : "") +
          (fresh ? " fresh" : "")
        }
      >
        {/* 票根：雙擊＝摺疊／展開（有子項才有意義）；徽章＝聚焦 */}
        <Stub
          kind={node.kind}
          serial={serial}
          accent={accent}
          onZoom={() => actions.zoomInto(node.id)}
          zoomLabel={`聚焦「${node.name}」（${KIND_LABEL[node.kind]}）`}
          onDoubleClick={(e) => {
            if (!hasChildren) return;
            e.stopPropagation();
            actions.toggleCollapse(node.id);
          }}
          title={hasChildren ? (collapsed ? "雙擊展開（→）" : "雙擊收合（←）") : undefined}
        />

        {/* 票面 */}
        <div className="body">
          {/* 票種小字＝詳情側板入口（D1 滑鼠入口；鍵盤「.」） */}
          <button
            type="button"
            tabIndex={-1}
            aria-label="打開詳情側板"
            title="詳情（.）"
            onClick={(e) => {
              e.stopPropagation();
              actions.openPanel(node.id);
            }}
            className={"fare-class" + (fare.teiki ? " teiki" : "")}
          >
            {fare.label}
          </button>

          {rename ? (
            <InlineInput
              initial={node.name}
              ariaLabel={`改名「${node.name}」`}
              focusKey={depth}
              onCommit={rename.commit}
              onCancel={rename.cancel}
              onTab={rename.tab}
              className="title"
            />
          ) : (
            <p
              onDoubleClick={(e) => {
                e.stopPropagation();
                actions.rename(node.id);
              }}
              title="雙擊改名（F2）"
              className="title"
            >
              {node.name}
            </p>
          )}

          <div className="meta">
            <MetaItems items={metaItems} />
            {/* 原型沒有的控件：空日期入口 hover／選中才現身（定期券的執行日由規則排定，不給入口） */}
            {((!chipDate && !rule) || !node.due_on) && (
              <span className="meta-hover">
                {!chipDate && !rule && (
                  <RowDate
                    date={null}
                    flag="backfill"
                    label="執行日"
                    emptyText="＋執行日"
                    today={today}
                    onPick={(v) => actions.setDate(node.id, "scheduled_on", v)}
                    onFocusBack={actions.focusContainer}
                  />
                )}
                {!node.due_on && (
                  <RowDate
                    date={null}
                    label="締切日"
                    emptyText="＋締切"
                    today={today}
                    onPick={(v) => actions.setDate(node.id, "due_on", v)}
                    onFocusBack={actions.focusContainer}
                  />
                )}
              </span>
            )}
          </div>
        </div>

        {/* 誤點票的延着角印（B4；同今日列的位置：票面與検印欄之間，検印欄留空）；有結局後退右下小號（CSS） */}
        {lateSeal && <span className="late-seal">延着</span>}

        {/* 検印欄：「済」章（完成流）；定期券本班運休＝墨色角印蓋在同一個位置（語彙同今日列） */}
        <div className="stamp-zone">
          <button
            type="button"
            tabIndex={-1}
            aria-label={suspended ? "取消本班運休" : done ? "取消完成" : "蓋章完成"}
            aria-pressed={done}
            title={suspended ? "本班運休中——再點一次取消（或按 U）" : done ? "取消「済」章" : "蓋章：完成（Space）"}
            onClick={(e) => {
              e.stopPropagation();
              actions.complete(node.id);
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
              <SealSuspended title="運休（本班暫停）" />
            </span>
          )}
        </div>
        {menu && <RowMore name={node.name} menu={menu} onReturnFocus={actions.focusContainer} />}
      </article>
    </li>
  );
}

export interface DraftRowProps {
  depth: number;
  kind: NodeKind;
  accent?: string;
  handlers: EditHandlers;
}

/** 新增中的草稿票：同款票、虛線邊；位置與型別跟著 Tab／Shift+Tab 走，票種小字提示目前會建成什麼 */
export function DraftRow({ depth, kind, accent, handlers }: DraftRowProps) {
  return (
    <li role="treeitem" aria-level={depth + 1} aria-selected style={{ marginLeft: indentPx(depth) }} className="ticket-li">
      <article className="ticket draft">
        <Stub kind={kind} accent={accent} />
        <div className="body">
          <span className="fare-class" aria-hidden>
            {KIND_LABEL[kind]}
          </span>
          <InlineInput
            placeholder={`新的${KIND_LABEL[kind]}…`}
            ariaLabel={`輸入新${KIND_LABEL[kind]}的名稱`}
            focusKey={depth}
            onCommit={handlers.commit}
            onCancel={handlers.cancel}
            onTab={handlers.tab}
            className="title"
          />
          <div className="meta">
            <span className="status idle">Enter 建立・Tab 改層級・Esc 取消</span>
          </div>
        </div>
        <div className="stamp-zone">
          <span aria-hidden className="stamp">
            <span className="hint">検印</span>
          </span>
        </div>
      </article>
    </li>
  );
}
