/**
 * 完整搜尋（主線・完整搜尋班；契約 docs/research/2026-10-25-主線-完整搜尋班-契約.md）的純邏輯：
 * 命中分級與排序（D-主-113）、三組篩選（D-主-114）、摘錄切片（D-主-112）、日期欄文字（D-主-116）、名稱高亮切段。
 *
 * repository 的 `searchFull` 只負責「哪些節點命中、命中在哪一欄、那一欄的原文」；其餘都在這裡，兩殼共用、node 測得到。
 * 純函式、不碰 store／DOM／Tauri；import 一律帶 `.ts`（scripts/tests 直接載入）。
 * 済看「目前班次」（定期券的済蓋在班次上）由呼叫端的 `isDone` 決定，這裡不讀 store。
 * 方針組（方針擴充 辛 D-主-382）：另成一組、不混進節點結果；篩選怎麼作用見 `filterAimHits`。
 */
import type { NodeKind, NodeRow } from "./node.ts";
import { periodOfKey, periodRangeOf, periodShortLabel, stationHeadText, stationIdOfKey, weekOnOf, type WeekAimRow } from "./weekAims.ts";

/** 命中在哪一欄：名稱 → 概要 → 乘務記錄（只算手記）；數字越小越前面 */
export type FullSearchField = "name" | "description" | "log";

const FIELD_RANK: Record<FullSearchField, number> = { name: 0, description: 1, log: 2 };

/** repository 回的一筆：節點＋最好的命中欄＋那一欄的原文（名稱命中時 text 為 null） */
export interface FullSearchHit {
  node: NodeRow;
  field: FullSearchField;
  text: string | null;
}

export type StatusFilter = "all" | "open" | "done";
/** 車票／車票以外（路線、支線、列車、車廂、車站）／方針 */
export type KindFilter = "all" | "ticket" | "tree" | "aim";
/** 全部／臨時車票／某條路線的 id */
export type RouteFilter = "all" | "temp" | { routeId: string };

export interface FullSearchFilter {
  status: StatusFilter;
  kind: KindFilter;
  route: RouteFilter;
}

export const DEFAULT_FILTER: FullSearchFilter = { status: "all", kind: "all", route: "all" };

export function isDefaultFilter(f: FullSearchFilter): boolean {
  return f.status === "all" && f.kind === "all" && f.route === "all";
}

/** 臨時車票＝沒有父節點的車票（跟 Ctrl+P 的淡字口徑同一條） */
export function isTempTicket(node: Pick<NodeRow, "kind" | "parent_id">): boolean {
  return node.kind === "ticket" && !node.parent_id;
}

/** 三組篩選（D-主-114）；`isDone` 由呼叫端給（定期券看目前班次） */
export function filterHits(
  hits: readonly FullSearchHit[],
  f: FullSearchFilter,
  isDone: (node: NodeRow) => boolean,
): FullSearchHit[] {
  return hits.filter(({ node }) => {
    if (f.status !== "all" && isDone(node) !== (f.status === "done")) return false;
    if (f.kind === "aim") return false;
    if (f.kind === "ticket" && node.kind !== "ticket") return false;
    if (f.kind === "tree" && node.kind === "ticket") return false;
    if (f.route === "temp") return isTempTicket(node);
    // 掛了路線的臨時車票家在那條路線的大綱頂層（D-筆-26），兩邊都算
    if (f.route !== "all") return node.id === f.route.routeId || node.route_id === f.route.routeId;
    return true;
  });
}

/** 排序（D-主-113）：名稱命中 → 概要 → 乘務記錄；同層未完成在前、済在後；再依最近更新（新→舊），最後 id 定序 */
export function rankHits(hits: readonly FullSearchHit[], isDone: (node: NodeRow) => boolean): FullSearchHit[] {
  const done = new Map(hits.map((h) => [h.node.id, isDone(h.node)]));
  return [...hits].sort(
    (a, b) =>
      FIELD_RANK[a.field] - FIELD_RANK[b.field] ||
      Number(done.get(a.node.id)) - Number(done.get(b.node.id)) ||
      b.node.updated_at.localeCompare(a.node.updated_at) ||
      a.node.id.localeCompare(b.node.id),
  );
}

/**
 * 清單不動（D-主-110；沙盒 F1）：同一次搜尋（字與篩選沒變）裡資料變了重查時，已經在清單上的照舊位置，
 * 新冒出來的接在後面（照排序）；蓋済、改名只在原地變樣子，換字或換篩選才重新排。
 * `prev`＝上一次的順序（id → 位置），null＝這次是新的搜尋；回新的順序表給下一次用。
 */
export function keepOrder(
  ranked: readonly FullSearchHit[],
  prev: ReadonlyMap<string, number> | null,
): { hits: FullSearchHit[]; order: Map<string, number> } {
  if (!prev) return { hits: [...ranked], order: new Map(ranked.map((h, i) => [h.node.id, i])) };
  const known = ranked.filter((h) => prev.has(h.node.id)).sort((a, b) => prev.get(a.node.id)! - prev.get(b.node.id)!);
  const fresh = ranked.filter((h) => !prev.has(h.node.id));
  const hits = [...known, ...fresh];
  return { hits, order: new Map(hits.map((h, i) => [h.node.id, i])) };
}

