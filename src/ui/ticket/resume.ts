/**
 * 頁面一直開著跨午夜／跨月（沒有任何寫入）時，讓「今天」相關的顯示跟上——UI 端的輕量觸發，不輪詢。
 *
 * 觸發點：分頁回到可見（visibilitychange → visible）、視窗拿到焦點（桌機從別的視窗切回來不發 visibilitychange）。
 * 全模組只掛一組監聽器（路線圖每條路線列都會訂閱，不要每列各掛一組）；最後一個訂閱者離開就拆。
 * 訂閱者自己判斷「有沒有變」，便宜到可以每次回來都跑：
 *   - useRouteSpendFresh：叫 store 既有的 loadRouteSpend（它自己偵測跨月、整批作廢；沒跨月且已有值就直接 return）。
 *   - useCalendarTodayFresh：月曆格的 isToday 跟今天對不上才叫既有的 setView("calendar")（進日曆時本來就會重算）。
 * 兩者 mount 時也各檢查一次：頁面切走再切回來（store 的快取還是昨天／上個月算的）同樣跟得上。
 */
import { useEffect, useRef } from "react";
import { todayKey } from "../../lib/date";
import type { CalendarCell } from "../../domain/ticketView";
import { useTicketStore } from "../../store/ticketStore";
import { useUiStore } from "../../store/uiStore";

const subs = new Set<() => void>();

function fire(): void {
  for (const fn of [...subs]) fn();
}
/** visibilitychange 也會在「變隱藏」時發；只接回到可見那一下（focus 本身就代表在前景，不另外擋） */
function onVisibility(): void {
  if (document.visibilityState === "visible") fire();
}

/** 回到前景時呼叫 fn（fn 用 ref 讀最新值，訂閱只在 mount／unmount 變動） */
export function useOnResume(fn: () => void): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const call = () => ref.current();
    if (subs.size === 0) {
      document.addEventListener("visibilitychange", onVisibility);
      window.addEventListener("focus", fire);
    }
    subs.add(call);
    return () => {
      subs.delete(call);
      if (subs.size === 0) {
        document.removeEventListener("visibilitychange", onVisibility);
        window.removeEventListener("focus", fire);
      }
    };
  }, []);
}

/** 路線「本月」花費：已載過的才補叫（沒載過的由元件自己的 effect 處理，那條路徑會先 warm） */
export function useRouteSpendFresh(routeId: string): void {
  const check = () => {
    const st = useTicketStore.getState();
    if (st.routeSpend[routeId]) void st.loadRouteSpend(routeId);
  };
  useEffect(check, [routeId]); // eslint-disable-line react-hooks/exhaustive-deps
  useOnResume(check);
}

/** 月曆格的「今天」標記過期了沒：今天在格子裡 ⇒ 標記要剛好落在今天；不在 ⇒ 不該有任何格標今天 */
export function calendarTodayStale(cal: readonly (readonly CalendarCell[])[], today: string): boolean {
  let flagged: string | null = null;
  let present = false;
  for (const week of cal)
    for (const c of week) {
      if (c.isToday) flagged = c.dayKey;
      if (c.dayKey === today) present = true;
    }
  return present ? flagged !== today : flagged !== null;
}

/** 月曆今日格：過期且正在日曆視圖 ⇒ 叫既有的 setView("calendar") 重算。
 *  詳情板開著 entry／account 時不叫（setView 會把它收起，不能因為切回視窗就關掉使用者正在看的東西） */
export function useCalendarTodayFresh(): void {
  const check = () => {
    const st = useTicketStore.getState();
    if (st.view !== "calendar" || st.calendar === null) return;
    if (st.panel.kind === "entry" || st.panel.kind === "account") return;
    if (!calendarTodayStale(st.calendar, todayKey(useUiStore.getState().dayStartHour))) return;
    void st.setView("calendar");
  };
  useEffect(check, []); // eslint-disable-line react-hooks/exhaustive-deps
  useOnResume(check);
}
