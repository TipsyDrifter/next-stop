/**
 * 側板「幾點」的換算（UI 丙-3 C5）：資料是營業日表記 "HH:MM"（小時可 ≥ 24，日界線 03:00 下 "25:00"＝隔天 01:00；lib/date 檔頭），
 * 共用 `ClockInput` 吃的是毫秒。兩邊都以**這一天**（refDay＝營業日 key，通常是執行日）為基準換：
 *   "25:00" ＋ 10/23 → 10/24 01:00 的毫秒 → 存回時再算回 "25:00"（不是 "01:00"），營業日語意不壞。
 * 零 store import（`scripts/tests/panel-clock-value.test.ts` 直接載入）。
 */
import { arrivalClock, clockInstant, clockMinutes, clockRange, clockText, parseClockInput } from "../../lib/date";

const MIN = 60_000;
/** 時段的結束格沒有長度時，點下去從開始後多久起（同時刻表⑦「其他時段」新一段的預設長度） */
const SPAN_SEED_MIN = 60;

/** 營業日表記 → 毫秒（壞字串 null） */
export function clockToMs(t: string, refDay: string): number | null {
  return clockInstant(refDay, t);
}

/** 毫秒 → 營業日表記：以 refDay 的 00:00 起算的牆鐘分鐘（隔天 01:00 ⇒ 1500 ⇒ "25:00"）；算出負數或放不進兩位小時 ⇒ null */
export function msToClock(ms: number, refDay: string): string | null {
  const [y, m, d] = refDay.split("-").map(Number);
  if (!y || !m || !d) return null;
  const at = new Date(ms);
  // 以日曆日相減算天數（不用毫秒差除一天：日光節約那天會差一小時）
  const days = Math.round(
    (Date.UTC(at.getFullYear(), at.getMonth(), at.getDate()) - Date.UTC(y, m - 1, d)) / 86_400_000,
  );
  return clockText(days * 1440 + at.getHours() * 60 + at.getMinutes());
}

/** 這一天可以排的時刻範圍（毫秒）：日界線那一刻起 24 小時的最後一分（同 parseClockInput 的範圍） */
export function clockBounds(refDay: string, dayStartHour: number): { lo: number; hi: number } {
  const r = clockRange(dayStartHour);
  const lo = clockInstant(refDay, clockText(r.min) ?? "00:00") ?? 0;
  return { lo, hi: lo + (r.max - r.min) * MIN };
}

/**
 * 還沒排時刻、按下去要從哪個時刻起：這一天是今天 ⇒ 現在往後取整到 15 分；其他天 ⇒ 09:00。都夾在這一天的範圍裡。
 * 只是起點——不按 Enter、不動它就離開，什麼都不存。
 */
export function clockSeed(refDay: string, today: string, dayStartHour: number, now: number = Date.now()): number {
  const { lo, hi } = clockBounds(refDay, dayStartHour);
  let seed: number;
  if (refDay === today) {
    const q = 15 * MIN;
    seed = Math.ceil(now / q) * q;
  } else {
    seed = clockInstant(refDay, parseClockInput("09:00", dayStartHour) ?? "09:00") ?? lo;
  }
  return Math.max(lo, Math.min(seed, hi));
}

/* ───────────── 時段組（D-主-129）：開始 → 結束兩格；資料只有 scheduled_time＋estimate_min，結束是算出來的 ───────────── */

/** 結束格的值＝開始＋長度（營業日表記，過午夜寫 "25:30"）；沒排開始或沒有長度＝null */
export function spanEnd(start: string | null, estimateMin: number | null): string | null {
  return start ? arrivalClock(start, estimateMin) : null;
}

/** 改結束 → 新長度（分）＝結束−開始；結束不晚於開始（或任一格壞字串）＝null，呼叫端不寫 */
export function spanLen(start: string, end: string): number | null {
  const a = clockMinutes(start);
  const b = clockMinutes(end);
  if (a === null || b === null) return null;
  return b > a ? b - a : null;
}

/**
 * 結束格的範圍（毫秒）：開始後一分起（等於或早於開始＝ClockInput 打錯規則擋下、說明行寫範圍），到這一天的終點；
 * 現有的結束已經超過終點（長度很長、開始又晚）就放寬到它——框裡的值不能落在範圍外。開始是壞字串＝null。
 */
export function spanEndBounds(
  start: string,
  end: string | null,
  refDay: string,
  dayStartHour: number,
): { lo: number; hi: number } | null {
  const s = clockToMs(start, refDay);
  if (s === null) return null;
  const day = clockBounds(refDay, dayStartHour);
  const e = end !== null ? clockToMs(end, refDay) : null;
  return { lo: s + MIN, hi: Math.max(day.hi, s + MIN, e ?? 0) };
}

/** 結束格沒有長度、點下去的起點：開始後 60 分，夾在結束格的範圍裡 */
export function spanEndSeed(bounds: { lo: number; hi: number }): number {
  return Math.min(bounds.lo - MIN + SPAN_SEED_MIN * MIN, bounds.hi);
}
