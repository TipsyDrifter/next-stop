/**
 * externalBridge——⑬ 外部入口對原生層的橋（契約 第二節、第九節）。平台分流看真實平台（`onAndroid()`），不看排版。
 *
 * - 桌機：Rust `external.rs`／`pin.rs` 的 command 與事件。
 * - Android：本地 plugin `tt-notice` 的 `ext_*`／`widget_*`／`nfc_*` 與事件 `external-open`。
 * - `?mock=1` 與沒有 Tauri 橋接的瀏覽器：不碰原生、一律安全的假值（手法同 reminderBridge、capture-window/shell）。
 *   mock 另外給 `window.__externalMock`：`open(url)` 模擬外面丟連結進來、`nfc` 調硬體狀態、`finishNfc(code?)` 結束寫入，沙盒對帳與截圖用。
 */
import { addPluginListener, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { MOCK_MODE } from "../../data";
import { ticketLink, type ExternalQueueItem } from "../../domain/externalLink";
import type { PinSnapshot } from "../../domain/pinSnapshot";
import { useUiStore } from "../../store/uiStore";
import { isTauri } from "../notes/capture-window/shell";
import { onAndroid } from "../timetable/ttNoticeBridge";

export const EV_PIN_VISIBILITY = "pin:visibility";
export const EV_PIN_HELLO = "pin:hello";
export const EV_PIN_STATE = "pin:state";
export const EV_PIN_ACTION = "pin:action";
export const PIN_WINDOW = "pin";

/** 手機 dev 包跟正式版同套件，scheme 固定（契約 第一節） */
const ANDROID_SCHEME = "nextstop";

export interface PinStatus {
  visible: boolean;
  onTop: boolean;
}

export type PinAction =
  | { kind: "arrive" }
  | { kind: "depart"; categoryId: string }
  | { kind: "openToday" }
  | { kind: "openTimetable" };

export interface WidgetStatus {
  supported: boolean;
  installed: number;
}

export interface NfcStatus {
  hardware: boolean;
  enabled: boolean;
}

export type NfcWriteError = "readonly" | "too_small" | "not_ndef" | "io" | "cancelled" | "no_nfc";
const NFC_ERRORS: readonly NfcWriteError[] = ["readonly", "too_small", "not_ndef", "cancelled", "no_nfc", "io"];

function errText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string") return (e as { message: string }).message;
  return String(e);
}

/** 真的叫原生？ */
function live(): boolean {
  return !MOCK_MODE && isTauri();
}

/* ───────── mock ───────── */

interface ExternalMock {
  queue: ExternalQueueItem[];
  /** 模擬外面丟一個連結進來（＝原生把它存進佇列再敲門）；`at` 不給＝現在 */
  open(url: string, at?: number): void;
  pin: PinStatus;
  widget: { status: WidgetStatus; lastState: string | null };
  nfc: NfcStatus;
  /** 結束進行中的寫入：不給＝成功；給代碼＝照那個代碼失敗 */
  finishNfc(code?: NfcWriteError): void;
  /** 最後一份給小窗的快照 */
  snapshot: PinSnapshot | null;
}

const openListeners = new Set<() => void>();
const pinListeners = new Set<(s: PinStatus) => void>();
let mockSeq = 0;
let mockNfc: { resolve(): void; reject(code: NfcWriteError): void } | null = null;

const mock: ExternalMock = {
  queue: [],
  open(url, at) {
    mock.queue.push({ id: `mock-${++mockSeq}`, url, at: at ?? Date.now() });
    for (const cb of Array.from(openListeners)) cb();
  },
  pin: { visible: false, onTop: true },
  widget: { status: { supported: true, installed: 0 }, lastState: null },
  nfc: { hardware: true, enabled: true },
  finishNfc(code) {
    if (code) mockNfc?.reject(code);
    else mockNfc?.resolve();
    mockNfc = null;
  },
  snapshot: null,
};

if (typeof window !== "undefined" && MOCK_MODE) {
  (window as unknown as { __externalMock?: ExternalMock }).__externalMock = mock;
}

