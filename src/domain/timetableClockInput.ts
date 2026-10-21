/**
 * 時刻表・可打字的時刻框——純函式（磨光⑥ 契約 §1-1、§1-5½；D-時-142、143、148）。
 *
 * - 解析一律走 `lib/date.ts` 的 `parseClockInput`（打的是「營業日的時刻」，接受 0830、8:30、25:00、全形…），這裡不另寫解析；
 *   「看不懂」與「超出這一天」的分辨照 `ui/panel/TimeField.tsx` judge 的寫法：用兩個極端的日界線（0、23）再問一次。
 * - 換成毫秒（D-時-143）：打的是營業日表記，先看 `dayKeyOf(目前值)` 那一天（`clockInstant`）——在 [lo, hi] 裡就是它；
 *   不在才退到前一天／後一天：取在範圍裡、離目前值 12 小時內、最近的那一個；都沒有 ⇒ range。
 *   12 小時：免得手滑（到着 09:15 時発車打 1000）被解成前一天 10:00、默默變成一塊 23 小時的紀錄（磨光⑥ 評審 #3）；
 *   改出發時間往前到前一晚、日界線 00:00 下跨午夜這類正當的跨天都在 12 小時內。
 * - 時間一律毫秒；不讀時鐘（`now` 由呼叫端給）。只 import `./timetable.ts` 與 `../lib/date.ts`。
 */
import { MIN, fmtClock } from "./timetable.ts";
import { addDays, clockInstant, dayKeyOf, dayWindow, parseClockInput, toDateKey } from "../lib/date.ts";

const DAY = 24 * 60 * MIN;
/** 前一天／後一天的候選離目前值超過這個就不取 */
const ADJACENT_MAX = 12 * 60 * MIN;

export interface ClockInputBounds {
  /** 目前值（ms）——「離它最近的那一天」的基準 */
  value: number;
  lo: number;
  hi: number;
  dayStartHour: number;
  /**
   * 「當天」是哪個營業日（選填；預設 dayKeyOf(value)）。UI 傳 clockInputRefDay（看的那一天含頭尾）——
   * 到着停在日界線那一刻（過去那天的最後一段空白）時，dayKeyOf 會算成下一天，回頭打前一天下午就被 12 小時擋掉（真機代驗 D1）。
   */
  baseDay?: string;
}

/** range 的 side：最近的那個候選落在 hi 之後＝late、lo 之前＝early（錯誤訊息只寫綁住的那一側時用） */
export type ClockInputResult = { ms: number } | { err: "bad" } | { err: "range"; side: "early" | "late" };

/**
 * 打的字 → 毫秒（D-時-143）。空字串回 bad（呼叫端先把空字串當「還原」處理，不會叫到這支）。
 * lo 不在整分上時（例：発車 08:30:20 ⇒ 到着的 lo＝08:31:20），打 08:31 會被拉到 lo——顯示的字一樣、範圍說明寫的也是 08:31。
 */
export function resolveClockInput(raw: string, b: ClockInputBounds): ClockInputResult {
  const t = parseClockInput(raw, b.dayStartHour);
  if (t === null) {
    // 格式對、只是不在這一天（例：日界線 03:00 下的 28:00）⇒ 超出範圍；連格式都不對 ⇒ 看不懂
    if (parseClockInput(raw, 0) !== null || parseClockInput(raw, 23) !== null) return { err: "range", side: "late" };
    return { err: "bad" };
  }
  const base = b.baseDay ?? dayKeyOf(new Date(b.value).toISOString(), b.dayStartHour);
  const loFloor = Math.floor(b.lo / MIN) * MIN;
  let best: number | null = null;
  let nearest: number | null = null;
  for (const k of [0, -1, 1]) {
    let c = clockInstant(addDays(base, k), t);
    if (c === null) continue;
    if (k !== 0 && Math.abs(c - b.value) > ADJACENT_MAX) continue;
    if (nearest === null || Math.abs(c - b.value) < Math.abs(nearest - b.value)) nearest = c;
    if (c < b.lo && c >= loFloor) c = b.lo; // 跟 lo 同一分鐘
    if (c < b.lo || c > b.hi) continue;
    if (k === 0) return { ms: c }; // 當天的在範圍裡＝就是它（營業日表記打的就是這一天）
    if (best === null || Math.abs(c - b.value) < Math.abs(best - b.value)) best = c;
  }
  if (best !== null) return { ms: best };
  return { err: "range", side: nearest !== null && nearest < b.lo ? "early" : "late" };
}

/** 錯在哪的說明（說明行用）。lo 離 hi 超過一天時只寫綁住的那一側 */
export function clockInputErrText(r: Exclude<ClockInputResult, { ms: number }>, lo: number, hi: number): string {
  if (r.err === "bad") return "看不懂，例：0830、8:30、25:00";
  if (hi - lo <= DAY) return `要在 ${fmtClock(lo)}–${fmtClock(hi)} 之間`;
  return r.side === "early" ? `不能早於 ${fmtClock(lo)}` : `不能晚於 ${fmtClock(hi)}`;
}

/**
 * 說明行的「哪一天」基準：目前值落在看的那一天（含頭尾）⇒ 看的那一天；不在（例：看別天時改運行中那班）⇒ 目前值所在的營業日。
 */
