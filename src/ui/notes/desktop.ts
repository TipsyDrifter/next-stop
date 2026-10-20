/**
 * 旅客筆記・桌機元件出口（mount 檔只從這裡 import；車次①契約 §2.0）。
 * export 名凍結：`NotesView`、`NotesDesktopOverlay`（契約 §2.5 第 6 點）。
 * `CaptureButton`：側欄工具插槽（mount 的 `sidebarTool`，契約 0-1 甲）由整合席接上。
 * 車次③（契約 §6.1）：
 *   - `NotesCoverAux`：書封頁務件（mount 的 `sidebarAux`，0-17）
 *   - `TagField`：任務側板「荷札」欄的桌機元件（`nodeFields` 一筆的 `Desktop`；手機的 `Mobile` 在 mobile.ts，整合席組成一筆 spec）
 *   - `NOTES_QUICK_JUMP`：Ctrl+P 的荷札提供者（mount 的 `quickJump`，0-5；整合席接 QuickJump 後填）
 * 車次④（契約 §2.2、§6.1；整合席填 mount）：
 *   - `NoteField`：任務側板「筆記」區（`nodeFields` 第二筆的 `Desktop`；kinds＝`NOTE_NODE_KINDS`、`top: true`）
 *   - `CalendarDiaryAux`：日曆當日清單浮層底部的「日記」列（mount 的 `calendarDayAux`）
 *   - `NOTES_QUICK_JUMPS`：Ctrl+P 三組提供者［荷札、筆記、日記］（mount 的 `quickJump` 改填這個陣列；§5.2、0-3 甲）
 */
import type { QuickJumpProviderSpec } from "../../lines/types";
import { NOTES_QUICK_JUMP } from "./tags/quickJump";
import { NOTES_QJ_DIARY, NOTES_QJ_NOTES } from "./quickJumpNotes";

export { NotesView } from "./NotesView";
export { NotesDesktopOverlay } from "./NotesDesktopOverlay";
export { CaptureButton } from "./CaptureButton";
export { NotesCoverAux } from "./NotesCoverAux";
export { TagField } from "./tags/TagField";
// 時刻表⑥ 契約 0-7：不綁實體種類的荷札欄（實體模式＝立刻寫；受控模式＝只改草稿）；別線的面板從這裡 import
export { EntityTagField, draftHasKey, type EntityTagFieldProps } from "./tags/EntityTagField";
export { NOTES_QUICK_JUMP } from "./tags/quickJump";
export { NoteField } from "./NoteField";
export { CalendarDiaryAux } from "./CalendarDiaryAux";
// 階段⑤（契約 §4.3）：捕捉小窗的根；main.tsx 在 isCaptureWindow() 時掛它
export { CaptureWindowApp } from "./capture-window/CaptureWindowApp";
// 階段⑤（契約 §4.5／§5.4）：設定〈一般〉的開機自啟一列；SettingsPanel 從這裡 import
export { AutostartRow } from "./AutostartRow";
export { NOTES_QJ_NOTES, NOTES_QJ_DIARY };
/** Ctrl+P 的三組（順序＝畫面上的組序：荷札、筆記、日記） */
export const NOTES_QUICK_JUMPS: readonly QuickJumpProviderSpec[] = [NOTES_QUICK_JUMP, NOTES_QJ_NOTES, NOTES_QJ_DIARY];
