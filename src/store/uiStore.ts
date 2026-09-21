/**
 * uiStore——介面狀態：目前頁／選取／zoom／摺疊／側板／覆蓋層（toast、確認窗、快速跳轉、設定、完成卡、路線 dialog）／主題／日界線。
 * 主題與日界線持久化到 settings（經 repository）。
 *
 * 主題（M3 ② 換裝後）：偏好值＝pastel（粉彩星空）／galaxy（銀河鐵道）／system；
 * DOM 契約不變，仍寫 <html data-theme="light|dark">——galaxy ＝ dark，全站 CSS 選擇器不用動。
 * settings 表裡的 M2 舊值（light／dark）啟動時自動遷移成新值（見 normalizeTheme）。
 */
import { create } from "zustand";
import { settingsRepo, DEV_FLAGS, MOCK_MODE } from "../data";
// type-only import：不產生執行期依賴，store 不會因此被拉進 ui 層（registry 的真相仍在 tabs.ts）
import type { MobileTabKey } from "../ui/mobile/tabs";

export type ThemePref = "pastel" | "galaxy" | "system";

/**
 * 頁面（gnav 第一欄三頁；決策記錄 r5／Q3、規格書 §3 全域導航）。
 * M3 ⑤ 起三頁全通車（gnav 三枚都可點、Ctrl+1/2/3 直接換頁）。
 * 啟動落點＝today（決策 #12「首頁＝今日視圖」）；dev／mock 可用 `?page=` 換落點（DEV_FLAGS）。
 * 頁務件隨頁：側欄「我的路線」點路線＝切 routemap 並開該路線。
 */
export type PageId = "today" | "routemap" | "calendar";

/** 日曆視圖形態（D-⑤-1 甲：月／週同一套格語彙，週＝一列七欄放大版）；預設月、切換記憶 */
export type CalendarView = "month" | "week";

/**
 * 設定頁的分頁（D-⑥-7 三籤；SettingsPanel 的 TABS 照這個型別）。
 * 放在 store 而不是 SettingsPanel 的本地 state，是因為「開設定到指定籤」要能從外面叫——
 * M3 ⑥ 的失敗 toast／啟動橫幅按下去要直接落在「備份與還原」那一籤（不記憶，每次開都吃傳進來的值）。
 */
// v1.1.1 加第四籤 "sync"（同步；契約席先把型別與籤位立好、SettingsPanel 先 disabled，WP8 通車時打開）
export type SettingsTab = "general" | "backup" | "hotkeys" | "sync";

export interface ToastState {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}

export interface ConfirmState {
  title: string;
  body?: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
}

export interface RouteDialogState {
  /** 新增路線時的所屬幹線；新增幹線＝null */
  lineId: string | null;
  /** 編輯既有幹線／路線時的 id；新增＝null */
  editId: string | null;
}

const KEY_THEME = "theme";
const KEY_DAY_START = "day_start_hour";
/** 今日視圖誤點區的摺疊狀態（r1「誤點 N 件」可摺疊、**記憶狀態**）；"1"＝收起 */
const KEY_LATE_COLLAPSED = "today_late_collapsed";
/** 日曆視圖形態（r4「預設月視圖＋記憶切換」，D-⑤-1）；"week"＝週，其餘一律月 */
const KEY_CALENDAR_VIEW = "calendar_view";

