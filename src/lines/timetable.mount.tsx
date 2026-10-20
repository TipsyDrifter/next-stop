/**
 * 時刻表線的登記檔・元件與掛點（並行地基・契約 §5.1；增補二）。**只有時刻表線改這個檔。**
 *
 * - `desktopView`：桌機頁面元件（`timetable.manifest.ts` 的 `page.status` 是 "open" 才會被畫出來）
 * - `mobileView` ：手機頁面元件（`mobile.status` 是 "open" 才會被畫出來）
 * - `reload`     ：同步拉到東西／本機被整批換掉之後，重載這條線的畫面狀態（`syncStore` 呼叫）
 * - 選填 `desktopOverlay`／`mobileOverlay`／`globalHotkeyHandlers`：全域浮層與全域快捷鍵（增補二；未通車不生效）
 *
 * 車次①a（契約 §6.1）：填 desktopView／mobileView／reload／mobileOverlay；不填 globalHotkeyHandlers。
 * ①a 補充契約（系統匣，2026-10-10）：加填 desktopOverlay＝TimetableDesktopAgent（回 null；App 一開就把運行中送到系統匣，
 * 不必先進時刻表頁——原 §6.1「不填 desktopOverlay」由此改寫）。
 * 車次①b（契約 §6.1 #1f）：加填 navBadge／navHint（運行中標記；插槽＝接縫 #58）。
 * 車次②段一（② 契約 §6.1 #A1、0-12）：加填 nodeFields 第一筆 `timetable.time`（車票、支線、路線的「時間」列；
 * 內容可展開成多行 ⇒ `top`）與 ticketSheetItems `timetable.depart`（手機票卡 ⋯ 的「発車」）。
 * 車次②段二填值（② 契約 §6.1 #F1；插槽＝接縫 #66）：加填 todayRowActions `timetable.depart`（桌機今日列「発車」鈕／
 * 「正在跑」標記、手機票卡「正在跑」標記、今日鍵 n＝`timetable.today.depart`）、todayStats（今日「專注」）、
 * nodeFields 第二筆 `timetable.time.task`（列車、車廂側板「分量」段的「時間」，取代「花費」列；section "amount"）。
 * `desktopView`／`mobileView` 的欄位與值寫同一行（probe 牙齒 9 讀值）。此後凍結，只有整合席能改。
 * 車次③（③ 契約 §2 丙列、§5.6、0-13；丙席，契約授權）：加填 routeListAside（手機路線列尾本月時數，D-時-53）與
 * syncRowLabel（同步清單的時刻表三張表；組字在 `timetableSyncLabel.ts` 的純函式，這裡只查列、查名字、組跳轉）。
 * 車次⑥（⑥ 契約 0-6、§5.6、D-時-123；丙席，契約授權）：加填 tagEntities 三筆（`timetable:block`／`category`／`goal`；
 * 存活條件、荷札頁列字與跳轉都在 `timetableTagEntities.ts`）。
 */
import type { LineMount } from "./types";
import { TimetableDesktopAgent, TimetableView } from "../ui/timetable/desktop";
import { MobileTimetable, TimetableMobileAgent } from "../ui/timetable/mobile";
import { NavBadge, timetableNavHint } from "../ui/timetable/NavBadge";
import { useTimetableStore, whenTimetableIdle } from "../store/timetableStore";
import { TimeField } from "../ui/timetable/task/TimeField";
import { TimeFieldMobile } from "../ui/timetable/task/TimeFieldMobile";
import { TicketSheetDepart } from "../ui/timetable/task/TicketSheetDepart";
import { TodayRowDepart, departFromTodayKey } from "../ui/timetable/task/TodayRowDepart";
import { TodayRowMark } from "../ui/timetable/task/TodayRowMark";
import { TodayFocus } from "../ui/timetable/task/TodayFocus";
import { RouteTimeAside } from "../ui/timetable/task/RouteTimeAside";
import { TT_TEXT } from "../store/timetableStore";
import { useTimetableStatsStore } from "../store/timetableStatsStore";
import { useNodeStore } from "../store/nodeStore";
import { useUiStore } from "../store/uiStore";
import { timetableRepo } from "../data/timetableRepository";
import { nodeRepo } from "../data";
import { todayKey } from "../lib/date";
import { blockSyncLabel, categorySyncLabel, goalSyncLabel, type SyncLabelLookup } from "./timetableSyncLabel";
import type { SyncRowLabel } from "./types";
import { TIMETABLE_TAG_ENTITIES } from "./timetableTagEntities";

