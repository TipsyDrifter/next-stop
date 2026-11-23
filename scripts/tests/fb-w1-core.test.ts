/**
 * 第一梯回饋專卷（eng-tree）完整回歸與單元測試：
 *   1. 【Bug 1 ＋ 操作 8】搬移引擎樹祖先去重（dedupeSubtreeRoots ＋ moveToAnchor ＋ batchMoveTo ＋ moveMany）
 *   2. 【操作 7】全階層掛載規則解禁（MovePickKind／moveTargetRule／excludeSubtrees ＋ train/car/ticket 跨五目標搬移與復原）
 *   3. 【操作 2 資料層】車票⇄支線雙向轉型（根層帶路線標籤車票轉支線／列車補寫 parent_id ＋ 空支線轉車票）
 *   4. 【Bug 2 領域層】篩選支援有子項列車／車廂（matchTask）＋ 命中子樹縮排組裝（buildFilteredOutlineGroups）
 *   5. 【Bug 4 領域層】車票開放掛載旅客筆記（NOTE_NODE_KINDS／AttachTarget）與日記足跡心情保留（groupFootprints）
 *
 * 跑法：`node --test scripts/tests/fb-w1-core.test.ts`
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { TaskFilterCtx, TaskRow } from "../../src/domain/taskFilter.ts";
import type { AttachTarget } from "../../src/domain/notes.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const FAKE_DB = `
let t = Date.UTC(2026, 10, 20, 1, 0, 0);
export function getDb() { const d = globalThis.__db; if (!d) throw new Error("測試沒設 __db"); return Promise.resolve(d); }
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
const FAKE_DATA_INDEX = `
export const nodeRepo = new Proxy({}, {
  get(_, prop) {
    const mock = globalThis.__mockNodeRepo;
    if (!mock) throw new Error("測試沒設 __mockNodeRepo");
    const v = mock[prop];
    return typeof v === "function" ? v.bind(mock) : v;
  }
});
export const settingsRepo = { get: async () => null, set: async () => {} };
export const logRepo = {};
export const syncRepo = {};
export const backupRepo = {};
export const reorderIds = (ids) => ids;
export const SYNC_WRITE_EVENT = "ns:sync-write";
export const parseKeep = () => 10;
export const BACKUP_SETTING_KEYS = {};
export const BACKUP_KEEP_DEFAULT = 10;
export const DEV_FLAGS = { mock: false };
export const MOCK_MODE = false;
export const WIPED_MODE = false;
export const USE_SQLITE = false;
`;
const FAKE_TAG_REPO = `export const tagRepo = { attach: async () => ({}), detach: async () => ({}), undo: async () => {} };`;
const FAKE_MOOD_STORE = `export const useMoodStore = { getState: () => ({ notifyStamped() {} }) };`;
const FAKE_UI_STORE = `
const state = {
  dayStartHour: 3,
  toast: null,
  showToast(t) { state.toast = t; },
  askConfirm() {},
};
export const useUiStore = { getState: () => state };
`;
const FAKE_TAG_STORE = `export const useTagStore = { getState: () => ({ loadIndex: async () => {} }) };`;
const FAKE_SELECTION_STORE = `export const useSelectionStore = { getState: () => ({ clear() {} }) };`;
const dataUrl = (src: string) => "data:text/javascript," + encodeURIComponent(src);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "../../src/store/uiStore.ts") {
      return { url: dataUrl(FAKE_UI_STORE), shortCircuit: true };
    }
    const fromSrc = context.parentURL !== undefined && context.parentURL.includes("/src/");
    if (fromSrc) {
      if (specifier === "../lib/db") return { url: dataUrl(FAKE_DB), shortCircuit: true };
      if (specifier === "./syncRepository") return { url: dataUrl(FAKE_SYNC), shortCircuit: true };
      if (specifier === "@tauri-apps/api/core") return { url: dataUrl(FAKE_CORE), shortCircuit: true };
      if (specifier === "../lib/windowTheme") return { url: dataUrl(FAKE_WINDOW_THEME), shortCircuit: true };
      if (specifier === "../data" && context.parentURL.includes("/src/store/")) {
        return { url: dataUrl(FAKE_DATA_INDEX), shortCircuit: true };
      }
      if (specifier === "../data/tagRepo" && context.parentURL.includes("/src/store/")) {
        return { url: dataUrl(FAKE_TAG_REPO), shortCircuit: true };
      }
      if (specifier === "../ui/ambience/moodStore" && context.parentURL.includes("/src/store/")) {
        return { url: dataUrl(FAKE_MOOD_STORE), shortCircuit: true };
      }
      if (specifier === "./uiStore" && context.parentURL.includes("/src/store/")) {
        return { url: dataUrl(FAKE_UI_STORE), shortCircuit: true };
      }
      if (specifier === "./tagStore" && context.parentURL.includes("/src/store/")) {
        return { url: dataUrl(FAKE_TAG_STORE), shortCircuit: true };
      }
      if (specifier === "./selectionStore" && context.parentURL.includes("/src/store/")) {
        return { url: dataUrl(FAKE_SELECTION_STORE), shortCircuit: true };
      }
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

const {
  dedupeSubtreeRoots,
  excludeSubtrees,
  moveTargetRule,
} = await import("../../src/domain/moveTo.ts");
const {
  DEFAULT_TASK_FILTER,
  TEMP_ROUTE,
  buildFilteredOutlineGroups,
  isTaskSettled,
  matchTask,
} = await import("../../src/domain/taskFilter.ts");
const { NOTE_NODE_KINDS, groupFootprints } = await import("../../src/domain/notes.ts");
const { MemoryNodeRepository } = await import("../../src/data/memoryRepository.ts");
const { SqliteNodeRepository } = await import("../../src/data/sqliteNodeRepository.ts");
const { useNodeStore } = await import("../../src/store/nodeStore.ts");
const { useUiStore } = await import("../../src/store/uiStore.ts");
const { APPEND, batchMoveTo } = await import("../../src/store/batchActions.ts");

function makeRepo(kind: "memory" | "sqlite") {
  if (kind === "sqlite") {
    const db = makeDb();
    setDb(db);
    return { repo: new SqliteNodeRepository(), db };
  }
  return { repo: new MemoryNodeRepository(), db: null };
}

/* ═════════════════════════════════════════════
 * 1. 【Bug 1 ＋ 操作 8】搬移引擎樹祖先去重
 * ═════════════════════════════════════════════ */

