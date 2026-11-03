/**
 * 週方針——repository 層（戊；契約 §2、§3）。SQLite 版與記憶體版跑同一套寫入行為；「已排」兩版都驗，回顧的時間與花費只有 SQLite 版。
 * 跑法：`node --test scripts/tests/week-aims-repo.test.ts`（node 24，型別剝除；零依賴）。
 *
 * SQLite：node:sqlite 記憶體庫＋`src-tauri/migrations` 全部依序跑（真的 DDL，含 week_aims）；`../lib/db` 換成回這顆庫的替身、
 * `./syncRepository` 換成照順序執行 SQL、把 op 記下來的假批次（載入法同 `timetable-plans-sqlite.test.ts`）。
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
export function getDb() { const d = globalThis.__aimsDb; if (!d) throw new Error("測試沒設 __aimsDb"); return Promise.resolve(d); }
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
    // 運行報告的済（sealRepo）直接拿來比對口徑：它的 MOCK_MODE／noteRepo 換成最小替身（只走 SQLite 分支）
    if (fromSrc && context.parentURL!.endsWith("/src/data/sealRepo.ts")) {
      if (specifier === "./index") return { url: dataUrl("export const MOCK_MODE = false;"), shortCircuit: true };
      if (specifier === "./noteRepo") return { url: dataUrl("export const noteRepo = {};"), shortCircuit: true };
    }
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
    raw,
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

const { SqliteWeekAimRepository } = await import("../../src/data/sqliteWeekAimRepository.ts");
const { MemoryWeekAimRepository } = await import("../../src/data/memoryWeekAimRepository.ts");
const { carryAimId, planSaveWeek, aimsOfWeek } = await import("../../src/domain/weekAims.ts");
const { dayWindow, dayKeyOf } = await import("../../src/lib/date.ts");
const { sealRepo } = await import("../../src/data/sealRepo.ts");
const { buildOperationReport } = await import("../../src/domain/report.ts");
const { dedupeSeals, sealsInWindow } = await import("../../src/domain/seals.ts");

const WEEK = "2026-10-26"; // 週一
const DSH = 6;
const inWeek = (day: string, h: number) => new Date(Date.parse(dayWindow(day, DSH).start) + h * 3_600_000).toISOString();

/**
 * 共用節點測資：路線 R1 底下一班列車 T1、兩張票、一張掛 R1 標籤的臨時票、週外一張、定期券一張、刪掉一張；路線 R2 沒東西。
 * 路線 R3（D-主-281 支線）：支線 B1 ⊃ 票 K7（這週済）＋支線 B2 ⊃ 票 K8（這週排、沒済）與退役定期券 K9（這週済、班次 o3 同一時刻＝只算一枚）；
 * R3 直屬列車 T3 ⊃ 票 K10（這週済，不在 B1 底下）。
 */
type N = { id: string; kind: string; parent_id: string | null; route_id: string | null; status?: string; scheduled_on?: string | null; completed_at?: string | null; repeat_rule?: string | null; deleted_at?: string | null };
const NODES: N[] = [
  { id: "R1", kind: "route", parent_id: null, route_id: null },
  { id: "R2", kind: "route", parent_id: null, route_id: null },
  { id: "T1", kind: "train", parent_id: "R1", route_id: "R1" },
  { id: "K1", kind: "ticket", parent_id: "T1", route_id: "R1", status: "done", scheduled_on: "2026-10-27", completed_at: inWeek("2026-10-28", 3) },
  { id: "K2", kind: "ticket", parent_id: "T1", route_id: "R1", scheduled_on: "2026-11-01" },
  { id: "K3", kind: "ticket", parent_id: null, route_id: "R1", scheduled_on: "2026-10-26" },
  { id: "K4", kind: "ticket", parent_id: "T1", route_id: "R1", scheduled_on: "2026-11-02" },
  { id: "K5", kind: "ticket", parent_id: "T1", route_id: "R1", scheduled_on: "2026-10-29", repeat_rule: '{"every":"day"}' },
  { id: "K6", kind: "ticket", parent_id: "T1", route_id: "R1", scheduled_on: "2026-10-29", deleted_at: "2026-10-29T00:00:00.000Z" },
  { id: "R3", kind: "route", parent_id: null, route_id: null },
  { id: "B1", kind: "branch", parent_id: "R3", route_id: "R3" },
  { id: "B2", kind: "branch", parent_id: "B1", route_id: "R3" },
  { id: "K7", kind: "ticket", parent_id: "B1", route_id: "R3", status: "done", scheduled_on: "2026-10-27", completed_at: inWeek("2026-10-27", 5) },
  { id: "K8", kind: "ticket", parent_id: "B2", route_id: "R3", scheduled_on: "2026-10-30" },
  { id: "K9", kind: "ticket", parent_id: "B2", route_id: "R3", status: "done", scheduled_on: "2026-10-30", completed_at: inWeek("2026-10-30", 5), repeat_rule: '{"every":"day"}' },
  { id: "T3", kind: "train", parent_id: "R3", route_id: "R3" },
  { id: "K10", kind: "ticket", parent_id: "T3", route_id: "R3", status: "done", scheduled_on: "2026-10-31", completed_at: inWeek("2026-10-31", 1) },
];

