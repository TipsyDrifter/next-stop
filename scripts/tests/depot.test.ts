/**
 * 第五本第一梯 ③ 車庫與回顧——到站（D-主-201～206）、駅スタンプ（D-主-208～214）、車庫頁資料（D-主-217～219）。
 * 跑法：`node --test scripts/tests/depot.test.ts`（node 24，型別剝除預設開；零依賴）。
 *
 * SQLite：node:sqlite 記憶體庫＋`src-tauri/migrations` 全部依序跑（含暫定號 stamps）；`../lib/db` 換成回這顆庫的替身、
 * `./syncRepository` 換成照順序執行 SQL、把 op 收進 `globalThis.__depOps` 的假批次。記憶體版跑同一組封口語義。
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
export function getDb() { return Promise.resolve(globalThis.__depDb); }
export function uuid() { return crypto.randomUUID(); }
export function nowUtcIso() { t += 1000; return new Date(t).toISOString(); }
`;
const FAKE_SYNC = `
export function newWriteBatch() { return { stmts: [], ops: [] }; }
export async function runWriteBatch(db, stmts, ops) { db.runBatch(stmts); (globalThis.__depOps ??= []).push(...ops); }
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

const { todayKey, addDays } = await import("../../src/lib/date.ts");
const depot = await import("../../src/domain/depot.ts");
const stamps = await import("../../src/domain/stamps.ts");
const view = await import("../../src/domain/depotView.ts");
const { SqliteNodeRepository } = await import("../../src/data/sqliteNodeRepository.ts");
const { MemoryNodeRepository } = await import("../../src/data/memoryRepository.ts");
const { SqliteDepotRepository, blockCounts, openedOnOf } = await import("../../src/data/depotRepository.ts");
const { fixedRule } = await import("../../src/domain/repeat.ts");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const H = 6;
const TODAY = todayKey(H);

/** 測試用的節點列（只填用得到的欄） */
function n(p: Partial<Any> & { id: string; kind: string }): Any {
  return {
    parent_id: null, line_id: null, route_id: null, name: p.id, description: null, position: 0, sort_key: null,
    color: null, code: null, status: "todo", scheduled_on: null, due_on: null, priority: "mid", estimate_min: null,
    progress: null, time_spent_min: null, mood: null, repeat_rule: null, completed_at: null, expected_on: null,
    arrived_on: null, today_position: null, carried_from: null, scheduled_time: null, time_overrides: null,
    created_at: "2026-08-01T00:00:00.000Z", updated_at: "2026-08-01T00:00:00.000Z", deleted_at: null, synced_at: null,
    account_id: null, device_id: null,
    ...p,
  };
}

/* ───────────── 到站的計畫（純函式） ───────────── */