describe("1. Bug 1 ＋ 操作 8：搬移引擎樹祖先去重", () => {
  test("dedupeSubtreeRoots：同時選取祖先與子孫時僅留祖先並保持相對順序", () => {
    const parents: Record<string, string | null> = {
      B1: "R1",
      T1: "B1",
      C1: "T1",
      K1: "C1",
      K2: "T1",
      T2: "R1",
      K_other: "T2",
    };
    const parentOf = (id: string) => parents[id] ?? null;

    assert.deepEqual(dedupeSubtreeRoots(["T1", "K2"], parentOf), ["T1"]);
    assert.deepEqual(dedupeSubtreeRoots(["K2", "T1"], parentOf), ["T1"], "子先父後也能正確保留父節點");
    assert.deepEqual(dedupeSubtreeRoots(["T2", "K1", "B1", "K_other", "C1"], parentOf), ["T2", "B1"]);
    assert.deepEqual(dedupeSubtreeRoots(["T1", "T2"], parentOf), ["T1", "T2"]);
    assert.deepEqual(dedupeSubtreeRoots(["T1", "T1"], parentOf), ["T1"]);

    // 環狀壞資料不造成無窮迴圈
    const cyclic: Record<string, string | null> = { X: "Y", Y: "X" };
    assert.deepEqual(dedupeSubtreeRoots(["X", "Z"], (id) => cyclic[id] ?? null), ["X", "Z"]);
  });

  for (const kindName of ["memory", "sqlite"] as const) {
    test(`moveMany(${kindName})：同時傳入 [train, childTicket] 搬進支線與跨路線時整棵保留不攤平不降格`, async () => {
      const { repo } = makeRepo(kindName);
      const line = await repo.create({ kind: "line", name: "幹線", parentId: null });
      const r1 = await repo.create({ kind: "route", name: "R1", parentId: line.id });
      const r2 = await repo.create({ kind: "route", name: "R2", parentId: line.id });
      const b1 = await repo.create({ kind: "branch", name: "支線", parentId: r1.id });
      const train = await repo.create({ kind: "train", name: "母列車", parentId: r1.id });
      const k1 = await repo.create({ kind: "ticket", name: "子票1", parentId: train.id });
      const k2 = await repo.create({ kind: "ticket", name: "子票2", parentId: train.id });

      // 同時傳入 train 與子票進支線 b1
      await repo.moveMany(
        [
          { id: train.id, parentId: b1.id },
          { id: k1.id, parentId: b1.id },
          { id: k2.id, parentId: b1.id },
        ],
        { after: null, before: null },
      );

      const tAfter = await repo.getNode(train.id);
      assert.equal(tAfter?.kind, "train", "母列車絕不可被降格為車票");
      assert.equal(tAfter?.parent_id, b1.id);
      assert.equal((await repo.getNode(k1.id))?.parent_id, train.id, "子票1仍留在母列車底下");
      assert.equal((await repo.getNode(k2.id))?.parent_id, train.id, "子票2仍留在母列車底下");

      // 反序 [子票, 母列車] 跨路線搬到 r2
      await repo.moveMany(
        [
          { id: k1.id, parentId: r2.id },
          { id: train.id, parentId: r2.id },
        ],
        { after: null, before: null },
      );

      const tCross = await repo.getNode(train.id);
      assert.equal(tCross?.kind, "train");
      assert.equal(tCross?.parent_id, r2.id);
      assert.equal(tCross?.route_id, r2.id);
      assert.equal((await repo.getNode(k1.id))?.parent_id, train.id);
      assert.equal((await repo.getNode(k1.id))?.route_id, r2.id);
      assert.equal((await repo.getNode(k2.id))?.route_id, r2.id);
    });
  }

  test("nodeStore.moveToAnchor 與 batchMoveTo（含復原）：同時選取母列車＋子車票整棵搬進支線／列車", async () => {
    const repo = new MemoryNodeRepository();
    (globalThis as Record<string, unknown>).__mockNodeRepo = repo;
    const line = await repo.create({ kind: "line", name: "幹線", parentId: null });
    const route = await repo.create({ kind: "route", name: "英文", parentId: line.id });
    const branch = await repo.create({ kind: "branch", name: "閱讀支線", parentId: route.id });
    const train = await repo.create({ kind: "train", name: "文法列車", parentId: route.id });
    const child = await repo.create({ kind: "ticket", name: "第一課", parentId: train.id });

    // moveToAnchor 直接傳入 [train, child]
    const r1 = await useNodeStore.getState().moveToAnchor([train.id, child.id], branch.id, APPEND);
    assert.equal(r1.ok, true);
    assert.equal((await repo.getNode(train.id))?.kind, "train");
    assert.equal((await repo.getNode(train.id))?.parent_id, branch.id);
    assert.equal((await repo.getNode(child.id))?.parent_id, train.id);

    // batchMoveTo 傳入 [child, train] + 復原 toast
    const ok = await batchMoveTo([child.id, train.id], route.id, "英文");
    assert.equal(ok, true);
    assert.equal((await repo.getNode(train.id))?.parent_id, route.id);
    assert.equal((await repo.getNode(child.id))?.parent_id, train.id);

    // 觸發 toast 復原：應回到 branch 底下，且子票仍在列車內
    const toast = useUiStore.getState().toast;
    assert.ok(toast?.onAction);
    toast.onAction!();
    await new Promise((res) => setTimeout(res, 10));
    assert.equal((await repo.getNode(train.id))?.parent_id, branch.id);
    assert.equal((await repo.getNode(child.id))?.parent_id, train.id);
  });
});

