/**
 * 時刻表線⑦（D-時-166 拖曳排序）——`reorderGoals`：SQLite 版與記憶體版跑同一套，行為要一致。
 * 跑法：`node --test scripts/tests/timetable-goal-reorder.test.ts`（node 24，型別剝除預設開；零依賴）。
 * 載入法同 `timetable-plans-sqlite.test.ts`（node:sqlite 記憶體庫＋全部 migration；`../lib/db`、`./syncRepository` 換替身、op 記下來）。
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
let t = Date.now() - 1000 * 60 * 60 * 24 * 3;
export function getDb() { const d = globalThis.__goalReorderDb; if (!d) throw new Error("測試沒設 __goalReorderDb"); return Promise.resolve(d); }
export function uuid() { return crypto.randomUUID(); }
export function nowUtcIso() { t += 1000; return new Date(t).toISOString(); }
`;
const FAKE_SYNC = `
export function newWriteBatch() { return { stmts: [], ops: [] }; }
export async function runWriteBatch(db, stmts, ops) { db.runBatch(stmts, ops); }
export async function ensureSyncTables() { return false; }
`;
const dataUrl = (src: string) => "data:text/javascript," + encodeURIComponent(src);
registerHooks({
  resolve(specifier, context, nextResolve) {
    const fromSrc = context.parentURL !== undefined && context.parentURL.includes("/src/");
    if (fromSrc) {
      if (specifier === "../lib/db") return { url: dataUrl(FAKE_DB), shortCircuit: true };
      if (specifier === "./syncRepository") return { url: dataUrl(FAKE_SYNC), shortCircuit: true };
      if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) return nextResolve(specifier + ".ts", context);
    }
    return nextResolve(specifier, context);
  },
});

type Op = { tbl: string; row_id: string; op: string; cols: Record<string, unknown> };
function makeDb() {
  const raw = new DatabaseSync(":memory:");
  const dir = path.join(ROOT, "src-tauri/migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) raw.exec(readFileSync(path.join(dir, f), "utf8"));
  raw.exec("PRAGMA foreign_keys = OFF");
  const bind = (args: unknown[] = []) => Object.fromEntries(args.map((v, i) => ["$" + (i + 1), v])) as Record<string, never>;
  const db = {
    batches: [] as Op[][],
    async select(sql: string, args?: unknown[]) {
      return raw.prepare(sql).all(bind(args)).map((r) => ({ ...r }));
    },
    async execute(sql: string, args?: unknown[]) {
      raw.prepare(sql).run(bind(args));
      return { rowsAffected: 0 };
    },
    runBatch(stmts: { sql: string; args: unknown[] }[], ops: Op[]) {
      raw.exec("BEGIN");
      try {
        for (const st of stmts) raw.prepare(st.sql).run(bind(st.args));
        raw.exec("COMMIT");
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      }
      db.batches.push(ops);
    },
  };
  return db;
}

const { SqliteTimetableRepository } = await import("../../src/data/sqliteTimetableRepository.ts");
const { MemoryTimetableRepository } = await import("../../src/data/memoryTimetableRepository.ts");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Repo = any;
type Maker = () => { repo: Repo; db: ReturnType<typeof makeDb> | null };
const makers: [string, Maker][] = [
  [
    "sqlite",
    () => {
      const db = makeDb();
      (globalThis as Record<string, unknown>).__goalReorderDb = db;
      return { repo: new SqliteTimetableRepository(), db };
    },
  ],
  ["memory", () => ({ repo: new MemoryTimetableRepository({ seedDemo: false, nodeRepo: {} as never }), db: null })],
];

const goal = (name: string) => ({
  name,
  categoryIds: ["c-create"],
  period: "week",
  targetMin: 600,
  direction: "atLeast",
  startOn: null,
  endOn: null,
});

for (const [name, make] of makers) {
  describe(`${name}：⑦ reorderGoals`, () => {
    test("新順序整組寫 0..n-1；清單沒提到的接尾端；不認得的、重複的 id 略過", async () => {
      const { repo, db } = make();
      const a = await repo.createGoal(goal("甲"));
      const b = await repo.createGoal(goal("乙"));
      const c = await repo.createGoal(goal("丙"));
      const before = db?.batches.length ?? 0;
      await repo.reorderGoals([c.id, "nope", a.id, c.id]);
      const rows = await repo.listGoals();
      assert.deepEqual(rows.map((r: Repo) => r.id), [c.id, a.id, b.id]);
      assert.deepEqual(rows.map((r: Repo) => r.position), [0, 1, 2]);
      if (db) {
        assert.equal(db.batches.length, before + 1, "一次寫入＝一個 batch");
        const ops = db.batches[db.batches.length - 1];
        assert.deepEqual(ops.map((o) => o.row_id).sort(), [a.id, b.id, c.id].sort(), "整組每列都送 op（#101）");
        for (const o of ops) {
          assert.equal(o.tbl, "time_goals");
          assert.deepEqual(Object.keys(o.cols).sort(), ["position", "updated_at"]);
        }
      }
    });

    test("封存、刪除的不參與排序（位置不動、不送 op）", async () => {
      const { repo, db } = make();
      const a = await repo.createGoal(goal("甲"));
      const b = await repo.createGoal(goal("乙"));
      const c = await repo.createGoal(goal("丙"));
      const d = await repo.createGoal(goal("丁"));
      await repo.archiveGoal(b.id, true);
      await repo.deleteGoal(d.id);
      const archivedPos = (await repo.getGoal(b.id)).position;
      await repo.reorderGoals([c.id, a.id, b.id, d.id]);
      if (db) {
        const ids = db.batches[db.batches.length - 1].map((o) => o.row_id).sort();
        assert.deepEqual(ids, [a.id, c.id].sort());
      }
      assert.equal((await repo.getGoal(b.id)).position, archivedPos, "封存的位置不動");
      const live = (await repo.listGoals()).filter((r: Repo) => r.archived_at === null).map((r: Repo) => r.id);
      assert.deepEqual(live, [c.id, a.id]);
    });
  });
}

/* 整合席補：分類拖曳＝store.placeCategory 的兩步（搬組 updateCategory({ parentId }) → reorderCategories(新組, 新順序)） */
const mkCat = (repo: Repo, name: string, parentId: string | null) => repo.createCategory({ parentId, name, colorIdx: 1, defaultMin: null });
async function placeCategory(repo: Repo, id: string, parentId: string | null, orderedIds: readonly string[]) {
  const me = (await repo.listCategories()).find((c: Repo) => c.id === id);
  if (me.parent_id !== parentId && parentId !== null) await repo.updateCategory(id, { parentId });
  await repo.reorderCategories(parentId, orderedIds);
}

