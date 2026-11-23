/**
 * 第三梯回饋專卷（eng-tree）完整單元與整合測試：
 *   1. 【Bug 3 ＋ 操作 6 資料層】CreateNodeInput.stationId 同筆 INSERT 與 oplog 寫入（SQLite ＋ Memory）
 *   2. 【Bug 3 ＋ 操作 6 看板與繼承】effectiveStation／inheritedStationOf 祖先鏈繼承、boardCards 空支線納入與 stationColumns 歸欄
 *   3. 【操作 6 軌道條與篩選】stationTrack.ts：buildStationTrack 各站車票進度與未排站計數、matchesStationFilter 單站與繼承子樹判定
 *   4. 【討論 4 方針層級收斂】AIM_ATTACH_KINDS === ["route"]、resolveAimRouteId 歷史支線向上相容
 *
 * 跑法：`node --test scripts/tests/fb-w3-core.test.ts`
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { NodeRow } from "../../src/domain/node.ts";
import {
  NO_STATION_COL,
  boardCards,
  effectiveStation,
  inheritedStationOf,
  isVisibleCard,
  stationColumns,
  type BoardNode,
} from "../../src/domain/board.ts";
import { buildStationTrack, matchesStationFilter } from "../../src/domain/stationTrack.ts";
import { AIM_ATTACH_KINDS, AIM_TEXT_MAX, checkAimText, isAimAttachableKind, resolveAimRouteId } from "../../src/domain/weekAims.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const FAKE_DB = `
let t = Date.UTC(2026, 10, 20, 1, 0, 0);
export function getDb() { const d = globalThis.__dbW3; if (!d) throw new Error("測試沒設 __dbW3"); return Promise.resolve(d); }
export function uuid() { return crypto.randomUUID(); }
export function nowUtcIso() { t += 1000; return new Date(t).toISOString(); }
`;
const FAKE_SYNC = `
export const SYNC_WRITE_EVENT = "ns:sync-write";
export const SYNC_SETTINGS_KEYS = new Set();
export function newWriteBatch() { return { stmts: [], ops: [] }; }
export async function runWriteBatch(db, stmts, ops) { db.runBatch(stmts, ops); }
export async function occurrenceId(n, d) { return n + "|" + d; }
export async function ensureSyncTables() { return false; }
`;
const FAKE_CORE = `export async function invoke() { throw new Error("測試不 invoke"); }`;
const FAKE_WINDOW_THEME = `export function syncWindowTheme() {}`;

const dataUrl = (src: string) => "data:text/javascript," + encodeURIComponent(src);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const fromSrc = context.parentURL !== undefined && context.parentURL.includes("/src/");
    if (fromSrc) {
      if (specifier === "../lib/db") return { url: dataUrl(FAKE_DB), shortCircuit: true };
      if (specifier === "./syncRepository") return { url: dataUrl(FAKE_SYNC), shortCircuit: true };
      if (specifier === "@tauri-apps/api/core") return { url: dataUrl(FAKE_CORE), shortCircuit: true };
      if (specifier === "../lib/windowTheme") return { url: dataUrl(FAKE_WINDOW_THEME), shortCircuit: true };
      if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) {
        try {
          return nextResolve(specifier + ".ts", context);
        } catch {
          return nextResolve(specifier + "/index.ts", context);
        }
      }
    }
    return nextResolve(specifier, context);
  },
});

interface Op {
  tbl: string;
  row_id: string;
  op: string;
  cols: Record<string, unknown>;
}
interface Batch {
  ops: Op[];
}
interface TestDb {
  batches: Batch[];
  raw: DatabaseSync;
  select(sql: string, args?: unknown[]): Promise<Record<string, unknown>[]>;
  execute(sql: string, args?: unknown[]): Promise<{ rowsAffected: number }>;
  runBatch(stmts: { sql: string; args: unknown[] }[], ops: Op[]): void;
}
const bind = (args: unknown[] = []) => Object.fromEntries(args.map((v, i) => ["$" + (i + 1), v])) as Record<string, never>;

function makeDb(): TestDb {
  const raw = new DatabaseSync(":memory:");
  const dir = path.join(ROOT, "src-tauri/migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    raw.exec(readFileSync(path.join(dir, f), "utf8"));
  }
  const db: TestDb = {
    batches: [],
    raw,
    async select(sql, args) {
      return raw.prepare(sql).all(bind(args)) as Record<string, unknown>[];
    },
    async execute(sql, args) {
      const r = raw.prepare(sql).run(bind(args));
      return { rowsAffected: Number(r.changes) };
    },
    runBatch(stmts, ops) {
      raw.exec("BEGIN");
      try {
        for (const s of stmts) raw.prepare(s.sql).run(bind(s.args));
        raw.exec("COMMIT");
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      }
      db.batches.push({ ops });
    },
  };
  return db;
}

const setDb = (db: TestDb) => {
  (globalThis as Record<string, unknown>).__dbW3 = db;
};

const { SqliteNodeRepository } = await import("../../src/data/sqliteNodeRepository.ts");
const { MemoryNodeRepository } = await import("../../src/data/memoryRepository.ts");

function makeNode(
  id: string,
  kind: NodeRow["kind"],
  parent_id: string | null,
  overrides: Partial<NodeRow> = {},
): NodeRow {
  return {
    id,
    kind,
    parent_id,
    line_id: "L1",
    route_id: kind === "route" || kind === "line" ? null : "R1",
    name: id,
    description: null,
    position: 0,
    sort_key: null,
    station_id: null,
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
    account_id: null,
    device_id: null,
    created_at: "2026-11-01T00:00:00.000Z",
    updated_at: "2026-11-01T00:00:00.000Z",
    synced_at: null,
    deleted_at: null,
    ...overrides,
  };
}

describe("1. CreateNodeInput.stationId 同筆寫入（SQLite ＋ Memory）", () => {
  test("SQLite 版：建支線／列車／車票／路線臨時票時同筆 INSERT 寫入 station_id 與 oplog；未給時不進 oplog", async () => {
    const db = makeDb();
    setDb(db);
    const repo = new SqliteNodeRepository();

    const line = await repo.create({ kind: "line", name: "本線", parentId: null });
    const route = await repo.create({ kind: "route", name: "日本語", parentId: line.id, stationId: "ignored" });
    assert.equal(route.station_id, null, "route 不寫入 station_id");

    const st = await repo.create({ kind: "station", name: "N3", parentId: route.id, stationId: "ignored" });
    assert.equal(st.station_id, null, "station 不寫入 station_id");

    const branch = await repo.create({ kind: "branch", name: "文法", parentId: route.id, stationId: st.id });
    assert.equal(branch.station_id, st.id);
    const branchOp = db.batches.at(-1)?.ops.find((o) => o.row_id === branch.id && o.op === "upsert");
    assert.equal(branchOp?.cols.station_id, st.id, "branch oplog 應含 station_id");

    const train = await repo.create({ kind: "train", name: "教材列車", parentId: branch.id, stationId: st.id });
    assert.equal(train.station_id, st.id);

    const rootTicket = await repo.create({
      kind: "ticket",
      name: "自由席直選站",
      parentId: null,
      routeTagId: route.id,
      stationId: st.id,
    });
    assert.equal(rootTicket.station_id, st.id);
    assert.equal(rootTicket.route_id, route.id);
    const rtOp = db.batches.at(-1)?.ops.find((o) => o.row_id === rootTicket.id && o.op === "upsert");
    assert.equal(rtOp?.cols.station_id, st.id);

    const plainTicket = await repo.create({ kind: "ticket", name: "沒指定站", parentId: train.id });
    assert.equal(plainTicket.station_id, null);
    const plainOp = db.batches.at(-1)?.ops.find((o) => o.row_id === plainTicket.id && o.op === "upsert");
    assert.equal("station_id" in (plainOp?.cols ?? {}), false, "未給 stationId 時 oplog 不夾帶 station_id");
  });

  test("Memory 版：建支線／列車／車票／路線臨時票時同步寫入 station_id", async () => {
    const repo = new MemoryNodeRepository({ seedDemo: false });
    const line = await repo.create({ kind: "line", name: "本線", parentId: null });
    const route = await repo.create({ kind: "route", name: "日文", parentId: line.id, stationId: "ignored" });
    const st = await repo.create({ kind: "station", name: "N2", parentId: route.id });

    const branch = await repo.create({ kind: "branch", name: "閱讀", parentId: route.id, stationId: st.id });
    const ticket = await repo.create({ kind: "ticket", name: "第一篇", parentId: branch.id, stationId: st.id });
    const loose = await repo.create({ kind: "ticket", name: "臨時票", parentId: null, routeTagId: route.id, stationId: st.id });
    const none = await repo.create({ kind: "ticket", name: "不掛站", parentId: branch.id });

    assert.equal(route.station_id, null);
    assert.equal(branch.station_id, st.id);
    assert.equal(ticket.station_id, st.id);
    assert.equal(loose.station_id, st.id);
    assert.equal(none.station_id, null);
  });
});

describe("2. 掛站繼承與看板空支線保留（src/domain/board.ts）", () => {
  const stations = [
    makeNode("S1", "station", "R1", { route_id: null, name: "起站" }),
    makeNode("S2", "station", "R1", { route_id: null, name: "終站" }),
    makeNode("S_OTHER", "station", "R2", { route_id: null, name: "他線車站" }),
    makeNode("S_DEL", "station", "R1", { route_id: null, name: "已刪車站", deleted_at: "2026-11-02T00:00:00.000Z" }),
  ];
  const stationMap = new Map(stations.map((s) => [s.id, s]));

  test("inheritedStationOf & effectiveStation：沿祖先鏈繼承、自身覆寫優先、跨路線／已刪擋下、防循環", () => {
    const branch = makeNode("B1", "branch", "R1", { name: "文法支線", station_id: "S1" });
    const train = makeNode("T1", "train", "B1", { name: "助詞列車", station_id: null });
    const car = makeNode("C1", "car", "T1", { name: "格助詞車廂", station_id: null });
    const childInherit = makeNode("k1", "ticket", "C1", { station_id: null });
    const childOverride = makeNode("k2", "ticket", "C1", { station_id: "S2" });
    const childStaleForeign = makeNode("k3", "ticket", "B1", { station_id: "S_OTHER" });
    const branchDelStation = makeNode("B_DEL", "branch", "R1", { name: "舊站支線", station_id: "S_DEL" });
    const childUnderDel = makeNode("k4", "ticket", "B_DEL", { station_id: null });
    const cycleA = makeNode("CYC1", "train", "CYC2", { station_id: null });
    const cycleB = makeNode("CYC2", "branch", "CYC1", { station_id: null });

    const byId = Object.fromEntries(
      [branch, train, car, childInherit, childOverride, childStaleForeign, branchDelStation, childUnderDel, cycleA, cycleB].map((n) => [
        n.id,
        n,
      ]),
    );

    assert.deepEqual(inheritedStationOf(childInherit, stationMap, byId), {
      stationId: "S1",
      inheritedFrom: { id: "B1", name: "文法支線" },
    });
    assert.equal(effectiveStation(childInherit, stationMap, byId), "S1");
    assert.equal(effectiveStation(childInherit, stationMap), null, "不傳 byId 維持 2 參數舊行為");

    assert.deepEqual(inheritedStationOf(childOverride, stationMap, byId), {
      stationId: "S2",
      inheritedFrom: null,
    });

    assert.deepEqual(inheritedStationOf(childStaleForeign, stationMap, byId), {
      stationId: "S1",
      inheritedFrom: { id: "B1", name: "文法支線" },
    });

    assert.deepEqual(inheritedStationOf(childUnderDel, stationMap, byId), {
      stationId: null,
      inheritedFrom: null,
    });

    assert.deepEqual(inheritedStationOf(cycleA, stationMap, byId), {
      stationId: null,
      inheritedFrom: null,
    });
  });

  test("boardCards({ includeEmptyBranches: true }) 與 stationColumns：空支線與繼承子車票皆正確歸站", () => {
    const emptyB1 = makeNode("EB1", "branch", "R1", { name: "空支線1", station_id: "S1" });
    const emptyB2 = makeNode("EB2", "branch", "R1", { name: "未排站空支線", station_id: null });
    const parentB = makeNode("PB", "branch", "R1", { name: "已掛站支線", station_id: "S2" });
    const emptyT = makeNode("ET", "train", "PB", { name: "繼承空列車", station_id: null });
    const tInherit = makeNode("t1", "ticket", "PB", { name: "繼承車票", station_id: null });
    const tOverride = makeNode("t2", "ticket", "PB", { name: "改掛起站", station_id: "S1" });
    const tree = {
      byId: Object.fromEntries([emptyB1, emptyB2, parentB, emptyT, tInherit, tOverride].map((n) => [n.id, n])),
      childrenOf: { PB: ["ET", "t1", "t2"] } as Record<string, string[]>,
    };
    const roots = ["EB1", "EB2", "PB"];

    assert.deepEqual(
      boardCards(tree, roots).map((c) => c.node.id),
      ["ET", "t1", "t2"],
      "預設 boardCards 不變",
    );
    assert.equal(isVisibleCard(tree, "EB1", undefined, true), false);
    assert.equal(isVisibleCard(tree, "EB1", undefined, true, { includeEmptyBranches: true }), true);

    const cards = boardCards(tree, roots, [], { includeEmptyBranches: true });
    assert.deepEqual(cards.map((c) => c.node.id), ["EB1", "EB2", "ET", "t1", "t2"]);

    const cols = stationColumns(cards, stations.slice(0, 2), tree.byId);
    assert.deepEqual(cols.map((c) => c.station?.id ?? null), [null, "S1", "S2"]);
    assert.deepEqual(cols[0].cards.map((c) => c.node.id), ["EB2"]);
    assert.deepEqual(cols[1].cards.map((c) => c.node.id), ["EB1", "t2"]);
    assert.deepEqual(cols[2].cards.map((c) => c.node.id), ["ET", "t1"]);
  });
});

describe("3. 站點軌道條與單站篩選（src/domain/stationTrack.ts）", () => {
  test("buildStationTrack：計算各站含繼承車票進度、定期券與未排站、routeArrived", () => {
    const stations = [
      makeNode("S2", "station", "R1", { route_id: null, name: "第二站", position: 1, arrived_on: null, expected_on: "2026-12-01" }),
      makeNode("S1", "station", "R1", { route_id: null, name: "第一站", position: 0, arrived_on: "2026-11-10" }),
      makeNode("S3", "station", "R1", { route_id: null, name: "第三站", position: 2, arrived_on: null }),
      makeNode("S_OTHER", "station", "R2", { route_id: null, name: "他線", position: 0 }),
    ];
    const b1 = makeNode("B1", "branch", "R1", { station_id: "S1" });
    const k1 = makeNode("k1", "ticket", "B1", { status: "done" }); // 繼承 S1, done
    const k2 = makeNode("k2", "ticket", "B1", { status: "todo" }); // 繼承 S1, todo
    const k3 = makeNode("k3", "ticket", "B1", { status: "todo", station_id: "S2" }); // 覆寫 S2, 定期券
    const k4 = makeNode("k4", "ticket", "B1", { status: "paused", station_id: "S2" }); // paused 未完成不計入分母
    const kLoose = makeNode("kLoose", "ticket", null, { route_id: "R1", status: "done", station_id: null }); // 未排站
    const kOtherRoute = makeNode("kOther", "ticket", "R2", { route_id: "R2", status: "done", station_id: "S_OTHER" });
    const trainDone = makeNode("T1", "train", "B1", { status: "done" }); // 列車不計入車票數

    const nodes = [b1, k1, k2, k3, k4, kLoose, kOtherRoute, trainDone];
    const track = buildStationTrack({
      routeId: "R1",
      stations,
      nodes,
      occurrences: { k3: { status: "done", due_on: "2026-11-20" } },
    });

    assert.deepEqual(
      track.stops.map((s) => ({
        id: s.station.id,
        done: s.ticketDone,
        total: s.ticketTotal,
        pct: s.ticketPct,
        isArrived: s.isArrived,
        isNext: s.isNext,
      })),
      [
        { id: "S1", done: 1, total: 2, pct: 50, isArrived: true, isNext: false },
        { id: "S2", done: 1, total: 1, pct: 100, isArrived: false, isNext: true },
        { id: "S3", done: 0, total: 0, pct: 0, isArrived: false, isNext: false },
      ],
    );
    assert.equal(track.unassignedDone, 1);
    assert.equal(track.unassignedTotal, 1);

    const garageTrack = buildStationTrack({ routeId: "R1", stations, nodes, routeArrived: true });
    assert.equal(garageTrack.stops.some((s) => s.isNext), false, "進車庫路線不標示下一站");
  });

  test("matchesStationFilter：單站篩選含繼承子項、祖先路徑保留與未排站篩選", () => {
    const stations = [
      makeNode("S1", "station", "R1", { route_id: null }),
      makeNode("S2", "station", "R1", { route_id: null }),
    ];
    const b1 = makeNode("B1", "branch", "R1", { station_id: "S1" });
    const tInherit = makeNode("t1", "ticket", "B1", { station_id: null });
    const tOverride = makeNode("t2", "ticket", "B1", { station_id: "S2" });
    const bUnassigned = makeNode("B2", "branch", "R1", { station_id: null });
    const tUnassigned = makeNode("t3", "ticket", "B2", { station_id: null });
    const tInB2WithS2 = makeNode("t4", "ticket", "B2", { station_id: "S2" });
    const tree = {
      byId: Object.fromEntries([b1, tInherit, tOverride, bUnassigned, tUnassigned, tInB2WithS2].map((n) => [n.id, n])),
      childrenOf: { B1: ["t1", "t2"], B2: ["t3", "t4"] } as Record<string, string[]>,
    };

    assert.equal(matchesStationFilter("t1", null, tree, stations), true);
    assert.equal(matchesStationFilter("t1", "S1", tree, stations), true, "繼承自支線 B1 的車票命中 S1");
    assert.equal(matchesStationFilter("t2", "S1", tree, stations), false, "已覆寫到 S2 的車票不命中 S1");
    assert.equal(matchesStationFilter("B1", "S2", tree, stations), true, "祖先容器底下有命中 S2 的子孫時保留顯示");
    assert.equal(matchesStationFilter("B2", "S2", tree, stations), true);
    assert.equal(matchesStationFilter("t3", "S2", tree, stations), false);
    assert.equal(matchesStationFilter("t3", NO_STATION_COL, tree, stations), true, "未排站篩選");
    assert.equal(matchesStationFilter("t1", NO_STATION_COL, tree, stations), false, "已繼承 S1 不屬於未排站");
  });
});

describe("4. 討論 4：方針掛載收斂為 route 與歷史支線向上相容（src/domain/weekAims.ts）", () => {
  test("AIM_ATTACH_KINDS === ['route'] 且 resolveAimRouteId 相容歷史支線與深層節點", () => {
    assert.deepEqual(AIM_ATTACH_KINDS, ["route"]);
    assert.equal(isAimAttachableKind("route"), true);
    assert.equal(isAimAttachableKind("branch"), false);

    const route = makeNode("R1", "route", "L1", { route_id: null });
    const routeDeleted = makeNode("R_DEL", "route", "L1", { route_id: null, deleted_at: "2026-11-10T00:00:00.000Z" });
    const branch = makeNode("B1", "branch", "R1", { route_id: "R1" });
    const branchLegacyNoCache = makeNode("B2", "branch", "R1", { route_id: null });
    const branchUnderDeletedRoute = makeNode("B3", "branch", "R_DEL", { route_id: "R_DEL" });
    const byId = Object.fromEntries([route, routeDeleted, branch, branchLegacyNoCache, branchUnderDeletedRoute].map((n) => [n.id, n]));

    assert.equal(resolveAimRouteId("R1", byId), "R1");
    assert.equal(resolveAimRouteId("B1", byId), "R1");
    assert.equal(resolveAimRouteId("B2", byId), "R1");
    assert.equal(resolveAimRouteId("B3", byId), null);
    assert.equal(resolveAimRouteId("missing", byId), null);
    assert.equal(resolveAimRouteId(null, byId), null);
  });

  test("AIM_TEXT_MAX === 160 且 checkAimText 保留 Shift+Enter 句內換行", () => {
    assert.equal(AIM_TEXT_MAX, 160);
    assert.equal(checkAimText("  第一行   重點\r\n  第二行  \n\n\n  第三行 "), "第一行 重點\n第二行\n\n第三行");
    assert.equal(checkAimText("字".repeat(160)).length, 160);
    assert.throws(() => checkAimText("字".repeat(161)), /最多 160 個字/);
  });
});
