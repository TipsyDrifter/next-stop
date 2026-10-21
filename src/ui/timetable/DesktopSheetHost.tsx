/**
 * DesktopSheetHost——桌機的面板宿主（車次①a 契約 §5.2、§5.4；乙席）。
 * 把 `store.sheet` 對應到丙席的六個面板、包進 `DialogShell`（width 510，磨光⑥）；標題與面板都走 `panels/index` 的對照表
 * （`sheetTitle`／`SheetPanel`，與手機 MobileSheetHost 共用一份，文案只改一處）。longRun 的 live dot 由 timetable.css §D 用
 * `:has(.ns-tt-sheet-body[data-kind="longRun"])` 畫在標題前（DialogShell 是集中檔、title 只收字串）。
 * 關閉（Esc／點暗幕／×／面板 onDone）一律走 `store.closeSheet()`——關的是 longRun 就算「略過」（契約 0-10）。
 * 面板本體只在確認寫入完成後才叫 onDone（resolveLongRun 成功時 store 自己已把 sheet 收掉，再關一次無害）。
 */
import { useTimetableStore } from "../../store/timetableStore";
import { DialogShell } from "../common/DialogShell";
import { SheetPanel, sheetTitle } from "./panels";
import { useNow } from "./useNow";

/** 磨光⑥ §1-5½：460 → 510（時刻列一行排得下 −1h −15 −5 −1｜框｜+1 +5 +15 +1h；chip 換下一行） */
const SHEET_WIDTH = 510;
/**
 * 磨光③ 2-4（體檢 S4）：置頂距離 8vh（DialogShell 預設 18vh；前例：設定 10vh、指引 6vh、售票口 9vh）——補記／改一塊在
 * 1280×800、1366×768 按鈕不用捲就看得到；長面板撐不下時按鈕列黏底（timetable.css §F `.ns-tt-panel-block .ns-tt-actions`）。
 */
const SHEET_TOP = "pt-[8vh]";

export function DesktopSheetHost() {
  const sheet = useTimetableStore((s) => s.sheet);
  const running = useTimetableStore((s) => s.running);
  const catById = useTimetableStore((s) => s.catById);
  const dayBlocks = useTimetableStore((s) => s.dayBlocks);
  const todayBlocks = useTimetableStore((s) => s.todayBlocks);
  const weekBlocks = useTimetableStore((s) => s.weekBlocks);
  const closeSheet = useTimetableStore((s) => s.closeSheet);
  const now = useNow(1000);

  // ④（乙席）：日程的 plan 面板在桌機是貼在卡旁的浮層，由 schedule/ScheduleView 的 PlanPopover 自己畫，這裡不包置中的 DialogShell
  if (!sheet || sheet.kind === "plan") return null;
  const title = sheetTitle(sheet, { running, catById, dayBlocks, todayBlocks, weekBlocks }, now);

  return (
    <DialogShell title={title} overline="時刻表 — TIMETABLE" onClose={closeSheet} width={SHEET_WIDTH} topClass={SHEET_TOP}>
      <div className="ns-tt-sheet-body" data-kind={sheet.kind}>
        <SheetPanel sheet={sheet} onDone={closeSheet} />
      </div>
    </DialogShell>
  );
}
