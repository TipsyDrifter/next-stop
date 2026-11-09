/**
 * depotStore——車庫頁的資料＋駅スタンプ的偵測引擎（第五本第一梯 ③；契約 `docs/research/2026-11-02-主線-車庫與回顧-契約.md`）。
 *
 * 偵測（D-主-210～212）：
 *   - 時機：開 App（boot）、每次有 op 的寫入（`SYNC_WRITE_EVENT`，去抖 1.5 秒——済、到站、存日記、結束時間塊、記帳都會丟）、
 *     核心資料重載（nodeStore 的 routes／today 換了：同步拉回、各種 refresh 都會走到）、回到前景。
 *   - 一趟：事實 → detectStamps → keyStamps → 跟表裡的列 diff → 一個交易寫完 → 重讀章。同時只跑一趟，跑的時候又被叫＝跑完再補一趟。
 *   - 第一次（本機鍵 `stamps_backfilled` 沒有）＝回填：只寫、不通知，寫完記下鍵。之後每一趟「這台剛 insert／revive 的列」通知一次。
 *   - 通知交給 UI 層註冊的 notifier（`setStampNotifier`；toast 要畫一枚小章，store 不碰元件）。
 *
 * 車庫頁的資料（`load`）：章（活的、排好）、開業日、各路線済章數、全部済的日子、筆記摘要。頁開著才載；偵測寫了章順手重讀章。
 */
import { create } from "zustand";
import { SYNC_WRITE_EVENT, settingsRepo } from "../data";
import { depotRepo } from "../data/depotRepo";
import type { DepotData } from "../data/depotRepository";
import { compareStamps, detectStamps, diffStamps, isEmptyPlan, keyStamps, type KeyedStamp, type StampRow } from "../domain/stamps";
import { todayKey } from "../lib/date";
import { useNodeStore } from "./nodeStore";
import { useUiStore } from "./uiStore";

/** 本機鍵（不在同步白名單）：回填過了沒 */
export const KEY_STAMPS_BACKFILLED = "stamps_backfilled";
/** 本機鍵（不在同步白名單）：走行圖收起來的幹線（JSON 字串陣列）——兩台螢幕不一樣大，各記各的 */
export const KEY_MAP_FOLDED = "depot_map_folded";
const DEBOUNCE_MS = 1500;

export type DepotTab = "ride" | "map" | "year";

interface DepotState {
  /** 活的章，日期舊→新 */
  stamps: StampRow[];
  data: DepotData | null;
  loading: boolean;
  error: string | null;
  /** 頁內狀態：分頁籤、開著的記錄簿（路線 id；null＝沒開） */
  tab: DepotTab;
  bookId: string | null;
  /** 走行圖收起來的幹線（幹線 id） */
  mapFolded: readonly string[];
  setMapFolded: (ids: readonly string[]) => void;
  setTab: (t: DepotTab) => void;
  openBook: (routeId: string | null) => void;
  /** 載車庫頁的資料＋章 */
  load: () => Promise<void>;
  /** 跑一趟偵測（外部一般不必叫；boot 掛好的事件會叫） */
  check: () => Promise<void>;
  boot: () => void;
  stop: () => void;
}

type Notifier = (fresh: readonly KeyedStamp[]) => void;
let notifier: Notifier | null = null;
/** UI 層註冊蓋章 toast 的畫法（StampNotifier 元件） */
export function setStampNotifier(fn: Notifier | null): void {
  notifier = fn;
}

/** 讀不懂就當沒收過：收合只是版面偏好，不值得為它報錯 */
function parseFolded(raw: string | null): string[] {
  try {
    const v: unknown = JSON.parse(raw ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

let running: Promise<void> | null = null;
let again = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let offWrite: (() => void) | null = null;
let offNode: (() => void) | null = null;
let offVisible: (() => void) | null = null;

function schedule(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void useDepotStore.getState().check();
  }, DEBOUNCE_MS);
}

const alive = (rows: StampRow[]) => rows.filter((r) => r.deleted_at === null).sort(compareStamps);

async function runOnce(): Promise<void> {
  const h = useUiStore.getState().dayStartHour;
  const today = todayKey(h);
  const [facts, rows, flag] = await Promise.all([
    depotRepo.stampFacts(today, h),
    depotRepo.listStamps(),
    settingsRepo.get(KEY_STAMPS_BACKFILLED).catch(() => null),
  ]);
  const desired = await keyStamps(detectStamps(facts));
  const plan = diffStamps(desired, rows, facts);
  const backfill = flag !== "1";
  if (!isEmptyPlan(plan)) {
    await depotRepo.applyStampPlan(plan);
    if (!backfill) {
      const fresh = [...plan.insert, ...plan.revive];
      if (fresh.length) notifier?.(fresh);
    }
    useDepotStore.setState({ stamps: alive(await depotRepo.listStamps()) });
  } else {
    useDepotStore.setState({ stamps: alive(rows) });
  }
  if (backfill) await settingsRepo.set(KEY_STAMPS_BACKFILLED, "1").catch(() => undefined);
}

export const useDepotStore = create<DepotState>((set, get) => ({
  stamps: [],
  data: null,
  loading: false,
  error: null,
  tab: (() => {
    const saved = useUiStore.getState().readLastNav?.().depotTab;
    return saved === "ride" || saved === "map" || saved === "year" ? saved : "ride";
  })(),
  bookId: null,
  mapFolded: [],

  setMapFolded(ids) {
    set({ mapFolded: ids });
    void settingsRepo.set(KEY_MAP_FOLDED, JSON.stringify(ids)).catch(() => undefined);
  },

  setTab(t) {
    set({ tab: t, bookId: null });
    useUiStore.getState().writeLastNav?.({ depotTab: t });
  },

  openBook(routeId) {
    set({ bookId: routeId });
  },

  async load() {
    set({ loading: get().data === null });
    try {
      const h = useUiStore.getState().dayStartHour;
      const [data, rows, folded] = await Promise.all([
        depotRepo.loadDepot(h),
        depotRepo.listStamps(),
        settingsRepo.get(KEY_MAP_FOLDED).catch(() => null),
      ]);
      set({ data, stamps: alive(rows), mapFolded: parseFolded(folded), loading: false, error: null });
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : String(e) });
    }
  },

  async check() {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          await runOnce();
        } while (again);
      } catch (e) {
        console.warn("[next-stop] 駅スタンプ偵測失敗：", e instanceof Error ? e.message : String(e));
      } finally {
        running = null;
      }
    })();
    return running;
  },

  boot() {
    if (offWrite) return; // 可重入（StrictMode 雙掛載）
    const onWrite = () => schedule();
    window.addEventListener(SYNC_WRITE_EVENT, onWrite);
    offWrite = () => window.removeEventListener(SYNC_WRITE_EVENT, onWrite);
    // 核心重載（同步拉回、各種 refresh）：路線清單或今日聚合換了就再看一次；記憶體版（?mock=1）不丟寫入事件，也靠這條
    offNode = useNodeStore.subscribe((s, p) => {
      if (s.routes !== p.routes || s.stations !== p.stations || s.today !== p.today) schedule();
    });
    const onVisible = () => {
      if (document.visibilityState === "visible") schedule();
    };
    document.addEventListener("visibilitychange", onVisible);
    offVisible = () => document.removeEventListener("visibilitychange", onVisible);
    void get().check();
  },

  stop() {
    offWrite?.();
    offNode?.();
    offVisible?.();
    offWrite = offNode = offVisible = null;
    if (timer) clearTimeout(timer);
    timer = null;
  },
}));
