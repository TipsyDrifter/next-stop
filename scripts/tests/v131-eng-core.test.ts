/**
 * 第一梯（v1.31）eng-core 核心領域模型與資料層回歸測試：
 *   1. Bug 1（最下層葉節點一律為 ticket）：
 *      - defaultChildKind 對 route/branch/train/car 回傳 "ticket"
 *      - backfillLeafTickets()（SQLite ＋ Memory）：把無存活子項的 train/car 轉為 "ticket"，
 *        不觸碰 updated_at、保留 serial/sort_key/日期/狀態、寫入 { kind: "ticket" } oplog，且冪等
 *      - 搬移（move／moveMany）、新建、軟刪／復原時，葉節點保持 ticket、目標 ticket 自動升格、
 *        帶存活子項的父節點搬移維持 train/car 層級不被壓成 ticket、失去最後一個子項的父節點自動降回 ticket
 *   2. Bug 2（途中下車 paused 全面退出誤點與待辦提醒）：
 *      - SqliteNodeRepository / MemoryNodeRepository 的 listToday 與 routeOpenCounts 排除 paused
 *      - buildSchedule / buildCalendar / buildScheduleBounds / lateCount / lateItemsOf / taskFilter 全面排除 paused
 *
 * 跑法：`node --test scripts/tests/v131-eng-core.test.ts`
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const FAKE_DB = `
let t = Date.UTC(2026, 10, 10, 1, 0, 0);
export function getDb() { const d = globalThis.__db; if (!d) throw new Error("測試沒設 __db"); return Promise.resolve(d); }
export function uuid() { return crypto.randomUUID(); }
export function nowUtcIso() { t += 1000; return new Date(t).toISOString(); }
`;
const FAKE_SYNC = `
export const SYNC_WRITE_EVENT = "ns:sync-write";
export function newWriteBatch() { return { stmts: [], ops: [] }; }
export async function runWriteBatch(db, stmts, ops) { db.runBatch(stmts, ops); }
export async function occurrenceId(n, d) { return n + "|" + d; }
export async function ensureSyncTables() { return false; }
`;
const FAKE_CORE = `export async function invoke() { throw new Error("測試不 invoke"); }`;
const dataUrl = (src: string) => "data:text/javascript," + encodeURIComponent(src);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const fromSrc = context.parentURL !== undefined && context.parentURL.includes("/src/");
    if (fromSrc) {
      if (specifier === "../lib/db") return { url: dataUrl(FAKE_DB), shortCircuit: true };
      if (specifier === "./syncRepository") return { url: dataUrl(FAKE_SYNC), shortCircuit: true };
      if (specifier === "@tauri-apps/api/core") return { url: dataUrl(FAKE_CORE), shortCircuit: true };
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
  (globalThis as Record<string, unknown>).__db = db;
};

const { defaultChildKind, promotedKindForParent } = await import("../../src/domain/node.ts");
const { lateCount } = await import("../../src/domain/dayCount.ts");
const { DEFAULT_TASK_FILTER, isTaskSettled, isTaskLate, isTaskOverdue, matchTask } = await import("../../src/domain/taskFilter.ts");
const { routeHeadStats } = await import("../../src/domain/routeHead.ts");
const { buildRouteOverview } = await import("../../src/domain/routeOverview.ts");
const { lateItemsOf } = await import("../../src/domain/timetableSchedule.ts");
const { buildSchedule, buildCalendar, buildScheduleBounds, buildRouteOpenCounts } = await import("../../src/data/nodeRepository.ts");
const { MemoryNodeRepository } = await import("../../src/data/memoryRepository.ts");
const { SqliteNodeRepository } = await import("../../src/data/sqliteNodeRepository.ts");

function makeNodeRow(over: Partial<import("../../src/domain/node.ts").NodeRow> & { id: string }): import("../../src/domain/node.ts").NodeRow {
  return {
    parent_id: null,
    line_id: null,
    route_id: null,
    kind: "ticket",
    name: over.id,
    note: null,
    code: null,
    color: null,
    status: "todo",
    position: 0,
    sort_key: null,
    scheduled_on: null,
    scheduled_time: null,
    due_on: null,
    estimate_min: null,
    repeat_rule: null,
    repeat_paused: 0,
    done_at: null,
    arrived_at: null,
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    deleted_at: null,
    ...over,
  };
}

/* ═════════════════════════════════════════════
 * Bug 1：最下層葉節點一律為車票（ticket）
 * ═════════════════════════════════════════════ */

