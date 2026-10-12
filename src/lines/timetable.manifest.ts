/**
 * 時刻表線的登記檔・純資料（並行地基・契約 §5.1）。**只有時刻表線改這個檔。**
 *
 * 通車：`page.status` 改成 "open"（手機一起通車就把 `mobile.status` 也改）；元件填在 `./timetable.mount.tsx`。
 * 未通車（planned）時 `hotkeys`／`scenes` 必須是空陣列、`hotkeyFiles` 必須是空物件（`pnpm probe:registry` 守門）。
 * 純資料：不得 import React／store／Tauri API；型別一律 `import type`（probe 在 node 直接載入本檔）。
 *
 * 車次①a（契約 §6.1）：通車、三個頁內鍵（N／Enter／V）、兩張同步表、一把同步 settings 鍵。此後凍結，只有整合席能改。
 */
import type { LineManifest } from "./types";
import type { Hotkey } from "../ui/shell/hotkeys";
import type { Scene } from "../ui/shell/hotkeyRows";

/**
 * hotkeys 與 scenes 都以「另外宣告、有型別註記的常數」帶入（地基契約 §13 標準寫法；旅客筆記線同）：
 * Hotkey.scope／Scene.scope 的型別 HotkeyScope 由本檔 `TIMETABLE.hotkeyScopes` 導出（lines/index.ts 的 LineHotkeyScope），
 * 物件字面值若直接寫在 TIMETABLE 裡會被 `satisfies LineManifest` 拿去做上下文型別 ⇒ 繞回自身推導（TS7022／TS2456）。
 * 另外宣告也順便避開 as const 的 readonly tuple 不滿足 Hotkey.chords 可變陣列的問題。
 */
const TIMETABLE_HOTKEYS: Hotkey[] = [
  { id: "timetable.depart", scope: "timetable", chords: [{ key: "n" }], label: "発車／換車", wired: true },
  { id: "timetable.arrive", scope: "timetable", chords: [{ key: "Enter" }], label: "到着（運行中才有效）", wired: true },
  { id: "timetable.view", scope: "timetable", chords: [{ key: "v" }], label: "切換視圖", wired: true },
];

const TIMETABLE_SCENES: Scene[] = [
  { scope: "timetable", title: "時刻表", note: "時刻表頁、游標不在字裡、沒有面板開著的時候。" },
];

export const TIMETABLE = {
  id: "timetable",
  page: { status: "open", label: "時刻表", navDigit: "5", guideTitle: "時刻表的快捷鍵" },
  mobile: { slot: "tab", status: "open", label: "時刻表", latin: "TIMETABLE" },
  hotkeyScopes: ["timetable"],
  hotkeys: TIMETABLE_HOTKEYS,
  scenes: TIMETABLE_SCENES,
  hotkeyFiles: { timetable: "ui/timetable/useTimetableKeyboard.ts" },
  syncTables: ["time_categories", "time_blocks"],
  syncSettingsKeys: ["timetable_long_run_max_min"],
} as const satisfies LineManifest;
