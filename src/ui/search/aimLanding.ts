/**
 * 點了一句方針 → 到那一期的畫面（方針擴充 辛 D-主-382；兩殼共用，`shell` 決定怎麼換頁）：
 *   週、月＝行程表該期（桌機切週／月檢視、落在那一期；手機今日 tab 的行程表捲到那一天，月方針再打開月曆翻到那個月）
 *   年＝車庫年鑑（告示換成那一年）
 *   車站＝路線頁（走 Ctrl+P 同一條跳轉，已到站、車庫路線的邊界都在那裡），到了開那一站的小卡
 *
 * 「落在哪一期」是畫面自己的本地狀態（行程表的游標、年鑑告示的鍵），外面搆不到，所以走請求槽（同 `routeMapReveal.useRevealStore`）：
 * 這裡下請求、那一頁掛上時用 `useAimLanding` 收。請求擺著等它掛上，收了才清；下一次請求會蓋掉沒人收的那一張。
 */
import { useEffect } from "react";
import { create } from "zustand";
import { aimLandingDay, type AimSearchHit } from "../../domain/fullSearch";
import { periodOfKey, type AimPeriod } from "../../domain/weekAims";
import { todayKey } from "../../lib/date";
import { useDepotStore } from "../../store/depotStore";
import { useUiStore } from "../../store/uiStore";
import { jumpToNode } from "../common/QuickJump";
import { jumpToNodeMobile } from "../mobile/routeMapReveal";
import { useScheduleUiStore } from "../schedule/scheduleUiStore";

interface AimLandingState {
  /** 要落在哪一期（期間鍵）；null＝沒有 */
  req: { key: string; nonce: number } | null;
  request(key: string): void;
  consume(nonce: number): void;
}

let nonce = 0;
const useAimLandingStore = create<AimLandingState>()((set, get) => ({
  req: null,
  request: (key) => set({ req: { key, nonce: ++nonce } }),
  consume: (n) => {
    if (get().req?.nonce === n) set({ req: null });
  },
}));

/** 畫面那一頭：有指向這幾種期間的請求就收下（掛上時已經擺著的也收得到）。`periods`、`onLand` 不必穩定 */
export function useAimLanding(periods: readonly AimPeriod[], onLand: (key: string) => void): void {
  const req = useAimLandingStore((s) => s.req);
  useEffect(() => {
    if (!req || !periods.includes(periodOfKey(req.key))) return;
    useAimLandingStore.getState().consume(req.nonce);
    onLand(req.key);
    // 只看請求本身：同一張請求只收一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req]);
}

export async function goToAim(hit: Pick<AimSearchHit, "aim" | "station">, shell: "desktop" | "mobile"): Promise<void> {
  const ui = useUiStore.getState();
  const key = hit.aim.week_on;
  const period = periodOfKey(key);
  if (period === "station") {
    if (!hit.station) return;
    useAimLandingStore.getState().request(key);
    await (shell === "desktop" ? jumpToNode(hit.station) : jumpToNodeMobile(hit.station));
    return;
  }
  if (period === "year") {
    useAimLandingStore.getState().request(key);
    useDepotStore.getState().setTab("year");
    if (shell === "desktop") ui.setPage("depot");
    else ui.setMobileTab("depot");
    return;
  }
  const day = aimLandingDay(key, todayKey(ui.dayStartHour), ui.weekStart);
  if (shell === "desktop") {
    // 行程表的游標是一天（週、月都由它推），所以請求放那一天：`useAimLanding(["week"], setAnchor)` 收得到（日期的 periodOfKey＝week）
    useAimLandingStore.getState().request(day);
    await ui.setCalendarView(period);
    ui.setPage("calendar");
    return;
  }
  // 手機行程表那一行平常看週，月方針要打開月曆翻到那個月才看得到；開月曆是行程表的本地狀態，走請求槽（MobileSchedule 收，週方針收了關月曆）
  useAimLandingStore.getState().request(key);
  // 週那一行跟著捲到的那一天；串流掛上才收得到捲動請求（掛載前的請求它當舊的不跑），所以等這一輪畫完才發
  const schedule = useScheduleUiStore.getState();
  schedule.setMobileSub("schedule");
  schedule.setMobileLayout("stream");
  ui.setMobileTab("today");
  setTimeout(() => useScheduleUiStore.getState().requestScroll(day, false), 0);
}
