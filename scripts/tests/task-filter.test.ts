// ⑫ 看板與篩選：篩選條件、排序、常用篩選的解析（src/domain/taskFilter.ts）、看板分欄（src/domain/board.ts）
// 跑法：node --test scripts/tests/task-filter.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TASK_FILTER,
  followTagRenames,
  TEMP_ROUTE,
  isDefaultTaskFilter,
  isTaskLate,
  matchTask,
  parseSavedFilters,
  serializeSavedFilters,
  routeKeyOf,
  sortTasks,
  type TaskFilter,
  type TaskFilterCtx,
  type TaskNode,
} from "../../src/domain/taskFilter.ts";
import { CONFLICT_COL_LABEL, describeConflict } from "../../src/domain/node.ts";
import { DONE_COLUMN_LIMIT, SUB_ROW, TOP_COL, boardCards, cardStatus, effectiveStation, isVisibleCard, recentDoneCards, resolveTrainDrop, stationColumns, statusColumns, trainColumns, trainDropPlace, type BoardNode } from "../../src/domain/board.ts";

const TODAY = "2026-11-06";

function task(id: string, patch: Partial<TaskNode> = {}): TaskNode {
  return {
    id,
    kind: "ticket",
    parent_id: "t1",
    route_id: "r1",
    status: "todo",
    scheduled_on: null,
    due_on: null,
    priority: "mid",
    updated_at: "2026-11-01T00:00:00.000Z",
    ...patch,
  };
}

function ctx(patch: Partial<TaskFilterCtx> = {}): TaskFilterCtx {
  return { today: TODAY, occurrences: {}, tagsOf: () => [], depot: new Set(), ...patch };
}

const f = (patch: Partial<TaskFilter>): TaskFilter => ({ ...DEFAULT_TASK_FILTER, ...patch });

test("預設條件：未済都留下、済不留", () => {
  assert.equal(isDefaultTaskFilter(DEFAULT_TASK_FILTER), true);
  assert.equal(matchTask(task("a"), DEFAULT_TASK_FILTER, ctx()), true);
  assert.equal(matchTask(task("a", { status: "done" }), DEFAULT_TASK_FILTER, ctx()), false);
  assert.equal(matchTask(task("a", { status: "done" }), f({ status: "all" }), ctx()), true);
});

test("路線：同組任一；臨時車票＝沒路線；掛路線標籤的算那條路線", () => {
  const loose = task("a", { parent_id: null, route_id: null });
  const tagged = task("b", { parent_id: null, route_id: "r2" });
  assert.equal(matchTask(loose, f({ routes: [TEMP_ROUTE] }), ctx()), true);
  assert.equal(matchTask(tagged, f({ routes: [TEMP_ROUTE] }), ctx()), false);
  assert.equal(matchTask(tagged, f({ routes: ["r1", "r2"] }), ctx()), true);
  assert.equal(matchTask(task("c"), f({ routes: ["r2"] }), ctx()), false);
});

test("車庫：沒選路線不算車庫裡的，明確選了才算", () => {
  const c = ctx({ depot: new Set(["r1"]) });
  assert.equal(matchTask(task("a"), DEFAULT_TASK_FILTER, c), false);
  assert.equal(matchTask(task("a"), f({ routes: ["r1"] }), c), true);
});

test("荷札：父含子、同組任一", () => {
  const c = ctx({ tagsOf: (id) => (id === "a" ? ["讀書/文法"] : []) });
  assert.equal(matchTask(task("a"), f({ tags: ["讀書"] }), c), true);
  assert.equal(matchTask(task("a"), f({ tags: ["工作", "讀書/文法"] }), c), true);
  assert.equal(matchTask(task("a"), f({ tags: ["工作"] }), c), false);
  assert.equal(matchTask(task("b"), f({ tags: ["讀書"] }), c), false);
});

test("指到已刪的條件不參與比對", () => {
  const c = ctx({ aliveRoute: (id) => id !== "gone", aliveTag: (k) => k !== "gone" });
  assert.equal(matchTask(task("a"), f({ routes: ["gone"] }), c), true);
  assert.equal(matchTask(task("a"), f({ tags: ["gone"] }), c), true);
});

