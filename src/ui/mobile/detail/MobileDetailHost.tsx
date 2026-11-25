/**
 * 手機詳情頁（v1.36 D-1.36-6「三段式大硬券・漸進式揭露」重構，與桌機側板 100% 雙端同等）：
 *   1. 第一段「票頭與歸屬帶」：票根列右側 `.m-dt-fare` 升級為可點擊切換按鈕（開 MSheet 切換乘車券／定期券／預留席，
 *      消滅下方兩整行低頻轉換列）、名稱下無框單行空概要（點擊展開多行）、緊湊歸屬帶（掛在／車站／荷札）。
 *   2. 第二段「行車排程與検印」：推進狀態 → 優先順序 → 結案雙印記（蓋済｜途中下車）→ 排程組
 *      （乘車日 → 單行「時段與預估」漸進式揭露膠囊 → 條件顯示其他時段 → 締切日）；定期券才展開重複規則與本班検印。
 *   3. 第三段「旅途足跡與關聯」：直屬子車票清單（列車／車廂，支援原地蓋済與新增）→ 時刻表累計時數與進度 → 關聯旅客筆記
 *      → 心情三燈（順暢／平穩／吃力）→ 乘務記錄 → 競合 → 轉種類 → 刪除。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { KIND_LABEL, WORK_LOG_EVENT_LABEL, describeConflict, isTaskKind, parseRule, type NodeKind, type NodeRow } from "../../../domain";
import { REPEATABLE_KINDS, nodeRepo } from "../../../data";
import { isMultiDayTicket } from "../../../domain/dateRange";
import { effectiveTime, isTimeOverridden } from "../../../domain/scheduledTime";
import { currentDest, moveTargetRule } from "../../../domain/moveTo";
import type { AttachTarget } from "../../../domain/notes";
import { todayKey } from "../../../lib/date";
import { lineNodeFields } from "../../../lines/runtime";
import type { NodeFieldSpec } from "../../../lines/types";
import { conflictNameOf, isSettling, serialOf, useNodeStore } from "../../../store/nodeStore";
import { useSelectionStore } from "../../../store/selectionStore";
import { useUiStore } from "../../../store/uiStore";
import { CommitInput } from "../../common/fields";
import { MFullPage } from "../../common/MFullPage";
import { MSheet, MSheetItem } from "../../common/MSheet";
import { MobileAttachPicker, RouteRoundel } from "../../common/MobileAttachPicker";
import type { AttachKind } from "../../notes/useAttachOptions";
import { MobileDatePicker, type DateQuick } from "../../common/MobileDatePicker";
import { dateChipRangeText } from "../../common/DateChip";
import { dueQuickSet, scheduledQuickSet } from "../../common/datePickRules";
import { MobileSeatSheet, canActAsSeatSlot, releaseSeatedFlow } from "../../common/seating";
import "../../common/seating/flexible-seating.css";
import { IconClose } from "../../common/icons";
import { reattachTo } from "../../common/quickadd/reattach";
import { useNodeLocationInfo, type NodeLocationInfo } from "../../panel/MoveTo";
import "../../common/moveTo.css";
import { MOODS } from "../../complete/moods";
import { fareClass } from "../../outline/OutlineRow";
import { convertKindFlow, moveRunFlow, resetRunTimeFlow } from "../../outline/nodeFlows";
import { useMinuteTick } from "../../schedule/useMinuteTick";
import { MobileTimeSheet, timeReceipt } from "../MobileTimeSheet";
import { confirmAndDeleteNode } from "../../common/deleteNodeFlow";
import { fareModeOf, mdwText, runDateBounds, switchFare, teikiState, type FareMode } from "../../panel/panelRules";
import { spanEnd } from "../../panel/clockValue";
import { LengthField } from "../../panel/TimeField";
import { ScheduleSummaryChip, useHasExtraSlots } from "../../panel/ScheduleSummaryRow";
import { ChildTicketsSection } from "../../panel/ChildTicketsSection";
import { useRepeatDraft } from "../../panel/useRepeatDraft";
import type { PanelRepeat } from "../../panel/RepeatRuleEditor";
import { fmtLogStamp, splitLogs, timeCardOf } from "./detailModel";
import { MobileRepeatSection } from "./MobileRepeatSection";
import { MobileRouteBody } from "./MobileRouteBody";
import { useMobileDetailStore } from "./mobileDetailStore";
import { AmountRows, DoneAt, Row, StampRows, StatusRows } from "./MobileStateRows";
import { MobileStationRow } from "./MobileStationRow";
import "./detail.css";

/** 全螢幕頁那一層的返回層 id */
const PAGE_LAYER = "core.detail";
/** 疊在頁上的子 sheet 那一層（同一時間只開一張；種類由 MSheet 自己認成 "dialog"） */
const SUB_LAYER = "core.detail.sub";

export function MobileDetailHost() {
  const nodeId = useMobileDetailStore((s) => s.nodeId);
  if (!nodeId) return null;
  return <DetailPage key={nodeId} nodeId={nodeId} />;
}

/* ───────────── 找節點＋外框 ───────────── */

