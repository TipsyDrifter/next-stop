/**
 * 失物招領的 repository：SQLite 版與記憶體版跑同一套能跑的；真的既有 repo（節點、筆記、荷札、時刻表、售票口、週方針）接上去跑。
 * 跑法：`node --test scripts/tests/lost-found-sqlite.test.ts`（node 24）。
 *
 * SQLite：node:sqlite 記憶體庫＋全部 migrations，外鍵開著（驗寫入順序父先子後）；`../lib/db`、`./syncRepository`、`./index` 換替身，
 * op 收進 `db.ops` 驗「送了哪些欄」。同步欄與必填欄直接讀 `src-tauri/src/sync/tables/*.rs`，不再抄一份。
 */
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const FAKE_DB = `
let t = Date.now();
export function getDb() { return Promise.resolve(globalThis.__lfDb); }
export function uuid() { return crypto.randomUUID(); }
export function nowUtcIso() { t += 1000; return new Date(t).toISOString(); }
`;
const FAKE_SYNC = `
export function newWriteBatch() { return { stmts: [], ops: [] }; }
export async function runWriteBatch(db, stmts, ops) { db.runBatch(stmts, ops); }
export async function occurrenceId(n, d) { return n + "|" + d; }
export async function ensureSyncTables() { return false; }
`;
const FAKE_INDEX = `
const kv = new Map();
export const MOCK_MODE = false;
export const WIPED_MODE = false;
export const nodeRepo = new Proxy({}, { get: (_, k) => { const r = globalThis.__lfNodes; const v = r[k]; return typeof v === "function" ? v.bind(r) : v; } });
export const settingsRepo = { get: async (k) => kv.get(k) ?? null, set: async (k, v) => void kv.set(k, v) };
`;
const dataUrl = (src: string) => "data:text/javascript," + encodeURIComponent(src);
registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = context.parentURL;
    if (parent !== undefined && parent.includes("/src/")) {
      if (specifier === "../lib/db") return { url: dataUrl(FAKE_DB), shortCircuit: true };
      if (specifier === "./syncRepository") return { url: dataUrl(FAKE_SYNC), shortCircuit: true };
      if (specifier === "./index" && parent.includes("/src/data/")) return { url: dataUrl(FAKE_INDEX), shortCircuit: true };
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

type Op = { tbl: string; row_id: string; op: string; cols: Record<string, unknown> };
type Row = Record<string, unknown> & { id: string };

function makeDb() {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = OFF");
  const dir = path.join(ROOT, "src-tauri/migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) raw.exec(readFileSync(path.join(dir, f), "utf8"));
  raw.exec("PRAGMA foreign_keys = ON");
  assert.equal((raw.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys, 1, "外鍵要開著才驗得到寫入順序");
  const bind = (args: unknown[] = []) => Object.fromEntries(args.map((v, i) => ["$" + (i + 1), v])) as Record<string, never>;
  const ops: Op[] = [];
  return {
    raw,
    ops,
    /** 開過幾個非空交易（驗「併成一批」） */
    batchCount: 0,
    async select(sql: string, args?: unknown[]) {
      return raw.prepare(sql).all(bind(args)).map((r) => ({ ...r }));
    },
    async execute(sql: string, args?: unknown[]) {
      raw.prepare(sql).run(bind(args));
      return { rowsAffected: 0 };
    },
    runBatch(stmts: { sql: string; args: unknown[] }[], batchOps: Op[]) {
      if (stmts.length) this.batchCount++;
      raw.exec("BEGIN");
      try {
        for (const st of stmts) raw.prepare(st.sql).run(bind(st.args));
        raw.exec("COMMIT");
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      }
      ops.push(...batchOps);
    },
  };
}

/** 從 Rust 登記表讀同步欄與必填欄（同 probe:registry 靠的寫法慣例） */
function rustRegistry(): { columns: Record<string, string[]>; required: Record<string, string[]> } {
  const columns: Record<string, string[]> = {};
  const required: Record<string, string[]> = {};
  const dir = path.join(ROOT, "src-tauri/src/sync/tables");
  for (const f of ["core.rs", "notes.rs", "timetable.rs", "ticket.rs"]) {
    const src = readFileSync(path.join(dir, f), "utf8");
    const consts = new Map<string, string[]>();
    for (const m of src.matchAll(/const (\w+_COLS): &\[\(&str, bool\)\] = &\[([\s\S]*?)\];/g)) {
      consts.set(m[1], [...m[2].matchAll(/\("(\w+)",\s*(?:true|false)\)/g)].map((x) => x[1]));
    }
    for (const m of src.matchAll(/^\s*name: "(\w+)",[\s\S]*?columns: (\w+),[\s\S]*?required: &\[([^\]]*)\]/gm)) {
      columns[m[1]] = consts.get(m[2]) ?? [];
      required[m[1]] = [...m[3].matchAll(/"(\w+)"/g)].map((x) => x[1]);
    }
  }
  return { columns, required };
}
const REG = rustRegistry();
for (const t of ["nodes", "work_logs", "occurrences", "node_time_overrides", "notes", "tags", "taggings", "time_blocks", "time_categories", "tk_entries", "tk_accounts", "tk_categories", "tk_currencies", "tk_budgets", "tk_repeats", "tk_wishes", "tk_templates", "week_aims"]) {
  assert.ok(REG.columns[t]?.length && REG.required[t], `Rust 登記表讀不到 ${t}`);
}

const { SqliteLostFoundRepository } = await import("../../src/data/lostFoundRepository.ts");
const { MemoryLostFoundRepository } = await import("../../src/data/memoryLostFoundRepository.ts");
const { SqliteNodeRepository } = await import("../../src/data/sqliteNodeRepository.ts");
const { SqliteNoteRepository } = await import("../../src/data/sqliteNoteRepository.ts");
const { SqliteTagRepository } = await import("../../src/data/sqliteTagRepository.ts");
const { SqliteTicketRepository } = await import("../../src/data/sqliteTicketRepository.ts");
const { SqliteTimetableRepository } = await import("../../src/data/sqliteTimetableRepository.ts");
const { SqliteWeekAimRepository } = await import("../../src/data/sqliteWeekAimRepository.ts");
const { tagId } = await import("../../src/data/tagRepository.ts");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { materializeId, pickUpRepeatCols, skippedEntryIds } = (await import("../../src/domain/ticketPlan.ts")) as any;
const { todayKey } = await import("../../src/lib/date.ts");

const NOW = Date.now();
const ago = (days: number, ms = 0) => new Date(NOW - days * 86_400_000 - ms).toISOString();
const T1 = ago(1);
const T2 = ago(2);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** 兩個實作共用的操作面：放列、讀列、repo */
interface Harness {
  name: string;
  repo: Any;
  put(table: string, row: Row): void;
  read(table: string, id: string): Promise<Row | undefined>;
  db?: ReturnType<typeof makeDb>;
}

function sqliteHarness(): Harness {
  const db = makeDb();
  const g = globalThis as Record<string, unknown>;
  g.__lfDb = db;
  const nodes = new SqliteNodeRepository();
  g.__lfNodes = nodes;
  const tags = new SqliteTagRepository();
  const repo = new SqliteLostFoundRepository({
    nodes,
    notes: new SqliteNoteRepository(),
    tags,
    timetable: new SqliteTimetableRepository({ tagRepo: tags }),
    ticket: new SqliteTicketRepository(),
    aims: new SqliteWeekAimRepository(),
    readSnapshot: async () => {
      throw new Error("測試不走這支");
    },
  });
  return {
    name: "sqlite",
    repo,
    db,
    put(table, row) {
      const names = Object.keys(row);
      db.raw.prepare(`INSERT INTO ${table} (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`).run(...(names.map((n) => row[n]) as never[]));
    },
    async read(table, id) {
      return (await db.select(`SELECT * FROM ${table} WHERE id = $1`, [id]))[0] as Row | undefined;
    },
  };
}
function memoryHarness(): Harness {
  const repo = new MemoryLostFoundRepository({ seed: false });
  return {
    name: "memory",
    repo,
    put: (t, r) => repo.put(t, r),
    read: async (t, id) => repo.get(t, id),
  };
}

const node = (id: string, kind: string, parent: string | null, deleted: string | null, extra: Partial<Row> = {}): Row => ({
  id,
  kind,
  parent_id: parent,
  line_id: null,
  route_id: null,
  name: id,
  deleted_at: deleted,
  ...extra,
});
const note = (id: string, body: string, deleted: string | null, extra: Partial<Row> = {}): Row => ({
  id,
  kind: "note",
  body,
  noted_at: ago(9),
  deleted_at: deleted,
  ...extra,
});

/** 一條活著的幹線＋路線 */
function seedTree(h: Harness): void {
  h.put("nodes", node("l", "line", null, null));
  h.put("nodes", node("r", "route", "l", null, { line_id: "l", name: "日文" }));
}

for (const make of [sqliteHarness, memoryHarness]) {
  const kindName = make === sqliteHarness ? "sqlite" : "memory";
  describe(`${kindName}：最近刪除`, () => {
    let h: Harness;
    beforeEach(() => {
      h = make();
      seedTree(h);
    });
    const ids = async () => (await h.repo.list(NOW)).map((x: Any) => x.id);

    test("同一刀一列、先後兩刀兩列、父活子死自成一列；帶路線名", async () => {
      const inRoute = { line_id: "l", route_id: "r" };
      h.put("nodes", node("t", "train", "r", T1, inRoute));
      h.put("nodes", node("k1", "ticket", "t", T1, inRoute));
      h.put("nodes", node("k2", "ticket", "t", T2, inRoute)); // 先被單獨刪
      h.put("nodes", node("t2", "train", "r", null, inRoute));
      h.put("nodes", node("k3", "ticket", "t2", ago(3), inRoute)); // 父活子死
      const items = await h.repo.list(NOW);
      assert.deepEqual(items.map((x: Any) => x.id), ["t", "k2", "k3"]);
      assert.equal(items[0].childCount, 1);
      assert.deepEqual(items[0].ids, ["t", "k1"]);
      assert.equal(items[0].detail, "日文");
      assert.equal(items[2].childCount, 0);
    });

    test("批次刪除各成一列；窗外不列；改名的荷札不列", async () => {
      h.put("notes", note("n1", "一", ago(1, 1)));
      h.put("notes", note("n2", "二", ago(1, 2)));
      h.put("notes", note("old", "太舊", ago(31)));
      h.put("tags", { id: "tg", name: "改名", name_key: "改名", renamed_to: "x", deleted_at: T1 });
      assert.deepEqual(await ids(), ["n1", "n2"]);
    });

    test("撿回後從清單消失；一刀的子樹都回來；更早先刪的那張不回來", async () => {
      const inRoute = { line_id: "l", route_id: "r" };
      h.put("nodes", node("t", "train", "r", T1, inRoute));
      h.put("nodes", node("k1", "ticket", "t", T1, inRoute));
      h.put("nodes", node("k2", "ticket", "t", T2, inRoute));
      const [first] = await h.repo.list(NOW);
      assert.deepEqual(await h.repo.restore(first), {});
      assert.deepEqual(await ids(), ["k2"]);
      assert.equal((await h.read("nodes", "k1"))?.deleted_at, null);
      assert.equal((await h.read("nodes", "k2"))?.deleted_at, T2);
    });

    test("車票上層不在：放到臨時車票，原路線活著掛標籤", async () => {
      const inRoute = { line_id: "l", route_id: "r" };
      h.put("nodes", node("t", "train", "r", T2, inRoute));
      h.put("nodes", node("k", "ticket", "t", T1, inRoute));
      const item = (await h.repo.list(NOW)).find((x: Any) => x.id === "k");
      assert.deepEqual(await h.repo.restore(item), { placedAsLoose: true });
      const row = await h.read("nodes", "k");
      assert.equal(row?.deleted_at, null);
      assert.equal(row?.parent_id, null);
      assert.equal(row?.route_id, "r");
      assert.equal((await h.read("nodes", "t"))?.deleted_at, T2, "上層不回來");
    });

    test("車票的路線也死了：放臨時車票、不掛標籤", async () => {
      h.put("nodes", node("r2", "route", "l", T2, { line_id: "l" }));
      h.put("nodes", node("t", "train", "r2", T2, { line_id: "l", route_id: "r2" }));
      h.put("nodes", node("k", "ticket", "t", T1, { line_id: "l", route_id: "r2" }));
      const item = (await h.repo.list(NOW)).find((x: Any) => x.id === "k");
      assert.deepEqual(await h.repo.restore(item), { placedAsLoose: true });
      assert.equal((await h.read("nodes", "k"))?.route_id, null);
    });

    test("非車票上層不在：回 needsParent、沒寫；withParent 連上層那一刀", async () => {
      const inRoute = { line_id: "l", route_id: "r" };
      h.put("nodes", node("t", "train", "r", T1, inRoute));
      h.put("nodes", node("k", "ticket", "t", T1, inRoute));
      h.put("nodes", node("c", "car", "t", T2, inRoute));
      const item = (await h.repo.list(NOW)).find((x: Any) => x.id === "c");
      const res = await h.repo.restore(item);
      assert.deepEqual(res, { needsParent: { id: "t", name: "t", kind: "train" } });
      assert.equal((await h.read("nodes", "c"))?.deleted_at, T2, "沒同意就沒寫");
      assert.deepEqual(await h.repo.restore(item, { withParent: true }), {});
      for (const id of ["c", "t", "k"]) assert.equal((await h.read("nodes", id))?.deleted_at, null, id);
      assert.deepEqual(await ids(), []);
    });

    test("帳目撿回：skipped_days 減回", async () => {
      const day = "2026-10-01";
      const eid = materializeId("rp", day);
      h.put("tk_currencies", { id: "cur", code: "TWD", name: "新台幣", decimals: 0, rate_to_main: "1", is_main: 1 });
      h.put("tk_accounts", { id: "acc", name: "現金", currency: "TWD" });
      h.put("tk_repeats", { id: "rp", kind: "expense", account_id: "acc", amount_minor: 100, currency: "TWD", rule: JSON.stringify({ mode: "fixed", freq: "monthly", start: day }), skipped_days: JSON.stringify([day, "2026-09-01"]) });
      h.put("tk_entries", { id: eid, kind: "expense", occurred_on: day, occurred_at: ago(2), account_id: "acc", amount_minor: 100, currency: "TWD", main_minor: 100, account_minor: 100, repeat_id: "rp", deleted_at: T1 });
      const item = (await h.repo.list(NOW)).find((x: Any) => x.id === eid);
      assert.equal(item.kind, "tk_entry");
      await h.repo.restore(item);
      assert.equal((await h.read("tk_entries", eid))?.deleted_at, null);
      assert.deepEqual(JSON.parse(String((await h.read("tk_repeats", "rp"))?.skipped_days)), ["2026-09-01"]);
    });

    test("預算：一刀（預設＋月覆寫）撿回；別刀不動", async () => {
      h.put("tk_budgets", { id: "bd", kind: "total", month: null, amount_minor: 500, deleted_at: T1 });
      h.put("tk_budgets", { id: "bm", kind: "total", month: "2026-11", amount_minor: 900, deleted_at: T1 });
      h.put("tk_budgets", { id: "bo", kind: "total", month: "2026-10", amount_minor: 700, deleted_at: T2 });
      const items = await h.repo.list(NOW);
      assert.equal(items.length, 2);
      assert.equal(items[0].id, "bd");
      await h.repo.restore(items[0]);
      assert.equal((await h.read("tk_budgets", "bd"))?.deleted_at, null);
      assert.equal((await h.read("tk_budgets", "bm"))?.deleted_at, null);
      assert.equal((await h.read("tk_budgets", "bo"))?.deleted_at, T2);
    });

    test("荷札撿回：荷札與同一刀的掛載回來，筆記內文沒有就補在最後一行，有的不重補；更早摘的不帶", async () => {
      h.put("tags", { id: "tg", name: "旅行", name_key: "旅行", renamed_to: null, deleted_at: T1 });
      h.put("tags", { id: "tg2", name: "旅行/日本", name_key: "旅行/日本", renamed_to: null, deleted_at: T1 });
      h.put("notes", note("n1", "東京", null));
      h.put("notes", note("n2", "早就寫回 #旅行 了", null));
      h.put("taggings", { id: "g1", entity_type: "note", entity_id: "n1", tag_id: "tg", deleted_at: T1 });
      h.put("taggings", { id: "g1b", entity_type: "note", entity_id: "n1", tag_id: "tg2", deleted_at: T1 });
      h.put("taggings", { id: "g2", entity_type: "note", entity_id: "n2", tag_id: "tg", deleted_at: T1 });
      h.put("taggings", { id: "g3", entity_type: "note", entity_id: "n2", tag_id: "tg2", deleted_at: T2 });
      const [item] = await h.repo.list(NOW);
      assert.equal(item.title, "#旅行");
      assert.deepEqual(item.ids.slice().sort(), ["tg", "tg2"]);
      await h.repo.restore(item);
      assert.equal((await h.read("tags", "tg"))?.deleted_at, null);
      assert.equal((await h.read("tags", "tg2"))?.deleted_at, null);
      assert.equal((await h.read("taggings", "g1"))?.deleted_at, null);
      assert.equal((await h.read("taggings", "g3"))?.deleted_at, T2, "更早摘的不是這一刀");
      assert.equal((await h.read("notes", "n1"))?.body, "東京\n#旅行\n#旅行/日本");
      assert.equal((await h.read("notes", "n2"))?.body, "早就寫回 #旅行 了", "n2 這一刀只有 #旅行，內文本來就有");
    });

    test("週方針撿回；week_on 是期間鍵也照顯示", async () => {
      h.put("week_aims", { id: "a1", week_on: "2026-11-02", text: "讀完", deleted_at: T1 });
      h.put("week_aims", { id: "a2", week_on: "M2026-11", text: "月方針", deleted_at: T2 });
      const items = await h.repo.list(NOW);
      assert.equal(items[0].detail, "11/2 那週");
      assert.equal(items[1].detail, "2026 年 11 月");
      await h.repo.restore(items[0]);
      assert.equal((await h.read("week_aims", "a1"))?.deleted_at, null);
    });

    test("時間目標、作息範本、願望、常用票種、定期帳、日記：撿回都消失", async () => {
      h.put("tk_currencies", { id: "cur", code: "TWD", name: "新台幣", decimals: 0, rate_to_main: "1", is_main: 1 });
      h.put("tk_accounts", { id: "acc", name: "現金", currency: "TWD" });
      h.put("time_goals", { id: "g", name: "目標", scope: "{}", period: "week", target_min: 60, direction: "atLeast", deleted_at: ago(1, 1) });
      h.put("time_routines", { id: "ro", name: "範本", deleted_at: ago(1, 2) });
      h.put("tk_wishes", { id: "w", name: "耳機", deleted_at: ago(1, 3) });
      h.put("tk_templates", { id: "tp", name: "午餐", kind: "expense", deleted_at: ago(1, 4) });
      h.put("tk_repeats", { id: "rp", kind: "expense", account_id: "acc", amount_minor: 1, currency: "TWD", rule: "{}", deleted_at: ago(1, 5) });
      h.put("notes", note("d", "日記", ago(1, 6), { kind: "diary", entry_date: "2026-11-01" }));
      for (const item of await h.repo.list(NOW)) await h.repo.restore(item);
      assert.deepEqual(await ids(), []);
    });
  });

  describe(`${kindName}：內容不同（§3.5）`, () => {
    let h: Harness;
    beforeEach(() => {
      h = make();
    });
    const snapshotOf = (tables: Record<string, Row[]>) => ({ exported_at: ago(5), schema: 18, tables, columns: REG.columns });

    test("比對只看比對欄；改回＋復原：筆記與車票", async () => {
      h.put("nodes", node("k", "ticket", null, null, { name: "新名", description: "同", position: 7 }));
      h.put("nodes", node("k2", "ticket", null, null, { name: "只動順序", description: null, position: 7 }));
      h.put("notes", note("n", "現在的內文", null));
      h.put("notes", note("dead", "已刪", T1));
      const snap = snapshotOf({
        nodes: [node("k", "ticket", null, null, { name: "舊名", description: "同", position: 1 }), node("k2", "ticket", null, null, { name: "只動順序", description: null, position: 1 })],
        notes: [note("n", "舊內文", null), note("dead", "舊", null)],
      });
      const { changed, missing } = await h.repo.diffSnapshot(snap);
      assert.deepEqual(changed.map((x: Any) => x.id).sort(), ["k", "n"]);
      assert.deepEqual(missing.map((x: Any) => x.id), ["dead"]);

      const k = changed.find((x: Any) => x.id === "k");
      const r1 = await h.repo.revertToSnapshot(k);
      assert.deepEqual(r1.before, { name: "新名" });
      assert.deepEqual(r1.after, { name: "舊名" });
      assert.equal((await h.read("nodes", "k"))?.name, "舊名");
      await h.repo.undoRevert(r1);
      assert.equal((await h.read("nodes", "k"))?.name, "新名");

      const n = changed.find((x: Any) => x.id === "n");
      const r2 = await h.repo.revertToSnapshot(n);
      assert.equal((await h.read("notes", "n"))?.body, "舊內文");
      await h.repo.undoRevert(r2);
      assert.equal((await h.read("notes", "n"))?.body, "現在的內文");
    });

    test("這一筆剛被刪：改回擋下、不寫", async () => {
      h.put("notes", note("n", "現在", T1));
      await assert.rejects(() => h.repo.revertToSnapshot({ table: "notes", id: "n", fields: [{ col: "body", label: "內文", snapshot: "舊", current: "現在" }] }), /已經刪除/);
      assert.equal((await h.read("notes", "n"))?.body, "現在");
    });
  });
}

describe("sqlite：改回只送比對欄、荷札跟上", () => {
  const snapshotOf = (tables: Record<string, Row[]>) => ({ exported_at: ago(5), schema: 18, tables, columns: REG.columns });

  test("車票：op 只有不同的欄＋updated_at；筆記：op 只有內文＋updated_at", async () => {
    const h = sqliteHarness();
    h.put("nodes", node("k", "ticket", null, null, { name: "同", description: "新概要", position: 3, status: "doing" }));
    h.put("notes", note("n", "新", null));
    const { changed } = await h.repo.diffSnapshot(
      snapshotOf({ nodes: [node("k", "ticket", null, null, { name: "同", description: "舊概要", position: 1, status: "todo" })], notes: [note("n", "舊", null)] }),
    );
    const db = h.db!;
    const r = await h.repo.revertToSnapshot(changed.find((x: Any) => x.id === "k"));
    assert.deepEqual(Object.keys(db.ops[0].cols).sort(), ["description", "updated_at"]);
    assert.equal(db.ops[0].cols.description, "舊概要");
    assert.equal(db.ops[0].op, "upsert");
    const row = await h.read("nodes", "k");
    assert.equal(row?.position, 3, "順序不動");
    assert.equal(row?.status, "doing", "狀態不動");
    db.ops.length = 0;
    await h.repo.undoRevert(r);
    assert.deepEqual(Object.keys(db.ops[0].cols).sort(), ["description", "updated_at"]);
    assert.equal(db.ops[0].cols.description, "新概要", "復原寫回舊值");
    db.ops.length = 0;
    await h.repo.revertToSnapshot(changed.find((x: Any) => x.id === "n"));
    assert.deepEqual(Object.keys(db.ops[0].cols).sort(), ["body", "updated_at"]);
  });

  test("筆記內文的 #字：taggings 跟上（改回掛舊字、摘新字；復原反過來）", async () => {
    const h = sqliteHarness();
    const tags = new SqliteTagRepository();
    h.put("notes", note("n", "現在 #新字", null));
    await tags.syncBodyTags("n", "現在 #新字");
    const { changed } = await h.repo.diffSnapshot(snapshotOf({ notes: [note("n", "以前 #舊字", null)] }));
    const r = await h.repo.revertToSnapshot(changed[0]);
    const keys = async () => (await tags.listTagsOf("note", "n")).map((t: Any) => t.name_key).sort();
    assert.deepEqual(await keys(), ["舊字"]);
    await h.repo.undoRevert(r);
    assert.deepEqual(await keys(), ["新字"]);
  });
});

describe("sqlite：荷札走真的刪除路徑", () => {
  test("remove 之後撿回：內文補回、掛載回來，下一次存檔不被摘掉", async () => {
    const h = sqliteHarness();
    const tags = new SqliteTagRepository();
    h.put("notes", note("n", "去東京 #旅行", null));
    await tags.syncBodyTags("n", "去東京 #旅行");
    const id = await tagId("旅行");
    await tags.remove({ ok: true, key: "旅行", name: "旅行", keys: ["旅行"], places: 1, affected: {}, kidsWithItems: 0, bodyCount: 1, childCount: 0 } as Any);
    assert.equal((await h.read("notes", "n"))?.body?.toString().includes("#旅行"), false, "刪除時內文的字已被拿掉");
    assert.deepEqual(await tags.listTagsOf("note", "n"), []);

    const [item] = await h.repo.list(Date.now() + 60_000);
    assert.equal(item.id, id);
    await h.repo.restore(item);
    const body = String((await h.read("notes", "n"))?.body);
    assert.match(body, /\n#旅行$/);
    assert.deepEqual((await tags.listTagsOf("note", "n")).map((t: Any) => t.name_key), ["旅行"]);
    assert.deepEqual((await tags.syncBodyTags("n", body)).removed, [], "下一次存檔不被摘掉");
  });
});

describe("sqlite：rescue（§3.3）", () => {
  const OLD = ago(20);
  const stamp = { created_at: OLD, updated_at: OLD };
  const snapshotOf = (tables: Record<string, Row[]>) => ({ exported_at: ago(5), schema: 18, tables, columns: REG.columns });
  const inRoute = { line_id: "l", route_id: "r", ...stamp };
  const fullNode = (id: string, kind: string, parent: string | null, extra: Partial<Row> = {}): Row => ({
    ...node(id, kind, parent, null, stamp),
    description: "概要",
    position: 2,
    status: "todo",
    priority: "mid",
    scheduled_on: null,
    sort_key: "a1",
    account_id: null,
    device_id: "dev",
    synced_at: null,
    ...extra,
  });

  /** op 帶齊 Rust 的必填欄，而且只帶同步欄 */
  function assertFullOp(op: Op): void {
    const allowed = new Set(REG.columns[op.tbl]);
    for (const c of Object.keys(op.cols)) assert.ok(allowed.has(c), `${op.tbl}.${c} 不是同步欄`);
    for (const c of REG.required[op.tbl]) assert.ok(c in op.cols && op.cols[c] !== null, `${op.tbl} 缺必填欄 ${c}`);
  }

  test("路線子樹：對面沒有這一列也收得到；conflict log 不帶；活著的子節點不動；快取欄不進 op", async () => {
    const h = sqliteHarness();
    const db = h.db!;
    h.put("nodes", node("l", "line", null, null));
    h.put("nodes", node("r", "route", "l", T1, { line_id: "l" })); // 現在已刪
    h.put("nodes", node("t", "train", "r", T1, { line_id: "l", route_id: "r", name: "被改過的名字" }));
    h.put("nodes", node("alive", "ticket", "t", null, { line_id: "l", route_id: "r", name: "活著改過名" }));
    const before = await h.read("nodes", "alive");

    const snap = snapshotOf({
      nodes: [
        fullNode("r", "route", "l", { line_id: "l", name: "日文" }),
        fullNode("t", "train", "r", inRoute),
        fullNode("k", "ticket", "t", { ...inRoute, name: "不見的票" }),
        fullNode("alive", "ticket", "t", { ...inRoute, name: "快照時的名字" }),
      ],
      work_logs: [
        { id: "w1", node_id: "k", body: "", logged_at: OLD, event: "issued", ...stamp, deleted_at: null },
        { id: "w2", node_id: "k", body: "{}", logged_at: OLD, event: "conflict", ...stamp, deleted_at: null },
      ],
      occurrences: [{ id: "oc", node_id: "k", due_on: "2026-10-01", status: "done", ...stamp, deleted_at: null }],
      node_time_overrides: [{ id: "ov", node_id: "k", due_on: "2026-10-02", hhmm: "09:00", ...stamp, deleted_at: null }],
      taggings: [{ id: "gg", entity_type: "node", entity_id: "k", tag_id: "tt", ...stamp, deleted_at: null }],
      tags: [{ id: "tt", name: "難", name_key: "難", renamed_to: null, ...stamp, deleted_at: null }],
    });
    const { missing } = await h.repo.diffSnapshot(snap);
    const item = missing.find((x: Any) => x.id === "r");
    assert.equal(item.childCount, 2, "t、k；活著的 alive 不算");
    assert.deepEqual(await h.repo.rescue(snap, item), {});

    assert.equal((await h.read("nodes", "r"))?.name, "r", "本機有 tombstone：內容照本機");
    assert.equal((await h.read("nodes", "r"))?.deleted_at, null);
    assert.equal((await h.read("nodes", "t"))?.name, "被改過的名字", "本機有 tombstone：不用快照蓋");
    const k = await h.read("nodes", "k");
    assert.equal(k?.route_id, "r");
    assert.equal(k?.line_id, "l");
    assert.equal(k?.device_id, "dev");
    assert.deepEqual(await h.read("nodes", "alive"), before, "活著的子節點一個字都不動");
    assert.equal(await h.read("work_logs", "w2"), undefined, "競合日誌不帶");
    assert.equal((await h.read("work_logs", "w1"))?.event, "issued");
    assert.equal((await h.read("occurrences", "k|2026-10-01"))?.status, "done", "決定性 id");
    assert.equal((await h.read("node_time_overrides", "ov"))?.hhmm, "09:00");
    assert.equal((await h.read("taggings", "gg"))?.deleted_at, null);
    assert.equal((await h.read("tags", "tt"))?.deleted_at, null);

    for (const op of db.ops) assertFullOp(op);
    const opOf = (id: string) => db.ops.find((o) => o.row_id === id)!;
    assert.equal(opOf("k").cols.kind, "ticket");
    assert.equal(opOf("k").cols.name, "不見的票");
    assert.equal(opOf("k").cols.deleted_at, null);
    assert.ok(!("line_id" in opOf("k").cols));
    assert.ok(!("route_id" in opOf("k").cols), "非根層票的 route_id 是快取");
    assert.ok(!db.ops.some((o) => o.row_id === "alive" || o.row_id === "w2"));
    assert.equal(opOf("r").cols.name, "r");
    assert.equal(opOf("t").cols.name, "被改過的名字");
    assert.equal(opOf("k").cols.updated_at, (await h.read("nodes", "k"))?.updated_at);
    assert.notEqual(opOf("k").cols.updated_at, OLD, "updated_at＝現在");
  });

  test("車票上層不見：放臨時車票＋路線標籤；op 帶 parent_id、route_id", async () => {
    const h = sqliteHarness();
    seedTree(h);
    const snap = snapshotOf({ nodes: [fullNode("t", "train", "r", inRoute), fullNode("k", "ticket", "t", inRoute)] });
    const { missing } = await h.repo.diffSnapshot(snap);
    assert.deepEqual(await h.repo.rescue(snap, missing.find((x: Any) => x.id === "k")), { placedAsLoose: true });
    const row = await h.read("nodes", "k");
    assert.equal(row?.parent_id, null);
    assert.equal(row?.route_id, "r");
    assert.equal(row?.line_id, "l");
    assert.equal(row?.sort_key, null);
    const op = h.db!.ops[0];
    assert.equal(op.cols.parent_id, null);
    assert.equal(op.cols.route_id, "r");
    assert.ok(!("line_id" in op.cols));
    assertFullOp(op);
  });

  test("非車票上層不見：先問；同意就連上層帶回（外鍵順序過得了）", async () => {
    const h = sqliteHarness();
    h.put("nodes", node("l", "line", null, null));
    const snap = snapshotOf({ nodes: [fullNode("r", "route", "l", { line_id: "l" }), fullNode("t", "train", "r", inRoute), fullNode("c", "car", "t", inRoute)] });
    const res = await h.repo.rescue(snap, { table: "nodes", id: "c" });
    assert.equal(res.needsParent.id, "t");
    assert.equal(await h.read("nodes", "c"), undefined, "沒同意就沒寫");
    assert.equal(h.db!.ops.length, 0);
    assert.deepEqual(await h.repo.rescue(snap, { table: "nodes", id: "c" }, { withParent: true }), {});
    assert.equal((await h.read("nodes", "c"))?.route_id, "r");
    assert.equal((await h.read("nodes", "t"))?.line_id, "l");
  });

  test("帳目：帳戶、分類、幣別一起帶（重新開始之後）；skipped_days 減回；舊快照缺的欄吃預設", async () => {
    const h = sqliteHarness();
    const day = "2026-10-01";
    const eid = materializeId("rp", day);
    h.put("tk_currencies", { id: "twd", code: "TWD", name: "新台幣", decimals: 0, rate_to_main: "1", is_main: 1 });
    h.put("tk_accounts", { id: "acc0", name: "活的", currency: "TWD" });
    h.put("tk_repeats", { id: "rp", kind: "expense", account_id: "acc0", amount_minor: 100, currency: "TWD", rule: JSON.stringify({ mode: "fixed", freq: "monthly", start: day }), skipped_days: JSON.stringify([day]) });
    const snap = snapshotOf({
      tk_entries: [{ id: eid, kind: "expense", occurred_on: day, occurred_at: OLD, account_id: "acc", category_id: "sub", amount_minor: 100, currency: "USD", main_minor: 3000, account_minor: 100, repeat_id: "rp", ...stamp, deleted_at: null }],
      tk_accounts: [{ id: "acc", name: "美金戶", group_key: "bank", currency: "USD", position: 0, ...stamp, deleted_at: null }],
      tk_categories: [
        { id: "main", kind: "expense", name: "餐飲", parent_id: null, position: 0, ...stamp, deleted_at: null },
        { id: "sub", kind: "expense", name: "午餐", parent_id: "main", position: 0, ...stamp, deleted_at: null },
      ],
      tk_currencies: [{ id: "usd", code: "USD", name: "美元", decimals: 2, rate_to_main: "30", is_main: 0, position: 1, ...stamp, deleted_at: null }],
    });
    const { missing } = await h.repo.diffSnapshot(snap);
    await h.repo.rescue(snap, missing.find((x: Any) => x.id === eid));
    assert.equal((await h.read("tk_entries", eid))?.deleted_at, null);
    assert.equal((await h.read("tk_entries", eid))?.note, "", "舊快照沒有 note：吃表預設");
    assert.equal((await h.read("tk_accounts", "acc"))?.name, "美金戶");
    assert.equal((await h.read("tk_categories", "sub"))?.parent_id, "main");
    assert.equal((await h.read("tk_currencies", "usd"))?.code, "USD");
    assert.deepEqual(JSON.parse(String((await h.read("tk_repeats", "rp"))?.skipped_days)), []);
    for (const op of h.db!.ops) if (op.tbl !== "tk_repeats") assertFullOp(op);
    const order = h.db!.ops.map((o) => o.row_id);
    assert.ok(order.indexOf("acc") < order.indexOf(eid) && order.indexOf("main") < order.indexOf("sub") && order.indexOf("sub") < order.indexOf(eid));
  });

  test("時間塊：跑 planCover，蓋到現在的塊就切；還在運行的結束在快照那一刻", async () => {
    const h = sqliteHarness();
    h.put("time_categories", { id: "cat", name: "讀", ...stamp });
    const t0 = Date.parse(ago(6));
    const iso = (min: number) => new Date(t0 + min * 60_000).toISOString();
    h.put("time_blocks", { id: "now", category_id: "cat", started_at: iso(30), ended_at: iso(90), ...stamp });
    const snap = snapshotOf({
      time_blocks: [{ id: "b", category_id: "cat", started_at: iso(0), ended_at: iso(60), long_run_ack: 0, ...stamp, deleted_at: null }],
      time_categories: [{ id: "cat", name: "讀", ...stamp, deleted_at: null }],
    });
    const { missing } = await h.repo.diffSnapshot(snap);
    const item = missing.find((x: Any) => x.id === "b");
    const preview = await h.repo.previewCover(item, snap);
    assert.equal(preview.shortened + preview.removed + preview.splitCount > 0, true, "先講會蓋到");
    const res = await h.repo.rescue(snap, item);
    assert.ok(res.cover);
    assert.equal((await h.read("time_blocks", "b"))?.deleted_at, null);
    assert.equal((await h.read("time_blocks", "now"))?.started_at, iso(60), "後來的塊被切短");

    const h2 = sqliteHarness();
    h2.put("time_categories", { id: "cat", name: "讀", ...stamp });
    const running = snapshotOf({ time_blocks: [{ id: "run", category_id: "cat", started_at: ago(6), ended_at: null, ...stamp, deleted_at: null }], time_categories: [] });
    await h2.repo.rescue(running, { table: "time_blocks", id: "run" });
    assert.equal((await h2.read("time_blocks", "run"))?.ended_at, running.exported_at);
    assert.equal((await h2.read("time_blocks", "run"))?.deleted_at, null);
  });

  test("荷札本身：掛載回來、活著的筆記內文補回", async () => {
    const h = sqliteHarness();
    const id = await tagId("旅行");
    h.put("notes", note("n", "東京", null));
    const snap = snapshotOf({
      tags: [{ id, name: "旅行", name_key: "旅行", renamed_to: null, ...stamp, deleted_at: null }],
      taggings: [{ id: "g", entity_type: "note", entity_id: "n", tag_id: id, ...stamp, deleted_at: null }],
    });
    await h.repo.rescue(snap, { table: "tags", id });
    assert.equal((await h.read("notes", "n"))?.body, "東京\n#旅行");
    assert.equal((await h.read("taggings", "g"))?.deleted_at, null);
    assert.deepEqual(Object.keys(h.db!.ops.find((o) => o.tbl === "notes")!.cols).sort(), ["body", "updated_at"]);
  });

  test("大路線切批：超過參數上限照樣寫完，父先子後", async () => {
    const h = sqliteHarness();
    h.put("nodes", node("l", "line", null, null));
    const kids = Array.from({ length: 800 }, (_, i) => fullNode(`k${i}`, "ticket", "t", inRoute));
    const snap = snapshotOf({ nodes: [fullNode("r", "route", "l", { line_id: "l" }), fullNode("t", "train", "r", inRoute), ...kids] });
    await h.repo.rescue(snap, { table: "nodes", id: "r" });
    assert.equal((await h.db!.select(`SELECT COUNT(*) AS n FROM nodes WHERE deleted_at IS NULL`, []))[0].n, 803);
  });
});

describe("sqlite：既有 repo 補的那幾支", () => {
  test("removeBudget 回 id、restoreBudget 收回；op 只有 deleted_at、updated_at", async () => {
    const h = sqliteHarness();
    const ticket = new SqliteTicketRepository();
    await ticket.setBudget({ kind: "total" }, null, 500);
    await ticket.setBudget({ kind: "total" }, "2026-11", 900);
    const ids = await ticket.removeBudget({ kind: "total" }, null);
    assert.equal(ids.length, 2);
    assert.equal((await ticket.listBudgets()).length, 0);
    h.db!.ops.length = 0;
    await ticket.restoreBudget(ids);
    assert.equal((await ticket.listBudgets()).length, 2);
    assert.equal(h.db!.ops.length, 2);
    assert.deepEqual(Object.keys(h.db!.ops[0].cols).sort(), ["deleted_at", "updated_at"]);
    h.db!.ops.length = 0;
    await ticket.restoreBudget(ids);
    assert.equal(h.db!.ops.length, 0, "沒刪的不寫");
  });

  test("restoreAim 走得通（真的 deleteAim → 撿回）", async () => {
    const h = sqliteHarness();
    const aims = new SqliteWeekAimRepository();
    h.put("week_aims", { id: "a", week_on: "2026-11-02", text: "讀完" });
    await aims.deleteAim("a");
    const [item] = await h.repo.list(Date.now() + 60_000);
    assert.equal(item.kind, "week_aim");
    await h.repo.restore(item);
    assert.equal((await h.read("week_aims", "a"))?.deleted_at, null);
  });

  test("restoreAsLoose：掛路線時排序鍵給尾端；op 不帶 line_id", async () => {
    const h = sqliteHarness();
    seedTree(h);
    const nodes = new SqliteNodeRepository();
    h.put("nodes", node("t", "train", "r", T1, { line_id: "l", route_id: "r" }));
    h.put("nodes", node("k", "ticket", "t", T1, { line_id: "l", route_id: "r" }));
    await nodes.restoreAsLoose("k", "r");
    const row = await h.read("nodes", "k");
    assert.equal(row?.line_id, "l");
    assert.notEqual(row?.sort_key, null);
    const op = h.db!.ops.at(-1)!;
    assert.equal(op.row_id, "k");
    assert.deepEqual(Object.keys(op.cols).sort(), ["deleted_at", "parent_id", "route_id", "sort_key", "updated_at"]);
  });
});

/* ═══════════════ 對抗審查的修正（docs/research/2026-11-05-失物招領-對抗審查.md） ═══════════════ */

const RULE_MONTHLY = JSON.stringify({ v: 1, mode: "fixed", freq: "monthly", interval: 1, byweekday: null, bymonthday: [1], start: "2026-01-01", until: null, count: null });
const THE_DAY = "2026-02-01";

function seedLedger(h: Harness): void {
  h.put("tk_currencies", { id: "cur", code: "TWD", name: "新台幣", decimals: 0, rate_to_main: "1", is_main: 1 });
  h.put("tk_accounts", { id: "acc", name: "現金", currency: "TWD" });
}
const repeatRow = (deleted: string | null, extra: Partial<Row> = {}): Row => ({
  id: "rp",
  kind: "expense",
  account_id: "acc",
  amount_minor: 100,
  currency: "TWD",
  rule: RULE_MONTHLY,
  next_on: "2026-03-01",
  skipped_days: JSON.stringify([THE_DAY]),
  deleted_at: deleted,
  ...extra,
});
const entryRow = (id: string, day: string, deleted: string | null): Row => ({
  id,
  kind: "expense",
  occurred_on: day,
  occurred_at: ago(30),
  account_id: "acc",
  amount_minor: 100,
  currency: "TWD",
  main_minor: 100,
  account_minor: 100,
  repeat_id: "rp",
  deleted_at: deleted,
});

for (const make of [sqliteHarness, memoryHarness]) {
  const kindName = make === sqliteHarness ? "sqlite" : "memory";
  describe(`${kindName}：最近刪除的定期帳與臨時車票`, () => {
    let h: Harness;
    beforeEach(() => {
      h = make();
      seedLedger(h);
    });
    const itemOf = async (id: string) => (await h.repo.list(NOW)).find((x: Any) => x.id === id);

    test("沙盒 F-2：撿回帳目時規則是 tombstone，不碰規則（等撿回規則才拿掉那班）", async () => {
      const eid = materializeId("rp", THE_DAY);
      h.put("tk_repeats", repeatRow(T2));
      h.put("tk_entries", entryRow(eid, THE_DAY, T1));
      await h.repo.restore(await itemOf(eid));
      const rule = await h.read("tk_repeats", "rp");
      assert.deepEqual(JSON.parse(String(rule?.skipped_days)), [THE_DAY]);
      assert.equal(rule?.deleted_at, T2, "規則還是刪的");
    });

    test("問題 3：撿回規則時，帳現在活著的那班從 skipped_days 拿掉；帳不活的留著", async () => {
      const eid = materializeId("rp", THE_DAY);
      h.put("tk_repeats", repeatRow(T1, { skipped_days: JSON.stringify([THE_DAY, "2026-03-01"]) }));
      h.put("tk_entries", entryRow(eid, THE_DAY, null));
      await h.repo.restore(await itemOf("rp"));
      assert.deepEqual(JSON.parse(String((await h.read("tk_repeats", "rp"))?.skipped_days)), ["2026-03-01"]);
    });

    test("問題 4：撿回規則不補：next_on 跳到今天之後，回 noBackfill", async () => {
      h.put("tk_repeats", repeatRow(T1, { skipped_days: "[]" }));
      const res = await h.repo.restore(await itemOf("rp"));
      assert.equal(res.noBackfill, true);
      const r = await h.read("tk_repeats", "rp");
      assert.equal(r?.deleted_at, null);
      assert.ok(String(r?.next_on) > todayKey(0), `next_on=${String(r?.next_on)}`);
    });

    test("問題 9：根層臨時車票的路線已刪：清標籤放收件匣", async () => {
      h.put("nodes", node("l", "line", null, null));
      h.put("nodes", node("r", "route", "l", T2, { line_id: "l" }));
      h.put("nodes", node("k", "ticket", null, T1, { line_id: "l", route_id: "r" }));
      assert.deepEqual(await h.repo.restore(await itemOf("k")), { placedAsLoose: true });
      const row = await h.read("nodes", "k");
      assert.equal(row?.deleted_at, null);
      assert.equal(row?.route_id, null);
    });

    test("問題 1：快照撿回有 tombstone 的筆記，內文留本機版；之後出現在內容不同，可以改回", async () => {
      h.put("notes", note("n", "週二版", T1));
      const snap = { exported_at: ago(5), schema: 18, tables: { notes: [note("n", "週一版", null)] }, columns: REG.columns };
      const first = await h.repo.diffSnapshot(snap);
      assert.equal(first.missing[0].title, "週二版");
      await h.repo.rescue(snap, first.missing[0]);
      assert.equal((await h.read("notes", "n"))?.body, "週二版");
      assert.equal((await h.read("notes", "n"))?.deleted_at, null);
      const after = await h.repo.diffSnapshot(snap);
      assert.deepEqual(after.missing, []);
      assert.deepEqual(after.changed.map((x: Any) => x.id), ["n"]);
    });

    test("問題 2：活著的列再按一次撿回：不寫、回已經在了", async () => {
      h.put("notes", note("n", "另一台改過", null));
      const snap = { exported_at: ago(5), schema: 18, tables: { notes: [note("n", "快照", null)] }, columns: REG.columns };
      const res = await h.repo.rescue(snap, { table: "notes", id: "n" });
      assert.equal(res.alreadyHere, true);
      assert.equal((await h.read("notes", "n"))?.body, "另一台改過");
    });
  });
}

describe("sqlite：對抗審查的修正", () => {
  const OLD = ago(20);
  const stamp = { created_at: OLD, updated_at: OLD };
  const snapshotOf = (tables: Record<string, Row[]>) => ({ exported_at: ago(5), schema: 18, tables, columns: REG.columns });
  const requiredOk = (op: Op): void => {
    for (const c of REG.required[op.tbl]) assert.ok(c in op.cols && op.cols[c] !== null, `${op.tbl} 缺必填欄 ${c}`);
  };

  test("問題 1：本機 tombstone 的節點整列 op：必填欄齊、內容是本機的；快照舊內容不進資料庫", async () => {
    const h = sqliteHarness();
    h.put("nodes", node("l", "line", null, null));
    h.put("nodes", node("r", "route", "l", T1, { line_id: "l", name: "較新的路線", ...stamp }));
    h.put("nodes", node("k", "ticket", "r", T1, { line_id: "l", route_id: "r", name: "較新的票", description: "較新的概要", status: "doing", ...stamp }));
    const snap = snapshotOf({ nodes: [node("r", "route", "l", null, { name: "舊路線", ...stamp }), node("k", "ticket", "r", null, { name: "舊票", ...stamp })] });
    await h.repo.rescue(snap, { table: "nodes", id: "r" });
    const k = await h.read("nodes", "k");
    assert.equal(k?.name, "較新的票");
    assert.equal(k?.description, "較新的概要");
    assert.equal(k?.status, "doing");
    assert.equal(k?.deleted_at, null);
    assert.equal(k?.route_id, "r");
    for (const op of h.db!.ops) requiredOk(op);
    const op = h.db!.ops.find((o) => o.row_id === "k")!;
    assert.equal(op.cols.name, "較新的票");
    assert.equal(op.cols.deleted_at, null);
    assert.ok(!("route_id" in op.cols), "非根層票的 route_id 是快取");
  });

  test("問題 8：連同上層時，只在本機有 tombstone 的上層也送整列", async () => {
    const h = sqliteHarness();
    h.put("nodes", node("l", "line", null, null));
    h.put("nodes", node("r", "route", "l", null, { line_id: "l" }));
    h.put("nodes", node("t", "train", "r", T1, { line_id: "l", route_id: "r", name: "本機列車", ...stamp }));
    const snap = snapshotOf({ nodes: [node("c", "car", "t", null, stamp)] });
    await h.repo.rescue(snap, { table: "nodes", id: "c" }, { withParent: true });
    const op = h.db!.ops.find((o) => o.row_id === "t")!;
    requiredOk(op);
    assert.equal(op.cols.name, "本機列車");
    assert.equal(op.cols.parent_id, "r");
    assert.equal((await h.read("nodes", "t"))?.deleted_at, null);
    assert.equal((await h.read("nodes", "c"))?.route_id, "r");
  });

  test("問題 2：活著的時間塊撿回：不寫 tombstone、沒有 op、previewCover 回 null", async () => {
    const h = sqliteHarness();
    h.put("time_categories", { id: "cat", name: "讀", ...stamp });
    h.put("time_blocks", { id: "b", category_id: "cat", started_at: ago(6), ended_at: ago(5), ...stamp });
    const before = await h.read("time_blocks", "b");
    const snap = snapshotOf({ time_blocks: [{ id: "b", category_id: "cat", started_at: ago(7), ended_at: ago(6), ...stamp, deleted_at: null }], time_categories: [] });
    assert.equal(await h.repo.previewCover({ table: "time_blocks", id: "b" }, snap), null);
    const res = await h.repo.rescue(snap, { table: "time_blocks", id: "b" });
    assert.equal(res.alreadyHere, true);
    assert.deepEqual(await h.read("time_blocks", "b"), before);
    assert.equal(h.db!.ops.length, 0);
  });

  test("問題 2：活著的節點：自己一個字不動，只補底下不在的子節點；回補了幾個", async () => {
    const h = sqliteHarness();
    h.put("nodes", node("l", "line", null, null));
    h.put("nodes", node("r", "route", "l", null, { line_id: "l", name: "現在的名字", ...stamp }));
    const before = await h.read("nodes", "r");
    const snap = snapshotOf({ nodes: [node("r", "route", "l", null, { name: "快照名", ...stamp }), node("k", "ticket", "r", null, stamp)] });
    const res = await h.repo.rescue(snap, { table: "nodes", id: "r" });
    assert.equal(res.alreadyHere, true);
    assert.equal(res.filled, 1);
    assert.deepEqual(await h.read("nodes", "r"), before);
    assert.equal((await h.read("nodes", "k"))?.route_id, "r");
  });

  test("問題 1：時間塊有 tombstone：用本機內容，運行中結束在刪除那一刻（不是快照那一刻）", async () => {
    const h = sqliteHarness();
    h.put("time_categories", { id: "cat", name: "讀", ...stamp });
    h.put("time_categories", { id: "cat2", name: "寫", ...stamp });
    const started = ago(6);
    h.put("time_blocks", { id: "b", category_id: "cat2", started_at: started, ended_at: null, ...stamp, deleted_at: T1 });
    const snap = snapshotOf({ time_blocks: [{ id: "b", category_id: "cat", started_at: started, ended_at: ago(5), ...stamp, deleted_at: null }], time_categories: [] });
    await h.repo.rescue(snap, { table: "time_blocks", id: "b" });
    const b = await h.read("time_blocks", "b");
    assert.equal(b?.category_id, "cat2");
    assert.equal(b?.deleted_at, null);
    assert.equal(b?.ended_at, T1);
    const full = h.db!.ops.find((o) => o.row_id === "b" && "category_id" in o.cols)!;
    assert.equal(full.cols.category_id, "cat2");
  });

  test("問題 3：先撿帳、再撿規則：實體化不會再刪那筆帳（走真的 materializeRepeats）", async () => {
    const h = sqliteHarness();
    seedLedger(h);
    const ticket = new SqliteTicketRepository();
    const eid = materializeId("rp", THE_DAY);
    h.put("tk_repeats", repeatRow(T2));
    h.put("tk_entries", entryRow(eid, THE_DAY, T1));
    const items = await h.repo.list(NOW);
    await h.repo.restore(items.find((x: Any) => x.id === eid));
    await h.repo.restore((await h.repo.list(NOW)).find((x: Any) => x.id === "rp"));
    await ticket.materializeRepeats(todayKey(0), 0);
    assert.equal((await h.read("tk_entries", eid))?.deleted_at, null, "帳還活著");
  });

  test("沙盒 F-2：撿回帳目不對 tombstone 規則送 op（否則併發刪規則時它會復活）", async () => {
    const h = sqliteHarness();
    seedLedger(h);
    const eid = materializeId("rp", THE_DAY);
    h.put("tk_repeats", repeatRow(T2));
    h.put("tk_entries", entryRow(eid, THE_DAY, T1));
    await h.repo.restore((await h.repo.list(NOW)).find((x: Any) => x.id === eid));
    assert.equal(h.db!.ops.find((o) => o.tbl === "tk_repeats"), undefined);
  });

  test("沙盒 F-2：快照撿回帳目，規則是 tombstone 不碰", async () => {
    const h = sqliteHarness();
    seedLedger(h);
    const eid = materializeId("rp", THE_DAY);
    h.put("tk_repeats", repeatRow(T2));
    const snap = snapshotOf({ tk_entries: [{ ...entryRow(eid, THE_DAY, null), ...stamp }] });
    await h.repo.rescue(snap, { table: "tk_entries", id: eid });
    assert.deepEqual(JSON.parse(String((await h.read("tk_repeats", "rp"))?.skipped_days)), [THE_DAY]);
    assert.equal((await h.read("tk_repeats", "rp"))?.deleted_at, T2);
  });

  test("問題 3、4：快照撿回規則（本機沒有這一列）：skipped_days 拿掉帳活著的班、next_on 不補、op 都帶", async () => {
    const h = sqliteHarness();
    seedLedger(h);
    const ticket = new SqliteTicketRepository();
    const eid = materializeId("rp", THE_DAY);
    h.put("tk_entries", entryRow(eid, THE_DAY, null));
    const snap = snapshotOf({ tk_repeats: [{ ...repeatRow(null), ...stamp, hhmm: "09:00", position: 0, note: "" }] });
    const res = await h.repo.rescue(snap, { table: "tk_repeats", id: "rp" });
    assert.equal(res.noBackfill, true);
    const r = await h.read("tk_repeats", "rp");
    assert.deepEqual(JSON.parse(String(r?.skipped_days)), []);
    assert.ok(String(r?.next_on) > todayKey(0));
    const op = h.db!.ops.find((o) => o.tbl === "tk_repeats")!;
    assert.equal(op.cols.next_on, r?.next_on);
    assert.equal(op.cols.skipped_days, "[]");
    requiredOk(op);
    const m = await ticket.materializeRepeats(todayKey(0), 0);
    assert.equal(m.inserted, 0, "中間的班次不補");
    assert.equal((await h.read("tk_entries", eid))?.deleted_at, null);
  });

  test("問題 4：快照撿回有 tombstone 的規則：內容用本機的，一樣不補", async () => {
    const h = sqliteHarness();
    seedLedger(h);
    const ticket = new SqliteTicketRepository();
    h.put("tk_repeats", repeatRow(T1, { note: "較新的備註", skipped_days: "[]" }));
    const snap = snapshotOf({ tk_repeats: [{ ...repeatRow(null, { note: "舊備註" }), ...stamp }] });
    await h.repo.rescue(snap, { table: "tk_repeats", id: "rp" });
    const r = await h.read("tk_repeats", "rp");
    assert.equal(r?.note, "較新的備註");
    assert.ok(String(r?.next_on) > todayKey(0));
    assert.equal((await ticket.materializeRepeats(todayKey(0), 0)).inserted, 0);
  });

  test("問題 4：toast 復原那條路（restoreRepeat）行為不變：next_on、skipped_days 不動", async () => {
    const h = sqliteHarness();
    seedLedger(h);
    const ticket = new SqliteTicketRepository();
    h.put("tk_repeats", repeatRow(T1));
    await ticket.restoreRepeat("rp");
    const r = await h.read("tk_repeats", "rp");
    assert.equal(r?.deleted_at, null);
    assert.equal(r?.next_on, "2026-03-01");
    assert.deepEqual(JSON.parse(String(r?.skipped_days)), [THE_DAY]);
    assert.deepEqual(Object.keys(h.db!.ops[0].cols).sort(), ["deleted_at", "updated_at"]);
  });

  test("問題 5：快照撿回荷札：使用者自己摘的不補內文（走真的刪除路徑）", async () => {
    const h = sqliteHarness();
    const tags = new SqliteTagRepository();
    h.put("notes", note("n", "去東京 #x", null));
    await tags.syncBodyTags("n", "去東京 #x");
    const id = await tagId("x");
    const gid = (await h.db!.select(`SELECT id FROM taggings WHERE tag_id = $1`, [id]))[0].id as string;
    const snap = snapshotOf({
      tags: [{ id, name: "x", name_key: "x", renamed_to: null, ...stamp, deleted_at: null }],
      taggings: [{ id: gid, entity_type: "note", entity_id: "n", tag_id: id, ...stamp, deleted_at: null }],
    });
    // 使用者編輯拿掉 #x，之後才刪荷札（這時已經沒有掛載）
    h.db!.raw.exec(`UPDATE notes SET body = '去東京' WHERE id = 'n'`);
    await tags.syncBodyTags("n", "去東京");
    await tags.remove({ ok: true, key: "x", name: "x", keys: ["x"], places: 0, affected: {}, kidsWithItems: 0, bodyCount: 0, childCount: 0 } as Any);
    const res = await h.repo.rescue(snap, { table: "tags", id });
    assert.deepEqual(res, {});
    assert.equal((await h.read("tags", id))?.deleted_at, null);
    assert.equal((await h.read("notes", "n"))?.body, "去東京", "內文不補");
    assert.notEqual((await h.read("taggings", gid))?.deleted_at, null, "掛載不帶");
  });

  test("問題 7：舊隨機 id 的班次寫成決定性 id；本機有活的舊 id 就不帶；唯一索引不撞", async () => {
    const h = sqliteHarness();
    const stampRow = (id: string, due: string): Row => ({ id, node_id: "k", due_on: due, status: "done", ...stamp, deleted_at: null });
    const snap = snapshotOf({ nodes: [node("k", "ticket", null, null, stamp)], occurrences: [stampRow("rand1", "2026-10-01"), stampRow("rand2", "2026-10-02")] });
    h.put("nodes", node("k", "ticket", null, T1, stamp));
    h.put("occurrences", { id: "liveOld", node_id: "k", due_on: "2026-10-02", status: "done", ...stamp });
    await h.repo.rescue(snap, { table: "nodes", id: "k" });
    assert.equal(await h.read("occurrences", "rand1"), undefined);
    assert.equal((await h.read("occurrences", "k|2026-10-01"))?.status, "done");
    assert.equal(await h.read("occurrences", "k|2026-10-02"), undefined, "該班已有活列");
    const op = h.db!.ops.find((o) => o.tbl === "occurrences")!;
    assert.equal(op.row_id, "k|2026-10-01");
    requiredOk(op);
  });

  test("問題 9：快照撿回根層臨時車票、路線已刪：清標籤、op 帶 route_id null", async () => {
    const h = sqliteHarness();
    h.put("nodes", node("l", "line", null, null));
    h.put("nodes", node("r", "route", "l", T1, { line_id: "l" }));
    const snap = snapshotOf({ nodes: [node("k", "ticket", null, null, { route_id: "r", ...stamp })] });
    assert.deepEqual(await h.repo.rescue(snap, { table: "nodes", id: "k" }), { placedAsLoose: true });
    assert.equal((await h.read("nodes", "k"))?.route_id, null);
    const op = h.db!.ops[0];
    assert.ok("route_id" in op.cols);
    assert.equal(op.cols.route_id, null);
  });

  test("問題 10：復活依賴幣別：本機有活的主幣別就寫 0", async () => {
    const h = sqliteHarness();
    h.put("tk_currencies", { id: "twd", code: "TWD", name: "新台幣", decimals: 0, rate_to_main: "1", is_main: 1 });
    h.put("tk_currencies", { id: "usd", code: "USD", name: "美元", decimals: 2, rate_to_main: "30", is_main: 1, deleted_at: T1 });
    h.put("tk_accounts", { id: "a", name: "美金戶", currency: "USD" });
    const snap = snapshotOf({
      tk_entries: [{ id: "e", kind: "expense", occurred_on: "2026-10-01", occurred_at: OLD, account_id: "a", amount_minor: 1, currency: "USD", main_minor: 30, account_minor: 1, ...stamp, deleted_at: null }],
      tk_currencies: [{ id: "usd", code: "USD", name: "美元", decimals: 2, rate_to_main: "30", is_main: 1, position: 1, ...stamp, deleted_at: null }],
    });
    await h.repo.rescue(snap, { table: "tk_entries", id: "e" });
    const usd = await h.read("tk_currencies", "usd");
    assert.equal(usd?.deleted_at, null);
    assert.equal(usd?.is_main, 0);
    assert.equal(h.db!.ops.find((o) => o.row_id === "usd")?.cols.is_main, 0);
    assert.equal((await h.db!.select(`SELECT COUNT(*) AS n FROM tk_currencies WHERE is_main = 1 AND deleted_at IS NULL`, []))[0].n, 1);
  });

  test("問題 11：改回筆記：內文與掛載在同一批（一個交易）", async () => {
    const h = sqliteHarness();
    const tags = new SqliteTagRepository();
    h.put("notes", note("n", "現在 #新字", null));
    await tags.syncBodyTags("n", "現在 #新字");
    const { changed } = await h.repo.diffSnapshot(snapshotOf({ notes: [note("n", "以前 #舊字", null)] }));
    h.db!.batchCount = 0;
    const r = await h.repo.revertToSnapshot(changed[0]);
    assert.equal(h.db!.batchCount, 1, "只開一個交易");
    assert.deepEqual((await tags.listTagsOf("note", "n")).map((t: Any) => t.name_key), ["舊字"]);
    assert.deepEqual(r.before, { body: "現在 #新字" });
    h.db!.batchCount = 0;
    await h.repo.undoRevert(r);
    assert.equal(h.db!.batchCount, 1);
  });

  test("問題 11：批次失敗＝內文也沒改（整批回滾）", async () => {
    const h = sqliteHarness();
    const tags = new SqliteTagRepository();
    h.put("notes", note("n", "現在 #新字", null));
    await tags.syncBodyTags("n", "現在 #新字");
    const { changed } = await h.repo.diffSnapshot(snapshotOf({ notes: [note("n", "以前 #舊字", null)] }));
    h.db!.raw.exec(`CREATE TRIGGER boom BEFORE INSERT ON taggings BEGIN SELECT RAISE(ABORT, 'boom'); END`);
    await assert.rejects(() => h.repo.revertToSnapshot(changed[0]), /boom/);
    assert.equal((await h.read("notes", "n"))?.body, "現在 #新字");
  });

  test("問題 12：softDelete 根已刪就回 []、不重戳；子孫時刻不動", async () => {
    const h = sqliteHarness();
    const nodes = new SqliteNodeRepository();
    h.put("nodes", node("t", "train", null, null));
    h.put("nodes", node("k", "ticket", "t", null));
    const first = await nodes.softDelete("t");
    assert.deepEqual(first.slice().sort(), ["k", "t"]);
    const at = (await h.read("nodes", "t"))?.deleted_at;
    const n = h.db!.ops.length;
    assert.deepEqual(await nodes.softDelete("t"), []);
    assert.equal((await h.read("nodes", "t"))?.deleted_at, at);
    assert.equal(h.db!.ops.length, n, "沒有新 op");
    assert.equal((await h.repo.list(Date.now() + 60_000)).length, 1, "還是一刀一列");
    assert.deepEqual(await nodes.softDelete("不存在"), []);
  });
});

describe("問題 3、4：撿回定期帳要改的欄（pickUpRepeatCols）", () => {
  const base = { id: "rp", rule: RULE_MONTHLY, next_on: "2026-03-01", import_source: null, skipped_days: JSON.stringify(["2026-02-01", "2026-03-01"]) } as Any;
  test("next_on 從明天往後第一班；帳活著的那班從 skipped_days 拿掉，其他留著", () => {
    const out = pickUpRepeatCols(base, [], new Set([materializeId("rp", "2026-02-01")]), "2026-11-04");
    assert.equal(out.next_on, "2026-12-01");
    assert.deepEqual(JSON.parse(out.skipped_days), ["2026-03-01"]);
  });
  test("規則看不懂：不丟錯、next_on 不動", () => {
    assert.equal(pickUpRepeatCols({ ...base, rule: "{}" }, [], new Set(), "2026-11-04").next_on, "2026-03-01");
  });
  test("候選：skipped_days 每一天的決定性 id", () => {
    assert.deepEqual(skippedEntryIds(base), [materializeId("rp", "2026-02-01"), materializeId("rp", "2026-03-01")]);
  });
});

describe("記憶體版：問題 12", () => {
  test("softDelete 根已刪就回 []、不重戳", async () => {
    const { MemoryNodeRepository } = await import("../../src/data/memoryRepository.ts");
    const repo = new MemoryNodeRepository() as Any;
    const line = await repo.create({ kind: "line", name: "幹線", parentId: null });
    const first = await repo.softDelete(line.id);
    assert.deepEqual(first, [line.id]);
    assert.deepEqual(await repo.softDelete(line.id), []);
    assert.deepEqual(await repo.softDelete("不存在"), []);
  });
});

describe("記憶體版的假資料（?mock=1）", () => {
  test("涵蓋每個分類；撿回後從清單消失；假快照能撿能改回；wiped 一筆都沒有", async () => {
    const repo = new MemoryLostFoundRepository({ seed: true });
    const items = await repo.list(Date.now());
    assert.deepEqual([...new Set(items.map((x: Any) => x.category))].sort(), ["notes", "ticket", "tasks", "timetable"].sort());
    const before = items.length;
    const note0 = items.find((x: Any) => x.kind === "note");
    await repo.restore(note0);
    assert.equal((await repo.list(Date.now())).length, before - 1);

    const snap = await repo.readSnapshot();
    const { missing, changed } = await repo.diffSnapshot(snap);
    assert.ok(missing.length >= 2);
    assert.ok(changed.length >= 2);
    await repo.rescue(snap, missing[0]);
    const after = await repo.diffSnapshot(snap);
    assert.equal(after.missing.length, missing.length - 1);
    const r = await repo.revertToSnapshot(changed[0]);
    assert.equal((await repo.diffSnapshot(snap)).changed.length, changed.length - 1);
    await repo.undoRevert(r);
    assert.equal((await repo.diffSnapshot(snap)).changed.length, changed.length);

    assert.deepEqual(await new MemoryLostFoundRepository({ seed: false }).list(Date.now()), []);
  });
});
