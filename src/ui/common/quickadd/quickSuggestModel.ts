/**
 * quickSuggestModel——建票列、行內編輯與方針輸入框的 `@路線`／`#荷札` 即時補完純規則（第二梯 D-FB-3；操作 4）。
 *
 * 純函式模組（帶 .ts 副檔名），供 `scripts/tests/fb-w2-quick-sel.test.ts` 直接以 Node 測試：
 *   - `detectQuickTrigger`：從輸入框文字與游標位置辨識當前正輸入的 `@路線`（含引號空白路線名、`@路線/子項`）或 `#荷札`
 *   - `buildDestSuggestions`：依幹線分組（`幹線・○○`／`其他`）過濾路線，支援模糊比對與 `@路線/` 第二層支線／列車／車廂／車票
 *   - `formatDestInsertion`／`replaceTriggerRange`：插入補完字串（含空白路線名自動加引號）或於方針框剝離 `@` 標記
 */
import type { NodeRow } from "../../../domain/node.ts";
import { tagAtCaret } from "../../../domain/tags.ts";
import type { AttachKind, AttachOption, RouteLineGroup } from "../../notes/useAttachOptions.ts";

export type SuggestRoute = Pick<NodeRow, "id" | "name" | "code" | "color" | "line_id">;
export type SuggestLine = Pick<NodeRow, "id" | "name">;

export type QuickTrigger =
  | {
      kind: "dest";
      start: number;
      end: number;
      rawQuery: string;
      quoted: boolean;
    }
  | {
      kind: "tag";
      start: number;
      end: number;
      q: string;
    };

