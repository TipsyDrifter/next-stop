/**
 * 回饋乙（D-主-151；結接縫 #108／點子 #119）：nodes 兄弟順序改排序鍵 sort_key（migration 0014）。
 * 跑法：`node --test scripts/tests/node-sort-key.test.ts`（node 24，型別剝除預設開；零依賴）。
 *
 * 驗的事：①搬一列只寫一列 ②路線最上層的列車與臨時車票共用一份清單（#119） ③兩台各搬同區不同列、合併後兩邊的意圖都在
 * ④兩台插同一個縫撞鍵：顯示穩定、再插進兩者之間只多寫一列 ⑤存量回填決定性 ⑥moveMany 多張保持相對順序。
 *
 * 替身同 sync-engine-position-group：`../lib/db`、`./syncRepository` 換成 data: URL 版；sqlite 跑 node:sqlite 記憶體庫套全部 migration。
 * 「兩台」＝兩顆庫，換裝置就換 globalThis.__db；每個 runWriteBatch＝一批、一個遞增 hlc；交換＝把對方的批次照逐格 LWW 套進來
 * （只套 nodes；line_id／route_id 快取不同步——群組條件用的是 parent_id 與根層車票的 route_id，後者是資料、會進 op）。
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
let t = Date.UTC(2026, 10, 1, 1, 0, 0);
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

/* ───────── 假 db（收批次＋hlc） ───────── */

