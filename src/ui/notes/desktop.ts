/**
 * 旅客筆記・桌機元件出口（mount 檔只從這裡 import；車次①契約 §2.0）。
 * export 名凍結：`NotesView`、`NotesDesktopOverlay`（契約 §2.5 第 6 點）。
 * `CaptureButton`：側欄工具插槽（mount 的 `sidebarTool`，契約 0-1 甲）由整合席接上。
 * 車次③（契約 §6.1）：
 *   - `NotesCoverAux`：書封頁務件（mount 的 `sidebarAux`，0-17）
 *   - `TagField`：任務側板「荷札」欄的桌機元件（`nodeFields` 一筆的 `Desktop`；手機的 `Mobile` 在 mobile.ts，整合席組成一筆 spec）
 *   - `NOTES_QUICK_JUMP`：Ctrl+P 的荷札提供者（mount 的 `quickJump`，0-5；整合席接 QuickJump 後填）
 */
export { NotesView } from "./NotesView";
export { NotesDesktopOverlay } from "./NotesDesktopOverlay";
export { CaptureButton } from "./CaptureButton";
export { NotesCoverAux } from "./NotesCoverAux";
export { TagField } from "./tags/TagField";
export { NOTES_QUICK_JUMP } from "./tags/quickJump";
