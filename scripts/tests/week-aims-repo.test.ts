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

/* ───────────── 方針擴充：月、年、車站（辛；契約 2026-11-04 §1、§7）。上面週方針的測試一條不動 ───────────── */

const { DAY_MAX, DAY_MIN, aimsOfKey } = await import("../../src/domain/weekAims.ts");

const MONTH = "M2026-11";
const NEXT_MONTH = "M2026-12";
const YEAR = "Y2026";
const STATION = "Sstation-1";

for (const [name, make] of makers) {
  describe(`方針擴充 repository（${name}）`, () => {
    test("寫進去的 week_on＝期間鍵；listRange 照字串能撈兩個月；週區間撈不到", async () => {
      const { repo, db } = make();
      await repo.saveWeek(MONTH, planSaveWeek([], [draft("本月")], MONTH));
      await repo.saveWeek(NEXT_MONTH, planSaveWeek([], [draft("下月")], NEXT_MONTH));
      await repo.saveWeek(YEAR, planSaveWeek([], [draft("今年")], YEAR));
      await repo.saveWeek(STATION, planSaveWeek([], [draft("這站")], STATION));
      assert.deepEqual((await repo.listRange(MONTH, NEXT_MONTH)).map((r: Repo) => r.text), ["本月", "下月"]);
      assert.deepEqual(await repo.listRange(WEEK, "2026-11-01"), []);
      assert.deepEqual(aimsOfKey(await repo.listRange(YEAR, YEAR), YEAR).map((r: Repo) => r.week_on), [YEAR]);
      if (db) assert.equal(db.batches[3][0].cols.week_on, STATION);
    });

    test("listKeys：整批撈、含已刪、只認字面、照 week_on 與順序；空清單＝空", async () => {
      const { repo } = make();
      await repo.saveWeek(STATION, planSaveWeek([], [draft("站一"), draft("站二")], STATION));
      await repo.saveWeek(MONTH, planSaveWeek([], [draft("本月")], MONTH));
      await repo.saveWeek("Sstation-2", planSaveWeek([], [draft("別站")], "Sstation-2"));
      const [m] = aimsOfKey(await repo.listKeys([MONTH]), MONTH);
      await repo.deleteAim(m.id);
      const rows = await repo.listKeys([STATION, MONTH]);
      assert.deepEqual(rows.map((r: Repo) => r.text), ["本月", "站一", "站二"]);
      assert.notEqual(rows[0].deleted_at, null, "含已刪，比照 listRange");
      assert.deepEqual(aimsOfKey(rows, MONTH), []);
      assert.deepEqual(await repo.listKeys([]), []);
    });

    test("五句上限各期分開：週、月、年、站各自塞滿不互相擋；第六句的字隨期間", async () => {
      const { repo } = make();
      const five = ["一", "二", "三", "四", "五"].map((t) => draft(t));
      const sixth = { creates: [{ id: null, text: "六", nodeId: null, position: 5, carriedFrom: null }], updates: [], deletes: [] };
      for (const [key, msg] of [
        [WEEK, /一週最多 5 句/],
        [MONTH, /一個月最多 5 句/],
        [YEAR, /一年最多 5 句/],
        [STATION, /一站最多 5 句/],
      ] as const) {
        await repo.saveWeek(key, planSaveWeek([], five, key));
        await assert.rejects(repo.saveWeek(key, sixth), msg, `${key} 第六句要擋`);
      }
      // 另一期、另一站都還能寫
      await repo.saveWeek(NEXT_MONTH, planSaveWeek([], [draft("下月")], NEXT_MONTH));
      await repo.saveWeek("Sstation-2", planSaveWeek([], [draft("別站")], "Sstation-2"));
      // 比對現況的口徑：月方針的刪除不會被週的區間吃掉
      const rows = aimsOfKey(await repo.listRange(MONTH, MONTH), MONTH);
      await repo.saveWeek(MONTH, planSaveWeek(rows, rows.slice(0, 4).map((r: Repo) => draft(r.text, null, r.id)), MONTH));
      assert.equal(aimsOfKey(await repo.listRange(MONTH, MONTH), MONTH).length, 4);
      assert.equal(aimsOfKey(await repo.listRange(WEEK, "2026-11-01"), WEEK).length, 5);
    });

    test("框開著時別處新寫（conflict.theirs）：第二道五句上限不算它們；自己超過照擋", async () => {
      const { repo } = make();
      await repo.saveWeek(MONTH, planSaveWeek([], [draft("甲"), draft("乙"), draft("丙")], MONTH));
      const base = aimsOfKey(await repo.listRange(MONTH, MONTH), MONTH).map((r: Repo) => draft(r.text, r.node_id, r.id));
      await repo.saveWeek(MONTH, planSaveWeek(aimsOfKey(await repo.listRange(MONTH, MONTH), MONTH), [...base, draft("別處一"), draft("別處二")], MONTH));
      const cur = aimsOfKey(await repo.listRange(MONTH, MONTH), MONTH);
      await repo.saveWeek(MONTH, planSaveWeek(cur, [...base, draft("丁"), draft("戊")], MONTH, base));
      const after = aimsOfKey(await repo.listRange(MONTH, MONTH), MONTH);
      assert.deepEqual(after.map((r: Repo) => r.text), ["甲", "乙", "丙", "丁", "戊", "別處一", "別處二"]);
      // 不帶 conflict 直接塞：repository 照擋
      await assert.rejects(repo.saveWeek(MONTH, { creates: [{ id: null, text: "八", nodeId: null, position: 7, carriedFrom: null }], updates: [], deletes: [] }), /最多 5 句/);
    });

    test("帶到下期：決定性 id、兩台各帶＝同一列；刪掉再帶＝復活；月、年、站都一樣", async () => {
      const { repo } = make();
      for (const [src, target] of [
        [MONTH, NEXT_MONTH],
        [YEAR, "Y2027"],
        [STATION, "Sstation-2"],
      ] as const) {
        await repo.saveWeek(src, planSaveWeek([], [draft("那一句")], src));
        const [a] = aimsOfKey(await repo.listRange(src, src), src);
        const id = await carryAimId(a.id, target);
        // 兩台各帶一次：第二次是同一個 id，蓋回同一列
        await repo.saveWeek(target, planSaveWeek([], [draft(a.text, null, id, a.id)], target));
        await repo.saveWeek(target, { creates: [{ id, text: a.text, nodeId: null, position: 0, carriedFrom: a.id }], updates: [], deletes: [] });
        let got = aimsOfKey(await repo.listRange(target, target), target);
        assert.deepEqual(got.map((r: Repo) => [r.id, r.carried_from]), [[id, a.id]]);
        await repo.deleteAim(id);
        await repo.saveWeek(target, planSaveWeek([], [draft(a.text, null, id, a.id)], target));
        got = aimsOfKey(await repo.listRange(target, target), target);
        assert.deepEqual(got.map((r: Repo) => [r.id, r.deleted_at]), [[id, null]]);
      }
    });

    test("蓋済、取消、刪、復原對各期的列都通", async () => {
      const { repo } = make();
      await repo.saveWeek(YEAR, planSaveWeek([], [draft("今年")], YEAR));
      const [a] = aimsOfKey(await repo.listRange(YEAR, YEAR), YEAR);
      await repo.setDone(a.id, "2026-11-04T00:00:00.000Z");
      assert.equal((await repo.getAim(a.id)).done_at, "2026-11-04T00:00:00.000Z");
      await repo.deleteAim(a.id);
      assert.deepEqual(aimsOfKey(await repo.listRange(YEAR, YEAR), YEAR), []);
      await repo.restoreAim(a.id);
      assert.equal(aimsOfKey(await repo.listRange(YEAR, YEAR), YEAR).length, 1);
    });

    test("已排：plannedCounts 吃月、年、車站的範圍（含不限的一端）", async () => {
      const { repo } = make();
      const r1 = [{ id: "R1", kind: "route" }];
      assert.deepEqual((await repo.plannedCounts(r1, "2026-10-01", "2026-10-31")).R1, { planned: 2, done: 1 }, "K1、K3；K2 在 11/1、K4 在 11/2");
      assert.deepEqual((await repo.plannedCounts(r1, "2026-11-01", "2026-11-30")).R1, { planned: 2, done: 0 }, "K2、K4");
      assert.deepEqual((await repo.plannedCounts(r1, DAY_MIN, DAY_MAX)).R1, { planned: 4, done: 1 });
    });

    test("回顧：reviewStats 吃範圍；字串鍵＝換算成範圍；車站的鍵丟 RangeError；不限的一端照算", async () => {
      const { repo } = make();
      const r1 = [{ id: "R1", kind: "route" }];
      const week = await repo.reviewStats(r1, { from: WEEK, to: "2026-11-01" }, DSH);
      assert.equal(week.stats.R1.stamps, 3, "跟舊的週參數同一個數：K1＋o1＋o4");
      assert.deepEqual(await repo.reviewStats(r1, WEEK, DSH), week);
      // 十月：K1（10/28）＋o1（10/29）＋o2（10/22）＋o4（10/27）
      assert.equal((await repo.reviewStats(r1, "M2026-10", DSH)).stats.R1.stamps, 4);
      assert.equal((await repo.reviewStats(r1, "M2026-11", DSH)).stats.R1.stamps, 0);
      assert.equal((await repo.reviewStats(r1, "Y2026", DSH)).stats.R1.stamps, 4);
      assert.equal((await repo.reviewStats(r1, { from: DAY_MIN, to: DAY_MAX }, DSH)).stats.R1.stamps, 4, "車站兩頭不限");
      assert.equal((await repo.reviewStats(r1, { from: "2026-10-28", to: DAY_MAX }, DSH)).stats.R1.stamps, 2, "K1＋o1");
      assert.equal((await repo.reviewStats(r1, { from: DAY_MIN, to: "2026-10-27" }, DSH)).stats.R1.stamps, 2, "o2＋o4");
      await assert.rejects(repo.reviewStats(r1, STATION, DSH), RangeError);
    });
  });
}

