/**
 * v1.33 資料層測試（時刻表）：time_stat_topics（G1 / 功能 2）與 time_routines.start_day/end_day（G2）。
 * SQLite 版（node:sqlite + 全套 0001–0023 migrations）與記憶體版跑同一套斷言。
 * 跑法：`node --test scripts/tests/v133-schema-timetable.test.ts`
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
let t = Date.now() - 1000 * 60 * 60 * 24;
export function getDb() { const d = globalThis.__v133TtDb; if (!d) throw new Error("測試沒設 __v133TtDb"); return Promise.resolve(d); }
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
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    raw.exec(readFileSync(path.join(dir, f), "utf8"));
  }
  raw.exec("PRAGMA foreign_keys = OFF");
  const bind = (args: unknown[] = []) => Object.fromEntries(args.map((v, i) => ["$" + (i + 1), v])) as Record<string, never>;
  return {
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
        for (const st of stmts) raw.prepare(st.sql).run(bind(argsOrEmpty(st.args)));
        raw.exec("COMMIT");
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      }
      this.batches.push(ops);
    },
  };
}
function argsOrEmpty(args: unknown[] | undefined): unknown[] {
  return args ?? [];
}

const { SqliteTimetableRepository } = await import("../../src/data/sqliteTimetableRepository.ts");
const { MemoryTimetableRepository } = await import("../../src/data/memoryTimetableRepository.ts");
const { autoRoutineFor, isRoutineActiveOn, WEEKDAYS_EVERY } = await import("../../src/domain/timetableRoutine.ts");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Repo = any;
type Maker = () => { repo: Repo; db: ReturnType<typeof makeDb> | null };
const makers: [string, Maker][] = [
  [
    "sqlite",
    () => {
      const db = makeDb();
      (globalThis as Record<string, unknown>).__v133TtDb = db;
      return { repo: new SqliteTimetableRepository(), db };
    },
  ],
  ["memory", () => ({ repo: new MemoryTimetableRepository({ seedDemo: false, nodeRepo: {} as never }), db: null })],
];

test("0023_v133_stats_and_prefs.sql 為純 LF 行尾（零 CR）", () => {
  const bytes = readFileSync(path.join(ROOT, "src-tauri/migrations/0023_v133_stats_and_prefs.sql"));
  assert.equal(bytes.includes(13), false);
});

for (const [name, make] of makers) {
  describe(`${name}：time_stat_topics CRUD 與同步 op`, () => {
    test("create / list / get / update / archive / delete / restore / reorder", async () => {
      const { repo, db } = make();
      const t1 = await repo.createStatTopic({ name: "  睡眠觀察 ", scope: '{"v":1,"categories":["c-sleep"]}', dayStartHour: 18 });
      assert.equal(t1.name, "睡眠觀察");
      assert.equal(t1.day_start_hour, 18);
      assert.equal(t1.position, 0);
      assert.equal(t1.archived_at, null);
      if (db) {
        const op = db.batches[db.batches.length - 1][0];
        assert.equal(op.tbl, "time_stat_topics");
        assert.equal(op.op, "upsert");
        assert.equal(op.cols.day_start_hour, 18);
      }

      const t2 = await repo.createStatTopic({ name: "畢業專題" });
      assert.equal(t2.scope, '{"v":1}');
      assert.equal(t2.day_start_hour, null);
      assert.equal(t2.position, 1);

      assert.deepEqual(
        (await repo.listStatTopics()).map((r: { id: string }) => r.id),
        [t1.id, t2.id],
      );

      // 逐欄 LWW：只改 dayStartHour ⇒ op 只帶 day_start_hour + updated_at
      const batchCountBefore = db?.batches.length ?? 0;
      await repo.updateStatTopic(t1.id, { name: "睡眠觀察", dayStartHour: null });
      const updated = await repo.getStatTopic(t1.id);
      assert.equal(updated.day_start_hour, null);
      if (db) {
        assert.equal(db.batches.length, batchCountBefore + 1);
        const cols = db.batches[db.batches.length - 1][0].cols;
        assert.equal(cols.day_start_hour, null);
        assert.equal("name" in cols, false);
      }

      // 沒變動 ⇒ 不發 batch
      const beforeNoop = db?.batches.length ?? 0;
      await repo.updateStatTopic(t1.id, { name: "睡眠觀察", dayStartHour: null });
      if (db) assert.equal(db.batches.length, beforeNoop);

      // 封存與重排
      await repo.archiveStatTopic(t2.id, true);
      assert.ok((await repo.getStatTopic(t2.id)).archived_at);
      await repo.archiveStatTopic(t2.id, false);
      assert.equal((await repo.getStatTopic(t2.id)).archived_at, null);

      await repo.reorderStatTopics([t2.id, t1.id]);
      assert.deepEqual(
        (await repo.listStatTopics()).map((r: { id: string }) => r.id),
        [t2.id, t1.id],
      );

      // 軟刪與復原
      await repo.deleteStatTopic(t1.id);
      assert.equal(await repo.getStatTopic(t1.id), null);
      assert.ok((await repo.getStatTopic(t1.id, { withDeleted: true })).deleted_at);
      if (db) {
        const op = db.batches[db.batches.length - 1][0];
        assert.equal(op.op, "delete");
      }

      await repo.restoreStatTopic(t1.id);
      assert.equal((await repo.getStatTopic(t1.id)).deleted_at, null);
    });

    test("upsertStatTopic 可新建、更新並復活墓碑", async () => {
      const { repo } = make();
      const id = "00000000-0000-4000-8000-000000000099";
      const created = await repo.upsertStatTopic({ id, name: "夜讀", dayStartHour: 20 });
      assert.equal(created.id, id);
      assert.equal(created.day_start_hour, 20);

      await repo.deleteStatTopic(id);
      assert.equal(await repo.getStatTopic(id), null);

      const revived = await repo.upsertStatTopic({ id, name: "夜讀・復活", dayStartHour: 19 });
      assert.equal(revived.deleted_at, null);
      assert.equal(revived.name, "夜讀・復活");
      assert.equal(revived.day_start_hour, 19);
    });

    test("輸入驗證：空名稱、壞 JSON、切日時間越界皆拋 RangeError", async () => {
      const { repo } = make();
      await assert.rejects(() => repo.createStatTopic({ name: "  " }), RangeError);
      await assert.rejects(() => repo.createStatTopic({ name: "a", scope: "[]" }), RangeError);
      await assert.rejects(() => repo.createStatTopic({ name: "a", scope: "{" }), RangeError);
      await assert.rejects(() => repo.createStatTopic({ name: "a", dayStartHour: -1 }), RangeError);
      await assert.rejects(() => repo.createStatTopic({ name: "a", dayStartHour: 24 }), RangeError);
      await assert.rejects(() => repo.createStatTopic({ name: "a", dayStartHour: 18.5 }), RangeError);
    });
  });

  describe(`${name}：time_routines 生效區間 start_day / end_day`, () => {
    const ITEMS = [{ cat: "c-create", s: "09:00", e: "12:00" }];

    test("createRoutine / updateRoutine 讀寫 start_day 與 end_day 並進 sync op", async () => {
      const { repo, db } = make();
      const r = await repo.createRoutine({
        name: "115-1 學期",
        items: ITEMS,
        weekdays: WEEKDAYS_EVERY,
        startDay: "2026-09-01",
        endDay: "2027-01-15",
      });
      assert.equal(r.start_day, "2026-09-01");
      assert.equal(r.end_day, "2027-01-15");
      if (db) {
        const op = db.batches[db.batches.length - 1][0];
        assert.equal(op.cols.start_day, "2026-09-01");
        assert.equal(op.cols.end_day, "2027-01-15");
      }

      // 清除結束日（空字串／null）
      await repo.updateRoutine(r.id, { endDay: null });
      const after = await repo.getRoutine(r.id);
      assert.equal(after.start_day, "2026-09-01");
      assert.equal(after.end_day, null);

      // 不合法日期與倒置區間拋 RangeError
      await assert.rejects(() => repo.updateRoutine(r.id, { endDay: "2026-02-30" }), RangeError);
      await assert.rejects(() => repo.updateRoutine(r.id, { endDay: "2026-08-31" }), RangeError);
    });

    test("autoRoutineFor 與 isRoutineActiveOn 依 start_day / end_day 邊界過濾", async () => {
      const { repo } = make();
      const sem = await repo.createRoutine({
        name: "學期課表",
        items: ITEMS,
        weekdays: WEEKDAYS_EVERY,
        startDay: "2026-09-01",
        endDay: "2026-09-30",
      });
      const fallback = await repo.createRoutine({
        name: "常駐作息",
        items: ITEMS,
        weekdays: WEEKDAYS_EVERY,
      });
      const list = [sem, fallback];
      assert.equal(isRoutineActiveOn(sem, "2026-08-31"), false);
      assert.equal(isRoutineActiveOn(sem, "2026-09-01"), true);
      assert.equal(isRoutineActiveOn(sem, "2026-09-30"), true);
      assert.equal(isRoutineActiveOn(sem, "2026-10-01"), false);

      assert.equal(autoRoutineFor("2026-08-31", list)?.id, fallback.id);
      assert.equal(autoRoutineFor("2026-09-01", list)?.id, sem.id);
      assert.equal(autoRoutineFor("2026-09-30", list)?.id, sem.id);
      assert.equal(autoRoutineFor("2026-10-01", list)?.id, fallback.id);
    });
  });
}
