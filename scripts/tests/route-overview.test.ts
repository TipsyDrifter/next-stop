/**
 * 路線一覽的數字（丁 D-主-240／241；src/domain/routeOverview.ts）——桌機一覽卡片與手機第一層同一支。
 * 跑法：`node --test scripts/tests/route-overview.test.ts`（node 24，型別剝除；純函式）。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildRouteOverview, type OverviewInput, type RouteMember } from "../../src/domain/routeOverview.ts";

const H = 3_600_000;
const W = { start: 0, end: 30 * 24 * H };

function base(over: Partial<OverviewInput> = {}): OverviewInput {
  return {
    routeIds: ["r1", "r2"],
    members: [],
    isDone: (m) => m.status === "done",
    stations: [],
    spans: [],
    spend: [],
    todayRows: [],
    today: "2026-11-02",
    window: W,
    now: W.end,
    ...over,
  };
}

const m = (id: string, kind: string, route: string | null, status = "todo"): RouteMember => ({ id, kind, status, route_id: route });

describe("車票済數", () => {
  test("只數車票（含掛路線標籤的臨時車票）；列車、車廂、支線不算；済由 isDone 判", () => {
    const r = buildRouteOverview(
      base({
        members: [m("t1", "ticket", "r1", "done"), m("t2", "ticket", "r1"), m("tr", "train", "r1", "done"), m("b", "branch", "r1"), m("t3", "ticket", "r2")],
      }),
    );
    assert.equal(r.byRoute.r1.ticketTotal, 2);
    assert.equal(r.byRoute.r1.ticketDone, 1);
    assert.equal(r.byRoute.r2.ticketTotal, 1);
  });
  test("定期券看目前班次：isDone 說済就算済", () => {
    const r = buildRouteOverview(base({ members: [m("rep", "ticket", "r1")], isDone: (x) => x.id === "rep" }));
    assert.equal(r.byRoute.r1.ticketDone, 1);
  });
});

describe("近 30 天時間", () => {
  test("塊連路線或連到路線裡的節點都算；同一路線重疊只算一次；窗外裁掉", () => {
    const r = buildRouteOverview(
      base({
        members: [m("n1", "train", "r1")],
        spans: [
          { start: 1 * H, end: 3 * H, nodeId: null, routeId: "r1" },
          { start: 2 * H, end: 4 * H, nodeId: "n1", routeId: null }, // 跟上一塊重疊 1h
          { start: -2 * H, end: 1 * H, nodeId: null, routeId: "r2" }, // 窗前那 2h 不算
        ],
      }),
    );
    assert.equal(r.byRoute.r1.timeMs, 3 * H);
    assert.equal(r.byRoute.r2.timeMs, 1 * H);
    assert.equal(r.totalTimeMs, 4 * H);
  });
  test("運行中算到 now；連到不認得的節點、沒連的塊不算", () => {
    const r = buildRouteOverview(
      base({
        now: 10 * H,
        window: { start: 0, end: 10 * H },
        spans: [
          { start: 8 * H, end: null, nodeId: null, routeId: "r1" },
          { start: 1 * H, end: 2 * H, nodeId: "ghost", routeId: null },
          { start: 1 * H, end: 2 * H, nodeId: null, routeId: null },
        ],
      }),
    );
    assert.equal(r.byRoute.r1.timeMs, 2 * H);
    assert.equal(r.totalTimeMs, 2 * H);
  });
});

describe("花費與誤點", () => {
  test("花費加總直掛路線的支出；沒掛路線、別條路線各自算", () => {
    const r = buildRouteOverview(
      base({ spend: [{ route_id: "r1", main_minor: 1000 }, { route_id: "r1", main_minor: 250 }, { route_id: null, main_minor: 99 }, { route_id: "r2", main_minor: 1 }] }),
    );
    assert.equal(r.byRoute.r1.spendMinor, 1250);
    assert.equal(r.byRoute.r2.spendMinor, 1);
    assert.equal(r.totalSpendMinor, 1251);
  });
  test("誤點＝今日切片還沒交代的（同 lateCount）；按路線分", () => {
    const row = (route: string | null, over: object = {}) => ({
      route_id: route,
      bucket: "late" as const,
      status: "todo",
      scheduled_on: "2026-10-30",
      due_on: null,
      occurrence: null,
      ...over,
    });
    const r = buildRouteOverview(
      base({ todayRows: [row("r1"), row("r1", { status: "done" }), row("r1", { bucket: "today" }), row("r2"), row(null)] }),
    );
    assert.equal(r.byRoute.r1.late, 1);
    assert.equal(r.byRoute.r2.late, 1);
  });
});

describe("車站", () => {
  const st = (id: string, parent: string, pos: number, arrived: string | null = null, exp: string | null = null) => ({
    id,
    parent_id: parent,
    name: id,
    arrived_on: arrived,
    expected_on: exp,
    position: pos,
    sort_key: null,
    created_at: "2026-01-01T00:00:00Z",
  });
  test("下一站＝還沒到站的第一個（兄弟順序）；進度＝到站數／車站數", () => {
    const r = buildRouteOverview(base({ stations: [st("s2", "r1", 2, null, "2026-12-06"), st("s1", "r1", 1, "2026-10-01"), st("s3", "r1", 3)] }));
    assert.deepEqual(r.byRoute.r1.nextStation, { name: "s2", expectedOn: "2026-12-06" });
    assert.equal(r.byRoute.r1.stationsArrived, 1);
    assert.equal(r.byRoute.r1.stationsTotal, 3);
    assert.equal(r.byRoute.r2.nextStation, null);
  });
});
