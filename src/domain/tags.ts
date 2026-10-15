/**
 * 📝 旅客筆記・荷札（tags）——型別＋純函式（車次③「荷札」；契約 §4）
 *
 * 規格：docs/research/2026-10-12-旅客筆記-車次③荷札-契約.md §4
 * 行為對照：prototypes/旅客筆記-荷札-src/logic.js（標 `=logic.js:行` 的地方逐字對齊；差異寫在註解）
 * 拍板：決策記錄 旅客筆記 D-筆-7／19／37～46
 *
 * 同一語意只定義一次（契約 §1-9）：名稱正規化、內文解析、建議排序、改名／刪除的計畫全在這裡；
 * repository 只執行計畫、UI 只畫、Rust 零邏輯。
 *
 * 寫法限制（契約 §4 開頭）：
 *   - 零 import（只有 `import type`，執行期剝掉）——`scripts/tests/tags-logic.test.ts` 用 node 直接載入本檔
 *   - 只用可剝除語法：不用 enum／namespace／參數屬性
 *
 * 與原型的差異：
 *   - 0-19（D-筆-44）：`#` 前面是全形標點也算荷札（`PRE_OK`）；`tagAtCaret` 同步
 *   - 樹的資料來源是 `TagIndexSource`（tags＋taggings 兩張表的存活列），不再從內文即時解析；
 *     筆記與日記的 taggings 由 repository 的 `syncBodyTags` 從內文推導（契約 0-13）
 *   - 刪除只有「整段字一起刪」（D-筆-39；原型的 strip 分支不移植）
 *   - 不移植：renderBody／inlineHtml 的 HTML 產出（④）、escapeHtml、entities、改資料的 attach／detach／apply*、日期
 */
import type { TaggedItem } from "../data/tagRepository";

/* ═══ 常數 ═══ */

/** uuid v5 of name_key（固定常數；兩台同名同 id 的前提）。永不改。 */
export const TAG_ID_NAMESPACE = "7a4e9c2b-1d5f-5b8a-9e3c-6f0d2a8b4c1e";
/** uuid v5 of `${entity_type}|${entity_id}|${tag_id}`。永不改。 */
export const TAGGING_ID_NAMESPACE = "3c8b1f6d-9a2e-5c4b-8d7f-1e5a0b9c2d6f";
/** entity_type='node' 只接受這三種節點（路線、幹線、支線、車站掛不上） */
export const TAG_ENTITY_NODE_KINDS: readonly string[] = ["ticket", "train", "car"];
/** 裝置本地 settings 鍵（不同步；契約 0-10） */
export const TAGS_BACKFILL_KEY = "notes_tags_backfill";
export const TAGS_RECENT_KEY = "notes_tags_recent";
/** 手機點選器「最近用過」最多幾個 */
export const RECENT_MAX = 6;

/* ═══ 型別 ═══ */

export type NormalizedName = { ok: true; name: string; key: string } | { ok: false; reason: string };
/** 內文裡的一個荷札：start＝# 的位置、end＝末字之後、raw＝# 後的原字（=logic.js:96-98） */
export interface TagOccurrence { start: number; end: number; raw: string; name: string; key: string }
/** 鍵集合：Set 或陣列都收 */
export type KeySet = ReadonlySet<string> | readonly string[];

/**
 * 樹與計數的來源（repository `loadIndexSource` 回）：存活的 tags 全部＋存活且實體存活的 taggings。
 * `kinds`（選填，契約 §4.2 affectedCounts 列）：entityId → 'ticket'|'train'|'car'|'note'|'diary'（別線不填＝other）。
 */
export interface TagIndexSource {
  tags: { id: string; name: string; key: string }[];
  taggings: { tagId: string; entityType: string; entityId: string }[];
  kinds?: Record<string, string>;
}
/** 樹的一個節點（=logic.js:199-201，多 id）。虛資料夾＝只存在於路徑中段、表裡沒有那一列的父層（real:false、id:null） */
export interface TagNode {
  key: string;
  /** 全路徑顯示名（保留大小寫） */
  name: string;
  /** 末段 */
  seg: string;
  real: boolean;
  depth: number;
  parent: string | null;
  children: string[];
  /** 直接掛這個荷札的東西數 */
  direct: number;
  /** 含子孫、同一個東西只算一次（點父看子的數字） */
  total: number;
  /** 真荷札的 tags.id；虛資料夾 null */
  id: string | null;
}
export interface TagEnt { type: string; id: string; keys: string[]; kind?: string }
export interface TagIndex { byKey: Record<string, TagNode>; roots: string[]; ents: TagEnt[] }
export interface TagTreeRow { key: string; node: TagNode; open: boolean; hasKids: boolean }
export interface TagSuggestItem {
  key: string;
  name: string;
  count: number;
  /** 0 整名相同／1 某段相同／2 段首／3 中間含有；瀏覽模式＝相對層數 */
  tier: number;
  real: boolean;
  /** 要加粗的字元範圍（對 name／key 都成立，兩者等長） */
  hl: [number, number] | null;
}
export interface TagSuggestResult {
  items: TagSuggestItem[];
  create: { name: string; key: string } | null;
  hint: string | null;
  /** 瀏覽模式（打 `難度/`）的父 key */
  browse: string | null;
}
export interface SuggestOptions { exclude?: KeySet; includeVirtual?: boolean; limit?: number }
export interface AffectedCounts { ticket: number; train: number; car: number; note: number; diary: number; other: number; total: number }
export type KindOf = (type: string, id: string) => string;
export interface RenameMove { from: string; to: string; toName: string }
export type RenamePlan =
  | {
      ok: true;
      /** 新舊 key 相同（只改大小寫／全形寫法）＝只換顯示名 */
      same: boolean;
      nameOnly?: boolean;
      oldKey: string;
      oldName: string;
      newKey: string;
      newName: string;
      moves: RenameMove[];
      /** 子孫搬過去後撞到既有真荷札的 key */
      conflicts: string[];
      /** 自己是真荷札、改成既有真荷札＝併入 */
      rootConflict: { key: string; name: string; count: number } | null;
      affected: AffectedCounts;
      childCount: number;
      ownCount: number;
    }
  | { ok: false; reason: string };