test("路線刪了、票還掛著標籤：算臨時車票，選已刪路線與臨時車票都比得到該比的", () => {
  const c = ctx({ aliveRoute: (id) => id !== "gone" });
  const orphan = task("a", { parent_id: null, route_id: "gone" });
  assert.equal(matchTask(orphan, f({ routes: [TEMP_ROUTE] }), c), true, "選臨時車票比得到");
  assert.equal(matchTask(orphan, DEFAULT_TASK_FILTER, c), true);
  assert.equal(matchTask(orphan, f({ routes: ["r1"] }), c), false);
  assert.equal(routeKeyOf(orphan, c.aliveRoute), TEMP_ROUTE);
  assert.equal(routeKeyOf(orphan), "gone", "沒給判準照原值（存檔不改寫）");
});

test("有子項的列車：只有「誤點」條件收，而且要真的誤點", () => {
  const past = "2026-11-01";
  const lateTrain = task("t", { kind: "train", has_kids: true, due_on: past });
  const okTrain = task("u", { kind: "train", has_kids: true });
  assert.equal(matchTask(lateTrain, DEFAULT_TASK_FILTER, ctx()), false);
  assert.equal(matchTask(lateTrain, f({ due: "overdue" }), ctx()), false);
  assert.equal(matchTask(lateTrain, f({ status: "all" }), ctx()), false);
  assert.equal(matchTask(lateTrain, f({ late: true }), ctx()), true);
  assert.equal(matchTask(okTrain, f({ late: true }), ctx()), false);
  assert.equal(matchTask(lateTrain, f({ late: true, routes: ["r2"] }), ctx()), false, "其他條件照舊");
});

test("跳轉落點：看得到的卡才算；有子項、隱藏中的済、支線都不算", () => {
  const n2 = (id: string, kind: BoardNode["kind"], status: BoardNode["status"] = "todo"): BoardNode => ({ id, kind, parent_id: "R", name: id, status });
  const t = {
    byId: { a: n2("a", "ticket"), d: n2("d", "ticket", "done"), T: n2("T", "train"), E: n2("E", "train"), B: n2("B", "branch"), p: n2("p", "ticket") },
    childrenOf: { T: ["a"] },
  };
  assert.equal(isVisibleCard(t, "a", undefined, true), true);
  assert.equal(isVisibleCard(t, "T", undefined, true), false, "有子項的列車不是卡");
  assert.equal(isVisibleCard(t, "E", undefined, true), true, "空列車是卡");
  assert.equal(isVisibleCard(t, "B", undefined, true), false, "支線不是卡");
  assert.equal(isVisibleCard(t, "d", undefined, true), false, "隱藏済");
  assert.equal(isVisibleCard(t, "d", undefined, false), true);
  assert.equal(isVisibleCard(t, "p", { status: "done", due_on: TODAY }, true), false, "定期券看班次");
  assert.equal(isVisibleCard(t, "nope", undefined, false), false);
});

test("跨路線済欄：最近完成的在前，超過上限只算張數", () => {
  const row = (id: string, completed_at: string | null) => ({ node: { id, completed_at, updated_at: "2026-01-01T00:00:00.000Z" } });
  const out = recentDoneCards([row("old", "2026-10-01T00:00:00.000Z"), row("new", "2026-11-01T00:00:00.000Z"), row("teiki", null)], { teiki: { status: "done", due_on: "2026-10-15" } }, 2);
  assert.deepEqual(out.shown.map((r) => r.node.id), ["new", "teiki"]);
  assert.equal(out.rest, 1);
  assert.equal(recentDoneCards([], {}).rest, 0);
  const many = Array.from({ length: DONE_COLUMN_LIMIT + 7 }, (_, i) => row(`k${i}`, `2026-11-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`));
  const capped = recentDoneCards(many, {});
  assert.equal(capped.shown.length, DONE_COLUMN_LIMIT);
  assert.equal(capped.rest, 7);
});

