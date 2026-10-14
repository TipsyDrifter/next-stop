// 主線車次①「行程表」・串流純函式單元測試（契約 §6.3）
// 跑法：node --test scripts/tests/stream-model.test.ts（node 24 直接剝除型別；不進 tsc——tsconfig 只 include src）
// streamModel.ts 只 import type ＋ lib/date.ts，所以不需要 resolve hook（同 notes-logic.test.ts）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  INITIAL_AFTER,
  INITIAL_BEFORE,
  MAX_SPAN_DAYS,
  STEP_DAYS,
  canLoadNewer,
  canLoadOlder,
  ensureWindow,
  extendWindow,
  initialWindow,
  lateSummary,
  mdw,
  nextMonday,
  sectionOf,
  sheetDeferItems,
  streamModel,
  type LateRowSeed,
  type ScheduleBounds,
  type StreamInput,
  type StreamSection,
} from "../../src/ui/schedule/streamModel.ts";
import type { DueEntry, ScheduleEntry } from "../../src/data/nodeRepository.ts";
import { addDays } from "../../src/lib/date.ts";

const TODAY = "2026-10-12"; // 週一

const entry = (date: string, node_id = `n-${date}`): ScheduleEntry => ({
  date,
  node_id,
  kind: "single",
  occurrence_status: null,
  is_late: date < TODAY,
  is_done: false,
  is_assumed: false,
});
const due = (date: string, node_id = `d-${date}`): DueEntry => ({ date, node_id });

const input = (o: Partial<StreamInput> = {}): StreamInput => ({
  entries: [],
  dues: [],
  from: "2026-10-09",
  to: "2026-11-02",
  today: TODAY,
  bounds: null,
  expanded: new Set<string>(),
  ...o,
});
const kinds = (s: readonly StreamSection[]) => s.map((x) => x.kind);
const keys = (s: readonly StreamSection[]) => s.map((x) => x.key);
const dayAt = (s: readonly StreamSection[], date: string) => {
  const hit = s.find((x) => x.kind === "day" && x.date === date);
  assert.ok(hit && hit.kind === "day", `沒有 ${date} 的 day 段`);
  return hit;
};
const B = (o: Partial<ScheduleBounds> = {}): ScheduleBounds => ({ earliest: null, latest: null, openEndedRepeat: false, ...o });

/* ═══ streamModel ═══ */

test("streamModel：空輸入＋bounds=null ⇒ 只有 day 與 gap、沒有 edge；今天恆為 day 段", () => {
  const s = streamModel(input());
  assert.ok(!s.some((x) => x.kind === "edge"));
  // 10/9–10/11 三天空白 ⇒ gap；今天 day；10/13–11/2 ⇒ gap
  assert.deepEqual(kinds(s), ["gap", "day", "gap"]);
  const today = dayAt(s, TODAY);
  assert.equal(today.rel, "today");
  assert.equal(today.empty, true);
  assert.equal(today.inRun, false);
});

test("streamModel：單一空白日＝day 段 empty（不壓成 gap）", () => {
  const s = streamModel(input({ from: "2026-10-11", to: "2026-10-13", entries: [entry("2026-10-13")] }));
  assert.deepEqual(kinds(s), ["day", "day", "day"]);
  const blank = dayAt(s, "2026-10-11");
  assert.equal(blank.empty, true);
  assert.equal(blank.past, true);
  assert.equal(dayAt(s, "2026-10-13").empty, false);
});

test("streamModel：兩天空白＝gap count 2；三天空白＝gap count 3；過去／未來的 past 旗標", () => {
  const s = streamModel(input({ from: "2026-10-10", to: "2026-10-15" }));
  // 10/10–10/11 gap(2) ・ 今天 ・ 10/13–10/15 gap(3)
  assert.deepEqual(kinds(s), ["gap", "day", "gap"]);
  const g1 = s[0];
  const g2 = s[2];
  assert.ok(g1.kind === "gap" && g2.kind === "gap");
  assert.deepEqual([g1.from, g1.to, g1.count, g1.past, g1.open], ["2026-10-10", "2026-10-11", 2, true, false]);
  assert.deepEqual([g2.from, g2.to, g2.count, g2.past, g2.open], ["2026-10-13", "2026-10-15", 3, false, false]);
  assert.equal(g1.key, "g:2026-10-10");
});

