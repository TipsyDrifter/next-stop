/**
 * NotesMobileOverlay——手機全域浮層的殼（＝浮動鈕＋捕捉面板＋變待辦全螢幕預覽；車次①契約 §5.3）。
 *
 * 由 `lineOverlays("mobile")` 掛在 MobileShell 最後（每個 tab 都在；契約增補二）。三件互斥：
 *   preview 開著 ⇒ 畫預覽（store.openCapture 在 preview 開著時本來就不開捕捉）；
 *   capture 開著 ⇒ 畫面板；兩者都沒有 ⇒ 浮動鈕可按。
 *   浮動鈕**一直留在 DOM**、面板開著時只是藏起來：notes-mobile.css 用 `:has(.ns-notes-fab)` 給 `.m-page` 墊底部留白
 *   （最後一張票捲得出鈕的範圍），鈕若拔掉再插回，留白會跟著抽動、畫面底下的捲動位置跳一下。
 * 狀態全在 notesStore（桌機 NotesDesktopOverlay 同一份），兩殼永不同時渲染（useShell.ts）。
 */
import { useNotesStore } from "../../../store/notesStore";
import { MobileCaptureFab } from "./MobileCaptureFab";
import { MobileCaptureSheet } from "./MobileCaptureSheet";
import { MobileTodoPreview } from "./MobileTodoPreview";
import "../notes-mobile.css";

export function NotesMobileOverlay() {
  const hasCapture = useNotesStore((s) => s.capture !== null);
  const hasPreview = useNotesStore((s) => s.preview !== null);
  return (
    <>
      <MobileCaptureFab hidden={hasPreview || hasCapture} />
      {hasPreview ? <MobileTodoPreview /> : hasCapture ? <MobileCaptureSheet /> : null}
    </>
  );
}
