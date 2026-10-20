/**
 * 主線階段②「車票預定時刻」・純函式與 repository 單元測試（契約 §6.3）。
 * 跑法：`node --test scripts/tests/ticket-time.test.ts`（node 24，型別剝除預設開；零依賴）。
 * 放 `scripts/` 而不是 `src/`：tsconfig 的 include 只有 src，不會去找 node:test 的型別。
 *
 * 載入：`date.ts`／`scheduledTime.ts`／`sql.ts`／`timeGridModel.ts` 是純檔，直接 import；
 * `nodeRepository.ts`（compareTodayRows／sortByDateThenNode／buildSchedule）與 `memoryRepository.ts` 有沒寫副檔名的相對 import，
 * 所以用 `module.registerHooks` 補 `.ts`（資料夾補 `/index.ts`），並把 `../lib/db` 換成替身（不載 tauri-plugin-sql）。
 * 時區：測資一律用 `new Date(y, m-1, d, h, mi)` 造本地時刻，不寫 UTC 字面值。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";

/* ───────── 載入替身（只影響 src/ 底下的 import） ───────── */

const FAKE_DB = `
let t = Date.now(); // 接近真實時間：seedDemo 的「今天蓋済」要落在真實的日界線視窗內
export function getDb() { throw new Error("測試不碰 sqlite"); }
export function uuid() { return crypto.randomUUID(); }
export function nowUtcIso() { t += 1000; return new Date(t).toISOString(); }
`;
const dataUrl = (src: string) => "data:text/javascript," + encodeURIComponent(src);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const fromSrc = context.parentURL !== undefined && context.parentURL.includes("/src/");
    if (fromSrc) {
      if (specifier === "../lib/db") return { url: dataUrl(FAKE_DB), shortCircuit: true };
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

import {
  addDays,
  arrivalClock,
  clockInstant,
  clockMinutes,
  clockRange,
  clockSpan,
  clockText,
  compareClock,
  isClockInRange,
  isClockPast,
  nextDayNote,
  nowClockMinutes,
  parseClockInput,
  todayKey,
} from "../../src/lib/date.ts";
import {
  TIME_FIXED_ORDER_MSG,
  TIME_FORMAT_MSG,
  TIME_REPEAT_ONLY_MSG,
  assertClockWritable,
  dropFutureOverrides,
  effectiveTime,
  isTimeOverridden,
  manualIndexOfDisplay,
  manualOrderIds,
  parseTimeOverrides,
  serializeTimeOverrides,
  timeOfRow,
  type TodayLike,
} from "../../src/domain/scheduledTime.ts";
import { escapeLike } from "../../src/lib/sql.ts";
import {
  LANE_MIN_MIN,
  NO_ESTIMATE_MIN,
  hourTicks,
  timeGridModel,
} from "../../src/ui/schedule/timeGridModel.ts";
import type { ScheduleEntry, TodayRow } from "../../src/data/nodeRepository.ts";
import type { NodeRow } from "../../src/domain/node.ts";

// 靜態 import 會在 registerHooks 之前就被載入，所以需要 resolve hook 的檔一律動態 import
const { compareTodayRows, buildSchedule } = await import("../../src/data/nodeRepository.ts");
const { MemoryNodeRepository } = await import("../../src/data/memoryRepository.ts");
const { fixedRule } = await import("../../src/domain/repeat.ts");

/* ───────── 測資工廠 ───────── */

const TODAY = "2026-10-16"; // 週五
const H = 6; // 日界線

const node = (o: Partial<NodeRow> = {}): NodeRow => ({
  id: "n1",
  kind: "ticket",
  parent_id: null,
  line_id: null,
  route_id: null,
  name: "票",
  description: null,
  position: 0,
  color: null,
  code: null,
  status: "todo",
  scheduled_on: TODAY,
  due_on: null,
  priority: "mid",
  estimate_min: null,
  progress: null,
  time_spent_min: null,
  mood: null,
  repeat_rule: null,
  completed_at: null,
  expected_on: null,
  arrived_on: null,
  today_position: null,
  carried_from: null,
  scheduled_time: null,
  time_overrides: null,
  account_id: null,
  device_id: null,
  created_at: "2026-10-01T00:00:00.000Z",
  updated_at: "2026-10-01T00:00:00.000Z",
  synced_at: null,
  deleted_at: null,
  ...o,
});

const RULE = JSON.stringify(fixedRule("daily", "2026-10-01")); // 有規則的測資用（覆寫表只在有規則時才讀；B1）

const trow = (o: Partial<TodayRow> = {}): TodayRow => ({
  ...node(o),
  child_total: 0,
  child_done: 0,
  serial: "",
  bucket: "today",
  occurrence: null,
  ...o,
});

const entry = (date: string, node_id: string, time: string | null = null, o: Partial<ScheduleEntry> = {}): ScheduleEntry => ({
  date,
  node_id,
  kind: "single",
  occurrence_status: null,
  is_late: false,
  is_done: false,
  is_assumed: false,
  time,
  ...o,
});

const ms = (y: number, m: number, d: number, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi).getTime();

/* ═══════════════ lib/date.ts：parseClockInput ═══════════════ */

describe("parseClockInput（日界線 6）", () => {
  const cases: [string, string | null][] = [
    ["14", "14:00"],
    ["9", "09:00"],
    ["930", "09:30"],
    ["0930", "09:30"],
    ["1400", "14:00"],
    ["14:00", "14:00"],
    ["2:30", "26:30"],
    ["2.30", "26:30"],
    ["14：00", "14:00"],
    ["１４００", "14:00"],
    ["1:00", "25:00"],
    ["25:00", "25:00"],
    ["2500", "25:00"],
    ["6", "06:00"],
    ["5:59", "29:59"],
    ["24:00", "24:00"],
    ["30:00", null],
    ["14:60", null],
    ["abc", null],
    ["下午3點", null],
    ["", null],
    ["   ", null],
    ["  14  ", "14:00"],
    ["2:3", null], // 帶冒號的分鐘必須兩位，免得 2.3 被讀成 02:03
    ["14:00:00", null],
  ];
  for (const [raw, want] of cases) {
    test(`${JSON.stringify(raw)} → ${want}`, () => assert.equal(parseClockInput(raw, H), want));
  }
  test("日界線 0：1:00 → 01:00、25:00 → null", () => {
    assert.equal(parseClockInput("1:00", 0), "01:00");
    assert.equal(parseClockInput("25:00", 0), null);
  });
  test("日界線 3：2:30 → 26:30、3:00 → 03:00", () => {
    assert.equal(parseClockInput("2:30", 3), "26:30");
    assert.equal(parseClockInput("3:00", 3), "03:00");
  });
});

/* ═══════════════ lib/date.ts：其他純函式 ═══════════════ */

describe("clockMinutes／clockText／clockRange／isClockInRange", () => {
  test("clockMinutes 來回 clockText", () => {
    for (const t of ["00:00", "06:00", "14:30", "25:30", "29:59", "47:59"]) {
      const m = clockMinutes(t);
      assert.notEqual(m, null);
      assert.equal(clockText(m as number), t);
    }
    assert.equal(clockMinutes("25:30"), 1530);
  });
  test("clockMinutes 擋壞格式與分 ≥ 60", () => {
    assert.equal(clockMinutes("1:30"), null);
    assert.equal(clockMinutes("14:60"), null);
    assert.equal(clockMinutes("14-30"), null);
    assert.equal(clockMinutes(""), null);
  });
  test("clockText 擋負數／非整數／≥ 6000", () => {
    assert.equal(clockText(-1), null);
    assert.equal(clockText(1.5), null);
    assert.equal(clockText(6000), null);
    assert.equal(clockText(5999), "99:59");
  });
  test("clockRange(6) = {360, 1799}", () => {
    assert.deepEqual(clockRange(6), { min: 360, max: 1799 });
    assert.deepEqual(clockRange(0), { min: 0, max: 1439 });
  });
  test("isClockInRange：兩端含、格式壞 ⇒ false", () => {
    assert.equal(isClockInRange("06:00", 6), true);
    assert.equal(isClockInRange("29:59", 6), true);
    assert.equal(isClockInRange("05:59", 6), false);
    assert.equal(isClockInRange("30:00", 6), false);
    assert.equal(isClockInRange("9:00", 6), false);
  });
});

describe("clockInstant／clockSpan", () => {
  test("clockInstant 25:00 ＝ 隔天 01:00（本地）", () => {
    assert.equal(clockInstant("2026-10-16", "25:00"), ms(2026, 10, 17, 1, 0));
    assert.equal(clockInstant("2026-10-16", "14:30"), ms(2026, 10, 16, 14, 30));
  });
  test("clockInstant 格式不對 ⇒ null", () => {
    assert.equal(clockInstant("2026-10", "14:00"), null);
    assert.equal(clockInstant("2026-10-16", "14"), null);
  });
  test("clockSpan 有預計", () => {
    assert.deepEqual(clockSpan("2026-10-16", "14:00", 90), { start: ms(2026, 10, 16, 14), end: ms(2026, 10, 16, 15, 30) });
  });
  test("clockSpan 沒預計／0／負數 ⇒ end === start", () => {
    const s = ms(2026, 10, 16, 14);
    assert.deepEqual(clockSpan("2026-10-16", "14:00", null), { start: s, end: s });
    assert.deepEqual(clockSpan("2026-10-16", "14:00", 0), { start: s, end: s });
    assert.deepEqual(clockSpan("2026-10-16", "14:00", -5), { start: s, end: s });
  });
  test("clockSpan 跨日不裁切；格式不對 ⇒ null", () => {
    assert.deepEqual(clockSpan("2026-10-16", "25:00", 120), { start: ms(2026, 10, 17, 1), end: ms(2026, 10, 17, 3) });
    assert.equal(clockSpan("x", "25:00", 120), null);
  });
});

describe("arrivalClock／nextDayNote／compareClock／isClockPast", () => {
  test("arrivalClock", () => {
    assert.equal(arrivalClock("14:00", 90), "15:30");
    assert.equal(arrivalClock("23:30", 120), "25:30");
    assert.equal(arrivalClock("14:00", null), null);
    assert.equal(arrivalClock("14:00", 0), null);
    assert.equal(arrivalClock("14:00", 99999), null);
  });
  test("nextDayNote", () => {
    assert.equal(nextDayNote("25:00"), "隔天 01:00");
    assert.equal(nextDayNote("24:00"), "隔天 00:00");
    assert.equal(nextDayNote("14:00"), null);
  });
  test("compareClock 三態", () => {
    assert.ok(compareClock("09:00", "10:00") < 0);
    assert.ok(compareClock("25:00", "23:00") > 0);
    assert.equal(compareClock("09:00", "09:00"), 0);
    assert.ok(compareClock("09:00", null) < 0); // 有時刻的在前
    assert.ok(compareClock(null, "09:00") > 0);
    assert.equal(compareClock(null, undefined), 0);
  });
  test("isClockPast 前後各一；null ⇒ false", () => {
    const at = ms(2026, 10, 16, 9);
    assert.equal(isClockPast("2026-10-16", "09:00", at - 1), false);
    assert.equal(isClockPast("2026-10-16", "09:00", at), true);
    assert.equal(isClockPast("2026-10-16", null, at + 1e9), false);
    assert.equal(isClockPast("2026-10-16", "xx", at + 1e9), false);
  });
  test("isClockPast：25:00 在隔天 00:30 還沒到、01:05 已過", () => {
    assert.equal(isClockPast("2026-10-16", "25:00", ms(2026, 10, 17, 0, 30)), false);
    assert.equal(isClockPast("2026-10-16", "25:00", ms(2026, 10, 17, 1, 5)), true);
  });
});

describe("nowClockMinutes", () => {
  test("這一天之內（含隔天 00:30 ⇒ 1470）", () => {
    assert.equal(nowClockMinutes("2026-10-16", H, ms(2026, 10, 16, 14, 5)), 14 * 60 + 5);
    assert.equal(nowClockMinutes("2026-10-16", H, ms(2026, 10, 17, 0, 30)), 1470);
    assert.equal(nowClockMinutes("2026-10-16", H, ms(2026, 10, 16, 6, 0)), 360);
  });
  test("不在這一天 ⇒ null", () => {
    assert.equal(nowClockMinutes("2026-10-16", H, ms(2026, 10, 16, 5, 59)), null);
    assert.equal(nowClockMinutes("2026-10-16", H, ms(2026, 10, 17, 6, 0)), null);
    assert.equal(nowClockMinutes("2026-10-17", H, ms(2026, 10, 16, 14)), null);
  });
});

describe("todayKey 日界線必填", () => {
  test("日界線之前算前一天", () => {
    assert.equal(todayKey(6, new Date(2026, 9, 17, 5, 59)), "2026-10-16");
    assert.equal(todayKey(6, new Date(2026, 9, 17, 6, 0)), "2026-10-17");
  });
});

/* ═══════════════ domain/scheduledTime.ts ═══════════════ */

describe("TimeOverrides 解析與序列化", () => {
  test("parseTimeOverrides：壞 JSON／非物件／空 ⇒ {}", () => {
    assert.deepEqual(parseTimeOverrides(null), {});
    assert.deepEqual(parseTimeOverrides(undefined), {});
    assert.deepEqual(parseTimeOverrides(""), {});
    assert.deepEqual(parseTimeOverrides("{oops"), {});
    assert.deepEqual(parseTimeOverrides("[1,2]"), {});
    assert.deepEqual(parseTimeOverrides("42"), {});
    assert.deepEqual(parseTimeOverrides("null"), {});
  });
  test("parseTimeOverrides：壞 key／壞值靜默丟掉、null 值保留", () => {
    const o = parseTimeOverrides(
      JSON.stringify({ "2026-10-16": "09:30", "2026-10-17": null, "10/18": "08:00", "2026-10-19": "9:00", "2026-10-20": 5 }),
    );
    assert.deepEqual(o, { "2026-10-16": "09:30", "2026-10-17": null });
  });
  test("serializeTimeOverrides：空表 ⇒ null、key 排序", () => {
    assert.equal(serializeTimeOverrides({}), null);
    const s = serializeTimeOverrides({ "2026-10-18": "10:00", "2026-10-16": null, "2026-10-17": "09:00" });
    assert.equal(s, '{"2026-10-16":null,"2026-10-17":"09:00","2026-10-18":"10:00"}');
    // 兩台對同一張表產同一個字
    assert.equal(
      serializeTimeOverrides({ "2026-10-17": "09:00", "2026-10-16": null, "2026-10-18": "10:00" }),
      s,
    );
  });
  test("dropFutureOverrides：丟班次日 ≥ from", () => {
    const out = dropFutureOverrides({ "2026-10-15": "07:00", "2026-10-16": "08:00", "2026-10-17": null }, "2026-10-16");
    assert.deepEqual(out, { "2026-10-15": "07:00" });
  });
});

describe("effectiveTime／isTimeOverridden", () => {
  const rule = node({ repeat_rule: RULE, scheduled_time: "07:00", time_overrides: '{"2026-10-16":"09:30","2026-10-17":null}' });
  test("覆寫命中 ⇒ 用它", () => assert.equal(effectiveTime(rule, "2026-10-16"), "09:30"));
  test("覆寫是 null ⇒ 本班無時刻（蓋掉每班時刻）", () => assert.equal(effectiveTime(rule, "2026-10-17"), null));
  test("沒命中 ⇒ scheduled_time", () => assert.equal(effectiveTime(rule, "2026-10-18"), "07:00"));
  test("date 為 null ⇒ scheduled_time", () => assert.equal(effectiveTime(rule, null), "07:00"));
  test("單發票（覆寫表空）直接回 scheduled_time", () => {
    assert.equal(effectiveTime(node({ scheduled_time: "14:00" }), TODAY), "14:00");
    assert.equal(effectiveTime(node(), TODAY), null);
  });
  test("isTimeOverridden", () => {
    assert.equal(isTimeOverridden(rule, "2026-10-16"), true);
    assert.equal(isTimeOverridden(rule, "2026-10-17"), true); // null 覆寫也算「本班」
    assert.equal(isTimeOverridden(rule, "2026-10-18"), false);
    assert.equal(isTimeOverridden(rule, null), false);
    assert.equal(isTimeOverridden(node(), TODAY), false);
  });
  // B1：跨機並發「A 清規則、B 設本班時刻」會留下「沒規則但有覆寫表」的票——覆寫表一律不讀
  const stale = node({ repeat_rule: null, scheduled_time: "07:00", time_overrides: '{"2026-10-16":"09:45"}' });
  test("B1：沒規則＋殘留覆寫 ⇒ effectiveTime 回 scheduled_time", () => {
    assert.equal(effectiveTime(stale, "2026-10-16"), "07:00");
    assert.equal(effectiveTime({ ...stale, repeat_rule: "" }, "2026-10-16"), "07:00");
    assert.equal(effectiveTime({ ...stale, repeat_rule: "  " }, "2026-10-16"), "07:00");
    assert.equal(effectiveTime({ ...stale, scheduled_time: null }, "2026-10-16"), null);
  });
  test("B1：沒規則＋殘留覆寫 ⇒ isTimeOverridden false", () => {
    assert.equal(isTimeOverridden(stale, "2026-10-16"), false);
    assert.equal(isTimeOverridden({ ...stale, repeat_rule: "" }, "2026-10-16"), false);
  });
  test("B1：沒規則＋殘留覆寫 ⇒ timeOfRow 用 scheduled_time（今日列、含已有 occurrence 的形狀）", () => {
    assert.equal(timeOfRow(trow({ ...stale, scheduled_on: TODAY })), "07:00");
    assert.equal(
      timeOfRow(trow({ ...stale, scheduled_on: "2026-10-17", occurrence: { id: "o", status: "done", due_on: "2026-10-16" } })),
      "07:00",
    );
  });
  test("B1：加上規則後同一份覆寫表照讀", () => {
    assert.equal(effectiveTime({ ...stale, repeat_rule: RULE }, "2026-10-16"), "09:45");
    assert.equal(isTimeOverridden({ ...stale, repeat_rule: RULE }, "2026-10-16"), true);
  });
});

describe("今日列：timeOfRow／manualOrderIds／manualIndexOfDisplay", () => {
  test("timeOfRow：today／late／due 三種 bucket", () => {
    // today：定期券已済（occurrence.due_on = 今天，scheduled_on 已被推到明天）⇒ 看班次日
    const done = trow({
      repeat_rule: RULE,
      scheduled_time: "07:00",
      time_overrides: '{"2026-10-16":"09:30"}',
      scheduled_on: "2026-10-17",
      occurrence: { id: "o", status: "done", due_on: "2026-10-16" },
    });
    assert.equal(timeOfRow(done), "09:30");
    // late：誤點班的原定日沒有覆寫 ⇒ 每班時刻
    const late = trow({
      bucket: "late",
      repeat_rule: RULE,
      scheduled_time: "06:30",
      time_overrides: '{"2026-10-16":"09:30"}',
      scheduled_on: "2026-10-14",
    });
    assert.equal(timeOfRow(late), "06:30");
    // due：沒有執行日 ⇒ 退到 scheduled_time（單發票，null）
    assert.equal(timeOfRow(trow({ bucket: "due", scheduled_on: null, due_on: "2026-10-15" })), null);
    assert.equal(timeOfRow(trow({ bucket: "due", scheduled_on: null, scheduled_time: "10:00" })), "10:00");
  });

  const T = (id: string, time: string | null = null, bucket: TodayLike["bucket"] = "today"): TodayLike => ({
    id,
    bucket,
    scheduled_time: time,
    time_overrides: null,
    scheduled_on: TODAY,
    occurrence: null,
  });
  test("manualOrderIds：只收沒時刻的 today 列、依傳入順序", () => {
    const rows = [T("late1", null, "late"), T("a", "09:00"), T("b"), T("due1", null, "due"), T("c", "10:00"), T("d")];
    assert.deepEqual(manualOrderIds(rows), ["b", "d"]);
  });
  test("manualIndexOfDisplay：[T, U, T, U] 的 index 0..4 ⇒ 0,0,1,1,2", () => {
    const rows = [T("t1", "09:00"), T("u1"), T("t2", "10:00"), T("u2")];
    assert.deepEqual([0, 1, 2, 3, 4].map((i) => manualIndexOfDisplay(rows, i)), [0, 0, 1, 1, 2]);
  });
  test("manualIndexOfDisplay：index 超過長度夾在尾端", () => {
    const rows = [T("u1"), T("u2")];
    assert.equal(manualIndexOfDisplay(rows, 99), 2);
  });
  test("座標換算：有時刻的票在最上面 N 條時，落點仍對（契約 §6.1 #3）", () => {
    // 畫面：[T1, T2, U1, U2, U3]；把 U3（手排 index 2）拖到 U1 上方（畫面 index 2、edge before）
    const rows = [T("t1", "08:00"), T("t2", "09:00"), T("u1"), T("u2"), T("u3")];
    const ids = manualOrderIds(rows);
    assert.deepEqual(ids, ["u1", "u2", "u3"]);
    const from = ids.indexOf("u3");
    const k = manualIndexOfDisplay(rows, 2); // before 畫面 index 2（U1）
    assert.equal(k, 0);
    const to = k > from ? k - 1 : k;
    assert.equal(to, 0); // 插到手排的最前面，而不是被畫面座標 2 帶到 u3 自己腳邊
  });
  test("訊息常數存在且不是空字串", () => {
    for (const m of [TIME_FORMAT_MSG, TIME_REPEAT_ONLY_MSG, TIME_FIXED_ORDER_MSG]) assert.ok(m.length > 4);
  });
  test("assertClockWritable：null 放行；沒有 dayStartHour／越界／壞格式都 throw TIME_FORMAT_MSG", () => {
    assert.doesNotThrow(() => assertClockWritable(null, undefined));
    assert.doesNotThrow(() => assertClockWritable("25:00", 6));
    assert.throws(() => assertClockWritable("14:00", undefined), { message: TIME_FORMAT_MSG });
    assert.throws(() => assertClockWritable("30:00", 6), { message: TIME_FORMAT_MSG });
    assert.throws(() => assertClockWritable("9:00", 6), { message: TIME_FORMAT_MSG });
  });
});

/* ═══════════════ nodeRepository：排序與 buildSchedule ═══════════════ */

describe("compareTodayRows（today 分區的時刻鍵）", () => {
  const ids = (rows: TodayRow[]) => [...rows].sort(compareTodayRows).map((r) => r.id);
  test("有時刻的在前、照時刻；沒時刻的接在後照 today_position", () => {
    const rows = [
      trow({ id: "u2", today_position: 1 }),
      trow({ id: "t2", scheduled_time: "14:00" }),
      trow({ id: "u1", today_position: 0 }),
      trow({ id: "t1", scheduled_time: "09:00" }),
    ];
    assert.deepEqual(ids(rows), ["t1", "t2", "u1", "u2"]);
  });
  test("25:00 排在 23:00 之後", () => {
    assert.deepEqual(
      ids([trow({ id: "night", scheduled_time: "25:00" }), trow({ id: "eve", scheduled_time: "23:00" })]),
      ["eve", "night"],
    );
  });
  test("同時刻 ⇒ 落到 created_at", () => {
    const rows = [
      trow({ id: "b", scheduled_time: "10:00", created_at: "2026-10-02T00:00:00.000Z" }),
      trow({ id: "a", scheduled_time: "10:00", created_at: "2026-10-01T00:00:00.000Z" }),
    ];
    assert.deepEqual(ids(rows), ["a", "b"]);
  });
  test("済票留在時刻位（時刻照排，不因 done 沉底）", () => {
    const rows = [
      trow({ id: "later", scheduled_time: "15:00" }),
      trow({ id: "done", scheduled_time: "08:30", status: "done" }),
      trow({ id: "u", today_position: 0 }),
    ];
    assert.deepEqual(ids(rows), ["done", "later", "u"]);
  });
  test("定期券：覆寫後的班次時刻參與排序", () => {
    const rows = [
      trow({ id: "r", repeat_rule: RULE, scheduled_time: "07:00", time_overrides: '{"2026-10-16":"13:00"}' }),
      trow({ id: "s", scheduled_time: "09:00" }),
    ];
    assert.deepEqual(ids(rows), ["s", "r"]);
  });
  test("late／due 分區不受時刻影響（誤點區照原定日、締切區照締切日）", () => {
    const rows = [
      trow({ id: "l2", bucket: "late", scheduled_on: "2026-10-15", scheduled_time: "06:00" }),
      trow({ id: "l1", bucket: "late", scheduled_on: "2026-10-14", scheduled_time: "23:00" }),
      trow({ id: "d1", bucket: "due", scheduled_on: null, due_on: "2026-10-15", scheduled_time: "01:00" }),
      trow({ id: "t", scheduled_time: "05:00" }),
    ];
    assert.deepEqual(ids(rows), ["l1", "l2", "d1", "t"]);
  });
});

describe("buildSchedule／sortByDateThenNode（行程表同一把尺）", () => {
  const nodes = [
    node({ id: "a", scheduled_on: TODAY, scheduled_time: "14:00", created_at: "2026-10-01T00:00:01.000Z" }),
    node({ id: "b", scheduled_on: TODAY, scheduled_time: "09:00", created_at: "2026-10-01T00:00:02.000Z" }),
    node({ id: "c", scheduled_on: TODAY, scheduled_time: null, created_at: "2026-10-01T00:00:00.000Z" }),
    node({ id: "d", scheduled_on: TODAY, scheduled_time: "09:00", created_at: "2026-10-01T00:00:00.500Z" }),
  ];
  const rows = buildSchedule(nodes, {}, TODAY, TODAY, TODAY, H);
  test("entries 帶 time；有時刻的在前、同時刻落 created_at、沒時刻在最後", () => {
    assert.deepEqual(rows.map((r) => r.node_id), ["d", "b", "a", "c"]);
    assert.deepEqual(rows.map((r) => r.time), ["09:00", "09:00", "14:00", null]);
  });
  test("定期券的班次用 effectiveTime(node, 班次日)", () => {
    const rule = fixedRule("daily", "2026-10-14");
    const n = node({
      id: "r",
      kind: "ticket",
      repeat_rule: JSON.stringify(rule),
      scheduled_on: TODAY,
      scheduled_time: "07:00",
      time_overrides: '{"2026-10-16":"09:30"}',
    });
    const out = buildSchedule([n], {}, "2026-10-15", "2026-10-17", TODAY, H);
    const byDate = Object.fromEntries(out.map((e) => [e.date, e.time]));
    assert.equal(byDate["2026-10-15"], "07:00");
    assert.equal(byDate["2026-10-16"], "09:30");
    assert.equal(byDate["2026-10-17"], "07:00");
  });
});

/* ═══════════════ timeGridModel ═══════════════ */

describe("timeGridModel", () => {
  const nodes = (o: Record<string, Partial<NodeRow>>): Record<string, NodeRow> =>
    Object.fromEntries(Object.entries(o).map(([id, p]) => [id, node({ id, ...p })]));
  const run = (entries: ScheduleEntry[], ns: Record<string, NodeRow>, dayStartHour = H) =>
    timeGridModel({ days: [TODAY, addDays(TODAY, 1)], entries, dues: [], nodes: ns, dayStartHour });

  test("有時刻／無時刻分流", () => {
    const d = run([entry(TODAY, "a", "10:00"), entry(TODAY, "b", null)], nodes({ a: { estimate_min: 60 }, b: {} }))[0];
    assert.equal(d.blocks.length, 1);
    assert.equal(d.blocks[0].startMin, 600);
    assert.equal(d.blocks[0].endMin, 660);
    assert.equal(d.untimed.length, 1);
    assert.equal(d.untimed[0].entry.node_id, "b");
    assert.equal(d.untimed[0].outOfAxis, false);
  });
  test("noEstimate（null 與 0）⇒ endMin = start + 45", () => {
    const d = run([entry(TODAY, "a", "10:00"), entry(TODAY, "b", "12:00")], nodes({ a: { estimate_min: null }, b: { estimate_min: 0 } }))[0];
    for (const b of d.blocks) {
      assert.equal(b.noEstimate, true);
      assert.equal(b.endMin - b.startMin, NO_ESTIMATE_MIN);
    }
  });
  test("跨軸尾：裁切＋contToNext", () => {
    // 日界線 6 ⇒ axisMax = 1800（30:00）；29:00 開始、120 分 ⇒ 裁到 1800
    const d = run([entry(TODAY, "a", "29:00")], nodes({ a: { estimate_min: 120 } }))[0];
    assert.equal(d.blocks[0].startMin, 1740);
    assert.equal(d.blocks[0].endMin, 1800);
    assert.equal(d.blocks[0].contToNext, true);
  });
  test("剛好貼軸尾不算續", () => {
    const d = run([entry(TODAY, "a", "29:00")], nodes({ a: { estimate_min: 60 } }))[0];
    assert.equal(d.blocks[0].endMin, 1800);
    assert.equal(d.blocks[0].contToNext, false);
  });
  test("兩班重疊 ⇒ lanes = 2", () => {
    const d = run(
      [entry(TODAY, "a", "10:00"), entry(TODAY, "b", "10:30")],
      nodes({ a: { estimate_min: 60 }, b: { estimate_min: 60 } }),
    )[0];
    assert.deepEqual(d.blocks.map((b) => [b.lane, b.lanes]), [[0, 2], [1, 2]]);
  });
  test("接續不重疊 ⇒ 各自一欄", () => {
    const d = run(
      [entry(TODAY, "a", "10:00"), entry(TODAY, "b", "11:00")],
      nodes({ a: { estimate_min: 60 }, b: { estimate_min: 60 } }),
    )[0];
    assert.deepEqual(d.blocks.map((b) => [b.lane, b.lanes]), [[0, 1], [0, 1]]);
  });
  test("兩張同時刻 noEstimate ⇒ 不同 lane", () => {
    const d = run([entry(TODAY, "a", "10:00"), entry(TODAY, "b", "10:00")], nodes({ a: {}, b: {} }))[0];
    assert.deepEqual(new Set(d.blocks.map((b) => b.lane)), new Set([0, 1]));
    assert.ok(d.blocks.every((b) => b.lanes === 2));
  });
  test("太短的預計 lane 排列保底 LANE_MIN_MIN", () => {
    // a 只有 5 分，但 lane 以 15 分算；b 在 a 開始後 10 分 ⇒ 仍算重疊
    const d = run(
      [entry(TODAY, "a", "10:00"), entry(TODAY, "b", "10:10")],
      nodes({ a: { estimate_min: 5 }, b: { estimate_min: 30 } }),
    )[0];
    assert.equal(LANE_MIN_MIN, 15);
    assert.ok(d.blocks.every((b) => b.lanes === 2));
  });
  test("軸外 03:30（dayStartHour 6）⇒ untimed 標 outOfAxis，排在沒時刻的後面", () => {
    const d = run(
      [entry(TODAY, "x", "03:30"), entry(TODAY, "n", null), entry(TODAY, "y", "30:00")],
      nodes({ x: {}, n: {}, y: {} }),
    )[0];
    assert.equal(d.blocks.length, 0);
    assert.deepEqual(d.untimed.map((u) => [u.entry.node_id, u.outOfAxis]), [["n", false], ["x", true], ["y", true]]);
  });
  test("dues 依日分流；不在 days 內的 entries 丟掉", () => {
    const out = timeGridModel({
      days: [TODAY],
      entries: [entry("2026-12-31", "z", "10:00")],
      dues: [{ date: TODAY, node_id: "q" }, { date: "2026-12-31", node_id: "r" }],
      nodes: {},
      dayStartHour: H,
    });
    assert.equal(out.length, 1);
    assert.deepEqual(out[0].dues, [{ date: TODAY, node_id: "q" }]);
    assert.equal(out[0].blocks.length, 0);
  });
  test("blocks 依 startMin → key；不改輸入", () => {
    const es = [entry(TODAY, "b", "11:00"), entry(TODAY, "a", "11:00"), entry(TODAY, "c", "09:00")];
    const snap = JSON.stringify(es);
    const d = run(es, nodes({ a: {}, b: {}, c: {} }))[0];
    assert.deepEqual(d.blocks.map((b) => b.entry.node_id), ["c", "a", "b"]);
    assert.equal(JSON.stringify(es), snap);
  });
  test("hourTicks(6)：25 個、第一個 h=6、h=24 的 sub、最後 h=30", () => {
    const t = hourTicks(6);
    assert.equal(t.length, 25);
    assert.equal(t[0].h, 6);
    assert.equal(t[0].label, "06:00");
    const mid = t.find((x) => x.h === 24);
    assert.equal(mid?.sub, "深夜 0 時");
    assert.equal(mid?.night, true);
    assert.equal(t.find((x) => x.h === 25)?.sub, "1 時");
    assert.equal(t[24].h, 30);
    assert.equal(t[24].label, "30:00");
    assert.equal(t.find((x) => x.h === 23)?.night, false);
  });
});

/* ═══════════════ sql.ts escapeLike ═══════════════ */

describe("escapeLike", () => {
  test("三個萬用字元", () => {
    assert.equal(escapeLike("50%"), "50\\%");
    assert.equal(escapeLike("a_b"), "a\\_b");
    assert.equal(escapeLike("a\\b"), "a\\\\b");
    assert.equal(escapeLike("plain"), "plain");
  });
  test("反例：node:sqlite 記憶體表——跳脫後只回字面相符的一列，不跳脫會多回", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE t (name TEXT)");
    const ins = db.prepare("INSERT INTO t (name) VALUES (?)");
    for (const n of ["a%b", "axb", "c_d", "cxd", "e\\f", "exf"]) ins.run(n);
    const sel = db.prepare("SELECT name FROM t WHERE name LIKE ? ESCAPE '\\' ORDER BY name");
    const raw = db.prepare("SELECT name FROM t WHERE name LIKE ? ORDER BY name");
    assert.deepEqual(sel.all(`%${escapeLike("a%b")}%`).map((r) => r.name), ["a%b"]);
    assert.deepEqual(raw.all("%a%b%").map((r) => r.name), ["a%b", "axb"]); // 不跳脫會多回一列
    assert.deepEqual(sel.all(`%${escapeLike("c_d")}%`).map((r) => r.name), ["c_d"]);
    assert.deepEqual(sel.all(`%${escapeLike("e\\f")}%`).map((r) => r.name), ["e\\f"]);
    // 單打一個 % 或 _：只列名字真的含那個字元的
    assert.deepEqual(sel.all(`%${escapeLike("%")}%`).map((r) => r.name), ["a%b"]);
    assert.deepEqual(sel.all(`%${escapeLike("_")}%`).map((r) => r.name), ["c_d"]);
    db.close();
  });
});

