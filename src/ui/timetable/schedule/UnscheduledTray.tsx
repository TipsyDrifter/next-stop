/**
 * UnscheduledTray——日程的「還沒排」（④ 契約 §5.7、D-時-80；第四梯 D-FB-7：預留席車票、期間自由券、本班填空與入座顯示）。
 *
 *   桌機 aside.ns-tt-sched-un.is-side：標題「還沒排 N」＋「＋ 預留席」、說明、一張張卡（可拖、點一下＝選起來）、點選提示、底部漏班提示
 *   手機 div.ns-tt-sched-un.is-chips：標題列＋「＋ 預留席」、一排橫捲 chip（點一下＝選、長按 0.4 秒拖）、點選提示或漏班那一行
 */
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { TT_TEXT } from "../../../store/timetableStore";
import { ADHOC_TEXT, SEG_DEFAULT_MIN, addSegNode, useTimetableScheduleStore } from "../../../store/timetableScheduleStore";
import { SEG_UI } from "./routineModel";
import { useUiStore } from "../../../store/uiStore";
import { useScheduleUiStore } from "../../schedule/scheduleUiStore";
import { MIN, fmtDur } from "../../../domain/timetable";
import { openTicket } from "./openTicket";
import { SCHED_UI } from "./scheduleModel";
import { ADD_PLACEHOLDER_KEY, PLACEHOLDER_UI, isAddPlaceholder, planItemDisplay } from "./scheduleSeatModel";
import { routeColorOf, type SchedulePage } from "./useSchedulePage";
import type { DragSrc, DragView } from "./useScheduleDrag";

interface TrayEntry {
  key: string;
  nodeId: string;
  /** 軸外的時刻（改日界線前存的 03:30） */
  off: string | null;
  /** 誤點票的原執行日 */
  lateFrom: string | null;
}

const md = (key: string): string => {
  const [, m, d] = key.split("-").map(Number);
  return `${m}/${d}`;
};

export interface UnscheduledTrayProps {
  page: SchedulePage;
  mode: "side" | "chips";
  drag: DragView | null;
  onDragStart(key: string, src: DragSrc): (e: ReactPointerEvent<HTMLElement>) => void;
  swallowClick(): boolean;
}