for (const [name, make] of makers) {
  describe(`searchAims（${name}）`, () => {
    test("四種期間都找；含已済、不含已刪；大小寫不敏感；空字回空", async () => {
      const { repo } = make();
      await repo.saveWeek(WEEK, planSaveWeek([], [draft("週的 Grammar"), draft("別的句子")], WEEK));
      await repo.saveWeek(MONTH, planSaveWeek([], [draft("月的 grammar")], MONTH));
      await repo.saveWeek(YEAR, planSaveWeek([], [draft("年的 GRAMMAR")], YEAR));
      await repo.saveWeek(STATION, planSaveWeek([], [draft("站的 grammar"), draft("站的第二句 grammar")], STATION));
      const texts = async (q: string) => (await repo.searchAims(q)).map((r: Repo) => r.text).sort();
      assert.deepEqual(await texts("grammar"), ["年的 GRAMMAR", "月的 grammar", "站的 grammar", "站的第二句 grammar", "週的 Grammar"].sort());
      assert.deepEqual(await texts("  第二句 "), ["站的第二句 grammar"], "前後空白不算");
      assert.deepEqual(await repo.searchAims(""), []);
      assert.deepEqual(await repo.searchAims("   "), []);

      const [row] = await repo.searchAims("月的");
      await repo.setDone(row.id, "2026-11-04T01:00:00.000Z");
      const [done] = await repo.searchAims("月的");
      assert.equal(done.id, row.id, "已済的照樣找得到");
      assert.equal(done.done_at, "2026-11-04T01:00:00.000Z");

      await repo.deleteAim(row.id);
      assert.deepEqual(await repo.searchAims("月的"), [], "刪掉的找不到");
      await repo.restoreAim(row.id);
      assert.equal((await repo.searchAims("月的")).length, 1, "復原就回來");
    });

    test("字面比對：% 與 _ 與反斜線不是萬用字元", async () => {
      const { repo } = make();
      await repo.saveWeek(MONTH, planSaveWeek([], [draft("完成 80% 的單字"), draft("a_b 專案"), draft("路徑 c:\\temp"), draft("普通的一句")], MONTH));
      assert.deepEqual((await repo.searchAims("%")).map((r: Repo) => r.text), ["完成 80% 的單字"]);
      assert.deepEqual((await repo.searchAims("_")).map((r: Repo) => r.text), ["a_b 專案"]);
      assert.deepEqual((await repo.searchAims("\\")).map((r: Repo) => r.text), ["路徑 c:\\temp"]);
    });

    test("最近改過的先；同一句回來的是完整列", async () => {
      const { repo } = make();
      await repo.saveWeek(MONTH, planSaveWeek([], [draft("甲 共同字"), draft("乙 共同字")], MONTH));
      const rows = await repo.listKeys([MONTH]);
      const first = rows.find((r: Repo) => r.text.startsWith("甲"));
      await repo.saveWeek(MONTH, { creates: [], updates: [{ id: first.id, text: "甲改 共同字" }], deletes: [] });
      const hits = await repo.searchAims("共同字");
      assert.equal(hits[0].text, "甲改 共同字");
      assert.equal(hits[0].week_on, MONTH);
      assert.equal(hits[1].text, "乙 共同字");
    });
  });
}