describe("planArrival／planDeparture（D-主-201／202）", () => {
  const L = n({ id: "L", kind: "line" });
  const A = n({ id: "A", kind: "route", line_id: "L" });
  const B = n({ id: "B", kind: "route", line_id: "L" });
  const C = n({ id: "C", kind: "route", line_id: "L", arrived_on: "2026-09-08", status: "done" });

  test("路線到站：寫那一條 arrived_on＋done；復原＝原值", () => {
    const p = depot.planArrival("A", [L], [A, B, C], "2026-11-02");
    assert.deepEqual(p.writes, [{ id: "A", arrived_on: "2026-11-02", status: "done" }]);
    assert.deepEqual(p.undo, [{ id: "A", arrived_on: null, status: "todo" }]);
    assert.deepEqual(p.routeIds, ["A"]);
  });

  test("已到站的路線再按一次：什麼都不寫", () => {
    assert.equal(depot.planArrival("C", [L], [A, B, C], "2026-11-02").writes.length, 0);
  });

  test("幹線到站＝幹線＋底下還在跑的路線同一天（先前就到站的不動）", () => {
    const p = depot.planArrival("L", [L], [A, B, C], "2026-11-02");
    assert.deepEqual(p.writes.map((w) => w.id), ["L", "A", "B"]);
    assert.ok(p.writes.every((w) => w.arrived_on === "2026-11-02" && w.status === "done"));
    assert.deepEqual(p.routeIds, ["A", "B"]);
  });

  test("幹線回到運行＝幹線＋同一天到站的路線；路線回到運行而幹線已到站＝幹線也回來", () => {
    const L2 = { ...L, arrived_on: "2026-11-02", status: "done" };
    const A2 = { ...A, arrived_on: "2026-11-02", status: "done" };
    const B2 = { ...B, arrived_on: "2026-11-02", status: "done" };
    const back = depot.planDeparture("L", [L2], [A2, B2, C]);
    assert.deepEqual(back.writes.map((w) => w.id), ["L", "A", "B"]);
    assert.ok(back.writes.every((w) => w.arrived_on === null && w.status === "todo"));
    const one = depot.planDeparture("A", [L2], [A2, B2, C]);
    assert.deepEqual(one.writes.map((w) => w.id), ["A", "L"]);
    assert.deepEqual(one.undo, [
      { id: "A", arrived_on: "2026-11-02", status: "done" },
      { id: "L", arrived_on: "2026-11-02", status: "done" },
    ]);
  });

  test("還在跑：幹線收進車庫、另一台同時在底下開新路線 ⇒ 幹線照樣在清單（新路線不會消失，D-主-203）", () => {
    const L2 = { ...L, arrived_on: "2026-11-02" };
    const fresh = n({ id: "N", kind: "route", line_id: "L" });
    assert.deepEqual(depot.liveLinesOf([L2], [{ ...A, arrived_on: "2026-11-02" }, fresh]).map((l) => l.id), ["L"]);
    assert.deepEqual(depot.liveLinesOf([L2], [{ ...A, arrived_on: "2026-11-02" }]).map((l) => l.id), []);
  });

  test("inDepot：路線看自己；票看 route_id；幹線、收件匣票不在車庫", () => {
    const ids = depot.depotRouteIds([A, C]);
    assert.equal(depot.inDepot(C, ids), true);
    assert.equal(depot.inDepot(A, ids), false);
    assert.equal(depot.inDepot(n({ id: "t", kind: "ticket", route_id: "C" }), ids), true);
    assert.equal(depot.inDepot(n({ id: "t2", kind: "ticket" }), ids), false);
    assert.equal(depot.inDepot(L, ids), false);
  });
});

describe("buildShelf（D-主-217）", () => {
  test("依到站日排、已到站幹線底下的夾成一組（組的位置＝幹線到站日）", () => {
    const U = n({ id: "U", kind: "line", arrived_on: "2026-09-20" });
    const life = n({ id: "LIFE", kind: "line" });
    const routes = [
      n({ id: "G1", kind: "route", line_id: "LIFE", arrived_on: "2026-10-31" }),
      n({ id: "M1", kind: "route", line_id: "U", arrived_on: "2026-09-08" }),
      n({ id: "D8", kind: "route", line_id: "U", arrived_on: "2026-09-20" }),
      n({ id: "D9", kind: "route", line_id: "LIFE", arrived_on: "2026-10-25" }),
      n({ id: "E1", kind: "route", line_id: "LIFE" }),
    ];
    const shelf = depot.buildShelf([life, U], routes);
    assert.deepEqual(
      shelf.map((s) => (s.type === "group" ? `${s.line.id}[${s.routes.map((r) => r.id).join(",")}]` : s.route.id)),
      ["U[M1,D8]", "D9", "G1"],
    );
  });
});

/* ───────────── 駅スタンプ（純函式） ───────────── */

function facts(p: Partial<Any> = {}): Any {
  return {
    today: "2026-11-02",
    firstTask: null,
    stations: [],
    routes: [],
    lines: [],
    seals: [],
    diaryDays: [],
    ledgerFirstDay: null,
    blocks: [],
    categoryNames: {},
    ...p,
  };
}