export const TIMETABLE_MOUNT: LineMount = {
  desktopView: TimetableView,
  mobileView: MobileTimetable,
  reload: (ctx) => useTimetableStore.getState().reload(ctx),
  // 桌機全域代理：系統匣顯示運行中（回 null、零 DOM）
  desktopOverlay: TimetableDesktopAgent,
  // 手機全域代理：回前景重貼常駐通知、重排試驗提醒、記下待問（回 null、零 DOM）
  mobileOverlay: TimetableMobileAgent,
  // ①b 運行中標記（接縫 #58）：書封「時刻表」與手機 tab 右上的分類小圓牌；桌機 tooltip 尾巴「・創作 14:35 発」
  navBadge: NavBadge,
  navHint: timetableNavHint,
  // ②段一 #A1：側板／手機路線圖詳情的「時間」列（車票、支線、路線；狀態段）
  // ②段二 #F1：列車、車廂的「時間」畫在「分量」段，取代「花費」列（列車、車廂才有手填，〈原型拍板〉3）
  nodeFields: [
    { id: "timetable.time", label: "時間", kinds: ["ticket", "branch", "route"], top: true, Desktop: TimeField, Mobile: TimeFieldMobile },
    { id: "timetable.time.task", label: "時間", kinds: ["train", "car"], top: true, section: "amount", Desktop: TimeField, Mobile: TimeFieldMobile },
  ],
  // ②段一 #A1：手機票卡 ⋯ 的「発車」
  ticketSheetItems: [{ id: "timetable.depart", Item: TicketSheetDepart }],
  // ②段二 #F1：今日列「発車」／「正在跑」與今日鍵 n（manifest 登記 scope "today" 的 `timetable.today.depart`）
  todayRowActions: [
    {
      id: "timetable.depart",
      Desktop: TodayRowDepart,
      Mobile: TodayRowMark,
      hotkeys: { "timetable.today.depart": departFromTodayKey },
    },
  ],
  // ②段二 #F1：今日「專注」＝有連到任務／路線的時間塊（桌機取代核心專注；手機補上）
  todayStats: TodayFocus,
  // ③ D-時-53：手機路線圖第一層每條路線列尾的本月時數（只回 span）
  routeListAside: RouteTimeAside,
  // ③ 0-13（#73 R1／R5）：同步清單的時刻表三張表——名字、欄名、值印成人話、已刪除的塊補一句
  syncRowLabel: timetableSyncRowLabel,
  // ⑥ 0-6：荷札頁認得時刻表的塊（手動掛的）、分類的預設荷札、目標綁的荷札（存活＋列字＋跳轉）
  tagEntities: TIMETABLE_TAG_ENTITIES,
};

/* ───────── ③ syncRowLabel（0-13；查列一律含已刪除，真的查不到才回 null） ───────── */

/** 先回時刻表頁（桌機關掉設定面板再換頁；手機換 tab），等 store 載好 */
async function gotoTimetable(shell: "desktop" | "mobile"): Promise<void> {
  const ui = useUiStore.getState();
  if (shell === "desktop") {
    ui.setSettingsOpen(false);
    ui.setPage("timetable");
  } else ui.setMobileTab("timetable");
  await useTimetableStore.getState().init(shell);
}

