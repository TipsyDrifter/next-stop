/**
 * 時刻表線⑥「荷札接軌」純函式測試（⑥ 契約 §4；甲席 Stage 0）。
 * 跑法：`node --test scripts/tests/timetable-tags.test.ts`（node 24，型別剝除預設開；零依賴）。
 *
 * 契約 §4 的 1～9 各一個 describe（編號對得上）；第 6 項含 `planMerge` 的 `absorbedInto`（甲席資料加的欄）。
 * repository 層的搬荷札與目標荷札在 `timetable-tag-carry.test.ts`。
 * 時區：測資一律用 `new Date(y, m-1, d, h, mi).getTime()` 造本地時刻（同 timetable-stats.test.ts）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MIN,
  planMerge,
  planReconcile,
  planSplitMulti,
  type KeyedSpan,
  type TimeCategoryRow,
  type TimeGoalRow,
} from "../../src/domain/timetable.ts";
import {
  ROUTE_NONE,
  buildGoals,
  buildStats,
  classifySpans,
  goalMember,
  goalProgress,
  goalProgressIn,
  goalScopeJson,
  goalScopeNext,
  goalScopeVersion,
  normalizeGoalInput,
  parseGoal,
  periodWindow,
  trendKeys,
  windowTotals,
  type Goal,
  type GoalInput,
  type StatsSpan,
} from "../../src/domain/timetableStats.ts";
import {
  EMPTY_TAG_MAPS,
  TT_TAG_BLOCK,
  TT_TAG_BLOCK_OFF,
  TT_TAG_CATEGORY,
  TT_TAG_GOAL,
  blockTags,
  carryPairs,
  catDefaults,
  defaultsAfterOff,
  isBlockOff,
  tagMapsOf,
  tagShareRows,
  underKey,
  type TimetableTagMaps,
} from "../../src/domain/timetableTags.ts";
import { carryPairsOfPlan } from "../../src/data/timetableTagCarry.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");

/* ───────── 測試用小工具 ───────── */

/** 本地 (月, 日, 時, 分)；2026 年 */
const L = (m: number, d: number, h = 0, mi = 0): number => new Date(2026, m - 1, d, h, mi).getTime();
const H = 60 * MIN;

const cat = (id: string, parent: string | null, name: string, extra: Partial<TimeCategoryRow> = {}): TimeCategoryRow => ({
  id,
  parent_id: parent,
  name,
  glyph: null,
  color_idx: 1,
  position: 0,
  default_min: null,
  archived_at: null,
  account_id: null,
  device_id: null,
  created_at: "2026-10-01T00:00:00.000Z",
  updated_at: "2026-10-01T00:00:00.000Z",
  synced_at: null,
  deleted_at: null,
  ...extra,
});
/** 本務（G1）：創作 c1、學習 c2；休閒（G2）：娛樂 c3（封存）；孤兒 c9（組 Gx 不在清單裡） */
const CATS: TimeCategoryRow[] = [
  cat("G1", null, "本務"),
  cat("G2", null, "休閒"),
  cat("c1", "G1", "創作"),
  cat("c2", "G1", "學習"),
  cat("c3", "G2", "娛樂", { archived_at: "2026-10-10T00:00:00.000Z" }),
  cat("c9", "Gx", "孤兒"),
];

/** index.ents 的形狀（tagStore.index.ents） */
const ENTS = [
  { type: TT_TAG_CATEGORY, id: "G1", keys: ["高效"] },
  { type: TT_TAG_CATEGORY, id: "c1", keys: ["創作/寫", "高效"] }, // 「高效」組也帶 ⇒ fromGroup 不重複列
  { type: TT_TAG_CATEGORY, id: "c3", keys: ["拖延"] },
  { type: TT_TAG_CATEGORY, id: "Gx", keys: ["幽靈"] },
  { type: TT_TAG_CATEGORY, id: "c9", keys: ["孤"] },
  { type: TT_TAG_BLOCK, id: "b-commute", keys: ["podcast"] },
  { type: TT_TAG_BLOCK, id: "b-fun", keys: ["拖延"] }, // 分類已帶的又手動掛（D-時-127：資料照掛、blockTags 去重）
  { type: TT_TAG_GOAL, id: "g-night", keys: ["高效"] },
  { type: "node", id: "n1", keys: ["高效"] }, // 別線的略過
  { type: "note", id: "x1", keys: ["拖延"] },
];
const M: TimetableTagMaps = tagMapsOf(ENTS);

const sp = (id: string, catId: string, start: number, end: number | null, o: Partial<StatsSpan> = {}): StatsSpan => ({
  id,
  categoryId: catId,
  start,
  end,
  ack: false,
  estimateMin: null,
  nodeId: null,
  routeId: null,
  tagKeys: [],
  ...o,
});
/** 照 0-9 的規則把 tagKeys 填好（store 之後就是這樣做） */
const withTags = (s: StatsSpan, m: TimetableTagMaps = M): StatsSpan => ({ ...s, tagKeys: blockTags(s, CATS, m) });

const noTh = (): number | null => null;
const noRoute = (): string => ROUTE_NONE;

