/**
 * 時刻表線⑤・方眼純函式測試（⑤ 契約 §4；甲席）。
 * 跑法：`node --test scripts/tests/timetable-grid.test.ts`（node 24，型別剝除預設開；零依賴）。
 *
 * 時區：測資一律用 `new Date(y, m-1, d, h, mi, s).getTime()` 造本地時刻（同 timetable-logic.test.ts）。
 * Stage 0 先釘純函式（§4-1～8、11）；§4-9、10（repository 的 paint／undoPaint）由 Build 階段補在本檔。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { MIN, isoOf, msOf, segmentsOfDay, type AxisItem, type CoverSummary, type Span, type TimeBlockRow, type WritePlan } from "../../src/domain/timetable.ts";
import {
  CELL_OPTIONS,
  DEFAULT_CELL_MIN,
  buildPaintUndo,
  cellCount,
  cellIndexAt,
  cellRange,
  clampSel,
  gridWindow,
  paintCoverOf,
  paintKindOf,
  paintModeOf,
  paintUndoable,
  parseCellMin,
  pickCellBlock,
  planPaintFill,
  planPaintLive,
  planUndoPaint,
  rowHoursFor,
  rowRuns,
  snapEdges,
  type PaintRow,
  type PaintUndo,
} from "../../src/domain/timetableGrid.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const HOUR = 60 * MIN;

/** 2026-10-20 的本地時刻；d 可以給 21（隔天凌晨） */
const T = (h: number, mi = 0, s = 0, d = 20): number => new Date(2026, 9, d, h, mi, s).getTime();
const win = (h: number, rowHours: 1 | 2 = 1) => gridWindow({ start: T(h), end: T(h, 0, 0, 21) }, rowHours);
const sp = (id: string, start: number, end: number | null, categoryId = "c-" + id, ack = false): Span => ({ id, categoryId, start, end, ack });
const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

/** 測試輔助：把 plan 套到 spans（不處理 link／estimate；同 timetable-logic.test.ts 的 apply） */
function apply(spans: readonly Span[], plan: WritePlan): Span[] {
  const out = new Map(spans.map((s) => [s.id, { ...s }]));
  for (const p of plan.patches) {
    const s = out.get(p.id)!;
    if (p.start !== undefined) s.start = p.start;
    if (p.end !== undefined) s.end = p.end;
    if (p.categoryId !== undefined) s.categoryId = p.categoryId;
    if (p.ack !== undefined) s.ack = p.ack;
  }
  for (const id of plan.deletes) out.delete(id);
  plan.inserts.forEach((i, n) => out.set(`new${n}`, { id: `new${n}`, categoryId: i.categoryId, start: i.start, end: i.end, ack: i.ack }));
  return Array.from(out.values()).sort((a, b) => a.start - b.start);
}

describe("0. 格子大小與列高", () => {
  test("parseCellMin：認得的照用、其餘回預設 10", () => {
    for (const m of CELL_OPTIONS) assert.equal(parseCellMin(String(m)), m);
    for (const raw of [null, "", "7", "abc", "60", "10.5"]) assert.equal(parseCellMin(raw), DEFAULT_CELL_MIN);
    assert.equal(DEFAULT_CELL_MIN, 10);
  });
  test("rowHoursFor：桌機永遠 1；手機一列不到 16px ⇒ 2（〈原型定案〉4）", () => {
    assert.equal(rowHoursFor(100, "desktop"), 1);
    assert.equal(rowHoursFor(24 * 16, "mobile"), 1);
    assert.equal(rowHoursFor(24 * 14.1, "mobile"), 2);
    assert.equal(rowHoursFor(24 * 10, "mobile"), 2);
  });
  test("gridWindow：一列 1 小時 24 列、2 小時 12 列", () => {
    assert.equal(win(6).rows, 24);
    assert.equal(win(6, 2).rows, 12);
    assert.equal(win(6, 2).rowMs, 2 * HOUR);
  });
});

describe("1. rowRuns", () => {
  const w = win(6);
  const now = T(23);
  test("14:07–16:22 拆成三段（列內比例；〈原型定案〉2）、head 只有開頭那列", () => {
    const items = segmentsOfDay([sp("a", T(14, 7), T(16, 22))], w, now);
    const runs = rowRuns(items, w, now);
    assert.deepEqual(runs.map((r) => r.row), [8, 9, 10]);
    close(runs[0].x0, 7 / 60);
    close(runs[0].x1, 1);
    close(runs[1].x0, 0);
    close(runs[1].x1, 1);
    close(runs[2].x0, 0);
    close(runs[2].x1, 22 / 60);
    assert.deepEqual(runs.map((r) => r.head), [true, false, false]);
    assert.deepEqual(runs.map((r) => [r.contPrev, r.contNext]), [[false, true], [true, true], [true, false]]);
    assert.ok(runs.every((r) => r.blockId === "a" && r.categoryId === "c-a" && !r.running && !r.tiny));
  });
  test("結束在整點不會在下一列多出空段", () => {
    const runs = rowRuns(segmentsOfDay([sp("a", T(14, 7), T(15))], w, now), w, now);
    assert.deepEqual(runs.map((r) => r.row), [8]);
  });
  test("運行中畫到 now", () => {
    const n = T(15, 42);
    const runs = rowRuns(segmentsOfDay([sp("r", T(14, 52), null)], w, n), w, n);
    assert.deepEqual(runs.map((r) => r.row), [8, 9]);
    close(runs[1].x1, 42 / 60);
    assert.ok(runs.every((r) => r.running));
    assert.equal(runs[1].contNext, false);
  });
  test("從前一天續過來的從第 0 列 0 開始、沒有 head", () => {
    const runs = rowRuns(segmentsOfDay([sp("s", T(23, 48, 0, 19), T(7, 12))], w, now), w, now);
    assert.deepEqual(runs.map((r) => r.row), [0, 1]);
    close(runs[0].x0, 0);
    assert.equal(runs[0].head, false);
    assert.equal(runs[0].contPrev, true);
    close(runs[1].x1, 12 / 60);
  });
  test("碎塊 tiny、零長度塊也有一段", () => {
    const runs = rowRuns(segmentsOfDay([sp("t", T(10, 38), T(10, 38, 30)), sp("z", T(11), T(11))], w, now), w, now);
    assert.equal(runs.length, 2);
    assert.ok(runs.every((r) => r.tiny));
    const z = runs.find((r) => r.blockId === "z")!;
    assert.equal(z.x0, z.x1);
  });
  test("一列 2 小時：14:07 在 14:00–16:00 那一列的 7/120", () => {
    const w2 = win(6, 2);
    const runs = rowRuns(segmentsOfDay([sp("a", T(14, 7), T(14, 37))], w2, now), w2, now);
    assert.deepEqual(runs.map((r) => r.row), [4]);
    close(runs[0].x0, 7 / 120);
    close(runs[0].x1, 37 / 120);
  });
});

