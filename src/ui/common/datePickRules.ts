/**
 * 日期欄「該不該送出」的判斷（純函式；原本給 DatePicker 桌機版的原生日期欄用，D-主-36）。
 * 磨光⑤ S8（D-主-54）起挑選器一律自畫月格、原生欄已拿掉：`isPickableDay` 仍由 DatePicker 轉出給呼叫端驗值，
 * 其餘幾支留著（測試照綠），之後若再出現可打字的日期欄就沿用這套規則。
 * 不 import 任何東西，`node --test` 直接載（scripts/tests/date-pick-rules.test.ts）。
 *
 * 規則：
 *   - 用月曆點選造成的 change（沒有鍵盤旗標）＝立即送出（值要合格、且跟開啟時的值不同）
 *   - 鍵盤造成的 change（數字、↑↓、Backspace／Delete）＝只更新欄位，不送——打到一半湊出的合法日期不算「選好了」
 *   - Enter＝檢查目前的值：合格 ⇒ 送出；不合格 ⇒ 還原成開啟時的值＋一行小字說為什麼
 *   - 失焦／點外面關閉＝不送出（呼叫端什麼都不做就是了）
 */

/** 日期欄的值能不能當成「選好了」：完整 YYYY-MM-DD、年份 ≥ 1970（逐位輸入會先經過 0002／0020）、落在 min／max 內 */
export function isPickableDay(d: string, min?: string, max?: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && Number(d.slice(0, 4)) >= 1970 && (!min || d >= min) && (!max || d <= max);
}

export const DATE_HINT_INCOMPLETE = "日期不完整，已還原";
export const DATE_HINT_OUT_OF_RANGE = "不在可選的範圍內，已還原";

/** 這個按鍵會改日期欄的值嗎（數字、↑↓、Backspace／Delete）；Alt+↓ 是開月曆，不算 */
export function isDateEditKey(key: string, altKey = false): boolean {
  if (altKey) return false;
  return /^\d$/.test(key) || key === "ArrowUp" || key === "ArrowDown" || key === "Backspace" || key === "Delete";
}

/** change 事件要不要立刻送出：沒有鍵盤旗標、值合格、且跟開啟時的值不同 */
export function shouldPickOnChange(
  v: string,
  keyboardEdit: boolean,
  original: string,
  min?: string,
  max?: string,
): boolean {
  return !keyboardEdit && isPickableDay(v, min, max) && v !== original;
}

export type DateEnterOutcome = { kind: "pick"; day: string } | { kind: "revert"; hint: string };

/** Enter：值合格 ⇒ 送出；不完整（含年 < 1970）⇒ 還原＋「日期不完整」；完整但超出 min／max ⇒ 還原＋「不在可選的範圍內」 */
export function resolveDateEnter(v: string, min?: string, max?: string): DateEnterOutcome {
  if (isPickableDay(v, min, max)) return { kind: "pick", day: v };
  const complete = /^\d{4}-\d{2}-\d{2}$/.test(v) && Number(v.slice(0, 4)) >= 1970;
  return { kind: "revert", hint: complete ? DATE_HINT_OUT_OF_RANGE : DATE_HINT_INCOMPLETE };
}

/* ───────────── 區間點選狀態機（第四梯 4B · D-FB-7） ───────────── */

export type RangePickStep =
  | { kind: "start"; draftStart: string }
  | { kind: "commit"; start: string; end: string | null };

/**
 * 區間模式的兩下點選規則：
 * - 第一下（`draftStart === null`）：記住起日，等待訖日
 * - 第二下（`draftStart !== null`）：
 *   - 點同一天 ⇒ 收斂為單日 `{ start: day, end: null }`
 *   - 點更早一天 ⇒ 自動對調為 `[day, draftStart]`
 *   - 點更晚一天 ⇒ `[draftStart, day]`
 */
export function stepRangePick(draftStart: string | null, day: string): RangePickStep {
  if (!draftStart) return { kind: "start", draftStart: day };
  if (day === draftStart) return { kind: "commit", start: day, end: null };
  return day < draftStart
    ? { kind: "commit", start: day, end: draftStart }
    : { kind: "commit", start: draftStart, end: day };
}

