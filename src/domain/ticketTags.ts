/**
 * 售票口④・荷札（契約 §1、D-票-74）的純函式：帳目／定期帳規則／願望／常用票種掛荷札時，售票口這邊要算的東西。
 *
 * 荷札本身（名稱正規化、內文解析、樹與計數）一律用旅客筆記的 `./tags`（同一語意只定義一次）；本檔只做售票口的接法：
 *   - 實體種類（`ticket:entry`／`ticket:repeat`／`ticket:wish`／`ticket:template`；taggings 的 entity_type，不加欄）
 *   - `tagStore.index` → 帳 id → 荷札 keys（篩選、依荷札統計、關鍵字比對荷札名都靠它；`ViewCtx.entryTags`）
 *   - 捕捉框「記一筆」一行裡的 `#名稱` 抽成荷札、不進備註（色碼、純數字不算——`parseTags` 的規則）
 *   - 草稿裡的荷札名稱先驗過再寫（名稱不合法 ⇒ 整筆不寫，同時刻表⑥的 checkTagNames）
 *
 * 鐵則同 ①②③：只用可剝除語法、零副作用；`import` 只自 `./tags`（它本身零 import）——`scripts/tests/ticket-4-logic.test.ts` 以 node 直接載入。
 */
import { normalizeName, parseTags, removeTagText, type TagIndex } from "./tags";

/** 一筆帳（entity_id＝tk_entries.id） */
export const TK_TAG_ENTRY = "ticket:entry" as const;
/** 定期帳規則：它記出來的每一筆帶規則的荷札 */
export const TK_TAG_REPEAT = "ticket:repeat" as const;
/** 願望：買了那筆帶過去 */
export const TK_TAG_WISH = "ticket:wish" as const;
/** 常用票種：填出來的草稿帶過去 */
export const TK_TAG_TEMPLATE = "ticket:template" as const;
export type TicketTagType = typeof TK_TAG_ENTRY | typeof TK_TAG_REPEAT | typeof TK_TAG_WISH | typeof TK_TAG_TEMPLATE;

/** index（tagStore.index）→ 某種實體 id → 掛的 keys；index 還沒載＝空物件 */
export function entityTagMap(idx: TagIndex | null, type: string = TK_TAG_ENTRY): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!idx) return out;
  for (const e of idx.ents) if (e.type === type && e.keys.length) out[e.id] = e.keys.slice();
  return out;
}

/** 荷札 key → 顯示名（index 裡找不到就用 key；key 是英文小寫過的名稱） */
export function tagNameOf(idx: TagIndex | null): (key: string) => string {
  return (key: string) => {
    const n = idx ? idx.byKey[key] : undefined;
    return n ? n.name : key;
  };
}

/** 某實體掛的荷札「名稱」（setTags 要名稱不是 key）；照 key 排序 */
export function tagNamesOf(idx: TagIndex | null, type: string, id: string): string[] {
  if (!idx) return [];
  const name = tagNameOf(idx);
  for (const e of idx.ents) if (e.type === type && e.id === id) return e.keys.slice().sort().map(name);
  return [];
}

/**
 * 捕捉框「記一筆」一行：把 `#名稱` 抽出來當荷札，剩下的照舊給 `parseQuickEntry`（金額、分類、備註、@帳戶）。
 * 規則全照旅客筆記的 parseTags：`#` 前面要是行首、空白或全形標點；色碼（#fff、#AD3D2B）、純數字（#2026）、網址裡的 # 不算——
 * 那些字原樣留在備註。同名（大小寫不同）只留第一個寫法。
 */
export function splitQuickTags(body: string): { body: string; names: string[] } {
  const occ = parseTags(body);
  if (!occ.length) return { body, names: [] };
  const names: string[] = [];
  const keys: string[] = [];
  for (const o of occ) {
    if (keys.indexOf(o.key) >= 0) continue;
    keys.push(o.key);
    names.push(o.name);
  }
  return { body: removeTagText(body, keys).replace(/\s+/g, " ").trim(), names };
}

/**
 * 草稿的荷札名稱：去掉開頭的 #、正規化、同名去重（照第一次出現的寫法）；有一個不合法 ⇒ { ok:false, reason }。
 * 空陣列＝合法（不掛）。
 */
export function cleanTagNames(raw: readonly string[]): { ok: true; names: string[] } | { ok: false; reason: string; name: string } {
  const names: string[] = [];
  const keys: string[] = [];
  for (const r of raw) {
    const n = normalizeName(r);
    if (!n.ok) return { ok: false, reason: n.reason, name: r };
    if (keys.indexOf(n.key) >= 0) continue;
    keys.push(n.key);
    names.push(n.name);
  }
  return { ok: true, names };
}
