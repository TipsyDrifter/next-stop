/**
 * 側板「幾點」的換算（UI 丙-3 C5）：資料是營業日表記 "HH:MM"（小時可 ≥ 24，日界線 03:00 下 "25:00"＝隔天 01:00；lib/date 檔頭），
 * 共用 `ClockInput` 吃的是毫秒。兩邊都以**這一天**（refDay＝營業日 key，通常是執行日）為基準換：
 *   "25:00" ＋ 10/23 → 10/24 01:00 的毫秒 → 存回時再算回 "25:00"（不是 "01:00"），營業日語意不壞。
 * 零 store import（`scripts/tests/panel-clock-value.test.ts` 直接載入）。
 */
import { clockInstant, clockRange, clockText, parseClockInput } from "../../lib/date";

const MIN = 60_000;

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
