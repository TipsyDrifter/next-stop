/**
 * 旅客筆記・桌機元件出口（mount 檔只從這裡 import；車次①契約 §2.0）。
 * export 名凍結：`NotesView`、`NotesDesktopOverlay`（契約 §2.5 第 6 點）。
 * `CaptureButton`：側欄工具插槽（mount 的 `sidebarTool`，契約 0-1 甲）由整合席接上。
 */
export { NotesView } from "./NotesView";
export { NotesDesktopOverlay } from "./NotesDesktopOverlay";
export { CaptureButton } from "./CaptureButton";
