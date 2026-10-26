/**
 * 同步引擎班 #101（D-主-125）：排序整組寫——售票口帳戶／分類、時刻表分類每次移動都把整組兄弟的 position 重寫入列。
 * 跑法：`node --test scripts/tests/sync-engine-position-group.test.ts`（node 24，型別剝除預設開；零依賴）。
 *
 * 為什麼要整組：同步是逐欄 LWW，原本相鄰互換只送「值變了的 2 列」，兩台各排同一組時各拿走自己動過的列，
 * 合出來不是任何一台的版本。整組每列同批同 hlc 都送，hlc 較大那台在每一列都贏 ⇒ 完整採用其中一台。
 *
 * 測試替身同 ticket-logic／timetable-tag-carry：`../lib/db`、`./syncRepository` 換成 data: URL 版，
 * sqlite 跑 node:sqlite 記憶體庫套真的 migration；「兩台」＝兩個庫，換裝置就換 globalThis.__db。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const FAKE_DB = `
let t = Date.UTC(2026, 9, 26, 1, 0, 0);
export function getDb() { const d = globalThis.__db; if (!d) throw new Error("測試沒設 __db"); return Promise.resolve(d); }
export function uuid() { return crypto.randomUUID(); }
export function nowUtcIso() { t += 1000; return new Date(t).toISOString(); }
`;
const FAKE_SYNC = `
export const SYNC_WRITE_EVENT = "ns:sync-write";
export function newWriteBatch() { return { stmts: [], ops: [] }; }
export async function runWriteBatch(db, stmts, ops) { db.runBatch(stmts, ops); }
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
      if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) return nextResolve(specifier + ".ts", context);
    }
    return nextResolve(specifier, context);
  },
});

/* ───────── 假 db（收 op） ───────── */

interface Op {
  tbl: string;
  row_id: string;
  op: string;
  cols: Record<string, unknown>;
}
interface TestDb {
  ops: Op[];
  select(sql: string, args?: unknown[]): Promise<Record<string, unknown>[]>;
  execute(sql: string, args?: unknown[]): Promise<void>;
  runBatch(stmts: { sql: string; args: unknown[] }[], ops: Op[]): void;
}
function makeDb(migrations: string[]): TestDb {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = OFF");
  for (const m of migrations) raw.exec(readFileSync(path.join(ROOT, "src-tauri/migrations", m), "utf8"));
  const bind = (args: unknown[] = []) => Object.fromEntries(args.map((v, i) => ["$" + (i + 1), v])) as Record<string, never>;
  const db: TestDb = {
    ops: [],
    async select(sql, args) {
      return raw.prepare(sql).all(bind(args)).map((r) => ({ ...r }));
    },
    async execute(sql, args) {
      raw.prepare(sql).run(bind(args));
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
      db.ops.push(...ops);
    },
  };
  return db;
}
const setDb = (db: TestDb) => {
  (globalThis as { __db?: TestDb }).__db = db;
};

/** 新列的完整 upsert op 灌進另一台（＝兩台起點相同；不模擬 hlc，起點視為 hlc 0） */
async function seedFrom(src: TestDb, dst: TestDb): Promise<void> {
  for (const o of src.ops) {
    const names = Object.keys(o.cols);
    await dst.execute(
      `INSERT OR REPLACE INTO ${o.tbl} (id, ${names.join(", ")}) VALUES ($1, ${names.map((_, i) => `$${i + 2}`).join(", ")})`,
      [o.row_id, ...names.map((n) => o.cols[n])],
    );
  }
}

/**
 * 逐欄 LWW 合併：每個 op 批次帶一個 hlc（同批共用），cell＝(tbl,row,col)，hlc 大的贏。
 * 回合併後每一列的 position（起點 hlc 0 的值由 seed 給）。
 */
