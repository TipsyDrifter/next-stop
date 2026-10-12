/**
 * DesktopSheetHost——桌機的面板宿主（車次①a 契約 §5.2、§5.4；乙席）。
 * 把 `store.sheet` 對應到丙席的六個面板、包進 `DialogShell`（width 460）；標題與面板都走 `panels/index` 的對照表
 * （`sheetTitle`／`SheetPanel`，與手機 MobileSheetHost 共用一份，文案只改一處）。longRun 的 live dot 由 timetable.css §D 用
 * `:has(.ns-tt-sheet-body[data-kind="longRun"])` 畫在標題前（DialogShell 是集中檔、title 只收字串）。
 * 關閉（Esc／點暗幕／×／面板 onDone）一律走 `store.closeSheet()`——關的是 longRun 就算「略過」（契約 0-10）。
 * 面板本體只在確認寫入完成後才叫 onDone（resolveLongRun 成功時 store 自己已把 sheet 收掉，再關一次無害）。
 */
import { useTimetableStore } from "../../store/timetableStore";
import { DialogShell } from "../common/DialogShell";
import { SheetPanel, sheetTitle } from "./panels";
import { useNow } from "./useNow";

const SHEET_WIDTH = 460;

export function DesktopSheetHost() {
  const sheet = useTimetableStore((s) => s.sheet);
  const running = useTimetableStore((s) => s.running);
  const catById = useTimetableStore((s) => s.catById);
  const dayBlocks = useTimetableStore((s) => s.dayBlocks);
  const todayBlocks = useTimetableStore((s) => s.todayBlocks);
  const weekBlocks = useTimetableStore((s) => s.weekBlocks);
  const closeSheet = useTimetableStore((s) => s.closeSheet);
  const now = useNow(1000);

  if (!sheet) return null;
  const title = sheetTitle(sheet, { running, catById, dayBlocks, todayBlocks, weekBlocks }, now);

  return (
    <DialogShell title={title} overline="時刻表 — TIMETABLE" onClose={closeSheet} width={SHEET_WIDTH}>
      <div className="ns-tt-sheet-body" data-kind={sheet.kind}>
        <SheetPanel sheet={sheet} onDone={closeSheet} />
      </div>
    </DialogShell>
  );
}