describe("2. 日界線 06:00 與 03:00", () => {
  test("第 0 列是日界線那一點；凌晨 01:30 在 06:00 的第 19 列、03:00 的第 22 列", () => {
    const now = T(5, 0, 0, 21);
    for (const [h, row] of [[6, 19], [3, 22]] as const) {
      const w = win(h);
      const first = rowRuns(segmentsOfDay([sp("a", T(h, 10), T(h, 20))], w, now), w, now);
      assert.equal(first[0].row, 0);
      const late = rowRuns(segmentsOfDay([sp("b", T(1, 30, 0, 21), T(1, 50, 0, 21))], w, now), w, now);
      assert.equal(late[0].row, row);
      close(late[0].x0, 0.5);
    }
  });
});

describe("3. cellIndexAt／cellRange", () => {
  const w = win(6);
  test("四種格子大小；反向拖結果一樣", () => {
    for (const m of CELL_OPTIONS) {
      assert.equal(cellCount(w, m), (24 * 60) / m);
      const i = cellIndexAt(w, m, T(14, 7));
      assert.equal(i, Math.floor((8 * 60 + 7) / m));
      const j = cellIndexAt(w, m, T(15, 31));
      assert.deepEqual(cellRange(w, m, i, j), cellRange(w, m, j, i));
      const r = cellRange(w, m, i, j);
      assert.equal(r.start, w.start + i * m * MIN);
      assert.equal(r.end, w.start + (j + 1) * m * MIN);
    }
  });
  test("夾在 [0, 格數−1]", () => {
    assert.equal(cellIndexAt(w, 10, T(5)), 0);
    assert.equal(cellIndexAt(w, 10, T(7, 0, 0, 21)), cellCount(w, 10) - 1);
  });
});

describe("4. clampSel", () => {
  const w = win(6);
  test("尾超過 now 夾到 now；整段在未來 ⇒ null；跨窗夾回窗內；不到 1 分 ⇒ null", () => {
    const now = T(15, 42, 10);
    assert.deepEqual(clampSel({ start: T(15), end: T(16) }, w, now), { start: T(15), end: now });
    assert.equal(clampSel({ start: T(16), end: T(17) }, w, now), null);
    assert.deepEqual(clampSel({ start: T(5), end: T(7) }, w, now), { start: T(6), end: T(7) });
    assert.equal(clampSel({ start: T(15, 42), end: T(16) }, w, now), null);
  });
});

describe("5. snapEdges（D-時-97）", () => {
  const w = win(6);
  const now = T(23);
  const cell = 10 * MIN;
  const items = segmentsOfDay([sp("p", T(13, 53), T(14, 7)), sp("n", T(14, 52), T(15, 30))], w, now);
  test("頭格半格空白、半格前一塊 ⇒ 頭縮到空白開始；尾同理", () => {
    assert.deepEqual(snapEdges({ start: T(14), end: T(15) }, items, cell), { start: T(14, 7), end: T(14, 52) });
  });
  test("前一塊被整格跨過（選區從它中間開始、超過一格）⇒ 不縮", () => {
    const long = segmentsOfDay([sp("p", T(13, 30), T(14, 17))], w, now);
    assert.deepEqual(snapEdges({ start: T(13, 40), end: T(14, 30) }, long, cell), { start: T(13, 40), end: T(14, 30) });
  });
  test("縮完不到 1 分 ⇒ 不縮", () => {
    const tight = segmentsOfDay([sp("p", T(14), T(14, 4, 30)), sp("n", T(14, 5, 20), T(14, 10))], w, now);
    assert.deepEqual(snapEdges({ start: T(14), end: T(14, 10) }, tight, cell), { start: T(14), end: T(14, 10) });
  });
  test("不到 1 分的秒數縫不吸住選區（〈原型定案〉8）", () => {
    const seam = segmentsOfDay([sp("p", T(13, 50), T(14, 0, 40)), sp("n", T(14, 1), T(15))], w, now);
    assert.deepEqual(snapEdges({ start: T(14), end: T(14, 30) }, seam, cell), { start: T(14), end: T(14, 30) });
  });
  test("整段空白 ⇒ 不動", () => {
    assert.deepEqual(snapEdges({ start: T(11), end: T(12) }, items, cell), { start: T(11), end: T(12) });
  });
});

