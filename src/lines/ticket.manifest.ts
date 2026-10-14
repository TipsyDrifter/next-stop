/**
 * 售票口線的登記檔・純資料（並行地基・契約 §5.1）。**只有售票口線改這個檔。**
 *
 * 通車：`page.status` 改成 "open"（手機一起通車就把 `mobile.status` 也改）；元件填在 `./ticket.mount.tsx`。
 * 未通車（planned）時 `hotkeys`／`scenes` 必須是空陣列、`hotkeyFiles` 必須是空物件（`pnpm probe:registry` 守門）。
 * 純資料：不得 import React／store／Tauri API；型別一律 `import type`（probe 在 node 直接載入本檔）。
 *
 * 車次①（契約 §3.11）：通車、九個頁內鍵＋五個欄位內鍵（只登錄）、四張同步表；此後凍結，只有整合席能改。
 */
import type { LineManifest } from "./types";
import type { Hotkey } from "../ui/shell/hotkeys";
import type { Scene } from "../ui/shell/hotkeyRows";

const SHIFT_LOOSE = ["shift"] as const;
const ALL_LOOSE = ["ctrl", "shift", "alt"] as const;

/** 另外宣告、有型別註記（地基契約 §13 標準寫法；同 timetable.manifest.ts:14-24 的理由） */
const TICKET_HOTKEYS: Hotkey[] = [
  { id: "ticket.new", scope: "ticket", chords: [{ key: "n" }], label: "記一筆", wired: true, ignoreMods: [...SHIFT_LOOSE] },
  { id: "ticket.move.up", scope: "ticket", chords: [{ key: "ArrowUp" }], label: "上一筆", wired: true, ignoreMods: [...SHIFT_LOOSE] },
  { id: "ticket.move.down", scope: "ticket", chords: [{ key: "ArrowDown" }], label: "下一筆", wired: true, ignoreMods: [...SHIFT_LOOSE] },
  { id: "ticket.open", scope: "ticket", chords: [{ key: "Enter" }], label: "開這一筆", wired: true },
  { id: "ticket.delete", scope: "ticket", chords: [{ key: "Delete" }], label: "刪除（可復原）", wired: true, ignoreMods: [...SHIFT_LOOSE] },
  { id: "ticket.month.prev", scope: "ticket", chords: [{ key: "[" }], label: "上一個月", wired: true },
  { id: "ticket.month.next", scope: "ticket", chords: [{ key: "]" }], label: "下一個月", wired: true },
  { id: "ticket.account.next", scope: "ticket", chords: [{ key: "Tab" }], label: "下一個帳戶篩選", wired: true },
  { id: "ticket.escape", scope: "ticket", chords: [{ key: "Escape" }], label: "收起", wired: true, ignoreMods: [...ALL_LOOSE] },
  { id: "ticket-entry.save", scope: "ticket-entry", chords: [{ key: "Enter" }], label: "存檔（新票）", wired: false },
  { id: "ticket-entry.again", scope: "ticket-entry", chords: [{ key: "Enter", ctrl: true }], label: "存並再記", wired: false },
  { id: "ticket-entry.next", scope: "ticket-entry", chords: [{ key: "Tab" }], label: "下一個欄位", wired: false },
  { id: "ticket-entry.escape", scope: "ticket-entry", chords: [{ key: "Escape" }], label: "放棄／收起", wired: false },
  { id: "ticket-entry.pick", scope: "ticket-entry", chords: [{ key: "ArrowUp" }, { key: "ArrowDown" }], label: "分類欄：選候選", wired: false },
];

const TICKET_SCENES: Scene[] = [
  { scope: "ticket", title: "售票口", note: "售票口頁選中一筆、游標不在字裡的時候。" },
  { scope: "ticket-entry", title: "記一筆（大票）", note: "詳情板的票開著、游標在欄位裡的時候；鍵由輸入欄自理。" },
];

export const TICKET = {
  id: "ticket",
  page: { status: "open", label: "售票口", navDigit: "6", guideTitle: "售票口的快捷鍵" },
  mobile: { slot: "tab", status: "open", label: "售票口", latin: "TICKET OFFICE" },
  hotkeyScopes: ["ticket", "ticket-entry"],
  hotkeys: TICKET_HOTKEYS,
  scenes: TICKET_SCENES,
  hotkeyFiles: { ticket: "ui/ticket/useTicketKeyboard.ts" },
  syncTables: ["tk_currencies", "tk_accounts", "tk_categories", "tk_entries"],
  syncSettingsKeys: [],
} as const satisfies LineManifest;
