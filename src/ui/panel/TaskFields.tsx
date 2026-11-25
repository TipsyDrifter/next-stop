/**
 * 節點詳情側板（v1.36 D-1.36-6「三段式大硬券・漸進式揭露」重構）：
 *   1. 第一段「票頭與歸屬帶」：右上角票種角標（可點擊 PopMenu 切換乘車券／定期券／預留席，消滅舊版兩整行轉換列）、
 *      票名下無框單行空概要（點擊才展開多行）、緊湊歸屬帶（掛在／車站／荷札）。
 *   2. 第二段「行車排程與検印」：推進狀態＋優先順序＋結案雙印記（蓋済｜途中下車）＋排程組
 *      （乘車日 → 單行「時段與預估」漸進式揭露膠囊 → 條件顯示其他時段 → 締切日）；定期券才展開重複規則與本班検印。
 *   3. 第三段「旅途足跡與關聯」：直屬子車票清單（列車／車廂，支援原地蓋済與新增）→ 時刻表累計時數與進度 → 關聯旅客筆記
 *      → 心情三燈（順暢／平穩／吃力，complete/moods.ts）→ 乘務記錄（工作日誌）→ 底部操作列。
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { KIND_LABEL, isTaskKind, parseRule, type Mood, type NodeRow } from "../../domain";
import { REPEATABLE_KINDS } from "../../data";
import { autoProgress, descendantCount, isSettling, openDescendantCount, serialOf, useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";
import { KIND_GLYPH, badgeClass, fareClass } from "../outline/OutlineRow";
import {
  ActionButton,
  ActionsRow,
  CommitInput,
  FieldRow,
  NumberField,
  SectionRule,
} from "./fields";
import { RepeatSection, TeikiStampRow, usePanelRepeat, type PanelRepeat } from "./RepeatRuleEditor";
import { LengthField, TimeSpanField } from "./TimeField";
import { ScheduleSummaryChip, useHasExtraSlots } from "./ScheduleSummaryRow";
import { ChildTicketsSection } from "./ChildTicketsSection";
import { StationFieldRow } from "../board/StationField";
import { Choice } from "./Choice";
import { DateChip } from "../common/DateChip";
import { PopMenu, type PopMenuItem } from "../common/PopMenu";
import {
  DesktopSeatPicker,
  canActAsSeatSlot,
  releaseSeatedFlow,
} from "../common/seating";
import "../common/seating/flexible-seating.css";
import { MOODS } from "../complete/moods";
import { todayKey } from "../../lib/date";
import { fmtDateTime } from "./format";
import { WorkLogList } from "./WorkLogList";
import { LocationFieldRow, useMoveTo, useNodeLocationInfo, type NodeLocationInfo } from "./MoveTo";
import { lineNodeFields } from "../../lines/runtime";
import type { NodeFieldSpec } from "../../lines/types";
import { confirmAndDeleteNode } from "../common/deleteNodeFlow";
import { changeStatusFlow, convertKindFlow, openKidsOf } from "../outline/nodeFlows";
import {
  PRIORITY_OPTIONS,
  PROGRESS_OPTIONS,
  fareModeOf,
  mdwText,
  settlementViewOf,
  switchFare,
  teikiState,
  type FareMode,
  type ProgressStatus,
  type SettledSeal,
} from "./panelRules";
import "./taskStatusSeals.css";

/* 心情三燈的字與色：與完成卡同一份（complete/moods.ts；正名＝順暢／平穩／吃力，存值 green／yellow／red 不變） */

/* ───────────── 入口：依 kind 分派 ───────────── */

export function NodePanel({ node }: { node: NodeRow }) {
  if (isTaskKind(node.kind)) return <TaskPanel node={node} />;
  if (node.kind === "ticket") return <TicketPanel node={node} />;
  if (node.kind === "branch") return <BranchPanel node={node} />;
  return <FallbackPanel node={node} />;
}

/* ───────────── 第一段：票頭（含可點票種角標、單行空概要）與歸屬帶 ───────────── */