const goalRow = (o: Partial<TimeGoalRow> = {}): TimeGoalRow => ({
  id: "g-night",
  name: "夜行列車",
  scope: JSON.stringify({ categories: ["G1"] }),
  period: "since",
  target_min: 180 * 60,
  direction: "atLeast",
  start_on: "2026-10-01",
  end_on: null,
  position: 0,
  archived_at: null,
  account_id: null,
  device_id: null,
  created_at: "2026-10-01T00:00:00.000Z",
  updated_at: "2026-10-01T00:00:00.000Z",
  synced_at: null,
  deleted_at: null,
  ...o,
});

/* ───────── 0. 三張對照 ───────── */

describe("0. tagMapsOf", () => {
  test("只收時刻表的三種 type；別線（node／note）略過；keys 去重", () => {
    assert.deepEqual(Object.keys(M.category).sort(), ["G1", "Gx", "c1", "c3", "c9"]);
    assert.deepEqual(M.block, { "b-commute": ["podcast"], "b-fun": ["拖延"] });
    assert.deepEqual(M.goal, { "g-night": ["高效"] });
    const dup = tagMapsOf([
      { type: TT_TAG_BLOCK, id: "b", keys: ["a", "a"] },
      { type: TT_TAG_BLOCK, id: "b", keys: ["c", "a"] },
      { type: TT_TAG_BLOCK, id: "e", keys: [] },
    ]);
    assert.deepEqual(dup.block, { b: ["a", "c"] }, "同一實體兩次＝併起來；沒有 key 的不建");
  });
  test("沙盒 F2：keys 一律升冪，跟 index 的到達順序無關（兩台的範圍字才一致）", () => {
    const a = tagMapsOf([{ type: TT_TAG_GOAL, id: "g", keys: ["效率", "podcast"] }]);
    const b = tagMapsOf([{ type: TT_TAG_GOAL, id: "g", keys: ["podcast", "效率"] }]);
    assert.deepEqual(a.goal.g, b.goal.g);
    assert.deepEqual(a.goal.g, ["podcast", "效率"]);
  });
  test("常數字面值（taggings.entity_type；永不改）", () => {
    assert.equal(TT_TAG_BLOCK, "timetable:block");
    assert.equal(TT_TAG_CATEGORY, "timetable:category");
    assert.equal(TT_TAG_GOAL, "timetable:goal");
  });
});

/* ───────── 1. catDefaults ───────── */

describe("1. catDefaults（D-時-111：組往下傳）", () => {
  test("子分類＝自己的＋組的（組的扣掉自己已有的）；升冪", () => {
    assert.deepEqual(catDefaults("c1", CATS, M), { own: ["創作/寫", "高效"], fromGroup: [] });
    assert.deepEqual(catDefaults("c2", CATS, M), { own: [], fromGroup: ["高效"] });
  });
  test("組本身只有自己的", () => {
    assert.deepEqual(catDefaults("G1", CATS, M), { own: ["高效"], fromGroup: [] });
    assert.deepEqual(catDefaults("G2", CATS, M), { own: [], fromGroup: [] });
  });
  test("找不到組 ⇒ 只算自己（就算那個組 id 在 taggings 裡有荷札）；找不到分類 ⇒ 只看 taggings 自己的", () => {
    assert.deepEqual(catDefaults("c9", CATS, M), { own: ["孤"], fromGroup: [] });
    assert.deepEqual(catDefaults("nope", CATS, M), { own: [], fromGroup: [] });
  });
  test("封存的分類照推導（含封存的清單；歷史塊仍算）", () => {
    assert.deepEqual(catDefaults("c3", CATS, M), { own: ["拖延"], fromGroup: [] });
  });
  test("把分類搬到別的組 ⇒ 組帶的跟著換（推導，不抄）", () => {
    const moved = CATS.map((c) => (c.id === "c2" ? { ...c, parent_id: "G2" } : c));
    const m2 = tagMapsOf([...ENTS, { type: TT_TAG_CATEGORY, id: "G2", keys: ["放鬆"] }]);
    assert.deepEqual(catDefaults("c2", moved, m2), { own: [], fromGroup: ["放鬆"] });
  });
});

/* ───────── 2. blockTags ───────── */

describe("2. blockTags（D-時-110：手動 ∪ 推導）", () => {
  test("手動 ∪ 分類自己的 ∪ 組的；去重、升冪", () => {
    assert.deepEqual(blockTags({ id: "b-commute", categoryId: "c2" }, CATS, M), ["podcast", "高效"]);
    assert.deepEqual(blockTags({ id: "b-x", categoryId: "c1" }, CATS, M), ["創作/寫", "高效"]);
    assert.deepEqual(blockTags({ id: "b-fun", categoryId: "c3" }, CATS, M), ["拖延"], "分類已帶又手動掛 ⇒ 只一個");
  });
  test("分類沒有預設、塊沒手動 ⇒ 空", () => {
    assert.deepEqual(blockTags({ id: "b-none", categoryId: "G2" }, CATS, M), []);
    assert.deepEqual(blockTags({ id: "b-none", categoryId: "c2" }, CATS, EMPTY_TAG_MAPS), []);
  });
  test("underKey：自己或底下；不會把「高鐵」算進「高」", () => {
    assert.ok(underKey("高效", "高效"));
    assert.ok(underKey("高效/深度", "高效"));
    assert.ok(!underKey("高效", "高效/深度"));
    assert.ok(!underKey("高鐵", "高"));
  });
});

