/**
 * notice——時刻表通知的**路由**（①b①c 契約 §5.10.8；Stage 0-C 起歸丙）。兩支公開入口給兩個 Agent 叫：
 *   - `syncRunningNotice({force})`：Android ⇒ 常駐通知；桌機 ⇒ `noticeDesktop.syncTray`（丁）。
 *   - `syncLongRunReminder({force})`：Android ⇒ 跑太久提醒；桌機 ⇒ `desktopReminder.syncDesktopReminder()`（丁）。
 * 平台分流看**真實平台**、不看排版（①a 補充契約 §3；`onAndroid()`）。視窗拉窄成手機排版也還是走系統匣。
 * 對帳 log（`ttNoticeLog`／`window.__ttNoticeLog`）與 `onAndroid()` 在 `ttNoticeBridge.ts`（避免循環 import），這裡原樣轉出。
 *
 * Android（丙 Stage 1）：本地 plugin `tt-notice`（`ttNoticeBridge`）接手 72501／72502（契約 0-7）。
 * - 常駐通知：`ttPost(buildNoticeState(...))`——整份狀態（運行中那班、常用分類格、開關、固定字）交給 Kotlin 畫
 *   （自訂版面、系統跳秒、到着、格子；停車中也留著，契約 0-9）。去重簽章＝`JSON.stringify(state)`；
 *   `force: true`＝回前景一律重送（Android 14 起 ongoing 可被滑掉）。「運行中顯示」關掉照樣送（`enabled:false`，Kotlin 收掉 72501）——
 *   見下面 `syncRunningNotice` 的說明。
 * - 跑太久提醒：`reminderOf(...)` 有 ⇒ `ttScheduleReminder`（Kotlin 自己的精準鬧鐘），無 ⇒ `ttCancelReminder`。
 * - 換手：Android 第一次以 ①c 啟動（本地鍵 `timetable_notice_v2` 不是 "1"）時，在本 plugin 第一次送之前呼叫一次
 *   `plugin:notification|cancel [72502]` 收掉 2.3.3 排過的舊鬧鐘（`retireLegacyOnce`；只做一次，因為它也會收同 id 的畫面通知）。
 *   72501 不必收：新 plugin 用同一個 id 一貼就取代舊的。
 * - 對帳：每次「打算貼／收／排／取消」push 一筆到 `ttNoticeLog`（bridge 記）；去重擋掉的不記。
 *
 * 桌機：`noticeDesktop.syncTray`（丁）、`desktopReminder.syncDesktopReminder`（丁）。
 *
 * 車次②（② 契約 §5.10、0-13；丙）：運行中那班連到任務 ⇒ 通知的名字是「分類・任務名」（任務名截到 16 字；Kotlin 只照貼字串，
 * 不重 build 原生層）、跑太久門檻多一層任務的預計時間（預估 → 任務 → 分類 → 全域）。名字與預計都從 store 的 `linkInfo`
 * 讀（`linkLabelOf`／`taskEstimateOf`）；什麼時候重送由兩個代理的觸發條件決定（`taskSig`，歸乙）。
 */
import { invoke } from "@tauri-apps/api/core";
import { MOCK_MODE, settingsRepo } from "../../data";
import { fmtClock, msOf, thresholdOf } from "../../domain/timetable";
import { clipLabel, linkLabelOf, runLabel, taskEstimateOf } from "../../domain/timetableLink";
import { TT_NOTICE_TEXT, buildNoticeState, reminderSig, reminderToKeep } from "../../domain/timetableNotice";
import { useTimetableStore } from "../../store/timetableStore";
import { syncDesktopReminder } from "./desktopReminder";
import { syncTray } from "./noticeDesktop";
import { noticeLog, onAndroid, ttCancelReminder, ttPost, ttScheduleReminder } from "./ttNoticeBridge";

export { onAndroid, ttNoticeLog, type NoticeLogEntry } from "./ttNoticeBridge";