test("streamModel：gap 被 expanded 一天就整段 open，其後逐日輸出 inRun 空段", () => {
  const s = streamModel(input({ from: "2026-10-12", to: "2026-10-16", expanded: new Set(["2026-10-15"]) }));
  assert.deepEqual(kinds(s), ["day", "gap", "day", "day", "day", "day"]);
  const g = s[1];
  assert.ok(g.kind === "gap" && g.open === true);
  const run = s.slice(2);
  assert.deepEqual(
    run.map((x) => x.kind === "day" && [x.date, x.inRun, x.empty]),
    [
      ["2026-10-13", true, true],
      ["2026-10-14", true, true],
      ["2026-10-15", true, true],
      ["2026-10-16", true, true],
    ],
  );
});

test("streamModel：有 dues 沒 entries 的日子不是空白；視窗外的資料忽略", () => {
  const s = streamModel(
    input({
      from: "2026-10-12",
      to: "2026-10-15",
      dues: [due("2026-10-14"), due("2026-10-20")],
      entries: [entry("2026-10-08")],
    }),
  );
  // 今天 ・ 10/13 單日空白 ・ 10/14（締切）・ 10/15 單日空白
  assert.deepEqual(kinds(s), ["day", "day", "day", "day"]);
  const d14 = dayAt(s, "2026-10-14");
  assert.equal(d14.empty, false);
  assert.equal(d14.dues.length, 1);
  assert.equal(d14.rows.length, 0);
});

test("streamModel：before 邊界吃掉開頭的連續空白日（from <= earliest）", () => {
  const s = streamModel(
    input({
      from: "2026-10-05",
      to: "2026-10-13",
      entries: [entry("2026-10-09")],
      bounds: B({ earliest: "2026-10-09", latest: "2026-12-01" }),
    }),
  );
  assert.equal(s[0].kind, "edge");
  const e = s[0];
  assert.ok(e.kind === "edge");
  assert.deepEqual([e.side, e.from, e.to, e.open, e.key], ["before", "2026-10-05", "2026-10-08", false, "e:before"]);
  // 10/9 有票 ・ 10/10–10/11 gap ・ 今天 ・ 10/13 單日
  assert.deepEqual(kinds(s), ["edge", "day", "gap", "day", "day"]);
  assert.ok(!s.some((x) => x.kind === "edge" && x.side === "after"), "to < latest ⇒ 沒有 after 邊界");
});

test("streamModel：before 邊界 0 天（視窗第一天就有票）⇒ from=from、to=from−1", () => {
  const s = streamModel(
    input({ from: "2026-10-09", to: "2026-10-13", entries: [entry("2026-10-09")], bounds: B({ earliest: "2026-10-09", latest: "2026-12-01" }) }),
  );
  const e = s[0];
  assert.ok(e.kind === "edge" && e.side === "before");
  assert.deepEqual([e.from, e.to], ["2026-10-09", "2026-10-08"]);
  assert.equal(s[1].kind, "day");
});

test("streamModel：earliest===null（空庫）⇒ before 邊界＋今日段＋after 邊界，三段", () => {
  const s = streamModel(input({ bounds: B() }));
  assert.deepEqual(keys(s), ["e:before", `d:${TODAY}`, "e:after"]);
  const before = s[0];
  const after = s[2];
  assert.ok(before.kind === "edge" && after.kind === "edge");
  assert.deepEqual([before.from, before.to], ["2026-10-09", "2026-10-11"]);
  assert.deepEqual([after.from, after.to, after.open], ["2026-10-13", "2026-11-02", false]);
});

