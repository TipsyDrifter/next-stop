/**
 * hotkeyRebind——自訂快捷鍵的純邏輯（⑧；D-主-331～；純函式、不碰 DOM，`scripts/tests/hotkey-rebind.test.ts` 直接跑）。
 *
 * 四件事：哪些鍵能改（`isRebindable`）、按下去算哪一組（`chordFromEvent`）、這組鍵能不能用（`chordProblem`）、
 * 跟誰撞鍵（`conflictsOf`）；另外管設定表那一格 JSON 的進出（`parseOverrides`／`serializeOverrides`）。
 * 存檔與 Rust 全域鍵在 `hotkeyOverrides.ts`，畫面在 `settings/HotkeysTab.tsx`。
 */
import type { Chord, Hotkey, HotkeyScope, KeyLike } from "./hotkeys.ts";
import { HOTKEYS, formatChord, hotkeyById, isSymbolKey } from "./hotkeys.ts";

/** 設定表的 key；裝置本地（不進 SYNC_SETTINGS_KEYS），照 D-1.1-3「螢幕偏好不同步」 */
export const OVERRIDES_KEY = "hotkey_overrides";

/** Windows 全域鍵（Rust 註冊、到不了 webview）；跟旅客筆記 `capture-window/shell.ts` 的 HOTKEY_ID 同一筆，測試對帳 */
export const OS_HOTKEY_ID = "notes.capture.global";

/**
 * 不開放改的組：輸入框、對話框裡的 Enter／Esc／Tab／↑↓ 是輸入慣例，散在幾十個輸入元件裡、也不該因人而異。
 * 完整搜尋的鍵游標在搜尋框裡也要能按（同 combobox 慣例），一樣歸這類。
 */
const CONVENTION_SCOPES: ReadonlySet<HotkeyScope> = new Set<HotkeyScope>([
  "common",
  "edit",
  "search",
  "notes-capture",
  "ticket-entry",
]);

/**
 * `wired:false` 但真的查 registry 的那幾筆（daylist 由當日清單與串流查表；全域鍵走 Rust）。
 * 日記存檔雖然也查表，但它在輸入框裡作用（綁單鍵就打不出那個字），算輸入慣例，不開放。
 */
function queriesRegistry(hk: Hotkey): boolean {
  return hk.wired || hk.scope === "daylist" || hk.id === OS_HOTKEY_ID;
}

/** Esc 全 App 都是「退一步」，對話框、側板各自攔它，一處改了處處對不上 */
function isEscape(hk: Hotkey): boolean {
  return hk.chords.some((c) => c.key === "Escape");
}

export function isRebindable(hk: Hotkey): boolean {
  return !CONVENTION_SCOPES.has(hk.scope) && !isEscape(hk) && queriesRegistry(hk);
}

/* ───────── 按下去算哪一組 ───────── */

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "AltGraph", "OS", "CapsLock", "NumLock", "ScrollLock", "Fn"]);

export interface RecordEvent extends KeyLike {
  code?: string;
  keyCode?: number;
}

/**
 * keydown → Chord；只按修飾鍵、或看不出是哪顆鍵時回 null（繼續等）。
 * 中文輸入法開著時 `key` 是 "Process"：字母和數字從實體鍵位 `code` 認（使用者不用為了改鍵先切輸入法）。
 * Win 鍵歸作業系統；Mac 的 ⌘ 照 registry 當 Ctrl。
 */
export function chordFromEvent(e: RecordEvent, isMac = false): Chord | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  if (e.metaKey && !isMac) return null;
  let key = e.key;
  if (key === "Process" || key === "Unidentified" || key === "Dead") {
    const m = /^(?:Key|Digit)([A-Z0-9])$/.exec(e.code ?? "");
    if (!m) return null;
    key = m[1];
  }
  if (key.length === 1) key = key.toLowerCase();
  const chord: Chord = { key };
  if (e.ctrlKey || e.metaKey) chord.ctrl = true;
  if (e.altKey) chord.alt = true;
  // 符號鍵的 Shift 已經算進字形（Shift+/ 就是 ?），不另外記
  if (e.shiftKey && !isSymbolKey(key)) chord.shift = true;
  return chord;
}

export function sameChord(a: Chord, b: Chord): boolean {
  return (
    a.key.toLowerCase() === b.key.toLowerCase() &&
    !!a.ctrl === !!b.ctrl &&
    !!a.alt === !!b.alt &&
    (isSymbolKey(a.key) || !!a.shift === !!b.shift)
  );
}

export function chordText(chord: Chord, isMac?: boolean): string {
  return formatChord(chord, isMac).join("+");
}

/* ───────── 這組鍵能不能用 ───────── */

const FUNCTION_KEY = /^F([1-9]|1[0-9]|2[0-4])$/;
/** 背景鍵由作業系統註冊，主鍵認實體鍵位：字母、數字、F 鍵、空白最穩；符號鍵會隨 Shift 與鍵盤配置變字 */
const OS_MAIN_KEY = /^[a-z0-9 ]$/;
/** 打字時要用的系統鍵：全域鍵連輸入框裡都吃，綁上去等於不能複製貼上 */
const TEXT_EDIT_KEYS = new Set(["a", "c", "v", "x", "y", "z"]);

