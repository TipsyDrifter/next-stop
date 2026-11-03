/**
 * 時刻表線⑦——repository 層：塊的備註、作息範本、預定（⑦ 契約 §2–§6）。SQLite 版與記憶體版跑同一套。
 * 跑法：`node --test scripts/tests/timetable-plans-sqlite.test.ts`（node 24，型別剝除預設開；零依賴）。
 *
 * SQLite：node:sqlite 記憶體庫＋`src-tauri/migrations` 全部依序跑（真的 DDL，含 0014）；`../lib/db` 換成回這顆庫的替身、
 * `./syncRepository` 換成照順序執行 SQL、把 op 記下來的假批次（看「一次寫入＝一個 batch、op 帶哪些欄」）。載入法同 `core-polish7-sqlite.test.ts`。
 * `db.cells = true`＝模擬「已加入同步」：`ensureSyncTables` 回 true、每筆 op 的每一欄在 sync_cells 戳一格（同 syncSideStatements），
 * repository 據此分辨「同步過的列」。
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
let t = Date.now() - 1000 * 60 * 60 * 24 * 3; // 寫入戳記：一直往前走、比真實時間早（不會比 Date.now() 晚）
export function getDb() { const d = globalThis.__plansDb; if (!d) throw new Error("測試沒設 __plansDb"); return Promise.resolve(d); }
export function uuid() { return crypto.randomUUID(); }
export function nowUtcIso() { t += 1000; return new Date(t).toISOString(); }
`;
const FAKE_SYNC = `
export function newWriteBatch() { return { stmts: [], ops: [] }; }
export async function runWriteBatch(db, stmts, ops) { db.runBatch(stmts, ops); }
export async function ensureSyncTables(db) { return !!db.cells; }
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
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) raw.exec(readFileSync(path.join(dir, f), "utf8"));
  raw.exec("PRAGMA foreign_keys = OFF"); // 測資的分類 id 是假的（放在 migration 之後：有支 migration 會把它打開）
  let hlc = 0;
  const bind = (args: unknown[] = []) => Object.fromEntries(args.map((v, i) => ["$" + (i + 1), v])) as Record<string, never>;
  const db = {
    batches: [] as Op[][],
    async select(sql: string, args?: unknown[]) {
      return raw.prepare(sql).all(bind(args)).map((r) => ({ ...r }));
    },
    async execute(sql: string, args?: unknown[]) {
      raw.prepare(sql).run(bind(args));
      return { rowsAffected: 0 };
    },
    cells: false,
    runBatch(stmts: { sql: string; args: unknown[] }[], ops: Op[]) {
      raw.exec("BEGIN");
      try {
        for (const st of stmts) raw.prepare(st.sql).run(bind(st.args));
        if (db.cells) {
          for (const o of ops) {
            for (const c of Object.keys(o.cols)) {
              raw.prepare("INSERT OR REPLACE INTO sync_cells (tbl, row_id, col, hlc, device_id) VALUES (?, ?, ?, ?, ?)").run(o.tbl, o.row_id, c, String(++hlc).padStart(13, "0") + "0000-dev", "dev");
            }
          }
        }
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

const { MIN, isoOf } = await import("../../src/domain/timetable.ts");
const { SqliteTimetableRepository } = await import("../../src/data/sqliteTimetableRepository.ts");
const { MemoryTimetableRepository } = await import("../../src/data/memoryTimetableRepository.ts");
const { WEEKDAYS_WORK, dayRoutineOf, planApplyRoutine, planEnsureMaterialized, planFillRoutine, serializeRoutineItems } = await import(
  "../../src/domain/timetableRoutine.ts"
);

const HOUR = 60 * MIN;
/** 兩天前 00:00（本地）起算：都在過去，fill 不會被「不能記未來」擋 */
const base = (() => {
  const d = new Date();
  d.setDate(d.getDate() - 2);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
})();
const at = (h: number, m = 0): string => isoOf(base + h * HOUR + m * MIN);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Repo = any;
type Maker = () => { repo: Repo; db: ReturnType<typeof makeDb> | null };
const makers: [string, Maker][] = [
  [
    "sqlite",
    () => {
      const db = makeDb();
      (globalThis as Record<string, unknown>).__plansDb = db;
      return { repo: new SqliteTimetableRepository(), db };
    },
  ],
  ["memory", () => ({ repo: new MemoryTimetableRepository({ seedDemo: false, nodeRepo: {} as never }), db: null })],
];

const ITEMS = [
  { cat: "c-create", s: "09:00", e: "12:00" },
  { cat: "c-meal", s: "12:00", e: "13:00", n: "午餐" },
];

