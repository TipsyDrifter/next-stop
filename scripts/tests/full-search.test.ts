// 完整搜尋班・純邏輯單元測試（契約 docs/research/2026-10-25-主線-完整搜尋班-契約.md §3、§5）
// 跑法：node --test scripts/tests/full-search.test.ts（node 24 直接剝除型別）
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dateCell,
  keepOrder,
  excerptOf,
  filterHits,
  rankHits,
  splitHits,
  DEFAULT_FILTER,
  aimLandingDay,
  aimPeriodText,
  aimPlaceText,
  buildAimHits,
  filterAimHits,
  isDefaultFilter,
  rankAimHits,
  type FullSearchHit,
} from "../../src/domain/fullSearch.ts";
import type { NodeRow } from "../../src/domain/node.ts";
import type { WeekAimRow } from "../../src/domain/weekAims.ts";

function node(p: Partial<NodeRow> & { id: string }): NodeRow {
  return {
    kind: "ticket",
    parent_id: "p",
    line_id: "L",
    route_id: "R1",
    name: p.id,
    description: null,
    position: 0,
    sort_key: null,
    color: null,
    code: null,
    status: "todo",
    scheduled_on: null,
    due_on: null,
    priority: "mid",
    estimate_min: null,
    progress: null,
    time_spent_min: null,
    mood: null,
    repeat_rule: null,
    completed_at: null,
    expected_on: null,
    arrived_on: null,
    today_position: null,
    carried_from: null,
    scheduled_time: null,
    time_overrides: null,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    deleted_at: null,
    ...p,
  } as NodeRow;
}

const hit = (n: NodeRow, field: FullSearchHit["field"] = "name", text: string | null = null): FullSearchHit => ({ node: n, field, text });
const byStatus = (n: NodeRow) => n.status === "done";

test("排序：名稱 → 概要 → 乘務記錄；同層未完成在前；再依最近更新", () => {
  const hits = [
    hit(node({ id: "log1" }), "log", "x"),
    hit(node({ id: "doneName", status: "done", updated_at: "2026-10-09T00:00:00Z" }), "name"),
    hit(node({ id: "desc1" }), "description", "x"),
    hit(node({ id: "nameOld", updated_at: "2026-10-02T00:00:00Z" }), "name"),
    hit(node({ id: "nameNew", updated_at: "2026-10-05T00:00:00Z" }), "name"),
  ];
  assert.deepEqual(
    rankHits(hits, byStatus).map((h) => h.node.id),
    ["nameNew", "nameOld", "doneName", "desc1", "log1"],
  );
});

test("済看呼叫端給的判準（定期券看目前班次，不看 status）", () => {
  const rep = node({ id: "rep", repeat_rule: "{}", status: "todo" });
  const plain = node({ id: "plain", updated_at: "2026-09-01T00:00:00Z" });
  const ranked = rankHits([hit(rep), hit(plain)], (n) => n.id === "rep");
  assert.deepEqual(ranked.map((h) => h.node.id), ["plain", "rep"]);
  assert.deepEqual(
    filterHits([hit(rep), hit(plain)], { ...DEFAULT_FILTER, status: "done" }, (n) => n.id === "rep").map((h) => h.node.id),
    ["rep"],
  );
});

test("篩選：狀態、種類、路線（臨時車票、某條路線含路線本身與掛路線的臨時車票）", () => {
  const route = node({ id: "R1", kind: "route", parent_id: null, route_id: "R1" });
  const train = node({ id: "t", kind: "train", route_id: "R1" });
  const tk = node({ id: "tk", route_id: "R1", status: "done" });
  const temp = node({ id: "temp", parent_id: null, route_id: null });
  const tempTagged = node({ id: "tempR", parent_id: null, route_id: "R1" });
  const other = node({ id: "o", route_id: "R2" });
  const all = [route, train, tk, temp, tempTagged, other].map((n) => hit(n));
  const ids = (f: Partial<typeof DEFAULT_FILTER>) => filterHits(all, { ...DEFAULT_FILTER, ...f }, byStatus).map((h) => h.node.id);

  assert.equal(ids({}).length, 6);
  assert.deepEqual(ids({ status: "open" }), ["R1", "t", "temp", "tempR", "o"]);
  assert.deepEqual(ids({ status: "done" }), ["tk"]);
  assert.deepEqual(ids({ kind: "ticket" }), ["tk", "temp", "tempR", "o"]);
  assert.deepEqual(ids({ kind: "tree" }), ["R1", "t"]);
  assert.deepEqual(ids({ route: "temp" }), ["temp", "tempR"]);
  assert.deepEqual(ids({ route: { routeId: "R1" } }), ["R1", "t", "tk", "tempR"]);
  assert.deepEqual(ids({ route: { routeId: "R1" }, kind: "ticket", status: "open" }), ["tempR"]);
});