test("締切六種的邊界", () => {
  const due = (d: string | null) => task("a", { due_on: d });
  const m = (d: string | null, cond: TaskFilter["due"]) => matchTask(due(d), f({ due: cond }), ctx());
  assert.equal(m("2026-11-05", "overdue"), true);
  assert.equal(m("2026-11-06", "overdue"), false);
  assert.equal(m("2026-11-06", "today"), true);
  assert.equal(m("2026-11-06", "week"), true);
  assert.equal(m("2026-11-13", "week"), true);
  assert.equal(m("2026-11-14", "week"), false);
  assert.equal(m("2026-11-05", "week"), false);
  assert.equal(m("2026-11-30", "month"), true);
  assert.equal(m("2026-12-01", "month"), false);
  assert.equal(m(null, "none"), true);
  assert.equal(m("2026-11-30", "none"), false);
  assert.equal(m(null, "has"), false);
});

test("締切已過：有結局就不算", () => {
  const n = task("a", { due_on: "2026-11-01", status: "done" });
  assert.equal(matchTask(n, f({ due: "overdue", status: "all" }), ctx()), false);
});

test("誤點：過了執行日沒結局；定期券看這一班", () => {
  assert.equal(isTaskLate(task("a", { scheduled_on: "2026-11-05" }), undefined, TODAY), true);
  assert.equal(isTaskLate(task("a", { scheduled_on: TODAY }), undefined, TODAY), false);
  assert.equal(isTaskLate(task("a", { scheduled_on: "2026-11-05", status: "done" }), undefined, TODAY), false);
  // 定期券沒交代的班次沒有 occurrence 列：看 scheduled_on
  assert.equal(isTaskLate(task("a", { scheduled_on: "2026-11-02" }), undefined, TODAY), true);
  assert.equal(isTaskLate(task("a", { scheduled_on: "2026-11-09" }), { status: "skipped", due_on: "2026-11-02" }, TODAY), false);
  assert.equal(isTaskLate(task("a"), undefined, TODAY), false);
});

test("誤點條件跟 lateCount 同一群：沒排執行日、締切到了也算", () => {
  const m = (patch: Partial<TaskNode>) => matchTask(task("a", patch), f({ late: true }), ctx());
  assert.equal(m({ scheduled_on: "2026-11-01" }), true);
  assert.equal(m({ due_on: "2026-11-01" }), true);
  assert.equal(m({ due_on: TODAY }), true);
  assert.equal(m({ due_on: "2026-11-07" }), false);
  assert.equal(m({ scheduled_on: "2026-11-09", due_on: "2026-11-01" }), false);
  assert.equal(matchTask(task("a", { due_on: "2026-11-01", status: "done" }), f({ late: true, status: "all" }), ctx()), false);
});

test("跨組是而且", () => {
  const c = ctx({ tagsOf: () => ["讀書"] });
  const n = task("a", { scheduled_on: "2026-11-01", due_on: TODAY, priority: "high" });
  const all = f({ routes: ["r1"], tags: ["讀書"], due: "today", late: true, high: true });
  assert.equal(matchTask(n, all, c), true);
  assert.equal(matchTask({ ...n, priority: "low" }, all, c), false);
  assert.equal(matchTask({ ...n, scheduled_on: "2026-11-09" }, all, c), false);
});

test("排序：預設誤點在前、締切近的在前、沒日期在後", () => {
  const list = [
    task("none"),
    task("far", { due_on: "2026-12-01" }),
    task("near", { due_on: "2026-11-08" }),
    task("late", { scheduled_on: "2026-11-01", due_on: "2026-12-30" }),
  ];
  assert.deepEqual(sortTasks(list, "smart", ctx()).map((n) => n.id), ["late", "near", "far", "none"]);
  assert.deepEqual(sortTasks(list, "priority", ctx()).length, 4);
});

test("常用篩選：壞值不炸、不認得的欄丟掉、來回不變", () => {
  assert.deepEqual(parseSavedFilters(null), []);
  assert.deepEqual(parseSavedFilters("{壞"), []);
  assert.deepEqual(parseSavedFilters('{"a":1}'), []);
  const parsed = parseSavedFilters(
    JSON.stringify([
      { id: "s1", name: "下週要交", filter: { due: "week", due2: "x", routes: ["r1", 3], status: "奇怪" }, layout: "board", extra: 1 },
      { id: "s1", name: "重複 id" },
      { id: "s2", name: "  " },
      { name: "沒 id" },
    ]),
  );
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0], { id: "s1", name: "下週要交", filter: f({ due: "week", routes: ["r1"] }), layout: "board" });
  assert.deepEqual(parseSavedFilters(serializeSavedFilters(parsed)), parsed);
});

