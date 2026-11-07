/**
 * reminderBridge——提醒對原生層的橋（⑨ 契約 §4、§5）。平台分流看真實平台（`onAndroid()`），不看排版。
 *
 * - Android：本地 plugin `tt-notice` 的 `rem_sync`／`rem_take_launch`＋事件 `reminder-open`。排程與貼通知都在 Kotlin（App 沒開也響）。
 * - 桌機：`reminder_toast`（Rust 自己組 toast：點了由系統開 `nextstop://reminder`，走 ⑬ 收連結；`ns-reminder-open` 留著當後備）。
 *   送失敗退回 `notifyOnce`：點不回來，但至少看得到。
 * - `?mock=1`：不碰原生，記進 `window.__reminderMock`（對帳與沙盒用；`open(target)` 模擬點通知）。
 */
import { addPluginListener, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { MOCK_MODE } from "../../data";
import { parseTarget, type ReminderItem, type ReminderKind, type ReminderRecent, type ReminderTarget } from "../../domain/reminders";
import { notifyOnce } from "../../lib/notify";
import { onAndroid } from "../timetable/ttNoticeBridge";

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function live(): boolean {
  return !MOCK_MODE && typeof window !== "undefined";
}

/** 這個平台是原生層自己排（true）還是 JS tick（false） */
export function nativeSchedules(): boolean {
  return live() && onAndroid();
}

/* ───────── mock ───────── */

interface ReminderMock {
  /** 最後一次算出來的清單 */
  items: ReminderItem[];
  /** 打算送出的流水 */
  sent: ReminderItem[];
  /** 模擬點通知 */
  open(target: ReminderTarget): void;
}

const openListeners = new Set<(t: ReminderTarget) => void>();

const mock: ReminderMock = {
  items: [],
  sent: [],
  open(target) {
    for (const cb of Array.from(openListeners)) cb(target);
  },
};

if (typeof window !== "undefined" && MOCK_MODE) {
  (window as unknown as { __reminderMock?: ReminderMock }).__reminderMock = mock;
}

/** 算好的清單交出去：mock 只記下來讓沙盒對帳 */
export function noteMockItems(items: ReminderItem[]): void {
  if (MOCK_MODE) mock.items = items;
}

/* ───────── Android ───────── */

/** Kotlin 帶回來的 fired 正規化（JSON 型別不可信；形狀不對的丟掉） */
export function normFired(raw: unknown): { recent: ReminderRecent; memberKeys: string[] }[] {
  const list: unknown = typeof raw === "string" ? safeJson(raw) : raw;
  if (!Array.isArray(list)) return [];
  const out: { recent: ReminderRecent; memberKeys: string[] }[] = [];
  for (const x of list) {
    if (x === null || typeof x !== "object") continue;
    const o = x as Record<string, unknown>;
    const members = typeof o.memberKeys === "string" ? safeJson(o.memberKeys) : o.memberKeys;
    if (!Array.isArray(members)) continue;
    const memberKeys = members.filter((k): k is string => typeof k === "string");
    const target = parseTarget(typeof o.target === "string" ? o.target : null);
    if (target === null || typeof o.title !== "string") continue;
    out.push({
      memberKeys,
      recent: {
        at: typeof o.at === "number" ? o.at : Date.now(),
        kind: o.kind as ReminderKind,
        title: o.title,
        body: typeof o.body === "string" ? o.body : "",
        target,
      },
    });
  }
  return out;
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return null;
  }
}

export interface RemSyncResult {
  fired: { recent: ReminderRecent; memberKeys: string[] }[];
  exactAlarm: boolean;
}

/**
 * `items`＝null：只取「App 沒開時響過的」、不動清單（每趟先這樣取，記進帳本再算新清單，總結的成員才不會重響）。
 * 失敗＝空結果：下一趟再試，Kotlin 那邊的 inbox 沒清。
 */
export async function remSync(items: readonly ReminderItem[] | null): Promise<RemSyncResult> {
  try {
    const arg = items === null ? null : JSON.stringify(items.map((it) => ({ ...it, target: JSON.stringify(it.target) })));
    const r = await invoke<{ fired?: unknown; exactAlarm?: unknown }>("plugin:tt-notice|rem_sync", { items: arg });
    return { fired: normFired(r?.fired), exactAlarm: r?.exactAlarm !== false };
  } catch (e) {
    console.warn("[reminders] rem_sync 失敗：", errText(e));
    return { fired: [], exactAlarm: true };
  }
}

/** 冷啟動：是不是點通知開進來的（讀完即刪） */
async function remTakeLaunch(): Promise<ReminderTarget | null> {
  try {
    const r = await invoke<{ target?: unknown }>("plugin:tt-notice|rem_take_launch");
    return parseTarget(typeof r?.target === "string" ? r.target : null);
  } catch (e) {
    console.warn("[reminders] rem_take_launch 失敗：", errText(e));
    return null;
  }
}

/* ───────── 桌機 ───────── */

/** 送一則（桌機與 mock）；永遠 resolve */
export async function showToast(it: ReminderItem): Promise<void> {
  if (MOCK_MODE || typeof window === "undefined") {
    mock.sent.push(it);
    console.info(`[reminders] ${it.key}：${it.title}（mock，不呼叫原生）`);
    return;
  }
  try {
    await invoke("reminder_toast", { title: it.title, body: it.body, target: JSON.stringify(it.target) });
  } catch (e) {
    console.warn("[reminders] toast 失敗，退回一般通知：", errText(e));
    await notifyOnce(it.key, { title: it.title, body: it.body }, true, "desktop");
  }
}

/* ───────── 點開 ───────── */

/**
 * 監聽「點了通知」；回解除函式。Android 另外先查一次冷啟動（App 是被通知叫起來的）。
 * 事件只當訊號：Android 真正的目標在 `rem_take_launch`（讀完即刪，冷啟動與 `reminder-open` 同一條路，不會跳兩次）。
 */
export async function onReminderOpen(cb: (t: ReminderTarget) => void): Promise<() => void> {
  if (!live()) {
    openListeners.add(cb);
    return () => {
      openListeners.delete(cb);
    };
  }
  if (onAndroid()) {
    const drain = () => {
      void remTakeLaunch().then((t) => {
        if (t) cb(t);
      });
    };
    drain();
    try {
      const l = await addPluginListener<unknown>("tt-notice", "reminder-open", drain);
      return () => {
        void l.unregister().catch((e: unknown) => console.warn("[reminders] 解除監聽失敗：", errText(e)));
      };
    } catch (e) {
      console.warn("[reminders] 登記監聽失敗：", errText(e));
      return () => undefined;
    }
  }
  try {
    return await listen<string>("ns-reminder-open", (ev) => {
      const t = parseTarget(ev.payload);
      if (t) cb(t);
    });
  } catch (e) {
    console.warn("[reminders] 登記監聽失敗：", errText(e));
    return () => undefined;
  }
}