test("streamModel：openEndedRepeat ⇒ 沒有 after 邊界（尾端照常壓 gap）", () => {
  const s = streamModel(input({ bounds: B({ earliest: "2026-10-01", latest: "2026-10-12", openEndedRepeat: true }) }));
  assert.ok(!s.some((x) => x.kind === "edge" && x.side === "after"));
  assert.equal(s[s.length - 1].kind, "gap");
});

test("streamModel：after 邊界 open 時其後逐日輸出 inRun 段；0 天時 from=to+1", () => {
  const s = streamModel(
    input({
      from: "2026-10-12",
      to: "2026-10-15",
      entries: [entry("2026-10-13")],
      bounds: B({ earliest: "2026-10-13", latest: "2026-10-13" }),
      expanded: new Set(["2026-10-14"]),
    }),
  );
  // before(0 天：from=10/12 <= earliest) ・ 今天 ・ 10/13 ・ after(10/14–10/15, open) ・ 10/14 ・ 10/15
  assert.deepEqual(keys(s), ["e:before", `d:${TODAY}`, "d:2026-10-13", "e:after", "d:2026-10-14", "d:2026-10-15"]);
  const b0 = s[0];
  assert.ok(b0.kind === "edge" && b0.from === "2026-10-12" && b0.to === "2026-10-11");
  const e = s[3];
  assert.ok(e.kind === "edge" && e.open === true);
  assert.ok(s.slice(4).every((x) => x.kind === "day" && x.inRun && x.empty));

  const z = streamModel(
    input({ from: "2026-10-12", to: "2026-10-13", entries: [entry("2026-10-13")], bounds: B({ earliest: "2026-10-13", latest: "2026-10-13" }) }),
  );
  const ez = z[z.length - 1];
  assert.ok(ez.kind === "edge" && ez.side === "after");
  assert.deepEqual([ez.from, ez.to], ["2026-10-14", "2026-10-13"]);
});

test("streamModel：段 key 穩定（兩次呼叫相同）；rel today／tomorrow；entries 順序照輸入", () => {
  const es = [entry("2026-10-13", "b"), entry("2026-10-13", "a"), entry("2026-10-12", "c")];
  const a = streamModel(input({ entries: es }));
  const b = streamModel(input({ entries: es }));
  assert.deepEqual(keys(a), keys(b));
  assert.equal(dayAt(a, TODAY).rel, "today");
  assert.equal(dayAt(a, "2026-10-13").rel, "tomorrow");
  assert.deepEqual(
    dayAt(a, "2026-10-13").rows.map((r) => r.entry.node_id),
    ["b", "a"],
  );
  assert.equal(dayAt(a, "2026-10-13").rows[0].time, undefined);
});

test("streamModel：不改輸入；to < from ⇒ 空陣列", () => {
  const es = [entry("2026-10-13"), entry("2026-10-20")];
  const ds = [due("2026-10-15")];
  const ex = new Set(["2026-10-16"]);
  const snapshot = JSON.stringify({ es, ds, ex: [...ex] });
  streamModel(input({ entries: es, dues: ds, expanded: ex }));
  assert.equal(JSON.stringify({ es, ds, ex: [...ex] }), snapshot);
  assert.deepEqual(streamModel(input({ from: "2026-10-13", to: "2026-10-12" })), []);
});

/* ═══ 視窗 ═══ */

test("initialWindow：[today−3, today+21]", () => {
  assert.deepEqual(initialWindow(TODAY), { from: "2026-10-09", to: "2026-11-02" });
  assert.equal(INITIAL_BEFORE, 3);
  assert.equal(INITIAL_AFTER, 21);
});

