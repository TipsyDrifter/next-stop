// 時刻表篩選與排序純函式測試（v1.32 2B-2）
// 跑法：node --test "src/domain/timetableFilter.test.ts"
import { test } from "node:test";
import assert from "node:assert/strict";
import { MIN, isoOf, type TimeBlockRow, type TimeCategoryRow } from "./timetable.ts";
import type { LinkInfo } from "./timetableLink.ts";
import { tagMapsOf } from "./timetableTags.ts";
import {
  DEFAULT_TIMETABLE_FILTER,
  NO_ROUTE_FILTER,
  expandCategoryFilterIds,
  filterTimetableDay,
  hasTimetableFilterCriteria,
  isTimetableFilterActive,
  type TimetableFilter,
} from "./timetableFilter.ts";

const DAY_START = Date.parse("2026-11-15T03:00:00.000Z");
const DAY_END = DAY_START + 24 * 60 * MIN;
const NOW = DAY_START + 12 * 60 * MIN; // 15:00Z

function cat(id: string, name: string, parent_id: string | null, position = 0): TimeCategoryRow {
  return {
    id,
    name,
    glyph: name.slice(0, 1),
    color_idx: 1,
    parent_id,
    position,
    default_min: null,
    archived_at: null,
    account_id: null,
    device_id: null,
    created_at: "2026-11-01T00:00:00.000Z",
    updated_at: "2026-11-01T00:00:00.000Z",
    synced_at: null,
    deleted_at: null,
  };
}

function block(
  id: string,
  category_id: string,
  startMin: number,
  endMin: number | null,
  extra: Partial<TimeBlockRow> = {},
): TimeBlockRow {
  return {
    id,
    category_id,
    started_at: isoOf(DAY_START + startMin * MIN),
    ended_at: endMin === null ? null : isoOf(DAY_START + endMin * MIN),
    long_run_ack: 0,
    estimate_min: null,
    node_id: null,
    route_id: null,
    note: null,
    account_id: null,
    device_id: null,
    created_at: "2026-11-15T03:00:00.000Z",
    updated_at: "2026-11-15T03:00:00.000Z",
    synced_at: null,
    deleted_at: null,
    ...extra,
  };
}

const CATEGORIES: TimeCategoryRow[] = [
  cat("g-work", "正事", null, 0),
  cat("c-dev", "開發", "g-work", 0),
  cat("c-write", "寫作", "g-work", 1),
  cat("g-life", "生活", null, 1),
  cat("c-read", "閱讀", "g-life", 0),
];

const LINKS: Record<string, LinkInfo> = {
  "r-ns": {
    id: "r-ns",
    kind: "route",
    kindLabel: "路線",
    name: "私鐵手帳",
    routeId: "r-ns",
    estimateMin: null,
    code: "NS",
    deleted: false,
    missing: false,
  },
  "r-jp": {
    id: "r-jp",
    kind: "route",
    kindLabel: "路線",
    name: "日文自學",
    routeId: "r-jp",
    estimateMin: null,
    code: "JP",
    deleted: false,
    missing: false,
  },
  "br-ui": {
    id: "br-ui",
    kind: "branch",
    kindLabel: "支線",
    name: "介面支線",
    routeId: "r-ns",
    estimateMin: null,
    code: null,
    deleted: false,
    missing: false,
  },
  "tk-filter": {
    id: "tk-filter",
    kind: "ticket",
    kindLabel: "車票",
    name: "時刻表篩選列",
    routeId: "r-ns",
    estimateMin: 60,
    code: null,
    deleted: false,
    missing: false,
  },
  "tk-vocab": {
    id: "tk-vocab",
    kind: "ticket",
    kindLabel: "車票",
    name: "背五十音單字",
    routeId: "r-jp",
    estimateMin: 30,
    code: null,
    deleted: false,
    missing: false,
  },
  "tk-temp": {
    id: "tk-temp",
    kind: "ticket",
    kindLabel: "車票",
    name: "買咖啡豆",
    routeId: null,
    estimateMin: null,
    code: null,
    deleted: false,
    missing: false,
  },
};

const TAG_MAPS = tagMapsOf([
  { type: "timetable:category", id: "g-work", keys: ["產出"] },
  { type: "timetable:category", id: "c-dev", keys: ["程式/前端"] },
  { type: "timetable:block", id: "b1", keys: ["專注"] },
  { type: "timetable:block-off", id: "b2", keys: ["產出"] },
  { type: "timetable:block", id: "b3", keys: ["日文/單字", "專注"] },
]);

const BLOCKS: TimeBlockRow[] = [
  // b1: 開發 60m，連到介面支線底下的車票 tk-filter，荷札＝產出(組)＋程式/前端(類)＋專注(塊)
  block("b1", "c-dev", 60, 120, { node_id: "tk-filter", note: "完成純函式模型" }),
  // b2: 寫作 30m，只連路線 r-ns，排除組預設荷札「產出」⇒ 無生效荷札
  block("b2", "c-write", 150, 180, { route_id: "r-ns", note: "整理規格筆記" }),
  // b3: 閱讀 90m，連 tk-vocab (r-jp)，荷札＝日文/單字＋專注
  block("b3", "c-read", 240, 330, { node_id: "tk-vocab" }),
  // b4: 閱讀 45m（運行中 11:15 起至 12:00 NOW），連無路線臨時車票 tk-temp
  block("b4", "c-read", 675, null, { node_id: "tk-temp", note: "手沖配方測試" }),
];

