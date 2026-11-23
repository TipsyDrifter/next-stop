/**
 * themeSystem.ts——v1.34 4A「亮暗代表主題自由配對」與「四模式時光自動切換」純函式核心。
 *
 * 鐵則：零 React／零 DOM／零 Tauri 執行期依賴（`node --test` 直接載入測試，相對路徑帶 `.ts`）。
 *
 * 四種切換模式（`ThemeMode`）：
 *   1. `manual`   手動（白晝／入夜秒切）：固定停在亮色或暗色，點頂欄日夜鈕或手機快速切換在「我的亮色代表 ⇄ 我的暗色代表」間秒切。
 *   2. `system`   跟隨系統：依 OS `prefers-color-scheme` 自動套用「我的亮色代表」或「我的暗色代表」。
 *   3. `schedule` 依時間自動切換：依自訂白晝時刻（預設 06:30）與入夜時刻（預設 18:30）自動平滑切換亮／暗代表主題（支援跨午夜區間）。
 *   4. `kamakura` 水鏡鎌倉全天候：全天掛載 `<html data-skin="kamakura">`，並依白晝／入夜時刻同步切換 `<html data-theme="light|dark">`，
 *                 由場景層（4B）讀取 `data-skin="kamakura"` 進行 24h 連續天色插值與湖上列車渲染。
 */
import { isSkinId, skinById, type SkinId } from "./themeShop.ts";

export type LightThemeId = "pastel" | "techo" | "yumemi" | "kamakura";
export type DarkThemeId = "galaxy" | "sleeper" | "moonlight" | "kamakura";
export type ConcreteThemeId = "pastel" | "galaxy" | SkinId;
export type StaticConcreteThemeId = Exclude<ConcreteThemeId, "kamakura">;
export type ThemePolarity = "light" | "dark";
export type ThemeMode = "manual" | "system" | "schedule" | "kamakura";
export type KamakuraTimePref = "auto" | "dawn" | "day" | "dusk" | "night";
export type KamakuraRole = "full" | "light" | "dark";

export const DEFAULT_LIGHT_THEME: LightThemeId = "pastel";
export const DEFAULT_DARK_THEME: DarkThemeId = "galaxy";
export const DEFAULT_DAY_THEME_HM = "06:30";
export const DEFAULT_NIGHT_THEME_HM = "18:30";

/** localStorage 快取鍵（供 index.html 開頁同步腳本即刻求值，達成零閃白／零閃黑） */
export const THEME_CONFIG_CACHE_KEY = "ns-theme-config";
/** 水鏡鎌倉駐足時段同步快取鍵（4A × 4B 跨層契約） */
export const KAMAKURA_TIME_CACHE_KEY = "ns-kamakura-time";

export interface ThemeRepOption<T extends string = string> {
  id: T;
  /** 完整顯示名稱（水鏡鎌倉在代表清單標明「·晝」／「·夜」） */
  name: string;
  /** 簡短名稱 */
  shortName: string;
  latin: string;
  note: string;
  dynamic?: boolean;
}

export const LIGHT_THEME_OPTIONS: readonly ThemeRepOption<LightThemeId>[] = [
  { id: "pastel", name: "粉彩星空", shortName: "粉彩星空", latin: "Pastel Starry", note: "朧月的月台・日間" },
  { id: "techo", name: "旅の手帖", shortName: "旅の手帖", latin: "Techo", note: "暖米紙與墨綠書封" },
  { id: "yumemi", name: "少女手帳", shortName: "少女手帳", latin: "Yumemi", note: "奶米白與薰衣草" },
  { id: "kamakura", name: "水鏡鎌倉·晝", shortName: "水鏡鎌倉", latin: "Kamakura · Day", note: "晴空碧水與湖上列車", dynamic: true },
];

