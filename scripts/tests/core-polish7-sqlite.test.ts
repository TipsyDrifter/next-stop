/**
 * 主線・磨光⑦——SQLite 版與記憶體版跑同一套（D-主-67 補記、D-主-68 接縫 #102、評審 #1／#3）。
 * 跑法：`node --test scripts/tests/core-polish7-sqlite.test.ts`（node 24，型別剝除預設開；零依賴）。
 *
 * SQLite：node:sqlite 記憶體庫＋`src-tauri/migrations` 全部依序跑；`../lib/db` 換成回這顆庫的替身、`./syncRepository` 換成
 * 只照順序執行 SQL 的假批次（不寫 oplog——同步那半由沙盒驗）。載入法同 `timetable-tag-carry.test.ts`。
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
let t = Date.now(); // 接近真實時間：今天蓋的章要落在真實的日界線視窗內
export function getDb() { return Promise.resolve(globalThis.__polish7Db); }
export function uuid() { return crypto.randomUUID(); }
export function nowUtcIso() { t += 1000; return new Date(t).toISOString(); }
`;
const FAKE_SYNC = `
export function newWriteBatch() { return { stmts: [], ops: [] }; }
export async function runWriteBatch(db, stmts, ops) { db.runBatch(stmts, ops); }
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

const { addDays, dayWindow, todayKey } = await import("../../src/lib/date.ts");
const { SqliteNodeRepository } = await import("../../src/data/sqliteNodeRepository.ts");
const { MemoryNodeRepository } = await import("../../src/data/memoryRepository.ts");
const { fixedRule } = await import("../../src/domain/repeat.ts");
const { isRetiredRunRow } = await import("../../src/domain/retiredRun.ts");

const H = 6;
const TODAY = todayKey(H);
const YDAY = addDays(TODAY, -1);
const lastSec = (day: string): string => new Date(Date.parse(dayWindow(day, H).end) - 1000).toISOString();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Repo = any;
const makers: [string, () => Repo][] = [
  [
    "sqlite",
    () => {
      (globalThis as Record<string, unknown>).__polish7Db = makeDb();
      return new SqliteNodeRepository();
    },
  ],
  ["memory", () => new MemoryNodeRepository()],
];

for (const [name, make] of makers) {
  describe(`${name}：磨光⑦`, () => {
    test("#102：先済定期券、再一起完成列車 ⇒ 今日清單還在、算完成；這一列點済章不准悄悄解除退役（isRetiredRunRow）", async () => {
      const repo = make();
      const line = await repo.create({ kind: "line", name: "日語", parentId: null });
      const route = await repo.create({ kind: "route", name: "N5", parentId: line.id });
      const train = await repo.create({ kind: "train", name: "N5 文法", parentId: route.id, scheduledOn: TODAY });
      const daily = await repo.create({ kind: "ticket", name: "背 N5 單字", parentId: train.id, scheduledOn: TODAY });
      await repo.setRepeatRule(daily.id, fixedRule("daily", addDays(TODAY, -7)), TODAY, H);
      await repo.setCompleted(daily.id, true, { dateKey: TODAY, dayStartHour: H });
      await repo.setCompleted(train.id, true, { cascade: true, dateKey: TODAY, dayStartHour: H });
      const row = (await repo.listToday(TODAY, H)).find((r: Repo) => r.id === daily.id);
      assert.ok(row, "退役後今日清單還看得到");
      assert.equal(row.status, "done");
      assert.equal(row.bucket, "today");
      assert.equal(row.occurrence?.status, "done");
      assert.equal(isRetiredRunRow(row), true, "今日頁點它的済章只給說明");
      // 沙盒 F1：先済再退役 ⇒ 這台的 scheduled_on 推到了明天（另一台可能停在今天）；明天的清單不能因此冒出一張済
      const tomorrow = addDays(TODAY, 1);
      assert.equal((await repo.listToday(tomorrow, H)).some((r: Repo) => r.id === daily.id), false, "退役的定期券不走第一條");
    });

    test("補記：未済的票改到昨天 ⇒ 済、完成時刻＝昨天日界線前一秒、済事件同時刻；不進今天的清單", async () => {
      const repo = make();
      const t = await repo.create({ kind: "ticket", name: "補寫日記", parentId: null, scheduledOn: TODAY });
      assert.deepEqual(await repo.reschedule(t.id, YDAY, TODAY, { backfill: true, dayStartHour: H }), { backfilled: true });
      const n = await repo.getNode(t.id);
      assert.equal(n.status, "done");
      assert.equal(n.completed_at, lastSec(YDAY));
      assert.equal(n.carried_from, null);
      const done = (await repo.listWorkLogs(t.id)).filter((l: Repo) => l.event === "done");
      assert.equal(done.length, 1);
      assert.equal(done[0].logged_at, lastSec(YDAY));
      assert.notEqual(done[0].created_at, done[0].logged_at, "列的寫入時刻照實是現在");
      assert.equal((await repo.listToday(TODAY, H)).some((r: Repo) => r.id === t.id), false);
    });

    test("補記：誤點票從過去挪到另一個過去 ⇒ 不長繰越（評審 #3）；沒帶 backfill（復原）放回過去 ⇒ 不補記", async () => {
      const repo = make();
      const t = await repo.create({ kind: "ticket", name: "誤點票", parentId: null, scheduledOn: addDays(TODAY, -4) });
      assert.deepEqual(await repo.reschedule(t.id, addDays(TODAY, -2), TODAY, { backfill: true, dayStartHour: H }), { backfilled: true });
      assert.equal((await repo.getNode(t.id)).carried_from, null, "往過去挪不算繰越");

      const late = await repo.create({ kind: "ticket", name: "另一張", parentId: null, scheduledOn: TODAY });
      assert.deepEqual(await repo.reschedule(late.id, YDAY, TODAY), { backfilled: false });
      assert.equal((await repo.getNode(late.id)).status, "todo");
    });

    test("補記的復原：收回済、放回原執行日與原狀態（進行中）", async () => {
      const repo = make();
      const t = await repo.create({ kind: "ticket", name: "進行中的票", parentId: null, scheduledOn: TODAY });
      await repo.update(t.id, { status: "doing" }, { dateKey: TODAY, dayStartHour: H });
      const before = await repo.getNode(t.id);
      await repo.reschedule(t.id, YDAY, TODAY, { backfill: true, dayStartHour: H });
      // 照 nodeStore 的復原順序：先取消完成、再改期（不帶 backfill）、再放回繰越來源與狀態
      await repo.setCompleted(t.id, false, { dateKey: TODAY, dayStartHour: H });
      await repo.reschedule(t.id, before.scheduled_on, TODAY);
      await repo.update(t.id, { carried_from: before.carried_from, status: before.status }, { dateKey: TODAY, dayStartHour: H });
      const n = await repo.getNode(t.id);
      assert.deepEqual([n.status, n.completed_at, n.scheduled_on, n.carried_from], ["doing", null, TODAY, null]);
      assert.equal((await repo.listWorkLogs(t.id)).filter((l: Repo) => l.event === "done").length, 0, "済事件收回");
    });

    test("補記：列車的子票全済 ⇒ 可以補記；還有未完成子票 ⇒ 照舊誤點", async () => {
      const repo = make();
      const line = await repo.create({ kind: "line", name: "L", parentId: null });
      const route = await repo.create({ kind: "route", name: "R", parentId: line.id });
      const open = await repo.create({ kind: "train", name: "有未完成", parentId: route.id, scheduledOn: TODAY });
      await repo.create({ kind: "ticket", name: "子", parentId: open.id, scheduledOn: null });
      assert.deepEqual(await repo.reschedule(open.id, YDAY, TODAY, { backfill: true, dayStartHour: H }), { backfilled: false });
      const allDone = await repo.create({ kind: "train", name: "子票都済", parentId: route.id, scheduledOn: TODAY });
      const kid = await repo.create({ kind: "ticket", name: "子", parentId: allDone.id, scheduledOn: null });
      await repo.setCompleted(kid.id, true, { dateKey: TODAY, dayStartHour: H });
      assert.deepEqual(await repo.reschedule(allDone.id, YDAY, TODAY, { backfill: true, dayStartHour: H }), { backfilled: true });
    });
  });
}