function DetailPage({ nodeId }: { nodeId: string }) {
  const close = useMobileDetailStore((s) => s.close);
  useEffect(() => {
    if (useSelectionStore.getState().ids.length) useSelectionStore.getState().clear();
  }, []);
  const sliced = useNodeStore((s) => s.tree.byId[nodeId] ?? s.today.byId[nodeId] ?? s.routes.find((r) => r.id === nodeId));
  const tree = useNodeStore((s) => s.tree);
  const today = useNodeStore((s) => s.today);
  const occ = useNodeStore((s) => s.currentOccurrences);
  const calendar = useNodeStore((s) => s.calendar);
  const [fetched, setFetched] = useState<{ row: NodeRow | null } | null>(null);
  useEffect(() => {
    let alive = true;
    void nodeRepo
      .getNode(nodeId)
      .then((n) => {
        if (alive) setFetched({ row: n && !n.deleted_at ? n : null });
      })
      .catch(() => {
        if (alive) setFetched({ row: null });
      });
    return () => {
      alive = false;
    };
  }, [nodeId, tree, today, occ, calendar]);

  const gone = !sliced && fetched !== null && fetched.row === null;
  useEffect(() => {
    if (gone) close();
  }, [gone, close]);

  const node = sliced ?? fetched?.row ?? undefined;

  useEffect(
    () =>
      useUiStore.subscribe((s, prev) => {
        if (s.mobileTab !== prev.mobileTab) close();
      }),
    [close],
  );

  return (
    <MFullPage title={node ? `${KIND_LABEL[node.kind]}詳情` : "詳情"} left={{ label: "返回", back: true, onClick: close }} backId={PAGE_LAYER}>
      {node && (node.kind === "route" ? <MobileRouteBody route={node} onClose={close} /> : <DetailBody node={node} onClose={close} />)}
    </MFullPage>
  );
}

type Sub =
  | {
      kind: "date";
      title: string;
      value: string | null;
      endValue?: string | null;
      isMultiDay?: boolean;
      allowRange?: boolean;
      quick: readonly DateQuick[];
      min?: string;
      max?: string;
      onPick(day: string): void;
      onPickRange?(start: string, end: string | null, isMultiDay?: boolean): void;
    }
  | { kind: "time" }
  | { kind: "end" }
  | { kind: "run"; railDate: string }
  | { kind: "seat"; slotId: string; slotName: string; dueOn: string }
  | { kind: "fare" }
  | { kind: "move"; from: AttachTarget };

/* ───────────── 內容 ───────────── */

