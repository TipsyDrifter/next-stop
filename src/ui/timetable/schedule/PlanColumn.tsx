/**
 * PlanColumn——日程的「預定」欄（④ 契約 §5.2、§5.4、§5.5；〈原型定案〉1、3、5；乙席）。
 * 長相＝原型 v-h.js cardHtml／railHtml（.vh-card／.vh-rl）→ 正式版 `.ns-tt-sched-card`／`.ns-tt-sched-rl`（timetable.css §L）。
 *
 *   div.ns-tt-sched-lanes                 卡的絕對定位層（右邊讓出 128px 給「差多少」欄＝桌機 ≥1100px）
 *   │  button.ns-tt-sched-card[.is-short|.is-done|.is-cancel|.is-noest|.is-live|.is-overdue|.is-on|.is-open|.is-sel|.is-movable]
 *   │  div.ns-tt-sched-ghost              拖曳／點選時的落點卡
 *   └ div.ns-tt-sched-rail                「差多少」欄（只有 layout="rail"）
 *
 * 位置＝timeGridModel 的牆鐘分鐘換成窗內百分比；lane 照 `lane／lanes` 並排（D-時-87：不因卡的最小高另算重疊）。
 * 卡高＝預計（沒預計＝45 分虛線「長度未定」），最小高 CSS 給（桌機 22px、手機單行 22px≈30 分）。
 */
