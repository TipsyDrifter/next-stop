/**
 * hotkeys——全 App 快捷鍵 registry（**單一真相來源**；M3 ⑦ WP1）。
 *
 * 為什麼放這裡（shell 層）：四張視圖按鍵表（全域／今日／大綱／日曆格層）原本各自寫死字面值，
 * 指引頁若再手抄一份，下一個 milestone 加一顆鍵就漂。拍板（決策記錄 :136「設定頁『操作指南／
 * 鍵盤快捷鍵』分頁＋導航模式 `?` 快速疊層（IME 備援 `Ctrl+/`）」、:190「registry 單一來源」，
 * registry 結構列為純機械項）要求 **registry 是四張表真的在查的那份資料，不是文件**。
 * shell 是全域殼層，today／outline／calendar 三個視圖與 App 層全域鍵都在它下面，往這裡放不會產生
 * 視圖之間互相 import 的橫向依賴。
 *
 * 誰在查它：
 *   - 驅動端（wired: true）：`useGlobalHotkeys` / `useTodayKeyboard` / `useOutlineKeyboard`
 *     / `useCalendarKeyboard` —— 用 `resolveHotkey(scope, e)` 決定「這顆鍵是哪個動作」。
 *   - 顯示端（WP2 `?` 疊層、WP3 設定「快捷鍵」籤）：用 `byScope()` 切片＋`formatChord()` 排鍵帽。
 *   - 防漂 probe：無重複 id／同 scope 無撞鍵／每個 wired id 在對應 hook 檔裡至少出現一次。
 *
 * 不接線的三組（daylist／common／edit，`wired: false`）只登錄給指引頁顯示：當日清單浮層與八個
 * 覆蓋層各自的 Esc 語義有差異，統一反而風險大；它們的鍵是慣例、不會漂（草案 D-⑦-4）。
 *
 * ── 比對語義（讀 code 前先看這段，`ignoreMods` 是行為存底不是設計品味）──
 * `Chord` 的修飾鍵是**精確比對**：沒宣告的修飾鍵按下就不匹配（`{ key: "t" }` 不吃 Ctrl+T／Alt+T），
 * 現行四張表「帶 Ctrl／Alt 就放行給全域鍵或瀏覽器」的規則因此自然成立。
 * 但現行 code 有兩類鍵**刻意不看某些修飾鍵**，registry 必須照抄才能行為零變：
 *   1. `ignoreMods: ["shift"]`——`Space`／`Delete`／`↑↓`／`L`／`U`／`[`／`]`… 這些分支只擋 `mod || alt`，
 *      Shift 沒被檢查（Shift+Space 現在就是「済」）。有 Shift 變體的鍵（Enter／T／Tab）不在此列。
 *   2. `ignoreMods: ["ctrl","shift","alt"]`——`Esc`／`F2` 在現行 switch 裡沒有任何修飾鍵護欄。
 *   3. 全域組另加 `"alt"`——`useGlobalHotkeys` 只看 `ctrlKey || metaKey`，Ctrl+Alt+1 現在也會換頁。
 * 同一顆鍵有兩筆匹配時（例如 Enter 與 Ctrl+Enter）由 `resolveHotkey` 挑「放寬最少」的那筆，
 * 不靠登錄順序；順序只決定顯示與同放寬度時的先來後到。
 *
 * ── 並行地基（契約 2026-09-29 §8）──
 * Ctrl+數字的換頁鍵不再手寫：由 `pages.ts` 的頁面登記表產生（`navHotkeys()`，只產已通車的頁）。
 * 三條功能線的快捷鍵寫在各線的 `src/lines/<line>.manifest.ts`，接在 `HOTKEYS` 最後；scope 名也由登記檔導出。
 * 本檔是 probe 直接載入的純資料：新增的值 import 一律含 `.ts`。
 *
 * ── 覆寫層（⑧ 自訂快捷鍵，D-主-331）──
 * `HOTKEYS` 永遠是預設值（probe 對帳的就是它）；使用者改過的鍵放在 `overrides`，查表與顯示一律經 `effective()`：
 * `matchHotkey`／`resolveHotkey`／`matches`／`byScope`／`hotkeyById` 拿到的都是覆寫後的鍵位，所以四張按鍵表與所有鍵帽字不用各自知道有覆寫。
 * 覆寫過的那一筆**不帶 `ignoreMods`**（放寬是舊行為的存底，使用者自己按的組合鍵就是精確比對）。
 * 存檔、衝突、錄鍵都不在這裡（`hotkeyOverrides.ts`、`hotkeyRebind.ts`、設定籤）；本檔只放 runtime 那一張表與通知。
 */
