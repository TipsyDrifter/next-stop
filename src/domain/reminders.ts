/**
 * 提醒的純函式（⑨ 契約 `docs/research/2026-11-04-主線-截止提醒-契約.md` §3、§4）。
 *
 * Kotlin 讀不到 SQLite，所以排程在 JS 算好、整份交給原生；桌機同一份清單由 tick 檢查。兩端都吃 `buildReminderPlan` 的結果。
 * 一則通知（`ReminderItem`）可以代表好幾件事（三張票同一天締切＝一則），「響過了沒」記在每件事的 `memberKeys` 上，
 * 所以總結發出去之後才加進來的第四張，下一次會單獨響一則，不會把前三張再響一次。
 *
 * 鐵則：只准 import `../lib/date.ts`（`node --test` 直載，相對路徑帶 `.ts`）；只用可剝除語法。
 */
import { addDays, clockInstant, clockMinutes, clockText, isClockInRange, parseClockInput, type ClockText } from "../lib/date.ts";

/* ───────── 設定 ───────── */

/** 本機鍵（不進同步白名單：開關與時刻各台各記，最常見的用法是「手機開、桌機關」） */
export const KEY_REMINDERS = "reminders";
export const KEY_REMINDER_SENT = "reminder_sent";
export const KEY_REMINDER_RECENT = "reminder_recent";

export interface ReminderSettings {
  /** 所有「早上」的提醒共用的時刻（營業日表記） */
  morning: ClockText;
  /** 所有「晚上」的提醒共用的時刻 */
  evening: ClockText;
  dueEve: boolean;
  dueDay: boolean;
  late: boolean;
  /** 誤點滿幾天提醒一次 */
  lateDays: number;
  timed: boolean;
  /** 開始前幾分鐘 */
  timedBefore: number;
  review: boolean;
  routine: boolean;
  repeat: boolean;
  sync: boolean;
  backup: boolean;
}

/**
 * 預設時刻照使用者作息（約 03:30 睡、11:00 起）：
 * 早上 11:30＝起床半小時內看得到、不會吵醒人；晚上 21:00＝離睡覺還有六個多小時，「明天截止」來得及動手。
 * 定期帳與作息時段預設關：帳本來就會自動記、作息一天好幾段，開了容易變吵。
 */
export const DEFAULT_REMINDER_SETTINGS: ReminderSettings = {
  morning: "11:30",
  evening: "21:00",
  dueEve: true,
  dueDay: true,
  late: true,
  lateDays: 3,
  timed: true,
  timedBefore: 10,
  review: true,
  routine: false,
  repeat: false,
  sync: true,
  backup: true,
};

export const LATE_DAYS_OPTIONS: readonly number[] = [1, 3, 7, 14];
export const TIMED_BEFORE_OPTIONS: readonly number[] = [0, 5, 10, 15, 30];

/** 讀設定：壞值或缺鍵一律回預設（升版多一個開關時，舊資料照樣讀得懂） */
export function parseReminderSettings(raw: string | null | undefined): ReminderSettings {
  const d = DEFAULT_REMINDER_SETTINGS;
  if (!raw) return { ...d };
  let o: Record<string, unknown>;
  try {
    const v = JSON.parse(raw) as unknown;
    if (v === null || typeof v !== "object" || Array.isArray(v)) return { ...d };
    o = v as Record<string, unknown>;
  } catch {
    return { ...d };
  }
  const bool = (k: keyof ReminderSettings, fb: boolean): boolean => (typeof o[k] === "boolean" ? (o[k] as boolean) : fb);
  const clock = (k: "morning" | "evening"): ClockText => {
    const v = o[k];
    return typeof v === "string" && clockMinutes(v) !== null ? v : d[k];
  };
  const int = (k: "lateDays" | "timedBefore", min: number, max: number): number => {
    const v = o[k];
    return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : d[k];
  };
  return {
    morning: clock("morning"),
    evening: clock("evening"),
    dueEve: bool("dueEve", d.dueEve),
    dueDay: bool("dueDay", d.dueDay),
    late: bool("late", d.late),
    lateDays: int("lateDays", 1, 365),
    timed: bool("timed", d.timed),
    timedBefore: int("timedBefore", 0, 240),
    review: bool("review", d.review),
    routine: bool("routine", d.routine),
    repeat: bool("repeat", d.repeat),
    sync: bool("sync", d.sync),
    backup: bool("backup", d.backup),
  };
}

