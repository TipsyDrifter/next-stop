/**
 * 日期工具——執行日／締切日一律用「本地日期 key」YYYY-MM-DD（date-only，不帶時區）。
 * 日界線（決策 D9；D-時-21 起 App 預設 06:00，來源＝本檔的 `DEFAULT_DAY_START_HOUR`）：現在本地時間尚未過日界線 → 算前一天。
 * `todayKey` 的日界線必填：呼叫端一律傳 `useUiStore.getState().dayStartHour`（mock 種子用檔內常數，主線②契約 §0-1 第 7 條）。
 */
export function toDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * 日界線預設 06:00（主人 2026-10-06 拍板 D-時-21）。唯一定義在這裡（收官磨光 A4 從 uiStore 搬來、uiStore 轉出口）：
 * data 層的讀取面守門要讀設定值，又不能 import store（data/ → store/ 循環）。
 */
export const DEFAULT_DAY_START_HOUR = 6;

/**
 * settings 的 `day_start_hour` 原字串 → 時；沒設／空字串／壞值＝DEFAULT_DAY_START_HOUR。"0"（午夜）是合法值
 * （以前的 `Number(x) || 3` 會把它吃成預設）。uiStore.loadSettings 與 SQLite 讀取面的守門日共用這一份（收官磨光 A4）。
 */
export function parseDayStartHour(raw: string | null | undefined): number {
  return raw !== null && raw !== undefined && raw !== "" && Number.isFinite(Number(raw)) ? Number(raw) : DEFAULT_DAY_START_HOUR;
}

export function todayKey(dayStartHour: number, now: Date = new Date()): string {
  const d = new Date(now);
  if (d.getHours() < dayStartHour) d.setDate(d.getDate() - 1);
  return toDateKey(d);
}

/**
 * 某個時刻戳（UTC ISO）落在哪一個「日界線日」——todayKey 的通用版。
 * 用途：M3 ④ 把 occurrences.completed_at／updated_at 換算成班次的錨點日（完成後 N 天要從哪天起算）。
 */
export function dayKeyOf(iso: string, dayStartHour = 3): string {
  return todayKey(dayStartHour, new Date(iso));
}

export function addDays(key: string, n: number): string {
  const [y, m, d] = key.split("-").map(Number);
  return toDateKey(new Date(y, m - 1, d + n));
}

/**
 * 某個「日界線日」的時間視窗，回傳 UTC ISO 上下界（[start, end)）。
 * dateKey 這一天＝本地 dateKey 的 dayStartHour 點 起，到隔天同一時刻止。
 * 用途：判斷 completed_at／logged_at 這種時刻戳「算不算今天」（M3 ③ 今日聚合的第四條 OR）。
 */
export function dayWindow(dateKey: string, dayStartHour = 3): { start: string; end: string } {
  const [y, m, d] = dateKey.split("-").map(Number);
  return {
    start: new Date(y, m - 1, d, dayStartHour).toISOString(),
    end: new Date(y, m - 1, d + 1, dayStartHour).toISOString(),
  };
}

/** 時刻戳（UTC ISO）落在 dateKey 這個日界線日之內？ */
export function isInDay(iso: string | null, dateKey: string, dayStartHour = 3): boolean {
  if (!iso) return false;
  const { start, end } = dayWindow(dateKey, dayStartHour);
  return iso >= start && iso < end;
}

// ───────────── 預定時刻（主線階段②；營業日表記）─────────────
// 全部是純函式、零 import——時刻表線④直接 import（契約 §3.1／§5.3）。

/**
 * 營業日表記的時刻（主線階段②）："HH:MM"，兩位小時、兩位分；小時可以 ≥ 24。
 * 「這一天」從日界線（dayStartHour:00）起算 24 小時：日界線 06:00 時 "25:00"＝隔天凌晨 01:00、"29:59" 是最後一分。
 * 存的字就是看到的字；比字串就是比時間（兩位補零）。
 * 讀取不驗範圍（改了日界線，已存的字不翻面）；只有寫入前用 parseClockInput／isClockInRange 驗。
 * 全部是牆鐘算法（本地欄位），不是 elapsed 毫秒——DST 轉換日也以牆鐘為準。
 */