export const DARK_THEME_OPTIONS: readonly ThemeRepOption<DarkThemeId>[] = [
  { id: "galaxy", name: "銀河鐵道", shortName: "銀河鐵道", latin: "Galaxy Platform", note: "深夜月台・夜間" },
  { id: "sleeper", name: "夜行寝台", shortName: "夜行寝台", latin: "Night Sleeper", note: "車廂裡的暖燈" },
  { id: "moonlight", name: "月白", shortName: "月白", latin: "Moonlight", note: "冷調的月光" },
  { id: "kamakura", name: "水鏡鎌倉·夜", shortName: "水鏡鎌倉", latin: "Kamakura · Night", note: "群青星夜與湖面月影", dynamic: true },
];

export interface ThemeSystemConfig {
  mode: ThemeMode;
  lightPref: LightThemeId;
  darkPref: DarkThemeId;
  manualPolarity: ThemePolarity;
  /** 若使用者在商店直接點選一套非代表的靜態主題試穿，暫記於此；按日夜切換鈕或改代表主題時自動清回 null */
  manualOverride: StaticConcreteThemeId | null;
  /** 白晝起始時刻 HH:MM（00:00–23:59），預設 06:30 */
  dayStartHm: string;
  /** 入夜起始時刻 HH:MM（00:00–23:59），預設 18:30 */
  nightStartHm: string;
}

export interface ThemeEnvironment {
  systemDark: boolean;
  /** 本地時間自午夜起算的分鐘數（0–1439） */
  nowMinutes: number;
  /** 水鏡鎌倉專屬駐足時段（由 localStorage["ns-kamakura-time"] 讀取；缺省視為 "auto"） */
  kamakuraTime?: KamakuraTimePref | null;
}

export interface ResolvedThemeState {
  /** 寫入 `<html data-theme>` */
  dataTheme: ThemePolarity;
  /** 寫入 `<html data-skin>`（粉彩／銀河為 null） */
  dataSkin: SkinId | null;
  /** 寫入 `<html data-kamakura-role>`：全天候為 `"full"`，代表配對為 `"light"|"dark"`，非水鏡為 `null` */
  kamakuraRole: KamakuraRole | null;
  /** 當前實際生效的主題 ID */
  activeThemeId: ConcreteThemeId;
  /** 同步至原生視窗外框的主題（跟隨系統傳 null） */
  windowTheme: ThemePolarity | null;
}

export const DEFAULT_THEME_SYSTEM_CONFIG: ThemeSystemConfig = {
  mode: "system",
  lightPref: DEFAULT_LIGHT_THEME,
  darkPref: DEFAULT_DARK_THEME,
  manualPolarity: "light",
  manualOverride: null,
  dayStartHm: DEFAULT_DAY_THEME_HM,
  nightStartHm: DEFAULT_NIGHT_THEME_HM,
};

export function isLightThemeId(v: string | null | undefined): v is LightThemeId {
  return LIGHT_THEME_OPTIONS.some((o) => o.id === v);
}

export function isDarkThemeId(v: string | null | undefined): v is DarkThemeId {
  return DARK_THEME_OPTIONS.some((o) => o.id === v);
}

export function isThemeMode(v: string | null | undefined): v is ThemeMode {
  return v === "manual" || v === "system" || v === "schedule" || v === "kamakura";
}

export function isKamakuraTimePref(v: string | null | undefined): v is KamakuraTimePref {
  return v === "auto" || v === "dawn" || v === "day" || v === "dusk" || v === "night";
}

/**
 * 水鏡鎌倉全天候模式（`mode === "kamakura"` 或 `?theme=kamakura`）亮暗象限判定：
 * - 鎖定 `"night"` ⇒ `dark = true`
 * - 鎖定 `"dawn" | "day" | "dusk"` ⇒ `dark = false`
 * - 其餘（`"auto"`／未設）對齊水鏡鎌倉白晝區間 `05:10–18:30`（`310 <= nowMinutes < 1110`）
 */
export function isKamakuraDarkAt(nowMinutes: number, kamakuraTime?: string | null): boolean {
  if (kamakuraTime === "night") return true;
  if (kamakuraTime === "dawn" || kamakuraTime === "day" || kamakuraTime === "dusk") return false;
  const normNow = ((Math.floor(nowMinutes) % 1440) + 1440) % 1440;
  return !(normNow >= 310 && normNow < 1110);
}