function NameBlock({
  node,
  onRename,
  sub,
  stub,
  repeat,
  summaryPlaceholder,
  summaryAriaLabel,
}: {
  node: NodeRow;
  onRename: (name: string) => void;
  sub?: ReactNode;
  stub?: { glyph: string; dashed: boolean; label: string; color: string | null };
  /** 傳入時右上角票種角標升級為可點擊切換選單（乘車券／定期券／預留席） */
  repeat?: PanelRepeat;
  summaryPlaceholder?: string;
  summaryAriaLabel?: string;
}) {
  const done = node.status === "done";
  const updateNode = useNodeStore((s) => s.updateNode);
  const routeColor = useNodeStore((s) => s.routes.find((r) => r.id === s.routeId)?.color ?? null);
  const todaySerial = useNodeStore((s) => s.today.byId[node.id]?.serial);
  const serials = useNodeStore((s) => s.serials);
  const serial = todaySerial ?? serialOf(serials, node.id);
  const tree = useNodeStore((s) => s.tree);
  const routeId = useNodeStore((s) => s.routeId);
  const parentKind =
    node.parent_id && node.parent_id !== routeId
      ? tree.byId[node.parent_id]?.kind
      : node.parent_id === routeId || (node.parent_id === null && node.route_id != null)
        ? "route"
        : undefined;

  const canSwitchFare = Boolean(repeat && REPEATABLE_KINDS.includes(node.kind));
  const mode: FareMode = fareModeOf(node, repeat?.draft.mode);
  const plainLabel = fareClass({ ...node, repeat_rule: null, is_placeholder: null }, parentKind).label;
  const displayFare = canSwitchFare
    ? {
        label: mode === "teiki" ? "定期券" : mode === "seat" ? "預留席" : plainLabel,
        teiki: mode === "teiki",
        seat: mode === "seat",
      }
    : (() => {
        const f = parseRule(node.repeat_rule)
          ? { label: "定期券", teiki: true }
          : fareClass({ ...node, repeat_rule: null }, parentKind);
        return { ...f, seat: Boolean(node.is_placeholder && !f.teiki) };
      })();

  const [fareOpen, setFareOpen] = useState(false);
  const fareBtnRef = useRef<HTMLButtonElement>(null);

  const applyFare = (next: FareMode) => {
    if (!repeat) return;
    if (next === "plain") {
      if (repeat.draft.mode !== "none") repeat.push(switchFare(repeat.draft, false));
      if (node.is_placeholder) void updateNode(node.id, { is_placeholder: null });
    } else if (next === "teiki") {
      repeat.push(switchFare(repeat.draft, true));
      if (node.is_placeholder) void updateNode(node.id, { is_placeholder: null });
    } else if (next === "seat") {
      if (repeat.draft.mode !== "none") repeat.push(switchFare(repeat.draft, false));
      if (!node.is_placeholder) void updateNode(node.id, { is_placeholder: 1 });
    }
  };

  const fareMenuItems: PopMenuItem[] = [
    {
      key: "plain",
      label: mode === "plain" ? `${plainLabel} ✓` : plainLabel,
      hint: "一般單次待辦",
      onSelect: () => applyFare("plain"),
    },
    {
      key: "teiki",
      label: mode === "teiki" ? "定期券 ✓" : "定期券",
      hint: "依重複規則自動排班",
      onSelect: () => applyFare("teiki"),
    },
    {
      key: "seat",
      label: mode === "seat" ? "預留席 ✓" : "預留席",
      hint: "虛線空位，可讓其他待辦入座",
      onSelect: () => applyFare("seat"),
    },
  ];

  const accent = (stub ? stub.color : routeColor) ?? "var(--color-ink-soft)";

  return (
    <header className="panel-head">
      {canSwitchFare ? (
        <>
          <button
            ref={fareBtnRef}
            type="button"
            aria-haspopup="menu"
            aria-expanded={fareOpen}
            aria-label={`票種：${displayFare.label}（點擊切換票種）`}
            title="點擊切換票種（乘車券／定期券／預留席）"
            className={
              "fare-class is-pickable" +
              (displayFare.teiki ? " teiki" : "") +
              (displayFare.seat ? " is-seat" : "") +
              (fareOpen ? " is-open" : "")
            }
            onClick={() => setFareOpen((o) => !o)}
          >
            <span>{displayFare.label}</span>
            <span className="fare-caret" aria-hidden="true">
              ▾
            </span>
          </button>
          {fareOpen && (
            <PopMenu
              anchor={fareBtnRef.current}
              overline={{ zh: "切換票種", latin: "Fare" }}
              label="切換票種"
              items={fareMenuItems}
              onClose={() => setFareOpen(false)}
            />
          )}
        </>
      ) : (
        <span className={`fare-class${displayFare.teiki ? " teiki" : ""}${displayFare.seat ? " is-seat" : ""}`}>
          {displayFare.label}
        </span>
      )}

      <div className="panel-kind" style={{ color: accent }}>
        <span aria-hidden className={stub ? (stub.dashed ? "badge dashed" : "badge") : badgeClass(node.kind)}>
          {stub ? stub.glyph : KIND_GLYPH[node.kind]}
        </span>
        <span className="line-name">{stub ? stub.label : KIND_LABEL[node.kind]}</span>
        {serial && <span className="serial">No.{serial}</span>}
      </div>

      <div className="date-line">
        <CommitInput
          value={node.name}
          onCommit={onRename}
          required
          wrap
          ariaLabel="名稱"
          className={`d ${done ? "done" : ""}`}
        />
      </div>

      {sub && <p className="day-stats">{sub}</p>}

      {summaryPlaceholder && (
        <InlineSummary
          node={node}
          ariaLabel={summaryAriaLabel ?? "概要"}
          placeholder={summaryPlaceholder}
        />
      )}
    </header>
  );
}

