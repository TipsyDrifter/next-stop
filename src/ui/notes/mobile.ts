/**
 * 旅客筆記・手機元件出口（mount 檔只從這裡 import；車次①契約 §2.0、§2.3）。
 * export 名凍結：`MobileNotes`（底部第三格的頁）、`NotesMobileOverlay`（浮動鈕＋捕捉面板＋變待辦預覽；每個 tab 都在）。
 * 樣式 `notes-mobile.css` 由這兩個根元件各自 import（每條規則都掛 `[data-shell="mobile"]`，桌機零影響）。
 */
export { MobileNotes } from "./mobile/MobileNotes";
export { NotesMobileOverlay } from "./mobile/NotesMobileOverlay";
