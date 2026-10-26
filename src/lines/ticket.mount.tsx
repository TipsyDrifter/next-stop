/**
 * 售票口線的登記檔・元件與掛點（並行地基・契約 §5.1；增補二）。**只有售票口線改這個檔。**
 *
 * - `desktopView`：桌機頁面元件（`ticket.manifest.ts` 的 `page.status` 是 "open" 才會被畫出來）
 * - `mobileView` ：手機頁面元件（`mobile.status` 是 "open" 才會被畫出來）（車次①整合起是底部第五格，D-票-20；不再收到 `onBack`）
 * - `reload`     ：同步拉到東西／本機被整批換掉之後，重載這條線的畫面狀態（`syncStore` 呼叫）
 * - 選填 `desktopOverlay`／`mobileOverlay`／`globalHotkeyHandlers`：全域浮層與全域快捷鍵（增補二；未通車不生效）
 *
 * 地基階段三個欄位都是 null、選填欄位都不填 ⇒ 集中檔走不到任何一條這條線的分支。
 * 車次①（契約 §3.11）：填 desktopView／mobileView／reload／desktopOverlay／mobileOverlay／sidebarAux／captureTargets；
 * 不填 globalHotkeyHandlers、sidebarTool、calendarDayMarks。
 * 第②階段（②契約 §3.5）起再填 nodeFields／quickJump／routeListAside（整合席）。`desktopView`／`mobileView` 的欄位與值寫同一行（probe 牙齒 9）。
 * 第③階段（③契約 §3.10）：再填 afterPull（整合席）；calendarDayMarks 照舊不填（D-票-32）。
 * 此後凍結，只有整合席能改。
 */
import type { LineMount, NodeFieldSpec, SyncRowLabel } from "./types";
import { TicketView, TicketSide, RouteSpendField, TICKET_QUICK_JUMP } from "../ui/ticket/desktop";
import { MobileTicketOffice, RouteSpendAside } from "../ui/ticket/mobile";
import { TicketAgent } from "../ui/ticket/TicketAgent";
import { TICKET_CAPTURE } from "../ui/ticket/capture";
import { useTicketStore } from "../store/ticketStore";
import { ticketRepo } from "../data/ticketRepository";
import { SYNC_LABEL_FALLBACK } from "../store/syncMergeLabels";
import { repeatSyncLabel } from "./ticketSyncLabel";

/**
 * 同步清單列（同步引擎班順手；組字在 `ticketSyncLabel.ts`）：定期帳、帳戶、帳目分類講人話，其餘售票口的表回
 * `SYNC_LABEL_FALLBACK`＝照舊印泛稱（插槽一填就接走整條線的表，回 null 會變成「現在找不到了」）。
 * 帳戶／分類是 #101 整組寫之後補的（沙盒 F-8）：排序競合一次列 N 筆，泛稱「帳戶（74f8）的 position」認不出是哪個。
 * 已刪的查不到＝null（真的不在了）。
 */
async function ticketSyncRowLabel(tbl: string, rowId: string): Promise<SyncRowLabel | null> {
  if (tbl === "tk_accounts") {
    const row = (await ticketRepo.listAccounts()).find((a) => a.id === rowId);
    return row ? { label: `帳戶「${row.name}」`, cols: ACCOUNT_COLS } : null;
  }
  if (tbl === "tk_categories") {
    const row = (await ticketRepo.listCategories()).find((c) => c.id === rowId);
    return row ? { label: `分類「${row.name}」`, cols: CATEGORY_COLS } : null;
  }
  if (tbl !== "tk_repeats") return SYNC_LABEL_FALLBACK;
  const [repeats, accounts, categories] = await Promise.all([ticketRepo.listRepeats(), ticketRepo.listAccounts(), ticketRepo.listCategories()]);
  const row = repeats.find((r) => r.id === rowId);
  if (!row) return null;
  const acc = new Map(accounts.map((a) => [a.id, a.name]));
  const cat = new Map(categories.map((c) => [c.id, c.name]));
  return repeatSyncLabel(row, { accountName: (id) => acc.get(id) ?? null, categoryName: (id) => cat.get(id) ?? null });
}

const ACCOUNT_COLS: Readonly<Record<string, string>> = { position: "順序", name: "名稱", group_key: "群組", currency: "幣別", archived_at: "封存" };
const CATEGORY_COLS: Readonly<Record<string, string>> = { position: "順序", name: "名稱", kind: "收支", parent_id: "上層分類", archived_at: "封存" };

/** 路線側板的「花費」列（②契約 D-票-12、0-11、0-12）；時刻表線另登記 timetable.time，RoutePanel 不改 */
const TICKET_NODE_FIELDS: readonly NodeFieldSpec[] = [
  { id: "ticket.spend", label: "花費", kinds: ["route"], Desktop: RouteSpendField },
];

export const TICKET_MOUNT: LineMount = {
  desktopView: TicketView,
  mobileView: MobileTicketOffice,
  reload: (ctx) => useTicketStore.getState().reload(ctx),
  // 全域代理（回 null、零 DOM）：App 一啟動就 warm（起手三列、帳戶名給捕捉框的落點）＋沙盒除錯入口（0-34）
  desktopOverlay: TicketAgent,
  mobileOverlay: TicketAgent,
  // 書封頁務件（接縫 #50，已在 main；0-12、0-32）
  sidebarAux: TicketSide,
  // 捕捉框「記一筆」（0-7）
  captureTargets: [TICKET_CAPTURE],
  // 第②階段（②契約 §3.5）：路線側板「花費」列（0-11、0-12）、Ctrl+P「帳目」組（0-4、0-19）、手機路線圖列尾小字（0-13）
  nodeFields: TICKET_NODE_FIELDS,
  quickJump: TICKET_QUICK_JUMP,
  routeListAside: RouteSpendAside,
  // 第③階段（③契約 0-6）：同步拉完 ⇒ 實體化到期的定期帳（含 0-7 的 reconcile）。reload 只在 tk_* 有變才跑，不適合當觸發
  afterPull: () => void useTicketStore.getState().materialize("afterPull"),
  // 同步引擎班順手：同步頁清單／toast 的定期帳講人話（其餘表照舊泛稱）
  syncRowLabel: ticketSyncRowLabel,
  // calendarDayMarks 不填（D-票-29；③的 0-2 答 (a)，D-票-32：主線日曆不標超支）
};
