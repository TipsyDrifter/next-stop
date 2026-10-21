/**
 * 路線頭統計——桌機大綱頁首與手機路線圖抬頭同一把尺（磨光⑤ N12；src/domain/routeHead.ts）。
 * 跑法：`node --test scripts/tests/route-head.test.ts`（node 24，型別剝除；零依賴）。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { flattenSubtrees, isRouteNodeDone, routeHeadStats, routeHeadTicketText } from "../../src/domain/routeHead.ts";

interface N {
  id: string;
  kind: string;
  status: string;
}
const n = (id: string, kind: string, status = "todo"): N => ({ id, kind, status });

/** 日文路線：列車 T1 ⊃ 車廂 C1（未済）⊃ 車票 a,b；車票 c（直屬列車）；車票 r（重複任務） */
function japanese() {
  const nodes = [n("T1", "train"), n("C1", "car"), n("a", "ticket", "done"), n("b", "ticket"), n("c", "ticket"), n("r", "ticket")];
  const byId = Object.fromEntries(nodes.map((x) => [x.id, x]));
  const childrenOf: Record<string, string[]> = { T1: ["C1", "c", "r"], C1: ["a", "b"] };
  return { nodes, byId, childrenOf, roots: ["T1"] };
}

describe("routeHeadStats", () => {
  test("分母只數車票：未済的車廂、列車不算車票", () => {
    const j = japanese();
    const s = routeHeadStats(j.nodes, (x) => x.status === "done");
    assert.equal(s.ticketTotal, 4);
    assert.equal(s.ticketDone, 1);
    assert.equal(s.items, 6);
    assert.equal(s.pct, 25);
  });

  test("重複任務今天這班済了：isDone 判得過，就算 nodes.status 還是 todo", () => {
    const j = japanese();
    const doneOccurrence = new Set(["r"]);
    const s = routeHeadStats(j.nodes, (x) => (doneOccurrence.has(x.id) ? true : x.status === "done"));
    assert.equal(s.ticketDone, 2);
    assert.equal(s.ticketTotal, 4);
    assert.equal(s.pct, 50);
  });

  test("車廂 status 為 done 也不灌進車票分子", () => {
    const nodes = [n("C", "car", "done"), n("t", "ticket")];
    const s = routeHeadStats(nodes, (x) => x.status === "done");
    assert.deepEqual(s, { ticketDone: 0, ticketTotal: 1, pct: 0, items: 2 });
  });

  test("沒有車票：pct=0、手機文字為空", () => {
    const s = routeHeadStats([n("T", "train")], () => true);
    assert.deepEqual(s, { ticketDone: 0, ticketTotal: 0, pct: 0, items: 1 });
    assert.equal(routeHeadTicketText(s), "");
  });

  test("空清單", () => {
    assert.deepEqual(routeHeadStats([], () => true), { ticketDone: 0, ticketTotal: 0, pct: 0, items: 0 });
  });

  test("pct 四捨五入：1/3 → 33、2/3 → 67", () => {
    const three = [n("a", "ticket"), n("b", "ticket"), n("c", "ticket")];
    assert.equal(routeHeadStats(three, (x) => x.id === "a").pct, 33);
    assert.equal(routeHeadStats(three, (x) => x.id !== "c").pct, 67);
  });

  test("手機文字：車票 d/t 済", () => {
    const j = japanese();
    assert.equal(routeHeadTicketText(routeHeadStats(j.nodes, (x) => x.status === "done")), "車票 1/4 済");
  });
});

describe("flattenSubtrees", () => {
  test("整棵子樹攤平（含根），兩殼走同一份分子分母", () => {
    const j = japanese();
    const flat = flattenSubtrees(j, j.roots);
    assert.deepEqual(flat.map((x) => x.id).sort(), ["C1", "T1", "a", "b", "c", "r"]);
    const viaTree = routeHeadStats(flat, (x) => x.status === "done");
    const viaList = routeHeadStats(j.nodes, (x) => x.status === "done");
    assert.deepEqual(viaTree, viaList);
  });

  test("zoom 進車廂：只算那一子樹", () => {
    const j = japanese();
    const s = routeHeadStats(flattenSubtrees(j, j.childrenOf.C1), (x) => x.status === "done");
    assert.deepEqual(s, { ticketDone: 1, ticketTotal: 2, pct: 50, items: 2 });
  });

  test("樹裡找不到的 id 略過", () => {
    const j = japanese();
    assert.equal(flattenSubtrees(j, ["ghost"]).length, 0);
  });
});

describe("isRouteNodeDone（手機路線圖用的共用済規則）", () => {
  test("有目前班次 ⇒ 看班次結局，不看 nodes.status", () => {
    assert.equal(isRouteNodeDone({ id: "a", status: "todo" }, { a: { status: "done" } }), true);
    assert.equal(isRouteNodeDone({ id: "a", status: "done" }, { a: { status: "skipped" } }), false);
  });
  test("沒有目前班次 ⇒ 看 nodes.status", () => {
    assert.equal(isRouteNodeDone({ id: "a", status: "done" }, {}), true);
    assert.equal(isRouteNodeDone({ id: "a", status: "todo" }, {}), false);
  });
});