export type DeletePlan =
  | {
      ok: true;
      key: string;
      name: string;
      /** 自己＋全部子孫（含虛資料夾） */
      keys: string[];
      /** 摘下幾處（實體數） */
      places: number;
      affected: AffectedCounts;
      /** 底下有東西的子荷札數 */
      kidsWithItems: number;
      /** 要改內文的筆記＋日記 */
      bodyCount: number;
      /** 真的子孫荷札數（不含自己；契約外增補，給 toast 28「（含 N 個子荷札）」） */
      childCount: number;
    }
  | { ok: false; reason: string };
export type InlineSegment = { kind: "text" | "code" | "url"; text: string } | { kind: "tag"; occ: TagOccurrence };
/** `groupTaggedItems` 回的列：多一個 `rel`（看父層時它實際掛的子荷札相對名，「、」接；沒有＝null） */
export type GroupedTaggedItem = TaggedItem & { rel: string | null };
export interface TaggedGroups {
  nodes: { open: GroupedTaggedItem[]; done: GroupedTaggedItem[] };
  notes: GroupedTaggedItem[];
  diaries: GroupedTaggedItem[];
  other: GroupedTaggedItem[];
}

/* ═══ 一、名稱（=logic.js:35-60） ═══ */

function nfkc(s: unknown): string {
  return String(s == null ? "" : s).normalize("NFKC");
}
function lowerAscii(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}
function toSet(ks: KeySet | null | undefined): ReadonlySet<string> {
  if (!ks) return new Set();
  return ks instanceof Set ? ks : new Set(ks as readonly string[]);
}

/**
 * 正規化＋驗證（=logic.js:43-54）：trim、去開頭一個 `#`、NFKC、各段去頭尾空白；不可含空白與 `#`、層不可空、
 * 至少一個非數字字元。name＝顯示用（保留大小寫）、key＝英文小寫；兩者字數相同，字元位置可以互相對照。
 */
export function normalizeName(raw: string): NormalizedName {
  let s = nfkc(raw).replace(/^\s+|\s+$/g, "");
  if (s.charAt(0) === "#") s = s.slice(1);
  if (!s) return { ok: false, reason: "還沒有名稱" };
  const segs = s.split("/").map((x) => x.replace(/^\s+|\s+$/g, ""));
  for (const seg of segs) if (!seg) return { ok: false, reason: "層與層之間不能空著" };
  const name = segs.join("/");
  if (/\s/.test(name)) return { ok: false, reason: "荷札名稱不能有空白" };
  if (name.indexOf("#") >= 0) return { ok: false, reason: "荷札名稱不能有 #" };
  if (!/[^0-9/]/.test(name)) return { ok: false, reason: "只有數字不能當荷札（像 #2026）" };
  return { ok: true, name, key: lowerAscii(name) };
}
export function keyOf(raw: string): string | null {
  const n = normalizeName(raw);
  return n.ok ? n.key : null;
}
export function segsOf(key: string): string[] {
  return String(key).split("/");
}
export function depthOf(key: string): number {
  return segsOf(key).length;
}
export function parentOf(key: string): string | null {
  const i = key.lastIndexOf("/");
  return i < 0 ? null : key.slice(0, i);
}
/** key 是 parentKey 自己或它的子孫（不會把 `#高鐵` 算進 `#高`） */
export function isUnder(key: string, parentKey: string): boolean {
  return key === parentKey || key.indexOf(parentKey + "/") === 0;
}
export function lastSeg(name: string): string {
  const i = name.lastIndexOf("/");
  return i < 0 ? name : name.slice(i + 1);
}

/* ═══ 二、內文解析（=logic.js:65-157） ═══ */

/**
 * 色碼：3／4／6／8 位十六進位且至少含一個數字（#AD3D2B、#1e1e1e），或同一個字母重複（#fff、#FFFFFF）。
 * 只有字母的十六進位英文字（#cafe、#add、#face）當荷札——那是字，不是色。
 */