/**
 * 緊貼票名下的無框概要（D-1.36-6）：
 *   - 空白時為單行無框淡字鈕「＋ 補一句概要…」，不佔 SectionRule 與多行框高度
 *   - 點擊或已有內容時自動展開多行編輯框；文字清空失焦即優雅收合回單行淡字
 */
function InlineSummary({
  node,
  ariaLabel,
  placeholder,
}: {
  node: NodeRow;
  ariaLabel: string;
  placeholder: string;
}) {
  const updateNode = useNodeStore((s) => s.updateNode);
  const val = node.description ?? "";
  const hasDesc = val.trim().length > 0;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(val);
  const focused = useRef(false);
  const committed = useRef(val);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    committed.current = val;
    if (!focused.current) setDraft(val);
  }, [val, node.id]);

  useEffect(() => {
    if (editing) taRef.current?.focus();
  }, [editing]);

  const commit = () => {
    const next = draft.trim();
    if (next !== committed.current) {
      committed.current = next;
      setDraft(next);
      void updateNode(node.id, { description: next || null });
    } else {
      setDraft(committed.current);
    }
    if (!next) setEditing(false);
  };

  if (!hasDesc && !editing) {
    return (
      <button
        type="button"
        className="panel-summary-add"
        aria-label={`新增${ariaLabel}`}
        onClick={() => setEditing(true)}
      >
        ＋ 補一句概要…
      </button>
    );
  }

  return (
    <div className="panel-summary-edit">
      <textarea
        ref={taRef}
        rows={hasDesc ? 2 : 2}
        aria-label={ariaLabel}
        placeholder={placeholder}
        className="panel-summary-ta"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={() => {
          focused.current = true;
        }}
        onBlur={() => {
          focused.current = false;
          commit();
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            commit();
            taRef.current?.blur();
          } else if (e.key === "Escape") {
            if (draft !== committed.current) {
              e.preventDefault();
              e.stopPropagation();
              setDraft(committed.current);
            } else if (!committed.current) {
              e.preventDefault();
              e.stopPropagation();
              setEditing(false);
            }
          }
        }}
      />
    </div>
  );
}

/** 插槽 `nodeFields` 的段（lines/types NodeFieldSpec.section；不填＝status） */
type FieldSection = NonNullable<NodeFieldSpec["section"]>;

/**
 * 別線登記的節點欄位列（插槽 `nodeFields`）：
 *   - 給單一段名或段名陣列：只渲染對應 section
 *   - 給 `"all"`：渲染所有非 `"schedule"` 的段（給 RoutePanel 等不分三段的面板，確保不遺漏 meta／status／footprint）
 */
function lineFieldsFor(
  node: NodeRow,
  section: FieldSection | readonly FieldSection[] | "all" = "status",
): NodeFieldSpec[] {
  const all = lineNodeFields("desktop").filter((f) => f.kinds.includes(node.kind));
  if (section === "all") return all.filter((f) => f.section !== "schedule");
  const set = typeof section === "string" ? new Set<FieldSection>([section]) : new Set<FieldSection>(section);
  return all.filter((f) => set.has((f.section ?? "status") as FieldSection));
}

/** 也給 RoutePanel 用（路線面板使用 `section="all"` 完整渲染荷札／時間／筆記不遺漏） */
export function LineRows({
  node,
  section,
  filter,
}: {
  node: NodeRow;
  section?: FieldSection | readonly FieldSection[] | "all";
  filter?: (f: NodeFieldSpec) => boolean;
}) {
  const fields = lineFieldsFor(node, section ?? "status");
  const list = filter ? fields.filter(filter) : fields;
  return (
    <>
      {list.map((f) => (
        <FieldRow key={f.id} label={f.label} top={f.top}>
          <f.Desktop node={node} />
        </FieldRow>
      ))}
    </>
  );
}

/** 第一段尾端：緊湊歸屬帶（掛在 ＋ 車站〔有站才出〕 ＋ #荷札） */
function AffiliationBand({ node, locInfo }: { node: NodeRow; locInfo?: NodeLocationInfo }) {
  return (
    <div className="fields panel-affil">
      <LocationFieldRow node={node} info={locInfo} bare />
      <StationFieldRow node={node} />
      <LineRows node={node} section="meta" />
    </div>
  );
}

/* ───────────── 第二段：上半主段 —— 行車排程與検印 ───────────── */