function DetailBody({ node, onClose }: { node: NodeRow; onClose: () => void }) {
  const updateNode = useNodeStore((s) => s.updateNode);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const today = todayKey(dayStartHour);
  const [sub, setSub] = useState<Sub | null>(null);
  const closeSub = () => setSub(null);

  const task = isTaskKind(node.kind) || node.kind === "ticket";
  const repeatable = REPEATABLE_KINDS.includes(node.kind);
  const repeat = useRepeatDraft(node);
  const [repOpen, setRepOpen] = useState(false);

  const moveRule = moveTargetRule(node.kind);
  const locInfo = useNodeLocationInfo(node);

  const fareMode: FareMode = fareModeOf(node, repeatable ? repeat.draft.mode : undefined);
  const plainFare = fareClass({ ...node, repeat_rule: null, is_placeholder: null }, locInfo.parentKind ?? undefined).label;

  const applyFare = (next: FareMode) => {
    closeSub();
    if (!repeatable) return;
    if (next === "plain") {
      if (repeat.draft.mode !== "none") repeat.push(switchFare(repeat.draft, false));
      if (node.is_placeholder) void updateNode(node.id, { is_placeholder: null });
    } else if (next === "teiki") {
      repeat.push(switchFare(repeat.draft, true));
      setRepOpen(true);
      if (node.is_placeholder) void updateNode(node.id, { is_placeholder: null });
    } else if (next === "seat") {
      if (repeat.draft.mode !== "none") repeat.push(switchFare(repeat.draft, false));
      if (!node.is_placeholder) void updateNode(node.id, { is_placeholder: 1 });
    }
  };

  const startMove = async () => {
    let parentKind: NodeKind | null = null;
    if (node.parent_id) {
      const s = useNodeStore.getState();
      parentKind = s.routes.some((r) => r.id === node.parent_id)
        ? "route"
        : ((s.tree.byId[node.parent_id] ?? s.today.byId[node.parent_id])?.kind ??
          (await nodeRepo.getNode(node.parent_id))?.kind ??
          null);
    }
    setSub({ kind: "move", from: currentDest(node.parent_id, parentKind, node.route_id) });
  };

  const remove = () => {
    onClose();
    void confirmAndDeleteNode(node.id);
  };

  const canTicketToBranch =
    node.kind === "ticket" &&
    node.route_id !== null &&
    !locInfo.route?.arrived_on &&
    locInfo.parentKind !== "train" &&
    locInfo.parentKind !== "car";

  return (
    <div className="m-dt">
      {/* 第一段：票頭（票根・可點票種角標・名稱・完成於・單行空概要） */}
      <header className="m-dt-head">
        <Stub
          node={node}
          parentKind={locInfo.parentKind ?? undefined}
          fareMode={repeatable ? fareMode : undefined}
          plainFare={plainFare}
          onOpenFare={repeatable ? () => setSub({ kind: "fare" }) : undefined}
        />
        <CommitInput
          value={node.name}
          onCommit={(name) =>
            void updateNode(node.id, { name, ...(node.is_placeholder ? { is_placeholder: null } : {}) })
          }
          required
          wrap
          ariaLabel="名稱"
          className="m-dt-name"
        />
        <DoneAt node={node} />
        {node.kind !== "station" && <MobileInlineSummary node={node} />}
      </header>

      {task ? (
        <TaskFields
          node={node}
          today={today}
          setSub={setSub}
          locInfo={locInfo}
          repeat={repeat}
          repOpen={repOpen}
          onToggleRep={() => setRepOpen((o) => !o)}
          onStartMove={() => void startMove()}
        />
      ) : (
        <>
          {/* 支線等非任務節點：歸屬帶 ＋ 足跡欄位（不遺漏 meta／footprint／status） */}
          <div className="m-dt-group is-affil">
            {moveRule && <LocationPickRow info={locInfo} onOpen={() => void startMove()} />}
            {node.kind === "branch" && <MobileStationRow node={node} />}
            <LineFieldRows node={node} sections={["meta"]} inGroup />
          </div>
          <BranchFootprintMobile node={node} />
        </>
      )}

      {/* 轉種類（雙端同等） */}
      {(node.kind === "train" || node.kind === "branch") && (
        <button type="button" className="m-dt-link" onClick={() => void convertKindFlow(node, node.kind === "train" ? "branch" : "train")}>
          <span>{node.kind === "train" ? "轉為支線" : "轉為列車"}</span>
          <span className="m-dt-link-aside">{node.kind === "train" ? "把這班列車改成支線" : "把這條支線改成一班列車"}</span>
          <span className="m-dt-chev" aria-hidden="true">
            ›
          </span>
        </button>
      )}
      {canTicketToBranch && (
        <button type="button" className="m-dt-link" onClick={() => void convertKindFlow(node, "branch")}>
          <span>轉為支線</span>
          <span className="m-dt-link-aside">把這張車票改成支線（主題）</span>
          <span className="m-dt-chev" aria-hidden="true">
            ›
          </span>
        </button>
      )}
      {node.kind === "branch" && !locInfo.hasKids && (
        <button type="button" className="m-dt-link" onClick={() => void convertKindFlow(node, "ticket")}>
          <span>轉為車票</span>
          <span className="m-dt-link-aside">把這條空支線改成一張車票</span>
          <span className="m-dt-chev" aria-hidden="true">
            ›
          </span>
        </button>
      )}

      <button type="button" className="ns-btn btn-ghost ns-btn-danger m-dt-delete" onClick={remove}>
        刪除{KIND_LABEL[node.kind]}
      </button>

      {/* ── 疊在頁上的子 sheet（同一時間一張；返回鍵＝關這一張） ── */}
      {sub?.kind === "fare" && repeatable && (
        <MSheet list title="切換票種" overline={node.name} backId={SUB_LAYER} backKind="dialog" onClose={closeSub}>
          <MSheetItem
            ariaLabel={fareMode === "plain" ? `${plainFare}（目前）` : plainFare}
            onClick={() => applyFare("plain")}
          >
            {plainFare}
            {fareMode === "plain" && <span className="m-tks-aside">✓</span>}
            <small>一般單次待辦</small>
          </MSheetItem>
          <MSheetItem
            ariaLabel={fareMode === "teiki" ? "定期券（目前）" : "定期券"}
            onClick={() => applyFare("teiki")}
          >
            定期券
            {fareMode === "teiki" && <span className="m-tks-aside">✓</span>}
            <small>依重複規則自動排班</small>
          </MSheetItem>
          <MSheetItem
            ariaLabel={fareMode === "seat" ? "預留席（目前）" : "預留席"}
            onClick={() => applyFare("seat")}
          >
            預留席
            {fareMode === "seat" && <span className="m-tks-aside">✓</span>}
            <small>虛線空位，可讓其他待辦入座</small>
          </MSheetItem>
        </MSheet>
      )}
      {sub?.kind === "date" && (
        <MobileDatePicker
          title={sub.title}
          value={sub.value}
          endValue={sub.endValue}
          isMultiDay={sub.isMultiDay}
          allowRange={sub.allowRange}
          min={sub.min}
          max={sub.max}
          today={today}
          quick={sub.quick}
          onPick={(d) => {
            closeSub();
            if (d !== sub.value || sub.endValue || sub.isMultiDay) sub.onPick(d);
          }}
          onPickRange={
            sub.onPickRange
              ? (s, e, multi) => {
                  closeSub();
                  if (s !== sub.value || (e ?? null) !== (sub.endValue ?? null) || Boolean(multi) !== Boolean(sub.isMultiDay)) {
                    sub.onPickRange?.(s, e, multi);
                  }
                }
              : undefined
          }
          onClose={closeSub}
          backId={SUB_LAYER}
          backKind="dialog"
        />
      )}
      {sub?.kind === "seat" && (
        <MobileSeatSheet
          slotId={sub.slotId}
          slotName={sub.slotName}
          dueOn={sub.dueOn}
          backId={SUB_LAYER}
          backKind="dialog"
          onClose={closeSub}
        />
      )}
      {sub?.kind === "time" && <TimeSub node={node} today={today} onClose={closeSub} />}
      {sub?.kind === "end" && <EndSub node={node} today={today} onClose={closeSub} />}
      {sub?.kind === "run" && <RunTimeSub node={node} railDate={sub.railDate} today={today} onClose={closeSub} />}
      {sub?.kind === "move" && moveRule && (
        <MobileAttachPicker
          title={moveRule.label}
          depth={moveRule.depth}
          kinds={moveRule.depth === "node" ? (moveRule.kinds as readonly AttachKind[]) : undefined}
          routeSelectable={moveRule.routeSelectable}
          value={sub.from}
          excludeId={node.id}
          currentNote="目前位置"
          backKind="dialog"
          onPick={(t) => {
            closeSub();
            void reattachTo(node, { routeId: t.routeId, nodeId: t.nodeId });
          }}
          onClear={
            node.kind === "ticket" && (node.parent_id !== null || node.route_id !== null)
              ? () => {
                  closeSub();
                  void reattachTo(node, null);
                }
              : undefined
          }
          clearLabel="無路線（臨時車票）"
          onClose={closeSub}
        />
      )}
    </div>
  );
}

