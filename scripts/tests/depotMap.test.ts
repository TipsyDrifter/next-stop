/**
 * 第五本第三梯 ③-2 走行圖——版面純函式（D-主-551～558）。
 * 跑法：`node --test scripts/tests/depotMap.test.ts`（node 24，型別剝除預設開；零依賴）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  NET_MIN_WIDTH,
  NO_LINE_NAME,
  buildRouteMap,
  fitText,
  fmtMapDay,
  layoutNet,
  layoutRouteMap,
  layoutTree,
  trunkKey,
  type LaidRoute,
  type MapTrunk,
} from "../../src/domain/depotMap.ts";

const TODAY = "2029-11-06";
const line = (id: string, arrived_on: string | null = null) => ({ id, name: id, arrived_on });
const route = (id: string, line_id: string | null, arrived_on: string | null = null) => ({ id, line_id, name: id, code: id.slice(0, 2), color: null, arrived_on });
const station = (id: string, route_id: string | null, arrived_on: string | null) => ({ id, route_id, name: id, arrived_on });

/** n 條路線的幹線，隨機混到站與車站（固定種子） */
function trunk(id: string, n: number, withStations = 0): MapTrunk {
  return {
    id,
    name: id,
    arrived_on: null,
    routes: Array.from({ length: n }, (_, i) => ({
      id: `${id}-${i}`,
      name: `路線${i}`,
      code: "R",
      color: null,
      arrived_on: i % 2 ? "2029-01-02" : null,
      termName: null,
      stations: Array.from({ length: withStations }, (_, k) => ({ id: `${id}-${i}-${k}`, name: "站", day: `2029-01-0${(k % 9) + 1}` })),
    })),
  };
}

/** 斜段 + 水平段：看同一側兩條路線的斜段有沒有交叉 */
function segCross(a: LaidRoute, b: LaidRoute): boolean {
  const seg = (r: LaidRoute) => [r.junction, r.badge] as const;
  const [p1, p2] = seg(a);
  const [p3, p4] = seg(b);
  const d = (p: { x: number; y: number }, q: { x: number; y: number }, r: { x: number; y: number }) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  return d(p1, p2, p3) * d(p1, p2, p4) < 0 && d(p3, p4, p1) * d(p3, p4, p2) < 0;
}

describe("buildRouteMap", () => {
  test("只收已到着的車站、舊→新；照傳入順序分幹線", () => {
    const t = buildRouteMap(
      [line("L1"), line("L2")],
      [route("R1", "L1"), route("R2", "L2")],
      [station("新", "R1", "2029-02-01"), station("舊", "R1", "2029-01-01"), station("沒到", "R1", null)],
    );
    assert.deepEqual(t.map((x) => x.id), ["L1", "L2"]);
    assert.deepEqual(t[0].routes[0].stations.map((s) => s.name), ["舊", "新"]);
  });

  test("到站日那天到着的最後一站併進終點，不另畫白點", () => {
    const [t] = buildRouteMap([line("L")], [route("R", "L", "2029-03-01")], [station("甲", "R", "2029-02-01"), station("乙", "R", "2029-03-01")]);
    assert.equal(t.routes[0].termName, "乙");
    assert.deepEqual(t.routes[0].stations.map((s) => s.name), ["甲"]);
  });

  test("找不到幹線的路線不會憑空消失", () => {
    const t = buildRouteMap([line("L")], [route("R", "L"), route("X", "不見了"), route("Y", null)], []);
    assert.equal(t.length, 2);
    assert.equal(t[1].name, NO_LINE_NAME);
    assert.deepEqual(t[1].routes.map((r) => r.id), ["X", "Y"]);
  });
});

describe("日期與字", () => {
  test("今年 M.D、別年帶年份", () => {
    assert.equal(fmtMapDay("2029-05-15", TODAY), "5.15");
    assert.equal(fmtMapDay("2027-05-15", TODAY), "2027.5.15");
  });
  test("放不下才截斷", () => {
    assert.equal(fitText("短", 100, 12.5), "短");
    const cut = fitText("畢業專題文獻資料蒐集與期末口試簡報準備", 100, 12.5);
    assert.ok(cut.endsWith("…"));
    assert.ok(cut.length < 19);
  });
});