/* ───────── 3. byTag ───────── */

describe("3. byTag／untaggedMs（0-10：不是分割）", () => {
  const now = L(10, 20, 23);
  const w = periodWindow("day", "2026-10-20", 6, 1);
  const spans = [
    sp("both", "G2", L(10, 20, 8), L(10, 20, 10), { tagKeys: ["高效/深度", "高效"] }), // 2h
    sp("nested", "G2", L(10, 20, 10), L(10, 20, 11), { tagKeys: ["難度/高"] }), // 1h，「難度」是虛資料夾
    sp("plain", "G2", L(10, 20, 11), L(10, 20, 11, 30)), // 30m 沒掛
    sp("tiny", "G2", L(10, 20, 12), L(10, 20, 12) + 30_000, { tagKeys: ["高效"] }), // 碎塊
    sp("pend", "G2", L(10, 20, 13), L(10, 20, 16), { tagKeys: ["高效"] }), // 待確認
    withTags(sp("derived", "c2", L(10, 20, 17), L(10, 20, 18))), // 學習 ⇒ 組帶 高效，1h
  ];
  const th = (s: StatsSpan): number | null => (s.id === "pend" ? 60 : null);
  const t = windowTotals(spans, classifySpans(spans, now, th), w, now, noRoute);

  test("同塊掛「高效/深度」＋「高效」⇒ 高效只算一次；高效/深度 也有", () => {
    assert.equal(t.byTag["高效"], 3 * H, "both 2h ＋ derived 1h；both 不重複算");
    assert.equal(t.byTag["高效/深度"], 2 * H);
  });
  test("虛資料夾父層有數字", () => {
    assert.equal(t.byTag["難度"], 1 * H);
    assert.equal(t.byTag["難度/高"], 1 * H);
  });
  test("untaggedMs＝沒掛荷札的已記錄", () => {
    assert.equal(t.untaggedMs, 30 * MIN);
  });
  test("碎塊、待確認不進 byTag／untagged（同 ③）", () => {
    assert.equal(t.pendingMs, 3 * H);
    assert.equal(t.recordedMs, 4.5 * H);
    assert.equal(t.byTag["高效"], 3 * H, "pend（3h）、tiny 都掛 #高效，沒進");
    assert.equal(t.msById["tiny"], undefined, "碎塊連 msById 也沒有");
    assert.equal(t.msById["pend"], 3 * H, "待確認在 msById（目標的「另有 n 班待確認」用）");
  });
  test("舊呼叫端的 span 沒有 tagKeys（③ 的測資）⇒ 當沒掛，不炸", () => {
    const legacy = [{ id: "a", categoryId: "c1", start: L(10, 20, 8), end: L(10, 20, 9), ack: false, estimateMin: null, nodeId: null, routeId: null } as unknown as StatsSpan];
    const r = windowTotals(legacy, classifySpans(legacy, now, noTh), w, now, noRoute);
    assert.equal(r.untaggedMs, 1 * H);
    assert.deepEqual(r.byTag, {});
  });
  test("buildStats：tags 列（tagShareRows）＋untagged；趨勢每根有 byTag", () => {
    const names: Record<string, { name: string; real: boolean }> = {
      高效: { name: "高效", real: true },
      "高效/深度": { name: "高效/深度", real: true },
      難度: { name: "難度", real: false },
      "難度/高": { name: "難度/高", real: true },
    };
    const r = buildStats({
      spans,
      cats: CATS,
      goals: [],
      period: "day",
      key: "2026-10-20",
      now,
      h: 6,
      weekStart: 1,
      thresholdMin: th,
      routeOf: noRoute,
      tagRows: (c, p) => tagShareRows(c, p, (k) => names[k]),
    });
    assert.deepEqual(
      r.tags.map((x) => [x.key, x.depth, x.parent, x.hasKids, x.real, x.ms]),
      [
        ["難度", 1, null, true, false, 1 * H],
        ["難度/高", 2, "難度", false, true, 1 * H],
        ["高效", 1, null, true, true, 3 * H],
        ["高效/深度", 2, "高效", false, true, 2 * H],
      ],
    );
    assert.deepEqual(r.untagged, { ms: 30 * MIN, prevMs: 0 });
    assert.equal(r.trend[r.trend.length - 1].byTag["高效"], 3 * H);
    const bare = buildStats({ spans, cats: CATS, goals: [], period: "day", key: "2026-10-20", now, h: 6, weekStart: 1, thresholdMin: th, routeOf: noRoute });
    assert.deepEqual(bare.tags, [], "沒給 tagRows ⇒ 空");
  });
});