/* ═════════════════════════════════════════════
 * 2. 【操作 7】全階層掛載規則解禁
 * ═════════════════════════════════════════════ */

describe("2. 操作 7：全階層掛載規則解禁與跨五目標搬移復原", () => {
  test("moveTargetRule 與 excludeSubtrees：支援多選排除多個子樹", () => {
    for (const k of ["ticket", "car", "train"] as const) {
      assert.deepEqual(moveTargetRule(k), {
        depth: "node",
        kinds: ["branch", "train", "car", "ticket"],
        routeSelectable: true,
        label: "移到哪條路線、支線、列車或車票",
      });
    }
    const tree = [
      { id: "B1", depth: 0, selectable: true },
      { id: "T1", depth: 1, selectable: true },
      { id: "K1", depth: 2, selectable: true },
      { id: "T2", depth: 1, selectable: true },
      { id: "B2", depth: 0, selectable: true },
      { id: "K2", depth: 1, selectable: true },
    ];
    assert.deepEqual(
      excludeSubtrees(tree, new Set(["T1", "K1", "B2"])).map((x) => x.id),
      ["B1", "T2"],
    );
    assert.deepEqual(
      excludeSubtrees(tree, new Set()).map((x) => x.id),
      tree.map((x) => x.id),
    );
  });

  for (const kindName of ["memory", "sqlite"] as const) {
    test(`moveToAnchor(${kindName})：train / car / ticket 跨 route / branch / train / car / ticket 搬移與復原`, async () => {
      const { repo } = makeRepo(kindName);
      (globalThis as Record<string, unknown>).__mockNodeRepo = repo;
      const ns = useNodeStore.getState();

      const line = await repo.create({ kind: "line", name: "幹線", parentId: null });
      const route = await repo.create({ kind: "route", name: "日文", parentId: line.id });
      const branch = await repo.create({ kind: "branch", name: "支線", parentId: route.id });
      const targetTrain = await repo.create({ kind: "train", name: "目標列車", parentId: route.id });
      const targetCar = await repo.create({ kind: "car", name: "目標車廂", parentId: targetTrain.id });
      await repo.create({ kind: "ticket", name: "占位", parentId: targetCar.id });

      // ① train（帶子票）搬進另一張車票：目標車票自動升格 train，源 train 自動轉 car，復原還原！
      const targetTicket = await repo.create({ kind: "ticket", name: "目標車票", parentId: null, routeTagId: route.id });
      const srcTrain = await repo.create({ kind: "train", name: "源列車", parentId: route.id });
      const srcTrainKid = await repo.create({ kind: "ticket", name: "源列車子票", parentId: srcTrain.id });

      assert.equal((await ns.moveToAnchor([srcTrain.id], targetTicket.id, APPEND)).ok, true);
      assert.equal((await repo.getNode(targetTicket.id))?.kind, "train", "根層標籤車票接收子項應升格為 train");
      assert.equal((await repo.getNode(targetTicket.id))?.parent_id, route.id);
      assert.equal((await repo.getNode(srcTrain.id))?.kind, "car", "列車移入目標後應轉為 car");
      assert.equal((await repo.getNode(srcTrain.id))?.parent_id, targetTicket.id);
      assert.equal((await repo.getNode(srcTrainKid.id))?.parent_id, srcTrain.id);

      // 移回 route：源 car 升回 train，原 targetTicket 無子項自動降回 ticket
      assert.equal((await ns.moveToAnchor([srcTrain.id], route.id, APPEND)).ok, true);
      assert.equal((await repo.getNode(srcTrain.id))?.kind, "train");
      assert.equal((await repo.getNode(targetTicket.id))?.kind, "ticket", "子項全數移出後目標應自動降回 ticket");

      // ② train 移入 targetTrain / targetCar 皆轉 car
      assert.equal((await ns.moveToAnchor([srcTrain.id], targetCar.id, APPEND)).ok, true);
      assert.equal((await repo.getNode(srcTrain.id))?.kind, "car");
      assert.equal((await repo.getNode(srcTrain.id))?.parent_id, targetCar.id);

      // ③ car（帶子票）移到 branch 轉 train，再移回 targetTrain 轉 car
      assert.equal((await ns.moveToAnchor([srcTrain.id], branch.id, APPEND)).ok, true);
      assert.equal((await repo.getNode(srcTrain.id))?.kind, "train");
      assert.equal((await repo.getNode(srcTrain.id))?.parent_id, branch.id);
      assert.equal((await ns.moveToAnchor([srcTrain.id], targetTrain.id, APPEND)).ok, true);
      assert.equal((await repo.getNode(srcTrain.id))?.kind, "car");

      // ④ ticket 移入另一張在支線底下的車票，再移回 route（變根層路線標籤車票），目標車票自動降回 ticket
      const leafSrc = await repo.create({ kind: "ticket", name: "單票", parentId: route.id });
      const leafDst = await repo.create({ kind: "ticket", name: "支線下目標票", parentId: branch.id });
      assert.equal((await ns.moveToAnchor([leafSrc.id], leafDst.id, APPEND)).ok, true);
      assert.equal((await repo.getNode(leafDst.id))?.kind, "train");
      assert.equal((await repo.getNode(leafSrc.id))?.parent_id, leafDst.id);

      assert.equal((await ns.moveToAnchor([leafSrc.id], route.id, APPEND)).ok, true);
      assert.equal((await repo.getNode(leafSrc.id))?.parent_id, null);
      assert.equal((await repo.getNode(leafSrc.id))?.route_id, route.id);
      assert.equal((await repo.getNode(leafDst.id))?.kind, "ticket");
    });
  }
});

