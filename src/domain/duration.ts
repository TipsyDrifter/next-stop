/**
 * 預估時長與目標時數純函式（v1.32 2A-2）：
 * - `parseDurationInput`：智慧解析多格式時長字串（純分、小數／整數時、複合時分、冒號時分、全形字正規化）
 * - `formatDurationShort`：精簡顯示字串（如 `45m`、`1h`、`1h10`、`2h30`），與 `parseDurationInput` 可雙向往返
 * - `splitDurationMatrix` / `composeMatrixHour` / `composeMatrixMinute`：時 × 分雙排矩陣拆解與組合邏輯
 *
 * 分層鐵律：零 React / Store / Tauri 依賴，可直接由 Node 原生測試載入。
 */

export const DURATION_DEFAULT_MAX = 1440;
export const DURATION_GOAL_MAX = 60000;

export const MATRIX_BASE_HOURS = [0, 1, 2, 3] as const;
export const MATRIX_EXT_HOURS = [4, 5, 6, 8] as const;
export const MATRIX_MINUTES = [0, 10, 15, 20, 30, 40, 45, 50] as const;

export type MatrixMinute = (typeof MATRIX_MINUTES)[number];

export interface ParseDurationOptions {
  /** 最大允許分鐘數（預設 1440＝24h；目標模式可傳 60000） */
  maxMin?: number;
  /** 是否允許 0 分鐘（預設 false：0 視為不合法回 undefined） */
  allowZero?: boolean;
}

export interface DurationMatrixParts {
  /** 小時部分（value 為 null 或 <=0 時為 null） */
  hours: number | null;
  /** 分鐘餘數 0..59（value 為 null 或 <=0 時為 null） */
  mins: number | null;
  /** 分鐘餘數是否不在標準 8 格（00/10/15/20/30/40/45/50）內 */
  isCustomMin: boolean;
}

const MATRIX_MIN_SET: ReadonlySet<number> = new Set<number>(MATRIX_MINUTES);

/**
 * 將全形數字、全形英文字母、全形冒號／句點與空白正規化為半形小寫。
 */
export function normalizeDurationText(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    // 全形數字 ０-９ -> 0-9
    if (code >= 0xff10 && code <= 0xff19) {
      out += String.fromCharCode(code - 0xfee0);
    } else if (code >= 0xff21 && code <= 0xff3a) {
      // 全形大寫 Ａ-Ｚ -> a-z
      out += String.fromCharCode(code - 0xfee0 + 32);
    } else if (code >= 0xff41 && code <= 0xff5a) {
      // 全形小寫 ａ-ｚ -> a-z
      out += String.fromCharCode(code - 0xfee0);
    } else if (code === 0xff1a) {
      // 全形冒號 ： -> :
      out += ":";
    } else if (code === 0xff0e) {
      // 全形小數點 ． -> .
      out += ".";
    } else if (code === 0x3000) {
      // 全形空白 -> 半形空白
      out += " ";
    } else {
      out += raw[i];
    }
  }
  return out.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * 智慧解析時長輸入：
 * - 空字串（或純空白）→ `null`（代表清除／不預估）
 * - 無法辨識、負數、或未開 `allowZero` 時為 0 → `undefined`
 * - 合法字串 → 四捨五入為整數分鐘，並夾在 `[allowZero ? 0 : 1, maxMin]`
 *
 * 支援格式：
 * - 純整數分鐘：`"70"` → `70`、`"45"` → `45`
 * - 小數或整數小時：`"2.5h"` / `"2.5小時"` / `"2.5 hr"` → `150`、`"2h"` → `120`
 * - 複合時分：`"1h10"` / `"1h10m"` / `"1小時10分"` / `"1h 30m"` → `70` / `90`
 * - 冒號時分：`"1:10"` / `"02:30"` → `70` / `150`（分鐘須兩位數 `00..59`）
 * - 帶分字尾：`"90m"` / `"90分"` / `"90min"` / `"90分鐘"` → `90`
 */