describe("detectStamps（D-主-209）", () => {
  test("開業、車站、路線、幹線：照事實蓋，日期＝事實那天；刪掉的不新蓋", () => {
    const out = stamps.detectStamps(
      facts({
        firstTask: { day: "2026-08-06", name: "把書桌清出來" },
        stations: [
          { id: "s1", name: "N5", arrived_on: "2026-10-15", alive: true },
          { id: "s2", name: "N4", arrived_on: null, alive: true },
          { id: "s3", name: "刪掉的", arrived_on: "2026-10-01", alive: false },
        ],
        routes: [{ id: "r1", name: "研究所甄試", arrived_on: "2026-10-31", alive: true, opened_on: "2026-08-10" }],
        lines: [{ id: "l1", name: "大學三年級", arrived_on: "2026-09-20", alive: true }],
      }),
    );
    const keys = out.map((s) => `${s.kind}:${s.subject_id ?? ""}:${s.stamped_on}`).sort();
    assert.deepEqual(keys, ["line:l1:2026-09-20", "opening::2026-08-06", "route:r1:2026-10-31", "station:s1:2026-10-15"]);
  });

  test("路線開業滿一年：到了才蓋；滿一年前就到站的不蓋；只蓋一次", () => {
    const f = facts({
      today: "2026-11-02",
      routes: [
        { id: "old", name: "日文", arrived_on: null, alive: true, opened_on: "2025-10-01" },
        { id: "young", name: "體能", arrived_on: null, alive: true, opened_on: "2026-01-01" },
        { id: "short", name: "搬家", arrived_on: "2025-03-01", alive: true, opened_on: "2025-01-01" },
      ],
    });
    const ys = stamps.detectStamps(f).filter((s) => s.kind === "route_year");
    assert.deepEqual(ys.map((s) => [s.subject_id, s.stamped_on]), [["old", "2026-10-01"]]);
  });

  test("累計章只蓋稀疏幾枚：済 100／1000、日記 100、時刻表分類 100 小時（跨過門檻那一塊結束的那天）", () => {
    const seals = Array.from({ length: 1000 }, (_, i) => ({ day: addDays("2026-01-01", Math.floor(i / 10)), name: `票${i + 1}` }));
    const diaryDays = Array.from({ length: 120 }, (_, i) => addDays("2026-03-01", i));
    const HOUR = 3_600_000;
    const blocks = [
      { category_id: "c1", ms: 60 * HOUR, end_day: "2026-05-01", end_at: "2026-05-01T10:00:00.000Z" },
      { category_id: "c2", ms: 99 * HOUR, end_day: "2026-05-02", end_at: "2026-05-02T10:00:00.000Z" },
      { category_id: "c1", ms: 50 * HOUR, end_day: "2026-06-01", end_at: "2026-06-01T10:00:00.000Z" },
      { category_id: "c1", ms: 50 * HOUR, end_day: "2026-07-01", end_at: "2026-07-01T10:00:00.000Z" },
    ];
    const out = stamps.detectStamps(facts({ seals, diaryDays, blocks, categoryNames: { c1: "讀書" } }));
    const pick = (k: string) => out.filter((s) => s.kind === k).map((s) => `${s.value}@${s.stamped_on}:${s.label}`);
    assert.deepEqual(pick("seals"), ["100@2026-01-10:票100", "1000@2026-04-10:票1000"]);
    assert.deepEqual(pick("diary"), [`100@${addDays("2026-03-01", 99)}:日記`]);
    assert.deepEqual(pick("time_cat"), ["100@2026-06-01:讀書"], "c2 只有 99 小時不蓋；c1 第三塊跨過才蓋、第四塊不再蓋");
  });

  test("記帳滿一年：沒到不蓋（不提前蓋到未來）", () => {
    assert.equal(stamps.detectStamps(facts({ ledgerFirstDay: "2026-01-01" })).length, 0);
    const out = stamps.detectStamps(facts({ ledgerFirstDay: "2025-10-01" }));
    assert.deepEqual(out.map((s) => [s.kind, s.stamped_on]), [["ledger_year", "2026-10-01"]]);
  });
});

