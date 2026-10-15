// 旅客筆記・荷札純函式單元測試（車次③契約 §4.4）
// 跑法：node --test scripts/tests/tags-logic.test.ts（node 24 直接剝除型別；不進 tsc——tsconfig 只 include src）
//
// 案例來源：prototypes/旅客筆記-荷札-src/smoke.mjs 的 suite() 逐條移植。原型的「改資料」函式（attach／applyRename／
// applyDelete）不移植——那些在 repository 執行計畫；這裡用測試內的小模擬器（simulateRename／simulateDelete，
// 照原型 applyRename／applyDelete 的語意）驗「計畫＋內文改寫」兩支純函式算得對。
// 與原型不同處：0-19（D-筆-44）全形標點後的 # 算荷札——原型「（#靈感）不算」改成算。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import {
  affectedCounts,
  backfillNotice,
  buildIndex,
  completeTab,
  deleteBody,
  deleteConfirmText,
  deleteExample,
  depthOf,
  flattenTree,
  groupTaggedItems,
  inlineParagraphs,
  inlineSegments,
  isHexColor,
  isUnder,
  itemsUnder,
  keyOf,
  keysOfEntity,
  lastSeg,
  maskText,
  mergeConfirmText,
  normalizeName,
  parentOf,
  parseTags,
  planDelete,
  planRename,
  pushRecentKeys,
  relName,
  removeTagText,
  renameBody,
  renameImpact,
  rewriteRaw,
  rewriteTags,
  setTagsToast,
  snippetAround,
  suggest,
  tagAtCaret,
  tagDisplayParts,
  tagKeysIn,
  TAG_ENTITY_NODE_KINDS,
  type DeletePlan,
  type RenamePlan,
  type TagIndexSource,
} from "../../src/domain/tags.ts";
import { uuidv5 } from "../../src/lib/uuidv5.ts";
import { tagId, taggingId, emptyReceipt, isEmptyReceipt, type TaggedItem } from "../../src/data/tagRepository.ts";

/* ── 假資料（=smoke.mjs mini()；手寫、跟 seed 無關） ── */

interface FxNode { id: string; kind: string; status?: string; tags: string[] }
interface FxNote { id: string; body: string }
interface Fx { nodes: FxNode[]; notes: FxNote[]; diaries: FxNote[]; tags: { key: string; name: string }[] }

const TODAY = "2026-10-12";
function mini(): Fx {
  return {
    nodes: [
      { id: "a", kind: "ticket", tags: ["難度/高", "高"] },
      { id: "b", kind: "ticket", status: "done", tags: ["難度/低"] },
      { id: "c", kind: "train", tags: ["高", "重要/高"] },
      { id: "d", kind: "ticket", tags: ["高"] },
      { id: "e", kind: "ticket", tags: ["專案/搬家/打包"] },
      { id: "r", kind: "route", tags: [] },
    ],
    notes: [
      { id: "n1", body: "今天 #高 的事很多， #難度/高 也有。色 #AD3D2B 不算。" },
      { id: "n2", body: "- 打包 #專案/搬家/打包\n- 退租 #專案/搬家/退租" },
    ],
    diaries: [{ id: "d1", body: "#高 開頭也算" }],
    tags: [
      { key: "難度/高", name: "難度/高" }, { key: "難度/低", name: "難度/低" }, { key: "高", name: "高" },
      { key: "重要/高", name: "重要/高" }, { key: "專案/搬家/打包", name: "專案/搬家/打包" }, { key: "專案/搬家/退租", name: "專案/搬家/退租" },
    ],
  };
}
/** Fx → TagIndexSource（＝repository 的 loadIndexSource：tags＋存活 taggings；筆記與日記的 taggings 由內文推導） */
function srcOf(fx: Fx): TagIndexSource {
  const tags = fx.tags.map((t) => ({ id: "id:" + t.key, name: t.name, key: t.key }));
  const have = new Set(tags.map((t) => t.key));
  const taggings: TagIndexSource["taggings"] = [];
  const kinds: Record<string, string> = {};
  for (const n of fx.nodes) {
    if (!TAG_ENTITY_NODE_KINDS.includes(n.kind)) continue;
    kinds[n.id] = n.kind;
    for (const k of n.tags) taggings.push({ tagId: "id:" + k, entityType: "node", entityId: n.id });
  }
  const bodies: [FxNote, string][] = [...fx.notes.map((n) => [n, "note"] as [FxNote, string]), ...fx.diaries.map((n) => [n, "diary"] as [FxNote, string])];
  for (const [x, kind] of bodies) {
    kinds[x.id] = kind;
    for (const o of parseTags(x.body)) {
      if (!have.has(o.key)) {
        have.add(o.key);
        tags.push({ id: "id:" + o.key, name: o.name, key: o.key });
      }
    }
    for (const k of tagKeysIn(x.body)) taggings.push({ tagId: "id:" + k, entityType: "note", entityId: x.id });
  }
  return { tags, taggings, kinds };
}
const idxOf = (fx: Fx) => buildIndex(srcOf(fx));
const tagRow = (fx: Fx, key: string) => fx.tags.find((t) => t.key === key) ?? null;
/** 原型 applyRename 的語意（=logic.js:425-454）：節點的 keys 換新、內文用 renameBody、表裡的列搬或併 */
function simulateRename(fx: Fx, plan: RenamePlan): Fx {
  assert.ok(plan.ok);
  if (plan.same) {
    const r = tagRow(fx, plan.oldKey);
    if (r) r.name = plan.newName;
    return fx;
  }
  const map = new Map(plan.moves.map((m) => [m.from, m]));
  for (const n of fx.nodes) {
    const out: string[] = [];
    for (const k of n.tags) {
      const t = map.get(k)?.to ?? k;
      if (!out.includes(t)) out.push(t);
    }
    n.tags = out;
  }
  for (const x of [...fx.notes, ...fx.diaries]) x.body = renameBody(x.body, plan);
  for (const m of plan.moves) {
    const src = tagRow(fx, m.from);
    if (!src) continue;
    if (tagRow(fx, m.to)) fx.tags.splice(fx.tags.indexOf(src), 1);
    else {
      src.key = m.to;
      src.name = m.toName;
    }
  }
  return fx;
}
/** 原型 applyDelete(…, 'remove') 的語意 */
function simulateDelete(fx: Fx, plan: DeletePlan): Fx {
  assert.ok(plan.ok);
  const set = new Set(plan.keys);
  for (const n of fx.nodes) n.tags = n.tags.filter((k) => !set.has(k));
  for (const x of [...fx.notes, ...fx.diaries]) x.body = deleteBody(x.body, plan);
  fx.tags = fx.tags.filter((t) => !set.has(t.key));
  return fx;
}
const keys = (s: string) => parseTags(s).map((o) => o.key);
const ok = <T extends { ok: boolean }>(p: T) => {
  assert.equal(p.ok, true, JSON.stringify(p));
  return p as Extract<T, { ok: true }>;
};

