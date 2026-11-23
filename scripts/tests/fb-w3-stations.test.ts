/**
 * 回饋專卷 第三梯（3A 車站主畫面軌道條、跨層級掛站繼承與建票直選車站）單元與整合測試。
 * 跑法：`node --test scripts/tests/fb-w3-stations.test.ts`
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { NO_DEST, mergeQuick, type QuickDest } from "../../src/ui/common/quickadd/quickAddModel.ts";
import type { QuickAddParse } from "../../src/domain/quickAdd.ts";
import {
  NO_STATION_COL,
  boardCards,
  effectiveStation,
  inheritedStationOf,
  stationColumns,
} from "../../src/domain/board.ts";
import { buildStationTrack, matchesStationFilter } from "../../src/domain/stationTrack.ts";
import type { NodeKind, NodeRow, NodeStatus } from "../../src/domain/node.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");

const ROUTE_A: QuickDest = { routeId: "r-a", nodeId: null, nodeKind: "route" };
const ROUTE_B: QuickDest = { routeId: "r-b", nodeId: null, nodeKind: "route" };
const BRANCH_A1: QuickDest = { routeId: "r-a", nodeId: "b-1", nodeKind: "branch" };

const mkParse = (p: Partial<QuickAddParse> = {}): QuickAddParse => ({
  name: "整理五十音",
  tokens: [],
  tags: [],
  ...p,
});

function mkNode(
  id: string,
  kind: NodeKind,
  opts: {
    parent_id?: string | null;
    route_id?: string | null;
    station_id?: string | null;
    status?: NodeStatus;
    name?: string;
    arrived_on?: string | null;
    expected_on?: string | null;
    position?: number;
  } = {},
): NodeRow {
  return {
    id,
    kind,
    parent_id: opts.parent_id ?? null,
    line_id: null,
    route_id: opts.route_id ?? null,
    station_id: opts.station_id ?? null,
    name: opts.name ?? id,
    description: null,
    color: null,
    code: null,
    status: opts.status ?? "todo",
    priority: "mid",
    scheduled_on: null,
    scheduled_time: null,
    time_overrides: null,
    carried_from: null,
    due_on: null,
    repeat_rule: null,
    estimate_min: null,
    time_spent_min: null,
    progress_manual: null,
    mood: null,
    completed_at: opts.status === "done" ? "2026-11-20T10:00:00.000Z" : null,
    expected_on: opts.expected_on ?? null,
    arrived_on: opts.arrived_on ?? null,
    arrival_note: null,
    position: opts.position ?? 0,
    today_position: null,
    sort_key: String(opts.position ?? 0).padStart(4, "0"),
    today_sort_key: null,
    created_at: "2026-11-20T00:00:00.000Z",
    updated_at: "2026-11-20T00:00:00.000Z",
    deleted_at: null,
  };
}

describe("quickAddModel.mergeQuick：建票列與行內編輯直選車站（操作 6）", () => {
  test("單站聚焦篩選時 defaults.stationId 自動帶入同路線新建項（含切換到同路線支線）", () => {
    const defaults = { dest: ROUTE_A, stationId: "st-a1", scheduledOn: null };
    const v1 = mergeQuick(mkParse(), {}, defaults, () => null);
    assert.equal(v1.stationId, "st-a1");
    assert.equal(v1.on.has("station"), false);

    // 改掛到同一條路線底下的支線，預設車站仍保留
    const v2 = mergeQuick(mkParse(), { dest: BRANCH_A1 }, defaults, () => null);
    assert.equal(v2.stationId, "st-a1");
  });

  test("換到別條路線或摘除路線時，原路線的 defaults.stationId 自動歸零不外洩", () => {
    const defaults = { dest: ROUTE_A, stationId: "st-a1", scheduledOn: null };
    const vTypedOther = mergeQuick(mkParse({ dest: { routeId: "r-b", nodeId: null } }), {}, defaults, () => null);
    assert.equal(vTypedOther.dest.routeId, "r-b");
    assert.equal(vTypedOther.stationId, null);

    const vDetached = mergeQuick(mkParse(), { dest: NO_DEST }, defaults, () => null);
    assert.equal(vDetached.dest.routeId, null);
    assert.equal(vDetached.stationId, null);
  });

  test("點選「車站」膠囊可顯式覆寫或清回還沒排站", () => {
    const defaults = { dest: ROUTE_A, stationId: "st-a1", scheduledOn: null };
    const picked = mergeQuick(mkParse(), { stationId: "st-a2" }, defaults, () => null);
    assert.equal(picked.stationId, "st-a2");
    assert.equal(picked.on.has("station"), true);

    const cleared = mergeQuick(mkParse(), { stationId: null }, defaults, () => null);
    assert.equal(cleared.stationId, null);
    assert.equal(cleared.on.has("station"), false);

    // 在今日頁先選 @路線B 再挑該路線車站
    const todayPicked = mergeQuick(
      mkParse(),
      { dest: ROUTE_B, stationId: "st-b1" },
      { dest: NO_DEST, scheduledOn: "2026-11-20" },
      () => null,
    );
    assert.equal(todayPicked.dest.routeId, "r-b");
    assert.equal(todayPicked.stationId, "st-b1");
    assert.equal(todayPicked.on.has("station"), true);
  });
});

describe("跨層級掛站繼承、空支線看板與軌道條統計（Bug 3 ＋ 操作 6）", () => {
  const st1 = mkNode("st-1", "station", { parent_id: "r-1", name: "基礎文法", arrived_on: "2026-11-10", position: 1 });
  const st2 = mkNode("st-2", "station", { parent_id: "r-1", name: "讀解實戰", expected_on: "2026-12-01", position: 2 });
  const st3 = mkNode("st-3", "station", { parent_id: "r-1", name: "模擬試題", position: 3 });
  const stations = [st1, st2, st3];
  const stMap = new Map(stations.map((s) => [s.id, s]));

  // 結構：
  //   b-1（支線，掛 st-2）
  //     └ tr-1（列車，未顯式掛站 → 繼承 st-2）
  //         ├ tk-1（車票，done，未顯式掛站 → 繼承 st-2）
  //         └ tk-2（車票，todo，顯式覆寫 st-3）
  //   b-empty（空支線，掛 st-3）
  //   tk-free（路線自由席車票，未掛站）
  const b1 = mkNode("b-1", "branch", { parent_id: "r-1", route_id: "r-1", station_id: "st-2", name: "文法篇" });
  const tr1 = mkNode("tr-1", "train", { parent_id: "b-1", route_id: "r-1", name: "動詞變化" });
  const tk1 = mkNode("tk-1", "ticket", { parent_id: "tr-1", route_id: "r-1", status: "done", name: "て形" });
  const tk2 = mkNode("tk-2", "ticket", { parent_id: "tr-1", route_id: "r-1", station_id: "st-3", status: "todo", name: "綜合練習" });
  const bEmpty = mkNode("b-empty", "branch", { parent_id: "r-1", route_id: "r-1", station_id: "st-3", name: "考古題章節" });
  const tkFree = mkNode("tk-free", "ticket", { parent_id: null, route_id: "r-1", status: "todo", name: "買參考書" });

  const allNodes = [b1, tr1, tk1, tk2, bEmpty, tkFree];
  const byId = Object.fromEntries(allNodes.map((n) => [n.id, n]));
  const tree = {
    byId,
    childrenOf: {
      "b-1": ["tr-1"],
      "tr-1": ["tk-1", "tk-2"],
    } as Record<string, string[] | undefined>,
  };

  test("詳情下拉繼承文案探測：自身覆寫時仍可查出父層繼承來源以供『恢復繼承』", () => {
    const tk1Inh = inheritedStationOf(tk1, stMap, byId);
    assert.equal(tk1Inh.stationId, "st-2");
    assert.deepEqual(tk1Inh.inheritedFrom, { id: "b-1", name: "文法篇" });

    // tk2 自身覆寫為 st-3，但將 station_id 視為 null 探測時可取得祖先「文法篇（讀解實戰）」供下拉第一項顯示「恢復繼承自…」
    assert.equal(effectiveStation(tk2, stMap, byId), "st-3");
    const tk2ParentInh = inheritedStationOf({ ...tk2, station_id: null }, stMap, byId);
    assert.equal(tk2ParentInh.stationId, "st-2");
    assert.deepEqual(tk2ParentInh.inheritedFrom, { id: "b-1", name: "文法篇" });
  });

  test("看板『依車站』：保留空支線並依祖先繼承車站正確歸欄", () => {
    const cards = boardCards(tree, ["b-1", "b-empty", "tk-free"], [], { includeEmptyBranches: true });
    const cols = stationColumns(cards, stations, byId);

    const noneCol = cols.find((c) => c.station === null)!;
    const st2Col = cols.find((c) => c.station?.id === "st-2")!;
    const st3Col = cols.find((c) => c.station?.id === "st-3")!;

    assert.deepEqual(noneCol.cards.map((c) => c.node.id), ["tk-free"]);
    assert.deepEqual(st2Col.cards.map((c) => c.node.id), ["tk-1"]);
    assert.deepEqual(st3Col.cards.map((c) => c.node.id), ["tk-2", "b-empty"]);
  });

  test("站點軌道條進度與單站聚焦篩選：含繼承車票統計、下一站判定與祖先鏈保留", () => {
    const track = buildStationTrack({
      routeId: "r-1",
      stations,
      nodes: allNodes,
      byId,
    });
    assert.equal(track.stops.length, 3);
    assert.equal(track.stops[0].isArrived, true);
    assert.equal(track.stops[0].isNext, false);

    // st-2 是第一個未到站車站 → isNext = true，且包含繼承自 b-1 的 tk-1 (1/1 = 100%)
    assert.equal(track.stops[1].station.id, "st-2");
    assert.equal(track.stops[1].isNext, true);
    assert.equal(track.stops[1].ticketDone, 1);
    assert.equal(track.stops[1].ticketTotal, 1);
    assert.equal(track.stops[1].ticketPct, 100);

    // st-3 包含顯式覆寫的 tk-2 (0/1 = 0%)，空支線 b-empty 不誤計入車票分母
    assert.equal(track.stops[2].station.id, "st-3");
    assert.equal(track.stops[2].ticketDone, 0);
    assert.equal(track.stops[2].ticketTotal, 1);
    assert.equal(track.unassignedTotal, 1);

    // 點擊 st-3 單站篩選時：b-1 與 tr-1 因底下有 tk-2 命中而保留祖先路徑，tk-1 與 tk-free 隱藏
    assert.equal(matchesStationFilter("b-1", "st-3", tree, stMap), true);
    assert.equal(matchesStationFilter("tr-1", "st-3", tree, stMap), true);
    assert.equal(matchesStationFilter("tk-2", "st-3", tree, stMap), true);
    assert.equal(matchesStationFilter("b-empty", "st-3", tree, stMap), true);
    assert.equal(matchesStationFilter("tk-1", "st-3", tree, stMap), false);
    assert.equal(matchesStationFilter("tk-free", "st-3", tree, stMap), false);

    // 篩選未排站（NO_STATION_COL）只命中 tk-free
    assert.equal(matchesStationFilter("tk-free", NO_STATION_COL, tree, stMap), true);
    assert.equal(matchesStationFilter("b-1", NO_STATION_COL, tree, stMap), false);
  });
});

describe("視覺規範守門：station-track.css 零裸色碼與零塑膠大圓角", () => {
  test("不含 #hex / rgb() / hsl() 裸色碼，且不含 8px–16px 塑膠圓角", () => {
    const cssPath = path.join(ROOT, "src/ui/outline/station-track.css");
    const raw = readFileSync(cssPath, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

    assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(raw), false, "station-track.css 不得含 #hex 裸色碼");
    assert.equal(/\b(?:rgba?|hsla?)\s*\(/.test(raw), false, "station-track.css 不得含 rgb/hsl 裸色碼");

    const radiusLines = [...raw.matchAll(/border-radius\s*:\s*([^;]+);/g)].map((m) => m[1].trim());
    for (const val of radiusLines) {
      assert.equal(
        /\b(?:8|9|10|11|12|13|14|15|16)px\b/.test(val),
        false,
        `station-track.css 出現禁用圓角值：border-radius: ${val}`,
      );
    }
  });
});