describe("版面", () => {
  for (const n of [1, 2, 6, 15, 30]) {
    test(`寬版 ${n} 條：水平段對齊、斜段不交叉、都在畫布內`, () => {
      const L = layoutNet([trunk("T", n, 3)], 740, TODAY);
      const rs = L.trunks[0].routes;
      assert.equal(new Set(rs.map((r) => r.badge.x)).size, 1);
      for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) assert.equal(segCross(rs[i], rs[j]), false, `${i}×${j}`);
      for (const r of rs) {
        assert.ok(r.end.x > r.badge.x + 60, "水平段還留得下");
        assert.ok(r.end.x <= 740);
        assert.ok(r.junction.x >= 20);
      }
      const ys = rs.map((r) => r.badge.y);
      assert.ok(Math.min(...ys) > 0 && Math.max(...ys) < L.height);
    });
  }

  test("線長跟資料量無關：車站多寡不改線尾", () => {
    const a = layoutNet([trunk("T", 2, 0)], 740, TODAY).trunks[0].routes;
    const b = layoutNet([trunk("T", 2, 7)], 740, TODAY).trunks[0].routes;
    assert.deepEqual(a.map((r) => r.end), b.map((r) => r.end));
  });

  test("到站才有終點；運行中沒有", () => {
    const rs = layoutTree([trunk("T", 2)], 340, TODAY).trunks[0].routes;
    assert.equal(rs[0].term, null);
    assert.equal(rs[0].running, true);
    assert.equal(rs[1].term?.date, "1.2");
  });

  test("車站太多：留最近的、白點不疊在一起", () => {
    const [r] = layoutTree([trunk("T", 1, 60)], 340, TODAY).trunks[0].routes;
    assert.ok(r.hiddenStations > 0);
    assert.equal(r.stations.length + r.hiddenStations, 60);
    assert.equal(r.stations.at(-1)!.id, "T-0-59");
    assert.ok(r.stations[1].x - r.stations[0].x >= 13);
  });

  test("窄版一列 46 高、幹線到站收雙圈", () => {
    const t: MapTrunk = { ...trunk("T", 3), arrived_on: "2029-02-02" };
    const [lt] = layoutTree([t], 340, TODAY).trunks;
    assert.equal(lt.routes[1].badge.y - lt.routes[0].badge.y, 46);
    assert.equal(lt.tail, null);
    assert.equal(lt.term?.date, "2.2");
  });

  test("窄版：底下沒路線的幹線，線不會從名牌下面露出一截", () => {
    for (const lt of [layoutTree([trunk("E", 0)], 340, TODAY).trunks[0], layoutTree([trunk("F", 3)], 340, TODAY, 14, new Set(["F"])).trunks[0]]) {
      assert.equal(lt.tail, null);
      const bottom = Number(lt.solid.split("V")[1]);
      assert.ok(bottom + 3.5 <= lt.plate.y + 24, `${bottom} 超出名牌`);
    }
  });

  test("沒有路線的幹線、完全空的都不會壞", () => {
    assert.equal(layoutNet([trunk("T", 0)], 740, TODAY).trunks[0].routes.length, 0);
    assert.equal(layoutTree([], 340, TODAY).trunks.length, 0);
  });

  for (const [name, fn, w] of [["寬版", layoutNet, 740], ["窄版", layoutTree, 340]] as const) {
    test(`${name}收合：路線不畫、寫條數、下一條幹線往上收、高度變矮`, () => {
      const ts = [trunk("A", 6, 2), trunk("B", 4)];
      const open = fn(ts, w, TODAY);
      const shut = fn(ts, w, TODAY, 12.5, new Set(["A"]));
      assert.equal(open.trunks[0].folded, false);
      assert.equal(shut.trunks[0].folded, true);
      assert.equal(shut.trunks[0].routes.length, 0);
      assert.equal(shut.trunks[0].count?.text, "6 條路線");
      assert.equal(shut.trunks[1].routes.length, 4);
      assert.ok(shut.trunks[1].junction.y < open.trunks[1].junction.y);
      assert.ok(shut.height < open.height);
      assert.equal(open.trunks[0].count, null);
    });

    test(`${name}收合：沒路線的幹線收不起來；到站的幹線仍收在雙圈`, () => {
      const empty = fn([trunk("E", 0)], w, TODAY, 12.5, new Set(["E"])).trunks[0];
      assert.equal(empty.foldable, false);
      assert.equal(empty.folded, false);
      assert.equal(empty.caret, null);
      const parked: MapTrunk = { ...trunk("P", 3), arrived_on: "2029-02-02" };
      const lt = fn([parked], w, TODAY, 12.5, new Set(["P"])).trunks[0];
      assert.equal(lt.term?.date, "2.2");
      assert.equal(lt.tail, null);
    });
  }

  test("找不到幹線的那一組也能收", () => {
    assert.equal(trunkKey({ id: null }), "none");
    const orphan: MapTrunk = { ...trunk("x", 2), id: null };
    assert.equal(layoutNet([orphan], 740, TODAY, 12.5, new Set(["none"])).trunks[0].folded, true);
  });

  test("寬度決定排法：手機寬一定直立", () => {
    assert.equal(layoutRouteMap([], NET_MIN_WIDTH, TODAY).mode, "net");
    assert.equal(layoutRouteMap([], NET_MIN_WIDTH - 1, TODAY).mode, "tree");
    assert.equal(layoutRouteMap([], 340, TODAY).mode, "tree");
  });
});