test("荷札改名：條件跟著走、連續改名照鏈走、環不打轉、沒變回同一個物件", () => {
  const base = f({ tags: ["舊", "別的"] });
  assert.deepEqual(followTagRenames(base, [{ from: "舊", to: "新" }]).tags, ["新", "別的"]);
  assert.deepEqual(followTagRenames(base, [{ from: "舊", to: "中" }, { from: "中", to: "新" }]).tags, ["新", "別的"]);
  assert.deepEqual(followTagRenames(f({ tags: ["a"] }), [{ from: "a", to: "b" }, { from: "b", to: "a" }]).tags, ["b"]);
  assert.deepEqual(followTagRenames(f({ tags: ["舊", "新"] }), [{ from: "舊", to: "新" }]).tags, ["新"]);
  assert.equal(followTagRenames(base, [{ from: "沒有", to: "新" }]), base);
});

/* ── 看板 ── */

const n = (id: string, kind: BoardNode["kind"], parent_id: string | null, status: BoardNode["status"] = "todo"): BoardNode => ({
  id,
  kind,
  parent_id,
  name: id,
  status,
});

const tree = {
  byId: Object.fromEntries(
    [
      n("loose", "ticket", null),
      n("T1", "train", "R"),
      n("a", "ticket", "T1", "doing"),
      n("C1", "car", "T1"),
      n("b", "ticket", "C1", "done"),
      n("emptyT", "train", "R"),
      n("BR", "branch", "R"),
      n("x", "ticket", "BR", "paused"),
      n("st", "station", "R"),
    ].map((row) => [row.id, row]),
  ),
  childrenOf: { T1: ["a", "C1"], C1: ["b"], BR: ["x"] } as Record<string, string[]>,
};
const ROOTS = ["loose", "T1", "emptyT", "BR", "st"];

test("卡＝葉節點任務：有子項的列車、支線、車站不是卡；路徑寫祖先", () => {
  const cards = boardCards(tree, ROOTS);
  assert.deepEqual(cards.map((c) => c.node.id), ["loose", "a", "b", "emptyT", "x"]);
  assert.deepEqual(cards.find((c) => c.node.id === "b")!.crumb, ["T1", "C1"]);
});

test("依狀態：四欄照順序、順序跟大綱", () => {
  const cols = statusColumns(boardCards(tree, ROOTS), {});
  assert.deepEqual(cols.map((c) => c.status), ["todo", "doing", "paused", "done"]);
  assert.deepEqual(cols.map((c) => c.cards.map((k) => k.node.id)), [["loose", "emptyT"], ["a"], ["x"], ["b"]]);
});

test("定期券：班次済進済欄；隔天沒有班次紀錄回到 nodes.status", () => {
  assert.equal(cardStatus({ status: "todo" }, { status: "done", due_on: TODAY }), "done");
  assert.equal(cardStatus({ status: "todo" }, undefined), "todo");
  assert.equal(cardStatus({ status: "doing" }, undefined), "doing");
  assert.equal(cardStatus({ status: "todo" }, { status: "skipped", due_on: TODAY }), "todo");
});

test("依列車：最上層一欄＋每個列車與支線；空列車照樣一欄；車站不成欄", () => {
  const cols = trainColumns(tree, ROOTS);
  assert.deepEqual(cols.map((c) => c.holder?.id ?? null), [null, "T1", "emptyT", "BR"]);
  assert.deepEqual(cols[0].cards.map((k) => k.node.id), ["loose"]);
  assert.deepEqual(cols[1].cards.map((k) => k.node.id), ["a", "b"]);
  assert.deepEqual(cols[1].cards[1].crumb, ["C1"]);
  assert.deepEqual(cols[2].cards, []);
});

test("車站：還在且同路線才算；搬走或刪了當沒掛", () => {
  const stations = new Map([["s1", { parent_id: "R" }]]);
  assert.equal(effectiveStation({ station_id: "s1", route_id: "R" }, stations), "s1");
  assert.equal(effectiveStation({ station_id: "s1", route_id: "OTHER" }, stations), null);
  assert.equal(effectiveStation({ station_id: "gone", route_id: "R" }, stations), null);
  assert.equal(effectiveStation({ station_id: null, route_id: "R" }, stations), null);
});

