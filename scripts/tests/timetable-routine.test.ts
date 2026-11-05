/**
 * 時刻表線⑦——作息範本與預定的純函式（`src/domain/timetableRoutine.ts`；⑦ 契約 §3、§4）＋塊備註的純函式（`timetable.ts`）
 * ＋同步清單的兩張新表（`timetableSyncLabel.ts`）。
 * 跑法：`node --test scripts/tests/timetable-routine.test.ts`（node 24，型別剝除；零依賴）。
 * 時區：測資用本地時刻 `T(...)`（同 timetable-logic.test.ts）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  EMPTY_ROUTINE_ITEMS,
  ROUTINE_PLAN_NS,
  WEEKDAYS_EVERY,
  WEEKDAYS_WEEKEND,
  WEEKDAYS_WORK,
  assignSpansToSegments,
  autoRoutineFor,
  checkPlanTimes,
  checkRoutineItems,
  compareRoutineItem,
  dayRoutineOf,
  fmtRoutineDelta,
  hasWeekday,
  isMaterialized,
  materializeRows,
  parseRoutineItems,
  planApplyRoutine,
  planEnsureMaterialized,
  planFillRoutine,
  planUndoApplyRoutine,
  routineFromDay,
  routineHasItems,
  routinePlanId,
  routineSummaryText,
  segName,
  planLabelOf,
  serializeRoutineItems,
  slotsOfNode,
  toggleWeekday,
  weekdayBitOf,
  weekdayOwners,
  weekdaysSummary,
  type TimePlanRow,
  type TimeRoutineRow,
} from "../../src/domain/timetableRoutine.ts";
import { MIN, insertNoteOf, normalizeNote, planCover, planEdit, planFill, planMerge, planResolveLongRun, planSplit, planSplitMulti, type Span } from "../../src/domain/timetable.ts";
import { uuidv5 } from "../../src/lib/uuidv5.ts";
import { planSyncLabel, routineSyncLabel, type SyncLabelLookup, type SyncLabelText } from "../../src/lines/timetableSyncLabel.ts";

const T = (mo: number, d: number, h: number, mi = 0): number => new Date(2026, mo - 1, d, h, mi).getTime();
const H = 6;

function routine(over: Partial<TimeRoutineRow>): TimeRoutineRow {
  return {
    id: "r-1",
    name: "工作日",
    items: EMPTY_ROUTINE_ITEMS,
    weekdays: 0,
    position: 0,
    archived_at: null,
    account_id: null,
    device_id: null,
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    synced_at: null,
    deleted_at: null,
    ...over,
  };
}

function plan(over: Partial<TimePlanRow>): TimePlanRow {
  return {
    id: "p-1",
    day: "2026-11-02",
    start_hm: "09:00",
    end_hm: "12:00",
    category_id: "c-create",
    node_id: null,
    routine_id: null,
    label: null,
    account_id: null,
    device_id: null,
    created_at: "2026-11-01T00:00:00.000Z",
    updated_at: "2026-11-01T00:00:00.000Z",
    synced_at: null,
    deleted_at: null,
    ...over,
  };
}

const ITEMS = serializeRoutineItems([
  { cat: "c-create", s: "09:00", e: "12:00" },
  { cat: "c-sleep", s: "23:00", e: "31:00" },
  { cat: "c-meal", s: "12:00", e: "13:00", n: " 午餐 " },
]);

describe("純度", () => {
  test("timetableRoutine.ts 只 import ./timetable.ts、./timetableSchedule.ts、../lib/date.ts、../lib/uuidv5.ts（其餘只准 import type）", () => {
    const src = readFileSync(new URL("../../src/domain/timetableRoutine.ts", import.meta.url), "utf8");
    const all = Array.from(src.matchAll(/^import\s+(type\s+)?[\s\S]*?from\s+"([^"]+)";/gm));
    const values = all.filter((m) => !m[1]).map((m) => m[2]).sort();
    assert.deepEqual(values, ["../lib/date.ts", "../lib/uuidv5.ts", "./timetable.ts", "./timetableSchedule.ts"]);
  });
});

describe("範本的段 JSON", () => {
  test("serialize 依開始排、parse 讀回；鍵順序固定", () => {
    const items = parseRoutineItems(ITEMS);
    assert.deepEqual(items?.map((i) => i.s), ["09:00", "12:00", "23:00"]);
    assert.equal(ITEMS, serializeRoutineItems(items!));
    assert.ok(ITEMS.startsWith('{"v":1,"items":[{"cat":"c-create","s":"09:00","e":"12:00"}'));
  });
  test("段的名字 n：去空白、空的不寫；JSON 只在有名字時帶 n（D-時-167）", () => {
    assert.equal(parseRoutineItems(ITEMS)?.[1].n, "午餐");
    assert.ok(ITEMS.includes('"n":"午餐"'));
    assert.equal(serializeRoutineItems([{ cat: "c", s: "09:00", e: "10:00", n: "  " }]), '{"v":1,"items":[{"cat":"c","s":"09:00","e":"10:00"}]}');
    assert.equal(checkRoutineItems([{ cat: "c", s: "09:00", e: "10:00", n: " 早餐 " }])[0].n, "早餐");
    assert.equal(segName({ label: null }, "用餐"), "用餐");
    assert.equal(segName({ label: "晚餐" }, "用餐"), "晚餐");
    assert.equal(planLabelOf("  \n "), null);
    assert.equal(planLabelOf(" 早餐\n便當 "), "早餐 便當");
  });
  test("讀不懂的外殼＝null；個別壞掉的段略過", () => {
    assert.equal(parseRoutineItems('{"v":2,"items":[]}'), null);
    assert.equal(parseRoutineItems('{"items":[]}'), null);
    assert.equal(parseRoutineItems("not json"), null);
    assert.equal(parseRoutineItems(null), null);
    assert.deepEqual(parseRoutineItems('{"v":1,"items":[{"cat":"a","s":"10:00","e":"09:00"},{"cat":"b","s":"9:00","e":"10:00"},{"cat":"c","s":"10:00","e":"11:00"}]}'), [
      { cat: "c", s: "10:00", e: "11:00" },
    ]);
    assert.deepEqual(parseRoutineItems(EMPTY_ROUTINE_ITEMS), []);
  });
  test("checkRoutineItems：不對 ⇒ RangeError 人話", () => {
    assert.throws(() => checkRoutineItems([{ cat: "", s: "09:00", e: "10:00" }]), /分類/);
    assert.throws(() => checkRoutineItems([{ cat: "a", s: "9", e: "10:00" }]), /14:00/);
    assert.throws(() => checkRoutineItems([{ cat: "a", s: "10:00", e: "10:00" }]), /晚於/);
    assert.throws(() => checkPlanTimes("2026-11-2", "09:00", "10:00"), /日期/);
    assert.doesNotThrow(() => checkPlanTimes("2026-11-02", "23:00", "25:00"));
  });
});

describe("週幾位元", () => {
  test("bit0＝週一 … bit6＝週日（2026-11-02 是週一、11-01 週日）", () => {
    assert.equal(weekdayBitOf("2026-11-02"), 0);
    assert.equal(weekdayBitOf("2026-11-01"), 6);
    assert.equal(weekdayBitOf("2026-11-07"), 5);
    assert.equal(weekdayBitOf("nope"), -1);
    assert.equal(hasWeekday(WEEKDAYS_WORK, "2026-11-06"), true);
    assert.equal(hasWeekday(WEEKDAYS_WORK, "2026-11-07"), false);
    assert.equal(hasWeekday(WEEKDAYS_WEEKEND, "2026-11-01"), true);
  });
  test("摘要與切換", () => {
    assert.equal(weekdaysSummary(0), "不自動帶");
    assert.equal(weekdaysSummary(WEEKDAYS_EVERY), "每天");
    assert.equal(weekdaysSummary(WEEKDAYS_WORK), "平日");
    assert.equal(weekdaysSummary(WEEKDAYS_WEEKEND), "週末");
    assert.equal(weekdaysSummary(0b10101), "週一、三、五");
    assert.equal(toggleWeekday(0b1, 0), 0);
    assert.equal(toggleWeekday(0, 6), 0b1000000);
  });
  test("兩套都勾週一 ⇒ position 前面那套贏；封存、刪除的不算；weekdayOwners 標得出誰拿走", () => {
    const a = routine({ id: "a", position: 1, weekdays: WEEKDAYS_WORK });
    const b = routine({ id: "b", position: 0, weekdays: 0b1 });
    const c = routine({ id: "c", position: -1, weekdays: WEEKDAYS_EVERY, archived_at: "x" });
    const d = routine({ id: "d", position: -2, weekdays: WEEKDAYS_EVERY, deleted_at: "x" });
    assert.equal(autoRoutineFor("2026-11-02", [a, b, c, d])?.id, "b");
    assert.equal(autoRoutineFor("2026-11-03", [a, b, c, d])?.id, "a");
    assert.equal(autoRoutineFor("2026-11-01", [a, b, c, d]), null);
    assert.deepEqual(weekdayOwners([a, b, c, d]), ["b", "a", "a", "a", "a", null, null]);
  });
});

describe("落地（D-時-160）", () => {
  const R = routine({ id: "r-1", weekdays: WEEKDAYS_WORK, items: ITEMS });
  test("id＝uuid v5(ROUTINE_PLAN_NS, day|routineId|cat|s|e|k)；兩次落地同一批 id", async () => {
    const a = await materializeRows("2026-11-02", R);
    const b = await materializeRows("2026-11-02", R);
    assert.equal(a.length, 3);
    assert.deepEqual(a.map((x) => x.id), b.map((x) => x.id));
    assert.equal(a[0].id, await uuidv5(ROUTINE_PLAN_NS, "2026-11-02|r-1|c-create|09:00|12:00|0"));
    assert.equal(a[1].id, await routinePlanId("2026-11-02", "r-1", { cat: "c-meal", s: "12:00", e: "13:00" }));
    assert.deepEqual(
      a.map((x) => [x.start_hm, x.end_hm, x.category_id, x.routine_id, x.node_id]),
      [
        ["09:00", "12:00", "c-create", "r-1", null],
        ["12:00", "13:00", "c-meal", "r-1", null],
        ["23:00", "31:00", "c-sleep", "r-1", null],
      ],
    );
    assert.notEqual((await materializeRows("2026-11-03", R))[0].id, a[0].id, "換一天＝另一批");
    assert.deepEqual(a.map((x) => x.label), [null, "午餐", null], "段的名字（D-時-167）跟著落地；沒名字＝null");
  });
  test("id 跟段的內容綁、不跟位置綁（反方評審 #2）：範本前面插一段，舊有的段 id 不變；一模一樣的兩段各有序號", async () => {
    const old = await materializeRows("2026-11-02", R);
    const R2 = routine({
      id: "r-1",
      weekdays: WEEKDAYS_WORK,
      items: serializeRoutineItems([{ cat: "c-run", s: "06:30", e: "07:00" }, ...(parseRoutineItems(ITEMS) ?? [])]),
    });
    const neu = await materializeRows("2026-11-02", R2);
    assert.equal(neu.length, 4);
    for (const o of old) {
      const same = neu.find((x) => x.id === o.id);
      assert.ok(same, "舊版的每一段在新版裡同一個 id");
      assert.deepEqual([same.category_id, same.start_hm, same.end_hm], [o.category_id, o.start_hm, o.end_hm], "同一個 id＝同一段內容");
    }
    const twin = routine({ id: "r-t", items: serializeRoutineItems([{ cat: "c-x", s: "10:00", e: "11:00" }, { cat: "c-x", s: "10:00", e: "11:00" }]) });
    const tw = await materializeRows("2026-11-02", twin);
    assert.equal(new Set(tw.map((x) => x.id)).size, 2);
  });
  test("planFillRoutine（收到就補齊）：這天有某一套的列（活著或已刪）⇒ 補上那套本機沒有的段，沿用已有列的 created_at", async () => {
    const full = await materializeRows("2026-11-02", R);
    const at = "2026-11-02T00:00:05.000Z";
    // 另一台只同步過來兩段：一段改過、一段刪了
    const got: TimePlanRow[] = [
      plan({ ...full[0], start_hm: "09:30", created_at: at, updated_at: "2026-11-02T03:00:00.000Z" }),
      plan({ ...full[1], created_at: at, deleted_at: "2026-11-02T03:00:00.000Z" }),
    ];
    const add = await planFillRoutine("2026-11-02", got, [R]);
    assert.deepEqual(add.map((u) => u.id), [full[2].id], "只補缺的那段；刪掉的不補回來、改過的不動");
    assert.equal(add[0].created_at, at);
    assert.deepEqual(await planFillRoutine("2026-11-02", [...got, plan({ ...full[2], created_at: at })], [R]), [], "齊了 ⇒ 不補");
    assert.deepEqual(await planFillRoutine("2026-11-02", [], [R]), [], "這天沒有列 ⇒ 不補（過去沒開過的日子照樣沒有作息）");
    const onlyTomb = [plan({ ...full[1], created_at: at, deleted_at: "x" })];
    assert.equal((await planFillRoutine("2026-11-02", onlyTomb, [R])).length, 2, "只收到一段墓碑也補（另一台只刪了一段）");
  });
  test("planFillRoutine 不補：範本已刪／0 段、已換成別套、範本在這天落地之後改過、版本對不上", async () => {
    const full = await materializeRows("2026-11-02", R);
    const at = "2026-11-02T00:00:05.000Z";
    const one = [plan({ ...full[0], created_at: at })];
    assert.deepEqual(await planFillRoutine("2026-11-02", one, [{ ...R, deleted_at: "x" }]), [], "範本已刪");
    assert.equal((await planFillRoutine("2026-11-02", one, [{ ...R, archived_at: "x" }])).length, 2, "封存的照補");
    assert.deepEqual(await planFillRoutine("2026-11-02", one, [{ ...R, items: serializeRoutineItems([]) }]), [], "0 段");
    // 換成別套：舊那套只剩墓碑、新那套活著 ⇒ 舊那套不補（不疊兩套）
    const B = routine({ id: "r-2", name: "假日", items: serializeRoutineItems([{ cat: "c-play", s: "10:00", e: "18:00" }]) });
    const b = await materializeRows("2026-11-02", B);
    const switched = [plan({ ...full[0], created_at: at, deleted_at: "x" }), plan({ ...b[0], created_at: at })];
    assert.deepEqual(await planFillRoutine("2026-11-02", switched, [R, B]), []);
    // 範本在這天落地之後改過（D-時-160：改範本只影響還沒落地的日子）⇒ 不補新段
    assert.deepEqual(await planFillRoutine("2026-11-02", one, [{ ...R, updated_at: "2026-11-03T00:00:00.000Z" }]), []);
    // 這天的列有不在範本現在那套裡的 id（範本的段改過）⇒ 不補
    const stale = [plan({ id: "old-version-id", routine_id: "r-1", created_at: at })];
    assert.deepEqual(await planFillRoutine("2026-11-02", stale, [R]), []);
  });
  test("套用 0 段（或讀不懂）的範本 ⇒ RangeError（那天什麼都不會出現；反方評審 #4）", async () => {
    const empty = routine({ id: "r-e", name: "休假", items: serializeRoutineItems([]) });
    const broken = routine({ id: "r-b", name: "壞", items: "{" });
    assert.equal(routineHasItems(R), true);
    assert.equal(routineHasItems(empty), false);
    assert.equal(routineHasItems(broken), false);
    await assert.rejects(planApplyRoutine("2026-11-02", [], empty, [R, empty]), /還沒有段/);
    await assert.rejects(planApplyRoutine("2026-11-02", [], broken, [R, broken]), /還沒有段/);
  });
  test("已落地＝有 routine_id 的作息列（含已刪）；車票段、手動段不算", () => {
    assert.equal(isMaterialized([]), false);
    assert.equal(isMaterialized([plan({ routine_id: null })]), false);
    assert.equal(isMaterialized([plan({ node_id: "n", routine_id: null, category_id: null })]), false);
    assert.equal(isMaterialized([plan({ routine_id: "r-1", deleted_at: "x" })]), true);
  });
  test("dayRoutineOf：虛擬（今天以後）畫範本的段、id 先算好；過去的虛擬日不畫範本；已落地畫活著的列", async () => {
    const v = await dayRoutineOf("2026-11-02", [], [R], "2026-11-02");
    assert.equal(v.materialized, false);
    assert.equal(v.routineId, "r-1");
    assert.equal(v.segs.length, 3);
    assert.ok(v.segs.every((s) => s.virtual));
    assert.equal(v.segs[0].id, await routinePlanId("2026-11-02", "r-1", { cat: "c-create", s: "09:00", e: "12:00" }));
    const past = await dayRoutineOf("2026-10-30", [], [R], "2026-11-02");
    assert.deepEqual(past.segs, []);
    assert.equal(past.routineId, null);
    const rows = await materializeRows("2026-11-02", R);
    const db: TimePlanRow[] = rows.map((u) => plan({ ...u, deleted_at: null }));
    db[1].deleted_at = "2026-11-02T01:00:00.000Z";
    db.push(plan({ id: "manual", routine_id: null, start_hm: "14:00", end_hm: "15:00" }));
    db.push(plan({ id: "slot", node_id: "n-1", category_id: null, start_hm: "16:00", end_hm: "17:00" }));
    const m = await dayRoutineOf("2026-11-02", db, [R], "2026-11-02");
    assert.equal(m.materialized, true);
    assert.equal(m.routineId, "r-1");
    assert.deepEqual(m.segs.map((s) => s.id), [rows[0].id, "manual", rows[2].id]);
    assert.ok(m.segs.every((s) => !s.virtual));
  });
  test("「這天不套」：沒落地 ⇒ 把自動範本那批寫成已刪（標記留著）；之後 dayRoutineOf 是空的、不再冒出來", async () => {
    const w = await planApplyRoutine("2026-11-02", [], null, [R]);
    assert.equal(w.upserts.length, 3);
    assert.ok(w.upserts.every((u) => u.deleted));
    assert.deepEqual(w.deletes, []);
    const db = w.upserts.map((u) => plan({ ...u, deleted_at: "x" }));
    const d = await dayRoutineOf("2026-11-02", db, [R], "2026-11-02");
    assert.equal(d.materialized, true);
    assert.deepEqual(d.segs, []);
    assert.equal(d.routineId, null);
    assert.deepEqual(await planEnsureMaterialized("2026-11-02", db, [R]), [], "已落地 ⇒ 不再落地");
  });
  test("換一套／重新套用：活著的作息段（含手動）刪掉、寫新那套；同 id 的直接 upsert 不先刪；車票段不動", async () => {
    const B = routine({ id: "r-2", name: "假日", items: serializeRoutineItems([{ cat: "c-play", s: "10:00", e: "18:00" }]) });
    const rows = await materializeRows("2026-11-02", R);
    const db: TimePlanRow[] = [
      ...rows.map((u) => plan({ ...u })),
      plan({ id: "manual", routine_id: null }),
      plan({ id: "slot", node_id: "n-1", category_id: null }),
    ];
    const sw = await planApplyRoutine("2026-11-02", db, B, [R, B]);
    assert.deepEqual(sw.upserts.map((u) => u.routine_id), ["r-2"]);
    assert.deepEqual(sw.deletes.sort(), [...rows.map((r) => r.id), "manual"].sort());
    const again = await planApplyRoutine("2026-11-02", db, R, [R, B]);
    assert.deepEqual(again.upserts.map((u) => u.id), rows.map((r) => r.id));
    assert.deepEqual(again.deletes, ["manual"], "同一套重新套用：同 id 的列直接 upsert，只刪手動段");
  });
  test("復原換套（失物招領 §5-3）：新段收回、舊段寫回原內容；車票段不動", async () => {
    const B = routine({ id: "r-2", name: "假日", items: serializeRoutineItems([{ cat: "c-play", s: "10:00", e: "18:00" }]) });
    const rows = await materializeRows("2026-11-02", R);
    const db: TimePlanRow[] = [
      ...rows.map((u) => plan({ ...u })),
      plan({ id: "manual", routine_id: null, label: "手動" }),
      plan({ id: "slot", node_id: "n-1", category_id: null }),
    ];
    const w = await planApplyRoutine("2026-11-02", db, B, [R, B]);
    const back = planUndoApplyRoutine(db, w);
    assert.deepEqual(back.deletes, w.upserts.map((u) => u.id), "新那套收回");
    assert.deepEqual(back.upserts.map((u) => u.id).sort(), [...rows.map((r) => r.id), "manual"].sort(), "舊段與手動段回來，車票段沒進來");
    assert.ok(back.upserts.every((u) => !u.deleted));
    assert.equal(back.upserts.find((u) => u.id === "manual")?.label, "手動");
  });
  test("復原重新套用：手動調過的段時刻要還回去；之前是墓碑的段再刪回去", async () => {
    const rows = await materializeRows("2026-11-02", R);
    const [edited, dead, plain] = rows;
    const db: TimePlanRow[] = [
      plan({ ...edited, start_hm: "07:30" }),
      plan({ ...dead, deleted_at: "2026-11-01T00:00:00.000Z" }),
      plan({ ...plain }),
    ];
    const w = await planApplyRoutine("2026-11-02", db, R, [R]);
    assert.ok(w.upserts.length >= 3, "同一套：同 id 直接 upsert");
    const back = planUndoApplyRoutine(db, w);
    assert.deepEqual(back.deletes, []);
    const by = new Map(back.upserts.map((u) => [u.id, u]));
    assert.equal(by.get(edited.id)?.start_hm, "07:30");
    assert.equal(by.get(dead.id)?.deleted, true);
    assert.equal(by.get(plain.id)?.deleted, undefined);
  });
  test("復原「這天不套」：舊段活回來之後，這天又是原本那一套", async () => {
    const rows = (await materializeRows("2026-11-02", R)).map((u) => plan({ ...u }));
    const w = await planApplyRoutine("2026-11-02", rows, null, [R]);
    assert.deepEqual(w.upserts, []);
    const back = planUndoApplyRoutine(rows, w);
    assert.equal(back.upserts.length, rows.length);
    const off = await dayRoutineOf("2026-11-02", rows.map((r) => ({ ...r, deleted_at: "x" })), [R], "2026-11-02");
    assert.equal(off.routineId, null);
    const on = await dayRoutineOf("2026-11-02", back.upserts.map((u) => plan({ ...u })), [R], "2026-11-02");
    assert.equal(on.routineId, "r-1");
  });
  test("復原「這天不套」的墓碑（之前這天沒有列）：標記活回來，畫面回到自動範本", async () => {
    const w = await planApplyRoutine("2026-11-02", [], null, [R]);
    const back = planUndoApplyRoutine([], w);
    assert.deepEqual(back.deletes, []);
    assert.ok(back.upserts.length === 3 && back.upserts.every((u) => !u.deleted));
  });
  test("沙盒 F-1：同一天活著的列屬於兩套 ⇒ 只畫後換的那一套（活著的列最大 created_at；同樣大＝routine_id 大的）＋手動段", async () => {
    const W = routine({ id: "r-w", name: "週末", items: serializeRoutineItems([{ cat: "c-rest", s: "10:00", e: "12:00" }, { cat: "c-gym", s: "16:00", e: "17:00" }]) });
    const S = routine({ id: "r-s", name: "讀書週", items: serializeRoutineItems([{ cat: "c-study", s: "09:00", e: "11:00" }, { cat: "c-study", s: "14:00", e: "16:00" }]) });
    const at1 = "2026-11-01T15:27:00.960Z";
    const at2 = "2026-11-01T15:27:02.960Z";
    const tomb = (await materializeRows("2026-11-02", R)).map((u) => plan({ ...u, deleted_at: at1 }));
    const w = (await materializeRows("2026-11-02", W)).map((u) => plan({ ...u, created_at: at1 }));
    const s = (await materializeRows("2026-11-02", S)).map((u) => plan({ ...u, created_at: at2 }));
    const manual = plan({ id: "manual", routine_id: null, category_id: "c-x", start_hm: "19:00", end_hm: "20:00", created_at: "2026-11-01T00:00:00.000Z" });
    const rows = [...tomb, ...w, ...s, manual];
    const v = await dayRoutineOf("2026-11-02", rows, [R, W, S], "2026-11-02");
    assert.equal(v.routineId, "r-s", "B 晚 2 秒換的讀書週");
    assert.deepEqual(v.segs.map((g) => g.id), [s[0].id, s[1].id, "manual"]);
    // 兩台收到同一批列、順序不同 ⇒ 同一套
    assert.deepEqual(await dayRoutineOf("2026-11-02", rows.slice().reverse(), [R, W, S], "2026-11-02"), v);
    // 同樣大 ⇒ routine_id 大的（"r-w" > "r-s"）
    const tie = [...w, ...s.map((x) => ({ ...x, created_at: at1 }))];
    assert.equal((await dayRoutineOf("2026-11-02", tie, [R, W, S], "2026-11-02")).routineId, "r-w");
    // 收到就補齊不碰輸的那套：週末只收到一段、讀書週齊的 ⇒ 什麼都不補（不把輸的那套補完整）
    assert.deepEqual(await planFillRoutine("2026-11-02", [...tomb, w[0], ...s], [R, W, S]), []);
    // 贏的那套缺一段 ⇒ 只補贏的那套
    const fill = await planFillRoutine("2026-11-02", [...tomb, w[0], s[0]], [R, W, S]);
    assert.deepEqual(fill.map((u) => u.id), [s[1].id]);
    // 重新套用贏的那套 ⇒ 輸的那套活著的列一起軟刪；這天不套 ⇒ 全部軟刪（使用者下一次動這天，資料就收成一套）
    const again = await planApplyRoutine("2026-11-02", rows, S, [R, W, S]);
    assert.deepEqual(again.deletes.sort(), [...w.map((x) => x.id), "manual"].sort());
    const off = await planApplyRoutine("2026-11-02", rows, null, [R, W, S]);
    assert.deepEqual(off.upserts, []);
    assert.deepEqual(off.deletes.sort(), [...w, ...s, manual].map((x) => x.id).sort());
    const sw = await planApplyRoutine("2026-11-02", rows, R, [R, W, S]);
    assert.deepEqual(sw.deletes.sort(), [...w, ...s, manual].map((x) => x.id).sort(), "換成第三套 ⇒ 兩套都刪");
  });
  test("planEnsureMaterialized（只寫本機的那批）：沒有自動範本／範本沒段 ⇒ []", async () => {
    assert.deepEqual(await planEnsureMaterialized("2026-11-01", [], [R]), [], "週日沒有範本");
    assert.deepEqual(await planEnsureMaterialized("2026-11-02", [], [routine({ weekdays: WEEKDAYS_EVERY })]), []);
    const w = await planEnsureMaterialized("2026-11-02", [], [R]);
    assert.deepEqual(w.map((u) => u.id), (await materializeRows("2026-11-02", R)).map((u) => u.id));
    assert.ok(w.every((u) => !u.deleted));
  });
});

describe("對照（D-時-161）", () => {
  const day = "2026-11-02";
  const item = { cat: "c-create", s: "09:00", e: "12:00" };
  const sp = (id: string, cat: string, a: number, b: number | null, pending = false): Span & { pending: boolean } => ({
    id,
    categoryId: cat,
    start: a,
    end: b,
    ack: false,
    pending,
  });
  test("還沒到開始 ⇒ upcoming、不比", () => {
    const c = compareRoutineItem(day, item, [], T(11, 2, 8, 0));
    assert.equal(c.state, "upcoming");
    assert.equal(fmtRoutineDelta(c), null);
  });
  test("晚 20 分開始・少 1h ⇒ late、不照表（做了 2h／3h 但開始晚了）", () => {
    const c = compareRoutineItem(day, item, [sp("b", "c-create", T(11, 2, 9, 20), T(11, 2, 11, 20))], T(11, 2, 13));
    assert.equal(c.state, "late");
    assert.equal(c.startDeltaMin, 20);
    assert.equal(c.durDeltaMin, -60);
    assert.equal(c.onSchedule, false);
    assert.equal(fmtRoutineDelta(c), "晚 20 分開始・少 1h");
  });
  test("晚 10 分內或提早＝準點；做滿一半＝照表；只比同一個分類（原型回報 ✎2：組不再代表底下的子分類）", () => {
    const group = { cat: "g-duty", s: "09:00", e: "12:00" };
    const g = compareRoutineItem(day, group, [sp("b", "c-study", T(11, 2, 8, 50), T(11, 2, 10, 40))], T(11, 2, 13));
    assert.equal(g.state, "missed", "組的 id 對不到子分類的塊");
    const study = { cat: "c-study", s: "09:00", e: "12:00" };
    const c = compareRoutineItem(day, study, [sp("b", "c-study", T(11, 2, 8, 50), T(11, 2, 10, 40))], T(11, 2, 13));
    assert.equal(c.state, "onTime");
    assert.equal(c.startDeltaMin, -10);
    assert.equal(c.actualMs, 100 * MIN, "夾在 [s, e] 內：09:00–10:40");
    assert.equal(c.onSchedule, true);
    const late10 = compareRoutineItem(day, item, [sp("b", "c-create", T(11, 2, 9, 10), T(11, 2, 12))], T(11, 2, 13));
    assert.equal(late10.state, "onTime");
  });
  test("分類不同的不算；沒重疊：段還沒結束＝還沒開始、結束了＝沒記到；碎塊不算", () => {
    const other = [sp("x", "c-play", T(11, 2, 9), T(11, 2, 12)), sp("tiny", "c-create", T(11, 2, 9), T(11, 2, 9) + 30_000)];
    const mid = compareRoutineItem(day, item, other, T(11, 2, 10));
    assert.equal(mid.state, "notStarted");
    assert.equal(fmtRoutineDelta(mid), "還沒開始");
    assert.deepEqual(mid.blockIds, ["tiny"], "描金照樣含碎塊");
    const after = compareRoutineItem(day, item, other, T(11, 2, 13));
    assert.equal(after.state, "missed");
    assert.equal(fmtRoutineDelta(after), "沒記到");
  });
  test("運行中：寫「運行中・準點・已 X／預計 Y」；待確認的塊算開始不算時長", () => {
    const run = compareRoutineItem(day, item, [sp("r", "c-create", T(11, 2, 9, 5), null)], T(11, 2, 10, 5));
    assert.equal(run.state, "running");
    assert.equal(fmtRoutineDelta(run), "運行中・準點・已 1h／預計 3h");
    const pend = compareRoutineItem(day, item, [sp("p", "c-create", T(11, 2, 9), T(11, 2, 12), true)], T(11, 2, 13));
    assert.equal(pend.state, "onTime");
    assert.equal(pend.actualMs, 0);
    assert.equal(pend.onSchedule, false);
  });
  test("跨日界線的段（23:00–25:00）：用 clockInstant 進位到隔天", () => {
    const night = { cat: "c-create", s: "23:00", e: "25:00" };
    const c = compareRoutineItem(day, night, [sp("n", "c-create", T(11, 2, 23), T(11, 3, 1))], T(11, 3, 2));
    assert.equal(c.state, "onTime");
    assert.equal(c.actualMs, 120 * MIN);
    assert.equal(c.onSchedule, true);
  });
  test("沙盒 O-2：段還沒結束只判開始、不寫長短；結束後才寫完整的（23:00–25:00、塊 23:10–24:00）", () => {
    const night = { cat: "c-create", s: "23:00", e: "25:00" };
    const blk = [sp("n", "c-create", T(11, 2, 23, 10), T(11, 3, 0))];
    const mid = compareRoutineItem(day, night, blk, T(11, 3, 0) + 29_000);
    assert.equal(mid.state, "onTime");
    assert.equal(mid.durDeltaMin, null);
    assert.equal(fmtRoutineDelta(mid), "準點");
    const done = compareRoutineItem(day, night, blk, T(11, 3, 1));
    assert.equal(done.durDeltaMin, -70);
    assert.equal(fmtRoutineDelta(done), "準點・少 1h10m");
    const late = compareRoutineItem(day, item, [sp("b", "c-create", T(11, 2, 9, 30), T(11, 2, 10))], T(11, 2, 11));
    assert.equal(fmtRoutineDelta(late), "晚 30 分開始", "段 09:00–12:00 還沒結束：只寫開始晚多少");
  });
  test("頂端總結：「作息 3 段・照表 1」；0 段不印", () => {
    const ok = compareRoutineItem(day, item, [sp("b", "c-create", T(11, 2, 9), T(11, 2, 12))], T(11, 2, 13));
    const bad = compareRoutineItem(day, item, [], T(11, 2, 13));
    assert.equal(routineSummaryText([ok, bad, bad]), "作息 3 段・照表 1");
    assert.equal(routineSummaryText([]), null);
  });
});

describe("從某天的記錄帶入", () => {
  test("≥ 10 分的塊照順序、同分類相鄰的併成一段（中間的碎塊不擋）；夾在日界線窗內；運行中算到 now", () => {
    const blocks: Span[] = [
      { id: "a", categoryId: "sleep", start: T(11, 2, 1), end: T(11, 2, 7, 30), ack: true }, // 窗從 06:00 起
      { id: "b", categoryId: "create", start: T(11, 2, 9), end: T(11, 2, 10), ack: false },
      { id: "c", categoryId: "rest", start: T(11, 2, 10), end: T(11, 2, 10, 5), ack: false }, // < 10 分
      { id: "d", categoryId: "create", start: T(11, 2, 10, 5), end: T(11, 2, 12), ack: false },
      { id: "e", categoryId: "meal", start: T(11, 2, 12), end: T(11, 2, 12, 9), ack: false }, // < 10 分
      { id: "f", categoryId: "sleep", start: T(11, 3, 0, 30), end: null, ack: false }, // 運行中、跨午夜
    ];
    assert.deepEqual(routineFromDay(blocks, "2026-11-02", H, T(11, 3, 2)), [
      { cat: "sleep", s: "06:00", e: "07:30" },
      { cat: "create", s: "09:00", e: "12:00" },
      { cat: "sleep", s: "24:30", e: "26:00" },
    ]);
  });
});

describe("車票多時段（D-時-162）", () => {
  const segs = [
    { key: "1", start: T(11, 2, 9), end: T(11, 2, 10) },
    { key: "2", start: T(11, 2, 14), end: T(11, 2, 16) },
  ];
  test("塊給重疊最多的那段；都沒重疊＝開始最近的；運行中算到 now", () => {
    const spans: Span[] = [
      { id: "a", categoryId: "c", start: T(11, 2, 9, 30), end: T(11, 2, 14, 30), ack: false }, // 跟 1 重疊 30 分、跟 2 重疊 30 分 ⇒ 開始早的
      { id: "b", categoryId: "c", start: T(11, 2, 13, 50), end: T(11, 2, 15), ack: false },
      { id: "c", categoryId: "c", start: T(11, 2, 11), end: T(11, 2, 11, 30), ack: false }, // 沒重疊：離 1 兩小時、離 2 三小時
      { id: "d", categoryId: "c", start: T(11, 2, 13), end: null, ack: false }, // 運行中，now 15:00
    ];
    assert.deepEqual(assignSpansToSegments(spans, segs, T(11, 2, 15)), { "1": ["a", "c"], "2": ["d", "b"] });
    assert.deepEqual(assignSpansToSegments(spans, [], T(11, 2, 15)), {});
  });
  test("slotsOfNode：活著的、day → 開始時刻", () => {
    const rows = [
      plan({ id: "x", node_id: "n", day: "2026-11-03", start_hm: "09:00" }),
      plan({ id: "y", node_id: "n", day: "2026-11-02", start_hm: "14:00" }),
      plan({ id: "z", node_id: "n", day: "2026-11-02", start_hm: "10:00", deleted_at: "x" }),
      plan({ id: "w", node_id: "m", day: "2026-11-01" }),
    ];
    assert.deepEqual(slotsOfNode(rows, "n").map((r) => r.id), ["y", "x"]);
  });
});

describe("塊的備註（D-時-163／164）", () => {
  const A: Span = { id: "a", categoryId: "c-create", start: T(11, 2, 9), end: T(11, 2, 12), ack: false };
  const B: Span = { id: "b", categoryId: "c-study", start: T(11, 2, 12), end: T(11, 2, 13), ack: false };
  const now = T(11, 2, 20);
  test("normalizeNote：去前後空白、換行變空白、空＝null、undefined 照傳", () => {
    assert.equal(normalizeNote("  寫第三章\n草稿 "), "寫第三章 草稿");
    assert.equal(normalizeNote("   "), null);
    assert.equal(normalizeNote(null), null);
    assert.equal(normalizeNote(undefined), undefined);
  });
  test("insertNoteOf：明寫優先；fromId 抄來源；noTagCarry 不抄", () => {
    const src = { note: "原本的" };
    assert.equal(insertNoteOf({ fromId: "a", note: undefined }, src), "原本的");
    assert.equal(insertNoteOf({ fromId: "a", note: "新的" }, src), "新的");
    assert.equal(insertNoteOf({ fromId: "a", noTagCarry: true }, src), null);
    assert.equal(insertNoteOf({ fromId: null }, src), null);
    assert.equal(insertNoteOf({ fromId: "a" }, {}), null, "舊列沒有這欄");
  });
  test("切開／多切點／蓋掉切出的尾段 ⇒ insert 有 fromId、沒明寫 note（照來源抄）；「改成另一個分類」⇒ noTagCarry", () => {
    const s1 = planSplit([A], { id: "a", at: T(11, 2, 10), categoryId2: "c-study", now })!;
    assert.equal(s1.inserts[0].fromId, "a");
    assert.equal(s1.inserts[0].note, undefined);
    const s2 = planSplitMulti([A], { id: "a", cuts: [T(11, 2, 10), T(11, 2, 11)], categoryIds: ["c-create", "c-study", "c-create"], now });
    assert.ok(s2.inserts.every((i) => i.fromId === "a" && i.note === undefined));
    const cov = planCover([A], { start: T(11, 2, 10), end: T(11, 2, 11) }, null);
    assert.equal(cov.inserts[0].fromId, "a");
    const lr = planResolveLongRun([A], { id: "a", end: T(11, 2, 10), choice: "cat", categoryId2: "c-play", now });
    assert.equal(lr.inserts[0].noTagCarry, true);
  });
  test("planFill／planEdit 收備註；跟現值一樣不出 patch", () => {
    const f = planFill([], { categoryId: "c", start: T(11, 2, 14), end: T(11, 2, 15), now, note: " 讀書會 " });
    assert.equal(f.inserts[0].note, "讀書會");
    const e1 = planEdit([A], { id: "a", categoryId: "c-create", start: A.start, end: A.end!, now, note: "x", curNote: null });
    assert.deepEqual(e1.patches, [{ id: "a", note: "x" }]);
    const e2 = planEdit([A], { id: "a", categoryId: "c-create", start: A.start, end: A.end!, now, note: "x", curNote: "x" });
    assert.deepEqual(e2.patches, []);
    const e3 = planEdit([A], { id: "a", categoryId: "c-create", start: A.start, end: A.end!, now, note: "", curNote: "x" });
    assert.deepEqual(e3.patches, [{ id: "a", note: null }]);
  });
  test("合併：留當前塊的；當前沒寫才拿被吞那塊的；併進運行中＝抄當前塊的（當前沒寫就留運行中的）", () => {
    const info = (notes: Record<string, string | null>) => (id: string) => ({ estimateMin: null, link: { nodeId: null, routeId: null }, note: notes[id] ?? null });
    const keepMine = planMerge([A, B], { id: "b", dir: "prev", bound: T(11, 2, 6), now, infoOf: info({ a: "鄰居", b: "我的" }) })!;
    assert.equal(keepMine.plan.patches.find((p) => p.id === "b")?.note, undefined);
    const takeTheirs = planMerge([A, B], { id: "b", dir: "prev", bound: T(11, 2, 6), now, infoOf: info({ a: "鄰居", b: null }) })!;
    assert.equal(takeTheirs.plan.patches.find((p) => p.id === "b")?.note, "鄰居");
    const takeNext = planMerge([A, B], { id: "a", dir: "next", bound: T(11, 2, 20), now, infoOf: info({ a: null, b: "下一塊" }) })!;
    assert.equal(takeNext.plan.patches.find((p) => p.id === "a")?.note, "下一塊");
    const R: Span = { ...B, end: null };
    const intoRun = planMerge([A, R], { id: "a", dir: "next", bound: T(11, 2, 20), now, infoOf: info({ a: "當前", b: "運行中的" }) })!;
    assert.equal(intoRun.preview.intoRunning, true);
    assert.equal(intoRun.plan.patches.find((p) => p.id === "b")?.note, "當前");
    const keepRun = planMerge([A, R], { id: "a", dir: "next", bound: T(11, 2, 20), now, infoOf: info({ a: null, b: "運行中的" }) })!;
    assert.equal(keepRun.plan.patches.find((p) => p.id === "b")?.note, undefined);
  });
});

describe("同步清單：time_routines／time_plans", () => {
  const TEXT = {
    syncNodeGone: "一張車票",
    syncCatGone: "已刪除的分類",
    syncArchived: "已封存",
    syncNotArchived: "沒封存",
    syncRoutineLabel: (n: string) => `作息範本「${n}」`,
    syncRoutineGone: "已刪除的範本",
    syncRoutineManual: "（手動加的）",
    syncWeekdays: weekdaysSummary,
    syncRoutineItems: (j: string) => {
      const it = parseRoutineItems(j);
      return it === null ? null : `${it.length} 段`;
    },
    syncSlotOrdinal: (n: number) => `第 ${n} 段`,
    syncCols: { time_blocks: {}, time_categories: {}, time_goals: {}, time_routines: { name: "名字" }, time_plans: { day: "日期" } },
  } as unknown as SyncLabelText;
  const look: SyncLabelLookup = {
    now: T(11, 1, 12),
    dayStartHour: H,
    categoryName: (id) => ({ "c-create": "創作" })[id] ?? null,
    nodeName: (id) => ({ "n-1": "期中報告" })[id] ?? null,
    routeName: () => null,
    routineName: (id) => ({ "r-1": "工作日" })[id] ?? null,
  };
  test("範本：名字、段數、週幾摘要", () => {
    const l = routineSyncLabel(routine({ items: ITEMS, weekdays: WEEKDAYS_WORK }), look, TEXT);
    assert.equal(l.label, "作息範本「工作日」");
    assert.equal(l.fmt!("items", ITEMS), "3 段");
    assert.equal(l.fmt!("weekdays", WEEKDAYS_WORK), "平日");
    assert.equal(l.fmt!("name", "x"), null);
  });
  test("預定：作息段「11/2 創作 09:00–12:00」、車票段「11/3 期中報告 第 2 段 14:00–16:00」", () => {
    assert.equal(planSyncLabel(plan({}), look, TEXT).label, "11/2 創作 09:00–12:00");
    assert.equal(planSyncLabel(plan({ label: "早餐" }), look, TEXT).label, "11/2 早餐 09:00–12:00", "有名字印名字");
    const slot = planSyncLabel(plan({ day: "2026-11-03", node_id: "n-1", category_id: null, start_hm: "14:00", end_hm: "16:00" }), look, TEXT, 2);
    assert.equal(slot.label, "11/3 期中報告 第 2 段 14:00–16:00");
    assert.equal(slot.fmt!("routine_id", null), "（手動加的）");
    assert.equal(slot.fmt!("routine_id", "r-1"), "工作日");
    assert.equal(slot.fmt!("day", "2026-11-03"), "11/3");
  });
});