/** 一段文字照「命中／不命中」切開（大小寫不敏感、字面比對）；名稱高亮與摘錄共用 */
export interface TextPart {
  text: string;
  hit: boolean;
}

export function splitHits(text: string, term: string): TextPart[] {
  const t = term.trim();
  if (!t) return text ? [{ text, hit: false }] : [];
  const low = text.toLowerCase();
  const needle = t.toLowerCase();
  const parts: TextPart[] = [];
  let at = 0;
  for (let i = low.indexOf(needle); i !== -1; i = low.indexOf(needle, i + needle.length)) {
    if (i > at) parts.push({ text: text.slice(at, i), hit: false });
    parts.push({ text: text.slice(i, i + needle.length), hit: true });
    at = i + needle.length;
  }
  if (at < text.length) parts.push({ text: text.slice(at), hit: false });
  return parts;
}

/** 摘錄：把原文壓成一行，取第一個命中前後各 `radius` 字；被截掉的那頭補「…」。找不到命中就取開頭 */
export function excerptOf(text: string, term: string, radius = 18): TextPart[] {
  const flat = text.replace(/\s+/g, " ").trim();
  const t = term.trim().toLowerCase();
  const i = t ? flat.toLowerCase().indexOf(t) : -1;
  const from = i < 0 ? 0 : Math.max(0, i - radius);
  const to = i < 0 ? Math.min(flat.length, radius * 2) : Math.min(flat.length, i + t.length + radius);
  const body = splitHits(flat.slice(from, to), term);
  if (from > 0) body.unshift({ text: "…", hit: false });
  if (to < flat.length) body.push({ text: "…", hit: false });
  return body;
}

/** 摘錄前的欄名（名稱命中沒有摘錄） */
export const FIELD_LABEL: Record<Exclude<FullSearchField, "name">, string> = {
  description: "概要",
  log: "乘務記錄",
};

function md(key: string, thisYear: string): string {
  const [y, m, d] = key.split("-");
  return y === thisYear ? `${Number(m)}/${Number(d)}` : `${y}/${Number(m)}/${Number(d)}`;
}

/** 日期欄的一格：`tag` 是前面的淡字小標（締切「締」、還在跑的定期券「下一班」）；`late`＝過了還沒済（整格赭色） */
export interface DateCell {
  tag: "" | "締" | "下一班";
  text: string;
  late: boolean;
}

/**
 * 右側日期欄（D-主-116；原型 dateHTML）：有執行日寫執行日（還在跑的定期券寫「下一班」、今天還沒済寫「今天」）；
 * 沒有就寫締切「締 M/D」；都沒有回 null。不是今年的日期帶年份。`today`＝營業日的 YYYY-MM-DD。
 */
export function dateCell(
  node: Pick<NodeRow, "scheduled_on" | "due_on" | "repeat_rule" | "status">,
  done: boolean,
  today: string,
): DateCell | null {
  const year = today.slice(0, 4);
  // 退役的定期券（D-主-122）：執行日＝最後一班済的那天（repository 推導；沒済過＝NULL）。照印、不赭、不講「今天」；
  // NULL 就空白——不退到締切，免得空出來的執行日被締切頂上去、看起來像「這張票有截止日要趕」
  if (node.repeat_rule && node.status === "done") {
    return node.scheduled_on ? { tag: "", text: md(node.scheduled_on, year), late: false } : null;
  }
  if (node.scheduled_on) {
    // 還在跑的定期券（退役的上面已經分流）——今天那班還沒済寫「今天」，其餘寫「下一班」（沙盒 O5：
    // 今天済了之後 scheduled_on 推到下一班，`done` 是看目前班次的，不能拿來判退役）
    if (node.repeat_rule) {
      if (node.scheduled_on === today && !done) return { tag: "", text: "今天", late: false };
      return { tag: "下一班", text: md(node.scheduled_on, year), late: false };
    }
    if (node.scheduled_on === today && !done) return { tag: "", text: "今天", late: false };
    return { tag: "", text: md(node.scheduled_on, year), late: !done && node.scheduled_on < today };
  }
  if (node.due_on) return { tag: "締", text: md(node.due_on, year), late: !done && node.due_on < today };
  return null;
}

/** 種類篩選的選項文字 */
export const KIND_FILTER_LABEL: Record<KindFilter, string> = {
  all: "全部",
  ticket: "車票",
  tree: "路線・列車・車廂",
  aim: "方針",
};

export const STATUS_FILTER_LABEL: Record<StatusFilter, string> = {
  all: "全部",
  open: "未完成",
  done: "済",
};

