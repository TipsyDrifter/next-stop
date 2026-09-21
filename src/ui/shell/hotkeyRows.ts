/**
 * hotkeyRows——快捷鍵 registry 的「顯示切片」（M3 ⑦ Wave B 契約席；純資料＋純函式，零 DOM 依賴）。
 *
 * 誰在用：
 *   - WP2 `?` 情境卡 `HotkeyGuide.tsx`（D-⑦-1 甲）：`pageScope(page)` 取當前頁的 scope，
 *     `rowsFor(scope)` ＋ `rowsFor("global")` 兩段。
 *   - WP3 設定「快捷鍵」籤 `HotkeysTab.tsx`（D-⑦-2 甲）：`SCENES` 依序七組，每組 `rowsFor(scene.scope)`；
 *     籤頂 `DUAL_MODE_NOTE` 三句。
 *   - 防漂 probe：每一筆 registry id 都必須出現在某一列的 `ids` 裡（wired 與不接線的都要）。
 *
 * 為什麼另開一檔而不寫在 hotkeys.ts：hotkeys.ts 是四張按鍵表真的在查的驅動資料，這裡是給人看的排版
 * 邏輯（成對合併、情境註、雙模式說明）；顯示端改文案不該碰到驅動端。文案來源仍是 registry 的
 * `label`／`note`，這裡只做「成對的兩筆合成一列」與少數合併後的標題對照（`PAIR_LABEL`），不手抄鍵位。
 *
 * 一列（`HotkeyRow`）的 `chords: Chord[][]`：
 *   外層＝顯示槽（成對合併的列有兩槽，先後照 registry 登錄順序：↑ 在 ↓ 前、Tab 在 Shift+Tab 前；單筆一槽），
 *   內層＝該槽的可替代鍵位（registry 一筆的 `chords`，如「開當日清單」的 Enter／Space、「快捷鍵指引」的 ?／Ctrl+/）。
 *   顯示端一律 `rowPaths(row)` 攤平成一串 Chord，每條用 `formatChord()` 排鍵帽，條與條之間放「／」——
 *   「移動選取 ↑ ／ ↓」「換月 Ctrl+← ／ Ctrl+→」「開當日清單 Enter ／ Space」都是這一種寫法，不需要分辨槽與替代。
 */

import type { PageId } from "../../store/uiStore";
import type { Chord, Hotkey, HotkeyScope } from "./hotkeys";
import { byScope, formatChord, hotkeyById } from "./hotkeys";

/* ───────── 七組（顯示順序＝這個陣列的順序） ───────── */

export interface Scene {
  scope: HotkeyScope;
  /** 組標題（籤內的 .techo-overline／情境卡的段標） */
  title: string;
  /** 一句情境註：這組鍵「什麼時候有效」（人話，.ns-note 小字） */
  note: string;
}

export const SCENES: readonly Scene[] = [
  {
    scope: "global",
    title: "全域",
    note: "在哪一頁都能按，游標在輸入框裡也照樣有效。",
  },
  {
    scope: "today",
    title: "今日視圖",
    note: "今日頁選中一列車票、游標不在字裡的時候。",
  },
  {
    scope: "outline",
    title: "路線圖（大綱）",
    note: "路線圖裡選中一列、游標不在字裡的時候。",
  },
  {
    scope: "calendar",
    title: "日曆（格層）",
    note: "日曆的月格或週格裡，焦點停在某一天的時候。",
  },
  {
    scope: "daylist",
    title: "日曆・當日清單",
    note: "在日曆點開某一天的清單浮層之後。",
  },
  {
    scope: "common",
    title: "側板與覆蓋層通用",
    note: "詳情側板、設定、快速跳轉這類浮起來的卡片開著的時候。",
  },
  {
    scope: "edit",
    title: "編輯模式（輸入框內）",
    note: "按 Enter 或 F2 進了輸入框、游標在字裡的時候。",
  },
];

const SCENE_BY_SCOPE = new Map(SCENES.map((s) => [s.scope, s]));

export function sceneOf(scope: HotkeyScope): Scene {
  const s = SCENE_BY_SCOPE.get(scope);
  if (!s) throw new Error(`hotkeyRows: 未登錄的 scope「${scope}」`);
  return s;
}

/* ───────── 籤頂：導航／編輯雙模式說明（規格書 :45 鐵則翻成人話） ───────── */

/** 指引鍵的兩組鍵帽字（`?`／IME 備援），直接查 registry（Mac 顯 ⌘+/，Windows 顯 Ctrl+/），不手抄 */
const [GUIDE_KEY, GUIDE_FALLBACK] = hotkeyById("global.guide")!.chords.map((c) => formatChord(c).join("+"));

export const DUAL_MODE_NOTE: readonly string[] = [
  // 這三句只出現在設定籤；`?` 叫出的是「目前這一頁」的情境卡，不是這張七組全表——照實說
  `選中一列、游標不在字裡，就是導航模式：單鍵直接是動作，按 ${GUIDE_KEY} 叫出目前這一頁的快捷鍵卡。`,
  "按 Enter 或 F2 進了輸入框，就是編輯模式：所有鍵都是在打字，Enter 存、Esc 還原。",
  `輸入法正在組字的時候，每一顆鍵都先交給輸入法；這時想叫指引，改按 ${GUIDE_FALLBACK}。`,
];

/* ───────── 頁 → scope（`?` 情境卡用） ───────── */

export function pageScope(page: PageId): HotkeyScope {
  switch (page) {
    case "today":
      return "today";
    case "routemap":
      return "outline";
    case "calendar":
      return "calendar";
  }
}

