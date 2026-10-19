/**
 * 捕捉小窗（階段⑤）的殼層介面：視窗 label／事件名／command 名的常數，與 Tauri 的薄包裝。
 * 契約 `docs/research/2026-10-16-旅客筆記-車次⑤捕捉小窗-契約.md` §4.6、規則 1-9。
 *
 * 零 store import（只有 `@tauri-apps/api` 與一支純函式）：`lib/db.ts` 會 import 這支來分流，
 * 不能把 UI 樹拉進 `lib/`。字串常數與 `src-tauri/src/capture.rs` 逐字相同（`notes-logic.test.ts` 對帳）。
 * 瀏覽器預覽（`?mock=1`，沒有 Tauri 橋接）時所有包裝都是安全的 no-op／假資料，不丟錯。
 */
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { captureWindowFromSearch } from "../../../domain/notes";

export const CAPTURE_WINDOW = "capture";
/** Rust → 小窗：小窗剛被叫出來（熱鍵或系統匣），該把焦點放回打字區 */
export const EV_CAPTURE_SHOW = "notes:capture-show";
/** 小窗 → 全域：小窗存了東西，主視窗該重讀（payload `{ at: number }`） */
export const EV_CAPTURED = "notes:captured";

export const CMD = {
  hide: "capture_hide",
  fit: "capture_fit",
  status: "capture_status",
  autostartGet: "autostart_get",
  autostartSet: "autostart_set",
} as const;

/** 快捷鍵登記檔的 id（`notes.manifest.ts`）；設定頁與票面的鍵帽一律 `capsOf(HOTKEY_ID)` */
export const HOTKEY_ID = "notes.capture.global";
/** `settings` 表的本機鍵：「預設開機自啟」只做一次的旗標（不進同步白名單） */
export const AUTOSTART_FLAG_KEY = "notes_autostart_default";

/** 受付章在小窗上播放的時間（D-筆-61：前景已還給原 App，存好後章繼續浮 ≈400ms 才 hide） */
export const CAPTURE_STAMP_MS = 400;

/**
 * `hideCapture` 的收法（對應 Rust `HideMode`）：
 * - `saved`：Enter 的當下（**存檔寫完之前**，不然 Enter 後馬上打的字會掉在小窗）。Rust 先把前景還給原 App、
 *   小窗改成不可聚焦＋點擊穿透，**不 hide**；存好後呼叫端播章（`CAPTURE_STAMP_MS`），播完再 `hideCapture("hide")`。
 *   這段期間小窗會收到 blur，**必須忽略**。
 * - `revive`：`saved` 之後存檔沒成功（寫入失敗、其實是空的、轉成預覽框）⇒ 把小窗叫回來（show＋聚焦，字不動）。
 * - `esc`：Esc 放棄。還前景再 hide。
 * - `hide`（預設）：失焦、章播完、Alt+F4 之後的收尾。只 hide。
 */
export type CaptureHideMode = "saved" | "esc" | "hide" | "revive";

export interface CaptureStatus {
  hotkeyRegistered: boolean;
  hotkeyError: string | null;
  accel: string;
}

export interface AutostartInfo {
  /** plugin 沒掛成功、或不是桌機／在瀏覽器預覽 ⇒ false，此時整列不畫 */
  available: boolean;
  enabled: boolean;
  /** 登錄檔值名＝identifier */
  name: string;
  /** 這支 exe 是 debug 建置（Rust `cfg!(debug_assertions)`）。「預設開」不對 debug exe 做；手動開關不看這個 */
  debugBuild: boolean;
}

/** 有 Tauri 橋接嗎（瀏覽器預覽 `?mock=1` 沒有） */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** 目前視窗的 label；沒有橋接（瀏覽器）或讀不到 ⇒ null。不走 IPC（讀 `__TAURI_INTERNALS__` 的 metadata）。 */
function currentLabelSafe(): string | null {
  try {
    return getCurrentWindow().label;
  } catch {
    return null;
  }
}

/** 這個 JS context 是捕捉小窗嗎：網址帶 `?window=capture`（瀏覽器預覽用），或視窗 label 是 `capture`（正式路徑）。 */
export function isCaptureWindow(): boolean {
  const search = typeof location !== "undefined" ? location.search : "";
  return captureWindowFromSearch(search) || currentLabelSafe() === CAPTURE_WINDOW;
}

export async function hideCapture(mode?: CaptureHideMode): Promise<void> {
  if (!isTauri()) return;
  await invoke<void>(CMD.hide, mode ? { mode } : {});
}

/** 小窗跟著內容長高：`height` 是票（或預覽框）的邏輯像素高度，Rust 端加紙邊並夾範圍 */
export async function fitCapture(height: number): Promise<void> {
  if (!isTauri()) return;
  await invoke<void>(CMD.fit, { height });
}

export async function captureStatus(): Promise<CaptureStatus> {
  // 瀏覽器預覽：假裝註冊成功，免得每次開預覽都跳「全域鍵沒有啟用」
  // `accel` 留空：鍵帽一律由 `capsOf(HOTKEY_ID)` 出，這裡不抄 Rust `HOTKEY_ACCEL` 的第二份
  if (!isTauri()) return { hotkeyRegistered: true, hotkeyError: null, accel: "" };
  return invoke<CaptureStatus>(CMD.status);
}

const NO_AUTOSTART: AutostartInfo = { available: false, enabled: false, name: "", debugBuild: false };

export async function autostartGet(): Promise<AutostartInfo> {
  if (!isTauri()) return NO_AUTOSTART;
  return invoke<AutostartInfo>(CMD.autostartGet);
}

export async function autostartSet(enabled: boolean): Promise<AutostartInfo> {
  if (!isTauri()) return NO_AUTOSTART;
  return invoke<AutostartInfo>(CMD.autostartSet, { enabled });
}

/** 小窗被 Rust 叫出來時呼叫 `cb`；回傳取消監聽。沒有橋接 ⇒ 永不觸發。 */
export async function onCaptureShow(cb: () => void): Promise<() => void> {
  if (!isTauri()) return () => {};
  return listen(EV_CAPTURE_SHOW, () => cb());
}

/** 小窗存了東西，通知主視窗（及任何聽的人）重讀。沒有橋接 ⇒ no-op。 */
export async function emitCaptured(): Promise<void> {
  if (!isTauri()) return;
  await emit(EV_CAPTURED, { at: Date.now() });
}
