/**
 * 第四梯回饋專卷（eng-tree）完整單元與整合測試（4A + 4B + 4C · D-FB-7）：
 *   1. Migration 0024 / 0025 嚴格 LF 與欄位（nodes.scheduled_end, nodes.is_placeholder, node_time_overrides.custom_title, seated_node_id）
 *   2. 4A：parseQuickAdd 無標題預留席語法（@目的地／#標籤＋時間／日期／區間）與 placeholderTicketTitle
 *   3. 4A：time_plans (kind='adhoc') 開機冪等轉換為預留席車票（決定性 UUID v5、保留日期/時段/時長/路線/名稱、軟刪舊 adhoc）
 *   4. 4B：dateRange.ts 純函式（normalizeDateRange、週末/本週/下週/本月 含 weekStart 0|1、isRangeCoveringDay、isRangeOverdue、compareRangeDrawerRows）
 *   5. 4B：期間自由券 [scheduled_on, scheduled_end] 在 SQLite ＋ Memory 的投影規則：
 *      - 進行中不進 listToday、不進誤點，由 listRangeTickets 依 scheduled_end 迫近排序
 *      - 未過區間起日（scheduled_on > today）不出現
 *      - 超過 scheduled_end 且未完成進入 listToday bucket="late"
 *      - pullRangeTicketToToday 語義（reschedule(..., { scheduledEnd: null })）收斂回單日今日票
 *   6. 4C Mode A：setRunCustomTitle 逐班標題覆寫（保留同列 hhmm / seated_node_id、清時間不誤刪 custom_title、足跡／済章顯示「填空標題（母定期名）」）
 *   7. 4C Mode B：seatTicketIntoSlot / releaseSeatedSlot 在 SQLite ＋ Memory：
 *      - 入座對齊日期、listToday / listCalendar / listSchedule 隱藏空位並掛 seated_into（繼承 slotTime / slotEstimateMin）
 *      - totalEstimateMin 只算一次、不雙重計算
 *      - 改期移離班次日或軟刪已入座車票自動釋出預留空位
 *      - 雙向完成／取消完成同步（定期券班次 & 單發預留席）
 *      - moveOccurrence 搬動該班時同步搬動 custom_title / seated_node_id 與入座車票日期
 *
 * 跑法：`node --test scripts/tests/fb-w4-core.test.ts`
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  DATE_RANGE_PRESET_LABEL,
  compareRangeDrawerRows,
  dateRangePreset,
  formatDateRangeBadge,
  isRangeCoveringDay,
  isRangeOverdue,
  isRangeTicket,
  normalizeDateRange,
  rangeRemainingDays,
} from "../../src/domain/dateRange.ts";
import { parseQuickAdd, placeholderTicketTitle, type QuickAddCtx } from "../../src/domain/quickAdd.ts";
import {
  TIME_OVERRIDE_INHERIT_HHMM,
  effectiveEstimateMin,
  overridesFromRows,
  timeOfRow,
  totalEstimateMin,
} from "../../src/domain/scheduledTime.ts";
import { SEAL_NODE_SQL, SEAL_OCC_SQL, dedupeSeals, sealOfRow, sealsInWindow, type SealRow } from "../../src/domain/seals.ts";
import { planItemOf, planTimeWrite, planUndo } from "../../src/domain/timetableSchedule.ts";
import { fixedRule } from "../../src/domain/repeat.ts";
import { groupFootprints, footprintSeals } from "../../src/domain/notes.ts";
import { dayWindow } from "../../src/lib/date.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const FAKE_DB = `
let t = Date.UTC(2026, 9, 8, 1, 0, 0);
export function getDb() { const d = globalThis.__dbW4; if (!d) throw new Error("測試沒設 __dbW4"); return Promise.resolve(d); }
export function uuid() { return crypto.randomUUID(); }
export function nowUtcIso() { t += 1000; return new Date(t).toISOString(); }
`;
const FAKE_SYNC = `
export const SYNC_WRITE_EVENT = "ns:sync-write";
export const SYNC_SETTINGS_KEYS = new Set();
export function newWriteBatch() { return { stmts: [], ops: [] }; }
export async function runWriteBatch(db, stmts, ops) { db.runBatch(stmts, ops); }
export async function occurrenceId(n, d) { return n + "|" + d; }
export async function ensureSyncTables() { return false; }
`;
const FAKE_CORE = `export async function invoke() { throw new Error("測試不 invoke"); }`;
const FAKE_WINDOW_THEME = `export function syncWindowTheme() {}`;

const dataUrl = (src: string) => "data:text/javascript," + encodeURIComponent(src);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const fromSrc = context.parentURL !== undefined && context.parentURL.includes("/src/");
    if (fromSrc) {
      if (specifier === "../lib/db") return { url: dataUrl(FAKE_DB), shortCircuit: true };
      if (specifier === "./syncRepository") return { url: dataUrl(FAKE_SYNC), shortCircuit: true };
      if (specifier === "@tauri-apps/api/core") return { url: dataUrl(FAKE_CORE), shortCircuit: true };
      if (specifier === "../lib/windowTheme") return { url: dataUrl(FAKE_WINDOW_THEME), shortCircuit: true };
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

interface Op {
  tbl: string;
  row_id: string;
  op: string;
  cols: Record<string, unknown>;
}
interface Batch {
  ops: Op[];
}
interface TestDb {
  batches: Batch[];
  raw: DatabaseSync;
  select(sql: string, args?: unknown[]): Promise<Record<string, unknown>[]>;
  execute(sql: string, args?: unknown[]): Promise<{ rowsAffected: number }>;
  runBatch(stmts: { sql: string; args: unknown[] }[], ops: Op[]): void;
}
const bind = (args: unknown[] = []) => Object.fromEntries(args.map((v, i) => ["$" + (i + 1), v])) as Record<string, never>;

function makeDb(): TestDb {
  const raw = new DatabaseSync(":memory:");
  const dir = path.join(ROOT, "src-tauri/migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    raw.exec(readFileSync(path.join(dir, f), "utf8"));
  }
  const db: TestDb = {
    batches: [],
    raw,
    async select(sql, args) {
      return raw.prepare(sql).all(bind(args)) as Record<string, unknown>[];
    },
    async execute(sql, args) {
      const r = raw.prepare(sql).run(bind(args));
      return { rowsAffected: Number(r.changes) };
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
      db.batches.push({ ops });
    },
  };
  return db;
}

const setDb = (db: TestDb) => {
  (globalThis as Record<string, unknown>).__dbW4 = db;
};

const { SqliteNodeRepository } = await import("../../src/data/sqliteNodeRepository.ts");
const { MemoryNodeRepository } = await import("../../src/data/memoryRepository.ts");
const { MemoryNoteRepository } = await import("../../src/data/memoryNoteRepository.ts");
const { applyTodaySeating } = await import("../../src/data/nodeRepository.ts");

function makeQuickCtx(): QuickAddCtx {
  return {
    today: "2026-10-07", // 週三
    dayStartHour: 6,
    weekStart: 1,
    routes: [
      { id: "r-jp", name: "日文", code: "JP" },
      { id: "r-dev", name: "開發", code: "DEV" },
    ],
    tasksOf: (routeId) =>
      routeId === "r-jp"
        ? [{ id: "b-vocab", name: "單字支線", kind: "branch" }]
        : [],
  };
}

describe("第四梯 Migration 0024 / 0025 與 LF 行尾驗證", () => {
  test("0024 與 0025 皆為純 LF 且建出預期欄位", () => {
    for (const file of ["0024_flexible_tickets.sql", "0025_override_seating.sql"]) {
      const buf = readFileSync(path.join(ROOT, "src-tauri/migrations", file), "utf8");
      assert.equal(buf.includes("\r"), false, `${file} 不得包含 CR`);
    }
    const db = makeDb();
    const nodeCols = db.raw.prepare("PRAGMA table_info(nodes)").all() as { name: string }[];
    assert.ok(nodeCols.some((c) => c.name === "scheduled_end"));
    assert.ok(nodeCols.some((c) => c.name === "is_placeholder"));
    const ovrCols = db.raw.prepare("PRAGMA table_info(node_time_overrides)").all() as { name: string }[];
    assert.ok(ovrCols.some((c) => c.name === "custom_title"));
    assert.ok(ovrCols.some((c) => c.name === "seated_node_id"));
  });
});

describe("4A · 無標題預留席與 QuickAdd 區間語法", () => {
  test("無標題但有時間／日期＋@目的地或#標籤 ⇒ 自動產出預留席", () => {
    const ctx = makeQuickCtx();
    const a = parseQuickAdd("@日文 2h", ctx);
    assert.equal(a.isPlaceholder, true);
    assert.equal(a.name, "");
    assert.equal(a.placeholderTitle, "日文");
    assert.equal(a.estimateMin, 120);
    assert.equal(a.dest?.routeId, "r-jp");

    const b = parseQuickAdd("#學習 14:00-16:00", ctx);
    assert.equal(b.isPlaceholder, true);
    assert.equal(b.name, "");
    assert.equal(b.placeholderTitle, "學習");
    assert.equal(b.scheduledTime, "14:00");
    assert.equal(b.estimateMin, 120);
    assert.deepEqual(b.tags.map((t) => t.name), ["學習"]);

    const c = parseQuickAdd("@日文 10/10", ctx);
    assert.equal(c.isPlaceholder, true);
    assert.equal(c.scheduledOn, "2026-10-10");
    assert.equal(c.placeholderTitle, "日文");

    // 只有 @目的地沒有任何時間／日期／區間 ⇒ 不冒然變成預留席
    const d = parseQuickAdd("@日文", ctx);
    assert.equal(d.isPlaceholder, undefined);
    assert.equal(d.name, "");

    assert.equal(placeholderTicketTitle({ routeName: "單字支線" }), "單字支線");
    assert.equal(placeholderTicketTitle({ tagNames: ["深度工作"] }), "深度工作");
    assert.equal(placeholderTicketTitle({}), "預留席");
  });

  test("QuickAdd 期間區間語法：MM/DD~MM/DD、MM/DD-MM/DD、YYYY-MM-DD~YYYY-MM-DD、週末/本週/下週/本月", () => {
    const ctx = makeQuickCtx(); // 2026-10-07 週三, weekStart=1
    const r1 = parseQuickAdd("整理書櫃 10/10~10/12", ctx);
    assert.equal(r1.name, "整理書櫃");
    assert.equal(r1.scheduledOn, "2026-10-10");
    assert.equal(r1.scheduledEnd, "2026-10-12");

    // '-' 不會被當成開始-結束時段，能辨識日期區間
    const r2 = parseQuickAdd("寫報告 10/8-10/10", ctx);
    assert.equal(r2.name, "寫報告");
    assert.equal(r2.scheduledOn, "2026-10-08");
    assert.equal(r2.scheduledEnd, "2026-10-10");

    // 跨年自動推算（今天 12 月中，輸入 1/2~1/5）
    const crossYear = parseQuickAdd("新年規劃 1/2~1/5", { ...ctx, today: "2026-12-20" });
    assert.equal(crossYear.scheduledOn, "2027-01-02");
    assert.equal(crossYear.scheduledEnd, "2027-01-05");

    const wknd = parseQuickAdd("大掃除 週末", ctx);
    assert.equal(wknd.scheduledOn, "2026-10-10");
    assert.equal(wknd.scheduledEnd, "2026-10-11");

    const thisWk = parseQuickAdd("複習 本週", ctx);
    assert.equal(thisWk.scheduledOn, "2026-10-05");
    assert.equal(thisWk.scheduledEnd, "2026-10-11");

    const nextWk = parseQuickAdd("新章 下週", ctx);
    assert.equal(nextWk.scheduledOn, "2026-10-12");
    assert.equal(nextWk.scheduledEnd, "2026-10-18");

    const thisMo = parseQuickAdd("月度結算 本月", ctx);
    assert.equal(thisMo.scheduledOn, "2026-10-01");
    assert.equal(thisMo.scheduledEnd, "2026-10-31");
  });
});

describe("4B · dateRange.ts 純函式語義", () => {
  test("normalizeDateRange 與週起始日預設區間", () => {
    assert.deepEqual(normalizeDateRange(null, "2026-10-10"), { scheduledOn: null, scheduledEnd: null });
    assert.deepEqual(normalizeDateRange("2026-10-10", "2026-10-10"), { scheduledOn: "2026-10-10", scheduledEnd: null });
    assert.deepEqual(normalizeDateRange("2026-10-15", "2026-10-10"), { scheduledOn: "2026-10-10", scheduledEnd: "2026-10-15" });

    // weekStart=0（週日起算）於 2026-10-07（週三）：週末為 10/10~10/11，下週為 10/11~10/17
    assert.deepEqual(dateRangePreset("weekend", "2026-10-07", 0), {
      from: "2026-10-10",
      to: "2026-10-11",
    });
    assert.deepEqual(dateRangePreset("nextWeek", "2026-10-07", 0), {
      from: "2026-10-11",
      to: "2026-10-17",
    });
    assert.equal(DATE_RANGE_PRESET_LABEL.weekend, "週末");

    const ticket = { scheduled_on: "2026-10-08", scheduled_end: "2026-10-10", status: "todo" };
    assert.equal(isRangeTicket(ticket), true);
    assert.equal(isRangeCoveringDay(ticket, "2026-10-08"), true);
    assert.equal(isRangeCoveringDay(ticket, "2026-10-10"), true);
    assert.equal(isRangeCoveringDay(ticket, "2026-10-11"), false);
    assert.equal(isRangeOverdue(ticket, "2026-10-10"), false);
    assert.equal(isRangeOverdue(ticket, "2026-10-11"), true);
    assert.equal(rangeRemainingDays("2026-10-10", "2026-10-08"), 2);
    assert.equal(formatDateRangeBadge("2026-10-08", "2026-10-10"), "10/8–10/10");
  });

  test("compareRangeDrawerRows 依 scheduled_end ASC 排序", () => {
    const a = {
      id: "a",
      scheduled_on: "2026-10-01",
      scheduled_end: "2026-10-12",
      priority: "high" as const,
      sort_key: null,
      created_at: "2026-10-01T00:00:00Z",
    };
    const b = {
      id: "b",
      scheduled_on: "2026-10-05",
      scheduled_end: "2026-10-09",
      priority: "low" as const,
      sort_key: null,
      created_at: "2026-10-05T00:00:00Z",
    };
    assert.deepEqual([a, b].sort(compareRangeDrawerRows).map((x) => x.id), ["b", "a"]);
  });
});

describe("4A · SQLite 開機 adhoc 冪等遷移至預留席車票", () => {
  test("將 time_plans(kind='adhoc') 轉成 is_placeholder=1 車票、軟刪舊列，重跑冪等", async () => {
    const db = makeDb();
    setDb(db);
    const repo = new SqliteNodeRepository();
    const now = "2026-10-07T00:00:00Z";
    db.raw
      .prepare(
        `INSERT INTO nodes (id, kind, parent_id, line_id, route_id, name, position, status, priority, created_at, updated_at)
         VALUES ('L1','line',NULL,'L1',NULL,'學習',0,'todo','mid',$now,$now),
                ('R1','route','L1','L1','R1','日文',0,'todo','mid',$now,$now)`,
      )
      .run({ $now: now });
    db.raw
      .prepare(`INSERT INTO time_categories (id, name, color_idx, position, created_at, updated_at) VALUES ('cat1','閱讀',1,0,$now,$now)`)
      .run({ $now: now });
    db.raw
      .prepare(
        `INSERT INTO time_plans (id, kind, day, start_hm, end_hm, category_id, node_id, route_id, label, created_at, updated_at)
         VALUES ('adhoc-1','adhoc','2026-10-08','09:30','11:00','cat1',NULL,'R1','文法衝刺',$now,$now),
                ('adhoc-2','adhoc','2026-10-09','14:00','15:00','cat1',NULL,NULL,NULL,$now,$now),
                ('regular-1','planned','2026-10-08','16:00','17:00','cat1',NULL,'R1','一般計畫塊',$now,$now)`,
      )
      .run({ $now: now });

    const count1 = await repo.migrateAdhocPlans();
    assert.equal(count1, 2);

    const placeholders = db.raw
      .prepare(`SELECT id, name, route_id, line_id, scheduled_on, scheduled_time, estimate_min, is_placeholder FROM nodes WHERE is_placeholder = 1 AND deleted_at IS NULL ORDER BY scheduled_on`)
      .all() as Record<string, unknown>[];
    assert.equal(placeholders.length, 2);
    assert.equal(placeholders[0].name, "文法衝刺");
    assert.equal(placeholders[0].route_id, "R1");
    assert.equal(placeholders[0].line_id, "L1");
    assert.equal(placeholders[0].scheduled_on, "2026-10-08");
    assert.equal(placeholders[0].scheduled_time, "09:30");
    assert.equal(placeholders[0].estimate_min, 90);
    // 無 label 且無 node/route ⇒ 退回 category 名稱
    assert.equal(placeholders[1].name, "閱讀");
    assert.equal(placeholders[1].estimate_min, 60);

    // 舊 adhoc 已 soft delete，一般 planned 不受影響
    const alivePlans = db.raw
      .prepare(`SELECT id FROM time_plans WHERE deleted_at IS NULL`)
      .all() as { id: string }[];
    assert.deepEqual(alivePlans.map((p) => p.id), ["regular-1"]);

    // 冪等重跑：傳回 0、不重複建票
    const count2 = await repo.migrateAdhocPlans();
    assert.equal(count2, 0);
  });
});

describe("4B · 期間自由券 SQLite ＋ Memory 雙後端一致性", () => {
  async function runRangeScenario(repo: InstanceType<typeof SqliteNodeRepository> | InstanceType<typeof MemoryNodeRepository>) {
    const line = await repo.create({ kind: "line", name: "生活", parentId: null });
    const route = await repo.create({ kind: "route", name: "家務", parentId: line.id });

    // 1. 進行中期間券（10/06 ~ 10/10，今天 10/08）
    const activeA = await repo.create({
      kind: "ticket",
      name: "寄包裹",
      parentId: null,
      routeTagId: route.id,
      scheduledOn: "2026-10-06",
      scheduledEnd: "2026-10-12",
    });
    const activeB = await repo.create({
      kind: "ticket",
      name: "繳帳單",
      parentId: null,
      routeTagId: route.id,
      scheduledOn: "2026-10-07",
      scheduledEnd: "2026-10-09",
    });
    // 2. 尚未開始的未來期間券（10/10 ~ 10/15）
    const future = await repo.create({
      kind: "ticket",
      name: "打包行李",
      parentId: null,
      routeTagId: route.id,
      scheduledOn: "2026-10-10",
      scheduledEnd: "2026-10-15",
    });
    // 3. 已超過訖日的期間券（10/01 ~ 10/05）⇒ 應進 listToday late
    const overdue = await repo.create({
      kind: "ticket",
      name: "報修水龍頭",
      parentId: null,
      routeTagId: route.id,
      scheduledOn: "2026-10-01",
      scheduledEnd: "2026-10-05",
    });
    // 4. 一般單日今日票
    const single = await repo.create({
      kind: "ticket",
      name: "買牛奶",
      parentId: null,
      routeTagId: route.id,
      scheduledOn: "2026-10-08",
    });

    const todayRows = await repo.listToday("2026-10-08", 6);
    assert.deepEqual(
      todayRows.map((r) => ({ id: r.id, bucket: r.bucket })).sort((a, b) => a.id.localeCompare(b.id)),
      [
        { id: overdue.id, bucket: "late" },
        { id: single.id, bucket: "today" },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );

    const drawer = await repo.listRangeTickets("2026-10-08", 6);
    // 依 scheduled_end ASC 排序：activeB (10/09) 先於 activeA (10/12)，future 與 overdue 不在抽屜
    assert.deepEqual(drawer.map((r) => r.id), [activeB.id, activeA.id]);
    assert.equal(drawer.some((r) => r.id === future.id), false);

    // pullRangeTicketToToday：清除 scheduled_end，立即進入 listToday
    await repo.reschedule(activeB.id, "2026-10-08", "2026-10-08", { scheduledEnd: null });
    const afterPullToday = await repo.listToday("2026-10-08", 6);
    assert.ok(afterPullToday.some((r) => r.id === activeB.id && r.bucket === "today" && r.scheduled_end === null));
    const afterPullDrawer = await repo.listRangeTickets("2026-10-08", 6);
    assert.deepEqual(afterPullDrawer.map((r) => r.id), [activeA.id]);
  }

  test("SQLite 版期間自由券投影、誤點、抽屜排序與拉入今日", async () => {
    const db = makeDb();
    setDb(db);
    await runRangeScenario(new SqliteNodeRepository());
  });

  test("Memory 版期間自由券投影、誤點、抽屜排序與拉入今日", async () => {
    await runRangeScenario(new MemoryNodeRepository());
  });
});

describe("4C · Mode A（本班填空）與 Mode B（待辦入座）SQLite ＋ Memory 一致性", () => {
  async function runModeABScenario(repo: InstanceType<typeof SqliteNodeRepository> | InstanceType<typeof MemoryNodeRepository>) {
    const line = await repo.create({ kind: "line", name: "學習", parentId: null });
    const route = await repo.create({ kind: "route", name: "日文", parentId: line.id });

    // 定期預留席（每日 09:00，預估 60m）
    const slot = await repo.create({
      kind: "ticket",
      name: "深度學習席",
      parentId: null,
      routeTagId: route.id,
      scheduledTime: "09:00",
      dayStartHour: 6,
      estimateMin: 60,
      isPlaceholder: true,
    });
    await repo.setRepeatRule(slot.id, fixedRule("daily", "2026-10-07"), "2026-10-08", 6);

    // ── Mode A：本班填空 ──
    await repo.setRunCustomTitle(slot.id, "2026-10-08", "讀第 3 章");
    await repo.setRunTime(slot.id, "2026-10-08", "10:00", 6);
    // 清掉該班時刻時，custom_title 不得被連帶軟刪，且 hhmm 退回 TIME_OVERRIDE_INHERIT_HHMM ("")
    await repo.clearRunTime(slot.id, "2026-10-08");
    const todayA = await repo.listToday("2026-10-08", 6);
    const slotRowA = todayA.find((r) => r.id === slot.id);
    assert.ok(slotRowA);
    assert.equal(slotRowA.custom_title, "讀第 3 章");
    assert.equal(timeOfRow(slotRowA), "09:00"); // 退回每班時刻

    // overridesFromRows 忽略 ""（不當成清空時刻）
    const allOvr = await repo.listRunOverrides();
    assert.equal(allOvr[0]?.hhmm, TIME_OVERRIDE_INHERIT_HHMM);
    assert.deepEqual(overridesFromRows(allOvr), {});

    // 日曆投影也帶 custom_title
    const calA = await repo.listCalendar("2026-10-08", "2026-10-09", { todayDateKey: "2026-10-08", dayStartHour: 6 });
    const calEntry08 = calA.entries.find((e) => e.node_id === slot.id && e.date === "2026-10-08");
    const calEntry09 = calA.entries.find((e) => e.node_id === slot.id && e.date === "2026-10-09");
    assert.equal(calEntry08?.custom_title, "讀第 3 章");
    assert.equal(calEntry09?.custom_title ?? null, null); // 次日乾淨無覆寫

    // ── Mode B：待辦車票入座 ──
    // 先給 10/08 設回特別時刻 10:30，確認入座車票會繼承這個時刻與預估時長
    await repo.setRunTime(slot.id, "2026-10-08", "10:30", 6);
    const todoTicket = await repo.create({
      kind: "ticket",
      name: "整理錯題筆記",
      parentId: null,
      routeTagId: route.id,
      scheduledOn: "2026-10-11", // 原本在其他天
      estimateMin: 40, // 即使自己有 40m，也以空位繼承／不雙算為準
    });

    await repo.seatTicketIntoSlot(slot.id, "2026-10-08", todoTicket.id);
    const movedTicket = await repo.getNode(todoTicket.id);
    assert.equal(movedTicket?.scheduled_on, "2026-10-08");

    const todayB = await repo.listToday("2026-10-08", 6);
    // 原空位已被隱藏，只剩入座車票並掛上 seated_into
    assert.equal(todayB.some((r) => r.id === slot.id), false);
    const seatedRow = todayB.find((r) => r.id === todoTicket.id);
    assert.ok(seatedRow?.seated_into);
    assert.equal(seatedRow.seated_into.slotNodeId, slot.id);
    assert.equal(seatedRow.seated_into.slotName, "讀第 3 章");
    assert.equal(seatedRow.seated_into.slotTime, "10:30");
    assert.equal(seatedRow.seated_into.slotEstimateMin, 60);
    assert.equal(timeOfRow(seatedRow), "10:30");
    // 預估只算一次（有自身預估取自身 40、絕不 40+60 雙算；無自身預估則繼承空位 60）
    assert.equal(effectiveEstimateMin(seatedRow), 40);
    assert.equal(totalEstimateMin(todayB), 40);
    assert.equal(effectiveEstimateMin({ estimate_min: null, seated_into: seatedRow.seated_into }), 60);

    // 日曆同日也隱藏空位、將 seated_into 掛在入座車票上
    const calB = await repo.listCalendar("2026-10-08", "2026-10-09", { todayDateKey: "2026-10-08", dayStartHour: 6 });
    assert.equal(calB.entries.some((e) => e.node_id === slot.id && e.date === "2026-10-08"), false);
    const calSeated = calB.entries.find((e) => e.node_id === todoTicket.id && e.date === "2026-10-08");
    assert.equal(calSeated?.seated_into?.slotNodeId, slot.id);

    // 雙向完成同步：完成入座車票 ⇒ 定期席 10/08 班次同步蓋済並推到 10/09；撤銷 ⇒ 班次一併復原
    await repo.setCompleted(todoTicket.id, true, { dateKey: "2026-10-08", dayStartHour: 6 });
    const slotAfterDone = await repo.getNode(slot.id);
    assert.equal(slotAfterDone?.scheduled_on, "2026-10-09");
    const occsAfterDone = await repo.listOccurrences(slot.id);
    assert.ok(occsAfterDone.some((o) => o.due_on === "2026-10-08" && o.status === "done"));

    await repo.setCompleted(todoTicket.id, false, { dateKey: "2026-10-08", dayStartHour: 6 });
    const slotAfterUndo = await repo.getNode(slot.id);
    assert.equal(slotAfterUndo?.scheduled_on, "2026-10-08");

    // 改期移離 10/08 ⇒ 自動釋出原空位
    await repo.reschedule(todoTicket.id, "2026-10-12", "2026-10-08");
    const todayAfterMove = await repo.listToday("2026-10-08", 6);
    assert.ok(todayAfterMove.some((r) => r.id === slot.id), "改期移離後空位應自動恢復顯現");

    // 另建一張每週定期席，測試 moveOccurrence 10/08 → 10/09 ⇒ seated 票與 custom_title 跟著搬到 10/09
    const weeklySlot = await repo.create({
      kind: "ticket",
      name: "每週整理席",
      parentId: null,
      routeTagId: route.id,
      scheduledTime: "16:00",
      dayStartHour: 6,
      isPlaceholder: true,
    });
    await repo.setRepeatRule(weeklySlot.id, fixedRule("weekly", "2026-10-08", { byweekday: [4] }), "2026-10-08", 6);
    await repo.setRunCustomTitle(weeklySlot.id, "2026-10-08", "讀第 3 章");
    await repo.seatTicketIntoSlot(weeklySlot.id, "2026-10-08", todoTicket.id);
    await repo.moveOccurrence(weeklySlot.id, "2026-10-08", "2026-10-09", "2026-10-08", 6);
    const ticketMovedWithRun = await repo.getNode(todoTicket.id);
    assert.equal(ticketMovedWithRun?.scheduled_on, "2026-10-09");
    const ovrAfterMoveRun = await repo.listRunOverrides();
    assert.ok(
      ovrAfterMoveRun.some(
        (o) =>
          o.node_id === weeklySlot.id &&
          o.due_on === "2026-10-09" &&
          o.seated_node_id === todoTicket.id &&
          o.custom_title === "讀第 3 章",
      ),
    );

    // 軟刪已入座車票 ⇒ 自動釋出空位（custom_title 仍保留）
    await repo.softDelete(todoTicket.id);
    const ovrAfterDelete = await repo.listRunOverrides();
    assert.equal(ovrAfterDelete.some((o) => o.seated_node_id === todoTicket.id), false);
    assert.ok(
      ovrAfterDelete.some(
        (o) => o.node_id === weeklySlot.id && o.due_on === "2026-10-09" && o.custom_title === "讀第 3 章",
      ),
    );

    // releaseSeatedSlot 也對顯式解除有效，且單發預留席完成／撤済也同步
    const singleSlot = await repo.create({
      kind: "ticket",
      name: "單發空位",
      parentId: null,
      routeTagId: route.id,
      scheduledOn: "2026-10-08",
      scheduledTime: "15:00",
      dayStartHour: 6,
      estimateMin: 30,
      isPlaceholder: true,
    });
    const guest = await repo.create({
      kind: "ticket",
      name: "訪客車票",
      parentId: null,
      routeTagId: route.id,
      scheduledOn: "2026-10-08",
    });
    await repo.seatTicketIntoSlot(singleSlot.id, "2026-10-08", guest.id);
    await repo.setCompleted(guest.id, true, { dateKey: "2026-10-08", dayStartHour: 6 });
    assert.equal((await repo.getNode(singleSlot.id))?.status, "done");
    await repo.setCompleted(guest.id, false, { dateKey: "2026-10-08", dayStartHour: 6 });
    assert.equal((await repo.getNode(singleSlot.id))?.status, "todo");
    await repo.releaseSeatedSlot(singleSlot.id, "2026-10-08");
    assert.equal((await repo.listToday("2026-10-08", 6)).filter((r) => r.id === singleSlot.id || r.id === guest.id).length, 2);
  }

  test("SQLite 版 Mode A ＋ Mode B 完整閉環", async () => {
    const db = makeDb();
    setDb(db);
    await runModeABScenario(new SqliteNodeRepository());
  });

  test("Memory 版 Mode A ＋ Mode B 完整閉環", async () => {
    await runModeABScenario(new MemoryNodeRepository());
  });

  test("Mode A 當班填空在足跡／済章顯示「填空標題（母定期名）」", async () => {
    const db = makeDb();
    setDb(db);
    const repo = new SqliteNodeRepository();
    const line = await repo.create({ kind: "line", name: "學習", parentId: null });
    const route = await repo.create({ kind: "route", name: "日文", parentId: line.id });
    const slot = await repo.create({
      kind: "ticket",
      name: "每日閱讀席",
      parentId: null,
      routeTagId: route.id,
      scheduledTime: "20:00",
      dayStartHour: 6,
      isPlaceholder: true,
    });
    await repo.setRepeatRule(slot.id, fixedRule("daily", "2026-10-08"), "2026-10-08", 6);
    await repo.setRunCustomTitle(slot.id, "2026-10-08", "讀第 3 章");
    await repo.setCompleted(slot.id, true, { dateKey: "2026-10-08", dayStartHour: 6 });

    const { start, end } = dayWindow("2026-10-08", 6);
    const occRows = await db.select<Record<string, unknown>[]>(
      `SELECT o.id, o.node_id,
              CASE WHEN nto.custom_title IS NOT NULL AND nto.custom_title != '' THEN nto.custom_title || '（' || n.name || '）' ELSE n.name END AS name,
              n.kind, n.route_id, o.completed_at AS at, o.mood, o.due_on
       FROM occurrences o JOIN nodes n ON n.id = o.node_id
       LEFT JOIN node_time_overrides nto ON nto.node_id = o.node_id AND nto.due_on = o.due_on AND nto.deleted_at IS NULL
       WHERE o.deleted_at IS NULL AND o.status = 'done' AND o.completed_at >= $1 AND o.completed_at < $2`,
      [start, end],
    );
    assert.equal(occRows[0]?.name, "讀第 3 章（每日閱讀席）");

    // 領域純函式 sealsInWindow / footprintSeals / groupFootprints 同口徑
    const occs = await repo.listOccurrences(slot.id);
    const slotNode = (await repo.getNode(slot.id))!;
    const seals = sealsInWindow({ start, end }, [slotNode], occs, (nid, d) =>
      nid === slot.id && d === "2026-10-08" ? "讀第 3 章" : null,
    );
    assert.equal(seals[0]?.name, "讀第 3 章（每日閱讀席）");
    const fpSeals = footprintSeals({ start, end }, [slotNode], occs, (nid, d) =>
      nid === slot.id && d === "2026-10-08" ? "讀第 3 章" : null,
    );
    const dayFp = groupFootprints("2026-10-08", fpSeals, [], null);
    assert.equal(dayFp.seals[0]?.name, "讀第 3 章（每日閱讀席）");

    void applyTodaySeating;
  });

  test("Mode B 入座頂替蓋済後，SQLite ＆ Memory 足跡與済章僅產出 1 枚済章（不重複計算母空殼）", async () => {
    // 1. SQLite：定期預留席 + 單次預留席 各自被待辦入座並完成
    const db = makeDb();
    setDb(db);
    const sRepo = new SqliteNodeRepository();
    const sLine = await sRepo.create({ kind: "line", name: "學習", parentId: null });
    const sRoute = await sRepo.create({ kind: "route", name: "日文", parentId: sLine.id });
    const sRepeatSlot = await sRepo.create({
      kind: "ticket",
      name: "每日預留席",
      parentId: null,
      routeTagId: sRoute.id,
      scheduledTime: "09:00",
      dayStartHour: 6,
      isPlaceholder: true,
    });
    await sRepo.setRepeatRule(sRepeatSlot.id, fixedRule("daily", "2026-10-08"), "2026-10-08", 6);
    const sGuestA = await sRepo.create({
      kind: "ticket",
      name: "背 50 個單字",
      parentId: null,
      routeTagId: sRoute.id,
      scheduledOn: "2026-10-08",
    });
    await sRepo.seatTicketIntoSlot(sRepeatSlot.id, "2026-10-08", sGuestA.id);
    await sRepo.setCompleted(sGuestA.id, true, { dateKey: "2026-10-08", dayStartHour: 6 });

    const sSingleSlot = await sRepo.create({
      kind: "ticket",
      name: "單次預留席",
      parentId: null,
      routeTagId: sRoute.id,
      scheduledOn: "2026-10-08",
      scheduledTime: "14:00",
      dayStartHour: 6,
      isPlaceholder: true,
    });
    const sGuestB = await sRepo.create({
      kind: "ticket",
      name: "寫閱讀心得",
      parentId: null,
      routeTagId: sRoute.id,
      scheduledOn: "2026-10-08",
    });
    await sRepo.seatTicketIntoSlot(sSingleSlot.id, "2026-10-08", sGuestB.id);
    await sRepo.setCompleted(sGuestB.id, true, { dateKey: "2026-10-08", dayStartHour: 6 });

    const { start, end } = dayWindow("2026-10-08", 6);
    const nodeSeals = (await db.select<SealRow[]>(SEAL_NODE_SQL, [start, end])).map(sealOfRow);
    const occSeals = (await db.select<SealRow[]>(SEAL_OCC_SQL, [start, end])).map(sealOfRow);
    const sqlSeals = dedupeSeals([...nodeSeals, ...occSeals]);
    assert.deepEqual(
      sqlSeals.map((s) => s.nodeId).sort(),
      [sGuestA.id, sGuestB.id].sort(),
      "SQLite SEAL_NODE_SQL / SEAL_OCC_SQL 不得重覆吐出被入座頂替的空殼預留席",
    );

    // 2. Memory + MemoryNoteRepository.listFootprints 同口徑
    const mNodeRepo = new MemoryNodeRepository();
    const mNoteRepo = new MemoryNoteRepository(mNodeRepo, false);
    const mLine = await mNodeRepo.create({ kind: "line", name: "學習", parentId: null });
    const mRoute = await mNodeRepo.create({ kind: "route", name: "日文", parentId: mLine.id });
    const mRepeatSlot = await mNodeRepo.create({
      kind: "ticket",
      name: "每日預留席",
      parentId: null,
      routeTagId: mRoute.id,
      scheduledTime: "09:00",
      dayStartHour: 6,
      isPlaceholder: true,
    });
    await mNodeRepo.setRepeatRule(mRepeatSlot.id, fixedRule("daily", "2026-10-08"), "2026-10-08", 6);
    const mGuestA = await mNodeRepo.create({
      kind: "ticket",
      name: "背 50 個單字",
      parentId: null,
      routeTagId: mRoute.id,
      scheduledOn: "2026-10-08",
    });
    await mNodeRepo.seatTicketIntoSlot(mRepeatSlot.id, "2026-10-08", mGuestA.id);
    await mNodeRepo.setCompleted(mGuestA.id, true, { dateKey: "2026-10-08", dayStartHour: 6 });

    const mSingleSlot = await mNodeRepo.create({
      kind: "ticket",
      name: "單次預留席",
      parentId: null,
      routeTagId: mRoute.id,
      scheduledOn: "2026-10-08",
      scheduledTime: "14:00",
      dayStartHour: 6,
      isPlaceholder: true,
    });
    const mGuestB = await mNodeRepo.create({
      kind: "ticket",
      name: "寫閱讀心得",
      parentId: null,
      routeTagId: mRoute.id,
      scheduledOn: "2026-10-08",
    });
    await mNodeRepo.seatTicketIntoSlot(mSingleSlot.id, "2026-10-08", mGuestB.id);
    await mNodeRepo.setCompleted(mGuestB.id, true, { dateKey: "2026-10-08", dayStartHour: 6 });

    const fp = await mNoteRepo.listFootprints("2026-10-08", 6);
    assert.deepEqual(
      fp.seals.map((s) => s.nodeId).sort(),
      [mGuestA.id, mGuestB.id].sort(),
      "MemoryNoteRepository.listFootprints 對入座頂替也應僅產出實際完成車票的済章",
    );
  });
});

describe("4B × 時刻表日程 · 期間自由券拖上軸收斂為單日與撤回還原", () => {
  test("planItemOf / planTimeWrite / planUndo 正確收斂與還原 [scheduled_on, scheduled_end]", () => {
    const item = planItemOf(
      {
        date: "2026-10-03",
        node_id: "t-range",
        kind: "single",
        time: null,
        is_done: false,
        is_late: false,
        occurrence_status: null,
      },
      {
        estimate_min: 60,
        time_overrides: null,
        repeat_rule: null,
        scheduled_on: "2026-10-02",
        scheduled_end: "2026-10-04",
      },
    );
    assert.deepEqual(item.rangeOrigin, { start: "2026-10-02", end: "2026-10-04" });

    assert.deepEqual(planTimeWrite(item, "14:00"), {
      op: "setTime",
      id: "t-range",
      time: "14:00",
      scheduledOn: "2026-10-03",
      scheduledEnd: null,
    });
    assert.deepEqual(planUndo(item), {
      op: "setTime",
      id: "t-range",
      time: null,
      scheduledOn: "2026-10-02",
      scheduledEnd: "2026-10-04",
    });
  });
});