export type ClockText = string;

const CLOCK_RE = /^\d{2}:\d{2}$/;
const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** clockText 放得進兩位小時的上限（100:00 = 6000 分鐘放不進） */
const CLOCK_TEXT_LIMIT_MIN = 6000;

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n));

/** 這一天合法時刻的分鐘範圍（含兩端）：[dayStartHour*60, dayStartHour*60 + 1439] */
export function clockRange(dayStartHour: number): { min: number; max: number } {
  return { min: dayStartHour * 60, max: dayStartHour * 60 + 1439 };
}

/** "HH:MM" → 自 00:00 起的牆鐘分鐘（"25:30" → 1530）。格式不是 /^\d{2}:\d{2}$/ 或分 ≥ 60 ⇒ null。不驗範圍 */
export function clockMinutes(t: string): number | null {
  if (typeof t !== "string" || !CLOCK_RE.test(t)) return null;
  const h = Number(t.slice(0, 2));
  const m = Number(t.slice(3, 5));
  if (m >= 60) return null;
  return h * 60 + m;
}

/** 分鐘 → "HH:MM"（1530 → "25:30"）。負數／非整數／≥ 6000（放不進兩位小時）⇒ null */
export function clockText(min: number): ClockText | null {
  if (!Number.isInteger(min) || min < 0 || min >= CLOCK_TEXT_LIMIT_MIN) return null;
  return `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`;
}

/** 全形數字／全形冒號轉半形，"." 與 "．" 當冒號 */
function normalizeClockInput(raw: string): string {
  return raw
    .trim()
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xff10 + 0x30))
    .replace(/[：．.]/g, ":");
}

/**
 * 使用者輸入 → 營業日表記；看不懂或超出範圍 ⇒ null。
 * 接受（去前後空白、全形數字與全形冒號轉半形、"." 當冒號）："14"、"9"、"930"、"0930"、"1400"、"14:00"、"2:30"、"2.30"、"14：00"、"25:00"、"2500"。
 * 規則：解析成 H:M（H 0–47、M 0–59；1–2 位無冒號＝整點、3 位＝HMM、4 位＝HHMM）→ m = H*60+M；
 *       m < range.min ⇒ m += 1440（「1:00」在日界線 06:00 下＝25:00；「6」＝06:00 不加）；
 *       m 仍落在 range 之外 ⇒ null（「30:00」在 06:00 下、「25:00」在 00:00 下都拒收）。
 * 空字串／只有空白 ⇒ null（呼叫端先用 raw.trim() === "" 判「清除」，再叫這支判「無效」）。
 * 不認中文（「下午3點」「9點半」⇒ null；原型 :1384 的提示只說「要下午請打 14:30」）。
 * 帶冒號時分鐘必須兩位（"2:3" ⇒ null，免得 "2.3" 被讀成 02:03）。
 */
export function parseClockInput(raw: string, dayStartHour: number): ClockText | null {
  if (typeof raw !== "string") return null;
  const s = normalizeClockInput(raw);
  if (s === "") return null;
  let h: number;
  let mi: number;
  const colon = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (colon) {
    h = Number(colon[1]);
    mi = Number(colon[2]);
  } else if (/^\d{1,4}$/.test(s)) {
    if (s.length <= 2) {
      h = Number(s);
      mi = 0;
    } else {
      h = Number(s.slice(0, s.length - 2));
      mi = Number(s.slice(-2));
    }
  } else {
    return null;
  }
  if (h > 47 || mi > 59) return null;
  const range = clockRange(dayStartHour);
  let m = h * 60 + mi;
  if (m < range.min) m += 1440;
  if (m < range.min || m > range.max) return null;
  return clockText(m);
}

/** 已成形的字是不是合法的營業日表記（格式＋在 clockRange 內）。repository 寫入前用 */
export function isClockInRange(t: string, dayStartHour: number): boolean {
  const m = clockMinutes(t);
  if (m === null) return false;
  const r = clockRange(dayStartHour);
  return m >= r.min && m <= r.max;
}

