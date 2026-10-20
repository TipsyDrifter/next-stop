/**
 * useCaptureShellBridge——主視窗這一側的接線（契約 §4.4；只在 `main` 跑，由 `NotesDesktopOverlay` 呼叫）。
 *
 * 1. 小窗存了東西（`notes:captured`）⇒ 旅客筆記重讀（notes／nodes／tags／taggings）＋ `nodeStore.refresh()`（待辦票根建了車票）
 *    ＋ 丟一顆 `SYNC_WRITE_EVENT`（小窗那個 JS context 丟的事件主視窗聽不到，同步引擎在主視窗）。
 * 2. 主視窗 `focus`／`visibilitychange→visible` ⇒ 同樣重讀（1 秒內只做一次）：藏著的 WebView2 會不會延後處理事件未驗證（查證 Q3），
 *    叫出來那一刻再對一次。這條**不**丟 `SYNC_WRITE_EVENT`——syncStore 自己在 focus／visible 就會跑一趟（syncStore.ts 的 attachSchedule），再丟只是重複。
 * 3. 啟動問一次 `capture_status()`：全域鍵沒註冊成功 ⇒ toast＋OS 通知（主視窗可能藏著，toast 沒人看；`notifyOnce` 一次啟動只發一次）。
 *    結果留在模組變數給設定〈一般〉的 `AutostartRow` 先畫（它掛上時會再問一次）。
 * 4. 「預設開機自啟」一次（`autostartBoot.ts`）。
 *
 * 瀏覽器預覽（沒有 Tauri）與小窗自己：整支不做事。
 */
import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { SYNC_WRITE_EVENT } from "../../../data";
import { notifyOnce } from "../../../lib/notify";
import { useNodeStore } from "../../../store/nodeStore";
import { useNotesStore } from "../../../store/notesStore";
import { useUiStore } from "../../../store/uiStore";
import { capsOf } from "../notesBits";
import { bootAutostartDefault } from "./autostartBoot";
import { EV_CAPTURED, HOTKEY_ID, captureStatus, isCaptureWindow, isTauri, type CaptureStatus } from "./shell";

/** 最近一次問到的熱鍵狀態（null＝還沒問過）；`AutostartRow` 先用它畫、再自己問一次 */
let lastStatus: CaptureStatus | null = null;
export function lastCaptureStatus(): CaptureStatus | null {
  return lastStatus;
}
export function rememberCaptureStatus(s: CaptureStatus): void {
  lastStatus = s;
}

/** 契約 §5.7-3（toast 與 OS 通知同句） */
export function hotkeyFailedText(): string {
  return `快捷鍵 ${capsOf(HOTKEY_ID)} 被別的程式佔走了，請看設定〈一般〉`;
}

/** 啟動時的熱鍵檢查：一次啟動只做一次（StrictMode 雙掛載不重複 toast） */
let statusChecked = false;
async function checkHotkeyOnce(): Promise<void> {
  if (statusChecked) return;
  statusChecked = true;
  let s: CaptureStatus;
  try {
    s = await captureStatus();
  } catch (e) {
    console.warn("[capture] capture_status 失敗", e);
    return;
  }
  lastStatus = s;
  if (s.hotkeyRegistered) return;
  const text = hotkeyFailedText();
  useUiStore.getState().showToast({ message: text });
  void notifyOnce("notes.hotkey-failed", { title: "私鐵手帳", body: text });
}

/** 小窗寫進 DB 的東西會動到的表（`LineReloadContext.changed`；notesStore.reload 依此決定重載哪些） */
const CAPTURE_CHANGED = ["notes", "nodes", "tags", "taggings"];

async function reloadAfterCapture(): Promise<void> {
  try {
    await Promise.all([
      useNotesStore.getState().reload({ changed: CAPTURE_CHANGED, wiped: false, shell: "desktop" }),
      useNodeStore.getState().refresh(),
    ]);
  } catch (e) {
    console.warn("[capture] 小窗存檔後重讀失敗", e);
  }
}

export function useCaptureShellBridge(): void {
  useEffect(() => {
    if (!isTauri() || isCaptureWindow()) return;
    let alive = true;
    let unlisten: (() => void) | null = null;

    void listen(EV_CAPTURED, () => {
      void reloadAfterCapture();
      window.dispatchEvent(new CustomEvent(SYNC_WRITE_EVENT));
    }).then((un) => {
      if (alive) unlisten = un;
      else un();
    });

    // 顯示時重讀：1 秒內只做一次（focus 與 visibilitychange 常一起來）
    let last = 0;
    const onShown = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - last < 1000) return;
      last = now;
      void reloadAfterCapture();
    };
    window.addEventListener("focus", onShown);
    document.addEventListener("visibilitychange", onShown);

    void checkHotkeyOnce();
    void bootAutostartDefault();

    return () => {
      alive = false;
      unlisten?.();
      window.removeEventListener("focus", onShown);
      document.removeEventListener("visibilitychange", onShown);
    };
  }, []);
}