test("高亮切段：大小寫不敏感、字面比對、多處命中", () => {
  assert.deepEqual(splitHits("Meet 會議 meet", "MEET"), [
    { text: "Meet", hit: true },
    { text: " 會議 ", hit: false },
    { text: "meet", hit: true },
  ]);
  assert.deepEqual(splitHits("100%_完成", "%_"), [
    { text: "100", hit: false },
    { text: "%_", hit: true },
    { text: "完成", hit: false },
  ]);
  assert.deepEqual(splitHits("abc", "  "), [{ text: "abc", hit: false }]);
});

test("摘錄：壓成一行、命中前後各 radius 字、截掉的那頭補…", () => {
  const text = "第一行\n\n" + "前".repeat(30) + "會議" + "後".repeat(30);
  const parts = excerptOf(text, "會議", 5);
  assert.deepEqual(parts, [
    { text: "…", hit: false },
    { text: "前前前前前", hit: false },
    { text: "會議", hit: true },
    { text: "後後後後後", hit: false },
    { text: "…", hit: false },
  ]);
  // 命中在開頭：不補前面的…
  assert.equal(excerptOf("會議在週三", "會議", 5)[0].text, "會議");
  // 換行壓成空白
  assert.equal(excerptOf("a\n\nb 會議", "會議", 10).map((p) => p.text).join(""), "a b 會議");
});

test("日期欄：執行日／今天／過期／定期券下一班／締切／跨年帶年份／都沒有", () => {
  const today = "2026-10-25";
  // done＝目前班次済了沒（定期券看班次）；retired＝定期券本身退役（nodes.status=done）
  const cell = (p: { scheduled_on?: string; due_on?: string; repeat_rule?: string; retired?: boolean }, done = false) =>
    dateCell(
      { scheduled_on: p.scheduled_on ?? null, due_on: p.due_on ?? null, repeat_rule: p.repeat_rule ?? null, status: p.retired || (done && !p.repeat_rule) ? "done" : "todo" },
      done,
      today,
    );
  assert.deepEqual(cell({ scheduled_on: "2026-10-28" }), { tag: "", text: "10/28", late: false });
  assert.deepEqual(cell({ scheduled_on: "2026-10-25" }), { tag: "", text: "今天", late: false });
  assert.deepEqual(cell({ scheduled_on: "2026-10-25" }, true), { tag: "", text: "10/25", late: false });
  assert.deepEqual(cell({ scheduled_on: "2026-10-20" }), { tag: "", text: "10/20", late: true });
  assert.deepEqual(cell({ scheduled_on: "2026-10-20" }, true), { tag: "", text: "10/20", late: false });
  assert.deepEqual(cell({ scheduled_on: "2026-10-26", repeat_rule: "{}" }), { tag: "下一班", text: "10/26", late: false });
  // 定期券今天那班還沒済＝「今天」；今天済了、scheduled_on 推到明天＝仍是「下一班」（沙盒 O5）
  assert.deepEqual(cell({ scheduled_on: "2026-10-25", repeat_rule: "{}" }), { tag: "", text: "今天", late: false });
  assert.deepEqual(cell({ scheduled_on: "2026-10-26", repeat_rule: "{}" }, true), { tag: "下一班", text: "10/26", late: false });
  // 退役的定期券不講下一班
  assert.deepEqual(cell({ scheduled_on: "2026-10-20", repeat_rule: "{}", retired: true }, true), { tag: "", text: "10/20", late: false });
  assert.deepEqual(cell({ due_on: "2026-11-02" }), { tag: "締", text: "11/2", late: false });
  assert.deepEqual(cell({ due_on: "2026-10-01" }), { tag: "締", text: "10/1", late: true });
  assert.deepEqual(cell({ scheduled_on: "2025-03-04" }, true), { tag: "", text: "2025/3/4", late: false });
  assert.equal(cell({}), null);
});