export function parseDurationInput(
  raw: string,
  opts?: ParseDurationOptions,
): number | null | undefined {
  const s = normalizeDurationText(raw);
  if (s === "") return null;

  const maxMin = opts?.maxMin ?? DURATION_DEFAULT_MAX;
  const allowZero = opts?.allowZero ?? false;

  let minutes: number | undefined;

  // 1. 純整數分鐘："70"、"45"
  if (/^\d+$/.test(s)) {
    minutes = Number(s);
  }
  // 2. 冒號時分："1:10"、"02:30"（分鐘固定 2 位 00..59，避免 "1:3" 歧義）
  else {
    const colonMatch = /^(\d+):([0-5]\d)$/.exec(s);
    if (colonMatch) {
      minutes = Number(colonMatch[1]) * 60 + Number(colonMatch[2]);
    }
  }

  // 3. 小數或整數小時："2.5h"、"2.5 hr"、"2.5小時"、"2時"
  if (minutes === undefined) {
    const hourOnly = /^(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h|小時|時)$/.exec(s);
    if (hourOnly) {
      minutes = Number(hourOnly[1]) * 60;
    }
  }

  // 4. 帶分字尾："90m"、"90min"、"90 mins"、"90分"、"90分鐘"
  if (minutes === undefined) {
    const minOnly = /^(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|m|分鐘|分)$/.exec(s);
    if (minOnly) {
      minutes = Number(minOnly[1]);
    }
  }

  // 5. 複合時分："1h10"、"1h10m"、"1小時10分"、"1小時10"、"1h 30m"、"1hr 30min"
  if (minutes === undefined) {
    const compound =
      /^(\d+)\s*(?:hours?|hrs?|h|小時|時)\s*(\d{1,2})\s*(?:minutes?|mins?|m|分鐘|分)?$/.exec(s);
    if (compound) {
      const h = Number(compound[1]);
      const m = Number(compound[2]);
      if (m < 60) {
        minutes = h * 60 + m;
      }
    }
  }

  if (minutes === undefined || !Number.isFinite(minutes) || minutes < 0) {
    return undefined;
  }

  const rounded = Math.round(minutes);
  if (rounded === 0) {
    return allowZero ? 0 : undefined;
  }
  if (rounded < 1) {
    return undefined;
  }
  return Math.min(maxMin, rounded);
}

/**
 * 將正整數分鐘格式化為精簡可讀字串（同時可被 `parseDurationInput` 原樣解析回同一分鐘數）：
 * - `45` → `"45m"`
 * - `60` → `"1h"`
 * - `70` → `"1h10"`
 * - `150` → `"2h30"`
 * - `65` → `"1h05"`
 */
export function formatDurationShort(min: number): string {
  if (!Number.isFinite(min) || min <= 0) return "0m";
  const rounded = Math.round(min);
  if (rounded < 60) return `${rounded}m`;
  const h = Math.floor(rounded / 60);
  const m = rounded % 60;
  if (m === 0) return `${h}h`;
  return `${h}h${String(m).padStart(2, "0")}`;
}

/**
 * 將分鐘數拆解為雙排矩陣對應的 `{ hours, mins, isCustomMin }`。
 * - `null` 或 `<= 0` → `{ hours: null, mins: null, isCustomMin: false }`
 * - `30` → `{ hours: 0, mins: 30, isCustomMin: false }`
 * - `70` → `{ hours: 1, mins: 10, isCustomMin: false }`
 * - `25` → `{ hours: 0, mins: 25, isCustomMin: true }`
 */
export function splitDurationMatrix(min: number | null): DurationMatrixParts {
  if (min === null || !Number.isFinite(min) || min <= 0) {
    return { hours: null, mins: null, isCustomMin: false };
  }
  const rounded = Math.round(min);
  const hours = Math.floor(rounded / 60);
  const mins = rounded % 60;
  return {
    hours,
    mins,
    isCustomMin: !MATRIX_MIN_SET.has(mins),
  };
}

export interface ComposeMatrixOptions {
  allowNull?: boolean;
  maxMin?: number;
}

/**
 * 雙排矩陣點選「小時排」：
 * - 若原本為 `null`，分鐘預設 `00`（例：點 `1h` → `60`）
 * - 若選完為 `0h + 00m`：當 `allowNull`（預設 `true`）時回 `null`（清除），否則回 `null` 不變或最小格 `10`
 */
export function composeMatrixHour(
  current: number | null,
  nextHour: number,
  opts?: ComposeMatrixOptions,
): number | null {
  const allowNull = opts?.allowNull ?? true;
  const maxMin = opts?.maxMin ?? DURATION_DEFAULT_MAX;
  const parts = splitDurationMatrix(current);
  const mins = parts.mins ?? 0;
  const total = Math.max(0, Math.floor(nextHour)) * 60 + mins;
  if (total <= 0) {
    return allowNull ? null : Math.min(maxMin, 15);
  }
  return Math.min(maxMin, total);
}

/**
 * 雙排矩陣點選「分鐘排」：
 * - 若原本為 `null`，小時預設 `0h`（例：直接點 `30m` → `30`）
 * - 若選完為 `0h + 00m`：當 `allowNull`（預設 `true`）時回 `null`（清除），否則保底 `15`
 */
export function composeMatrixMinute(
  current: number | null,
  nextMin: number,
  opts?: ComposeMatrixOptions,
): number | null {
  const allowNull = opts?.allowNull ?? true;
  const maxMin = opts?.maxMin ?? DURATION_DEFAULT_MAX;
  const parts = splitDurationMatrix(current);
  const hours = parts.hours ?? 0;
  const total = hours * 60 + Math.max(0, Math.floor(nextMin));
  if (total <= 0) {
    return allowNull ? null : Math.min(maxMin, 15);
  }
  return Math.min(maxMin, total);
}