describe("6. paintModeOf（D-時-99）", () => {
  const now = T(15, 42, 10);
  test("尾＝now（30 秒內）＋有運行中 ⇒ live；沒運行中 ⇒ fill；尾在 now 之前 ⇒ fill", () => {
    assert.equal(paintModeOf({ start: T(14), end: now }, true, now), "live");
    assert.equal(paintModeOf({ start: T(14), end: now - 20_000 }, true, now), "live");
    assert.equal(paintModeOf({ start: T(14), end: now }, false, now), "fill");
    assert.equal(paintModeOf({ start: T(14), end: T(15) }, true, now), "fill");
  });
});

describe("7. planPaintLive", () => {
  const now = T(15, 42);
  const base = [sp("x", T(13), T(14, 52), "meal"), sp("R", T(14, 52), null, "create")];
  test("C ≠ R、a > r ⇒ R 結束於 a、C 運行中", () => {
    const out = apply(base, planPaintLive(base, { categoryId: "study", at: T(15), now })!);
    assert.deepEqual(out.find((s) => s.id === "R"), { ...base[1], end: T(15) });
    const run = out.filter((s) => s.end === null);
    assert.equal(run.length, 1);
    assert.equal(run[0].categoryId, "study");
    assert.equal(run[0].start, T(15));
  });
  test("C ≠ R、a ≤ r ⇒ R 整班收掉（a 之後的其他塊一併收掉）", () => {
    const out = apply(base, planPaintLive(base, { categoryId: "study", at: T(14), now })!);
    assert.equal(out.find((s) => s.id === "R"), undefined);
    assert.deepEqual(out.find((s) => s.id === "x"), { ...base[0], end: T(14) });
    assert.equal(out.filter((s) => s.end === null)[0].categoryId, "study");
  });
  test("C ＝ R、a < r ⇒ restart（R 的 id 留著、只改 start）", () => {
    const plan = planPaintLive(base, { categoryId: "create", at: T(14, 30), now })!;
    assert.equal(plan.inserts.length, 0);
    const out = apply(base, plan);
    assert.deepEqual(out.find((s) => s.id === "R"), { ...base[1], start: T(14, 30) });
    assert.deepEqual(out.find((s) => s.id === "x"), { ...base[0], end: T(14, 30) });
  });
  test("C ＝ R、a ≥ r ⇒ null（不用寫）", () => {
    assert.equal(planPaintLive(base, { categoryId: "create", at: T(15), now }), null);
    assert.equal(planPaintLive(base, { categoryId: "create", at: T(14, 52), now }), null);
  });
  test("沒有運行中的班（另一台剛到站、store 還沒 refresh）⇒ 補到現在（已結束、ack＝true），不發車（D-時-99）", () => {
    const ended = [sp("x", T(13), T(14, 52), "meal"), sp("R", T(14, 52), T(15, 30), "create")];
    const plan = planPaintLive(ended, { categoryId: "study", at: T(15), now })!;
    assert.equal(plan.inserts.length, 1);
    assert.deepEqual(
      { c: plan.inserts[0].categoryId, s: plan.inserts[0].start, e: plan.inserts[0].end, ack: plan.inserts[0].ack },
      { c: "study", s: T(15), e: now, ack: true },
    );
    const out = apply(ended, plan);
    assert.equal(out.filter((s) => s.end === null).length, 0, "沒有運行中的班");
    assert.deepEqual(out.find((s) => s.id === "R"), { ...ended[1], end: T(15) });
    // at 晚於 now ⇒ 夾到 now 之前不成立：結束時間要晚於開始時間（store 不會送；守住不發車）
    assert.throws(() => planPaintLive(ended, { categoryId: "study", at: now + MIN, now }), RangeError);
  });
});

describe("8. pickCellBlock", () => {
  const w = win(6);
  const now = T(23);
  const kind = (x: AxisItem | null) => (x === null ? null : x.kind === "block" ? x.span.id : `gap ${x.from}-${x.to}`);
  test("格內兩塊取重疊多的；同分取較晚開始", () => {
    const items = segmentsOfDay([sp("a", T(13), T(14, 3)), sp("b", T(14, 3), T(15))], w, now);
    assert.equal(kind(pickCellBlock(items, { start: T(14), end: T(14, 10) })), "b");
    const even = segmentsOfDay([sp("a", T(13), T(14, 5)), sp("b", T(14, 5), T(15))], w, now);
    assert.equal(kind(pickCellBlock(even, { start: T(14), end: T(14, 10) })), "b");
  });
  test("碎塊只在格內沒別的塊時才中", () => {
    const items = segmentsOfDay([sp("t", T(10, 38), T(10, 38, 30)), sp("c", T(10, 38, 30), T(11, 20))], w, now);
    assert.equal(kind(pickCellBlock(items, { start: T(10, 30), end: T(10, 40) })), "c");
    const alone = segmentsOfDay([sp("t", T(10, 38), T(10, 38, 30))], w, now);
    assert.equal(kind(pickCellBlock(alone, { start: T(10, 30), end: T(10, 40) })), "t");
  });
  test("整格空白 ⇒ 那一整段 gap；未來 ⇒ null", () => {
    const n = T(15, 42);
    const items = segmentsOfDay([sp("a", T(6), T(11, 20)), sp("b", T(13), T(15, 42))], w, n);
    assert.equal(kind(pickCellBlock(items, { start: T(12), end: T(12, 10) })), `gap ${T(11, 20)}-${T(13)}`);
    assert.equal(pickCellBlock(items, { start: T(16), end: T(16, 10) }), null);
  });
});

