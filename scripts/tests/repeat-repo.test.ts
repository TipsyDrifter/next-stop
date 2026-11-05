/**
 * ⑥ 重複任務補完——SQLite 版與記憶體版跑同一套（D-主-293 跑完到站、D-主-295 單次改日期、D-主-296 覆寫、D-主-298 子樹）。
 * 跑法：`node --test scripts/tests/repeat-repo.test.ts`。載入法同 core-polish7-sqlite.test.ts：
 * node:sqlite 記憶體庫＋migrations 全跑；`../lib/db`、`./syncRepository` 換替身（op 記下來給同步測試看）。
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
let t = Date.now();
export function getDb() { return Promise.resolve(globalThis.__repeatDb); }
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
  const ops: { tbl: string; row_id: string; op: string; cols: Record<string, unknown> }[] = [];
  (globalThis as Record<string, unknown>).__repeatOps = ops;
  return {
    async select(sql: string, args?: unknown[]) {
      return raw.prepare(sql).all(bind(args)).map((r) => ({ ...r }));
    },
    async execute(sql: string, args?: unknown[]) {
      raw.prepare(sql).run(bind(args));
      return { rowsAffected: 0 };
    },
    runBatch(stmts: { sql: string; args: unknown[] }[], batchOps: typeof ops) {
      raw.exec("BEGIN");
      try {
        for (const st of stmts) raw.prepare(st.sql).run(bind(st.args));
        raw.exec("COMMIT");
        ops.push(...(batchOps ?? []));
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      }
    },
  };
}

const { addDays, todayKey } = await import("../../src/lib/date.ts");
const { SqliteNodeRepository } = await import("../../src/data/sqliteNodeRepository.ts");
const { MemoryNodeRepository } = await import("../../src/data/memoryRepository.ts");
const { fixedRule, afterRule, parseRule, firstFixedDate } = await import("../../src/domain/repeat.ts");
const { isRetiredRunRow } = await import("../../src/domain/retiredRun.ts");

const H = 6;
const TODAY = todayKey(H);
const TOMORROW = addDays(TODAY, 1);
const opts = { dateKey: TODAY, dayStartHour: H };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Repo = any;
const makers: [string, () => Repo][] = [
  [
    "sqlite",
    () => {
      (globalThis as Record<string, unknown>).__repeatDb = makeDb();
      return new SqliteNodeRepository();
    },
  ],
  ["memory", () => new MemoryNodeRepository()],
];

async function route(repo: Repo) {
  const line = await repo.create({ kind: "line", name: "生活", parentId: null });
  return repo.create({ kind: "route", name: "家事", parentId: line.id });
}

async function daily(repo: Repo, patch: Record<string, unknown> = {}) {
  const r = await route(repo);
  const train = await repo.create({ kind: "train", name: "例行", parentId: r.id });
  const t = await repo.create({ kind: "ticket", name: "背單字", parentId: train.id, scheduledOn: TODAY });
  await repo.setRepeatRule(t.id, { ...fixedRule("daily", TODAY), ...patch }, TODAY, H);
  return t;
}

async function chore(repo: Repo, rule = fixedRule("daily", TODAY)) {
  const r = await route(repo);
  const train = await repo.create({ kind: "train", name: "大掃除", parentId: r.id });
  const a = await repo.create({ kind: "ticket", name: "吸地", parentId: train.id });
  const b = await repo.create({ kind: "ticket", name: "拖地", parentId: train.id });
  await repo.setRepeatRule(train.id, rule, TODAY, H);
  return { train, a, b };
}

for (const [name, make] of makers) {
  describe(`${name}：跑完到站`, () => {
    test("做滿 N 次：最後一枚済後自動到站、不多長章；運休不扣次數", async () => {
      const repo = make();
      const t = await daily(repo, { count: 1 });
      await repo.skipOccurrence(t.id, true, TODAY, H);
      assert.equal((await repo.getNode(t.id)).status, "todo", "運休不算一次");
      assert.equal((await repo.getNode(t.id)).scheduled_on, TOMORROW);
      await repo.setCompleted(t.id, true, { dateKey: TOMORROW, dayStartHour: H });
      const n = await repo.getNode(t.id);
      assert.equal(n.status, "done");
      const [occ] = (await repo.listOccurrences(t.id)).filter((o: { status: string }) => o.status === "done");
      assert.equal(n.completed_at, occ.completed_at, "跟最後一枚済同一刻，済的口徑才不會多算");
      assert.equal(n.scheduled_on, TOMORROW);
    });

    test("到某天為止：最後一班沒交代前不到站，留在誤點", async () => {
      const repo = make();
      const t = await daily(repo, { until: TODAY });
      const later = addDays(TODAY, 5);
      await repo.syncRepeats(later, H);
      const n = await repo.getNode(t.id);
      assert.equal(n.status, "todo");
      assert.equal(n.scheduled_on, TODAY);
      await repo.skipOccurrence(t.id, true, later, H);
      assert.equal((await repo.getNode(t.id)).status, "done", "運休交代了最後一班也算跑完");
      assert.equal((await repo.getNode(t.id)).completed_at, null, "一班都沒済過不算済章");
    });

    test("取消最後一班的済章＝回到運行；今日列不被當成跟著上層退役", async () => {
      const repo = make();
      const t = await daily(repo, { count: 1 });
      await repo.setCompleted(t.id, true, opts);
      const row = (await repo.listToday(TODAY, H)).find((r: { id: string }) => r.id === t.id);
      assert.equal(row.run_ended, true);
      assert.equal(isRetiredRunRow(row), false);
      await repo.setCompleted(t.id, false, opts);
      const n = await repo.getNode(t.id);
      assert.equal(n.status, "todo");
      assert.equal(n.scheduled_on, TODAY);
      assert.equal((await repo.listOccurrences(t.id)).length, 0);
    });

    test("取消最後一班的運休＝回到運行", async () => {
      const repo = make();
      const t = await daily(repo, { until: TODAY });
      await repo.skipOccurrence(t.id, true, TODAY, H);
      assert.equal((await repo.getNode(t.id)).status, "done");
      await repo.skipOccurrence(t.id, false, TODAY, H, TODAY);
      assert.equal((await repo.getNode(t.id)).status, "todo");
    });

    test("改規則放寬＝回到運行；跟著上層退役的不會被復活", async () => {
      const repo = make();
      const t = await daily(repo, { count: 1 });
      await repo.setCompleted(t.id, true, opts);
      assert.equal((await repo.getNode(t.id)).status, "done");
      await repo.setRepeatRule(t.id, { ...fixedRule("daily", TODAY), count: 3 }, TODAY, H);
      const n = await repo.getNode(t.id);
      assert.equal(n.status, "todo");
      assert.equal(n.scheduled_on, TOMORROW);

      const r = await route(repo);
      const train = await repo.create({ kind: "train", name: "上層", parentId: r.id });
      const u = await repo.create({ kind: "ticket", name: "不限次", parentId: train.id, scheduledOn: TODAY });
      await repo.setRepeatRule(u.id, fixedRule("daily", TODAY), TODAY, H);
      await repo.setCompleted(train.id, true, { cascade: true, ...opts });
      assert.equal((await repo.getNode(u.id)).status, "done");
      await repo.setRepeatRule(u.id, { ...fixedRule("daily", TODAY), count: 3 }, TODAY, H);
      assert.equal((await repo.getNode(u.id)).status, "done", "規則本來就沒跑完，是人讓它停的");
    });
  });

  describe(`${name}：單次改日期`, () => {
    test("明天那班改到後天：日曆跟著動、下一班不受影響、規則只多一格 moves", async () => {
      const repo = make();
      const r = await route(repo);
      const train = await repo.create({ kind: "train", name: "例行", parentId: r.id });
      const t = await repo.create({ kind: "ticket", name: "隔天班", parentId: train.id, scheduledOn: TODAY });
      await repo.setRepeatRule(t.id, fixedRule("daily", TODAY, { interval: 3 }), TODAY, H);
      const from = addDays(TODAY, 3);
      const to = addDays(TODAY, 4);
      await repo.moveOccurrence(t.id, from, to, TODAY, H);
      const rule = parseRule((await repo.getNode(t.id)).repeat_rule);
      assert.deepEqual(rule.moves, { [from]: to });
      const days = (await repo.listSchedule(TODAY, addDays(TODAY, 7), { todayDateKey: TODAY, dayStartHour: H })).filter((e: { node_id: string }) => e.node_id === t.id).map((e: { date: string }) => e.date);
      assert.deepEqual(days, [TODAY, to, addDays(TODAY, 6)]);
      await repo.moveOccurrence(t.id, to, from, TODAY, H);
      assert.equal("moves" in parseRule((await repo.getNode(t.id)).repeat_rule), false, "改回原日規則回到原樣");
    });

    test("今天那班改走：目前班次跟著走；時刻覆寫搬過去", async () => {
      const repo = make();
      const r = await route(repo);
      const train = await repo.create({ kind: "train", name: "例行", parentId: r.id });
      const t = await repo.create({ kind: "ticket", name: "週班", parentId: train.id, scheduledOn: TODAY });
      const weekday = new Date(`${TODAY}T12:00:00`).getDay();
      await repo.setRepeatRule(t.id, fixedRule("weekly", TODAY, { byweekday: [weekday] }), TODAY, H);
      await repo.setRunTime(t.id, TODAY, "14:00", H);
      await repo.moveOccurrence(t.id, TODAY, TOMORROW, TODAY, H);
      const n = await repo.getNode(t.id);
      assert.equal(n.scheduled_on, TOMORROW);
      assert.deepEqual(JSON.parse(n.time_overrides), { [TOMORROW]: "14:00" });
    });

    test("擋下的情況回原因，不寫資料", async () => {
      const repo = make();
      const t = await daily(repo);
      await assert.rejects(() => repo.moveOccurrence(t.id, TODAY, TOMORROW, TODAY, H), /已經有一班/);
      await assert.rejects(() => repo.moveOccurrence(t.id, TODAY, addDays(TODAY, -1), TODAY, H), /今天以後/);
      assert.equal("moves" in parseRule((await repo.getNode(t.id)).repeat_rule), false);
    });

    test("完成後間隔：改目前這一班，交代後錨點一變就失效", async () => {
      const repo = make();
      const r = await route(repo);
      const train = await repo.create({ kind: "train", name: "例行", parentId: r.id });
      const t = await repo.create({ kind: "ticket", name: "澆水", parentId: train.id, scheduledOn: TODAY });
      await repo.setRepeatRule(t.id, afterRule(3, TODAY), TODAY, H);
      await repo.moveOccurrence(t.id, TODAY, TOMORROW, TODAY, H);
      assert.equal((await repo.getNode(t.id)).scheduled_on, TOMORROW);
    });
  });

  describe(`${name}：改規則與覆寫（D-主-296）`, () => {
    test("今天已済那班的時刻覆寫，換排程也留著；未來還沒交代的清掉", async () => {
      const repo = make();
      const t = await daily(repo);
      await repo.setRunTime(t.id, TODAY, "09:00", H);
      await repo.setRunTime(t.id, TOMORROW, "10:00", H);
      await repo.setCompleted(t.id, true, opts);
      await repo.setRepeatRule(t.id, fixedRule("daily", TODAY, { interval: 2 }), TODAY, H);
      const over = JSON.parse((await repo.getNode(t.id)).time_overrides);
      assert.equal(over[TODAY], "09:00");
      assert.equal(over[TOMORROW], undefined);
    });

    test("只改結束條件：未來的覆寫與改過的日期都留著", async () => {
      const repo = make();
      const t = await daily(repo, { interval: 3 });
      const from = addDays(TODAY, 3);
      const to = addDays(TODAY, 4);
      await repo.setRunTime(t.id, addDays(TODAY, 6), "10:00", H);
      await repo.moveOccurrence(t.id, from, to, TODAY, H);
      await repo.setRepeatRule(t.id, { ...fixedRule("daily", TODAY, { interval: 3 }), until: addDays(TODAY, 30) }, TODAY, H);
      const n = await repo.getNode(t.id);
      assert.equal(JSON.parse(n.time_overrides)[addDays(TODAY, 6)], "10:00");
      assert.deepEqual(parseRule(n.repeat_rule).moves, { [from]: to });
    });

    test("換排程：還沒交代的改日期清掉；清成不重複全清", async () => {
      const repo = make();
      const t = await daily(repo, { interval: 3 });
      await repo.moveOccurrence(t.id, addDays(TODAY, 3), addDays(TODAY, 4), TODAY, H);
      await repo.setRepeatRule(t.id, fixedRule("daily", TODAY, { interval: 2 }), TODAY, H);
      assert.equal("moves" in parseRule((await repo.getNode(t.id)).repeat_rule), false);
      await repo.setRunTime(t.id, addDays(TODAY, -1), "08:00", H);
      await repo.setRepeatRule(t.id, null, TODAY, H);
      assert.equal((await repo.getNode(t.id)).repeat_rule, null);
    });

    test("呼叫端帶的 moves 不算數（寫入的唯一入口是 moveOccurrence）", async () => {
      const repo = make();
      const t = await daily(repo);
      await repo.setRepeatRule(t.id, { ...fixedRule("daily", TODAY), moves: { [TODAY]: addDays(TODAY, 9) } }, TODAY, H);
      assert.equal("moves" in parseRule((await repo.getNode(t.id)).repeat_rule), false);
    });
  });

  describe(`${name}：整棵子樹掛重複（D-主-298）`, () => {
    test("有子項的列車能掛；上層或子孫已有定期券就擋", async () => {
      const repo = make();
      const { train, a } = await chore(repo);
      assert.ok(parseRule((await repo.getNode(train.id)).repeat_rule));
      await assert.rejects(() => repo.setRepeatRule(a.id, fixedRule("daily", TODAY), TODAY, H), /不能再掛定期券/);
      const r = await route(repo);
      const up = await repo.create({ kind: "train", name: "上層", parentId: r.id });
      const kid = await repo.create({ kind: "ticket", name: "子", parentId: up.id });
      await repo.setRepeatRule(kid.id, fixedRule("daily", TODAY), TODAY, H);
      await assert.rejects(() => repo.setRepeatRule(up.id, fixedRule("daily", TODAY), TODAY, H), /不能再掛定期券/);
    });

    test("蓋完一班：子項全部回未完成，這次的済記成班次；連帶完成的也算", async () => {
      const repo = make();
      const { train, a, b } = await chore(repo);
      await repo.setCompleted(a.id, true, opts);
      const aDoneAt = (await repo.getNode(a.id)).completed_at;
      const ids = await repo.setCompleted(train.id, true, { cascade: true, ...opts });
      assert.ok(ids.includes(b.id));
      for (const k of [a, b]) {
        const n = await repo.getNode(k.id);
        assert.equal(n.status, "todo");
        assert.equal(n.completed_at, null);
      }
      const occA = await repo.listOccurrences(a.id);
      assert.deepEqual(occA.map((o: { due_on: string; completed_at: string }) => [o.due_on, o.completed_at]), [[TODAY, aDoneAt]]);
      assert.equal((await repo.listOccurrences(b.id)).length, 1);
      assert.equal((await repo.getNode(train.id)).scheduled_on, TOMORROW);
    });

    test("子項的日期跟著平移，取消済章一起還原", async () => {
      const repo = make();
      const { train, a, b } = await chore(repo);
      await repo.update(a.id, { due_on: addDays(TODAY, 2) }, TODAY, H);
      await repo.setCompleted(a.id, true, opts);
      await repo.setCompleted(train.id, true, { cascade: true, ...opts });
      assert.equal((await repo.getNode(a.id)).due_on, addDays(TODAY, 3));
      await repo.setCompleted(train.id, false, opts);
      const na = await repo.getNode(a.id);
      assert.equal(na.status, "done", "自己先蓋的回到已完成");
      assert.equal(na.due_on, addDays(TODAY, 2));
      assert.equal((await repo.getNode(b.id)).status, "todo", "連帶完成的回到未完成");
      assert.equal((await repo.listOccurrences(a.id)).length, 0);
      assert.equal((await repo.listOccurrences(b.id)).length, 0);
    });

    test("取消最後一班的済：連帶蓋的回未完成，自己先蓋的留著（⑥ 沙盒 F-3）", async () => {
      const repo = make();
      const { train, a, b } = await chore(repo, { ...fixedRule("daily", TODAY), until: TODAY });
      await repo.setCompleted(a.id, true, opts);
      await repo.setCompleted(train.id, true, { cascade: true, ...opts });
      assert.equal((await repo.getNode(train.id)).status, "done");
      assert.equal((await repo.getNode(b.id)).status, "done");
      await repo.setCompleted(train.id, false, opts);
      assert.equal((await repo.getNode(train.id)).status, "todo");
      assert.equal((await repo.getNode(a.id)).status, "done");
      assert.equal((await repo.getNode(b.id)).status, "todo");
      const logs = await repo.listWorkLogs(b.id);
      assert.equal(logs.filter((l: { event: string }) => l.event === "done").length, 0, "連帶那枚済要收回");
    });

    test("放寬規則回運行：最後一班的子項接著下一班，這次的済記成班次（⑥ 沙盒 F-3）", async () => {
      const repo = make();
      const { train, a } = await chore(repo, { ...fixedRule("daily", TODAY), until: TODAY });
      await repo.setCompleted(train.id, true, { cascade: true, ...opts });
      await repo.setRepeatRule(train.id, fixedRule("daily", TODAY), TODAY, H);
      assert.equal((await repo.getNode(train.id)).status, "todo");
      assert.equal((await repo.getNode(a.id)).status, "todo");
      assert.equal((await repo.listOccurrences(a.id)).length, 1);
    });

    test("最後一班跑完不重置，子項留在已完成；運休不動子項", async () => {
      const repo = make();
      const { train, a, b } = await chore(repo, { ...fixedRule("daily", TODAY), count: 1 });
      await repo.setCompleted(a.id, true, opts);
      await repo.skipOccurrence(train.id, true, TODAY, H);
      assert.equal((await repo.getNode(a.id)).status, "done", "運休不動子項");
      await repo.setCompleted(train.id, true, { cascade: true, dateKey: TOMORROW, dayStartHour: H });
      assert.equal((await repo.getNode(train.id)).status, "done");
      assert.equal((await repo.getNode(a.id)).status, "done");
      assert.equal((await repo.getNode(b.id)).status, "done");
    });
  });

  describe(`${name}：行程表投影`, () => {
    test("做滿 N 次：日曆只畫剩下的班；bounds 有盡頭", async () => {
      const repo = make();
      const t = await daily(repo, { count: 2 });
      const days = (await repo.listSchedule(TODAY, addDays(TODAY, 10), { todayDateKey: TODAY, dayStartHour: H })).filter((e: { node_id: string }) => e.node_id === t.id).map((e: { date: string }) => e.date);
      assert.deepEqual(days, [TODAY, TOMORROW]);
      const bounds = await repo.scheduleBounds();
      assert.equal(bounds.openEndedRepeat, false);
      assert.equal(bounds.latest >= TOMORROW, true);
    });

    test("firstFixedDate 認得改過來的那天（overrideKeepOf 的讀取守門靠它）", () => {
      const rule = { ...fixedRule("weekly", TODAY, { byweekday: [new Date(`${TODAY}T12:00:00`).getDay()] }), moves: { [TODAY]: TOMORROW } };
      assert.equal(firstFixedDate(rule, TOMORROW), TOMORROW);
    });
  });
}

describe("sqlite：同步", () => {
  test("同一班反悔再蓋、改回原日：復活舊列的 op 不帶 created_at（⑥ 沙盒 F-6）", async () => {
    (globalThis as Record<string, unknown>).__repeatDb = makeDb();
    const repo = new SqliteNodeRepository();
    const t = await daily(repo);
    const ops = (globalThis as unknown as { __repeatOps: { tbl: string; op: string; cols: Record<string, unknown> }[] }).__repeatOps;
    await repo.setCompleted(t.id, true, opts);
    assert.ok(ops.filter((o) => o.tbl === "occurrences").some((o) => "created_at" in o.cols), "第一次新建要帶");
    await repo.setCompleted(t.id, false, opts);
    ops.length = 0;
    await repo.setCompleted(t.id, true, opts);
    const again = ops.filter((o) => o.tbl === "occurrences");
    assert.equal(again.length, 1);
    assert.equal("created_at" in again[0].cols, false);
  });

  test("跑完到站的 status 進 oplog；執行日推導不進；子項重置與班次記錄都進", async () => {
    (globalThis as Record<string, unknown>).__repeatDb = makeDb();
    const repo = new SqliteNodeRepository();
    const { train, a } = await chore(repo, { ...fixedRule("daily", TODAY), count: 2 });
    const ops = (globalThis as unknown as { __repeatOps: { tbl: string; row_id: string; cols: Record<string, unknown> }[] }).__repeatOps;
    ops.length = 0;
    await repo.setCompleted(a.id, true, opts);
    await repo.setCompleted(train.id, true, { cascade: true, ...opts });
    const reset = ops.filter((o) => o.tbl === "nodes" && o.row_id === a.id && o.cols.status === "todo");
    assert.equal(reset.length, 1);
    assert.ok(ops.some((o) => o.tbl === "occurrences" && o.row_id === `${a.id}|${TODAY}`));

    ops.length = 0;
    await repo.setCompleted(train.id, true, { cascade: true, dateKey: TOMORROW, dayStartHour: H });
    const end = ops.find((o) => o.tbl === "nodes" && o.row_id === train.id && o.cols.status === "done");
    assert.ok(end, "到站要同步");
    assert.equal("scheduled_on" in end.cols, false, "執行日是推導值，不進 oplog");
  });
});
