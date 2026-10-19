/**
 * syncMerge——同步頁「最近兩台撞到的」清單與提示的純函式（主線車次③；契約 `docs/research/2026-10-18-主線-車次③同步復活提示-契約.md` §3.4／§4.9）。
 *
 * 拍板：D-主-16（同步頁一區清單＋白話提示附「看看」）、D-主-17（兩台都提示、文案分方向）、
 *       D-主-18（「刪了又回來」與「兩邊都改了」兩類分開標示、復活排前）、D-主-19（知道了＝整張清光）、
 *       D-主-20（兩邊都改了的列印兩邊的值、各截 24 字）。
 *
 * 純函式檔：**唯一的 import 是 `import type`**，相對路徑一律帶 `.ts`（`node --test` 直載；契約 §1 規則 10）。
 * 不 import `node.ts`：`KIND_LABEL`／`CONFLICT_COL_LABEL` 只在 `store/syncMergeLabels.ts` 用（§0-1 第 16 條）。
 *
 * 文案紀律（總表核可條件）：通用、不點名任何一線——名詞只來自 `TBL_NOUN`，線要講自己的話就填 `syncRowLabel` 插槽。
 * `by_me === false`（本機那一格是第三台寫的）時句子一律不指認「這台」（§0-1 第 20 條）。
 */
import type { MergeKind, MergeNotice } from "../data/syncRepository.ts";

/** 表 → 名詞與量詞（泛稱；三線沒填插槽時用）。不認得的表 ⇒ { noun: "一筆資料", unit: "筆" } */
export const TBL_NOUN: Readonly<Record<string, { noun: string; unit: string }>> = {
  nodes: { noun: "車票", unit: "張" }, // 列上實際印 KIND_LABEL[kind]（syncMergeLabels 拿到列才知道 kind）
  work_logs: { noun: "乘務記錄", unit: "筆" },
  occurrences: { noun: "班次", unit: "班" },
  notes: { noun: "筆記", unit: "則" },
  settings: { noun: "設定", unit: "項" }, // 核心 settings 表（day_start_hour）；Rust 對每張表都記通知，KeyValue 也算
  tags: { noun: "荷札", unit: "枚" },
  taggings: { noun: "荷札掛載", unit: "筆" },
  time_categories: { noun: "時間分類", unit: "個" },
  time_blocks: { noun: "一段時間", unit: "段" },
  time_goals: { noun: "時數目標", unit: "個" },
  tk_currencies: { noun: "幣別", unit: "個" },
  tk_accounts: { noun: "帳戶", unit: "個" },
  tk_categories: { noun: "帳目分類", unit: "個" },
  tk_entries: { noun: "一筆帳", unit: "筆" },
};

const UNKNOWN_NOUN = { noun: "一筆資料", unit: "筆" } as const;

function nounEntry(tbl: string): { noun: string; unit: string } {
  return Object.prototype.hasOwnProperty.call(TBL_NOUN, tbl) ? TBL_NOUN[tbl] : UNKNOWN_NOUN;
}

/** 單數名詞（泛稱與「（現在找不到了）」用）：「筆記」「一段時間」「一筆帳」「一筆資料」 */
export function nounOf(tbl: string): string {
  return nounEntry(tbl).noun;
}

/**
 * 帶數量的名詞：「3 則筆記」「2 段時間」「2 筆帳」「1 張車票」「1 筆資料」。
 * 名詞本身以「一＋量詞」開頭的（一段時間、一筆帳、一筆資料）先剝掉那兩個字，免得印成「2 段一段時間」。
 */
export function countNoun(tbl: string, n: number): string {
  const { noun, unit } = nounEntry(tbl);
  const base = noun.startsWith(`一${unit}`) ? noun.slice(1 + unit.length) : noun;
  return `${n} ${unit}${base}`;
}

/** 依字元（code point）截斷，不切壞代理對；超過補「…」 */
function clip(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : s;
}

/**
 * 清單列名字的截斷：名字長得像「車票『牙醫』」（前綴＋『名』）時只截『』裡面那段，括號留著；
 * 其餘整段截。toast 用 12 字（#59 兩行上限，§0-1 第 14 條）。
 */
export function clipLabel(label: string, max: number): string {
  const m = /^([^『]*)『(.*)』([^』]*)$/u.exec(label);
  if (m) return `${m[1]}『${clip(m[2], max)}』${m[3]}`;
  return clip(label, max);
}

/** 清單列的泛稱：`${nounOf(tbl)}（${row_id 最後 4 字}）`，例「筆記（a1b2）」 */
export function fallbackLabel(n: MergeNotice): string {
  const tail = Array.from(n.row_id ?? "").slice(-4).join("");
  return `${nounOf(n.tbl)}（${tail}）`;
}