export function isHexColor(tok: string): boolean {
  if (!/^(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(tok)) return false;
  if (/[0-9]/.test(tok)) return true;
  return /^(.)\1+$/i.test(tok);
}
const MASK = "\u0000";
/** 網址：到空白、引號、全形標點或已遮罩處為止 */
const URL_SRC = "(?:https?:\\/\\/|www\\.)[^\\s<>\"'）」』、，。；！？\\u0000]+";
function fill(n: number): string {
  return MASK.repeat(n);
}
/** 把不該解析的範圍（圍欄程式碼整段、行內程式碼、網址）換成 \u0000，長度不變——位置可以直接對回原文 */
export function maskText(text: string): string {
  const lines = String(text || "").split("\n");
  let inFence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    let ln = lines[i];
    const fm = /^ {0,3}(`{3,}|~{3,})/.exec(ln);
    if (inFence) {
      lines[i] = fill(ln.length);
      if (fm && fm[1].charAt(0) === inFence.charAt(0) && fm[1].length >= inFence.length) inFence = null;
      continue;
    }
    if (fm) {
      inFence = fm[1];
      lines[i] = fill(ln.length);
      continue;
    }
    ln = ln.replace(/(`+)[^`]*?\1/g, (m) => fill(m.length));
    ln = ln.replace(new RegExp(URL_SRC, "gi"), (m) => fill(m.length));
    lines[i] = ln;
  }
  return lines.join("\n");
}
/** 結束字集（=logic.js:93，不動）：半形標點後的 `#` 仍不算（`a,#b`＝英文語境） */
const TERM = "\\s#\\u0000，。、；：！？「」『』（）【】《》〈〉,;:!?()\\[\\]{}<>\"'`";
const TAG_RE_SRC = "#([^" + TERM + "]+)";
/** `#` 前面可以是什麼（0-19／D-筆-44）：空白或全形標點 */
const PRE_OK_CLASS = "\\s，。、；：！？「」『』（）【】《》〈〉…—";
const PRE_OK = new RegExp("[" + PRE_OK_CLASS + "]");
const CARET_RE = new RegExp("(^|[" + PRE_OK_CLASS + "])#([^" + TERM + "]*)$");

/**
 * 解析內文裡的荷札（=logic.js:100-115）。規則：`#` 前面要是行首、空白或全形標點（0-19）；遇到空白、#、
 * 全形與半形標點即結束；尾巴的 `. / ／ - _ ~ …` 不算進名稱；色碼、純數字（#2026）、網址與程式碼裡的 # 都不算。
 */
export function parseTags(text: string): TagOccurrence[] {
  text = String(text || "");
  const masked = maskText(text);
  const re = new RegExp(TAG_RE_SRC, "g");
  const out: TagOccurrence[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked))) {
    const at = m.index;
    if (at > 0 && !PRE_OK.test(masked.charAt(at - 1))) continue;
    const raw = m[1].replace(/[./／\-_~…]+$/, "");
    if (!raw || isHexColor(raw)) continue;
    const n = normalizeName(raw);
    if (!n.ok) continue;
    out.push({ start: at, end: at + 1 + raw.length, raw, name: n.name, key: n.key });
  }
  return out;
}
/** 內文掛的 keys（去重、照出現順序；=logic.js:116-120） */
export function tagKeysIn(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const o of parseTags(text)) {
    if (!seen.has(o.key)) {
      seen.add(o.key);
      out.push(o.key);
    }
  }
  return out;
}
/** 依序改寫每個荷札：fn(occ) 回取代字串（含 #），回 null＝不動（=logic.js:122-131） */
export function rewriteTags(text: string, fn: (occ: TagOccurrence) => string | null): string {
  text = String(text || "");
  const occ = parseTags(text);
  for (let i = occ.length - 1; i >= 0; i--) {
    const r = fn(occ[i]);
    if (r == null) continue;
    text = text.slice(0, occ[i].start) + r + text.slice(occ[i].end);
  }
  return text;
}
/** 把 raw（內文裡的原字）的前 oldDepth 段換成新名稱，其餘段原樣保留（=logic.js:421-424） */
export function rewriteRaw(raw: string, oldDepth: number, newName: string): string {
  const segs = raw.split(/[/／]/);
  return newName + (segs.length > oldDepth ? "/" + segs.slice(oldDepth).join("/") : "");
}
/** 刪掉荷札字：連帶吃掉一個相鄰空白（優先後面的；在行尾就吃前面的），行尾清尾空白（=logic.js:133-146） */
export function removeTagText(text: string, keySet: KeySet): string {
  text = String(text || "");
  const set = toSet(keySet);
  const occ = parseTags(text);
  for (let i = occ.length - 1; i >= 0; i--) {
    const o = occ[i];
    if (!set.has(o.key)) continue;
    let a = o.start;
    let b = o.end;
    const next = text.charAt(b);
    const prev = a > 0 ? text.charAt(a - 1) : "";
    if (next === " " || next === "\t" || next === "　") b++;
    else if (prev === " " || prev === "\t" || prev === "　") a--;
    text = text.slice(0, a) + text.slice(b);
  }
  return text.replace(/[ \t]+$/gm, "");
}
/**
 * 游標前面是不是正在打荷札（內文打字時的建議清單；=logic.js:148-157，前字類加全形標點 0-19）。
 * 回 `{ start, q }`（start＝# 的位置）或 null；在程式碼或網址裡＝null。
 */
export function tagAtCaret(text: string, caret: number): { start: number; q: string } | null {
  text = String(text || "");
  const m = CARET_RE.exec(text.slice(0, caret));
  if (!m) return null;
  const start = caret - m[2].length - 1;
  if (maskText(text).charAt(start) !== "#") return null;
  return { start, q: m[2] };
}

/* ═══ 三、樹、計數、點父看子（=logic.js:197-277） ═══ */

function byName(a: TagNode, b: TagNode): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * 樹與計數（=logic.js:203-242）。輸入改 `TagIndexSource`：`ents` 由 taggings 依 entityType+entityId 分組；
 * 指到不存在（或已刪除）tag 的 tagging 略過。`entityKinds` 省略＝用 `src.kinds`。
 */
