/**
 * 售票口「時刻」換 ClockInput 的值換算（UI 丙-5 F1／F2／F3；契約 §1 F、地圖 §3.2）。
 *
 * 兩邊的語言不一樣：
 *   - 售票口存的是**牆鐘** "HH:MM"（0–23）＋帳日 key；`atOf(dayKey, hhmm, dayStartHour)` 把「日界線前的凌晨」算到隔一個日曆日。
 *   - 共用 `ClockInput` 吃毫秒，打字認營業日表記（日界線 04:00 下帳日 10/23 打 "25:00"＝10/24 01:00）。
 * 存回一律寫牆鐘：毫秒 → `msToWallHHMM` → "01:00"，再交給 `atOf(10/23, "01:00")` 還是同一刻、帳日仍是 10/23。
 * **不要用 `panel/clockValue.ts` 的 `msToClock`**——它吐營業日表記 "25:00"，`atOf` 收到 h>23 直接丟例外。
 *
 * 零 store import（`scripts/tests/ticket-clock.test.ts` 直接載入）。
 */
import { atOf } from "../../domain/ticket";

const MIN = 60_000;

const pad2 = (n: number): string => (n < 10 ? "0" : "") + n;

/**
 * 那個帳日可以排的時刻範圍（毫秒）：日界線那一刻起 24 小時，hi＝最後一分（同 panel/clockValue 的 clockBounds 語意）。
 * 用日曆日造（不用 lo＋24h 毫秒）：日光節約那天也落在「隔天日界線前一分」。dayKey 一定是 "YYYY-MM-DD"（帳日 key）。
 */
export function ticketClockBounds(dayKey: string, dayStartHour: number): { lo: number; hi: number } {
  const [y, m, d] = dayKey.split("-").map(Number);
  const lo = new Date(y, m - 1, d, dayStartHour, 0).getTime();
  const hi = new Date(y, m - 1, d + 1, dayStartHour, 0).getTime() - MIN;
  return { lo, hi };
}

/** 帳日＋牆鐘 "HH:MM" → 毫秒（`atOf`：h < dayStartHour 算隔一個日曆日）；字串看不懂（例：新票草稿還是空字串）回 null */
export function ticketClockValue(dayKey: string, hhmm: string, dayStartHour: number): number | null {
  try {
    return Date.parse(atOf(dayKey, hhmm, dayStartHour));
  } catch {
    return null;
  }
}

/** 毫秒 → 本地牆鐘 "HH:MM"（小時 0–23；同 domain `localTime`）。存回 `setDraft({time})`／`atOf` 用這個 */
export function msToWallHHMM(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
