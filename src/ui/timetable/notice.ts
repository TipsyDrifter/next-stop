/**
 * notice——靜態常駐通知（車次①a 契約 §5.8）與試驗項 T・背景「跑太久」提醒（§5.9、D-時-20）；丙席。
 * 平台分流看**真實平台**、不看排版（①a 補充契約 §3；`onAndroid()`）：
 *   - Android：OS 常駐通知＋試驗提醒（下面這些）。
 *   - 桌機：常駐的替代＝系統匣（D-時-24）——`syncRunningNotice` 改叫 Rust `tray_set_status` 換圖示與 tooltip；
 *     試驗項 T 不排（桌機通知發了收不回）。視窗拉窄成手機排版也還是走系統匣，不會跳 Windows 系統通知。
 * mock 只記 log（`window.__ttNoticeLog`）。
 *
 * 寫法照 `lib/notify.ts`：權限直接問 Rust `plugin:notification|is_permission_granted`（外掛 JS 包裝在 Windows 恆 false 的坑）、
 * 送出直接 `invoke("plugin:notification|notify", { options })`、頻道用外掛的 `createChannel`（動態 import）。
 *
 * - 常駐通知（id 72501，頻道 timetable-running，Importance.Low）：「{分類}・HH:MM 発」／「運行中」，`ongoing: true`。
 *   只寫出發時刻、不寫經過時間（另一台換了車，這台要等回前景才更新）。「更新」＝同 id 再送一次（2.3.3 先取消再貼）。
 *   沒有運行中 ⇒ `remove_active([{ id }])`——**陣列絕不能是空的**（Kotlin 收到空陣列＝cancelAll，會把同步告警一起清掉）。
 * - 試驗提醒（id 72502，頻道 timetable-long-run，Importance.Default）：`LONG_RUN_REMINDER_TRIAL` 開關；
 *   先 `cancel([id])` 再排（**不准空陣列**：上游 cancel() 空清單會崩），門檻時刻 `schedule.at`。
 *   capability `notification:allow-remove-active`／`allow-cancel` 由整合席加（契約 0-12）——沒加之前 invoke 會丟錯、這裡吞掉。
 * - 去重：同一個「該貼的內容」不重送（store 每次 refresh 都換新的 running 物件，Agent 的訂閱會頻繁觸發）；
 *   `force: true`＝回前景一律重貼（Android 14 起 ongoing 可被滑掉；不查 get_active，直接重貼）。
 * - 對帳：每次「打算貼／收／排／取消」push 一筆到 `ttNoticeLog`；去重擋掉的不記。
 */
import { invoke } from "@tauri-apps/api/core";
import { MOCK_MODE } from "../../data";
import { MIN, fmtClock, fmtDur, isoOf, longRunThreshold, msOf } from "../../domain/timetable";
import { useTimetableStore } from "../../store/timetableStore";

/** 常駐通知 id／頻道 */
export const RUNNING_NOTICE_ID = 72501;
export const RUNNING_CHANNEL_ID = "timetable-running";
/** 試驗提醒 id／頻道 */
export const LONG_RUN_REMINDER_ID = 72502;
export const LONG_RUN_CHANNEL_ID = "timetable-long-run";

/** 試驗項 T 的開關（§2.5）：丙席做完改 true；真機判定不過就改回 false 並標「併入 ①c」 */
export const LONG_RUN_REMINDER_TRIAL = true;

export interface NoticeLogEntry {
  at: string;
  kind: "post" | "remove" | "schedule" | "cancel";
  detail: string;
}

/** 對帳用（同 `lib/notify.ts` 的做法）：每次「打算貼／收」push 一筆 */
export const ttNoticeLog: NoticeLogEntry[] = [];
if (typeof window !== "undefined") {
  (window as unknown as { __ttNoticeLog?: NoticeLogEntry[] }).__ttNoticeLog = ttNoticeLog;
}

export type NoticePermission = "granted" | "denied" | "unknown";