/** 完整搜尋會出現的節點種類（同 Ctrl+P：幹線不進結果） */
export const SEARCHABLE_KINDS: readonly NodeKind[] = ["route", "branch", "train", "car", "ticket", "station"];

/** 一次畫幾列；捲到底再接一批（D-主-115） */
export const RESULT_PAGE = 300;

/* ───────────── 方針組（D-主-382） ───────────── */

/** 一句方針的命中：句子＋它掛的路線或支線＋（車站方針）那一站 */
export interface AimSearchHit {
  aim: WeekAimRow;
  /** 掛的路線或支線；沒掛或已刪＝null（標籤消失、句子留著，§3 #16） */
  node: NodeRow | null;
  /** 車站方針的那一站；其他期間＝null */
  station: NodeRow | null;
}

/**
 * 句子列 → 命中：`nodes`＝查到的活節點（已刪的不要放進來）。
 * 車站被刪的方針跟著藏、復原就回來（§3 #16），所以這裡濾掉，不在 repository 濾：repository 只管句子文字。
 */
export function buildAimHits(aims: readonly WeekAimRow[], nodes: ReadonlyMap<string, NodeRow>): AimSearchHit[] {
  const out: AimSearchHit[] = [];
  for (const aim of aims) {
    const stationId = stationIdOfKey(aim.week_on);
    const station = stationId ? (nodes.get(stationId) ?? null) : null;
    if (stationId && !station) continue;
    out.push({ aim, node: aim.node_id ? (nodes.get(aim.node_id) ?? null) : null, station });
  }
  return out;
}

/** 這句算哪條路線：掛的節點優先；車站方針沒掛＝那一站的路線；都沒有＝null */
export function aimRouteId(hit: Pick<AimSearchHit, "node" | "station">): string | null {
  const { node, station } = hit;
  if (node) return node.kind === "route" ? node.id : node.route_id;
  return station ? (station.route_id ?? station.parent_id) : null;
}

/**
 * 三組篩選對方針組的作用（節點的篩選照舊，兩組各篩各的）：
 * - 狀態：未完成／済＝看這句有沒有蓋済。
 * - 種類：全部、方針＝留著；車票、路線・列車・車廂＝整組不出現（方針不是這兩種）。
 * - 路線：某條路線＝`aimRouteId` 是它（掛它、掛它的支線、它的車站）；臨時車票＝整組不出現（方針不是票）；沒掛路線的句子只在「全部」出現。
 */
export function filterAimHits(hits: readonly AimSearchHit[], f: FullSearchFilter): AimSearchHit[] {
  if (f.kind === "ticket" || f.kind === "tree" || f.route === "temp") return [];
  const route = f.route;
  return hits.filter((h) => {
    if (f.status !== "all" && (h.aim.done_at !== null) !== (f.status === "done")) return false;
    return route === "all" || aimRouteId(h) === route.routeId;
  });
}

/** 排序同節點的同層規則（D-主-113）：未完成在前、済在後；再依最近更新（新→舊），最後 id 定序 */
export function rankAimHits(hits: readonly AimSearchHit[]): AimSearchHit[] {
  return [...hits].sort(
    (a, b) =>
      Number(a.aim.done_at !== null) - Number(b.aim.done_at !== null) ||
      b.aim.updated_at.localeCompare(a.aim.updated_at) ||
      a.aim.id.localeCompare(b.aim.id),
  );
}

/** 週的 week_on 是寫的當下的週首：換算成現在的週首才跟「本週」、行程表那一週對得上；其他期間原樣 */
function currentKeyOfRow(key: string, weekStart: 0 | 1): string {
  return periodOfKey(key) === "week" ? weekOnOf(key, weekStart) : key;
}

/** 一列的期間字：本週／上週／10/26 那週、本月／10月／2025年10月、今年／去年／2025 年；車站＝站名・日期 */
export function aimPeriodText(hit: Pick<AimSearchHit, "aim" | "station">, today: string, weekStart: 0 | 1): string {
  const key = hit.aim.week_on;
  if (periodOfKey(key) === "station") return stationHeadText(hit.station);
  return periodShortLabel(currentKeyOfRow(key, weekStart), today, weekStart);
}

/** 一列的淡字：掛的路線或支線；車站方針沒掛＝那一站的路線（搜尋清單要看得出是哪條）；都沒有＝空字 */
export function aimPlaceText(hit: Pick<AimSearchHit, "node" | "station">, routes: readonly Pick<NodeRow, "id" | "name">[]): string {
  if (hit.node) return hit.node.name;
  const rid = aimRouteId(hit);
  return rid ? (routes.find((r) => r.id === rid)?.name ?? "") : "";
}

/** 行程表要落在哪一天：今天在這一期裡＝今天；否則這一期第一天。週、月才問（年、車站不走行程表，periodRangeOf 對車站會丟 RangeError） */
export function aimLandingDay(key: string, today: string, weekStart: 0 | 1): string {
  const { from, to } = periodRangeOf(currentKeyOfRow(key, weekStart));
  return today >= from && today <= to ? today : from;
}