/** 設定裡的時刻照目前日界線解讀：日界線改過之後，「01:00」還是當天晚上那個 25:00，不會跑到一天的開頭 */
export function clockForDay(t: ClockText, dayStartHour: number): ClockText {
  if (isClockInRange(t, dayStartHour)) return t;
  const m = clockMinutes(t);
  if (m === null) return t;
  return parseClockInput(clockText(m % 1440) ?? t, dayStartHour) ?? t;
}

/* ───────── 事實（`data/reminderFacts.ts` 撈好交進來） ───────── */

export interface DueFact {
  nodeId: string;
  name: string;
  day: string;
  routeName: string | null;
}

export interface LateFact {
  nodeId: string;
  name: string;
  /** 原定的那天（誤點＝執行日；只有締切的票＝締切日）；改了執行日就是新的一次 */
  anchor: string;
}

export interface TimedFact {
  nodeId: string;
  name: string;
  day: string;
  time: ClockText;
  routeName: string | null;
  /** 第二段起的時段（`time_plans` 的 id）；第一段＝null */
  planId: string | null;
}

export interface AimWeekFact {
  weekOn: string;
  /** 這週最後一天（依週起點） */
  lastDay: string;
}

export interface RepeatFact {
  repeatId: string;
  day: string;
  label: string;
  /** 已格式化的金額（「−12,000」） */
  amountText: string;
}

export interface RoutineFact {
  segId: string;
  day: string;
  name: string;
  start: ClockText;
  end: ClockText;
}

export interface ReminderFacts {
  today: string;
  dayStartHour: number;
  dues: readonly DueFact[];
  lates: readonly LateFact[];
  timed: readonly TimedFact[];
  aimWeeks: readonly AimWeekFact[];
  repeats: readonly RepeatFact[];
  routines: readonly RoutineFact[];
}

/* ───────── 通知 ───────── */

export type ReminderKind = "due-eve" | "due-day" | "late" | "timed" | "review" | "repeat" | "routine";

/** 點開去哪（兩端同一份；原生層只當字串帶著走） */
export type ReminderTarget =
  | { kind: "node"; id: string }
  /** 行程表那一天 */
  | { kind: "day"; day: string }
  /** 今日頁（誤點區） */
  | { kind: "today" }
  /** 打開那週的方針回顧 */
  | { kind: "review"; weekOn: string }
  /** 售票口那一天 */
  | { kind: "ticketDay"; day: string }
  /** 時刻表日程那一天 */
  | { kind: "routine"; day: string };

export interface ReminderItem {
  key: string;
  kind: ReminderKind;
  /** 這則代表的每一件事；全部記進帳本才算響過 */
  memberKeys: string[];
  fireAt: number;
  /** 過了這個時刻就不響（`now >= expireAt`）；這是「補送到什麼時候」的唯一定義 */
  expireAt: number;
  title: string;
  body: string;
  target: ReminderTarget;
}

/** 一次送給原生層的上限（一次只排最近的一個鬧鐘，這裡只限制清單大小；看未來 14 天時正常用不到） */
export const MAX_REMINDER_ITEMS = 200;
export const REMINDER_HORIZON_DAYS = 14;

const DAY_MS = 86_400_000;
const WEEKDAY_ZH = ["日", "一", "二", "三", "四", "五", "六"];
const NAME_MAX = 24;
/** 誤點「一直到交代為止」，給一個夠遠的期限就好 */
const LATE_EXPIRE_MS = 365 * DAY_MS;
/** 作息段開始後多久還值得響：鬧鐘可能晚幾分鐘（精準鬧鐘沒給時），再晚就沒意義 */
const ROUTINE_EXPIRE_MS = 15 * 60_000;

function clip(name: string): string {
  const s = name.trim() || "（無標題）";
  return s.length > NAME_MAX ? `${s.slice(0, NAME_MAX)}…` : s;
}