describe("Bug 1 · 領域與搬移層級不變量", () => {
  test("defaultChildKind：路線／支線／列車／車廂預設新任務皆為 ticket", () => {
    assert.equal(defaultChildKind("line"), "route");
    assert.equal(defaultChildKind("route"), "ticket");
    assert.equal(defaultChildKind("branch"), "ticket");
    assert.equal(defaultChildKind("train"), "ticket");
    assert.equal(defaultChildKind("car"), "ticket");
    assert.equal(defaultChildKind("ticket"), null);
    assert.equal(defaultChildKind("station"), null);

    assert.equal(promotedKindForParent("route"), "train");
    assert.equal(promotedKindForParent("branch"), "train");
    assert.equal(promotedKindForParent("train"), "car");
    assert.equal(promotedKindForParent("car"), "car");
    assert.equal(promotedKindForParent("ticket"), "car");
  });

  for (const kindName of ["memory", "sqlite"] as const) {
    test(`新建・搬移・刪子自動升降級（${kindName}）`, async () => {
      let repo: import("../../src/data/nodeRepository.ts").NodeRepository;
      if (kindName === "sqlite") {
        setDb(makeDb());
        repo = new SqliteNodeRepository();
      } else {
        repo = new MemoryNodeRepository();
      }

      const line = await repo.create({ kind: "line", name: "幹線" });
      const route = await repo.create({ kind: "route", parentId: line.id, name: "路線" });
      const branch = await repo.create({ kind: "branch", parentId: route.id, name: "支線" });

      // ① 直接在路線、支線底下建車票
      const tUnderRoute = await repo.create({ kind: "ticket", parentId: route.id, name: "直掛路線的車票" });
      const tUnderBranch = await repo.create({ kind: "ticket", parentId: branch.id, name: "支線下的車票" });
      const tLeaf = await repo.create({ kind: "ticket", parentId: route.id, name: "準備被縮排的車票" });
      assert.equal(tUnderRoute.kind, "ticket");
      assert.equal(tUnderBranch.kind, "ticket");

      // ② 葉節點搬進另一張車票底下：被搬的仍是 ticket，目標父 ticket 升格為 train
      await repo.move(tLeaf.id, tUnderRoute.id);
      const movedLeaf = await repo.getNode(tLeaf.id);
      assert.equal(movedLeaf?.kind, "ticket", "葉節點縮排後仍應為 ticket");
      assert.equal((await repo.getNode(tUnderRoute.id))?.kind, "train", "接收子項的路線直屬車票應升格為 train");

      // ③ 帶子項的父節點（tUnderRoute，目前是 train 且底下有 tLeaf）搬到支線或另一台列車底下
      //    即使呼叫端傳了 newKind: "ticket"，有存活子項的節點也絕不可被壓成 ticket！
      const trainHolder = await repo.create({ kind: "ticket", parentId: route.id, name: "另一張票" });
      const subChild = await repo.create({ kind: "ticket", parentId: trainHolder.id, name: "孫票" });
      assert.equal((await repo.getNode(trainHolder.id))?.kind, "train");
      assert.equal(subChild.kind, "ticket");

      await repo.move(tUnderRoute.id, trainHolder.id, { newKind: "ticket" });
      const movedParentIntoTrain = await repo.getNode(tUnderRoute.id);
      assert.equal(movedParentIntoTrain?.kind, "car", "有存活子項的列車搬進列車下應調整為 car，不可壓成 ticket");
      assert.equal((await repo.getNode(tLeaf.id))?.kind, "ticket", "底下的葉子依然是 ticket");

      // 再把這台帶著子項的 car 搬回支線下（即使傳 newKind: "ticket"），應變回 train
      await repo.move(tUnderRoute.id, branch.id, { newKind: "ticket" });
      const movedParentToBranch = await repo.getNode(tUnderRoute.id);
      assert.equal(movedParentToBranch?.kind, "train", "有存活子項的車廂搬進支線下應升回 train");
      assert.equal((await repo.getNode(trainHolder.id))?.kind, "train");

      // ④ 移走最後一個子項 → 原父節點自動降回 ticket
      await repo.move(tLeaf.id, route.id);
      assert.equal((await repo.getNode(tUnderRoute.id))?.kind, "ticket", "移走最後一個子項後應自動降回 ticket");

      // ⑤ 軟刪最後一個子項 → 父節點降回 ticket；復原該子項 → 父節點升回 train
      await repo.softDelete(subChild.id);
      assert.equal((await repo.getNode(trainHolder.id))?.kind, "ticket", "軟刪最後一個子項後父節點降回 ticket");
      await repo.restore([subChild.id]);
      assert.equal((await repo.getNode(trainHolder.id))?.kind, "train", "復原最後一個子項後父節點升回 train");
    });
  }

  test("backfillLeafTickets（sqlite）：僅轉無存活子項的 train/car 為 ticket，保 updated_at／欄位，寫 oplog 且冪等", async () => {
    const db = makeDb();
    setDb(db);
    const oldTs = "2026-01-01T00:00:00.000Z";
    db.raw.exec(`
      INSERT INTO nodes (id, kind, parent_id, line_id, route_id, name, status, sort_key, scheduled_on, due_on, created_at, updated_at, deleted_at) VALUES
        ('L1', 'line', NULL, NULL, NULL, '幹線', 'todo', 'a0', NULL, NULL, '${oldTs}', '${oldTs}', NULL),
        ('R1', 'route', 'L1', 'L1', NULL, '路線', 'todo', 'a0', NULL, NULL, '${oldTs}', '${oldTs}', NULL),
        ('T_EMPTY', 'train', 'R1', 'L1', 'R1', '空列車', 'todo', 'a1', '2026-11-01', '2026-11-05', '${oldTs}', '${oldTs}', NULL),
        ('T_SOFT_CHILD', 'train', 'R1', 'L1', 'R1', '只有已刪子項的列車', 'paused', 'a2', '2026-11-02', NULL, '${oldTs}', '${oldTs}', NULL),
        ('C_DELETED', 'car', 'T_SOFT_CHILD', 'L1', 'R1', '已軟刪車廂', 'todo', 'a0', NULL, NULL, '${oldTs}', '${oldTs}', '${oldTs}'),
        ('T_WITH_KID', 'train', 'R1', 'L1', 'R1', '有存活子項的列車', 'todo', 'a3', NULL, NULL, '${oldTs}', '${oldTs}', NULL),
        ('C_EMPTY', 'car', 'T_WITH_KID', 'L1', 'R1', '空車廂(應變票)', 'todo', 'a0', '2026-11-03', NULL, '${oldTs}', '${oldTs}', NULL),
        ('C_WITH_KID', 'car', 'T_WITH_KID', 'L1', 'R1', '有子項的車廂', 'todo', 'a1', NULL, NULL, '${oldTs}', '${oldTs}', NULL),
        ('K_KID', 'ticket', 'C_WITH_KID', 'L1', 'R1', '最底層票', 'todo', 'a0', NULL, NULL, '${oldTs}', '${oldTs}', NULL),
        ('T_DELETED_SELF', 'train', 'R1', 'L1', 'R1', '已刪空列車', 'todo', 'a4', NULL, NULL, '${oldTs}', '${oldTs}', '${oldTs}');
    `);

    const repo = new SqliteNodeRepository();
    // 第一次呼叫（例如 listTasks）即自動觸發啟動回填
    const tasks = await repo.listTasks();
    const byId = Object.fromEntries(tasks.map((t) => [t.id, t]));
    assert.equal(byId.T_EMPTY.kind, "ticket");
    assert.equal(byId.T_SOFT_CHILD.kind, "ticket", "只有軟刪子項也視同無存活子項，應轉為 ticket");
    assert.equal(byId.C_EMPTY.kind, "ticket", "有父列車但自己無子項的空車廂應轉為 ticket");
    assert.equal(byId.T_WITH_KID.kind, "train", "有存活子項的列車維持 train");
    assert.equal(byId.C_WITH_KID.kind, "car", "有存活子項的車廂維持 car");
    assert.equal(byId.K_KID.kind, "ticket");

    // 保留原 updated_at、sort_key、scheduled_on、due_on、status，且已軟刪節點不動
    const rawRows = db.raw.prepare("SELECT id, kind, status, sort_key, scheduled_on, due_on, updated_at FROM nodes ORDER BY id").all() as Record<string, unknown>[];
    const rawById = Object.fromEntries(rawRows.map((r) => [String(r.id), r]));
    assert.equal(rawById.T_EMPTY.updated_at, oldTs);
    assert.equal(rawById.T_EMPTY.sort_key, "a1");
    assert.equal(rawById.T_EMPTY.scheduled_on, "2026-11-01");
    assert.equal(rawById.T_EMPTY.due_on, "2026-11-05");
    assert.equal(rawById.T_SOFT_CHILD.status, "paused");
    assert.equal(rawById.T_SOFT_CHILD.updated_at, oldTs);
    assert.equal(rawById.C_EMPTY.updated_at, oldTs);
    assert.equal(rawById.T_DELETED_SELF.kind, "train", "已軟刪節點不回填");

    // oplog 僅對 3 筆受轉換列寫入 { kind: "ticket" }
    const kindOps = db.batches.flatMap((b) => b.ops).filter((o) => o.tbl === "nodes" && "kind" in o.cols);
    assert.equal(kindOps.length, 3);
    assert.deepEqual(
      kindOps.map((o) => o.row_id).sort(),
      ["C_EMPTY", "T_EMPTY", "T_SOFT_CHILD"],
    );
    for (const o of kindOps) {
      assert.deepEqual(o.cols, { kind: "ticket" });
    }

    // 冪等：再次顯式呼叫 backfillLeafTickets() 與開啟新 repo 實例皆不再寫入任何 batch
    const batchesBefore = db.batches.length;
    await repo.backfillLeafTickets();
    await new SqliteNodeRepository().listRouteMembers();
    assert.equal(db.batches.length, batchesBefore, "已回填完成應零寫入");
  });

  test("backfillLeafTickets（memory）：轉無存活子項的 train/car 為 ticket，保留 updated_at 且冪等", async () => {
    const oldTs = "2026-02-01T00:00:00.000Z";
    const repo = new MemoryNodeRepository();
    const map = (repo as unknown as { nodes: Map<string, import("../../src/domain/node.ts").NodeRow> }).nodes;
    for (const row of [
      makeNodeRow({ id: "L1", kind: "line", updated_at: oldTs }),
      makeNodeRow({ id: "R1", kind: "route", parent_id: "L1", line_id: "L1", updated_at: oldTs }),
      makeNodeRow({ id: "T1", kind: "train", parent_id: "R1", line_id: "L1", route_id: "R1", sort_key: "a0", scheduled_on: "2026-11-01", updated_at: oldTs }),
      makeNodeRow({ id: "T2", kind: "train", parent_id: "R1", line_id: "L1", route_id: "R1", updated_at: oldTs }),
      makeNodeRow({ id: "C1", kind: "car", parent_id: "T2", line_id: "L1", route_id: "R1", updated_at: oldTs }),
    ]) {
      map.set(row.id, row);
    }
    await repo.backfillLeafTickets();
    const t1 = await repo.getNode("T1");
    const t2 = await repo.getNode("T2");
    const c1 = await repo.getNode("C1");
    assert.equal(t1?.kind, "ticket");
    assert.equal(t1?.updated_at, oldTs);
    assert.equal(t1?.sort_key, "a0");
    assert.equal(t1?.scheduled_on, "2026-11-01");
    assert.equal(t2?.kind, "train");
    assert.equal(c1?.kind, "ticket");
    assert.equal(c1?.updated_at, oldTs);
  });
});

