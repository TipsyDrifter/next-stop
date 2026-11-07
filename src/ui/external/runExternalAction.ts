/**
 * runExternalAction——連結進來之後做什麼（⑬ 外部入口；契約 第一節、第二節）。兩端共用，平台差異都在橋裡。
 *
 * - open 走 ⑨ 的 `openReminderTarget`（票已刪由它既有的 toast 說）；発車到着走時刻表 store，判斷同系統匣的 `handleTrayAction`。
 * - 認不得的連結、票已刪：toast 一句，不報錯。発車到着都能復原，所以不再跳確認（D-主-492）。
 * - 主視窗藏著（不開 App 的連結常見）：App 內 toast 看不到，発車到着的結果改用系統通知講一句。
 *   store 自己的 toast 照樣會發（下次看到主視窗時可能還在，無妨）。
 * - 発車到着照連結發生的時間記，動作前先等同步一趟（同 `noticePending.ts`）：冷啟動時別台的紀錄可能還在路上。
 *   太舊的不執行（`externalLinkExpired`）。
 */
import { getCurrentWindow } from "@tauri-apps/api/window";
import { noticeDepartCategoryOk } from "../../domain/timetableNotice";
import { msOf } from "../../domain/timetable";
import { externalLinkExpired, parseExternalLink, type ExternalAction } from "../../domain/externalLink";
import { parseTarget } from "../../domain/reminders";
import { notifyOnce } from "../../lib/notify";
import { isMobileShell } from "../../lib/shell";
import { TT_TEXT, useTimetableStore, waitForTimetableSyncSettle } from "../../store/timetableStore";
import { useUiStore } from "../../store/uiStore";
import { openReminderTarget } from "../reminders/openReminderTarget";
import { onAndroid } from "../timetable/ttNoticeBridge";

/** 動作前等同步的上限（同 noticePending 的 SETTLE_MS） */
const SYNC_SETTLE_MS = 5_000;
const LINK_TOO_OLD = "這個連結太舊了，沒有執行";

const shellNow = (): "desktop" | "mobile" => (isMobileShell() ? "mobile" : "desktop");

let notifySeq = 0;

async function mainHidden(): Promise<boolean> {
  if (typeof document === "undefined") return false;
  if (document.visibilityState === "hidden") return true;
  // WebView2 被縮小或藏到系統匣時 visibilityState 都還是 visible（沙盒實測），桌機要另外問視窗
  if (onAndroid()) return false;
  try {
    const w = getCurrentWindow();
    return !(await w.isVisible()) || (await w.isMinimized());
  } catch {
    return false; // 問不到（瀏覽器 mock、視窗關到一半）就當看得到：最多是 toast 沒人看見
  }
}

function notifyNow(message: string): void {
  void notifyOnce(`external:${++notifySeq}`, { title: "私鐵手帳", body: message }, true, onAndroid() ? "mobile" : "desktop");
}

/** 講一句：看得到主視窗＝toast；藏著＝系統通知 */
async function say(message: string): Promise<void> {
  if (await mainHidden()) notifyNow(message);
  else useUiStore.getState().showToast({ message });
}

/** 成功時 store 已經 toast 過，只有藏著才要另外講 */
async function sayIfHidden(message: string): Promise<void> {
  if (await mainHidden()) notifyNow(message);
}

/** 冷啟動時 store 可能還沒好：init 冪等，跟代理共用同一個 promise。讀不到（資料庫打不開）＝false */
async function timetableReady(): Promise<boolean> {
  const s = useTimetableStore.getState();
  if (s.ready) return true;
  try {
    await s.init(shellNow());
  } catch (e) {
    console.warn("[external] 時刻表還沒好：", e);
    return false;
  }
  return useTimetableStore.getState().ready;
}

async function departCategory(categoryId: string, at: number): Promise<void> {
  if (!(await timetableReady())) return say("時刻表打不開");
  await waitForTimetableSyncSettle(SYNC_SETTLE_MS);
  // 等完才讀：同步可能帶來別台剛発的那班
  const s = useTimetableStore.getState();
  const cat = s.catById[categoryId];
  if (!noticeDepartCategoryOk(cat)) return say("這個分類已經不在了");
  if (s.running?.category_id === categoryId) return say(TT_TEXT.alreadyRunning);
  // 発車會蓋掉 at 之後的紀錄：比現在這班還早的連結不能把這班蓋掉
  if (s.running && at < msOf(s.running.started_at)) return say(LINK_TOO_OLD);
  await s.depart(categoryId, at);
  const after = useTimetableStore.getState().running;
  if (after?.category_id === categoryId) await sayIfHidden(TT_TEXT.depart(cat.name, msOf(after.started_at)));
  else await sayIfHidden("沒発車成功");
}

async function arrive(at: number): Promise<void> {
  if (!(await timetableReady())) return say("時刻表打不開");
  await waitForTimetableSyncSettle(SYNC_SETTLE_MS);
  const s = useTimetableStore.getState();
  const r = s.running;
  if (!r) return say("目前沒有列車在跑");
  const started = msOf(r.started_at);
  // 到站時間夾在 [這班出發, 現在]：比這班還早的連結照做，這班會變成零分鐘就到站
  if (at <= started) return say(LINK_TOO_OLD);
  const name = s.catById[r.category_id]?.name ?? "？";
  await s.arrive(at);
  if (useTimetableStore.getState().running?.id === r.id) await sayIfHidden("沒到着成功");
  else await sayIfHidden(TT_TEXT.arrive(name, Math.max(0, Math.min(at, Date.now()) - started)));
}

export async function runExternalAction(a: ExternalAction, at: number): Promise<void> {
  switch (a.kind) {
    case "openTicket":
      return openReminderTarget({ kind: "node", id: a.nodeId }, shellNow());
    case "openToday":
      return openReminderTarget({ kind: "today" }, shellNow());
    case "openReminder": {
      const target = parseTarget(a.target);
      if (!target) return say("這個連結打不開");
      return openReminderTarget(target, shellNow());
    }
    case "departCategory":
      return departCategory(a.categoryId, at);
    case "departTicket":
      if (!(await timetableReady())) return say("時刻表打不開");
      return useTimetableStore.getState().departFromTask(a.nodeId);
    case "arrive":
      return arrive(at);
  }
}

/**
 * 跑一個連結；永遠 resolve（佇列要能確認掉）。動作本身丟錯也當處理過：
 * 否則一個壞連結會卡在佇列最前面，每次回前景都再錯一次。太舊的同理，講一句就算處理過。
 */
export async function runExternalLink(url: string, at: number): Promise<void> {
  const a = parseExternalLink(url);
  if (!a) return say("這個連結打不開");
  if (externalLinkExpired(a, at, Date.now())) return say(LINK_TOO_OLD);
  try {
    await runExternalAction(a, at);
  } catch (e) {
    console.warn("[external] 連結沒跑成：", e);
    await say("這個連結打不開");
  }
}
