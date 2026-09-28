/**
 * notify——OS 通知的唯一出口（v1.1.5；契約席立骨架、WP-B 接外掛）。
 *
 * 拍板依據：決策記錄〈v1.1.5 Plan 拍板〉技術自決「橫幅主力、OS 通知只用 `notify()` 一支失敗靜默；
 *   Android 通知權限在加入成功後問一次」＋《2026-09-25-v1.1.5-同步告警與復原碼契約.md》§3。
 *
 * 為什麼通知只是加分（查證：`…-盲探-Sonnet補查①通知外掛.md`）：桌機點通知**不會回到 App**（外掛沒有 onclick）、
 *   dev build 顯示成 PowerShell 的名稱、Android 外掛一票 open issue。所以：
 *   ① 橫幅（`uiStore.syncBanner`）不依賴這裡的成敗；② 只用 `plugin:notification|notify` 一支（不用 schedule／cancel／pending）；
 *   ③ 任何失敗吞掉、`console.warn` 一行；④ `?mock=1` 下**不碰外掛**，只記進 `notifyLog`（＝`window.__notifLog`）。
 *
 * 為什麼權限查詢、詢問、送出都直接 `invoke("plugin:notification|…")`，不用外掛的 `isPermissionGranted()`／`sendNotification()`
 *   （讀外掛 2.3.3 原始碼查到的兩個坑）：
 *   ① **Windows 上 `isPermissionGranted()` 恆 false**：init 腳本在 `__TEMPLATE_windows__=true` 時不打 IPC、直接拿
 *      `window.Notification.permission === 'granted'`（初值 'default'）⇒ 把 permission 設成 'denied'；之後 JS API 一律讀這個快取。
 *      只有同一進程叫過 `requestPermission()` 才會翻成 granted——而我們一台只問一次（加入後），重開 App 就永遠 false、永遠不送。
 *      直接叫 command 走的是 Rust `permission_state()`：桌機恆 Granted、Android 照實回。
 *   ② `sendNotification()` 是 `new window.Notification(...)`——回傳 void、裡面的 invoke 失敗變成 unhandled rejection，
 *      我們接不住也不知道外掛收下沒。直接叫同一支 command（payload 形狀與 init 腳本逐字相同：`{ options: { title, body, channelId? } }`）
 *      就能 await、失敗吞掉、`sent` 照實記。
 *   外掛的 npm 套件只拿來建 Android 頻道（`createChannel`＋`Importance` 型別）；三支 command 都在 capabilities 白名單內。
 *
 * 權限（契約 §3.4）：這裡**不問**權限——查到不是 granted 就記一行、不送（橫幅照出）。
 *   問的時機（`syncStore.askNotificationIfNeeded`，`status.notif_asked` 沒設才叫 `askNotificationPermissionOnce()`）：
 *   加入同步成功後；以及開機時「已加入但從沒問過」（v1.1.5 修正席／產品評審 B1：v1.1.4 原地升級的裝置）。
 *   問到答案（granted／denied）才寫 `sync_meta.notif_asked='1'`（拒絕就只用橫幅、不再問）；外掛叫不動（skipped）不記、下次啟動再問。
 *   桌機 `requestPermission` 恆 granted。
 *
 * 對帳用（整合席沙盒 甲1–甲7）：不論 mock 或真機，每次「打算送」都 push 一筆到 `notifyLog`＋`console.info("[sync:notify] …")`；
 *   同一個陣列也掛在 `window.__notifLog`（第一次 push 才掛——沒告警的桌機連這個全域都不會出現）。
 *   CDP 進頁面讀 `window.__notifLog` 或 `(await import('/src/lib/notify.ts')).notifyLog` 都行。
 */
import { invoke } from "@tauri-apps/api/core";
import { MOCK_MODE } from "../data";

export interface NotifyPayload {
  title: string;
  body: string;
}

/** 哪一殼：Android 要帶頻道、桌機不用（由 syncStore 傳它模組層的 `shell`） */
export type NotifyShell = "desktop" | "mobile";

/** Android 通知頻道（只有一個；契約 §3.5）。桌機不用。 */
export const NOTIFY_CHANNEL = { id: "sync-alerts", name: "同步狀態" } as const;

export interface NotifyLogEntry {
  key: string;
  payload: NotifyPayload;
  /** 外掛真的收下了沒（mock／沒權限／失敗一律 false） */
  sent: boolean;
  at: string;
}

/**
 * 這個進程「打算送出」的通知流水（對帳用；不含任何票名——文案本來就不含）。
 * `key`＝告警種類或一次性事件名（`SyncAlertKind`／`SyncEventKind`）。
 */
export const notifyLog: NotifyLogEntry[] = [];

declare global {
  interface Window {
    /** v1.1.5 沙盒對帳用：與 `notifyLog` 同一個陣列（第一次打算送才掛上） */
    __notifLog?: NotifyLogEntry[];
  }
}