describe("3b. tagShareRows（D-時-119）", () => {
  test("只列本期或上期 > 0 的；名稱升冪、父在子前；找不到名字＝key、real false", () => {
    const rows = tagShareRows({ b: 5, "b/x": 5, a: 0, z: 0 }, { a: 3, "c/d": 1, c: 1 }, (k) => (k === "b" ? { name: "B", real: true } : null));
    assert.deepEqual(
      rows.map((r) => [r.key, r.name, r.seg, r.depth, r.parent, r.hasKids, r.real, r.ms, r.prevMs]),
      [
        ["b", "B", "B", 1, null, true, true, 5, 0], // "B" < "a"（大寫在前，同 flattenTree 的字元比較）
        ["b/x", "b/x", "x", 2, "b", false, false, 5, 0],
        ["a", "a", "a", 1, null, false, false, 0, 3],
        ["c", "c", "c", 1, null, true, false, 0, 1],
        ["c/d", "c/d", "d", 2, "c", false, false, 0, 1],
      ],
    );
    assert.deepEqual(tagShareRows({}, {}, () => null), []);
  });
  test("父層缺了（呼叫端自己湊的資料）⇒ 掛到最近的在場祖先，否則當頂層", () => {
    const rows = tagShareRows({ "p/q/r": 2, p: 2 }, {}, () => null);
    assert.deepEqual(rows.map((r) => [r.key, r.parent, r.depth]), [["p", null, 1], ["p/q/r", "p", 2]]);
  });
});

/* ───────── 4. 目標 ───────── */

describe("4. 目標（0-4：分類 ∪ 荷札，一塊只算一次）", () => {
  const now = L(10, 20, 23);
  const opts = { now, h: 6, weekStart: 1 as const, thresholdMin: noTh };
  const spans = [
    withTags(sp("make", "c1", L(10, 5, 9), L(10, 5, 12))), // 創作 3h（推導 高效）
    withTags(sp("learn", "c2", L(10, 6, 9), L(10, 6, 11))), // 學習 2h（組帶 高效）
    withTags(sp("fun", "c3", L(10, 7, 20), L(10, 7, 23))), // 娛樂 3h（拖延）
    sp("deep", "G2", L(10, 8, 9), L(10, 8, 10), { tagKeys: ["高效/深度"] }), // 1h，只掛子荷札
  ];

  test("scope 版本：v1 照舊、v2 讀得到 cats；{cats} 沒有 v ⇒ null；v 不是 2 ⇒ null", () => {
    const v1 = parseGoal(goalRow({ scope: goalScopeJson(["c1"]) }))!;
    assert.deepEqual(v1.categoryIds, ["c1"]);
    assert.deepEqual(v1.tagKeys, [], "parseGoal 不填 tagKeys");
    assert.equal(goalScopeJson(["c1", "c1"]), '{"categories":["c1"]}');
    assert.equal(goalScopeJson(["c1"], true), '{"v":2,"cats":["c1"]}');
    const v2 = parseGoal(goalRow({ scope: goalScopeJson(["c1", "c2", "c1"], true) }))!;
    assert.deepEqual(v2.categoryIds, ["c1", "c2"]);
    assert.equal(parseGoal(goalRow({ scope: JSON.stringify({ cats: ["c1"] }) })), null);
    assert.equal(parseGoal(goalRow({ scope: JSON.stringify({ v: 3, cats: ["c1"] }) })), null);
    assert.equal(parseGoal(goalRow({ scope: JSON.stringify({ v: 2, categories: ["c1"] }) })), null, "v2 沒有 cats ⇒ 不認得");
    assert.deepEqual(parseGoal(goalRow({ scope: goalScopeJson([], true) }))!.categoryIds, [], "只綁荷札：cats 空也讀得到");
    assert.equal(goalScopeVersion(goalScopeJson(["c1"])), 1);
    assert.equal(goalScopeVersion(goalScopeJson(["c1"], true)), 2);
    assert.equal(goalScopeVersion("壞掉"), null);
  });

  test("v2 有黏性：原本是 v2 ⇒ 改名、摘光荷札後仍寫 v2；v1＋這次有荷札 ⇒ v2；v1＋沒荷札 ⇒ v1", () => {
    const v2 = goalScopeJson(["c1"], true);
    assert.equal(goalScopeVersion(goalScopeNext(v2, ["c1"], false)), 2, "這次沒帶荷札（改名）");
    assert.equal(goalScopeVersion(goalScopeNext(v2, [], false)), 2, "荷札全被摘");
    assert.equal(goalScopeVersion(goalScopeNext(goalScopeJson(["c1"]), ["c1"], true)), 2);
    assert.equal(goalScopeNext(goalScopeJson(["c1"]), ["c1", "c2"], false), '{"categories":["c1","c2"]}');
    assert.equal(goalScopeVersion(goalScopeNext(null, [], true)), 2, "新目標");
  });

  test("Goal.tagKeys 不看 scope 版本：v1 列＋有 taggings ⇒ 照算聯集", () => {
    const g = { ...parseGoal(goalRow({ scope: goalScopeJson(["c3"]) }))!, tagKeys: [...(M.goal["g-night"] ?? [])] };
    const [v] = buildGoals([g], spans, CATS, opts);
    assert.equal(v.cur.ms, 3 * H + 3 * H + 2 * H + 1 * H, "娛樂 3h ＋ 高效（創作 3h、學習 2h、高效/深度 1h）");
    assert.equal(v.emptyScope, false);
  });

  test("只綁荷札（#高效，含子荷札）：夜行列車", () => {
    const g = { ...parseGoal(goalRow({ scope: goalScopeJson([], true) }))!, tagKeys: ["高效"] };
    const [v] = buildGoals([g], spans, CATS, opts);
    assert.equal(v.cur.ms, 6 * H);
  });

  test("分類＋荷札聯集只算一次（創作同時是分類成員又推導成 #高效）", () => {
    const g = { ...parseGoal(goalRow({ scope: goalScopeJson(["c1"], true) }))!, tagKeys: ["高效"] };
    const [v] = buildGoals([g], spans, CATS, opts);
    assert.equal(v.cur.ms, 6 * H, "不是 3h＋6h");
  });

  test("沒綁荷札的目標：逐塊判與舊的加總表結果相同", () => {
    const g = parseGoal(goalRow({ scope: goalScopeJson(["G1"]) }))!;
    const w = { start: L(10, 1, 6), end: L(10, 21, 6) };
    const cls = classifySpans(spans, now, noTh);
    const t = windowTotals(spans, cls, w, now, noRoute);
    const byId = new Map(spans.map((s) => [s.id, s] as const));
    assert.deepEqual(goalProgressIn(g, t, byId, CATS), goalProgress(g, t.byCategory, CATS));
  });

  test("荷札全被刪（tagKeys 空）、也沒分類 ⇒ 範圍空、進度 0、emptyScope", () => {
    const g = { ...parseGoal(goalRow({ scope: goalScopeJson([], true) }))!, tagKeys: [] };
    const [v] = buildGoals([g], spans, CATS, opts);
    assert.equal(v.cur.ms, 0);
    assert.equal(v.cur.ratio, 0);
    assert.equal(v.emptyScope, true);
  });

  test("「另有 n 班待確認」逐塊判：荷札範圍內的待確認才算", () => {
    const pend = [...spans, sp("p1", "G2", L(10, 9, 9), L(10, 9, 15), { tagKeys: ["高效"] }), sp("p2", "G2", L(10, 10, 9), L(10, 10, 15))];
    const g = { ...parseGoal(goalRow({ scope: goalScopeJson([], true) }))!, tagKeys: ["高效"] };
    const [v] = buildGoals([g], pend, CATS, { ...opts, thresholdMin: (s) => (s.id === "p1" || s.id === "p2" ? 60 : null) });
    assert.equal(v.cur.pendingCount, 1);
    assert.equal(v.cur.pendingMs, 6 * H);
    assert.deepEqual(v.cur.pendingItems.map((x) => x.id), ["p1"]);
    assert.equal(v.cur.ms, 6 * H, "待確認不進進度");
  });

  test("goalMember：分類中、荷札中（含底下的荷札）、都不中", () => {
    const cs = new Set(["c1"]);
    assert.ok(goalMember({ categoryId: "c1", tagKeys: [] }, cs, []));
    assert.ok(goalMember({ categoryId: "x", tagKeys: ["高效/深度"] }, cs, ["高效"]));
    assert.ok(!goalMember({ categoryId: "x", tagKeys: ["高效"] }, cs, ["高效/深度"]), "子荷札的目標不收父荷札的塊");
    assert.ok(!goalMember({ categoryId: "x", tagKeys: ["高鐵"] }, cs, ["高"]));
    assert.ok(!goalMember({ categoryId: "x" }, cs, ["高效"]), "沒有 tagKeys 的舊 span");
  });
});