/* ═════════════════════════════════════════════
 * 3. 【操作 2 資料層】車票⇄支線雙向轉型補齊
 * ═════════════════════════════════════════════ */

describe("3. 操作 2 資料層：車票⇄支線雙向轉型補齊", () => {
  for (const kindName of ["memory", "sqlite"] as const) {
    test(`setKind(${kindName})：根層帶路線標籤車票轉支線／列車同步寫 parent_id，空支線轉車票對齊自由席`, async () => {
      const { repo, db } = makeRepo(kindName);
      const line = await repo.create({ kind: "line", name: "幹線", parentId: null });
      const route = await repo.create({ kind: "route", name: "路線", parentId: line.id });

      // 根層帶路線標籤的車票（QuickAddRow 建法：parent_id = null, route_id = route.id）
      const looseTagged = await repo.create({
        kind: "ticket",
        name: "從建票列建的票",
        parentId: null,
        routeTagId: route.id,
        scheduledOn: "2026-11-20",
        dueOn: "2026-11-25",
      });
      assert.equal(looseTagged.parent_id, null);
      assert.equal(looseTagged.route_id, route.id);

      // 轉為 branch：應自動將 parent_id 寫為 route.id，並清除日期／時刻／重複
      await repo.setKind(looseTagged.id, "branch");
      const asBranch = await repo.getNode(looseTagged.id);
      assert.equal(asBranch?.kind, "branch");
      assert.equal(asBranch?.parent_id, route.id);
      assert.equal(asBranch?.line_id, line.id);
      assert.equal(asBranch?.scheduled_on, null);
      assert.equal(asBranch?.due_on, null);

      if (db) {
        const lastOps = db.batches[db.batches.length - 1].ops;
        const op = lastOps.find((o) => o.row_id === looseTagged.id);
        assert.equal(op?.cols.kind, "branch");
        assert.equal(op?.cols.parent_id, route.id, "oplog 須同步記錄 parent_id");
      }

      // 另一張根層帶路線標籤車票轉為 train
      const looseToTrain = await repo.create({
        kind: "ticket",
        name: "轉列車",
        parentId: null,
        routeTagId: route.id,
      });
      await repo.setKind(looseToTrain.id, "train");
      const asTrain = await repo.getNode(looseToTrain.id);
      assert.equal(asTrain?.kind, "train");
      assert.equal(asTrain?.parent_id, route.id);

      // 無路線標籤的收件匣車票仍禁止直接轉支線
      const inboxTicket = await repo.create({ kind: "ticket", name: "收件匣票", parentId: null });
      await assert.rejects(() => repo.setKind(inboxTicket.id, "branch"), /根層/);

      // 空支線（0 存活子項）轉為 ticket：對齊路線下自由席車票（parent_id = route.id）
      const emptyBranch = await repo.create({ kind: "branch", name: "空支線", parentId: route.id });
      const softKid = await repo.create({ kind: "ticket", name: "已刪子票", parentId: emptyBranch.id });
      await repo.softDelete(softKid.id);
      await repo.setKind(emptyBranch.id, "ticket");
      const backToTicket = await repo.getNode(emptyBranch.id);
      assert.equal(backToTicket?.kind, "ticket");
      assert.equal(backToTicket?.parent_id, route.id);
      assert.equal(backToTicket?.route_id, route.id);

      // 有存活子項的支線不能轉為 ticket
      const fullBranch = await repo.create({ kind: "branch", name: "有子項支線", parentId: route.id });
      await repo.create({ kind: "ticket", name: "存活子票", parentId: fullBranch.id });
      await assert.rejects(() => repo.setKind(fullBranch.id, "ticket"), /車票/);
    });
  }
});