/**
 * 班次：K5 這週済一班（o1）、上週済一班（o2，不算）、上週那班這週才補済（o4：済章看完成時刻＝算這週）；
 * 退役定期券 K9 的最後一班 o3 跟 K9 本身同一時刻済（同一節點同一時刻只算一枚）。
 */
const OCCS = [
  { id: "o1", node_id: "K5", due_on: "2026-10-29", status: "done", completed_at: inWeek("2026-10-29", 2) },
  { id: "o2", node_id: "K5", due_on: "2026-10-22", status: "done", completed_at: inWeek("2026-10-22", 2) },
  { id: "o4", node_id: "K5", due_on: "2026-10-25", status: "done", completed_at: inWeek("2026-10-27", 2) },
  { id: "o3", node_id: "K9", due_on: "2026-10-30", status: "done", completed_at: inWeek("2026-10-30", 5) },
].map((o) => ({ ...o, mood: null, deleted_at: null }));

function fullNode(n: N) {
  return {
    line_id: null,
    name: n.id,
    description: null,
    position: 0,
    sort_key: null,
    color: null,
    code: null,
    status: n.status ?? "todo",
    scheduled_on: n.scheduled_on ?? null,
    due_on: null,
    priority: "mid",
    estimate_min: null,
    progress: null,
    time_spent_min: null,
    mood: null,
    repeat_rule: n.repeat_rule ?? null,
    completed_at: n.completed_at ?? null,
    expected_on: null,
    arrived_on: null,
    today_position: null,
    carried_from: null,
    scheduled_time: null,
    time_overrides: null,
    account_id: null,
    device_id: null,
    created_at: "2026-10-20T00:00:00.000Z",
    updated_at: "2026-10-20T00:00:00.000Z",
    synced_at: null,
    deleted_at: n.deleted_at ?? null,
    ...n,
  };
}