/* ───────── 5. normalizeGoalInput ───────── */

describe("5. normalizeGoalInput（請選至少一個分類或荷札）", () => {
  const base: GoalInput = { name: "夜行列車", categoryIds: [], period: "since", targetMin: 180 * 60, direction: "atLeast", startOn: "2026-10-01", endOn: null };
  test("分類 0、荷札 1 ⇒ 過；荷札 trim、去掉 #、去重", () => {
    const v = normalizeGoalInput({ ...base, tagNames: [" #高效 ", "高效", ""] });
    assert.deepEqual(v.categoryIds, []);
    assert.deepEqual(v.tagNames, ["高效"]);
  });
  test("兩者都 0 ⇒「請選至少一個分類或荷札」（tagNames 沒給、給空陣列都一樣）", () => {
    assert.throws(() => normalizeGoalInput(base), /^RangeError: 請選至少一個分類或荷札$/);
    assert.throws(() => normalizeGoalInput({ ...base, tagNames: [] }), /請選至少一個分類或荷札/);
    assert.throws(() => normalizeGoalInput({ ...base, tagNames: ["  ", "#"] }), /請選至少一個分類或荷札/);
  });
  test("tagNames 沒給 ⇒ 回傳也沒有（＝repository 不動荷札）；給了空陣列 ⇒ 回空陣列（＝摘光）", () => {
    const a = normalizeGoalInput({ ...base, categoryIds: ["c1"] });
    assert.ok(!("tagNames" in a));
    const b = normalizeGoalInput({ ...base, categoryIds: ["c1"], tagNames: [] });
    assert.deepEqual(b.tagNames, []);
  });
});

/* ───────── 6. carry ───────── */