describe("12. 塗完的 toast：paintKindOf／paintUndoable／paintCoverOf（沙盒 F2、F3）", () => {
  const base = { blockEnded: false, wrote: true };
  test("分類：沒寫＝same；fill＝fill；live 主角不是新增的＝restart；新增而已結束＝fillToNow；其餘＝live", () => {
    assert.equal(paintKindOf({ ...base, mode: "live", blockInserted: false, wrote: false }), "same");
    assert.equal(paintKindOf({ ...base, mode: "fill", blockInserted: true }), "fill");
    assert.equal(paintKindOf({ ...base, mode: "live", blockInserted: false }), "restart");
    assert.equal(paintKindOf({ ...base, mode: "live", blockInserted: true, blockEnded: true }), "fillToNow");
    assert.equal(paintKindOf({ ...base, mode: "live", blockInserted: true }), "live");
  });
  test("提早出發（restart）不給撤回（契約 §9-3 降級）；same 沒東西可撤；fill／fillToNow／live 照舊給", () => {
    assert.equal(paintUndoable("restart"), false);
    assert.equal(paintUndoable("same"), false);
    assert.equal(paintUndoable("fill"), true);
    assert.equal(paintUndoable("fillToNow"), true);
    assert.equal(paintUndoable("live"), true);
  });
  test("副標扣掉運行中那班：選區頭晚於它＝扣切短、不晚於＝扣蓋掉；別的種類不動", () => {
    const sum = { removed: 2, shortened: 1, splitCount: 0 };
    assert.deepEqual(paintCoverOf("live", sum, 100, 200), { removed: 2, shortened: 0, splitCount: 0 });
    assert.deepEqual(paintCoverOf("live", sum, 200, 200), { removed: 1, shortened: 1, splitCount: 0 });
    assert.deepEqual(paintCoverOf("live", sum, 300, 200), { removed: 1, shortened: 1, splitCount: 0 });
    assert.deepEqual(paintCoverOf("live", { removed: 0, shortened: 0, splitCount: 0 }, 100, 200), { removed: 0, shortened: 0, splitCount: 0 });
    assert.deepEqual(paintCoverOf("live", sum, null, 200), sum);
    for (const k of ["restart", "fill", "fillToNow"] as const) assert.deepEqual(paintCoverOf(k, sum, 100, 200), sum);
  });
});

describe("11. 純度牙齒", () => {
  test("timetableGrid.ts 只 import ./timetable.ts（相對路徑帶 .ts）", () => {
    const src = readFileSync(path.join(ROOT, "src/domain/timetableGrid.ts"), "utf8");
    const froms = Array.from(src.matchAll(/^import[\s\S]*?from\s+"([^"]+)";/gm)).map((m) => m[1]);
    assert.ok(froms.length > 0);
    assert.deepEqual(Array.from(new Set(froms)), ["./timetable.ts"]);
  });
});

/* ═════════════════════════ 9′. 撤回快照的純函式（repository 共用） ═════════════════════════ */

describe("9′. planPaintFill／buildPaintUndo／planUndoPaint", () => {
  const now = T(23);
  test("planPaintFill：新塊 ack＝true（〈原型定案〉5）；inherit 切出來的段照抄原塊", () => {
    const base = [sp("a", T(10), T(14), "c-a", false)];
    const plan = planPaintFill(base, { categoryId: "x", start: T(11), end: T(12), now });
    assert.equal(plan.inserts.length, 2);
    assert.equal(plan.inserts[0].inherit, true);
    assert.equal(plan.inserts[0].ack, false);
    assert.equal(plan.inserts[1].inherit, false);
    assert.equal(plan.inserts[1].ack, true);
  });
  const row = (started_at: string, ended_at: string | null, updated_at: string, deleted_at: string | null = null): PaintRow => ({
    started_at,
    ended_at,
    deleted_at,
    updated_at,
  });
  test("buildPaintUndo：沒有值變（updated_at 沒動）的 patch 不進 touched；delete 進；新增的進 inserted", () => {
    const plan: WritePlan = {
      patches: [
        { id: "same", end: 1 },
        { id: "moved", start: 2 },
      ],
      inserts: [],
      deletes: ["gone"],
    };
    const before = { same: row("s0", "e0", "u0"), moved: row("s1", "e1", "u0"), gone: row("s2", "e2", "u0") };
    const after = {
      same: row("s0", "e0", "u0"),
      moved: row("s9", "e1", "u1"),
      gone: row("s2", "e2", "u1", "u1"),
      n1: row("s3", null, "u1"),
    };
    const undo = buildPaintUndo(plan, before, after, ["n1"]);
    assert.deepEqual(undo.inserted, [{ id: "n1", updated_at: "u1" }]);
    assert.deepEqual(
      undo.touched.map((t) => [t.id, t.before.started_at, t.afterUpdatedAt]),
      [
        ["moved", "s1", "u1"],
        ["gone", "s2", "u1"],
      ],
    );
  });
  test("buildPaintUndo：同一毫秒（updated_at 剛好一樣）但三欄變了 ⇒ 照記", () => {
    const plan: WritePlan = { patches: [{ id: "a", end: 1 }], inserts: [], deletes: [] };
    const undo = buildPaintUndo(plan, { a: row("s", "e0", "u0") }, { a: row("s", "e1", "u0") }, []);
    assert.equal(undo.touched.length, 1);
  });
  test("planUndoPaint：守門比 updated_at；只寫不同的欄", () => {
    const undo: PaintUndo = {
      inserted: [{ id: "n", updated_at: "u1" }],
      touched: [
        { id: "a", before: { started_at: "s0", ended_at: "e0", deleted_at: null }, afterUpdatedAt: "u1" },
        { id: "b", before: { started_at: "s1", ended_at: "e1", deleted_at: null }, afterUpdatedAt: "u1" },
      ],
    };
    const cur = { n: row("x", null, "u1"), a: row("s0", "e9", "u1"), b: row("s1", "e1", "u1", "u1") };
    assert.deepEqual(planUndoPaint(undo, cur), [
      { id: "n", op: "delete" },
      { id: "a", op: "set", cols: { ended_at: "e0" } },
      { id: "b", op: "set", cols: { deleted_at: null } },
    ]);
    assert.equal(planUndoPaint(undo, { ...cur, a: row("s0", "e9", "u2") }), null, "被動到的列後來又改過");
    assert.equal(planUndoPaint(undo, { ...cur, n: row("x", null, "u2") }), null, "新塊被改過");
    assert.equal(planUndoPaint(undo, { ...cur, n: row("x", null, "u1", "u1") }), null, "新塊已被刪");
    assert.equal(planUndoPaint(undo, { ...cur, a: null }), null, "列不見了");
  });
});