interface Op {
  tbl: string;
  row_id: string;
  op: string;
  cols: Record<string, unknown>;
}
interface Batch {
  hlc: number;
  ops: Op[];
}
let HLC = 0;
interface TestDb {
  batches: Batch[];
  /** 逐格戳記（tbl|row|col → hlc）：本機寫的與套進來的都記 */
  cells: Map<string, number>;
  raw: DatabaseSync;
  select(sql: string, args?: unknown[]): Promise<Record<string, unknown>[]>;
  execute(sql: string, args?: unknown[]): Promise<{ rowsAffected: number }>;
  runBatch(stmts: { sql: string; args: unknown[] }[], ops: Op[]): void;
}
const bind = (args: unknown[] = []) => Object.fromEntries(args.map((v, i) => ["$" + (i + 1), v])) as Record<string, never>;
function makeDb(): TestDb {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = OFF");
  const dir = path.join(ROOT, "src-tauri/migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) raw.exec(readFileSync(path.join(dir, f), "utf8"));
  const db: TestDb = {
    batches: [],
    cells: new Map(),
    raw,
    async select(sql, args) {
      return raw.prepare(sql).all(bind(args)).map((r) => ({ ...r }));
    },
    async execute(sql, args) {
      raw.prepare(sql).run(bind(args));
      return { rowsAffected: 0 };
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
      if (!ops.length) return;
      const hlc = ++HLC;
      for (const o of ops) for (const c of Object.keys(o.cols)) db.cells.set(`${o.tbl}|${o.row_id}|${c}`, hlc);
      db.batches.push({ hlc, ops });
    },
  };
  return db;
}
const setDb = (db: TestDb) => {
  (globalThis as { __db?: TestDb }).__db = db;
};

/** 把 src 從第 from 批起的 nodes op 照逐格 LWW 套進 dst（＝同步拉取） */
function applyBatches(src: TestDb, dst: TestDb, from = 0): void {
  for (const { hlc, ops } of src.batches.slice(from)) {
    for (const o of ops) {
      if (o.tbl !== "nodes") continue;
      const win = Object.keys(o.cols).filter((c) => hlc > (dst.cells.get(`nodes|${o.row_id}|${c}`) ?? 0));
      if (!win.length) continue;
      const exists = dst.raw.prepare("SELECT 1 FROM nodes WHERE id = $1").get(bind([o.row_id]));
      if (exists) {
        dst.raw
          .prepare(`UPDATE nodes SET ${win.map((c, i) => `${c} = $${i + 2}`).join(", ")} WHERE id = $1`)
          .run(bind([o.row_id, ...win.map((c) => o.cols[c])]));
      } else {
        dst.raw
          .prepare(`INSERT INTO nodes (id, ${win.join(", ")}) VALUES ($1, ${win.map((_, i) => `$${i + 2}`).join(", ")})`)
          .run(bind([o.row_id, ...win.map((c) => o.cols[c])]));
      }
      for (const c of win) dst.cells.set(`nodes|${o.row_id}|${c}`, hlc);
    }
  }
}

/** 兩台互相拉取（各自從上次交換之後的批次起） */
function exchange(a: TestDb, b: TestDb, mark: { a: number; b: number }): void {
  const na = a.batches.length;
  const nb = b.batches.length;
  applyBatches(a, b, mark.a);
  applyBatches(b, a, mark.b);
  mark.a = na;
  mark.b = nb;
}

/* ───────── 被測 ───────── */

const { SqliteNodeRepository } = await import("../../src/data/sqliteNodeRepository.ts");
const { MemoryNodeRepository } = await import("../../src/data/memoryRepository.ts");
const { compareSiblings, groupFor, inGroup } = await import("../../src/domain/nodeOrder.ts");
const { planSortKeyBackfill, slotFromAnchor } = await import("../../src/domain/nodeSortKey.ts");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Repo = any;
const nodeOps = (db: TestDb, from: number) => db.batches.slice(from).flatMap((b) => b.ops.filter((o) => o.tbl === "nodes"));

const IMPLS: { name: string; make: () => { repo: Repo; db: TestDb | null } }[] = [
  {
    name: "sqlite",
    make: () => {
      const db = makeDb();
      setDb(db);
      return { repo: new SqliteNodeRepository(), db };
    },
  },
  { name: "memory", make: () => ({ repo: new MemoryNodeRepository(), db: null }) },
];

/** 一條路線＋n 班列車（照建立序＝顯示序） */
async function routeWith(repo: Repo, names: string[]) {
  const line = await repo.create({ kind: "line", name: "本線", parentId: null });
  const route = await repo.create({ kind: "route", name: "路線", parentId: line.id });
  const ids: Record<string, string> = {};
  for (const n of names) ids[n] = (await repo.create({ kind: "train", name: n, parentId: route.id })).id;
  return { line, route, ids };
}
const namesOf = async (repo: Repo, anyId: string, ids: Record<string, string>) => {
  const back = Object.fromEntries(Object.entries(ids).map(([k, v]) => [v, k]));
  return (await repo.listSiblingIds(anyId)).map((x: string) => back[x] ?? x);
};

/* ───────── ① ② ⑥：兩種實作都跑 ───────── */

for (const impl of IMPLS) {
  describe(`排序鍵（${impl.name}）`, () => {
    test("①搬一列只寫被搬那一列（sort_key＋parent_id＋kind＋updated_at）；position 不動、兄弟不動", async () => {
      const { repo, db } = impl.make();
      const { route, ids } = await routeWith(repo, ["a", "b", "c", "d"]);
      const before = new Map<string, Repo>();
      for (const id of Object.values(ids)) before.set(id, await repo.getNode(id));
      const n0 = db?.batches.length ?? 0;
      await repo.move(ids.d, route.id, 0);
      assert.deepEqual(await namesOf(repo, ids.a, ids), ["d", "a", "b", "c"]);
      for (const k of ["a", "b", "c"]) {
        const row = await repo.getNode(ids[k]);
        assert.equal(row.sort_key, before.get(ids[k]).sort_key, `${k} 的鍵不動`);
        assert.equal(row.updated_at, before.get(ids[k]).updated_at, `${k} 不被戳`);
      }
      const d = await repo.getNode(ids.d);
      assert.equal(d.position, before.get(ids.d).position, "position 不再被搬移改寫");
      assert.ok(d.sort_key < before.get(ids.a).sort_key, "新鍵在 a 之前（位元組序）");
      if (db) {
        const ops = nodeOps(db, n0);
        assert.equal(ops.length, 1, "一筆 op");
        assert.equal(ops[0].row_id, ids.d);
        assert.deepEqual(Object.keys(ops[0].cols).sort(), ["kind", "parent_id", "sort_key", "updated_at"]);
      }
    });

    test("②#119：路線最上層的列車與掛標籤的臨時車票同一份清單，搬來搬去不對調；臨時票重排不碰別條路線與收件匣", async () => {
      const { repo, db } = impl.make();
      const { line, route, ids } = await routeWith(repo, ["T1", "T2"]);
      ids.K1 = (await repo.create({ kind: "ticket", name: "K1", parentId: null, routeTagId: route.id })).id;
      ids.K2 = (await repo.create({ kind: "ticket", name: "K2", parentId: null, routeTagId: route.id })).id;
      const route2 = await repo.create({ kind: "route", name: "別條", parentId: line.id });
      const other = await repo.create({ kind: "ticket", name: "別條的票", parentId: null, routeTagId: route2.id });
      const inbox = await repo.create({ kind: "ticket", name: "收件匣", parentId: null });
      assert.equal(inbox.sort_key, null, "收件匣不排序、不給鍵");
      const untouched = async () => [await repo.getNode(other.id), await repo.getNode(inbox.id)].map((r: Repo) => [r.sort_key, r.updated_at, r.position]);
      const keep = await untouched();
      const n0 = db?.batches.length ?? 0;

      assert.deepEqual(await namesOf(repo, ids.T1, ids), ["T1", "T2", "K1", "K2"], "新建一律接尾（列車與臨時票同一條尾巴）");
      await repo.move(ids.K2, null, 1); // 臨時票（根層、保留標籤）插到 T1 後面
      assert.deepEqual(await namesOf(repo, ids.T1, ids), ["T1", "K2", "T2", "K1"]);
      await repo.move(ids.T2, route.id, 0);
      assert.deepEqual(await namesOf(repo, ids.T1, ids), ["T2", "T1", "K2", "K1"]);
      await repo.moveMany([{ id: ids.K1, parentId: null }], { after: ids.T2, before: ids.T1 });
      assert.deepEqual(await namesOf(repo, ids.T1, ids), ["T2", "K1", "T1", "K2"]);
      // 大綱（listRouteTree）的最上層順序＝同一份清單
      const tree = await repo.listRouteTree(route.id);
      const roots = tree.filter((n: Repo) => n.parent_id === route.id || n.parent_id === null).map((n: Repo) => n.id);
      assert.deepEqual(roots, await repo.listSiblingIds(ids.T1));
      assert.deepEqual(await untouched(), keep, "別條路線的票、收件匣的票一個欄位都沒動");
      if (db) assert.ok(nodeOps(db, n0).every((o) => o.row_id !== other.id && o.row_id !== inbox.id), "op 也沒有它們");
      // 臨時票的標籤沒被搬移洗掉
      assert.equal((await repo.getNode(ids.K1)).route_id, route.id);
    });

    test("⑥moveMany：多張依給的順序放在錨之間、保持相對順序；放不進同一份清單＝整批不寫", async () => {
      const { repo, db } = impl.make();
      const { line, route, ids } = await routeWith(repo, ["a", "b", "c", "d", "e"]);
      await repo.moveMany(
        [
          { id: ids.b, parentId: route.id },
          { id: ids.d, parentId: route.id },
        ],
        { after: ids.e, before: null },
      );
      assert.deepEqual(await namesOf(repo, ids.a, ids), ["a", "c", "e", "b", "d"]);
      await repo.moveMany(
        [
          { id: ids.d, parentId: route.id },
          { id: ids.a, parentId: route.id },
        ],
        { after: ids.c, before: ids.e },
      );
      assert.deepEqual(await namesOf(repo, ids.a, ids), ["c", "d", "a", "e", "b"]);
      // 錨的鄰居被搬走／不在：after 找不到就看 before
      await repo.moveMany([{ id: ids.b, parentId: route.id }], { after: "不存在", before: ids.c });
      assert.deepEqual(await namesOf(repo, ids.a, ids), ["b", "c", "d", "a", "e"]);
      // 跨清單：一張路線最上層、一張別條路線 ⇒ 擋下、什麼都沒寫
      const route2 = await repo.create({ kind: "route", name: "別條", parentId: line.id });
      const n0 = db?.batches.length ?? 0;
      await assert.rejects(
        repo.moveMany(
          [
            { id: ids.a, parentId: route.id },
            { id: ids.e, parentId: route2.id },
          ],
          { after: null, before: null },
        ),
        /放不進同一個地方/,
      );
      assert.deepEqual(await namesOf(repo, ids.a, ids), ["b", "c", "d", "a", "e"]);
      if (db) assert.equal(db.batches.length, n0, "整批不寫");
    });

    test("moveMany：路線標籤一起換（routeTag）＝臨時票換到別條路線的清單、收件匣（null）清標籤", async () => {
      const { repo } = impl.make();
      const { line, route, ids } = await routeWith(repo, ["T1"]);
      const route2 = await repo.create({ kind: "route", name: "別條", parentId: line.id });
      const t2 = await repo.create({ kind: "train", name: "別條列車", parentId: route2.id });
      const k = await repo.create({ kind: "ticket", name: "K", parentId: null, routeTagId: route.id });
      await repo.moveMany([{ id: k.id, parentId: null, routeTag: route2.id }], { after: null, before: t2.id });
      const moved = await repo.getNode(k.id);
      assert.equal(moved.route_id, route2.id);
      assert.deepEqual(await repo.listSiblingIds(k.id), [k.id, t2.id]);
      assert.deepEqual(await repo.listSiblingIds(ids.T1), [ids.T1], "原路線少了它");
      await repo.moveMany([{ id: k.id, parentId: null, routeTag: null }], { after: null, before: null });
      const inbox = await repo.getNode(k.id);
      assert.equal(inbox.route_id, null);
      assert.equal(inbox.sort_key, null, "收件匣不給鍵");
    });

    test("setRouteTag 換標籤＝排序鍵改成新清單的尾端；清標籤＝NULL", async () => {
      const { repo } = impl.make();
      const { route, ids } = await routeWith(repo, ["T1", "T2"]);
      const k = await repo.create({ kind: "ticket", name: "K", parentId: null });
      await repo.setRouteTag(k.id, route.id);
      assert.deepEqual(await repo.listSiblingIds(ids.T1), [ids.T1, ids.T2, k.id]);
      await repo.setRouteTag(k.id, null);
      assert.equal((await repo.getNode(k.id)).sort_key, null);
    });

    test("create afterId：插在那一格後面；不在同一份清單＝尾端；不再位移兄弟", async () => {
      const { repo, db } = impl.make();
      const { route, ids } = await routeWith(repo, ["a", "b"]);
      const n0 = db?.batches.length ?? 0;
      ids.x = (await repo.create({ kind: "train", name: "x", parentId: route.id, afterId: ids.a })).id;
      assert.deepEqual(await namesOf(repo, ids.a, ids), ["a", "x", "b"]);
      if (db) assert.deepEqual(nodeOps(db, n0).map((o) => o.row_id), [ids.x], "只寫新的那一列");
      const car = await repo.create({ kind: "car", name: "車廂", parentId: ids.b });
      ids.y = (await repo.create({ kind: "train", name: "y", parentId: route.id, afterId: car.id })).id;
      assert.deepEqual(await namesOf(repo, ids.a, ids), ["a", "x", "b", "y"]);
    });
  });
}

/* ───────── ③ ④ ⑤：兩台（sqlite） ───────── */

describe("排序鍵：兩台（sqlite）", () => {
  /** A 建好一條路線＋列車，B 從 A 拉一次（＝兩台起點相同） */
  async function twoDevices(names: string[]) {
    const A = makeDb();
    const B = makeDb();
    setDb(A);
    const repoA = new SqliteNodeRepository();
    const repoB = new SqliteNodeRepository();
    const { route, ids } = await routeWith(repoA, names);
    const mark = { a: 0, b: 0 };
    exchange(A, B, mark);
    const on = async <T>(db: TestDb, fn: () => Promise<T>): Promise<T> => {
      setDb(db);
      return fn();
    };
    const order = async (db: TestDb) => on(db, () => namesOf(db === A ? repoA : repoB, ids[names[0]], ids));
    return { A, B, repoA, repoB, route, ids, mark, on, order };
  }

  test("③兩台各搬同一區的不同列 ⇒ 合併後兩邊的意圖都在、兩台一樣（沒有混血）", async () => {
    const t = await twoDevices(["a", "b", "c", "d", "e"]);
    await t.on(t.A, () => t.repoA.move(t.ids.a, t.route.id, 2)); // A：a 搬到 c 後面
    await t.on(t.B, () => t.repoB.move(t.ids.e, t.route.id, 0)); // B：e 搬到最前面
    assert.deepEqual(await t.order(t.A), ["b", "c", "a", "d", "e"]);
    assert.deepEqual(await t.order(t.B), ["e", "a", "b", "c", "d"]);
    exchange(t.A, t.B, t.mark);
    assert.deepEqual(await t.order(t.A), ["e", "b", "c", "a", "d"], "兩個搬移都在");
    assert.deepEqual(await t.order(t.B), await t.order(t.A), "兩台一樣");
  });

  test("③′兩台搬同一列 ⇒ 那一列後寫贏，結果是其中一台的完整意圖", async () => {
    const t = await twoDevices(["a", "b", "c", "d"]);
    await t.on(t.A, () => t.repoA.move(t.ids.a, t.route.id, 3));
    await t.on(t.B, () => t.repoB.move(t.ids.a, t.route.id, 1)); // B 後寫
    const bLocal = await t.order(t.B);
    exchange(t.A, t.B, t.mark);
    assert.deepEqual(await t.order(t.A), bLocal);
    assert.deepEqual(await t.order(t.B), bLocal);
  });

  test("④兩台插同一個縫撞鍵 ⇒ 顯示穩定、兩台一樣；再插進兩者之間只多寫擋路的那一列", async () => {
    const t = await twoDevices(["a", "b"]);
    const x = await t.on(t.A, () => t.repoA.create({ kind: "train", name: "x", parentId: t.route.id, afterId: t.ids.a }));
    const y = await t.on(t.B, () => t.repoB.create({ kind: "train", name: "y", parentId: t.route.id, afterId: t.ids.a }));
    t.ids.x = x.id;
    t.ids.y = y.id;
    assert.equal(x.sort_key, y.sort_key, "前提：兩台算出同一個鍵");
    exchange(t.A, t.B, t.mark);
    const merged = await t.order(t.A);
    assert.deepEqual(await t.order(t.B), merged, "撞鍵時兩台照同一條決勝排、畫面一樣");
    assert.equal(merged[0], "a");
    assert.equal(merged[3], "b");
    // 在 A 上插進兩張撞鍵的中間
    const first = merged[1];
    const n0 = t.A.batches.length;
    const z = await t.on(t.A, () => t.repoA.create({ kind: "train", name: "z", parentId: t.route.id, afterId: t.ids[first] }));
    t.ids.z = z.id;
    const ops = nodeOps(t.A, n0);
    assert.equal(ops.length, 2, "新的一列＋擋路的一列");
    assert.ok(ops.some((o) => o.row_id === z.id));
    assert.deepEqual(await t.order(t.A), ["a", first, "z", merged[2], "b"]);
    exchange(t.A, t.B, t.mark);
    assert.deepEqual(await t.order(t.B), await t.order(t.A));
  });

  test("⑤存量回填決定性：兩份一樣的舊資料（sort_key 全 NULL）回填出一樣的鍵、照舊順序；op 只帶 sort_key、不戳 updated_at；再跑一次零寫入", async () => {
    const rows = [
      ["L1", "line", null, null, null, 1],
      ["L2", "line", null, null, null, 0],
      ["R1", "route", "L1", "L1", null, 0],
      ["T1", "train", "R1", "L1", "R1", 5],
      ["T2", "train", "R1", "L1", "R1", 2],
      ["S1", "station", "R1", "L1", "R1", 0],
      ["K1", "ticket", null, "L1", "R1", 3], // 掛 R1 標籤的臨時票：跟 T1／T2 同一份清單
      ["K2", "ticket", null, null, null, 0], // 收件匣：不給鍵
      ["C1", "car", "T2", "L1", "R1", 1],
      ["C2", "car", "T2", "L1", "R1", 1], // 同 position ⇒ created_at 決勝
    ] as const;
    const seedOld = (db: TestDb) => {
      rows.forEach(([id, kind, parent, line, route, pos], i) => {
        const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
        db.raw
          .prepare(
            `INSERT INTO nodes (id, kind, parent_id, line_id, route_id, name, position, created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`,
          )
          .run(bind([id, kind, parent, line, route, id, pos, ts]));
      });
    };
    const keysOf = (db: TestDb) =>
      Object.fromEntries((db.raw.prepare("SELECT id, sort_key FROM nodes ORDER BY id").all() as { id: string; sort_key: string | null }[]).map((r) => [r.id, r.sort_key]));
    const A = makeDb();
    const B = makeDb();
    seedOld(A);
    seedOld(B);
    const stampsBefore = A.raw.prepare("SELECT id, updated_at FROM nodes ORDER BY id").all();
    setDb(A);
    await new SqliteNodeRepository().listSidebar(); // 讀取觸發回填（同 backfillOverrides 的呼叫點）
    setDb(B);
    await new SqliteNodeRepository().listSidebar();
    assert.deepEqual(keysOf(A), keysOf(B), "兩台算出一樣的鍵");
    const k = keysOf(A);
    assert.equal(k.K2, null, "收件匣不給鍵");
    for (const id of ["L1", "L2", "R1", "T1", "T2", "S1", "K1", "C1", "C2"]) assert.ok(k[id], `${id} 有鍵`);
    // 照舊順序：position → created_at → id
    assert.ok(k.L2! < k.L1!, "幹線：L2(0) 在 L1(1) 前");
    assert.ok(k.T2! < k.K1! && k.K1! < k.T1!, "路線最上層：T2(2) → K1(3) → T1(5)，列車與臨時票同一串");
    assert.ok(k.C1! < k.C2!, "同 position 照 created_at");
    assert.deepEqual(A.raw.prepare("SELECT id, updated_at FROM nodes ORDER BY id").all(), stampsBefore, "不戳 updated_at");
    const ops = nodeOps(A, 0);
    assert.ok(ops.length === 9 && ops.every((o) => JSON.stringify(Object.keys(o.cols)) === '["sort_key"]'), "每列一筆、只帶 sort_key");
    // 冪等：再開一個實例（＝下次啟動）不寫
    setDb(A);
    const n0 = A.batches.length;
    await new SqliteNodeRepository().listSidebar();
    assert.equal(A.batches.length, n0, "已補齊＝零寫入");
    // 兩台各自回填的 op 互相套用：值相同，畫面一樣
    const mark = { a: 0, b: 0 };
    exchange(A, B, mark);
    assert.deepEqual(keysOf(A), keysOf(B));
  });

  test("⑤′回填接在既有鍵後面：舊版那台新建的列（沒鍵）補在該清單最後", async () => {
    const t = await twoDevices(["a", "b"]);
    // 模擬舊版推來一張沒鍵的列車（position 很小也一樣排最後：沒鍵的排在有鍵的後面）
    t.B.raw
      .prepare(`INSERT INTO nodes (id, kind, parent_id, name, position, created_at, updated_at) VALUES ('old', 'train', $1, 'old', 0, $2, $2)`)
      .run(bind([t.route.id, "2026-11-01T00:00:00.000Z"]));
    t.ids.old = "old";
    assert.deepEqual(await t.order(t.B), ["a", "b", "old"], "回填之前就排最後");
    setDb(t.B);
    await new SqliteNodeRepository().listSidebar();
    const row = t.B.raw.prepare("SELECT sort_key FROM nodes WHERE id = 'old'").get() as { sort_key: string };
    const b = t.B.raw.prepare("SELECT sort_key FROM nodes WHERE id = $1").get(bind([t.ids.b])) as { sort_key: string };
    assert.ok(row.sort_key > b.sort_key, "補的鍵接在 b 之後");
    assert.deepEqual(await t.order(t.B), ["a", "b", "old"]);
  });
});

/* ───────── 純函式 ───────── */

describe("nodeOrder／nodeSortKey 純函式", () => {
  test("compareSiblings：有鍵在前（位元組序，大寫在小寫前）、沒鍵在後照 position→created_at→id", () => {
    const r = (id: string, sort_key: string | null, position = 0, created_at = "2026-01-01T00:00:00.000Z") => ({ id, sort_key, position, created_at });
    const sorted = [r("n2", null, 1), r("k2", "a0"), r("n1", null, 0), r("k1", "Zz"), r("k3", "a0V")].sort(compareSiblings).map((x) => x.id);
    assert.deepEqual(sorted, ["k1", "k2", "k3", "n1", "n2"]);
  });

  test("groupFor／inGroup：路線最上層含根層掛標籤的車票、不含車站；收件匣另一組", () => {
    const g = groupFor({ parentId: "R", parentKind: "route", kind: "train", routeId: null });
    assert.deepEqual(g, { type: "routeTop", routeId: "R" });
    assert.ok(inGroup({ parent_id: null, kind: "ticket", route_id: "R" }, g));
    assert.ok(!inGroup({ parent_id: "R", kind: "station", route_id: "R" }, g));
    assert.deepEqual(groupFor({ parentId: null, parentKind: null, kind: "ticket", routeId: null }), { type: "inbox" });
    assert.deepEqual(groupFor({ parentId: "R", parentKind: "route", kind: "station", routeId: "R" }), { type: "stations", routeId: "R" });
  });

  test("slotFromAnchor：先認 after、再認 before；都不在＝after 是 null 就最上面、否則最後", () => {
    const rest = ["a", "b", "c"];
    assert.equal(slotFromAnchor(rest, { after: "a", before: "b" }), 1);
    assert.equal(slotFromAnchor(rest, { after: "gone", before: "c" }), 2);
    assert.equal(slotFromAnchor(rest, { after: null, before: "gone" }), 0);
    assert.equal(slotFromAnchor(rest, { after: "gone", before: null }), 3);
  });

  test("planSortKeyBackfill：同一份輸入（順序打亂）算出同一組鍵", () => {
    const rows = [
      { id: "a", kind: "line", parent_id: null, route_id: null, sort_key: null, position: 1, created_at: "1" },
      { id: "b", kind: "line", parent_id: null, route_id: null, sort_key: "a0", position: 0, created_at: "2" },
      { id: "c", kind: "line", parent_id: null, route_id: null, sort_key: null, position: 0, created_at: "3" },
    ];
    const kind = (id: string) => rows.find((r) => r.id === id)?.kind ?? null;
    const w1 = planSortKeyBackfill(rows, kind);
    const w2 = planSortKeyBackfill([...rows].reverse(), kind);
    assert.deepEqual(w1, w2);
    assert.deepEqual(w1.map((w) => w.id), ["c", "a"], "沒鍵的照 position 接在 b（a0）後面");
    assert.ok(w1.every((w) => w.key > "a0"));
  });
});