test("extendWindow：older／newer 各補 14 天", () => {
  const w = initialWindow(TODAY);
  assert.deepEqual(extendWindow(w, "older"), { from: addDays(w.from, -STEP_DAYS), to: w.to });
  assert.deepEqual(extendWindow(w, "newer"), { from: w.from, to: addDays(w.to, STEP_DAYS) });
  assert.equal(STEP_DAYS, 14);
});

test("extendWindow：超過 365 天從另一端收掉（整段寬度恆 ≤ 365）", () => {
  // 剛好 365 天的視窗
  const w = { from: "2026-01-01", to: addDays("2026-01-01", MAX_SPAN_DAYS - 1) };
  const older = extendWindow(w, "older");
  assert.equal(older.from, addDays(w.from, -14));
  assert.equal(older.to, addDays(older.from, MAX_SPAN_DAYS - 1));
  const newer = extendWindow(w, "newer");
  assert.equal(newer.to, addDays(w.to, 14));
  assert.equal(newer.from, addDays(newer.to, -(MAX_SPAN_DAYS - 1)));
  assert.equal(MAX_SPAN_DAYS, 365);
});

test("ensureWindow：在內不變（同一個物件）、在外擴、遠到放不下時以 from 為錨重開", () => {
  const w = initialWindow(TODAY);
  assert.equal(ensureWindow(w, "2026-10-15", "2026-10-20"), w);
  assert.deepEqual(ensureWindow(w, "2026-10-01", "2026-10-05"), { from: "2026-10-01", to: w.to });
  assert.deepEqual(ensureWindow(w, "2026-11-10", "2026-11-30"), { from: w.from, to: "2026-11-30" });
  // 兩年後：擴不進 365 ⇒ [from−3, from+21]
  const far = ensureWindow(w, "2028-10-12", "2028-10-12");
  assert.deepEqual(far, { from: "2028-10-09", to: "2028-11-02" });
  // 目標區間本身很長：to 保留、再夾上限
  const long = ensureWindow(w, "2028-01-01", "2029-06-01");
  assert.equal(long.from, "2027-12-29");
  assert.equal(long.to, addDays("2027-12-29", MAX_SPAN_DAYS - 1));
});

test("canLoadOlder／canLoadNewer：隨邊界變；open 的 after 邊界不擋補載", () => {
  const none = streamModel(input());
  assert.equal(canLoadOlder(none), true);
  assert.equal(canLoadNewer(none), true);
  const both = streamModel(input({ bounds: B() }));
  assert.equal(canLoadOlder(both), false);
  assert.equal(canLoadNewer(both), false);
  const openEnded = streamModel(input({ bounds: B({ earliest: "2026-10-01", latest: "2026-10-12", openEndedRepeat: true }) }));
  assert.equal(canLoadNewer(openEnded), true);
  const afterOpen = streamModel(input({ bounds: B(), expanded: new Set(["2026-10-20"]) }));
  assert.equal(canLoadNewer(afterOpen), true);
});

test("sectionOf：在 day／在收著的 gap／在 after 邊界／不在視窗", () => {
  const s = streamModel(input({ from: "2026-10-05", to: "2026-10-20", entries: [entry("2026-10-09")], bounds: B({ earliest: "2026-10-09", latest: "2026-10-12" }) }));
  const d = sectionOf(s, "2026-10-09");
  assert.ok(d && d.kind === "day" && d.date === "2026-10-09");
  const g = sectionOf(s, "2026-10-11");
  assert.ok(g && g.kind === "gap" && g.from === "2026-10-10" && g.to === "2026-10-11");
  const a = sectionOf(s, "2026-10-18");
  assert.ok(a && a.kind === "edge" && a.side === "after");
  const b = sectionOf(s, "2026-10-06");
  assert.ok(b && b.kind === "edge" && b.side === "before");
  assert.equal(sectionOf(s, "2026-12-01"), null);
});