/* ═══ 名稱正規化 ═══ */

test("正規化：trim、去開頭 #、各段去空白", () => {
  const n = ok(normalizeName("  #難度 / 高 "));
  assert.equal(n.name, "難度/高");
  assert.equal(n.key, "難度/高");
});
test("正規化：英文轉小寫只在 key，name 保留大小寫", () => {
  const n = ok(normalizeName("AI/工具"));
  assert.equal(n.name, "AI/工具");
  assert.equal(n.key, "ai/工具");
});
test("正規化：NFKC（全形英數、全形斜線）", () => {
  const n = ok(normalizeName("ＡＩ／工具"));
  assert.equal(n.key, "ai/工具");
  assert.equal(n.name, "AI/工具");
});
test("名稱規則：純數字不行（#2026、#2026/10）", () => {
  const a = normalizeName("2026");
  assert.equal(a.ok, false);
  assert.equal(normalizeName("2026/10").ok, false);
  assert.match(!a.ok ? a.reason : "", /數字/);
});
test("名稱規則：數字加一個字就行", () => {
  assert.equal(normalizeName("2026年").ok, true);
  assert.equal(normalizeName("年度/2026").ok, true);
});
for (const [raw, re] of [
  ["難 度", /空白/],
  ["a#b", /#/],
  ["難度//高", /空著/],
  ["難度/", /空著/],
  ["", /還沒有名稱/],
  ["#", /還沒有名稱/],
] as const) {
  test(`名稱規則：「${raw}」不行`, () => {
    const n = normalizeName(raw);
    assert.equal(n.ok, false);
    assert.match(!n.ok ? n.reason : "", re);
  });
}
test("keyOf：不合法回 null", () => {
  assert.equal(keyOf("AI"), "ai");
  assert.equal(keyOf("2026"), null);
});
test("路徑工具：depthOf／parentOf／isUnder／lastSeg", () => {
  assert.equal(depthOf("a/b/c"), 3);
  assert.equal(parentOf("a/b/c"), "a/b");
  assert.equal(parentOf("a"), null);
  assert.equal(isUnder("難度/高", "難度"), true);
  assert.equal(isUnder("難度", "難度"), true);
  assert.equal(isUnder("高鐵", "高"), false);
  assert.equal(lastSeg("專案/搬家/打包"), "打包");
});

/* ═══ 內文解析 ═══ */

test("解析：行首與空白後的 # 才算", () => {
  assert.deepEqual(keys("#靈感 開頭"), ["靈感"]);
  assert.deepEqual(keys("句中 #靈感"), ["靈感"]);
  assert.deepEqual(keys("a#b"), []);
  assert.deepEqual(keys("第二行\n#靈感"), ["靈感"]);
});
test("解析：全形空白後也算", () => assert.deepEqual(keys("甲　#乙"), ["乙"]));
test("解析：色碼不算（#AD3D2B、#1e1e1e、#fff、#FFFFFF）", () => assert.deepEqual(keys("朱 #AD3D2B 墨 #1e1e1e 白 #fff #FFFFFF"), []));
test("解析：只有字母的十六進位英文字算（#cafe、#add）", () => assert.deepEqual(keys("#cafe #add"), ["cafe", "add"]));
test("isHexColor：3／4／6／8 位含數字、或同字母重複", () => {
  for (const t of ["AD3D2B", "1e1e1e", "fff", "FFFFFF", "abc1", "12345678"]) assert.equal(isHexColor(t), true, t);
  for (const t of ["cafe", "add", "face", "gg", "abcde"]) assert.equal(isHexColor(t), false, t);
});
test("解析：網址裡的 # 不算", () => {
  assert.deepEqual(keys("看 https://x.com/#top 這篇"), []);
  assert.deepEqual(keys("www.example.com/page#part"), []);
});
test("解析：行內程式碼不算（`#define`）", () => assert.deepEqual(keys("用 `#define` 定義 #課程/作業系統"), ["課程/作業系統"]));
test("解析：程式碼後面緊貼的 # 也不算", () => assert.deepEqual(keys("`x`#tag"), []));
test("解析：圍欄程式碼整段不算", () => assert.deepEqual(keys("前 #甲\n```\n#include <x>\n #乙\n```\n後 #丙"), ["甲", "丙"]));
test("解析：#2026 只有數字不算", () => assert.deepEqual(keys("#2026 的目標"), []));
test("解析：Markdown 標題（# 後空白）不算", () => assert.deepEqual(keys("# 標題\n## 小標"), []));
test("解析：遇到全形標點就結束", () => {
  assert.deepEqual(keys("記在 #讀書/日文，很累。"), ["讀書/日文"]);
  assert.deepEqual(keys("（ #靈感）"), ["靈感"]);
});
// 0-19（D-筆-44）：全形標點後緊貼的 # 算（原型不算）
test("解析：全形標點後的 # 算——「。#靈感」", () => assert.deepEqual(keys("想到了。#靈感"), ["靈感"]));
test("解析：全形標點後的 # 算——「？#待查」", () => assert.deepEqual(keys("真的嗎？#待查"), ["待查"]));
test("解析：全形標點後的 # 算——「，#a/b」", () => assert.deepEqual(keys("還有，#a/b 要做"), ["a/b"]));
test("解析：全形括號後的 # 算——「（#靈感）」（原型不算，D-筆-44 改）", () => assert.deepEqual(keys("（#靈感）"), ["靈感"]));
test("解析：半形標點後的 # 仍不算——「a,#b」", () => assert.deepEqual(keys("a,#b"), []));
test("解析：尾巴的句點與斜線不算進名稱", () => {
  assert.deepEqual(keys("結束 #難度/高."), ["難度/高"]);
  assert.deepEqual(keys("瀏覽 #難度/ 中"), ["難度"]);
});
test("解析：位置對得回原文", () => {
  const s = "今天 #難度/高 好難";
  const o = parseTags(s)[0];
  assert.equal(s.slice(o.start, o.end), "#難度/高");
  assert.equal(o.raw, "難度/高");
});
test("解析：全形標點後的位置也對得回原文", () => {
  const s = "好。#靈感 來了";
  const o = parseTags(s)[0];
  assert.equal(s.slice(o.start, o.end), "#靈感");
});
test("解析：同一個荷札寫兩次只算一處", () => assert.deepEqual(tagKeysIn("#a1 #A1 #a1"), ["a1"]));
test("解析：大小寫與全形寫法收成同一個 key", () => assert.deepEqual(tagKeysIn("#AI/工具 #ai/工具 #ＡＩ／工具"), ["ai/工具"]));
test("maskText：長度不變、程式碼與網址換成 \\u0000", () => {
  const s = "a `#x` https://x.com/#t b";
  const m = maskText(s);
  assert.equal(m.length, s.length);
  assert.equal(m.indexOf("#"), -1);
  assert.ok(m.startsWith("a ") && m.endsWith(" b"));
});
test("游標處的荷札：打到一半", () => {
  const s = "寫 #難";
  assert.deepEqual(tagAtCaret(s, s.length), { start: 2, q: "難" });
  assert.deepEqual(tagAtCaret("#", 1), { start: 0, q: "" });
});
test("游標處的荷札：網址與程式碼裡不出建議", () => {
  const s = "https://x.com/#to";
  assert.equal(tagAtCaret(s, s.length), null);
  assert.equal(tagAtCaret("`#de", 4), null);
  assert.equal(tagAtCaret("a#b", 3), null);
});
test("游標處的荷札：全形標點後出建議（0-19）", () => {
  assert.deepEqual(tagAtCaret("好。#靈", 4), { start: 2, q: "靈" });
  assert.deepEqual(tagAtCaret("（#", 2), { start: 1, q: "" });
});
test("游標處的荷札：半形逗號後不出", () => assert.equal(tagAtCaret("a,#b", 4), null));
test("游標處的荷札：打完空白就不算", () => assert.equal(tagAtCaret("#難度 ", 4), null));

/* ═══ 樹、計數、點父看子 ═══ */

test("樹：虛資料夾（專案、專案/搬家、難度）", () => {
  const idx = idxOf(mini());
  assert.equal(idx.byKey["專案"].real, false);
  assert.equal(idx.byKey["專案/搬家"].real, false);
  assert.equal(idx.byKey["專案/搬家/打包"].real, true);
  assert.equal(idx.byKey["難度"].real, false);
  assert.deepEqual(idx.byKey["專案/搬家"].children, ["專案/搬家/打包", "專案/搬家/退租"]);
});
test("樹：真荷札帶 tags.id、虛資料夾 id 為 null", () => {
  const idx = idxOf(mini());
  assert.equal(idx.byKey["高"].id, "id:高");
  assert.equal(idx.byKey["難度"].id, null);
});
test("計數：direct 只算自己，total 含子孫且同一個東西只算一次", () => {
  const idx = idxOf(mini());
  assert.equal(idx.byKey["高"].direct, 5); // a c d n1 d1
  assert.equal(idx.byKey["難度/高"].direct, 2); // a n1
  assert.equal(idx.byKey["難度"].total, 3); // a b n1
  assert.equal(idx.byKey["專案"].total, 2); // e n2（n2 掛兩個子荷札，只算一次）
});
test("計數：只在筆記內文出現的也進樹（補掛之後）", () => {
  const d = mini();
  d.notes.push({ id: "n3", body: "#新的" });
  assert.equal(idxOf(d).byKey["新的"].direct, 1);
});
test("實體：路線不算掛得上的東西", () => {
  assert.equal(idxOf(mini()).ents.some((e) => e.id === "r"), false);
  assert.equal(TAG_ENTITY_NODE_KINDS.includes("route"), false);
  assert.equal(TAG_ENTITY_NODE_KINDS.includes("car"), true);
});
test("樹：指到不存在 tag 的 tagging 略過（孤兒＝顯示狀態，不是錯誤）", () => {
  const idx = buildIndex({ tags: [{ id: "t1", name: "甲", key: "甲" }], taggings: [{ tagId: "t1", entityType: "node", entityId: "x" }, { tagId: "gone", entityType: "node", entityId: "x" }] });
  assert.deepEqual(idx.ents, [{ type: "node", id: "x", keys: ["甲"] }]);
});
test("樹：同一實體重複的 tagging 只算一次", () => {
  const idx = buildIndex({ tags: [{ id: "t1", name: "甲", key: "甲" }], taggings: [{ tagId: "t1", entityType: "note", entityId: "x" }, { tagId: "t1", entityType: "note", entityId: "x" }] });
  assert.equal(idx.byKey["甲"].direct, 1);
});
test("樹：kinds 寫進 ents（給 affectedCounts）", () => {
  const idx = idxOf(mini());
  assert.equal(idx.ents.find((e) => e.id === "c")?.kind, "train");
  assert.equal(idx.ents.find((e) => e.id === "d1")?.kind, "diary");
});
test("keysOfEntity：側板讀 index 就有某張票的荷札", () => {
  assert.deepEqual(keysOfEntity(idxOf(mini()), "node", "a").sort(), ["難度/高", "高"].sort());
  assert.deepEqual(keysOfEntity(idxOf(mini()), "node", "zzz"), []);
});
test("點父看子：#難度 列出 難度/高 與 難度/低 底下的東西，跨型別", () => {
  const items = itemsUnder(idxOf(mini()), "難度");
  assert.deepEqual(items.map((x) => x.id).sort(), ["a", "b", "n1"]);
  assert.deepEqual(items.find((x) => x.id === "b")?.matched, ["難度/低"]);
});
test("點父看子：不會把同字首的兄弟算進來（#高 不含 #高鐵）", () => {
  const d = mini();
  d.nodes[0].tags.push("高鐵");
  d.tags.push({ key: "高鐵", name: "高鐵" });
  assert.equal(itemsUnder(idxOf(d), "高").every((x) => x.matched.every((k) => k === "高")), true);
});
test("relName：相對父層的那一段", () => {
  assert.equal(relName("專案/搬家/打包", "專案"), "搬家/打包");
  assert.equal(relName("高", "高"), "");
});
test("樹攤平：預設只有根、展開才往下", () => {
  const idx = idxOf(mini());
  assert.deepEqual(flattenTree(idx, {}, "").map((r) => r.key), ["專案", "重要", "難度", "高"].sort((a, b) => (a < b ? -1 : 1)));
  const open = flattenTree(idx, { 難度: 1 }, "").map((r) => r.key);
  assert.ok(open.includes("難度/高") && open.includes("難度/低"));
});
test("樹攤平：篩選字時自動展開祖先", () => {
  assert.deepEqual(flattenTree(idxOf(mini()), {}, "打包").map((r) => r.key), ["專案", "專案/搬家", "專案/搬家/打包"]);
});
test("樹攤平：篩選忽略 # 與大小寫", () => {
  const d = mini();
  d.tags.push({ key: "ai/工具", name: "AI/工具" });
  assert.deepEqual(flattenTree(idxOf(d), null, "#AI").map((r) => r.key), ["ai", "ai/工具"]);
});
test("樹攤平：hasKids 與 open 旗標", () => {
  const rows = flattenTree(idxOf(mini()), { 專案: 1 }, "");
  const p = rows.find((r) => r.key === "專案");
  assert.equal(p?.open, true);
  assert.equal(p?.hasKids, true);
  assert.equal(rows.find((r) => r.key === "高")?.hasKids, false);
});

/* ═══ 建議清單 ═══ */

const idx0 = () => idxOf(mini());
test("建議：打「高」→ 整名相同的 #高 最前，其次段相同（難度/高、重要/高）", () => {
  const s = suggest(idx0(), "高");
  assert.deepEqual(s.items.map((x) => x.key), ["高", "難度/高", "重要/高"]);
  assert.equal(s.create, null);
});
test("建議：同一級依掛著的數量多到少", () => {
  const s = suggest(idx0(), "高");
  assert.ok(s.items[1].count >= s.items[2].count);
});
test("建議：段首 > 中間含有", () => {
  const d = mini();
  d.tags.push({ key: "最高原則", name: "最高原則" }, { key: "高鐵", name: "高鐵" });
  const ks = suggest(idxOf(d), "高").items.map((x) => x.key);
  assert.ok(ks.indexOf("高鐵") < ks.indexOf("最高原則"));
  assert.ok(ks.indexOf("重要/高") < ks.indexOf("高鐵"));
});
test("建議：tier 四級（0 整名／1 段相同／2 段首／3 含有）", () => {
  const d = mini();
  d.tags.push({ key: "最高原則", name: "最高原則" }, { key: "高鐵", name: "高鐵" });
  const s = suggest(idxOf(d), "高", { limit: 20 });
  const tierOf = (k: string) => s.items.find((x) => x.key === k)?.tier;
  assert.deepEqual([tierOf("高"), tierOf("難度/高"), tierOf("高鐵"), tierOf("最高原則")], [0, 1, 2, 3]);
});
test("建議：加粗範圍是對到的那一段", () => {
  const it = suggest(idx0(), "高").items.find((x) => x.key === "難度/高");
  assert.deepEqual(it?.hl, [3, 4]);
});
test("建議：打 `難度/` 列出 難度 底下的子荷札，不給建立", () => {
  const s = suggest(idx0(), "難度/");
  assert.deepEqual(s.items.map((x) => x.key).sort(), ["難度/低", "難度/高"]);
  assert.equal(s.browse, "難度");
  assert.equal(s.create, null);
});
test("建議：打 `專案/` 也看得到孫荷札", () => {
  assert.deepEqual(suggest(idx0(), "專案/").items.map((x) => x.key).sort(), ["專案/搬家/打包", "專案/搬家/退租"]);
});
test("建議：瀏覽空資料夾給提示", () => {
  const s = suggest(idx0(), "高/");
  assert.equal(s.items.length, 0);
  assert.equal(s.hint, "「高」底下還沒有子荷札");
});
test("建議：沒完全對到 → 給「建立」", () => assert.deepEqual(suggest(idx0(), "新荷札").create, { name: "新荷札", key: "新荷札" }));
test("建議：完全對到 → 不給建立", () => assert.equal(suggest(idx0(), "難度/高").create, null));
test("建議：只打數字 → 不給建立、給提示", () => {
  const a = suggest(idx0(), "2026");
  assert.equal(a.create, null);
  assert.match(a.hint ?? "", /數字/);
});
test("建議：含空白 → 不給建立、給提示", () => {
  const b = suggest(idx0(), "難 度");
  assert.equal(b.create, null);
  assert.match(b.hint ?? "", /空白/);
});
test("建議：大小寫不分", () => {
  const d = mini();
  d.tags.push({ key: "ai/工具", name: "AI/工具" });
  assert.equal(suggest(idxOf(d), "ai").items[0].name, "AI/工具");
});
test("建議：已掛著的排除（陣列或 Set 都收）", () => {
  assert.equal(suggest(idx0(), "高", { exclude: ["高"] }).items.some((x) => x.key === "高"), false);
  assert.equal(suggest(idx0(), "高", { exclude: new Set(["高"]) }).items.some((x) => x.key === "高"), false);
});
test("建議：已掛著的名稱不給「建立」", () => assert.equal(suggest(idx0(), "新的", { exclude: ["新的"] }).create, null));
test("建議：虛資料夾預設不列、includeVirtual 才列", () => {
  assert.equal(suggest(idx0(), "專案").items.some((x) => x.key === "專案"), false);
  assert.equal(suggest(idx0(), "專案", { includeVirtual: true }).items[0].key, "專案");
});
test("建議：空字串＝最常用的幾個", () => {
  const s = suggest(idx0(), "");
  assert.equal(s.items[0].key, "高");
  assert.ok(s.items.length <= 8);
});
test("建議：開頭的 # 與全形字先正規化", () => {
  assert.equal(suggest(idx0(), "#高").items[0].key, "高");
  const d = mini();
  d.tags.push({ key: "ai", name: "AI" });
  assert.equal(suggest(idxOf(d), "ＡＩ").items[0].key, "ai");
});
test("Tab 補完到下一個 /", () => {
  const s = suggest(idx0(), "專");
  assert.equal(completeTab(s.items[0], null), "專案/");
  const b = suggest(idx0(), "專案/");
  assert.equal(completeTab(b.items[0], b.browse), "專案/搬家/");
  const h = suggest(idx0(), "高");
  assert.equal(completeTab(h.items[1], null), "難度/高");
});
test("Tab 補完：單層名稱補到全名", () => {
  const s = suggest(idx0(), "高");
  assert.equal(completeTab(s.items[0], null), "高");
});
test("最近用過：推到最前、去重、最多 6", () => {
  assert.deepEqual(pushRecentKeys(["a", "b", "c"], "b"), ["b", "a", "c"]);
  assert.deepEqual(pushRecentKeys(["1", "2", "3", "4", "5", "6"], "7"), ["7", "1", "2", "3", "4", "5"]);
});

/* ═══ 改名＝搬家、併入 ═══ */

test("改名：預覽數字與文案", () => {
  const p = ok(planRename(idx0(), "專案/搬家", "搬家"));
  assert.equal(p.childCount, 2);
  assert.equal(p.affected.ticket, 1);
  assert.equal(p.affected.note, 1);
  assert.match(renameImpact(p), /1 張車票、1 則筆記的內文；#專案\/搬家 底下的 2 個子荷札一起搬/);
});
test("改名：搬層級，子孫跟著搬、內文一起改", () => {
  const d = mini();
  simulateRename(d, planRename(idxOf(d), "專案/搬家", "搬家"));
  assert.ok(tagRow(d, "搬家/打包"));
  assert.equal(tagRow(d, "專案/搬家/打包"), null);
  assert.deepEqual(d.nodes.find((n) => n.id === "e")?.tags, ["搬家/打包"]);
  assert.equal(d.notes[1].body, "- 打包 #搬家/打包\n- 退租 #搬家/退租");
});
test("改名：#高 → #難度/中（新名稱）", () => {
  const d = mini();
  const p = planRename(idxOf(d), "高", "難度/中");
  assert.equal(ok(p).rootConflict, null);
  simulateRename(d, p);
  assert.equal(d.notes[0].body, "今天 #難度/中 的事很多， #難度/高 也有。色 #AD3D2B 不算。");
  assert.equal(d.diaries[0].body, "#難度/中 開頭也算");
});
test("改名成已存在的名稱 → rootConflict（給「要不要併入」用）", () => {
  const p = ok(planRename(idx0(), "高", "難度/高"));
  assert.deepEqual(p.rootConflict, { key: "難度/高", name: "難度/高", count: 2 });
  assert.equal(p.ownCount, 5);
});
test("併入：同一個東西掛兩個 → 併完只剩一個，不重複", () => {
  const d = mini();
  simulateRename(d, planRename(idxOf(d), "高", "難度/高"));
  assert.deepEqual(d.nodes[0].tags, ["難度/高"]);
  assert.equal(tagRow(d, "高"), null);
  assert.equal(idxOf(d).byKey["難度/高"].direct, 5); // #高 的 a c d n1 d1 ∪ 原本的 a n1（去重）
});
test("改名：不能搬進自己底下", () => {
  const p = planRename(idx0(), "難度/高", "難度/高/更高");
  assert.equal(p.ok, false);
  assert.match(!p.ok ? p.reason : "", /自己底下/);
});
test("改名：找不到的荷札", () => {
  const p = planRename(idx0(), "沒有", "x");
  assert.equal(!p.ok && p.reason, "找不到這個荷札");
});
test("改名：新名稱不合法回 reason", () => {
  const p = planRename(idx0(), "高", "2026");
  assert.match(!p.ok ? p.reason : "", /數字/);
});
test("改名：只改大小寫＝同一個 key，只換顯示名", () => {
  const d = mini();
  d.tags.push({ key: "ai", name: "ai" });
  const p = ok(planRename(idxOf(d), "ai", "AI"));
  assert.equal(p.same, true);
  assert.equal(p.nameOnly, true);
  simulateRename(d, p);
  assert.equal(tagRow(d, "ai")?.name, "AI");
});
test("改名：保留內文裡原本的子段寫法", () => {
  assert.equal(rewriteTags("#AI/Tool", () => "#X"), "#X");
  const d = mini();
  d.tags.push({ key: "ai/tool", name: "AI/Tool" });
  d.notes[0].body = "#AI/Tool 好用";
  simulateRename(d, planRename(idxOf(d), "ai", "人工智慧"));
  assert.equal(d.notes[0].body, "#人工智慧/Tool 好用");
});
test("rewriteRaw：前 N 段換新、其餘原樣（含全形斜線）", () => {
  assert.equal(rewriteRaw("專案/搬家/打包", 2, "搬家"), "搬家/打包");
  assert.equal(rewriteRaw("高", 1, "難度/中"), "難度/中");
  assert.equal(rewriteRaw("ＡＩ／Tool", 1, "人工智慧"), "人工智慧/Tool");
});
test("改名：虛資料夾改成既有的名稱＝搬到它底下，不問併入", () => {
  const p = ok(planRename(idx0(), "專案", "高"));
  assert.equal(p.rootConflict, null);
  assert.deepEqual(p.conflicts, []);
  const d = mini();
  simulateRename(d, p);
  assert.ok(tagRow(d, "高/搬家/打包"));
  assert.ok(tagRow(d, "高"));
});
test("改名：子孫撞名 → conflicts（沒有 rootConflict 也要問）", () => {
  const d = mini();
  d.tags.push({ key: "家/搬家/打包", name: "家/搬家/打包" });
  const p = ok(planRename(idxOf(d), "專案", "家"));
  assert.equal(p.rootConflict, null);
  assert.deepEqual(p.conflicts, ["家/搬家/打包"]);
});
test("改名：虛資料夾也能改（子孫跟著搬）", () => {
  const d = mini();
  simulateRename(d, planRename(idxOf(d), "專案", "計畫"));
  assert.ok(tagRow(d, "計畫/搬家/打包"));
});
test("renameBody：同 key 的計畫不動內文", () => {
  const d = mini();
  d.tags.push({ key: "ai", name: "ai" });
  assert.equal(renameBody("#ai 在這", planRename(idxOf(d), "ai", "AI")), "#ai 在這");
});
test("renameBody：程式碼與網址裡的同名字不受影響", () => {
  const p = planRename(idx0(), "高", "難度/中");
  assert.equal(renameBody("`#高` https://x.com/#高 #高", p), "`#高` https://x.com/#高 #難度/中");
});
test("renameImpact：沒有東西掛著＝只改名稱；別線補「處別處」", () => {
  const d = mini();
  d.tags.push({ key: "空", name: "空" });
  assert.equal(renameImpact(planRename(idxOf(d), "空", "空的")), "沒有東西掛著，只改名稱");
  const idx = buildIndex({ tags: [{ id: "t", name: "x", key: "x" }], taggings: [{ tagId: "t", entityType: "timetable:block", entityId: "b1" }] });
  assert.equal(renameImpact(planRename(idx, "x", "y")), "會改動 1 處別處");
});
test("affectedCounts：kindOf 可由呼叫端給", () => {
  const c = affectedCounts(idx0(), ["高"], () => "car");
  assert.equal(c.car, 5);
  assert.equal(c.total, 5);
});
test("併入確認框（rootConflict）文案", () => {
  const t = mergeConfirmText(planRename(idx0(), "高", "難度/高"));
  assert.equal(t.title, "併入 #難度/高？");
  assert.match(t.body, /^#難度\/高 已經存在（掛著 2 處）。要把 #高 的 5 處併進去嗎？會改動 /);
  assert.ok(t.body.endsWith("。"));
});
test("併入確認框（子孫撞名）文案", () => {
  const d = mini();
  d.tags.push({ key: "家/搬家/打包", name: "家/搬家/打包" });
  const t = mergeConfirmText(planRename(idxOf(d), "專案", "家"));
  assert.equal(t.title, "連子荷札一起併入？");
  assert.match(t.body, /^#專案 底下有 1 個子荷札和既有的同名（例：#家\/搬家\/打包），改名後會併在一起。/);
});

/* ═══ 刪除（只有「整段字一起刪」，D-筆-39） ═══ */

test("刪除：預覽（摘下幾處、底下有東西的子荷札）", () => {
  const p = ok(planDelete(idx0(), "難度"));
  assert.equal(p.places, 3);
  assert.equal(p.kidsWithItems, 2);
  assert.equal(p.bodyCount, 1);
  assert.equal(p.childCount, 2);
});
test("刪除：整段字一起刪（不留雙空白）", () => {
  const d = mini();
  simulateDelete(d, planDelete(idxOf(d), "高"));
  assert.equal(d.notes[0].body, "今天 的事很多， #難度/高 也有。色 #AD3D2B 不算。");
  assert.equal(d.diaries[0].body, "開頭也算");
  assert.deepEqual(d.nodes[0].tags, ["難度/高"]);
  assert.equal(tagRow(d, "高"), null);
});
test("刪除：在行尾的荷札吃掉前面的空白", () => {
  assert.equal(removeTagText("打包 #專案/搬家/打包\n下一行", ["專案/搬家/打包"]), "打包\n下一行");
});
test("刪除：連子荷札一起（父層刪除）", () => {
  const d = mini();
  simulateDelete(d, planDelete(idxOf(d), "專案"));
  assert.equal(d.notes[1].body, "- 打包\n- 退租");
  assert.equal(idxOf(d).byKey["專案"], undefined);
});
test("刪除：程式碼裡的同名字不受影響", () => {
  assert.equal(removeTagText("`#高` 與 #高", ["高"]), "`#高` 與");
});
test("刪除：全形空白也吃一個", () => assert.equal(removeTagText("甲　#乙　丙", ["乙"]), "甲　丙"));
test("刪除：全形標點後的荷札（0-19）也刪得掉", () => assert.equal(removeTagText("好。#靈感 來了", ["靈感"]), "好。來了"));
test("刪除：找不到的荷札", () => assert.equal(planDelete(idx0(), "沒有").ok, false));
test("刪除例子：父層刪除時挑子荷札、附改後的句子", () => {
  const d = mini();
  const p = planDelete(idxOf(d), "專案");
  const ex = deleteExample(d.notes.map((n) => n.body), p);
  assert.deepEqual(ex, { raw: "專案/搬家/打包", before: "- 打包 #專案/搬家/打包", after: "- 打包" });
});
test("刪除例子：長句截 40 字、從荷札前 14 字起", () => {
  const body = "這是一段很長很長很長很長很長很長很長很長很長的前文，然後 #高 後面還有很長很長很長很長很長很長很長很長的字";
  const ex = deleteExample([body], planDelete(idx0(), "高"));
  assert.ok(ex);
  assert.ok(ex.before.startsWith("…") && ex.before.includes("#高"));
  assert.ok(!ex.after.includes("#高"));
  assert.ok(ex.before.length <= 42);
});
test("刪除例子：內文沒有寫到＝null", () => {
  assert.equal(deleteExample(["沒有荷札"], planDelete(idx0(), "高")), null);
});
test("刪除確認框：單一荷札", () => {
  const d = mini();
  const p = planDelete(idxOf(d), "高");
  const t = deleteConfirmText(p, deleteExample([...d.notes, ...d.diaries].map((x) => x.body), p));
  assert.equal(t.title, "刪除 #高？");
  assert.equal(t.body, "摘下 5 處。筆記與日記內文裡的 #高 會一起刪掉。例：『今天 #高 的事很多， #難度/高 也有。色 #AD3D2B 不算。』→『今天 的事很多， #難度/高 也有。色 #AD3D2B 不算。』。會改動 2 則筆記或日記的內文。");
});
test("刪除確認框：父層（連子）", () => {
  const d = mini();
  const p = planDelete(idxOf(d), "專案");
  const t = deleteConfirmText(p, deleteExample(d.notes.map((n) => n.body), p));
  assert.equal(t.title, "刪除 #專案，連同底下 2 個子荷札？");
  assert.match(t.body, /^摘下 2 處。#專案 和它的子荷札（例：#專案\/搬家\/打包）會從筆記與日記內文裡一起刪掉。例：/);
});
test("刪除確認框：父層自己也寫在內文（含子荷札）", () => {
  const d = mini();
  const p = planDelete(idxOf(d), "專案");
  assert.ok(p.ok && p.kidsWithItems > 0);
  const t = deleteConfirmText(p, { raw: "專案", before: "#專案 a", after: "a" });
  assert.equal(t.title, "刪除 #專案，連同底下 2 個子荷札？");
  assert.match(t.body, /^摘下 2 處。筆記與日記內文裡的 #專案（含子荷札） 會一起刪掉。例：/);
});
test("刪除確認框：沒有內文寫到", () => {
  const d = mini();
  const p = planDelete(idxOf(d), "重要/高");
  const t = deleteConfirmText(p, null);
  assert.equal(t.body, "摘下 1 處。筆記與日記內文裡的 #重要/高 會一起刪掉。目前沒有筆記或日記寫到它。");
});

/* ═══ 摘要、行內切段、顯示 ═══ */

test("摘要：荷札前後一小段", () => {
  const s = snippetAround("前面一大段文字很長很長很長 #高 後面", ["高"], 4);
  assert.equal(s.tag, "#高");
  assert.equal(s.pre, "…長很長");
  assert.equal(s.post, "後面");
});
test("摘要：沒有命中＝開頭一段", () => {
  const s = snippetAround("沒有荷札的一段字", ["高"], 2);
  assert.deepEqual(s, { pre: "沒有荷札", tag: "", post: "" });
});
test("行內切段：荷札、色碼、網址、程式碼", () => {
  const segs = inlineSegments("看 #高 與 #AD3D2B、https://x.com/#top、`#define`");
  assert.deepEqual(segs.map((s) => s.kind), ["text", "tag", "text", "url", "text", "code"]);
  const url = segs[3];
  assert.equal(url.kind === "url" && url.text, "https://x.com/#top");
  const code = segs[5];
  assert.equal(code.kind === "code" && code.text, "`#define`");
});
test("行內切段：拼回去等於原文", () => {
  const line = "（#靈感）寫在 https://a.b/c 與 `x` 之間 #讀書/日文。";
  const back = inlineSegments(line).map((s) => (s.kind === "tag" ? line.slice(s.occ.start, s.occ.end) : s.text)).join("");
  assert.equal(back, line);
});
test("行內切段：tag 段帶 occurrence（key 正規化）", () => {
  const s = inlineSegments("#ＡＩ/Tool")[0];
  assert.equal(s.kind, "tag");
  assert.equal(s.kind === "tag" && s.occ.key, "ai/tool");
});
test("行內切段：沒有任何特殊段＝一整段 text", () => assert.deepEqual(inlineSegments("平凡的一句"), [{ kind: "text", text: "平凡的一句" }]));
test("行內切段：空字串＝空陣列", () => assert.deepEqual(inlineSegments(""), []));
test("行內切段：網址尾巴的標點不算", () => {
  const segs = inlineSegments("見 https://x.com/a.");
  assert.deepEqual(segs.at(-1), { kind: "text", text: "." });
});
test("段落切段：圍欄裡的行不出小牌", () => {
  const out = inlineParagraphs([["```", "#include <x>", "```", "#高"]]);
  assert.deepEqual(out[0][1], [{ kind: "text", text: "#include <x>" }]);
  assert.equal(out[0][3][0].kind, "tag");
});
test("tagDisplayParts：父層與末段", () => {
  assert.deepEqual(tagDisplayParts("難度/高"), { parents: ["難度"], last: "高" });
  assert.deepEqual(tagDisplayParts("靈感"), { parents: [], last: "靈感" });
});

/* ═══ 清單分組（0-20） ═══ */

function nodeItem(id: string, status: string, scheduled_on: string | null, name = id, matched = ["高"], repeat_rule: string | null = null): TaggedItem {
  return { kind: "node", id, node: { id, name, kind: "ticket", route_id: null, status: status as "todo", scheduled_on, parent_id: null, repeat_rule }, matched };
}
function noteItem(id: string, kind: "note" | "diary", noted_at: string, entry_date: string | null = null, matched = ["高"]): TaggedItem {
  return { kind: "note", id, note: { id, kind, title: null, body: "", entry_date, noted_at }, matched };
}
test("分組：車票未完成在前（日期升冪、沒日期在後、再名稱），已完成另一組", () => {
  const g = groupTaggedItems([nodeItem("z", "todo", null), nodeItem("b", "todo", "2026-10-05"), nodeItem("a", "todo", "2026-10-05"), nodeItem("x", "done", "2026-10-01"), nodeItem("c", "doing", "2026-10-03")], null);
  assert.deepEqual(g.nodes.open.map((x) => x.id), ["c", "a", "b", "z"]);
  assert.deepEqual(g.nodes.done.map((x) => x.id), ["x"]);
});
test("分組：定期券（status 一路 todo）不算已完成；退役（done）算", () => {
  const g = groupTaggedItems([nodeItem("p", "todo", null, "p", ["高"], "weekly:1"), nodeItem("q", "done", null, "q", ["高"], "weekly:1")], null);
  assert.deepEqual(g.nodes.open.map((x) => x.id), ["p"]);
  assert.deepEqual(g.nodes.done.map((x) => x.id), ["q"]);
});
test("分組：筆記 noted_at 降冪、日記 entry_date 降冪", () => {
  const g = groupTaggedItems([noteItem("n1", "note", "2026-10-01T00:00:00Z"), noteItem("n2", "note", "2026-10-09T00:00:00Z"), noteItem("d1", "diary", "2026-10-02T00:00:00Z", "2026-10-02"), noteItem("d2", "diary", "2026-10-01T00:00:00Z", "2026-10-07")], null);
  assert.deepEqual(g.notes.map((x) => x.id), ["n2", "n1"]);
  assert.deepEqual(g.diaries.map((x) => x.id), ["d2", "d1"]);
});
test("分組：別線的列進 other", () => {
  const g = groupTaggedItems([{ kind: "other", entityType: "timetable:block", id: "b1", matched: ["高"] }], null);
  assert.equal(g.other.length, 1);
});
test("分組：看父層時附 rel（實際掛的子荷札相對名）", () => {
  const g = groupTaggedItems([nodeItem("a", "todo", null, "a", ["難度/高", "難度"]), nodeItem("b", "todo", null, "b", ["難度"])], "難度", (k) => (k === "難度/高" ? "難度/高" : k));
  assert.equal(g.nodes.open.find((x) => x.id === "a")?.rel, "高");
  assert.equal(g.nodes.open.find((x) => x.id === "b")?.rel, null);
});

/* ═══ 文案 ═══ */

test("通車提示條文案", () => assert.equal(backfillNotice(12, 30), "以前筆記與日記裡打的 #荷札 已經補掛上了：找到 12 個荷札、30 處。"));
test("toast 25：掛與摘、新建數；沒變動回 null", () => {
  assert.equal(setTagsToast(["a", "b"], [], 1), "掛上 #a、#b（新建 1 個）");
  assert.equal(setTagsToast(["a"], ["c"], 0), "掛上 #a；摘下 #c");
  assert.equal(setTagsToast([], [], 0), null);
});

/* ═══ 決定性 id（0-18） ═══ */

test("uuidv5：RFC 4122 範例（NAMESPACE_DNS, 'python.org'）", async () => {
  assert.equal(await uuidv5("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "python.org"), "886313e1-3b8a-5372-9b90-0c9aee199e5d");
});
test("uuidv5 與 syncRepository 的 occurrenceId 同一套演算法", async () => {
  // 「測的就是跑的」：從 syncRepository.ts 原始碼切出 occurrenceId 與兩個 helper、剝型別求值（該檔 import 了 Tauri，node 不能直接載）
  const src = readFileSync(new URL("../../src/data/syncRepository.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const grab = (re: RegExp) => {
    const m = re.exec(src);
    assert.ok(m, String(re));
    return m[0];
  };
  const code = [
    grab(/export const OCCURRENCE_ID_NAMESPACE = "[^"]+";/),
    grab(/export async function occurrenceId\([\s\S]*?\n}\n/),
    grab(/function hexToBytes\([\s\S]*?\n}\n/),
    grab(/function bytesToHex\([\s\S]*?\n}\n/),
  ].join("\n").replace(/^export /gm, "");
  const mod = new Function(stripTypeScriptTypes(code) + "\nreturn { occurrenceId, OCCURRENCE_ID_NAMESPACE };")() as {
    occurrenceId(n: string, d: string): Promise<string>;
    OCCURRENCE_ID_NAMESPACE: string;
  };
  assert.equal(await uuidv5(mod.OCCURRENCE_ID_NAMESPACE, "n1|" + TODAY), await mod.occurrenceId("n1", TODAY));
});
test("tagId 決定性：同 key 同 id、不同 key 不同 id、是 v5", async () => {
  const a = await tagId("難度/高");
  assert.equal(a, await tagId("難度/高"));
  assert.notEqual(a, await tagId("難度/低"));
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
test("taggingId 決定性：同 (type, entity, tag) 同 id", async () => {
  const t = await tagId("高");
  assert.equal(await taggingId("node", "x", t), await taggingId("node", "x", t));
  assert.notEqual(await taggingId("node", "x", t), await taggingId("note", "x", t));
});
test("收據：空收據判定", () => {
  const r = emptyReceipt();
  assert.equal(isEmptyReceipt(r), true);
  r.createdTagIds.push("x");
  assert.equal(isEmptyReceipt(r), false);
});
