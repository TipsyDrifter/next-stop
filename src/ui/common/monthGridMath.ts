/**
 * monthGridMath——共用日期挑選器「自畫月格」的純函式（旅客筆記車次③ 0-6 甲、D-筆-46 修訂）。
 *
 * 零 import、只用可剝除語法：`node --test scripts/tests/month-grid.test.ts` 直接載。
 * 日子一律是 `YYYY-MM-DD` 字串、月份是 `YYYY-MM`；只在算星期幾與月底時借 `Date`（本地時區、只看年月日，不碰時刻）。
 * 週首 `weekStart` 用 JS `getDay()` 的值（0＝週日、1＝週一；＝uiStore.weekStart）。
 * 不搬 `domain/notes.ts` 的月曆函式：`src/ui/common` 不 import 線的 domain（契約 §6.2-11）。
 */

/** 一頁月格固定 6 列 × 7 欄（換月時高度不跳） */
export const GRID_CELLS = 42;

function pad2(n: number): string {
  return (n < 10 ? "0" : "") + n;
}

function partsOf(key: string): [number, number, number] {
  const [y, m, d] = key.split("-").map(Number);
  return [y, m, d || 1];
}

function keyOfDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** "2026-10-05" → "2026-10" */
export function monthOfDay(day: string): string {
  return day.slice(0, 7);
}