test("sectionOf：攤開的 gap 裡的日子回 day 段（不是 gap）", () => {
  const s = streamModel(input({ from: "2026-10-12", to: "2026-10-16", expanded: new Set(["2026-10-14"]) }));
  const d = sectionOf(s, "2026-10-14");
  assert.ok(d && d.kind === "day" && d.inRun);
});

/* ═══ 日期文案 ═══ */

test("nextMonday：週一→下週一（七天後）、週日→隔天、週三→五天後", () => {
  assert.equal(nextMonday("2026-10-12"), "2026-10-19"); // 週一
  assert.equal(nextMonday("2026-10-11"), "2026-10-12"); // 週日
  assert.equal(nextMonday("2026-10-14"), "2026-10-19"); // 週三
});

test("mdw：「M/D（週X）」不補零", () => {
  assert.equal(mdw("2026-10-12"), "10/12（週一）");
  assert.equal(mdw("2026-01-04"), "1/4（週日）");
});

test("sheetDeferItems：未來票「往後推一天」＝railDate+1、monday 以 railDate 為準", () => {
  const r = sheetDeferItems("2026-10-20", "2026-10-20", TODAY);
  assert.deepEqual(r.first, { label: "往後推一天", day: "2026-10-21" });
  assert.equal(r.monday, "2026-10-26");
});

test("sheetDeferItems：過去票「推遲到明天」＝today+1；今天的票也是；monday 以 today 為準", () => {
  const past = sheetDeferItems("2026-10-03", "2026-10-03", TODAY);
  assert.deepEqual(past.first, { label: "推遲到明天", day: "2026-10-13" });
  assert.equal(past.monday, "2026-10-19");
  const cur = sheetDeferItems(TODAY, TODAY, TODAY);
  assert.deepEqual(cur.first, { label: "推遲到明天", day: "2026-10-13" });
});

test("sheetDeferItems：無執行日「排到明天」＝today+1（締切浮出來的票）", () => {
  const r = sheetDeferItems("2026-10-10", null, TODAY);
  assert.deepEqual(r.first, { label: "排到明天", day: "2026-10-13" });
  assert.equal(r.monday, "2026-10-19");
  assert.deepEqual(sheetDeferItems(null, null, TODAY).first, { label: "排到明天", day: "2026-10-13" });
});

/* ═══ 誤點列（P8） ═══ */

const seed = (o: Partial<LateRowSeed>): LateRowSeed => ({
  bucket: "late",
  status: "todo",
  scheduled_on: "2026-10-08",
  due_on: null,
  occurrence: null,
  ...o,
});

test("lateSummary：只算 late＋due，today 分區不算", () => {
  const r = lateSummary(
    [seed({}), seed({ bucket: "due", scheduled_on: null, due_on: "2026-10-10" }), seed({ bucket: "today", scheduled_on: TODAY })],
    TODAY,
  );
  assert.deepEqual(r, { count: 2, earliest: "2026-10-08" });
});

test("lateSummary：排除已交代（済、運休、節點 done）", () => {
  const r = lateSummary(
    [
      seed({ status: "done" }),
      seed({ occurrence: { status: "done", due_on: "2026-10-05" }, scheduled_on: "2026-10-13" }),
      seed({ occurrence: { status: "skipped", due_on: "2026-10-06" }, scheduled_on: "2026-10-13" }),
      seed({ scheduled_on: "2026-10-09" }),
    ],
    TODAY,
  );
  assert.deepEqual(r, { count: 1, earliest: "2026-10-09" });
});

test("lateSummary：earliest 取 late 的 scheduled_on 與 due 的 due_on 之最小；空陣列 ⇒ {0, null}", () => {
  const r = lateSummary(
    [seed({ scheduled_on: "2026-10-09" }), seed({ bucket: "due", scheduled_on: null, due_on: "2026-10-02" })],
    TODAY,
  );
  assert.deepEqual(r, { count: 2, earliest: "2026-10-02" });
  assert.deepEqual(lateSummary([], TODAY), { count: 0, earliest: null });
});