/** 名字查表：分類（store 已載就用、沒載讀一次；含封存）、節點（linkInfo／nodeStore 快取＋這一列自己連到的先讀好） */
async function lookupFor(extraNodeIds: readonly (string | null)[]): Promise<SyncLabelLookup> {
  const tt = useTimetableStore.getState();
  const cats = tt.ready ? tt.categories : await timetableRepo.listCategories();
  const catName = new Map(cats.map((c) => [c.id, c.name] as const));
  const ns = useNodeStore.getState();
  const nodeName = new Map<string, string>();
  const routeName = new Map<string, string>();
  for (const r of ns.routes) routeName.set(r.id, r.name);
  for (const id of Object.keys(tt.linkInfo)) {
    const li = tt.linkInfo[id];
    if (!li.missing) (li.kind === "route" ? routeName : nodeName).set(id, li.name);
  }
  for (const id of Object.keys(ns.tree.byId)) nodeName.set(id, ns.tree.byId[id].name);
  const want = extraNodeIds.filter((id): id is string => id !== null && !nodeName.has(id) && !routeName.has(id));
  const rows = await Promise.all(want.map((id) => nodeRepo.getNode(id).catch(() => null)));
  rows.forEach((n) => {
    if (n) (n.kind === "route" ? routeName : nodeName).set(n.id, n.name);
  });
  const dayStartHour = useUiStore.getState().dayStartHour;
  return {
    now: Date.now(),
    dayStartHour,
    categoryName: (id) => catName.get(id) ?? null,
    nodeName: (id) => nodeName.get(id) ?? routeName.get(id) ?? null,
    routeName: (id) => routeName.get(id) ?? nodeName.get(id) ?? null,
  };
}

async function timetableSyncRowLabel(tbl: string, rowId: string, shell: "desktop" | "mobile"): Promise<SyncRowLabel | null> {
  if (tbl === "time_blocks") {
    // 沙盒回報 F3：清單在 pull 後的 status 一到就開始解名字，整理（reload → reconcile）還在後面。
    // 先等同步這一趟收完＋serial 佇列清空，讀到的才是整理之後的列（被整理刪掉的塊才帶得到 note）
    await whenTimetableIdle();
    const row = await timetableRepo.getBlock(rowId, { withDeleted: true });
    if (!row) return null;
    const look = await lookupFor([row.node_id, row.route_id]);
    const gone = row.deleted_at !== null;
    return {
      ...blockSyncLabel(row, look, TT_TEXT),
      open: async () => {
        await gotoTimetable(shell);
        const tt = useTimetableStore.getState();
        if (tt.view === "week" || tt.view === "stats") tt.setView(shell === "mobile" ? "axis" : "split");
        await tt.setDayKey(todayKey(useUiStore.getState().dayStartHour, new Date(row.started_at)));
        if (gone) return; // 已刪除：只跳到那一天
        const s = useTimetableStore.getState();
        if (s.dayBlocks.some((b) => b.id === rowId)) s.openSheet({ kind: "edit", blockId: rowId });
      },
    };
  }
  if (tbl === "time_categories") {
    const tt = useTimetableStore.getState();
    const cats = tt.ready ? tt.categories : await timetableRepo.listCategories();
    const row = cats.find((c) => c.id === rowId);
    if (!row) return null; // 只有未刪除（含封存）讀得到：分類目前只會封存、不會刪
    const look = await lookupFor([]);
    return {
      ...categorySyncLabel(row, look, TT_TEXT),
      open: async () => {
        await gotoTimetable(shell);
        useTimetableStore.getState().openSheet({ kind: "categories" });
      },
    };
  }
  if (tbl === "time_goals") {
    const row = await timetableRepo.getGoal(rowId, { withDeleted: true });
    if (!row) return null;
    const look = await lookupFor([]);
    const gone = row.deleted_at !== null;
    return {
      ...goalSyncLabel(row, look, TT_TEXT),
      open: async () => {
        await gotoTimetable(shell);
        const tt = useTimetableStore.getState();
        tt.setView("stats");
        const st = useTimetableStatsStore.getState();
        st.toCurrent();
        // 目標面板的初值讀統計 store 的 goalList：等這一輪算完再開（統計頁剛掛上時還是空的）
        await st.load();
        if (!gone) useTimetableStore.getState().openSheet({ kind: "goal", goalId: rowId });
      },
    };
  }
  return null;
}
