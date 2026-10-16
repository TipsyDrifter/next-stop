/**
 * MobileCaptureFab——每個分頁右下角的「記一句」浮動圓鈕（車次①契約 §5.3；D-筆-16 手機入口）。
 *
 * 造形＝「一枚空的検印欄」：頁材質＋虛線內圈，**不是第二塊深色面**（對比分層紀律：書封色只在頂帶與 tab bar；
 * 原型 styles.css 八節 .ns-notes-fab）。
 *
 * 定位（樣式在 notes-mobile.css）：fixed、貼 tab bar 之上 14px；今日頁（mobileTab==="today"）再抬一條建票輸入列的高
 * （`--m-newticket-h`），不壓到「無日期」開關與輸入框。任何輸入框聚焦時（軟鍵盤多半彈著）CSS 先把它收起來，
 * 免得浮在鍵盤上方蓋住字。
 */
import { useUiStore } from "../../../store/uiStore";
import { useNotesStore } from "../../../store/notesStore";
import { useScheduleUiStore } from "../../schedule/scheduleUiStore";

export function MobileCaptureFab({ hidden = false }: { hidden?: boolean }) {
  const onTodayTab = useUiStore((s) => s.mobileTab === "today");
  const onTodaySub = useScheduleUiStore((s) => s.mobileSub === "today");
  const onToday = onTodayTab && onTodaySub;
  const openCapture = useNotesStore((s) => s.openCapture);
  return (
    <button
      type="button"
      className={"ns-notes-fab" + (onToday ? " is-today" : "") + (hidden ? " is-hidden" : "")}
      aria-label="記一句"
      aria-hidden={hidden || undefined}
      tabIndex={hidden ? -1 : undefined}
      onClick={() => openCapture()}
    >
      <svg
        width="22"
        height="22"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M3.2 12.8l.9-3.1 6.6-6.6a1.4 1.4 0 0 1 2 2l-6.6 6.6z" />
        <path d="M9.5 4.3l2.2 2.2" />
      </svg>
    </button>
  );
}