/**
 * 常駐通知 id／頻道（本地 plugin 沿用 ①a 的 id，契約 0-7）。頻道 2026-10-14 換成 v2（IMPORTANCE_DEFAULT＋頻道靜音；
 * 舊的 LOW 頻道 `timetable-running` 在 HyperOS 鎖屏不顯示），由 Kotlin `TtNoticeRenderer.ensureChannels` 建新刪舊；
 * 這裡只是對帳用的同一個字串，要跟 Kotlin 的 `CHANNEL_RUNNING` 一致。
 */
export const RUNNING_NOTICE_ID = 72501;
export const RUNNING_CHANNEL_ID = "timetable-running-v2";
/** 跑太久提醒 id／頻道 */
export const LONG_RUN_REMINDER_ID = 72502;
export const LONG_RUN_CHANNEL_ID = "timetable-long-run";

/** 本地鍵（不同步，契約 0-11）："1"＝已收過 tauri-plugin-notification 排的舊 72502 鬧鐘 */
export const KEY_NOTICE_V2 = "timetable_notice_v2";

export type NoticePermission = "granted" | "denied" | "unknown";

const log = noticeLog;

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
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

/* ───────── 換手：收掉 tauri-plugin-notification 排過的舊 72502 鬧鐘（契約 0-7） ───────── */

let retirePromise: Promise<void> | null = null;

/**
 * Android 第一次以 ①c 啟動時，在本 plugin 第一次 post／排提醒之前呼叫一次 `plugin:notification|cancel [72502]`：
 * 舊鬧鐘的 PendingIntent 指向 2.3.3 的 TimedNotificationPublisher，不收會照響一次舊樣式的提醒。
 * 成功或失敗都把本地鍵設 "1"（之後再叫會把本 plugin 自己貼的提醒也收掉，所以只做一次）。
 * 讀本地鍵失敗 ⇒ 這次不收也不設（下一次啟動再試）。mock／瀏覽器：只記 log。
 */
function retireLegacyOnce(): Promise<void> {
  if (!retirePromise) {
    retirePromise = (async () => {
      if (MOCK_MODE || typeof window === "undefined") {
        log("cancel", "（換手）mock：不收舊 72502 鬧鐘");
        return;
      }
      let done: string | null;
      try {
        done = await settingsRepo.get(KEY_NOTICE_V2);
      } catch (e) {
        console.warn("[tt:notice] 讀換手旗標失敗，這次先不收舊鬧鐘：", errText(e));
        return;
      }
      if (done === "1") return;
      log("cancel", "（換手）收掉 plugin-notification 排過的 72502 鬧鐘");
      try {
        // 陣列不准空（上游 cancel() 空清單會崩）
        await invoke("plugin:notification|cancel", { notifications: [LONG_RUN_REMINDER_ID] });
      } catch (e) {
        console.warn("[tt:notice] 收舊 72502 鬧鐘失敗（照樣標成做過）：", errText(e));
      }
      try {
        await settingsRepo.set(KEY_NOTICE_V2, "1");
      } catch (e) {
        console.warn("[tt:notice] 寫換手旗標失敗：", errText(e));
      }
    })();
  }
  return retirePromise;
}

/* ───────── 常駐通知（契約 §5.10.5、§5.10.8） ───────── */

let lastRunningSig: string | null = null;

/**
 * Android：把整份 `NoticeState` 交給 Kotlin（貼／收 72501）；桌機 ⇒ `noticeDesktop.syncTray`。`force`＝回前景一律重送。
 *
 * 「運行中顯示」關掉時照樣 `ttPost`（state.enabled=false ⇒ Kotlin 收掉 72501），不用 `ttRemove`：
 * Kotlin 的提醒鬧鐘到點時要比對 `state.running.id`，關著通知的期間 running 換了，只 remove 會讓 Kotlin 留著舊的 running，
 * 新那一班的提醒就永遠對不上、不響（跑太久提醒與運行中顯示是兩個獨立開關，D-時-30）。
 */