import type { CSSProperties, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import type { TimeGridBlock } from "../../schedule/timeGridModel";
import { TT_TEXT, useTimetableStore } from "../../../store/timetableStore";
import { useTimetableScheduleStore } from "../../../store/timetableScheduleStore";
import { clockText, nextDayNote } from "../../../lib/date";
import { fmtDur, MIN } from "../../../domain/timetable";
import { SCHED_UI, deltaFull, deltaLines, deltaShort, minFrac, pct, toneOf } from "./scheduleModel";
import { routeColorOf, type SchedulePage } from "./useSchedulePage";
import type { DragSrc, DragView } from "./useScheduleDrag";

export type CardLayout = "rail" | "inline";

export interface PlanColumnProps {
  page: SchedulePage;
  layout: CardLayout;
  /** 每小時幾 px（桌機 48、手機 44） */
  hourPx: number;
  drag: DragView | null;
  onDragStart(key: string, src: DragSrc): (e: ReactPointerEvent<HTMLElement>) => void;
  swallowClick(): boolean;
  /** 點選排時刻：指標的 clientY → 分鐘（已吸附）；量不到 ⇒ null */
  minAtY(clientY: number): number | null;
}

/**
 * 卡的單行門檻（px）：低於它就把時刻、名稱（、差多少）擠成一行。
 * inline＝30：手機 45 分（長度未定）的卡高 33px，放得下兩行（時刻＋名稱｜本班＋短說法，＝原型 cardHtml 手機寫法）；
 * 單行只留給 30 分以下的票（D-時-87 的最小高）。原本 34 會把 45 分的卡都擠成單行，並排時本班與準點都看不到（評審 r27）。
 */
const SHORT_PX = { rail: 38, inline: 30 } as const;
const RAIL_LINE = 15;

export function PlanColumn({ page, layout, hourPx, drag, onDragStart, swallowClick, minAtY }: PlanColumnProps) {
  const { grid, items, nodes, cmp, dayStartHour, isPast, canEdit, activeKey, openKey, sel, picked, shell } = page;
  const setHover = useTimetableScheduleStore((s) => s.setHover);
  const running = useTimetableStore((s) => s.running);
  const blocks = grid?.blocks ?? [];
  const dayPx = 24 * hourPx;
  const desk = shell === "desktop";

  const onCardClick = (b: TimeGridBlock, e: ReactMouseEvent): void => {
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

  const cards = blocks.map((b) => {
    const it = items[b.key];
    if (!it) return null;
    const c = cmp.cmp.get(b.key);
    const name = nodes[it.nodeId]?.name ?? "？";
    const hpx = ((b.endMin - b.startMin) / 60) * hourPx;
    const short = hpx < SHORT_PX[layout];
    const tone = c ? toneOf(c) : "future";
    const t = it.time ?? "";
    const next = nextDayNote(t);
    const movable = canEdit && !it.skipped;
    const isLive = c?.state === "running" || (running?.node_id === it.nodeId && page.isToday);
    const tag = it.skipped ? (
      <em className="ns-tt-sched-tag is-cancel">{TT_TEXT.schedSkipped}</em>
    ) : it.overridden ? (
      <em className="ns-tt-sched-tag">{TT_TEXT.schedRun}</em>
    ) : null;
    const inlineDelta = layout === "inline" && c && !it.skipped ? deltaShort(it, c, isPast, TT_TEXT.schedSkipped) : null;
    const full = c ? deltaFull(it, c, isPast, TT_TEXT.schedSkipped) : null;
    const title =
      `${TT_TEXT.schedDepart(t)}${next ? `（${next}）` : ""}・${it.estimateMin ? fmtDur(it.estimateMin * MIN) : TT_TEXT.schedNoEstimate}　${name}` +
      (it.overridden ? `　${TT_TEXT.schedRun}` : "") +
      (full ? `　${full}` : "");
    const cls =
      "ns-tt-sched-card" +
      ` is-${layout}` +
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
      "--rc": routeColorOf(page, it.nodeId),
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
    return (
      <button
        type="button"
        key={b.key}
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
              {/* 短卡照樣印「長度未定」（原型 v-h.js:478）：擠的時候名稱先省略，標籤留著 */}
              {b.noEstimate && <i className="ns-tt-sched-noest">{TT_TEXT.schedNoEstimate}</i>}
            </span>
            <span className="ns-tt-sched-cn">{name}</span>
          </>
        ) : (
          <>
            <span className="ns-tt-sched-ct">
              {time}
              {/* 單行（D-時-87）：本班／運休的小標籤緊跟時刻（一律畫）、短說法接在名稱後（並排也畫）；擠的時候名稱與短說法用省略號截斷 */}
              {short && tag}
              <span className="ns-tt-sched-cn">{name}</span>
              {short && inlineDelta && <span className={"ns-tt-sched-cd is-" + tone}>{inlineDelta}</span>}
            </span>
            {!short && (tag || inlineDelta) && (
              <span className={"ns-tt-sched-cd is-" + tone}>
                {tag}
                {inlineDelta}
              </span>
            )}
          </>
        )}
        {it.done && (
          <span className="ns-tt-sched-seal" aria-hidden="true">
            {TT_TEXT.schedDone}
          </span>
        )}
        {!desk && sel === b.key && (
          <span
            className="ns-tt-sched-open"
            role="button"
            onClick={(e) => {
              e.stopPropagation();
              page.openPlan(b.key);
            }}
          >
            {/* 窄卡（並排）只留「›」：timetable.css 用 container query 收掉字，免得把名稱整個蓋住 */}
            <span className="ns-tt-sched-open-w">{SCHED_UI.openWord}</span>
            {SCHED_UI.openMark}
          </span>
        )}
      </button>
    );
  });

  /* 「差多少」欄：跟著卡頂，擠到就往下推（原型 railHtml） */
  let rail: ReactNode = null;
  if (layout === "rail") {
    let floor = -999;
    rail = (
      <div className="ns-tt-sched-rail" aria-hidden="true">
        {[...blocks]
          .sort((a, b) => a.startMin - b.startMin || a.lane - b.lane)
          .map((b) => {
            const it = items[b.key];
            const c = cmp.cmp.get(b.key);
            if (!it || !c) return null;
            const lines = deltaLines(it, c, isPast, TT_TEXT.schedSkipped);
            if (!lines.length) return null;
            const y = Math.max(minFrac(b.startMin, dayStartHour) * dayPx, floor + 3);
            floor = y + lines.length * RAIL_LINE + 4;
            return (
              <div key={b.key} className={"ns-tt-sched-rl is-" + toneOf(c) + (activeKey === b.key ? " is-on" : "")} style={{ top: y + "px" }}>
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
        <Ghost page={page} drag={drag} hourPx={hourPx} />
      </div>
      {rail}
    </>
  );
}

/** 拖曳中的落點卡（虛線金框）：高＝預計（沒預計 45 分），落點分鐘照吸附 */
function Ghost({ page, drag, hourPx }: { page: SchedulePage; drag: DragView | null; hourPx: number }) {
  if (!drag || drag.min === null) return null;
  const it = page.items[drag.key];
  if (!it) return null;
  const len = it.estimateMin ?? 45;
  const hpx = (len / 60) * hourPx;
  const style = {
    top: pct(minFrac(drag.min, page.dayStartHour)),
    height: pct(Math.min(len, page.dayStartHour * 60 + 1440 - drag.min) / 1440),
  } as CSSProperties;
  return (
    <div className={"ns-tt-sched-ghost" + (it.estimateMin ? "" : " is-noest") + (hpx < 36 ? " is-short" : "")} style={style} aria-hidden="true">
      <span className="ns-tt-num">{clockText(drag.min)}</span>
      <b>{page.nodes[it.nodeId]?.name ?? "？"}</b>
    </div>
  );
}