/** 票名下的無框單行空概要（點擊才展開多行；清空失焦退回單行淡字） */
function MobileInlineSummary({ node }: { node: NodeRow }) {
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
      <button type="button" className="m-dt-note-add" aria-label="新增概要" onClick={() => setEditing(true)}>
        ＋ 補一句概要…
      </button>
    );
  }

  return (
    <div className="m-dt-note">
      <textarea
        ref={taRef}
        rows={2}
        aria-label="概要"
        placeholder="補一句要做到什麼程度…"
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

function LocationPickRow({ info, onOpen }: { info: NodeLocationInfo; onOpen: () => void }) {
  const pathText = info.route ? info.segments.join(" › ") : "無路線（臨時券）";
  return (
    <Row label="掛在">
      <button type="button" className="m-dt-pick" aria-label={`掛在：${pathText}`} onClick={onOpen}>
        {info.route ? (
          <>
            <RouteRoundel route={info.route} />
            <span className="m-dt-loc-path">{pathText}</span>
          </>
        ) : (
          <span className="is-empty">{pathText}</span>
        )}
        <span className="m-dt-chev" aria-hidden="true">
          ›
        </span>
      </button>
    </Row>
  );
}

/* ───────────── 票根列（右上可點票種角標） ───────────── */

function Stub({
  node,
  parentKind,
  fareMode,
  plainFare,
  onOpenFare,
}: {
  node: NodeRow;
  parentKind?: NodeKind;
  fareMode?: FareMode;
  plainFare?: string;
  onOpenFare?: () => void;
}) {
  const route = useNodeStore((s) => (node.route_id ? s.routes.find((r) => r.id === node.route_id) : undefined));
  const todaySerial = useNodeStore((s) => s.today.byId[node.id]?.serial);
  const serials = useNodeStore((s) => s.serials);
  const serial = todaySerial ?? serialOf(serials, node.id);
  const color = route?.color ?? "var(--route-none)";

  const displayFare =
    fareMode !== undefined
      ? {
          label: fareMode === "teiki" ? "定期券" : fareMode === "seat" ? "預留席" : (plainFare ?? "乘車券"),
          teiki: fareMode === "teiki",
          seat: fareMode === "seat",
        }
      : (() => {
          const f = parseRule(node.repeat_rule)
            ? { label: "定期券", teiki: true }
            : fareClass({ ...node, repeat_rule: null }, parentKind);
          return { ...f, seat: Boolean(node.is_placeholder && !f.teiki) };
        })();

  return (
    <div className="m-dt-stub">
      <span className={"m-dt-route" + (route ? "" : " is-none")} style={{ ["--c" as string]: color }} aria-hidden="true">
        {route ? (route.code ?? route.name.slice(0, 1)) : "臨"}
      </span>
      <span className="m-dt-route-name">{route ? route.name : "無路線"}</span>
      {serial && <span className="m-dt-serial">No.{serial}</span>}
      {onOpenFare ? (
        <button
          type="button"
          className={
            "m-dt-fare is-pickable" +
            (displayFare.teiki ? " is-teiki" : "") +
            (displayFare.seat ? " is-seat" : "")
          }
          aria-haspopup="dialog"
          aria-label={`票種：${displayFare.label}（點擊切換票種）`}
          onClick={onOpenFare}
        >
          <span>{displayFare.label}</span>
          <span className="m-dt-fare-caret" aria-hidden="true">
            ▾
          </span>
        </button>
      ) : (
        <span
          className={
            "m-dt-fare" +
            (displayFare.teiki ? " is-teiki" : "") +
            (displayFare.seat ? " is-seat" : "")
          }
        >
          {displayFare.label}
        </span>
      )}
    </div>
  );
}

/* ───────────── 列車／車廂／車票的三段式大硬券欄位 ───────────── */

function TaskFields({
  node,
  today,
  setSub,
  locInfo,
  repeat,
  repOpen,
  onToggleRep,
  onStartMove,
}: {
  node: NodeRow;
  today: string;
  setSub: (s: Sub) => void;
  locInfo: NodeLocationInfo;
  repeat: PanelRepeat;
  repOpen: boolean;
  onToggleRep: () => void;
  onStartMove: () => void;
}) {
  const updateNode = useNodeStore((s) => s.updateNode);
  const runOverrides = useNodeStore((s) => s.runOverrides);
  const weekStart = useUiStore((s) => s.weekStart);
  const repeatable = REPEATABLE_KINDS.includes(node.kind);
  const { draft, push } = repeat;
  const { teiki, retired } = teikiState(node);
  const ruled = teiki || retired;
  const [schedOpen, setSchedOpen] = useState(false);
  const hasExtraSlots = useHasExtraSlots(node, "mobile");

  const syncDueTarget = node.scheduled_end ?? node.scheduled_on;
  const isDueSynced = Boolean(syncDueTarget && node.due_on === syncDueTarget);

  const seatedOvr =
    !ruled && node.scheduled_on
      ? runOverrides.find((o) => !o.deleted_at && o.seated_node_id === node.id && o.due_on === node.scheduled_on)
      : undefined;
  const hostOvr =
    !ruled && node.is_placeholder && node.scheduled_on
      ? runOverrides.find((o) => !o.deleted_at && o.node_id === node.id && o.due_on === node.scheduled_on && o.seated_node_id)
      : undefined;
  const canHostSeat = !ruled && canActAsSeatSlot(node, node.status === "done") && Boolean(node.scheduled_on);

  const pickDate = (
    title: string,
    value: string | null,
    quick: readonly DateQuick[],
    onPick: (d: string) => void,
    range?: {
      min?: string;
      max?: string;
      endValue?: string | null;
      isMultiDay?: boolean;
      allowRange?: boolean;
      onPickRange?(s: string, e: string | null, isMultiDay?: boolean): void;
    },
  ) => setSub({ kind: "date", title, value, quick, onPick, ...range });

  return (
    <>
      {/* ── 第一段尾端：緊湊歸屬帶（掛在 ＋ 車站 ＋ 荷札） ── */}
      <div className="m-dt-group is-affil">
        <LocationPickRow info={locInfo} onOpen={onStartMove} />
        <MobileStationRow node={node} />
        <LineFieldRows node={node} sections={["meta"]} inGroup />
      </div>

      {/* ── 第二段：上半主段 —— 行車排程與検印 ── */}
      <section className="m-dt-band">
        <h3 className="m-dt-band-title">行車排程</h3>
        <div className="m-dt-group">
          <StatusRows node={node} />

          {seatedOvr && (
            <Row label="入座席次">
              <div className="ns-range-row-acts">
                <span className="ns-seat-badge">已入座（{seatedOvr.due_on.slice(5).replace("-", "/")}）</span>
                <button
                  type="button"
                  className="ns-seat-release"
                  onClick={() => void releaseSeatedFlow(seatedOvr.node_id, seatedOvr.due_on, node.id)}
                >
                  釋出預留席
                </button>
              </div>
            </Row>
          )}

          {canHostSeat && node.scheduled_on && (
            <Row label="待辦入座">
              {hostOvr?.seated_node_id ? (
                <div className="ns-range-row-acts">
                  <span className="ns-seat-badge">已有車票入座</span>
                  <button
                    type="button"
                    className="ns-seat-release"
                    onClick={() => void releaseSeatedFlow(node.id, node.scheduled_on!, hostOvr.seated_node_id ?? undefined)}
                  >
                    釋出預留席
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="ns-seat-dropbtn"
                  onClick={() => setSub({ kind: "seat", slotId: node.id, slotName: node.name, dueOn: node.scheduled_on! })}
                >
                  ⇄ 配對待辦入座…
                </button>
              )}
            </Row>
          )}

          <Row label="乘車日">
            {ruled ? (
              <span className="m-dt-locked">
                {node.scheduled_on ? mdwText(node.scheduled_on) : "—"}
                <span className="m-dt-sub">・依重複設定排班</span>
              </span>
            ) : (
              <DatePick
                value={node.scheduled_on}
                endValue={node.scheduled_end}
                isMultiDay={isMultiDayTicket(node)}
                empty="沒排日期"
                label="乘車日"
                onOpen={() =>
                  pickDate(
                    "乘車日",
                    node.scheduled_on,
                    scheduledQuickSet(today, weekStart),
                    (d) => {
                      const syncDue = Boolean(node.scheduled_on && node.due_on === (node.scheduled_end ?? node.scheduled_on));
                      void updateNode(
                        node.id,
                        syncDue
                          ? { scheduled_on: d, scheduled_end: null, is_multi_day: null, due_on: d }
                          : { scheduled_on: d, scheduled_end: null, is_multi_day: null },
                        { backfill: true },
                      );
                    },
                    {
                      endValue: node.scheduled_end,
                      isMultiDay: isMultiDayTicket(node),
                      allowRange: true,
                      onPickRange: (s, e, multi) => {
                        const syncDue = Boolean(node.scheduled_on && node.due_on === (node.scheduled_end ?? node.scheduled_on));
                        const nextMulti = e && multi ? 1 : null;
                        void updateNode(
                          node.id,
                          syncDue
                            ? { scheduled_on: s, scheduled_end: e, is_multi_day: nextMulti, due_on: e ?? s }
                            : { scheduled_on: s, scheduled_end: e, is_multi_day: nextMulti },
                          { backfill: !e },
                        );
                      },
                    },
                  )
                }
                onClear={() =>
                  void updateNode(node.id, { scheduled_on: null, scheduled_end: null, is_multi_day: null }, { backfill: true })
                }
              />
            )}
          </Row>

          {/* 單行「時段與預估」漸進式揭露膠囊（收合省下 ~150px；點擊原地展開 SpanButtons ＋ DurationPicker） */}
          <Row label="時段" tall={schedOpen}>
            <ScheduleSummaryChip
              start={node.scheduled_time}
              estimateMin={node.estimate_min}
              lockedDate={ruled}
              expanded={schedOpen}
              onToggle={() => setSchedOpen((o) => !o)}
              variant="mobile"
            >
              <div className="m-dt-sched-edit-block">
                <SpanButtons node={node} ruled={ruled} onStart={() => setSub({ kind: "time" })} onEnd={() => setSub({ kind: "end" })} />
                <LengthField value={node.estimate_min} onCommit={(v) => void updateNode(node.id, { estimate_min: v })} compact={false} />
              </div>
            </ScheduleSummaryChip>
          </Row>

          {/* 其他時段（timetable.slots）：僅在有資料或展開編輯時顯示 */}
          {(hasExtraSlots || schedOpen) && <ScheduleLineRows node={node} />}

          <Row label="締切日">
            <div className="m-dt-due-row">
              <DatePick
                value={node.due_on}
                empty="未設定"
                label="締切日"
                onOpen={() =>
                  pickDate(
                    "締切日",
                    node.due_on,
                    dueQuickSet(today, { scheduledOn: syncDueTarget, weekStart }),
                    (d) => void updateNode(node.id, { due_on: d }),
                  )
                }
                onClear={() => void updateNode(node.id, { due_on: null })}
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
          </Row>
        </div>

        {/* 定期券專屬：重複規則與本班検印 */}
        {repeatable && draft.mode !== "none" && (
          <MobileRepeatSection
            node={node}
            draft={draft}
            push={push}
            open={repOpen}
            onToggle={onToggleRep}
            onPickDate={(title, cur, done, min) => pickDate(title, cur, [], done, { min })}
          />
        )}

        {teiki && (
          <div className="m-dt-group is-after-sec">
            <StampRows
              node={node}
              onRunTime={() => {
                const day = useNodeStore.getState().currentOccurrences[node.id]?.due_on ?? node.scheduled_on;
                if (day) setSub({ kind: "run", railDate: day });
              }}
              onRunDate={(railDate) => {
                const { min, max } = runDateBounds(parseRule(node.repeat_rule), today);
                const quick = scheduledQuickSet(today, weekStart).filter((q) => q.day >= min && (!max || q.day <= max));
                pickDate(
                  "本班日期",
                  railDate,
                  quick,
                  (d) => {
                    if (!isSettling(node.id)) void moveRunFlow(node.id, railDate, d);
                  },
                  { min, max },
                );
              }}
              onRunSeat={(railDate, slotName) => setSub({ kind: "seat", slotId: node.id, slotName, dueOn: railDate })}
            />
          </div>
        )}
      </section>

      {/* ── 第三段：下半主段 —— 旅途足跡與關聯 ── */}
      <section className="m-dt-band m-dt-footprint">
        <h3 className="m-dt-band-title">旅途足跡</h3>

        {/* 1. 直屬子車票清單（列車／車廂顯示） */}
        {isTaskKind(node.kind) && <ChildTicketsSection node={node} variant="mobile" />}

        {/* 2. 時刻表累計時數、列車進度、關聯旅客筆記、心情三燈 */}
        <div className="m-dt-group">
          <LineFieldRows
            node={node}
            sections={["amount", "footprint"]}
            filter={(f) => f.id.startsWith("timetable.")}
            inGroup
          />
          <AmountRows node={node} />
          <LineFieldRows
            node={node}
            sections={["footprint", "status"]}
            filter={(f) => !f.id.startsWith("timetable.")}
            inGroup
          />
          <Row label="心情">
            <MoodLights value={node.mood} onChange={(m) => void updateNode(node.id, { mood: m })} />
          </Row>
        </div>

        {/* 3. 乘務記錄與競合 */}
        <WorkLogs node={node} />
      </section>
    </>
  );
}

/** 支線等非任務節點的旅途足跡（不遺漏時間與關聯筆記） */
function BranchFootprintMobile({ node }: { node: NodeRow }) {
  const fields = lineNodeFields("mobile").filter(
    (f) => f.Mobile && f.kinds.includes(node.kind) && (f.section === "footprint" || f.section === "status" || !f.section),
  );
  if (!fields.length) return null;
  return (
    <section className="m-dt-band m-dt-footprint">
      <h3 className="m-dt-band-title">旅途足跡</h3>
      <div className="m-dt-group">
        <LineFieldRows node={node} sections={["footprint", "status"]} inGroup />
      </div>
    </section>
  );
}

/** 日期列：整列可點開日期 sheet；有值時右邊一顆 × */
function DatePick({
  value,
  endValue,
  isMultiDay = false,
  empty,
  label,
  onOpen,
  onClear,
}: {
  value: string | null;
  endValue?: string | null;
  isMultiDay?: boolean;
  empty: string;
  label: string;
  onOpen(): void;
  onClear(): void;
}) {
  const shown = value
    ? endValue && endValue > value
      ? dateChipRangeText(value, endValue, isMultiDay)
      : mdwText(value)
    : null;
  return (
    <div className={"m-dt-datepick" + (value ? " has-clear" : "")}>
      <button type="button" className="m-dt-pick" aria-label={`${label}：${shown ?? empty}`} onClick={onOpen}>
        {shown ? <span>{shown}</span> : <span className="is-empty">{empty}</span>}
        <span className="m-dt-chev" aria-hidden="true">
          ›
        </span>
      </button>
      {value && (
        <button type="button" className="ns-iconbtn m-dt-clear" aria-label={`清除${label}`} title="清除" onClick={onClear}>
          <IconClose />
        </button>
      )}
    </div>
  );
}

/** 時段兩格：開始 → 結束 */
function SpanButtons({ node, ruled, onStart, onEnd }: { node: NodeRow; ruled: boolean; onStart(): void; onEnd(): void }) {
  const start = node.scheduled_time;
  const end = spanEnd(start, node.estimate_min);
  return (
    <div className="m-dt-span">
      {ruled && <span className="m-dt-sub">每班</span>}
      <button type="button" className="m-dt-hmbtn" aria-label={`開始時刻：${start ?? "不排時刻"}`} onClick={onStart}>
        {start ? <b className="m-dt-hm">{start}</b> : <span className="is-empty">不排</span>}
      </button>
      <span className="m-dt-span-arr" aria-hidden="true">
        →
      </span>
      <button
        type="button"
        className="m-dt-hmbtn"
        aria-label={start ? `結束時刻：${end ?? "沒有"}` : "結束時刻：先排開始"}
        disabled={!start}
        onClick={onEnd}
      >
        {end ? <b className="m-dt-hm">{end}</b> : <span className="is-empty">—</span>}
      </button>
    </div>
  );
}

function TimeSub({ node, today, onClose }: { node: NodeRow; today: string; onClose(): void }) {
  const occ = useNodeStore((s) => s.currentOccurrences[node.id]);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const now = useMinuteTick();
  const card = useMemo(() => timeCardOf(node, occ), [node, occ]);
  const setTime = (time: string | null, estimateMin?: number | null) => {
    const patch: { scheduled_time: string | null; estimate_min?: number | null } = { scheduled_time: time };
    if (estimateMin !== undefined) patch.estimate_min = estimateMin;
    void useNodeStore
      .getState()
      .updateNode(node.id, patch)
      .then((r) => {
        if (r.ok) useUiStore.getState().showToast({ message: timeReceipt("rule", time) }, 2400);
      });
  };
  return (
    <MobileTimeSheet
      card={card}
      mode="rule"
      withLen={false}
      today={today}
      dayStartHour={dayStartHour}
      now={now}
      backId={SUB_LAYER}
      onCommit={(time, est) => {
        setTime(time, est);
        onClose();
      }}
      onClear={() => {
        if (card.ruleTime !== null) setTime(null);
        onClose();
      }}
      onClose={onClose}
    />
  );
}

function EndSub({ node, today, onClose }: { node: NodeRow; today: string; onClose(): void }) {
  const occ = useNodeStore((s) => s.currentOccurrences[node.id]);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const now = useMinuteTick();
  const card = useMemo(() => timeCardOf(node, occ), [node, occ]);
  return (
    <MobileTimeSheet
      card={card}
      mode="end"
      today={today}
      dayStartHour={dayStartHour}
      now={now}
      backId={SUB_LAYER}
      onCommit={(_end, len) => {
        if (typeof len === "number" && len > 0) void useNodeStore.getState().updateNode(node.id, { estimate_min: len });
        onClose();
      }}
      onClear={onClose}
      onClose={onClose}
    />
  );
}

function RunTimeSub({ node, railDate, today, onClose }: { node: NodeRow; railDate: string; today: string; onClose(): void }) {
  const occ = useNodeStore((s) => s.currentOccurrences[node.id]);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const now = useMinuteTick();
  const card = useMemo(
    () => ({
      ...timeCardOf(node, occ),
      railDate,
      time: effectiveTime(node, railDate),
      timeOverridden: isTimeOverridden(node, railDate),
    }),
    [node, occ, railDate],
  );
  const setRun = (time: string | null) =>
    void useNodeStore
      .getState()
      .setRunTime(node.id, railDate, time)
      .then((r) => {
        if (r.ok) useUiStore.getState().showToast({ message: timeReceipt("run", time) }, 2400);
      });
  return (
    <MobileTimeSheet
      card={card}
      mode="run"
      today={today}
      dayStartHour={dayStartHour}
      now={now}
      backId={SUB_LAYER}
      onCommit={(time) => {
        setRun(time);
        onClose();
      }}
      onClear={() => {
        setRun(null);
        onClose();
      }}
      onReset={() => {
        void resetRunTimeFlow(node.id, railDate);
        onClose();
      }}
      onClose={onClose}
    />
  );
}

/** 心情三燈（順 · 平 · 難；complete/moods.ts）；再按同一盞＝熄掉 */
function MoodLights({ value, onChange }: { value: NodeRow["mood"]; onChange: (m: NodeRow["mood"]) => void }) {
  const cur = MOODS.find((m) => m.value === value);
  return (
    <div className="m-dt-moods" role="group" aria-label="心情">
      {MOODS.map((m) => {
        const on = value === m.value;
        return (
          <button
            key={m.value}
            type="button"
            className="m-dt-mood"
            style={{ color: m.color }}
            aria-label={`心情：${m.label}`}
            aria-pressed={on}
            title={on ? `${m.label}（再按一次清除）` : m.label}
            onClick={() => onChange(on ? null : m.value)}
          >
            <span>{m.glyph}</span>
          </button>
        );
      })}
      <span className="m-dt-mood-word">{cur ? cur.label : "還沒選"}</span>
    </div>
  );
}

type FieldSection = NonNullable<NodeFieldSpec["section"]>;

/**
 * 各線登記的節點欄位的手機列（插槽 nodeFields 的 Mobile）：
 * 支援依 `sections` 與 `filter` 精準分流到歸屬帶（meta）或旅途足跡（amount／footprint／status）。
 */
function LineFieldRows({
  node,
  sections,
  filter,
  inGroup = false,
}: {
  node: NodeRow;
  sections?: readonly FieldSection[];
  filter?: (f: NodeFieldSpec) => boolean;
  inGroup?: boolean;
}) {
  const set = sections ? new Set<FieldSection>(sections) : null;
  const fields = lineNodeFields("mobile").filter((f) => {
    if (!f.Mobile || !f.kinds.includes(node.kind)) return false;
    const sec = (f.section ?? "status") as FieldSection;
    if (set) {
      if (!set.has(sec)) return false;
    } else if (sec === "schedule") {
      return false;
    }
    return filter ? filter(f) : true;
  });
  if (!fields.length) return null;
  return (
    <div className={"m-dt-lines" + (inGroup ? " is-in-group" : "")}>
      {fields.map((f) => (f.Mobile ? <f.Mobile key={f.id} node={node} /> : null))}
    </div>
  );
}

/** 時段組裡的別線欄位（section "schedule"：其他時段） */
function ScheduleLineRows({ node }: { node: NodeRow }) {
  const fields = lineNodeFields("mobile").filter((f) => f.Mobile && f.kinds.includes(node.kind) && f.section === "schedule");
  if (!fields.length) return null;
  return (
    <div className="m-dt-lines is-in-group">{fields.map((f) => (f.Mobile ? <f.Mobile key={f.id} node={node} /> : null))}</div>
  );
}

/* ───────────── 乘務記錄＋競合 ───────────── */

function WorkLogs({ node }: { node: NodeRow }) {
  const logs = useNodeStore((s) => s.workLogs[node.id]);
  const loadWorkLogs = useNodeStore((s) => s.loadWorkLogs);
  const addWorkLog = useNodeStore((s) => s.addWorkLog);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void loadWorkLogs(node.id);
  }, [node.id, node.updated_at, loadWorkLogs]);
  const { entries, conflicts, manual } = useMemo(() => splitLogs(logs), [logs]);

  const submit = async () => {
    const body = draft.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      if (await addWorkLog(node.id, body)) setDraft("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section className="m-dt-sec">
        <h3 className="m-dt-sec-title">
          乘務記錄{manual > 0 && <span className="m-dt-sec-aside">{manual} 則</span>}
        </h3>
        {logs === undefined ? (
          <p className="m-dt-empty">讀取中…</p>
        ) : (
          entries.length > 0 && (
            <ul className="m-dt-logs">
              {entries.map((l) => (
                <li key={l.id} className={l.event ? "is-evt" : undefined}>
                  <span className="m-dt-tm">{fmtLogStamp(l.logged_at)}</span>
                  <span className={l.event ? "m-dt-evt" : "m-dt-hw"}>{l.event ? WORK_LOG_EVENT_LABEL[l.event] : l.body}</span>
                </li>
              ))}
            </ul>
          )
        )}
        <div className="m-dt-logadd">
          <input
            type="text"
            className="m-dt-loginput"
            placeholder="記一句…"
            aria-label="記一句乘務記錄"
            enterKeyHint="done"
            autoComplete="off"
            value={draft}
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === "Enter") {
                e.preventDefault();
                void submit();
              }
            }}
          />
          <button type="button" className="ns-btn btn-seal" disabled={busy || !draft.trim()} onClick={() => void submit()}>
            記入
          </button>
        </div>
      </section>

      {conflicts.length > 0 && (
        <div className="m-dt-conflict">
          <span className="m-dt-label">競合</span>
          <ul>
            {conflicts.map((l) => (
              <li key={l.id}>
                <span className="m-dt-tm">{fmtLogStamp(l.logged_at)}</span>
                {describeConflict(l.body, conflictNameOf)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