function seedSqlite(db: ReturnType<typeof makeDb>) {
  for (const n of NODES) {
    db.raw
      .prepare(
        `INSERT INTO nodes (id, kind, parent_id, route_id, name, status, scheduled_on, completed_at, repeat_rule, deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(n.id, n.kind, n.parent_id, n.route_id, n.id, n.status ?? "todo", n.scheduled_on ?? null, n.completed_at ?? null, n.repeat_rule ?? null, n.deleted_at ?? null);
  }
  const occ = db.raw.prepare(`INSERT INTO occurrences (id, node_id, due_on, status, completed_at) VALUES (?,?,?,?,?)`);
  for (const o of OCCS) occ.run(o.id, o.node_id, o.due_on, o.status, o.completed_at);
}

const memNodeRepo = {
  async listSidebar() {
    return { lines: [], routes: NODES.filter((n) => n.kind === "route").map(fullNode), stations: [] };
  },
  async listRouteTree(routeId: string) {
    return NODES.filter((n) => n.route_id === routeId && !n.deleted_at).map(fullNode);
  },
  async getNode(id: string) {
    const n = NODES.find((x) => x.id === id);
    return n ? fullNode(n) : null;
  },
  async listOccurrences(nodeId: string, from?: string, to?: string) {
    return OCCS.filter((o) => o.node_id === nodeId && (!from || o.due_on >= from) && (!to || o.due_on <= to));
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Repo = any;
const makers: [string, () => { repo: Repo; db: ReturnType<typeof makeDb> | null }][] = [
  [
    "sqlite",
    () => {
      const db = makeDb();
      seedSqlite(db);
      (globalThis as Record<string, unknown>).__aimsDb = db;
      return { repo: new SqliteWeekAimRepository(), db };
    },
  ],
  ["memory", () => ({ repo: new MemoryWeekAimRepository({ nodeRepo: memNodeRepo as never, seedDemo: false }), db: null })],
];

const draft = (text: string, nodeId: string | null = null, id: string | null = null, carriedFrom: string | null = null) => ({ id, text, nodeId, carriedFrom });

for (const [name, make] of makers) {
  describe(`週方針 repository（${name}）`, () => {
    test("寫方針存檔：新句照順序、改字只送變的欄、刪掉的軟刪", async () => {
      const { repo, db } = make();
      await repo.saveWeek(WEEK, planSaveWeek([], [draft("讀完第五課", "R1"), draft("  跑 三次 "), draft("")]));
      let rows = aimsOfWeek(await repo.listRange(WEEK, "2026-11-01"), WEEK);
      assert.deepEqual(rows.map((r: Repo) => [r.text, r.node_id, r.position]), [
        ["讀完第五課", "R1", 0],
        ["跑 三次", null, 1],
      ]);
      if (db) {
        assert.equal(db.batches.length, 1, "一次存檔＝一個 batch");
        const op = db.batches[0][0];
        assert.equal(op.tbl, "week_aims");
        assert.deepEqual(Object.keys(op.cols).sort(), ["carried_from", "created_at", "deleted_at", "done_at", "node_id", "position", "text", "updated_at", "week_on"]);
      }
      // 換順序＋改字＋刪一句
      const [a, b] = rows;
      await repo.saveWeek(WEEK, planSaveWeek(rows, [draft("跑兩次", null, b.id), draft("讀完第五課", "R1", a.id)]));
      rows = aimsOfWeek(await repo.listRange(WEEK, "2026-11-01"), WEEK);
      assert.deepEqual(rows.map((r: Repo) => r.text), ["跑兩次", "讀完第五課"]);
      if (db) {
        const ops = db.batches[1];
        const ob = ops.find((o) => o.row_id === b.id)!;
        assert.deepEqual(Object.keys(ob.cols).sort(), ["position", "text", "updated_at"]);
      }
      await repo.saveWeek(WEEK, planSaveWeek(rows, [draft("讀完第五課", "R1", a.id)]));
      const all = await repo.listRange(WEEK, "2026-11-01");
      assert.equal(all.length, 2, "刪掉的列還在（軟刪）");
      assert.equal(aimsOfWeek(all, WEEK).length, 1);
      if (db) assert.equal(db.batches[2].find((o) => o.row_id === b.id)!.op, "delete");
    });

    test("一週最多五句：加第六句擋下；已經超過的週不加新句照樣存得了", async () => {
      const { repo } = make();
      await repo.saveWeek(WEEK, planSaveWeek([], ["一", "二", "三", "四", "五"].map((t) => draft(t))));
      const rows = aimsOfWeek(await repo.listRange(WEEK, "2026-11-01"), WEEK);
      assert.throws(() => planSaveWeek(rows, [...rows.map((r: Repo) => draft(r.text, null, r.id)), draft("六")]), /最多 5 句/);
      // 繞過純函式直接塞第六句：repository 自己也擋
      await assert.rejects(
        repo.saveWeek(WEEK, { creates: [{ id: null, text: "六", nodeId: null, position: 5, carriedFrom: null }], updates: [], deletes: [] }),
        /最多 5 句/,
      );
    });

    test("蓋済與取消：狀態沒變不寫", async () => {
      const { repo, db } = make();
      await repo.saveWeek(WEEK, planSaveWeek([], [draft("讀完第五課")]));
      const [a] = aimsOfWeek(await repo.listRange(WEEK, "2026-11-01"), WEEK);
      await repo.setDone(a.id, "2026-10-28T10:00:00.000Z");
      await repo.setDone(a.id, "2026-10-28T11:00:00.000Z"); // 已済再蓋：不動
      assert.equal((await repo.getAim(a.id)).done_at, "2026-10-28T10:00:00.000Z");
      if (db) assert.deepEqual(Object.keys(db.batches[1][0].cols).sort(), ["done_at", "updated_at"]);
      await repo.setDone(a.id, null);
      assert.equal((await repo.getAim(a.id)).done_at, null);
      await assert.rejects(repo.setDone("nope", null), /找不到/);
    });

    test("帶到下週：決定性 id；刪掉再帶＝同一列復活、済清掉", async () => {
      const { repo } = make();
      await repo.saveWeek(WEEK, planSaveWeek([], [draft("v0.2 登入頁", "R1")]));
      const [src] = aimsOfWeek(await repo.listRange(WEEK, "2026-11-01"), WEEK);
      const next = "2026-11-02";
      const id = await carryAimId(src.id, next);
      assert.equal(id, await carryAimId(src.id, next), "同一句帶到同一週＝同一個 id");
      assert.notEqual(id, await carryAimId(src.id, "2026-11-09"));
      await repo.saveWeek(next, planSaveWeek([], [draft(src.text, src.node_id, id, src.id)]));
      let [c] = aimsOfWeek(await repo.listRange(next, "2026-11-08"), next);
      assert.equal(c.id, id);
      assert.equal(c.carried_from, src.id);
      await repo.setDone(id, "2026-11-03T01:00:00.000Z");
      await repo.deleteAim(id);
      assert.equal(await repo.getAim(id), null);
      await repo.saveWeek(next, planSaveWeek([], [draft(src.text, src.node_id, id, src.id)]));
      [c] = aimsOfWeek(await repo.listRange(next, "2026-11-08"), next);
      assert.equal(c.id, id);
      assert.equal(c.done_at, null);
      assert.equal(c.deleted_at, null);
    });

    test("已排 N 張・済 M：路線樹＋路線標籤的臨時票；週外、定期券、刪掉的不算", async () => {
      const { repo } = make();
      const c = await repo.plannedCounts(
        [
          { id: "R1", kind: "route" },
          { id: "R2", kind: "route" },
          { id: "T1", kind: "train" },
        ],
        WEEK,
        "2026-11-01",
      );
      assert.deepEqual(c.R1, { planned: 3, done: 1 });
      assert.deepEqual(c.R2, { planned: 0, done: 0 });
      assert.deepEqual(c.T1, { planned: 2, done: 1 });
    });

    test("回顧蓋章：這週的済章（共用口徑 seals.ts）＝這週済的票＋這週完成的班次（含補済上週那班）", async () => {
      const { repo } = make();
      const r = await repo.reviewStats([{ id: "R1", kind: "route" }], WEEK, DSH);
      assert.equal(r.stats.R1.stamps, 3, "K1＋o1＋o4（o2 上週完成不算）");
    });

    test("掛支線：已排＝支線子樹（含巢狀支線）這週的票；定期券、支線外的不算（D-主-281）", async () => {
      const { repo } = make();
      const c = await repo.plannedCounts(
        [
          { id: "B1", kind: "branch" },
          { id: "B2", kind: "branch" },
          { id: "R3", kind: "route" },
        ],
        WEEK,
        "2026-11-01",
      );
      assert.deepEqual(c.B1, { planned: 2, done: 1 }, "K7＋K8；K9 是定期券");
      assert.deepEqual(c.B2, { planned: 1, done: 0 });
      assert.deepEqual(c.R3, { planned: 3, done: 2 }, "K7＋K8＋K10");
    });

    test("掛支線：回顧蓋章只數支線底下的済章；退役定期券本身與最後一班同時刻＝一枚（D-主-281、283）", async () => {
      const { repo } = make();
      const r = await repo.reviewStats(
        [
          { id: "B1", kind: "branch" },
          { id: "B2", kind: "branch" },
          { id: "R3", kind: "route" },
        ],
        WEEK,
        DSH,
      );
      assert.equal(r.stats.B1.stamps, 2, "K7＋K9（o3 去重）");
      assert.equal(r.stats.B2.stamps, 1);
      assert.equal(r.stats.R3.stamps, 3, "K7＋K9＋K10");
      assert.equal(r.stats.B1.spendMinor, null, "帳目只能掛路線");
    });

    test("回顧蓋章跟運行報告的「本週済」「今天済」同一把尺（D-主-283）", async () => {
      const { repo, db } = make();
      const r = await repo.reviewStats(
        [
          { id: "R1", kind: "route" },
          { id: "R3", kind: "route" },
        ],
        WEEK,
        DSH,
      );
      const end = "2026-11-01";
      // SQLite：運行報告真正用的 sealRepo；記憶體：mock 足跡同一支純函式（sealsInWindow＋dedupeSeals）
      const seals = db
        ? await sealRepo.listSeals(WEEK, end, DSH)
        : dedupeSeals(sealsInWindow({ start: dayWindow(WEEK, DSH).start, end: dayWindow(end, DSH).end }, NODES.map(fullNode), OCCS));
      const facts = {
        today: end,
        dayStartHour: DSH,
        weekStart: 1 as const,
        days: 7,
        seals: seals.map((x: Repo) => ({ at: x.at, nodeId: x.nodeId, routeId: x.routeId })),
        late: [],
        dueSoon: [],
        dueByDay: {},
        routes: {},
        time: null,
        money: null,
        notes: null,
        yearAgo: null,
        dayNotes: null,
      };
      // 本週：所有済章都在 R1、R3 底下 ⇒ 兩條的蓋章加起來＝報告的本週合計
      const report = buildOperationReport(facts as never, Date.parse(dayWindow(end, DSH).end) - 1);
      const thisWeek = report.rows.find((x: Repo) => x.kind === "sum" && x.which === "this") as Repo;
      assert.equal(thisWeek.seals, 6);
      assert.equal(r.stats.R1.stamps + r.stats.R3.stamps, thisWeek.seals);
      // 今天：拿週二當今天，報告「今天済」＝那天的済章（K1 不在這天；K7、o4 在）
      const day = "2026-10-27";
      const r2 = buildOperationReport({ ...facts, today: day } as never, Date.parse(dayWindow(day, DSH).end) - 1);
      assert.equal(r2.ride.seals, seals.filter((x: Repo) => dayKeyOf(x.at, DSH) === day).length);
      assert.equal(r2.ride.seals, 2, "K7＋o4");
    });
  });
}

describe("週方針 repository（sqlite）回顧：時刻表與售票口", () => {
  test("時間塊跟這週重疊的部分、只連路線的也算；支出合計主幣別、收入不算", async () => {
    const db = makeDb();
    seedSqlite(db);
    (globalThis as Record<string, unknown>).__aimsDb = db;
    const ins = db.raw.prepare(`INSERT INTO time_blocks (id, category_id, started_at, ended_at, node_id, route_id) VALUES (?,?,?,?,?,?)`);
    ins.run("b1", "c", inWeek("2026-10-27", 1), inWeek("2026-10-27", 2), "K2", null); // 60m
    ins.run("b2", "c", inWeek("2026-10-30", 4), new Date(Date.parse(inWeek("2026-10-30", 4)) + 30 * 60_000).toISOString(), null, "R1"); // 30m
    ins.run("b3", "c", inWeek("2026-10-26", -1), inWeek("2026-10-26", 1), "K1", null); // 跨週首：只算 60m
    ins.run("b4", "c", inWeek("2026-11-03", 1), inWeek("2026-11-03", 2), "K2", null); // 週外
    db.raw.prepare(`INSERT INTO tk_currencies (id, code, decimals, is_main) VALUES ('cur','TWD',0,1)`).run();
    const e = db.raw.prepare(
      `INSERT INTO tk_entries (id, kind, occurred_on, occurred_at, account_id, amount_minor, currency, main_minor, account_minor, route_id) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    );
    e.run("e1", "expense", "2026-10-27", inWeek("2026-10-27", 1), "a", 1200, "TWD", 1200, 1200, "R1");
    e.run("e2", "expense", "2026-10-28", inWeek("2026-10-28", 1), "a", 90, "TWD", 90, 90, "R1");
    e.run("e3", "income", "2026-10-28", inWeek("2026-10-28", 1), "a", 5000, "TWD", 5000, 5000, "R1");
    e.run("e4", "expense", "2026-11-02", inWeek("2026-11-02", 1), "a", 300, "TWD", 300, 300, "R1");
    const repo = new SqliteWeekAimRepository();
    const r = await repo.reviewStats(
      [
        { id: "R1", kind: "route" },
        { id: "T1", kind: "train" },
      ],
      WEEK,
      DSH,
    );
    assert.equal(r.stats.R1.minutes, 150);
    assert.equal(r.stats.R1.spendMinor, 1290);
    assert.deepEqual(r.money, { code: "TWD", decimals: 0 });
    assert.equal(r.stats.T1.minutes, 120, "列車子樹：b1＋b3；只連路線的 b2 不算");
    assert.equal(r.stats.T1.spendMinor, null, "帳目只能掛路線");
  });
});
