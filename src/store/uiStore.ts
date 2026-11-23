/**
 * uiStore——介面狀態：目前頁／選取／zoom／摺疊／側板／覆蓋層（toast、確認窗、快速跳轉、設定、完成卡、路線 dialog）／主題／日界線。
 * 主題與日界線持久化到 settings（經 repository）。
 *
 * 主題（M3 ② 換裝後）：偏好值＝pastel（粉彩星空）／galaxy（銀河鐵道）／system；
 * DOM 契約不變，仍寫 <html data-theme="light|dark">——galaxy ＝ dark，全站 CSS 選擇器不用動。
 * settings 表裡的 M2 舊值（light／dark）啟動時自動遷移成新值（見 normalizeTheme）。
 */
import { create } from "zustand";
import type { ReactNode } from "react";
import { settingsRepo, DEV_FLAGS, MOCK_MODE } from "../data";
import { isSkinId, skinById, type SkinId } from "../lib/themeShop";
import {
  DEFAULT_THEME_SYSTEM_CONFIG,
  KAMAKURA_TIME_CACHE_KEY,
  THEME_CONFIG_CACHE_KEY,
  isKamakuraDarkAt,
  isKamakuraTimePref,
  legacyThemeValueOf,
  localNowMinutes,
  nextConfigOnPickTheme,
  nextConfigOnSetDarkPref,
  nextConfigOnSetLightPref,
  nextConfigOnSetMode,
  nextConfigOnTogglePair,
  normalizeThemeHm,
  parseThemeSystemSettings,
  resolveThemeSystem,
  serializeThemeCache,
  type ConcreteThemeId,
  type DarkThemeId,
  type KamakuraTimePref,
  type LightThemeId,
  type ResolvedThemeState,
  type ThemeMode,
  type ThemeSystemConfig,
} from "../lib/themeSystem";
import { syncWindowTheme } from "../lib/windowTheme";
import { isCaptureWindow } from "../ui/notes/capture-window/shell";
import { useHandFontStore } from "./handFontStore";
import { useSelectionStore } from "./selectionStore";
// type-only import：不產生執行期依賴，store 不會因此被拉進 ui 層（registry 的真相仍在 tabs.ts）
import type { MobileTabKey } from "../ui/mobile/tabs";
// 頁面登記表（並行地基・契約 §6）：純資料模組，不拉 React／DOM
import { DEFAULT_PAGE, pageById, type PageId } from "../ui/shell/pages";
import { DEFAULT_DAY_START_HOUR, parseDayStartHour } from "../lib/date";

export type ThemePref = "pastel" | "galaxy" | "system" | SkinId;

/**
 * 頁面（gnav 第一欄三頁；決策記錄 r5／Q3、規格書 §3 全域導航）。
 * M3 ⑤ 起三頁全通車（gnav 三枚都可點、Ctrl+1/2/3 直接換頁）。
 * 啟動落點＝today（決策 #12「首頁＝今日視圖」）；dev／mock 可用 `?page=` 換落點（DEV_FLAGS）。
 * 頁務件隨頁：側欄「我的路線」點路線＝切 routemap 並開該路線。
 * 並行地基（契約 §6）：頁的清單搬到 `ui/shell/pages.ts`（核心三頁＋三條功能線）；型別含六個 id，
 * 執行期只有已通車（open）的頁能被 `setPage` 與 `?page=` 接受（契約決策 8）。
 */
export type { PageId } from "../ui/shell/pages";

/** 日曆視圖形態（D-⑤-1 甲：月／週同一套格語彙，週＝一列七欄放大版）；預設月、切換記憶 */
export type CalendarView = "month" | "week" | "time" | "stream";

/**
 * 設定頁的分頁（D-⑥-7 三籤；SettingsPanel 的 TABS 照這個型別）。
 * 放在 store 而不是 SettingsPanel 的本地 state，是因為「開設定到指定籤」要能從外面叫——
 * M3 ⑥ 的失敗 toast／啟動橫幅按下去要直接落在「備份與還原」那一籤（不記憶，每次開都吃傳進來的值）。
 */
// v1.1.1 加第四籤 "sync"（同步；契約席先把型別與籤位立好、SettingsPanel 先 disabled，WP8 通車時打開）
export type SettingsTab = "general" | "reminders" | "backup" | "hotkeys" | "sync" | "assistant" | "lostfound" | "shortcuts";

export interface ToastState {
  message: string;
  /** 第二行小字（墨色淡一階）；沒有＝只有一行主訊息（時刻表⑤〈原型定案〉1；UI 丙-1 從 Toast.tsx 的 module augmentation 搬進本體） */
  sub?: string;
  actionLabel?: string;
  onAction?: () => void;
  /** 訊息左邊的小圖（車庫與回顧 D-主-212：蓋章 toast 帶一枚小章）；沒有＝不畫 */
  lead?: ReactNode;
}