function LockedDate({ value }: { value: string | null }) {
  return (
    <div className="date">
      <span className="latin">{value ? mdwText(value) : "—"}</span>
      <span className="empty" style={{ marginTop: 0 }}>
        依重複設定排班
      </span>
    </div>
  );
}

function ScheduledChip({ node }: { node: NodeRow }) {
  const updateNode = useNodeStore((s) => s.updateNode);
  return (
    <DateChip
      date={node.scheduled_on}
      endDate={node.scheduled_end}
      allowRange
      onPick={(v) => {
        const syncDue = Boolean(node.scheduled_on && node.due_on === (node.scheduled_end ?? node.scheduled_on));
        void updateNode(
          node.id,
          syncDue && v ? { scheduled_on: v, scheduled_end: null, due_on: v } : { scheduled_on: v, scheduled_end: null },
          { backfill: true },
        );
      }}
      onPickRange={(s, e) => {
        const syncDue = Boolean(node.scheduled_on && node.due_on === (node.scheduled_end ?? node.scheduled_on));
        void updateNode(
          node.id,
          syncDue && s
            ? { scheduled_on: s, scheduled_end: e, due_on: e ?? s }
            : { scheduled_on: s, scheduled_end: e },
          { backfill: !e },
        );
      }}
      allowPast
      flag="backfill"
      clearable
      label="乘車日"
    />
  );
}

/**
 * 推進狀態（未開始｜進行中）＋優先順序（低｜中｜高）＋結案雙印記（蓋済｜途中下車）
 * 緊湊整合於上半主段開頭，一眼掌握目前做到哪、多緊急、是否結案。
 */
function StatusAndSealFields({ node }: { node: NodeRow }) {
  const updateNode = useNodeStore((s) => s.updateNode);
  const sv = settlementViewOf(node);
  const lastProgressRef = useRef<{ id: string; status: ProgressStatus }>({
    id: node.id,
    status: node.status === "doing" ? "doing" : "todo",
  });
  if (lastProgressRef.current.id !== node.id) {
    lastProgressRef.current = { id: node.id, status: node.status === "doing" ? "doing" : "todo" };
  } else if (sv.progressValue) {
    lastProgressRef.current.status = sv.progressValue;
  }

  const [freshSeal, setFreshSeal] = useState<SettledSeal | null>(null);
  const restoreTarget = lastProgressRef.current.status;
  const restoreLabel = restoreTarget === "doing" ? "退回進行中" : "退回未開始";

  const applyStatus = (next: NodeRow["status"], seal?: SettledSeal) => {
    if (isSettling(node.id)) return;
    if (seal) setFreshSeal(seal);
    else setFreshSeal(null);
    changeStatusFlow(node, next, openKidsOf(node));
  };

  const toggleSeal = (seal: SettledSeal) => {
    if (seal === "done" && !sv.canStampDone) return;
    if (sv.settled === seal) {
      applyStatus(restoreTarget);
    } else {
      applyStatus(seal, seal);
    }
  };

  return (
    <>
      <FieldRow label="推進狀態">
        <Choice
          value={sv.progressValue}
          options={PROGRESS_OPTIONS}
          onChange={(next) => applyStatus(next)}
          ariaLabel="推進狀態"
        />
      </FieldRow>

      <FieldRow label="優先順序">
        <Choice
          value={node.priority}
          options={PRIORITY_OPTIONS}
          onChange={(v) => void updateNode(node.id, { priority: v })}
          ariaLabel="優先順序"
        />
      </FieldRow>

      <FieldRow label="結案印記" top>
        <div className="ns-seals-wrap">
          <div role="group" aria-label="結案印記" className="ns-seals-row">
            <button
              type="button"
              className={
                "ns-seal-btn is-sumi" +
                (sv.settled === "done" && !sv.noSeal ? " is-on" : "") +
                (freshSeal === "done" && sv.settled === "done" ? " is-fresh" : "")
              }
              aria-pressed={sv.settled === "done" && !sv.noSeal}
              disabled={!sv.canStampDone}
              title={
                sv.doneDisabledWhy ??
                (sv.settled === "done" ? `取消蓋済（${restoreLabel}）` : "蓋済結案（完成）")
              }
              onClick={() => toggleSeal("done")}
              onAnimationEnd={() => setFreshSeal(null)}
            >
              <span className="ns-seal-mark is-sumi" aria-hidden>
                済
              </span>
              <span>蓋済</span>
            </button>

            <button
              type="button"
              className={
                "ns-seal-btn is-geshya" +
                (sv.settled === "paused" ? " is-on" : "") +
                (freshSeal === "paused" && sv.settled === "paused" ? " is-fresh" : "")
              }
              aria-pressed={sv.settled === "paused"}
              title={
                sv.settled === "paused"
                  ? `解除途中下車（${restoreLabel}）`
                  : "蓋途中下車印記（暫時封存，退出誤點與待辦）"
              }
              onClick={() => toggleSeal("paused")}
              onAnimationEnd={() => setFreshSeal(null)}
            >
              <span className="ns-seal-mark is-geshya" aria-hidden>
                下車
              </span>
              <span>途中下車</span>
            </button>
          </div>

          {(sv.sealNote || sv.settled !== null || sv.retiredNote) && (
            <div className="ns-seals-foot">
              {sv.sealNote && (
                <span>
                  {sv.sealNote}
                  {sv.settled === "done" && !sv.noSeal && node.completed_at && (
                    <span className="ns-seals-note-time"> · {fmtDateTime(node.completed_at)}</span>
                  )}
                </span>
              )}
              {sv.settled !== null && (
                <button
                  type="button"
                  className="ns-seals-restore"
                  onClick={() => applyStatus(restoreTarget)}
                >
                  {restoreLabel}
                </button>
              )}
              {sv.retiredNote && <span>{sv.retiredNote}</span>}
            </div>
          )}
        </div>
      </FieldRow>
    </>
  );
}

