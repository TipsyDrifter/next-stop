/**
 * TodayFocus——今日頁的「專注」（車次② 契約 §5.8、0-14；丙）。段一只寫好；段二填值 commit 掛 `todayStats`（§6.1 #S7、#S8）。
 *
 * 專注＝今天有連到任務或路線（nodeId 或 routeId 非 null）的時間塊聯集，裁到今天的日界線範圍
 * （`focusMs(todayBlocks, dayWindow(dateKey, dayStartHour), now)`；運行中那班算到現在，每分鐘重算）。0 ⇒ 回 null。
 *
 *   桌機：{lead && <span class="sep">・</span>}<span class="ns-tt-focus">專注 <b>1h20m</b></span>
 *         （沿 `TodayView.tsx` 頁首 `.day-stats` 的 DOM 形狀；`.sep` 借核心 class）
 *   手機：<span class="m-today-left">{lead ? "・" : ""}專注 1h20m</span>；`wrap`（核心今天沒畫統計列）⇒ 外面自己包
 *         `<p class="m-today-stats">`——有內容才包，沒內容整個 null，核心不會留下空的 `<p>`（契約 §6.1 #S7）。
 *
 * `dateKey` 不是時刻表 store 的 `todayKey`（今日頁跨日界線、時刻表還沒重讀的那一下）⇒ 回 null，同時在 effect 裡叫一次
 * `refresh()`（store 沒有定時 refresh；同一個 dateKey 只叫一次）。
 */
import { useEffect, useMemo, useRef } from "react";
import { fmtDur, msOf } from "../../../domain/timetable";
import { focusMs, toLinkedSpan } from "../../../domain/timetableLink";
import { dayWindow } from "../../../lib/date";
import { TT_TEXT, useTimetableStore } from "../../../store/timetableStore";
import { useUiStore } from "../../../store/uiStore";
import { useNow } from "../useNow";
import "../timetable.css";

export function TodayFocus({
  shell,
  dateKey,
  lead,
  wrap,
}: {
  shell: "desktop" | "mobile";
  dateKey: string;
  lead: boolean;
  wrap: boolean;
}) {
  const ready = useTimetableStore((s) => s.ready);
  const storeKey = useTimetableStore((s) => s.todayKey);
  const todayBlocks = useTimetableStore((s) => s.todayBlocks);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const now = useNow(60_000);
  const stale = !ready || dateKey !== storeKey;
  const asked = useRef<string | null>(null);

  useEffect(() => {
    if (!ready || dateKey === storeKey || asked.current === dateKey) return;
    asked.current = dateKey;
    void useTimetableStore.getState().refresh();
  }, [ready, dateKey, storeKey]);

  const ms = useMemo(() => {
    if (stale) return 0;
    const w = dayWindow(dateKey, dayStartHour);
    return focusMs(todayBlocks.map(toLinkedSpan), { start: msOf(w.start), end: msOf(w.end) }, now);
  }, [stale, dateKey, dayStartHour, todayBlocks, now]);

  const text = fmtDur(ms);
  if (stale || text === "0m") return null;

  if (shell === "desktop") {
    return (
      <>
        {lead && <span className="sep">・</span>}
        <span className="ns-tt-focus">
          {TT_TEXT.FOCUS} <b>{text}</b>
        </span>
      </>
    );
  }
  const inner = (
    <span className="m-today-left">
      {lead ? "・" : ""}
      {TT_TEXT.FOCUS} {text}
    </span>
  );
  return wrap ? <p className="m-today-stats">{inner}</p> : inner;
}
