/**
 * ttNoticeBridge——JS 對本地 plugin `tauri-plugin-tt-notice` 的橋（①b①c 契約 §5.10.8；丙席 Stage 0-C 全文）。
 *
 * - 全部只在 `onAndroid() && !MOCK_MODE` 時真的 invoke `plugin:tt-notice|<cmd>`（Rust 端沒有命令，tauri 在 mobile
 *   轉給 Kotlin；桌機沒有轉發，所以桌機一律不呼叫）。其他情況只 push 一筆 `ttNoticeLog`（＝①a notice.ts 的對帳 log，搬到這裡）。
 * - **mock 模擬器**（`?mock=1` 驗佇列用）：`window.__ttNoticeMock = { tap(categoryId), arrive(), queue, … }`——
 *   在記憶體裡做 §5.10.7 的 TILE／ARRIVE（樂觀更新最後一次 `ttPost` 的 state），然後叫 `ttOnPending` 登記的 cb；
 *   `ttTakePending`／`ttAckPending` 讀寫這個 queue。佇列沒清空時 `ttPost` 保留樂觀更新的 running、`ttScheduleReminder`／
 *   `ttCancelReminder` 不動提醒——與 Kotlin（TtNoticePlugin）同一條規則。
 * - `noticeBlockId(actionId)`：佇列発車的確定性 id（契約 0-6）＝uuid v5(TIMETABLE_ID_NAMESPACE, "notice:" + actionId)，
 *   寫法同 `sqliteTimetableRepository.ts` 的 `pieceId`（Web Crypto）。
 *
 * 為什麼 `ttNoticeLog`／`onAndroid` 搬到這裡：本檔要用它們，而 notice.ts（路由）會 import 本檔——
 * 留在 notice.ts 就成了循環 import。notice.ts 原樣轉出（`export { … } from "./ttNoticeBridge"`），既有的 import 不用改。
 *
 * 失敗語義：`ttTakePending` 失敗＝`{ actions: [], launch: null }`；`ttStatus` 失敗＝null；
 * 其餘（post／remove／ack／schedule／cancel）把錯原樣丟出，讓呼叫端清掉去重簽章、下次再試（同 ①a notice.ts）。
 */
import { invoke, addPluginListener } from "@tauri-apps/api/core";
import { MOCK_MODE } from "../../data";
import { TIMETABLE_ID_NAMESPACE, fmtClock, isoOf } from "../../domain/timetable";
import type { NoticeState, PendingAction } from "../../domain/timetableNotice";

/* ───────── 對帳 log（原 notice.ts:37-54） ───────── */

export interface NoticeLogEntry {
  at: string;
  kind: "post" | "remove" | "schedule" | "cancel" | "take" | "ack";
  detail: string;
}

/** 對帳用（同 `lib/notify.ts` 的做法）：每次「打算貼／收／排／取消／取／確認」push 一筆 */
export const ttNoticeLog: NoticeLogEntry[] = [];
if (typeof window !== "undefined") {
  (window as unknown as { __ttNoticeLog?: NoticeLogEntry[] }).__ttNoticeLog = ttNoticeLog;
}

/** 記一筆對帳 log（notice.ts／noticeDesktop.ts 共用） */
export function noticeLog(kind: NoticeLogEntry["kind"], detail: string): void {
  ttNoticeLog.push({ at: new Date().toISOString(), kind, detail });
  console.info(`[tt:notice] ${kind} ${detail}${MOCK_MODE ? "（mock，不呼叫外掛）" : ""}`);
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

/** 真的叫 Kotlin？（Android 且不是 mock） */
function live(): boolean {
  return onAndroid() && !MOCK_MODE && typeof window !== "undefined";
}

/* ───────── 型別 ───────── */

export interface TakePendingResult {
  actions: PendingAction[];
  launch: { ask: string | null; open: boolean } | null;
}

export interface TtStatus {
  exactAlarm: boolean;
  notificationsEnabled: boolean;
  pendingCount: number;
  reminderFireAt: number | null;
  lastRender: string;
}

export interface TtReminderSpec {
  blockId: string;
  fireAt: number;
  title: string;
  body: string;
}

/* ───────── 確定性 id（契約 0-6） ───────── */

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}