/**
 * 上半主段：行車排程與検印（推進狀態・優先順序・結案雙印記 ＋ 排程組〔乘車日 → 單行時段與預估膠囊 → 其他時段(條件) → 締切日〕）
 */
function ExecutionScheduleSection({
  node,
  repeat,
  lockedDate,
  teiki,
}: {
  node: NodeRow;
  repeat: PanelRepeat;
  lockedDate: boolean;
  teiki: boolean;
}) {
  const updateNode = useNodeStore((s) => s.updateNode);
  const runOverrides = useNodeStore((s) => s.runOverrides);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const [seatAnchor, setSeatAnchor] = useState<HTMLElement | null>(null);
  const [schedOpen, setSchedOpen] = useState(false);
  const hasExtraSlots = useHasExtraSlots(node, "desktop");

  const syncDueTarget = node.scheduled_end ?? node.scheduled_on;
  const isDueSynced = Boolean(syncDueTarget && node.due_on === syncDueTarget);

  // Mode B：這張單發票是否正入座於某個預留席，或本身是單發預留席
  const seatedOvr =
    !lockedDate && node.scheduled_on
      ? runOverrides.find((o) => !o.deleted_at && o.seated_node_id === node.id && o.due_on === node.scheduled_on)
      : undefined;
  const hostOvr =
    !lockedDate && node.is_placeholder && node.scheduled_on
      ? runOverrides.find((o) => !o.deleted_at && o.node_id === node.id && o.due_on === node.scheduled_on && o.seated_node_id)
      : undefined;
  const canHostSeat = !lockedDate && canActAsSeatSlot(node, node.status === "done") && Boolean(node.scheduled_on);

  return (
    <>
      <SectionRule title="行車排程" />
      <div className="fields">
        <StatusAndSealFields node={node} />

        <div className="sched-group">
          {seatedOvr && (
            <FieldRow label="入座席次">
              <span className="ns-range-row-acts">
                <span className="ns-seat-badge">已入座（{seatedOvr.due_on.slice(5).replace("-", "/")}）</span>
                <button
                  type="button"
                  className="ns-seat-release"
                  onClick={() => void releaseSeatedFlow(seatedOvr.node_id, seatedOvr.due_on, node.id)}
                >
                  釋出預留席
                </button>
              </span>
            </FieldRow>
          )}

          {canHostSeat && node.scheduled_on && (
            <FieldRow label="待辦入座">
              {hostOvr?.seated_node_id ? (
                <span className="ns-range-row-acts">
                  <span className="ns-seat-badge">已有車票入座</span>
                  <button
                    type="button"
                    className="ns-seat-release"
                    onClick={() => void releaseSeatedFlow(node.id, node.scheduled_on!, hostOvr.seated_node_id ?? undefined)}
                  >
                    釋出預留席
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="ns-seat-dropbtn"
                  aria-expanded={seatAnchor !== null}
                  onClick={(e) => setSeatAnchor(seatAnchor ? null : e.currentTarget)}
                >
                  ⇄ 配對待辦入座…
                </button>
              )}
            </FieldRow>
          )}

          <FieldRow label="乘車日">
            {lockedDate ? <LockedDate value={node.scheduled_on} /> : <ScheduledChip node={node} />}
          </FieldRow>

          <FieldRow label="時段" top={schedOpen}>
            <ScheduleSummaryChip
              start={node.scheduled_time}
              estimateMin={node.estimate_min}
              lockedDate={lockedDate}
              expanded={schedOpen}
              onToggle={() => setSchedOpen((o) => !o)}
              variant="desktop"
            >
              <div className="panel-sched-edit-block">
                <TimeSpanField
                  start={node.scheduled_time}
                  estimateMin={node.estimate_min}
                  onStart={(v) => void updateNode(node.id, { scheduled_time: v })}
                  onLen={(min) => void updateNode(node.id, { estimate_min: min })}
                  dayStartHour={dayStartHour}
                  refDay={node.scheduled_on ?? todayKey(dayStartHour)}
                  prefix={lockedDate ? "每班" : undefined}
                />
                <LengthField
                  value={node.estimate_min}
                  onCommit={(v) => void updateNode(node.id, { estimate_min: v })}
                />
              </div>
            </ScheduleSummaryChip>
          </FieldRow>

          {/* 其他時段（timetable.slots）：僅在有資料或展開編輯時顯示 */}
          {(hasExtraSlots || schedOpen) && <LineRows node={node} section="schedule" />}

          <FieldRow label="締切日">
            <div className="panel-due-row">
              <DateChip
                date={node.due_on}
                onPick={(v) => void updateNode(node.id, { due_on: v })}
                allowPast
                clearable
                label="締切日"
              />
              {syncDueTarget && (
                <button
                  type="button"
                  className={"ns-qa-chip" + (isDueSynced ? " is-on" : "")}
                  aria-pressed={isDueSynced}
                  title="將締切日設為與乘車日（或期間訖日）同一天"
                  onClick={() =>
                    void updateNode(node.id, {
                      due_on: isDueSynced ? null : syncDueTarget,
                    })
                  }
                >
                  <span className="k">＝同乘車日</span>
                </button>
              )}
            </div>
          </FieldRow>
        </div>
      </div>

      {/* 定期券專屬：重複規則與本班検印 */}
      <RepeatSection node={node} repeat={repeat} />
      {teiki && <TeikiStampRow node={node} />}

      {seatAnchor && node.scheduled_on && (
        <DesktopSeatPicker
          slotId={node.id}
          slotName={node.name}
          dueOn={node.scheduled_on}
          anchor={seatAnchor}
          onClose={() => setSeatAnchor(null)}
        />
      )}
    </>
  );
}

