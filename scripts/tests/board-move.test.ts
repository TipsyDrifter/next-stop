/**
 * ⑫ 看板換欄：快照 → 寫 → 復原（src/domain/boardMove.ts）與 listTasks 的 has_kids。
 * 跑法：`node --test scripts/tests/board-move.test.ts`（node 24，型別剝除預設開；零依賴）。
 *
 * 計畫是純函式；真正寫下去的那幾條用 SQLite（node:sqlite 記憶體庫＋全部 migration，同 depot.test.ts 的做法）與記憶體版各跑一次，兩邊要同結果。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const FAKE_DB = `
let t = Date.now();
export function getDb() { return Promise.resolve(globalThis.__boardDb); }
export function uuid() { return crypto.randomUUID(); }
export function nowUtcIso() { t += 1000; return new Date(t).toISOString(); }
`;
const FAKE_SYNC = `
export function newWriteBatch() { return { stmts: [], ops: [] }; }
export async function runWriteBatch(db, stmts) { db.runBatch(stmts); }
export async function occurrenceId(n, d) { return n + "|" + d; }
export async function ensureSyncTables() { return false; }
`;
const dataUrl = (src: string) => "data:text/javascript," + encodeURIComponent(src);
registerHooks({
  resolve(specifier, context, nextResolve) {
    const fromSrc = context.parentURL !== undefined && context.parentURL.includes("/src/");
    if (fromSrc) {
      if (specifier === "../lib/db") return { url: dataUrl(FAKE_DB), shortCircuit: true };
      if (specifier === "./syncRepository") return { url: dataUrl(FAKE_SYNC), shortCircuit: true };
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

function makeDb() {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = OFF");
  const dir = path.join(ROOT, "src-tauri/migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) raw.exec(readFileSync(path.join(dir, f), "utf8"));
  const bind = (args: unknown[] = []) => Object.fromEntries(args.map((v, i) => ["$" + (i + 1), v])) as Record<string, never>;
  return {
    async select(sql: string, args?: unknown[]) {
      return raw.prepare(sql).all(bind(args)).map((r) => ({ ...r }));
    },
    async execute(sql: string, args?: unknown[]) {
      raw.prepare(sql).run(bind(args));
      return { rowsAffected: 0 };
    },
    runBatch(stmts: { sql: string; args: unknown[] }[]) {
      raw.exec("BEGIN");
      try {
        for (const st of stmts) raw.prepare(st.sql).run(bind(st.args));
        raw.exec("COMMIT");
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      }
    },
  };
}

const { todayKey, addDays } = await import("../../src/lib/date.ts");
const { afterRule } = await import("../../src/domain/repeat.ts");
const { SqliteNodeRepository } = await import("../../src/data/sqliteNodeRepository.ts");
const { MemoryNodeRepository } = await import("../../src/data/memoryRepository.ts");
const { cardSettled, planCardMove, planCardRestore, readCardStates, restoreCardStates, runCardSteps } = await import("../../src/domain/boardMove.ts");
const { cardStatus } = await import("../../src/domain/board.ts");
const { lateCount } = await import("../../src/domain/dayCount.ts");
const { DEFAULT_TASK_FILTER, matchTask } = await import("../../src/domain/taskFilter.ts");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const H = 6;
const TODAY = todayKey(H);
const DAY = { dateKey: TODAY, dayStartHour: H };

const once = { kind: "ticket", status: "todo", teiki: false, run: null } as const;
const teiki = { kind: "ticket", status: "todo", teiki: true, run: null } as const;

describe("計畫（純函式）", () => {
  test("單發票：換欄就是改 status；蓋済、取消済走 setCompleted", () => {
    assert.deepEqual(planCardMove(once, "doing"), [{ op: "status", status: "doing" }]);
    assert.deepEqual(planCardMove(once, "todo"), []);
    assert.deepEqual(planCardMove({ ...once, status: "doing" }, "done"), [{ op: "complete" }]);
    assert.deepEqual(planCardMove({ ...once, status: "done" }, "todo"), [{ op: "uncomplete" }]);
    assert.deepEqual(planCardMove({ ...once, status: "done" }, "paused"), [{ op: "uncomplete" }, { op: "status", status: "paused" }]);
    assert.deepEqual(planCardMove({ ...once, status: "done" }, "done"), []);
  });

  test("定期券：蓋済時 status 回 todo；從済拖走寫回目標欄（status＝doing 的不會落回進行中）", () => {
    const done = { status: "done", due_on: TODAY };
    assert.deepEqual(planCardMove(teiki, "done"), [{ op: "complete" }]);
    assert.deepEqual(planCardMove({ ...teiki, status: "doing" }, "done"), [{ op: "complete" }, { op: "status", status: "todo" }]);
    assert.deepEqual(planCardMove({ ...teiki, status: "doing", run: done }, "todo"), [{ op: "uncomplete" }, { op: "status", status: "todo" }]);
    assert.deepEqual(planCardMove({ ...teiki, run: done }, "paused"), [{ op: "uncomplete" }, { op: "status", status: "paused" }]);
    assert.deepEqual(planCardMove({ ...teiki, status: "doing", run: done }, "done"), [{ op: "status", status: "todo" }]);
  });

  test("運休中放哪欄都先取消運休；放回原欄也要取消（⋯ 選單選「未開始」）", () => {
    const skipped = { status: "skipped", due_on: TODAY };
    assert.deepEqual(planCardMove({ ...teiki, run: skipped }, "todo"), [{ op: "unskip", due_on: TODAY }]);
    assert.deepEqual(planCardMove({ ...teiki, run: skipped }, "doing"), [{ op: "unskip", due_on: TODAY }, { op: "status", status: "doing" }]);
    assert.deepEqual(planCardMove({ ...teiki, run: skipped }, "done"), [{ op: "unskip", due_on: TODAY }, { op: "complete" }]);
    assert.equal(cardSettled({ status: "todo", run: skipped }), true);
    assert.equal(cardSettled({ status: "todo", run: null }), false);
    assert.equal(cardSettled({ status: "done", run: null }), true);
  });

  test("復原從最新的兩格走回快照，不假設現況", () => {
    // 拖到進行中後按検印再復原：現況是済，快照是未開始 ⇒ 撤済，不能只寫 status
    assert.deepEqual(planCardRestore({ ...once, status: "done" }, once), [{ op: "uncomplete" }]);
    assert.deepEqual(planCardRestore({ ...once, status: "done" }, { ...once, status: "doing" }), [{ op: "uncomplete" }, { op: "status", status: "doing" }]);
    assert.deepEqual(planCardRestore({ ...once, status: "doing" }, { ...once, status: "done" }), [{ op: "complete" }]);
    assert.deepEqual(planCardRestore(once, once), []);
    // 運休放回去
    const skipped = { status: "skipped", due_on: TODAY };
    assert.deepEqual(planCardRestore({ ...teiki, status: "doing" }, { ...teiki, run: skipped }), [{ op: "skip", due_on: TODAY }, { op: "status", status: "todo" }]);
    assert.deepEqual(planCardRestore({ ...teiki, run: { status: "done", due_on: TODAY } }, { ...teiki, run: skipped }), [{ op: "uncomplete" }, { op: "skip", due_on: TODAY }]);
  });
});

const makers: [string, () => Any][] = [
  [
    "SQLite",
    () => {
      (globalThis as Any).__boardDb = makeDb();
      return new SqliteNodeRepository();
    },
  ],
  ["記憶體", () => new MemoryNodeRepository()],
];

for (const [name, mk] of makers) {
  describe(`真的寫下去（${name}）`, () => {
    async function seed(repo: Any) {
      const L = await repo.create({ kind: "line", name: "L" });
      const R = await repo.create({ kind: "route", name: "R", parentId: L.id });
      const T = await repo.create({ kind: "train", name: "T", parentId: R.id });
      const K = await repo.create({ kind: "ticket", name: "K", parentId: T.id });
      const Pass = await repo.create({ kind: "ticket", name: "定期", parentId: T.id });
      await repo.setRepeatRule(Pass.id, afterRule(1, TODAY), TODAY, H);
      return { L, R, T, K, Pass };
    }
    const column = async (repo: Any, id: string) => {
      const n = await repo.getNode(id);
      const occ = (await repo.listCurrentOccurrences(TODAY, H))[id];
      return { col: cardStatus(n, occ), status: n.status, occ: occ?.status ?? null, completed: n.completed_at };
    };
    const move = async (repo: Any, id: string, to: Any) => {
      const before = await readCardStates(repo, [id], DAY);
      await runCardSteps(repo, id, planCardMove(before.get(id), to), DAY);
      return before;
    };

    test("定期券 status＝doing：從済拖到未開始，寫完 status 等於目標欄", async () => {
      const repo = mk();
      const { Pass } = await seed(repo);
      await move(repo, Pass.id, "doing");
      assert.equal((await column(repo, Pass.id)).col, "doing");
      await move(repo, Pass.id, "done");
      assert.deepEqual(await column(repo, Pass.id).then((c) => [c.col, c.status, c.occ]), ["done", "todo", "done"]);
      await move(repo, Pass.id, "todo");
      assert.deepEqual(await column(repo, Pass.id).then((c) => [c.col, c.status, c.occ]), ["todo", "todo", null]);
    });

    test("定期券蓋済後隔天回未開始（status 已回 todo）", async () => {
      const repo = mk();
      const { Pass } = await seed(repo);
      await move(repo, Pass.id, "doing");
      await move(repo, Pass.id, "done");
      const tomorrow = addDays(TODAY, 1);
      const n = await repo.getNode(Pass.id);
      const occ = (await repo.listCurrentOccurrences(tomorrow, H))[Pass.id];
      assert.equal(cardStatus(n, occ), "todo");
    });

    test("復原還原快照：拖到進行中後按検印再復原，不留下矛盾列", async () => {
      const repo = mk();
      const { K } = await seed(repo);
      const snap = await move(repo, K.id, "doing");
      await repo.setCompleted(K.id, true, { dateKey: TODAY, dayStartHour: H });
      assert.deepEqual(await restoreCardStates(repo, snap, DAY), []);
      const c = await column(repo, K.id);
      assert.equal(c.status, "todo");
      assert.equal(c.completed, null, "completed_at 不能留著");
    });

    test("復原定期券：済拖回未開始再復原，班次回到済、status 回原值", async () => {
      const repo = mk();
      const { Pass } = await seed(repo);
      await move(repo, Pass.id, "doing");
      await move(repo, Pass.id, "done");
      const snap = await move(repo, Pass.id, "paused");
      assert.equal((await column(repo, Pass.id)).col, "paused");
      await restoreCardStates(repo, snap, DAY);
      assert.deepEqual(await column(repo, Pass.id).then((c) => [c.col, c.status]), ["done", "todo"]);
    });

    test("運休中換欄會取消運休，復原把運休放回去", async () => {
      const repo = mk();
      const { Pass } = await seed(repo);
      await repo.skipOccurrence(Pass.id, true, TODAY, H);
      const was = (await readCardStates(repo, [Pass.id], DAY)).get(Pass.id);
      assert.equal(was.run.status, "skipped");
      const snap = await move(repo, Pass.id, "doing");
      assert.deepEqual(await column(repo, Pass.id).then((c) => [c.col, c.occ]), ["doing", null]);
      assert.deepEqual(await restoreCardStates(repo, snap, DAY), []);
      const after = (await readCardStates(repo, [Pass.id], DAY)).get(Pass.id);
      assert.deepEqual(after.run, was.run, "同一班運休回來");
      assert.equal(after.status, "todo");
      // 運休中選「未開始」：取消運休，復原也放回去
      const again = await move(repo, Pass.id, "todo");
      assert.equal((await column(repo, Pass.id)).occ, null);
      await restoreCardStates(repo, again, DAY);
      assert.equal((await column(repo, Pass.id)).occ, "skipped");
    });

    test("單發票從済拖走再復原：回到済（完成時間換成現在，同取消済再蓋済）", async () => {
      const repo = mk();
      const { K } = await seed(repo);
      await move(repo, K.id, "done");
      const snap = await move(repo, K.id, "paused");
      assert.deepEqual(await column(repo, K.id).then((c) => [c.col, c.completed]), ["paused", null]);
      await restoreCardStates(repo, snap, DAY);
      const c = await column(repo, K.id);
      assert.equal(c.col, "done");
      assert.notEqual(c.completed, null);
    });

    test("選取列蓋済的判斷看目前班次：今天已済的定期券算有結局", async () => {
      const repo = mk();
      const { Pass, K } = await seed(repo);
      await move(repo, Pass.id, "done");
      const s = await readCardStates(repo, [Pass.id, K.id], DAY);
      assert.equal(s.get(Pass.id).status, "todo", "status 一路是 todo，不能照它判");
      assert.equal(cardSettled(s.get(Pass.id)), true);
      assert.equal(cardSettled(s.get(K.id)), false);
    });

    test("已刪的卡不進快照；復原時已刪就略過", async () => {
      const repo = mk();
      const { K } = await seed(repo);
      const snap = await move(repo, K.id, "doing");
      await repo.softDelete(K.id);
      assert.equal((await readCardStates(repo, [K.id], DAY)).size, 0);
      assert.deepEqual(await restoreCardStates(repo, snap, DAY), []);
    });

    test("listTasks 帶 has_kids；「誤點」條件對得上路線卡的誤點數，其他條件照舊只看葉節點", async () => {
      const repo = mk();
      const { R, T, K } = await seed(repo);
      await repo.update(T.id, { due_on: addDays(TODAY, -2) });
      const tasks = await repo.listTasks();
      assert.equal(tasks.find((x: Any) => x.id === T.id).has_kids, true);
      assert.equal(tasks.find((x: Any) => x.id === K.id).has_kids, false);
      const rows = (await repo.listToday(TODAY, H)).filter((r: Any) => r.route_id === R.id);
      const n = lateCount(rows, TODAY).count;
      const ctx = { today: TODAY, occurrences: await repo.listCurrentOccurrences(TODAY, H), tagsOf: () => [], depot: new Set<string>(), aliveRoute: () => true };
      const hits = tasks.filter((x: Any) => matchTask(x, { ...DEFAULT_TASK_FILTER, routes: [R.id], late: true }, ctx));
      assert.equal(hits.length, n);
      assert.deepEqual(hits.map((x: Any) => x.id), [T.id]);
      assert.equal(tasks.some((x: Any) => x.id === T.id && matchTask(x, { ...DEFAULT_TASK_FILTER, routes: [R.id] }, ctx)), false);
    });
  });
}
