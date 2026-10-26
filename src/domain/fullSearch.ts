/**
 * 完整搜尋（主線・完整搜尋班；契約 docs/research/2026-10-25-主線-完整搜尋班-契約.md）的純邏輯：
 * 命中分級與排序（D-主-113）、三組篩選（D-主-114）、摘錄切片（D-主-112）、日期欄文字（D-主-116）、名稱高亮切段。
 *
 * repository 的 `searchFull` 只負責「哪些節點命中、命中在哪一欄、那一欄的原文」；其餘都在這裡，兩殼共用、node 測得到。
 * 純函式、不碰 store／DOM／Tauri；import 一律帶 `.ts`（scripts/tests 直接載入）。
 * 済看「目前班次」（定期券的済蓋在班次上）由呼叫端的 `isDone` 決定，這裡不讀 store。
 */
import type { NodeKind, NodeRow } from "./node.ts";

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
/** 車票／車票以外（路線、支線、列車、車廂、車站） */
export type KindFilter = "all" | "ticket" | "tree";
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
