/**
 * scheduleUiStore——行程表（主線車次①）的介面狀態，zustand，**不持久化**（契約 §3.5）。
 *
 *   mobileSub   手機今日 tab 的子頁「今日｜行程表」（P4：同一次開啟期間記住；冷啟動＝today；切 tab、回前景都不換）
 *   focusDay    scroll-spy 的「目前捲到的那天」——週條 .is-sel、桌機頁首月份吃它；null＝串流沒掛
 *   scrollReq   跳轉請求（nonce 遞增；useStream 訂閱）——桌機頁首鈕、月曆覆蓋層、週條都經這裡
 *   expanded    攤開的空白日（評審 C4：捲遠再回來還是攤開的；活到 App 關掉）
 *   draftDay    草稿列開在哪一天（一次一張；D-主-8 點日期標題列建票）
 *   mobileLayout  手機行程表子頁「清單｜時段」（主線②；session 記憶，與 mobileSub 同款）
 *
 * 為什麼不進 uiStore：那是集中檔（並行地基契約 §13），本班不能動；而這幾格只有行程表讀寫。
 * 視窗（from／to）**不在這裡**——住 useStream 的本地 state（D-主-6：進頁起點永遠是今天）。
 */
import { create, type StoreApi, type UseBoundStore } from "zustand";
import { MOCK_MODE } from "../../data";
import { useUiStore } from "../../store/uiStore";
import { todayKey } from "../../lib/date";

export type MobileSub = "today" | "schedule";
/** 手機行程表子頁的版面：串流（清單）或 3 天時段（主線② D-主-11） */
export type MobileLayout = "stream" | "time";

export interface ScheduleUiState {
  /** 手機今日 tab 的子頁（P4：同一次開啟期間記住；冷啟動＝"today"） */
  mobileSub: MobileSub;
  setMobileSub(sub: MobileSub): void;
  /** scroll-spy 的「目前捲到的那天」（週條 .is-sel、桌機頁首月份）；null＝串流沒掛 */
  focusDay: string | null;
  setFocusDay(day: string | null): void;
  /** 跳轉請求（nonce 遞增；useStream 訂閱） */
  scrollReq: { day: string; smooth: boolean; nonce: number } | null;
  /** smooth 預設 true */
  requestScroll(day: string, smooth?: boolean): void;
  /** 攤開的空白日（評審 C4：捲遠再回來還是攤開的；活到 App 關掉） */
  expanded: ReadonlySet<string>;
  expandDays(days: readonly string[]): void;
  collapseDays(days: readonly string[]): void;
  /** 草稿列開在哪一天（一次一張；null＝沒有） */
  draftDay: string | null;
  setDraftDay(day: string | null): void;
  /** 手機行程表子頁：串流（清單）或 3 天時段（D-主-11；session 記憶，與 mobileSub 同款）。初值 "stream"；dev／mock：`?layout=time` */
  mobileLayout: MobileLayout;
  setMobileLayout(v: MobileLayout): void;
}

/**
 * dev／mock 專用：`?sub=schedule` 讓手機殼直接落在行程表子頁（截圖與預覽用）。
 * 不碰 `DEV_FLAGS`（data/index.ts 是集中檔）；正式打包（非 DEV 且非 mock）不生效。
 */
function detectInitialSub(): MobileSub {
  if (!import.meta.env.DEV && !MOCK_MODE) return "today";
  if (typeof window === "undefined") return "today";
  try {
    return new URLSearchParams(window.location.search).get("sub") === "schedule" ? "schedule" : "today";
  } catch {
    return "today";
  }
}

/** dev／mock 專用：`?layout=time` 讓手機行程表直接落在 3 天時段（與 `?sub=` 同款自讀；正式打包不生效） */
function detectInitialLayout(): MobileLayout {
  if (!import.meta.env.DEV && !MOCK_MODE) return "stream";
  if (typeof window === "undefined") return "stream";
  try {
    return new URLSearchParams(window.location.search).get("layout") === "time" ? "time" : "stream";
  } catch {
    return "stream";
  }
}

export const useScheduleUiStore: UseBoundStore<StoreApi<ScheduleUiState>> = create<ScheduleUiState>()((set, get) => ({
  mobileSub: detectInitialSub(),
  setMobileSub: (sub) => set({ mobileSub: sub }),

  focusDay: null,
  setFocusDay: (day) => {
    if (get().focusDay !== day) set({ focusDay: day });
  },

  scrollReq: null,
  requestScroll: (day, smooth = true) =>
    set((s) => ({ scrollReq: { day, smooth, nonce: (s.scrollReq?.nonce ?? 0) + 1 } })),

  // expanded 一律換新的 Set 實例（不就地改），讓 streamModel 的 memo 生效
  expanded: new Set<string>(),
  expandDays: (days) => {
    if (!days.length) return;
    const cur = get().expanded;
    if (days.every((d) => cur.has(d))) return;
    const next = new Set(cur);
    for (const d of days) next.add(d);
    set({ expanded: next });
  },
  collapseDays: (days) => {
    if (!days.length) return;
    const cur = get().expanded;
    if (!days.some((d) => cur.has(d))) return;
    const next = new Set(cur);
    for (const d of days) next.delete(d);
    set({ expanded: next });
  },

  draftDay: null,
  // P10 的最後一道守門：過去的日子不能開草稿（今天＝日界線今天，每次呼叫當下算）
  setDraftDay: (day) => {
    if (day !== null && day < todayKey(useUiStore.getState().dayStartHour)) return;
    set({ draftDay: day });
  },

  mobileLayout: detectInitialLayout(),
  setMobileLayout: (v) => set({ mobileLayout: v }),
}));