/* ───────────── 第三段：下半主段 —— 旅途足跡與關聯 ───────────── */

function FootprintSection({ node }: { node: NodeRow }) {
  const tree = useNodeStore((s) => s.tree);
  const updateNode = useNodeStore((s) => s.updateNode);
  const logCount = useNodeStore(
    (s) => s.workLogs[node.id]?.filter((l) => l.event === null).length ?? 0,
  );
  const isParentTask = isTaskKind(node.kind);
  const auto = isParentTask ? autoProgress(tree, node.id) : null;
  const total = isParentTask ? descendantCount(tree, node.id) : 0;
  const doneCount = isParentTask ? total - openDescendantCount(tree, node.id) : 0;
  const carsWord =
    total && (tree.childrenOf[node.id] ?? []).every((id) => tree.byId[id]?.kind === "ticket") ? "車票" : "子項";
  const hasLineAmount = isParentTask && lineFieldsFor(node, "amount").length > 0;

  return (
    <>
      <SectionRule title="旅途足跡" />

      {/* 1. 直屬子車票清單（列車／車廂顯示） */}
      {isParentTask && <ChildTicketsSection node={node} variant="desktop" />}

      {/* 2. 時刻表累計時數、進度、關聯筆記與心情三燈 */}
      <div className="fields panel-footprint-fields">
        {isParentTask ? (
          hasLineAmount ? (
            <LineRows node={node} section="amount" />
          ) : (
            <FieldRow label="花費">
              <NumberField
                value={node.time_spent_min}
                onCommit={(v) => void updateNode(node.id, { time_spent_min: v })}
                ariaLabel="花費時間（分）"
                unit="分"
                placeholder="—"
              />
            </FieldRow>
          )
        ) : (
          <LineRows node={node} section="footprint" filter={(f) => f.id.startsWith("timetable.")} />
        )}

        {isParentTask && (
          <FieldRow label="進度">
            {auto !== null ? (
              <div className="meta" style={{ marginTop: 0 }}>
                {total <= 6 && (
                  <span className="cars" role="img" aria-label={`${carsWord} ${doneCount}/${total}`}>
                    {Array.from({ length: total }, (_, i) => (
                      <i key={i} className={i < doneCount ? "full" : undefined} />
                    ))}
                    <em>
                      {carsWord} {doneCount}/{total}
                    </em>
                  </span>
                )}
                {total > 6 && (
                  <span>
                    {carsWord} {doneCount}/{total}
                  </span>
                )}
                <span className="sep">・</span>
                <span>{auto}%</span>
              </div>
            ) : (
              <NumberField
                value={node.progress}
                onCommit={(v) => void updateNode(node.id, { progress: v ?? 0 })}
                ariaLabel="進度（%）"
                unit="%"
                min={0}
                max={100}
                step={5}
                placeholder="0"
              />
            )}
          </FieldRow>
        )}

        {/* 關聯旅客筆記與其他足跡／預設段欄位 */}
        <LineRows
          node={node}
          section={["footprint", "status"]}
          filter={(f) => !f.id.startsWith("timetable.")}
        />

        {/* 心情三燈（順 · 平 · 難）：歸位至旅途足跡，緊接乘務記錄 */}
        <FieldRow label="心情">
          <MoodLights value={node.mood} onChange={(m) => void updateNode(node.id, { mood: m })} />
        </FieldRow>
      </div>

      {/* 3. 乘務記錄（工作日誌） */}
      <SectionRule title="乘務記錄" aside={logCount ? `${logCount} 則` : undefined} />
      <WorkLogList nodeId={node.id} />
    </>
  );
}