/** YYYY-MM ±n 月 */
export function shiftMonth(month: string, n: number): string {
  const [y, m] = partsOf(month);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

/** 該月天數 */
export function daysInMonth(month: string): number {
  const [y, m] = partsOf(month);
  return new Date(y, m, 0).getDate();
}

/** YYYY-MM-DD ±n 天 */
export function shiftDay(day: string, n: number): string {
  const [y, m, d] = partsOf(day);
  return keyOfDate(new Date(y, m - 1, d + n));
}

/** 該月第 d 日（超過月底就落在月底；換月時保留「同一個日」用） */
export function dayInMonth(month: string, d: number): string {
  return `${month}-${pad2(Math.max(1, Math.min(d, daysInMonth(month))))}`;
}

/** 1 日前面要空幾格：(1 日的 getDay − weekStart + 7) % 7 */
export function leadBlanks(month: string, weekStart: number): number {
  const [y, m] = partsOf(month);
  return (new Date(y, m - 1, 1).getDay() - weekStart + 7) % 7;
}

/** 欄頭：weekStart=1 ⇒「一二三四五六日」；0 ⇒「日一二三四五六」 */
export function weekHeads(weekStart: number): string[] {
  const zh = ["日", "一", "二", "三", "四", "五", "六"];
  return Array.from({ length: 7 }, (_, i) => zh[(weekStart + i) % 7]);
}

/** 一頁 42 格：前置空格＝null、該月的日、補滿 6 列的尾端空格＝null */
export function monthCells(month: string, weekStart: number): (string | null)[] {
  const lead = leadBlanks(month, weekStart);
  const n = daysInMonth(month);
  return Array.from({ length: GRID_CELLS }, (_, i) => {
    const d = i - lead + 1;
    return d >= 1 && d <= n ? `${month}-${pad2(d)}` : null;
  });
}

/** 這一天能不能點：落在 min／max 內（都含） */
export function inRange(day: string, min?: string, max?: string): boolean {
  return (!min || day >= min) && (!max || day <= max);
}

/** 換月箭頭能不能按：整個目標月都在 min／max 外就不能 */
export function canShowMonth(month: string, min?: string, max?: string): boolean {
  return (!min || `${month}-${pad2(daysInMonth(month))}` >= min) && (!max || `${month}-01` <= max);
}

/** 開啟時顯示哪個月：value 的月 → 否則 today 的月；再夾進 min／max 的月 */
export function initialMonth(value: string | null | undefined, today: string, min?: string, max?: string): string {
  let m = monthOfDay(value || today);
  if (max && m > monthOfDay(max)) m = monthOfDay(max);
  if (min && m < monthOfDay(min)) m = monthOfDay(min);
  return m;
}

/** 這個月裡，鍵盤焦點（roving tabindex）落在哪一格：value → today → 第一個能點的日；全月都不能點＝1 日 */
export function focusDayOf(
  month: string,
  value: string | null | undefined,
  today: string,
  min?: string,
  max?: string,
): string {
  if (value && monthOfDay(value) === month && inRange(value, min, max)) return value;
  if (monthOfDay(today) === month && inRange(today, min, max)) return today;
  const n = daysInMonth(month);
  for (let d = 1; d <= n; d++) {
    const k = `${month}-${pad2(d)}`;
    if (inRange(k, min, max)) return k;
  }
  return `${month}-01`;
}

/**
 * 方向鍵在格間移動：回傳新焦點日（可能落到前後月，呼叫端跟著換月）；不認得的鍵或落到 min／max 外＝null（不動）。
 *   ←／→ ±1 天、↑／↓ ±7 天、PageUp／PageDown ±1 月（同一個日，超過月底落月底）、Home／End＝本月 1 日／月底
 */
export function moveFocus(day: string, key: string, min?: string, max?: string): string | null {
  const month = monthOfDay(day);
  const d = partsOf(day)[2];
  let next: string | null = null;
  switch (key) {
    case "ArrowLeft":
      next = shiftDay(day, -1);
      break;
    case "ArrowRight":
      next = shiftDay(day, 1);
      break;
    case "ArrowUp":
      next = shiftDay(day, -7);
      break;
    case "ArrowDown":
      next = shiftDay(day, 7);
      break;
    case "PageUp":
      next = dayInMonth(shiftMonth(month, -1), d);
      break;
    case "PageDown":
      next = dayInMonth(shiftMonth(month, 1), d);
      break;
    case "Home":
      next = `${month}-01`;
      break;
    case "End":
      next = dayInMonth(month, 31);
      break;
    default:
      return null;
  }
  if (next === null) return null;
  if (inRange(next, min, max)) return next;
  // 方向鍵越界＝不動；PageUp／PageDown／Home／End 越界＝夾到邊界（例：max＝今天，下個月同一日在未來 ⇒ 停在今天）
  if (key.startsWith("Arrow")) return null;
  const clamped = min && next < min ? min : max && next > max ? max : next;
  return clamped === day ? null : clamped;
}

/** 月格上一個按鍵要做什麼（磨光⑤ S8：DayGrid 的鍵盤規則全在這裡，元件只照做） */
export type GridKeyAction =
  /** 焦點移到這一天（可能跨月，呼叫端跟著換月） */
  | { type: "move"; day: string }
  /** 選這一天（Enter；Space 交給按鈕自己點，避免 keyup 再點一次） */
  | { type: "pick"; day: string }
  /** 認得的鍵但走不動（到邊界、焦點日不能點）：吃掉，免得捲動頁面或被頁面鍵盤表拿去用 */
  | { type: "swallow" };

/**
 * 方向鍵／PageUp／PageDown／Home／End＝moveFocus；Enter＝選焦點日（不在 min／max 內就只吃掉）；
 * 其他鍵＝null（不處理、照常冒泡——Esc 由外層挑選器收起，Tab 照常移焦點）。
 */
export function gridKeyAction(day: string, key: string, min?: string, max?: string): GridKeyAction | null {
  if (key === "Enter") return inRange(day, min, max) ? { type: "pick", day } : { type: "swallow" };
  const to = moveFocus(day, key, min, max);
  if (to !== null) return { type: "move", day: to };
  return /^(Arrow(Left|Right|Up|Down)|PageUp|PageDown|Home|End)$/.test(key) ? { type: "swallow" } : null;
}

/** 月份標題：「2026 年 10 月」 */
export function monthTitle(month: string): string {
  const [y, m] = partsOf(month);
  return `${y} 年 ${m} 月`;
}
