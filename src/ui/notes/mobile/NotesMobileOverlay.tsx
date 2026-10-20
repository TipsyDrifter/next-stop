/**
 * NotesMobileOverlay——手機全域浮層的殼（＝浮動鈕＋捕捉面板＋變待辦全螢幕預覽；車次①契約 §5.3）。
 *
 * 由 `lineOverlays("mobile")` 掛在 MobileShell 最後（每個 tab 都在；契約增補二）。三件互斥：
 *   preview 開著 ⇒ 畫預覽（store.openCapture 在 preview 開著時本來就不開捕捉）；
 *   capture 開著 ⇒ 畫面板；兩者都沒有 ⇒ 浮動鈕可按。
 *   浮動鈕**一直留在 DOM**、面板開著時只是藏起來：notes-mobile.css 用 `:has(.ns-notes-fab)` 給 `.m-page` 墊底部留白
 *   （最後一張票捲得出鈕的範圍），鈕若拔掉再插回，留白會跟著抽動、畫面底下的捲動位置跳一下。
 * 車次③：荷札點選器（`tagStore.picker`，契約 §5.5）也畫在這裡——優先序 預覽 > 點選器 > 捕捉面板（同時只畫一件）；
 *   點選器開著時浮動鈕同樣收起。誰都能 `tagStore.openPicker(...)` 叫它（路線圖詳情、編輯工具列、之後的票卡 ⋯）。
 * 狀態全在 notesStore（桌機 NotesDesktopOverlay 同一份），兩殼永不同時渲染（useShell.ts）。
 * 磨光① 返回層（契約 §1.5）：預覽（full）與捕捉面板（sheet）登記在這裡（狀態的主人＝store，這裡是唯一畫它們的地方）；
 *   active 跟著「現在畫的是哪一件」走。點選器的返回要叫它自己的 finish()，登記在 MobileTagPicker。
 */
import { useNotesStore } from "../../../store/notesStore";
import { useTagStore } from "../../../store/tagStore";
import { useBackLayer } from "../../mobile/backStack";
import { MobileCaptureFab } from "./MobileCaptureFab";
import { MobileCaptureSheet } from "./MobileCaptureSheet";
import { MobileTodoPreview } from "./MobileTodoPreview";
import { MobileTagPicker } from "./MobileTagPicker";
import { useShareIntake } from "./useShareIntake";
import "../notes-mobile.css";

export function NotesMobileOverlay() {
  // 車次⑤：別的 App 分享進來的文字收進收件匣（Android 限定；桌機殼不掛這個浮層）
  useShareIntake();
  const hasCapture = useNotesStore((s) => s.capture !== null);
  const hasPreview = useNotesStore((s) => s.preview !== null);
  const picker = useTagStore((s) => s.picker);
  // 返回＝預覽的「取消」；捕捉框＝取消鈕／Esc（有內容時第一下只出提醒，第二下才關——兩段式照舊）
  useBackLayer("notes.preview", hasPreview, () => useNotesStore.getState().cancelPreview(), "full");
  useBackLayer("notes.capture", !hasPreview && !picker && hasCapture, () => useNotesStore.getState().escapeCapture());
  return (
    <>
      <MobileCaptureFab hidden={hasPreview || hasCapture || picker !== null} />
      {hasPreview ? <MobileTodoPreview /> : picker ? <MobileTagPicker picker={picker} /> : hasCapture ? <MobileCaptureSheet /> : null}
    </>
  );
}
