/**
 * WeekTimeGrid——桌機行程表第四段「時段」（主線階段②；契約 §4.7 乙；D-主-11、D-主-13、D-主-15）。
 *
 * 時段＝**週的另一種排法**：同一週七天、同一份 `useCalendar()`（游標／區間／載入／選取格／浮層全照週走），
 * 只是畫成「有時刻的票畫在幾點、用預計畫長度」的共用畫布 `TimeGrid`（甲，shell="desktop"）。
 *   資料  useCalendar 的 days／byDate／nodes／routes／today／selectedDay ＋ uiStore.dayStartHour ＋ useMinuteTick()
 *         ⇒ timeGridModel ⇒ <TimeGrid/>
 *   點塊／籤  ⇒ 選取那張票＋開側板（原型 :1407「正式版＝開側板」）；塊上標 .is-sel
 *   點欄頭／欄內空白 ⇒ c.openDay（當日清單浮層，與月格／週格同一個）
 *   畫布內捲動 ⇒ 收掉當日清單浮層（浮層錨在畫布裡的格上，捲走了會對不上；同 CalendarView 外層捲動即關的處置）
 *
 * 版面：`.month-card.ns-sch-wtg` 一張紙、`.ns-tg` 撐滿；頁面本身不捲（CalendarView 掛 `.is-time`，schedule.css）。
 * 不做（契約 §4.8 末）：拖塊改時刻、拉長改預計、點空白建票。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useUiStore } from "../../store/uiStore";
import { useCalendar } from "../calendar/useCalendarController";
import { TimeGrid, type TimeGridHandle } from "./TimeGrid";
import { timeGridModel } from "./timeGridModel";
import { useMinuteTick } from "./useMinuteTick";
import "./schedule.css";

export function WeekTimeGrid() {
  const c = useCalendar();
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const selectedId = useUiStore((s) => s.selectedId);
  const panelOpen = useUiStore((s) => s.panelOpen);
  const now = useMinuteTick();
  const handle = useRef<TimeGridHandle>(null);
  /** 點過的那一塊（`${date}-${node_id}`）；側板換到別張票或關掉就不再標 */
  const [picked, setPicked] = useState<string | null>(null);

  const days = useMemo(
    () =>
      timeGridModel({
        days: c.days,
        // 換週的那一瞬間 store 還是上一週的資料——只畫落在這七天的（timeGridModel 依 days 分組，其餘自然落空）
        entries: c.days.flatMap((d) => c.byDate.entries[d] ?? []),
        dues: c.days.flatMap((d) => c.byDate.dues[d] ?? []),
        nodes: c.nodes,
        dayStartHour,
      }),
    [c.days, c.byDate, c.nodes, dayStartHour],
  );

  const selectedKey = picked && panelOpen && selectedId && picked.endsWith(`-${selectedId}`) ? picked : null;

  // 畫布自己捲（.ns-tg-scroll）：捲動就收當日清單浮層
  const { popTarget, closeDay } = c;
  useEffect(() => {
    const el = handle.current?.scroller();
    if (!el || !popTarget) return;
    const onScroll = () => closeDay();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [popTarget, closeDay]);

  return (
    <div className="month-card ns-sch-wtg">
      <TimeGrid
        days={days}
        dayStartHour={dayStartHour}
        now={now}
        today={c.today}
        selectedDay={c.selectedDay}
        routes={c.routes}
        nodes={c.nodes}
        shell="desktop"
        selectedKey={selectedKey}
        handleRef={handle}
        onPick={(date, nodeId) => {
          setPicked(`${date}-${nodeId}`);
          c.selectDay(date);
          const ui = useUiStore.getState();
          ui.select(nodeId);
          ui.setPanelOpen(true);
        }}
        onHead={(date, el) => c.openDay(date, el)}
      />
    </div>
  );
}
