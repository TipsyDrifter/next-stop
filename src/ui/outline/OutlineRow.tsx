/**
 * OutlineRow／DraftRow／LateRow——大綱的一列＝一張完整車票（結構與 class 1:1 照抄 prototypes/m1-c-techo.html 的 .ticket；CSS 在 styles/techo.css）：
 * .stub（.badge 類型徽章＝點擊聚焦／.line-name 類型／.serial 票號 No.MMDD-NN）＋ .body（.fare-class 票種＝點擊開詳情／.title 標題＝雙擊改名／
 * .meta 狀態・車廂格・預計・執行日／締切 chip）＋ .stamp-zone（検印／済章）。摺疊＝雙擊票根（鍵盤 ←／→ 另有）。
 * DraftRow＝同款票、虛線邊、輸入在 .title 位置；LateRow＝誤點區的 .ticket.late-t（赭 chip「原定 M/D」・
 * 誤點註記「晚了 N 天」〔粉彩手寫〕／「延誤 N 天」〔銀河排印〕＋「延着」印）。
 * 對應 UI Flow 2.0／2.0b／2.0d。取捨：列內按鈕 tabIndex=-1 且 mousedown 不搶焦點——焦點永遠留在大綱容器，鍵盤流不中斷；
 * 原型沒有的控件（空日期入口）hover／選中才現身；優先級不在票面（詳情側板看）。
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
import { useEffect, useRef, type MouseEvent, type ReactNode } from "react";
import { KIND_LABEL, describeRule, parseRule, type NodeKind, type NodeRow, type NodeStatus } from "../../domain";
import type { CurrentOccurrence } from "../../data";
import { SealSuspended } from "../stamps";
import { DateChip } from "./DateChip";
import { InlineInput } from "./InlineInput";
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
  paused: { text: "暫停", idle: true },
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
}: OutlineRowProps) {
  const ref = useRef<HTMLLIElement>(null);
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
  const schedLate = !settled && !!railDate && railDate < today;
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
  // 日期輸入框以鍵盤收起 → 焦點還給大綱容器（點別處收起就不搶）
  const onDateClose = (via: "key" | "blur") => {
    if (via === "key") actions.focusContainer();
  };
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
          aria-label={`${railPrefix} ${mmdd(chipDate)}（定期券由規則排定）`}
          title="定期券：由規則排定"
          onClick={(e) => {
            e.stopPropagation();
            actions.noteRepeatDate();
          }}
          className={"date chip locked" + (schedLate ? " late" : "")}
        >
          {railPrefix} {mmdd(chipDate)}
        </button>
      ) : (
        <DateChip
          value={chipDate}
          prefix={schedLate ? "原定" : "執行"}
          late={schedLate}
          ariaLabel="執行日"
          onChange={(v) => actions.setDate(node.id, "scheduled_on", v)}
          onClose={onDateClose}
        />
      )
    ) : null,
    // 過期票在大綱：赭 chip「原定 M/D」之後接誤點註記（件一 d3 樣張逐字）
    schedLate && chipDate ? <LateNote days={diffDays(today, chipDate)} /> : null,
    node.due_on ? (
      <DateChip
        value={node.due_on}
        prefix="締切"
        late={dueLate}
        ariaLabel="締切日"
        onChange={(v) => actions.setDate(node.id, "due_on", v)}
        onClose={onDateClose}
      />
    ) : null,
    hasChildren && collapsed ? <span className="fold-note">收摺中</span> : null,
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
      <article
        className={
          "ticket" +
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
          title={hasChildren ? (collapsed ? "雙擊展開（→）" : "雙擊摺疊（←）") : undefined}
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
                  <DateChip
                    value={null}
                    placeholder="＋執行日"
                    ariaLabel="執行日"
                    onChange={(v) => actions.setDate(node.id, "scheduled_on", v)}
                    onClose={onDateClose}
                  />
                )}
                {!node.due_on && (
                  <DateChip
                    value={null}
                    placeholder="＋締切"
                    ariaLabel="締切日"
                    onChange={(v) => actions.setDate(node.id, "due_on", v)}
                    onClose={onDateClose}
                  />
                )}
              </span>
            )}
          </div>
        </div>

        {/* 検印欄：「済」章（完成流）；定期券本班運休＝墨色角印蓋在同一個位置（語彙同今日列） */}
        <div className="stamp-zone">
          <button
            type="button"
            tabIndex={-1}
            aria-label={suspended ? "取消本班運休" : done ? "取消完成" : "蓋章完成"}
            aria-pressed={done}
            title={suspended ? "本班運休中——再點一次取消（或按 U）" : done ? "取消済章" : "蓋章：完成（Space）"}
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
              <SealSuspended title="運休（本班停駛）" />
            </span>
          )}
        </div>
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

export interface LateRowProps {
  node: NodeRow;
  /** 執行日過期幾天 */
  daysLate: number;
  /** 這一班在講的那一天＝`occurrence?.due_on ?? scheduled_on`（定期券漏掉的那一班印它，不印 scheduled_on） */
  railDate: string | null;
  accent?: string;
  serial?: string;
  onPick(id: string): void;
}

/** 誤點區的一票（原型 .ticket.late-t）：原定 M/D・延誤 N 日＋「延着」印；點擊＝在大綱裡選到它 */
export function LateRow({ node, daysLate, railDate, accent, serial, onPick }: LateRowProps) {
  const fare = fareClass(node);
  return (
    <article
      className="ticket late-t"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onPick(node.id)}
      title="點擊在大綱中選取"
    >
      <Stub kind={node.kind} serial={serial} accent={accent} />
      <div className="body">
        <span className={"fare-class" + (fare.teiki ? " teiki" : "")}>{fare.label}</span>
        <p className="title">{node.name}</p>
        <div className="meta">
          <span className="chip late">原定 {railDate ? mmdd(railDate) : "—"}</span>
          <span className="sep">・</span>
          <LateNote days={daysLate} />
        </div>
      </div>
      <span className="late-seal">延着</span>
    </article>
  );
}