function run(patch: Partial<TimetableFilter> = {}) {
  return filterTimetableDay({
    dayBlocks: BLOCKS,
    window: { start: DAY_START, end: DAY_END },
    now: NOW,
    filter: { ...DEFAULT_TIMETABLE_FILTER, ...patch },
    categories: CATEGORIES,
    links: LINKS,
    tagMaps: TAG_MAPS,
    tagNames: {
      產出: "產出",
      "程式/前端": "程式/前端",
      專注: "專注",
      "日文/單字": "日文/單字",
    },
    routeNames: {
      "r-ns": "私鐵手帳",
      "r-jp": "日文自學",
    },
    branchNodeIds: {
      "br-ui": ["br-ui", "tk-filter"],
    },
  });
}

test("預設未篩選且 timeAsc：active=false，保留含 gap 空檔的完整時間軸", () => {
  assert.equal(isTimetableFilterActive(DEFAULT_TIMETABLE_FILTER), false);
  assert.equal(hasTimetableFilterCriteria(DEFAULT_TIMETABLE_FILTER), false);
  const res = run();
  assert.equal(res.active, false);
  assert.equal(res.hasCriteria, false);
  assert.equal(res.axisItems.some((i) => i.kind === "gap"), true);
  assert.deepEqual(
    res.blocks.map((b) => b.row.id),
    ["b1", "b2", "b3", "b4"],
  );
  assert.equal(res.count, 4);
  assert.equal(res.totalMs, (60 + 30 + 90 + 45) * MIN);
});

test("分類篩選：選頂層分組自動涵蓋底下所有子分類，單選子分類只命該分類", () => {
  const expanded = expandCategoryFilterIds(["g-work"], CATEGORIES);
  assert.equal(expanded.has("c-dev"), true);
  assert.equal(expanded.has("c-write"), true);
  assert.equal(expanded.has("c-read"), false);

  const byGroup = run({ categoryIds: ["g-work"] });
  assert.equal(byGroup.active, true);
  assert.deepEqual(
    byGroup.blocks.map((b) => b.row.id),
    ["b1", "b2"],
  );
  assert.equal(byGroup.totalMs, 90 * MIN);

  const byLeaf = run({ categoryIds: ["c-write"] });
  assert.deepEqual(
    byLeaf.blocks.map((b) => b.row.id),
    ["b2"],
  );
});

test("路線與支線篩選：未掛路線（含無路線臨時票）、指定路線、支線含子孫任務", () => {
  const unrouted = run({ routeId: NO_ROUTE_FILTER });
  assert.deepEqual(
    unrouted.blocks.map((b) => b.row.id),
    ["b4"],
  );

  const byRoute = run({ routeId: "r-ns" });
  assert.deepEqual(
    byRoute.blocks.map((b) => b.row.id),
    ["b1", "b2"],
  );

  const byBranch = run({ routeId: "br-ui" });
  assert.deepEqual(
    byBranch.blocks.map((b) => b.row.id),
    ["b1"],
  );
});

test("#荷札組合篩選：支援分類繼承、單塊排除（block-off）、父含子、多荷札 AND 交集", () => {
  // b1 繼承 g-work 的「產出」，b2 單塊排除了「產出」
  const byInherited = run({ tagKeys: ["產出"] });
  assert.deepEqual(
    byInherited.blocks.map((b) => b.row.id),
    ["b1"],
  );

  // 父荷札「程式」命中子荷札「程式/前端」；「日文」命中「日文/單字」
  const byParent = run({ tagKeys: ["程式"] });
  assert.deepEqual(
    byParent.blocks.map((b) => b.row.id),
    ["b1"],
  );

  // 多選組合篩選（AND）：同時帶「日文」與「專注」⇒ 只剩 b3
  const combo = run({ tagKeys: ["日文", "專注"] });
  assert.deepEqual(
    combo.blocks.map((b) => b.row.id),
    ["b3"],
  );
});

test("關鍵字搜尋：比對分類名、任務名、所屬路線名、時間塊備註與荷札名", () => {
  assert.deepEqual(
    run({ query: "寫作" }).blocks.map((b) => b.row.id),
    ["b2"],
  );
  assert.deepEqual(
    run({ query: "五十音" }).blocks.map((b) => b.row.id),
    ["b3"],
  );
  // 透過任務所屬路線名「私鐵手帳」同時命中連車票的 b1 與只連路線的 b2
  assert.deepEqual(
    run({ query: "私鐵手帳" }).blocks.map((b) => b.row.id),
    ["b1", "b2"],
  );
  assert.deepEqual(
    run({ query: "手沖配方" }).blocks.map((b) => b.row.id),
    ["b4"],
  );
  assert.deepEqual(
    run({ query: "#前端" }).blocks.map((b) => b.row.id),
    ["b1"],
  );
});

test("四種排序切換：timeAsc、timeDesc、durDesc、durAsc，且單切非預設排序即進入台帳模式", () => {
  const desc = run({ sort: "timeDesc" });
  assert.equal(desc.active, true);
  assert.equal(desc.hasCriteria, false);
  assert.deepEqual(
    desc.blocks.map((b) => b.row.id),
    ["b4", "b3", "b2", "b1"],
  );

  // 時長：b3(90m) > b1(60m) > b4(45m) > b2(30m)
  const durDesc = run({ sort: "durDesc" });
  assert.deepEqual(
    durDesc.blocks.map((b) => b.row.id),
    ["b3", "b1", "b4", "b2"],
  );

  const durAsc = run({ sort: "durAsc" });
  assert.deepEqual(
    durAsc.blocks.map((b) => b.row.id),
    ["b2", "b4", "b1", "b3"],
  );
});

test("無結果退路：多條件交集無命中時回傳空清單與 0 合計", () => {
  const none = run({ categoryIds: ["c-write"], tagKeys: ["專注"] });
  assert.equal(none.active, true);
  assert.equal(none.count, 0);
  assert.equal(none.totalMs, 0);
  assert.deepEqual(none.blocks, []);
});
