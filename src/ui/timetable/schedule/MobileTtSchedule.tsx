/**
 * MobileTtSchedule——時刻表手機頁的「日程」視圖（④ 契約 §5.1、§5.10；〈原型定案〉2、3、7；D-時-87；乙席）。
 * 檔名避開主線的 `ui/mobile/MobileSchedule.tsx`（契約 §2）。長相＝原型 prototypes/時刻表-④.html 手機（v-h.js schedHtml is-phone）。
 *
 *   div.ns-tt-sched.is-phone[data-no-fab]（撐滿 .m-page 剩下的高；整頁不捲，時間軸自己捲——§L 用 :has 把 .m-page 改成直欄不捲；
 *     data-no-fab＝收起「記一句」浮鈕，跟方眼同一個取捨，要記一句從今日頁或其他頁；磨光③ 2-13）
 *   ├ ScheduleNav ＋ ScheduleSummary
 *   ├ UnscheduledTray mode="chips"（頂上一排橫捲 chip：點一下再點位置、長按 0.4 秒拖）
 *   └ ScheduleGrid layout="inline"（每小時 44px；卡最小一行≈30 分，短票一行「13:30 背 N5 單字 準點」）
 *
 * 手機的點：預定卡第一下只點亮（卡角「打開 ›」、連到的實績描金），再點一下或按「打開 ›」才開面板（MobileSheetHost 的 plan sheet）。
 * 點實績塊照軸的語義（不另做描金）。
 *
 * 整合席掛法：MobileTimetable 的 schedule 分支＝`<MobileTtSchedule />`，放在 `.m-page.ns-tt-m` 裡、切換鈕（.ns-tt-mtop）下面；
 * 底部運行列與 MobileSheetHost 照舊（plan sheet 由 panels/index.ts 的 SheetPanel 畫）。
 */
import { useRef } from "react";
import { TT_TEXT } from "../../../store/timetableStore";
import { useUiStore } from "../../../store/uiStore";
import { ScheduleGrid } from "./ScheduleGrid";
import { ScheduleNav, ScheduleSummary } from "./ScheduleSummary";
import { UnscheduledTray } from "./UnscheduledTray";
import { DragFloat, usePickEscape } from "./ScheduleView";
import { SCHED_UI } from "./scheduleModel";
import { useSchedulePage } from "./useSchedulePage";
import { useScheduleDrag } from "./useScheduleDrag";

const HOUR_PX = 44;

export function MobileTtSchedule() {
  const page = useSchedulePage("mobile");
  const pcolRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { drag, onPointerDown, swallowClick } = useScheduleDrag({
    enabled: page.canEdit,
    dayStartHour: page.dayStartHour,
    pcolRef,
    scrollRef,
    onDrop: (key, min) => {
      page.setSel(null);
      page.place(key, min);
    },
    onMiss: (src) => {
      if (src === "list") useUiStore.getState().showToast({ message: `${SCHED_UI.dropMissed}：${SCHED_UI.dropMissedSub}` });
    },
  });
  usePickEscape();

  return (
    <div className="ns-tt-sched is-phone" data-no-fab aria-label={TT_TEXT.viewSchedule}>
      <ScheduleNav page={page} />
      <ScheduleSummary page={page} />
      {page.error && !page.grid && <p className="ns-tt-sched-err">⚠ {page.error}</p>}
      <UnscheduledTray page={page} mode="chips" drag={drag} onDragStart={onPointerDown} swallowClick={swallowClick} />
      <ScheduleGrid
        page={page}
        layout="inline"
        hourPx={HOUR_PX}
        drag={drag}
        onDragStart={onPointerDown}
        swallowClick={swallowClick}
        pcolRef={pcolRef}
        scrollRef={scrollRef}
      />
      <DragFloat page={page} drag={drag} />
    </div>
  );
}
