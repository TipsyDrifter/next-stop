/**
 * hotkeyOverrides——自訂快捷鍵的存檔與套用（⑧；D-主-331～）。
 *
 * 覆寫存在設定表一格 JSON（`OVERRIDES_KEY`，裝置本地、不同步，照 D-1.1-3「螢幕偏好不同步」）；
 * runtime 那張表在 `hotkeys.ts`（`setHotkeyOverrides`），查表與顯示都讀它。
 * 背景也能用的那組鍵（`OS_HOTKEY_ID`）由 Rust 註冊，所以另外要叫 `capture_set_hotkey`：別的程式佔著就退回原本的鍵、回一句理由。
 * 手機不走這裡（`useGlobalHotkeys(false)`）：手機沒有鍵盤，也就沒有覆寫。
 */
import { settingsRepo } from "../../data";
import { useUiStore } from "../../store/uiStore";
import { captureSetHotkey } from "../notes/capture-window/shell";
import { defaultHotkeyById, hotkeyOverrides, setHotkeyOverrides, type Chord } from "./hotkeys";
import {
  OS_HOTKEY_ID,
  OVERRIDES_KEY,
  chordText,
  chordToAccel,
  parseOverrides,
  serializeOverrides,
  withChord,
} from "./hotkeyRebind";

let loaded: Promise<void> | null = null;

/** 叫 Rust 換鍵；拿到了回 null，沒拿到（別的程式佔著、格式不認得）回原因 */
async function applyOsHotkey(map: ReadonlyMap<string, Chord[]>): Promise<string | null> {
  const chord = map.get(OS_HOTKEY_ID)?.[0];
  try {
    const status = await captureSetHotkey(chord ? chordToAccel(chord) : null);
    return status.hotkeyRegistered ? null : (status.hotkeyError ?? "註冊失敗");
  } catch (e) {
    return e instanceof Error ? e.message : String(e ?? "註冊失敗");
  }
}

/**
 * 還原、復原走這條：鍵照換（使用者要的就是這組），只是拿不到要講。
 * Rust 那邊會記著這組繼續重試，佔鍵的程式一關就拿回來；〈一般〉也會提醒。
 */
async function applyOsHotkeyLoudly(map: ReadonlyMap<string, Chord[]>): Promise<string | null> {
  const failed = await applyOsHotkey(map);
  if (!failed) return null;
  console.warn("[hotkeys] 全域鍵註冊失敗", failed);
  const chord = map.get(OS_HOTKEY_ID)?.[0] ?? defaultHotkeyById(OS_HOTKEY_ID)?.chords[0];
  return `${chord ? chordText(chord) : "這組鍵"} 被別的程式佔走了，關掉它或換一組`;
}

/**
 * 開 App 讀一次（重複呼叫共用同一趟）。Rust 開機先註冊預設的全域鍵，這裡讀到覆寫才換；
 * 開機檢查「全域鍵有沒有拿到」要排在這之後（useCaptureShellBridge），不然預設鍵被別人佔走時會誤報。
 */
export function loadHotkeyOverrides(): Promise<void> {
  loaded ??= (async () => {
    try {
      const map = parseOverrides(await settingsRepo.get(OVERRIDES_KEY));
      setHotkeyOverrides(map);
      if (map.has(OS_HOTKEY_ID)) await applyOsHotkey(map);
    } catch (e) {
      console.warn("[hotkeys] 讀自訂快捷鍵失敗，先用預設", e);
    }
  })();
  return loaded;
}

async function commit(next: Map<string, Chord[]>): Promise<void> {
  setHotkeyOverrides(next);
  try {
    await settingsRepo.set(OVERRIDES_KEY, serializeOverrides(next));
  } catch (e) {
    // 這次開著都算數，只是下次開 App 會回到上一份；照實說
    console.warn("[hotkeys] 存自訂快捷鍵失敗", e);
    useUiStore.getState().showToast({ message: "快捷鍵沒存起來，下次開 App 會回到原本的鍵" });
  }
}

/** 換一組鍵。回 null＝成功；回字串＝沒換成（全域鍵被別的程式佔走），鍵維持原樣 */
export async function rebindHotkey(id: string, index: number, chord: Chord): Promise<string | null> {
  const defaults = defaultHotkeyById(id);
  if (!defaults) return null;
  const prev = hotkeyOverrides();
  const next = withChord(prev, defaults, index, chord);
  if (id === OS_HOTKEY_ID) {
    const failed = await applyOsHotkey(next);
    if (failed) {
      await applyOsHotkey(prev);
      console.warn("[hotkeys] 全域鍵註冊失敗", failed);
      return "這組鍵被別的程式佔走了，換一組吧。";
    }
  }
  await commit(next);
  return null;
}

/** 單列還原（成對的列一次還原兩筆） */
export async function resetHotkeys(ids: readonly string[]): Promise<void> {
  const next = new Map(hotkeyOverrides());
  for (const id of ids) next.delete(id);
  await commit(next);
  if (!ids.includes(OS_HOTKEY_ID)) return;
  const warning = await applyOsHotkeyLoudly(next);
  if (warning) useUiStore.getState().showToast({ message: warning });
}

/** 全部還原；回傳還原前的那一份（toast 的「復原」用）與全域鍵沒拿到時要多講的一句（同一則 toast，分開跳會互蓋） */
export async function resetAllHotkeys(): Promise<{ before: Map<string, Chord[]>; warning: string | null }> {
  const before = new Map(hotkeyOverrides());
  await commit(new Map());
  const warning = before.has(OS_HOTKEY_ID) ? await applyOsHotkeyLoudly(new Map()) : null;
  return { before, warning };
}

export async function restoreHotkeys(map: Map<string, Chord[]>): Promise<void> {
  // 中間又改過全域鍵時，現況有覆寫而復原那份沒有，也要換回去
  const osTouched = map.has(OS_HOTKEY_ID) || hotkeyOverrides().has(OS_HOTKEY_ID);
  await commit(map);
  if (!osTouched) return;
  const warning = await applyOsHotkeyLoudly(map);
  if (warning) useUiStore.getState().showToast({ message: warning });
}