describe("6. carry（0-8：手動荷札跟著 fromId 搬）", () => {
  test("planSplitMulti：切成四段 ⇒ 三個新段都帶 fromId（換分類的那段也帶，不管 inherit）", () => {
    const s = { id: "A", categoryId: "c1", start: L(10, 20, 8), end: L(10, 20, 12), ack: false };
    const plan = planSplitMulti([s], { id: "A", cuts: [L(10, 20, 9), L(10, 20, 10), L(10, 20, 11)], categoryIds: ["c1", "c2", "c1", "c3"], now: L(10, 20, 23) });
    assert.deepEqual(plan.inserts.map((i) => [i.fromId, i.inherit, i.categoryId]), [["A", false, "c2"], ["A", true, "c1"], ["A", false, "c3"]]);
    // repository 給新 id 後組 pair
    const pairs = carryPairs(plan.inserts.map((i, k) => ({ to: "new" + k, from: i.fromId ?? "" })));
    assert.deepEqual(pairs, [{ to: "new0", from: "A" }, { to: "new1", from: "A" }, { to: "new2", from: "A" }]);
  });
  test("planReconcile：片段 key＝`${id}|ISO`、fromId＝原塊", () => {
    const spans: KeyedSpan[] = [
      { id: "A", categoryId: "c1", start: L(10, 20, 10), end: L(10, 20, 12), ack: false, writeKey: "2" },
      { id: "B", categoryId: "c2", start: L(10, 20, 9), end: L(10, 20, 13), ack: false, writeKey: "1" },
    ];
    const plan = planReconcile(spans);
    assert.equal(plan.inserts.length, 1);
    const ins = plan.inserts[0];
    assert.equal(ins.fromId, "B");
    assert.equal(ins.key, `B|${new Date(L(10, 20, 12)).toISOString()}`);
  });
  test("carryPairs：去重、to===from 略過、空 id 略過", () => {
    assert.deepEqual(
      carryPairs([
        { to: "x", from: "A" },
        { to: "x", from: "A" },
        { to: "A", from: "A" },
        { to: "", from: "A" },
        { to: "y", from: "" },
        { to: "x", from: "B" },
      ]),
      [{ to: "x", from: "A" }, { to: "x", from: "B" }],
    );
  });
  test("planMerge 的 absorbedInto（被吞的 → 留下的）：併進鄰居才標；鄰居是未記錄（自己延長）不標", () => {
    const A = { id: "A", categoryId: "c1", start: L(10, 20, 8), end: L(10, 20, 9), ack: false };
    const B = { id: "B", categoryId: "c2", start: L(10, 20, 9), end: L(10, 20, 10), ack: false };
    const now = L(10, 20, 23);
    const prev = planMerge([A, B], { id: "B", dir: "prev", bound: L(10, 20, 6), now })!;
    assert.deepEqual(prev.plan.absorbedInto, [{ from: "B", to: "A" }]);
    assert.ok(prev.plan.deletes.includes("B"));
    const next = planMerge([A, B], { id: "A", dir: "next", bound: L(10, 20, 23), now })!;
    assert.deepEqual(next.plan.absorbedInto, [{ from: "A", to: "B" }]);
    // 鄰居與自己之間隔了 ≥ 1 分的未記錄 ⇒ 自己延長、沒有被吞的
    const C = { id: "C", categoryId: "c2", start: L(10, 20, 12), end: L(10, 20, 13), ack: false };
    const gap = planMerge([A, C], { id: "C", dir: "prev", bound: L(10, 20, 6), now })!;
    assert.equal(gap.preview.keepId, "C");
    assert.equal(gap.plan.absorbedInto, undefined);
    // repository 組 pair：insert 的 fromId ＋ absorbedInto
    assert.deepEqual(carryPairsOfPlan(prev.plan.inserts, [], prev.plan.absorbedInto), [{ to: "A", from: "B", off: false }]);
  });
  test("carryPairsOfPlan：insert 有 fromId 才成對（新塊 id 依序對應）；沒有 absorbedInto 不加", () => {
    const ins = [{ fromId: "A" }, { fromId: null }, { fromId: "B" }];
    assert.deepEqual(carryPairsOfPlan(ins, ["n0", "n1", "n2"], undefined), [{ to: "n0", from: "A", off: false }, { to: "n2", from: "B", off: false }]);
    assert.deepEqual(carryPairsOfPlan([], [], undefined), []);
  });
});

/* ───────── 7. 舊版相容的牙齒 ───────── */

/** v1.15 版的 `parseGoal`（⑥ 之前；scope 的判斷逐字照抄，其餘欄位判斷照當時的寫法） */
function parseGoalV115(r: TimeGoalRow): { categoryIds: string[] } | null {
  const period = r.period;
  if (period !== "day" && period !== "week" && period !== "month" && period !== "since" && period !== "until" && period !== "range") return null;
  const direction = r.direction;
  if (direction !== "atLeast" && direction !== "atMost") return null;
  let scope: unknown;
  try {
    scope = JSON.parse(r.scope);
  } catch {
    return null;
  }
  if (scope === null || typeof scope !== "object" || Array.isArray(scope)) return null;
  const cats = (scope as { categories?: unknown }).categories;
  if (!Array.isArray(cats)) return null;
  const categoryIds: string[] = [];
  for (const c of cats) if (typeof c === "string" && !categoryIds.includes(c)) categoryIds.push(c);
  if (typeof r.target_min !== "number" || !Number.isInteger(r.target_min) || r.target_min <= 0) return null;
  return { categoryIds };
}