/* ═══════════════ MemoryNodeRepository（與 SQLite 版同一套規則的記憶體實作） ═══════════════ */

describe("MemoryNodeRepository：時刻寫入與覆寫表", () => {
  // 週五是 TODAY；每週五的定期券（今天就是班次日）
  const weeklyFri = () => fixedRule("weekly", addDays(TODAY, -28), { byweekday: [5] });
  const mk = async (repo: MemoryNodeRepository, name = "票") =>
    repo.create({ kind: "ticket", name, parentId: null, scheduledOn: TODAY });

  test("update：scheduled_time 驗格式與範圍；沒有 dayStartHour 不走預設值", async () => {
    const repo = new MemoryNodeRepository();
    const t = await mk(repo);
    await repo.update(t.id, { scheduled_time: "25:00" }, { dayStartHour: H });
    assert.equal((await repo.getNode(t.id))?.scheduled_time, "25:00");
    await assert.rejects(repo.update(t.id, { scheduled_time: "30:00" }, { dayStartHour: H }), { message: TIME_FORMAT_MSG });
    await assert.rejects(repo.update(t.id, { scheduled_time: "9:00" }, { dayStartHour: H }), { message: TIME_FORMAT_MSG });
    await assert.rejects(repo.update(t.id, { scheduled_time: "14:00" }), { message: TIME_FORMAT_MSG }); // 沒帶 opts
    assert.equal((await repo.getNode(t.id))?.scheduled_time, "25:00"); // 失敗沒有污染
    await repo.update(t.id, { scheduled_time: null }); // 清除不需要 dayStartHour
    assert.equal((await repo.getNode(t.id))?.scheduled_time, null);
  });

  test("setRunTime：非定期券 ⇒ TIME_REPEAT_ONLY_MSG；壞日期／壞時刻 ⇒ throw", async () => {
    const repo = new MemoryNodeRepository();
    const single = await mk(repo);
    await assert.rejects(repo.setRunTime(single.id, TODAY, "09:00", H), { message: TIME_REPEAT_ONLY_MSG });
    const r = await mk(repo, "定期券");
    await repo.setRepeatRule(r.id, weeklyFri(), TODAY, H);
    await assert.rejects(repo.setRunTime(r.id, "10/16", "09:00", H));
    await assert.rejects(repo.setRunTime(r.id, TODAY, "30:00", H), { message: TIME_FORMAT_MSG });
    await assert.rejects(repo.setRunTime("nope", TODAY, "09:00", H));
  });

  test("setRunTime／clearRunTime：覆寫只蓋那一班；清空 ⇒ 欄位 null；null＝本班無時刻", async () => {
    const repo = new MemoryNodeRepository();
    const r = await mk(repo, "背單字");
    await repo.setRepeatRule(r.id, weeklyFri(), TODAY, H);
    await repo.update(r.id, { scheduled_time: "07:00" }, { dayStartHour: H });
    await repo.setRunTime(r.id, TODAY, "09:30", H);
    const n1 = (await repo.getNode(r.id)) as NodeRow;
    assert.equal(effectiveTime(n1, TODAY), "09:30");
    assert.equal(effectiveTime(n1, addDays(TODAY, 7)), "07:00");
    await repo.setRunTime(r.id, TODAY, null, H); // 本班不排時刻
    const n2 = (await repo.getNode(r.id)) as NodeRow;
    assert.equal(effectiveTime(n2, TODAY), null);
    assert.equal(isTimeOverridden(n2, TODAY), true);
    await repo.clearRunTime(r.id, TODAY);
    const n3 = (await repo.getNode(r.id)) as NodeRow;
    assert.equal(n3.time_overrides, null); // 空表不存 "{}"
    assert.equal(effectiveTime(n3, TODAY), "07:00");
    assert.equal(n3.scheduled_time, "07:00");
  });

  test("B1：沒規則的票帶殘留覆寫，update({scheduled_time}) 把覆寫清掉；有規則的票不動覆寫", async () => {
    const repo = new MemoryNodeRepository();
    const t = await mk(repo, "殘留");
    // 造出殘留：先掛規則＋設本班，再清規則的路徑會被 §0-1 第 13 條清乾淨，所以直接戳內部表模擬跨機同步灌進來的狀態
    (repo as unknown as { nodes: Map<string, NodeRow> }).nodes.set(t.id, {
      ...((await repo.getNode(t.id)) as NodeRow),
      scheduled_time: "07:00",
      time_overrides: '{"2026-10-16":"09:45"}',
    });
    assert.equal(effectiveTime((await repo.getNode(t.id)) as NodeRow, TODAY), "07:00"); // 讀端已不理殘留
    await repo.update(t.id, { name: "改名" }); // 沒碰 scheduled_time ⇒ 不動覆寫表
    assert.equal((await repo.getNode(t.id))?.time_overrides, '{"2026-10-16":"09:45"}');
    await repo.update(t.id, { scheduled_time: "08:00" }, { dayStartHour: H });
    const n = (await repo.getNode(t.id)) as NodeRow;
    assert.equal(n.scheduled_time, "08:00");
    assert.equal(n.time_overrides, null);
    // 有規則的票：寫 scheduled_time 不動覆寫
    const r = await mk(repo, "定期");
    await repo.setRepeatRule(r.id, weeklyFri(), TODAY, H);
    await repo.setRunTime(r.id, TODAY, "09:30", H);
    await repo.update(r.id, { scheduled_time: "07:00" }, { dayStartHour: H });
    const rn = (await repo.getNode(r.id)) as NodeRow;
    assert.equal(effectiveTime(rn, TODAY), "09:30");
    assert.equal(rn.time_overrides, '{"2026-10-16":"09:30"}');
  });

  test("過去班次的覆寫一律保留：誤點中、蓋済後、再寫別班都不被吃掉（D-主-32；§6.1 #10 舊規則「済後被清」廢止）", async () => {
    const repo = new MemoryNodeRepository();
    const r = await mk(repo, "跑步");
    // 每週三：最近一班在 2 天前（週三 10/14）、沒人蓋 ⇒ 誤點中
    await repo.setRepeatRule(r.id, fixedRule("weekly", addDays(TODAY, -28), { byweekday: [3] }), TODAY, H);
    const lateDay = "2026-10-14";
    assert.equal((await repo.getNode(r.id))?.scheduled_on, lateDay);
    await repo.setRunTime(r.id, lateDay, "06:45", H);
    await repo.setRunTime(r.id, "2026-10-21", "08:00", H); // 對別班寫
    let o = parseTimeOverrides((await repo.getNode(r.id))?.time_overrides);
    assert.equal(o[lateDay], "06:45"); // 誤點中的班還在
    await repo.setCompleted(r.id, true, { dateKey: TODAY, dayStartHour: H }); // 蓋済那一班
    await repo.setRunTime(r.id, "2026-10-28", "08:00", H);
    o = parseTimeOverrides((await repo.getNode(r.id))?.time_overrides);
    assert.equal(o[lateDay], "06:45"); // 已過且有結局 ⇒ 仍在（歷史不被改寫）
    assert.equal(o["2026-10-21"], "08:00");
    // 再寫別班一次，過去那天仍不動
    await repo.setRunTime(r.id, "2026-11-04", "09:00", H);
    o = parseTimeOverrides((await repo.getNode(r.id))?.time_overrides);
    assert.equal(o[lateDay], "06:45");
  });

  test("setRepeatRule：清規則 ⇒ 覆寫全清、scheduled_time 留著；換規則 ⇒ 只清班次日 ≥ 今天", async () => {
    const repo = new MemoryNodeRepository();
    const r = await mk(repo);
    await repo.setRepeatRule(r.id, fixedRule("daily", addDays(TODAY, -28)), TODAY, H);
    await repo.update(r.id, { scheduled_time: "07:00" }, { dayStartHour: H });
    await repo.setRunTime(r.id, "2026-10-10", "08:00", H); // 過去
    await repo.setRunTime(r.id, TODAY, "09:30", H); // 今天
    await repo.setRunTime(r.id, "2026-10-20", "10:00", H); // 未來
    await repo.setRepeatRule(r.id, weeklyFri(), TODAY, H); // 換規則
    let o = parseTimeOverrides((await repo.getNode(r.id))?.time_overrides);
    assert.deepEqual(o, { "2026-10-10": "08:00" });
    await repo.setRepeatRule(r.id, null, TODAY, H); // 清規則
    const n = (await repo.getNode(r.id)) as NodeRow;
    assert.equal(n.time_overrides, null);
    assert.equal(n.scheduled_time, "07:00");
    o = parseTimeOverrides(n.time_overrides);
    assert.deepEqual(o, {});
  });

  test("listToday：有時刻的在前（照時刻）、沒時刻的接在後維持手排；25:00 排最後", async () => {
    const repo = new MemoryNodeRepository();
    const mkT = (name: string) => repo.create({ kind: "ticket", name, parentId: null, scheduledOn: TODAY });
    const u1 = await mkT("無時刻甲");
    const night = await mkT("夜班");
    const u2 = await mkT("無時刻乙");
    const morning = await mkT("晨間");
    const eve = await mkT("傍晚");
    await repo.update(night.id, { scheduled_time: "25:00" }, { dayStartHour: H });
    await repo.update(morning.id, { scheduled_time: "08:30" }, { dayStartHour: H });
    await repo.update(eve.id, { scheduled_time: "18:00" }, { dayStartHour: H });
    const rows = await repo.listToday(TODAY, H);
    assert.deepEqual(rows.map((r) => r.name), ["晨間", "傍晚", "夜班", "無時刻甲", "無時刻乙"]);
    // 手排座標只含沒時刻的兩張
    assert.deepEqual(manualOrderIds(rows), [u1.id, u2.id]);
    // 手排：把乙挪到甲前面（座標 0）——有時刻的三張位置不動
    await repo.moveToday(u2.id, 0, TODAY, H);
    assert.deepEqual((await repo.listToday(TODAY, H)).map((r) => r.name), ["晨間", "傍晚", "夜班", "無時刻乙", "無時刻甲"]);
  });

  test("listCalendar：entries 帶 time，定期券用 effectiveTime", async () => {
    const repo = new MemoryNodeRepository();
    const r = await mk(repo, "日課");
    await repo.setRepeatRule(r.id, fixedRule("daily", addDays(TODAY, -5)), TODAY, H);
    await repo.update(r.id, { scheduled_time: "07:00" }, { dayStartHour: H });
    await repo.setRunTime(r.id, TODAY, "09:30", H);
    const cal = await repo.listCalendar(TODAY, addDays(TODAY, 1), { todayDateKey: TODAY, dayStartHour: H });
    const byDate = Object.fromEntries(cal.entries.filter((e) => e.node_id === r.id).map((e) => [e.date, e.time]));
    assert.equal(byDate[TODAY], "09:30");
    assert.equal(byDate[addDays(TODAY, 1)], "07:00");
  });

  test("seedDemo：今日頁有時刻的種子票排在前面，定期券有本班覆寫，夜班 25:00 最後", async () => {
    const repo = new MemoryNodeRepository();
    repo.seedDemo();
    const today = todayKey(6);
    const rows = await repo.listToday(today, 6);
    const todayRows = rows.filter((r) => r.bucket === "today");
    const times = todayRows.map((r) => timeOfRow(r));
    const firstUntimed = times.findIndex((t) => t === null);
    assert.ok(firstUntimed > 0, "有時刻的種子票應排在最前面");
    assert.ok(times.slice(0, firstUntimed).every((t) => t !== null));
    assert.ok(times.slice(firstUntimed).every((t) => t === null));
    const sorted = [...times.slice(0, firstUntimed)].sort() as string[];
    assert.deepEqual(times.slice(0, firstUntimed), sorted);
    assert.equal(times[firstUntimed - 1], "25:00"); // 夜班回報最後
    const vocab = rows.find((r) => r.name === "背 N5 單字");
    assert.ok(vocab);
    assert.equal(timeOfRow(vocab as TodayRow), "09:30");
    assert.equal(isTimeOverridden(vocab as TodayRow, vocab?.occurrence?.due_on ?? today), true);
    const jog = rows.find((r) => r.name === "跑步 3 公里");
    assert.equal(jog?.bucket, "late");
    assert.equal(jog ? timeOfRow(jog) : null, "06:30"); // 誤點區照樣印原時刻
  });
});
