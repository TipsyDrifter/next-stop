/**
 * 車庫頁的畫面資料（第五本第一梯 ③；契約 §三 D-主-217～219）——純函式，零 IO。
 *
 *   albumPages   印譜帳：一個月一頁，舊→新；沒有章的月份不出現
 *   buildYearbook 年鑑：那年今日＋按月列（新→舊；有済、日記、章或到站的月份才列）
 *   bookStations 記錄簿「經過的車站」：開業、已到着的站、終點（運行中只列到着的、最後一行運行中）
 *
 * 守則（不遊戲化）：只算發生過的量；不出現「還差 N」、連續天數、比例。
 */
import type { NodeRow } from "./node";
import { compareStamps, type StampRow } from "./stamps";

export interface NoteDigestLike {
  id: string;
  kind: "note" | "diary";
  day: string;
  noted_at: string;
  title: string | null;
  text: string;
}

/** 實現過的願望（年鑑用；候車室的「實現了」讀時判斷，D-主-516／517）。`day`＝bought_at（實現時刻）依日界線換算的本地日 */
export interface WishDigestLike {
  id: string;
  name: string;
  kind: string; // 種類名（repository 已 join wr_kinds 取名；種類被刪＝空字串）
  /** UTC ISO */
  bought_at: string;
  day: string;
}