export function clockInputRefDay(value: number, viewDay: string, dayStartHour: number): string {
  const w = dayWindow(viewDay, dayStartHour);
  if (value >= Date.parse(w.start) && value <= Date.parse(w.end)) return viewDay;
  return dayKeyOf(new Date(value).toISOString(), dayStartHour);
}

/**
 * 打字中的預覽（說明行用），以基準日（營業日 key）的日曆日比：同一天 ⇒「→ 08:30」；過了午夜 ⇒「＝隔天 01:00」
 * （同 lib/date nextDayNote 的寫法）；前一天 ⇒「＝前一天 23:50」。回 [前綴, 時刻]，時刻由呼叫端加粗。
 */
export function clockInputPreview(ms: number, refDay: string): [string, string] {
  const d = new Date(ms);
  const [y, m, dd] = refDay.split("-").map(Number);
  const days = Math.round((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(y, m - 1, dd)) / DAY);
  const hm = fmtClock(ms);
  if (days === 0) return ["→ ", hm];
  if (days === 1) return ["＝隔天 ", hm];
  if (days === -1) return ["＝前一天 ", hm];
  return [days > 0 ? `＝${days} 天後 ` : `＝${-days} 天前 `, hm];
}

/* ── 磨光⑤ §8 甲′（D-主-64、65）：補記跨日變長塊——看得到哪一天、超過 12 小時要確認 ──
 * 使用者 10-21：看週一、補記那段＝週一 06:00–週二 06:00（兩端都寫「06:00」），到着用鈕往後轉到 10:30 其實是週二 10:30，
 * 存成 33 小時。步進穿過日界線本身是對的（真的跨天是正當的）；缺的是畫面上看不到日期、也沒人問。 */

const WEEK_ZH = "日一二三四五六";

/**
 * 時間欄旁的短日期「10/20（一）」；`other`＝跟面板參考日（營業日 key，當日曆日看）不是同一個日曆日 ⇒ 畫成赭色。
 * 比日曆日、不比營業日：跟打字預覽「＝隔天 01:00」同一把尺（日界線 06:00 下的週一 01:30，使用者說的就是「週一 01:30」）。
 */
export function clockDateLabel(ms: number, refDay: string): { text: string; other: boolean } {
  const d = new Date(ms);
  const [y, m, dd] = refDay.split("-").map(Number);
  const other = d.getFullYear() !== y || d.getMonth() !== m - 1 || d.getDate() !== dd;
  return { text: `${d.getMonth() + 1}/${d.getDate()}（${WEEK_ZH[d.getDay()]}）`, other };
}

/** 一塊超過這個長度，存檔前要確認（D-主-64；睡眠常見 8～10 小時，12 已夠寬） */
export const LONG_BLOCK_MS = 12 * 60 * MIN;

/**
 * 起訖組成的這一塊超過 12 小時 ⇒ 確認句「這一塊有 33 小時，跨到 10/20（二）——確定嗎？」；12 小時內（含）回 null。
 * 不論是打字、步進、長按、貼齊造成的都一樣（打字那條路的 12 小時解讀規則是另一件事：它決定打的字是哪一天）。
 * 時長取整到分（同軸上的顯示）；結束跟開始同一個日曆日就不寫「跨到」。
 */
export function longBlockAsk(start: number, end: number): string | null {
  if (end - start <= LONG_BLOCK_MS) return null;
  const mins = Math.floor((end - start) / MIN);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const len = m ? `${h} 小時 ${m} 分` : `${h} 小時`;
  const endDay = clockDateLabel(end, toDateKey(new Date(start)));
  return `這一塊有 ${len}` + (endDay.other ? `，跨到 ${endDay.text}` : "") + "——確定嗎？";
}

/** 步進鈕走一步（d 分），夾在 [lo, hi]；lo > hi（區間退化）回 lo（同 panels/controls clamp）。Stepper 用，測試重現步進路徑也用這支 */
export function stepClockValue(base: number, d: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(base + d * MIN, hi));
}

/* ── 長按加速（§1-5½；D-時-148）：按下先走一步，停 HOLD_DELAY_MS 後連跳，間隔從 170ms 逐步縮到最快 45ms ── */

export const HOLD_DELAY_MS = 420;
const HOLD_FIRST_GAP_MS = 170;
const HOLD_MIN_GAP_MS = 45;
const HOLD_SHRINK = 0.84;

/** 連跳的第 n 步（0 起）之後要等多久（ms） */
export function holdGapMs(n: number): number {
  return Math.max(HOLD_MIN_GAP_MS, Math.round(HOLD_FIRST_GAP_MS * HOLD_SHRINK ** Math.max(0, n)));
}

/** 微調鈕（分）：−1h −15 −5 −1 ｜框｜ +1 +5 +15 +1h（D-時-147） */
export const CLOCK_STEPS: readonly number[] = [-60, -15, -5, -1, 1, 5, 15, 60];

/** 鈕上的字：−1h／−15／+5… */
export function clockStepLabel(d: number): string {
  const a = Math.abs(d);
  return (d < 0 ? "−" : "+") + (a === 60 ? "1h" : String(a));
}