export function noteMockSnapshot(s: PinSnapshot): void {
  if (MOCK_MODE) mock.snapshot = s;
}

/* ───────── 連結佇列：取＋確認才刪 ───────── */

/** 型別不可信（Kotlin 可能回 JSON 字串）：形狀不對的丟掉 */
function normItems(raw: unknown): ExternalQueueItem[] {
  const items = (raw as { items?: unknown } | null)?.items;
  let list: unknown = items;
  if (typeof items === "string") {
    try {
      list = JSON.parse(items) as unknown;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  const out: ExternalQueueItem[] = [];
  for (const o of list as ({ id?: unknown; url?: unknown; at?: unknown } | null)[]) {
    if (!o || typeof o.id !== "string" || typeof o.url !== "string") continue;
    // 沒帶時間的當成剛發生：寧可照做，也不要把使用者剛碰的連結判成太舊
    out.push({ id: o.id, url: o.url, at: typeof o.at === "number" && Number.isFinite(o.at) ? o.at : Date.now() });
  }
  return out;
}

export function externalBridgeUsable(): boolean {
  return MOCK_MODE || isTauri();
}

export async function externalTake(): Promise<ExternalQueueItem[]> {
  if (!live()) return mock.queue.slice();
  return normItems(await invoke<unknown>(onAndroid() ? "plugin:tt-notice|ext_take" : "external_take"));
}

export async function externalAck(ids: string[]): Promise<void> {
  if (!live()) {
    mock.queue = mock.queue.filter((it) => !ids.includes(it.id));
    return;
  }
  await invoke(onAndroid() ? "plugin:tt-notice|ext_ack" : "external_ack", { ids });
}

/** 原生敲門：有新連結（事件只當訊號，真正的內容在 `externalTake`）。回解除函式 */
export async function onExternalOpen(cb: () => void): Promise<() => void> {
  if (!live()) {
    openListeners.add(cb);
    return () => {
      openListeners.delete(cb);
    };
  }
  try {
    if (onAndroid()) {
      const l = await addPluginListener<unknown>("tt-notice", "external-open", () => cb());
      return () => {
        void l.unregister().catch((e: unknown) => console.warn("[external] 解除監聽失敗：", errText(e)));
      };
    }
    return await listen("ns-external-open", () => cb());
  } catch (e) {
    console.warn("[external] 登記監聽失敗：", errText(e));
    return () => undefined;
  }
}

let schemeCache: string | null = null;

/** 這個建置的連結開頭：Android 固定；桌機問 Rust（dev、沙盒各有各的，不搶正式版的連結） */
export async function externalScheme(): Promise<string> {
  if (!live() || onAndroid()) return ANDROID_SCHEME;
  if (schemeCache === null) schemeCache = await invoke<string>("external_scheme");
  return schemeCache;
}

/* ───────── 桌面小窗 ───────── */

export async function pinStatus(): Promise<PinStatus> {
  if (!live()) return { ...mock.pin };
  return invoke<PinStatus>("pin_status");
}

function notePin(next: PinStatus): PinStatus {
  mock.pin = next;
  for (const cb of Array.from(pinListeners)) cb({ ...next });
  return { ...next };
}

export async function pinSetVisible(visible: boolean): Promise<PinStatus> {
  if (!live()) return notePin({ ...mock.pin, visible });
  return invoke<PinStatus>("pin_set_visible", { visible });
}

export async function pinSetOnTop(onTop: boolean): Promise<PinStatus> {
  if (!live()) return notePin({ ...mock.pin, onTop });
  return invoke<PinStatus>("pin_set_on_top", { onTop });
}

/** 小窗開關的變化（系統匣、小窗自己的 ✕ 也會動）。回解除函式 */
export async function onPinVisibility(cb: (s: PinStatus) => void): Promise<() => void> {
  if (!live()) {
    pinListeners.add(cb);
    return () => {
      pinListeners.delete(cb);
    };
  }
  try {
    return await listen<PinStatus>(EV_PIN_VISIBILITY, (ev) => cb(ev.payload));
  } catch (e) {
    console.warn("[external] 登記監聽失敗：", errText(e));
    return () => undefined;
  }
}

/** 叫出主視窗（小窗的「開今日」「開時刻表」） */
export async function externalShowMain(): Promise<void> {
  if (!live()) return;
  try {
    await invoke("external_show_main");
  } catch (e) {
    console.warn("[external] 叫出主視窗失敗：", errText(e));
  }
}

/* ───────── 手機小工具 ───────── */

/** 失敗照丟：呼叫端清掉去重簽章、下次再送 */
export async function widgetSync(state: string): Promise<void> {
  if (!live()) {
    mock.widget.lastState = state;
    return;
  }
  await invoke("plugin:tt-notice|widget_sync", { state });
}

export async function widgetStatus(): Promise<WidgetStatus> {
  if (!live()) return { ...mock.widget.status };
  try {
    const r = await invoke<Partial<WidgetStatus>>("plugin:tt-notice|widget_status");
    return { supported: r?.supported === true, installed: typeof r?.installed === "number" ? r.installed : 0 };
  } catch (e) {
    console.warn("[external] 問小工具狀態失敗：", errText(e));
    return { supported: false, installed: 0 };
  }
}

/** 系統有跳出「加到主畫面」＝true */
export async function widgetPin(): Promise<boolean> {
  if (!live()) return true;
  const r = await invoke<{ requested?: unknown }>("plugin:tt-notice|widget_pin");
  return r?.requested === true;
}

/* ───────── NFC ───────── */

export async function nfcStatus(): Promise<NfcStatus> {
  if (!live()) return { ...mock.nfc };
  try {
    const r = await invoke<Partial<NfcStatus>>("plugin:tt-notice|nfc_status");
    return { hardware: r?.hardware === true, enabled: r?.enabled === true };
  } catch (e) {
    console.warn("[external] 問 NFC 狀態失敗：", errText(e));
    return { hardware: false, enabled: false };
  }
}

/** Kotlin 的 reject 訊息 → 代碼；認不得的當 io（「沒寫好，再靠近一次」總是對的） */
function nfcErrorOf(e: unknown): NfcWriteError {
  const text = errText(e);
  return NFC_ERRORS.find((c) => new RegExp(`\\b${c}\\b`).test(text)) ?? "io";
}

/** 等貼紙靠近、寫一筆。成功 resolve；失敗 reject `NfcWriteError` */
export function nfcWrite(url: string): Promise<void> {
  if (!live()) {
    return new Promise<void>((resolve, reject) => {
      mockNfc = { resolve, reject };
    });
  }
  return invoke("plugin:tt-notice|nfc_write", { url }).then(
    () => undefined,
    (e: unknown) => {
      throw nfcErrorOf(e);
    },
  );
}

export async function nfcCancel(): Promise<void> {
  if (!live()) {
    mock.finishNfc("cancelled");
    return;
  }
  await invoke("plugin:tt-notice|nfc_cancel").catch((e: unknown) => console.warn("[external] 取消寫入失敗：", errText(e)));
}

export async function nfcOpenSettings(): Promise<void> {
  if (!live()) return;
  await invoke("plugin:tt-notice|nfc_open_settings").catch((e: unknown) => console.warn("[external] 開 NFC 設定失敗：", errText(e)));
}

/* ───────── 複製 ───────── */

/** 票的 ⋯「複製連結」（今日、路線圖、手機票卡三處共用）：有結果都說一聲 */
export async function copyTicketLink(nodeId: string): Promise<void> {
  const toast = useUiStore.getState().showToast;
  try {
    await navigator.clipboard.writeText(ticketLink(await externalScheme(), nodeId));
    toast({ message: "已複製連結" });
  } catch (e) {
    console.warn("[external] 複製連結失敗：", errText(e));
    toast({ message: "複製不了" });
  }
}