/** 摘要用的一句：標題優先，否則內文第一個非空行；最多 60 字 */
export function digestLine(title: string | null, text: string): string {
  const t = title?.trim();
  if (t) return t.length > 60 ? `${t.slice(0, 60)}…` : t;
  const line =
    text
      .split(/\r?\n/)
      .map((l) => l.replace(/^[#>\-*\s]+/, "").trim())
      .find((l) => l !== "") ?? "";
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}

/* ───────── 印譜帳 ───────── */

export interface AlbumPage {
  /** "YYYY-MM" */
  month: string;
  stamps: StampRow[];
}

export function albumPages(stamps: readonly StampRow[]): AlbumPage[] {
  const by = new Map<string, StampRow[]>();
  for (const s of [...stamps].filter((x) => x.deleted_at === null).sort(compareStamps)) {
    const m = s.stamped_on.slice(0, 7);
    (by.get(m) ?? by.set(m, []).get(m)!).push(s);
  }
  return [...by.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([month, list]) => ({ month, stamps: list }));
}

/* ───────── 年鑑 ───────── */

export interface YearbookMonth {
  /** "YYYY-MM" */
  month: string;
  seals: number;
  diaries: number;
  /** 這個月實現的願望件數（只記發生過的，不比目標） */
  wishes: number;
  stamps: StampRow[];
  /** 這個月到站的路線（arrived_on 落在這個月；依日期） */
  routes: NodeRow[];
  /** 這個月到站的幹線 */
  lines: NodeRow[];
  /** 代表的一句：當月最後一則筆記或日記 */
  quote: { id: string; kind: "note" | "diary"; day: string; text: string } | null;
}

export interface AgoItem {
  /** 那一天 "YYYY-MM-DD" */
  day: string;
  /** 幾年前 */
  years: number;
  id: string;
  /** 優先序 日記 › 筆記 › 願望 */
  kind: "note" | "diary" | "wish";
  /** 日記／筆記＝摘要一句；願望＝願望的名字 */
  text: string;
  /** 願望的種類（kind 為 "wish" 才有） */
  wishKind?: string;
}

export interface Yearbook {
  ago: AgoItem | null;
  months: YearbookMonth[];
}

export function buildYearbook(input: {
  today: string;
  stamps: readonly StampRow[];
  sealDays: readonly string[];
  notes: readonly NoteDigestLike[];
  /** 實現過的願望（可省略＝沒有） */
  wishes?: readonly WishDigestLike[];
  routes: readonly NodeRow[];
  lines: readonly NodeRow[];
}): Yearbook {
  const wishes = input.wishes ?? [];
  const months = new Map<string, YearbookMonth>();
  const at = (m: string): YearbookMonth => {
    let v = months.get(m);
    if (!v) {
      v = { month: m, seals: 0, diaries: 0, wishes: 0, stamps: [], routes: [], lines: [], quote: null };
      months.set(m, v);
    }
    return v;
  };
  for (const d of input.sealDays) at(d.slice(0, 7)).seals++;
  for (const n of input.notes) if (n.kind === "diary") at(n.day.slice(0, 7)).diaries++;
  for (const w of wishes) at(w.day.slice(0, 7)).wishes++;
  for (const s of [...input.stamps].filter((x) => x.deleted_at === null).sort(compareStamps)) at(s.stamped_on.slice(0, 7)).stamps.push(s);
  const byDay = (a: NodeRow, b: NodeRow) => (a.arrived_on! < b.arrived_on! ? -1 : a.arrived_on! > b.arrived_on! ? 1 : 0);
  for (const r of [...input.routes].filter((x) => x.arrived_on).sort(byDay)) at(r.arrived_on!.slice(0, 7)).routes.push(r);
  for (const l of [...input.lines].filter((x) => x.arrived_on).sort(byDay)) at(l.arrived_on!.slice(0, 7)).lines.push(l);
  // 代表句：當月最後寫下的那則（noted_at 最晚）；只在已經有內容的月份放（光有筆記的月份不另開一列）
  const lastByMonth = new Map<string, NoteDigestLike>();
  for (const n of input.notes) {
    const m = n.day.slice(0, 7);
    const cur = lastByMonth.get(m);
    if (!cur || n.noted_at > cur.noted_at) lastByMonth.set(m, n);
  }
  for (const [m, n] of lastByMonth) {
    const v = months.get(m);
    const text = digestLine(n.title, n.text);
    if (v && text) v.quote = { id: n.id, kind: n.kind, day: n.day, text };
  }
  const list = [...months.values()]
    .filter((v) => v.month <= input.today.slice(0, 7))
    .sort((a, b) => (a.month < b.month ? 1 : -1));
  return { ago: agoOf(input.today, input.notes, wishes), months: list };
}

/**
 * 那年今日：往年同月同日，最近的那一年；同一天內 日記 › 筆記 › 願望（單筆）；沒有＝null（整段不出現）。
 * 願望的「那一天」＝實現時刻依日界線換算的本地日（呼叫端算好放 `day`）。
 */
export function agoOf(today: string, notes: readonly NoteDigestLike[], wishes: readonly WishDigestLike[] = []): AgoItem | null {
  const md = today.slice(5);
  const year = Number(today.slice(0, 4));
  const past = (day: string) => day.slice(5) === md && Number(day.slice(0, 4)) < year;
  interface Cand {
    day: string;
    rank: number;
    at: string;
    item: AgoItem;
  }
  const cands: Cand[] = [];
  for (const n of notes) {
    const text = digestLine(n.title, n.text);
    if (!past(n.day) || text === "") continue;
    cands.push({ day: n.day, rank: n.kind === "diary" ? 0 : 1, at: n.noted_at, item: { day: n.day, years: year - Number(n.day.slice(0, 4)), id: n.id, kind: n.kind, text } });
  }
  for (const w of wishes) {
    const text = w.name.trim();
    if (!past(w.day) || text === "") continue;
    cands.push({ day: w.day, rank: 2, at: w.bought_at, item: { day: w.day, years: year - Number(w.day.slice(0, 4)), id: w.id, kind: "wish", text, wishKind: w.kind } });
  }
  if (!cands.length) return null;
  const best = cands.sort(
    (a, b) =>
      (a.day < b.day ? 1 : a.day > b.day ? -1 : 0) || // 最近那一年
      a.rank - b.rank || // 日記 › 筆記 › 願望
      (a.at < b.at ? -1 : a.at > b.at ? 1 : 0), // 同一天先發生的
  )[0];
  return best.item;
}

/* ───────── 記錄簿 ───────── */

export interface BookStop {
  kind: "start" | "station" | "term" | "now";
  name: string;
  /** "YYYY-MM-DD"；運行中那一行沒有 */
  day: string | null;
  /** 車站 id（start／now／沒有對應車站的終點＝null） */
  stationId: string | null;
}

/**
 * 經過的車站：開業 → 已到着的站（依到着日）→ 終點（已到站：到站日那天到着的最後一站標「終點」，沒有就補一行「到站」）
 * 運行中：只列到着的站，最後一行「運行中」（不列下一站——路線圖的「下一站＋金弧」管預告）。
 */
export function bookStations(route: Pick<NodeRow, "arrived_on">, openedOn: string, stations: readonly NodeRow[]): BookStop[] {
  const arrived = stations
    .filter((s) => s.arrived_on !== null && s.deleted_at === null)
    .sort((a, b) => (a.arrived_on! < b.arrived_on! ? -1 : a.arrived_on! > b.arrived_on! ? 1 : 0));
  const out: BookStop[] = [{ kind: "start", name: "開業", day: openedOn, stationId: null }];
  const end = route.arrived_on;
  let termMarked = false;
  arrived.forEach((s, i) => {
    const isTerm = end !== null && i === arrived.length - 1 && s.arrived_on === end;
    if (isTerm) termMarked = true;
    out.push({ kind: isTerm ? "term" : "station", name: s.name, day: s.arrived_on, stationId: s.id });
  });
  if (end !== null && !termMarked) out.push({ kind: "term", name: "到站", day: end, stationId: null });
  if (end === null) out.push({ kind: "now", name: "運行中", day: null, stationId: null });
  return out;
}