/** 心情三燈：三個 .badge 小圓（順／平／難），點亮一盞；再按同一盞＝熄掉（null） */
function MoodLights({ value, onChange }: { value: Mood | null; onChange: (m: Mood | null) => void }) {
  return (
    <div role="group" aria-label="心情" className="mood">
      {MOODS.map((m) => {
        const active = value === m.value;
        const style: CSSProperties = { color: m.color };
        return (
          <button
            key={m.value}
            type="button"
            aria-label={`心情：${m.label}`}
            aria-pressed={active}
            title={active ? `${m.label}（再按一次清除）` : m.label}
            onClick={() => onChange(active ? null : m.value)}
            className={`badge ${active ? "on" : ""}`}
            style={style}
          >
            <span>{m.glyph}</span>
          </button>
        );
      })}
    </div>
  );
}

/** 改名／刪除／轉型——三個面板共用 */
function useNodeActions() {
  const updateNode = useNodeStore((s) => s.updateNode);
  const select = useUiStore((s) => s.select);

  const remove = (node: NodeRow) => {
    void confirmAndDeleteNode(node.id, {
      around: async (del) => {
        if (await del()) select(null);
      },
      onRestored: () => select(node.id),
    });
  };

  return { updateNode, remove, convert: convertKindFlow };
}

/* ───────────── 列車／車廂 ───────────── */

function TaskPanel({ node }: { node: NodeRow }) {
  const { updateNode, remove, convert } = useNodeActions();
  const repeat = usePanelRepeat(node);
  const locInfo = useNodeLocationInfo(node);

  const done = node.status === "done";
  const { teiki, retired } = teikiState(node);
  const lockedDate = teiki || retired;

  return (
    <div>
      <NameBlock
        node={node}
        repeat={repeat}
        onRename={(name) => void updateNode(node.id, { name, ...(node.is_placeholder ? { is_placeholder: null } : {}) })}
        sub={
          done && node.completed_at ? (
            <>
              完成於 <b>{fmtDateTime(node.completed_at)}</b>
            </>
          ) : undefined
        }
        summaryAriaLabel={`${KIND_LABEL[node.kind]}概要`}
        summaryPlaceholder="補一句要做到什麼程度……"
      />

      <AffiliationBand node={node} locInfo={locInfo} />

      <ExecutionScheduleSection node={node} repeat={repeat} lockedDate={lockedDate} teiki={teiki} />

      <FootprintSection node={node} />

      <ActionsRow
        left={
          node.kind === "train" ? (
            <ActionButton ariaLabel="轉為支線" title="把這班列車改成支線" onClick={() => void convert(node, "branch")}>
              轉為支線
            </ActionButton>
          ) : undefined
        }
        right={
          <ActionButton ariaLabel={`刪除${KIND_LABEL[node.kind]}`} tone="danger" onClick={() => remove(node)}>
            刪除
          </ActionButton>
        }
      />
    </div>
  );
}

/* ───────────── 車票 ───────────── */