export function buildIndex(src: TagIndexSource, entityKinds?: Record<string, string>): TagIndex {
  const kinds = entityKinds ?? src.kinds;
  const byKey: Record<string, TagNode> = {};
  const tagById = new Map<string, { id: string; name: string; key: string }>();
  for (const t of src.tags) tagById.set(t.id, t);
  function node(key: string, name: string, real: boolean, id: string | null): TagNode {
    let x = byKey[key];
    if (!x) {
      x = byKey[key] = {
        key, name, seg: lastSeg(name), real: false, depth: depthOf(key), parent: parentOf(key),
        children: [], direct: 0, total: 0, id: null,
      };
    }
    if (real) {
      x.real = true;
      x.name = name;
      x.seg = lastSeg(name);
      if (id) x.id = id;
    }
    return x;
  }
  function addPath(key: string, name: string, id: string | null): void {
    node(key, name, true, id);
    let k = key;
    let nm = name;
    let pk = parentOf(k);
    while (pk !== null) {
      const pn = nm.slice(0, pk.length);
      const p = node(pk, pn, false, null);
      if (p.children.indexOf(k) < 0) p.children.push(k);
      k = pk;
      nm = pn;
      pk = parentOf(k);
    }
  }
  for (const t of src.tags) addPath(t.key, t.name, t.id);
  const ents: TagEnt[] = [];
  const entByRef = new Map<string, TagEnt>();
  for (const g of src.taggings) {
    const t = tagById.get(g.tagId);
    if (!t) continue;
    const ref = g.entityType + "\u0001" + g.entityId;
    let e = entByRef.get(ref);
    if (!e) {
      e = { type: g.entityType, id: g.entityId, keys: [] };
      const k = kinds?.[g.entityId];
      if (k) e.kind = k;
      entByRef.set(ref, e);
      ents.push(e);
    }
    if (e.keys.indexOf(t.key) < 0) e.keys.push(t.key);
  }
  for (const e of ents) {
    const hit = new Set<string>();
    for (const k of e.keys) {
      byKey[k].direct++;
      let c: string | null = k;
      while (c !== null) {
        if (!hit.has(c)) {
          hit.add(c);
          byKey[c].total++;
        }
        c = parentOf(c);
      }
    }
  }
  const roots: string[] = [];
  for (const k of Object.keys(byKey)) {
    const x = byKey[k];
    x.children.sort((a, b) => byName(byKey[a], byKey[b]));
    if (x.parent === null) roots.push(k);
  }
  roots.sort((a, b) => byName(byKey[a], byKey[b]));
  return { byKey, roots, ents };
}