/* ═════════════════════════════════════════════
 * 4. 【Bug 2 領域層】篩選支援有子項列車／車廂與命中子樹組裝
 * ═════════════════════════════════════════════ */

describe("4. Bug 2 領域層：篩選列車／車廂與 buildFilteredOutlineGroups", () => {
  const row = (id: string, patch: Partial<TaskRow> = {}): TaskRow =>
    ({
      id,
      kind: "ticket",
      parent_id: null,
      line_id: "L1",
      route_id: "R1",
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
      created_at: "2026-11-01T00:00:00.000Z",
      updated_at: "2026-11-01T00:00:00.000Z",
      deleted_at: null,
      hlc: "0",
      has_kids: false,
      ...patch,
    }) as TaskRow;

  test("matchTask：有子項的列車／車廂在荷札、締切、優先級、預設條件下皆可正常命中", () => {
    const trainWithKids = row("T1", { kind: "train", has_kids: true, due_on: "2026-11-20", priority: "high" });
    const carWithKids = row("C1", { kind: "car", has_kids: true, parent_id: "T1" });
    const ctx: TaskFilterCtx = {
      today: "2026-11-20",
      occurrences: {},
      tagsOf: (id) => (id === "T1" || id === "C1" ? ["重點"] : []),
      depot: new Set(),
    };
    assert.equal(matchTask(trainWithKids, DEFAULT_TASK_FILTER, ctx), true);
    assert.equal(matchTask(trainWithKids, { ...DEFAULT_TASK_FILTER, tags: ["重點"] }, ctx), true);
    assert.equal(matchTask(trainWithKids, { ...DEFAULT_TASK_FILTER, due: "today" }, ctx), true);
    assert.equal(matchTask(trainWithKids, { ...DEFAULT_TASK_FILTER, high: true }, ctx), true);
    assert.equal(matchTask(carWithKids, { ...DEFAULT_TASK_FILTER, tags: ["重點"] }, ctx), true);
  });

  test("buildFilteredOutlineGroups：按路線→支線／列車／車廂脈絡→縮排子票組裝，並保留母列車命中子項與進度", () => {
    const routes = [{ id: "R1" }, { id: "R2" }];
    const holders = [
      { id: "B1", name: "文法支線", parent_id: "R1" },
      { id: "T1", name: "N3 列車", parent_id: "B1" },
      { id: "C1", name: "助詞車廂", parent_id: "T1" },
      { id: "T2", name: "命中列車", parent_id: "R2" },
    ];
    const k1 = row("K1", { parent_id: "C1", route_id: "R1", status: "todo" }); // hit
    const k2 = row("K2", { parent_id: "C1", route_id: "R1", status: "done" }); // not hit
    const t1 = row("T1", { kind: "train", parent_id: "B1", route_id: "R1", has_kids: true });
    const c1 = row("C1", { kind: "car", parent_id: "T1", route_id: "R1", has_kids: true });
    const t2 = row("T2", { kind: "train", parent_id: "R2", route_id: "R2", has_kids: true }); // hit
    const t2OpenKid = row("K3", { parent_id: "T2", route_id: "R2", status: "todo" }); // brought by T2
    const t2DoneKid = row("K4", { parent_id: "T2", route_id: "R2", status: "done" }); // filtered out by childVisible
    const loose = row("L_TEMP", { parent_id: null, route_id: null }); // TEMP_ROUTE hit

    const allTasks = [t1, c1, k1, k2, t2, t2OpenKid, t2DoneKid, loose];
    const matched = [k1, t2, loose];

    const groups = buildFilteredOutlineGroups({
      matched,
      allTasks,
      holders,
      routes,
      childVisible: (c) => !isTaskSettled(c, undefined),
    });

    assert.deepEqual(
      groups.map((g) => g.routeKey),
      ["R1", "R2", TEMP_ROUTE],
    );

    // R1: B1(0, ancestor) -> T1(1, ancestor) -> C1(2, ancestor) -> K1(3, hit)
    assert.deepEqual(
      groups[0].items.map((it) => ({ id: it.id, kind: it.kind, depth: it.depth, role: it.role, matched: it.matched })),
      [
        { id: "B1", kind: "branch", depth: 0, role: "ancestor", matched: false },
        { id: "T1", kind: "train", depth: 1, role: "ancestor", matched: false },
        { id: "C1", kind: "car", depth: 2, role: "ancestor", matched: false },
        { id: "K1", kind: "ticket", depth: 3, role: "hit", matched: true },
      ],
    );
    assert.deepEqual(groups[0].items[2].progress, { done: 1, total: 2 });

    // R2: T2(0, hit) -> K3(1, child)；K4 因已完成被 childVisible 排除
    assert.deepEqual(
      groups[1].items.map((it) => ({ id: it.id, kind: it.kind, depth: it.depth, role: it.role, matched: it.matched })),
      [
        { id: "T2", kind: "train", depth: 0, role: "hit", matched: true },
        { id: "K3", kind: "ticket", depth: 1, role: "child", matched: false },
      ],
    );
    assert.deepEqual(groups[1].items[0].progress, { done: 1, total: 2 });

    // TEMP_ROUTE: L_TEMP(0, hit)
    assert.equal(groups[2].routeId, null);
    assert.deepEqual(groups[2].items.map((it) => it.id), ["L_TEMP"]);
  });
});