/* ═════════════════════════════════════════════
 * Bug 2：途中下車（paused）全面退出誤點與待辦提醒
 * ═════════════════════════════════════════════ */

describe("Bug 2 · paused（途中下車）全面退出誤點／待辦／提醒", () => {
  const TODAY = "2026-11-10";
  const YESTERDAY = "2026-11-09";
  const TWO_DAYS_AGO = "2026-11-08";

  for (const kindName of ["memory", "sqlite"] as const) {
    test(`listToday 與 routeOpenCounts 排除 paused（${kindName}）`, async () => {
      let repo: import("../../src/data/nodeRepository.ts").NodeRepository;
      if (kindName === "sqlite") {
        setDb(makeDb());
        repo = new SqliteNodeRepository();
      } else {
        repo = new MemoryNodeRepository();
      }

      const line = await repo.create({ kind: "line", name: "幹線" });
      const route = await repo.create({ kind: "route", parentId: line.id, name: "路線" });

      const activeLate = await repo.create({ kind: "ticket", parentId: route.id, name: "真誤點", scheduledOn: TWO_DAYS_AGO });
      const pausedLate = await repo.create({ kind: "ticket", parentId: route.id, name: "誤點途中下車", scheduledOn: TWO_DAYS_AGO });
      const pausedToday = await repo.create({ kind: "ticket", parentId: route.id, name: "今日途中下車", scheduledOn: TODAY });
      const pausedDue = await repo.create({ kind: "ticket", parentId: route.id, name: "締切途中下車", dueOn: YESTERDAY });
      const doneToday = await repo.create({ kind: "ticket", parentId: route.id, name: "今日已完成", scheduledOn: TODAY });

      await repo.update(pausedLate.id, { status: "paused" });
      await repo.update(pausedToday.id, { status: "paused" });
      await repo.update(pausedDue.id, { status: "paused" });
      await repo.update(doneToday.id, { status: "done" });

      const todayRows = await repo.listToday(TODAY, 6);
      const ids = new Set(todayRows.map((r) => r.id));
      assert.ok(ids.has(activeLate.id), "未完成的昨日票仍在今日誤點");
      assert.ok(ids.has(doneToday.id), "今日剛済的票留在今日已結案");
      assert.equal(ids.has(pausedLate.id), false, "過去途中下車的票絕不可出現在誤點");
      assert.equal(ids.has(pausedToday.id), false, "今日途中下車的票不可留在未完成／誤點");
      assert.equal(ids.has(pausedDue.id), false, "過去締切但途中下車的票絕不可出現在締切逾期");

      const counts = await repo.routeOpenCounts();
      assert.equal(counts[route.id] ?? 0, 1, "路線未完成待辦數應排除 paused，僅計 activeLate 1 筆");
    });
  }

  test("domain 與 nodeRepository 純函式全面排除 paused", () => {
    const pausedLateRow = makeNodeRow({ id: "P1", scheduled_on: YESTERDAY, due_on: YESTERDAY, status: "paused" });
    const activeLateRow = makeNodeRow({ id: "A1", scheduled_on: YESTERDAY, due_on: YESTERDAY, status: "todo" });
    const pausedRepeatRow = makeNodeRow({
      id: "PR1",
      scheduled_on: YESTERDAY,
      status: "paused",
      repeat_rule: JSON.stringify({ every: 1, unit: "day", since: "2026-11-01" }),
    });

    // dayCount.lateCount
    const lc = lateCount(
      [
        { bucket: "late", status: "paused", scheduled_on: YESTERDAY, due_on: null, repeat_rule: null, occurrence: null },
        { bucket: "late", status: "todo", scheduled_on: YESTERDAY, due_on: null, repeat_rule: null, occurrence: null },
      ],
      TODAY,
    );
    assert.equal(lc.count, 1);

    // taskFilter：open 預設條件與常用篩選排除 paused／已済／skipped，all 保留，done 僅收已済
    const tfCtx = {
      today: TODAY,
      occurrences: { REP_DONE: { status: "done" }, REP_SKIP: { status: "skipped" } },
      tagsOf: () => [] as const,
      depot: new Set<string>(),
    };
    const doneRow = makeNodeRow({ id: "D_TF", status: "done" });
    const repDoneRow = makeNodeRow({ id: "REP_DONE", status: "paused", repeat_rule: "{}" });
    const repSkipRow = makeNodeRow({ id: "REP_SKIP", status: "todo", repeat_rule: "{}" });
    assert.equal(isTaskSettled(pausedLateRow, undefined), true);
    assert.equal(isTaskLate(pausedLateRow, undefined, TODAY), false);
    assert.equal(isTaskOverdue(pausedLateRow, undefined, TODAY), false);
    assert.equal(matchTask(pausedLateRow, { ...DEFAULT_TASK_FILTER, status: "open" }, tfCtx), false, "未済篩選必須排除 paused");
    assert.equal(matchTask(doneRow, { ...DEFAULT_TASK_FILTER, status: "open" }, tfCtx), false, "未済篩選必須排除 done");
    assert.equal(matchTask(repSkipRow, { ...DEFAULT_TASK_FILTER, status: "open" }, tfCtx), false, "未済篩選必須排除本班運休");
    assert.equal(matchTask(activeLateRow, { ...DEFAULT_TASK_FILTER, status: "open" }, tfCtx), true);
    assert.equal(matchTask(pausedLateRow, { ...DEFAULT_TASK_FILTER, status: "done" }, tfCtx), false);
    assert.equal(matchTask(repDoneRow, { ...DEFAULT_TASK_FILTER, status: "done" }, tfCtx), true, "定期券本班済時進入 done 篩選");
    assert.equal(matchTask(pausedLateRow, { ...DEFAULT_TASK_FILTER, status: "all" }, tfCtx), true, "all 保留 paused");
    assert.equal(matchTask(pausedLateRow, { ...DEFAULT_TASK_FILTER, due: "overdue" }, tfCtx), false);
    assert.equal(matchTask(pausedLateRow, { ...DEFAULT_TASK_FILTER, late: true }, tfCtx), false);
    assert.equal(matchTask(activeLateRow, { ...DEFAULT_TASK_FILTER, due: "overdue" }, tfCtx), true);
    assert.equal(matchTask(activeLateRow, { ...DEFAULT_TASK_FILTER, late: true }, tfCtx), true);

    // timetableSchedule.lateItemsOf
    const ttLate = lateItemsOf(
      [
        { id: "P1", bucket: "late", status: "paused", repeat_rule: null, occurrence: null, scheduled_on: YESTERDAY, scheduled_time: null, estimate_min: 30, carried_from: null },
        { id: "A1", bucket: "late", status: "todo", repeat_rule: null, occurrence: null, scheduled_on: YESTERDAY, scheduled_time: null, estimate_min: 30, carried_from: null },
      ],
      TODAY,
    );
    assert.deepEqual(ttLate.items.map((i) => i.nodeId), ["A1"]);

    // nodeRepository: buildSchedule / buildCalendar / buildScheduleBounds / buildRouteOpenCounts
    const sch = buildSchedule([pausedLateRow, activeLateRow, pausedRepeatRow], {}, TWO_DAYS_AGO, TODAY, TODAY, 6);
    assert.equal(sch.find((e) => e.node_id === "P1")?.is_late, false, "途中下車在行程表不可標為誤點");
    assert.equal(sch.find((e) => e.node_id === "A1")?.is_late, true, "未完成且過去排程應標為誤點");
    assert.equal(sch.filter((e) => e.node_id === "PR1" && e.date >= TODAY).length, 0, "途中下車定期券不可再往後推算班次");

    const cal = buildCalendar([pausedLateRow, activeLateRow], {}, TWO_DAYS_AGO, TODAY, TODAY, 6);
    assert.deepEqual(cal.dues.map((d) => d.node_id), ["A1"]);

    const pausedOpenRepeat = makeNodeRow({
      id: "PR_OPEN",
      scheduled_on: YESTERDAY,
      status: "paused",
      repeat_rule: JSON.stringify({ every: 1, unit: "day", since: "2026-11-01" }),
    });
    const bounds = buildScheduleBounds([pausedOpenRepeat], {}, TODAY);
    assert.equal(bounds.openEndedRepeat, false, "途中下車的無期限定期券不視為未來無界排程");

    const openCounts = buildRouteOpenCounts([
      { id: "P1", kind: "ticket", parent_id: "R1", status: "paused", route_id: "R1", deleted_at: null },
      { id: "A1", kind: "ticket", parent_id: "R1", status: "todo", route_id: "R1", deleted_at: null },
      { id: "D1", kind: "ticket", parent_id: "R1", status: "done", route_id: "R1", deleted_at: null },
    ]);
    assert.deepEqual(openCounts, { R1: 1 });

    // routeHeadStats & buildRouteOverview：未完成且 paused 的車票不計入分母，但本班已済定期券不誤略
    const headNodes = [
      { id: "D1", kind: "ticket", status: "done" },
      { id: "P1", kind: "ticket", status: "paused" },
      { id: "RP_DONE", kind: "ticket", status: "paused" }, // 例如定期券本班已 done
    ];
    const headStats = routeHeadStats(headNodes, (n) => n.id === "D1" || n.id === "RP_DONE");
    assert.equal(headStats.ticketDone, 2);
    assert.equal(headStats.ticketTotal, 2);
    assert.equal(headStats.pct, 100);

    const overview = buildRouteOverview({
      routeIds: ["R1"],
      members: [
        { id: "D1", kind: "ticket", status: "done", route_id: "R1" },
        { id: "P1", kind: "ticket", status: "paused", route_id: "R1" },
        { id: "RP_DONE", kind: "ticket", status: "paused", route_id: "R1" },
      ],
      isDone: (m) => m.id === "D1" || m.id === "RP_DONE",
      spans: [],
      spend: [],
      todayRows: [],
      today: TODAY,
      stations: [],
      now: Date.now(),
      window: { start: 0, end: 1 },
    });
    assert.equal(overview.byRoute.R1.ticketDone, 2);
    assert.equal(overview.byRoute.R1.ticketTotal, 2);
  });
});