/** 值 → 短字：null／undefined／空白 ⇒ 「（空）」；字串截 `max` 字補「…」；非字串 JSON.stringify 再截 */
export function fmtMergeValue(v: unknown, max = 24): string {
  if (v === null || v === undefined) return "（空）";
  let s: string;
  if (typeof v === "string") s = v;
  else {
    try {
      s = JSON.stringify(v) ?? "";
    } catch {
      s = String(v);
    }
  }
  if (!s.trim()) return "（空）";
  return clip(s, max);
}

/**
 * 一列的方向句（label 已由呼叫端解好；D-主-17 分方向、D-主-20 印兩邊的值）：
 *   revived     ⇒ by_me：「你在這台刪過，另一台改過——回來了」；!by_me：「一台刪過、另一台改過——回來了」
 *   kept        ⇒ by_me：「另一台刪過，但這台改過——留著」；!by_me：「一台刪過、另一台改過——留著改過的」
 *   overwritten ⇒ !by_me：「一台改成「{mine}」、另一台改成「{theirs}」——留下後改的」
 *                  winner==="mine"：「另一台改成「{theirs}」、這台改成「{mine}」——留下這台後改的」（③ʹ 恆 by_me）
 *                  winner==="theirs"：「這台改成「{mine}」、另一台改成「{theirs}」——留下另一台後改的」
 *   （先看 by_me：萬一有 winner=mine 卻不是這台寫的那一格，也不說「這台改成」——§0-1 第 20 條的精神）
 * `fmt`（選填，來自 `SyncRowLabel.fmt`）：overwritten 的兩邊值先問它，回 null 就退回 `fmtMergeValue`。
 */
export function describeMerge(n: MergeNotice, fmt?: (col: string, v: unknown) => string | null): string {
  if (n.kind === "revived") return n.by_me ? "你在這台刪過，另一台改過——回來了" : "一台刪過、另一台改過——回來了";
  if (n.kind === "kept") return n.by_me ? "另一台刪過，但這台改過——留著" : "一台刪過、另一台改過——留著改過的";
  // 線可以給 `fmt` 把值印成人話（接縫 #77）；回 null、丟錯或沒給 ⇒ 退回 fmtMergeValue（不給 fmt 時輸出逐字不變）
  const show = (v: unknown): string => {
    if (fmt) {
      try {
        const s = fmt(n.col ?? "", v);
        if (s !== null && s !== undefined) return s;
      } catch {
        /* 退回 fmtMergeValue */
      }
    }
    return fmtMergeValue(v);
  };
  const mine = show(n.mine);
  const theirs = show(n.theirs);
  if (!n.by_me) return `一台改成「${mine}」、另一台改成「${theirs}」——留下後改的`;
  if (n.winner === "mine") return `另一台改成「${theirs}」、這台改成「${mine}」——留下這台後改的`;
  return `這台改成「${mine}」、另一台改成「${theirs}」——留下另一台後改的`;
}

/** 欄名：cols?.[col] ?? col（**不**退回 CONFLICT_COL_LABEL——它是 nodes 專用，§0-1 第 16 條） */
function colLabelOf(n: MergeNotice, cols?: Readonly<Record<string, string>>): string {
  const col = n.col ?? "";
  return (cols && Object.prototype.hasOwnProperty.call(cols, col) ? cols[col] : undefined) ?? col;
}

/** 「兩邊都改了」那一類的主詞：`${label} 的 ${colLabel}`；沒有 col（revived／kept）就只回 label */
export function mergeSubject(label: string, n: MergeNotice, cols?: Readonly<Record<string, string>>): string {
  if (!n.col) return label;
  return `${label} 的 ${colLabelOf(n, cols)}`;
}

const KIND_RANK: Readonly<Record<MergeKind, number>> = { revived: 0, kept: 1, overwritten: 2 };

function isKnownKind(k: unknown): k is MergeKind {
  return typeof k === "string" && Object.prototype.hasOwnProperty.call(KIND_RANK, k);
}

/** 由新到舊：先比 `at`，同 `at` 比 hlc（都是可直接比字串的格式） */
function newerFirst(a: MergeNotice, b: MergeNotice): number {
  if (a.at !== b.at) return a.at < b.at ? 1 : -1;
  if (a.hlc !== b.hlc) return a.hlc < b.hlc ? 1 : -1;
  return 0;
}