describe("diffStamps（D-主-210：只 insert 缺的、不改活列；取消到站收回、再到站同一列復活）", () => {
  const row = (p: Partial<Any>): Any => ({
    id: "x", kind: "station", subject_id: "s1", value: null, label: "N5", stamped_on: "2026-10-15",
    created_at: "t", updated_at: "t", deleted_at: null, ...p,
  });

  test("沒有的插入；活的就算日期不同也不動", async () => {
    const want = await stamps.keyStamps([{ kind: "station", subject_id: "s1", value: null, label: "N5", stamped_on: "2026-10-20" }]);
    const plan = stamps.diffStamps(want, [row({ id: want[0].id })], facts({ stations: [{ id: "s1", name: "N5", arrived_on: "2026-10-20", alive: true }] }));
    assert.ok(stamps.isEmptyPlan(plan));
    const plan2 = stamps.diffStamps(want, [], facts());
    assert.equal(plan2.insert.length, 1);
  });

  test("取消到站（節點還在）⇒ 收回；節點刪掉 ⇒ 不收回", () => {
    const rows = [row({ id: "a", subject_id: "s1" }), row({ id: "b", subject_id: "s2" }), row({ id: "c", kind: "seals", subject_id: null, value: 100 })];
    const plan = stamps.diffStamps([], rows, facts({
      stations: [
        { id: "s1", name: "N5", arrived_on: null, alive: true },
        { id: "s2", name: "N4", arrived_on: null, alive: false },
      ],
    }));
    assert.deepEqual(plan.retract.map((r) => r.id), ["a"]);
  });

  test("收回過又到站 ⇒ 復活同一列（日期與名字換新）", async () => {
    const want = await stamps.keyStamps([{ kind: "route", subject_id: "r1", value: null, label: "新名字", stamped_on: "2026-11-02" }]);
    const plan = stamps.diffStamps(want, [row({ id: want[0].id, kind: "route", subject_id: "r1", deleted_at: "2026-10-01" })], facts());
    assert.equal(plan.revive.length, 1);
    assert.equal(plan.revive[0].stamped_on, "2026-11-02");
    assert.equal(plan.insert.length, 0);
  });

  test("id＝uuid v5（兩台各自算出同一個）", async () => {
    const a = await stamps.stampId("seals", null, 100);
    assert.equal(a, await stamps.stampId("seals", null, 100));
    assert.notEqual(a, await stamps.stampId("seals", null, 1000));
    assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

/* ───────────── 車庫頁資料（純函式） ───────────── */

describe("depotView：印譜帳、年鑑、記錄簿的車站", () => {
  const st = (id: string, kind: string, day: string): Any => ({
    id, kind, subject_id: null, value: null, label: id, stamped_on: day, created_at: "t", updated_at: "t", deleted_at: null,
  });

  test("印譜帳一個月一頁、舊→新；收回的章不出現；沒章的月份不出現", () => {
    const pages = view.albumPages([st("a", "station", "2026-10-08"), st("b", "opening", "2026-08-06"), { ...st("c", "station", "2026-09-01"), deleted_at: "x" }]);
    assert.deepEqual(pages.map((p) => [p.month, p.stamps.map((s) => s.id)]), [["2026-08", ["b"]], ["2026-10", ["a"]]]);
  });

  test("年鑑：只列有內容的月份、新→舊；代表句＝當月最後寫下的那則；未來月份不列", () => {
    const yb = view.buildYearbook({
      today: "2026-11-02",
      stamps: [st("a", "station", "2026-10-08")],
      sealDays: ["2026-10-01", "2026-10-02", "2026-08-03"],
      notes: [
        { id: "n1", kind: "note", day: "2026-10-30", noted_at: "2026-10-30T10:00:00Z", title: null, text: "書審上傳" },
        { id: "n2", kind: "diary", day: "2026-10-31", noted_at: "2026-10-31T12:00:00Z", title: null, text: "## \n面試完走出來，天還很亮。" },
        { id: "n3", kind: "note", day: "2026-12-01", noted_at: "2026-12-01T00:00:00Z", title: null, text: "未來" },
      ],
      routes: [n({ id: "G1", kind: "route", arrived_on: "2026-10-31" })],
      lines: [],
    });
    assert.deepEqual(yb.months.map((m) => m.month), ["2026-10", "2026-08"]);
    const oct = yb.months[0];
    assert.equal(oct.seals, 2);
    assert.equal(oct.diaries, 1);
    assert.deepEqual(oct.routes.map((r) => r.id), ["G1"]);
    assert.equal(oct.quote?.text, "面試完走出來，天還很亮。");
    assert.equal(yb.ago, null, "沒有往年同一天的東西 ⇒ 那年今日不出現");
  });

  test("那年今日：最近的那一年、日記優先", () => {
    const ago = view.agoOf("2026-11-01", [
      { id: "a", kind: "note", day: "2025-11-01", noted_at: "2025-11-01T01:00:00Z", title: null, text: "筆記" },
      { id: "b", kind: "diary", day: "2025-11-01", noted_at: "2025-11-01T09:00:00Z", title: null, text: "第一次自己去看海" },
      { id: "c", kind: "diary", day: "2024-11-01", noted_at: "2024-11-01T09:00:00Z", title: null, text: "兩年前" },
      { id: "d", kind: "diary", day: "2026-11-01", noted_at: "2026-11-01T09:00:00Z", title: null, text: "今天的不算" },
    ]);
    assert.deepEqual(ago && [ago.id, ago.years, ago.text], ["b", 1, "第一次自己去看海"]);
  });

  test("願望實現：年鑑按月計件、那年今日認願望（日記 › 筆記 › 願望）", () => {
    const w = (id: string, name: string, day: string, kind = "go"): Any => ({ id, name, kind, bought_at: `${day}T04:00:00Z`, day });
    const yb = view.buildYearbook({
      today: "2026-11-02",
      stamps: [],
      sealDays: [],
      notes: [],
      wishes: [w("w1", "京都散步", "2026-10-12"), w("w2", "降噪耳機", "2026-10-20", "buy"), w("w3", "未來的", "2026-12-01")],
      routes: [],
      lines: [],
    });
    assert.deepEqual(yb.months.map((m) => [m.month, m.wishes]), [["2026-10", 2]], "只有願望的月份也列、未來月份不列");
    const wishes = [w("a", "去年買的耳機", "2025-11-01", "buy"), w("b", "前年", "2024-11-01")];
    const note = { id: "n", kind: "note", day: "2025-11-01", noted_at: "2025-11-01T01:00:00Z", title: null, text: "筆記" };
    const diary = { id: "d", kind: "diary", day: "2025-11-01", noted_at: "2025-11-01T09:00:00Z", title: null, text: "日記" };
    const a1 = view.agoOf("2026-11-01", [], wishes);
    assert.deepEqual(a1 && [a1.kind, a1.id, a1.years, a1.text, a1.wishKind], ["wish", "a", 1, "去年買的耳機", "buy"]);
    assert.equal(view.agoOf("2026-11-01", [note], wishes)?.id, "n", "筆記 › 願望");
    assert.equal(view.agoOf("2026-11-01", [note, diary], wishes)?.id, "d", "日記 › 筆記");
    assert.equal(view.agoOf("2026-11-01", [{ ...note, day: "2024-11-01" }], wishes)?.id, "a", "最近那一年優先於種類");
    assert.equal(view.agoOf("2026-11-01", [], [w("x", "今年的不算", "2026-11-01")]), null);
  });

  test("記錄簿的車站：開業→已到着→終點；運行中只列到着的、最後一行運行中", () => {
    const sts = [
      n({ id: "s1", kind: "station", name: "讀書計畫", arrived_on: "2026-08-22" }),
      n({ id: "s2", kind: "station", name: "面試準備", arrived_on: "2026-10-31" }),
      n({ id: "s3", kind: "station", name: "沒到的" }),
    ];
    const done = view.bookStations({ arrived_on: "2026-10-31" }, "2026-08-10", sts);
    assert.deepEqual(done.map((s) => `${s.kind}:${s.name}`), ["start:開業", "station:讀書計畫", "term:面試準備"]);
    const run = view.bookStations({ arrived_on: null }, "2026-08-10", sts);
    assert.deepEqual(run.map((s) => s.kind), ["start", "station", "station", "now"]);
    const noTerm = view.bookStations({ arrived_on: "2026-11-02" }, "2026-08-10", sts);
    assert.deepEqual(noTerm.at(-1), { kind: "term", name: "到站", day: "2026-11-02", stationId: null });
  });
});

describe("depotRepository 的小規則", () => {
  test("開業日＝路線建立與最早一枚発券取早的那天", () => {
    assert.equal(openedOnOf("2026-09-01T00:00:00.000Z", "2026-08-10T00:00:00.000Z", 0), "2026-08-10");
    assert.equal(openedOnOf("2026-09-01T00:00:00.000Z", null, 0), "2026-09-01");
  });
  test("時間塊：跑太久沒確認的不算", () => {
    const b = (h: number, ack = 0, est: number | null = null) => ({
      started_at: "2026-01-01T00:00:00.000Z",
      ended_at: new Date(Date.parse("2026-01-01T00:00:00.000Z") + h * 3_600_000).toISOString(),
      estimate_min: est,
      long_run_ack: ack,
    });
    assert.equal(blockCounts(b(2), 840), true);
    assert.equal(blockCounts(b(20), 840), false);
    assert.equal(blockCounts(b(20, 1), 840), true);
    assert.equal(blockCounts(b(2, 0, 60), 840), false, "這一班的預估優先");
  });
});

/* ───────────── 封口（SQLite 與記憶體同一組語義） ───────────── */

type Repo = InstanceType<typeof SqliteNodeRepository> | InstanceType<typeof MemoryNodeRepository>;

async function seed(repo: Repo) {
  const line = await repo.create({ kind: "line", name: "生活", parentId: null });
  const r1 = await repo.create({ kind: "route", name: "日文", parentId: line.id });
  const r2 = await repo.create({ kind: "route", name: "體能", parentId: line.id });
  const tr = await repo.create({ kind: "train", name: "N4", parentId: r1.id, scheduledOn: TODAY });
  const tk = await repo.create({ kind: "ticket", name: "背單字", parentId: tr.id, scheduledOn: TODAY });
  const temp = await repo.create({ kind: "ticket", name: "買字典", parentId: null, routeTagId: r1.id, scheduledOn: TODAY });
  const other = await repo.create({ kind: "ticket", name: "跑步", parentId: null, routeTagId: r2.id, scheduledOn: TODAY });
  const late = await repo.create({ kind: "ticket", name: "誤點的", parentId: tr.id, scheduledOn: addDays(TODAY, -3) });
  return { line, r1, r2, tr, tk, temp, other, late };
}

for (const kind of ["sqlite", "memory"] as const) {
  describe(`封口全集的資料層（${kind}）`, () => {
    let repo: Repo;
    beforeEach(() => {
      (globalThis as Any).__depDb = makeDb();
      (globalThis as Any).__depOps = [];
      repo = kind === "sqlite" ? new SqliteNodeRepository() : new MemoryNodeRepository();
    });

    test("路線到站：今日（含誤點、掛標籤的臨時票）與行程表都不再有它的票；回到運行原樣回來；票的狀態沒動", async () => {
      const s = await seed(repo);
      const before = (await repo.listToday(TODAY, H)).map((r) => r.id).sort();
      assert.deepEqual(before, [s.tr.id, s.tk.id, s.temp.id, s.other.id, s.late.id].sort());
      await repo.setArrival([{ id: s.r1.id, arrived_on: TODAY, status: "done" }]);
      assert.deepEqual((await repo.listToday(TODAY, H)).map((r) => r.id), [s.other.id]);
      const cal = await repo.listCalendar(addDays(TODAY, -7), addDays(TODAY, 7), { todayDateKey: TODAY, dayStartHour: H });
      assert.deepEqual([...new Set(cal.entries.map((e) => e.node_id))], [s.other.id]);
      assert.equal((await repo.getNode(s.tk.id))?.status, "todo", "票的狀態一個都不動");
      const side = await repo.listSidebar();
      assert.equal(side.routes.find((r) => r.id === s.r1.id)?.arrived_on, TODAY);
      assert.equal(side.routes.find((r) => r.id === s.r1.id)?.status, "done");
      await repo.setArrival([{ id: s.r1.id, arrived_on: null, status: "todo" }]);
      assert.equal((await repo.listToday(TODAY, H)).length, 5);
    });

    test("收進車庫的定期券停止發班（syncRepeats 不動它）", async () => {
      const s = await seed(repo);
      const rep = await repo.create({ kind: "ticket", name: "每天背單字", parentId: s.tr.id, scheduledOn: addDays(TODAY, -10) });
      await repo.setRepeatRule(rep.id, fixedRule("daily", addDays(TODAY, -10)), addDays(TODAY, -10), H);
      await repo.setArrival([{ id: s.r1.id, arrived_on: TODAY, status: "done" }]);
      const changed = await repo.syncRepeats(TODAY, H);
      assert.ok(!changed.includes(rep.id));
    });

    test("setArrival 只收路線與幹線", async () => {
      const s = await seed(repo);
      await assert.rejects(() => repo.setArrival([{ id: s.tk.id, arrived_on: TODAY, status: "done" }]), /只有路線和幹線能到站/);
    });
  });
}

/* ───────────── SQLite：stamps 表與事實 ───────────── */

describe("SqliteDepotRepository（stamps 表、事實、車庫資料）", () => {
  beforeEach(() => {
    (globalThis as Any).__depDb = makeDb();
    (globalThis as Any).__depOps = [];
  });

  test("插入／復活／收回一個交易寫完，op 照慣例送出；listStamps 讀得回來", async () => {
    const dep = new SqliteDepotRepository();
    const [a, b] = await stamps.keyStamps([
      { kind: "seals", subject_id: null, value: 100, label: "票100", stamped_on: "2026-10-01" },
      { kind: "station", subject_id: "s1", value: null, label: "N5", stamped_on: "2026-10-02" },
    ]);
    await dep.applyStampPlan({ insert: [a, b], revive: [], retract: [] });
    let rows = await dep.listStamps();
    assert.equal(rows.length, 2);
    const ops = (globalThis as Any).__depOps as Any[];
    assert.ok(ops.every((o) => o.tbl === "stamps"));
    assert.deepEqual(Object.keys(ops[0].cols).sort(), ["created_at", "kind", "label", "stamped_on", "subject_id", "updated_at", "value"]);
    await dep.applyStampPlan({ insert: [], revive: [], retract: [rows.find((r) => r.id === b.id)!] });
    rows = await dep.listStamps();
    assert.ok(rows.find((r) => r.id === b.id)?.deleted_at);
    await dep.applyStampPlan({ insert: [], revive: [{ ...b, stamped_on: "2026-11-02", label: "N5 改名" }], retract: [] });
    rows = await dep.listStamps();
    const back = rows.find((r) => r.id === b.id)!;
    assert.equal(back.deleted_at, null);
    assert.equal(back.stamped_on, "2026-11-02");
    assert.equal(back.label, "N5 改名");
  });

  test("事實：開業、車站、済（依完成時刻排）、開業日取最早発券；車庫資料各路線済章數", async () => {
    const repo = new SqliteNodeRepository();
    const s = await seed(repo);
    const st = await repo.create({ kind: "station", name: "N5", parentId: s.r1.id });
    await repo.update(st.id, { arrived_on: "2026-10-15" });
    await repo.setCompleted(s.tk.id, true, { dateKey: TODAY, dayStartHour: H });
    await repo.setCompleted(s.other.id, true, { dateKey: TODAY, dayStartHour: H });
    const dep = new SqliteDepotRepository();
    const f = await dep.stampFacts(TODAY, H);
    assert.equal(f.firstTask?.name, "N4");
    assert.deepEqual(f.stations.map((x) => [x.name, x.arrived_on]), [["N5", "2026-10-15"]]);
    assert.deepEqual(f.seals.map((x) => x.name), ["背單字", "跑步"]);
    const d = await dep.loadDepot(H);
    assert.equal(d.routeSeals[s.r1.id], 1);
    assert.equal(d.routeSeals[s.r2.id], 1);
    assert.equal(d.sealDays.length, 2);
    assert.ok(d.openedOn[s.r1.id]);
  });
});