test("清單不動：同一次搜尋裡重查，已在清單上的照舊位置、新的接在後面；prev=null 照排序（沙盒 F1）", () => {
  const a = hit(node({ id: "a", updated_at: "2026-10-03T00:00:00Z" }));
  const b = hit(node({ id: "b", updated_at: "2026-10-02T00:00:00Z" }));
  const c = hit(node({ id: "c", updated_at: "2026-10-01T00:00:00Z" }));
  const first = keepOrder(rankHits([a, b, c], byStatus), null);
  assert.deepEqual(first.hits.map((h) => h.node.id), ["a", "b", "c"]);
  // b 被蓋済（排序會把它丟到最後）、新冒出 d（排序在最前）：b 原地、d 接在尾巴
  const bDone = hit(node({ id: "b", status: "done", updated_at: "2026-10-09T00:00:00Z" }));
  const d = hit(node({ id: "d", updated_at: "2026-10-10T00:00:00Z" }));
  const again = keepOrder(rankHits([a, bDone, c, d], byStatus), first.order);
  assert.deepEqual(again.hits.map((h) => h.node.id), ["a", "b", "c", "d"]);
  assert.equal(again.hits[1].node.status, "done", "樣子換成新的");
  // 被刪掉的那張就沒了，其餘照舊
  assert.deepEqual(keepOrder([a, c], again.order).hits.map((h) => h.node.id), ["a", "c"]);
});

/* ───────────── 方針組（方針擴充 辛 D-主-382） ───────────── */

function aim(p: Partial<WeekAimRow> & { id: string; week_on: string }): WeekAimRow {
  return {
    text: p.id,
    node_id: null,
    position: 0,
    done_at: null,
    carried_from: null,
    account_id: null,
    device_id: null,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    synced_at: null,
    deleted_at: null,
    ...p,
  } as WeekAimRow;
}

const R1 = node({ id: "R1", kind: "route", route_id: null, name: "日本語" });
const B1 = node({ id: "B1", kind: "branch", parent_id: "R1", route_id: "R1", name: "文法" });
const ST = node({ id: "ST", kind: "station", parent_id: "R2", route_id: "R2", name: "N5", expected_on: "2026-12-05" });
const NODES = new Map([R1, B1, ST].map((n) => [n.id, n]));
const R2_NAME = [{ id: "R2", name: "引越し" }];

test("buildAimHits：掛的節點接上；掛的被刪＝標籤消失、句子留著；車站被刪＝整句藏（§3 #16）", () => {
  const hits = buildAimHits(
    [
      aim({ id: "on-route", week_on: "M2026-11", node_id: "R1" }),
      aim({ id: "gone-node", week_on: "M2026-11", node_id: "刪了" }),
      aim({ id: "on-station", week_on: "SST" }),
      aim({ id: "gone-station", week_on: "S刪了" }),
    ],
    NODES,
  );
  assert.deepEqual(hits.map((h) => h.aim.id), ["on-route", "gone-node", "on-station"]);
  assert.equal(hits[0].node?.id, "R1");
  assert.equal(hits[1].node, null);
  assert.equal(hits[2].station?.id, "ST");
});

test("filterAimHits：狀態看済；車票、樹、臨時車票整組不出現；路線含它的支線與車站；沒掛只在全部", () => {
  const hits = buildAimHits(
    [
      aim({ id: "route", week_on: "M2026-11", node_id: "R1" }),
      aim({ id: "branch", week_on: "2026-11-02", node_id: "B1", done_at: "2026-11-03T00:00:00Z" }),
      aim({ id: "station", week_on: "SST" }),
      aim({ id: "loose", week_on: "Y2026" }),
    ],
    NODES,
  );
  const ids = (f: Partial<typeof DEFAULT_FILTER>) => filterAimHits(hits, { ...DEFAULT_FILTER, ...f }).map((h) => h.aim.id);
  assert.deepEqual(ids({}), ["route", "branch", "station", "loose"]);
  assert.deepEqual(ids({ kind: "aim" }), ["route", "branch", "station", "loose"]);
  assert.deepEqual(ids({ kind: "ticket" }), []);
  assert.deepEqual(ids({ kind: "tree" }), []);
  assert.deepEqual(ids({ status: "done" }), ["branch"]);
  assert.deepEqual(ids({ status: "open" }), ["route", "station", "loose"]);
  assert.deepEqual(ids({ route: "temp" }), []);
  assert.deepEqual(ids({ route: { routeId: "R1" } }), ["route", "branch"]);
  assert.deepEqual(ids({ route: { routeId: "R2" } }), ["station"]);
});