/* ═════════════════════════ 9、10. repository 的 paint／undoPaint（memory／sqlite） ═════════════════════════ */

const FAKE_DB = `
export function getDb() { const d = globalThis.__ttDb; if (!d) throw new Error("測試沒設 __ttDb"); return Promise.resolve(d); }
export function uuid() { return crypto.randomUUID(); }
export function nowUtcIso() { return new Date().toISOString(); }
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
interface TestDb {
  ops: Op[];
  select(sql: string, args?: unknown[]): Promise<Record<string, unknown>[]>;
  execute(sql: string, args?: unknown[]): Promise<void>;
  runBatch(stmts: { sql: string; args: unknown[] }[], ops: Op[]): void;
}
function makeSqliteDb(): TestDb {
  const raw = new DatabaseSync(":memory:");
  // 外鍵關掉（node:sqlite 預設開）：測資的分類 id 是假的（time_blocks.category_id 參照 time_categories）
  raw.exec("PRAGMA foreign_keys = OFF");
  raw.exec(readFileSync(path.join(ROOT, "src-tauri/migrations/0006_timetable_blocks.sql"), "utf8"));
  const bind = (args: unknown[] = []) => Object.fromEntries(args.map((v, i) => ["$" + (i + 1), v])) as Record<string, never>;
  const db: TestDb = {
    ops: [],
    async select(sql, args) {
      return raw.prepare(sql).all(bind(args)).map((r) => ({ ...r }));
    },
    async execute(sql, args) {
      raw.prepare(sql).run(bind(args));
    },
    runBatch(stmts, ops) {
      raw.exec("BEGIN");
      try {
        for (const st of stmts) raw.prepare(st.sql).run(bind(st.args));
        raw.exec("COMMIT");
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      }
      db.ops.push(...ops);
    },
  };
  return db;
}

type AnyRepo = any; // 測試只看行為；兩個實作都 implements TimetableRepository
type Ids = Record<"a" | "b" | "c" | "d" | "R", string>;
interface Impl {
  repo: AnyRepo;
  db: TestDb | null;
  /** 全部列（含已刪除），id → 列 */
  rows(): Promise<Record<string, TimeBlockRow>>;
  /** 模擬另一台改了這一列（同步套進來）：寫 cols＋一個比較晚的 updated_at */
  other(id: string, cols: Partial<TimeBlockRow>): Promise<void>;
}
const IMPLS: { name: string; make: () => Promise<Impl> }[] = [
  {
    name: "memory",
    make: async () => {
      const { MemoryTimetableRepository } = await import("../../src/data/memoryTimetableRepository.ts");
      const repo = new MemoryTimetableRepository({ seedDemo: false, nodeRepo: {} as never });
      const map = (repo as unknown as { blocks: Map<string, TimeBlockRow> }).blocks;
      return {
        repo,
        db: null,
        async rows() {
          return Object.fromEntries(Array.from(map.values(), (r) => [r.id, { ...r }]));
        },
        async other(id, cols) {
          Object.assign(map.get(id)!, cols, { updated_at: isoOf(Date.now() + 60_000) });
        },
      };
    },
  },
  {
    name: "sqlite",
    make: async () => {
      const db = makeSqliteDb();
      (globalThis as { __ttDb?: TestDb }).__ttDb = db;
      const { SqliteTimetableRepository } = await import("../../src/data/sqliteTimetableRepository.ts");
      return {
        repo: new SqliteTimetableRepository(),
        db,
        async rows() {
          const all = (await db.select("SELECT * FROM time_blocks")) as unknown as TimeBlockRow[];
          return Object.fromEntries(all.map((r) => [r.id, r]));
        },
        async other(id, cols) {
          const keys = Object.keys(cols);
          const args = [...keys.map((k) => (cols as Record<string, unknown>)[k]), isoOf(Date.now() + 60_000), id];
          const sets = [...keys.map((k, i) => `${k} = $${i + 1}`), `updated_at = $${keys.length + 1}`];
          await db.execute(`UPDATE time_blocks SET ${sets.join(", ")} WHERE id = $${keys.length + 2}`, args);
        },
      };
    },
  },
];

/** 撤回後要逐欄等於塗之前的欄（updated_at 不比：撤回本身會戳） */
const FIELDS = ["category_id", "started_at", "ended_at", "deleted_at", "estimate_min", "long_run_ack", "node_id", "route_id"] as const;
const pick = (r: TimeBlockRow) => Object.fromEntries(FIELDS.map((k) => [k, r[k]]));
const idsOf = (xs: { id: string }[]) => xs.map((x) => x.id).sort();

for (const { name, make } of IMPLS) {
  /** 測資：現在往前 10 小時（取整分）起算的分鐘 */
  const base = Math.floor(Date.now() / MIN) * MIN - 10 * HOUR;
  const m = (x: number) => base + x * MIN;
  const nowIso = () => isoOf(Date.now());

  /** a[0,60) b[60,120) c[120,180) d[180,240)；R＝cat-r 從 300 跑到現在、預估 30 分 */
  async function seed(impl: Impl): Promise<Ids> {
    const ids = {} as Ids;
    for (const [k, s, e] of [["a", 0, 60], ["b", 60, 120], ["c", 120, 180], ["d", 180, 240]] as const) {
      ids[k] = (await impl.repo.fill(`cat-${k}`, isoOf(m(s)), isoOf(m(e)))).block.id;
    }
    ids.R = (await impl.repo.depart("cat-r", isoOf(m(300)), { estimateMin: 30 })).block.id;
    return ids;
  }

  describe(`9. paint 的 plan 語義（${name}）`, () => {
    test("fill 蓋掉兩塊、切短一塊；新塊 ack＝1；touched＝真的寫了的列", async () => {
      const impl = await make();
      const id = await seed(impl);
      const opsBefore = impl.db?.ops.length ?? 0;
      const { block, summary, undo } = await impl.repo.paint("cat-x", isoOf(m(60)), isoOf(m(200)), "fill");
      assert.deepEqual(summary, { removed: 2, shortened: 1, splitCount: 0 });
      assert.equal(block.category_id, "cat-x");
      assert.equal(block.started_at, isoOf(m(60)));
      assert.equal(block.ended_at, isoOf(m(200)));
      assert.equal(block.long_run_ack, 1);
      const rows = await impl.rows();
      assert.notEqual(rows[id.b].deleted_at, null);
      assert.notEqual(rows[id.c].deleted_at, null);
      assert.equal(rows[id.d].started_at, isoOf(m(200)));
      assert.equal(rows[id.a].ended_at, isoOf(m(60)));
      assert.deepEqual(idsOf(undo.inserted), [block.id]);
      assert.deepEqual(idsOf(undo.touched), [id.b, id.c, id.d].sort());
      assert.equal(undo.touched.find((x: { id: string }) => x.id === id.d).before.started_at, isoOf(m(180)));
      if (impl.db) {
        // sqlite：touched 正好是這一批送了 op 的既有列（新塊之外）
        const opIds = new Set(impl.db.ops.slice(opsBefore).map((o) => o.row_id));
        opIds.delete(block.id);
        assert.deepEqual([...opIds].sort(), [id.b, id.c, id.d].sort());
      }
    });
    test("選區從運行中那班開頭之前到中間 ⇒ 那班 start 推到選區尾（同 id、還在跑）", async () => {
      const impl = await make();
      const id = await seed(impl);
      const { summary, undo } = await impl.repo.paint("cat-x", isoOf(m(250)), isoOf(m(320)), "fill");
      assert.deepEqual(summary, { removed: 0, shortened: 1, splitCount: 0 });
      const R = (await impl.rows())[id.R];
      assert.equal(R.started_at, isoOf(m(320)));
      assert.equal(R.ended_at, null);
      assert.equal(R.deleted_at, null);
      assert.deepEqual(idsOf(undo.touched), [id.R]);
    });
    test("選區在運行中那班中間 ⇒ 前段結束於選區頭、後段是新 id 的運行中（記進 inserted）", async () => {
      const impl = await make();
      const id = await seed(impl);
      const { block, summary, undo } = await impl.repo.paint("cat-x", isoOf(m(330)), isoOf(m(360)), "fill");
      assert.deepEqual(summary, { removed: 0, shortened: 1, splitCount: 1 });
      const rows = await impl.rows();
      assert.equal(rows[id.R].ended_at, isoOf(m(330)));
      const running = Object.values(rows).filter((r) => r.ended_at === null && r.deleted_at === null);
      assert.equal(running.length, 1);
      assert.notEqual(running[0].id, id.R);
      assert.equal(running[0].category_id, "cat-r");
      assert.equal(running[0].started_at, isoOf(m(360)));
      assert.equal(running[0].estimate_min, 30, "後段 inherit 預估");
      assert.equal(running[0].long_run_ack, 0, "inherit 的段照抄原塊的 ack");
      assert.deepEqual(idsOf(undo.inserted), [running[0].id, block.id].sort());
    });
    test("live：C ≠ R、a > r ⇒ R 結束於 a、C 從 a 跑", async () => {
      const impl = await make();
      const id = await seed(impl);
      const { block, summary } = await impl.repo.paint("cat-y", isoOf(m(400)), nowIso(), "live");
      assert.equal(block.ended_at, null);
      assert.equal(block.category_id, "cat-y");
      assert.equal(block.started_at, isoOf(m(400)));
      assert.equal(block.long_run_ack, 0, "live 的新運行中班照舊 0");
      assert.deepEqual(summary, { removed: 0, shortened: 1, splitCount: 0 }); // R 自己（store 依〈原型定案〉7 扣掉）
      assert.equal((await impl.rows())[id.R].ended_at, isoOf(m(400)));
    });
    test("live：C ≠ R、a ≤ r ⇒ R 整班收掉、a 之後的切短", async () => {
      const impl = await make();
      const id = await seed(impl);
      const { block, summary } = await impl.repo.paint("cat-y", isoOf(m(200)), nowIso(), "live");
      assert.deepEqual(summary, { removed: 1, shortened: 1, splitCount: 0 });
      const rows = await impl.rows();
      assert.notEqual(rows[id.R].deleted_at, null);
      assert.equal(rows[id.d].ended_at, isoOf(m(200)));
      assert.equal(block.started_at, isoOf(m(200)));
    });
    test("live：C ＝ R、a < r ⇒ 提早出發（R 的 id、預估都在；summary 不算 R）", async () => {
      const impl = await make();
      const id = await seed(impl);
      const { block, summary } = await impl.repo.paint("cat-r", isoOf(m(200)), nowIso(), "live");
      assert.equal(block.id, id.R);
      assert.equal(block.started_at, isoOf(m(200)));
      assert.equal(block.ended_at, null);
      assert.equal(block.estimate_min, 30);
      assert.deepEqual(summary, { removed: 0, shortened: 1, splitCount: 0 });
      assert.equal((await impl.rows())[id.d].ended_at, isoOf(m(200)));
    });
    test("live：C ＝ R、a ≥ r ⇒ 什麼都不寫（回運行中那班、summary 全 0、undo 空）", async () => {
      const impl = await make();
      const id = await seed(impl);
      const before = await impl.rows();
      const { block, summary, undo } = await impl.repo.paint("cat-r", isoOf(m(400)), nowIso(), "live");
      assert.equal(block.id, id.R);
      assert.deepEqual(summary, { removed: 0, shortened: 0, splitCount: 0 });
      assert.deepEqual(undo, { inserted: [], touched: [] });
      assert.deepEqual(await impl.rows(), before);
    });
    test("live 但資料庫裡沒有運行中的班 ⇒ 補到現在（已結束、ack＝1），不發車（D-時-99）", async () => {
      const impl = await make();
      const id = await seed(impl);
      await impl.repo.arrive(isoOf(m(360)));
      const before = await impl.rows();
      const t0 = Date.now();
      const { block, summary, undo } = await impl.repo.paint("cat-y", isoOf(m(500)), nowIso(), "live");
      const t1 = Date.now();
      assert.equal(block.category_id, "cat-y");
      assert.equal(block.started_at, isoOf(m(500)));
      assert.notEqual(block.ended_at, null, "已結束的一塊");
      assert.ok(msOf(block.ended_at!) >= t0 && msOf(block.ended_at!) <= t1, "補到現在");
      assert.equal(block.long_run_ack, 1);
      assert.deepEqual(summary, { removed: 0, shortened: 0, splitCount: 0 });
      const rows = await impl.rows();
      assert.equal(Object.values(rows).filter((r) => r.ended_at === null && r.deleted_at === null).length, 0, "沒有運行中的班");
      assert.equal(rows[id.R].ended_at, isoOf(m(360)), "到站的那班不動");
      assert.equal(await impl.repo.undoPaint(undo), true);
      const after = await impl.rows();
      for (const k of Object.keys(before)) assert.deepEqual(pick(after[k]), pick(before[k]));
    });
  });

  describe(`9″. 塗完的 toast 跟讀數同一口徑、提早出發不給撤回（${name}；沙盒 F2、F3）`, () => {
    /** store.paint 的分類＋副標，照 store 的寫法組（store 沒有測試骨架，這裡用同一組純函式） */
    const toastOf = (res: { block: TimeBlockRow; summary: CoverSummary; undo: PaintUndo }, mode: "fill" | "live", rStart: number | null, a: number) => {
      const kind = paintKindOf({
        mode,
        blockInserted: res.undo.inserted.some((x) => x.id === res.block.id),
        blockEnded: res.block.ended_at !== null,
        wrote: res.undo.inserted.length > 0 || res.undo.touched.length > 0,
      });
      return { kind, undoable: paintUndoable(kind), sub: paintCoverOf(kind, res.summary, rStart, a) };
    };
    const cases: [string, string, number, string, boolean, CoverSummary][] = [
      // 標籤、分類、選區頭（分）、期望種類、給撤回、期望副標（＝讀數）
      ["live 換車 a > r", "cat-y", 400, "live", true, { removed: 0, shortened: 0, splitCount: 0 }],
      ["live 換車 a ≤ r（R 整班收掉，讀數不算它）", "cat-y", 200, "live", true, { removed: 0, shortened: 1, splitCount: 0 }],
      ["live 同分類提早出發", "cat-r", 200, "restart", false, { removed: 0, shortened: 1, splitCount: 0 }],
      ["live 同分類不早於它", "cat-r", 400, "same", false, { removed: 0, shortened: 0, splitCount: 0 }],
    ];
    for (const [label, cat, s, kind, undoable, sub] of cases) {
      test(label, async () => {
        const impl = await make();
        const id = await seed(impl);
        const rStart = msOf((await impl.rows())[id.R].started_at);
        // 讀數＝useCoverText：live 一律把運行中那班當 exceptId
        const read = await impl.repo.previewCover(isoOf(m(s)), null, id.R);
        const res = await impl.repo.paint(cat, isoOf(m(s)), nowIso(), "live");
        const t = toastOf(res, "live", rStart, m(s));
        assert.equal(t.kind, kind);
        assert.equal(t.undoable, undoable);
        if (kind !== "same") {
          assert.deepEqual(t.sub, read, "副標＝讀數");
          assert.deepEqual(t.sub, sub);
        }
      });
    }
    test("fill 照舊給撤回；副標＝summary", async () => {
      const impl = await make();
      await seed(impl);
      const read = await impl.repo.previewCover(isoOf(m(60)), isoOf(m(200)), null);
      const res = await impl.repo.paint("cat-x", isoOf(m(60)), isoOf(m(200)), "fill");
      const t = toastOf(res, "fill", null, m(60));
      assert.equal(t.kind, "fill");
      assert.equal(t.undoable, true);
      assert.deepEqual(t.sub, read);
    });
    test("live 但資料庫裡沒有運行中的班 ⇒ fillToNow、給撤回", async () => {
      const impl = await make();
      const id = await seed(impl);
      const rStart = msOf((await impl.rows())[id.R].started_at);
      await impl.repo.arrive(isoOf(m(360)));
      const res = await impl.repo.paint("cat-y", isoOf(m(500)), nowIso(), "live");
      const t = toastOf(res, "live", rStart, m(500));
      assert.equal(t.kind, "fillToNow");
      assert.equal(t.undoable, true);
    });
  });

  describe(`10. undoPaint（${name}）`, () => {
    const cases: [string, string, number, number, "fill" | "live"][] = [
      ["fill 蓋兩塊切一塊", "cat-x", 60, 200, "fill"],
      ["fill 蓋到運行中那班的頭", "cat-x", 250, 320, "fill"],
      ["fill 在運行中那班中間", "cat-x", 330, 360, "fill"],
      ["live 換車 a > r", "cat-y", 400, -1, "live"],
      ["live 換車 a ≤ r（R 整班收掉）", "cat-y", 200, -1, "live"],
      ["live 同分類提早出發", "cat-r", 200, -1, "live"],
    ];
    for (const [label, cat, s, e, mode] of cases) {
      test(`撤得回來：${label}（列逐欄等於塗之前、R 回到運行中）`, async () => {
        const impl = await make();
        const id = await seed(impl);
        const before = await impl.rows();
        const { undo } = await impl.repo.paint(cat, isoOf(m(s)), e < 0 ? nowIso() : isoOf(m(e)), mode);
        const opsPaint = impl.db?.ops.length ?? 0;
        assert.equal(await impl.repo.undoPaint(undo), true);
        const after = await impl.rows();
        for (const k of Object.keys(before)) assert.deepEqual(pick(after[k]), pick(before[k]), `${k} 逐欄等於塗之前`);
        for (const x of undo.inserted) assert.notEqual(after[x.id].deleted_at, null, "新增的列軟刪除");
        const running = Object.values(after).filter((r) => r.ended_at === null && r.deleted_at === null);
        assert.deepEqual(running.map((r) => r.id), [id.R]);
        if (impl.db) {
          // 撤回只碰快照裡的列、只送三欄＋updated_at；沒有 planCover 去動別人
          const undoOps = impl.db.ops.slice(opsPaint);
          const allowed = new Set([...idsOf(undo.inserted), ...idsOf(undo.touched)]);
          assert.ok(undoOps.length > 0);
          for (const o of undoOps) {
            assert.ok(allowed.has(o.row_id), `撤回不該碰 ${o.row_id}`);
            if (o.op === "upsert") {
              for (const c of Object.keys(o.cols)) assert.ok(["started_at", "ended_at", "deleted_at", "updated_at"].includes(c), `多送了 ${c}`);
            } else {
              assert.equal(o.op, "delete");
              assert.ok(undo.inserted.some((x: { id: string }) => x.id === o.row_id));
            }
          }
        }
      });
    }
    if (name === "sqlite") {
      test("被動到的列只送它變了的那一欄（逐欄 LWW）", async () => {
        const impl = await make();
        const id = await seed(impl);
        const { undo } = await impl.repo.paint("cat-x", isoOf(m(60)), isoOf(m(200)), "fill");
        const n = impl.db!.ops.length;
        assert.equal(await impl.repo.undoPaint(undo), true);
        const byRow = Object.fromEntries(impl.db!.ops.slice(n).map((o) => [o.row_id, Object.keys(o.cols).sort()]));
        assert.deepEqual(byRow[id.d], ["started_at", "updated_at"]);
        assert.deepEqual(byRow[id.b], ["deleted_at", "updated_at"]);
        assert.deepEqual(byRow[id.c], ["deleted_at", "updated_at"]);
      });
    }

    const guards: [string, (id: Ids, newId: string) => [string, Partial<TimeBlockRow>]][] = [
      ["被切短的那塊只改了分類", (id) => [id.d, { category_id: "cat-z" }]],
      ["被切短的那塊改了起訖", (id) => [id.d, { started_at: isoOf(m(210)) }]],
      ["被收掉的那塊被另一台救回來", (id) => [id.c, { deleted_at: null }]],
      ["新塊被改過", (_id, newId) => [newId, { category_id: "cat-z" }]],
    ];
    for (const [label, edit] of guards) {
      test(`中間另一台改過 ⇒ false、一列都沒動：${label}`, async () => {
        const impl = await make();
        const id = await seed(impl);
        const { block, undo } = await impl.repo.paint("cat-x", isoOf(m(60)), isoOf(m(200)), "fill");
        const [rid, cols] = edit(id, block.id);
        await impl.other(rid, cols);
        const mid = await impl.rows();
        const n = impl.db?.ops.length ?? 0;
        assert.equal(await impl.repo.undoPaint(undo), false);
        assert.deepEqual(await impl.rows(), mid);
        assert.equal(impl.db?.ops.length ?? 0, n, "沒送 op");
      });
    }
  });
}
