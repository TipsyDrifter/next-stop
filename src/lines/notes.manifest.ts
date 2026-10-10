/**
 * 旅客筆記線的登記檔・純資料（並行地基・契約 §5.1）。**只有旅客筆記線改這個檔。**
 *
 * 通車：`page.status` 改成 "open"（手機一起通車就把 `mobile.status` 也改）；元件填在 `./notes.mount.tsx`。
 * 未通車（planned）時 `hotkeys`／`scenes` 必須是空陣列、`hotkeyFiles` 必須是空物件（`pnpm probe:registry` 守門）。
 * 純資料：不得 import React／store／Tauri API；型別一律 `import type`（probe 在 node 直接載入本檔）。
 *
 * 車次①（2026-10-06，契約 docs/research/2026-10-06-旅客筆記-車次①捕捉收件匣筆記-契約.md §6.1）：桌機與手機同時通車；
 * 本檔是最終版，Stage 0 寫入後凍結，之後只有整合席能改。
 */
import type { LineManifest } from "./types";
import type { Hotkey } from "../ui/shell/hotkeys";
import type { Scene } from "../ui/shell/hotkeyRows";

const GLOBAL_LOOSE = ["shift", "alt"] as const;
const SHIFT_LOOSE = ["shift"] as const;
const ALL_LOOSE = ["ctrl", "shift", "alt"] as const;

/** 另外宣告（不包在 as const 裡）：Hotkey.chords 是可變陣列，as const 的 readonly tuple 不滿足它 */
const NOTES_HOTKEYS: Hotkey[] = [
  { id: "notes.capture", scope: "global", chords: [{ key: "n", ctrl: true }], label: "記一句（捕捉）", wired: true, ignoreMods: [...GLOBAL_LOOSE] },
  { id: "notes.move.up", scope: "notes", chords: [{ key: "ArrowUp" }], label: "上移選取", wired: true, ignoreMods: [...SHIFT_LOOSE] },
  { id: "notes.move.down", scope: "notes", chords: [{ key: "ArrowDown" }], label: "下移選取", wired: true, ignoreMods: [...SHIFT_LOOSE] },
  { id: "notes.open", scope: "notes", chords: [{ key: "Enter" }], label: "進編輯／展開去處", wired: true },
  { id: "notes.inbox.todo", scope: "notes", chords: [{ key: "t" }], label: "變待辦（筆記）／排今天（車票）", wired: true },
  { id: "notes.inbox.tomorrow", scope: "notes", chords: [{ key: "t", shift: true }], label: "排明天（車票）", wired: true },
  { id: "notes.inbox.keep", scope: "notes", chords: [{ key: "n" }], label: "留作筆記", wired: true, ignoreMods: [...SHIFT_LOOSE] },
  { id: "notes.inbox.attach", scope: "notes", chords: [{ key: "l" }], label: "掛進列車（車票）", wired: true, ignoreMods: [...SHIFT_LOOSE] },
  { id: "notes.inbox.route", scope: "notes", chords: [{ key: "r" }], label: "掛上路線（車票）", wired: true, ignoreMods: [...SHIFT_LOOSE] },
  { id: "notes.delete", scope: "notes", chords: [{ key: "Delete" }], label: "刪除（可復原）", wired: true, ignoreMods: [...SHIFT_LOOSE] },
  { id: "notes.search", scope: "notes", chords: [{ key: "/" }], label: "搜尋筆記", wired: true },
  { id: "notes.escape", scope: "notes", chords: [{ key: "Escape" }], label: "回閱讀／收起浮層", wired: true, ignoreMods: [...ALL_LOOSE] },
  { id: "notes-capture.save", scope: "notes-capture", chords: [{ key: "Enter" }], label: "存檔", wired: false },
  { id: "notes-capture.newline", scope: "notes-capture", chords: [{ key: "Enter", shift: true }], label: "換行", wired: false },
  { id: "notes-capture.stub.next", scope: "notes-capture", chords: [{ key: "Tab" }], label: "下一枚票根", wired: false },
  { id: "notes-capture.stub.prev", scope: "notes-capture", chords: [{ key: "Tab", shift: true }], label: "上一枚票根", wired: false },
  { id: "notes-capture.escape", scope: "notes-capture", chords: [{ key: "Escape" }], label: "關閉（有內容先問一次）", wired: false },
  { id: "notes-capture.preview.confirm", scope: "notes-capture", chords: [{ key: "Enter", ctrl: true }], label: "預覽框：建立車票", wired: false },
];

/** 設定「快捷鍵」籤與「?」情境卡的分組 */
const NOTES_SCENES: Scene[] = [
  { scope: "notes", title: "旅客筆記", note: "旅客筆記頁選中一則、游標不在字裡的時候。" },
  { scope: "notes-capture", title: "捕捉框（記一句）", note: "捕捉框或變待辦預覽開著的時候；鍵由輸入框自理。" },
];

/**
 * hotkeys 與 scenes 都以「另外宣告、有型別註記的常數」帶入（契約 §8-2 的退路；Stage 0 實測 scenes 非如此不可）：
 * Scene.scope／Hotkey.scope 的型別 HotkeyScope 由 typeof NOTES.hotkeyScopes 導出（lines/index.ts 的 LineHotkeyScope）。
 * scenes 的物件字面值若直接寫在 NOTES 裡，會被 `satisfies LineManifest` 拿去做上下文型別 ⇒ 繞回 NOTES 自己
 * （TS2456／TS7022 型別循環）。hotkeyScopes 留在字面值裡沒問題。
 */
export const NOTES = {
  id: "notes",
  page: { status: "open", label: "旅客筆記", navDigit: "4", guideTitle: "旅客筆記的快捷鍵" },
  mobile: { slot: "tab", status: "open", label: "旅客筆記", latin: "NOTES" },
  hotkeyScopes: ["notes", "notes-capture"],
  hotkeys: NOTES_HOTKEYS,
  scenes: NOTES_SCENES,
  hotkeyFiles: { notes: "ui/notes/useNotesKeyboard.ts", global: "lines/notes.mount.tsx" },
  syncTables: ["notes"],
  syncSettingsKeys: [],
} as const satisfies LineManifest;
