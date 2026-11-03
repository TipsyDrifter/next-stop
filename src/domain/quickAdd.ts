/**
 * 建票列的快速語法解析（回饋甲 D-主-135）：一個輸入框裡打「買牛奶 明天 14:00 !高 #採買 @生活」，
 * 認出執行日／幾點／長度／締切／優先／荷札／掛到，剩下的字才是票名。
 *
 * 規則（契約 §二 D-主-135；實測後可調）：
 *   - 片段要跟其他字用空白（含全形空白）隔開，或在開頭／結尾——所以「明天的報告」不會被吃掉。
 *   - 執行日：今天／明天／後天／大後天、週一～週日（今天起最近的那一天，含今天）、下週一～下週日、
 *     11/15、11-15、11月15日、2026/11/15。只寫月日且已過今天＝明年。
 *   - 幾點：14:00、9:30、14點、9點半、下午3點（下午／晚上 +12）；營業日表記（25:00）照 parseClockInput。
 *     長度：30分、1h、1h30、90m、1.5h。
 *   - 締切：〆／締切／截止 後面直接接任一種日期（〆11/30、締切明天）。
 *   - 優先：!高 !中 !低、!1 !2 !3、!!＝高。
 *   - 荷札：#名稱，完全照 parseTags（可多個、/ 分層）。
 *   - 掛到：@代碼或全名（不分大小寫）、@路線/列車；找不到的 @ 不認、留在名稱裡。
 *   - 同一種寫兩次取最後一個（荷札例外，全收）；重複的片段全部反白、全部從名稱拿掉。
 *
 * 寫法限制：純函式；只 import 純函式模組（帶 .ts 副檔名），`scripts/tests/quick-add.test.ts` 以 node 直接載入。
 * 路線名含空白的（「Work Trip」）打不出來——片段以空白切，要掛這類路線請用代碼或 chip。
 */
import { parseClockInput } from "../lib/date.ts";
import { parseTags } from "./tags.ts";
import type { NodeKind, Priority } from "./node.ts";

export interface QuickAddCtx {
  /** YYYY-MM-DD，目前營業日 */
  today: string;
  /** 日界線（parseClockInput 用） */
  dayStartHour: number;
  routes: readonly { id: string; name: string; code: string | null }[];
  /** @路線/列車 第二段：給路線 id 回這條路線底下的列車／車廂（名字比對）；不給＝不認第二段 */
  tasksOf?: (routeId: string) => readonly { id: string; name: string; kind: NodeKind }[];
}

export type QuickTokenKind = "date" | "time" | "length" | "due" | "priority" | "tag" | "dest";

export interface QuickToken {
  kind: QuickTokenKind;
  /** 在原文字的 [start, end) */
  start: number;
  end: number;
  raw: string;
}

export interface QuickAddParse {
  /** 拿掉認出片段後的名稱（多餘空白收掉、trim） */
  name: string;
  /** 認出的片段（照位置排；給輸入框反白） */
  tokens: QuickToken[];
  scheduledOn?: string;
  /** 營業日表記 "HH:MM" */
  scheduledTime?: string;
  estimateMin?: number;
  dueOn?: string;
  priority?: Priority;
  tags: { name: string; key: string }[];
  /** nodeId＝列車／車廂；null＝路線本身 */
  dest?: { routeId: string; nodeId: string | null };
}

// ───────────── 日期 ─────────────

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n));

/** y-m-d 是不是真的存在的日子（2/30、13 月都不是）；回 "YYYY-MM-DD" 或 null */
function validKey(y: number, m: number, d: number): string | null {
  if (!Number.isInteger(y) || y < 1970 || y > 2999) return null;
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

function shiftKey(key: string, n: number): string {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}

/** 週一＝1 … 週日＝7 */
function isoDow(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).getDay() || 7;
}

const WEEKDAY_NUM: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };
const RELATIVE_DAYS: Record<string, number> = { 今天: 0, 明天: 1, 後天: 2, 后天: 2, 大後天: 3, 大后天: 3 };