import type { LineHotkeyScope } from "../../lines/index.ts";
import { LINE_MANIFESTS } from "../../lines/index.ts";
import { openPages } from "./pages.ts";

export type CoreHotkeyScope =
  | "global"
  | "today"
  | "outline"
  | "calendar"
  | "daylist"
  | "search"
  | "depot"
  | "board"
  | "common"
  | "edit";

/** 核心七組＋三線登記檔宣告的 scope */
export type HotkeyScope = CoreHotkeyScope | LineHotkeyScope;

/** 可被放寬（不精確比對）的修飾鍵名 */
export type ModifierName = "ctrl" | "shift" | "alt";

/**
 * 一組鍵位。`key` 用 `KeyboardEvent.key` 的值（字母一律小寫，比對時大小寫不敏感）；
 * `ctrl` 代表 Ctrl／Cmd 任一（沿現行 `e.ctrlKey || e.metaKey`）。
 */
export interface Chord {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export interface Hotkey {
  id: string;
  scope: HotkeyScope;
  /** 多組鍵位＝同一個動作的多條路（如指引頁的 `?` 與 `Ctrl+/`） */
  chords: Chord[];
  label: string;
  note?: string;
  /** true＝這顆鍵真的由某張表驅動；false＝只登錄給指引頁顯示（見檔頭） */
  wired: boolean;
  /** 行為存底：現行 handler 沒有檢查的修飾鍵（見檔頭比對語義） */
  ignoreMods?: ModifierName[];
}

/**
 * 比對用的事件形狀——刻意不寫 `KeyboardEvent`，這樣 React 合成事件、原生事件、probe 的合成物件
 * 三者都能餵進來（helper 保持純函式、不依賴 DOM 型別，probe 才能在 node 直接跑）。
 */
export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/* ───────── 平台判定（原本是 Sidebar.tsx 的本地常數，⑦ 收成一份） ───────── */

export const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);
/** 書封／指引頁上的快捷鍵註記（拉丁小字）：原型定稿寫「CTRL」，Mac 換 ⌘ */
export const MOD_KBD = IS_MAC ? "⌘" : "CTRL";

/* ───────── 鍵位總表（草案 §6；鍵位以四個 hook 檔的實際行為為準） ───────── */

const SHIFT_LOOSE: ModifierName[] = ["shift"];
/** Esc／F2：現行 switch 沒有任何修飾鍵護欄 */
const ALL_LOOSE: ModifierName[] = ["ctrl", "shift", "alt"];
/** 全域表只看 Ctrl／Cmd，Shift／Alt 都沒檢查 */
const GLOBAL_LOOSE: ModifierName[] = ["shift", "alt"];

/**
 * Ctrl+數字換頁鍵：對已通車的頁（`openPages()`，PAGES 順序）逐頁產一筆。
 * 欄位與順序和地基之前手寫的三筆逐欄相同（沒有 `note`；`ignoreMods` 是 GLOBAL_LOOSE）。
 * 未通車的頁不產（契約決策 7：Ctrl+4／5／6 在該線通車前沒有人攔）。
 */
function navHotkeys(): Hotkey[] {
  return openPages().map((p) => ({
    id: p.navHotkeyId,
    scope: "global",
    chords: [{ key: p.navDigit, ctrl: true }],
    label: p.label,
    wired: true,
    ignoreMods: GLOBAL_LOOSE,
  }));
}

