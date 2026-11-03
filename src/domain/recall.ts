/**
 * recall——「打幾個字就能選以前寫過的」的比對與排序（售票口④；共用元件 `ui/common/RecallInput` 的純函式半）。
 *
 * 呼叫端把歷史整理成 `RecallItem[]`（`tallyRecall` 可以幫忙數次數、留最近一次的寫法），`rankRecall` 照打的字挑出候選：
 *   - 比對鍵＝逐字 NFKC＋小寫（全形英數、全形空白都跟半形一樣；中文不受影響）；打的字前後空白不算。
 *   - 對得到＝鍵裡包含打的字。排序：`boost` 大的先（沒給＝0；時刻表⑦ 同分類優先）→ 開頭就對到 → 在詞首對到（前一個字是空白或標點）→ 中間對到；同一級比次數多、再比最近、再比短。
 *   - 跟打的字完全一樣的不列（已經打完了，再選一次沒意義）；鍵相同的只留一個。
 *   - `at`／`len` 是對到的那段在**原字串**的位置（給畫面加粗）；正規化改了長度、對不回原字串時是 -1。
 */

export interface RecallItem {
  /** 候選的字（選了就填這個） */
  text: string;
  /** 用過幾次（排序用；沒給＝1） */
  count?: number;
  /** 最近一次用的時間（可比較的字串或數字，例 ISO 日期；越大越近） */
  last?: string | number;
  /** 列右側的淡字（沒給＝「N 次」，由元件決定） */
  sub?: string;
  /** 排序加權（大的先；沒給＝0）——比對位置之前就先比。時刻表⑦：同分類寫過的備註給 1，排在別的分類前面 */
  boost?: number;
}

export interface RecallHit<T extends RecallItem = RecallItem> {
  item: T;
  /** 對到的那段在 item.text 的起點（-1＝標不出來） */
  at: number;
  len: number;
}

interface Keyed {
  key: string;
  /** key 的第 i 個 UTF-16 單位來自原字串的哪個位置 */
  map: number[];
}

/** 逐字 NFKC＋小寫，記下每個輸出單位對回原字串的位置 */
function keyed(text: string): Keyed {
  let key = "";
  const map: number[] = [];
  let i = 0;
  for (const ch of text) {
    const n = ch.normalize("NFKC").toLowerCase();
    key += n;
    for (let j = 0; j < n.length; j++) map.push(i);
    i += ch.length;
  }
  return { key, map };
}

/** 比對鍵（跟 rankRecall 內部同一套） */
export function recallKey(text: string): string {
  return keyed(text.trim()).key;
}

const WORD_GAP = /[\s\p{P}\p{S}]/u;

function tierOf(key: string, pos: number): number {
  if (pos === 0) return 0;
  return WORD_GAP.test(key[pos - 1]) ? 1 : 2;
}

function cmpLast(a: string | number | undefined, b: string | number | undefined): number {
  if (a === b) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return a > b ? -1 : 1;
}

/**
 * 照打的字挑候選。`query` 去掉前後空白後不足 `minChars` 個字（預設 1）⇒ 空陣列。
 */
export function rankRecall<T extends RecallItem>(items: readonly T[], query: string, opts: { limit?: number; minChars?: number } = {}): RecallHit<T>[] {
  const limit = opts.limit ?? 6;
  const minChars = opts.minChars ?? 1;
  const q = recallKey(query);
  if ([...q].length < minChars || limit <= 0) return [];
  const seen = new Map<string, { hit: RecallHit<T>; tier: number }>();
  for (const item of items) {
    const text = item.text.trim();
    if (!text) continue;
    const k = keyed(item.text);
    if (k.key.trim() === q) continue;
    const pos = k.key.indexOf(q);
    if (pos < 0) continue;
    const start = k.map[pos];
    const endKey = pos + q.length;
    const end = endKey < k.map.length ? k.map[endKey] : item.text.length;
    const ok = start !== undefined && end > start && keyed(item.text.slice(start, end)).key === q;
    const hit: RecallHit<T> = { item, at: ok ? start : -1, len: ok ? end - start : 0 };
    const tier = tierOf(k.key, pos);
    const dup = seen.get(k.key.trim());
    if (!dup || better(hit, tier, dup.hit, dup.tier) < 0) seen.set(k.key.trim(), { hit, tier });
  }
  return [...seen.values()]
    .sort((a, b) => better(a.hit, a.tier, b.hit, b.tier))
    .slice(0, limit)
    .map((x) => x.hit);
}

function better<T extends RecallItem>(a: RecallHit<T>, ta: number, b: RecallHit<T>, tb: number): number {
  return (
    (b.item.boost ?? 0) - (a.item.boost ?? 0) ||
    ta - tb ||
    (b.item.count ?? 1) - (a.item.count ?? 1) ||
    cmpLast(a.item.last, b.item.last) ||
    a.item.text.length - b.item.text.length ||
    (a.item.text < b.item.text ? -1 : a.item.text > b.item.text ? 1 : 0)
  );
}

/**
 * 把一串歷史（每次用到的字＋時間）數成候選：鍵相同的併成一個、次數相加，字取最近那次的寫法。空字略過。
 */
export function tallyRecall(uses: Iterable<{ text: string; at?: string | number }>): RecallItem[] {
  const by = new Map<string, RecallItem>();
  for (const u of uses) {
    const text = u.text.trim();
    if (!text) continue;
    const k = recallKey(text);
    const cur = by.get(k);
    if (!cur) {
      by.set(k, { text, count: 1, last: u.at });
      continue;
    }
    cur.count = (cur.count ?? 1) + 1;
    if (u.at !== undefined && (cur.last === undefined || u.at > cur.last)) {
      cur.last = u.at;
      cur.text = text;
    }
  }
  return [...by.values()];
}