/** 樹攤平成列（展開的才往下）；filter 有字時只留名稱含有它的列與它們的祖先、全部展開（=logic.js:244-265） */
export function flattenTree(
  idx: TagIndex,
  openSet: Readonly<Record<string, unknown>> | null,
  filter: string,
): TagTreeRow[] {
  const out: TagTreeRow[] = [];
  const f = filter ? lowerAscii(nfkc(filter).replace(/^#/, "").trim()) : "";
  let keep: Set<string> | null = null;
  if (f) {
    keep = new Set();
    for (const k of Object.keys(idx.byKey)) {
      if (k.indexOf(f) >= 0) {
        let c: string | null = k;
        while (c !== null) {
          keep.add(c);
          c = parentOf(c);
        }
      }
    }
  }
  function walk(keys: string[]): void {
    for (const k of keys) {
      if (keep && !keep.has(k)) continue;
      const x = idx.byKey[k];
      const open = keep ? true : !!(openSet && openSet[k]);
      out.push({ key: k, node: x, open, hasKids: x.children.length > 0 });
      if (open && x.children.length) walk(x.children);
    }
  }
  walk(idx.roots);
  return out;
}

/** 點父看子：掛著 key 或它任何子孫的實體；matched＝它實際掛的那幾個 key（=logic.js:267-275；資料由 repo `listUnder` 給） */
export function itemsUnder(idx: TagIndex, key: string): { type: string; id: string; matched: string[] }[] {
  const out: { type: string; id: string; matched: string[] }[] = [];
  for (const e of idx.ents) {
    const m = e.keys.filter((k) => isUnder(k, key));
    if (m.length) out.push({ type: e.type, id: e.id, matched: m });
  }
  return out;
}
/** 看父層時，子荷札相對於父層的那一段：relName('難度/高', '難度') → '高'（=logic.js:277） */
export function relName(name: string, parentKey: string): string {
  return name.length > parentKey.length ? name.slice(parentKey.length + 1) : "";
}
/** 某實體掛的 keys（側板直接讀 index，不另查；契約 §5.3） */
export function keysOfEntity(idx: TagIndex, type: string, id: string): string[] {
  for (const e of idx.ents) if (e.type === type && e.id === id) return e.keys.slice();
  return [];
}

/* ═══ 四、建議清單（=logic.js:287-350） ═══ */

/**
 * 排序：整個名稱相同(0) > 某一段完全相同(1) > 某一段的開頭(2) > 中間含有(3)；同級依掛著的數量多到少、再依層數淺到深。
 * q 以 `/` 結尾＝瀏覽那一層底下（像打開資料夾）；q 含 `/`＝從頭比對全路徑。預設 limit 8、不列虛資料夾。
 */
export function suggest(idx: TagIndex, q: string, opts: SuggestOptions = {}): TagSuggestResult {
  const limit = opts.limit || 8;
  const ex = toSet(opts.exclude);
  const raw = nfkc(q || "").replace(/^\s+|\s+$/g, "").replace(/^#/, "");
  const qq = lowerAscii(raw.split("/").map((s) => s.replace(/^\s+|\s+$/g, "")).join("/"));
  const cands = Object.keys(idx.byKey).map((k) => idx.byKey[k]).filter((x) => (x.real || opts.includeVirtual) && !ex.has(x.key));
  const cnt = (x: TagNode) => (x.real ? x.direct : x.total);
  const sortFn = (a: TagSuggestItem, b: TagSuggestItem) =>
    a.tier - b.tier || b.count - a.count || depthOf(a.key) - depthOf(b.key) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  let items: TagSuggestItem[] = [];
  if (!qq) {
    items = cands.map((x) => ({ key: x.key, name: x.name, count: cnt(x), tier: 0, real: x.real, hl: null }));
    items.sort(sortFn);
    return { items: items.slice(0, limit), create: null, hint: null, browse: null };
  }
  if (qq.charAt(qq.length - 1) === "/") {
    const pk = qq.replace(/\/+$/, "");
    items = cands
      .filter((x) => x.key.indexOf(pk + "/") === 0)
      .map((x) => ({ key: x.key, name: x.name, count: cnt(x), tier: depthOf(x.key) - depthOf(pk), real: x.real, hl: [0, pk.length] as [number, number] }));
    items.sort(sortFn);
    return {
      items: items.slice(0, limit),
      create: null,
      hint: items.length ? null : "「" + raw.replace(/\/+$/, "") + "」底下還沒有子荷札",
      browse: pk,
    };
  }
  for (const x of cands) {
    const k = x.key;
    let tier = -1;
    let hl: [number, number] | null = null;
    if (k === qq) {
      tier = 0;
      hl = [0, k.length];
    } else if (qq.indexOf("/") >= 0) {
      if (k.indexOf(qq) === 0) {
        tier = 2;
        hl = [0, qq.length];
      } else if (k.indexOf(qq) > 0) {
        tier = 3;
        hl = [k.indexOf(qq), k.indexOf(qq) + qq.length];
      }
    } else {
      const segs = segsOf(k);
      let off = 0;
      for (const seg of segs) {
        if (seg === qq && (tier < 0 || tier > 1)) {
          tier = 1;
          hl = [off, off + seg.length];
        } else if (seg.indexOf(qq) === 0 && (tier < 0 || tier > 2)) {
          tier = 2;
          hl = [off, off + qq.length];
        }
        off += seg.length + 1;
      }
      if (tier < 0 && k.indexOf(qq) >= 0) {
        tier = 3;
        hl = [k.indexOf(qq), k.indexOf(qq) + qq.length];
      }
    }
    if (tier >= 0) items.push({ key: k, name: x.name, count: cnt(x), tier, real: x.real, hl });
  }
  items.sort(sortFn);
  items = items.slice(0, limit);
  const n = normalizeName(raw);
  let create: { name: string; key: string } | null = null;
  let hint: string | null = null;
  if (n.ok) {
    const exists = idx.byKey[n.key] && idx.byKey[n.key].real;
    if (!exists && !ex.has(n.key)) create = { name: n.name, key: n.key };
  } else hint = n.reason;
  return { items, create, hint, browse: null };
}
/** Tab：補完到被選中那一列「對到的那一段」為止，後面還有層就帶一個 /（像檔名補完；=logic.js:340-350） */
export function completeTab(item: TagSuggestItem, browse: string | null): string {
  const segs = item.name.split("/");
  let k = 1;
  if (browse) k = depthOf(browse) + 1;
  else {
    const from = item.hl ? item.hl[0] : 0;
    let off = 0;
    for (let i = 0; i < segs.length; i++) {
      if (from < off + segs[i].length + 1) {
        k = i + 1;
        break;
      }
      off += segs[i].length + 1;
    }
  }
  if (k >= segs.length) return item.name;
  return segs.slice(0, k).join("/") + "/";
}
/** 「最近用過」推一個到最前（純函式版，最多 6；=logic.js:353-355） */
export function pushRecentKeys(list: readonly string[], key: string): string[] {
  return [key].concat(list.filter((k) => k !== key)).slice(0, RECENT_MAX);
}

/* ═══ 五、改名＝搬家、併入（=logic.js:380-419） ═══ */

const COUNT_BUCKETS = ["ticket", "train", "car", "note", "diary"];
function defaultKind(e: TagEnt): string {
  if (e.kind) return e.kind;
  if (e.type === "note") return "note";
  if (e.type === "node") return "ticket";
  return "other";
}
/** 被影響的實體依種類計數（=logic.js:381-389）；kind 由 `kindOf` 給，省略＝用 index 裡的 kinds */
export function affectedCounts(idx: TagIndex, keySet: KeySet, kindOf?: KindOf): AffectedCounts {
  const set = toSet(keySet);
  const c: AffectedCounts = { ticket: 0, train: 0, car: 0, note: 0, diary: 0, other: 0, total: 0 };
  for (const e of idx.ents) {
    if (!e.keys.some((k) => set.has(k))) continue;
    c.total++;
    const kind = kindOf ? kindOf(e.type, e.id) : defaultKind(e);
    if (COUNT_BUCKETS.indexOf(kind) >= 0) c[kind as "ticket"]++;
    else c.other++;
  }
  return c;
}
function nameOfKey(idx: TagIndex, key: string): string {
  return idx.byKey[key] ? idx.byKey[key].name : key;
}

/**
 * 改名（也用來併入；=logic.js:396-419）。newRaw 可以帶 `/`（搬層級）。含「不能搬進自己底下」、
 * 虛資料夾改成既有名稱不算併入（rootConflict 只在自己是真荷札時成立）、子孫撞名進 `conflicts`。
 */
export function planRename(idx: TagIndex, oldKey: string, newRaw: string, kindOf?: KindOf): RenamePlan {
  const old = idx.byKey[oldKey];
  if (!old) return { ok: false, reason: "找不到這個荷札" };
  const n = normalizeName(newRaw);
  if (!n.ok) return { ok: false, reason: n.reason };
  if (n.key === oldKey) {
    return {
      ok: true, same: true, oldKey, oldName: old.name, newKey: n.key, newName: n.name, nameOnly: n.name !== old.name,
      moves: [], conflicts: [], rootConflict: null, affected: affectedCounts(idx, [], kindOf), childCount: 0, ownCount: old.total,
    };
  }
  if (n.key.indexOf(oldKey + "/") === 0) return { ok: false, reason: "不能搬進自己底下" };
  const keys = Object.keys(idx.byKey).filter((k) => isUnder(k, oldKey) && idx.byKey[k].real);
  const moves = keys.map((k) => ({
    from: k,
    to: n.key + k.slice(oldKey.length),
    toName: n.name + nameOfKey(idx, k).slice(oldKey.length),
  }));
  const conflicts = moves.filter((m) => idx.byKey[m.to] && idx.byKey[m.to].real).map((m) => m.to);
  const tgt = idx.byKey[n.key];
  const rootConflict = tgt && tgt.real && old.real ? { key: n.key, name: tgt.name, count: tgt.total } : null;
  const childCount = keys.filter((k) => k !== oldKey).length;
  return {
    ok: true, same: false, oldKey, oldName: old.name, newKey: n.key, newName: n.name,
    moves, conflicts, rootConflict, affected: affectedCounts(idx, keys, kindOf), childCount, ownCount: old.total,
  };
}

/**
 * 改名計畫套到一則內文（=logic.js:436-441 的內文那段）：被搬的 key 換成新名稱、原寫法的子段保留。
 * repository 的 `rename` 逐則呼叫它（同一語意只定義一次）；沒變＝回原字串。
 */
export function renameBody(body: string, plan: RenamePlan): string {
  if (!plan.ok || plan.same) return body;
  const map = new Map(plan.moves.map((m) => [m.from, m]));
  const oldDepth = depthOf(plan.oldKey);
  return rewriteTags(body, (o) => (map.has(o.key) ? "#" + rewriteRaw(o.raw, oldDepth, plan.newName) : null));
}

/* ═══ 六、刪除（=logic.js:460-469） ═══ */

/** 刪除計畫套到一則內文：整段字一起刪（D-筆-39；=logic.js:478 的 remove 分支）。repository 的 `remove` 逐則呼叫它 */
export function deleteBody(body: string, plan: DeletePlan): string {
  return plan.ok ? removeTagText(body, plan.keys) : body;
}

/** 刪除的計畫：keys＝自己＋全部子孫；places＝摘下幾處；kidsWithItems＝底下有東西的子荷札數；bodyCount＝要改內文的筆記＋日記 */
export function planDelete(idx: TagIndex, key: string, kindOf?: KindOf): DeletePlan {
  const x = idx.byKey[key];
  if (!x) return { ok: false, reason: "找不到這個荷札" };
  const keys = Object.keys(idx.byKey).filter((k) => isUnder(k, key));
  const aff = affectedCounts(idx, keys, kindOf);
  const kids = keys.filter((k) => k !== key && idx.byKey[k].real && idx.byKey[k].direct > 0).length;
  const childCount = keys.filter((k) => k !== key && idx.byKey[k].real).length;
  return { ok: true, key, name: x.name, keys, places: aff.total, affected: aff, kidsWithItems: kids, bodyCount: aff.note + aff.diary, childCount };
}

/* ═══ 七、文案（=logic.js:488-499；app.js:627-645；契約 §5.8／§5.9） ═══ */

/** 改名預覽那一行：「會改動 3 張車票、1 班列車、2 則筆記的內文、1 篇日記；#難度/高 底下的 2 個子荷札一起搬」 */
export function renameImpact(plan: RenamePlan): string {
  if (!plan.ok || plan.same) return "";
  const a = plan.affected;
  const parts: string[] = [];
  if (a.ticket) parts.push(a.ticket + " 張車票");
  if (a.train) parts.push(a.train + " 班列車");
  if (a.car) parts.push(a.car + " 節車廂");
  if (a.note) parts.push(a.note + " 則筆記的內文");
  if (a.diary) parts.push(a.diary + " 篇日記");
  if (a.other) parts.push(a.other + " 處別處");
  let s = parts.length ? "會改動 " + parts.join("、") : "沒有東西掛著，只改名稱";
  if (plan.childCount) s += "；#" + plan.oldName + " 底下的 " + plan.childCount + " 個子荷札一起搬";
  return s;
}

const EX_LEAD = 14;
const EX_LEN = 40;
function clipAt(s: string, from: number): string {
  const f = Math.max(0, Math.min(from, s.length));
  return (f > 0 ? "…" : "") + s.slice(f, f + EX_LEN) + (s.length > f + EX_LEN ? "…" : "");
}
/**
 * 刪除確認框的例子（0-21）：從內文挑第一個命中 `plan.keys` 的 occurrence（父層刪除時通常是子荷札），
 * 回原字、那一行、`removeTagText` 後那一行（各截約 40 字，從荷札前 14 字起）。沒有命中＝null。
 */
export function deleteExample(bodies: readonly string[], plan: DeletePlan): { raw: string; before: string; after: string } | null {
  if (!plan.ok) return null;
  const set = new Set(plan.keys);
  for (const body of bodies) {
    const text = String(body || "");
    const occs = parseTags(text).filter((o) => set.has(o.key));
    if (!occs.length) continue;
    const o = occs[0];
    const ls = text.lastIndexOf("\n", o.start - 1) + 1;
    const leRaw = text.indexOf("\n", o.end);
    const le = leRaw < 0 ? text.length : leRaw;
    const line = text.slice(ls, le);
    const after = removeTagText(line, set);
    const from = Math.max(0, o.start - ls - EX_LEAD);
    return { raw: o.raw, before: clipAt(line, from), after: clipAt(after, from) };
  }
  return null;
}
/**
 * 刪除確認框全文（§5.9-3；2026-10-13 文案修訂：標題與內文都帶被刪荷札的名字——手機確認 sheet 會蓋住頁頭大牌，
 * 只寫子荷札的例子時主人看不到自己正在刪哪一個）；`ex` 由 `deleteExample` 給
 */
export function deleteConfirmText(
  plan: DeletePlan,
  ex: { raw: string; before: string; after: string } | null,
): { title: string; body: string } {
  if (!plan.ok) return { title: "", body: plan.reason };
  const title = plan.kidsWithItems ? `刪除 #${plan.name}，連同底下 ${plan.kidsWithItems} 個子荷札？` : `刪除 #${plan.name}？`;
  const exRaw = ex ? ex.raw : plan.name;
  const isSelf = keyOf(exRaw) === plan.key;
  let body = isSelf
    ? `摘下 ${plan.places} 處。筆記與日記內文裡的 #${exRaw}${plan.kidsWithItems ? "（含子荷札）" : ""} 會一起刪掉。`
    : `摘下 ${plan.places} 處。#${plan.name} 和它的子荷札（例：#${exRaw}）會從筆記與日記內文裡一起刪掉。`;
  if (ex) body += `例：『${ex.before}』→『${ex.after}』。`;
  body += plan.bodyCount ? `會改動 ${plan.bodyCount} 則筆記或日記的內文。` : "目前沒有筆記或日記寫到它。";
  return { title, body };
}
/** 併入確認框全文（§5.9-1／2；=app.js:627-637）：rootConflict＝併入既有名稱；否則＝子孫撞名 */
export function mergeConfirmText(plan: RenamePlan): { title: string; body: string } {
  if (!plan.ok) return { title: "", body: plan.reason };
  const impact = renameImpact(plan);
  if (plan.rootConflict) {
    const t = plan.rootConflict;
    return {
      title: `併入 #${t.name}？`,
      body: `#${t.name} 已經存在（掛著 ${t.count} 處）。要把 #${plan.oldName} 的 ${plan.ownCount} 處併進去嗎？${impact}。`,
    };
  }
  const c = plan.conflicts[0];
  const cName = plan.moves.find((m) => m.to === c)?.toName ?? c;
  return {
    title: "連子荷札一起併入？",
    body: `#${plan.oldName} 底下有 ${plan.conflicts.length} 個子荷札和既有的同名（例：#${cName}），改名後會併在一起。${impact}。`,
  };
}
/** 通車提示條（D-筆-43；=app.js:251） */
export function backfillNotice(tags: number, places: number): string {
  return `以前筆記與日記裡打的 #荷札 已經補掛上了：找到 ${tags} 個荷札、${places} 處。`;
}
/** toast 25（手機點選器完成）：沒有變動回 null */
export function setTagsToast(addedNames: readonly string[], removedNames: readonly string[], createdCount: number): string | null {
  const parts: string[] = [];
  if (addedNames.length) parts.push("掛上 " + addedNames.map((n) => "#" + n).join("、"));
  if (removedNames.length) parts.push("摘下 " + removedNames.map((n) => "#" + n).join("、"));
  if (!parts.length) return null;
  return parts.join("；") + (createdCount ? `（新建 ${createdCount} 個）` : "");
}

/* ═══ 八、摘要與行內切段（=logic.js:506-551） ═══ */

/** 清單裡的一小段摘要：第一個命中的荷札前後各 radius 字（=logic.js:506-518） */
export function snippetAround(text: string, keySet: KeySet, radius = 16): { pre: string; tag: string; post: string } {
  text = String(text || "");
  const set = toSet(keySet);
  const occ = parseTags(text).filter((o) => set.has(o.key))[0];
  const flat = (s: string) => s.replace(/\s+/g, " ");
  if (!occ) return { pre: flat(text.slice(0, radius * 2)), tag: "", post: "" };
  const a = Math.max(0, occ.start - radius);
  const b = Math.min(text.length, occ.end + radius);
  return {
    pre: (a > 0 ? "…" : "") + flat(text.slice(a, occ.start)).replace(/^\s+|\s+$/g, ""),
    tag: text.slice(occ.start, occ.end),
    post: flat(text.slice(occ.end, b)).replace(/^\s+|\s+$/g, "") + (b < text.length ? "…" : ""),
  };
}
/**
 * 一行字切成 text／tag／code／url 段（=logic.js:527-551 的切段；不產 HTML、不處理 `**粗體**`——④）。
 * code 段的 text＝含反引號的原字、url 段＝網址本身（尾巴標點不算）；③ 都畫成純文字（0-22）。
 */
export function inlineSegments(line: string): InlineSegment[] {
  line = String(line || "");
  const spans: { a: number; b: number; seg: InlineSegment }[] = [];
  for (const o of parseTags(line)) spans.push({ a: o.start, b: o.end, seg: { kind: "tag", occ: o } });
  let m: RegExpExecArray | null;
  let re = /(`+)([^`]*?)\1/g;
  while ((m = re.exec(line))) spans.push({ a: m.index, b: m.index + m[0].length, seg: { kind: "code", text: m[0] } });
  re = new RegExp(URL_SRC, "gi");
  const masked = line.replace(/(`+)[^`]*?\1/g, (x) => fill(x.length));
  while ((m = re.exec(masked))) {
    const u = m[0].replace(/[.,;:!?)]+$/, "");
    spans.push({ a: m.index, b: m.index + u.length, seg: { kind: "url", text: u } });
  }
  spans.sort((x, y) => x.a - y.a);
  const out: InlineSegment[] = [];
  let pos = 0;
  for (const s of spans) {
    if (s.a < pos) continue;
    if (s.a > pos) out.push({ kind: "text", text: line.slice(pos, s.a) });
    out.push(s.seg);
    pos = s.b;
  }
  if (pos < line.length) out.push({ kind: "text", text: line.slice(pos) });
  return out;
}
/**
 * `plainParagraphs` 的段落各行切段，並認得圍欄程式碼（圍欄裡的行整行是 text，不出小牌——與 `parseTags` 的遮罩一致）。
 * 回傳形狀與 `plainParagraphs(body)` 對齊：段 → 行 → 段落片段。
 */
export function inlineParagraphs(paras: readonly (readonly string[])[]): InlineSegment[][][] {
  let inFence: string | null = null;
  return paras.map((para) =>
    para.map((line) => {
      const fm = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (inFence) {
        if (fm && fm[1].charAt(0) === inFence.charAt(0) && fm[1].length >= inFence.length) inFence = null;
        return [{ kind: "text", text: line }] as InlineSegment[];
      }
      if (fm) {
        inFence = fm[1];
        return [{ kind: "text", text: line }] as InlineSegment[];
      }
      return inlineSegments(line);
    }),
  );
}
/** 牌子顯示「難度 / 高」用：父層各段＋末段 */
export function tagDisplayParts(name: string): { parents: string[]; last: string } {
  const segs = String(name || "").split(/[/／]/);
  return { parents: segs.slice(0, -1), last: segs[segs.length - 1] ?? "" };
}

/* ═══ 九、清單分組（0-20） ═══ */

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
/**
 * 荷札頁清單分組與排序（0-20）：車票・列車車廂（未完成在前：scheduled_on 升冪、NULL 在後、再名稱；
 * 已完成＝`status==='done'` 收到 done）／筆記（noted_at 降冪）／日記（entry_date 降冪）／別線。
 * `parentKey` 給時，各列附 `rel`＝它實際掛的子荷札相對名（`nameOf` 給顯示名，省略用 key）。
 */
export function groupTaggedItems(
  items: readonly TaggedItem[],
  parentKey: string | null,
  nameOf?: (key: string) => string,
): TaggedGroups {
  const g: TaggedGroups = { nodes: { open: [], done: [] }, notes: [], diaries: [], other: [] };
  for (const it of items) {
    let rel: string | null = null;
    if (parentKey) {
      const kids = it.matched.filter((k) => k !== parentKey && isUnder(k, parentKey));
      if (kids.length) rel = kids.map((k) => relName(nameOf ? nameOf(k) : k, parentKey)).join("、");
    }
    const row = { ...it, rel } as GroupedTaggedItem;
    if (it.kind === "node") (it.node.status === "done" ? g.nodes.done : g.nodes.open).push(row);
    else if (it.kind === "note") (it.note.kind === "diary" ? g.diaries : g.notes).push(row);
    else g.other.push(row);
  }
  const nodeCmp = (a: GroupedTaggedItem, b: GroupedTaggedItem) => {
    if (a.kind !== "node" || b.kind !== "node") return 0;
    const da = a.node.scheduled_on;
    const db = b.node.scheduled_on;
    if (da !== db) {
      if (da == null) return 1;
      if (db == null) return -1;
      return cmpStr(da, db);
    }
    return cmpStr(a.node.name, b.node.name);
  };
  g.nodes.open.sort(nodeCmp);
  g.nodes.done.sort(nodeCmp);
  g.notes.sort((a, b) => (a.kind === "note" && b.kind === "note" ? cmpStr(b.note.noted_at, a.note.noted_at) : 0));
  g.diaries.sort((a, b) =>
    a.kind === "note" && b.kind === "note"
      ? cmpStr(b.note.entry_date ?? "", a.note.entry_date ?? "") || cmpStr(b.note.noted_at, a.note.noted_at)
      : 0,
  );
  return g;
}