function applyTheme(pref: ThemePref) {
  const root = document.documentElement;
  const dark =
    pref === "galaxy" ||
    (pref === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  root.setAttribute("data-theme", dark ? "dark" : "light");
}

/** settings 表的字串 → ThemePref；含 M2 舊值遷移（light＝旅の手帖→粉彩星空、dark＝月白→銀河鐵道） */
function normalizeTheme(raw: string | null): ThemePref {
  switch (raw) {
    case "pastel":
    case "galaxy":
    case "system":
      return raw;
    case "light":
      return "pastel";
    case "dark":
      return "galaxy";
    default:
      return "system";
  }
}

/**
 * dev／mock 專用的主題覆寫：`?theme=pastel|galaxy`。
 * 給 headless 截圖與比稿對照用——蓋過 settings 讀到的值，但**不寫回** settings，
 * 關掉參數就回到主人自己的設定。正式打包（非 DEV 且非 mock）不生效。
 */
function detectThemeOverride(): ThemePref | null {
  if (!import.meta.env.DEV && !MOCK_MODE) return null;
  if (typeof window === "undefined") return null;
  try {
    const raw = new URLSearchParams(window.location.search).get("theme");
    return raw === "pastel" || raw === "galaxy" ? raw : null;
  } catch {
    return null;
  }
}

const THEME_OVERRIDE: ThemePref | null = detectThemeOverride();

// 覆寫存在就搶在第一次繪製前套上，避免 loadSettings 回來之前閃一下預設主題
if (THEME_OVERRIDE && typeof document !== "undefined") applyTheme(THEME_OVERRIDE);

let toastTimer: ReturnType<typeof setTimeout> | null = null;

interface UiStore {
  page: PageId;
  /**
   * 手機殼底部 tab 的落點（v1.1.0 D-1.1-2；值域＝tabs.ts 的 registry key）。
   *
   * 為什麼與桌機 `page` 分成兩個欄位：PageId 沒有 notes／timetable／more，硬共用會讓 setPage
   * 的型別鬆掉、Ctrl+1/2/3 也得多判一層。兩殼永不同時渲染（useShell 只回一個），各記各的落點最省。
   *
   * **不持久化**（不寫 settings）：手機每次開 App 都落在今日，與桌機 `page` 的啟動落點一致（決策 #12）。
   */
  mobileTab: MobileTabKey;
  selectedId: string | null;
  zoomId: string | null;
  collapsed: Record<string, boolean>;
  panelOpen: boolean;
  hideDone: boolean;
  toast: ToastState | null;
  confirm: ConfirmState | null;
  quickJumpOpen: boolean;
  settingsOpen: boolean;
  /** 設定頁停在哪一籤（M3 ⑥；SettingsPanel 唯一來源） */
  settingsTab: SettingsTab;
  /**
   * 快捷鍵指引疊層（M3 ⑦；`?` 導航模式／`Ctrl+/` IME 備援開關）。
   * **與設定、快速跳轉互斥**——三者都是 DialogShell，兩層同開會互搶 window 層的 Esc（草案 §0-6）；
   * 互斥寫在下面幾個 setter 裡，不靠元件的時序或 stopPropagation。
   */
  hotkeyGuideOpen: boolean;
  completeCardFor: string | null;
  routeDialog: RouteDialogState | null;
  theme: ThemePref;
  dayStartHour: number;
  /** 今日視圖：誤點區是否收起（持久化 settings key today_late_collapsed；M3 ③ r1） */
  lateCollapsed: boolean;
  /** 日曆視圖：月／週（持久化 settings key calendar_view；M3 ⑤ D-⑤-1） */
  calendarView: CalendarView;

  setPage: (page: PageId) => void;
  setMobileTab: (tab: MobileTabKey) => void;
  select: (id: string | null) => void;
  setZoom: (id: string | null) => void;
  toggleCollapsed: (id: string) => void;
  setCollapsed: (id: string, value: boolean) => void;
  /** 展開一串祖先（快速跳轉／搜尋定位用） */
  expand: (ids: string[]) => void;
  setPanelOpen: (open: boolean) => void;
  toggleHideDone: () => void;
  showToast: (toast: ToastState, ttlMs?: number) => void;
  hideToast: () => void;
  askConfirm: (confirm: ConfirmState) => void;
  closeConfirm: () => void;
  setQuickJumpOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setSettingsTab: (tab: SettingsTab) => void;
  /** 開設定並直接落在指定的籤（M3 ⑥ 失敗 toast 的「看原因」、啟動橫幅的「開啟設定」） */
  openSettings: (tab?: SettingsTab) => void;
  setHotkeyGuideOpen: (open: boolean) => void;
  toggleHotkeyGuide: () => void;
  setCompleteCardFor: (id: string | null) => void;
  openRouteDialog: (state: RouteDialogState) => void;
  closeRouteDialog: () => void;
  setTheme: (pref: ThemePref) => Promise<void>;
  setDayStartHour: (hour: number) => Promise<void>;
  setLateCollapsed: (collapsed: boolean) => Promise<void>;
  setCalendarView: (view: CalendarView) => Promise<void>;
  loadSettings: () => Promise<void>;
}

export const useUiStore = create<UiStore>((set, get) => ({
  // 起始頁＝today（決策 #12）；`?page=` 只在 dev／mock 生效（DEV_FLAGS，見 data/index.ts）
  page: DEV_FLAGS.page ?? "today",
  // ＝tabs.ts 的 DEFAULT_MOBILE_TAB；這裡寫字面值而不 import 常數，是為了讓 store 只吃 type-only import
  mobileTab: "today",
  selectedId: null,
  zoomId: null,
  collapsed: {},
  panelOpen: false,
  hideDone: false,
  toast: null,
  confirm: null,
  quickJumpOpen: false,
  settingsOpen: false,
  settingsTab: "general",
  hotkeyGuideOpen: false,
  completeCardFor: null,
  routeDialog: null,
  theme: THEME_OVERRIDE ?? "system",
  dayStartHour: 3,
  lateCollapsed: false,
  calendarView: DEV_FLAGS.view ?? "month",

  setPage: (page) => set({ page }),
  // 切頁順手收掉桌機專屬疊層：手機殼本來就不掛它們，這是保險不是功能（藍牙鍵盤按到 ? 或 Ctrl+P 時）
  setMobileTab: (tab) => set({ mobileTab: tab, hotkeyGuideOpen: false, quickJumpOpen: false }),
  select: (id) => set({ selectedId: id }),
  setZoom: (id) => set({ zoomId: id }),
  toggleCollapsed: (id) =>
    set((s) => ({ collapsed: { ...s.collapsed, [id]: !s.collapsed[id] } })),
  setCollapsed: (id, value) =>
    set((s) => ({ collapsed: { ...s.collapsed, [id]: value } })),
  expand: (ids) =>
    set((s) => {
      const next = { ...s.collapsed };
      for (const id of ids) next[id] = false;
      return { collapsed: next };
    }),
  setPanelOpen: (open) => set({ panelOpen: open }),
  toggleHideDone: () => set((s) => ({ hideDone: !s.hideDone })),

  showToast(toast, ttlMs = 10_000) {
    if (toastTimer) clearTimeout(toastTimer);
    set({ toast });
    toastTimer = setTimeout(() => set({ toast: null }), ttlMs);
  },
  hideToast() {
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = null;
    set({ toast: null });
  },

  askConfirm: (confirm) => set({ confirm }),
  closeConfirm: () => set({ confirm: null }),
  // 三個「開」的動作都順手收掉快捷鍵指引疊層（互斥，見 hotkeyGuideOpen 的說明）
  setQuickJumpOpen: (open) =>
    set(open ? { quickJumpOpen: true, hotkeyGuideOpen: false } : { quickJumpOpen: false }),
  setSettingsOpen: (open) =>
    set(open ? { settingsOpen: true, hotkeyGuideOpen: false } : { settingsOpen: false }),
  setSettingsTab: (tab) => set({ settingsTab: tab }),
  openSettings: (tab = "general") =>
    set({ settingsOpen: true, settingsTab: tab, hotkeyGuideOpen: false }),
  // 反過來，開疊層先收快速跳轉（設定那邊由 Ctrl+/ 改切籤，不會走到這裡）
  setHotkeyGuideOpen: (open) =>
    set(open ? { hotkeyGuideOpen: true, quickJumpOpen: false } : { hotkeyGuideOpen: false }),
  toggleHotkeyGuide: () =>
    set((s) =>
      s.hotkeyGuideOpen
        ? { hotkeyGuideOpen: false }
        : { hotkeyGuideOpen: true, quickJumpOpen: false },
    ),
  setCompleteCardFor: (id) => set({ completeCardFor: id }),
  openRouteDialog: (state) => set({ routeDialog: state }),
  closeRouteDialog: () => set({ routeDialog: null }),

  async setTheme(pref) {
    applyTheme(pref);
    set({ theme: pref });
    await settingsRepo.set(KEY_THEME, pref);
  },

  async setDayStartHour(hour) {
    set({ dayStartHour: hour });
    await settingsRepo.set(KEY_DAY_START, String(hour));
  },

  async setLateCollapsed(collapsed) {
    set({ lateCollapsed: collapsed });
    await settingsRepo.set(KEY_LATE_COLLAPSED, collapsed ? "1" : "0");
  },

  async setCalendarView(view) {
    set({ calendarView: view });
    await settingsRepo.set(KEY_CALENDAR_VIEW, view);
  },

  async loadSettings() {
    // 先套預設主題，再讀設定（讀不到——例如非 Tauri 環境預覽——也不讓畫面裸奔）
    applyTheme(get().theme);
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (get().theme === "system") applyTheme("system");
    });
    try {
      const [theme, dayStart, lateCollapsed, calendarView] = await Promise.all([
        settingsRepo.get(KEY_THEME),
        settingsRepo.get(KEY_DAY_START),
        settingsRepo.get(KEY_LATE_COLLAPSED),
        settingsRepo.get(KEY_CALENDAR_VIEW),
      ]);
      const pref: ThemePref = THEME_OVERRIDE ?? normalizeTheme(theme);
      applyTheme(pref);
      set({
        theme: pref,
        dayStartHour: dayStart ? Number(dayStart) || 3 : 3,
        lateCollapsed: lateCollapsed === "1",
        // `?view=` 蓋過設定但不寫回（與 THEME_OVERRIDE 同款，關掉參數就回主人自己的偏好）
        calendarView: DEV_FLAGS.view ?? (calendarView === "week" ? "week" : "month"),
      });
    } catch {
      // 設定讀取失敗不致命：維持預設（跟隨系統、03:00）
    }
  },
}));