describe("方針擴充 repository（sqlite）回顧：範圍裡的時刻表與售票口", () => {
  test("月範圍與兩頭不限的時間塊、支出；運行中的時間塊不會因為尾端不限算到未來", async () => {
    const db = makeDb();
    seedSqlite(db);
    (globalThis as Record<string, unknown>).__aimsDb = db;
    const ins = db.raw.prepare(`INSERT INTO time_blocks (id, category_id, started_at, ended_at, node_id, route_id) VALUES (?,?,?,?,?,?)`);
    ins.run("b1", "c", inWeek("2026-10-27", 1), inWeek("2026-10-27", 2), "K2", null); // 十月 60m
    ins.run("b2", "c", inWeek("2026-09-27", 1), inWeek("2026-09-27", 3), null, "R1"); // 九月 120m
    db.raw.prepare(`INSERT INTO tk_currencies (id, code, decimals, is_main) VALUES ('cur','TWD',0,1)`).run();
    const e = db.raw.prepare(
      `INSERT INTO tk_entries (id, kind, occurred_on, occurred_at, account_id, amount_minor, currency, main_minor, account_minor, route_id) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    );
    e.run("e1", "expense", "2026-10-27", inWeek("2026-10-27", 1), "a", 1200, "TWD", 1200, 1200, "R1");
    e.run("e2", "expense", "2026-09-27", inWeek("2026-09-27", 1), "a", 90, "TWD", 90, 90, "R1");
    const repo = new SqliteWeekAimRepository();
    const r1 = [{ id: "R1", kind: "route" }];
    const oct = await repo.reviewStats(r1 as never, "M2026-10", DSH);
    assert.equal(oct.stats.R1.minutes, 60);
    assert.equal(oct.stats.R1.spendMinor, 1200);
    const all = await repo.reviewStats(r1 as never, { from: DAY_MIN, to: DAY_MAX }, DSH);
    assert.equal(all.stats.R1.minutes, 180);
    assert.equal(all.stats.R1.spendMinor, 1290);
    // 還在跑的時間塊：算到現在，不是算到 9999 年
    const startedAt = new Date(Date.now() - 30 * 60_000).toISOString();
    ins.run("b3", "c", startedAt, null, "K2", null);
    const live = await repo.reviewStats(r1 as never, { from: DAY_MIN, to: DAY_MAX }, DSH);
    assert.ok(live.stats.R1.minutes >= 210 && live.stats.R1.minutes <= 212, `實得 ${live.stats.R1.minutes}`);
  });
});

/**
 * 舊版相容（D-主-371、§6-6）：月、年、站的鍵排在任何日期之後，還沒升級的那一台照舊版的週區間查詢撈不到。
 * 這裡的 SQL 是舊版 `sqliteWeekAimRepository` 的原文（listRange 與 saveWeek 算活列那兩句），刻意寫死、不接現行的程式。
 */
describe("舊版相容：混週、月、年、站的列跑舊版的週區間查詢", () => {
  const OLD_LIST = `SELECT * FROM week_aims WHERE week_on >= $1 AND week_on <= $2 ORDER BY week_on, position, created_at, id`;
  const OLD_ALIVE = `SELECT id FROM week_aims WHERE deleted_at IS NULL AND week_on >= $1 AND week_on <= $2`;

  async function mixed() {
    const db = makeDb();
    (globalThis as Record<string, unknown>).__aimsDb = db;
    const repo = new SqliteWeekAimRepository();
    const keys = [
      // 週：跨月那一週、前後週、跨年那一週、改過週起始日的週日起算
      "2026-10-19",
      "2026-10-25",
      "2026-10-26",
      "2026-11-02",
      "2026-12-28",
      "2027-01-04",
      // 月、年：剛好跟上面的週同月同年
      "M2026-10",
      "M2026-11",
      "M2026-12",
      "M2027-01",
      "Y2026",
      "Y2027",
      // 站：id 長得像日期也不會混進來
      "Sabc",
      "S0f3c9d2e-1111-4222-8333-444455556666",
      "S2026-10-27",
    ];
    for (const k of keys) await repo.saveWeek(k, planSaveWeek([], [draft(`句 ${k}`)], k));
    return db;
  }

  const WEEKS: [string, string, string, string[]][] = [
    ["跨月那一週", "2026-10-26", "2026-11-01", ["2026-10-26"]],
    ["週日起算的跨月那一週", "2026-10-25", "2026-10-31", ["2026-10-25", "2026-10-26"]],
    ["連上一週一起載（舊版 fetchWeeks）", "2026-10-19", "2026-11-01", ["2026-10-19", "2026-10-25", "2026-10-26"]],
    ["跨年那一週", "2026-12-28", "2027-01-03", ["2026-12-28"]],
    ["舊版 reloadAll 的大範圍", "2026-10-19", "2027-01-10", ["2026-10-19", "2026-10-25", "2026-10-26", "2026-11-02", "2026-12-28", "2027-01-04"]],
  ];
  for (const [label, from, to, want] of WEEKS) {
    test(`${label}：只撈到週的列`, async () => {
      const db = await mixed();
      const rows = (await db.select(OLD_LIST, [from, to])) as { week_on: string }[];
      assert.deepEqual(rows.map((r) => r.week_on), want);
      assert.ok(rows.every((r) => !/^[MYS]/.test(r.week_on)));
      const alive = await db.select(OLD_ALIVE, [from, to]);
      assert.equal(alive.length, want.length, "舊版算五句上限的那句也一樣");
    });
  }

  test("排序前提：M、S、Y 都排在任何日期之後（9999 年也是）", async () => {
    const db = makeDb();
    const [r] = (await db.select(`SELECT '9999-12-31' < 'M0000-01' AS m, '9999-12-31' < 'S' AS s, '9999-12-31' < 'Y0000' AS y`)) as { m: number; s: number; y: number }[];
    assert.deepEqual([r.m, r.s, r.y], [1, 1, 1]);
  });
});

describe("記憶體版示範種子（?mock=1）", () => {
  test("週的種子不動；多本月、今年；車站掛第一條有車站的路線裡第一個還沒到站的站", async () => {
    const { todayKey, DEFAULT_DAY_START_HOUR } = await import("../../src/lib/date.ts");
    const { monthKeyOf, stationKeyOf, weekEndOf, weekOnOf, yearKeyOf } = await import("../../src/domain/weekAims.ts");
    const sta = (id: string, parent_id: string, arrived_on: string | null) => ({ ...fullNode({ id, kind: "station", parent_id, route_id: null }), arrived_on });
    const repo = new MemoryWeekAimRepository({
      nodeRepo: {
        ...memNodeRepo,
        async listSidebar() {
          return {
            lines: [],
            routes: NODES.filter((n) => n.kind === "route").map(fullNode),
            stations: [sta("gone", "R1", "2026-01-01"), sta("next", "R1", null), sta("later", "R1", null), sta("other", "R2", null)],
          };
        },
      } as never,
      seedDemo: true,
    });
    const today = todayKey(DEFAULT_DAY_START_HOUR);
    const week = weekOnOf(today, 1);
    assert.deepEqual(aimsOfKey(await repo.listRange(week, weekEndOf(week)), week).map((r: Repo) => r.text), ["N5 文法第 5～6 課", "v0.2 的登入頁", "整理房間"]);
    const count = async (k: string) => aimsOfKey(await repo.listKeys([k]), k).length;
    assert.ok((await count(monthKeyOf(today))) > 0);
    assert.ok((await count(yearKeyOf(today))) > 0);
    assert.ok((await count(stationKeyOf("next"))) > 0);
    for (const k of ["gone", "later", "other"]) assert.equal(await count(stationKeyOf(k)), 0, k);
  });
});