/** 佇列発車的新塊 id＝uuid v5(TIMETABLE_ID_NAMESPACE, "notice:" + actionId)（同一筆動作套幾次都是同一個 id） */
export async function noticeBlockId(actionId: string): Promise<string> {
  const ns = hexToBytes(TIMETABLE_ID_NAMESPACE.replace(/-/g, ""));
  const name = new TextEncoder().encode(`notice:${actionId}`);
  const buf = new Uint8Array(ns.length + name.length);
  buf.set(ns, 0);
  buf.set(name, ns.length);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-1", buf));
  const b = hash.slice(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // variant RFC 4122
  const h = bytesToHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/* ───────── Kotlin 回傳的正規化（JSON 型別不可信） ───────── */

/** Kotlin 可能回陣列／物件，也可能回 JSON 字串；都轉成值 */
function parseMaybeJson(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v) as unknown;
  } catch {
    return null;
  }
}

function normAction(v: unknown): PendingAction | null {
  if (v === null || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  // 形狀不對的照樣留著（id 有就好）：交給 sortPending／pendingIsValid 判 invalid、ack 掉，不然會永遠卡在佇列裡
  if (typeof o.id !== "string" || o.id === "") return null;
  return {
    id: o.id,
    kind: o.kind as PendingAction["kind"],
    categoryId: typeof o.categoryId === "string" ? o.categoryId : null,
    at: typeof o.at === "number" ? o.at : Number(o.at),
    expectRunningId: typeof o.expectRunningId === "string" ? o.expectRunningId : null,
  };
}

function normTake(raw: unknown): TakePendingResult {
  const o = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const list = parseMaybeJson(o.actions);
  const actions: PendingAction[] = [];
  if (Array.isArray(list)) {
    for (const x of list) {
      const a = normAction(x);
      if (a) actions.push(a);
    }
  }
  const l = parseMaybeJson(o.launch);
  let launch: TakePendingResult["launch"] = null;
  if (l !== null && typeof l === "object") {
    const lo = l as Record<string, unknown>;
    launch = { ask: typeof lo.ask === "string" && lo.ask !== "" ? lo.ask : null, open: lo.open === true };
  }
  return { actions, launch };
}

function normStatus(raw: unknown): TtStatus | null {
  if (raw === null || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const fire = typeof o.reminderFireAt === "number" && Number.isFinite(o.reminderFireAt) ? o.reminderFireAt : null;
  return {
    exactAlarm: o.exactAlarm !== false,
    notificationsEnabled: o.notificationsEnabled === true,
    pendingCount: typeof o.pendingCount === "number" ? o.pendingCount : 0,
    reminderFireAt: fire,
    lastRender: typeof o.lastRender === "string" ? o.lastRender : "",
  };
}

/* ───────── mock 模擬器（§5.10.7 的 TILE／ARRIVE，記憶體版） ───────── */

interface MockReminder extends TtReminderSpec {
  fired: boolean;
}

interface TtNoticeMock {
  /** 待處理佇列（＝Kotlin 的 SharedPreferences `pending`） */
  queue: PendingAction[];
  /** 最後一次 ttPost 的 state（樂觀更新會改它的 running） */
  state: NoticeState | null;
  reminder: MockReminder | null;
  /** 下一次 ttTakePending 回的 launch（＝點通知本體／點提醒回 App） */
  launch: TakePendingResult["launch"];
  /** 模擬「點通知上的一格」 */
  tap(categoryId: string): void;
  /** 模擬「點通知上的到着」 */
  arrive(): void;
  /** 模擬「點提醒回 App」（下一次 ttTakePending 帶 launch.ask） */
  openFromReminder(blockId: string): void;
}

const pendingListeners = new Set<() => void>();

function firePendingListeners(): void {
  for (const cb of Array.from(pendingListeners)) {
    try {
      cb();
    } catch (e) {
      console.warn("[tt:notice] pending 監聽丟錯：", errText(e));
    }
  }
}

function newActionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return "mock-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

const mock: TtNoticeMock = {
  queue: [],
  state: null,
  reminder: null,
  launch: null,
  tap(categoryId: string): void {
    // ＝TtActionReceiver.onTile：通知關著、找不到這一格（PendingIntent 過期）、同分類正在跑 ⇒ 只重貼、不進佇列
    const st = mock.state;
    const running = st?.running ?? null;
    const tile = st?.tiles.find((t) => t.categoryId === categoryId) ?? null;
    if (!st || !st.enabled || !tile || (running && running.categoryId === categoryId)) {
      noticeLog("post", `mock tap ${categoryId}：不進佇列，只重貼`);
      return;
    }
    const at = Date.now();
    const action: PendingAction = { id: newActionId(), kind: "depart", categoryId, at, expectRunningId: running ? running.id : null };
    mock.queue.push(action);
    const startedLabel = fmtClock(at) + st.text.startedSuffix;
    // 通知上發車的那班還沒有預估 ⇒ estimateText null（＝TtActionReceiver）
    st.running = { ...tile, id: `pending:${action.id}`, startedAt: at, startedLabel, subText: `${tile.name}・${startedLabel}`, estimateText: null };
    mock.reminder =
      st.longRunEnabled && tile.thresholdMin !== null && tile.reminderTitle !== null
        ? { blockId: `pending:${action.id}`, fireAt: at + tile.thresholdMin * 60_000, title: tile.reminderTitle, body: st.text.reminderBody, fired: false }
        : null;
    noticeLog("post", `mock tap ${categoryId} → 佇列 ${mock.queue.length} 筆`);
    firePendingListeners();
  },
  arrive(): void {
    const st = mock.state;
    if (!st || !st.enabled || !st.running) {
      noticeLog("post", "mock arrive：沒有運行中，只重貼");
      return;
    }
    mock.queue.push({ id: newActionId(), kind: "arrive", categoryId: null, at: Date.now(), expectRunningId: st.running.id });
    st.running = null;
    mock.reminder = null;
    noticeLog("post", `mock arrive → 佇列 ${mock.queue.length} 筆`);
    firePendingListeners();
  },
  openFromReminder(blockId: string): void {
    mock.launch = { ask: blockId, open: true };
  },
};

if (typeof window !== "undefined" && MOCK_MODE) {
  (window as unknown as { __ttNoticeMock?: TtNoticeMock }).__ttNoticeMock = mock;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/* ───────── 公開 API ───────── */

/** 存 state 並依它貼或收常駐通知（72501） */
export async function ttPost(state: NoticeState): Promise<void> {
  const detail = state.running ? `tt:${state.running.subText}（格 ${state.tiles.length}）` : `tt:${state.text.idleTitle}（格 ${state.tiles.length}）`;
  noticeLog("post", detail);
  if (!live()) {
    // ＝TtNoticePlugin.post：佇列還沒清空時保留樂觀更新的 running（JS 這份是套用前的舊狀態）
    const next = JSON.parse(JSON.stringify(state)) as NoticeState;
    if (mock.queue.length && mock.state) next.running = mock.state.running;
    mock.state = next;
    return;
  }
  await invoke("plugin:tt-notice|post", { state: JSON.stringify(state) });
}

/** 收掉常駐通知（「運行中顯示」關掉／沒有權限） */
export async function ttRemove(): Promise<void> {
  noticeLog("remove", "tt:收掉常駐通知");
  if (!live()) {
    mock.state = null;
    return;
  }
  await invoke("plugin:tt-notice|remove");
}

/** 讀待處理佇列（只讀不清；契約 0-6）＋讀完即清的 launch。失敗＝空 */
export async function ttTakePending(): Promise<TakePendingResult> {
  if (!live()) {
    const r: TakePendingResult = { actions: mock.queue.map((a) => ({ ...a })), launch: mock.launch };
    mock.launch = null;
    if (r.actions.length || r.launch) noticeLog("take", `mock 取出 ${r.actions.length} 筆${r.launch ? "（帶 launch）" : ""}`);
    return r;
  }
  try {
    const r = normTake(await invoke<unknown>("plugin:tt-notice|take_pending"));
    if (r.actions.length || r.launch) noticeLog("take", `取出 ${r.actions.length} 筆${r.launch ? "（帶 launch）" : ""}`);
    return r;
  } catch (e) {
    console.warn("[tt:notice] 取待處理動作失敗：", errText(e));
    return { actions: [], launch: null };
  }
}

/** 確認（刪掉）這些 id；空陣列＝什麼都不刪 */
export async function ttAckPending(ids: readonly string[]): Promise<void> {
  if (!ids.length) return;
  noticeLog("ack", `確認 ${ids.length} 筆`);
  if (!live()) {
    const drop = new Set(ids);
    mock.queue = mock.queue.filter((a) => !drop.has(a.id));
    return;
  }
  await invoke("plugin:tt-notice|ack_pending", { ids: Array.from(ids) });
}

/** 排「跑太久」提醒（72502；AlarmManager） */
export async function ttScheduleReminder(r: TtReminderSpec): Promise<void> {
  noticeLog("schedule", `tt:${r.title} @ ${isoOf(r.fireAt)}`);
  if (!live()) {
    // ＝TtNoticePlugin.scheduleReminder：佇列還沒清空時不動提醒
    if (!mock.queue.length) mock.reminder = { ...r, fired: false };
    return;
  }
  await invoke("plugin:tt-notice|schedule_reminder", { blockId: r.blockId, fireAt: r.fireAt, title: r.title, body: r.body });
}

/** 取消提醒（刪 reminder、取消鬧鐘、收 72502） */
export async function ttCancelReminder(): Promise<void> {
  noticeLog("cancel", "tt:取消提醒");
  if (!live()) {
    if (!mock.queue.length) mock.reminder = null;
    return;
  }
  await invoke("plugin:tt-notice|cancel_reminder");
}

/** plugin 現況（〈通知〉節的精準鬧鐘提示、對帳）；失敗＝null */
export async function ttStatus(): Promise<TtStatus | null> {
  if (!live()) {
    return {
      exactAlarm: true,
      notificationsEnabled: true,
      pendingCount: mock.queue.length,
      reminderFireAt: mock.reminder && !mock.reminder.fired ? mock.reminder.fireAt : null,
      lastRender: mock.state ? (mock.state.running ? `running:${mock.state.running.id}@mock` : "idle@mock") : "off@mock",
    };
  }
  try {
    return normStatus(await invoke<unknown>("plugin:tt-notice|status"));
  } catch (e) {
    console.warn("[tt:notice] 查 plugin 狀態失敗：", errText(e));
    return null;
  }
}

/**
 * 監聽 plugin 的 `pending` 事件（App 行程活著、主人在通知上按了）：`addPluginListener("tt-notice", "pending", cb)`；
 * 回解除函式。mock／非 Android：登記到模擬器（`__ttNoticeMock.tap()`／`arrive()` 會叫它）。
 * 登記失敗＝回空的解除函式（回前景／冷啟動那兩條照樣會套佇列）。
 */
export async function ttOnPending(cb: () => void): Promise<() => void> {
  if (!live()) {
    pendingListeners.add(cb);
    return () => {
      pendingListeners.delete(cb);
    };
  }
  try {
    const l = await addPluginListener<unknown>("tt-notice", "pending", () => cb());
    return () => {
      void l.unregister().catch((e: unknown) => console.warn("[tt:notice] 解除 pending 監聽失敗：", errText(e)));
    };
  } catch (e) {
    console.warn("[tt:notice] 登記 pending 監聽失敗：", errText(e));
    return () => undefined;
  }
}