export function isStaticConcreteThemeId(v: string | null | undefined): v is StaticConcreteThemeId {
  return v === "pastel" || v === "galaxy" || (isSkinId(v) && v !== "kamakura");
}

export function polarityOfStaticTheme(id: StaticConcreteThemeId): ThemePolarity {
  if (id === "pastel") return "light";
  if (id === "galaxy") return "dark";
  const s = skinById(id);
  return s?.base === "dark" ? "dark" : "light";
}

export function lightThemeName(id: LightThemeId): string {
  return LIGHT_THEME_OPTIONS.find((o) => o.id === id)?.name ?? "粉彩星空";
}

export function darkThemeName(id: DarkThemeId): string {
  return DARK_THEME_OPTIONS.find((o) => o.id === id)?.name ?? "銀河鐵道";
}

export function concreteThemeName(id: ConcreteThemeId, polarity?: ThemePolarity): string {
  if (id === "pastel") return "粉彩星空";
  if (id === "galaxy") return "銀河鐵道";
  if (id === "kamakura") {
    if (polarity === "light") return "水鏡鎌倉·晝";
    if (polarity === "dark") return "水鏡鎌倉·夜";
    return "水鏡鎌倉";
  }
  return skinById(id)?.name ?? "粉彩星空";
}

/** 正規化 24 小時制 `HH:MM`（接受 `6:30`、`06:30`）；不合法退回 fallback */
export function normalizeThemeHm(raw: string | null | undefined, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  const m = raw.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return fallback;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isInteger(hh) || !Number.isInteger(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) {
    return fallback;
  }
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

/** `HH:MM` 轉午夜起算分鐘數 `0..1439` */
export function hmToMinutes(hm: string, fallbackMinutes: number = 390): number {
  const m = hm.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return fallbackMinutes;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return fallbackMinutes;
  return hh * 60 + mm;
}

/** Date 物件轉本地午夜起算分鐘數 `0..1439` */
export function localNowMinutes(d: Date = new Date()): number {
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * 判定當下是否屬於「白晝（亮色）」時段：
 * - 一般情況（`dayStart < nightStart`，例 06:30–18:30）：`[dayStart, nightStart)` 為白晝
 * - 熬夜跨午夜設定（`dayStart > nightStart`，例 08:00 起白晝、凌晨 01:30 才入夜）：`now >= dayStart || now < nightStart` 為白晝
 * - 兩者相等時保底視為白晝
 */
export function isDaytimeAt(nowMinutes: number, dayStartHm: string, nightStartHm: string): boolean {
  const normNow = ((Math.floor(nowMinutes) % 1440) + 1440) % 1440;
  const dayMin = hmToMinutes(normalizeThemeHm(dayStartHm, DEFAULT_DAY_THEME_HM), 390);
  const nightMin = hmToMinutes(normalizeThemeHm(nightStartHm, DEFAULT_NIGHT_THEME_HM), 1110);
  if (dayMin === nightMin) return true;
  if (dayMin < nightMin) {
    return normNow >= dayMin && normNow < nightMin;
  }
  return normNow >= dayMin || normNow < nightMin;
}

export interface RawThemeSettings {
  /** 舊版與相容鍵 `theme` */
  theme?: string | null;
  mode?: string | null;
  lightPref?: string | null;
  darkPref?: string | null;
  manualPolarity?: string | null;
  manualOverride?: string | null;
  dayStartHm?: string | null;
  nightStartHm?: string | null;
}

/**
 * 從 settings 表（含 v1.33 以前的單一 `theme` 鍵）解析出完整的 `ThemeSystemConfig`。
 * 舊用戶無縫升級保證：
 * - 原穿 `techo`／`yumemi` ⇒ 自動保留為手動亮色，且 `lightPref` 設為該套主題（點日夜鈕不會洗掉心愛主題）
 * - 原穿 `sleeper`／`moonlight` ⇒ 自動保留為手動暗色，且 `darkPref` 設為該套主題
 * - 原穿 `pastel`／`light` ⇒ 手動亮色（粉彩⇄銀河）
 * - 原穿 `galaxy`／`dark` ⇒ 手動暗色（粉彩⇄銀河）
 * - 原穿 `system` 或空白 ⇒ 跟隨系統（粉彩⇄銀河）
 */
export function parseThemeSystemSettings(raw: RawThemeSettings): ThemeSystemConfig {
  const dayStartHm = normalizeThemeHm(raw.dayStartHm, DEFAULT_DAY_THEME_HM);
  const nightStartHm = normalizeThemeHm(raw.nightStartHm, DEFAULT_NIGHT_THEME_HM);

  let fallbackMode: ThemeMode = "system";
  let fallbackLight: LightThemeId = DEFAULT_LIGHT_THEME;
  let fallbackDark: DarkThemeId = DEFAULT_DARK_THEME;
  let fallbackPol: ThemePolarity = "light";

  switch (raw.theme) {
    case "pastel":
    case "light":
      fallbackMode = "manual";
      fallbackPol = "light";
      break;
    case "galaxy":
    case "dark":
      fallbackMode = "manual";
      fallbackPol = "dark";
      break;
    case "techo":
    case "yumemi":
      fallbackMode = "manual";
      fallbackPol = "light";
      fallbackLight = raw.theme;
      break;
    case "sleeper":
    case "moonlight":
      fallbackMode = "manual";
      fallbackPol = "dark";
      fallbackDark = raw.theme;
      break;
    case "kamakura":
      fallbackMode = "kamakura";
      break;
    case "system":
    default:
      fallbackMode = "system";
      break;
  }

  const mode: ThemeMode = isThemeMode(raw.mode) ? raw.mode : fallbackMode;
  const lightPref: LightThemeId = isLightThemeId(raw.lightPref) ? raw.lightPref : fallbackLight;
  const darkPref: DarkThemeId = isDarkThemeId(raw.darkPref) ? raw.darkPref : fallbackDark;
  const manualPolarity: ThemePolarity =
    raw.manualPolarity === "light" || raw.manualPolarity === "dark" ? raw.manualPolarity : fallbackPol;
  const manualOverride: StaticConcreteThemeId | null = isStaticConcreteThemeId(raw.manualOverride)
    ? raw.manualOverride
    : null;

  return {
    mode,
    lightPref,
    darkPref,
    manualPolarity,
    manualOverride,
    dayStartHm,
    nightStartHm,
  };
}

/** 純函式求值：根據設定與當下環境（系統深淺、本地時刻、水鏡駐足時段）算出 DOM 應掛載的 `data-theme`、`data-skin` 與 `data-kamakura-role` */
export function resolveThemeSystem(config: ThemeSystemConfig, env: ThemeEnvironment): ResolvedThemeState {
  if (config.mode === "kamakura") {
    const dark = isKamakuraDarkAt(env.nowMinutes, env.kamakuraTime);
    const pol: ThemePolarity = dark ? "dark" : "light";
    return {
      dataTheme: pol,
      dataSkin: "kamakura",
      kamakuraRole: "full",
      activeThemeId: "kamakura",
      windowTheme: pol,
    };
  }

  if (config.mode === "schedule") {
    const dark = !isDaytimeAt(env.nowMinutes, config.dayStartHm, config.nightStartHm);
    const pol: ThemePolarity = dark ? "dark" : "light";
    const id: ConcreteThemeId = dark ? config.darkPref : config.lightPref;
    const skin: SkinId | null = id === "pastel" || id === "galaxy" ? null : id;
    return {
      dataTheme: pol,
      dataSkin: skin,
      kamakuraRole: skin === "kamakura" ? pol : null,
      activeThemeId: id,
      windowTheme: pol,
    };
  }

  if (config.mode === "system") {
    const dark = env.systemDark;
    const pol: ThemePolarity = dark ? "dark" : "light";
    const id: ConcreteThemeId = dark ? config.darkPref : config.lightPref;
    const skin: SkinId | null = id === "pastel" || id === "galaxy" ? null : id;
    return {
      dataTheme: pol,
      dataSkin: skin,
      kamakuraRole: skin === "kamakura" ? pol : null,
      activeThemeId: id,
      windowTheme: null,
    };
  }

  // manual
  if (config.manualOverride) {
    const pol = polarityOfStaticTheme(config.manualOverride);
    const skin: SkinId | null =
      config.manualOverride === "pastel" || config.manualOverride === "galaxy" ? null : config.manualOverride;
    return {
      dataTheme: pol,
      dataSkin: skin,
      kamakuraRole: null,
      activeThemeId: config.manualOverride,
      windowTheme: pol,
    };
  }

  const dark = config.manualPolarity === "dark";
  const pol: ThemePolarity = dark ? "dark" : "light";
  const id: ConcreteThemeId = dark ? config.darkPref : config.lightPref;
  const skin: SkinId | null = id === "pastel" || id === "galaxy" ? null : id;
  return {
    dataTheme: pol,
    dataSkin: skin,
    kamakuraRole: skin === "kamakura" ? pol : null,
    activeThemeId: id,
    windowTheme: pol,
  };
}

/** 頂欄日夜切換鈕／手機日夜秒切：在「我的亮色代表 ⇄ 我的暗色代表」之間一鍵切換（轉為手動固定） */
export function nextConfigOnTogglePair(config: ThemeSystemConfig, currentResolvedDark: boolean): ThemeSystemConfig {
  const nextPol: ThemePolarity = currentResolvedDark ? "light" : "dark";
  return {
    ...config,
    mode: "manual",
    manualPolarity: nextPol,
    manualOverride: null,
  };
}

/** 切換四模式：切回手動時繼承當下亮暗象限，畫面不突兀跳閃 */
export function nextConfigOnSetMode(
  config: ThemeSystemConfig,
  mode: ThemeMode,
  currentResolvedDark: boolean,
): ThemeSystemConfig {
  return {
    ...config,
    mode,
    manualPolarity: mode === "manual" ? (currentResolvedDark ? "dark" : "light") : config.manualPolarity,
    manualOverride: null,
  };
}

/** 設定「我的亮色代表主題」 */
export function nextConfigOnSetLightPref(config: ThemeSystemConfig, lightPref: LightThemeId): ThemeSystemConfig {
  return {
    ...config,
    lightPref,
    manualOverride: null,
  };
}

/** 設定「我的暗色代表主題」 */
export function nextConfigOnSetDarkPref(config: ThemeSystemConfig, darkPref: DarkThemeId): ThemeSystemConfig {
  return {
    ...config,
    darkPref,
    manualOverride: null,
  };
}

/** 直接點選單一主題（商店卡片即選即存或相容 `setTheme` API） */
export function nextConfigOnPickTheme(
  config: ThemeSystemConfig,
  pref: ConcreteThemeId | "system",
  currentResolvedDark: boolean,
): ThemeSystemConfig {
  if (pref === "system") {
    return nextConfigOnSetMode(config, "system", currentResolvedDark);
  }
  if (pref === "kamakura") {
    return {
      ...config,
      mode: "kamakura",
      manualOverride: null,
    };
  }
  const pol = polarityOfStaticTheme(pref);
  const matchesRep = pol === "light" ? config.lightPref === pref : config.darkPref === pref;
  return {
    ...config,
    mode: "manual",
    manualPolarity: pol,
    manualOverride: matchesRep ? null : pref,
  };
}

/** 供舊鍵 `settings.theme` 同步回寫的向後相容字串 */
export function legacyThemeValueOf(config: ThemeSystemConfig, resolved: ResolvedThemeState): string {
  if (config.mode === "system") return "system";
  if (config.mode === "kamakura") return "kamakura";
  return resolved.activeThemeId;
}

/** 序列化進 localStorage（供 index.html 同步啟動腳本讀取） */
export function serializeThemeCache(config: ThemeSystemConfig): string {
  return JSON.stringify({
    v: 1,
    mode: config.mode,
    lightPref: config.lightPref,
    darkPref: config.darkPref,
    manualPolarity: config.manualPolarity,
    manualOverride: config.manualOverride,
    dayStartHm: config.dayStartHm,
    nightStartHm: config.nightStartHm,
  });
}