for (const [name, make] of makers) {
  describe(`${name}：⑦ 塊的備註`, () => {
    test("補記帶備註 ⇒ 列上有；op 是一筆完整列、帶 note（一次寫入＝一個 batch）", async () => {
      const { repo, db } = make();
      const before = db?.batches.length ?? 0;
      const r = await repo.fill("c-create", at(9), at(11), { note: "  寫第三章\n草稿 " });
      assert.equal(r.block.note, "寫第三章 草稿");
      if (db) {
        assert.equal(db.batches.length, before + 1);
        const op = db.batches[db.batches.length - 1].find((o) => o.row_id === r.block.id)!;
        assert.equal(op.cols.note, "寫第三章 草稿");
      }
      const blank = await repo.fill("c-create", at(12), at(13), { note: "   " });
      assert.equal(blank.block.note, null);
    });

    test("切開、多切點、被蓋掉切出的尾段都帶備註；「改成另一個分類」切出的那段不帶", async () => {
      const { repo } = make();
      const a = (await repo.fill("c-create", at(9), at(12), { note: "原稿" })).block;
      const piece = await repo.split(a.id, at(10), "c-study");
      assert.equal(piece.note, "原稿");
      const multi = await repo.splitMulti(a.id, [at(9, 20), at(9, 40)], ["c-create", "c-study", "c-create"]);
      assert.deepEqual(multi.map((r: Repo) => r.note), ["原稿", "原稿", "原稿"]);
      // 補記蓋在 piece（10:00–12:00）中間 ⇒ 尾段帶 piece 的備註、補記那塊是自己的
      await repo.fill("c-play", at(10, 30), at(11), { note: "插進來的" });
      const day = await repo.listBlocks(at(0), at(24));
      const tail = day.find((r: Repo) => r.started_at === at(11));
      assert.equal(tail?.note, "原稿");
      assert.equal(day.find((r: Repo) => r.started_at === at(10, 30))?.note, "插進來的");
      // 跑太久「改成另一個分類」（planResolveLongRun cat）：切出的那段不帶
      const b = (await repo.fill("c-create", at(14), at(20), { note: "長的" })).block;
      await repo.resolveLongRun(b.id, at(15), "cat", "c-rest");
      const after = (await repo.listBlocks(at(14), at(21))).find((r: Repo) => r.started_at === at(15));
      assert.equal(after?.category_id, "c-rest");
      assert.equal(after?.note, null);
    });

    test("合併留當前塊的備註，當前塊沒寫才拿鄰居的", async () => {
      const { repo } = make();
      const a = (await repo.fill("c-create", at(9), at(10), { note: "上一塊" })).block;
      const b = (await repo.fill("c-create", at(10), at(11))).block;
      await repo.merge(b.id, "prev", at(0));
      const kept = await repo.getBlock(b.id);
      assert.equal(kept.note, "上一塊", "當前沒寫 ⇒ 拿被吞那塊的");
      assert.equal(await repo.getBlock(a.id), null, "鄰居被吞");
      const c = (await repo.fill("c-create", at(11), at(12), { note: "下一塊" })).block;
      await repo.merge(b.id, "next", at(23));
      assert.equal((await repo.getBlock(b.id)).note, "上一塊", "當前有寫 ⇒ 留自己的");
      assert.equal(await repo.getBlock(c.id), null);
    });

    test("editBlock：note undefined＝不動、null／空白＝清掉、跟現值一樣不寫", async () => {
      const { repo, db } = make();
      const a = (await repo.fill("c-create", at(9), at(10), { note: "x" })).block;
      const n0 = db?.batches.length ?? 0;
      await repo.editBlock(a.id, { categoryId: "c-create", startIso: a.started_at, endIso: a.ended_at, note: "x" });
      if (db) assert.equal(db.batches.length, n0, "什麼都沒變 ⇒ 不寫");
      await repo.editBlock(a.id, { categoryId: "c-create", startIso: a.started_at, endIso: a.ended_at });
      assert.equal((await repo.getBlock(a.id)).note, "x");
      await repo.editBlock(a.id, { categoryId: "c-create", startIso: a.started_at, endIso: a.ended_at, note: "改了" });
      if (db) {
        const op = db.batches[db.batches.length - 1][0];
        assert.deepEqual(Object.keys(op.cols).sort(), ["note", "updated_at"], "只送變了的欄");
      }
      await repo.editBlock(a.id, { categoryId: "c-create", startIso: a.started_at, endIso: a.ended_at, note: "  " });
      assert.equal((await repo.getBlock(a.id)).note, null);
    });

    test("editRunning 收備註", async () => {
      const { repo } = make();
      const r = (await repo.depart("c-create", at(9))).block;
      await repo.editRunning(r.id, { categoryId: "c-create", startIso: r.started_at, note: "進行中" });
      assert.equal((await repo.getBlock(r.id)).note, "進行中");
    });

    test("searchBlocks（只比備註、不分大小寫、新的在前、limit）與 listBlockNotes（依備註＋分類數塊數、留最近）", async () => {
      const { repo } = make();
      await repo.fill("c-create", at(9), at(10), { note: "Draft 第三章" });
      await repo.fill("c-create", at(11), at(12), { note: "draft 第四章" });
      await repo.fill("c-study", at(13), at(14), { note: "讀書會" });
      const gone = (await repo.fill("c-study", at(15), at(16), { note: "draft 刪掉的" })).block;
      await repo.softDelete(gone.id);
      const hits = await repo.searchBlocks("DRAFT", 10);
      assert.deepEqual(hits.map((r: Repo) => r.note), ["draft 第四章", "Draft 第三章"]);
      assert.deepEqual((await repo.searchBlocks("draft", 1)).map((r: Repo) => r.note), ["draft 第四章"]);
      assert.deepEqual(await repo.searchBlocks("  ", 10), []);
      await repo.fill("c-study", at(17), at(18), { note: "讀書會" });
      const tally = await repo.listBlockNotes();
      const club = tally.find((t: Repo) => t.note === "讀書會");
      assert.equal(club.count, 2);
      assert.equal(club.category_id, "c-study");
      assert.equal(club.last, at(17));
      assert.equal(tally[0].note, "讀書會", "最近的在前");
      assert.equal(tally.some((t: Repo) => t.note === "draft 刪掉的"), false, "已刪除的不算");
    });
  });

  describe(`${name}：⑦ 作息範本`, () => {
    test("建、改（只送變了的欄）、封存、刪、復原、重排", async () => {
      const { repo, db } = make();
      await assert.rejects(repo.createRoutine({ name: "  ", items: [], weekdays: 0 }), /名稱/);
      await assert.rejects(repo.createRoutine({ name: "x", items: [{ cat: "c", s: "10:00", e: "09:00" }], weekdays: 0 }), /晚於/);
      const a = await repo.createRoutine({ name: "工作日", items: ITEMS.slice().reverse(), weekdays: WEEKDAYS_WORK | 0x80 });
      assert.equal(a.items, serializeRoutineItems(ITEMS), "段依開始排好");
      assert.equal(a.weekdays, WEEKDAYS_WORK, "多出來的位元截掉");
      const b = await repo.createRoutine({ name: "假日", items: [], weekdays: 0 });
      assert.equal(b.position, a.position + 1);
      const n0 = db?.batches.length ?? 0;
      await repo.updateRoutine(a.id, { name: "工作日", weekdays: WEEKDAYS_WORK });
      if (db) assert.equal(db.batches.length, n0, "沒變 ⇒ 不寫");
      await repo.updateRoutine(a.id, { name: "上班日" });
      if (db) assert.deepEqual(Object.keys(db.batches[db.batches.length - 1][0].cols).sort(), ["name", "updated_at"]);
      assert.equal((await repo.getRoutine(a.id)).name, "上班日");
      await repo.archiveRoutine(b.id, true);
      assert.ok((await repo.listRoutines()).find((r: Repo) => r.id === b.id).archived_at, "封存的照樣列");
      await repo.deleteRoutine(b.id);
      assert.equal((await repo.listRoutines()).some((r: Repo) => r.id === b.id), false);
      assert.ok(await repo.getRoutine(b.id, { withDeleted: true }));
      await repo.restoreRoutine(b.id);
      await repo.archiveRoutine(b.id, false);
      const c = await repo.createRoutine({ name: "第三套", items: [], weekdays: 0 });
      await repo.reorderRoutines([c.id, a.id]);
      const order = (await repo.listRoutines()).map((r: Repo) => r.id);
      assert.deepEqual(order, [c.id, a.id, b.id], "清單沒提到的接尾端");
      await assert.rejects(repo.updateRoutine("nope", { name: "x" }), /找不到/);
    });
  });

  describe(`${name}：⑦ 預定`, () => {
    test("落地兩次＝同一批 id（不重複）；listPlans 含已刪；這天不套留墓碑", async () => {
      const { repo } = make();
      const r = await repo.createRoutine({ name: "工作日", items: ITEMS, weekdays: WEEKDAYS_WORK });
      const day = "2026-11-02"; // 週一
      const w1 = await planEnsureMaterialized(day, await repo.listPlans(day, day), [r]);
      assert.equal(await repo.materializePlans(w1), 2);
      const ids1 = (await repo.listPlans(day, day)).map((p: Repo) => p.id).sort();
      assert.equal(ids1.length, 2);
      // 再落地一次（rows 給空的）：同 id ⇒ 本機已有、不碰，不多列
      assert.equal(await repo.materializePlans(await planEnsureMaterialized(day, [], [r])), 0);
      assert.deepEqual((await repo.listPlans(day, day)).map((p: Repo) => p.id).sort(), ids1);
      assert.deepEqual(await planEnsureMaterialized(day, await repo.listPlans(day, day), [r]), [], "已落地 ⇒ 不再寫");
      // 這天不套
      await repo.writePlans(await planApplyRoutine(day, await repo.listPlans(day, day), null, [r]));
      const rows = await repo.listPlans(day, day);
      assert.equal(rows.length, 2, "墓碑還在");
      assert.ok(rows.every((p: Repo) => p.deleted_at !== null));
      // 另一天：沒落地就「這天不套」＝把範本那批寫成已刪
      const day2 = "2026-11-03";
      await repo.writePlans(await planApplyRoutine(day2, [], null, [r]));
      const rows2 = await repo.listPlans(day2, day2);
      assert.equal(rows2.length, 2);
      assert.ok(rows2.every((p: Repo) => p.deleted_at !== null && p.routine_id === r.id));
    });

    test("車票段：insert、listPlansByNode（活著的、day → 時刻）、update（只送變了的）、delete、restore；時刻不對整批不寫", async () => {
      const { repo, db } = make();
      if (db) db.cells = true; // 已加入同步：車票段建立時就送了完整列 ⇒ 之後的改動只送變了的欄
      const mk = (id: string, day: string, s: string, e: string) => ({ id, day, start_hm: s, end_hm: e, category_id: null, node_id: "n-1", routine_id: null, label: null });
      await repo.insertPlans([mk("s2", "2026-11-04", "14:00", "16:00"), mk("s1", "2026-11-03", "09:00", "10:00")]);
      await assert.rejects(repo.insertPlans([mk("bad1", "2026-11-04", "09:00", "10:00"), mk("bad2", "2026-11-04", "11:00", "10:00")]), /晚於/);
      assert.equal(await repo.getPlan("bad1"), null, "整批不寫");
      assert.deepEqual((await repo.listPlansByNode("n-1")).map((p: Repo) => p.id), ["s1", "s2"]);
      const n0 = db?.batches.length ?? 0;
      await repo.updatePlan("s2", { start_hm: "14:00" });
      if (db) assert.equal(db.batches.length, n0, "沒變 ⇒ 不寫");
      await repo.updatePlan("s2", { end_hm: "17:00", day: "2026-11-05" });
      if (db) assert.deepEqual(Object.keys(db.batches[db.batches.length - 1][0].cols).sort(), ["day", "end_hm", "updated_at"]);
      await assert.rejects(repo.updatePlan("s2", { start_hm: "18:00" }), /晚於/);
      const s2 = await repo.getPlan("s2");
      assert.deepEqual([s2.day, s2.start_hm, s2.end_hm], ["2026-11-05", "14:00", "17:00"]);
      await repo.deletePlan("s1");
      assert.deepEqual((await repo.listPlansByNode("n-1")).map((p: Repo) => p.id), ["s2"]);
      assert.equal(await repo.getPlan("s1"), null);
      assert.ok(await repo.getPlan("s1", { withDeleted: true }));
      assert.equal((await repo.listPlans("2026-11-03", "2026-11-03")).length, 1, "listPlans 含已刪");
      await repo.restorePlan("s1");
      assert.equal((await repo.listPlansByNode("n-1")).length, 2);
      await assert.rejects(repo.updatePlan("nope", { day: "2026-11-05" }), /找不到/);
      if (db) {
        // insert 的 op 是完整列（收到方沒有這列時必填欄要齊）
        const all = db.batches.flat().filter((o) => o.tbl === "time_plans" && o.row_id === "s1");
        assert.ok(all.some((o) => o.cols.day === "2026-11-03" && o.cols.start_hm === "09:00" && o.cols.end_hm === "10:00" && "created_at" in o.cols));
      }
    });

    test("重新套用：已落地的同 id 列 upsert 回範本的樣子（created_at 照留）", async () => {
      const { repo } = make();
      const r = await repo.createRoutine({ name: "工作日", items: ITEMS, weekdays: WEEKDAYS_WORK });
      const day = "2026-11-02";
      await repo.materializePlans(await planEnsureMaterialized(day, [], [r]));
      const first = (await repo.listPlans(day, day))[0];
      await repo.updatePlan(first.id, { start_hm: "08:00" });
      await repo.writePlans(await planApplyRoutine(day, await repo.listPlans(day, day), r, [r]));
      const again = await repo.getPlan(first.id);
      assert.equal(again.start_hm, "09:00");
      assert.equal(again.created_at, first.created_at);
      assert.equal(again.deleted_at, null);
    });

    test("段的名字 label（D-時-167）：落地帶範本的 n；updatePlan 改／清（空白＝null）；op 帶 label", async () => {
      const { repo, db } = make();
      const r = await repo.createRoutine({ name: "工作日", items: ITEMS, weekdays: WEEKDAYS_WORK });
      const day = "2026-11-02";
      await repo.materializePlans(await planEnsureMaterialized(day, [], [r]));
      const rows = await repo.listPlans(day, day);
      assert.deepEqual(rows.map((p: Repo) => p.label), [null, "午餐"]);
      await repo.updatePlan(rows[1].id, { label: " 早午餐 " });
      assert.equal((await repo.getPlan(rows[1].id)).label, "早午餐");
      if (db) assert.equal(db.batches[db.batches.length - 1][0].cols.label, "早午餐", "op 帶 label");
      await repo.updatePlan(rows[1].id, { label: "  " });
      assert.equal((await repo.getPlan(rows[1].id)).label, null);
    });
  });

  describe(`${name}：⑦ 作息落地只寫本機、收到就補齊（兩台）`, () => {
    /*
     * 兩台＝兩個 repository（sqlite：兩顆庫，呼叫前把 `__plansDb` 換成那一台的）。
     * 同步：sqlite＝把 A 這段期間真的送出的 op 套到 B，套法照同步引擎 `apply_object_with` 在「收到方沒有比較新的格子」時的行為——
     *   列在 ⇒ 照 op 的欄改；列不在 ⇒ NOT NULL 又沒 DEFAULT 的欄都有才建，缺了整筆跳過。
     * memory（沒有 op）＝把 A 這段期間變了的列整列抄過去（＝沒同步過的列送的完整列）。
     */
    type Dev = { repo: Repo; db: ReturnType<typeof makeDb> | null };
    const DAY = "2026-11-02"; // 週一
    const ITEMS3 = [...ITEMS, { cat: "c-study", s: "14:00", e: "16:00" }];
    const two = (): [Dev, Dev] => [make(), make()];
    const on = async <T,>(d: Dev, fn: (r: Repo) => Promise<T>): Promise<T> => {
      if (d.db) (globalThis as Record<string, unknown>).__plansDb = d.db;
      return fn(d.repo);
    };
    type Mark = { n: number; snap: Map<string, string> };
    const mem = (d: Dev): { plans: Map<string, Repo>; routines: Map<string, Repo> } => d.repo as never;
    const mark = (d: Dev): Mark => ({
      n: d.db?.batches.length ?? 0,
      snap: d.db ? new Map() : new Map([...mem(d).plans, ...mem(d).routines].map(([k, v]) => [k, JSON.stringify(v)])),
    });
    /** A 從 m 之後送出的 op（memory：變了的列） */
    const sent = (d: Dev, m: Mark): Op[] => {
      if (d.db) return d.db.batches.slice(m.n).flat();
      const out: Op[] = [];
      for (const [tbl, map] of [["time_plans", mem(d).plans], ["time_routines", mem(d).routines]] as const) {
        for (const [id, row] of map) if (m.snap.get(id) !== JSON.stringify(row)) out.push({ tbl, row_id: id, op: "upsert", cols: { ...row } });
      }
      return out;
    };
    const planOps = (ops: Op[]): Op[] => ops.filter((o) => o.tbl === "time_plans");
    let skipped = 0;
    const deliver = async (to: Dev, ops: Op[]): Promise<void> => {
      if (!to.db) {
        for (const o of ops) (o.tbl === "time_plans" ? mem(to).plans : mem(to).routines).set(o.row_id, { ...(o.cols as Repo) });
        return;
      }
      for (const o of ops) {
        const info = await to.db.select(`PRAGMA table_info(${o.tbl})`);
        const known = new Set(info.map((c: Repo) => c.name));
        const cols = Object.keys(o.cols).filter((c) => known.has(c) && c !== "id");
        const has = (await to.db.select(`SELECT id FROM ${o.tbl} WHERE id = $1`, [o.row_id])).length > 0;
        if (has) {
          if (!cols.length) continue;
          const sets = cols.map((c, i) => `${c} = $${i + 1}`).join(", ");
          await to.db.execute(`UPDATE ${o.tbl} SET ${sets} WHERE id = $${cols.length + 1}`, [...cols.map((c) => o.cols[c]), o.row_id]);
        } else {
          const required = info.filter((c: Repo) => c.notnull === 1 && c.dflt_value === null && c.pk === 0).map((c: Repo) => c.name);
          if (required.some((c: string) => o.cols[c] === undefined || o.cols[c] === null)) {
            skipped++;
            continue;
          }
          const marks = ["$1", ...cols.map((_, i) => `$${i + 2}`)].join(", ");
          await to.db.execute(`INSERT INTO ${o.tbl} (id, ${cols.join(", ")}) VALUES (${marks})`, [o.row_id, ...cols.map((c) => o.cols[c])]);
        }
      }
    };
    /** 一台這天「載入／收到之後」：補齊（只寫本機），回那天畫出來的樣子 */
    const settle = async (d: Dev, today = DAY) =>
      on(d, async (repo) => {
        const routines = await repo.listRoutines();
        await repo.materializePlans(await planFillRoutine(DAY, await repo.listPlans(DAY, DAY), routines));
        return dayRoutineOf(DAY, await repo.listPlans(DAY, DAY), routines, today);
      });
    const view = (v: Repo) => ({ routineId: v.routineId, segs: v.segs.map((s: Repo) => [s.id, s.s, s.e, s.routineId]) });
    /** 這台把這天在本機落地（今天的自動落地／動某一段之前）；回寫入的 op 數（應該是 0） */
    const land = async (d: Dev): Promise<number> => {
      const m = mark(d);
      await on(d, async (repo) => repo.materializePlans(await planEnsureMaterialized(DAY, await repo.listPlans(DAY, DAY), await repo.listRoutines())));
      return d.db ? planOps(sent(d, m)).length : 0;
    };
    const setup = async (): Promise<{ A: Dev; B: Dev; r: Repo }> => {
      const [A, B] = two();
      const m = mark(A);
      const r = await on(A, (repo) => repo.createRoutine({ name: "工作日", items: ITEMS3, weekdays: WEEKDAYS_WORK }));
      await deliver(B, sent(A, m));
      return { A, B, r };
    };
    /** A 改第一段、刪第二段（使用者動手：一般寫入） */
    const editAndDelete = async (A: Dev): Promise<Op[]> => {
      const m = mark(A);
      await on(A, async (repo) => {
        const [s1, s2] = (await repo.listPlans(DAY, DAY)).filter((p: Repo) => p.routine_id !== null);
        await repo.updatePlan(s1.id, { start_hm: "09:30" });
        await repo.deletePlan(s2.id);
      });
      return planOps(sent(A, m));
    };

    test("(e) 落地兩次＝同一批、不重複，而且都不送 op；已改過的段不被蓋回", async () => {
      const { A } = await setup();
      assert.equal(await land(A), 0, "落地不送 op");
      assert.equal(await land(A), 0);
      const rows = await on(A, (repo) => repo.listPlans(DAY, DAY));
      assert.equal(rows.length, 3);
      await on(A, (repo) => repo.updatePlan(rows[0].id, { start_hm: "09:30" }));
      assert.equal(await land(A), 0);
      await on(A, async (repo) => assert.equal(await repo.materializePlans(await planFillRoutine(DAY, await repo.listPlans(DAY, DAY), await repo.listRoutines())), 0));
      assert.equal((await on(A, (repo) => repo.getPlan(rows[0].id))).start_hm, "09:30");
    });

    test("(a) A 本機落地、改一段刪一段 ⇒ 只有這兩段送 op（完整列）；B 從沒落地，收到之後補齊＝整天、跟 A 一樣", async () => {
      const { A, B } = await setup();
      assert.equal(await land(A), 0);
      const ops = await editAndDelete(A);
      if (A.db) {
        assert.equal(ops.length, 2, "只送使用者動的兩段");
        for (const o of ops) for (const c of ["day", "start_hm", "end_hm", "routine_id", "category_id", "created_at"]) assert.ok(c in o.cols, `完整列：${c}`);
        const del = ops.find((o) => o.op === "delete")!;
        assert.notEqual(del.cols.deleted_at, null);
        assert.equal("deleted_at" in ops.find((o) => o.op === "upsert")!.cols, false, "改段的完整列不帶 deleted_at（留給編輯勝刪除）");
      }
      skipped = 0;
      await deliver(B, ops);
      assert.equal(skipped, 0, "收到方沒有這兩列也建得起來");
      const mB = mark(B);
      const vB = await settle(B);
      if (B.db) assert.equal(planOps(sent(B, mB)).length, 0, "補齊不送 op");
      const vA = await settle(A);
      assert.deepEqual(view(vB), view(vA));
      assert.equal(vB.segs.length, 2);
      assert.equal(vB.segs[0].s, "09:30", "改過的那段");
      assert.equal((await on(B, (repo) => repo.listPlans(DAY, DAY))).length, 3, "刪掉的那段是墓碑、沒被補回來");
    });

    test("(b) B 早就在本機落地過，再收到 A 的改／刪 ⇒ 跟 A 一樣（刪掉的不復活、改的不被蓋回）", async () => {
      const { A, B } = await setup();
      assert.equal(await land(B), 0);
      assert.equal(await land(A), 0);
      await deliver(B, await editAndDelete(A));
      const vB = await settle(B);
      assert.deepEqual(view(vB), view(await settle(A)));
      assert.equal(vB.segs.length, 2);
      // B 後來又載入一次（冷啟動落地）：列都在 ⇒ 什麼都不寫
      assert.equal(await land(B), 0);
      assert.deepEqual(view(await settle(B)), view(vB));
    });

    for (const bLanded of [false, true]) {
      test(`(c) A 換成另一套 ⇒ B${bLanded ? "（本機落地過舊那套）" : "（沒落地過）"}收到之後是新那套、舊那套是墓碑或沒有，不疊兩套`, async () => {
        const { A, B } = await setup();
        const m = mark(A);
        const w = await on(A, (repo) => repo.createRoutine({ name: "週末", items: [{ cat: "c-play", s: "10:00", e: "18:00" }], weekdays: 0 }));
        await deliver(B, sent(A, m));
        if (bLanded) await land(B);
        await land(A);
        const m2 = mark(A);
        await on(A, async (repo) => repo.writePlans(await planApplyRoutine(DAY, await repo.listPlans(DAY, DAY), w, await repo.listRoutines())));
        const ops = planOps(sent(A, m2));
        if (A.db) assert.equal(ops.length, 4, "舊那套三段的墓碑＋新那套一段");
        await deliver(B, ops);
        const vB = await settle(B);
        assert.equal(vB.routineId, w.id);
        assert.deepEqual(vB.segs.map((s: Repo) => s.routineId), [w.id]);
        assert.deepEqual(view(vB), view(await settle(A)));
        const old = (await on(B, (repo) => repo.listPlans(DAY, DAY))).filter((p: Repo) => p.routine_id !== w.id);
        assert.ok(old.every((p: Repo) => p.deleted_at !== null), "舊那套在 B 上都是墓碑");
      });
    }

    test("(f) 沙盒 X8：兩台離線時同一天各換一套 ⇒ 同步後兩台都只畫後換的那一套；補齊不把輸的那套補完整；重新套用一次資料就收成一套", async () => {
      const { A, B } = await setup();
      const m = mark(A);
      const wk = await on(A, (repo) =>
        repo.createRoutine({ name: "週末", items: [{ cat: "c-rest", s: "10:00", e: "12:00" }, { cat: "c-gym", s: "16:00", e: "17:00" }], weekdays: 0 }),
      );
      const st = await on(A, (repo) =>
        repo.createRoutine({
          name: "讀書週",
          items: [{ cat: "c-study", s: "09:00", e: "11:00" }, { cat: "c-study", s: "14:00", e: "16:00" }, { cat: "c-study", s: "20:00", e: "22:00" }],
          weekdays: 0,
        }),
      );
      await deliver(B, sent(A, m));
      // 兩台都是虛擬的工作日；離線時各自動手（store 的 applyRoutine：先在本機落地、再換）
      await land(A);
      await land(B);
      const mA = mark(A);
      await on(A, async (repo) => repo.writePlans(await planApplyRoutine(DAY, await repo.listPlans(DAY, DAY), wk, await repo.listRoutines())));
      const opsA = planOps(sent(A, mA));
      const mB = mark(B);
      await on(B, async (repo) => repo.writePlans(await planApplyRoutine(DAY, await repo.listPlans(DAY, DAY), st, await repo.listRoutines())));
      const opsB = planOps(sent(B, mB));
      const aliveOf = async (d: Dev, rid: string): Promise<string[]> =>
        (await on(d, (repo) => repo.listPlans(DAY, DAY)))
          .filter((p: Repo) => p.deleted_at === null && p.routine_id === rid)
          .map((p: Repo) => p.id)
          .sort();
      // B 先只收到 A 換的週末其中一段：B 畫的照樣是自己後換的讀書週，補齊也不把週末補完整
      const wkOps = opsA.filter((o) => o.op === "upsert" && o.cols.routine_id === wk.id);
      assert.equal(wkOps.length, 2);
      await deliver(B, opsA.filter((o) => o.row_id !== wkOps[1].row_id));
      const mB2 = mark(B);
      const partial = await settle(B);
      if (B.db) assert.equal(planOps(sent(B, mB2)).length, 0, "補齊不送 op");
      assert.equal(partial.routineId, st.id);
      assert.equal((await aliveOf(B, wk.id)).length, 1, "輸的那套沒被補回第二段");
      // 其餘的都到齊、兩台互相收到
      await deliver(B, opsA.filter((o) => o.row_id === wkOps[1].row_id));
      await deliver(A, opsB);
      const vA = await settle(A);
      const vB = await settle(B);
      assert.equal(vA.routineId, st.id, "B 晚換的讀書週");
      assert.deepEqual(vA.segs.map((s: Repo) => s.routineId), [st.id, st.id, st.id], "作息帶只畫一套、不疊");
      assert.deepEqual(view(vB), view(vA), "兩台一樣");
      assert.equal((await aliveOf(A, wk.id)).length, 2, "讀的時候判斷：輸的那套的列還活著（沒為這件事多送 op）");
      // 使用者在 A 上「重新套用」一次 ⇒ 輸的那套也軟刪；B 收到之後兩台的活列一模一樣、只剩讀書週
      const mA2 = mark(A);
      await on(A, async (repo) => repo.writePlans(await planApplyRoutine(DAY, await repo.listPlans(DAY, DAY), st, await repo.listRoutines())));
      await deliver(B, planOps(sent(A, mA2)));
      for (const d of [A, B]) {
        assert.deepEqual(await aliveOf(d, wk.id), []);
        assert.equal((await aliveOf(d, st.id)).length, 3);
      }
      assert.deepEqual(view(await settle(B)), view(await settle(A)));
    });

    test("(d) 沒落地過的一天「這天不套」⇒ 送整套的墓碑（完整列）；B 收到之後那天空的、也不會再自動落地", async () => {
      const { A, B } = await setup();
      const m = mark(A);
      // store 的 applyRoutine(day, null)：先在本機落地（不送 op），再全部軟刪（一般寫入）
      await land(A);
      await on(A, async (repo) => repo.writePlans(await planApplyRoutine(DAY, await repo.listPlans(DAY, DAY), null, await repo.listRoutines())));
      const ops = planOps(sent(A, m));
      if (A.db) {
        assert.equal(ops.length, 3);
        assert.ok(ops.every((o) => o.cols.deleted_at !== null && o.cols.routine_id !== undefined && o.cols.start_hm !== undefined));
      }
      skipped = 0;
      await deliver(B, ops);
      assert.equal(skipped, 0);
      const vB = await settle(B);
      assert.equal(vB.materialized, true);
      assert.deepEqual(vB.segs, []);
      assert.equal(await land(B), 0);
      assert.equal((await on(B, (repo) => repo.listPlans(DAY, DAY))).filter((p: Repo) => p.deleted_at === null).length, 0, "B 冷啟動不會再落地");
    });

    if (name === "sqlite") {
      test("同步過的列（本機有 sync_cells 戳記）⇒ 改只送變了的欄、刪只送 deleted_at；沒同步過的才送完整列", async () => {
        const { repo, db } = make();
        db!.cells = true;
        const r = await repo.createRoutine({ name: "工作日", items: ITEMS3, weekdays: WEEKDAYS_WORK });
        await repo.materializePlans(await planEnsureMaterialized(DAY, [], [r]));
        const [s1, s2, s3] = (await repo.listPlans(DAY, DAY)).filter((p: Repo) => p.routine_id !== null);
        const last = (): Op => db!.batches[db!.batches.length - 1][0];
        await repo.updatePlan(s1.id, { start_hm: "09:30" });
        assert.ok("day" in last().cols && "created_at" in last().cols, "第一次動：完整列");
        await repo.updatePlan(s1.id, { end_hm: "11:30" });
        assert.deepEqual(Object.keys(last().cols).sort(), ["end_hm", "updated_at"], "同步過：只送變了的");
        await repo.deletePlan(s1.id);
        assert.deepEqual(Object.keys(last().cols).sort(), ["deleted_at", "updated_at"]);
        await repo.restorePlan(s1.id);
        assert.deepEqual(Object.keys(last().cols).sort(), ["deleted_at", "updated_at"]);
        await repo.deletePlan(s2.id);
        assert.ok("start_hm" in last().cols && last().cols.deleted_at !== null, "沒同步過的刪除：完整列＋deleted_at");
        await repo.restorePlan(s2.id);
        assert.deepEqual(Object.keys(last().cols).sort(), ["deleted_at", "updated_at"], "刪除那筆送過了 ⇒ 同步過");
        assert.equal(s3.deleted_at, null);
      });
    }
  });
}