test("filterHits：種類選「方針」時節點組清空（既有三種照舊）", () => {
  const h = hit(node({ id: "t" }));
  assert.deepEqual(filterHits([h], { ...DEFAULT_FILTER, kind: "aim" }, byStatus), []);
  assert.equal(isDefaultFilter({ ...DEFAULT_FILTER, kind: "aim" }), false);
});

test("rankAimHits：未済在前，再最近更新、id 定序", () => {
  const hits = buildAimHits(
    [
      aim({ id: "old", week_on: "Y2026", updated_at: "2026-10-01T00:00:00Z" }),
      aim({ id: "done", week_on: "Y2026", updated_at: "2026-10-09T00:00:00Z", done_at: "2026-10-09T00:00:00Z" }),
      aim({ id: "new-b", week_on: "Y2026", updated_at: "2026-10-05T00:00:00Z" }),
      aim({ id: "new-a", week_on: "Y2026", updated_at: "2026-10-05T00:00:00Z" }),
    ],
    NODES,
  );
  assert.deepEqual(rankAimHits(hits).map((h) => h.aim.id), ["new-a", "new-b", "old", "done"]);
});

test("aimPeriodText：四種期間的字；週對齊現在的週首；車站寫站名", () => {
  const text = (week_on: string, weekStart: 0 | 1 = 1, station: NodeRow | null = null) =>
    aimPeriodText({ aim: aim({ id: "a", week_on }), station }, "2026-11-04", weekStart);
  assert.equal(text("2026-11-02"), "本週");
  assert.equal(text("2026-10-26"), "上週");
  assert.equal(text("2026-10-05"), "10/5 那週");
  assert.equal(text("2025-10-06"), "2025/10/6 那週");
  assert.equal(text("2026-11-01"), "上週", "週一起算時 11/1 是上一週的週日");
  assert.equal(text("2026-11-01", 0), "本週", "寫的時候週日起算、現在也是：同一週");
  assert.equal(text("M2026-11"), "本月");
  assert.equal(text("M2026-10"), "上個月");
  assert.equal(text("M2026-03"), "3月");
  assert.equal(text("M2025-10"), "2025年10月");
  assert.equal(text("Y2026"), "今年");
  assert.equal(text("Y2025"), "去年");
  assert.equal(text("Y2020"), "2020 年");
  assert.equal(text("SST", 1, ST), "N5・12/5");
});

test("aimPlaceText：掛的名字；車站沒掛寫那一站的路線；都沒有空字", () => {
  assert.equal(aimPlaceText({ node: B1, station: null }, R2_NAME), "文法");
  assert.equal(aimPlaceText({ node: null, station: ST }, R2_NAME), "引越し");
  assert.equal(aimPlaceText({ node: R1, station: ST }, R2_NAME), "日本語", "車站方針掛了別的路線：寫掛的");
  assert.equal(aimPlaceText({ node: null, station: null }, R2_NAME), "");
});

test("aimLandingDay：今天在這一期裡落今天；否則第一天", () => {
  assert.equal(aimLandingDay("2026-11-02", "2026-11-04", 1), "2026-11-04");
  assert.equal(aimLandingDay("2026-10-26", "2026-11-04", 1), "2026-10-26");
  assert.equal(aimLandingDay("M2026-11", "2026-11-04", 1), "2026-11-04");
  assert.equal(aimLandingDay("M2026-10", "2026-11-04", 1), "2026-10-01");
  assert.equal(aimLandingDay("M2027-02", "2026-11-04", 1), "2027-02-01");
  assert.equal(aimLandingDay("2026-11-01", "2026-11-04", 1), "2026-10-26", "週首設定改過：先對齊現在的週首");
});
