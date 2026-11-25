import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { NodeRow } from "../../domain/node";
import { diffCalendarDays, formatEstHours, layoutMultiDayRibbons } from "./multiDayRibbon.ts";

function makeNode(overrides: Partial<NodeRow> & { id: string; name: string }): NodeRow {
  return {
    parent_id: null,
    line_id: null,
    route_id: null,
    kind: "ticket",
    description: null,
    color: null,
    code: null,
    status: "todo",
    scheduled_on: null,
    scheduled_end: null,
    is_multi_day: null,
    is_placeholder: null,
    due_on: null,
    priority: "mid",
    repeat_rule: null,
    position: 0,
    sort_key: null,
    carried_from: null,
    today_position: null,
    expected_on: null,
    arrived_on: null,
    station_id: null,
    scheduled_time: null,
    time_overrides: null,
    estimate_min: null,
    progress: null,
    time_spent_min: null,
    completed_at: null,
    mood: null,
    account_id: null,
    device_id: null,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    synced_at: null,
    deleted_at: null,
    ...overrides,
  };
}

describe("layoutMultiDayRibbons", () => {
  const week = [
    "2026-10-05",
    "2026-10-06",
    "2026-10-07",
    "2026-10-08",
    "2026-10-09",
    "2026-10-10",
    "2026-10-11",
  ];

  it("ignores single-day and flexible-range tickets, only lays out isMultiDayTicket", () => {
    const nodes = [
      makeNode({ id: "s1", name: "單日", scheduled_on: "2026-10-06", scheduled_end: null, is_multi_day: null }),
      makeNode({ id: "f1", name: "自由券", scheduled_on: "2026-10-05", scheduled_end: "2026-10-09", is_multi_day: null }),
      makeNode({ id: "m1", name: "出差", scheduled_on: "2026-10-06", scheduled_end: "2026-10-08", is_multi_day: 1 }),
    ];
    const res = layoutMultiDayRibbons(week, nodes, "2026-10-07");
    assert.equal(res.laneCount, 1);
    assert.equal(res.segments.length, 1);
    assert.equal(res.segments[0].nodeId, "m1");
    assert.equal(res.segments[0].startCol, 1);
    assert.equal(res.segments[0].span, 3);
    assert.equal(res.segments[0].continuesLeft, false);
    assert.equal(res.segments[0].continuesRight, false);
    assert.equal(res.coveredNodeIds.has("m1"), true);
    assert.equal(res.coveredNodeIds.has("f1"), false);
  });

  it("packs non-overlapping ribbons into the same lane and stacks overlapping ones", () => {
    const nodes = [
      makeNode({ id: "a", name: "A", scheduled_on: "2026-10-05", scheduled_end: "2026-10-07", is_multi_day: 1 }),
      makeNode({ id: "b", name: "B", scheduled_on: "2026-10-06", scheduled_end: "2026-10-09", is_multi_day: 1 }),
      makeNode({ id: "c", name: "C", scheduled_on: "2026-10-08", scheduled_end: "2026-10-10", is_multi_day: 1 }),
    ];
    const res = layoutMultiDayRibbons(week, nodes, "2026-10-07");
    assert.equal(res.laneCount, 2);
    const byId = Object.fromEntries(res.segments.map((s) => [s.nodeId, s]));
    assert.equal(byId.a.lane, 0);
    assert.equal(byId.b.lane, 1);
    assert.equal(byId.c.lane, 0);
  });

  it("marks cross-week / cross-row continuation and clips to rangeFrom/rangeTo", () => {
    const crossWeek = [
      "2026-09-28",
      "2026-09-29",
      "2026-09-30",
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
      "2026-10-04",
    ];
    const trip = makeNode({
      id: "trip",
      name: "跨月旅行",
      scheduled_on: "2026-09-30",
      scheduled_end: "2026-10-06",
      is_multi_day: 1,
    });
    const res = layoutMultiDayRibbons(crossWeek, [trip], "2026-10-02", {
      rangeFrom: "2026-10-01",
      rangeTo: "2026-10-31",
    });
    assert.equal(res.segments.length, 1);
    const seg = res.segments[0];
    assert.equal(seg.startCol, 3);
    assert.equal(seg.span, 4);
    assert.equal(seg.continuesLeft, true);
    assert.equal(seg.continuesRight, true);
  });

  it("supports 4-day top row and 3-day bottom row for 2x4 weekly spread", () => {
    const trip = makeNode({
      id: "w1",
      name: "週三至週六研討會",
      scheduled_on: "2026-10-07",
      scheduled_end: "2026-10-10",
      is_multi_day: 1,
    });
    const top = layoutMultiDayRibbons(week.slice(0, 4), [trip], "2026-10-07");
    const bot = layoutMultiDayRibbons(week.slice(4, 7), [trip], "2026-10-07");
    assert.equal(top.segments[0].startCol, 2);
    assert.equal(top.segments[0].span, 2);
    assert.equal(top.segments[0].continuesLeft, false);
    assert.equal(top.segments[0].continuesRight, true);

    assert.equal(bot.segments[0].startCol, 0);
    assert.equal(bot.segments[0].span, 2);
    assert.equal(bot.segments[0].continuesLeft, true);
    assert.equal(bot.segments[0].continuesRight, false);
  });
});

describe("helpers", () => {
  it("formats estimated hours cleanly", () => {
    assert.equal(formatEstHours(0), "");
    assert.equal(formatEstHours(45), "45m");
    assert.equal(formatEstHours(60), "1h");
    assert.equal(formatEstHours(150), "2.5h");
    assert.equal(formatEstHours(80), "1h20");
  });

  it("computes UTC day diffs accurately", () => {
    assert.equal(diffCalendarDays("2026-10-10", "2026-10-07"), 3);
    assert.equal(diffCalendarDays("2026-11-02", "2026-10-31"), 2);
  });
});