export async function syncRunningNotice(opts: { force?: boolean } = {}): Promise<void> {
  const s = useTimetableStore.getState();
  if (!s.ready) return;
  if (!onAndroid()) {
    const r = s.noticeEnabled ? s.running : null;
    const label = r ? linkLabelOf(r, s.linkInfo) : null;
    const name = r ? runLabel(s.catById[r.category_id]?.name ?? "？", label === null ? null : clipLabel(label)) : "";
    const text = r ? runningNoticeText(name, r.started_at) : null;
    return syncTray(s.noticeEnabled, text, opts.force === true);
  }

  const state = buildNoticeState({
    enabled: s.noticeEnabled,
    tilesEnabled: s.noticeTilesEnabled,
    longRunEnabled: s.noticeLongRunEnabled,
    running: s.running,
    catById: s.catById,
    categories: s.categories,
    recentIds: s.recentCategoryIds,
    pins: s.noticePins,
    globalMaxMin: s.longRunMaxMin,
    // ②：運行中那班連到的任務名（buildNoticeState 自己截 16 字）與任務的預計時間
    linkLabel: s.running ? linkLabelOf(s.running, s.linkInfo) : null,
    taskEstimateMin: s.running ? taskEstimateOf(s.running, s.linkInfo) : null,
  });
  const sig = JSON.stringify(state);
  if (!opts.force && sig === lastRunningSig) return;
  lastRunningSig = sig;

  await retireLegacyOnce();
  try {
    await ttPost(state);
  } catch (e) {
    lastRunningSig = null; // 下一次變化再試
    console.warn("[tt:notice] 常駐通知失敗：", errText(e));
  }
}

/* ───────── 跑太久提醒（Android：plugin 的 AlarmManager；桌機：desktopReminder） ───────── */

let lastReminderSig: string | null = null;

/**
 * 排程／取消「跑太久」提醒：`reminderToKeep`（running 存在、跑太久提醒開著、未確認、門檻非 null、門檻時刻在 60 秒之後；
 * 已排好的同一個在提醒前 60 秒內也留著）有 ⇒ `ttScheduleReminder`；無 ⇒ `ttCancelReminder`
 * （也收掉畫面上已響過的那則——提醒時刻已過、人已經回到 App，由 autoAsk 問）。
 * 門檻：這一班的預估 → 任務的預計時間（②）→ 分類預設長度 → 全域上限（①b）。標題的名字＝「分類・任務名」（②）。
 * 桌機 ⇒ `desktopReminder.syncDesktopReminder()`。
 */
export async function syncLongRunReminder(opts: { force?: boolean } = {}): Promise<void> {
  // 桌機不走 plugin-notification（①a 補充契約 §3-3）：桌機版通知外掛沒有 cancel／remove_active，排了就收不回。
  // ①c 的桌機提醒（只發不收、同一班只一次，D-時-30）由 desktopReminder 用 setTimeout＋notifyOnce 做。
  if (!onAndroid()) {
    syncDesktopReminder();
    return;
  }
  const s = useTimetableStore.getState();
  if (!s.ready) return;
  const r = s.running;
  const cat = r ? (s.catById[r.category_id] ?? null) : null;
  const label = r ? linkLabelOf(r, s.linkInfo) : null;
  // 60 秒規則只擋新排：已經排好的同一個在提醒前 60 秒內照樣留著（重送也無妨，Kotlin 同一班同一時刻保留 fired），
  // 否則這 60 秒裡任何一次 refresh／回前景都會把快響的提醒取消、之後也不會再排（與 desktopReminder 一致）。
  const rem = r
    ? reminderToKeep(
        r,
        thresholdOf(r.estimate_min, cat, s.longRunMaxMin, taskEstimateOf(r, s.linkInfo)),
        runLabel(cat?.name ?? "？", label === null ? null : clipLabel(label)),
        s.noticeLongRunEnabled,
        Date.now(),
        lastReminderSig,
      )
    : null;
  const sig = rem ? reminderSig(rem) : "";
  if (!opts.force && sig === lastReminderSig) return;
  lastReminderSig = sig;

  await retireLegacyOnce();
  try {
    if (rem) await ttScheduleReminder({ ...rem, body: TT_NOTICE_TEXT.reminderBody });
    else await ttCancelReminder();
  } catch (e) {
    lastReminderSig = null;
    console.warn("[tt:notice] 跑太久提醒失敗：", errText(e));
  }
}
