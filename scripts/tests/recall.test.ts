/**
 * 售票口④：備註記憶的比對與排序（src/domain/recall.ts；共用元件 RecallInput 的純函式半）。
 * 跑法：`node --test scripts/tests/recall.test.ts`。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rankRecall, recallKey, tallyRecall, type RecallItem } from "../../src/domain/recall.ts";

const texts = (hits: { item: RecallItem }[]) => hits.map((h) => h.item.text);

test("開頭對到排在中間對到前面；同一級比次數", () => {
  const items: RecallItem[] = [
    { text: "早餐 麥味登", count: 9 },
    { text: "麥當勞", count: 2 },
    { text: "麥味登", count: 5 },
  ];
  assert.deepEqual(texts(rankRecall(items, "麥")), ["麥味登", "麥當勞", "早餐 麥味登"]);
});

test("詞首（空白、標點後）排在字中間前面", () => {
  const items: RecallItem[] = [{ text: "大麥克", count: 9 }, { text: "午餐・麥當勞", count: 1 }];
  assert.deepEqual(texts(rankRecall(items, "麥")), ["午餐・麥當勞", "大麥克"]);
});

test("次數一樣比最近、再比短", () => {
  const items: RecallItem[] = [
    { text: "捷運 上學", count: 3, last: "2026-10-01" },
    { text: "捷運", count: 3, last: "2026-10-20" },
    { text: "捷運 回家", count: 3, last: "2026-10-20" },
  ];
  assert.deepEqual(texts(rankRecall(items, "捷")), ["捷運", "捷運 回家", "捷運 上學"]);
});

test("全形英數與大小寫視為一樣；加粗位置對回原字串", () => {
  const items: RecallItem[] = [{ text: "ＭＯＳ 摩斯" }, { text: "Costco 好市多" }];
  const hits = rankRecall(items, "mos");
  assert.deepEqual(texts(hits), ["ＭＯＳ 摩斯"]);
  assert.equal(hits[0].at, 0);
  assert.equal(hits[0].len, 3);
  const h2 = rankRecall(items, "  cost ");
  assert.equal(h2[0].item.text, "Costco 好市多");
  assert.equal(h2[0].at, 0);
  assert.equal(h2[0].len, 4);
});

test("跟打的字完全一樣的不列；鍵相同只留一個", () => {
  const items: RecallItem[] = [{ text: "午餐" }, { text: "午餐便當", count: 1 }, { text: "午餐便當 ", count: 4 }];
  const hits = rankRecall(items, "午餐");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].item.count, 4);
});

test("空字、不足最少字數、對不到 ⇒ 空", () => {
  const items: RecallItem[] = [{ text: "房租" }];
  assert.deepEqual(rankRecall(items, ""), []);
  assert.deepEqual(rankRecall(items, "   "), []);
  assert.deepEqual(rankRecall(items, "房", { minChars: 2 }), []);
  assert.deepEqual(rankRecall(items, "水電"), []);
});

test("limit 截斷", () => {
  const items = Array.from({ length: 20 }, (_, i): RecallItem => ({ text: `咖啡 ${i}`, count: i }));
  const hits = rankRecall(items, "咖啡", { limit: 6 });
  assert.equal(hits.length, 6);
  assert.equal(hits[0].item.text, "咖啡 19");
});

test("tallyRecall：併同鍵、數次數、字取最近那次", () => {
  const items = tallyRecall([
    { text: "ｍｏｓ", at: "2026-10-01" },
    { text: "MOS", at: "2026-10-09" },
    { text: "  ", at: "2026-10-10" },
    { text: "房租", at: "2026-10-05" },
  ]);
  const mos = items.find((x) => recallKey(x.text) === "mos");
  assert.ok(mos);
  assert.equal(mos.count, 2);
  assert.equal(mos.text, "MOS");
  assert.equal(mos.last, "2026-10-09");
  assert.equal(items.length, 2);
});

test("emoji 等多單位字不會讓加粗位置錯", () => {
  const items: RecallItem[] = [{ text: "🍜 拉麵" }];
  const hits = rankRecall(items, "拉");
  assert.equal(hits.length, 1);
  assert.equal(items[0].text.slice(hits[0].at, hits[0].at + hits[0].len), "拉");
});

test("boost 大的先，比對位置之前就比（時刻表⑦ 同分類優先）", () => {
  const items: RecallItem[] = [
    { text: "讀論文", count: 9 },
    { text: "讀書會選書", count: 1, boost: 1 },
    { text: "選書：讀完第三章", count: 1, boost: 1 },
  ];
  assert.deepEqual(texts(rankRecall(items, "讀")), ["讀書會選書", "選書：讀完第三章", "讀論文"]);
});
