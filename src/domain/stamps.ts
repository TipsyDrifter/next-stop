/**
 * 駅スタンプ（第五本第一梯 ③；契約 `docs/research/2026-11-02-主線-車庫與回顧-契約.md` §二）——純函式，零 IO。
 *
 * 「只記發生過的事」：每一枚都由事實觸發、帶日期；沒發生的章不存在（不畫灰格、不排「還差 N」）。
 * 為什麼存表、不每次現算：日期要固定（現算的話取消一枚済，「第 1000 枚」就往後跳）；蓋章的那台建列並通知，
 * 另一台經同步收到既有列不再通知；歷史事實不全（車站到站沒有時刻、0002 前的済沒有事件），存下來每次看才一致。
 *
 *   detectStamps(facts)        → 應有的章（DesiredStamp，id 還沒算）
 *   diffStamps(desired, rows)  → 插入／復活／收回三份清單（只 insert 缺的，不改既有活列——D-主-210）
 *
 * id＝uuid v5(STAMP_ID_NAMESPACE, "kind|subject|value")：兩台各自蓋會收斂成同一列（D-主-208a）。
 */
import { uuidv5 } from "../lib/uuidv5";

export type StampKind =
  | "opening"
  | "station"
  | "route"
  | "line"
  | "route_year"
  | "ledger_year"
  | "seals"
  | "diary"
  | "time_cat";