test("依車站：還沒排站一欄＋每一站；欄內跟著卡的順序", () => {
  const card = (id: string, station_id: string | null) => ({ node: { ...n(id, "ticket", "T1"), station_id, route_id: "R" }, crumb: [] });
  const cols = stationColumns(
    [card("a", "s2"), card("b", null), card("c", "s2"), card("d", "gone")],
    [{ id: "s1", parent_id: "R" }, { id: "s2", parent_id: "R" }],
  );
  assert.deepEqual(cols.map((c) => c.station?.id ?? null), [null, "s1", "s2"]);
  assert.deepEqual(cols.map((c) => c.cards.map((k) => k.node.id)), [["b", "d"], [], ["a", "c"]]);
});

test("依列車落點：放在誰旁邊就進誰那一層；鄰居不同層就不當錨；空欄進那一欄", () => {
  assert.deepEqual(trainDropPlace(tree, "R", "T1", "a", "b"), { parentId: "T1", after: "a", before: null });
  assert.deepEqual(trainDropPlace(tree, "R", "T1", "b", null), { parentId: "C1", after: "b", before: null });
  assert.deepEqual(trainDropPlace(tree, "R", "T1", null, "b"), { parentId: "C1", after: null, before: "b" });
  assert.deepEqual(trainDropPlace(tree, "R", "emptyT", null, null), { parentId: "emptyT", after: null, before: null });
  assert.deepEqual(trainDropPlace(tree, "R", null, null, null), { parentId: "R", after: null, before: null });
  assert.deepEqual(trainDropPlace(tree, "R", null, "loose", null), { parentId: "R", after: "loose", before: null });
});

test("依列車小標：正下方＝進那節車廂最前面；正上方＝看上面那張；空欄進那一欄", () => {
  const n = (id: string, kind: BoardNode["kind"], parent_id: string | null): BoardNode => ({ id, kind, parent_id, name: id, status: "todo" });
  const tree = {
    byId: { T1: n("T1", "train", "R"), C1: n("C1", "car", "T1"), a: n("a", "ticket", "T1"), b: n("b", "ticket", "C1"), top: n("top", "ticket", null) },
    childrenOf: { T1: ["a", "C1"], C1: ["b"] },
  };
  const sub = SUB_ROW + "C1";
  assert.deepEqual(resolveTrainDrop(tree, "R", "T1", sub, "b"), { parentId: "C1", after: null, before: "b" });
  assert.deepEqual(resolveTrainDrop(tree, "R", "T1", "a", sub), { parentId: "T1", after: "a", before: null });
  assert.deepEqual(resolveTrainDrop(tree, "R", "T1", null, sub), { parentId: "T1", after: null, before: null });
  // 小標底下那張正被拖走：縫只剩小標
  assert.deepEqual(resolveTrainDrop(tree, "R", "T1", sub, null), { parentId: "C1", after: null, before: null });
  assert.deepEqual(resolveTrainDrop(tree, "R", TOP_COL, "top", null), { parentId: "R", after: "top", before: null });
});

test("競合日誌：車站與「掛在」不印 UUID；查得到講名字，查不到只講留下哪一邊", () => {
  const body = (col: string, mine: unknown, theirs: unknown, winner = "theirs") => JSON.stringify({ col, mine, theirs, winner });
  const names = (col: string, id: string) => (col === "station_id" ? (id === "s1" ? "第一站" : "（車站已不在）") : null);
  assert.equal(describeConflict(body("station_id", "s1", "s2"), names), "車站：放棄這台的「第一站」，保留另一台的「（車站已不在）」");
  assert.equal(describeConflict(body("station_id", null, "s1", "mine"), names), "車站：放棄另一台的「第一站」，保留這台的「還沒排站」");
  assert.equal(describeConflict(body("station_id", "uuid-a", "uuid-b")), "車站：兩台不一樣，留下另一台的", "沒給 nameOf（MCP）不印 id");
  assert.equal(describeConflict(body("parent_id", "uuid-a", "uuid-b", "mine"), names), "掛在：兩台不一樣，留下這台的");
  assert.equal(describeConflict(body("name", "甲", "乙")), "name：放棄這台的「甲」，保留另一台的「乙」".replace("name", CONFLICT_COL_LABEL.name ?? "name"));
});