/** 一個詞 → 日期 key；看不懂 ⇒ null。w 已 NFKC 正規化 */
function parseDateWord(w: string, today: string): string | null {
  if (Object.prototype.hasOwnProperty.call(RELATIVE_DAYS, w)) return shiftKey(today, RELATIVE_DAYS[w]);

  // 週X／下週X：週一～週日＝今天起最近的那一天（含今天）；下週X＝下一個日曆週（週一起算）的那天
  const wk = /^(下)?(?:週|周|星期|禮拜|礼拜)([一二三四五六日天])$/.exec(w);
  if (wk) {
    const target = WEEKDAY_NUM[wk[2]];
    const dow = isoDow(today);
    if (wk[1]) return shiftKey(today, 8 - dow + (target - 1));
    return shiftKey(today, (target - dow + 7) % 7);
  }

  // 2026/11/15、2026-11-15
  const full = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(w);
  if (full) return validKey(Number(full[1]), Number(full[2]), Number(full[3]));

  // 11/15、11-15、11月15日：沒寫年＝今天起最近的那一天（已過今天＝明年）
  const md = /^(\d{1,2})[/-](\d{1,2})$/.exec(w) ?? /^(\d{1,2})月(\d{1,2})[日號号]?$/.exec(w);
  if (md) {
    const m = Number(md[1]);
    const d = Number(md[2]);
    const y0 = Number(today.slice(0, 4));
    // 2/29 在非閏年不存在，往後找到存在的那一年
    for (let y = y0; y <= y0 + 4; y++) {
      const key = validKey(y, m, d);
      if (key && key >= today) return key;
    }
    return null;
  }
  return null;
}

// ───────────── 幾點／長度 ─────────────

const TIME_RE = /^(上午|早上|清晨|凌晨|中午|下午|傍晚|晚上)?(\d{1,2})(?::(\d{2})|[點点](?:(半)|(\d{1,2})分?)?)$/;

/** 一個詞 → "HH:MM"；看不懂或超出日界線範圍 ⇒ null */
function parseTimeWord(w: string, dayStartHour: number): string | null {
  const m = TIME_RE.exec(w);
  if (!m) return null;
  let h = Number(m[2]);
  const min = m[3] !== undefined ? Number(m[3]) : m[4] ? 30 : m[5] !== undefined ? Number(m[5]) : 0;
  if (min > 59) return null;
  const part = m[1];
  if (part === "下午" || part === "傍晚" || part === "晚上") {
    if (h < 12) h += 12;
    if (part === "晚上" && h === 12) h = 24;
  } else if (part === "中午") {
    if (h <= 6) h += 12;
  } else if (part && h === 12) {
    h = 0; // 上午／早上／凌晨 12 點＝午夜
  }
  return parseClockInput(`${h}:${pad2(min)}`, dayStartHour);
}

const LEN_HOUR = "(?:h|hr|hrs|hour|hours|小時|小时)";
const LEN_MIN = "(?:m|min|mins|分|分鐘|分钟)";
const LEN_H_RE = new RegExp(`^(\\d+(?:\\.\\d+)?)${LEN_HOUR}$`);
const LEN_HM_RE = new RegExp(`^(\\d+)${LEN_HOUR}(\\d{1,2})${LEN_MIN}?$`);
const LEN_M_RE = new RegExp(`^(\\d+)${LEN_MIN}$`);
/** 估時上限：一整天 */
const LENGTH_MAX = 1440;

/** 一個詞 → 分鐘數；看不懂 ⇒ null。w 已 NFKC 正規化＋小寫 */
function parseLengthWord(w: string): number | null {
  let min: number | null = null;
  let m = LEN_H_RE.exec(w);
  if (m) min = Math.round(Number(m[1]) * 60);
  else if ((m = LEN_HM_RE.exec(w))) {
    if (Number(m[2]) > 59) return null;
    min = Number(m[1]) * 60 + Number(m[2]);
  } else if ((m = LEN_M_RE.exec(w))) min = Number(m[1]);
  return min !== null && min >= 1 && min <= LENGTH_MAX ? min : null;
}

// ───────────── 優先／締切／掛到 ─────────────

const PRIORITY_OF: Record<string, Priority> = { 高: "high", 中: "mid", 低: "low", "1": "high", "2": "mid", "3": "low" };

function parsePriorityWord(w: string): Priority | null {
  if (w === "!!") return "high";
  const m = /^!([高中低123])$/.exec(w);
  return m ? PRIORITY_OF[m[1]] : null;
}

const DUE_PREFIX_RE = /^(?:〆|締切|截止)(.+)$/;

/** 名稱比對：NFKC＋不分大小寫 */
const fold = (s: string): string => s.normalize("NFKC").toLowerCase();

/** `@` 後面的字 → 路線（代碼優先、再全名）；找不到 ⇒ null */
function findRoute(q: string, ctx: QuickAddCtx): { id: string } | null {
  const k = fold(q);
  if (!k) return null;
  return ctx.routes.find((r) => r.code !== null && fold(r.code) === k) ?? ctx.routes.find((r) => fold(r.name) === k) ?? null;
}

