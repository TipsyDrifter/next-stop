/**
 * 巢狀放寬與轉種類（丁 D-主-245／246；src/domain/node.ts）。
 * 跑法：`node --test scripts/tests/kind-convert.test.ts`（node 24，型別剝除；純函式）。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { allowedChildKinds, childKindSwaps, promotedKindForParent } from "../../src/domain/node.ts";
import { buildShelf } from "../../src/domain/depot.ts";
import type { NodeRow } from "../../src/domain/node.ts";

describe("巢狀規則", () => {
  test("支線底下可以直接放車票；路線底下的車票走根層＋路線標籤（不放進 allowedChildKinds('route')）", () => {
    assert.deepEqual(allowedChildKinds("branch"), ["branch", "train", "ticket"]);
    assert.ok(!allowedChildKinds("route").includes("ticket"));
    assert.ok(allowedChildKinds(null).includes("ticket"));
  });
});

describe("轉種類時直屬子項跟著換", () => {
  test("有車廂的列車轉支線：車廂改列車；車票照留", () => {
    assert.deepEqual(childKindSwaps("branch", ["car", "ticket", "car"]), { swaps: { car: "train" } });
  });
  test("支線轉列車：列車改車廂；車票照留；空的直接過", () => {
    assert.deepEqual(childKindSwaps("train", ["train", "ticket"]), { swaps: { train: "car" } });
    assert.deepEqual(childKindSwaps("train", []), { swaps: {} });
  });
  test("支線裡還有支線就擋下、說原因", () => {
    const r = childKindSwaps("train", ["branch", "train"]);
    assert.ok("why" in r);
    assert.match(r.why, /支線/);
  });
  test("討論 5：車票加子項時依其父節點決定升格為列車或車廂", () => {
    assert.equal(promotedKindForParent("route"), "train");
    assert.equal(promotedKindForParent("branch"), "train");
    assert.equal(promotedKindForParent(null), "train");
    assert.equal(promotedKindForParent("train"), "car");
    assert.equal(promotedKindForParent("car"), "car");
  });
  test("功能 2：buildShelf 保留底下無已到站路線的已到站幹線", () => {
    const emptyArrivedLine = {
      id: "L1",
      kind: "line",
      name: "空幹線",
      arrived_on: "2026-11-01",
      deleted_at: null,
      position: 0,
    } as unknown as NodeRow;
    const shelf = buildShelf([emptyArrivedLine], []);
    assert.equal(shelf.length, 1);
    assert.equal(shelf[0].type, "group");
    if (shelf[0].type === "group") {
      assert.equal(shelf[0].line.id, "L1");
      assert.deepEqual(shelf[0].routes, []);
    }
  });
});
