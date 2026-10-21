// 磨光⑤ B1「移動到…」純邏輯單元測試（契約 docs/research/2026-10-21-主線-磨光⑤核心第二班-契約.md §1 B1、§3）
// 跑法：node --test scripts/tests/move-to.test.ts（node 24 直接剝除型別；只載 src/domain/moveTo.ts 與 node.ts，兩檔都零 runtime import）
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendIndex,
  currentDest,
  destParentId,
  excludeSubtree,
  isSameParent,
  moveTargetRule,
  moveToastText,
  pruneToSelectable,
} from "../../src/domain/moveTo.ts";
import { allowedChildKinds, type NodeKind } from "../../src/domain/node.ts";

/* ───────── 依種類能挑的新父節點 ───────── */

test("moveTargetRule：車票、車廂 → 列車／車廂，路線本身不可選", () => {
  for (const k of ["ticket", "car"] as const) {
    const r = moveTargetRule(k);
    assert.ok(r);
    assert.equal(r.depth, "node");
    assert.deepEqual(r.kinds, ["train", "car"]);
    assert.equal(r.routeSelectable, false);
  }
});

test("moveTargetRule：列車、支線 → 路線／支線", () => {
  for (const k of ["train", "branch"] as const) {
    const r = moveTargetRule(k);
    assert.ok(r);
    assert.equal(r.depth, "node");
    assert.deepEqual(r.kinds, ["branch"]);
    assert.equal(r.routeSelectable, true);
  }
});

test("moveTargetRule：站 → 只挑路線；幹線、路線不出入口", () => {
  const r = moveTargetRule("station");
  assert.ok(r);
  assert.equal(r.depth, "route");
  assert.equal(r.routeSelectable, true);
  assert.equal(moveTargetRule("line"), null);
  assert.equal(moveTargetRule("route"), null);
});

test("moveTargetRule 與 allowedChildKinds 一致：挑得到的父節點都允許掛這個種類（repository 不會擋）", () => {
  const kinds: NodeKind[] = ["branch", "train", "car", "ticket", "station"];
  for (const k of kinds) {
    const r = moveTargetRule(k);
    assert.ok(r, k);
    const parents: NodeKind[] = [...r.kinds, ...(r.routeSelectable ? (["route"] as const) : [])];
    assert.ok(parents.length > 0, k);
    for (const p of parents) assert.ok(allowedChildKinds(p).includes(k), `${k} 掛在 ${p} 底下應被允許`);
  }
});

/* ───────── 子樹排除 ───────── */

// 前序攤平（flattenAttachTree 的形狀）：
//   支A(0) ─ 列1(1) ─ 廂1a(2) ─ 廂1a-i(3)
//                   └ 廂1b(2)
//          └ 列2(1)
//   列3(0)
const T = [
  { id: "A", depth: 0, selectable: true },
  { id: "t1", depth: 1, selectable: true },
  { id: "c1a", depth: 2, selectable: true },
  { id: "c1ai", depth: 3, selectable: true },
  { id: "c1b", depth: 2, selectable: true },
  { id: "t2", depth: 1, selectable: true },
  { id: "t3", depth: 0, selectable: true },
];
const ids = (xs: readonly { id: string }[]) => xs.map((x) => x.id);

test("excludeSubtree：藏掉自己與整個子樹，兄弟與叔伯留著", () => {
  assert.deepEqual(ids(excludeSubtree(T, "t1")), ["A", "t2", "t3"]);
  assert.deepEqual(ids(excludeSubtree(T, "c1a")), ["A", "t1", "c1b", "t2", "t3"]);
  assert.deepEqual(ids(excludeSubtree(T, "A")), ["t3"]);
});

test("excludeSubtree：最後一列、葉節點、不在清單裡、沒給 id", () => {
  assert.deepEqual(ids(excludeSubtree(T, "t3")), ["A", "t1", "c1a", "c1ai", "c1b", "t2"]);
  assert.deepEqual(ids(excludeSubtree(T, "c1ai")), ["A", "t1", "c1a", "c1b", "t2", "t3"]);
  assert.deepEqual(ids(excludeSubtree(T, "nope")), ids(T));
  assert.deepEqual(ids(excludeSubtree(T, undefined)), ids(T));
  assert.notEqual(excludeSubtree(T, undefined), T); // 回新陣列，不回傳原陣列本身
});

