/**
 * 同步引擎班——逐班時刻覆寫拆列（D-主-120）＋退役執行日＝最後一班（D-主-122，#103）。
 * 跑法：`node --test scripts/tests/sync-engine-time-overrides.test.ts`（node 24，型別剝除預設開；零依賴）。
 *
 * SQLite：node:sqlite 記憶體庫＋`src-tauri/migrations` 全部依序跑；`../lib/db` 換成回這顆庫的替身、`./syncRepository`
 * 換成照順序執行 SQL、並把 op 收進 `globalThis.__steOps` 的假批次（真的 oplog／apply 那半由沙盒驗）。
 * 記憶體版跑同一組語義題（?mock=1 與 SQLite 不得分岐）。載入法同 `core-polish7-sqlite.test.ts`。
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
export function getDb() { return Promise.resolve(globalThis.__steDb); }
export function uuid() { return crypto.randomUUID(); }
export function nowUtcIso() { t += 1000; return new Date(t).toISOString(); }
`;
const FAKE_SYNC = `
export function newWriteBatch() { return { stmts: [], ops: [] }; }
export async function runWriteBatch(db, stmts, ops) { db.runBatch(stmts); (globalThis.__steOps ??= []).push(...ops); }
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

type Raw = InstanceType<typeof DatabaseSync>;
function makeDb() {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = OFF");
  const dir = path.join(ROOT, "src-tauri/migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) raw.exec(readFileSync(path.join(dir, f), "utf8"));
  const bind = (args: unknown[] = []) => Object.fromEntries(args.map((v, i) => ["$" + (i + 1), v])) as Record<string, never>;
  return {
    raw,
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
type Db = ReturnType<typeof makeDb>;

const { addDays, todayKey } = await import("../../src/lib/date.ts");
const { uuidv5 } = await import("../../src/lib/uuidv5.ts");
const { SqliteNodeRepository } = await import("../../src/data/sqliteNodeRepository.ts");
const { MemoryNodeRepository } = await import("../../src/data/memoryRepository.ts");
const { fixedRule, afterRule, serializeRule } = await import("../../src/domain/repeat.ts");
const {
  OVERRIDE_ID_NAMESPACE,
  overrideId,
  overridesFromRows,
  parseTimeOverrides,
  effectiveTime,
} = await import("../../src/domain/scheduledTime.ts");
const { attachTimeOverrides, overrideKeepOf, retiredScheduledOn, retiredWasDueToday } = await import(
  "../../src/data/nodeRepository.ts"
);

const H = 6;
const TODAY = todayKey(H);
const dow = (key: string) => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).getDay();
};
/** 每週「今天這個星期幾」，起算四週前：TODAY、TODAY±7 是班次日，TODAY±1 不是 */
const weeklyToday = () => fixedRule("weekly", addDays(TODAY, -28), { byweekday: [dow(TODAY)] });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/* ───────────── 純函式 ───────────── */