export const HOTKEYS: Hotkey[] = [
  /* ── 全域（useGlobalHotkeys；App 層 window listener，輸入框裡也吃） ── */
  ...navHotkeys(),
  {
    id: "global.quickjump",
    scope: "global",
    chords: [{ key: "p", ctrl: true }],
    label: "快速跳轉",
    wired: true,
    ignoreMods: GLOBAL_LOOSE,
  },
  {
    // 完整搜尋班 D-主-111：Shift 必按（Ctrl+P 等全域鍵放寬 Shift，這顆不放寬，免得日後 Ctrl+F 被它吃掉）
    id: "global.fullsearch",
    scope: "global",
    chords: [{ key: "f", ctrl: true, shift: true }],
    label: "完整搜尋",
    wired: true,
    ignoreMods: ["alt"],
  },
  {
    id: "global.panel.toggle",
    scope: "global",
    chords: [{ key: ".", ctrl: true }],
    label: "開關詳情側板",
    note: "句點",
    wired: true,
    ignoreMods: GLOBAL_LOOSE,
  },
  {
    id: "global.settings",
    scope: "global",
    chords: [{ key: ",", ctrl: true }],
    label: "設定",
    note: "逗點",
    wired: true,
    ignoreMods: GLOBAL_LOOSE,
  },
  {
    id: "global.guide",
    scope: "global",
    // `?` 只在導航模式攔（非輸入框、沒有別的疊層開著）；`Ctrl+/` 是 IME 備援，連輸入框裡都吃。
    // 放寬 Shift 是因為 US 配置的 `?` 本來就是 Shift+/，`e.key` 已經是 "?"；Alt 不放寬，
    // 讓 Alt 組合原樣交還瀏覽器（與其它全域鍵略有出入，但這是新鍵、沒有存底要守）。
    chords: [{ key: "?" }, { key: "/", ctrl: true }],
    label: "快捷鍵清單",
    // 不加 note：鍵帽已並排顯示 ?／Ctrl+/，小註若寫鍵名就是第二份真相（Mac 上還會跟 ⌘ 鍵帽打架）
    wired: true,
    ignoreMods: SHIFT_LOOSE,
  },

  /* ── 今日視圖（useTodayKeyboard） ── */
  {
    id: "today.move.up",
    scope: "today",
    chords: [{ key: "ArrowUp" }],
    label: "上移選取",
    wired: true,
    ignoreMods: SHIFT_LOOSE,
  },
  {
    id: "today.move.down",
    scope: "today",
    chords: [{ key: "ArrowDown" }],
    label: "下移選取",
    wired: true,
    ignoreMods: SHIFT_LOOSE,
  },
  {
    id: "today.reorder.up",
    scope: "today",
    chords: [{ key: "ArrowUp", alt: true }],
    label: "今日排序上移",
    wired: true,
    ignoreMods: SHIFT_LOOSE,
  },
  {
    id: "today.reorder.down",
    scope: "today",
    chords: [{ key: "ArrowDown", alt: true }],
    label: "今日排序下移",
    wired: true,
    ignoreMods: SHIFT_LOOSE,
  },
  {
    id: "today.complete",
    scope: "today",
    chords: [{ key: " " }],
    label: "済（完成）",
    wired: true,
    ignoreMods: SHIFT_LOOSE,
  },
  {
    id: "today.draft",
    scope: "today",
    chords: [{ key: "Enter" }],
    label: "新增車票",
    wired: true,
  },
  {
    id: "today.inbox",
    scope: "today",
    chords: [{ key: "Enter", shift: true }],
    label: "新增至收件匣",
    wired: true,
  },
  {
    id: "today.schedule.today",
    scope: "today",
    chords: [{ key: "t" }],
    label: "排今天",
    wired: true,
  },
  {
    id: "today.schedule.tomorrow",
    scope: "today",
    chords: [{ key: "t", shift: true }],
    label: "排明天",
    wired: true,
  },
  {
    id: "today.panel",
    scope: "today",
    chords: [{ key: "." }],
    label: "開詳情側板",
    note: "句點",
    wired: true,
    ignoreMods: SHIFT_LOOSE,
  },
  {
    id: "today.log",
    scope: "today",
    chords: [{ key: "l" }],
    label: "記乘務記錄",
    wired: true,
    ignoreMods: SHIFT_LOOSE,
  },
  {
    id: "today.suspend",
    scope: "today",
    chords: [{ key: "u" }],
    label: "本班運休／取消（定期券）",
    wired: true,
    ignoreMods: SHIFT_LOOSE,
  },
  {
    id: "today.delete",
    scope: "today",
    chords: [{ key: "Delete" }],
    label: "刪除（可復原）",
    wired: true,
    ignoreMods: SHIFT_LOOSE,
  },
  {
    id: "today.escape",
    scope: "today",
    chords: [{ key: "Escape" }],
    // label 照 useTodayController.escape() 的實際順序寫：草稿列→推遲小卡／記錄列→側板
    label: "取消多選／關閉視窗／側板",
    wired: true,
    ignoreMods: ALL_LOOSE,
  },
  /* 多選（回饋乙 D-主-152）：Ctrl+A 全選這一頁、Shift+↑↓ 擴選（精確比 Shift，所以贏過放寬 Shift 的 ↑↓）；Esc 清多選併在 escape 裡 */
  {
    id: "today.select.all",
    scope: "today",
    chords: [{ key: "a", ctrl: true }],
    label: "全選這一頁",
    wired: true,
  },
  {
    id: "today.select.extend.up",
    scope: "today",
    chords: [{ key: "ArrowUp", shift: true }],
    label: "擴選上一列",
    wired: true,
  },
  {
    id: "today.select.extend.down",
    scope: "today",
    chords: [{ key: "ArrowDown", shift: true }],
    label: "擴選下一列",
    wired: true,
  },

  /* ── 路線圖・大綱（useOutlineKeyboard） ── */
  {
    id: "outline.move.up",
    scope: "outline",
    chords: [{ key: "ArrowUp" }],
    label: "上移選取",
    wired: true,
    ignoreMods: SHIFT_LOOSE,
  },
  {
    id: "outline.move.down",
    scope: "outline",
    chords: [{ key: "ArrowDown" }],
    label: "下移選取",
    wired: true,
    ignoreMods: SHIFT_LOOSE,
  },
  {
    id: "outline.reorder.up",
    scope: "outline",
    chords: [{ key: "ArrowUp", alt: true }],
    label: "上移",
    wired: true,
    ignoreMods: SHIFT_LOOSE,
  },
  {
    id: "outline.reorder.down",
    scope: "outline",
    chords: [{ key: "ArrowDown", alt: true }],
    label: "下移",
    wired: true,
    ignoreMods: SHIFT_LOOSE,
  },
  {
    id: "outline.expand",
    scope: "outline",
    chords: [{ key: "ArrowRight" }],
    label: "展開",
    wired: true,
    ignoreMods: SHIFT_LOOSE,
  },
  {
    id: "outline.collapse",
    scope: "outline",
    chords: [{ key: "ArrowLeft" }],
    label: "摺疊",
    wired: true,
    ignoreMods: SHIFT_LOOSE,
  },
  {
    id: "outline.add.sibling",
    scope: "outline",
    chords: [{ key: "Enter" }],
    label: "同層新增",
    wired: true,
    ignoreMods: SHIFT_LOOSE,
  },
  {
    id: "outline.add.ticket",
    scope: "outline",
    chords: [{ key: "Enter", ctrl: true }],
    label: "直接新增車票",
    wired: true,
    ignoreMods: SHIFT_LOOSE,
  },
  {
    id: "outline.indent",
    scope: "outline",
    chords: [{ key: "Tab" }],
    label: "降層",
    wired: true,
  },
  {
    id: "outline.outdent",
    scope: "outline",
    chords: [{ key: "Tab", shift: true }],
    label: "升層",
    wired: true,
  },
  {
    id: "outline.complete",
    scope: "outline",
    chords: [{ key: " " }],
    label: "済（完成）",
    wired: true,
    ignoreMods: SHIFT_LOOSE,
  },
  {
    id: "outline.schedule.today",
    scope: "outline",
    chords: [{ key: "t" }],
    label: "排今天",
    wired: true,
  },
  {
    id: "outline.schedule.tomorrow",
    scope: "outline",
    chords: [{ key: "t", shift: true }],
    label: "排明天",
    wired: true,
  },
  {
    id: "outline.panel",
    scope: "outline",
    chords: [{ key: "." }],
    label: "開詳情側板",
    note: "句點",
    wired: true,
    ignoreMods: SHIFT_LOOSE,
  },
  {
    id: "outline.suspend",
    scope: "outline",
    chords: [{ key: "u" }],
    label: "本班運休／取消（定期券）",
    wired: true,
    ignoreMods: SHIFT_LOOSE,
  },
  {
    id: "outline.delete",
    scope: "outline",
    chords: [{ key: "Delete" }],
    label: "刪除（可復原）",
    wired: true,
    ignoreMods: SHIFT_LOOSE,
  },
  {
    id: "outline.rename",
    scope: "outline",
    chords: [{ key: "F2" }],
    label: "改名",
    wired: true,
    ignoreMods: ALL_LOOSE,
  },
  {
    id: "outline.route.prev",
    scope: "outline",
    chords: [{ key: "[" }],
    label: "上一條路線",
    wired: true,
    ignoreMods: SHIFT_LOOSE,
  },
  {
    id: "outline.route.next",
    scope: "outline",
    chords: [{ key: "]" }],
    label: "下一條路線",
    wired: true,
    ignoreMods: SHIFT_LOOSE,
  },
  {
    id: "outline.escape",
    scope: "outline",
    chords: [{ key: "Escape" }],
    // label 照 useOutlineController.escape()：有縮放先退出縮放，否則收側板
    label: "取消多選／返回上一層／關側板",
    wired: true,
    ignoreMods: ALL_LOOSE,
  },
  /* 多選（回饋乙 D-主-152）：Ctrl+A 全選這一頁、Shift+↑↓ 擴選（精確比 Shift，所以贏過放寬 Shift 的 ↑↓）；Esc 清多選併在 escape 裡 */
  {
    id: "outline.select.all",
    scope: "outline",
    chords: [{ key: "a", ctrl: true }],
    label: "全選這一頁",
    wired: true,
  },
  {
    id: "outline.select.extend.up",
    scope: "outline",
    chords: [{ key: "ArrowUp", shift: true }],
    label: "擴選上一列",
    wired: true,
  },
  {
    id: "outline.select.extend.down",
    scope: "outline",
    chords: [{ key: "ArrowDown", shift: true }],
    label: "擴選下一列",
    wired: true,
  },

  /* 路線圖的分頁（⑫）：大綱｜看板、路線一覽｜篩選，都是這兩顆；焦點不在大綱容器也要能按，接線在 useRouteMapViewKeys */
  {
    id: "outline.view.1",
    scope: "outline",
    chords: [{ key: "1" }],
    label: "切到大綱（路線一覽＝路線）",
    wired: true,
  },
  {
    id: "outline.view.2",
    scope: "outline",
    chords: [{ key: "2" }],
    label: "切到看板（路線一覽＝篩選）",
    wired: true,
  },

  /* ── 路線圖・看板（useBoardKeyboard；路線看板與篩選清單共用） ── */
  { id: "board.move.up", scope: "board", chords: [{ key: "ArrowUp" }], label: "上移選取", wired: true },
  { id: "board.move.down", scope: "board", chords: [{ key: "ArrowDown" }], label: "下移選取", wired: true },
  { id: "board.move.left", scope: "board", chords: [{ key: "ArrowLeft" }], label: "移到左邊一欄", wired: true },
  { id: "board.move.right", scope: "board", chords: [{ key: "ArrowRight" }], label: "移到右邊一欄", wired: true },
  { id: "board.shift.left", scope: "board", chords: [{ key: "ArrowLeft", alt: true }], label: "把這張換到左邊一欄", wired: true },
  { id: "board.shift.right", scope: "board", chords: [{ key: "ArrowRight", alt: true }], label: "把這張換到右邊一欄", wired: true },
  { id: "board.open", scope: "board", chords: [{ key: "Enter" }], label: "開詳情", wired: true },
  { id: "board.complete", scope: "board", chords: [{ key: " " }], label: "済（完成）", wired: true, ignoreMods: SHIFT_LOOSE },
  { id: "board.select.all", scope: "board", chords: [{ key: "a", ctrl: true }], label: "全選這一頁", wired: true },
  { id: "board.escape", scope: "board", chords: [{ key: "Escape" }], label: "取消多選／返回上一層／關側板", wired: true, ignoreMods: ALL_LOOSE },

  /* ── 日曆・格層（useCalendarKeyboard；月／週同一張表） ── */
  {
    id: "calendar.day.prev",
    scope: "calendar",
    chords: [{ key: "ArrowLeft" }],
    label: "前一天",
    wired: true,
    ignoreMods: SHIFT_LOOSE,
  },
  {
    id: "calendar.day.next",
    scope: "calendar",
    chords: [{ key: "ArrowRight" }],
    label: "後一天",
    wired: true,
    ignoreMods: SHIFT_LOOSE,
  },
  {
    id: "calendar.week.prev",
    scope: "calendar",
    chords: [{ key: "ArrowUp" }],
    label: "上一週",
    wired: true,
    ignoreMods: SHIFT_LOOSE,
  },
  {
    id: "calendar.week.next",
    scope: "calendar",
    chords: [{ key: "ArrowDown" }],
    label: "下一週",
    wired: true,
    ignoreMods: SHIFT_LOOSE,
  },
  {
    id: "calendar.page.prev",
    scope: "calendar",
    chords: [{ key: "PageUp" }],
    label: "上個月／上一週",
    wired: true,
    ignoreMods: SHIFT_LOOSE,
  },
  {
    id: "calendar.page.next",
    scope: "calendar",
    chords: [{ key: "PageDown" }],
    label: "下個月／下一週",
    wired: true,
    ignoreMods: SHIFT_LOOSE,
  },
  {
    id: "calendar.month.prev",
    scope: "calendar",
    chords: [{ key: "ArrowLeft", ctrl: true }],
    label: "上個月",
    wired: true,
    ignoreMods: SHIFT_LOOSE,
  },
  {
    id: "calendar.month.next",
    scope: "calendar",
    chords: [{ key: "ArrowRight", ctrl: true }],
    label: "下個月",
    wired: true,
    ignoreMods: SHIFT_LOOSE,
  },
  {
    id: "calendar.year.prev",
    scope: "calendar",
    chords: [{ key: "ArrowUp", ctrl: true }],
    label: "上一年",
    wired: true,
    ignoreMods: SHIFT_LOOSE,
  },
  {
    id: "calendar.year.next",
    scope: "calendar",
    chords: [{ key: "ArrowDown", ctrl: true }],
    label: "下一年",
    wired: true,
    ignoreMods: SHIFT_LOOSE,
  },
  {
    id: "calendar.today",
    scope: "calendar",
    chords: [{ key: "Home" }],
    label: "今天",
    wired: true,
    ignoreMods: SHIFT_LOOSE,
  },
  {
    id: "calendar.open",
    scope: "calendar",
    chords: [{ key: "Enter" }, { key: " " }],
    label: "開當日清單",
    wired: true,
    ignoreMods: SHIFT_LOOSE,
  },
  {
    id: "calendar.escape",
    scope: "calendar",
    chords: [{ key: "Escape" }],
    // label 照 useCalendarController.escape()：當日清單→月年跳轉卡→格上的提示，開著哪個收哪個
    label: "關閉彈出視窗",
    wired: true,
    ignoreMods: ALL_LOOSE,
  },

  /* ── 完整搜尋頁（FullSearchView 自帶一張表；只登錄不接線） ── */
  {
    id: "search.move.up",
    scope: "search",
    chords: [{ key: "ArrowUp" }],
    label: "上移選取",
    wired: false,
  },
  {
    id: "search.move.down",
    scope: "search",
    chords: [{ key: "ArrowDown" }],
    label: "下移選取",
    wired: false,
  },
  {
    id: "search.go",
    scope: "search",
    chords: [{ key: "Enter" }],
    label: "前往這一項",
    wired: false,
  },
  {
    id: "search.clear",
    scope: "search",
    chords: [{ key: "Escape" }],
    label: "清除搜尋字",
    wired: false,
  },

  /* ── 車庫頁（車庫與回顧 D-主-215；useDepotKeyboard） ── */
  {
    id: "depot.back",
    scope: "depot",
    chords: [{ key: "Escape" }],
    label: "關上記錄簿、回車庫",
    wired: true,
    ignoreMods: ALL_LOOSE,
  },

  /* ── 日曆・當日清單浮層（DayPopover 自帶一張表；只登錄不接線） ── */
  {
    id: "daylist.move.up",
    scope: "daylist",
    chords: [{ key: "ArrowUp" }],
    label: "上移選取",
    wired: false,
  },
  {
    id: "daylist.move.down",
    scope: "daylist",
    chords: [{ key: "ArrowDown" }],
    label: "下移選取",
    wired: false,
  },
  {
    id: "daylist.complete",
    scope: "daylist",
    chords: [{ key: " " }],
    label: "済（完成）",
    wired: false,
  },
  {
    id: "daylist.schedule.today",
    scope: "daylist",
    chords: [{ key: "t" }],
    label: "排今天",
    wired: false,
  },
  {
    id: "daylist.schedule.tomorrow",
    scope: "daylist",
    chords: [{ key: "t", shift: true }],
    label: "排明天",
    wired: false,
  },
  {
    id: "daylist.suspend",
    scope: "daylist",
    chords: [{ key: "u" }],
    label: "本班運休／取消（定期券）",
    wired: false,
  },
  {
    id: "daylist.panel",
    scope: "daylist",
    chords: [{ key: "." }],
    label: "開詳情側板",
    note: "句點",
    wired: false,
  },
  {
    id: "daylist.escape",
    scope: "daylist",
    chords: [{ key: "Escape" }],
    label: "收起清單",
    wired: false,
  },
  /* 多選（回饋乙 D-主-152）：Ctrl+A 全選這一頁、Shift+↑↓ 擴選（精確比 Shift，所以贏過放寬 Shift 的 ↑↓）；Esc 清多選併在 escape 裡 */
  {
    id: "daylist.select.all",
    scope: "daylist",
    chords: [{ key: "a", ctrl: true }],
    label: "全選這一頁",
    note: "行程表串流",
    wired: false,
  },
  {
    id: "daylist.select.extend.up",
    scope: "daylist",
    chords: [{ key: "ArrowUp", shift: true }],
    label: "擴選上一列",
    note: "行程表串流",
    wired: false,
  },
  {
    id: "daylist.select.extend.down",
    scope: "daylist",
    chords: [{ key: "ArrowDown", shift: true }],
    label: "擴選下一列",
    note: "行程表串流",
    wired: false,
  },

  /* ── 側板與覆蓋層通用（各元件自理；只登錄不接線） ── */
  {
    id: "common.escape",
    scope: "common",
    chords: [{ key: "Escape" }],
    label: "關閉／取消",
    wired: false,
  },
  {
    id: "common.confirm",
    scope: "common",
    chords: [{ key: "Enter" }],
    label: "確認",
    wired: false,
  },
  {
    id: "common.next",
    scope: "common",
    chords: [{ key: "Tab" }],
    label: "下一項",
    wired: false,
  },
  {
    id: "common.prev",
    scope: "common",
    chords: [{ key: "Tab", shift: true }],
    label: "上一項",
    wired: false,
  },
  {
    id: "common.move",
    scope: "common",
    chords: [{ key: "ArrowUp" }, { key: "ArrowDown" }],
    label: "在清單裡移動",
    wired: false,
  },

  /* ── 編輯模式：輸入框內（輸入框自理；只登錄不接線） ── */
  {
    id: "edit.save",
    scope: "edit",
    chords: [{ key: "Enter" }],
    label: "存檔",
    wired: false,
  },
  {
    id: "edit.cancel",
    scope: "edit",
    chords: [{ key: "Escape" }],
    label: "取消並離開",
    wired: false,
  },
  {
    id: "edit.indent",
    scope: "edit",
    chords: [{ key: "Tab" }],
    label: "降層",
    wired: false,
  },
  {
    // 大綱草稿列裡 Shift+Tab 升層（useOutlineController.retargetDraft）；與 indent 成對合成一列
    id: "edit.outdent",
    scope: "edit",
    chords: [{ key: "Tab", shift: true }],
    label: "升層",
    wired: false,
  },
  {
    id: "edit.save.multiline",
    scope: "edit",
    chords: [{ key: "Enter", ctrl: true }],
    label: "多行輸入存檔",
    wired: false,
  },

  /* ── 三條功能線（各線的 manifest；接在最後，不影響既有行為：resolveHotkey 只在同 scope 內比先後） ── */
  ...LINE_MANIFESTS.flatMap((m) => m.hotkeys),
];

