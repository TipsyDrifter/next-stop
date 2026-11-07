/**
 * reminderRuntime——提醒的常駐排程（⑨ 契約 §4）。App 開機流程叫 `startReminders(shell)`，兩殼都一份。
 *
 * 一趟（`refresh`）：取回 App 沒開時響過的（Android）→ 記進帳本 → 讀事實 → `buildReminderPlan` → 交出去。
 *   Android：`rem_sync` 整份交給 Kotlin（簽章沒變不重送）。桌機：留在記憶體，每分鐘 tick 看有沒有到期。
 * 什麼時候算一趟：開 App、回前景、離開前景（Android 接下來可能很久不跑 JS，先把最新的交出去）、換日、核心資料變動（去抖；同步拉完也會動到）、
 *   改設定、每五分鐘（售票口與時刻表在 App 內改規則、方針沒有通知到這裡；核心不直接訂閱線的 store）。
 *
 * 桌機為什麼用 tick 不用 setTimeout：電腦睡過一覺之後 setTimeout 不準，tick 醒來看到過期就照 `dueNow` 判（要補的補、過期的丟）。
 * 到期時先重算一次再送——票可能這幾分鐘內才蓋済。Android 做不到這件事（Kotlin 讀不到資料），所以 App 沒開時可能響一則已經做完的，契約 §3 寫明。
 */
import { MOCK_MODE, settingsRepo } from "../../data";
import { loadReminderFacts } from "../../data/reminderFacts";
import {
  KEY_REMINDER_RECENT,
  KEY_REMINDER_SENT,
  buildReminderPlan,
  dueNow,
  parseSent,
  pruneSent,
  pushRecent,
  type ReminderItem,
  type ReminderRecent,
} from "../../domain/reminders";
import { todayKey } from "../../lib/date";
import { LINE_MANIFESTS } from "../../lines";
import type { LineId } from "../../lines/types";
import { useNodeStore } from "../../store/nodeStore";
import { useReminderStore } from "../../store/reminderStore";
import { onAfterWipe } from "../../store/syncStore";
import { useUiStore } from "../../store/uiStore";
import { openReminderTarget } from "./openReminderTarget";
import { nativeSchedules, noteMockItems, onReminderOpen, remSync, showToast } from "./reminderBridge";

const TICK_MS = 60_000;
const REFRESH_MS = 5 * 60_000;
const DEBOUNCE_MS = 3_000;

type Shell = "desktop" | "mobile";

let shellNow: Shell = "desktop";
let stops: (() => void)[] = [];
let sent: Record<string, number> = {};
let sentLoaded = false;
let items: ReminderItem[] = [];
let lastSig: string | null = null;
let lastDay: string | null = null;
let running = false;
let again = false;
let ticking = false;
/** 下一趟不看簽章一定送（Kotlin 到期但貼不出去的，要帶清單的 rem_sync 才會補；強制停止後系統也會清掉鬧鐘） */
let forceSend = true;
let debounce: ReturnType<typeof setTimeout> | null = null;

