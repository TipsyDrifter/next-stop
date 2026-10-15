/**
 * noticeDesktop——桌機系統匣（①a 補充契約 §3-2；①b①c 契約 §5.11；丁席）。
 *
 * - `syncTray(enabled, text, force)`：notice.ts（路由，丙）在桌機叫它；簽名與 ①a 相同。除了圖示與 tooltip，
 *   ①c 起每次也送整份選單（`buildTrayMenu`）：「到着」「換車 ▸／発車 ▸」＋常用分類＋全部分類。
 *   選單要的其他狀態（分類、常用格開關、釘選、最近用過）**這裡自己讀 store**，notice.ts 的呼叫點不必改。
 * - `handleTrayAction(a)`：Rust 送上來的 `tt-tray` 事件（Agent 的 listen 轉進來）⇒ 換車／到着（0-15：不問其實到幾點）。
 * - 去重簽章＝圖示＋tooltip＋選單 JSON：經過時間取整到分 ⇒ 每分鐘最多送一次（Agent 每 60 秒叫一次）。
 */
import { invoke } from "@tauri-apps/api/core";
import { MOCK_MODE } from "../../data";
import { noticeDepartCategoryOk, noticeTiles } from "../../domain/timetableNotice";
import {
  TRAY_MENU_OFF,
  buildTrayMenu,
  trayTooltipOf,
  type TrayAction,
  type TrayMenuSpec,
} from "../../domain/timetableTray";
import { useTimetableStore } from "../../store/timetableStore";
import type { RunningNoticeText } from "./notice";
import { noticeLog } from "./ttNoticeBridge";

let lastTraySig: string | null = null;
/** 最後一次送出的內容（mock 對帳用：`window.__ttTrayMock.menu()`） */
let lastSent: { running: boolean; tooltip: string; menu: TrayMenuSpec } | null = null;

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 最後一次送給 Rust 的系統匣內容（沒送過＝null） */
export function lastTrayState(): { running: boolean; tooltip: string; menu: TrayMenuSpec } | null {
  return lastSent;
}

/**
 * 桌機：系統匣（①a 補充契約 §3-2；①b①c 契約 §5.11）。圖示在 App 開著時一直都在（Rust 建），這裡換三樣：
 *   - 圖示：運行中＝帶紅點；沒有或設定關掉＝預設。
 *   - tooltip：運行中＝「Next Stop・創作・14:35 発（1h20m）」；沒有＝「Next Stop・目前沒有列車在跑」；設定關掉＝「Next Stop」。
 *   - 選單：`buildTrayMenu(...)`；設定關掉＝`TRAY_MENU_OFF`（Rust 建回「開啟／結束」，0-16）。
 * `text`＝notice.ts 算好的運行中文字（設定關掉或沒在跑＝null），這裡只拿它判斷「要不要當運行中」，
 * 字由 `trayTooltipOf` 重算（多了經過時間）。不用問權限：系統匣不是通知。Rust 找不到 tray 會回 Ok，catch 是保險。
 */
export async function syncTray(enabled: boolean, text: RunningNoticeText | null, force: boolean): Promise<void> {
  const s = useTimetableStore.getState();
  const now = Date.now();
  const r = enabled && text !== null ? s.running : null;
  const running = r !== null;
  const tooltip = trayTooltipOf({ enabled, running: r, catById: s.catById, now });
  const tiles = s.noticeTilesEnabled ? noticeTiles(s.categories, s.recentCategoryIds, s.noticePins, r ? r.category_id : null) : [];
  const menu =
    buildTrayMenu({
      enabled,
      tilesEnabled: s.noticeTilesEnabled,
      running: r,
      catById: s.catById,
      categories: s.categories,
      tiles,
      now,
    }) ?? TRAY_MENU_OFF;
  const sig = `${running ? 1 : 0}|${tooltip}|${JSON.stringify(menu)}`;
  if (!force && sig === lastTraySig) return;
  lastTraySig = sig;
  lastSent = { running, tooltip, menu };
  noticeLog(running ? "post" : "remove", `tray:${tooltip}（選單 ${menu.header === "" ? "開啟／結束" : `常用 ${menu.quick.length}・組 ${menu.groups.length}`}）`);
  if (MOCK_MODE || typeof window === "undefined") return;
  try {
    await invoke("tray_set_status", { running, tooltip, menu });
  } catch (e) {
    lastTraySig = null; // 下一次變化再試
    console.warn("[tt:notice] 系統匣更新失敗：", errText(e));
  }
}

/**
 * 系統匣選單上的換車／到着（Rust `tt-tray` 事件；§5.11、0-15）：
 *   arrive ⇒ 有運行中才 `store.arrive()`（現在）；
 *   depart ⇒ 那個分類正在跑 ⇒ 不動；分類不在了／已刪／是頂層組（選單過期）⇒ 不動；否則 `store.depart(categoryId, now)`。
 *   封存的照樣発車（＝Android 佇列，`noticeDepartCategoryOk` 兩端共用）：封存只是不出現在選單裡，分類還在。
 * 不開面板、不問「其實到幾點」——視窗可能藏著；長時間運行未確認的那班照舊留「待確認」，回到時刻表時由 autoAsk 問。
 * store 還沒 ready（剛開機）⇒ 不動（選單只在 ready 後才送出，理論上不會發生）。
 */
export function handleTrayAction(a: TrayAction): void {
  const s = useTimetableStore.getState();
  if (!s.ready || a === null || typeof a !== "object") return;
  noticeLog("take", `tray:${a.kind === "depart" ? `depart ${a.categoryId}` : a.kind}`);
  if (a.kind === "arrive") {
    if (s.running) void s.arrive();
    return;
  }
  if (a.kind === "depart") {
    if (!noticeDepartCategoryOk(s.catById[a.categoryId])) return;
    if (s.running && s.running.category_id === a.categoryId) return;
    void s.depart(a.categoryId, Date.now());
  }
}