/* ───────── 顯示列 ───────── */

export interface HotkeyRow {
  /** 單筆＝registry id；成對合併＝`<共同前綴>.<a>/<b>`（如 `today.move.up/down`） */
  id: string;
  /** 來源 registry id（單筆一個、成對兩個；probe 用來對帳） */
  ids: string[];
  label: string;
  /** 外層＝顯示槽（成對的兩筆照 registry 登錄順序），內層＝該槽的可替代鍵位（見檔頭） */
  chords: Chord[][];
  note?: string;
  /** 兩筆都接線才算接線（不接線的組只登錄給指引頁看；顯示端目前不區分，留給 probe） */
  wired: boolean;
}

/**
 * 成對規則：id 尾段成對、其餘前綴相同、同 scope，就合成一列。
 * 兩筆的先後＝registry 登錄順序（up 在 down 前、Tab 在 Shift+Tab 前），不硬套 a／b；
 * `add.sibling`／`add.ticket` 是兩個不同動作，刻意不在此列。
 */
const PAIR_SUFFIXES: ReadonlyArray<readonly [string, string]> = [
  ["up", "down"],
  ["prev", "next"],
  ["today", "tomorrow"],
  ["expand", "collapse"],
  ["indent", "outdent"],
];

/**
 * 合併後的列標題對照：鍵＝「a 的 label／b 的 label」。
 * 兩筆 label 的共同前綴多半不成句（「上移選取／下移選取」的共同前綴是空的），
 * 所以成對的列一律先查這張表；查不到才退回共同前綴（去掉尾巴的「上／下」「前／後」等），
 * 再不行就「a／b」原樣並排。表是文案，不是鍵位——鍵位永遠來自 registry。
 */
const PAIR_LABEL: Record<string, { label: string; note?: string }> = {
  "上移選取／下移選取": { label: "移動選取" },
  "今日手動序 上移／今日手動序 下移": { label: "今日手動排序" },
  "手動序 上移／手動序 下移": { label: "手動排序" },
  "排今天／排明天": { label: "排今天／明天" },
  "展開／摺疊": { label: "展開／摺疊" },
  "降層／升層": { label: "降層／升層" },
  "上一條路線／下一條路線": { label: "切換路線" },
  "前一天／後一天": { label: "前一天／後一天" },
  "上一週／下一週": { label: "上一週／下一週" },
  "上一頁（月視圖＝上個月，週視圖＝上一週）／下一頁（月視圖＝下個月，週視圖＝下一週）": {
    label: "換頁",
    note: "月視圖＝換月，週視圖＝換週",
  },
  "上個月／下個月": { label: "換月" },
  "上一年／下一年": { label: "換年" },
  "上一個焦點／下一個焦點": { label: "移動焦點" },
};

/** 共同前綴退路：去掉尾端的方向字與空白，剩下至少兩個字才算成句 */
const TAIL = /[\s上下前後左右一個]+$/u;

function commonPrefix(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return a.slice(0, i);
}

function pairLabel(a: Hotkey, b: Hotkey): { label: string; note?: string } {
  const hit = PAIR_LABEL[`${a.label}／${b.label}`] ?? PAIR_LABEL[`${b.label}／${a.label}`];
  if (hit) return hit;
  const prefix = commonPrefix(a.label, b.label).replace(TAIL, "");
  if (prefix.length >= 2) return { label: prefix };
  return { label: `${a.label}／${b.label}` };
}

function splitSuffix(id: string): { base: string; suffix: string } {
  const i = id.lastIndexOf(".");
  return i < 0 ? { base: "", suffix: id } : { base: id.slice(0, i), suffix: id.slice(i + 1) };
}

function single(h: Hotkey): HotkeyRow {
  return {
    id: h.id,
    ids: [h.id],
    label: h.label,
    chords: [h.chords],
    note: h.note,
    wired: h.wired,
  };
}

/** 某一組的顯示列（保序＝registry 登錄順序；成對的兩筆併在第一筆的位置） */
export function rowsFor(scope: HotkeyScope): HotkeyRow[] {
  const list = byScope(scope);
  const byId = new Map(list.map((h) => [h.id, h]));
  const used = new Set<string>();
  const rows: HotkeyRow[] = [];

  for (const h of list) {
    if (used.has(h.id)) continue;
    const { base, suffix } = splitSuffix(h.id);
    let partner: Hotkey | undefined;
    for (const [a, b] of PAIR_SUFFIXES) {
      const other = suffix === a ? b : suffix === b ? a : null;
      if (!other) continue;
      const cand = byId.get(`${base}.${other}`);
      if (cand && !used.has(cand.id)) {
        partner = cand;
        break;
      }
    }
    used.add(h.id);
    if (!partner) {
      rows.push(single(h));
      continue;
    }
    used.add(partner.id);
    const { label, note } = pairLabel(h, partner);
    rows.push({
      id: `${base}.${suffix}/${splitSuffix(partner.id).suffix}`,
      ids: [h.id, partner.id],
      label,
      chords: [h.chords, partner.chords],
      // 對照表的註優先；沒有就沿用兩筆共同的 note（如「句點」），不同就不硬湊
      note: note ?? (h.note === partner.note ? h.note : undefined),
      wired: h.wired && partner.wired,
    });
  }
  return rows;
}

/** 一列攤平成顯示順序的鍵位串（槽與替代都用「／」分隔，顯示端不必分辨） */
export function rowPaths(row: HotkeyRow): Chord[] {
  return row.chords.flat();
}
