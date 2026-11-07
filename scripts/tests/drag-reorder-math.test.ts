// 回饋乙：共用拖曳元件的純算術（src/ui/common/dragReorder/dragMath.ts）
// 跑法：node --test scripts/tests/drag-reorder-math.test.ts（node 24 直接剝除型別；零 runtime import）
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  anchorOfGap,
  depthAt,
  depthRange,
  isColumnGapNoop,
  gapAt,
  gapY,
  indexOfAnchor,
  isSwipe,
  nearestValidDepth,
  treePlace,
  type TreeRow,
} from "../../src/ui/common/dragReorder/dragMath.ts";

const slots = [0, 50, 100].map((top) => ({ top, height: 40 }));

test("gapAt：中線以上算前一個縫", () => {
  assert.equal(gapAt(slots, -5), 0);
  assert.equal(gapAt(slots, 19), 0);
  assert.equal(gapAt(slots, 21), 1);
  assert.equal(gapAt(slots, 75), 2);
  assert.equal(gapAt(slots, 500), 3);
});

test("gapY：頭貼頂、尾貼底、中間取縫中點", () => {
  assert.equal(gapY(slots, 0), 0);
  assert.equal(gapY(slots, 1), 45);
  assert.equal(gapY(slots, 3), 140);
  assert.equal(gapY([], 0), 0);
});

test("anchorOfGap／indexOfAnchor：清單被重載也落在同一對鄰居之間", () => {
  const rest = ["A", "B", "C"].map((id) => ({ id }));
  const a = anchorOfGap(rest, 2); // B 與 C 之間
  assert.deepEqual(a, { after: "B", before: "C" });
  // 拖曳中上面多了一張 Z
  assert.equal(indexOfAnchor(["Z", "A", "B", "X", "C"], "X", a), 3);
  // 上鄰居不在了 → 認下鄰居
  assert.equal(indexOfAnchor(["A", "C", "X"], "X", a), 1);
  // 兩邊都不在 → null
  assert.equal(indexOfAnchor(["A", "X"], "X", { after: "Q", before: "R" }), null);
  // 頭／尾
  assert.equal(indexOfAnchor(["A", "B", "X"], "X", { after: null, before: "Q" }), 0);
  assert.equal(indexOfAnchor(["A", "B", "X"], ["X"], { after: "Q", before: null }), 2);
});

// 樹：R1(0) ├ T1(1) │ └ c1(2) └ T2(1)   R2(0)
const tree: TreeRow[] = [
  { id: "R1", depth: 0 },
  { id: "T1", depth: 1 },
  { id: "c1", depth: 2 },
  { id: "T2", depth: 1 },
  { id: "R2", depth: 0 },
];

test("isColumnGapNoop：連著的一批放回原縫才算沒動；不連續的放在第一張旁邊是有動", () => {
  const col = ["a", "b", "c", "d"];
  assert.equal(isColumnGapNoop(col, ["b"], { after: "a", before: "c" }), true);
  assert.equal(isColumnGapNoop(col, ["b", "c"], { after: "a", before: "d" }), true);
  assert.equal(isColumnGapNoop(col, ["a"], { after: null, before: "b" }), true);
  assert.equal(isColumnGapNoop(col, ["d"], { after: "c", before: null }), true);
  assert.equal(isColumnGapNoop(col, ["b"], { after: "c", before: "d" }), false);
  assert.equal(isColumnGapNoop(col, ["b", "d"], { after: "a", before: "c" }), false, "不連續");
  assert.equal(isColumnGapNoop(col, ["x"], { after: null, before: null }), false);
});

test("depthRange：最深＝上一列下一層、最淺＝下一列那層", () => {
  assert.deepEqual(depthRange(tree, 0), { min: 0, max: 0 });
  assert.deepEqual(depthRange(tree, 3), { min: 1, max: 3 }); // c1 與 T2 之間
  assert.deepEqual(depthRange(tree, 4), { min: 0, max: 2 }); // T2 與 R2 之間
  assert.deepEqual(depthRange(tree, 5), { min: 0, max: 1 }); // 最後
});

test("depthAt：左右位移換層，夾在範圍裡", () => {
  assert.equal(depthAt({ min: 1, max: 3 }, 1, 60, 28), 3);
  assert.equal(depthAt({ min: 1, max: 3 }, 1, 20, 28), 2);
  assert.equal(depthAt({ min: 1, max: 3 }, 1, -200, 28), 1);
});

test("treePlace：父節點與上下兄弟", () => {
  assert.deepEqual(treePlace(tree, 3, 2), { depth: 2, parent: "T1", after: "c1", before: null });
  assert.deepEqual(treePlace(tree, 3, 1), { depth: 1, parent: "R1", after: "T1", before: "T2" });
  assert.deepEqual(treePlace(tree, 4, 0), { depth: 0, parent: null, after: "R1", before: "R2" });
  assert.deepEqual(treePlace(tree, 4, 1), { depth: 1, parent: "R1", after: "T2", before: null });
  assert.deepEqual(treePlace(tree, 0, 0), { depth: 0, parent: null, after: null, before: "R1" });
  assert.deepEqual(treePlace(tree, 1, 1), { depth: 1, parent: "R1", after: null, before: "T1" });
});

test("nearestValidDepth：偏好的層不行就往兩側找", () => {
  assert.equal(nearestValidDepth({ min: 0, max: 3 }, 2, (d) => d === 2), 2);
  assert.equal(nearestValidDepth({ min: 0, max: 3 }, 2, (d) => d === 1 || d === 3), 1);
  assert.equal(nearestValidDepth({ min: 0, max: 3 }, 0, (d) => d === 3), 3);
  assert.equal(nearestValidDepth({ min: 0, max: 3 }, 1, () => false), null);
});

test("isSwipe：橫向夠遠且明顯比縱向大", () => {
  assert.equal(isSwipe(20, 3), true);
  assert.equal(isSwipe(-20, 3), true);
  assert.equal(isSwipe(20, 18), false);
  assert.equal(isSwipe(8, 0), false);
});