describe("7. 舊版相容（v1.15 的 parseGoal）", () => {
  test("讀 v2 ⇒ null（不畫、也不能改，不會用 categories 把荷札洗掉）", () => {
    assert.equal(parseGoalV115(goalRow({ scope: goalScopeJson(["c1"], true) })), null);
    assert.equal(parseGoalV115(goalRow({ scope: goalScopeJson([], true) })), null);
    assert.equal(parseGoalV115(goalRow({ scope: goalScopeNext(goalScopeJson(["c1"], true), ["c1"], false) })), null);
  });
  test("只綁分類的照舊寫 v1，舊版讀得到", () => {
    assert.deepEqual(parseGoalV115(goalRow({ scope: goalScopeJson(["c1", "c2"]) })), { categoryIds: ["c1", "c2"] });
  });
});

/* ───────── 8. 效能 ───────── */

describe("8. 效能", () => {
  test("10k 塊、每塊 0–3 個 key、月趨勢 6 根：windowTotals（含 byTag）< 250ms", () => {
    const POOL = ["高效", "高效/深度", "拖延", "podcast", "難度/高", "難度/中", "副/甲/乙"];
    const spans: StatsSpan[] = [];
    let t = L(4, 15, 6);
    for (let i = 0; i < 10_000; i++) {
      const len = (8 + ((i * 7) % 50)) * MIN;
      const n = i % 4;
      const keys: string[] = [];
      for (let j = 0; j < n; j++) {
        const k = POOL[(i * 3 + j * 5) % POOL.length];
        if (!keys.includes(k)) keys.push(k);
      }
      spans.push(sp("b" + String(i).padStart(5, "0"), ["c1", "c2", "c3"][i % 3], t, t + len, { tagKeys: keys }));
      t += len;
    }
    const now = L(10, 19, 12);
    const c = classifySpans(spans, now, () => 240);
    const keys = trendKeys("month", "2026-10-01", 1);
    const t0 = performance.now();
    let tagged = 0;
    for (const k of keys) {
      const w = periodWindow("month", k, 6, 1);
      const r = windowTotals(spans, c, w, now, noRoute);
      tagged += r.byTag["高效"] ?? 0;
    }
    const ms = performance.now() - t0;
    console.log(`[perf] ⑥ 10k 塊（0–3 key）× 月趨勢 6 根 windowTotals＋byTag：${ms.toFixed(1)} ms（#高效 ${(tagged / H).toFixed(0)}h）`);
    assert.ok(tagged > 0);
    assert.ok(ms < 250, `${ms.toFixed(1)}ms 超過 250ms`);
    // 目標逐塊判：since 半年、綁 #高效＋一個分類
    const goal: Goal = { ...parseGoal(goalRow({ start_on: "2026-04-15", scope: goalScopeJson(["c3"], true) }))!, tagKeys: ["高效", "podcast"] };
    const t1 = performance.now();
    const [v] = buildGoals([goal, goal, goal, goal, goal], spans, CATS, { now, h: 6, weekStart: 1, thresholdMin: () => 240 });
    const gms = performance.now() - t1;
    console.log(`[perf] ⑥ 10k 塊 × 5 個目標（分類＋荷札逐塊判）buildGoals：${gms.toFixed(1)} ms`);
    assert.ok(v.cur.ms > 0);
    assert.ok(gms < 250, `${gms.toFixed(1)}ms`);
  });
});

/* ───────── 排除（磨光③ 2-1；D-時-134） ───────── */