/** 回一句給人看的理由；可以用就回 null */
export function chordProblem(hk: Hotkey, index: number, chord: Chord): string | null {
  const hasMod = !!chord.ctrl || !!chord.alt;
  if (chord.key === "F4" && chord.alt) return "Alt+F4 是關閉視窗，換一組吧。";
  if (hk.id === OS_HOTKEY_ID) {
    if (!OS_MAIN_KEY.test(chord.key) && !FUNCTION_KEY.test(chord.key)) return "這組鍵要用字母、數字或 F 鍵。";
    const mods = Number(!!chord.ctrl) + Number(!!chord.alt) + Number(!!chord.shift);
    if (!hasMod || mods < 2) return "這組鍵在任何軟體裡都會作用，要同時按兩個修飾鍵（例如 Ctrl+Alt）。";
    return null;
  }
  if (hk.scope === "global") {
    // `?` 那一條只在沒打字時作用（useGlobalHotkeys 擋掉輸入框），可以是單鍵
    const navOnly = hk.id === "global.guide" && index === 0;
    if (!navOnly && !hasMod && !FUNCTION_KEY.test(chord.key)) {
      return "全域鍵打字時也會作用，要帶 Ctrl 或 Alt。";
    }
    if (chord.ctrl && !chord.alt && !chord.shift && TEXT_EDIT_KEYS.has(chord.key)) {
      return `${chordText(chord)} 打字時要用，換一組吧。`;
    }
  }
  return null;
}

/* ───────── 撞鍵 ───────── */

/**
 * 同一組鍵在「同一個情境」或「全域 vs 任何情境」都算撞：全域鍵在哪一頁都會作用。
 * 不同頁面之間不算（路線圖的 T 跟今日的 T 本來就各做各的）。
 * 例外：串流同時查 daylist 和「回今天」（calendar.today），這兩邊撞到也算。
 * 回的是覆寫後的 Hotkey（自己以外）。
 */
function sameContext(a: Hotkey, b: Hotkey): boolean {
  if (a.scope === b.scope || a.scope === "global" || b.scope === "global") return true;
  return (a.id === "calendar.today" && b.scope === "daylist") || (b.id === "calendar.today" && a.scope === "daylist");
}

export function conflictsOf(id: string, index: number): Hotkey[] {
  const hk = hotkeyById(id);
  const chord = hk?.chords[index];
  if (!hk || !chord) return [];
  const others: Hotkey[] = [];
  for (const raw of HOTKEYS) {
    if (raw.id === id) continue;
    if (!sameContext(raw, hk)) continue;
    const other = hotkeyById(raw.id)!;
    if (other.chords.some((c) => sameChord(c, chord))) others.push(other);
  }
  return others;
}

/** 目前所有撞鍵的列 id（籤頂的總數、各列的赭字都從這裡來） */
export function allConflictIds(): string[] {
  return HOTKEYS.filter((raw) => {
    const hk = hotkeyById(raw.id)!;
    return hk.chords.some((_, i) => conflictsOf(raw.id, i).length > 0);
  }).map((h) => h.id);
}

/* ───────── 設定表那一格 ───────── */

function validChord(v: unknown): v is Chord {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Record<string, unknown>;
  if (typeof c.key !== "string" || c.key.length === 0) return false;
  return (["ctrl", "shift", "alt"] as const).every((m) => c[m] === undefined || typeof c[m] === "boolean");
}

/**
 * 讀回來的東西不一定可信（版本換過、鍵被拿掉、手改過）：認不得的 id、不開放改的鍵、組數對不上一律丟掉，
 * 那一筆就回到預設，App 照樣開得起來。
 */
export function parseOverrides(raw: string | null): Map<string, Chord[]> {
  const out = new Map<string, Chord[]>();
  if (!raw) return out;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return out;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return out;
  const defaults = new Map(HOTKEYS.map((h) => [h.id, h]));
  for (const [id, chords] of Object.entries(data)) {
    const hk = defaults.get(id);
    if (!hk || !isRebindable(hk)) continue;
    if (!Array.isArray(chords) || chords.length !== hk.chords.length || !chords.every(validChord)) continue;
    out.set(id, chords as Chord[]);
  }
  return out;
}

export function serializeOverrides(map: ReadonlyMap<string, Chord[]>): string {
  return JSON.stringify(Object.fromEntries(map));
}

/** 把一組鍵換進某筆覆寫；換完跟預設一模一樣就不留這一筆（這樣「改過沒」永遠準） */
export function withChord(
  map: ReadonlyMap<string, Chord[]>,
  defaults: Hotkey,
  index: number,
  chord: Chord,
): Map<string, Chord[]> {
  const next = new Map(map);
  const chords = [...(map.get(defaults.id) ?? defaults.chords)];
  chords[index] = chord;
  if (chords.every((c, i) => sameChord(c, defaults.chords[i]))) next.delete(defaults.id);
  else next.set(defaults.id, chords);
  return next;
}

/** Rust `capture_set_hotkey` 吃的字串（global-hotkey 的 `Ctrl+Alt+N` 格式）；空白鍵要寫 Space */
export function chordToAccel(chord: Chord): string {
  const parts: string[] = [];
  if (chord.ctrl) parts.push("Ctrl");
  if (chord.alt) parts.push("Alt");
  if (chord.shift) parts.push("Shift");
  const k = chord.key;
  parts.push(k === " " ? "Space" : k.length === 1 ? k.toUpperCase() : k);
  return parts.join("+");
}