/** 「11/5（四）」 */
export function reminderDayText(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return `${m}/${d}（${WEEKDAY_ZH[new Date(y, m - 1, d).getDay()]}）`;
}

/** 兩個日期 key 相差幾天（a − b） */
export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((new Date(ay, am - 1, ad).getTime() - new Date(by, bm - 1, bd).getTime()) / DAY_MS);
}

/** 「這一天的日界線」：`day` 這個營業日的開始時刻 */
function dayStartAt(day: string, dayStartHour: number): number {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d, dayStartHour, 0).getTime();
}

/** 通知上寫牆鐘（響的當下就是凌晨兩點半，寫「26:30」反而要換算） */
function wallClock(t: ClockText): string {
  const m = clockMinutes(t);
  return m === null ? t : (clockText(m % 1440) ?? t);
}

function joinNames(names: readonly string[]): string {
  const shown = names.slice(0, 3).map(clip).join("、");
  return names.length > 3 ? `${shown}…` : shown;
}

/**
 * 總結那一則的 key：同一天兩批成員不同時也要是兩則（Android 用 key 當通知的 tag，相同就互相蓋掉）。
 * 成員一樣就一樣，重算不會變成新的一則。
 */
function groupKey(prefix: string, memberKeys: readonly string[]): string {
  let h = 0x811c9dc5;
  for (const k of [...memberKeys].sort()) {
    for (let i = 0; i < k.length; i++) {
      h ^= k.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  }
  return `${prefix}:${(h >>> 0).toString(36)}`;
}

function groupBy<T>(rows: readonly T[], keyOf: (r: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = keyOf(r);
    const g = out.get(k);
    if (g) g.push(r);
    else out.set(k, [r]);
  }
  return out;
}

/** 同一天的締切：一張＝點開到那張票；好幾張＝一則總結，點開到行程表那天 */
function dueItems(
  kind: "due-eve" | "due-day",
  rows: readonly DueFact[],
  day: string,
  fireAt: number,
  expireAt: number,
  sent: Readonly<Record<string, number>>,
): ReminderItem | null {
  const word = kind === "due-eve" ? "明天" : "今天";
  const fresh = rows
    .map((r) => ({ r, key: `${kind}:${r.nodeId}:${r.day}` }))
    .filter((x) => sent[x.key] === undefined);
  if (!fresh.length) return null;
  const base = { kind, fireAt, expireAt, memberKeys: fresh.map((x) => x.key) };
  if (fresh.length === 1) {
    const { r } = fresh[0];
    return {
      ...base,
      key: fresh[0].key,
      title: `${word}締切：${clip(r.name)}`,
      body: r.routeName ? `${reminderDayText(day)}・${r.routeName}` : reminderDayText(day),
      target: { kind: "node", id: r.nodeId },
    };
  }
  return {
    ...base,
    key: groupKey(`${kind}:${day}`, base.memberKeys),
    title: `${word}有 ${fresh.length} 個締切`,
    body: joinNames(fresh.map((x) => x.r.name)),
    target: { kind: "day", day },
  };
}

/**
 * 算出「現在起還可能響」的清單，依 fireAt 排序。已響過（`sent`）與已過期的不列；設定關掉的不列。
 * 誤點只看目前已經誤點的票：滿 N 天那天早上響；已經滿了的排今天早上（過了今天早上就是馬上）。
 */
export function buildReminderPlan(
  facts: ReminderFacts,
  settings: ReminderSettings,
  sent: Readonly<Record<string, number>>,
  now: number,
): ReminderItem[] {
  const { today, dayStartHour: h } = facts;
  const morning = clockForDay(settings.morning, h);
  const evening = clockForDay(settings.evening, h);
  const at = (day: string, t: ClockText): number | null => clockInstant(day, t);
  const out: ReminderItem[] = [];
  const push = (it: ReminderItem | null): void => {
    if (it && now < it.expireAt) out.push(it);
  };

  const dueByDay = groupBy(facts.dues, (r) => r.day);
  for (const [day, rows] of dueByDay) {
    if (settings.dueEve) {
      const fireAt = at(addDays(day, -1), evening);
      if (fireAt !== null) push(dueItems("due-eve", rows, day, fireAt, dayStartAt(day, h), sent));
    }
    if (settings.dueDay) {
      const fireAt = at(day, morning);
      if (fireAt !== null) push(dueItems("due-day", rows, day, fireAt, dayStartAt(addDays(day, 1), h), sent));
    }
  }

  if (settings.late) {
    const byFireDay = groupBy(
      facts.lates.filter((r) => sent[`late:${r.nodeId}:${r.anchor}`] === undefined),
      (r) => {
        const d = addDays(r.anchor, settings.lateDays);
        return d < today ? today : d;
      },
    );
    for (const [fireDay, rows] of byFireDay) {
      const fireAt = at(fireDay, morning);
      if (fireAt === null) continue;
      const memberKeys = rows.map((r) => `late:${r.nodeId}:${r.anchor}`);
      const base = { kind: "late" as const, fireAt, expireAt: fireAt + LATE_EXPIRE_MS, memberKeys };
      if (rows.length === 1) {
        const r = rows[0];
        const days = daysBetween(fireDay, r.anchor);
        push({
          ...base,
          key: memberKeys[0],
          title: `誤點 ${days} 天：${clip(r.name)}`,
          body: `原定 ${reminderDayText(r.anchor)}`,
          target: { kind: "node", id: r.nodeId },
        });
      } else {
        push({
          ...base,
          key: groupKey(`late:${fireDay}`, memberKeys),
          title: `有 ${rows.length} 張票誤點滿 ${settings.lateDays} 天`,
          body: joinNames(rows.map((r) => r.name)),
          target: { kind: "today" },
        });
      }
    }
  }

  if (settings.timed) {
    for (const r of facts.timed) {
      const start = at(r.day, r.time);
      if (start === null) continue;
      const key = r.planId ? `slot:${r.planId}:${r.day}:${r.time}` : `timed:${r.nodeId}:${r.day}:${r.time}`;
      if (sent[key] !== undefined) continue;
      const lead = settings.timedBefore > 0 ? `${settings.timedBefore} 分鐘後開始` : "現在開始";
      push({
        key,
        kind: "timed",
        memberKeys: [key],
        fireAt: start - settings.timedBefore * 60_000,
        // 不補：開始時刻一過就沒用了（timedBefore＝0 時多留一分鐘，不然 tick 永遠趕不上）
        expireAt: settings.timedBefore > 0 ? start : start + 60_000,
        title: `${wallClock(r.time)} ${clip(r.name)}`,
        body: r.routeName ? `${lead}・${r.routeName}` : lead,
        target: { kind: "node", id: r.nodeId },
      });
    }
  }

  if (settings.review) {
    for (const w of facts.aimWeeks) {
      const key = `review:${w.weekOn}`;
      const fireAt = at(w.lastDay, evening);
      if (fireAt === null || sent[key] !== undefined) continue;
      push({
        key,
        kind: "review",
        memberKeys: [key],
        fireAt,
        expireAt: dayStartAt(addDays(w.lastDay, 1), h),
        title: "這週的方針要收尾了",
        body: "回頭看看這週走到哪",
        target: { kind: "review", weekOn: w.weekOn },
      });
    }
  }

  if (settings.repeat) {
    for (const [day, rows] of groupBy(facts.repeats, (r) => r.day)) {
      const fresh = rows.filter((r) => sent[`repeat:${r.repeatId}:${day}`] === undefined);
      const fireAt = at(day, morning);
      if (!fresh.length || fireAt === null) continue;
      const memberKeys = fresh.map((r) => `repeat:${r.repeatId}:${r.day}`);
      push({
        key: fresh.length === 1 ? memberKeys[0] : groupKey(`repeat:${day}`, memberKeys),
        kind: "repeat",
        memberKeys,
        fireAt,
        expireAt: dayStartAt(addDays(day, 1), h),
        title: fresh.length === 1 ? `今天定期帳：${clip(fresh[0].label)}` : `今天定期帳 ${fresh.length} 筆`,
        body:
          fresh.length === 1
            ? fresh[0].amountText
            : fresh
                .slice(0, 3)
                .map((r) => `${clip(r.label)} ${r.amountText}`)
                .join("、") + (fresh.length > 3 ? "…" : ""),
        target: { kind: "ticketDay", day },
      });
    }
  }

  if (settings.routine) {
    for (const r of facts.routines) {
      const key = `routine:${r.segId}:${r.day}:${r.start}`;
      const fireAt = at(r.day, r.start);
      if (fireAt === null || sent[key] !== undefined) continue;
      push({
        key,
        kind: "routine",
        memberKeys: [key],
        fireAt,
        expireAt: fireAt + ROUTINE_EXPIRE_MS,
        title: `${wallClock(r.start)} ${clip(r.name)}`,
        body: `作息範本・到 ${wallClock(r.end)}`,
        target: { kind: "routine", day: r.day },
      });
    }
  }

  out.sort((a, b) => a.fireAt - b.fireAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return out.slice(0, MAX_REMINDER_ITEMS);
}

/** 現在該響的（到時間、還沒過期）。Kotlin `NsReminders` 是同一條規則 */
export function dueNow(items: readonly ReminderItem[], now: number): ReminderItem[] {
  return items.filter((it) => it.fireAt <= now && now < it.expireAt);
}

/* ───────── 帳本與最近的提醒 ───────── */

const SENT_KEEP_MS = 40 * DAY_MS;

export function parseSent(raw: string | null | undefined): Record<string, number> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    if (v === null || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Record<string, number> = {};
    for (const [k, at] of Object.entries(v as Record<string, unknown>)) {
      if (typeof at === "number" && Number.isFinite(at)) out[k] = at;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * 收帳本。誤點的鍵照「那張票還誤點著」留，不照時間清——否則誤點很久的票過一陣子會再響一次。
 * 其他鍵都帶日期，過了就不會再被算出來，留 40 天只是防時鐘亂跳。
 */
export function pruneSent(sent: Readonly<Record<string, number>>, facts: Pick<ReminderFacts, "lates">, now: number): Record<string, number> {
  const liveLate = new Set(facts.lates.map((r) => `late:${r.nodeId}:${r.anchor}`));
  const out: Record<string, number> = {};
  for (const [k, at] of Object.entries(sent)) {
    if (k.startsWith("late:") ? liveLate.has(k) : now - at < SENT_KEEP_MS) out[k] = at;
  }
  return out;
}

/** 提醒頁底部「最近的提醒」的一列（通知被滑掉、或桌機在通知中心點不回來時，從這裡還是到得了） */
export interface ReminderRecent {
  at: number;
  kind: ReminderKind;
  title: string;
  body: string;
  target: ReminderTarget;
}

export const MAX_REMINDER_RECENT = 30;

export function parseRecent(raw: string | null | undefined): ReminderRecent[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    return v.filter(
      (x): x is ReminderRecent =>
        x !== null &&
        typeof x === "object" &&
        typeof (x as ReminderRecent).at === "number" &&
        typeof (x as ReminderRecent).title === "string" &&
        typeof (x as ReminderRecent).target === "object" &&
        (x as ReminderRecent).target !== null,
    );
  } catch {
    return [];
  }
}

/** 新的在前，超過上限丟舊的 */
export function pushRecent(cur: readonly ReminderRecent[], fired: readonly ReminderRecent[]): ReminderRecent[] {
  return [...fired, ...cur].sort((a, b) => b.at - a.at).slice(0, MAX_REMINDER_RECENT);
}

/** 原生層帶回來的 target 字串 → 物件；看不懂＝null（點開只回 App，不跳） */
export function parseTarget(raw: string | null | undefined): ReminderTarget | null {
  if (!raw) return null;
  try {
    const t = JSON.parse(raw) as ReminderTarget;
    switch (t?.kind) {
      case "node":
        return typeof t.id === "string" ? t : null;
      case "day":
      case "ticketDay":
      case "routine":
        return typeof t.day === "string" ? t : null;
      case "review":
        return typeof t.weekOn === "string" ? t : null;
      case "today":
        return t;
      default:
        return null;
    }
  } catch {
    return null;
  }
}