function parseDestWord(body: string, ctx: QuickAddCtx): { routeId: string; nodeId: string | null } | null {
  // 先當整段都是路線名（路線名可以含 /），再試每個 / 切成「路線 / 列車」
  const whole = findRoute(body, ctx);
  if (whole) return { routeId: whole.id, nodeId: null };
  if (!ctx.tasksOf) return null;
  for (let i = body.indexOf("/"); i >= 0; i = body.indexOf("/", i + 1)) {
    const route = findRoute(body.slice(0, i), ctx);
    const sub = fold(body.slice(i + 1));
    if (!route || !sub) continue;
    const hit = ctx.tasksOf(route.id).find((t) => fold(t.name) === sub);
    if (hit) return { routeId: route.id, nodeId: hit.id };
  }
  return null;
}

// ───────────── 解析 ─────────────

type Hit =
  | { kind: "date"; v: string }
  | { kind: "time"; v: string }
  | { kind: "length"; v: number }
  | { kind: "due"; v: string }
  | { kind: "priority"; v: Priority }
  | { kind: "dest"; v: { routeId: string; nodeId: string | null } };

/** 一個以空白切出來的詞 → 認出的是什麼（沒認出 ⇒ null）；荷札不在這裡，走 parseTags */
function classifyWord(word: string, ctx: QuickAddCtx): Hit | null {
  const w = word.normalize("NFKC");

  const pr = parsePriorityWord(w);
  if (pr) return { kind: "priority", v: pr };

  if (w.charAt(0) === "@") {
    const dest = parseDestWord(w.slice(1), ctx);
    return dest ? { kind: "dest", v: dest } : null;
  }

  const due = DUE_PREFIX_RE.exec(w);
  if (due) {
    const d = parseDateWord(due[1], ctx.today);
    return d ? { kind: "due", v: d } : null;
  }

  const date = parseDateWord(w, ctx.today);
  if (date) return { kind: "date", v: date };

  const time = parseTimeWord(w, ctx.dayStartHour);
  if (time) return { kind: "time", v: time };

  const len = parseLengthWord(w.toLowerCase());
  if (len !== null) return { kind: "length", v: len };

  return null;
}

/**
 * 把一組不重疊的範圍從文字裡拿掉：範圍連同兩側的空白收成一個空白（在開頭或結尾則整段不留）。
 * 沒被拿掉的地方，使用者自己打的空白原樣保留。
 */
function cutRanges(text: string, ranges: readonly { start: number; end: number }[]): string {
  const MARK = "";
  let s = "";
  let at = 0;
  for (const r of [...ranges].sort((a, b) => a.start - b.start)) {
    s += text.slice(at, r.start) + MARK;
    at = r.end;
  }
  s += text.slice(at);
  return s.replace(/[\s]*[\s]*/g, (m, offset: number, whole: string) =>
    offset === 0 || offset + m.length === whole.length ? "" : " ",
  );
}

export function parseQuickAdd(text: string, ctx: QuickAddCtx): QuickAddParse {
  const src = String(text ?? "");
  const tokens: QuickToken[] = [];
  const out: QuickAddParse = { name: "", tokens, tags: [] };

  // 荷札：完全照 parseTags（位置也是它給的）
  const tagRanges: { start: number; end: number }[] = [];
  const seenKeys = new Set<string>();
  for (const o of parseTags(src)) {
    tokens.push({ kind: "tag", start: o.start, end: o.end, raw: src.slice(o.start, o.end) });
    tagRanges.push({ start: o.start, end: o.end });
    if (!seenKeys.has(o.key)) {
      seenKeys.add(o.key);
      out.tags.push({ name: o.name, key: o.key });
    }
  }

  // 其餘片段：以空白（含全形空白）切詞，逐詞認；同一種後寫的蓋掉先寫的
  const wordRe = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = wordRe.exec(src))) {
    const start = m.index;
    const end = start + m[0].length;
    if (tagRanges.some((r) => start < r.end && end > r.start)) continue;
    const hit = classifyWord(m[0], ctx);
    if (!hit) continue;
    tokens.push({ kind: hit.kind, start, end, raw: m[0] });
    switch (hit.kind) {
      case "date": out.scheduledOn = hit.v; break;
      case "time": out.scheduledTime = hit.v; break;
      case "length": out.estimateMin = hit.v; break;
      case "due": out.dueOn = hit.v; break;
      case "priority": out.priority = hit.v; break;
      case "dest": out.dest = hit.v; break;
    }
  }

  tokens.sort((a, b) => a.start - b.start);
  out.name = cutRanges(src, tokens).trim();
  return out;
}

/** 把某種片段從文字裡拿掉（chip 改值時用；同種多個全拿掉），回新文字；沒有該種片段就原樣回 */
export function stripTokens(text: string, kind: QuickTokenKind, ctx: QuickAddCtx): string {
  const hits = parseQuickAdd(text, ctx).tokens.filter((t) => t.kind === kind);
  return hits.length === 0 ? text : cutRanges(text, hits);
}