/* ═════════════════════════════════════════════
 * 5. 【Bug 4 領域層】車票開放掛載旅客筆記與日記足跡心情
 * ═════════════════════════════════════════════ */

describe("5. Bug 4 領域層：車票開放筆記掛載與足跡心情", () => {
  test("NOTE_NODE_KINDS 與 AttachTarget 納入 ticket", () => {
    assert.deepEqual([...NOTE_NODE_KINDS], ["route", "branch", "train", "car", "ticket"]);
    const target: AttachTarget = { routeId: "R1", nodeId: "K1", nodeKind: "ticket" };
    assert.equal(target.nodeKind, "ticket");
  });

  test("groupFootprints：保留 ticket 的 mood 並納入 moods 陣列", () => {
    const fp = groupFootprints(
      "2026-11-20",
      [
        {
          id: "k1",
          nodeId: "k1",
          name: "背單字",
          kind: "ticket",
          routeId: "R1",
          at: "2026-11-20T02:00:00.000Z",
          mood: "yellow",
          isRepeat: false,
        },
        {
          id: "t1",
          nodeId: "t1",
          name: "模擬考",
          kind: "train",
          routeId: "R1",
          at: "2026-11-20T05:00:00.000Z",
          mood: "green",
          isRepeat: false,
        },
      ],
      [],
      null,
    );
    assert.deepEqual(fp.moods, ["yellow", "green"]);
    assert.equal(fp.seals[0].mood, "yellow");
  });
});