/* ───────── 只留挑得到的與其群組頭 ───────── */

test("pruneToSelectable：搬列車＝只有支線能挑，別的列車、車廂拿掉，支線的祖先群組頭留著", () => {
  const opts = [
    { id: "b1", depth: 0, selectable: true },
    { id: "t1", depth: 1, selectable: false },
    { id: "c1", depth: 2, selectable: false },
    { id: "b2", depth: 1, selectable: true },
    { id: "t9", depth: 0, selectable: false },
    { id: "c9", depth: 1, selectable: false },
  ];
  assert.deepEqual(ids(pruneToSelectable(opts)), ["b1", "b2"]);
});

test("pruneToSelectable：挑得到的深層節點會把每一層祖先帶上", () => {
  const opts = [
    { id: "b1", depth: 0, selectable: false },
    { id: "t1", depth: 1, selectable: false },
    { id: "x", depth: 2, selectable: false },
    { id: "c1", depth: 2, selectable: true },
    { id: "b2", depth: 0, selectable: false },
  ];
  assert.deepEqual(ids(pruneToSelectable(opts)), ["b1", "t1", "c1"]);
});

test("pruneToSelectable：全部可選＝原樣；全部不可選＝空", () => {
  assert.deepEqual(ids(pruneToSelectable(T)), ids(T));
  assert.deepEqual(pruneToSelectable(T.map((o) => ({ ...o, selectable: false }))), []);
});

/* ───────── 落點 ───────── */

test("appendIndex：新父節點的最後一個（max(position)+1；沒有子節點＝0；有洞照 max）", () => {
  assert.equal(appendIndex([]), 0);
  assert.equal(appendIndex([{ position: 0 }, { position: 1 }]), 2);
  assert.equal(appendIndex([{ position: 5 }, { position: 2 }]), 6);
});

/* ───────── 目前位置 ───────── */

test("destParentId／isSameParent：挑路線本身＝路線 id；挑節點＝節點 id；臨時車票永遠是新位置", () => {
  assert.equal(destParentId({ routeId: "R", nodeId: null }), "R");
  assert.equal(destParentId({ routeId: "R", nodeId: "T" }), "T");
  assert.equal(isSameParent({ routeId: "R", nodeId: null }, "R"), true);
  assert.equal(isSameParent({ routeId: "R", nodeId: "T" }, "T"), true);
  assert.equal(isSameParent({ routeId: "R", nodeId: "T2" }, "T"), false);
  assert.equal(isSameParent({ routeId: "R2", nodeId: null }, "R"), false);
  assert.equal(isSameParent({ routeId: "R", nodeId: null }, null), false);
});

test("currentDest：父節點是路線／列車／根層", () => {
  assert.deepEqual(currentDest("R", "route", "R"), { routeId: "R", nodeId: null, nodeKind: "route" });
  assert.deepEqual(currentDest("T", "train", "R"), { routeId: "R", nodeId: "T", nodeKind: "train" });
  assert.deepEqual(currentDest("B", "branch", "R"), { routeId: "R", nodeId: "B", nodeKind: "branch" });
  // 臨時車票：沒有目前位置（nodeKind null），只帶路線標籤讓挑選器先展開那條路線
  assert.deepEqual(currentDest(null, null, "R"), { routeId: "R", nodeId: null, nodeKind: null });
  assert.deepEqual(currentDest(null, null, null), { routeId: null, nodeId: null, nodeKind: null });
});

test("moveToastText：路線・父節點；直接掛路線只寫路線名", () => {
  assert.equal(moveToastText("英文", "閱讀"), "已移到「英文・閱讀」");
  assert.equal(moveToastText("英文", null), "已移到「英文」");
  assert.equal(moveToastText(null, null), "已移動");
});
