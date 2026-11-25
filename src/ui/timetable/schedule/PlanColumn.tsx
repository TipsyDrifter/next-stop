/**
 * PlanColumn——日程的「預定」欄（④ 契約 §5.2、§5.4、§5.5；第四梯 D-FB-7：預留席虛線卡、本班填空標題、待辦入座頂替與一鍵入座）。
 *
 *   div.ns-tt-sched-lanes                 卡的絕對定位層（右邊讓出 128px 給「差多少」欄＝桌機 ≥1100px）
 *   │  button.ns-tt-sched-card[.is-placeholder|.is-seated|.is-short|.is-done|.is-cancel|.is-noest|.is-live|.is-overdue|.is-on|.is-open|.is-sel|.is-movable]
 *   │  div.ns-tt-sched-ghost              拖曳／點選／空白區拖拉建立預留席時的落點卡
 *   └ div.ns-tt-sched-rail                「差多少」欄（只有 layout="rail"）
 */
import type { CSSProperties, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { useTagStore } from "../../../store/tagStore";
import { TT_TEXT, useTimetableStore } from "../../../store/timetableStore";
import { ADHOC_TEXT, SEG_TEXT, addSegNode, useTimetableScheduleStore, type SchedBlock } from "../../../store/timetableScheduleStore";
import { segNumberOf } from "./routineModel";
import { clockText, nextDayNote } from "../../../lib/date";
import { fmtDur, MIN } from "../../../domain/timetable";
import { NodeCrumb, useParentCrumb } from "../../common/NodeCrumb";
import { TagDotHint, TagPills, useEntityTagKeys } from "../../common/TagPills";
import { SCHED_UI, deltaFull, deltaLines, deltaShort, minFrac, pct, toneOf } from "./scheduleModel";
import {
  PLACEHOLDER_UI,
  canSeatIntoSlot,
  isAddPlaceholder,
  isEligibleSeatCandidate,
  planItemDisplay,
} from "./scheduleSeatModel";
import { adhocDisplayOf, routeColorOf, type SchedulePage } from "./useSchedulePage";
import type { DragSrc, DragView } from "./useScheduleDrag";

export type CardLayout = "rail" | "inline";

export interface CreateRangePreview {
  startMin: number;
  endMin: number;
  durationMin: number;
}

export interface PlanColumnProps {
  page: SchedulePage;
  layout: CardLayout;
  /** 每小時幾 px（桌機 48、手機 44） */
  hourPx: number;
  drag: DragView | null;
  createRange?: CreateRangePreview | null;
  onDragStart(key: string, src: DragSrc): (e: ReactPointerEvent<HTMLElement>) => void;
  swallowClick(): boolean;
  /** 點選排時刻：指標的 clientY → 分鐘（已吸附）；量不到 ⇒ null */
  minAtY(clientY: number): number | null;
}

const SHORT_PX = { rail: 38, inline: 30 } as const;
const RAIL_LINE = 15;

export function PlanColumn({
  page,
  layout,
  hourPx,
  drag,
  createRange = null,
  onDragStart,
  swallowClick,
  minAtY,
}: PlanColumnProps) {
  const {
    items,
    slots,
    adhocs,
    nodes,
    cmp,
    dayStartHour,
    isPast,
    activeKey,
    sel,
    picked,
    shell,
  } = page;
  const setHover = useTimetableScheduleStore((s) => s.setHover);
  const running = useTimetableStore((s) => s.running);
  const blocks = page.blocks;
  const dayPx = 24 * hourPx;
  const desk = shell === "desktop";

  // 當使用者在「還沒排」點選了一張一般待辦車票時，可直接在預留席／定期班次卡上點「⇄ 入座此席」
  const pickedCandidateItem =
    picked && !isAddPlaceholder(picked) && !addSegNode(picked) && !slots[picked] && !adhocs[picked]
      ? items[picked]
      : undefined;
  const pickedCandidateNode = pickedCandidateItem ? nodes[pickedCandidateItem.nodeId] : undefined;

  const onCardClick = (b: SchedBlock, e: ReactMouseEvent): void => {
    e.stopPropagation();
    if (swallowClick()) return;
    if (picked) {
      const m = minAtY(e.clientY);
      if (m !== null) page.place(picked, m);
      return;
    }
    if (desk || sel === b.key) page.openPlan(b.key);
    else page.setSel(b.key);
  };

  const cards = blocks.map((b) => (
    <PlanCard
      key={b.key}
      b={b}
      page={page}
      layout={layout}
      hourPx={hourPx}
      drag={drag}
      runningNodeId={running?.node_id ?? null}
      pickedCandidateItem={pickedCandidateItem}
      pickedCandidateNode={pickedCandidateNode}
      onDragStart={onDragStart}
      onCardClick={onCardClick}
      setHover={setHover}
    />
  ));

  let rail: ReactNode = null;
  if (layout === "rail") {
    let floor = -999;
    rail = (
      <div className="ns-tt-sched-rail" aria-hidden="true">
        {[...blocks]
          .sort((a, b) => a.startMin - b.startMin || a.lane - b.lane)
          .map((b) => {
            const it = (b.slotId !== null ? (adhocs[b.key] ?? slots[b.key]) : undefined) ?? items[b.key];
            const c = cmp.cmp.get(b.key);
            if (!it || !c) return null;
            const lines = deltaLines(it, c, isPast, TT_TEXT.schedSkipped);
            if (!lines.length) return null;
            const y = Math.max(minFrac(b.startMin, dayStartHour) * dayPx, floor + 3);
            floor = y + lines.length * RAIL_LINE + 4;
            return (
              <div
                key={b.key}
                className={"ns-tt-sched-rl is-" + toneOf(c) + (activeKey === b.key ? " is-on" : "")}
                style={{ top: y + "px" }}
              >
                {lines.map((s, i) => (
                  <span key={i}>{s}</span>
                ))}
              </div>
            );
          })}
      </div>
    );
  }

  return (
    <>
      <div className="ns-tt-sched-lanes">
        {cards}
        <Ghost page={page} drag={drag} createRange={createRange} hourPx={hourPx} />
      </div>
      {rail}
    </>
  );
}

/** 拖曳中的落點卡，或空白區上下拖拉建立預留席時的虛線預覽卡 */
function Ghost({
  page,
  drag,
  createRange,
  hourPx,
}: {
  page: SchedulePage;
  drag: DragView | null;
  createRange: CreateRangePreview | null;
  hourPx: number;
}) {
  if (createRange) {
    const hpx = (createRange.durationMin / 60) * hourPx;
    const sHm = clockText(createRange.startMin) ?? "";
    const eHm = clockText(createRange.endMin) ?? "";
    const style = {
      top: pct(minFrac(createRange.startMin, page.dayStartHour)),
      height: pct(createRange.durationMin / 1440),
    } as CSSProperties;
    return (
      <div
        className={"ns-tt-sched-ghost is-placeholder" + (hpx < 36 ? " is-short" : "")}
        style={style}
        aria-hidden="true"
      >
        <span className="ns-tt-num">
          {sHm}–{eHm}
        </span>
        <b>
          {PLACEHOLDER_UI.fallbackName}（{fmtDur(createRange.durationMin * MIN)}）
        </b>
      </div>
    );
  }

  if (!drag || drag.min === null) return null;
  const adhoc = page.adhocs[drag.key];
  const it = adhoc ?? page.items[drag.key] ?? page.slots[drag.key];
  if (!it) return null;
  const len = it.estimateMin ?? 45;
  const hpx = (len / 60) * hourPx;
  const style = {
    top: pct(minFrac(drag.min, page.dayStartHour)),
    height: pct(Math.min(len, page.dayStartHour * 60 + 1440 - drag.min) / 1440),
  } as CSSProperties;
  const node = page.nodes[it.nodeId];
  const ghostName = adhoc
    ? adhocDisplayOf(page, adhoc).name
    : planItemDisplay(it, node, node?.route_id ? page.routeById[node.route_id]?.name : null).title;
  return (
    <div
      className={"ns-tt-sched-ghost" + (it.estimateMin ? "" : " is-noest") + (hpx < 36 ? " is-short" : "")}
      style={style}
      aria-hidden="true"
    >
      <span className="ns-tt-num">{clockText(drag.min)}</span>
      <b>{ghostName}</b>
    </div>
  );
}

function PlanCard({
  b,
  page,
  layout,
  hourPx,
  drag,
  runningNodeId,
  pickedCandidateItem,
  pickedCandidateNode,
  onDragStart,
  onCardClick,
  setHover,
}: {
  b: SchedBlock;
  page: SchedulePage;
  layout: CardLayout;
  hourPx: number;
  drag: DragView | null;
  runningNodeId: string | null;
  pickedCandidateItem: SchedulePage["items"][string] | undefined;
  pickedCandidateNode: SchedulePage["nodes"][string] | undefined;
  onDragStart(key: string, src: DragSrc): (e: ReactPointerEvent<HTMLElement>) => void;
  onCardClick(b: SchedBlock, e: ReactMouseEvent): void;
  setHover: (h: { kind: "plan" | "block"; id: string } | null) => void;
}) {
  const { items, slots, adhocs, nodes, routeById, cmp, dayStartHour, isPast, canEdit, activeKey, openKey, sel, shell, slotsByNode } = page;
  const desk = shell === "desktop";
  const adhoc = b.slotId !== null ? adhocs[b.key] : undefined;
  const slot = b.slotId !== null && !adhoc ? slots[b.key] : undefined;
  const it = adhoc ?? slot ?? items[b.key];
  const node = it ? nodes[it.nodeId] : undefined;
  const tagKeys = useEntityTagKeys("node", node?.id);
  const crumb = useParentCrumb(node?.parent_id);
  const tagIndex = useTagStore((s) => s.index);

  if (!it) return null;

  const c = cmp.cmp.get(b.key);
  const route = node?.route_id ? routeById[node.route_id] : undefined;
  const adDisp = adhoc ? adhocDisplayOf(page, adhoc) : null;
  const disp = !adhoc ? planItemDisplay(it, node, route?.name) : null;
  const name = adDisp ? adDisp.name : disp ? disp.title : (node?.name ?? "？");
  const rc = adDisp ? adDisp.color : routeColorOf(page, it.nodeId);

  const segNo =
    !adhoc && it.kind === "single"
      ? segNumberOf(node, it.nodeId, slotsByNode[it.nodeId], slot ? slot.planId : "main")
      : null;
  const segTag = segNo && segNo.total > 1 ? SEG_TEXT.tag(segNo.n) : null;
  const hpx = ((b.endMin - b.startMin) / 60) * hourPx;
  const short = hpx < SHORT_PX[layout];
  const tone = c ? toneOf(c) : "future";
  const t = it.time ?? "";
  const next = nextDayNote(t);
  const movable = canEdit && !it.skipped;
  const isLive =
    c?.state === "running" || (!adhoc && !segTag && runningNodeId === it.nodeId && page.isToday);

  const canQuickSeatHere =
    canEdit &&
    b.slotId === null &&
    !!pickedCandidateItem &&
    !!pickedCandidateNode &&
    canSeatIntoSlot(it, node) &&
    isEligibleSeatCandidate(pickedCandidateNode, it.nodeId);

  const tag = adhoc ? (
    <em className="ns-tt-sched-tag is-adhoc">{ADHOC_TEXT.tag}</em>
  ) : it.skipped ? (
    <em className="ns-tt-sched-tag is-cancel">{TT_TEXT.schedSkipped}</em>
  ) : disp?.badgeKind === "placeholder" ? (
    <em className="ns-tt-sched-tag is-placeholder">{PLACEHOLDER_UI.tag}</em>
  ) : disp?.badgeKind === "seated" ? (
    <em className="ns-tt-sched-tag is-seated">{disp.badgeText}</em>
  ) : disp?.badgeKind === "filled" ? (
    <em className="ns-tt-sched-tag is-filled">{disp.badgeText}</em>
  ) : it.overridden ? (
    <em className="ns-tt-sched-tag">{TT_TEXT.schedRun}</em>
  ) : segTag ? (
    <em className="ns-tt-sched-tag is-seg">{segTag}</em>
  ) : null;

  const inlineDelta =
    layout === "inline" && c && !it.skipped ? deltaShort(it, c, isPast, TT_TEXT.schedSkipped) : null;
  const full = c ? deltaFull(it, c, isPast, TT_TEXT.schedSkipped) : null;
  const displayFullTitle = disp ? disp.fullTitle : name;
  const crumbTip = crumb.length > 0 ? crumb.join(" › ") : null;
  const tagsTip = tagKeys.length > 0 ? tagKeys.map((k) => `#${tagIndex?.byKey[k]?.name ?? k}`).join("  ") : null;
  const title =
    (adhoc
      ? `${t}–${adhoc.end}${next ? `（${next}）` : ""}・${fmtDur((it.estimateMin ?? 0) * MIN)}　${name}${adDisp?.sub ? `（${adDisp.sub}）` : ""}`
      : slot
        ? `${t}–${slot.end}${next ? `（${next}）` : ""}・${fmtDur((it.estimateMin ?? 0) * MIN)}　${displayFullTitle}`
        : `${TT_TEXT.schedDepart(t)}${next ? `（${next}）` : ""}・${it.estimateMin ? fmtDur(it.estimateMin * MIN) : TT_TEXT.schedNoEstimate}　${displayFullTitle}`) +
    (crumbTip ? `（${crumbTip}）` : "") +
    (disp?.isPlaceholder ? `　${PLACEHOLDER_UI.tag}` : "") +
    (it.overridden ? `　${TT_TEXT.schedRun}` : "") +
    (segTag ? `　${segTag}` : "") +
    (full ? `　${full}` : "") +
    (tagsTip ? `　${tagsTip}` : "");

  const showCrumb = !short && crumb.length > 0 && hpx >= (layout === "rail" ? 52 : 46);
  const showFullTags = !short && tagKeys.length > 0 && hpx >= (layout === "rail" ? 68 : 60) && b.lanes === 1;
  const showDotHint = tagKeys.length > 0 && !showFullTags;

  const cls =
    "ns-tt-sched-card" +
    ` is-${layout}` +
    (adhoc || disp?.isPlaceholder ? " is-adhoc is-placeholder" : "") +
    (disp?.badgeKind === "seated" ? " is-seated" : "") +
    (short ? " is-short" : "") +
    (it.done ? " is-done" : "") +
    (it.skipped ? " is-cancel" : "") +
    (b.noEstimate ? " is-noest" : "") +
    (isLive ? " is-live" : "") +
    (c?.state === "notStarted" ? " is-overdue" : "") +
    (activeKey === b.key ? " is-on" : "") +
    (openKey === b.key ? " is-open" : "") +
    (!desk && sel === b.key ? " is-sel" : "") +
    (movable ? " is-movable" : "") +
    (drag?.key === b.key ? " is-lifted" : "");

  const style = {
    "--rc": rc,
    top: pct(minFrac(b.startMin, dayStartHour)),
    height: pct((b.endMin - b.startMin) / 1440),
    left: `calc(${(b.lane / b.lanes) * 100}% + 2px)`,
    width: `calc(${100 / b.lanes}% - 4px)`,
  } as CSSProperties;

  const time = (
    <span className="ns-tt-num ns-tt-sched-t">
      {t}
      {layout === "rail" && <span className="ns-tt-sched-hatsu">発</span>}
    </span>
  );
  const nameEl = (
    <span className="ns-tt-sched-cn">
      <i className="ns-tt-sched-rdot" aria-hidden="true" />
      {name}
    </span>
  );

  return (
    <button
      type="button"
      className={cls}
      style={style}
      title={title}
      aria-label={title}
      data-key={b.key}
      onPointerDown={movable ? onDragStart(b.key, "card") : undefined}
      onPointerEnter={(e) => {
        if (e.pointerType === "mouse" && !drag) setHover({ kind: "plan", id: b.key });
      }}
      onPointerLeave={(e) => {
        if (e.pointerType === "mouse") setHover(null);
      }}
      onClick={(e) => onCardClick(b, e)}
    >
      {layout === "rail" ? (
        <>
          <span className="ns-tt-sched-ct">
            {time}
            {tag}
            {next && !short && <small className="ns-tt-sched-next">{next}</small>}
            {b.noEstimate && <i className="ns-tt-sched-noest">{TT_TEXT.schedNoEstimate}</i>}
            {showDotHint && <TagDotHint keys={tagKeys} />}
          </span>
          {nameEl}
          {showCrumb && <NodeCrumb segments={crumb} compact className="ns-tt-sched-crumb" />}
          {showFullTags && (
            <span className="ns-tt-sched-card-tags">
              <TagPills keys={tagKeys} max={2} compact onPick={false} />
            </span>
          )}
        </>
      ) : (
        <>
          <span className="ns-tt-sched-ct">
            {time}
            {short && tag}
            {nameEl}
            {short && inlineDelta && <span className={"ns-tt-sched-cd is-" + tone}>{inlineDelta}</span>}
            {showDotHint && <TagDotHint keys={tagKeys} />}
          </span>
          {!short && (tag || inlineDelta) && (
            <span className={"ns-tt-sched-cd is-" + tone}>
              {tag}
              {inlineDelta}
            </span>
          )}
          {showCrumb && <NodeCrumb segments={crumb} compact className="ns-tt-sched-crumb" />}
          {showFullTags && (
            <span className="ns-tt-sched-card-tags">
              <TagPills keys={tagKeys} max={2} compact onPick={false} />
            </span>
          )}
        </>
      )}
      {canQuickSeatHere && pickedCandidateItem && (
        <span
          className="ns-tt-seat-pill"
          role="button"
          tabIndex={0}
          title={`讓「${pickedCandidateNode?.name ?? ""}」入座頂替此預留時段`}
          onPointerDown={(ev) => ev.stopPropagation()}
          onClick={(ev) => {
            ev.stopPropagation();
            void page.seatTicketInto(b.key, pickedCandidateItem.nodeId);
          }}
          onKeyDown={(ev) => {
            if (ev.key === "Enter" || ev.key === " ") {
              ev.preventDefault();
              ev.stopPropagation();
              void page.seatTicketInto(b.key, pickedCandidateItem.nodeId);
            }
          }}
        >
          ⇄ 入座此席
        </span>
      )}
      {it.done && (
        <span className="ns-tt-sched-seal" aria-hidden="true">
          {TT_TEXT.schedDone}
        </span>
      )}
      {!desk && sel === b.key && !canQuickSeatHere && (
        <span
          className="ns-tt-sched-open"
          role="button"
          onClick={(e) => {
            e.stopPropagation();
            page.openPlan(b.key);
          }}
        >
          <span className="ns-tt-sched-open-w">{SCHED_UI.openWord}</span>
          {SCHED_UI.openMark}
        </span>
      )}
    </button>
  );
}
