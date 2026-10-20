/**
 * 時刻表線的登記檔・純資料（並行地基・契約 §5.1）。**只有時刻表線改這個檔。**
 *
 * 通車：`page.status` 改成 "open"（手機一起通車就把 `mobile.status` 也改）；元件填在 `./timetable.mount.tsx`。
 * 未通車（planned）時 `hotkeys`／`scenes` 必須是空陣列、`hotkeyFiles` 必須是空物件（`pnpm probe:registry` 守門）。
 * 純資料：不得 import React／store／Tauri API；型別一律 `import type`（probe 在 node 直接載入本檔）。
 *
 * 車次①a（契約 §6.1）：通車、三個頁內鍵（N／Enter／V）、兩張同步表、一把同步 settings 鍵。此後凍結，只有整合席能改。
 * 車次①b（①b①c 契約 §5.9）：頁內鍵加七個（←／→／T／R／E／S／F）；①b①c 的新設定鍵全部本地、不進 syncSettingsKeys。
 * 車次②段二（② 契約 0-1 甲、§6.1 #F2；接縫 #66）：今日頁鍵 N＝`timetable.today.depart`（scope "today"，登記在核心 scope ⇒
 *   id 以 `timetable.` 開頭，牙齒 10）；處理函式在 mount 的 `todayRowActions[].hotkeys`，`hotkeyFiles.today` 指向 mount。
 * 車次③（③ 契約 §5.8；D-時-57；整合席）：視圖 1–4、統計 D／W／M 七個鍵；←／→／T 依視圖分派（只補 note）。
 * 車次④（④ 契約 0-7；D-時-74；整合席）：視圖 5＝日程；←／→／T 在日程＝換日（同軸，note 照舊）。
 * 車次⑤（⑤ 契約 0-6；D-時-92、104；整合席）：視圖 6＝方眼；←／→／T 在方眼＝換日（同軸，note 照舊）；Esc 不登記（方眼元件自己處理）。
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
const STEP_NOTE = "週視圖＝換週，統計＝換期";
const STATS_ONLY_NOTE = "統計視圖才有作用";

const TIMETABLE_HOTKEYS: Hotkey[] = [
  { id: "timetable.depart", scope: "timetable", chords: [{ key: "n" }], label: "発車／換車", wired: true },
  { id: "timetable.arrive", scope: "timetable", chords: [{ key: "Enter" }], label: "到着（運行中才有效）", wired: true },
  { id: "timetable.view", scope: "timetable", chords: [{ key: "v" }], label: "切換視圖", note: "兩欄⇄只看軸；在週視圖、統計、日程或方眼按下回到兩欄", wired: true },
  // 車次③（③ 契約 §5.8、D-時-57）：視圖四格 1–4（同切換鈕的鍵帽）。無修飾鍵、不加 ignoreMods（同①b）
  { id: "timetable.view.1", scope: "timetable", chords: [{ key: "1" }], label: "切到兩欄", wired: true },
  { id: "timetable.view.2", scope: "timetable", chords: [{ key: "2" }], label: "切到只看軸", wired: true },
  { id: "timetable.view.3", scope: "timetable", chords: [{ key: "3" }], label: "切到週視圖", wired: true },
  { id: "timetable.view.4", scope: "timetable", chords: [{ key: "4" }], label: "切到統計", wired: true },
  // 車次④（④ 契約 0-7、D-時-74）：第五格日程
  { id: "timetable.view.5", scope: "timetable", chords: [{ key: "5" }], label: "切到日程", wired: true },
  // 車次⑤（⑤ 契約 0-6、D-時-92）：第六格方眼
  { id: "timetable.view.6", scope: "timetable", chords: [{ key: "6" }], label: "切到方眼", wired: true },
  // 車次①b（①b①c 契約 §5.9；Stage 0-B 寫最終版，之後凍結）：無修飾鍵、不加 ignoreMods（Shift+T 等不吃）
  // 車次③（③ 契約 §5.8、D-時-57）：←／→／T 同一組鍵依視圖分派（週視圖＝換週／回本週，統計＝換期／回本期），不另登記；只補 note
  { id: "timetable.day.prev", scope: "timetable", chords: [{ key: "ArrowLeft" }], label: "前一天", note: STEP_NOTE, wired: true },
  { id: "timetable.day.next", scope: "timetable", chords: [{ key: "ArrowRight" }], label: "後一天", note: STEP_NOTE, wired: true },
  { id: "timetable.day.today", scope: "timetable", chords: [{ key: "t" }], label: "回今天", note: "週視圖＝回到本週，統計＝回到本期", wired: true },
  { id: "timetable.restart", scope: "timetable", chords: [{ key: "r" }], label: "改出發時間（運行中才有效）", wired: true },
  { id: "timetable.settings", scope: "timetable", chords: [{ key: "e" }], label: "分類與設定", wired: true },
  { id: "timetable.split", scope: "timetable", chords: [{ key: "s" }], label: "切開運行中那一班", wired: true },
  { id: "timetable.fill", scope: "timetable", chords: [{ key: "f" }], label: "補記最近的一段未記錄", wired: true },
  // 車次③：統計的期 D／W／M——只在統計視圖作用，其他視圖放行（不 preventDefault）
  { id: "timetable.stats.day", scope: "timetable", chords: [{ key: "d" }], label: "統計看一天", note: STATS_ONLY_NOTE, wired: true },
  { id: "timetable.stats.week", scope: "timetable", chords: [{ key: "w" }], label: "統計看一週", note: STATS_ONLY_NOTE, wired: true },
  { id: "timetable.stats.month", scope: "timetable", chords: [{ key: "m" }], label: "統計看一個月", note: STATS_ONLY_NOTE, wired: true },
  // 車次②段二：今日頁選中一列按 N ＝從那張票発車（精確比對、不加 ignoreMods：Shift+N 不作用）
  { id: "timetable.today.depart", scope: "today", chords: [{ key: "n" }], label: "発車（時刻表）", wired: true },
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
  hotkeyFiles: { timetable: "ui/timetable/useTimetableKeyboard.ts", today: "lines/timetable.mount.tsx" },
  syncTables: ["time_categories", "time_blocks", "time_goals"],
  syncSettingsKeys: ["timetable_long_run_max_min"],
} as const satisfies LineManifest;
