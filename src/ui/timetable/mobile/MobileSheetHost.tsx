/**
 * MobileSheetHost——手機的面板殼（車次①a 契約 §5.3；丙席）。
 * `store.sheet` → 對應 panel；關閉＝下滑把手／點暗幕／返回鍵／Esc ⇒ `store.closeSheet()`（longRun 面板被這樣關＝「略過」，契約 0-10）。
 * 標題由 `sheetTitle` 給；longRun 前置 live dot。
 *
 * UI 丙-4 C3（規範 §2.4 手機底部 sheet）：殼換成共用的 `MSheet`（拉柄、襯線標題、無 ×、內容自己捲、按鈕列黏底），
 * 舊的 `.m-sheet-veil > .m-sheet.ns-tt-sheet`＋× 退役。
 * - 返回層：`backId="timetable.sheet"`——TimetableMobileAgent 已用同一個 id 登記（kind 預設 sheet），backStack refcount 合併成一層，
 *   返回鍵按一次就關（不會變兩層）。
 * - Esc：MSheet 只讓返回堆疊最上面那一層吃。荷札點選器（旅客筆記的 `notes.tagPicker`，蓋在面板上）開著時它在最上面 ⇒ Esc 不關
 *   底下的面板（⑥ 評審後的規則，舊殼靠讀 tagStore.picker 擋；等價）。
 *   面板自己的子層（連結子頁 `timetable.blockLink`／`timetable.departLink`）在最上面時 MSheet 也不吃——
 *   這裡把 Esc 轉成那一層的返回（＝它自己的「‹」），外接鍵盤跟返回鍵一樣一次退一層。
 *   GoalPanel 的日期換成 DateChip 後，那一層是 DateChip 自己的 MSheet（`common.datechip.<id>`）、Esc 它自己吃，不在這張表。
 * - foot：有按鈕列的面板（`sheetHasFoot`）給一個空容器，面板的 `<Actions>` portal 進去（同桌機 DesktopSheetHost）；即時存的不給。
 * - 高度 auto（跟內容、初始 ≤60%），長面板（補記／改一塊、目標、分類）往上拉把手可到 90%。
 */
import { useEffect } from "react";
import { useTimetableStore } from "../../../store/timetableStore";
import { backStack } from "../../mobile/backStack";
import { MSheet } from "../../common/MSheet";
import { SheetPanel, sheetHasFoot, sheetTitle } from "../panels";
import { TtFootContext, useTtFoot } from "../panels/controls";
import { useNow } from "../useNow";

/** 面板內的子層（返回＝回面板）；Esc 轉給它們（MSheet 只管 timetable.sheet 這一層） */
const SUB_LAYERS = new Set(["timetable.blockLink", "timetable.departLink"]);

export function MobileSheetHost() {
  const sheet = useTimetableStore((s) => s.sheet);
  const running = useTimetableStore((s) => s.running);
  const catById = useTimetableStore((s) => s.catById);
  const dayBlocks = useTimetableStore((s) => s.dayBlocks);
  const todayBlocks = useTimetableStore((s) => s.todayBlocks);
  const weekBlocks = useTimetableStore((s) => s.weekBlocks);
  const closeSheet = useTimetableStore((s) => s.closeSheet);
  const now = useNow(60_000); // longRun 標題「已經跑了 X」跟著跳（分鐘級；與桌機一致）
  const open = sheet !== null;
  const { foot, el } = useTtFoot(!!sheet && sheetHasFoot(sheet.kind));

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape" || e.isComposing || e.keyCode === 229 || e.defaultPrevented) return;
      const top = backStack.top();
      if (!top || !SUB_LAYERS.has(top.id)) return;
      e.preventDefault();
      backStack.popTop();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!sheet) return null;
  const title = sheetTitle(sheet, { running, catById, dayBlocks, todayBlocks, weekBlocks }, now);

  return (
    <MSheet
      backId="timetable.sheet"
      onClose={closeSheet}
      foot={foot}
      title={
        <>
          {sheet.kind === "longRun" && <span className="ns-tt-sheet-dot" aria-hidden="true" />}
          {title}
        </>
      }
    >
      <TtFootContext.Provider value={el}>
        <div className="ns-tt-sheet-body" data-kind={sheet.kind}>
          <SheetPanel sheet={sheet} onDone={closeSheet} />
        </div>
      </TtFootContext.Provider>
    </MSheet>
  );
}