/**
 * 分組＋排序（D-主-18）：第一組＝revived＋kept（revived 在前、kept 在後）、第二組＝overwritten；
 * 組內依 `at` 由新到舊、同 `at` 依 hlc 由新到舊；kind 不認得的丟掉（壞資料不 throw）。
 */
export function groupMerges(list: readonly MergeNotice[]): { revived: MergeNotice[]; overwritten: MergeNotice[] } {
  const ok = (list ?? []).filter((n) => n && isKnownKind(n.kind));
  const revived = ok
    .filter((n) => n.kind !== "overwritten")
    .sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || newerFirst(a, b));
  const overwritten = ok.filter((n) => n.kind === "overwritten").sort(newerFirst);
  return { revived, overwritten };
}

/** 「新批」：`at > sinceKey` 的那些（sinceKey 為 null ⇒ 整張）。toast 只講新批（§0-1 第 5 條） */
export function mergeFreshSince(list: readonly MergeNotice[], sinceKey: string | null): MergeNotice[] {
  if (sinceKey === null) return [...list];
  return list.filter((n) => n.at > sinceKey);
}

/** toast 去重鍵：清單最新一筆的 `at`（Rust 端新在前；這裡取最大值，順序亂了也對）；空清單 ⇒ null */
export function mergeToastKey(list: readonly MergeNotice[]): string | null {
  let key: string | null = null;
  for (const n of list) if (n && typeof n.at === "string" && (key === null || n.at > key)) key = n.at;
  return key;
}

/** toast 裡的名字：已經自帶『』（「車票『牙醫』」）就不再包一層 */
function quoted(label: string): string {
  return label.includes("『") ? label : `『${label}』`;
}

/** 一筆通知講的是哪一樣東西（表＋列）。toast 的數量一律數這個，不數通知筆數（接縫 #82：一塊兩欄被蓋＝兩筆通知、一樣東西） */
export function mergeObjectKey(n: Pick<MergeNotice, "tbl" | "row_id">): string {
  return `${n.tbl}\u0000${n.row_id}`;
}

/** 按物件分組，保留第一次出現的順序 */
function byObject(list: readonly MergeNotice[]): MergeNotice[][] {
  const groups = new Map<string, MergeNotice[]>();
  for (const n of list) {
    const k = mergeObjectKey(n);
    const g = groups.get(k);
    if (g) g.push(n);
    else groups.set(k, [n]);
  }
  return [...groups.values()];
}

/**
 * toast 全文（§4.9；`fresh` 是新批、不是整張清單）。
 *   `singleLabel`：fresh 只講一樣東西時由呼叫端解好的名字（已截 12 字）；解不到（泛稱／找不到）⇒ null，句子改用「1 則筆記」。
 *   `cols`：只講一樣東西且是 overwritten 時的欄名表（插槽給的、或核心的 CONFLICT_COL_LABEL）；沒給就印欄名原文。
 *   `gone`：revived／kept 的那樣東西**現在**已經不在了（`mergeObjectKey` 的集合；主線④ #81——例：時刻表的整理在同一趟
 *     又把復活的那塊刪掉）。在集合裡的不再說「回來了／留著」，改說「現在已經不在了」；不給＝都當作還在（原行為）。
 *   數量一律是「幾樣東西」（#82）：一樣東西 ⇒ 依 kind、方向、by_me（同一樣東西被蓋好幾欄 ⇒ 一句列欄名）；
 *   多樣同一類同一表 ⇒ countNoun；其餘 ⇒ 「同步時有 N 處兩台撞到——看看是哪些」（N＝樣數）。
 */