/** 拆 dateKey；格式不對 ⇒ null */
function splitDateKey(dateKey: string): { y: number; mo: number; d: number } | null {
  const m = typeof dateKey === "string" ? DATE_KEY_RE.exec(dateKey) : null;
  return m ? { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) } : null;
}

/** 執行日＋時刻 → 本地瞬時（ms）＝ new Date(y, m-1, d, HH, MM).getTime()（牆鐘；HH ≥ 24 由 Date 進位到隔天）。格式不對 ⇒ null */
export function clockInstant(dateKey: string, t: string): number | null {
  const dk = splitDateKey(dateKey);
  const min = clockMinutes(t);
  if (dk === null || min === null) return null;
  return new Date(dk.y, dk.mo - 1, dk.d, Math.floor(min / 60), min % 60).getTime();
}

/**
 * 執行日＋時刻＋預計分鐘 → 區段 [start, end)（ms，牆鐘：end＝new Date(y, m-1, d, HH, MM + estimate)）。
 * estimateMin 不是正數 ⇒ end === start（沒長度；怎麼畫由 UI 決定，D-主-15）。不裁切：超出這一天的部分由畫的人裁。格式不對 ⇒ null
 */
export function clockSpan(
  dateKey: string,
  t: string,
  estimateMin: number | null,
): { start: number; end: number } | null {
  const dk = splitDateKey(dateKey);
  const min = clockMinutes(t);
  if (dk === null || min === null) return null;
  const hh = Math.floor(min / 60);
  const mm = min % 60;
  const start = new Date(dk.y, dk.mo - 1, dk.d, hh, mm).getTime();
  const hasLen = typeof estimateMin === "number" && Number.isFinite(estimateMin) && estimateMin > 0;
  const end = hasLen ? new Date(dk.y, dk.mo - 1, dk.d, hh, mm + estimateMin).getTime() : start;
  return { start, end };
}

/** 這一班的時刻已經過了（now ≥ clockInstant）。t 為 null／格式不對 ⇒ false。now 預設 Date.now() */
export function isClockPast(dateKey: string, t: string | null, now: number = Date.now()): boolean {
  if (t === null || t === undefined) return false;
  const at = clockInstant(dateKey, t);
  return at !== null && now >= at;
}

/** 排序鍵：有時刻的在前（字串序）、沒時刻的在後；兩個都沒有 ⇒ 0 */
export function compareClock(a: string | null | undefined, b: string | null | undefined): number {
  const an = a === null || a === undefined;
  const bn = b === null || b === undefined;
  if (an && bn) return 0;
  if (an) return 1;
  if (bn) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 顯示用小註：clockMinutes(t) >= 1440 ⇒ "隔天 01:00"（HH−24，補零）；否則 null。原型 :775 wallNext */
export function nextDayNote(t: string): string | null {
  const m = clockMinutes(t);
  if (m === null || m < 1440) return null;
  return `隔天 ${clockText(m - 1440)}`;
}

/** 到站時刻（D-主-12 側板「→ 15:30 着」、手機 sheet「→ 15:30 着（90 分）」）：t＋estimate 的營業日表記；estimate 不是正數 ⇒ null；超過 6000 分鐘 ⇒ null */
export function arrivalClock(t: string, estimateMin: number | null): ClockText | null {
  const m = clockMinutes(t);
  if (m === null) return null;
  if (typeof estimateMin !== "number" || !Number.isFinite(estimateMin) || estimateMin <= 0) return null;
  return clockText(Math.round(m + estimateMin));
}

/** 現在在這一天軸上的牆鐘分鐘（自 00:00 起，可 ≥ 1440）；now 不在 dateKey 這個營業日（用 clockRange 判）⇒ null。本地欄位算，不用毫秒差 */
export function nowClockMinutes(dateKey: string, dayStartHour: number, now: number = Date.now()): number | null {
  const dk = splitDateKey(dateKey);
  if (dk === null) return null;
  const n = new Date(now);
  const days = Math.round((Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()) - Date.UTC(dk.y, dk.mo - 1, dk.d)) / 86400000);
  const wall = days * 1440 + n.getHours() * 60 + n.getMinutes();
  const r = clockRange(dayStartHour);
  return wall >= r.min && wall <= r.max ? wall : null;
}