export interface StampRow {
  id: string;
  kind: StampKind;
  subject_id: string | null;
  value: number | null;
  label: string;
  stamped_on: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface DesiredStamp {
  kind: StampKind;
  subject_id: string | null;
  value: number | null;
  label: string;
  stamped_on: string;
}

/** 有身分的章（id 算好了） */
export type KeyedStamp = DesiredStamp & { id: string };

/** 只蓋這幾枚累計章（使用者 11-01 定案 4：稀疏、各一次） */
export const SEAL_MILESTONES: readonly number[] = [100, 1000];
export const DIARY_MILESTONES: readonly number[] = [100];
export const TIME_CAT_HOURS: readonly number[] = [100];

/** 車站／路線／幹線這三種會因「取消到站」收回；其餘蓋了不收回 */
export const RETRACTABLE_KINDS: readonly StampKind[] = ["station", "route", "line"];

export const STAMP_ID_NAMESPACE = "6f1d3c52-8a7e-4b0c-9d2f-3e5a7c1b9d40";

export function stampKey(kind: StampKind, subjectId: string | null, value: number | null): string {
  return `${kind}|${subjectId ?? ""}|${value ?? ""}`;
}

export function stampId(kind: StampKind, subjectId: string | null, value: number | null): Promise<string> {
  return uuidv5(STAMP_ID_NAMESPACE, stampKey(kind, subjectId, value));
}

/* ───────── 事實 ───────── */

export interface SubjectFact {
  id: string;
  name: string;
  arrived_on: string | null;
  /** false＝節點已刪除（章不收回、也不新蓋） */
  alive: boolean;
}

export interface RouteFact extends SubjectFact {
  /** 開業日（路線 created_at 與子樹最早一枚 issued 事件取早的那天，依日界線） */
  opened_on: string;
}

/** 一枚済（時間先後已排好） */
export interface SealFact {
  day: string;
  name: string;
}

/** 一塊已結束、算數的時間塊 */
export interface BlockFact {
  category_id: string;
  /** 毫秒長度 */
  ms: number;
  /** 結束那天（依日界線） */
  end_day: string;
  /** 結束時刻（排序用；ISO） */
  end_at: string;
}

export interface StampFacts {
  /** 今天（依日界線）——「滿一年」不蓋到未來 */
  today: string;
  /** 最早建立的那張票（列車／車廂／車票，含已刪的） */
  firstTask: { day: string; name: string } | null;
  stations: SubjectFact[];
  routes: RouteFact[];
  lines: SubjectFact[];
  /** 全部済，舊→新 */
  seals: SealFact[];
  /** 每篇日記寫下的那天，舊→新 */
  diaryDays: string[];
  /** 第一筆帳建立那天 */
  ledgerFirstDay: string | null;
  /** 已結束的時間塊（不含待確認的「跑太久」塊），舊→新 */
  blocks: BlockFact[];
  /** 分類 id → 名字 */
  categoryNames: Record<string, string>;
}

/** "YYYY-MM-DD" 加 n 天（本地日曆，不受夏令時間影響） */
export function addDaysKey(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

/** 滿一年＝那天加 365 天 */
export function yearAfter(day: string): string {
  return addDaysKey(day, 365);
}

const HOUR = 3_600_000;

/**
 * 事實 → 應有的章。順序不重要（呼叫端照 id 比對）。
 */
export function detectStamps(f: StampFacts): DesiredStamp[] {
  const out: DesiredStamp[] = [];
  const put = (kind: StampKind, subject_id: string | null, value: number | null, label: string, stamped_on: string) =>
    out.push({ kind, subject_id, value, label, stamped_on });

  if (f.firstTask) put("opening", null, null, f.firstTask.name, f.firstTask.day);

  for (const s of f.stations) if (s.alive && s.arrived_on) put("station", s.id, null, s.name, s.arrived_on);
  for (const r of f.routes) if (r.alive && r.arrived_on) put("route", r.id, null, r.name, r.arrived_on);
  for (const l of f.lines) if (l.alive && l.arrived_on) put("line", l.id, null, l.name, l.arrived_on);

  // 路線開業滿一年：那天到了、而且那天它還沒到站（到站後的週年不算「跑滿一年」）
  for (const r of f.routes) {
    if (!r.alive) continue;
    const at = yearAfter(r.opened_on);
    if (at > f.today) continue;
    if (r.arrived_on !== null && r.arrived_on < at) continue;
    put("route_year", r.id, null, r.name, at);
  }

  if (f.ledgerFirstDay) {
    const at = yearAfter(f.ledgerFirstDay);
    if (at <= f.today) put("ledger_year", null, null, "記帳", at);
  }

  for (const n of SEAL_MILESTONES) {
    const s = f.seals[n - 1];
    if (s) put("seals", null, n, s.name, s.day);
  }
  for (const n of DIARY_MILESTONES) {
    const d = f.diaryDays[n - 1];
    if (d) put("diary", null, n, "日記", d);
  }

  // 每個分類累計滿 N 小時：跨過門檻那一塊結束的那天
  const acc = new Map<string, number>();
  const crossed = new Set<string>();
  for (const b of f.blocks) {
    const before = acc.get(b.category_id) ?? 0;
    const after = before + b.ms;
    acc.set(b.category_id, after);
    for (const h of TIME_CAT_HOURS) {
      const key = `${b.category_id}|${h}`;
      if (crossed.has(key)) continue;
      if (before < h * HOUR && after >= h * HOUR) {
        crossed.add(key);
        put("time_cat", b.category_id, h, f.categoryNames[b.category_id] ?? "時刻表", b.end_day);
      }
    }
  }
  return out;
}

export interface StampPlan {
  insert: KeyedStamp[];
  /** 收回過又成立的：同一列 deleted_at 清掉、日期與名字換新 */
  revive: KeyedStamp[];
  /** 取消到站的車站／路線／幹線：軟刪 */
  retract: StampRow[];
}

/**
 * 應有的章 vs 表裡的列 → 要寫什麼。活列一律不改（日期一旦蓋下就固定）。
 * 收回只看「節點還在、但 arrived_on 清掉了」；節點刪掉不收回（章上的字不變）。
 */
export function diffStamps(desired: readonly KeyedStamp[], rows: readonly StampRow[], f: Pick<StampFacts, "stations" | "routes" | "lines">): StampPlan {
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  const insert: KeyedStamp[] = [];
  const revive: KeyedStamp[] = [];
  for (const d of desired) {
    const row = byId.get(d.id);
    if (!row) insert.push(d);
    else if (row.deleted_at !== null) revive.push(d);
  }
  const unarrived = new Set<string>();
  for (const s of [...f.stations, ...f.routes, ...f.lines]) if (s.alive && s.arrived_on === null) unarrived.add(s.id);
  const retract = rows.filter(
    (r) => r.deleted_at === null && RETRACTABLE_KINDS.includes(r.kind) && r.subject_id !== null && unarrived.has(r.subject_id),
  );
  return { insert, revive, retract };
}

export function isEmptyPlan(p: StampPlan): boolean {
  return !p.insert.length && !p.revive.length && !p.retract.length;
}

/** 給 id（非同步：uuid v5 用 Web Crypto） */
export async function keyStamps(desired: readonly DesiredStamp[]): Promise<KeyedStamp[]> {
  return Promise.all(desired.map(async (d) => ({ ...d, id: await stampId(d.kind, d.subject_id, d.value) })));
}

/* ───────── 畫面用的說法 ───────── */

/** 一枚章的完整說明（title／aria-label、toast） */
export function stampTitle(s: Pick<StampRow, "kind" | "label" | "value" | "stamped_on">, ctx?: { routeName?: string | null }): string {
  const [, m, d] = s.stamped_on.split("-").map(Number);
  const when = `${m}月${d}日`;
  switch (s.kind) {
    case "opening":
      return `開業・第一張票「${s.label}」・${when}`;
    case "station":
      return `車站到着・${ctx?.routeName ? `${ctx.routeName}「${s.label}」` : `「${s.label}」`}・${when}`;
    case "route":
      return `路線到站・${s.label}・${when}`;
    case "line":
      return `幹線到站・${s.label}・${when}`;
    case "route_year":
      return `路線開業滿一年・${s.label}・${when}`;
    case "ledger_year":
      return `記帳滿一年・${when}`;
    case "seals":
      return `第 ${s.value} 枚済「${s.label}」・${when}`;
    case "diary":
      return `日記累計 ${s.value} 篇・${when}`;
    case "time_cat":
      return `時刻表「${s.label}」累計 ${s.value} 小時・${when}`;
  }
}

/** toast 的短說法 */
export function stampShort(s: Pick<StampRow, "kind" | "label" | "value">): string {
  switch (s.kind) {
    case "opening":
      return "開業";
    case "station":
      return `${s.label} 到着`;
    case "route":
      return `${s.label} 到站`;
    case "line":
      return `幹線「${s.label}」到站`;
    case "route_year":
      return `${s.label} 開業滿一年`;
    case "ledger_year":
      return "記帳滿一年";
    case "seals":
      return `第 ${s.value} 枚済`;
    case "diary":
      return `日記累計 ${s.value} 篇`;
    case "time_cat":
      return `${s.label}累計 ${s.value} 小時`;
  }
}

/** 印譜帳的排序：日期舊→新，同一天依 kind 固定順序 */
const KIND_ORDER: Record<StampKind, number> = {
  opening: 0,
  station: 1,
  seals: 2,
  diary: 3,
  time_cat: 4,
  ledger_year: 5,
  route_year: 6,
  route: 7,
  line: 8,
};
export function compareStamps(a: Pick<StampRow, "stamped_on" | "kind" | "id">, b: Pick<StampRow, "stamped_on" | "kind" | "id">): number {
  return a.stamped_on < b.stamped_on ? -1 : a.stamped_on > b.stamped_on ? 1 : KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.id < b.id ? -1 : 1);
}
