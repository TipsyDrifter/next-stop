/**
 * UnscheduledTray——日程的「還沒排」（④ 契約 §5.7、D-時-80；〈原型定案〉2；乙席）。
 * 長相＝原型 v-h.js unHtml（.vh-un.is-side／.is-chips）→ 正式版 `.ns-tt-sched-un`（timetable.css §L）。
 *
 *   桌機 aside.ns-tt-sched-un.is-side：標題「還沒排 N」、說明、一張張卡（可拖、點一下＝選起來）、點選提示、底部「另有 N 班定期券漏班在今日頁 ›」
 *   手機 div.ns-tt-sched-un.is-chips：標題列、一排橫捲 chip（點一下＝選、長按 0.4 秒拖）、點選提示或漏班那一行
 *
 * 內容＝`grid.untimed`（沒時刻的、軸外的「軸外 03:30」）去掉済／運休，今天再接誤點的單發票（`lateKeys`，chip 標「誤點・10/17」；
 * 使用者改題 D-時-80：排上去＝執行日改到今天＋排時刻，store.placeAt 處理）。過去的日子照列、不能拖不能選。
 * 漏班那一行只有今天且 `lateRepeatCount > 0`（定期券主線擋改執行日，不進清單）；點了跳今日頁（桌機 setPage、手機 setMobileTab）。
 */
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { TT_TEXT } from "../../../store/timetableStore";
import { useTimetableScheduleStore } from "../../../store/timetableScheduleStore";
import { useUiStore } from "../../../store/uiStore";
import { useScheduleUiStore } from "../../schedule/scheduleUiStore";
import { MIN, fmtDur } from "../../../domain/timetable";
import { SCHED_UI } from "./scheduleModel";
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
  // 當天沒時刻的（含軸外），之後接今天的誤點單發票（使用者 00:1x 改題 D-時-80；store 只在今天給 lateKeys）
  const loaded = grid !== null && grid.date === page.date;
  const list: TrayEntry[] = (loaded ? grid.untimed : [])
    .map((u) => ({ key: `${u.entry.date}-${u.entry.node_id}`, nodeId: u.entry.node_id, off: u.outOfAxis && u.entry.time ? u.entry.time : null, lateFrom: null as string | null }))
    .filter((e) => {
      const it = items[e.key];
      return it && !it.done && !it.skipped;
    });
  if (loaded && isToday) {
    const seen = new Set(list.map((e) => e.key));
    for (const key of lateKeys) {
      const it = items[key];
      if (it?.lateFrom && !seen.has(key)) list.push({ key, nodeId: it.nodeId, off: null, lateFrom: it.lateFrom });
    }
  }
  const late = isToday && lateRepeatCount > 0;

  const goLate = (): void => {
    const ui = useUiStore.getState();
    if (desk) ui.setPage("today");
    else {
      // 漏班整群在今日段的誤點區（不是某一張票，不走 revealOnToday）；手機今日 tab 可能停在「行程表」段，先切回今日段（磨光① A7 同類）
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
  const pickHint = picked ? (
    <p className="ns-tt-sched-pickhint">
      <span>{desk ? SCHED_UI.pickHintDesk : TT_TEXT.schedPickHint}</span>
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
    const name = n?.name ?? "？";
    const route = n?.route_id ? routeById[n.route_id] : undefined;
    const off = u.off ? TT_TEXT.schedOutOfAxis(u.off) : u.lateFrom ? SCHED_UI.lateTag(md(u.lateFrom), it.time) : null;
    const est = it.estimateMin ? fmtDur(it.estimateMin * MIN) : TT_TEXT.schedNoEstimate;
    const meta = [route?.name ?? "", it.kind === "repeat" ? SCHED_UI.repeat : "", off ?? "", est].filter(Boolean);
    const cls = (mode === "chips" ? "ns-tt-sched-chip" : "ns-tt-sched-ui") + (picked === key ? " is-pick" : "") + (ro ? " is-ro" : "") + (drag?.key === key ? " is-lifted" : "");
    const style = { "--rc": routeColorOf(page, u.nodeId) } as CSSProperties;
    const dragProps = canEdit ? { onPointerDown: onDragStart(key, "list") } : {};
    if (mode === "chips") {
      return (
        <button type="button" key={key} className={cls} style={style} aria-pressed={picked === key} onClick={() => onPick(key)} {...dragProps}>
          <i className="ns-tt-sched-rdot" aria-hidden="true" />
          <span className="ns-tt-sched-chip-n">{name}</span>
          {off && <small className={"ns-tt-num" + (u.lateFrom || u.off ? " is-warn" : "")}>{off}</small>}
          <small className="ns-tt-num ns-tt-sched-chip-est">{est}</small>
        </button>
      );
    }
    return (
      <button type="button" key={key} className={cls} style={style} aria-pressed={picked === key} onClick={() => onPick(key)} {...dragProps}>
        {!ro && (
          <span className="ns-tt-sched-grip" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </span>
        )}
        <span className="ns-tt-sched-ui-main">
          <b>{name}</b>
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
      </div>
      <p className="ns-tt-sched-un-note">{ro ? TT_TEXT.schedPast : SCHED_UI.trayNoteEdit}</p>
      {list.length ? <div className="ns-tt-sched-ulist">{entries}</div> : empty}
      {pickHint}
      {lateLine && <div className="ns-tt-sched-un-foot">{lateLine}</div>}
    </aside>
  );
}