export interface ConfirmState {
  title: string;
  body?: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  /**
   * v1.1.6（重新開始契約 §5）：要主人逐字打出這個詞才能按確認（危險區用「清空」）。
   * 有值時確認鈕 disabled 直到 `輸入.trim() === typeToConfirm`；Enter 在不相符時不確認、不關窗。
   * 沒帶＝與 v1.1.5 以前逐字相同的兩鍵確認窗（F1／F3／還原／重新加入都不受影響）。
   */
  typeToConfirm?: string;
  /** 輸入框上方那一句（預設 `輸入「{typeToConfirm}」才能按下去`） */
  typeHint?: string;
  // UI 丙-1（視覺規範 §2.3）：舊的 `tone?: "seal" | "gold"`（接縫 #74 的金框確認鈕）退役——ConfirmDialog 不再讀它，
  // 定期帳那一顆改成一般確認框（主鈕＝實心墨，本來就不是朱），兩個呼叫端也已拿掉；欄位刪掉，免得有人再傳。
}

export interface RouteDialogState {
  /** 新增路線時的所屬幹線；新增幹線＝null */
  lineId: string | null;
  /** 編輯既有幹線／路線時的 id；新增＝null */
  editId: string | null;
}

const KEY_THEME = "theme";
const KEY_THEME_MODE = "theme_mode";
const KEY_THEME_LIGHT_PREF = "theme_light_pref";
const KEY_THEME_DARK_PREF = "theme_dark_pref";
const KEY_THEME_MANUAL_POLARITY = "theme_manual_polarity";
const KEY_THEME_MANUAL_OVERRIDE = "theme_manual_override";
const KEY_THEME_DAY_HM = "theme_day_start_hm";
const KEY_THEME_NIGHT_HM = "theme_night_start_hm";
const KEY_DAY_START = "day_start_hour";
/**
 * 日界線預設 06:00（主人 2026-10-06 拍板 D-時-21；由時刻表線①a 順帶改，契約 §6.2-3）。
 * 之前是 03:00；`src/lib/date.ts` 等處的 `dayStartHour = 3` 參數預設值不動（呼叫端都有傳）。
 * 收官磨光 A4：定義搬到 lib/date（data 層的讀取面守門也要讀它），這裡轉出口、呼叫端 import 不動。
 */
export { DEFAULT_DAY_START_HOUR };
/** 今日視圖誤點區的摺疊狀態（r1「誤點 N 件」可摺疊、**記憶狀態**）；"1"＝收起 */
const KEY_LATE_COLLAPSED = "today_late_collapsed";
/** 日曆視圖形態（r4「預設月視圖＋記憶切換」，D-⑤-1）；"week"＝週／"time"＝時段／"stream"＝串流，其餘一律月 */
const KEY_CALENDAR_VIEW = "calendar_view";
/** 每週從星期幾開始（旅客筆記車次② D-筆-29）：JS getDay() 數字字串，"1"＝一、"0"＝日 */
const KEY_WEEK_START = "week_start";
/** 已完成開關（回饋甲 D-主-131）：今日／路線圖各記各的；"1"＝隱藏。螢幕偏好不同步（D-1.1-3：不在 syncSettingsKeys 白名單） */
const KEY_TODAY_HIDE_DONE = "today_hide_done";
const KEY_OUTLINE_HIDE_DONE = "outline_hide_done";

/** settings 字串 → 週首：只認 "0"（週日），其餘（沒寫、舊值、亂值）一律 1＝週一 */
function normalizeWeekStart(raw: string | null): 0 | 1 {
  return raw === "0" ? 0 : 1;
}

/**
 * dev／mock 專用的主題覆寫：`?theme=pastel|galaxy|techo|sleeper|moonlight|yumemi|kamakura`。
 * 給 headless 截圖與比稿對照用——蓋過 settings 讀到的值，但**不寫回** settings，
 * 關掉參數就回到主人自己的設定。正式打包（非 DEV 且非 mock）不生效。
 */
function detectThemeOverride(): ConcreteThemeId | null {
  if (!import.meta.env.DEV && !MOCK_MODE) return null;
  if (typeof window === "undefined") return null;
  try {
    const raw = new URLSearchParams(window.location.search).get("theme");
    return raw === "pastel" || raw === "galaxy" || isSkinId(raw) ? raw : null;
  } catch {
    return null;
  }
}

const THEME_OVERRIDE: ConcreteThemeId | null = detectThemeOverride();

function readSystemDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return false;
  }
}