/**
 * 已送過、而且狀態還沒解除的告警 key（「同一狀態不重發」的第二道；第一道是 syncStore 的轉變偵測）。
 * 狀態解除時 syncStore 叫 `rearmNotify(key)` 把它拿掉——下一次再**轉入**同一種告警是新的一次，該再響（拍板「轉入時一則」）。
 */
const sentKeys = new Set<string>();

/** Android 頻道只建一次（冪等，但每次送都建一次是白打 IPC）；失敗＝false，改成不帶 channelId 送。動態 import：只有手機真的要送時才載入 */
let channelReady: Promise<boolean> | null = null;

function logEntry(entry: NotifyLogEntry): void {
  notifyLog.push(entry);
  if (typeof window !== "undefined" && !window.__notifLog) window.__notifLog = notifyLog;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function ensureChannel(): Promise<boolean> {
  if (!channelReady) {
    channelReady = (async () => {
      try {
        const { createChannel, Importance } = await import("@tauri-apps/plugin-notification");
        await createChannel({ id: NOTIFY_CHANNEL.id, name: NOTIFY_CHANNEL.name, importance: Importance.Default });
        return true;
      } catch (e) {
        console.warn("[sync:notify] 建通知頻道失敗，改用預設頻道：", errText(e));
        return false;
      }
    })();
  }
  return channelReady;
}

/**
 * 送一則通知；同一 `key` 在「狀態解除前」只送一次。**永遠 resolve**（失敗吞掉）；回傳「外掛收下了沒」。
 * `force=true`＝一次性事件（換鑰匙完成／還原完成／改用完成）——同一個事件可能發生第二次，不受 sentKeys 去重。
 */
export async function notifyOnce(
  key: string,
  payload: NotifyPayload,
  force = false,
  shell: NotifyShell = "desktop",
): Promise<boolean> {
  if (!force) {
    if (sentKeys.has(key)) return false;
    sentKeys.add(key);
  }
  const entry: NotifyLogEntry = { key, payload, sent: false, at: new Date().toISOString() };
  logEntry(entry);
  if (MOCK_MODE || typeof window === "undefined") {
    console.info(`[sync:notify] ${key} (mock，不呼叫外掛)`);
    return false;
  }
  try {
    // 直接問 Rust（見檔頭①）：`Some(true)`＝granted、`Some(false)`＝denied、`None`（null）＝還沒問過（Android）
    if ((await invoke<boolean | null>("plugin:notification|is_permission_granted")) !== true) {
      console.info(`[sync:notify] ${key} 沒有通知權限，只出橫幅`);
      return false;
    }
    const withChannel = shell === "mobile" && (await ensureChannel());
    const options = withChannel
      ? { title: payload.title, body: payload.body, channelId: NOTIFY_CHANNEL.id }
      : { title: payload.title, body: payload.body };
    await invoke("plugin:notification|notify", { options });
    entry.sent = true;
    console.info(`[sync:notify] ${key} sent`);
    return true;
  } catch (e) {
    console.warn(`[sync:notify] ${key} 送不出去：`, errText(e));
    return false;
  }
}

/** 告警解除：同一個 key 下次再轉入時可以再送一則（syncStore 的轉變偵測叫） */
export function rearmNotify(key: string): void {
  sentKeys.delete(key);
}

/** 重設去重與流水（測試／沙盒用；主人重開 App 本來就會清） */
export function resetNotifyOnce(): void {
  sentKeys.clear();
  notifyLog.length = 0;
}

/**
 * 通知權限「問一次」（契約 §3.4）：`syncStore.askNotificationIfNeeded` 叫（加入成功後／開機時已加入但沒問過），
 * `status.notif_asked` 為 true 就不會叫到這裡；呼叫端拿到 granted／denied 才 `syncRepo.markNotifAsked()`（拒絕就只用橫幅、不再問），
 * 回 `skipped`（外掛一時叫不動）不記，下次再問。
 * 桌機 `request_permission` 恆 Granted（外掛 desktop.rs 實證），所以桌機這裡等於只是確認一下、不會跳任何東西。
 * Android 13+ 跳系統詢問；12 以下權限預設就有。永遠 resolve；mock 下不碰外掛。
 */
export async function askNotificationPermissionOnce(): Promise<"granted" | "denied" | "skipped"> {
  if (MOCK_MODE || typeof window === "undefined") return "skipped";
  try {
    // 直接叫 command（見檔頭①）；`request_permission` 回 PermissionState：granted／denied／prompt／prompt-with-rationale
    if ((await invoke<boolean | null>("plugin:notification|is_permission_granted")) === true) return "granted";
    const answer = (await invoke<string>("plugin:notification|request_permission")) === "granted" ? "granted" : "denied";
    console.info(`[sync:notify] 通知權限：${answer}`);
    return answer;
  } catch (e) {
    console.warn("[sync:notify] 問通知權限失敗：", errText(e));
    return "skipped";
  }
}