function mergePositions(seed: Map<string, number>, batches: { hlc: number; ops: Op[] }[]): Map<string, number> {
  const cells = new Map<string, { hlc: number; v: number }>();
  for (const [id, v] of seed) cells.set(id, { hlc: 0, v });
  for (const { hlc, ops } of batches) {
    for (const o of ops) {
      if (typeof o.cols.position !== "number") continue;
      const cur = cells.get(o.row_id);
      if (!cur || hlc > cur.hlc) cells.set(o.row_id, { hlc, v: o.cols.position });
    }
  }
  return new Map([...cells].map(([k, c]) => [k, c.v]));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRepo = any;

/* ═════════════════════════ 售票口 ═════════════════════════ */

const newAcc = (name: string, group: string) => ({ name, group, currency: "TWD", openingMinor: null, occurredOn: "2026-10-26" });

const TICKET_IMPLS: { name: string; make: () => Promise<{ repo: AnyRepo; db: TestDb | null }> }[] = [
  {
    name: "memory",
    make: async () => {
      const { MemoryTicketRepository } = await import("../../src/data/memoryTicketRepository.ts");
      return { repo: new MemoryTicketRepository({ seedDemo: false }), db: null };
    },
  },
  {
    name: "sqlite",
    make: async () => {
      const db = makeDb(["0007_ticket_ledger.sql", "0010_ticket_plan.sql"]);
      setDb(db);
      const { SqliteTicketRepository } = await import("../../src/data/sqliteTicketRepository.ts");
      return { repo: new SqliteTicketRepository(), db };
    },
  },
];

describe("#101 售票口：相鄰互換寫整組", () => {
  for (const impl of TICKET_IMPLS) {
    test(`moveAccount：整組 position 正規化 0..n-1、整組 updated_at 都動（${impl.name}）`, async () => {
      const { repo, db } = await impl.make();
      await repo.ensureStarterRows();
      const a = await repo.createAccount(newAcc("A", "bank"));
      const b = await repo.createAccount(newAcc("B", "bank"));
      const c = await repo.createAccount(newAcc("C", "bank"));
      const d = await repo.createAccount(newAcc("D", "bank"));
      const other = await repo.createAccount(newAcc("別組", "cash"));
      const bank = async () => (await repo.listAccounts()).filter((x: { group_key: string }) => x.group_key === "bank");
      const before = new Map<string, string>((await bank()).map((x: { id: string; updated_at: string }) => [x.id, x.updated_at]));
      const otherBefore = (await repo.listAccounts()).find((x: { id: string }) => x.id === other.id).updated_at;
      const n0 = db?.ops.length ?? 0;

      await repo.moveAccount(c.id, -1);

      const after = await bank();
      assert.deepEqual(after.map((x: { id: string }) => x.id), [a.id, c.id, b.id, d.id]);
      assert.deepEqual(after.map((x: { position: number }) => x.position), [0, 1, 2, 3]);
      for (const x of after) assert.notEqual(x.updated_at, before.get(x.id), "沒換位的兄弟也要被戳（整組寫）");
      assert.equal((await repo.listAccounts()).find((x: { id: string }) => x.id === other.id).updated_at, otherBefore, "別組不動");
      if (db) {
        const ops = db.ops.slice(n0);
        assert.equal(ops.length, 4, "整組 4 列各一個 op");
        assert.deepEqual(ops.map((o) => o.row_id).sort(), [a.id, b.id, c.id, d.id].sort());
        for (const o of ops) assert.deepEqual(Object.keys(o.cols).sort(), ["position", "updated_at"]);
      }
    });

    test(`moveAccount：歷史撞號（兩列同 position）移動後也被正規化（${impl.name}）`, async () => {
      const { repo, db } = await impl.make();
      await repo.ensureStarterRows();
      const a = await repo.createAccount(newAcc("A", "bank"));
      const b = await repo.createAccount(newAcc("B", "bank"));
      const c = await repo.createAccount(newAcc("C", "bank"));
      if (!db) return; // memory 的列從外面改不到，造不出撞號；它的整組正規化由上一條驗
      await db.execute("UPDATE tk_accounts SET position = 0 WHERE id IN ($1, $2, $3)", [a.id, b.id, c.id]);
      await repo.moveAccount(c.id, -1);
      const rows = (await repo.listAccounts()).filter((x: { group_key: string }) => x.group_key === "bank");
      assert.deepEqual(rows.map((x: { position: number }) => x.position), [0, 1, 2]);
    });

    test(`moveCategory：整組（同 kind 同層、不含封存與兩個「未分類」）每列都寫（${impl.name}）`, async () => {
      const { repo, db } = await impl.make();
      await repo.ensureStarterRows();
      const x = await repo.createCategory({ kind: "expense", name: "X", parentId: null });
      const y = await repo.createCategory({ kind: "expense", name: "Y", parentId: null });
      const z = await repo.createCategory({ kind: "expense", name: "Z", parentId: null });
      const arch = await repo.createCategory({ kind: "expense", name: "封存的", parentId: null });
      await repo.setCategoryArchived(arch.id, true);
      const archBefore = (await repo.listCategories()).find((r: { id: string }) => r.id === arch.id);
      const n0 = db?.ops.length ?? 0;

      await repo.moveCategory(z.id, -1);

      const cats = await repo.listCategories();
      const live = cats.filter((r: { kind: string; parent_id: string | null; archived_at: string | null; name: string }) =>
        r.kind === "expense" && r.parent_id === null && r.archived_at === null && r.name !== "未分類");
      assert.deepEqual(live.map((r: { id: string }) => r.id), [x.id, z.id, y.id]);
      assert.deepEqual(live.map((r: { position: number }) => r.position), [0, 1, 2]);
      const archAfter = cats.find((r: { id: string }) => r.id === arch.id);
      assert.equal(archAfter.updated_at, archBefore.updated_at, "封存列不在組內，不碰");
      if (db) {
        const ops = db.ops.slice(n0);
        assert.deepEqual(ops.map((o) => o.row_id).sort(), [x.id, y.id, z.id].sort(), "只有顯示邊界內的 3 列，沒有封存、沒有未分類");
      }
    });
  }

  test("兩台各排同一群組 ⇒ 整組 LWW，收斂成 hlc 較大那台的完整版本（sqlite 兩個庫）", async () => {
    const devA = makeDb(["0007_ticket_ledger.sql", "0010_ticket_plan.sql"]);
    const devB = makeDb(["0007_ticket_ledger.sql", "0010_ticket_plan.sql"]);
    const { SqliteTicketRepository } = await import("../../src/data/sqliteTicketRepository.ts");
    const repo = new SqliteTicketRepository();

    // 起點：A 建好一組 4 個帳戶（positions 0..3），op 灌給 B
    setDb(devA);
    await repo.ensureStarterRows();
    const made: { id: string }[] = [];
    for (const n of ["A", "B", "C", "D"]) made.push(await repo.createAccount(newAcc(n, "bank")));
    await seedFrom(devA, devB);
    const seedOps = devA.ops.length;
    const ids = made.map((x) => x.id);
    const listIds = async (db: TestDb) => {
      setDb(db);
      return (await repo.listAccounts()).filter((x: { group_key: string }) => x.group_key === "bank").map((x: { id: string }) => x.id);
    };
    assert.deepEqual(await listIds(devB), ids, "兩台起點相同");
    const seed = new Map<string, number>(ids.map((id, i) => [id, i]));

    // A 把 C 往上（A,C,B,D）；B 把 D 往上（A,B,D,C）——原本各只送 2 列，合出 A?
    setDb(devA);
    await repo.moveAccount(ids[2], -1);
    setDb(devB);
    await repo.moveAccount(ids[3], -1);
    const bOrder = await listIds(devB);
    assert.deepEqual(bOrder, [ids[0], ids[1], ids[3], ids[2]]);

    const opsA = devA.ops.slice(seedOps);
    const opsB = devB.ops; // B 的 ops 只有這次移動
    assert.equal(opsA.length, 4);
    assert.equal(opsB.length, 4);

    // B 的 hlc 較大 ⇒ 每一列都贏 ⇒ 合併結果＝B 的完整版本
    const merged = mergePositions(seed, [
      { hlc: 1, ops: opsA },
      { hlc: 2, ops: opsB },
    ]);
    const mergedOrder = [...merged].sort((p, q) => p[1] - q[1]).map(([id]) => id);
    assert.deepEqual(mergedOrder, bOrder, "收斂成 B 的完整版本");
    assert.deepEqual([...merged.values()].sort(), [0, 1, 2, 3], "沒有撞號");
    // 反向（A 的 hlc 較大）⇒ 收斂成 A 的完整版本
    const mergedRev = mergePositions(seed, [
      { hlc: 2, ops: opsA },
      { hlc: 1, ops: opsB },
    ]);
    const revOrder = [...mergedRev].sort((p, q) => p[1] - q[1]).map(([id]) => id);
    assert.deepEqual(revOrder, [ids[0], ids[2], ids[1], ids[3]], "收斂成 A 的完整版本");

    // 對照：只送值有變的列（舊行為）合出來不是任何一台的版本——證明這個模擬抓得到 #101
    const changedOnly = (ops: Op[], from: number[]) => ops.filter((o) => from[ids.indexOf(o.row_id)] !== (o.cols.position as number));
    const oldA = changedOnly(opsA, [0, 1, 2, 3]);
    const oldB = changedOnly(opsB, [0, 1, 2, 3]);
    assert.equal(oldA.length, 2);
    assert.equal(oldB.length, 2);
    const mixed = mergePositions(seed, [
      { hlc: 1, ops: oldA },
      { hlc: 2, ops: oldB },
    ]);
    assert.notDeepEqual([...mixed.values()].sort(), [0, 1, 2, 3], "舊行為：兩台各排一次會撞號（混合版本）");
  });
});

/* ═════════════════════════ 時刻表 ═════════════════════════ */

const TIME_IMPLS: { name: string; make: () => Promise<{ repo: AnyRepo; db: TestDb | null }> }[] = [
  {
    name: "memory",
    make: async () => {
      const { MemoryTimetableRepository } = await import("../../src/data/memoryTimetableRepository.ts");
      return { repo: new MemoryTimetableRepository({ seedDemo: false, nodeRepo: {} as never, tagRepo: null }), db: null };
    },
  },
  {
    name: "sqlite",
    make: async () => {
      const db = makeDb(["0006_timetable_blocks.sql", "0011_timetable_goals.sql"]);
      setDb(db);
      const { SqliteTimetableRepository } = await import("../../src/data/sqliteTimetableRepository.ts");
      return { repo: new SqliteTimetableRepository({ tagRepo: null }), db };
    },
  },
];

const mkCat = (repo: AnyRepo, name: string, parentId: string | null) => repo.createCategory({ parentId, name, colorIdx: 1, defaultMin: null });

describe("#101 時刻表分類：reorderCategories 寫整組並對帳", () => {
  for (const impl of TIME_IMPLS) {
    test(`沒變的列也寫；清單沒提到的兄弟接尾端；封存與別層不碰；結果 0..n-1（${impl.name}）`, async () => {
      const { repo, db } = await impl.make();
      const g = await mkCat(repo, "組", null);
      const k1 = await mkCat(repo, "一", g.id);
      const k2 = await mkCat(repo, "二", g.id);
      const k3 = await mkCat(repo, "三", g.id);
      const k4 = await mkCat(repo, "四", g.id);
      const arch = await mkCat(repo, "封存", g.id);
      await repo.updateCategory(arch.id, { archived: true });
      const g2 = await mkCat(repo, "別組", null);
      const o1 = await mkCat(repo, "別組子", g2.id);
      const layer = async (pid: string) =>
        (await repo.listCategories()).filter((c: { parent_id: string | null }) => c.parent_id === pid);
      const stamp = async (id: string) => (await repo.listCategories()).find((c: { id: string }) => c.id === id).updated_at;
      const archStamp = await stamp(arch.id);
      const otherStamp = await stamp(o1.id);
      const n0 = db?.ops.length ?? 0;

      // 清單陳舊：只列 k2、k1（k3、k4 是「並行新增」沒在清單裡）；夾一個別層的 id 與一個重複 id
      await repo.reorderCategories(g.id, [k2.id, o1.id, k1.id, k2.id]);

      const live = (await layer(g.id)).filter((c: { archived_at: string | null }) => c.archived_at === null);
      const sorted = [...live].sort((a: { position: number }, b: { position: number }) => a.position - b.position);
      assert.deepEqual(sorted.map((c: { id: string }) => c.id), [k2.id, k1.id, k3.id, k4.id]);
      assert.deepEqual(sorted.map((c: { position: number }) => c.position), [0, 1, 2, 3]);
      assert.equal(await stamp(arch.id), archStamp, "封存的不在組內");
      assert.equal(await stamp(o1.id), otherStamp, "別層不碰");
      if (db) {
        const ops = db.ops.slice(n0);
        assert.deepEqual(ops.map((o) => o.row_id), [k2.id, k1.id, k3.id, k4.id], "整組 4 列、依新順序各一個 op");
        for (const o of ops) assert.deepEqual(Object.keys(o.cols).sort(), ["position", "updated_at"]);
      }

      // 已經是這個順序再排一次：值沒變也照寫（整組 LWW 要的就是這個）
      const n1 = db?.ops.length ?? 0;
      const s1 = await stamp(k3.id);
      await repo.reorderCategories(g.id, [k2.id, k1.id, k3.id, k4.id]);
      assert.notEqual(await stamp(k3.id), s1);
      if (db) assert.equal(db.ops.length - n1, 4);
    });
  }

  test("兩台各排同一層 ⇒ 整組 LWW 收斂成 hlc 較大那台的完整版本（sqlite 兩個庫）", async () => {
    const devA = makeDb(["0006_timetable_blocks.sql", "0011_timetable_goals.sql"]);
    const devB = makeDb(["0006_timetable_blocks.sql", "0011_timetable_goals.sql"]);
    const { SqliteTimetableRepository } = await import("../../src/data/sqliteTimetableRepository.ts");
    const repo = new SqliteTimetableRepository({ tagRepo: null });

    setDb(devA);
    const g = await mkCat(repo, "組", null);
    const ks: { id: string }[] = [];
    for (const n of ["一", "二", "三", "四"]) ks.push(await mkCat(repo, n, g.id));
    await seedFrom(devA, devB);
    const seedOps = devA.ops.length;
    const ids = ks.map((k) => k.id);
    const orderOf = async (db: TestDb) => {
      setDb(db);
      return (await repo.listCategories())
        .filter((c: { parent_id: string | null }) => c.parent_id === g.id)
        .sort((a: { position: number }, b: { position: number }) => a.position - b.position)
        .map((c: { id: string }) => c.id);
    };
    assert.deepEqual(await orderOf(devB), ids);
    const seed = new Map<string, number>(ids.map((id, i) => [id, i]));

    // A：三 ↑（一,三,二,四）；B：四 ↑（一,二,四,三）。UI 的 moveCategory 送整組 orderedIds
    setDb(devA);
    await repo.reorderCategories(g.id, [ids[0], ids[2], ids[1], ids[3]]);
    setDb(devB);
    await repo.reorderCategories(g.id, [ids[0], ids[1], ids[3], ids[2]]);
    const opsA = devA.ops.slice(seedOps);
    const opsB = devB.ops;
    assert.equal(opsA.length, 4);
    assert.equal(opsB.length, 4);

    const win = (m: Map<string, number>) => [...m].sort((p, q) => p[1] - q[1]).map(([id]) => id);
    const mergedB = mergePositions(seed, [{ hlc: 1, ops: opsA }, { hlc: 2, ops: opsB }]);
    assert.deepEqual(win(mergedB), await orderOf(devB), "B 贏 ⇒ B 的完整版本");
    assert.deepEqual([...mergedB.values()].sort(), [0, 1, 2, 3]);
    const mergedA = mergePositions(seed, [{ hlc: 2, ops: opsA }, { hlc: 1, ops: opsB }]);
    assert.deepEqual(win(mergedA), await orderOf(devA), "A 贏 ⇒ A 的完整版本");
  });
});