export function UnscheduledTray({ page, mode, drag, onDragStart, swallowClick }: UnscheduledTrayProps) {
  const { grid, items, nodes, routeById, picked, isToday, lateKeys, lateRepeatCount, canEdit, shell } = page;
  const pick = useTimetableScheduleStore((s) => s.pick);
  const desk = shell === "desktop";
  const ro = !page.cmp.canEdit;

  const loaded = grid !== null && grid.date === page.date;
  const list: TrayEntry[] = (loaded ? grid.untimed : [])
    .map((u) => ({
      key: `${u.entry.date}-${u.entry.node_id}`,
      nodeId: u.entry.node_id,
      off: u.outOfAxis && u.entry.time ? u.entry.time : null,
      lateFrom: null as string | null,
    }))
    .filter((e) => {
      const it = items[e.key];
      return it && !it.done && !it.skipped;
    });

  if (loaded && isToday) {
    const seen = new Set(list.map((e) => e.key));
    for (const key of lateKeys) {
      const it = items[key];
      if (it?.lateFrom && !seen.has(key)) {
        list.push({ key, nodeId: it.nodeId, off: null, lateFrom: it.lateFrom });
      }
    }
  }
  const late = isToday && lateRepeatCount > 0;

  const goLate = (): void => {
    const ui = useUiStore.getState();
    if (desk) ui.setPage("today");
    else {
      useScheduleUiStore.getState().setMobileSub("today");
      ui.setMobileTab("today");
    }
  };
  const onPick = (key: string): void => {
    if (swallowClick()) return;
    if (ro) {
      useUiStore.getState().showToast({ message: TT_TEXT.schedPast });
      return;
    }
    pick(picked === key ? null : key);
    page.setSel(null);
  };

  const lateLine = late ? (
    <button type="button" className="ns-tt-sched-late" onClick={goLate}>
      {TT_TEXT.schedLateRepeat(lateRepeatCount)} ›
    </button>
  ) : null;

  const addNode = addSegNode(picked);
  const moving = picked ? page.slots[picked] : undefined;
  const movingAdhoc = picked ? page.adhocs[picked] : undefined;
  const pickedTrayItem = picked && !isAddPlaceholder(picked) && !addNode && !moving && !movingAdhoc ? items[picked] : undefined;

  let hintText: string = desk ? SCHED_UI.pickHintDesk : TT_TEXT.schedPickHint;
  if (isAddPlaceholder(picked)) {
    hintText = PLACEHOLDER_UI.pickAdd;
  } else if (addNode !== null) {
    const est = nodes[addNode]?.estimate_min ?? null;
    hintText = SEG_UI.pickAdd(
      nodes[addNode]?.name ?? "？",
      fmtDur((typeof est === "number" && est > 0 ? est : SEG_DEFAULT_MIN) * MIN),
    );
  } else if (moving) {
    hintText = SEG_UI.pickMove(nodes[moving.nodeId]?.name ?? "？", "");
  } else if (movingAdhoc) {
    hintText = SEG_UI.pickMove(movingAdhoc.label || ADHOC_TEXT.fallbackName, "");
  }

  const placeholderBtn = !ro ? (
    <button
      type="button"
      className={"ns-tt-sched-adhoc-btn" + (isAddPlaceholder(picked) ? " is-pick" : "")}
      aria-pressed={isAddPlaceholder(picked)}
      onClick={() => onPick(ADD_PLACEHOLDER_KEY)}
      title="在預定欄放下「預留席車票」（同步顯示於今日頁與時刻表日程）"
    >
      {PLACEHOLDER_UI.addBtn}
    </button>
  ) : null;

  const pickHint = picked ? (
    <p className="ns-tt-sched-pickhint">
      <span>{hintText}</span>
      {pickedTrayItem && (
        <button
          type="button"
          onClick={() => {
            const id = pickedTrayItem.nodeId;
            pick(null);
            void openTicket(id, shell);
          }}
        >
          {SCHED_UI.open}
        </button>
      )}
      <button type="button" onClick={() => pick(null)}>
        {TT_TEXT.schedPickCancel}
        {desk && <kbd className="ns-tt-kbd">Esc</kbd>}
      </button>
    </p>
  ) : null;

  const entries = list.map((u) => {
    const key = u.key;
    const it = items[key];
    const n = nodes[u.nodeId];
    const route = n?.route_id ? routeById[n.route_id] : undefined;
    const disp = planItemDisplay(it, n, route?.name);
    const off = u.off
      ? TT_TEXT.schedOutOfAxis(u.off)
      : u.lateFrom
        ? SCHED_UI.lateTag(md(u.lateFrom), it.time)
        : null;
    const est = it.estimateMin ? fmtDur(it.estimateMin * MIN) : TT_TEXT.schedNoEstimate;
    const meta = [
      disp.badgeText ?? "",
      route?.name ?? "",
      it.kind === "repeat" && disp.badgeKind !== "filled" ? SCHED_UI.repeat : "",
      off ?? "",
      est,
    ].filter(Boolean);

    const cls =
      (mode === "chips" ? "ns-tt-sched-chip" : "ns-tt-sched-ui") +
      (disp.isPlaceholder ? " is-placeholder" : "") +
      (picked === key ? " is-pick" : "") +
      (ro ? " is-ro" : "") +
      (drag?.key === key ? " is-lifted" : "");
    const style = { "--rc": routeColorOf(page, u.nodeId) } as CSSProperties;
    const dragProps = canEdit ? { onPointerDown: onDragStart(key, "list") } : {};

    if (mode === "chips") {
      return (
        <button
          type="button"
          key={key}
          className={cls}
          style={style}
          aria-pressed={picked === key}
          onClick={() => onPick(key)}
          {...dragProps}
        >
          <i className="ns-tt-sched-rdot" aria-hidden="true" />
          <span className="ns-tt-sched-chip-n">{disp.title}</span>
          {disp.badgeText && <em className={`ns-tt-sched-tag is-${disp.badgeKind ?? "seg"}`}>{disp.badgeText}</em>}
          {off && <small className={"ns-tt-num" + (u.lateFrom || u.off ? " is-warn" : "")}>{off}</small>}
          <small className="ns-tt-num ns-tt-sched-chip-est">{est}</small>
        </button>
      );
    }

    return (
      <button
        type="button"
        key={key}
        className={cls}
        style={style}
        aria-pressed={picked === key}
        onClick={() => onPick(key)}
        {...dragProps}
      >
        {!ro && (
          <span className="ns-tt-sched-grip" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </span>
        )}
        <i className="ns-tt-sched-rdot" aria-hidden="true" />
        <span className="ns-tt-sched-ui-main">
          <b>{disp.title}</b>
          <small>{meta.join("・")}</small>
        </span>
      </button>
    );
  });

  const empty = <p className="ns-tt-sched-none">{ro ? SCHED_UI.trayEmptyPast : TT_TEXT.schedTrayEmpty}</p>;

  if (mode === "chips") {
    return (
      <div className="ns-tt-sched-un is-chips">
        <div className="ns-tt-sched-un-h">
          <b>{TT_TEXT.schedTrayTitle}</b>
          <span className="ns-tt-num">{list.length}</span>
          <small>{ro ? SCHED_UI.trayNoteRo : SCHED_UI.trayNoteEditMobile}</small>
          {placeholderBtn}
        </div>
        {list.length ? <div className="ns-tt-sched-chips">{entries}</div> : empty}
        {pickHint ?? lateLine}
      </div>
    );
  }
  return (
    <aside className="ns-tt-sched-un is-side" aria-label={TT_TEXT.schedTrayTitle}>
      <div className="ns-tt-sched-un-h">
        <b>{TT_TEXT.schedTrayTitle}</b>
        <span className="ns-tt-num">{list.length}</span>
        {placeholderBtn}
      </div>
      <p className="ns-tt-sched-un-note">{ro ? TT_TEXT.schedPast : SCHED_UI.trayNoteEdit}</p>
      {list.length ? <div className="ns-tt-sched-ulist">{entries}</div> : empty}
      {pickHint}
      {lateLine && <div className="ns-tt-sched-un-foot">{lateLine}</div>}
    </aside>
  );
}
