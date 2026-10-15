/**
 * 旅客筆記線的登記檔・元件與掛點（並行地基・契約 §5.1；增補二）。**只有旅客筆記線改這個檔。**
 *
 * - `desktopView`：桌機頁面元件（`notes.manifest.ts` 的 `page.status` 是 "open" 才會被畫出來）
 * - `mobileView` ：手機頁面元件（`mobile.status` 是 "open" 才會被畫出來）
 * - `reload`     ：同步拉到東西／本機被整批換掉之後，重載這條線的畫面狀態（`syncStore` 呼叫）
 * - 選填 `desktopOverlay`／`mobileOverlay`／`globalHotkeyHandlers`：全域浮層與全域快捷鍵（增補二；未通車不生效）
 *
 * 車次①（契約 §6.1）：Stage 0 寫入最終版；`sidebarTool`（側欄捕捉鈕 CaptureButton，0-1 甲）由整合席在乙席出貨後填上。
 * 車次②（契約 §6.1）：`calendarDayMarks`（日曆格內日記記號，0-2 乙）由整合席在調度放行後填上。
 * 車次③（契約 §6.1、0-17）：`sidebarAux`＝書封頁務件 NotesCoverAux（插槽 #50 已在 main；旅客筆記頁拿掉獨立頁務件欄的同一批）。
 *   `nodeFields`（荷札欄）／`quickJump`（Ctrl+P 打 #）由整合席接好集中檔渲染點後填；`ticketSheetItems`（手機票卡 ⋯）在主線 v1.6.0 進 main 後補。
 * 寫法約束（probe）：`desktopView`／`mobileView` 的欄位與值寫同一行（registry 牙齒 9）；
 * 全域鍵的處理函式物件必須寫在本檔、鍵用字串字面值（hotkeys 牙齒 3 在本檔找 "notes.capture"）。
 */
import type { LineMount, NodeFieldSpec, TicketSheetItemSpec } from "./types";
import type { NodeKind } from "../domain";
import { TAG_ENTITY_NODE_KINDS } from "../domain/tags";
import { NotesView, NotesDesktopOverlay, CaptureButton, NotesCoverAux, TagField, NOTES_QUICK_JUMP } from "../ui/notes/desktop";
import { MobileNotes, NotesMobileOverlay, MobileTagRow, MobileTagSheetItem } from "../ui/notes/mobile";
import { useNotesStore } from "../store/notesStore";
import { noteRepo } from "../data/noteRepo";

/** 「荷札」欄：桌機 TagField（乙席）＋手機 MobileTagRow（丙席）組成一筆（kinds 由 domain 常數給：車票／列車／車廂） */
const NOTES_NODE_FIELDS: readonly NodeFieldSpec[] = [
  { id: "notes.tags", label: "荷札", kinds: TAG_ENTITY_NODE_KINDS as readonly NodeKind[], Desktop: TagField, Mobile: MobileTagRow },
];

/** 手機今日／行程表票卡 ⋯ 的「荷札…」（車次③ 0-3；渲染點在 MobileTicketSheet） */
const NOTES_TICKET_SHEET_ITEMS: readonly TicketSheetItemSpec[] = [{ id: "notes.tags", Item: MobileTagSheetItem }];

export const NOTES_MOUNT: LineMount = {
  desktopView: NotesView,
  mobileView: MobileNotes,
  reload: (ctx) => useNotesStore.getState().reload(ctx),
  desktopOverlay: NotesDesktopOverlay,
  mobileOverlay: NotesMobileOverlay,
  // 書封搜尋鈕左側的「記一句」（0-1 甲；無 props＝書封款）
  sidebarTool: CaptureButton,
  // 鍵以字串字面值寫在本檔（probe 牙齒 3 在本檔找 "notes.capture"；§13〈新增全域浮層〉第 1 點）
  globalHotkeyHandlers: { "notes.capture": () => useNotesStore.getState().openCapture() },
  // 日曆格內記號＝有日記的日子（車次② 0-2 乙；listDiaryDays 回升冪的日 key）
  calendarDayMarks: (from, to) => noteRepo.listDiaryDays(from, to),
  // 書封頁務件（車次③ 0-17）：旅客筆記頁時取代「我的路線」
  sidebarAux: NotesCoverAux,
  // 任務側板／手機路線圖唯讀詳情的「荷札」列（車次③ 0-2／0-4；渲染點在 TaskFields、MobileRouteMap）
  nodeFields: NOTES_NODE_FIELDS,
  // Ctrl+P 打 # 只找荷札、一般結果後多一組「荷札」（車次③ 0-5）
  quickJump: NOTES_QUICK_JUMP,
  // 手機票卡 ⋯ sheet 的「荷札…」（車次③ 0-3；主對話 10-14 裁併進 1.7.0）
  ticketSheetItems: NOTES_TICKET_SHEET_ITEMS,
};