export type DayRangeRole = "single" | "start" | "mid" | "end" | null;

/** 月格某一格在 `[start, end]` 區間中的角色（供 DayGrid 標示頭尾與中間底色） */
export function dayRangeRole(
  day: string,
  start: string | null | undefined,
  end: string | null | undefined,
): DayRangeRole {
  if (!start) return null;
  if (!end || end <= start) return day === start ? "single" : null;
  if (day === start) return "start";
  if (day === end) return "end";
  if (day > start && day < end) return "mid";
  return null;
}

/** Pointer Drag 跨日拖曳正規化（起訖相同＝單日，訖早於起＝自動交換） */
export function normalizeDragRange(
  anchor: string,
  current: string,
): { start: string; end: string | null } {
  if (anchor === current) return { start: anchor, end: null };
  return current < anchor ? { start: current, end: anchor } : { start: anchor, end: current };
}

/* ───────────── 全站共用日期快選預設（v1.37 2A-1） ───────────── */

/** 一顆日期快選膠囊（多選動態「＝同乘車日」哨兵可設 `day: ""`） */
export interface DateQuickOption {
  label: string;
  /** YYYY-MM-DD（或動態語意哨兵 `""`） */
  day: string;
}

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n));

function addDaysKey(dayKey: string, delta: number): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

function dowOfKey(dayKey: string): number {
  const [y, m, d] = dayKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** 嚴格晚於 today 的最近星期一（今天是週一 ⇒ 7 天後） */
export function nextMondayKey(today: string): string {
  const dow = dowOfKey(today);
  return addDaysKey(today, (8 - dow) % 7 || 7);
}

/** 即將到來的「本週末」（週一～週六取本週六；週日取下週六，確保不落於今天以前） */
export function thisWeekendKey(today: string): string {
  const dow = dowOfKey(today);
  return dow === 0 ? addDaysKey(today, 6) : addDaysKey(today, 6 - dow);
}

/** 「本週日」：週一～週六取即將到來的週日；週日當日視 weekStart（1＝今天，0＝7 天後） */
export function thisSundayKey(today: string, weekStart: 0 | 1 = 1): string {
  const dow = dowOfKey(today);
  if (dow === 0) return weekStart === 0 ? addDaysKey(today, 7) : today;
  return addDaysKey(today, 7 - dow);
}

/** 乘車日統一快選膠囊：今天 · 明天 · 後天 · 本週末 · 下週一 */
export function scheduledQuickSet(today: string, _weekStart: 0 | 1 = 1): DateQuickOption[] {
  return [
    { label: "今天", day: today },
    { label: "明天", day: addDaysKey(today, 1) },
    { label: "後天", day: addDaysKey(today, 2) },
    { label: "本週末", day: thisWeekendKey(today) },
    { label: "下週一", day: nextMondayKey(today) },
  ];
}

/** 締切日統一快選膠囊：[＝同乘車日（有乘車日時顯示）] · 今天 · 明天 · 本週日 · 下週一 */
export function dueQuickSet(
  today: string,
  opts?: { scheduledOn?: string | null; weekStart?: 0 | 1; dynamicSync?: boolean },
): DateQuickOption[] {
  const list: DateQuickOption[] = [];
  if (opts?.scheduledOn) {
    list.push({ label: "＝同乘車日", day: opts.scheduledOn });
  } else if (opts?.dynamicSync) {
    list.push({ label: "＝同乘車日", day: "" });
  }
  list.push(
    { label: "今天", day: today },
    { label: "明天", day: addDaysKey(today, 1) },
    { label: "本週日", day: thisSundayKey(today, opts?.weekStart ?? 1) },
    { label: "下週一", day: nextMondayKey(today) },
  );
  return list;
}

/** 往回快選（日記／售票口記帳等往回翻的情境）：今天 · 昨天 · 前天 */
export function backwardQuickSet(today: string): DateQuickOption[] {
  return [
    { label: "今天", day: today },
    { label: "昨天", day: addDaysKey(today, -1) },
    { label: "前天", day: addDaysKey(today, -2) },
  ];
}

