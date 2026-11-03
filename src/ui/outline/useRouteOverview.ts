/**
 * useRouteOverview——路線一覽的資料（丁 D-主-241）：桌機「路線一覽」頁與手機路線圖第一層共用。
 *
 * 四句讀取一起發（都不建樹）：`nodeRepo.listRouteMembers()`（車票済數、塊連到的節點屬於哪條路線）、
 * `nodeRepo.listCurrentOccurrences`（定期券看目前班次）、時刻表 `listBlocks(近 30 天)`、售票口 `queryEntries(近 30 天支出)`；
 * 車站與今日切片（誤點）直接拿 nodeStore 已載的。算數字＝`domain/routeOverview.ts`（純函式、有測試）。
 *
 * 什麼時候重算：掛上、nodeStore 的路線／車站／今日切片換了、時刻表 `rev` 變了、任何寫入（`SYNC_WRITE_EVENT`，去抖 0.6 秒）、
 * 回到前景；運行中的那班每分鐘重算一次（時間跟著長）。只讀，失敗就留著上一份（console 記一句）。
 */
import { useEffect, useMemo, useState } from "react";
import { SYNC_WRITE_EVENT, nodeRepo } from "../../data";
import { ticketRepo } from "../../data/ticketRepository";
import { MAIN_CURRENCY } from "../../domain/ticket";
import { timetableRepo } from "../../data/timetableRepository";
import { buildRouteOverview, type OverviewResult, type OverviewSpan, type RouteMember } from "../../domain/routeOverview";
import { isRouteNodeDone } from "../../domain/routeHead";
import { toLinkedSpan } from "../../domain/timetableLink";
import { addDays, dayWindow, todayKey } from "../../lib/date";
import { useNodeStore } from "../../store/nodeStore";
import { useTimetableStore } from "../../store/timetableStore";
import { useUiStore } from "../../store/uiStore";

/** 一覽看幾天（含今天） */
export const OVERVIEW_DAYS = 30;

interface Loaded {
  members: RouteMember[];
  occ: Record<string, { status: string } | undefined>;
  spans: OverviewSpan[];
  spend: { route_id: string | null; main_minor: number }[];
  hasRunning: boolean;
  /** 主幣別的小數位（花費顯示用；售票口還沒開過也拿得到） */
  decimals: number;
}

export interface RouteOverviewData extends OverviewResult {
  decimals: number;
}

export function useRouteOverview(): RouteOverviewData | null {
  const routes = useNodeStore((s) => s.routes);
  const stations = useNodeStore((s) => s.stations);
  const today = useNodeStore((s) => s.today);
  const ttRev = useTimetableStore((s) => s.rev);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [tick, setTick] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  const dayKey = todayKey(dayStartHour, new Date(now));
  const win = useMemo(() => {
    const start = Date.parse(dayWindow(addDays(dayKey, -(OVERVIEW_DAYS - 1)), dayStartHour).start);
    return { start, startKey: addDays(dayKey, -(OVERVIEW_DAYS - 1)) };
  }, [dayKey, dayStartHour]);

  // 今日切片還沒載過（直接開路線圖頁）⇒ 載一次，誤點才數得出來
  useEffect(() => {
    if (today.dateKey === null) void useNodeStore.getState().loadToday();
  }, [today.dateKey]);

  // 寫入、回前景 ⇒ 重讀（去抖）
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const bump = () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => setTick((n) => n + 1), 600);
    };
    const onVis = () => document.visibilityState === "visible" && bump();
    window.addEventListener(SYNC_WRITE_EVENT, bump);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      if (t) clearTimeout(t);
      window.removeEventListener(SYNC_WRITE_EVENT, bump);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    const fromIso = new Date(win.start).toISOString();
    const toIso = new Date(Date.now() + 60_000).toISOString();
    Promise.all([
      nodeRepo.listRouteMembers(),
      nodeRepo.listCurrentOccurrences(dayKey, dayStartHour),
      timetableRepo.listBlocks(fromIso, toIso),
      ticketRepo.queryEntries({ from: win.startKey, toExcl: addDays(dayKey, 1), accountId: null, categoryIds: [], kinds: ["expense"], routeId: null }),
      ticketRepo.listCurrencies(),
    ]).then(
      ([members, occ, blocks, entries, currencies]) => {
        if (!alive) return;
        setNow(Date.now());
        setLoaded({
          members,
          occ,
          spans: blocks.map(toLinkedSpan),
          spend: entries.map((e) => ({ route_id: e.route_id, main_minor: e.main_minor })),
          hasRunning: blocks.some((b) => b.ended_at === null),
          decimals: currencies.find((c) => c.code === MAIN_CURRENCY)?.decimals ?? 2,
        });
      },
      (e: unknown) => console.warn("[路線一覽] 讀取失敗：", e instanceof Error ? e.message : String(e)),
    );
    return () => {
      alive = false;
    };
    // routes／stations／today 換物件＝重載過（寫入、同步），跟著重讀
  }, [routes, stations, today, ttRev, tick, dayKey, dayStartHour, win]);

  // 有運行中那班：每分鐘重算一次（不重讀）
  useEffect(() => {
    if (!loaded?.hasRunning) return;
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, [loaded?.hasRunning]);

  return useMemo(() => {
    if (!loaded) return null;
    const r = buildRouteOverview({
      routeIds: routes.map((r) => r.id),
      members: loaded.members,
      isDone: (m) => isRouteNodeDone(m, loaded.occ),
      stations,
      spans: loaded.spans,
      spend: loaded.spend,
      todayRows: today.rows,
      today: dayKey,
      window: { start: win.start, end: now },
      now,
    });
    return { ...r, decimals: loaded.decimals };
  }, [loaded, routes, stations, today, dayKey, win, now]);
}