const BY_ID = new Map(HOTKEYS.map((h) => [h.id, h]));

/* ───────── 覆寫層（見檔頭） ───────── */

let overrides: ReadonlyMap<string, Chord[]> = new Map();
let revision = 0;
const listeners = new Set<() => void>();

/** 整張換掉（hotkeyOverrides.ts 載入與改鍵時呼叫）；鍵帽字靠 `subscribeHotkeys` 跟著重畫 */
export function setHotkeyOverrides(next: ReadonlyMap<string, Chord[]>): void {
  overrides = next;
  revision += 1;
  for (const l of listeners) l();
}

export function hotkeyOverrides(): ReadonlyMap<string, Chord[]> {
  return overrides;
}

export function subscribeHotkeys(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function hotkeysRevision(): number {
  return revision;
}

/** 講「預設那顆鍵叫什麼」的註：鍵改掉就不成立了 */
const KEY_NAME_NOTES = new Set(["句點", "逗點"]);

function effective(hk: Hotkey): Hotkey {
  const chords = overrides.get(hk.id);
  if (!chords) return hk;
  return { ...hk, chords, ignoreMods: undefined, note: hk.note && KEY_NAME_NOTES.has(hk.note) ? undefined : hk.note };
}

/* ───────── helper ───────── */

/** 符號鍵（? ! [ …）：Shift 已經是字形的一部分（US 的 `?` 就是 Shift+/），比對與鍵帽都不再看 Shift */
export function isSymbolKey(key: string): boolean {
  return key.length === 1 && !/[\p{L}\p{N} ]/u.test(key);
}

/**
 * 單一 chord 比對（純函式、不碰 DOM）。
 * 字母鍵大小寫不敏感；`ctrl` 吃 Ctrl／Cmd 任一；沒宣告的修飾鍵按下＝不匹配，
 * 除非該修飾鍵列在 `ignore`（行為存底，見檔頭）。
 */
export function matchChord(
  e: KeyLike,
  chord: Chord,
  ignore?: readonly ModifierName[],
): boolean {
  if (e.key.toLowerCase() !== chord.key.toLowerCase()) return false;
  if (!ignore?.includes("ctrl") && !!chord.ctrl !== (e.ctrlKey || e.metaKey)) return false;
  if (!ignore?.includes("shift") && !isSymbolKey(chord.key) && !!chord.shift !== e.shiftKey) return false;
  if (!ignore?.includes("alt") && !!chord.alt !== e.altKey) return false;
  return true;
}

/** 某一筆 hotkey 的任一 chord 命中（帶該筆自己的修飾鍵放寬） */
export function matchHotkey(e: KeyLike, hk: Hotkey): boolean {
  const h = effective(hk);
  return h.chords.some((c) => matchChord(e, c, h.ignoreMods));
}

/**
 * 查表：這顆鍵在這個 scope 裡是哪個動作？沒有就 null（＝該張表不處理，放行）。
 * 多筆命中時挑「放寬最少」的那筆（Ctrl+Enter 勝過放寬 Shift 的 Enter），同放寬度取登錄順序在前者。
 */
export function resolveHotkey(scope: HotkeyScope, e: KeyLike): Hotkey | null {
  let best: Hotkey | null = null;
  let bestSlack = Number.POSITIVE_INFINITY;
  for (const raw of HOTKEYS) {
    if (raw.scope !== scope) continue;
    const hk = effective(raw);
    const slack = hk.ignoreMods?.length ?? 0;
    if (slack >= bestSlack) continue;
    if (!matchHotkey(e, hk)) continue;
    best = hk;
    bestSlack = slack;
  }
  return best;
}

/** 這顆鍵是不是這個 id 的動作（含同 scope 內的優先權裁決） */
export function matches(e: KeyLike, id: string): boolean {
  const hk = BY_ID.get(id);
  if (!hk) return false;
  return resolveHotkey(hk.scope, e)?.id === id;
}

/** 某一組的鍵表（保序＝登錄順序＝指引頁顯示順序） */
export function byScope(scope: HotkeyScope): Hotkey[] {
  return HOTKEYS.filter((h) => h.scope === scope).map(effective);
}

export function hotkeyById(id: string): Hotkey | undefined {
  const hk = BY_ID.get(id);
  return hk && effective(hk);
}

/** 登錄的預設鍵位（設定籤比對「改過沒」、單列還原用）；其他人一律用 `hotkeyById` */
export function defaultHotkeyById(id: string): Hotkey | undefined {
  return BY_ID.get(id);
}

/** 鍵名 → 鍵帽字（方向鍵箭頭、Space／Esc／Del 人話、字母大寫） */
const KEY_CAP: Record<string, string> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  " ": "Space",
  Escape: "Esc",
  Delete: "Del",
};

