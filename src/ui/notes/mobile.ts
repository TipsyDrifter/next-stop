/**
 * 旅客筆記・手機元件出口（mount 檔只從這裡 import；車次①契約 §2.0、§2.3）。
 * export 名凍結：`MobileNotes`（底部第三格的頁）、`NotesMobileOverlay`（浮動鈕＋捕捉面板＋變待辦預覽；每個 tab 都在）。
 * 樣式 `notes-mobile.css` 由這兩個根元件各自 import（每條規則都掛 `[data-shell="mobile"]`，桌機零影響）。
 * 車次③（契約 §6.1）：
 *   - `MobileTagRow`：手機路線圖唯讀詳情的「荷札」列（`nodeFields` 一筆的 `Mobile`；桌機的 `Desktop` 在 desktop.ts，整合席組成一筆 spec）
 *   - 荷札點選器不必 export：誰都用 `useTagStore.getState().openPicker(...)` 叫，NotesMobileOverlay 畫
 *     （之後的票卡 ⋯ →「荷札…」一列就是 `close(); openPicker({ mode:"entity", entityType:"node", entityId, name })`）。
 */
export { MobileNotes } from "./mobile/MobileNotes";
export { NotesMobileOverlay } from "./mobile/NotesMobileOverlay";
export { MobileTagRow } from "./mobile/MobileTagRow";
export { MobileTagSheetItem } from "./mobile/MobileTagSheetItem";
