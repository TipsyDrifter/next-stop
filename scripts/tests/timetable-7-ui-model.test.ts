/**
 * 時刻表⑦ UI 的純函式（整合席補）：日程的車票第二段起（`slotModel.ts`：SlotItem、lane、各段分塊）、頁首搜尋（`quickJumpModel.ts`）、
 * 作息帶的短說法（`routineModel.ts` 的 `rtShortLines`）。
 * 跑法：`node --test scripts/tests/timetable-7-ui-model.test.ts`（node 24，型別剝除預設開；零依賴）。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { schedBlocksOf, segmentSpansOf, slotItemsOf, slotKeyOf, type SlotItem } from "../../src/ui/timetable/schedule/slotModel.ts";
import { fairTake, matchByName } from "../../src/ui/timetable/quickJumpModel.ts";
import { clockInstant } from "../../src/lib/date.ts";
import { rtShortLines } from "../../src/ui/timetable/schedule/routineModel.ts";
import { compareRoutineItem } from "../../src/domain/timetableRoutine.ts";

const DAY = "2026-11-03";
const H = 6;
const hm = (s: string) => {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const plan = (id: string, s: string, e: string, extra: Partial<Any> = {}): Any => ({
  id,
  day: DAY,
  start_hm: s,
  end_hm: e,
  category_id: null,
  node_id: "n1",
  routine_id: null,
  label: null,
  account_id: null,
  device_id: null,
  created_at: "",
  updated_at: "",
  synced_at: null,
  deleted_at: null,
  ...extra,
});
const node = (id: string, extra: Partial<Any> = {}): Any => ({ id, status: "todo", deleted_at: null, ...extra });
const item = (nodeId: string, time: string | null, estimateMin: number | null, extra: Partial<Any> = {}): Any => ({
  key: `${DAY}-${nodeId}`,
  nodeId,
  date: DAY,
  kind: "single",
  time,
  overridden: false,
  estimateMin,
  done: false,
  skipped: false,
  lateFrom: null,
  carriedFrom: null,
  ...extra,
});
// timeGridModel 的 block 只用到這幾欄
const gridOf = (blocks: { key: string; nodeId: string; s: string; e: string; noEstimate?: boolean }[]): Any => ({
  blocks: blocks.map((b) => ({ key: b.key, entry: { node_id: b.nodeId }, startMin: hm(b.s), endMin: hm(b.e), noEstimate: b.noEstimate ?? false })),
});
const slotsOf = (list: SlotItem[]): Record<string, SlotItem> => Object.fromEntries(list.map((x) => [x.key, x]));

describe("slotItemsOf：time_plans 車票段 → 第二段起的卡", () => {
  test("key＝`${date}-${nodeId}-seg-${planId}`；長度＝結束−開始；作息段、刪掉的段、時刻不對的不算", () => {
    const rows = [
      plan("p1", "14:00", "15:30"),
      plan("r1", "09:00", "10:00", { node_id: null, category_id: "c" }),
      plan("p2", "16:00", "17:00", { deleted_at: "2026-11-01T00:00:00Z" }),
      plan("p3", "18:00", "18:00"),
    ];
    const out = slotItemsOf(DAY, rows, { n1: node("n1") }, {});
    assert.deepEqual(Object.keys(out), [slotKeyOf(DAY, "n1", "p1")]);
    assert.equal(slotKeyOf(DAY, "n1", "p1"), `${DAY}-n1-seg-p1`);
    const it = out[`${DAY}-n1-seg-p1`];
    assert.equal(it.time, "14:00");
    assert.equal(it.end, "15:30");
    assert.equal(it.estimateMin, 90);
    assert.equal(it.planId, "p1");
    assert.equal(it.kind, "single");
  });

  test("票刪了或不在 nodes ⇒ 不畫；蓋済跟第一段（沒有第一段就看節點狀態）", () => {
    const rows = [plan("p1", "14:00", "15:00"), plan("p2", "14:00", "15:00", { node_id: "gone" }), plan("p3", "14:00", "15:00", { node_id: "del" })];
    const nodes = { n1: node("n1"), del: node("del", { deleted_at: "x" }) };
    assert.deepEqual(Object.keys(slotItemsOf(DAY, rows, nodes, {})), [`${DAY}-n1-seg-p1`]);
    assert.equal(slotItemsOf(DAY, rows, nodes, { [`${DAY}-n1`]: item("n1", "09:00", 60, { done: true }) })[`${DAY}-n1-seg-p1`].done, true);
    assert.equal(slotItemsOf(DAY, rows, { n1: node("n1", { status: "done" }) }, {})[`${DAY}-n1-seg-p1`].done, true);
    assert.equal(slotItemsOf(DAY, rows, { n1: node("n1") }, {})[`${DAY}-n1-seg-p1`].done, false);
  });
});

describe("schedBlocksOf：第一段＋第二段起同一套 lane", () => {
  const seg = (planId: string, s: string, e: string, nodeId = "n1") => slotItemsOf(DAY, [plan(planId, s, e, { node_id: nodeId })], { [nodeId]: node(nodeId) }, {});

  test("第二段跟別張票的第一段重疊 ⇒ 同一個 cluster 兩條 lane；後面不重疊的另起、lanes 1", () => {
    const grid = gridOf([{ key: `${DAY}-n2`, nodeId: "n2", s: "09:00", e: "10:00" }]);
    const slots = { ...seg("p1", "09:30", "10:30"), ...seg("p2", "14:00", "15:00") };
    const out = schedBlocksOf(grid, slots, H);
    assert.deepEqual(
      out.map((b) => [b.key, b.slotId, b.startMin, b.endMin, b.lane, b.lanes]),
      [
        [`${DAY}-n2`, null, hm("09:00"), hm("10:00"), 0, 2],
        [`${DAY}-n1-seg-p1`, "p1", hm("09:30"), hm("10:30"), 1, 2],
        [`${DAY}-n1-seg-p2`, "p2", hm("14:00"), hm("15:00"), 0, 1],
      ],
    );
  });

  test("短段的 lane 長度保底 15 分：11:00–11:05 與 11:10 起的段擠同一個 cluster", () => {
    const slots = { ...seg("a", "11:00", "11:05"), ...seg("b", "11:10", "12:00", "n2") };
    const out = schedBlocksOf(null, slots, H);
    assert.deepEqual(
      out.map((b) => [b.slotId, b.lane, b.lanes, b.endMin - b.startMin]),
      [
        ["a", 0, 2, 5],
        ["b", 1, 2, 50],
      ],
    );
  });

  test("軸外（日界線前）的段不畫；畫的段尾夾在軸尾（25:xx 以後切掉）", () => {
    const slots = { ...seg("early", "05:00", "05:30"), ...seg("late", "29:30", "31:00") };
    const out = schedBlocksOf(null, slots, H);
    assert.deepEqual(out.map((b) => [b.slotId, b.startMin, b.endMin]), [["late", hm("29:30"), H * 60 + 1440]]);
  });

  test("同一張票第一段與第二段重疊也分兩條 lane（各自一張卡、key 不同）", () => {
    const grid = gridOf([{ key: `${DAY}-n1`, nodeId: "n1", s: "13:00", e: "14:30" }]);
    const out = schedBlocksOf(grid, seg("p1", "14:00", "15:00"), H);
    assert.deepEqual(out.map((b) => [b.key, b.lane, b.lanes]), [
      [`${DAY}-n1`, 0, 2],
      [`${DAY}-n1-seg-p1`, 1, 2],
    ]);
  });
});

describe("segmentSpansOf：一張票有好幾段 ⇒ 塊分給各段", () => {
  const at = (t: string) => clockInstant(DAY, t) as number;
  const span = (id: string, s: string, e: string | null, nodeId: string | null = "n1") => ({
    id,
    categoryId: "c",
    start: at(s),
    end: e === null ? null : at(e),
    ack: true,
    nodeId,
    pending: false,
  });

  test("早上那塊給第一段、下午那塊給第二段；別張票的塊不算", () => {
    const main = item("n1", "09:00", 60);
    const s2 = slotItemsOf(DAY, [plan("p1", "14:00", "15:00")], { n1: node("n1") }, {});
    const spans = [span("b1", "09:05", "09:50"), span("b2", "14:10", "14:40"), span("x", "14:00", "15:00", "n2")];
    const out = segmentSpansOf([main], Object.values(s2), spans, at("20:00"));
    assert.deepEqual(out.get(main.key)?.map((s) => s.id), ["b1"]);
    assert.deepEqual(out.get(`${DAY}-n1-seg-p1`)?.map((s) => s.id), ["b2"]);
  });

  test("只有一段的票不在表裡（照舊吃整天的塊）；沒時刻、誤點、運休的第一段不算一段", () => {
    const s2 = Object.values(slotItemsOf(DAY, [plan("p1", "14:00", "15:00")], { n1: node("n1") }, {}));
    const spans = [span("b1", "09:05", "09:50")];
    assert.equal(segmentSpansOf([item("n2", "09:00", 60)], [], spans, at("20:00")).size, 0);
    for (const first of [item("n1", null, 60), item("n1", "09:00", 60, { lateFrom: "2026-11-01" }), item("n1", "09:00", 60, { skipped: true })]) {
      assert.equal(segmentSpansOf([first], s2, spans, at("20:00")).size, 0);
    }
  });

  test("第一段沒填預計 ⇒ 用 45 分當它的長度；運行中的塊算到 now", () => {
    const main = item("n1", "09:00", null);
    const s2 = Object.values(slotItemsOf(DAY, [plan("p1", "10:00", "11:00")], { n1: node("n1") }, {}));
    // 09:40 起跑到 now 10:30：跟第一段（09:00–09:45）重疊 5 分、跟第二段重疊 30 分 ⇒ 第二段
    const out = segmentSpansOf([main], s2, [span("run", "09:40", null)], at("10:30"));
    assert.deepEqual(out.get(main.key), []);
    assert.deepEqual(out.get(`${DAY}-n1-seg-p1`)?.map((s) => s.id), ["run"]);
  });
});

describe("頁首搜尋（@）", () => {
  const rows = [{ name: "讀書" }, { name: "閱讀" }, { name: "Reading" }, { name: "寫作" }];

  test("matchByName：開頭對到的排前面、其餘照原順序；不分大小寫與全半形；空字＝全部", () => {
    assert.deepEqual(matchByName(rows, "讀").map((r) => r.name), ["讀書", "閱讀"]);
    assert.deepEqual(matchByName(rows, "ｒｅａｄ").map((r) => r.name), ["Reading"]);
    assert.deepEqual(matchByName(rows, "  ").map((r) => r.name), ["讀書", "閱讀", "Reading", "寫作"]);
    assert.deepEqual(matchByName(rows, "沒有"), []);
  });

  test("fairTake：每種先各一格、剩下照順序補；輸出照種類排；limit 0＝空", () => {
    const cats = ["c1", "c2", "c3", "c4", "c5"];
    const routines = ["r1"];
    const blocks = ["b1", "b2"];
    assert.deepEqual(fairTake([cats, routines, blocks], 4), ["c1", "c2", "r1", "b1"]);
    assert.deepEqual(fairTake([[], routines, blocks], 4), ["r1", "b1", "b2"]);
    assert.deepEqual(fairTake([cats, [], blocks], 2), ["c1", "b1"]);
    assert.deepEqual(fairTake([cats, routines, blocks], 2), ["c1", "r1"], "格子比種類少：前面的種類先拿");
    assert.deepEqual(fairTake([cats, routines, blocks], 0), []);
    assert.deepEqual(fairTake([cats, routines, blocks], 20), [...cats, ...routines, ...blocks]);
  });
});

describe("作息帶的短說法（rtShortLines）", () => {
  test("沙盒 O-2：段還沒結束只寫開始（「準點」），結束後才接「少 1h10m」；桌機、手機同一條規則", () => {
    const night = { cat: "c", s: "23:00", e: "25:00" };
    const blk = [{ id: "b", categoryId: "c", start: clockInstant(DAY, "23:10")!, end: clockInstant(DAY, "24:00")!, ack: false }];
    const mid = compareRoutineItem(DAY, night, blk, clockInstant(DAY, "24:00")! + 29_000);
    assert.deepEqual(rtShortLines(mid, true).map((x) => x.t), ["準點"]);
    assert.deepEqual(rtShortLines(mid, false).map((x) => x.t), ["準點"]);
    const done = compareRoutineItem(DAY, night, blk, clockInstant(DAY, "25:00")!);
    assert.deepEqual(rtShortLines(done, true).map((x) => x.t), ["準點", "少 1h10m"]);
    assert.deepEqual(rtShortLines(done, false).map((x) => x.t), ["準點", "少 1h10m"]);
  });
});