function TicketPanel({ node }: { node: NodeRow }) {
  const routes = useNodeStore((s) => s.routes);
  const { updateNode, remove, convert } = useNodeActions();
  const locInfo = useNodeLocationInfo(node);
  const repeat = usePanelRepeat(node);

  const { teiki, retired } = teikiState(node);
  const lockedDate = teiki || retired;
  const done = node.status === "done";

  const isTemp = node.parent_id === null;
  const tagRoute = node.route_id ? routes.find((r) => r.id === node.route_id) : undefined;
  const canConvertToBranch =
    node.route_id !== null && !tagRoute?.arrived_on && locInfo.parentKind !== "train" && locInfo.parentKind !== "car";

  return (
    <div>
      <NameBlock
        node={node}
        repeat={repeat}
        onRename={(name) => void updateNode(node.id, { name, ...(node.is_placeholder ? { is_placeholder: null } : {}) })}
        sub={
          done && node.completed_at ? (
            <>
              完成於 <b>{fmtDateTime(node.completed_at)}</b>
            </>
          ) : undefined
        }
        stub={
          isTemp
            ? {
                glyph: tagRoute?.code ?? (tagRoute ? tagRoute.name.slice(0, 1) : "臨"),
                dashed: !tagRoute,
                label: tagRoute?.name ?? "無路線",
                color: tagRoute?.color ?? "var(--route-none)",
              }
            : undefined
        }
        summaryAriaLabel="車票概要"
        summaryPlaceholder="補一句要做到什麼程度……"
      />

      <AffiliationBand node={node} locInfo={locInfo} />

      <ExecutionScheduleSection node={node} repeat={repeat} lockedDate={lockedDate} teiki={teiki} />

      <FootprintSection node={node} />

      <ActionsRow
        left={
          <>
            {canConvertToBranch && (
              <ActionButton
                ariaLabel="轉為支線"
                title="把這張車票改成支線（主題）"
                onClick={() => void convert(node, "branch")}
              >
                轉為支線
              </ActionButton>
            )}
            {node.route_id !== null && !tagRoute?.arrived_on && (
              <ActionButton
                ariaLabel="新增子車票"
                title="在此車票底下新增子車票，此車票將自動升格為列車或車廂"
                onClick={() => {
                  void (async () => {
                    useUiStore.getState().setCollapsed(node.id, false);
                    const child = await useNodeStore.getState().createNode({
                      kind: "ticket",
                      name: "新車票",
                      parentId: node.id,
                    });
                    if (child) useUiStore.getState().select(child.id);
                  })();
                }}
              >
                ＋子車票
              </ActionButton>
            )}
          </>
        }
        right={
          <ActionButton ariaLabel="刪除車票" tone="danger" onClick={() => remove(node)}>
            刪除
          </ActionButton>
        }
      />
    </div>
  );
}

/* ───────────── 支線 ───────────── */

function BranchPanel({ node }: { node: NodeRow }) {
  const tree = useNodeStore((s) => s.tree);
  const { updateNode, remove, convert } = useNodeActions();
  const locInfo = useNodeLocationInfo(node);
  const n = descendantCount(tree, node.id);

  return (
    <div>
      <NameBlock
        node={node}
        onRename={(name) => void updateNode(node.id, { name, ...(node.is_placeholder ? { is_placeholder: null } : {}) })}
        sub={
          n > 0 ? (
            <>
              含 <b>{n}</b> 個節點
            </>
          ) : undefined
        }
        summaryAriaLabel="支線概要"
        summaryPlaceholder="這條支線負責什麼……"
      />

      {/* 歸屬帶：掛在 ＋ 車站（可繼承）＋ 荷札 */}
      <AffiliationBand node={node} locInfo={locInfo} />

      {/* 支線足跡：時間與關聯筆記（確保不遺漏 footprint／status） */}
      <BranchFootprintFields node={node} />

      <ActionsRow
        left={
          <>
            <ActionButton ariaLabel="轉為列車" title="把這條支線改成一班列車（任務）" onClick={() => void convert(node, "train")}>
              轉為列車
            </ActionButton>
            {!locInfo.hasKids && (
              <ActionButton ariaLabel="轉為車票" title="把這條空支線改成一張車票" onClick={() => void convert(node, "ticket")}>
                轉為車票
              </ActionButton>
            )}
          </>
        }
        right={
          <ActionButton ariaLabel="刪除支線" tone="danger" onClick={() => remove(node)}>
            刪除
          </ActionButton>
        }
      />
    </div>
  );
}

function BranchFootprintFields({ node }: { node: NodeRow }) {
  const footprintFields = lineFieldsFor(node, ["footprint", "status"]);
  if (!footprintFields.length) return null;
  return (
    <>
      <SectionRule title="旅途足跡" />
      <div className="fields">
        <LineRows node={node} section={["footprint", "status"]} />
      </div>
    </>
  );
}

/* ───────────── 其他 kind（保底只給改名＋刪除） ───────────── */

function FallbackPanel({ node }: { node: NodeRow }) {
  const { updateNode, remove } = useNodeActions();
  const move = useMoveTo(node);
  return (
    <div>
      <NameBlock node={node} onRename={(name) => void updateNode(node.id, { name })} />
      <ActionsRow
        left={move.button}
        right={
          <ActionButton ariaLabel={`刪除${KIND_LABEL[node.kind]}`} tone="danger" onClick={() => remove(node)}>
            刪除
          </ActionButton>
        }
      />
      {move.picker}
    </div>
  );
}
