/**
 * 時間選擇器（站鐘錶盤）——純函式（庚 D-主-420；元件 `ui/common/TimeDial.tsx`）。
 *
 * 點錶盤跟打字走同一條路：把「HH:MM」交給 `resolveClockInput`，營業日表記、跨天、範圍全照打字的規則，這裡不另算。
 * 錶盤的幾何：外圈 1–12 點、內圈 00、13–23 點（各 12 格，12 與 00 在正上方）；分鐘一圈 60 格。
 * 時間一律毫秒；不讀時鐘（現在由呼叫端給）。
 */
import { clockInputPreview, resolveClockInput, type ClockInputBounds } from "./timetableClockInput.ts";

/** 外圈、內圈的半徑（錶盤邊長的比例）；viewBox 100 時就是 43、30 */
export const DIAL_OUTER_R = 0.43;
export const DIAL_INNER_R = 0.3;
/** 離圓心比這近＝角度不穩，不算點到 */
const DIAL_DEAD_R = 0.08;

const pad2 = (n: number): string => (n < 10 ? "0" : "") + n;

/** 毫秒 → 牆鐘的時與分 */
export function wallParts(ms: number): { h: number; m: number } {
  const d = new Date(ms);
  return { h: d.getHours(), m: d.getMinutes() };
}

/** 這一格（牆鐘時、分）換成毫秒；不在範圍回 null */
export function timeCellMs(h: number, m: number, b: ClockInputBounds): number | null {
  const r = resolveClockInput(`${pad2(h)}:${pad2(m)}`, b);
  return "ms" in r ? r.ms : null;
}

/** 這個小時裡離 m 最近、可以選的一分換成毫秒；整個小時都不行回 null */
export function minuteNearest(h: number, m: number, b: ClockInputBounds): number | null {
  for (let d = 0; d < 60; d++) {
    for (const c of d === 0 ? [m] : [m - d, m + d]) {
      if (c < 0 || c > 59) continue;
      const ms = timeCellMs(h, c, b);
      if (ms !== null) return ms;
    }
  }
  return null;
}

/** 這個小時有沒有哪一分可以選（範圍落在小時中間也算有：例如只能選 14:20–14:40） */
export function hourEnabled(h: number, b: ClockInputBounds): boolean {
  return minuteNearest(h, 30, b) !== null;
}

/**
 * 這一格實際落在別天時的說明（「隔天」「前一天」「3 天後」）；同一天回 null。照算出來的值判斷、不照「小時在日界線前」：
 * 打字規則允許往前後跳一天（補記的範圍往回開時，18 點是前一天 18 點，00 點反而是今天），只看小時會標錯。
 */
export function otherDayNote(ms: number, refDay: string): string | null {
  const [pre] = clockInputPreview(ms, refDay);
  return pre === "→ " ? null : pre.replace("＝", "").trim();
}

/* ───────── 錶盤幾何 ───────── */

/** 指標相對圓心的位移 → 從正上方順時針的角度（0–360） */
export function dialAngle(dx: number, dy: number): number {
  return ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
}

/** 這個小時排在錶面哪裡：第幾格（0＝正上方）、內圈或外圈 */
export function dialHourSlot(h: number): { slot: number; inner: boolean } {
  return { slot: h % 12, inner: h === 0 || h > 12 };
}

/** 第幾格的中心（0–100 的百分比座標）；slots＝一圈幾格，r＝半徑（邊長比例） */
export function dialPoint(slot: number, slots: number, r: number): { x: number; y: number } {
  const a = (slot / slots) * 2 * Math.PI;
  return { x: 50 + r * 100 * Math.sin(a), y: 50 - r * 100 * Math.cos(a) };
}

/** 點在哪個小時；r＝離圓心的距離（邊長比例），兩圈中間為界。太靠近圓心回 null */
export function dialHourAt(angle: number, r: number): number | null {
  if (r < DIAL_DEAD_R) return null;
  const slot = Math.round(angle / 30) % 12;
  return r < (DIAL_OUTER_R + DIAL_INNER_R) / 2 ? (slot === 0 ? 0 : slot + 12) : slot === 0 ? 12 : slot;
}

/** 點在哪一分：snap＝落到 5 分一格（點一下）；否則到 1 分（拖）。太靠近圓心回 null */
export function dialMinuteAt(angle: number, r: number, snap: boolean): number | null {
  if (r < DIAL_DEAD_R) return null;
  return snap ? (Math.round(angle / 30) % 12) * 5 : Math.round(angle / 6) % 60;
}

/** 方向鍵走小時：dir＝±1，跳過不能選的、繞一圈；都不能選回 null */
export function dialStepHour(h: number, dir: 1 | -1, b: ClockInputBounds): number | null {
  for (let i = 1; i < 24; i++) {
    const c = (h + dir * i + 24) % 24;
    if (hourEnabled(c, b)) return c;
  }
  return null;
}

/** 方向鍵走分鐘：d＝±1、±5，在這個小時裡繞圈，跳過不能選的；換成毫秒，都不能選回 null */
export function dialStepMinute(h: number, m: number, d: number, b: ClockInputBounds): number | null {
  for (let i = 1; i < 60; i++) {
    const c = (((m + d * i) % 60) + 60) % 60;
    const ms = timeCellMs(h, c, b);
    if (ms !== null) return ms;
  }
  return null;
}