const PRE_BOUNDARY_RE = /[\s\u3000，。、；：！？「」『』（）【】《》〈〉…—]/;
const TAG_STOP_RE = /[\s#\u0000，。、；：！？「」『』（）【】《》〈〉,;:!?()[\]{}<>"'`]/;

/** `@` 後面允許處於補完中的片段形態（支援一般無空白、`@"含空白路線`、`@"含空白路線"/子項`、`@路線/"含空白子項`） */
function isOpenAtSlice(slice: string): boolean {
  if (!/[\s\u3000\r\n]/.test(slice)) return true;
  if (/^"[^"\r\n]*$/.test(slice)) return true;
  if (/^"[^"\r\n]+"\/(?:[^\s\u3000"\r\n]*|"[^"\r\n]*)$/.test(slice)) return true;
  if (/^[^\s\u3000/"\r\n]+\/"[^"\r\n]*$/.test(slice)) return true;
  return false;
}

/** 偵測游標處是否正輸入 `@...` 或 `#...`（有選取範圍時由呼叫端先略過） */
export function detectQuickTrigger(
  text: string,
  caret: number,
  opts?: { allowDest?: boolean; allowTag?: boolean },
): QuickTrigger | null {
  const src = String(text ?? "");
  const pos = Math.max(0, Math.min(caret, src.length));
  const allowDest = opts?.allowDest !== false;
  const allowTag = opts?.allowTag !== false;

  if (allowDest) {
    for (let i = pos - 1; i >= 0; i--) {
      const ch = src.charAt(i);
      if (ch === "\n" || ch === "\r") break;
      if (ch !== "@") continue;
      if (i > 0 && !PRE_BOUNDARY_RE.test(src.charAt(i - 1))) continue;
      const slice = src.slice(i + 1, pos);
      if (!isOpenAtSlice(slice)) continue;
      const quoteCount = (slice.match(/"/g) ?? []).length;
      let end = pos;
      if (quoteCount % 2 === 1) {
        const closeIdx = src.indexOf('"', pos);
        const nlIdx = src.slice(pos).search(/[\r\n]/);
        if (closeIdx >= 0 && (nlIdx < 0 || closeIdx < pos + nlIdx)) {
          end = closeIdx + 1;
          while (end < src.length && !/[\s\u3000\r\n]/.test(src.charAt(end))) end++;
        } else {
          while (end < src.length && !/[\s\u3000\r\n]/.test(src.charAt(end))) end++;
        }
      } else {
        while (end < src.length && !/[\s\u3000\r\n]/.test(src.charAt(end))) end++;
      }
      return { kind: "dest", start: i, end, rawQuery: slice, quoted: slice.includes('"') };
    }
  }

  if (allowTag) {
    const hit = tagAtCaret(src, pos);
    if (hit) {
      let end = pos;
      while (end < src.length && !TAG_STOP_RE.test(src.charAt(end))) end++;
      return { kind: "tag", start: hit.start, end, q: hit.q };
    }
  }

  return null;
}

const fold = (s: string): string => s.normalize("NFKC").toLowerCase();

/** 模糊／子字串匹配分數（null＝不符合；分數高排前，同分維持原序） */
export function matchSuggestScore(query: string, name: string, code?: string | null): number | null {
  const q = fold(query.trim());
  if (!q) return 0;
  const nm = fold(name);
  const cd = code ? fold(code) : "";
  if (cd && cd === q) return 100;
  if (nm === q) return 96;
  if (cd && cd.startsWith(q)) return 90;
  if (nm.startsWith(q)) return 85;
  if (cd && cd.includes(q)) return 75;
  if (nm.includes(q)) return 70;
  // 字元依序出現的輕量模糊匹配（如「rw」對「日文 Work」或「單1」對「單字第1週」）
  let qi = 0;
  for (let i = 0; i < nm.length && qi < q.length; i++) {
    if (nm.charAt(i) === q.charAt(qi)) qi++;
  }
  return qi === q.length ? 40 : null;
}

export interface ParsedDestQuery<R extends SuggestRoute = SuggestRoute> {
  /** 已透過 `@路線/` 鎖定的目標路線；null 代表仍在第一層挑路線（或跨路線搜節點） */
  routeScope: R | null;
  /** 過濾關鍵字（第一層為路線／跨路線關鍵字；第二層為該路線下節點關鍵字） */
  query: string;
}

/** 解析 `@` 後字串：辨識是否已輸入 `@路線/` 進入特定路線子樹 */
export function parseDestQuery<R extends SuggestRoute>(rawQuery: string, routes: readonly R[]): ParsedDestQuery<R> {
  for (let idx = rawQuery.indexOf("/"); idx >= 0; idx = rawQuery.indexOf("/", idx + 1)) {
    const leftRaw = rawQuery.slice(0, idx).replace(/^"+|"+$/g, "").trim();
    if (!leftRaw) continue;
    const lk = fold(leftRaw);
    const route =
      routes.find((r) => r.code !== null && fold(r.code) === lk) ??
      routes.find((r) => fold(r.name) === lk) ??
      null;
    if (route) {
      const rightRaw = rawQuery.slice(idx + 1).replace(/^"+|"+$/g, "");
      return { routeScope: route, query: rightRaw };
    }
  }
  return { routeScope: null, query: rawQuery.replace(/^"+|"+$/g, "") };
}

export type DestSuggestRow<R extends SuggestRoute = SuggestRoute> =
  | { key: string; type: "header"; label: string }
  | { key: string; type: "route"; route: R; pickIndex: number; canDrill: boolean }
  | { key: string; type: "node"; route: R; opt: AttachOption; pickIndex: number; cross: boolean };

export interface DestSuggestPick<R extends SuggestRoute = SuggestRoute> {
  route: R;
  opt: AttachOption | null;
}

export interface DestSuggestResult<R extends SuggestRoute = SuggestRoute> {
  routeScope: R | null;
  query: string;
  rows: DestSuggestRow<R>[];
  picks: DestSuggestPick<R>[];
}

function groupByLineLocal<R extends SuggestRoute>(routes: readonly R[], lines: readonly SuggestLine[]): RouteLineGroup<R>[] {
  if (routes.length === 0) return [];
  const lineIds = new Set(lines.map((l) => l.id));
  const byLine = new Map<string, R[]>();
  const other: R[] = [];
  for (const r of routes) {
    if (r.line_id && lineIds.has(r.line_id)) {
      const list = byLine.get(r.line_id);
      if (list) list.push(r);
      else byLine.set(r.line_id, [r]);
    } else {
      other.push(r);
    }
  }
  const out: RouteLineGroup<R>[] = [];
  for (const l of lines) {
    const list = byLine.get(l.id);
    if (list && list.length > 0) out.push({ lineId: l.id, lineName: l.name, header: `幹線・${l.name}`, routes: list });
  }
  if (other.length > 0) out.push({ lineId: null, lineName: "其他", header: "其他", routes: other });
  return out;
}

export interface BuildDestSuggestInput<R extends SuggestRoute = SuggestRoute> {
  rawQuery: string;
  routes: readonly R[];
  lines: readonly SuggestLine[];
  /** 是否允許展開／搜尋路線下的支線／列車／車廂／車票 */
  allowSubNode: boolean;
  /** 路線本身是否可作為目標（搬車廂時路線不可直接選，但可進路線挑列車） */
  routeSelectable?: boolean;
  /** 限定可選的子節點種類（省略＝全部可選） */
  allowedKinds?: readonly AttachKind[];
  /** 各路線已載入的子樹選項（未載入時為空） */
  treesByRoute?: ReadonlyMap<string, readonly AttachOption[]>;
}

/** 建立 `@` 路線／節點補完清單（第一層依幹線分組；`@路線/` 展開該路線子樹） */
export function buildDestSuggestions<R extends SuggestRoute>(input: BuildDestSuggestInput<R>): DestSuggestResult<R> {
  const { rawQuery, routes, lines, allowSubNode, routeSelectable = true, allowedKinds, treesByRoute } = input;
  const parsed = parseDestQuery(rawQuery, routes);
  const rows: DestSuggestRow<R>[] = [];
  const picks: DestSuggestPick<R>[] = [];

  if (parsed.routeScope && allowSubNode) {
    const r = parsed.routeScope;
    const q = parsed.query.trim();
    rows.push({ key: `$scope:${r.id}`, type: "header", label: `${r.name} 底下` });
    if (!q && routeSelectable) {
      const pickIndex = picks.length;
      picks.push({ route: r, opt: null });
      rows.push({ key: `self:${r.id}`, type: "route", route: r, pickIndex, canDrill: false });
    }
    const opts = treesByRoute?.get(r.id) ?? [];
    for (const opt of opts) {
      if (allowedKinds && !allowedKinds.includes(opt.kind)) continue;
      if (!opt.selectable) continue;
      if (q && matchSuggestScore(q, opt.name) === null) continue;
      const pickIndex = picks.length;
      picks.push({ route: r, opt });
      rows.push({ key: `node:${opt.id}`, type: "node", route: r, opt, pickIndex, cross: false });
    }
    return { routeScope: r, query: parsed.query, rows, picks };
  }

  const q = parsed.query.trim();
  const matchedRoutes: R[] = [];
  for (const r of routes) {
    const lineName = r.line_id ? (lines.find((l) => l.id === r.line_id)?.name ?? "") : "";
    const s1 = matchSuggestScore(q, r.name, r.code);
    const s2 = q && lineName ? matchSuggestScore(q, lineName) : null;
    if (s1 !== null || s2 !== null) matchedRoutes.push(r);
  }

  if (routeSelectable || allowSubNode) {
    for (const g of groupByLineLocal(matchedRoutes, lines)) {
      rows.push({ key: `$line:${g.lineId ?? "other"}`, type: "header", label: g.header });
      for (const r of g.routes) {
        const pickIndex = picks.length;
        picks.push({ route: r, opt: null });
        rows.push({
          key: `route:${r.id}`,
          type: "route",
          route: r,
          pickIndex,
          canDrill: allowSubNode,
        });
      }
    }
  }

  // 有打關鍵字且支援子節點時，同步跨路線列出命中的支線／列車／車廂／車票（上限 12 筆避免洗版）
  if (q && allowSubNode && treesByRoute) {
    const crossHits: { route: R; opt: AttachOption; score: number }[] = [];
    for (const r of routes) {
      for (const opt of treesByRoute.get(r.id) ?? []) {
        if (allowedKinds && !allowedKinds.includes(opt.kind)) continue;
        if (!opt.selectable) continue;
        const sc = matchSuggestScore(q, opt.name);
        if (sc !== null) crossHits.push({ route: r, opt, score: sc });
      }
    }
    crossHits.sort((a, b) => b.score - a.score);
    const top = crossHits.slice(0, 12);
    if (top.length > 0) {
      rows.push({ key: "$cross:nodes", type: "header", label: "路線內項目" });
      for (const hit of top) {
        const pickIndex = picks.length;
        picks.push({ route: hit.route, opt: hit.opt });
        rows.push({
          key: `cross:${hit.opt.id}`,
          type: "node",
          route: hit.route,
          opt: hit.opt,
          pickIndex,
          cross: true,
        });
      }
    }
  }

  return { routeScope: null, query: parsed.query, rows, picks };
}

/** 格式化補完插入的 `@...` 片段（含空白或斜線時自動加雙引號，確保 parseQuickAdd 完整辨識） */
export function formatDestInsertion(routeName: string, subName?: string | null, drillSlash = false): string {
  const hasWs = (s: string) => /[\s\u3000]/.test(s);
  const needQuoteRoute = hasWs(routeName) || (Boolean(subName || drillSlash) && routeName.includes("/"));
  const rTok = needQuoteRoute ? `"${routeName}"` : routeName;
  if (drillSlash) {
    return `@${rTok}/`;
  }
  if (!subName) {
    return `@${rTok} `;
  }
  if (needQuoteRoute || hasWs(subName) || subName.includes("/")) {
    return `@"${routeName}"/"${subName}" `;
  }
  return `@${routeName}/${subName} `;
}

/** 以補完結果取代原文 `[start, end)` 區間並回傳新文字與新游標位置（`inserted === ""` 代表剝離標記，如方針框） */
export function replaceTriggerRange(
  text: string,
  start: number,
  end: number,
  inserted: string,
): { text: string; caret: number } {
  const before = text.slice(0, start);
  const after = text.slice(end);
  if (inserted === "") {
    if (before.endsWith(" ") && (after === "" || after.startsWith(" "))) {
      const trimmedBefore = before.slice(0, -1);
      return { text: trimmedBefore + after, caret: trimmedBefore.length };
    }
    if (before === "" && after.startsWith(" ")) {
      return { text: after.slice(1), caret: 0 };
    }
    return { text: before + after, caret: before.length };
  }
  if (inserted.endsWith(" ")) {
    const cleanAfter = after.replace(/^[ \u3000]/, "");
    return { text: before + inserted + cleanAfter, caret: before.length + inserted.length };
  }
  return { text: before + inserted + after, caret: before.length + inserted.length };
}
