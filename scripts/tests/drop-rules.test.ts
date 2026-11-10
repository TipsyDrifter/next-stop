// 回饋乙：路線圖拖曳的落點規則（src/domain/dropRules.ts）
// 跑法：node --test scripts/tests/drop-rules.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { adaptTo, childKinds, dropVerdict, type DropTree } from "../../src/domain/dropRules.ts";
import { allowedChildKinds, type NodeKind } from "../../src/domain/node.ts";

test("childKinds 與 allowedChildKinds 同表", () => {
  for (const k of ["line", "route", "branch", "train", "car", "ticket", "station"] as NodeKind[]) {
    assert.deepEqual(childKinds(k), allowedChildKinds(k), k);
  }
});

test("adaptTo：列車⇄車廂跟著位置換；車票當落點時視同車廂（自動升格）", () => {
  assert.equal(adaptTo("car", "route"), "train");
  assert.equal(adaptTo("train", "train"), "car");
  assert.equal(adaptTo("ticket", "route"), null);
  assert.equal(adaptTo("branch", "train"), null);
  assert.equal(adaptTo("ticket", "ticket"), "ticket");
  assert.equal(adaptTo("train", "ticket"), "car");
  assert.equal(adaptTo("car", "ticket"), "car");
});

// 路線 R ├ T1(列車) │ └ k1(車票) ├ B1(支線) │ └ T2(列車)  ＋臨時票 X（parent null）
const tree: DropTree = {
  byId: {
    T1: { id: "T1", kind: "train", parent_id: "R" },
    k1: { id: "k1", kind: "ticket", parent_id: "T1" },
    B1: { id: "B1", kind: "branch", parent_id: "R" },
    T2: { id: "T2", kind: "train", parent_id: "B1" },
    X: { id: "X", kind: "ticket", parent_id: null },
  },
  childrenOf: { R: ["T1", "B1"], T1: ["k1"], B1: ["T2"] },
};
const top = { id: "R", kind: "route" as NodeKind };

test("車票：進列車、進支線、拖上路線最上層都可以（丁 D-主-245；路線最上層＝掛路線標籤的根層車票）", () => {
  assert.deepEqual(dropVerdict(tree, top, ["k1"], "T2"), { ok: true, parentId: "T2" });
  assert.deepEqual(dropVerdict(tree, top, ["k1"], null), { ok: true, parentId: "R" });
  assert.deepEqual(dropVerdict(tree, top, ["X"], null), { ok: true, parentId: "R" });
  assert.deepEqual(dropVerdict(tree, top, ["k1"], "B1"), { ok: true, parentId: "B1" });
});

test("討論 5：樹內車票底下可放車票／列車（自動升格為列車或車廂）；無路線臨時車票與支線進車票／列車則擋下", () => {
  assert.deepEqual(dropVerdict(tree, top, ["T2"], "k1"), { ok: true, parentId: "k1" });
  assert.equal(dropVerdict(tree, top, ["B1"], "k1").ok, false);
  assert.equal(dropVerdict(tree, top, ["T2"], "X").ok, false);
  assert.equal(dropVerdict(tree, top, ["B1"], "T1").ok, false);
});

test("列車進支線、支線進支線可以；不能放進自己底下", () => {
  assert.deepEqual(dropVerdict(tree, top, ["T1"], "B1"), { ok: true, parentId: "B1" });
  assert.deepEqual(dropVerdict(tree, top, ["B1"], "T2"), { ok: false, why: "不能放進自己底下" });
  assert.deepEqual(dropVerdict(tree, top, ["T1"], "T2"), { ok: true, parentId: "T2" }); // 列車進列車＝變車廂
});

test("聚焦時最上層＝聚焦的節點", () => {
  assert.deepEqual(dropVerdict(tree, { id: "T1", kind: "train" }, ["T2"], null), { ok: true, parentId: "T1" });
});

test("多張一起：有一張放不下就整批不行", () => {
  assert.equal(dropVerdict(tree, top, ["T2", "B1"], "T1").ok, false);
});
