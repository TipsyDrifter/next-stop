/**
 * 建票列（回饋甲 D-主-127、128、131、135）——全 App 每個「新增車票／列車」的地方都用這一套。
 *   桌機：QuickAddRow（票形草稿列）、QuickAddLauncher（清單尾常駐「＋ 新增車票…」）、DoneToggleChip（区段標「済 N・隱藏」）
 *   手機：MobileQuickAdd（底部輸入列）
 *   共用：useQuickAdd（解析、chips、送出）、quickAddModel（規則，純函式）
 */
export { QuickAddRow, type QuickAddRowProps, type QuickPositional } from "./QuickAddRow";
export { InlineTicketEditor, type InlineTicketEditorProps } from "./InlineTicketEditor";
export { MobileQuickAdd, type MobileQuickAddProps } from "./MobileQuickAdd";
export { QuickAddLauncher, DoneToggleChip, type QuickAddLauncherProps, type DoneToggleChipProps } from "./QuickAddEntry";
export { useQuickAdd, attachQuickTags, type QuickAddApi, type QuickExtra, type UseQuickAddOptions } from "./useQuickAdd";
export {
  NO_DEST,
  resolveQuickTarget,
  leaveNote,
  type QuickDest,
  type QuickDefaults,
  type QuickHere,
  type QuickTarget,
  type RouteKind,
} from "./quickAddModel";