for (const [name, make] of makers) {
  describe(`${name}：⑦ 分類拖曳（placeCategory 的寫入）`, () => {
    test("拖到別組的第 2 格：搬組、新組整組 0..n-1 每列都送 op；舊組剩下的相對順序不變", async () => {
      const { repo, db } = make();
      const g1 = await mkCat(repo, "甲組", null);
      const a1 = await mkCat(repo, "甲一", g1.id);
      const a2 = await mkCat(repo, "甲二", g1.id);
      const a3 = await mkCat(repo, "甲三", g1.id);
      const g2 = await mkCat(repo, "乙組", null);
      const b1 = await mkCat(repo, "乙一", g2.id);
      const b2 = await mkCat(repo, "乙二", g2.id);
      const n0 = db?.batches.length ?? 0;
      await placeCategory(repo, a2.id, g2.id, [b1.id, a2.id, b2.id]);
      const all = await repo.listCategories();
      const layer = (pid: string) =>
        all.filter((c: Repo) => c.parent_id === pid).sort((x: Repo, y: Repo) => x.position - y.position);
      assert.deepEqual(layer(g2.id).map((c: Repo) => c.id), [b1.id, a2.id, b2.id]);
      assert.deepEqual(layer(g2.id).map((c: Repo) => c.position), [0, 1, 2]);
      assert.deepEqual(layer(g1.id).map((c: Repo) => c.id), [a1.id, a3.id]);
      if (db) {
        const last = db.batches[db.batches.length - 1];
        assert.equal(db.batches.length - n0, 2, "搬組一個 batch、整組排序一個 batch");
        assert.deepEqual(last.map((o) => o.row_id).sort(), [b1.id, a2.id, b2.id].sort(), "新組整組每列都送 op（#101）");
      }
    });

    test("同組換序（含組本身在頂層換序）：只寫那一層、一個 batch", async () => {
      const { repo, db } = make();
      const g1 = await mkCat(repo, "甲組", null);
      const a1 = await mkCat(repo, "甲一", g1.id);
      const a2 = await mkCat(repo, "甲二", g1.id);
      const g2 = await mkCat(repo, "乙組", null);
      const n0 = db?.batches.length ?? 0;
      await placeCategory(repo, a2.id, g1.id, [a2.id, a1.id]);
      await placeCategory(repo, g2.id, null, [g2.id, g1.id]);
      const all = await repo.listCategories();
      const byPos = (pid: string | null) =>
        all.filter((c: Repo) => c.parent_id === pid && (pid !== null || c.id === g1.id || c.id === g2.id)).sort((x: Repo, y: Repo) => x.position - y.position);
      assert.deepEqual(byPos(g1.id).map((c: Repo) => c.id), [a2.id, a1.id]);
      const top = byPos(null).map((c: Repo) => c.id);
      assert.ok(top.indexOf(g2.id) < top.indexOf(g1.id), "乙組排到甲組前面");
      if (db) assert.equal(db.batches.length - n0, 2, "兩次換序各一個 batch（沒有搬組）");
    });
  });
}
