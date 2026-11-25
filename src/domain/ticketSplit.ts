/**
 * 售票口 3A：舊帳長句隨筆分流小幫手純函式（v1.38 · D-1.36-5）。
 * 篩出已無損搬入 `item` 的兩段式或長句舊帳，產出建議切分（品項／來源 ＋ 隨筆備註）供使用者勾選一鍵分流。
 * 零 React / DOM / Tauri 相依，可供 `node --test` 直載。
 */

export interface SplitEntryLike {
  id: string;
  kind: "income" | "expense" | "transfer" | "adjust";
  occurred_on: string;
  amount_minor: number;
  currency: string;
  category_id: string | null;
  item: string;
  note: string;
  deleted_at: string | null;
}

export type SplitReason = "separator" | "parenthetical" | "space" | "long" | "duplicate";

export interface LegacySplitCandidate {
  entryId: string;
  occurredOn: string;
  originalItem: string;
  originalNote: string;
  suggestedItem: string;
  suggestedNote: string;
  reason: SplitReason;
  reasonLabel: string;
}

const LONG_ITEM_THRESHOLD = 14;

/** 明顯兩段式分隔符號（優先序由明確到寬鬆） */
const EXPLICIT_SEPARATORS = [
  /\s+[—–-]\s+/,
  /\s*｜\s*/,
  /\s*\|\s*/,
  /\s*\/\s*/,
  /：\s*/,
  /:\s+/,
  /，\s*/,
  /,\s+/,
] as const;

/** 尾端括號補充（如「麥味登（跟小美吃早午餐）」） */
const TRAILING_PAREN_RE = /^(.{2,18}?)\s*[（(]([^）)]{2,})[）)]$/;

/** 中間單空白切分（如「麥味登 蛋餅加起司超好吃」） */
const SPACE_SPLIT_RE = /^(\S{2,12})\s+(.{3,})$/;

/** 嘗試替單筆帳目產出「品項／來源 ＋ 隨筆備註」切分建議；不需分流回 null */
export function suggestLegacySplit(e: SplitEntryLike): LegacySplitCandidate | null {
  if (e.deleted_at !== null || e.kind === "adjust") return null;
  const rawItem = (e.item ?? "").trim();
  const rawNote = (e.note ?? "").trim();

  // 0. 防呆：雙機併發升級時若出現品項與備註逐字相同，建議清空重複備註
  if (rawItem !== "" && rawItem === rawNote) {
    return {
      entryId: e.id,
      occurredOn: e.occurred_on,
      originalItem: rawItem,
      originalNote: rawNote,
      suggestedItem: rawItem,
      suggestedNote: "",
      reason: "duplicate",
      reasonLabel: "品項與備註重複",
    };
  }

  // 已有隨筆備註者視為使用者已整理過，不再重複干擾
  if (rawItem === "" || rawNote !== "") return null;

  // 1. 尾端括號補充：「麥味登（跟室友聚餐）」
  const paren = TRAILING_PAREN_RE.exec(rawItem);
  if (paren) {
    const left = paren[1].trim();
    const right = paren[2].trim();
    if (left.length >= 2 && right.length >= 2) {
      return {
        entryId: e.id,
        occurredOn: e.occurred_on,
        originalItem: rawItem,
        originalNote: rawNote,
        suggestedItem: left,
        suggestedNote: right,
        reason: "parenthetical",
        reasonLabel: "括號隨筆",
      };
    }
  }

  // 2. 明確分隔符（— / ｜ / ： / ，）
  for (const sep of EXPLICIT_SEPARATORS) {
    const m = sep.exec(rawItem);
    if (!m || m.index <= 0) continue;
    const left = rawItem.slice(0, m.index).trim();
    const right = rawItem.slice(m.index + m[0].length).trim();
    if (left.length >= 2 && right.length >= 2) {
      return {
        entryId: e.id,
        occurredOn: e.occurred_on,
        originalItem: rawItem,
        originalNote: rawNote,
        suggestedItem: left,
        suggestedNote: right,
        reason: "separator",
        reasonLabel: "兩段式分隔",
      };
    }
  }

  // 3. 空白分隔兩段（首詞 2–12 字＋後方描述 ≥3 字）
  const sp = SPACE_SPLIT_RE.exec(rawItem);
  if (sp) {
    const left = sp[1].trim();
    const right = sp[2].trim();
    if (left.length >= 2 && right.length >= 3) {
      return {
        entryId: e.id,
        occurredOn: e.occurred_on,
        originalItem: rawItem,
        originalNote: rawNote,
        suggestedItem: left,
        suggestedNote: right,
        reason: "space",
        reasonLabel: "空白兩段",
      };
    }
  }

  // 4. 純長句（≥14 字）：保留前段為品項提示、全文歸隨筆（使用者可就地微調）
  if (rawItem.length >= LONG_ITEM_THRESHOLD) {
    return {
      entryId: e.id,
      occurredOn: e.occurred_on,
      originalItem: rawItem,
      originalNote: rawNote,
      suggestedItem: rawItem.slice(0, 8),
      suggestedNote: rawItem,
      reason: "long",
      reasonLabel: "長句隨筆",
    };
  }

  return null;
}

/** 篩出全部建議分流的舊帳清單（新到舊排序） */
export function findLegacySplitCandidates(entries: readonly SplitEntryLike[]): LegacySplitCandidate[] {
  const out: LegacySplitCandidate[] = [];
  for (const e of entries) {
    const c = suggestLegacySplit(e);
    if (c) out.push(c);
  }
  return out.sort((a, b) => b.occurredOn.localeCompare(a.occurredOn) || a.entryId.localeCompare(b.entryId));
}
