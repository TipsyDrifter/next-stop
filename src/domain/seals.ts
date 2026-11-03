/**
 * seals——「済」的定義，全 App 一份（② 運行報告 D-主-181；契約 `docs/research/2026-11-02-主線-運行報告-契約.md` §1）。
 *
 * 一枚済章＝下面兩種之一，依日界線歸日：
 *   (a) 節點：kind ∈ {train, car, ticket}、存活、status='done'、completed_at 落在窗內
 *       （含連同子項一起蓋的——cascade 分支也寫 completed_at；含退役定期券）
 *   (b) 定期券的班次：occurrences 存活、status='done'（運休不算）、completed_at 落在窗內、所屬節點存活
 * 同一節點同一時刻只算一枚（退役定期券 (a)(b) 可能同時成立；`dedupeSeals`）。
 *
 * 誰在用：日記足跡（旅客筆記 `listFootprints`／`listFootprintDays`、mock 的 `footprintSeals`）、運行報告（`sealRepo`）、
 * 之後的車庫與駅スタンプ（③）。規則要改只改這裡：SQLite 的兩句 SELECT 與 mock／測試用的純函式在同一個檔，一起改。
 *
 * 本檔零 import（domain 層慣例；probe 與 node 測試直接載入）。
 */

/** 會被蓋済的節點種類（路線、支線、車站、幹線不算） */
export const SEAL_KINDS: readonly string[] = ["train", "car", "ticket"];

/** 一枚済章（＝日記足跡的 `FootprintSeal`，那邊 re-export 這個形狀） */
export interface SealFact {
  /** 單發票等＝nodes.id；定期券班次＝occurrences.id */
  id: string;
  nodeId: string;
  name: string;
  kind: "train" | "car" | "ticket";
  /** 路線色由呼叫端對 nodeStore.routes 查；臨時車票沒掛路線＝null */
  routeId: string | null;
  /** 完成時刻（UTC ISO） */
  at: string;
  /** 跟著済章讀的心情燈號（nodes.mood 或 occurrences.mood）；沒點＝null */
  mood: "green" | "yellow" | "red" | null;
  /** 定期券班次日 YYYY-MM-DD；單發票 null */
  dueOn: string | null;
}

/* ───────── SQLite（$1＝窗的開始、$2＝窗的結束，UTC ISO；[start, end)） ───────── */

/** (a) 節點的條件（`FROM nodes n`） */
export const SEAL_NODE_WHERE =
  "n.deleted_at IS NULL AND n.kind IN ('train','car','ticket') AND n.status = 'done' " +
  "AND n.completed_at IS NOT NULL AND n.completed_at >= $1 AND n.completed_at < $2";

/** (b) 班次的條件（`FROM occurrences o JOIN nodes n ON n.id = o.node_id`） */
export const SEAL_OCC_WHERE =
  "o.deleted_at IS NULL AND n.deleted_at IS NULL AND o.status = 'done' " +
  "AND o.completed_at IS NOT NULL AND o.completed_at >= $1 AND o.completed_at < $2";

/** (a) 一列＝`SealRow`（id, node_id, name, kind, route_id, at, mood, due_on） */
export const SEAL_NODE_SQL =
  "SELECT n.id, n.id AS node_id, n.name, n.kind, n.route_id, n.completed_at AS at, n.mood, NULL AS due_on " +
  "FROM nodes n WHERE " +
  SEAL_NODE_WHERE;

/** (b) 一列＝`SealRow` */
export const SEAL_OCC_SQL =
  "SELECT o.id, o.node_id, n.name, n.kind, n.route_id, o.completed_at AS at, o.mood, o.due_on " +
  "FROM occurrences o JOIN nodes n ON n.id = o.node_id WHERE " +
  SEAL_OCC_WHERE;

/** 兩句 SELECT 回來的一列 */
export interface SealRow {
  id: string;
  node_id: string;
  name: string;
  kind: SealFact["kind"];
  route_id: string | null;
  at: string;
  mood: SealFact["mood"];
  due_on: string | null;
}

export function sealOfRow(r: SealRow): SealFact {
  return { id: r.id, nodeId: r.node_id, name: r.name, kind: r.kind, routeId: r.route_id, at: r.at, mood: r.mood, dueOn: r.due_on };
}

/* ───────── 純函式（mock 與測試走這裡；語義＝上面兩句 SELECT） ───────── */

/** 時刻視窗 [start, end)（UTC ISO；＝lib/date 的 dayWindow） */
export interface IsoWindow {
  start: string;
  end: string;
}

/** 來源的最小形狀（NodeRow／Occurrence 結構上都滿足） */
export interface SealNodeSrc {
  id: string;
  name: string;
  kind: string;
  route_id: string | null;
  status: string;
  completed_at: string | null;
  mood: SealFact["mood"];
  deleted_at: string | null;
}
export interface SealOccSrc {
  id: string;
  node_id: string;
  due_on: string;
  status: string;
  completed_at: string | null;
  mood: SealFact["mood"];
  deleted_at: string | null;
}

const inWin = (iso: string | null, w: IsoWindow): iso is string => !!iso && iso >= w.start && iso < w.end;

/** (a)＋(b)：不排序、不去重（去重交給 `dedupeSeals`） */
export function sealsInWindow(w: IsoWindow, nodes: readonly SealNodeSrc[], occurrences: readonly SealOccSrc[]): SealFact[] {
  const out: SealFact[] = [];
  const byId = new Map<string, SealNodeSrc>();
  for (const n of nodes) byId.set(n.id, n);
  for (const n of nodes) {
    if (n.deleted_at !== null || n.status !== "done" || SEAL_KINDS.indexOf(n.kind) < 0 || !inWin(n.completed_at, w)) continue;
    out.push({
      id: n.id,
      nodeId: n.id,
      name: n.name,
      kind: n.kind as SealFact["kind"],
      routeId: n.route_id,
      at: n.completed_at,
      mood: n.mood,
      dueOn: null,
    });
  }
  for (const o of occurrences) {
    const n = byId.get(o.node_id);
    if (!n || n.deleted_at !== null || o.deleted_at !== null || o.status !== "done" || !inWin(o.completed_at, w)) continue;
    out.push({
      id: o.id,
      nodeId: n.id,
      name: n.name,
      kind: n.kind as SealFact["kind"],
      routeId: n.route_id,
      at: o.completed_at,
      mood: o.mood,
      dueOn: o.due_on,
    });
  }
  return out;
}

/** 依完成時刻排序、同一節點同一時刻只留第一枚（退役定期券 (a)(b) 同時成立的那種） */
export function dedupeSeals<T extends Pick<SealFact, "nodeId" | "at">>(seals: readonly T[]): T[] {
  const byAt = (a: T, b: T) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0);
  const seen = new Set<string>();
  const out: T[] = [];
  for (const s of [...seals].sort(byAt)) {
    const k = s.nodeId + "\u0000" + s.at;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

/** 每天幾枚：`dayOf`＝日界線歸日（呼叫端給 `iso => dayKeyOf(iso, h)`）。先去重再數 */
export function countSealsByDay(seals: readonly Pick<SealFact, "nodeId" | "at">[], dayOf: (iso: string) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of dedupeSeals(seals)) {
    const d = dayOf(s.at);
    out[d] = (out[d] ?? 0) + 1;
  }
  return out;
}
