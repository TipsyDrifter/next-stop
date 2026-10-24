/**
 * DesktopSheetHost——桌機的面板宿主（車次①a 契約 §5.2、§5.4；乙席）。
 * 把 `store.sheet` 對應到丙席的六個面板、包進 `DialogShell`；標題與面板都走 `panels/index` 的對照表
 * （`sheetTitle`／`SheetPanel`，與手機 MobileSheetHost 共用一份，文案只改一處）。longRun 的 live dot 由 timetable.css §D 用
 * `:has(.ns-tt-sheet-body[data-kind="longRun"])` 畫在標題前（DialogShell 是集中檔、title 只收字串）。
 * 關閉（Esc／點暗幕／×／面板 onDone）一律走 `store.closeSheet()`——關的是 longRun 就算「略過」（契約 0-10）。
 * 面板本體只在確認寫入完成後才叫 onDone（resolveLongRun 成功時 store 自己已把 sheet 收掉，再關一次無害）。
 *
 * UI 丙-4 C1（規範 §2.4 置中對話框）：
 * - 殼統一成 `size="M"`（520）＋物件眉標「時刻表 / Timetable」；舊的 width 510、置頂 8vh 拿掉，照規範置頂 18vh。
 *   8vh 當初是為了讓補記／改一塊的按鈕在 768 高不用捲就看得到——按鈕列抬進黏底 foot 之後本文自己捲，不必再壓置頂距離。
 * - 有按鈕列的面板給 `foot`：一個空 div（`useTtFoot`），面板的 `<Actions>` 經 `TtFootContext` portal 進去（面板程式不搬 DOM）。
 *   即時存的面板（分類與設定、連結、算哪一類、荷札、待確認清單）與發車面板（點分類即發車，主鈕在本文裡）不給——規範 §2.3「即時存沒有主鈕列」。
 */
import { useTimetableStore } from "../../store/timetableStore";
import { DialogShell } from "../common/DialogShell";
import { SheetPanel, sheetHasFoot, sheetTitle } from "./panels";
import { TtFootContext, useTtFoot } from "./panels/controls";
import { useNow } from "./useNow";

export function DesktopSheetHost() {
  const sheet = useTimetableStore((s) => s.sheet);
  const running = useTimetableStore((s) => s.running);
  const catById = useTimetableStore((s) => s.catById);
  const dayBlocks = useTimetableStore((s) => s.dayBlocks);
  const todayBlocks = useTimetableStore((s) => s.todayBlocks);
  const weekBlocks = useTimetableStore((s) => s.weekBlocks);
  const closeSheet = useTimetableStore((s) => s.closeSheet);
  const now = useNow(1000);
  const { foot, el } = useTtFoot(!!sheet && sheetHasFoot(sheet.kind));

  // ④（乙席）：日程的 plan 面板在桌機是貼在卡旁的浮層，由 schedule/ScheduleView 的 PlanPopover 自己畫，這裡不包置中的 DialogShell
  if (!sheet || sheet.kind === "plan") return null;
  const title = sheetTitle(sheet, { running, catById, dayBlocks, todayBlocks, weekBlocks }, now);

  return (
    <DialogShell title={title} overline={{ zh: "時刻表", latin: "Timetable" }} size="M" onClose={closeSheet} foot={foot}>
      <TtFootContext.Provider value={el}>
        <div className="ns-tt-sheet-body" data-kind={sheet.kind}>
          <SheetPanel sheet={sheet} onDone={closeSheet} />
        </div>
      </TtFootContext.Provider>
    </DialogShell>
  );
}