function log(kind: NoticeLogEntry["kind"], detail: string): void {
  ttNoticeLog.push({ at: new Date().toISOString(), kind, detail });
  console.info(`[tt:notice] ${kind} ${detail}${MOCK_MODE ? "（mock，不呼叫外掛）" : ""}`);
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 真實平台是不是 Android（①a 補充契約 §3-1）。以前看 `timetableShell() === "mobile"`＝排版，
 * 桌機視窗拉窄到 ≤767px 就誤走 Android 通知路徑、跳出收不回的 Windows 系統通知。
 * 用 userAgent 而不是 `@tauri-apps/plugin-os`：專案沒有這個依賴（加它＝npm＋crate＋capability 三處），
 * 而 Android System WebView 的 UA 一定帶 "Android"、Windows 的 WebView2 一定不帶——拉窄視窗不會改 UA。
 */
export function onAndroid(): boolean {
  return typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
}

/** 常駐通知（Android）與系統匣 tooltip（桌機）共用的那一份文字（補充契約 §3-4：不得各寫一份） */
export interface RunningNoticeText {
  /** 「{分類}・HH:MM 発」：只寫出發時刻、不寫經過時間（另一台換了車，這台要等回前景才更新） */
  title: string;
  body: string;
}

export function runningNoticeText(categoryName: string, startedAt: string): RunningNoticeText {
  return { title: `${categoryName}・${fmtClock(msOf(startedAt))} 発`, body: "運行中" };
}

/** 系統匣 tooltip 的固定字（補充契約 §3-2） */
const TRAY_NAME = "Next Stop";
const TRAY_IDLE = `${TRAY_NAME}・目前沒有列車在跑`;

/**
 * 通知權限現況（「分類與設定」面板的「需要允許通知」用）。mock／非瀏覽器＝granted（面板不顯示提示）。
 * `is_permission_granted`：true＝granted、false＝denied、null＝還沒問過（Android）。
 */
export async function noticePermission(): Promise<NoticePermission> {
  if (MOCK_MODE || typeof window === "undefined") return "granted";
  try {
    const r = await invoke<boolean | null>("plugin:notification|is_permission_granted");
    return r === true ? "granted" : r === false ? "denied" : "unknown";
  } catch (e) {
    console.warn("[tt:notice] 問通知權限失敗：", errText(e));
    return "unknown";
  }
}

async function permissionGranted(): Promise<boolean> {
  try {
    return (await invoke<boolean | null>("plugin:notification|is_permission_granted")) === true;
  } catch (e) {
    console.warn("[tt:notice] 問通知權限失敗：", errText(e));
    return false;
  }
}

/** Android 頻道只建一次（冪等但每次都建是白打 IPC）；失敗＝false，改成不帶 channelId 送 */
const channelReady = new Map<string, Promise<boolean>>();
function ensureChannel(id: string, name: string, level: "low" | "default"): Promise<boolean> {
  let p = channelReady.get(id);
  if (!p) {
    p = (async () => {
      try {
        const { createChannel, Importance } = await import("@tauri-apps/plugin-notification");
        await createChannel({ id, name, importance: level === "low" ? Importance.Low : Importance.Default });
        return true;
      } catch (e) {
        console.warn(`[tt:notice] 建通知頻道 ${id} 失敗，改用預設頻道：`, errText(e));
        return false;
      }
    })();
    channelReady.set(id, p);
  }
  return p;
}

/* ───────── 常駐通知（§5.8） ───────── */

let lastRunningSig: string | null = null;
let lastTraySig: string | null = null;

/**
 * 依 store 的 running／分類名／noticeEnabled 重貼或收掉常駐通知（Android）、或換系統匣圖示與 tooltip（桌機）；
 * `force`＝回前景一律重貼。
 */
export async function syncRunningNotice(opts: { force?: boolean } = {}): Promise<void> {
  const s = useTimetableStore.getState();
  if (!s.ready) return;
  const r = s.noticeEnabled ? s.running : null;
  const name = r ? (s.catById[r.category_id]?.name ?? "？") : "";
  const text = r ? runningNoticeText(name, r.started_at) : null;
  if (!onAndroid()) return syncTray(s.noticeEnabled, text, opts.force === true);

  const sig = r ? `${r.id}|${r.started_at}|${name}` : "";
  if (!opts.force && sig === lastRunningSig) return;
  lastRunningSig = sig;

  const title = text?.title ?? "";
  if (MOCK_MODE || typeof window === "undefined") {
    log(r ? "post" : "remove", r ? title : "沒有運行中（收掉）");
    return;
  }
  try {
    if (r) {
      // 權限判完才記「post」，對帳時（契約 §5.8）才不會把沒貼出去的算成貼過
      if (!(await permissionGranted())) {
        log("remove", "無權限，略過");
        return;
      }
      log("post", title);
      const hasChannel = await ensureChannel(RUNNING_CHANNEL_ID, "時刻表・運行中", "low");
      await invoke("plugin:notification|notify", {
        options: {
          id: RUNNING_NOTICE_ID,
          ...(hasChannel ? { channelId: RUNNING_CHANNEL_ID } : {}),
          title,
          body: text?.body ?? "",
          ongoing: true,
          autoCancel: false,
        },
      });
    } else {
      log("remove", "沒有運行中（收掉）");
      // 陣列絕不能是空的（空陣列＝cancelAll）
      await invoke("plugin:notification|remove_active", { notifications: [{ id: RUNNING_NOTICE_ID }] });
    }
  } catch (e) {
    lastRunningSig = null; // 下一次變化再試
    console.warn("[tt:notice] 常駐通知失敗：", errText(e));
  }
}

/**
 * 桌機：系統匣（①a 補充契約 §3-2）。圖示在 App 開著時一直都在（Rust 建），這裡只換「運行中／預設」圖與 tooltip：
 *   運行中＝「Next Stop・{與手機常駐通知同一支文字}」；沒有＝「Next Stop・目前沒有列車在跑」；
 *   設定關掉＝一律 `running: false`＋「Next Stop」（圖示還在，只是不透露運行狀態）。
 * 去重看「要送的內容」本身（設定關掉與沒在跑兩種 tooltip 不同，不能共用 Android 那顆只看 running 的 sig）。
 * 不用問權限：系統匣不是通知。Rust 找不到 tray 會回 Ok（只寫 log），這裡的 catch 是保險。
 */
async function syncTray(enabled: boolean, text: RunningNoticeText | null, force: boolean): Promise<void> {
  const running = text !== null;
  const tooltip = !enabled ? TRAY_NAME : text ? `${TRAY_NAME}・${text.title}` : TRAY_IDLE;
  const sig = `${running ? 1 : 0}|${tooltip}`;
  if (!force && sig === lastTraySig) return;
  lastTraySig = sig;
  log(running ? "post" : "remove", `tray:${tooltip}`);
  if (MOCK_MODE || typeof window === "undefined") return;
  try {
    await invoke("tray_set_status", { running, tooltip });
  } catch (e) {
    lastTraySig = null; // 下一次變化再試
    console.warn("[tt:notice] 系統匣更新失敗：", errText(e));
  }
}

/* ───────── 試驗項 T・背景「跑太久」提醒（§5.9） ───────── */

let lastReminderSig: string | null = null;

/** 排程／取消「跑太久」提醒：running 存在、未確認、門檻非 null、門檻時刻在 60 秒之後才排；其餘只取消 */
export async function syncLongRunReminder(opts: { force?: boolean } = {}): Promise<void> {
  // 桌機不排（①a 補充契約 §3-3）：桌機版通知外掛沒有 cancel／remove_active，排了就收不回——
  // 換車、到站之後提醒照響。桌機的「跑太久」交給回前景時主動問（autoAsk）；系統匣上的提醒 ①c 再議。
  if (!LONG_RUN_REMINDER_TRIAL || !onAndroid()) return;
  const s = useTimetableStore.getState();
  if (!s.ready) return;
  const r = s.noticeEnabled ? s.running : null;
  let fireAt: number | null = null;
  let name = "";
  let thresholdMin: number | null = null;
  if (r && r.long_run_ack !== 1) {
    const cat = s.catById[r.category_id] ?? null;
    name = cat?.name ?? "？";
    thresholdMin = longRunThreshold(cat, s.longRunMaxMin);
    if (thresholdMin !== null) {
      const f = msOf(r.started_at) + thresholdMin * MIN;
      if (f > Date.now() + 60_000) fireAt = f;
    }
  }
  const sig = r && fireAt !== null ? `${r.id}|${fireAt}|${name}` : "";
  if (!opts.force && sig === lastReminderSig) return;
  lastReminderSig = sig;

  const title = thresholdMin !== null ? `${name}已經跑了 ${fmtDur(thresholdMin * MIN)}，還在嗎？` : "";
  log(fireAt !== null ? "schedule" : "cancel", fireAt !== null ? `${title} @ ${isoOf(fireAt)}` : "取消提醒");
  if (MOCK_MODE || typeof window === "undefined") return;
  try {
    // 先取消再排；陣列不准空（上游 cancel() 空清單會崩）
    await invoke("plugin:notification|cancel", { notifications: [LONG_RUN_REMINDER_ID] });
    if (fireAt === null) return;
    if (!(await permissionGranted())) return;
    const hasChannel = await ensureChannel(LONG_RUN_CHANNEL_ID, "時刻表・跑太久提醒", "default");
    const options = (date: string) => ({
      id: LONG_RUN_REMINDER_ID,
      ...(hasChannel ? { channelId: LONG_RUN_CHANNEL_ID } : {}),
      title,
      body: "點開時刻表修正",
      schedule: { at: { date, repeating: false, allowWhileIdle: true } },
    });
    try {
      await invoke("plugin:notification|notify", { options: options(isoOf(fireAt)) });
    } catch (e1) {
      // 契約 §9-8：ISO 含毫秒可能被 Rust iso8601 退件 ⇒ 不帶毫秒再試一次
      console.warn("[tt:notice] 排程（含毫秒）被退：", errText(e1));
      await invoke("plugin:notification|notify", { options: options(isoOf(fireAt).replace(/\.\d{3}Z$/, "Z")) });
    }
  } catch (e) {
    lastReminderSig = null;
    console.warn("[tt:notice] 跑太久提醒失敗：", errText(e));
  }
}