/**
 * chord → 鍵帽陣列（如 `["Ctrl", "Enter"]`）；指引頁一顆一枚 `<kbd>` 排。
 * Mac 顯 ⌘／⌥／⇧，Windows 顯 Ctrl／Alt／Shift（D-⑦-6）。
 */
export function formatChord(chord: Chord, isMac: boolean = IS_MAC): string[] {
  const caps: string[] = [];
  if (chord.ctrl) caps.push(isMac ? "⌘" : "Ctrl");
  if (chord.alt) caps.push(isMac ? "⌥" : "Alt");
  const k = chord.key;
  if (chord.shift && !isSymbolKey(k)) caps.push(isMac ? "⇧" : "Shift");
  caps.push(KEY_CAP[k] ?? (k.length === 1 ? k.toUpperCase() : k));
  return caps;
}

/** 某個 id 的第一組鍵位排成一句（`Ctrl+Enter`）；查不到回空字串。title、提示字一律用它，不手抄 */
export function capsOfHotkey(id: string): string {
  const hk = hotkeyById(id);
  return hk ? formatChord(hk.chords[0]).join("+") : "";
}

/**
 * 導航模式判定：target 是輸入框／可編輯區時整張表停用（編輯語義由輸入框自理）。
 * 原本今日／大綱／日曆三張表各自有一份一模一樣的實作，⑦ 收成這一份。
 */
export function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable;
}

/**
 * 這一下是不是「叫快捷鍵指引」：單鍵那條只在導航模式算（輸入框裡是打字），帶修飾鍵的連輸入框裡都算。
 * 自己開浮層的元件（當日清單、跳轉卡、推遲小卡）要一起擋，不然指引卡會疊上來（Esc 互搶）。
 */
export function isGuideKey(e: KeyLike & { target: EventTarget | null }): boolean {
  if (!matches(e, "global.guide")) return false;
  return e.ctrlKey || e.metaKey || e.altKey || !isEditableTarget(e.target);
}