describe("排除：一塊不算某個分類帶的荷札（D-時-134）", () => {
  /** 在 ENTS 上加：c2 自己帶「高效/深度」；b-x 排除 高效、b-fun 排除 拖延（它也手動掛著）、b-y 排除跟預設無關的 */
  const OFF_ENTS = [
    ...ENTS.filter((e) => !(e.type === TT_TAG_CATEGORY && e.id === "c2")),
    { type: TT_TAG_CATEGORY, id: "c2", keys: ["高效/深度"] },
    { type: TT_TAG_BLOCK_OFF, id: "b-x", keys: ["高效"] },
    { type: TT_TAG_BLOCK_OFF, id: "b-fun", keys: ["拖延"] },
    { type: TT_TAG_BLOCK_OFF, id: "b-y", keys: ["無關"] },
    { type: TT_TAG_BLOCK_OFF, id: "b-z", keys: ["創作/寫", "高效", "高效"] },
  ];
  const MO = tagMapsOf(OFF_ENTS);

  test("常數字面值＋tagMapsOf 收進 off（升冪、去重）；EMPTY_TAG_MAPS 也有 off；沒有排除＝off 空", () => {
    assert.equal(TT_TAG_BLOCK_OFF, "timetable:block-off");
    assert.deepEqual(MO.off, { "b-x": ["高效"], "b-fun": ["拖延"], "b-y": ["無關"], "b-z": ["創作/寫", "高效"] });
    assert.deepEqual(EMPTY_TAG_MAPS.off, {});
    assert.deepEqual(M.off, {});
    assert.equal(MO.block["b-x"], undefined, "排除不混進手動那張");
  });
  test("blockTags：只扣預設那半——分類自己的與組帶的同 key 都扣掉", () => {
    assert.deepEqual(blockTags({ id: "b-x", categoryId: "c1" }, CATS, MO), ["創作/寫"]);
    assert.deepEqual(blockTags({ id: "b-z", categoryId: "c1" }, CATS, MO), [], "預設全排除＝空");
    assert.deepEqual(blockTags({ id: "b-other", categoryId: "c1" }, CATS, MO), ["創作/寫", "高效"], "別塊不受影響");
  });
  test("手動也掛著同一個 key ⇒ 照樣在（D-時-127 一顆）", () => {
    assert.deepEqual(blockTags({ id: "b-fun", categoryId: "c3" }, CATS, MO), ["拖延"]);
    assert.deepEqual(defaultsAfterOff("b-fun", "c3", CATS, MO), { own: [], fromGroup: [] }, "預設那半確實扣了");
  });
  test("逐 key 不是子樹：排除 #高效 不影響 #高效/深度", () => {
    assert.deepEqual(blockTags({ id: "b-x", categoryId: "c2" }, CATS, MO), ["高效/深度"]);
    assert.deepEqual(defaultsAfterOff("b-x", "c2", CATS, MO), { own: ["高效/深度"], fromGroup: [] });
  });
  test("不在預設裡的排除讀時無效（改分類不裁，D-時-135）", () => {
    assert.deepEqual(blockTags({ id: "b-y", categoryId: "c1" }, CATS, MO), ["創作/寫", "高效"]);
    // b-x 換到 c3：c3 沒帶 高效 ⇒ 排除沒作用；換回 c1 又生效
    assert.deepEqual(blockTags({ id: "b-x", categoryId: "c3" }, CATS, MO), ["拖延"]);
  });
  test("defaultsAfterOff：沒排除＝跟 catDefaults 一樣；isBlockOff 只看 key 本身", () => {
    assert.deepEqual(defaultsAfterOff("b-none", "c1", CATS, MO), catDefaults("c1", CATS, MO));
    assert.deepEqual(defaultsAfterOff("b-x", "c1", CATS, MO), { own: ["創作/寫"], fromGroup: [] });
    assert.ok(isBlockOff("b-x", "高效", MO));
    assert.ok(!isBlockOff("b-x", "高效/深度", MO));
    assert.ok(!isBlockOff("b-none", "高效", MO));
  });
  test("舊形狀的對照（沒有 off 這張）照舊算、不炸", () => {
    const legacy = { block: M.block, category: M.category, goal: M.goal } as unknown as TimetableTagMaps;
    assert.deepEqual(blockTags({ id: "b-x", categoryId: "c1" }, CATS, legacy), ["創作/寫", "高效"]);
    assert.deepEqual(defaultsAfterOff("b-x", "c1", CATS, legacy), catDefaults("c1", CATS, legacy));
    assert.ok(!isBlockOff("b-x", "高效", legacy));
  });
  test("統計經 blockTags 就扣：byTag 少了那一塊", () => {
    const now = L(10, 20, 23);
    const w = periodWindow("day", "2026-10-20", 6, 1);
    const spans = [
      withTags(sp("b-x", "c1", L(10, 20, 8), L(10, 20, 9)), MO), // 排除 高效 ⇒ 只剩 創作/寫
      withTags(sp("b-other", "c1", L(10, 20, 9), L(10, 20, 10)), MO),
    ];
    const t = windowTotals(spans, classifySpans(spans, now, noTh), w, now, noRoute);
    assert.equal(t.byTag["高效"], 1 * H);
    assert.equal(t.byTag["創作/寫"], 2 * H);
  });
  test("純度：timetableTags.ts 仍只 import ./timetable.ts 與 ./tags.ts（同第 9 項）", () => {
    const src = readFileSync(path.join(ROOT, "src/domain/timetableTags.ts"), "utf8");
    const froms = Array.from(src.matchAll(/^import[\s\S]*?from\s+"([^"]+)";/gm)).map((m) => m[1]);
    assert.deepEqual(Array.from(new Set(froms)).sort(), ["./tags.ts", "./timetable.ts"]);
  });
});

/* ───────── 9. 純度牙齒 ───────── */

describe("9. 純度牙齒", () => {
  test("timetableTags.ts 只 import ./timetable.ts 與 ./tags.ts（相對路徑帶 .ts）", () => {
    const src = readFileSync(path.join(ROOT, "src/domain/timetableTags.ts"), "utf8");
    const froms = Array.from(src.matchAll(/^import[\s\S]*?from\s+"([^"]+)";/gm)).map((m) => m[1]);
    assert.ok(froms.length > 0);
    assert.deepEqual(Array.from(new Set(froms)).sort(), ["./tags.ts", "./timetable.ts"]);
  });
});