function readKamakuraTime(): KamakuraTimePref | null {
  if (typeof window === "undefined" || typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(KAMAKURA_TIME_CACHE_KEY);
    return isKamakuraTimePref(raw) ? raw : null;
  } catch {
    return null;
  }
}

function resolveForCurrentEnv(config: ThemeSystemConfig): ResolvedThemeState {
  const nowMinutes = localNowMinutes(new Date());
  const kamakuraTime = readKamakuraTime();
  if (THEME_OVERRIDE) {
    if (THEME_OVERRIDE === "kamakura") {
      const dark = isKamakuraDarkAt(nowMinutes, kamakuraTime);
      const pol = dark ? "dark" : "light";
      return {
        dataTheme: pol,
        dataSkin: "kamakura",
        kamakuraRole: "full",
        activeThemeId: "kamakura",
        windowTheme: pol,
      };
    }
    const skin = skinById(THEME_OVERRIDE);
    const dark = skin ? skin.base === "dark" : THEME_OVERRIDE === "galaxy";
    const pol = dark ? "dark" : "light";
    return {
      dataTheme: pol,
      dataSkin: skin ? skin.id : null,
      kamakuraRole: null,
      activeThemeId: THEME_OVERRIDE,
      windowTheme: pol,
    };
  }
  return resolveThemeSystem(config, {
    systemDark: readSystemDark(),
    nowMinutes,
    kamakuraTime,
  });
}

let transitionClearTimer: ReturnType<typeof setTimeout> | null = null;

function applyResolvedToDom(config: ThemeSystemConfig, animate: boolean): ResolvedThemeState {
  const resolved = resolveForCurrentEnv(config);
  if (typeof document === "undefined") return resolved;

  const root = document.documentElement;
  const prevTheme = root.getAttribute("data-theme");
  const prevSkin = root.getAttribute("data-skin");
  const prevRole = root.getAttribute("data-kamakura-role");
  const changed = prevTheme !== resolved.dataTheme || prevSkin !== resolved.dataSkin;

  if (animate && changed) {
    root.setAttribute("data-theme-transition", "1");
    if (transitionClearTimer) clearTimeout(transitionClearTimer);
    transitionClearTimer = setTimeout(() => {
      root.removeAttribute("data-theme-transition");
      transitionClearTimer = null;
    }, 320);
  }

  if (resolved.kamakuraRole) {
    if (prevRole !== resolved.kamakuraRole) root.setAttribute("data-kamakura-role", resolved.kamakuraRole);
  } else if (prevRole !== null) {
    root.removeAttribute("data-kamakura-role");
  }
  if (prevTheme !== resolved.dataTheme) {
    root.setAttribute("data-theme", resolved.dataTheme);
  }
  if (resolved.dataSkin) {
    if (prevSkin !== resolved.dataSkin) root.setAttribute("data-skin", resolved.dataSkin);
  } else if (prevSkin !== null) {
    root.removeAttribute("data-skin");
  }

  syncWindowTheme(resolved.windowTheme);

  // 快取只由主視窗寫，且 ?theme= 覆寫不蓋掉主人自己的偏好
  if (!THEME_OVERRIDE && !isCaptureWindow()) {
    try {
      localStorage.setItem(THEME_CONFIG_CACHE_KEY, serializeThemeCache(config));
      localStorage.setItem("ns-theme-resolved", resolved.dataTheme);
      if (resolved.dataSkin) localStorage.setItem("ns-skin-resolved", resolved.dataSkin);
      else localStorage.removeItem("ns-skin-resolved");
    } catch {
      /* 沒有快取只是開頁慢一拍套主題 */
    }
  }
  return resolved;
}

async function persistThemeConfig(config: ThemeSystemConfig, resolved: ResolvedThemeState): Promise<void> {
  const legacy = legacyThemeValueOf(config, resolved);
  await Promise.all([
    settingsRepo.set(KEY_THEME, legacy),
    settingsRepo.set(KEY_THEME_MODE, config.mode),
    settingsRepo.set(KEY_THEME_LIGHT_PREF, config.lightPref),
    settingsRepo.set(KEY_THEME_DARK_PREF, config.darkPref),
    settingsRepo.set(KEY_THEME_MANUAL_POLARITY, config.manualPolarity),
    settingsRepo.set(KEY_THEME_MANUAL_OVERRIDE, config.manualOverride ?? ""),
    settingsRepo.set(KEY_THEME_DAY_HM, config.dayStartHm),
    settingsRepo.set(KEY_THEME_NIGHT_HM, config.nightStartHm),
  ]);
}

const LAST_NAV_KEY = "ns.lastNav.v1";

export type MobileMoreView = "more" | "sync" | "backup" | "gestures" | "lostfound" | "reminders" | "shortcuts" | "shop";