export function mergeToastText(
  fresh: readonly MergeNotice[],
  singleLabel: string | null,
  cols?: Readonly<Record<string, string>>,
  gone?: ReadonlySet<string>,
): string {
  const list = fresh.filter((n) => n && isKnownKind(n.kind));
  if (list.length === 0) return "";
  const objects = byObject(list);
  const isGone = (n: MergeNotice): boolean => n.kind !== "overwritten" && !!gone?.has(mergeObjectKey(n));
  if (objects.length === 1 && list.length > 1) {
    // 同一樣東西好幾筆（#82）：全是 overwritten ⇒ 一句列出被蓋的欄；全是同一種刪改 ⇒ 當一筆講（有一筆是第三台的就不指認「這台」）
    const n = list[0];
    if (list.every((x) => x.kind === "overwritten")) return manyColsText(list, singleLabel, cols);
    if (list.every((x) => x.kind === n.kind)) {
      const by_me = list.every((x) => x.by_me);
      return mergeToastText([{ ...n, by_me }], singleLabel, cols, gone);
    }
    return `同步時有 1 處兩台撞到——看看是哪些`;
  }
  if (list.length === 1) {
    const n = list[0];
    const one = countNoun(n.tbl, 1);
    if (isGone(n)) {
      // 刪改相撞、後來又不在了：不分方向（「回來了」「留著」都會是反話），只講結果
      return singleLabel ? `${quoted(singleLabel)}一台刪過、另一台改過，現在已經不在了` : `有 ${one}一台刪過、另一台改過，現在已經不在了`;
    }
    if (n.kind === "revived") {
      if (n.by_me) return singleLabel ? `你刪掉的${quoted(singleLabel)}因為另一台改過，回來了` : `你刪掉的 ${one}因為另一台改過，回來了`;
      return singleLabel ? `${quoted(singleLabel)}因為另一台改過，回來了` : `有 ${one}因為另一台改過，回來了`;
    }
    if (n.kind === "kept") {
      if (n.by_me) return singleLabel ? `另一台刪過${quoted(singleLabel)}，但這台改過——留著` : `另一台刪過 ${one}，但這台改過——留著`;
      return singleLabel ? `${quoted(singleLabel)}一台刪過、另一台改過——留著` : `有 ${one}一台刪過、另一台改過——留著`;
    }
    const who = !n.by_me ? "" : n.winner === "mine" ? "這台" : "另一台";
    if (singleLabel) return `${quoted(singleLabel)}的${colLabelOf(n, cols)}兩台都改過，留下${who}後改的`;
    return `有 ${one}兩台改到同一格，留下${who}後改的`;
  }
  const first = list[0];
  const sameKindTbl = list.every((n) => n.kind === first.kind && n.tbl === first.tbl);
  if (sameKindTbl) {
    const many = countNoun(first.tbl, objects.length);
    if (first.kind === "overwritten") return `有 ${many}兩台改到同一格，留下後改的`;
    // 全都又不在了 ⇒ 結果句；有的在有的不在 ⇒ 混合句（一句話講不完兩種結果）
    const goneCount = list.filter(isGone).length;
    if (goneCount === list.length) return `有 ${many}一台刪過、另一台改過，現在已經不在了`;
    // revived／kept 的 N 筆句會說「你刪掉的」「這台改過」——有一筆是第三台的就不能這樣講，退回混合句
    if (goneCount === 0 && list.every((n) => n.by_me)) {
      return first.kind === "revived" ? `你刪掉的 ${many}因為另一台改過，回來了` : `另一台刪過 ${many}，但這台改過——留著`;
    }
  }
  return `同步時有 ${objects.length} 處兩台撞到——看看是哪些`;
}

/** toast 兩行上限（#59；單筆句的 12 字名＋欄名就是照這個量的） */
const TOAST_MAX_CHARS = 40;

/**
 * 同一樣東西被蓋了好幾欄（#82）：「『X』的分類、結束時刻兩台都改過，留下另一台後改的」。
 * 欄超過兩個就只說幾個地方（toast 兩行上限）。各欄留下的不是同一台、或有一欄是第三台的 ⇒ 不指認「這台／另一台」。
 */
function manyColsText(list: readonly MergeNotice[], label: string | null, cols?: Readonly<Record<string, string>>): string {
  const n = list[0];
  const sameWinner = list.every((x) => x.by_me && x.winner === n.winner);
  const who = !sameWinner ? "" : n.winner === "mine" ? "這台" : "另一台";
  const names = [...new Set(list.map((x) => colLabelOf(x, cols)))];
  if (label) {
    const many = `${quoted(label)}有 ${names.length} 個地方兩台都改過，留下${who}後改的`;
    if (names.length > 2) return many;
    const listed = `${quoted(label)}的${names.join("、")}兩台都改過，留下${who}後改的`;
    // 名字長＋欄名長會超過兩行（#59 的 40 字）⇒ 退回只說幾個地方
    return Array.from(listed).length <= TOAST_MAX_CHARS ? listed : many;
  }
  return `有 ${countNoun(n.tbl, 1)}兩台改到同樣的 ${names.length} 格，留下${who}後改的`;
}

export const MERGE_TEXT = {
  title: "最近兩台撞到的",
  groupRevived: "刪了又回來",
  groupOverwritten: "兩邊都改了、後改的留下",
  ack: "知道了",
  look: "看看",
  gone: "（現在找不到了）",
  intro: "兩台在沒看到對方修改的情況下各自改到同一筆時，引擎會留下改過的那一邊；這裡列出最近發生的幾筆，方便回頭查。",
  /** 「知道了」沒清成（橋接不通） */
  ackFailed: (e: string) => `沒清成：${e}`,
} as const;