describe("純函式：id／摺表／守門／f", () => {
  test("overrideId＝uuid v5(namespace, `node|date`)，同鍵同 id、不同班不同 id", async () => {
    const a = await overrideId("n1", "2026-10-19");
    assert.equal(a, await uuidv5(OVERRIDE_ID_NAMESPACE, "n1|2026-10-19"));
    assert.equal(a, await overrideId("n1", "2026-10-19"), "兩台算出同一個 id");
    assert.notEqual(a, await overrideId("n1", "2026-10-20"));
    assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test("overridesFromRows：丟已刪／壞日期／壞時刻；null＝本班無時刻；keep 守門", () => {
    const rows = [
      { node_id: "n", due_on: "2026-10-19", hhmm: "09:30" },
      { node_id: "n", due_on: "2026-10-20", hhmm: null },
      { node_id: "n", due_on: "2026-10-21", hhmm: "10:00", deleted_at: "2026-10-01T00:00:00.000Z" },
      { node_id: "n", due_on: "10/22", hhmm: "10:00" },
      { node_id: "n", due_on: "2026-10-23", hhmm: "9:00" },
    ];
    assert.deepEqual(overridesFromRows(rows), { "2026-10-19": "09:30", "2026-10-20": null });
    assert.deepEqual(overridesFromRows(rows, (d) => d !== "2026-10-20"), { "2026-10-19": "09:30" });
  });

  test("overrideKeepOf：固定排程擋「未來的非班次日」；過去的、起算日前的、班次日放行；間隔規則與無規則不擋", () => {
    const keep = overrideKeepOf(serializeRule(weeklyToday()), TODAY)!;
    assert.equal(keep(addDays(TODAY, 7)), true, "未來班次日");
    assert.equal(keep(addDays(TODAY, 1)), false, "未來非班次日（換規則後對面併發設的）");
    assert.equal(keep(TODAY), true, "今天是班次日");
    assert.equal(keep(addDays(TODAY, -1)), true, "過去的是歷史（D-主-32）");
    const late = fixedRule("weekly", addDays(TODAY, 3), { byweekday: [dow(TODAY)] });
    assert.equal(overrideKeepOf(serializeRule(late), TODAY)!(addDays(TODAY, 1)), true, "起算日以前不擋");
    assert.equal(overrideKeepOf(serializeRule(afterRule(3, TODAY)), TODAY), undefined);
    assert.equal(overrideKeepOf(null, TODAY), undefined);
  });

  test("attachTimeOverrides：沒列＝null（舊欄殘值不漏出）；有列摺成排序 JSON；守門套用", () => {
    const rule = serializeRule(weeklyToday());
    const nodes = [
      { id: "a", repeat_rule: rule, time_overrides: '{"2000-01-01":"01:00"}' },
      { id: "b", repeat_rule: rule, time_overrides: null },
    ];
    attachTimeOverrides(
      nodes,
      [
        { node_id: "b", due_on: addDays(TODAY, 7), hhmm: "10:00" },
        { node_id: "b", due_on: TODAY, hhmm: "09:30" },
        { node_id: "b", due_on: addDays(TODAY, 1), hhmm: "11:00" },
      ],
      TODAY,
    );
    assert.equal(nodes[0].time_overrides, null);
    assert.equal(nodes[1].time_overrides, JSON.stringify({ [TODAY]: "09:30", [addDays(TODAY, 7)]: "10:00" }));
  });

  test("f＝retiredScheduledOn：有済取最後一班；只有運休或一班都沒有＝null", () => {
    const o = (due_on: string, status: "done" | "skipped") => ({ due_on, status });
    assert.equal(retiredScheduledOn([o("2026-10-20", "done"), o("2026-10-22", "done"), o("2026-10-23", "skipped")]), "2026-10-22");
    assert.equal(retiredScheduledOn([o("2026-10-23", "skipped")]), null);
    assert.equal(retiredScheduledOn([]), null);
  });

  test("retiredWasDueToday：退役當下目前班次已到（≤ 今天）才算本來就在今天", () => {
    const daily = serializeRule(fixedRule("daily", addDays(TODAY, -7)));
    const fromTomorrow = serializeRule(fixedRule("daily", addDays(TODAY, 1)));
    assert.equal(retiredWasDueToday({ repeat_rule: daily }, [], TODAY, H), true);
    assert.equal(retiredWasDueToday({ repeat_rule: fromTomorrow }, [], TODAY, H), false);
    assert.equal(retiredWasDueToday({ repeat_rule: null }, [], TODAY, H), false);
  });
});

/* ───────────── 兩種實作同一組語義 ───────────── */

const makers: [string, () => Any][] = [
  [
    "sqlite",
    () => {
      (globalThis as Record<string, unknown>).__steDb = makeDb();
      (globalThis as Record<string, unknown>).__steOps = [];
      return new SqliteNodeRepository();
    },
  ],
  ["memory", () => new MemoryNodeRepository()],
];

async function mkWeekly(repo: Any, name = "背單字") {
  const t = await repo.create({ kind: "ticket", name, parentId: null, scheduledOn: TODAY });
  await repo.setRepeatRule(t.id, weeklyToday(), TODAY, H);
  await repo.update(t.id, { scheduled_time: "07:00" }, { dayStartHour: H });
  return t;
}

async function trainWithDaily(repo: Any, start = addDays(TODAY, -7)) {
  const line = await repo.create({ kind: "line", name: "日語", parentId: null });
  const route = await repo.create({ kind: "route", name: "N5", parentId: line.id });
  const train = await repo.create({ kind: "train", name: "N5 文法", parentId: route.id, scheduledOn: TODAY });
  const daily = await repo.create({ kind: "ticket", name: "背 N5 單字", parentId: train.id, scheduledOn: TODAY });
  await repo.setRepeatRule(daily.id, fixedRule("daily", start), TODAY, H);
  return { train, daily };
}

const overridesOf = async (repo: Any, id: string) => parseTimeOverrides((await repo.getNode(id))?.time_overrides);

for (const [name, make] of makers) {
  describe(`${name}：逐班時刻拆列（D-主-120）`, () => {
    test("兩班各自設、各自清——互不吃掉（#86 的本機面）", async () => {
      const repo = make();
      const t = await mkWeekly(repo);
      const next = addDays(TODAY, 7);
      await repo.setRunTime(t.id, TODAY, "09:30", H);
      await repo.setRunTime(t.id, next, null, H);
      assert.deepEqual(await overridesOf(repo, t.id), { [TODAY]: "09:30", [next]: null });
      const n = await repo.getNode(t.id);
      assert.equal(effectiveTime(n, TODAY), "09:30");
      assert.equal(effectiveTime(n, next), null);
      assert.equal(effectiveTime(n, addDays(TODAY, 14)), "07:00");
      await repo.clearRunTime(t.id, TODAY);
      assert.deepEqual(await overridesOf(repo, t.id), { [next]: null });
      await repo.clearRunTime(t.id, TODAY); // 已經沒有：no-op、不 throw
      await repo.setRunTime(t.id, TODAY, "08:00", H); // 清過再設＝同一列復活
      assert.deepEqual(await overridesOf(repo, t.id), { [TODAY]: "08:00", [next]: null });
    });

    test("換規則＝軟刪班次日 ≥ 今天的列、過去的留著；清規則＝全刪", async () => {
      const repo = make();
      const t = await repo.create({ kind: "ticket", name: "每日", parentId: null, scheduledOn: TODAY });
      await repo.setRepeatRule(t.id, fixedRule("daily", addDays(TODAY, -28)), TODAY, H);
      await repo.setRunTime(t.id, addDays(TODAY, -3), "08:00", H);
      await repo.setRunTime(t.id, TODAY, "09:30", H);
      await repo.setRunTime(t.id, addDays(TODAY, 2), "10:00", H);
      await repo.setRepeatRule(t.id, weeklyToday(), TODAY, H);
      assert.deepEqual(await overridesOf(repo, t.id), { [addDays(TODAY, -3)]: "08:00" });
      await repo.setRepeatRule(t.id, null, TODAY, H);
      assert.equal((await repo.getNode(t.id)).time_overrides, null);
    });

    test("B1：沒規則的票帶殘留覆寫列，update({scheduled_time}) 把列軟刪", async () => {
      const repo = make();
      const t = await mkWeekly(repo, "殘留");
      await repo.setRunTime(t.id, addDays(TODAY, 7), "09:45", H);
      // 造殘留：跨機「A 清規則、B 設本班時刻」——這裡直接把規則拿掉、列留著（模擬同步灌進來的狀態）
      if (name === "sqlite") {
        (globalThis as Any).__steDb.raw.prepare("UPDATE nodes SET repeat_rule = NULL WHERE id = ?").run(t.id);
      } else {
        const m = (repo as Any).nodes as Map<string, Any>;
        m.set(t.id, { ...m.get(t.id), repeat_rule: null });
      }
      assert.notEqual((await repo.getNode(t.id)).time_overrides, null, "讀得到殘留（B1 才看得見）");
      await repo.update(t.id, { scheduled_time: "08:00" }, { dayStartHour: H });
      assert.equal((await repo.getNode(t.id)).time_overrides, null);
    });

    test("讀取守門：併發復活、落在新規則未來非班次日的覆寫被忽略；班次日的照常生效", async () => {
      const repo = make();
      const t = await mkWeekly(repo);
      const nonRun = addDays(TODAY, 1);
      const run = addDays(TODAY, 7);
      // 模擬對面那台的列被同步進來（這台的 writeRunTime 不會寫非班次日以外的東西，所以直接灌）
      if (name === "sqlite") {
        const raw: Raw = (globalThis as Any).__steDb.raw;
        for (const [d, hh] of [[nonRun, "11:00"], [run, "12:00"]] as const) {
          raw
            .prepare("INSERT INTO node_time_overrides (id, node_id, due_on, hhmm) VALUES (?, ?, ?, ?)")
            .run(await overrideId(t.id, d), t.id, d, hh);
        }
      } else {
        const ovr = (repo as Any).ovr as Map<string, Any>;
        for (const [d, hh] of [[nonRun, "11:00"], [run, "12:00"]] as const) {
          ovr.set(`${t.id}|${d}`, { node_id: t.id, due_on: d, hhmm: hh, deleted_at: null, created_at: "x", updated_at: "x" });
        }
        (repo as Any).refreshOverrides(t.id);
      }
      assert.deepEqual(await overridesOf(repo, t.id), { [run]: "12:00" });
    });
  });

  describe(`${name}：退役執行日＝最後一班（D-主-122）`, () => {
    test("先済再一起完成 ⇒ 執行日＝今天那班（不再凍在被推到的明天）；今日還在、明天不冒", async () => {
      const repo = make();
      const { train, daily } = await trainWithDaily(repo);
      await repo.setCompleted(daily.id, true, { dateKey: TODAY, dayStartHour: H });
      assert.equal((await repo.getNode(daily.id)).scheduled_on, addDays(TODAY, 1), "活著時推到下一班");
      await repo.setCompleted(train.id, true, { cascade: true, dateKey: TODAY, dayStartHour: H });
      const n = await repo.getNode(daily.id);
      assert.equal(n.status, "done");
      assert.equal(n.scheduled_on, TODAY, "f＝最後一筆済的班次日");
      const row = (await repo.listToday(TODAY, H)).find((r: Any) => r.id === daily.id);
      assert.ok(row);
      assert.equal(row.bucket, "today");
      assert.equal(row.occurrence?.status, "done");
      assert.equal((await repo.listToday(addDays(TODAY, 1), H)).some((r: Any) => r.id === daily.id), false);
    });

    test("一班都沒済過就退役 ⇒ 執行日 NULL；今天本來就該跑 ⇒ 今日第四條照收", async () => {
      const repo = make();
      const { train, daily } = await trainWithDaily(repo);
      await repo.setCompleted(train.id, true, { cascade: true, dateKey: TODAY, dayStartHour: H });
      const n = await repo.getNode(daily.id);
      assert.equal(n.status, "done");
      assert.equal(n.scheduled_on, null);
      assert.ok((await repo.listToday(TODAY, H)).some((r: Any) => r.id === daily.id), "第四條 NULL 分支");
      assert.equal((await repo.listToday(addDays(TODAY, 1), H)).some((r: Any) => r.id === daily.id), false);
    });

    test("一班都沒済過、明天才開始跑就被一起完成 ⇒ 不冒進今天（第四條只收本來就在今天的票）", async () => {
      const repo = make();
      const { train, daily } = await trainWithDaily(repo, addDays(TODAY, 1));
      await repo.setCompleted(train.id, true, { cascade: true, dateKey: TODAY, dayStartHour: H });
      assert.equal((await repo.getNode(daily.id)).scheduled_on, null);
      assert.equal((await repo.listToday(TODAY, H)).some((r: Any) => r.id === daily.id), false);
    });

    test("凍住的舊值 ⇒ syncRepeats 收斂成 f，且不碰 updated_at", async () => {
      const repo = make();
      const { train, daily } = await trainWithDaily(repo);
      await repo.setCompleted(daily.id, true, { dateKey: TODAY, dayStartHour: H });
      await repo.setCompleted(train.id, true, { cascade: true, dateKey: TODAY, dayStartHour: H });
      // 模擬舊版留下的凍值（另一台一次收到兩筆時停的那天）
      const frozen = addDays(TODAY, 1);
      if (name === "sqlite") {
        (globalThis as Any).__steDb.raw.prepare("UPDATE nodes SET scheduled_on = ? WHERE id = ?").run(frozen, daily.id);
      } else {
        const m = (repo as Any).nodes as Map<string, Any>;
        m.set(daily.id, { ...m.get(daily.id), scheduled_on: frozen });
      }
      const before = await repo.getNode(daily.id);
      assert.deepEqual(await repo.syncRepeats(TODAY, H), [daily.id]);
      const after = await repo.getNode(daily.id);
      assert.equal(after.scheduled_on, TODAY);
      assert.equal(after.updated_at, before.updated_at, "推導重算不戳 updated_at");
      assert.deepEqual(await repo.syncRepeats(TODAY, H), [], "冪等");
    });

    test("退役解除（取消完成）⇒ 照規則重算回下一班", async () => {
      const repo = make();
      const { train, daily } = await trainWithDaily(repo);
      await repo.setCompleted(daily.id, true, { dateKey: TODAY, dayStartHour: H });
      await repo.setCompleted(train.id, true, { cascade: true, dateKey: TODAY, dayStartHour: H });
      assert.equal((await repo.getNode(daily.id)).scheduled_on, TODAY);
      await repo.setCompleted(daily.id, false, { dateKey: TODAY, dayStartHour: H });
      const n = await repo.getNode(daily.id);
      assert.equal(n.status, "todo");
      assert.equal(n.scheduled_on, addDays(TODAY, 1), "今天那班已済 ⇒ 目前班次＝明天");
    });
  });
}

/* ───────────── SQLite 限定：op 形狀、兩台同鍵、存量搬移 ───────────── */

const ops = (): Any[] => (globalThis as Any).__steOps;
const ntoOps = () => ops().filter((o) => o.tbl === "node_time_overrides");

/** 把一台的 node_time_overrides op 照逐列 LWW 的結果直接套到另一顆庫（同步引擎那半由沙盒驗，這裡只驗「同一列」） */
function applyNto(db: Db, list: Any[]) {
  for (const o of list) {
    const c = o.cols;
    if (o.op === "delete") {
      db.raw.prepare("UPDATE node_time_overrides SET deleted_at = ?, updated_at = ? WHERE id = ?").run(c.deleted_at, c.updated_at, o.row_id);
      continue;
    }
    db.raw
      .prepare(
        `INSERT INTO node_time_overrides (id, node_id, due_on, hhmm, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET hhmm = excluded.hhmm, deleted_at = NULL, updated_at = excluded.updated_at`,
      )
      .run(o.row_id, c.node_id, c.due_on, c.hhmm, c.updated_at);
  }
}

/** 兩台：同一張定期券（id 相同）各在自己的庫裡 */
async function twoDevices() {
  const a = makeDb();
  (globalThis as Any).__steDb = a;
  (globalThis as Any).__steOps = [];
  const repoA = new SqliteNodeRepository();
  const t = await repoA.create({ kind: "ticket", name: "兩台的定期券", parentId: null, scheduledOn: TODAY });
  await repoA.setRepeatRule(t.id, weeklyToday(), TODAY, H);
  const b = makeDb();
  const row = a.raw.prepare("SELECT * FROM nodes WHERE id = ?").get(t.id) as Record<string, never>;
  const cols = Object.keys(row);
  b.raw.prepare(`INSERT INTO nodes (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(...cols.map((k) => row[k]));
  const repoB = new SqliteNodeRepository();
  return { a, b, repoA, repoB, id: t.id };
}
const use = (db: Db) => {
  (globalThis as Any).__steDb = db;
  (globalThis as Any).__steOps = [];
};

describe("sqlite：op 形狀與兩台收斂", () => {
  test("setRunTime ⇒ 一筆 node_time_overrides upsert（row_id＝overrideId）；nodes 不進 op、舊欄不寫", async () => {
    const db = makeDb();
    use(db);
    const repo = new SqliteNodeRepository();
    const t = await mkWeekly(repo);
    (globalThis as Any).__steOps = [];
    await repo.setRunTime(t.id, TODAY, "09:30", H);
    assert.equal(ops().length, 1);
    const [o] = ops();
    assert.equal(o.tbl, "node_time_overrides");
    assert.equal(o.op, "upsert");
    assert.equal(o.row_id, await overrideId(t.id, TODAY));
    assert.deepEqual(
      { node_id: o.cols.node_id, due_on: o.cols.due_on, hhmm: o.cols.hhmm, deleted_at: o.cols.deleted_at },
      { node_id: t.id, due_on: TODAY, hhmm: "09:30", deleted_at: null },
    );
    assert.ok(o.cols.created_at, "新列帶 created_at");
    (globalThis as Any).__steOps = [];
    await repo.setRunTime(t.id, TODAY, "10:00", H);
    assert.equal(ops()[0].cols.created_at, undefined, "改值不改寫出生時刻");
    (globalThis as Any).__steOps = [];
    await repo.clearRunTime(t.id, TODAY);
    assert.deepEqual([ops().length, ops()[0].op, ops()[0].row_id], [1, "delete", await overrideId(t.id, TODAY)]);
    const raw = db.raw.prepare("SELECT time_overrides FROM nodes WHERE id = ?").get(t.id) as { time_overrides: string | null };
    assert.equal(raw.time_overrides, null, "舊欄停止寫入");
  });

  test("換規則的清未來 ⇒ 每列一筆 delete op（過去的列不動）", async () => {
    use(makeDb());
    const repo = new SqliteNodeRepository();
    const t = await repo.create({ kind: "ticket", name: "每日", parentId: null, scheduledOn: TODAY });
    await repo.setRepeatRule(t.id, fixedRule("daily", addDays(TODAY, -28)), TODAY, H);
    for (const d of [addDays(TODAY, -1), TODAY, addDays(TODAY, 1)]) await repo.setRunTime(t.id, d, "09:00", H);
    (globalThis as Any).__steOps = [];
    await repo.setRepeatRule(t.id, weeklyToday(), TODAY, H);
    const dels = ntoOps().filter((o) => o.op === "delete").map((o) => o.row_id).sort();
    assert.deepEqual(dels, [await overrideId(t.id, TODAY), await overrideId(t.id, addDays(TODAY, 1))].sort());
    const nodeOp = ops().find((o) => o.tbl === "nodes");
    assert.equal("time_overrides" in nodeOp.cols, false, "nodes op 不再帶舊欄");
  });

  test("兩台改不同班 ⇒ 不同列、互套之後兩班都在；改同一班 ⇒ 同一列同一個值", async () => {
    const { a, b, repoA, repoB, id } = await twoDevices();
    const d1 = TODAY;
    const d2 = addDays(TODAY, 7);
    use(a);
    await repoA.setRunTime(id, d1, "09:30", H);
    const fromA = ntoOps();
    use(b);
    await repoB.setRunTime(id, d2, "10:30", H);
    const fromB = ntoOps();
    assert.notEqual(fromA[0].row_id, fromB[0].row_id);
    applyNto(b, fromA);
    use(a);
    applyNto(a, fromB);
    const want = { [d1]: "09:30", [d2]: "10:30" };
    use(a);
    assert.deepEqual(await overridesOf(repoA, id), want);
    use(b);
    assert.deepEqual(await overridesOf(repoB, id), want);
    // 同一班兩台都設成同值 ⇒ 同一個 row_id、同一組資料欄（LWW 收斂到同一列，值相同不出競合通知）
    use(a);
    await repoA.setRunTime(id, d2, "11:00", H);
    const sameA = ntoOps()[0];
    use(b);
    await repoB.setRunTime(id, d2, "11:00", H);
    const sameB = ntoOps()[0];
    assert.equal(sameA.row_id, sameB.row_id);
    assert.deepEqual([sameA.cols.node_id, sameA.cols.due_on, sameA.cols.hhmm], [sameB.cols.node_id, sameB.cols.due_on, sameB.cols.hhmm]);
  });
});

describe("sqlite：存量搬移（舊欄 JSON → 列，一台一次）", () => {
  /** 一顆「舊版留下來」的庫：有規則的票、舊欄有 JSON、還沒搬過 */
  async function legacyDb(json: string) {
    const db = makeDb();
    use(db);
    const seed = new SqliteNodeRepository();
    const t = await seed.create({ kind: "ticket", name: "舊票", parentId: null, scheduledOn: TODAY });
    await seed.setRepeatRule(t.id, weeklyToday(), TODAY, H);
    db.raw.prepare("UPDATE nodes SET time_overrides = ? WHERE id = ?").run(json, t.id);
    db.raw.prepare("DELETE FROM settings WHERE key = 'nto_backfill_done'").run();
    db.raw.prepare("DELETE FROM node_time_overrides").run();
    (globalThis as Any).__steOps = [];
    return { db, id: t.id };
  }
  const legacyJson = () => JSON.stringify({ [addDays(TODAY, -7)]: "08:00", [TODAY]: "09:30", [addDays(TODAY, 7)]: null });

  test("第一次讀取就搬：列＋op 都出來；讀到的值與舊欄相同；重掃零缺列＝零寫入", async () => {
    const { db, id } = await legacyDb(legacyJson());
    const repo = new SqliteNodeRepository();
    assert.deepEqual(await overridesOf(repo, id), parseTimeOverrides(legacyJson()));
    assert.equal(ntoOps().length, 3);
    assert.ok(ntoOps().every((o) => o.op === "upsert" && o.cols.deleted_at === null));
    // 沒有持久旗標（它會在「改用另一台」「還原舊快照」後擋住重搬）：下一個實例重掃，
    // 但每一班都已有列（含軟刪的）＝零寫入；舊欄之後再被舊版物件改也不會蓋回來
    db.raw.prepare("UPDATE nodes SET time_overrides = ? WHERE id = ?").run(JSON.stringify({ [TODAY]: "23:00" }), id);
    (globalThis as Any).__steOps = [];
    const again = new SqliteNodeRepository();
    assert.deepEqual(await overridesOf(again, id), parseTimeOverrides(legacyJson()));
    assert.equal(ntoOps().length, 0);
  });

  test("已經有列的班不覆寫（對面先搬過、或這班後來改過／清過）", async () => {
    const { db, id } = await legacyDb(legacyJson());
    const oid = await overrideId(id, TODAY);
    db.raw
      .prepare("INSERT INTO node_time_overrides (id, node_id, due_on, hhmm, deleted_at) VALUES (?, ?, ?, ?, ?)")
      .run(oid, id, TODAY, "09:30", "2026-01-01T00:00:00.000Z"); // 這班在新版清掉過
    const repo = new SqliteNodeRepository();
    const o = await overridesOf(repo, id);
    assert.equal(TODAY in o, false, "清過的不被舊欄復活");
    assert.equal(ntoOps().some((x) => x.row_id === oid), false);
    assert.equal(ntoOps().length, 2);
  });

  test("兩台各自搬同一份舊欄 ⇒ 同一組 row_id、同一組值", async () => {
    const json = legacyJson();
    const { db: a, id } = await legacyDb(json);
    const repoA = new SqliteNodeRepository();
    await repoA.getNode(id);
    const fromA = ntoOps();
    const b = makeDb();
    const row = a.raw.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as Record<string, never>;
    const cols = Object.keys(row);
    b.raw.prepare(`INSERT INTO nodes (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(...cols.map((k) => row[k]));
    use(b);
    const repoB = new SqliteNodeRepository();
    await repoB.getNode(id);
    const fromB = ntoOps();
    const shape = (l: Any[]) =>
      l.map((o) => [o.row_id, o.cols.node_id, o.cols.due_on, o.cols.hhmm].join("|")).sort();
    assert.deepEqual(shape(fromA), shape(fromB));
  });

  test("沒規則的票、已刪的票不搬", async () => {
    const db = makeDb();
    use(db);
    const seed = new SqliteNodeRepository();
    const single = await seed.create({ kind: "ticket", name: "單發", parentId: null, scheduledOn: TODAY });
    const gone = await mkWeekly(seed, "已刪");
    await seed.softDelete(gone.id);
    for (const x of [single.id, gone.id]) {
      db.raw.prepare("UPDATE nodes SET time_overrides = ? WHERE id = ?").run(JSON.stringify({ [TODAY]: "09:00" }), x);
    }
    db.raw.prepare("DELETE FROM settings WHERE key = 'nto_backfill_done'").run();
    (globalThis as Any).__steOps = [];
    const repo = new SqliteNodeRepository();
    assert.equal((await repo.getNode(single.id)).time_overrides, null, "舊欄殘值不漏出");
    assert.equal(ntoOps().length, 0);
  });
});
