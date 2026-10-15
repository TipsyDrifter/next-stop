/**
 * desktopReminder——桌機「跑太久」提醒（Windows 通知，同一班只發一次；①b①c 契約 §5.14、D-時-30；丁席）。
 *
 * - `syncDesktopReminder()`：notice.ts 的 `syncLongRunReminder` 在桌機叫它（TimetableDesktopAgent 的訂閱與 mount）。
 *   算「這一班的提醒時刻」＝開始＋門檻（預估 → 分類預設 → 全域上限，`thresholdOf`）；`reminderOf` 給了就排 setTimeout。
 *   **已經排好同一個（同一班、同一時刻）就不動**——`reminderOf` 在提醒前 60 秒內會回 null，若照它清掉，
 *   任何一次 refresh 落在那 60 秒裡都會把快響的提醒取消。換了班、改了門檻、確認過、關掉開關才清。
 * - `fire`：重讀 store；同一班仍運行中、`blockMarker(...).pending`（真的超過門檻且沒確認過）、設定開著、
 *   本地鍵 `timetable_desktop_reminded` 不是這一班 ⇒ `notifyOnce("tt-longrun:" + blockId, …)` → 寫這把鍵。
 *   只發、不收回（桌機通知外掛沒有 cancel；〈開工決定〉三-11）。App 要開著才會響（文案已寫）。
 * - setTimeout 上限約 24.8 天：超過 24 天的不排，下次 refresh 再算。觸發時刻多等 1 秒——門檻判斷是「超過」，
 *   剛好等於門檻的那一毫秒還不算。
 */
import { MOCK_MODE, settingsRepo } from "../../data";
import { MIN, thresholdOf } from "../../domain/timetable";
import { TT_NOTICE_TEXT, reminderOf } from "../../domain/timetableNotice";
import { TT_TRAY_TEXT } from "../../domain/timetableTray";
import { notifyOnce } from "../../lib/notify";
import { blockMarker, useTimetableStore } from "../../store/timetableStore";
import { noticeLog } from "./ttNoticeBridge";

/** 本地鍵（不同步，契約 0-11）：最後一次發過提醒的那一班 id——「同一班只發一次」跨重開也成立 */
export const KEY_DESKTOP_REMINDED = "timetable_desktop_reminded";

const MAX_DELAY_MS = 24 * 24 * 60 * MIN;
const FIRE_SLACK_MS = 1_000;

let timer: ReturnType<typeof setTimeout> | null = null;
/** 排著的那一個：`${blockId}|${fireAt}` */
let timerKey: string | null = null;
let timerFireAt: number | null = null;

function clearTimer(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  timerKey = null;
  timerFireAt = null;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 目前這一班的提醒（`reminderOf`，store 還沒 ready／沒在跑＝null）。`now = -Infinity`＝不看 60 秒規則 */
function reminderNow(now: number): { blockId: string; fireAt: number; title: string } | null {
  const s = useTimetableStore.getState();
  const r = s.running;
  if (!s.ready || !r) return null;
  const cat = s.catById[r.category_id] ?? null;
  return reminderOf(r, thresholdOf(r.estimate_min, cat, s.longRunMaxMin), cat ? cat.name : "？", s.noticeLongRunEnabled, now);
}

export function syncDesktopReminder(): void {
  // 60 秒規則只用在「新排」：已排好的同一個（同一班、同一時刻、其餘條件仍成立）就留著
  const keep = reminderNow(Number.NEGATIVE_INFINITY);
  if (keep && timerKey === `${keep.blockId}|${keep.fireAt}`) return;
  const had = timerKey !== null;
  clearTimer();
  const now = Date.now();
  const rem = reminderNow(now);
  if (!rem) {
    if (had) noticeLog("cancel", "desktop:取消跑太久提醒");
    return;
  }
  const delay = rem.fireAt - now + FIRE_SLACK_MS;
  if (delay > MAX_DELAY_MS) return; // 太遠：下次 refresh 再算
  timerKey = `${rem.blockId}|${rem.fireAt}`;
  timerFireAt = rem.fireAt;
  const blockId = rem.blockId;
  timer = setTimeout(() => {
    timer = null;
    timerKey = null;
    timerFireAt = null;
    void fire(blockId);
  }, delay);
  noticeLog("schedule", `desktop:${rem.title} @ ${new Date(rem.fireAt).toISOString()}`);
}

/** 停掉排著的提醒（Agent unmount） */
export function stopDesktopReminder(): void {
  clearTimer();
}

async function fire(blockId: string): Promise<void> {
  const s = useTimetableStore.getState();
  const r = s.running;
  if (!s.ready || !r || r.id !== blockId || !s.noticeLongRunEnabled) return;
  const m = blockMarker(r, s.catById, s.longRunMaxMin, Date.now());
  if (m.kind === "none" || !m.pending) return;
  let reminded: string | null = null;
  try {
    reminded = await settingsRepo.get(KEY_DESKTOP_REMINDED);
  } catch (e) {
    console.warn("[tt:notice] 讀桌機提醒紀錄失敗：", errText(e));
  }
  if (reminded === blockId) return;
  const cat = s.catById[r.category_id] ?? null;
  const th = thresholdOf(r.estimate_min, cat, s.longRunMaxMin);
  if (!th) return;
  const title = TT_NOTICE_TEXT.reminderTitle(cat ? cat.name : "？", th.min);
  noticeLog("post", `desktop:${title}（${blockId}）`);
  await notifyOnce(`tt-longrun:${blockId}`, { title, body: TT_TRAY_TEXT.reminderBody }, false, "desktop");
  try {
    await settingsRepo.set(KEY_DESKTOP_REMINDED, blockId);
  } catch (e) {
    console.warn("[tt:notice] 寫桌機提醒紀錄失敗：", errText(e));
  }
}

/* ───────── mock 對帳（?mock=1）：`window.__ttDesktopReminder` ───────── */

interface DesktopReminderMock {
  /** 排著的那一個（沒有＝null） */
  scheduled(): { key: string; fireAt: number } | null;
  /** 不等時間，直接對運行中那班走一次 fire（條件照樣檢查：沒超過門檻、確認過、發過就不發） */
  fireNow(): Promise<void>;
}

if (typeof window !== "undefined" && MOCK_MODE) {
  const mock: DesktopReminderMock = {
    scheduled: () => (timerKey !== null && timerFireAt !== null ? { key: timerKey, fireAt: timerFireAt } : null),
    fireNow: async () => {
      const r = useTimetableStore.getState().running;
      if (r) await fire(r.id);
    },
  };
  (window as unknown as { __ttDesktopReminder?: DesktopReminderMock }).__ttDesktopReminder = mock;
}
