// 手機殼班 D-主-74 長按拖曳排序的純算術（src/ui/mobile/reorderDrag.ts）
// 跑法：node --test scripts/tests/mobile-reorder-drag.test.ts（node 24 直接剝除型別；零 runtime import）
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  anchorAt,
  dropIndex,
  dropOffset,
  edgeScrollStep,
  indexOfAnchor,
  shiftOf,
  type Slot,
} from "../../src/ui/mobile/reorderDrag.ts";

/** ＝src/data/nodeRepository.ts 的 reorderIds（moveToday 的座標；那支檔 import 了 domain 目錄，node test 載不進來，照寫一份） */
function reorderIds(ids: string[], id: string, index: number): string[] {
  const rest = ids.filter((x) => x !== id);
  rest.splice(Math.max(0, Math.min(index, rest.length)), 0, id);
  return rest;
}

// 四張卡：高 60／80／60／60，列距 8
const SLOTS: Slot[] = [
  { top: 0, height: 60 },
  { top: 68, height: 80 },
  { top: 156, height: 60 },
  { top: 224, height: 60 },
];
const center = (from: number, dy: number) => SLOTS[from].top + SLOTS[from].height / 2 + dy;

test("dropIndex：沒動＝原位；越過下一張的中線才換格", () => {
  assert.equal(dropIndex(SLOTS, 0, center(0, 0)), 0);
  assert.equal(dropIndex(SLOTS, 0, center(0, 77)), 0); // 中心 107 < 第二張中線 108
  assert.equal(dropIndex(SLOTS, 0, center(0, 79)), 1);
  assert.equal(dropIndex(SLOTS, 0, center(0, 999)), 3); // 拖到底＝最後一格
  assert.equal(dropIndex(SLOTS, 3, center(3, -999)), 0); // 拖到頂
  assert.equal(dropIndex(SLOTS, 2, center(2, -50)), 2); // 中心 136 還在第二張中線 108 之下 ⇒ 原位
  assert.equal(dropIndex(SLOTS, 2, center(2, -90)), 1); // 中心 96 越過 108 ⇒ 換到第二格
});

test("dropIndex 的結果直接餵 reorderIds（moveToday 同一套座標）", () => {
  const ids = ["a", "b", "c", "d"];
  // a 往下拖過 b 的中線 ⇒ to=1 ⇒ b a c d
  assert.deepEqual(reorderIds(ids, "a", dropIndex(SLOTS, 0, center(0, 79))), ["b", "a", "c", "d"]);
  // d 往上拖過 b 的中線 ⇒ to=1 ⇒ a d b c
  assert.deepEqual(reorderIds(ids, "d", dropIndex(SLOTS, 3, center(3, -150))), ["a", "d", "b", "c"]);
  // 沒越過任何中線 ⇒ 原位、順序不變
  assert.deepEqual(reorderIds(ids, "c", dropIndex(SLOTS, 2, center(2, 10))), ids);
});

test("shiftOf：from 與 to 之間的卡讓一格，其餘不動", () => {
  const amt = 68;
  // 0 拖到 2：1、2 往上補
  assert.deepEqual([0, 1, 2, 3].map((i) => shiftOf(i, 0, 2, amt)), [0, -68, -68, 0]);
  // 3 拖到 1：1、2 往下讓
  assert.deepEqual([0, 1, 2, 3].map((i) => shiftOf(i, 3, 1, amt)), [0, 68, 68, 0]);
  // 原位：都不動
  assert.deepEqual([0, 1, 2, 3].map((i) => shiftOf(i, 2, 2, amt)), [0, 0, 0, 0]);
});

test("dropOffset：往下＝框底對齊第 to 張底；往上＝框頂對齊第 to 張頂", () => {
  assert.equal(dropOffset(SLOTS, 0, 0), 0);
  assert.equal(dropOffset(SLOTS, 0, 1), 68 + 80 - 60 - 0); // 88
  assert.equal(dropOffset(SLOTS, 0, 3), 224 + 60 - 60); // 224
  assert.equal(dropOffset(SLOTS, 3, 1), 68 - 224);
  // 跟讓位一致：0 拖到 1，第二張上移 68（=60+8）後底在 80，框頂 88 ⇒ 中間剛好一個列距 8
  assert.equal(dropOffset(SLOTS, 0, 1) - (SLOTS[1].top - 68 + SLOTS[1].height), 8);
});

test("edgeScrollStep：上下緣感應帶內才捲，越深越快、有上限", () => {
  assert.equal(edgeScrollStep(300, 100, 700), 0);
  assert.ok(edgeScrollStep(120, 100, 700) < 0);
  assert.ok(edgeScrollStep(690, 100, 700) > 0);
  assert.equal(edgeScrollStep(0, 100, 700), -12);
  assert.equal(edgeScrollStep(900, 100, 700), 12);
  assert.ok(Math.abs(edgeScrollStep(150, 100, 700)) < Math.abs(edgeScrollStep(110, 100, 700)));
});

// ── 第二輪：落點換成鄰居錨（拖曳中清單被重載也不落錯格；反方評審 correctness minor，mock 重現過） ──

test("anchorAt：落點的上下鄰居（拿掉自己之後；頂／底＝null）", () => {
  const ids = ["a", "b", "c", "d"];
  assert.deepEqual(anchorAt(ids, "d", 1), { after: "a", before: "b" });
  assert.deepEqual(anchorAt(ids, "a", 0), { after: null, before: "b" });
  assert.deepEqual(anchorAt(ids, "a", 3), { after: "d", before: null });
  assert.deepEqual(anchorAt(["a"], "a", 0), { after: null, before: null });
});

test("indexOfAnchor：清單沒變＝跟 dropIndex 一樣的 index（換算前後同一格）", () => {
  const ids = ["a", "b", "c", "d"];
  for (const id of ids) {
    for (let to = 0; to < ids.length; to++) {
      assert.equal(indexOfAnchor(ids, id, anchorAt(ids, id, to)), to);
    }
  }
});

test("indexOfAnchor：拖曳中上面多了一張（同步／別台改順序）⇒ 照樣落在 A 的後面（舊做法交 index 會落到 A 前面）", () => {
  const snap = ["a", "b", "c", "d"]; // 抬起那一刻
  const at = anchorAt(snap, "d", 1); // 拖到 a、b 之間
  const latest = ["x", "a", "b", "c", "d"]; // 放開前清單重載
  const to = indexOfAnchor(latest, "d", at)!;
  assert.deepEqual(reorderIds(latest, "d", to), ["x", "a", "d", "b", "c"]);
  assert.deepEqual(reorderIds(latest, "d", 1), ["x", "d", "a", "b", "c"]); // 舊做法（快照 index）＝落錯格
});

test("indexOfAnchor：上鄰居不在了認下鄰居；頂／底那一側沒鄰居照樣頂／底；兩邊都不在＝null", () => {
  assert.equal(indexOfAnchor(["b", "c", "d"], "d", { after: "a", before: "b" }), 0); // a 被刪：插在 b 前
  assert.equal(indexOfAnchor(["x", "b", "c", "d"], "d", { after: null, before: "a" }), 0); // 放在頂、a 不在：還是頂
  assert.equal(indexOfAnchor(["a", "b", "x"], "a", { after: "d", before: null }), 2); // 放在底、d 不在：還是底
  assert.equal(indexOfAnchor(["x", "y", "d"], "d", { after: "a", before: "b" }), null);
});