function lineOpen(id: LineId, shell: Shell): boolean {
  const m = LINE_MANIFESTS.find((x) => x.id === id);
  return !!m && (shell === "desktop" ? m.page.status : m.mobile.status) === "open";
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function saveSent(): Promise<void> {
  try {
    await settingsRepo.set(KEY_REMINDER_SENT, JSON.stringify(sent));
  } catch (e) {
    console.warn("[reminders] 寫帳本失敗：", errText(e));
  }
}

async function record(fired: readonly { recent: ReminderRecent; memberKeys: readonly string[] }[]): Promise<void> {
  if (!fired.length) return;
  for (const f of fired) for (const k of f.memberKeys) sent[k] = f.recent.at;
  const st = useReminderStore.getState();
  const recent = pushRecent(st.recent, fired.map((f) => f.recent));
  st.setRecent(recent);
  await saveSent();
  try {
    await settingsRepo.set(KEY_REMINDER_RECENT, JSON.stringify(recent));
  } catch (e) {
    console.warn("[reminders] 寫最近的提醒失敗：", errText(e));
  }
}

async function plan(now: number): Promise<ReminderItem[]> {
  const ui = useUiStore.getState();
  const settings = useReminderStore.getState().settings;
  const facts = await loadReminderFacts({
    now,
    dayStartHour: ui.dayStartHour,
    weekStart: ui.weekStart,
    settings,
    open: { timetable: lineOpen("timetable", shellNow), ticket: lineOpen("ticket", shellNow) },
  });
  // 誤點關掉時事實裡沒有誤點，不能拿來清帳本（否則關一下再開，每張都重響）
  if (settings.late) sent = pruneSent(sent, facts, now);
  return buildReminderPlan(facts, settings, sent, now);
}

async function refreshOnce(): Promise<void> {
  await useReminderStore.getState().load();
  if (!sentLoaded) {
    sent = parseSent(await settingsRepo.get(KEY_REMINDER_SENT).catch(() => null));
    sentLoaded = true;
  }
  const native = nativeSchedules();
  if (native) await record((await remSync(null)).fired);

  const now = Date.now();
  lastDay = todayKey(useUiStore.getState().dayStartHour, new Date(now));
  items = await plan(now);
  noteMockItems(items);

  if (native) {
    const sig = JSON.stringify(items);
    if (sig === lastSig && !forceSend) return;
    forceSend = false;
    const r = await remSync(items);
    lastSig = sig;
    useReminderStore.getState().setExactAlarm(r.exactAlarm);
    await record(r.fired);
  }
}

/** 重算一趟。跑的時候又被叫 ⇒ 跑完補一趟；永遠 resolve */
export async function refreshReminders(opts: { force?: boolean } = {}): Promise<void> {
  if (opts.force) forceSend = true;
  if (running) {
    again = true;
    return;
  }
  running = true;
  try {
    await refreshOnce();
  } catch (e) {
    console.warn("[reminders] 重算失敗：", errText(e));
  } finally {
    running = false;
    if (again) {
      again = false;
      void refreshReminders();
    }
  }
}

function refreshSoon(): void {
  if (debounce !== null) clearTimeout(debounce);
  debounce = setTimeout(() => {
    debounce = null;
    void refreshReminders();
  }, DEBOUNCE_MS);
}

/** 桌機與 mock：看有沒有到期的；到期先重算（票可能剛蓋済），再送還是到期的那幾則 */
async function tick(): Promise<void> {
  // 送通知、寫帳本都要時間；上一輪還沒記完就再進來，同一則會響兩次
  if (ticking) return;
  ticking = true;
  try {
    await tickOnce();
  } finally {
    ticking = false;
  }
}

async function tickOnce(): Promise<void> {
  const now = Date.now();
  const day = todayKey(useUiStore.getState().dayStartHour, new Date(now));
  if (day !== lastDay) await refreshReminders();
  if (nativeSchedules()) return;
  if (!dueNow(items, now).length) return;
  await refreshReminders();
  const due = dueNow(items, Date.now());
  if (!due.length) return;
  for (const it of due) await showToast(it);
  await record(
    due.map((it) => ({
      memberKeys: it.memberKeys,
      recent: { at: Date.now(), kind: it.kind, title: it.title, body: it.body, target: it.target },
    })),
  );
  const firedKeys = new Set(due.map((it) => it.key));
  items = items.filter((it) => !firedKeys.has(it.key));
  noteMockItems(items);
}

/** 開機流程叫（`loadSettings` 之後，資料庫可用才叫）；可重入：先收掉上一輪 */
export function startReminders(shell: Shell): void {
  stopReminders();
  shellNow = shell;
  forceSend = true;
  void refreshReminders().then(() => tick());

  const timers = [
    setInterval(() => void tick().catch((e: unknown) => console.warn("[reminders] tick 失敗：", errText(e))), TICK_MS),
    setInterval(() => void refreshReminders(), REFRESH_MS),
  ];
  stops.push(() => timers.forEach(clearInterval));
  // 別台「一起清空」不重開 App：帳本與最近的提醒重讀，舊的才不會被下一次存檔寫回去
  stops.push(
    onAfterWipe(() => {
      sentLoaded = false;
      void useReminderStore.getState().reloadRecent();
    }),
  );

  // 回前景重算；離開前景也算一趟（Android 接下來可能很久不跑 JS）
  const onVisible = () => void refreshReminders({ force: true });
  document.addEventListener("visibilitychange", onVisible);
  stops.push(() => document.removeEventListener("visibilitychange", onVisible));

  // 核心資料變動（蓋済、改締切、改時刻……）。nodeStore 不分欄位通知，靠去抖＋簽章
  stops.push(
    useNodeStore.subscribe((s, p) => {
      if (s.today !== p.today || s.routes !== p.routes || s.stations !== p.stations) refreshSoon();
    }),
  );
  stops.push(
    useReminderStore.subscribe((s, p) => {
      if (s.settings !== p.settings && s.loaded) refreshSoon();
    }),
  );
  stops.push(
    useUiStore.subscribe((s, p) => {
      if (s.dayStartHour !== p.dayStartHour || s.weekStart !== p.weekStart) refreshSoon();
    }),
  );

  let closed = false;
  let unlisten: (() => void) | null = null;
  void onReminderOpen((t) => void openReminderTarget(t, shellNow)).then((fn) => {
    if (closed) fn();
    else unlisten = fn;
  });
  stops.push(() => {
    closed = true;
    unlisten?.();
  });
}

export function stopReminders(): void {
  for (const s of stops) s();
  stops = [];
  if (debounce !== null) clearTimeout(debounce);
  debounce = null;
}

if (typeof window !== "undefined" && MOCK_MODE) {
  (window as unknown as { __reminderTick?: () => Promise<void> }).__reminderTick = tick;
}