export interface LastNavState {
  page?: PageId;
  routeOverview?: boolean;
  routeId?: string | null;
  mobileTab?: MobileTabKey;
  mobileMoreView?: MobileMoreView;
  notesSection?: "inbox" | "notes" | "diary" | "tags";
  selectedNoteId?: string | null;
  depotTab?: "ride" | "map" | "year";
  waitroomFilter?: string;
  sidebarCollapsed?: boolean;
}

export function readLastNav(): LastNavState {
  if (typeof window === "undefined" || typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(LAST_NAV_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as LastNavState) : {};
  } catch {
    return {};
  }
}

export function writeLastNav(patch: Partial<LastNavState>): void {
  if (typeof window === "undefined" || typeof localStorage === "undefined") return;
  try {
    const cur = readLastNav();
    localStorage.setItem(LAST_NAV_KEY, JSON.stringify({ ...cur, ...patch }));
  } catch {
    /* localStorage 不可用時略過 */
  }
}

// 覆寫存在就搶在第一次繪製前套上，避免 loadSettings 回來之前閃一下預設主題
if (THEME_OVERRIDE && typeof document !== "undefined") {
  applyResolvedToDom(DEFAULT_THEME_SYSTEM_CONFIG, false);
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
let systemThemeWatched = false;
let scheduleMinuteTimer: ReturnType<typeof setTimeout> | null = null;

function stopThemeClockTimer(): void {
  if (scheduleMinuteTimer) {
    clearTimeout(scheduleMinuteTimer);
    scheduleMinuteTimer = null;
  }
}

function syncThemeClockTimer(mode: ThemeMode, tick: () => void): void {
  stopThemeClockTimer();
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (mode !== "schedule" && mode !== "kamakura" && THEME_OVERRIDE !== "kamakura") return;
  if (document.hidden) return;
  const msToNextMinute = 60_000 - (Date.now() % 60_000) + 60;
  scheduleMinuteTimer = setTimeout(() => {
    scheduleMinuteTimer = null;
    tick();
  }, msToNextMinute);
}

interface UiStore {
  page: PageId;
  /**
   * 桌機路線圖頁正在看「路線一覽」（丁 D-主-239）：true＝一覽、false＝目前那條路線的大綱。不存設定。
   * gnav「路線圖」、Ctrl+2、大綱麵包屑「路線圖」＝`openRouteMap()`（進一覽）；`nodeStore.openRoute(id)`＝看那條路線（離開一覽，
   * 開 App 自動開第一條、同步或刪除後換路線帶 `keepView` 不動它）。手機的第一層是 MobileRouteMap 自己記的，不看這個。
   */
  routeOverview: boolean;
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
  /** 桌機左側書封是否收合（持久化至 ns.lastNav.v1；預設展開 false） */
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebarCollapsed: () => void;
  /** 路線圖：已完成收起（持久化 settings key outline_hide_done；預設收起） */
  hideDone: boolean;
  /** 今日「今天的列車」：已完成收起（持久化 settings key today_hide_done；預設顯示＝済票留原位到日界線；回饋甲 D-主-131） */
  todayHideDone: boolean;
  toggleTodayHideDone: () => void;
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
  /** 當前實際生效的主題 ID（粉彩／銀河／5 套商店主題），供書封腳與氛圍層直接訂閱 */
  theme: ThemePref;
  /** v1.34 4A：時光主題配對與四模式設定完整狀態 */
  themeConfig: ThemeSystemConfig;
  /** 當前 `<html data-theme>` 是否為 `"dark"` */
  resolvedDark: boolean;
  dayStartHour: number;
  /** 今日視圖：誤點區是否收起（持久化 settings key today_late_collapsed；M3 ③ r1） */
  lateCollapsed: boolean;
  /** 日曆視圖：月／週／time＝時段／stream＝串流（持久化 settings key calendar_view；M3 ⑤ D-⑤-1、主線車次①） */
  calendarView: CalendarView;
  /**
   * 每週從星期幾開始（持久化 settings key week_start；旅客筆記車次② D-筆-29）：JS `getDay()` 的值，
   * 1＝週一（預設）、0＝週日。讀的人：旅客筆記月曆（純函式吃這個參數）、日曆視圖的欄序（整合席接）。
   */
  weekStart: 0 | 1;
  /**
   * v1.1.5（契約 §2）：主畫面同步橫幅要顯示哪一種告警；null＝沒有。**由 syncStore 的轉變偵測寫**（`evaluateAlerts`），
   * 值＝`SyncAlertKind`（型別住 syncStore，這裡用 string 免得 store 互相 import 型別以外的東西）。
   * 狀態解除（syncStore 算出 null）就自動消失。
   */
  syncBanner: string | null;
  /**
   * v1.1.5 D-1.1.5-2（主人拍板「可以關、下次啟動再出」）：主人按了「先收起」的那一種告警。
   * **只活在本次啟動**（不寫 settings）；同種告警不再出、換一種就再出；重開 App 狀態未解除就重出。
   */
  syncBannerDismissed: string | null;
  /**
   * v1.1.5：手機殼「前往同步」的深連結——橫幅在任何 tab 都可能出現，要能一鍵落到「更多 › 同步」。
   * MobileMore 掛載／看到它非 null 就切到 `MobileSync` 並清掉（消費一次）。桌機用 `openSettings("sync")`，不走這個。
   * 收官磨光 Q2-a：多一種 "backup"（備份失敗 toast 的「看原因」落到「更多 › 備份與還原」）。
   */
  mobileMoreRequest: "sync" | "backup" | "reminders" | null;
  /**
   * 日曆格內記號的「請重查」計數（接縫 #62；旅客筆記車次④ 0-14）：`useCalendarController` 的記號 effect 把它列進依賴；
   * 線在日記資料變了（同步拉到、本機寫了日記）時呼叫 `bumpCalendarMarks()` ⇒ 目前這個區間的記號重查一次。
   * 沒有線登記記號時 effect 一開頭就返回，所以沒人 bump 或沒有線填值都零成本。
   */
  calendarMarksTick: number;

  setPage: (page: PageId) => void;
  /** 進路線一覽（丁 D-主-239）：切到路線圖頁＋一覽，收掉聚焦、選取與側板（一覽沒有選中的東西） */
  openRouteMap: () => void;
  setRouteOverview: (on: boolean) => void;
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
  setThemeMode: (mode: ThemeMode) => Promise<void>;
  setLightThemePref: (id: LightThemeId) => Promise<void>;
  setDarkThemePref: (id: DarkThemeId) => Promise<void>;
  setThemeSchedule: (patch: { dayStartHm?: string; nightStartHm?: string }) => Promise<void>;
  toggleThemePair: () => Promise<void>;
  refreshThemeByClock: () => void;
  setDayStartHour: (hour: number) => Promise<void>;
  setLateCollapsed: (collapsed: boolean) => Promise<void>;
  setCalendarView: (view: CalendarView) => Promise<void>;
  /** 0＝週日、1＝週一；其他數字一律當 1 */
  setWeekStart: (day: number) => Promise<void>;
  loadSettings: () => Promise<void>;
  /* ── v1.1.5 同步橫幅（契約 §2.5；WP-B 寫、WP-C 讀） ── */
  /** 由 syncStore 叫：告警種類變了就換、null＝解除（清 dismissed）；換成別種告警也清 dismissed（那是新的一次） */
  setSyncBanner: (kind: string | null) => void;
  /** 「先收起」：記住這一種，本次啟動不再出 */
  dismissSyncBanner: () => void;
  /** 「前往同步」：桌機開設定落在同步籤；手機切到「更多」並請 MobileMore 進同步子頁 */
  openSyncPage: (shell: "desktop" | "mobile") => void;
  /** 收官磨光 Q2-a：備份頁的深連結——桌機＝設定〈備份與還原〉籤；手機＝「更多 › 備份與還原」 */
  openBackupPage: (shell: "desktop" | "mobile") => void;
  /** 提醒頁（第五本 ⑨）：桌機開設定〈提醒〉籤；手機切到「更多」並留一張請求（同 openBackupPage） */
  openRemindersPage: (shell: "desktop" | "mobile") => void;
  /** MobileMore 消費掉深連結 */
  consumeMobileMoreRequest: () => void;
  /** 日曆格內記號請重查（見 `calendarMarksTick`） */
  bumpCalendarMarks: () => void;
  readLastNav?: () => LastNavState;
  writeLastNav?: (patch: Partial<LastNavState>) => void;
}

const INITIAL_LAST_NAV = readLastNav();

export const useUiStore = create<UiStore>((set, get) => ({
  // 起始頁優先恢復上次瀏覽頁面（若已通車），否則落回 today；`?page=` 只在 dev／mock 生效
  page:
    DEV_FLAGS.page ??
    (INITIAL_LAST_NAV.page && pageById(INITIAL_LAST_NAV.page).status === "open"
      ? INITIAL_LAST_NAV.page
      : DEFAULT_PAGE),
  routeOverview: INITIAL_LAST_NAV.routeOverview ?? false,
  // ＝tabs.ts 的 DEFAULT_MOBILE_TAB；優先恢復上次手機分頁
  mobileTab: INITIAL_LAST_NAV.mobileTab ?? "today",
  selectedId: null,
  zoomId: null,
  collapsed: {},
  panelOpen: false,
  sidebarCollapsed: Boolean(INITIAL_LAST_NAV.sidebarCollapsed),
  hideDone: true, // 大綱的已完成預設收起（回饋甲 D-主-131：開關在區段標「済 N・顯示」）
  todayHideDone: false,
  toast: null,
  confirm: null,
  quickJumpOpen: false,
  settingsOpen: false,
  settingsTab: "general",
  hotkeyGuideOpen: false,
  completeCardFor: null,
  routeDialog: null,
  theme: THEME_OVERRIDE ?? "pastel",
  themeConfig: DEFAULT_THEME_SYSTEM_CONFIG,
  resolvedDark:
    typeof document !== "undefined" ? document.documentElement.getAttribute("data-theme") === "dark" : false,
  dayStartHour: DEFAULT_DAY_START_HOUR,
  lateCollapsed: false,
  calendarView: DEV_FLAGS.view ?? "month",
  weekStart: 1,
  syncBanner: null,
  syncBannerDismissed: null,
  mobileMoreRequest: null,
  calendarMarksTick: 0,

  // 未通車的頁不動作（對既有三頁行為相同；契約 §6.2 C-3）
  // 切頁即收 toast（視覺規範 §2.8，UI 丙-1）：上一頁的「復原」留到下一頁會讓人以為是在復原眼前的東西。
  // 同一頁重設（快速跳轉、荷札回跳落在原頁）不算切頁，不收——不然「先 setPage 再 showToast」以外的順序也會誤殺。
  setPage: (page) => {
    if (pageById(page).status !== "open") return;
    if (page !== get().page) get().hideToast();
    set({ page });
    writeLastNav({ page });
  },
  openRouteMap: () => {
    get().setPage("routemap");
    set({ routeOverview: true, zoomId: null, selectedId: null, panelOpen: false });
    writeLastNav({ page: "routemap", routeOverview: true });
  },
  setRouteOverview: (on) => {
    if (on !== get().routeOverview) set({ routeOverview: on });
    writeLastNav({ routeOverview: on });
  },
  // 切頁順手收掉桌機專屬疊層：手機殼本來就不掛它們，這是保險不是功能（藍牙鍵盤按到 ? 或 Ctrl+P 時）；toast 同 setPage
  setMobileTab: (tab) => {
    if (tab !== get().mobileTab) get().hideToast();
    set({ mobileTab: tab, hotkeyGuideOpen: false, quickJumpOpen: false });
    writeLastNav({ mobileTab: tab });
  },
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
  setPanelOpen: (open) => {
    if (open && useSelectionStore.getState().ids.length) useSelectionStore.getState().clear();
    set({ panelOpen: open });
  },
  setSidebarCollapsed: (collapsed) => {
    set({ sidebarCollapsed: collapsed });
    writeLastNav({ sidebarCollapsed: collapsed });
  },
  toggleSidebarCollapsed: () => {
    const next = !get().sidebarCollapsed;
    set({ sidebarCollapsed: next });
    writeLastNav({ sidebarCollapsed: next });
  },
  toggleHideDone: () => {
    const hideDone = !get().hideDone;
    set({ hideDone });
    void settingsRepo.set(KEY_OUTLINE_HIDE_DONE, hideDone ? "1" : "0").catch(() => undefined);
  },
  toggleTodayHideDone: () => {
    const todayHideDone = !get().todayHideDone;
    set({ todayHideDone });
    void settingsRepo.set(KEY_TODAY_HIDE_DONE, todayHideDone ? "1" : "0").catch(() => undefined);
  },

  // 壽命（視覺規範 §2.8，UI 丙-1）：有動作（復原）6 秒、純通知 4 秒；呼叫端帶了 ttlMs 照帶的
  showToast(toast, ttlMs = toast.actionLabel ? 6_000 : 4_000) {
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

  /* ── v1.1.5 同步橫幅 ── */
  // 解除（null）時順手清 dismissed：下一次同一種告警再來是「新的一次」，該再出（拍板：狀態解除自動消失）
  // v1.1.5 修正席（工程評審 S-1）：換成**別種**告警也清 dismissed——否則 stopped（收起）→ locked → stopped 那「新的一次」
  // stopped 會被舊的收起吃掉，只剩通知沒有橫幅（違反「橫幅是主力」）。同種告警一直沒離開＝不會叫到這裡（syncStore 同態直接 return）。
  setSyncBanner: (kind) =>
    set((s) => ({
      syncBanner: kind,
      syncBannerDismissed: kind === null || kind !== s.syncBannerDismissed ? null : s.syncBannerDismissed,
    })),
  dismissSyncBanner: () => set((s) => ({ syncBannerDismissed: s.syncBanner })),
  // v1.1.5 真機驗收（主人 2026-09-28）：按「前往同步」＝主人已經看到了，橫幅隨即收起（與「先收起」同一個機制：
  // 本次啟動有效、狀態解除自動清、重開 App 若還沒解除會再出）。不收的話同步頁上方還疊著橫幅、像沒點到。
  // UI 丙-1：換到同步頁＝切頁，先收 toast（§2.8；同步失敗 toast 的「前往同步」本來就會在按下後收）
  openSyncPage: (shell) => {
    get().hideToast();
    set((s) =>
      shell === "mobile"
        ? { mobileTab: "more", mobileMoreRequest: "sync", hotkeyGuideOpen: false, quickJumpOpen: false, syncBannerDismissed: s.syncBanner }
        : { settingsOpen: true, settingsTab: "sync", hotkeyGuideOpen: false, syncBannerDismissed: s.syncBanner },
    );
  },
  openBackupPage: (shell) => {
    get().hideToast();
    if (shell === "desktop") {
      get().openSettings("backup");
      return;
    }
    set({ mobileTab: "more", mobileMoreRequest: "backup", hotkeyGuideOpen: false, quickJumpOpen: false });
  },
  openRemindersPage: (shell) => {
    get().hideToast();
    if (shell === "desktop") {
      get().openSettings("reminders");
      return;
    }
    set({ mobileTab: "more", mobileMoreRequest: "reminders", hotkeyGuideOpen: false, quickJumpOpen: false });
  },
  consumeMobileMoreRequest: () => set({ mobileMoreRequest: null }),
  bumpCalendarMarks: () => set((s) => ({ calendarMarksTick: s.calendarMarksTick + 1 })),
  readLastNav,
  writeLastNav,

  async setTheme(pref) {
    const cur = get().themeConfig;
    const next = nextConfigOnPickTheme(cur, pref, get().resolvedDark);
    const resolved = applyResolvedToDom(next, true);
    set({
      themeConfig: next,
      theme: resolved.activeThemeId,
      resolvedDark: resolved.dataTheme === "dark",
    });
    syncThemeClockTimer(next.mode, () => get().refreshThemeByClock());
    await persistThemeConfig(next, resolved);
  },

  async setThemeMode(mode) {
    const cur = get().themeConfig;
    const next = nextConfigOnSetMode(cur, mode, get().resolvedDark);
    const resolved = applyResolvedToDom(next, true);
    set({
      themeConfig: next,
      theme: resolved.activeThemeId,
      resolvedDark: resolved.dataTheme === "dark",
    });
    syncThemeClockTimer(next.mode, () => get().refreshThemeByClock());
    await persistThemeConfig(next, resolved);
  },

  async setLightThemePref(id) {
    const cur = get().themeConfig;
    const next = nextConfigOnSetLightPref(cur, id);
    const resolved = applyResolvedToDom(next, true);
    set({
      themeConfig: next,
      theme: resolved.activeThemeId,
      resolvedDark: resolved.dataTheme === "dark",
    });
    syncThemeClockTimer(next.mode, () => get().refreshThemeByClock());
    await persistThemeConfig(next, resolved);
  },

  async setDarkThemePref(id) {
    const cur = get().themeConfig;
    const next = nextConfigOnSetDarkPref(cur, id);
    const resolved = applyResolvedToDom(next, true);
    set({
      themeConfig: next,
      theme: resolved.activeThemeId,
      resolvedDark: resolved.dataTheme === "dark",
    });
    syncThemeClockTimer(next.mode, () => get().refreshThemeByClock());
    await persistThemeConfig(next, resolved);
  },

  async setThemeSchedule(patch) {
    const cur = get().themeConfig;
    const next: ThemeSystemConfig = {
      ...cur,
      dayStartHm: patch.dayStartHm !== undefined ? normalizeThemeHm(patch.dayStartHm, cur.dayStartHm) : cur.dayStartHm,
      nightStartHm:
        patch.nightStartHm !== undefined ? normalizeThemeHm(patch.nightStartHm, cur.nightStartHm) : cur.nightStartHm,
    };
    const resolved = applyResolvedToDom(next, true);
    set({
      themeConfig: next,
      theme: resolved.activeThemeId,
      resolvedDark: resolved.dataTheme === "dark",
    });
    syncThemeClockTimer(next.mode, () => get().refreshThemeByClock());
    await persistThemeConfig(next, resolved);
  },

  async toggleThemePair() {
    const cur = get().themeConfig;
    const next = nextConfigOnTogglePair(cur, get().resolvedDark);
    const resolved = applyResolvedToDom(next, true);
    set({
      themeConfig: next,
      theme: resolved.activeThemeId,
      resolvedDark: resolved.dataTheme === "dark",
    });
    syncThemeClockTimer(next.mode, () => get().refreshThemeByClock());
    await persistThemeConfig(next, resolved);
  },

  refreshThemeByClock() {
    const cur = get().themeConfig;
    const prevTheme = get().theme;
    const prevDark = get().resolvedDark;
    const nextDarkFromPreview = resolveForCurrentEnv(cur).dataTheme === "dark";
    const resolved = applyResolvedToDom(cur, nextDarkFromPreview !== prevDark);
    const isDark = resolved.dataTheme === "dark";
    if (resolved.activeThemeId !== prevTheme || isDark !== prevDark) {
      set({
        theme: resolved.activeThemeId,
        resolvedDark: isDark,
      });
    }
    syncThemeClockTimer(cur.mode, () => get().refreshThemeByClock());
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

  async setWeekStart(day) {
    const weekStart = normalizeWeekStart(String(day));
    set({ weekStart });
    await settingsRepo.set(KEY_WEEK_START, String(weekStart));
  },

  async loadSettings() {
    if (typeof document !== "undefined" && !document.documentElement.hasAttribute("data-theme")) {
      applyResolvedToDom(get().themeConfig, false);
    }
    // ⑩ ＋ v1.34 4A：捕捉小窗每次叫出都會重跑 loadSettings，系統深淺與喚醒監聽只掛一次
    if (!systemThemeWatched && typeof window !== "undefined") {
      systemThemeWatched = true;
      try {
        window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
          if (get().themeConfig.mode === "system") get().refreshThemeByClock();
        });
      } catch {
        /* matchMedia 不支援時略過 */
      }
      const onWake = () => {
        const m = get().themeConfig.mode;
        if (typeof document !== "undefined" && document.hidden) {
          stopThemeClockTimer();
          return;
        }
        if (m === "schedule" || m === "kamakura" || m === "system" || THEME_OVERRIDE === "kamakura") {
          get().refreshThemeByClock();
        }
      };
      if (typeof document !== "undefined") {
        document.addEventListener("visibilitychange", onWake);
      }
      window.addEventListener("focus", onWake);
      window.addEventListener("pageshow", onWake);
      window.addEventListener("ns-kamakura-time-change", () => {
        get().refreshThemeByClock();
      });
    }
    void useHandFontStore.getState().init();
    try {
      const [
        theme,
        themeMode,
        lightPref,
        darkPref,
        manualPolarity,
        manualOverride,
        dayStartHm,
        nightStartHm,
        dayStart,
        lateCollapsed,
        calendarView,
        weekStart,
        todayHideDone,
        outlineHideDone,
      ] = await Promise.all([
        settingsRepo.get(KEY_THEME),
        settingsRepo.get(KEY_THEME_MODE),
        settingsRepo.get(KEY_THEME_LIGHT_PREF),
        settingsRepo.get(KEY_THEME_DARK_PREF),
        settingsRepo.get(KEY_THEME_MANUAL_POLARITY),
        settingsRepo.get(KEY_THEME_MANUAL_OVERRIDE),
        settingsRepo.get(KEY_THEME_DAY_HM),
        settingsRepo.get(KEY_THEME_NIGHT_HM),
        settingsRepo.get(KEY_DAY_START),
        settingsRepo.get(KEY_LATE_COLLAPSED),
        settingsRepo.get(KEY_CALENDAR_VIEW),
        settingsRepo.get(KEY_WEEK_START),
        settingsRepo.get(KEY_TODAY_HIDE_DONE),
        settingsRepo.get(KEY_OUTLINE_HIDE_DONE),
      ]);
      const parsedConfig = parseThemeSystemSettings({
        theme,
        mode: themeMode,
        lightPref,
        darkPref,
        manualPolarity,
        manualOverride,
        dayStartHm,
        nightStartHm,
      });
      const resolved = applyResolvedToDom(parsedConfig, false);
      set({
        themeConfig: parsedConfig,
        theme: resolved.activeThemeId,
        resolvedDark: resolved.dataTheme === "dark",
        dayStartHour: parseDayStartHour(dayStart),
        lateCollapsed: lateCollapsed === "1",
        calendarView:
          DEV_FLAGS.view ??
          (calendarView === "week" || calendarView === "stream"
            ? calendarView
            : calendarView === "time"
              ? "week"
              : "month"),
        weekStart: normalizeWeekStart(weekStart),
        todayHideDone: todayHideDone === "1",
        hideDone: outlineHideDone !== "0",
      });
      syncThemeClockTimer(parsedConfig.mode, () => get().refreshThemeByClock());
    } catch {
      // 設定讀取失敗不致命：維持預設（跟隨系統、06:00）
    }
  },
}));
