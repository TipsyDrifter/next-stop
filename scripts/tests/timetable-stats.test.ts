/**
 * 時刻表線③・統計純函式測試（③ 契約 §4；甲席）。
 * 跑法：`node --test scripts/tests/timetable-stats.test.ts`（node 24，型別剝除預設開；零依賴）。
 *
 * 時區：測資一律用 `new Date(y, m-1, d, h, mi).getTime()` 造本地時刻（同 timetable-logic.test.ts），不寫 UTC 字面值。
 * 契約 §4 的 13 項各一個 describe（編號對得上）；末尾另有幾支整頁（buildStats／buildWeek）與寫入驗證的冒煙。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MIN,
  STARTER_CATEGORIES,
  findBlockIn,
  sheetBlockIdOf,
  sliceSpans,
  thresholdOf,
  totalsByCategory,
  weekStartKey,
  type Span,
  type TimeBlockRow,
  type TimeCategoryRow,
  type TimeGoalRow,
} from "../../src/domain/timetable.ts";
import {
  ROUTE_GONE,
  ROUTE_NONE,
  TINY_MS,
  TREND_COUNT,
  buildGoals,
  buildStats,
  buildWeek,
  classifySpans,
  compareWindow,
  expandScope,
  fmtDelta,
  fmtPct,
  goalsFromMs,
  goalProgress,
  goalScopeJson,
  goalDaysLeft,
  goalPace,
  goalPrevWindow,
  goalWindow,
  normalizeGoalInput,
  parseGoal,
  isRealDateKey,
  periodWindow,
  resolveViewKey,
  routeKeyOf,
  routesChanged,
  shiftPeriod,
  staleNodeIds,
  dayRolledOver,
  statsFromMs,
  stepView,
  trendKeys,
  viewChangedSince,
  windowTotals,
  type Goal,
  type NodeRoute,
  type StatsSpan,
} from "../../src/domain/timetableStats.ts";
import { buildStatsDemo } from "../../src/domain/timetableStatsDemo.ts";
import { todayKey } from "../../src/lib/date.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");

/* ───────── 測試用小工具 ───────── */

/** 本地 (月, 日, 時, 分)；2026 年 */
const L = (m: number, d: number, h = 0, mi = 0): number => new Date(2026, m - 1, d, h, mi).getTime();
/** 本地 10/6 (h, mi)，d 偏移天數（同 timetable-logic.test.ts 的 T） */
const T = (h: number, mi: number, d = 0): number => new Date(2026, 9, 6 + d, h, mi).getTime();

const sp = (id: string, cat: string, start: number, end: number | null, o: Partial<StatsSpan> = {}): StatsSpan => ({
  id,
  categoryId: cat,
  start,
  end,
  ack: false,
  estimateMin: null,
  nodeId: null,
  routeId: null,
  ...o,
});

const noTh = (): number | null => null;
const noRoute = (): string => ROUTE_NONE;
const cls = (spans: readonly StatsSpan[], now: number, th: (s: StatsSpan) => number | null = noTh) => classifySpans(spans, now, th);

/** 分類：兩個頂層（G1 本務、G2 生活）、子分類 c1 c2（G1 底下）、c3（G2 底下） */
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
const CATS: TimeCategoryRow[] = [
  cat("G1", null, "本務"),
  cat("G2", null, "生活"),
  cat("c1", "G1", "創作", { position: 0 }),
  cat("c2", "G1", "學習", { position: 1 }),
  cat("c3", "G2", "睡覺", { position: 0 }),
];

const goalRow = (o: Partial<TimeGoalRow> = {}): TimeGoalRow => ({
  id: "g1",
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

/** 舊版（抽出 sliceSpans 之前）的 totalsByCategory，逐字照抄當對照組 */
function referenceTotals(spans: readonly Span[], w: { start: number; end: number }, now: number): Record<string, number> {
  const effEnd = Math.min(w.end, now);
  const clipped: Span[] = [];
  for (const s of spans) {
    const from = Math.max(s.start, w.start);
    const to = Math.min(s.end ?? now, effEnd);
    if (to <= from) continue;
    clipped.push({ ...s, start: from, end: to });
  }
  const totals: Record<string, number> = {};
  if (!clipped.length) return totals;
  const bounds = new Set<number>();
  for (const s of clipped) {
    bounds.add(s.start);
    bounds.add(s.end!);
  }
  const ts = Array.from(bounds).sort((a, b) => a - b);
  for (let i = 0; i + 1 < ts.length; i++) {
    const a = ts[i];
    const b = ts[i + 1];
    let owner: Span | null = null;
    for (const s of clipped) {
      if (s.start > a || s.end! < b) continue;
      if (!owner || s.start > owner.start || (s.start === owner.start && s.id > owner.id)) owner = s;
    }
    if (owner) totals[owner.categoryId] = (totals[owner.categoryId] ?? 0) + (b - a);
  }
  return totals;
}

/* ───────── 1. sliceSpans 抽出 ───────── */

describe("1. sliceSpans 抽出後 totalsByCategory 行為不變", () => {
  test("隨機資料（含髒資料重疊、運行中、窗外）：新舊演算法逐筆相同", () => {
    let seed = 12345;
    const rnd = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let round = 0; round < 200; round++) {
      const now = T(15, 0);
      const spans: Span[] = [];
      const n = 1 + Math.floor(rnd() * 12);
      for (let i = 0; i < n; i++) {
        const start = T(0, 0) + Math.floor(rnd() * 20 * 60) * MIN;
        const len = Math.floor(rnd() * 5 * 60) * MIN;
        const running = rnd() < 0.1;
        spans.push({ id: "s" + i, categoryId: "k" + Math.floor(rnd() * 4), start, end: running ? null : start + len, ack: false });
      }
      const w = { start: T(3, 0), end: T(3, 0, 1) };
      assert.deepEqual(totalsByCategory(spans, w, now), referenceTotals(spans, w, now), `round ${round}`);
    }
  });

  test("sliceSpans：每塊一筆、ms 加起來＝totalsByCategory；重疊歸較晚開始者", () => {
    const now = T(15, 0);
    const spans: Span[] = [
      { id: "a", categoryId: "x", start: T(9, 0), end: T(12, 0), ack: false },
      { id: "b", categoryId: "y", start: T(10, 0), end: T(11, 0), ack: false },
    ];
    const w = { start: T(3, 0), end: T(3, 0, 1) };
    const sl = sliceSpans(spans, w, now);
    assert.deepEqual(
      sl.map((x) => [x.id, x.categoryId, x.ms / MIN]).sort(),
      [
        ["a", "x", 120],
        ["b", "y", 60],
      ],
    );
    assert.deepEqual(totalsByCategory(spans, w, now), { x: 120 * MIN, y: 60 * MIN });
    assert.deepEqual(sliceSpans([], w, now), []);
  });
});

/* ───────── 2. 碎塊 ───────── */

describe("2. 碎塊（< 60 秒）不進任何數字", () => {
  const now = T(15, 0);
  const w = { start: T(6, 0), end: T(6, 0, 1) };
  test("59 秒不進、60 秒進；運行中 30 秒不進", () => {
    const spans = [
      sp("t59", "c1", T(9, 0), T(9, 0) + 59_000),
      sp("t60", "c1", T(10, 0), T(10, 0) + 60_000),
      sp("run", "c2", now - 30_000, null),
    ];
    const c = cls(spans, now);
    assert.deepEqual([...c.tiny].sort(), ["run", "t59"]);
    const t = windowTotals(spans, c, w, now, noRoute);
    assert.equal(t.byCategory.c1, 60_000);
    assert.equal(t.byCategory.c2, undefined);
    assert.equal(t.recordedMs, 60_000);
    assert.equal(t.byRoute[ROUTE_NONE], 60_000);
    assert.equal(TINY_MS, 60_000);
  });

  test("碎塊也不算待確認、不佔掉別人的時間（先丟掉再切片）", () => {
    // 一塊 10:00–12:00，中間夾一塊 30 秒的碎塊（髒資料重疊）：碎塊若參與切片會偷走 30 秒
    const spans = [sp("big", "c1", T(10, 0), T(12, 0)), sp("tiny", "c2", T(11, 0), T(11, 0) + 30_000)];
    const t = windowTotals(spans, cls(spans, now), w, now, noRoute);
    assert.equal(t.byCategory.c1, 120 * MIN);
    assert.equal(t.byCategory.c2, undefined);
  });
});

/* ───────── 3. 待確認 ───────── */

describe("3. 待確認", () => {
  const now = T(20, 0, 3);
  const w = { start: T(6, 0), end: T(6, 0, 4) }; // 窗涵蓋 4 天
  const th = (s: StatsSpan): number | null => (s.categoryId === "c1" ? 240 : null); // 創作預設 4 小時

  test("超過門檻且 ack=0 ⇒ 整塊進 pending；ack=1 不進；沒有門檻的分類永遠不會待確認", () => {
    const long = sp("long", "c1", T(9, 0), T(9, 0) + 52 * 60 * MIN); // 52 小時
    const confirmed = sp("ok", "c1", T(9, 0, -6), T(9, 0, -6) + 52 * 60 * MIN, { ack: true });
    const free = sp("free", "c3", T(9, 0, -7), T(9, 0, -7) + 20 * 60 * MIN); // 沒有門檻
    const c = cls([long, confirmed, free], now, th);
    assert.deepEqual([...c.pending], ["long"]);
    const t = windowTotals([long, confirmed, free], c, { start: T(6, 0, -8), end: T(6, 0, 4) }, now, noRoute);
    assert.equal(t.pendingMs, 52 * 60 * MIN);
    assert.deepEqual(t.pendingIds, ["long"]);
    assert.equal(t.byCategory.c1, 52 * 60 * MIN, "ack=1 那塊回到分類");
    assert.equal(t.byCategory.c3, 20 * 60 * MIN);
    assert.equal(t.byRoute[ROUTE_NONE], 72 * 60 * MIN, "待確認不進路線");
    assert.equal(t.pendingByCategory.c1.count, 1);
  });

  test("確認（ack 0→1）後同一窗重算：整塊回到分類，pending 清空", () => {
    const before = [sp("x", "c1", T(9, 0), T(21, 0))]; // 12 小時 > 4 小時門檻
    const t0 = windowTotals(before, cls(before, now, th), w, now, noRoute);
    assert.equal(t0.pendingMs, 12 * 60 * MIN);
    assert.equal(t0.byCategory.c1, undefined);
    const after = [{ ...before[0], ack: true }];
    const t1 = windowTotals(after, cls(after, now, th), w, now, noRoute);
    assert.equal(t1.pendingMs, 0);
    assert.deepEqual(t1.pendingIds, []);
    assert.equal(t1.byCategory.c1, 12 * 60 * MIN);
  });

  test("待確認的塊只算切進窗內的部分；跨窗的塊兩邊都有班數", () => {
    const x = sp("x", "c1", T(20, 0), T(20, 0) + 10 * 60 * MIN); // 10/6 20:00 → 10/7 06:00 跨日界線 06:00
    const c = cls([x], now, th);
    const day1 = windowTotals([x], c, { start: T(6, 0), end: T(6, 0, 1) }, now, noRoute);
    const day2 = windowTotals([x], c, { start: T(6, 0, 1), end: T(6, 0, 2) }, now, noRoute);
    assert.equal(day1.pendingMs, 10 * 60 * MIN);
    assert.equal(day2.pendingMs, 0);
    const wide = windowTotals([x], c, { start: T(6, 0, -1), end: T(6, 0, 2) }, now, noRoute);
    assert.equal(wide.pendingIds.length, 1);
  });

  test("運行中那班：門檻由呼叫端給（含任務預計）；超過就待確認，並算到 now", () => {
    const run = sp("run", "c1", now - 5 * 60 * MIN, null);
    const t = windowTotals([run], cls([run], now, () => 240), { start: now - 24 * 60 * MIN, end: now + MIN }, now, noRoute);
    assert.equal(t.pendingMs, 5 * 60 * MIN);
  });
});

/* ───────── 4. 日界線 ───────── */

describe("4. 日界線 06:00 與 03:00", () => {
  const blockAt4 = sp("n", "c3", T(4, 0, 1), T(5, 0, 1)); // 10/7 凌晨 04:00–05:00
  const now = T(20, 0, 1);
  for (const [h, owner] of [
    [6, "2026-10-06"],
    [3, "2026-10-07"],
  ] as const) {
    test(`日界線 ${String(h).padStart(2, "0")}:00：凌晨 04:00 的塊屬於 ${owner}`, () => {
      assert.equal(todayKey(h, new Date(T(4, 0, 1))), owner);
      const d6 = periodWindow("day", "2026-10-06", h, 1);
      const d7 = periodWindow("day", "2026-10-07", h, 1);
      const in6 = windowTotals([blockAt4], cls([blockAt4], now), d6, now, noRoute).recordedMs;
      const in7 = windowTotals([blockAt4], cls([blockAt4], now), d7, now, noRoute).recordedMs;
      if (owner === "2026-10-06") {
        assert.equal(in6, 60 * MIN);
        assert.equal(in7, 0);
      } else {
        assert.equal(in6, 0);
        assert.equal(in7, 60 * MIN);
      }
    });
  }
});

/* ───────── 5. 週與月 ───────── */

describe("5. 週（weekStart 0／1）與月", () => {
  test("weekStartKey：預設＝週一（舊行為）；0＝週日起", () => {
    assert.equal(weekStartKey("2026-10-06"), "2026-10-05");
    assert.equal(weekStartKey("2026-10-06", 1), "2026-10-05");
    assert.equal(weekStartKey("2026-10-06", 0), "2026-10-04");
    assert.equal(weekStartKey("2026-10-04", 0), "2026-10-04"); // 週日本身
    assert.equal(weekStartKey("2026-10-04", 1), "2026-09-28");
    assert.equal(weekStartKey("2026-10-05", 0), "2026-10-04"); // 週一在週日起的週裡
  });

  test("periodWindow：週＝7 天、月＝當月 1 日到下月 1 日；跨年、2 月", () => {
    const w1 = periodWindow("week", "2026-10-07", 6, 1);
    assert.equal(w1.key, "2026-10-05");
    assert.equal(w1.start, L(10, 5, 6));
    assert.equal(w1.end, L(10, 12, 6));
    const w0 = periodWindow("week", "2026-10-07", 6, 0);
    assert.equal(w0.key, "2026-10-04");
    assert.equal(w0.end - w0.start, 7 * 24 * 60 * MIN);
    const m = periodWindow("month", "2026-10-31", 3, 1);
    assert.equal(m.key, "2026-10-01");
    assert.equal(m.start, L(10, 1, 3));
    assert.equal(m.end, L(11, 1, 3));
    assert.equal(periodWindow("month", "2026-12-15", 3, 1).end, new Date(2027, 0, 1, 3).getTime());
    assert.equal(periodWindow("month", "2026-02-10", 3, 1).end, L(3, 1, 3));
  });

  test("shiftPeriod／trendKeys：日 14、週 8、月 6，最後一個＝本期；跨月跨年", () => {
    assert.equal(shiftPeriod("day", "2026-10-01", -1, 1), "2026-09-30");
    assert.equal(shiftPeriod("week", "2026-10-07", -1, 1), "2026-09-28");
    assert.equal(shiftPeriod("month", "2026-01-15", -1, 1), "2025-12-01");
    assert.equal(shiftPeriod("month", "2026-10-31", 1, 1), "2026-11-01");
    const d = trendKeys("day", "2026-10-19", 1);
    const w = trendKeys("week", "2026-10-19", 1);
    const m = trendKeys("month", "2026-10-19", 1);
    assert.deepEqual([d.length, w.length, m.length], [14, 8, 6]);
    assert.deepEqual([TREND_COUNT.day, TREND_COUNT.week, TREND_COUNT.month], [14, 8, 6]);
    assert.equal(d[13], "2026-10-19");
    assert.equal(d[0], "2026-10-06");
    assert.equal(w[7], "2026-10-19"); // 2026-10-19 是週一
    assert.equal(w[0], "2026-08-31");
    assert.equal(m[5], "2026-10-01");
    assert.equal(m[0], "2026-05-01");
    // 週日起：最後一根對齊到週日
    assert.equal(trendKeys("week", "2026-10-19", 0)[7], "2026-10-18");
  });

  test("月：10 月 31 日比 9 月，上期截止夾到 9 月底（不溢進 10 月）", () => {
    const cur = periodWindow("month", "2026-10-31", 6, 1);
    const now = L(10, 31, 12);
    const c = compareWindow("month", cur, now, 6, 1);
    assert.equal(c.compare, "sameSpan");
    assert.equal(c.prev.start, L(9, 1, 6));
    assert.equal(c.prev.end, L(10, 1, 6), "經過 30.25 天 > 9 月的 30 天 ⇒ 夾到 9 月底");
    // 10/15 12:00（本月已過 14 天 6 小時）比 9/15 12:00（9/1 06:00 起算同樣長）
    const mid = compareWindow("month", cur, L(10, 15, 12), 6, 1);
    assert.equal(mid.prev.end, L(9, 15, 12));
  });
});

/* ───────── 6. 同期 ───────── */

describe("6. 同期（D-時-45）", () => {
  test("週三 20:00 看本週 ⇒ 上週一日界線到上週三 20:00，compare=sameSpan", () => {
    const h = 6;
    const now = L(10, 7, 20); // 2026-10-07 週三
    const cur = periodWindow("week", "2026-10-07", h, 1);
    const c = compareWindow("week", cur, now, h, 1);
    assert.equal(c.compare, "sameSpan");
    assert.equal(c.prev.start, L(9, 28, 6));
    assert.equal(c.prev.end, L(9, 30, 20), "上週三 20:00");
  });

  test("已過完的週＝上週整週，compare=whole；未來的期（還沒開始）也是 whole", () => {
    const h = 6;
    const now = L(10, 19, 12);
    const past = periodWindow("week", "2026-10-07", h, 1);
    const c = compareWindow("week", past, now, h, 1);
    assert.equal(c.compare, "whole");
    assert.equal(c.prev.start, L(9, 28, 6));
    assert.equal(c.prev.end, L(10, 5, 6));
    const future = periodWindow("week", "2026-10-26", h, 1);
    assert.equal(compareWindow("week", future, now, h, 1).compare, "whole");
  });

  test("日：今天 14:00 比昨天同一刻；本期的邊界：恰在開始＝sameSpan 長 0", () => {
    const h = 6;
    const cur = periodWindow("day", "2026-10-19", h, 1);
    const c = compareWindow("day", cur, L(10, 19, 14), h, 1);
    assert.equal(c.prev.start, L(10, 18, 6));
    assert.equal(c.prev.end, L(10, 18, 14));
    const z = compareWindow("day", cur, cur.start, h, 1);
    assert.equal(z.compare, "sameSpan");
    assert.equal(z.prev.end, z.prev.start);
  });
});

/* ───────── 7. 未記錄 ───────── */

describe("7. 未記錄＝有效段 − 已記錄 − 待確認，不為負", () => {
  const w = { start: T(6, 0), end: T(6, 0, 1) };
  test("一般：8 小時有效段、記了 3 小時 ⇒ 未記錄 5 小時", () => {
    const now = T(14, 0);
    const spans = [sp("a", "c1", T(8, 0), T(11, 0))];
    const t = windowTotals(spans, cls(spans, now), w, now, noRoute);
    assert.equal(t.effectiveMs, 8 * 60 * MIN);
    assert.equal(t.recordedMs, 3 * 60 * MIN);
    assert.equal(t.unrecordedMs, 5 * 60 * MIN);
    assert.equal(t.recordedMs + t.pendingMs + t.unrecordedMs, t.effectiveMs);
  });

  test("有待確認：三者加起來＝有效段（誤差 < 1 分）", () => {
    const now = T(20, 0, 2);
    const wide = { start: T(6, 0), end: T(6, 0, 3) };
    const spans = [sp("a", "c1", T(8, 0), T(11, 0)), sp("b", "c2", T(12, 0), T(12, 0) + 30 * 60 * MIN)];
    const t = windowTotals(spans, cls(spans, now, (s) => (s.id === "b" ? 120 : null)), wide, now, noRoute);
    assert.equal(t.pendingMs, 30 * 60 * MIN);
    assert.ok(Math.abs(t.recordedMs + t.pendingMs + t.unrecordedMs - t.effectiveMs) < MIN);
  });

  test("未來的窗 effectiveMs = 0、全 0；重疊髒資料下 unrecorded 不為負", () => {
    const now = T(10, 0);
    const future = windowTotals([sp("a", "c1", T(8, 0), T(9, 0))], cls([]), { start: T(6, 0, 3), end: T(6, 0, 4) }, now, noRoute);
    assert.equal(future.effectiveMs, 0);
    assert.equal(future.recordedMs + future.pendingMs + future.unrecordedMs, 0);
    const dirty = [sp("a", "c1", T(6, 0), T(9, 0)), sp("b", "c2", T(7, 0), T(10, 0))];
    const t = windowTotals(dirty, cls(dirty, now), w, now, noRoute);
    assert.ok(t.unrecordedMs >= 0);
    assert.equal(t.recordedMs, 4 * 60 * MIN, "6:00–10:00 各分鐘只算一次");
  });
});

/* ───────── 8. 重疊（髒資料） ───────── */

describe("8. 重疊：歸較晚開始者，跟 totalsByCategory 一致", () => {
  test("windowTotals.byCategory ＝ totalsByCategory（沒有碎塊、待確認時）", () => {
    const now = T(18, 0);
    const spans = [
      sp("a", "c1", T(8, 0), T(12, 0)),
      sp("b", "c2", T(10, 0), T(11, 0)),
      sp("c", "c3", T(11, 30), T(14, 0)),
      sp("d", "c1", T(11, 30), T(12, 30)), // 同開始：id 較大的 d 贏
    ];
    const w = { start: T(6, 0), end: T(6, 0, 1) };
    const t = windowTotals(spans, cls(spans, now), w, now, noRoute);
    assert.deepEqual(t.byCategory, totalsByCategory(spans, w, now));
    assert.equal(t.recordedMs, Object.values(t.byCategory).reduce((a, b) => a + b, 0));
  });
});

/* ───────── 9. 路線 ───────── */

describe("9. 路線", () => {
  test("routeKeyOf：節點連路線／只連路線／沒連／節點已刪但有 route_id／節點已刪沒 route_id", () => {
    assert.equal(routeKeyOf(sp("a", "c1", 0, 1, { nodeId: "n1" }), { gone: false, routeId: "R1" }), "R1");
    assert.equal(routeKeyOf(sp("b", "c1", 0, 1, { routeId: "R2" }), undefined), "R2");
    assert.equal(routeKeyOf(sp("c", "c1", 0, 1), undefined), ROUTE_NONE);
    assert.equal(routeKeyOf(sp("d", "c1", 0, 1, { nodeId: "n2", routeId: "R3" }), { gone: true, routeId: null }), "R3");
    assert.equal(routeKeyOf(sp("e", "c1", 0, 1, { nodeId: "n3" }), { gone: true, routeId: null }), ROUTE_GONE);
    assert.equal(routeKeyOf(sp("f", "c1", 0, 1, { nodeId: "n4" }), undefined), ROUTE_GONE, "沒解到＝節點不在");
    // 活節點沒掛路線（臨時車票）：退回塊上的 route_id，再沒有算沒連
    assert.equal(routeKeyOf(sp("g", "c1", 0, 1, { nodeId: "n5" }), { gone: false, routeId: null }), ROUTE_NONE);
  });

  test("windowTotals.byRoute 照 routeOf 分；buildStats.routes 排序：時數多的在前、已刪除的任務在沒連任務之前", () => {
    const now = T(20, 0);
    const spans = [
      sp("a", "c1", T(8, 0), T(10, 0), { routeId: "R1" }),
      sp("b", "c1", T(10, 0), T(11, 0), { routeId: "R2" }),
      sp("c", "c2", T(11, 0), T(15, 0)), // 沒連
      sp("d", "c2", T(15, 0), T(16, 0), { nodeId: "dead" }), // 已刪除的任務
    ];
    const byId: Record<string, string> = { a: "R1", b: "R2", c: ROUTE_NONE, d: ROUTE_GONE };
    const r = buildStats({
      spans,
      cats: CATS,
      goals: [],
      period: "day",
      key: "2026-10-06",
      now,
      h: 6,
      weekStart: 1,
      thresholdMin: noTh,
      routeOf: (s) => byId[s.id],
    });
    assert.deepEqual(
      r.routes.map((x) => [x.key, x.ms / MIN]),
      [
        ["R1", 120],
        ["R2", 60],
        [ROUTE_GONE, 60],
        [ROUTE_NONE, 240],
      ],
    );
  });
});

/* ───────── 10. 目標 ───────── */

describe("10. 目標", () => {
  const by = { c1: 100 * MIN, c2: 50 * MIN, c3: 400 * MIN };
  const goal = (o: Partial<Goal> = {}): Goal => ({
    id: "g",
    name: "x",
    categoryIds: ["G1"],
    period: "week",
    targetMin: 120,
    direction: "atLeast",
    startOn: null,
    endOn: null,
    position: 0,
    archived: false,
    ...o,
  });

  test("expandScope：頂層＝自己＋底下所有子分類（含之後新增的）；子分類只有自己", () => {
    assert.deepEqual([...expandScope(["G1"], CATS)].sort(), ["G1", "c1", "c2"]);
    assert.deepEqual([...expandScope(["c2"], CATS)], ["c2"]);
    const later = [...CATS, cat("c9", "G1", "新增的")];
    assert.deepEqual([...expandScope(["G1"], later)].sort(), ["G1", "c1", "c2", "c9"], "目標沒改，新子分類自動算進去");
  });

  test("已刪除的分類略過（連同它的子分類不展開）；找不到的 id 略過；封存的照算", () => {
    const withDeleted = CATS.map((c) => (c.id === "c2" ? { ...c, deleted_at: "2026-10-10T00:00:00.000Z" } : c));
    assert.deepEqual([...expandScope(["G1"], withDeleted)].sort(), ["G1", "c1"]);
    assert.deepEqual([...expandScope(["c2", "nope"], withDeleted)], []);
    const archived = CATS.map((c) => (c.id === "c2" ? { ...c, archived_at: "2026-10-10T00:00:00.000Z" } : c));
    assert.deepEqual([...expandScope(["G1"], archived)].sort(), ["G1", "c1", "c2"]);
    const goneTop = CATS.map((c) => (c.id === "G1" ? { ...c, deleted_at: "x" } : c));
    assert.deepEqual([...expandScope(["G1"], goneTop)], []);
  });

  test("goalProgress：atLeast 達成／未達；atMost 超過 ⇒ over", () => {
    const g = goal({ categoryIds: ["G1"], targetMin: 150 });
    const r = goalProgress(g, by, CATS);
    assert.equal(r.ms, 150 * MIN);
    assert.equal(r.ratio, 1);
    assert.equal(r.met, true);
    assert.equal(r.over, false);
    const r2 = goalProgress(goal({ targetMin: 151 }), by, CATS);
    assert.equal(r2.met, false);
    const most = goalProgress(goal({ direction: "atMost", categoryIds: ["c3"], targetMin: 300 }), by, CATS);
    assert.equal(most.over, true);
    assert.equal(most.met, false);
    assert.equal(most.ms, 400 * MIN);
    const ok = goalProgress(goal({ direction: "atMost", categoryIds: ["c3"], targetMin: 400 }), by, CATS);
    assert.deepEqual([ok.over, ok.met], [false, true], "剛好等於目標不算超過");
  });

  test("goalWindow：週期重複＝含今天的期；since＝[start_on, 無終點)；upcoming／active 看日界線日", () => {
    const wk = goalWindow(goal({ period: "week" }), "2026-10-21", 6, 1);
    assert.deepEqual(wk, { start: L(10, 19, 6), end: L(10, 26, 6), state: "active" });
    const pv = goalPrevWindow(goal({ period: "week" }), "2026-10-21", 6, 1)!;
    assert.deepEqual(pv, { start: L(10, 12, 6), end: L(10, 19, 6) });
    assert.equal(goalPrevWindow(goal({ period: "since", startOn: "2026-10-01" }), "2026-10-21", 6, 1), null);
    const since = goalWindow(goal({ period: "since", startOn: "2026-10-01" }), "2026-10-19", 6, 1);
    assert.deepEqual(since, { start: L(10, 1, 6), end: null, state: "active" });
    assert.equal(goalWindow(goal({ period: "since", startOn: "2026-11-01" }), "2026-10-19", 6, 1).state, "upcoming");
    assert.equal(goalWindow(goal({ period: "since", startOn: "2026-10-19" }), "2026-10-19", 6, 1).state, "active", "起點當天就算進行中");
  });

  for (const h of [6, 3]) {
    test(`goalWindow：until／range 三種 state，終點含當天整天（日界線 ${String(h).padStart(2, "0")}:00）`, () => {
      const g = goal({ period: "range", startOn: "2026-11-01", endOn: "2026-11-30" });
      const w = goalWindow(g, "2026-11-15", h, 1);
      assert.equal(w.state, "active");
      assert.equal(w.start, L(11, 1, h));
      assert.equal(w.end, L(12, 1, h), "11/30 整天算到 12/1 的日界線");
      assert.equal(goalWindow(g, "2026-10-31", h, 1).state, "upcoming");
      assert.equal(goalWindow(g, "2026-11-30", h, 1).state, "active", "截止當天還在進行中");
      assert.equal(goalWindow(g, "2026-12-01", h, 1).state, "ended");
      // 凌晨 04:00 在 11/30 的窗內（h=6）或 12/1 的窗外（h=3）：整天的邊界跟著日界線走
      const edge = L(12, 1, 4);
      assert.equal(edge < (w.end as number), h === 6);
      // until：起點預設建立當天、可改；終點同 range
      const u = goalWindow(goal({ period: "until", startOn: "2026-10-19", endOn: "2026-12-31" }), "2026-10-19", h, 1);
      assert.deepEqual([u.state, u.start, u.end], ["active", L(10, 19, h), new Date(2027, 0, 1, h).getTime()]);
    });
  }

  test("goalPace（D-時-62）：剩 3 天含今天、還差 6h ⇒ 2h；達成／至多／沒終點／已結束／未開始 ⇒ null", () => {
    const g = goal({ period: "until", startOn: "2026-10-01", endOn: "2026-10-21", targetMin: 10 * 60 });
    assert.equal(goalDaysLeft(g, "2026-10-19"), 3);
    assert.equal(goalPace(g, 4 * 60 * MIN, "2026-10-19", 6), 2 * 60 * MIN);
    assert.equal(goalDaysLeft(g, "2026-10-21"), 1, "截止當天還剩 1 天");
    assert.equal(goalPace(g, 4 * 60 * MIN, "2026-10-21", 6), 6 * 60 * MIN);
    assert.equal(goalPace(g, 10 * 60 * MIN, "2026-10-19", 6), null, "剛好達成");
    assert.equal(goalPace(g, 12 * 60 * MIN, "2026-10-19", 6), null, "已超過");
    assert.equal(goalPace({ ...g, direction: "atMost" }, 0, "2026-10-19", 6), null);
    assert.equal(goalPace({ ...g, period: "since", endOn: null }, 0, "2026-10-19", 6), null, "沒有終點");
    assert.equal(goalPace(g, 0, "2026-10-22", 6), null, "已結束");
    assert.equal(goalDaysLeft(g, "2026-10-22"), null);
    assert.equal(goalPace({ ...g, startOn: "2026-10-25", endOn: "2026-10-30" }, 0, "2026-10-19", 6), null, "還沒開始");
    assert.equal(goalPace(goal({ period: "week" }), 0, "2026-10-19", 6), null, "週期重複沒有節奏");
    const range = goal({ period: "range", startOn: "2026-10-01", endOn: "2026-10-31", targetMin: 60 });
    assert.equal(goalPace(range, 0, "2026-10-31", 6), 60 * MIN);
  });

  test("buildGoals：since 的進度只算 start_on 之後；已刪除的分類略過；另有待確認提示", () => {
    const h = 6;
    const now = L(10, 19, 20);
    const spans = [
      sp("before", "c1", L(9, 30, 8), L(9, 30, 10)), // start_on 之前：不算
      sp("a", "c1", L(10, 2, 8), L(10, 2, 10)), // 2h
      sp("b", "c2", L(10, 3, 8), L(10, 3, 9)), // 1h
      sp("pend", "c1", L(10, 10, 8), L(10, 10, 20)), // 12h 超過門檻 ⇒ 待確認
    ];
    const g = parseGoal(goalRow({ period: "since", start_on: "2026-10-01", target_min: 10 * 60 }))!;
    const [v] = buildGoals([g], spans, CATS, { now, h, weekStart: 1, thresholdMin: (s) => (s.id === "pend" ? 240 : null), routeOf: noRoute });
    assert.equal(v.cur.ms, 3 * 60 * MIN);
    assert.equal(v.cur.pendingCount, 1);
    assert.equal(v.cur.pendingMs, 12 * 60 * MIN);
    assert.equal(v.prev, null);
    assert.equal(v.state, "active");
    assert.equal(v.window.end, null);
    assert.equal(v.daysLeft, null);
    assert.equal(v.paceMs, null);
    assert.deepEqual(v.liveCategoryIds, ["G1"]);
  });

  test("buildGoals：週目標有上一期結果", () => {
    const now = L(10, 21, 20); // 2026-10-21 週三
    const spans = [sp("a", "c3", L(10, 20, 8), L(10, 20, 18)), sp("b", "c3", L(10, 13, 8), L(10, 13, 12))];
    const g = parseGoal(goalRow({ period: "week", direction: "atMost", target_min: 8 * 60, start_on: null, scope: goalScopeJson(["c3"]) }))!;
    const [v] = buildGoals([g], spans, CATS, { now, h: 6, weekStart: 1, thresholdMin: noTh, routeOf: noRoute });
    assert.equal(v.cur.ms, 10 * 60 * MIN);
    assert.equal(v.cur.over, true);
    assert.equal(v.prev!.ms, 4 * 60 * MIN);
    assert.equal(v.prev!.met, true);
  });

  test("buildGoals：until 進行中（節奏、剩幾天）／range 已結束（整段、最後結果）／range 未開始（進度 0）；排序 進行中→未開始→已結束", () => {
    const h = 6;
    const now = L(10, 19, 12);
    const spans = [
      sp("a", "c1", L(10, 15, 8), L(10, 15, 12)), // 4h，在 until 內
      sp("old", "c1", L(9, 10, 8), L(9, 10, 18)), // 9 月，range 內 10h
      sp("future", "c1", L(10, 18, 8), L(10, 18, 9)), // 1h，在 range(11 月)之外
    ];
    const mkGoal = (id: string, o: Partial<TimeGoalRow>, pos: number): Goal =>
      parseGoal(goalRow({ id, position: pos, scope: goalScopeJson(["c1"]), target_min: 10 * 60, ...o }))!;
    const ended = mkGoal("ended", { period: "range", start_on: "2026-09-01", end_on: "2026-09-30" }, 0);
    const upcoming = mkGoal("up", { period: "range", start_on: "2026-11-01", end_on: "2026-11-30" }, 1);
    const until = mkGoal("until", { period: "until", start_on: "2026-10-12", end_on: "2026-10-21" }, 2);
    const views = buildGoals([ended, upcoming, until], spans, CATS, { now, h, weekStart: 1, thresholdMin: noTh, routeOf: noRoute });
    assert.deepEqual(views.map((v) => v.goal.id), ["until", "up", "ended"]);
    const [u, up, en] = views;
    assert.equal(u.state, "active");
    assert.equal(u.cur.ms, 5 * 60 * MIN, "10/15 的 4h ＋ 10/18 的 1h");
    assert.equal(u.daysLeft, 3);
    assert.equal(u.paceMs, (5 * 60 * MIN) / 3);
    assert.equal(up.state, "upcoming");
    assert.equal(up.cur.ms, 0);
    assert.equal(up.paceMs, null);
    assert.equal(en.state, "ended");
    assert.equal(en.cur.ms, 10 * 60 * MIN);
    assert.equal(en.cur.met, true);
    assert.equal(en.paceMs, null);
    assert.equal(en.daysLeft, null);
    // 已結束但沒達到
    const missed = buildGoals([{ ...ended, targetMin: 11 * 60 }], spans, CATS, { now, h, weekStart: 1, thresholdMin: noTh, routeOf: noRoute })[0];
    assert.deepEqual([missed.state, missed.cur.met], ["ended", false]);
  });

  test("parseGoal：不認得的 period／direction／scope ⇒ null；認得的轉成 Goal", () => {
    assert.equal(parseGoal(goalRow({ period: "year" })), null);
    assert.equal(parseGoal(goalRow({ period: "total" })), null, "舊名 total 已改 since；沒發行過，不認得就不畫");
    assert.equal(parseGoal(goalRow({ direction: "exactly" })), null);
    assert.equal(parseGoal(goalRow({ scope: "not json" })), null);
    assert.equal(parseGoal(goalRow({ scope: "[1,2]" })), null);
    assert.equal(parseGoal(goalRow({ scope: JSON.stringify({ tags: ["x"] }) })), null, "⑥ 新版的 scope 形狀（沒有 categories）舊版讀不懂 ⇒ 不畫");
    assert.equal(parseGoal(goalRow({ target_min: Number.NaN })), null);
    const g = parseGoal(goalRow({ scope: JSON.stringify({ categories: ["c1", "c1", 5, "c2"], tags: ["later"] }), archived_at: "2026-10-02T00:00:00.000Z" }))!;
    assert.deepEqual(g.categoryIds, ["c1", "c2"], "去重、丟掉非字串；多出來的 tags 欄忽略");
    assert.equal(g.archived, true);
    assert.equal(g.startOn, "2026-10-01");
    assert.equal(g.endOn, null);
    const recurring = parseGoal(goalRow({ period: "week", start_on: "2026-10-01", end_on: "2026-10-09" }))!;
    assert.deepEqual([recurring.startOn, recurring.endOn], [null, null], "週期重複一律忽略 start_on／end_on");
    // 缺 start_on ⇒ 退回建立當下的日界線日（不是 UTC 日期）：本地 10/1 01:00 建立、日界線 0 時 ＝ 10/1（UTC 在東八區是 9/30）
    const created = new Date(2026, 9, 1, 1, 0).toISOString();
    assert.equal(parseGoal(goalRow({ start_on: null, created_at: created }), 0)!.startOn, "2026-10-01");
    assert.equal(parseGoal(goalRow({ start_on: "", created_at: created }), 0)!.startOn, "2026-10-01", "空字串也算缺");
    assert.equal(parseGoal(goalRow({ start_on: null, created_at: created }), 6)!.startOn, "2026-09-30", "日界線 06:00：01:00 還算前一天");
    assert.equal(parseGoal(goalRow({ period: "until", start_on: null, end_on: "2026-12-31", created_at: created }), 0)!.startOn, "2026-10-01");
    assert.equal(parseGoal(goalRow({ start_on: null, created_at: "壞掉" }), 0), null, "建立時間也壞了 ⇒ 不畫");
  });

  test("parseGoal 嚴格（評審 #5）：target_min 要正整數、日期要真實存在、since 起點格式錯 ⇒ null", () => {
    for (const bad of [0, -5, 1.5, Number.POSITIVE_INFINITY, Number.NaN]) assert.equal(parseGoal(goalRow({ target_min: bad })), null, String(bad));
    assert.ok(parseGoal(goalRow({ target_min: 1 })));
    assert.equal(parseGoal(goalRow({ start_on: "2026-02-31" })), null, "since 起點是不存在的日期");
    assert.equal(parseGoal(goalRow({ start_on: "2026-13-01" })), null);
    assert.equal(parseGoal(goalRow({ start_on: "10/01" })), null, "since 起點格式錯 ⇒ 不再默默退回建立日");
    assert.equal(parseGoal(goalRow({ period: "until", start_on: "2026-06-31", end_on: "2026-12-31" })), null);
    assert.equal(parseGoal(goalRow({ period: "until", start_on: "2026-10-01", end_on: "2026-02-30" })), null);
    assert.equal(parseGoal(goalRow({ period: "range", start_on: "2026-10-01", end_on: "2026-11-31" })), null);
    assert.ok(parseGoal(goalRow({ period: "range", start_on: "2028-02-29", end_on: "2028-03-01" })), "閏日是真的");
    assert.equal(parseGoal(goalRow({ period: "range", start_on: "2027-02-29", end_on: "2027-03-01" })), null, "非閏年沒有 2/29");
    assert.equal(parseGoal(goalRow({ period: "week", start_on: "亂寫", end_on: "亂寫" }))!.startOn, null, "週期重複忽略起訖欄，亂寫也不擋");
  });

  test("isRealDateKey", () => {
    for (const ok of ["2026-10-19", "2028-02-29", "2026-12-31", "2026-01-01"]) assert.equal(isRealDateKey(ok), true, ok);
    for (const bad of ["2026-02-31", "2027-02-29", "2026-00-10", "2026-10-00", "2026-10-32", "2026-1-1", "", "abc", null, 20261019]) assert.equal(isRealDateKey(bad), false, String(bad));
  });

  test("parseGoal：until／range 缺 end_on、end_on 格式錯、end_on < start_on ⇒ null；range 缺 start_on ⇒ null；end_on = start_on 可以", () => {
    assert.equal(parseGoal(goalRow({ period: "until", end_on: null })), null);
    assert.equal(parseGoal(goalRow({ period: "range", end_on: null })), null);
    assert.equal(parseGoal(goalRow({ period: "until", end_on: "10/09" })), null);
    assert.equal(parseGoal(goalRow({ period: "range", start_on: "2026-10-10", end_on: "2026-10-09" })), null);
    assert.equal(parseGoal(goalRow({ period: "range", start_on: null, end_on: "2026-10-09" })), null);
    const one = parseGoal(goalRow({ period: "range", start_on: "2026-10-09", end_on: "2026-10-09" }))!;
    assert.deepEqual([one.period, one.startOn, one.endOn], ["range", "2026-10-09", "2026-10-09"]);
    const until = parseGoal(goalRow({ period: "until", start_on: null, end_on: "2026-12-31" }))!;
    assert.equal(until.startOn, "2026-10-01", "until 沒起點 ⇒ 退回建立日");
    assert.equal(until.endOn, "2026-12-31");
    // since 忽略 end_on
    assert.equal(parseGoal(goalRow({ period: "since", end_on: "2026-12-31" }))!.endOn, null);
  });

  test("goalScopeJson／normalizeGoalInput：往返、去重、驗證訊息", () => {
    assert.equal(goalScopeJson(["a", "b", "a"]), '{"categories":["a","b"]}');
    const ok = normalizeGoalInput({ name: "  夜行列車 ", categoryIds: ["c1", "c1", "c2"], period: "week", targetMin: 60, direction: "atMost", startOn: "2026-10-01", endOn: "2026-10-09" });
    assert.deepEqual(ok, { name: "夜行列車", categoryIds: ["c1", "c2"], period: "week", targetMin: 60, direction: "atMost", startOn: null, endOn: null });
    const base = { name: "x", categoryIds: ["c1"], period: "since" as const, targetMin: 60, direction: "atLeast" as const, startOn: "2026-10-01", endOn: null };
    assert.throws(() => normalizeGoalInput({ ...base, name: "   " }), /名稱不能是空的/);
    assert.throws(() => normalizeGoalInput({ ...base, name: "一".repeat(25) }), /最多 24 個字/);
    assert.equal(normalizeGoalInput({ ...base, name: "一".repeat(24) }).name.length, 24);
    assert.throws(() => normalizeGoalInput({ ...base, categoryIds: [] }), /至少選一個分類/);
    assert.throws(() => normalizeGoalInput({ ...base, targetMin: 0 }), /大於 0/);
    assert.throws(() => normalizeGoalInput({ ...base, targetMin: 1.5 }), /大於 0/);
    assert.throws(() => normalizeGoalInput({ ...base, startOn: null }), /起點/);
    assert.throws(() => normalizeGoalInput({ ...base, startOn: "10/01" }), /起點/);
    assert.throws(() => normalizeGoalInput({ ...base, period: "year" as unknown as "week" }), RangeError);
    assert.throws(() => normalizeGoalInput({ ...base, direction: "x" as unknown as "atLeast" }), RangeError);
    assert.equal(normalizeGoalInput({ ...base, period: "day", startOn: "2026-10-01" }).startOn, null);
    // since 不收終點；until／range 要終點且 ≥ 起點
    assert.equal(normalizeGoalInput({ ...base, endOn: "2026-12-31" }).endOn, null);
    const until = { ...base, period: "until" as const };
    assert.throws(() => normalizeGoalInput({ ...until, endOn: null }), /截止/);
    assert.throws(() => normalizeGoalInput({ ...until, endOn: "2026-09-30" }), /不能早於/);
    assert.equal(normalizeGoalInput({ ...until, endOn: "2026-10-01" }).endOn, "2026-10-01");
    assert.throws(() => normalizeGoalInput({ ...until, period: "range", startOn: null, endOn: "2026-10-09" }), /起點/);
  });
});

/* ───────── 11. fmtDelta／fmtPct ───────── */

describe("11. fmtDelta、fmtPct 邊界", () => {
  test("fmtDelta：|差| < 1 分＝持平；▲多／▼少（〈原型定案〉1）；時分格式同 fmtDur", () => {
    assert.equal(fmtDelta(0), "持平");
    assert.equal(fmtDelta(59_999), "持平");
    assert.equal(fmtDelta(-59_999), "持平");
    assert.equal(fmtDelta(60_000), "▲1m");
    assert.equal(fmtDelta(-60_000), "▼1m");
    assert.equal(fmtDelta((3 * 60 + 10) * MIN), "▲3h10m");
    assert.equal(fmtDelta(-45 * MIN), "▼45m");
    assert.equal(fmtDelta(2 * 60 * MIN), "▲2h");
    assert.equal(fmtDelta(Number.NaN), "持平");
    assert.ok(!fmtDelta(-45 * MIN).includes("-") && !fmtDelta(-45 * MIN).includes("−"));
  });

  test("fmtPct：27%、<1%、0、分母 0", () => {
    assert.equal(fmtPct(27, 100), "27%");
    assert.equal(fmtPct(1, 100), "1%");
    assert.equal(fmtPct(0.9, 100), "<1%");
    assert.equal(fmtPct(0.001, 100), "<1%");
    assert.equal(fmtPct(0, 100), "0%");
    assert.equal(fmtPct(50, 0), "—");
    assert.equal(fmtPct(0, 0), "—");
    assert.equal(fmtPct(100, 100), "100%");
    assert.equal(fmtPct(126, 1000), "13%");
    assert.equal(fmtPct(-5, 100), "0%");
  });
});

/* ───────── 12. 純度牙齒 ───────── */

describe("12. 純度牙齒", () => {
  test("timetableStats.ts 只 import ./timetable.ts 與 ../lib/date.ts（相對路徑帶 .ts）", () => {
    const src = readFileSync(path.join(ROOT, "src/domain/timetableStats.ts"), "utf8");
    const froms = Array.from(src.matchAll(/^import[\s\S]*?from\s+"([^"]+)";/gm)).map((m) => m[1]);
    assert.ok(froms.length > 0);
    assert.deepEqual(Array.from(new Set(froms)).sort(), ["../lib/date.ts", "./timetable.ts"]);
  });

  test("timetableStatsDemo.ts（&tt=stats 示範資料產生器）同樣只 import ./timetable.ts 與 ../lib/date.ts", () => {
    const src = readFileSync(path.join(ROOT, "src/domain/timetableStatsDemo.ts"), "utf8");
    const froms = Array.from(src.matchAll(/^import[\s\S]*?from\s+"([^"]+)";/gm)).map((m) => m[1]);
    assert.deepEqual(Array.from(new Set(froms)).sort(), ["../lib/date.ts", "./timetable.ts"]);
  });

  test("lib/date.ts 與 timetable.ts 本身沒有 import（零依賴鏈）", () => {
    for (const f of ["src/lib/date.ts", "src/domain/timetable.ts"]) {
      const src = readFileSync(path.join(ROOT, f), "utf8");
      const froms = Array.from(src.matchAll(/^import[\s\S]*?from\s+"([^"]+)";/gm)).map((m) => m[1]);
      assert.deepEqual(froms, [], f);
    }
  });
});

/* ───────── 13. 效能 ───────── */

describe("13. 效能", () => {
  /** 10k 塊首尾相接：約 190 天、每天 ~52 塊，涵蓋 6 個月 */
  function bigSpans(n: number, startMs: number): StatsSpan[] {
    const out: StatsSpan[] = [];
    let t = startMs;
    for (let i = 0; i < n; i++) {
      const len = (8 + ((i * 7) % 50)) * MIN; // 8–57 分
      out.push(sp("b" + String(i).padStart(5, "0"), ["c1", "c2", "c3"][i % 3], t, t + len, { routeId: i % 5 === 0 ? "R1" : null }));
      t += len;
    }
    return out;
  }

  test("10k 塊、月趨勢 6 根：windowTotals 全部跑完 < 200ms", () => {
    const now = L(10, 19, 12);
    const spans = bigSpans(10_000, L(4, 15, 6));
    const last = spans[spans.length - 1];
    assert.ok((last.end ?? 0) > L(8, 1), "資料至少涵蓋到 8 月之後");
    const c = classifySpans(spans, now, () => 240);
    const keys = trendKeys("month", "2026-10-01", 1);
    const t0 = performance.now();
    let rec = 0;
    for (const k of keys) {
      const w = periodWindow("month", k, 6, 1);
      rec += windowTotals(spans, c, w, now, (s) => s.routeId ?? ROUTE_NONE).recordedMs;
    }
    const ms = performance.now() - t0;
    console.log(`[perf] 10k 塊 × 月趨勢 6 根 windowTotals：${ms.toFixed(1)} ms（recorded ${(rec / MIN / 60).toFixed(0)}h）`);
    assert.ok(rec > 0);
    assert.ok(ms < 200, `${ms.toFixed(1)}ms 超過 200ms`);
  });

  test("整頁 buildStats（月，含環比、趨勢、路線、占比）10k 塊 < 300ms；日／週也量一下", () => {
    const now = L(10, 19, 12);
    const spans = bigSpans(10_000, L(4, 15, 6));
    for (const p of ["month", "week", "day"] as const) {
      const t0 = performance.now();
      const r = buildStats({ spans, cats: CATS, goals: [], period: p, key: "2026-10-19", now, h: 6, weekStart: 1, thresholdMin: () => 240, routeOf: (s) => s.routeId ?? ROUTE_NONE });
      const ms = performance.now() - t0;
      console.log(`[perf] buildStats(${p})：${ms.toFixed(1)} ms，trend ${r.trend.length} 根`);
      assert.equal(r.trend.length, TREND_COUNT[p]);
      assert.ok(ms < 300, `${p} ${ms.toFixed(1)}ms`);
    }
  });
});

/* ───────── 整頁冒煙 ───────── */

describe("buildStats／buildWeek 冒煙", () => {
  const h = 6;
  const now = L(10, 7, 20); // 週三 20:00
  const spans = [
    // 本週（10/5 週一起）
    sp("m1", "c1", L(10, 5, 8), L(10, 5, 12)), // 4h 創作
    sp("m2", "c3", L(10, 5, 23), L(10, 6, 5)), // 6h 睡覺（跨日界線前，歸 10/5）
    sp("t1", "c2", L(10, 6, 9), L(10, 6, 11)), // 2h 學習
    sp("w1", "c1", L(10, 7, 9), L(10, 7, 10)), // 1h 創作
    // 上週同期（9/28 週一起，到 9/30 20:00）
    sp("p1", "c1", L(9, 28, 8), L(9, 28, 10)), // 2h 創作
    sp("p2", "c3", L(9, 29, 1), L(9, 29, 5)), // 4h 睡覺
    sp("p3", "c1", L(9, 30, 21), L(9, 30, 23)), // 同期之外（9/30 20:00 以後）：不算進同期
  ];

  test("週：已記錄、同期上期、占比分組（頂層含子分類）、環比差", () => {
    const r = buildStats({ spans, cats: CATS, goals: [], period: "week", key: "2026-10-07", now, h, weekStart: 1, thresholdMin: noTh, routeOf: noRoute });
    assert.equal(r.key, "2026-10-05");
    assert.equal(r.isCurrent, true);
    assert.equal(r.compare, "sameSpan");
    assert.equal(r.cur.recordedMs, (4 + 6 + 2 + 1) * 60 * MIN);
    assert.equal(r.prev.recordedMs, (2 + 4) * 60 * MIN, "p3 在上週三 20:00 之後，不在同期");
    assert.equal(r.empty, false);
    assert.equal(r.future, false);
    const g1 = r.groups.find((g) => g.id === "G1")!;
    const g2 = r.groups.find((g) => g.id === "G2")!;
    assert.equal(g1.ms, 7 * 60 * MIN);
    assert.deepEqual(g1.children.map((c) => [c.id, c.ms / MIN]), [["c1", 300], ["c2", 120]]);
    assert.equal(g2.ms, 6 * 60 * MIN);
    assert.deepEqual(r.groups.map((g) => g.id), ["G1", "G2"], "依時數排序");
    assert.equal(g1.prevMs, 2 * 60 * MIN);
    assert.equal(fmtDelta(g1.ms - g1.prevMs), "▲5h");
    // 趨勢：8 根、最後一根＝本期、進行中
    assert.equal(r.trend.length, 8);
    const lastBar = r.trend[7];
    assert.deepEqual([lastBar.isCurrent, lastBar.inProgress, lastBar.key], [true, true, "2026-10-05"]);
    assert.equal(lastBar.byGroup.G1, 7 * 60 * MIN);
    assert.equal(r.trend[6].inProgress, false);
    assert.equal(r.trend[6].key, "2026-09-28");
  });

  test("已過完的期：比上週整週（whole）；沒有紀錄的期 empty；未來的期 future", () => {
    const later = L(10, 19, 12);
    const r = buildStats({ spans, cats: CATS, goals: [], period: "week", key: "2026-10-05", now: later, h, weekStart: 1, thresholdMin: noTh, routeOf: noRoute });
    assert.equal(r.compare, "whole");
    assert.equal(r.isCurrent, false);
    assert.equal(r.prev.recordedMs, (2 + 4 + 2) * 60 * MIN, "整個上週都算（p3 也在）");
    const empty = buildStats({ spans, cats: CATS, goals: [], period: "day", key: "2026-10-15", now: later, h, weekStart: 1, thresholdMin: noTh, routeOf: noRoute });
    assert.equal(empty.empty, true);
    assert.equal(empty.future, false);
    const fut = buildStats({ spans, cats: CATS, goals: [], period: "day", key: "2026-10-30", now: later, h, weekStart: 1, thresholdMin: noTh, routeOf: noRoute });
    assert.equal(fut.future, true);
    assert.equal(fut.cur.effectiveMs, 0);
  });

  test("上期有、本期 0 的分類仍列出（時數 0）", () => {
    const r = buildStats({ spans: [sp("p", "c2", L(9, 29, 8), L(9, 29, 9)), sp("q", "c1", L(10, 6, 8), L(10, 6, 9))], cats: CATS, goals: [], period: "week", key: "2026-10-05", now: L(10, 19, 12), h, weekStart: 1, thresholdMin: noTh, routeOf: noRoute });
    const g1 = r.groups.find((g) => g.id === "G1")!;
    const c2 = g1.children.find((c) => c.id === "c2")!;
    assert.deepEqual([c2.ms, c2.prevMs], [0, 60 * MIN]);
  });

  test("待確認清單：由新到舊、帶整塊時長；摘要的班數＝清單長度", () => {
    const sps = [sp("old", "c1", L(10, 5, 9), L(10, 5, 9) + 10 * 60 * MIN), sp("new", "c1", L(10, 6, 9), L(10, 6, 9) + 6 * 60 * MIN)];
    const r = buildStats({ spans: sps, cats: CATS, goals: [], period: "week", key: "2026-10-05", now, h, weekStart: 1, thresholdMin: () => 240, routeOf: noRoute });
    assert.deepEqual(r.pending.map((p) => p.id), ["new", "old"]);
    assert.equal(r.pending[0].durMs, 6 * 60 * MIN);
    assert.equal(r.cur.pendingIds.length, 2);
    assert.equal(r.cur.recordedMs, 0);
  });

  test("statsFromMs：涵蓋趨勢最早一期、環比上期、目標的上一期", () => {
    const early = statsFromMs("week", "2026-10-19", 6, 1);
    assert.equal(early, L(8, 31, 6), "週趨勢 8 根：10/19 往前 7 週＝8/31 06:00");
    // 目標另算（評審 #4）：statsFromMs 不看目標，goalsFromMs 才看
    assert.equal(statsFromMs("day", "2026-10-19", 6, 1), L(10, 6, 6), "日趨勢 14 根：10/19 往前 13 天");
    assert.equal(statsFromMs("month", "2026-10-19", 6, 1), L(5, 1, 6), "月趨勢 6 根：5/1");
    const now = L(10, 19, 12);
    assert.equal(goalsFromMs([], now, 6, 1), null);
    const g = parseGoal(goalRow({ period: "since", start_on: "2026-01-05" }))!;
    assert.equal(goalsFromMs([g], now, 6, 1), L(1, 5, 6));
    const gm = parseGoal(goalRow({ period: "month", start_on: null }))!;
    assert.equal(goalsFromMs([gm], now, 6, 1), L(9, 1, 6), "月目標＝上個月的開頭");
    const gw = parseGoal(goalRow({ period: "week", start_on: null }))!;
    assert.equal(goalsFromMs([g, gm, gw], now, 6, 1), L(1, 5, 6), "取最早的");
    assert.equal(goalsFromMs([gw], now, 6, 1), L(10, 12, 6), "週目標＝上週一");
  });

  test("buildWeek：7 天、每天 items、欄頭已記錄不含碎塊／待確認、今天標記、pendingIds", () => {
    const sps = [
      sp("a", "c1", L(10, 5, 8), L(10, 5, 10)),
      sp("tiny", "c2", L(10, 5, 10), L(10, 5, 10) + 20_000),
      sp("pend", "c1", L(10, 6, 8), L(10, 6, 8) + 6 * 60 * MIN),
      sp("run", "c2", L(10, 7, 18), null),
    ];
    const wk = buildWeek({ spans: sps, key: "2026-10-07", now, h, weekStart: 1, thresholdMin: () => 240 });
    assert.equal(wk.key, "2026-10-05");
    assert.equal(wk.days.length, 7);
    assert.deepEqual(wk.days.map((d) => d.dateKey), ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11"]);
    assert.equal(wk.days[0].recordedMs, 2 * 60 * MIN, "碎塊不算");
    assert.equal(wk.days[1].recordedMs, 0, "待確認不算已記錄");
    assert.deepEqual(wk.pendingIds, ["pend"]);
    assert.equal(wk.days[2].isToday, true);
    assert.equal(wk.days[2].recordedMs, 2 * 60 * MIN, "運行中算到 now（18:00–20:00）");
    assert.equal(wk.days[3].items.length, 0, "未來的日沒有 gap");
    // 碎塊在軸上照畫（block 項裡找得到 tiny）
    assert.ok(wk.days[0].items.some((i) => i.kind === "block" && i.span.id === "tiny"));
    assert.ok(wk.days[0].items.some((i) => i.kind === "gap"), "空白給「點空白＝補記」用");
    assert.equal(wk.isCurrent, true);
  });

  test("週日起的週：buildWeek 第一天是週日，窗 7 天", () => {
    const wk = buildWeek({ spans: [], key: "2026-10-07", now, h, weekStart: 0, thresholdMin: noTh });
    assert.equal(wk.key, "2026-10-04");
    assert.equal(wk.days[0].dateKey, "2026-10-04");
    assert.equal(wk.days[6].dateKey, "2026-10-10");
  });
});

/* ───────── 甲席修正（評審 #1、#2） ───────── */

describe("14. 評審 #1：面板開的那一塊不在畫面清單裡", () => {
  const row = (id: string): TimeBlockRow => ({
    id,
    category_id: "c1",
    started_at: "2026-10-10T00:00:00.000Z",
    ended_at: "2026-10-10T08:00:00.000Z",
    estimate_min: null,
    node_id: null,
    route_id: null,
    long_run_ack: 0,
    account_id: null,
    device_id: null,
    created_at: "2026-10-10T00:00:00.000Z",
    updated_at: "2026-10-10T00:00:00.000Z",
    synced_at: null,
    deleted_at: null,
  });

  test("sheetBlockIdOf：六種帶 blockId 的 sheet 取得到 id；其餘 null", () => {
    for (const kind of ["longRun", "restart", "edit", "split", "estimate", "link"]) {
      assert.equal(sheetBlockIdOf({ kind, blockId: "b1" } as { kind: string }), "b1", kind);
    }
    for (const sheet of [null, { kind: "depart" }, { kind: "fill", start: 1, end: 2 }, { kind: "categories" }, { kind: "taskCategory", nodeId: "n1" }, { kind: "goal", goalId: "g" }, { kind: "pendingList", from: 1, to: 2 }]) {
      assert.equal(sheetBlockIdOf(sheet), null);
    }
  });

  test("findBlockIn：運行中先、各段依序；清單外的找不到（⇒ 由 store 的 sheetBlock 補）", () => {
    const run = row("run");
    const day = [row("d1")];
    const week = [row("w1"), row("d1")];
    assert.equal(findBlockIn("run", run, [day, week]), run);
    assert.equal(findBlockIn("d1", run, [day, week]), day[0]);
    assert.equal(findBlockIn("w1", null, [day, week]), week[0]);
    assert.equal(findBlockIn("nine-days-ago", run, [day, week]), null);
    assert.equal(findBlockIn("x", null, []), null);
  });
});

describe("15. 評審 #2：&tt=stats 示範資料——待確認 3、碎塊 5，不隨日界線與開啟時刻飄", () => {
  const catByKey = new Map(STARTER_CATEGORIES.map((c) => [c.key, { default_min: c.defaultMin }] as const));
  const measure = (h: number, now: number) => {
    const blocks = buildStatsDemo(h, now, { nodeIds: ["n1", "n2"], routeIds: ["r1"] });
    const spans: StatsSpan[] = blocks.map((b, i) => sp("d" + i, b.key, b.start, b.end, { ack: !!b.ack, nodeId: b.nodeId ?? null, routeId: b.routeId ?? null }));
    const c = classifySpans(spans, now, (s) => thresholdOf(s.estimateMin, catByKey.get(s.categoryId) ?? null, 840)?.min ?? null);
    return { blocks, spans, ...c };
  };

  test("日界線 06:00 與 03:00、不同開啟時刻：待確認 3 塊、碎塊 5 塊（固定釘死）", () => {
    for (const h of [6, 3, 0]) {
      for (let k = 0; k < 40; k++) {
        const now = L(10, 19, 5, 17) + k * 37 * MIN + k * 1500; // 跨一整天多、含剛過整分的秒數
        const r = measure(h, now);
        assert.equal(r.pending.size, 3, `h=${h} k=${k}：待確認 ${r.pending.size}`);
        assert.equal(r.tiny.size, 5, `h=${h} k=${k}：碎塊 ${r.tiny.size}`);
      }
    }
  });

  test("每一塊（除了故意的長時間運行）都不超過分類預設長度的 90%；運行中那班不帶任務連結", () => {
    const now = L(10, 19, 14, 35);
    const { blocks } = measure(6, now);
    const longRun = new Set(["wash", "chore", "play", "sleep"]);
    let checked = 0;
    for (const b of blocks) {
      const end = b.end ?? now;
      const capMin = Math.floor((catByKey.get(b.key)!.default_min as number) * 0.9);
      if (end - b.start > capMin * MIN) {
        assert.ok(longRun.has(b.key), `${b.key} ${((end - b.start) / MIN).toFixed(0)} 分超過 ${capMin}`);
        continue;
      }
      checked++;
    }
    assert.ok(checked > 500);
    const last = blocks[blocks.length - 1];
    if (last.end === null) assert.equal(last.nodeId ?? null, null);
  });
});

/* ───────── 甲席修正（評審 #4～#10、#12） ───────── */

describe("16. 評審 #6：待確認塊整段被較晚開始的塊蓋住，班數仍計入", () => {
  test("被蓋住的待確認塊：pendingIds／pendingByCategory 計一班、時數 0；一塊被切成兩片只算一班", () => {
    const now = L(10, 19, 12);
    const w = { start: L(10, 19, 6), end: L(10, 20, 6) };
    // covered 06:30–10:30（待確認）整段被開始較晚的 late 06:20–11:00 蓋住
    const covered = sp("covered", "c1", L(10, 19, 6, 30), L(10, 19, 10, 30));
    const late = sp("late", "c2", L(10, 19, 6, 20), L(10, 19, 11, 0));
    // splitme 07:00–運行中（待確認）被 mid 09:00–09:30 從中間切開
    const sidx = sp("splitme", "c1", L(10, 19, 7, 0), null);
    const mid = sp("mid", "c2", L(10, 19, 9, 0), L(10, 19, 9, 30));
    const spans = [late, covered, sidx, mid].sort((a, b) => a.start - b.start);
    const c = cls(spans, now, (s) => (s.id === "covered" || s.id === "splitme" ? 60 : null));
    assert.deepEqual([...c.pending].sort(), ["covered", "splitme"]);
    const t = windowTotals(spans, c, w, now, noRoute);
    assert.deepEqual([...t.pendingIds].sort(), ["covered", "splitme"], "每塊只出現一次");
    assert.equal(t.pendingByCategory["c1"].count, 2);
    assert.ok(t.pendingMs > 0);
    const only = windowTotals([late, covered], cls([late, covered], now, (s) => (s.id === "covered" ? 60 : null)), w, now, noRoute);
    assert.deepEqual(only.pendingIds, ["covered"]);
    assert.equal(only.pendingByCategory["c1"].count, 1);
    assert.equal(only.pendingByCategory["c1"].ms, only.pendingMs);
  });

  test("與窗不相交的待確認塊不計", () => {
    const now = L(10, 19, 12);
    const far = sp("far", "c1", L(10, 10, 6), L(10, 10, 20));
    const c = cls([far], now, () => 60);
    const t = windowTotals([far], c, { start: L(10, 19, 6), end: L(10, 20, 6) }, now, noRoute);
    assert.deepEqual(t.pendingIds, []);
    assert.deepEqual(t.pendingByCategory, {});
  });
});

describe("17. 評審 #7：看哪一期存參考日，設定來回改不漂移", () => {
  const today = "2026-10-19"; // 週一
  test("resolveViewKey：週一起 → 週日起 → 週一起，回到同一週（10/5 週一）", () => {
    assert.equal(resolveViewKey("week", false, "2026-10-05", today, 6, 1), "2026-10-05");
    assert.equal(resolveViewKey("week", false, "2026-10-05", today, 6, 0), "2026-10-04", "週日起：10/5 在 10/4 那週");
    assert.equal(resolveViewKey("week", false, "2026-10-05", today, 6, 1), "2026-10-05", "改回來＝同一週");
    // 舊寫法（把對齊後的 key 寫回）會漂移：10/5 → 10/4 → 週一起 ⇒ 9/28
    assert.equal(weekStartKey(weekStartKey("2026-10-05", 0), 1), "2026-09-28");
  });
  test("resolveViewKey：follow 一律是今天所在的期；參考日在未來也夾到本期", () => {
    assert.equal(resolveViewKey("week", true, "2026-01-01", today, 6, 1), "2026-10-19");
    assert.equal(resolveViewKey("month", true, "2026-01-01", today, 6, 1), "2026-10-01");
    assert.equal(resolveViewKey("week", false, "2026-12-01", today, 6, 1), "2026-10-19");
    assert.equal(resolveViewKey("day", false, "2026-10-12", today, 3, 1), "2026-10-12");
  });
  test("stepView：往前、往後、到本期停、已經在本期再往後 ⇒ null；回傳的 ref 是新一期第一天", () => {
    const back = stepView("week", true, "2026-10-19", today, -1, 6, 1)!;
    assert.deepEqual(back, { ref: "2026-10-12", follow: false, key: "2026-10-12" });
    const back2 = stepView("week", false, back.ref, today, -1, 6, 1)!;
    assert.equal(back2.key, "2026-10-05");
    const fwd = stepView("week", false, back2.ref, today, 2, 6, 1)!;
    assert.deepEqual(fwd, { ref: "2026-10-19", follow: true, key: "2026-10-19" }, "翻到本期就算停在本期");
    assert.equal(stepView("week", true, "2026-10-19", today, 1, 6, 1), null, "本期不能再往後");
    assert.equal(stepView("week", false, "2026-10-12", today, 5, 6, 1)!.key, "2026-10-19", "翻太多也夾在本期");
    // 參考日 10/5（週一起的那週）在週日起的設定下往前翻一週：10/4 那週的前一週＝9/27
    assert.equal(stepView("week", false, "2026-10-05", today, -1, 6, 0)!.key, "2026-09-27");
    assert.equal(stepView("month", false, "2026-09-15", today, 1, 6, 1)!.key, "2026-10-01");
    assert.equal(stepView("day", true, today, today, -1, 3, 1)!.key, "2026-10-18");
  });
});

describe("17b. 評審 #12：換日（#72）、停在本期／翻到過去、作廢結果", () => {
  test("換日：停在本期的跟著換（key 變）、翻到過去的留在原地；跨過 03:00 日界線才算換日", () => {
    // 週視圖／統計「停在本期」：10/19（週一）→ 10/20 仍同一週；10/26（下週一）才換週
    assert.equal(resolveViewKey("week", true, "2026-10-19", "2026-10-20", 6, 1), "2026-10-19");
    assert.equal(resolveViewKey("week", true, "2026-10-19", "2026-10-26", 6, 1), "2026-10-26");
    assert.equal(resolveViewKey("day", true, "2026-10-19", "2026-10-20", 6, 1), "2026-10-20");
    assert.equal(resolveViewKey("month", true, "2026-10-01", "2026-11-01", 6, 1), "2026-11-01");
    // 翻到 10/5 那週的，換日後還在 10/5 那週
    assert.equal(resolveViewKey("week", false, "2026-10-05", "2026-10-26", 6, 1), "2026-10-05");
    // 日界線 03:00：本地 10/20 02:30 仍是 10/19；03:30 才是 10/20
    assert.equal(todayKey(3, new Date(2026, 9, 20, 2, 30)), "2026-10-19");
    assert.equal(todayKey(3, new Date(2026, 9, 20, 3, 30)), "2026-10-20");
    assert.equal(dayRolledOver("2026-10-19", todayKey(3, new Date(2026, 9, 20, 2, 30))), false);
    assert.equal(dayRolledOver("2026-10-19", todayKey(3, new Date(2026, 9, 20, 3, 30))), true);
    assert.equal(dayRolledOver(null, "2026-10-20"), false, "還沒算過 ⇒ 不用比");
  });
  test("作廢結果：開算後 period／follow／翻到的期任一個變了 ⇒ 作廢；沒變 ⇒ 留", () => {
    const today = "2026-10-19";
    const computed = { period: "week" as const, follow: false, key: "2026-10-05" };
    const same = { period: "week" as const, follow: false, ref: "2026-10-05" };
    assert.equal(viewChangedSince(computed, same, today, 6, 1), false);
    assert.equal(viewChangedSince(computed, { ...same, ref: "2026-10-08" }, today, 6, 1), false, "參考日換成同一週的別天不算變");
    assert.equal(viewChangedSince(computed, { ...same, ref: "2026-10-12" }, today, 6, 1), true, "翻到別週");
    assert.equal(viewChangedSince(computed, { ...same, period: "month" }, today, 6, 1), true);
    assert.equal(viewChangedSince(computed, { ...same, follow: true }, today, 6, 1), true);
    assert.equal(viewChangedSince(computed, same, today, 6, 0), true, "週起點改了、同一個參考日對齊出別週 ⇒ 舊結果作廢（下一趟已排）");
  });
});

describe("18. 評審 #10：nodeStore 變動只在窗內節點的路線解法變了才作廢", () => {
  const n = (id: string, kind: string, route: string | null, deleted: string | null = null) => ({ id, kind, route_id: route, deleted_at: deleted });
  const cache = new Map<string, NodeRoute>([
    ["t1", { gone: false, routeId: "R1" }],
    ["t2", { gone: false, routeId: "R1" }],
    ["gone", { gone: true, routeId: null }],
    ["far", { gone: false, routeId: "R9" }],
  ]);
  test("改名／換順序等無關欄位 ⇒ 沒有要作廢的", () => {
    const prev = { t1: n("t1", "ticket", "R1"), t2: n("t2", "ticket", "R1") };
    const next = { t1: { ...n("t1", "ticket", "R1") }, t2: { ...n("t2", "ticket", "R1") } };
    assert.deepEqual(staleNodeIds(cache.keys(), cache, prev, next), []);
  });
  test("搬到別的路線、刪除、從樹裡消失 ⇒ 作廢；不在樹裡的（getNode 讀來的）維持快取", () => {
    const prev = { t1: n("t1", "ticket", "R1"), t2: n("t2", "ticket", "R1") };
    const next = { t1: n("t1", "ticket", "R2"), t2: n("t2", "ticket", "R1", "2026-10-19T00:00:00.000Z") };
    assert.deepEqual(staleNodeIds(cache.keys(), cache, prev, next).sort(), ["t1", "t2"]);
    assert.deepEqual(staleNodeIds(["t1", "far"], cache, prev, {}), ["t1"], "t1 本來在樹裡、現在不在 ⇒ 重解；far 兩邊都不在 ⇒ 不動");
    assert.deepEqual(staleNodeIds(["gone"], cache, {}, { gone: n("gone", "ticket", "R1") }), ["gone"], "本來找不到、現在樹裡有了 ⇒ 重解");
    assert.deepEqual(staleNodeIds(["r"], new Map([["r", { gone: false, routeId: "r" }]]), {}, { r: n("r", "route", null) }), [], "路線節點的路線＝自己");
  });
  test("routesChanged：只看用到的路線的名字與刪除狀態", () => {
    const r = (id: string, name: string, del: string | null = null) => ({ id, name, deleted_at: del });
    const prev = [r("R1", "學期"), r("R2", "家")];
    assert.equal(routesChanged(["R1"], prev, [r("R1", "學期"), r("R2", "新名字")]), false, "沒用到的路線改名不算");
    assert.equal(routesChanged(["R1"], prev, [r("R1", "學期二"), r("R2", "家")]), true);
    assert.equal(routesChanged(["R2"], prev, [r("R1", "學期"), r("R2", "家", "2026-10-19T00:00:00.000Z")]), true);
    assert.equal(routesChanged(["R1"], prev, [r("R2", "家")]), true, "路線不見了");
    assert.equal(routesChanged([], prev, []), false);
  });
});

describe("19. 評審 #12：週起點 0／日界線 03:00 下的環比、趨勢、週目標窗", () => {
  test("trendKeys：週日起，8 根由舊到新，最後一根是 10/18（週日）", () => {
    assert.deepEqual(trendKeys("week", "2026-10-21", 0), ["2026-08-30", "2026-09-06", "2026-09-13", "2026-09-20", "2026-09-27", "2026-10-04", "2026-10-11", "2026-10-18"]);
  });
  test("compareWindow：週日起、03:00，本週三 12:00 比上週同一刻（週日 03:00 起算 3 天 9 小時）", () => {
    const cur = periodWindow("week", "2026-10-21", 3, 0);
    assert.deepEqual([cur.key, cur.start, cur.end], ["2026-10-18", L(10, 18, 3), L(10, 25, 3)]);
    const c = compareWindow("week", cur, L(10, 21, 12), 3, 0);
    assert.equal(c.compare, "sameSpan");
    assert.deepEqual(c.prev, { start: L(10, 11, 3), end: L(10, 14, 12) });
  });
  test("compareWindow：03:00 日界線，10/31 凌晨 02:00 仍屬 10/30 的月內（已過 29 天 23 小時），上月同一刻＝10/1 02:00（未超過上月尾 03:00）", () => {
    const cur = periodWindow("month", "2026-10-30", 3, 1);
    const c = compareWindow("month", cur, L(10, 31, 2), 3, 1);
    assert.equal(c.compare, "sameSpan");
    assert.deepEqual(c.prev, { start: L(9, 1, 3), end: L(10, 1, 2) });
  });
  test("週目標的窗：週日起 ⇒ 10/18–10/25 與上一整週；週一起 ⇒ 10/19–10/26", () => {
    const g = parseGoal(goalRow({ period: "week", start_on: null }), 3)!;
    assert.deepEqual(goalWindow(g, "2026-10-21", 3, 0), { start: L(10, 18, 3), end: L(10, 25, 3), state: "active" });
    assert.deepEqual(goalPrevWindow(g, "2026-10-21", 3, 0), { start: L(10, 11, 3), end: L(10, 18, 3) });
    assert.deepEqual(goalWindow(g, "2026-10-21", 3, 1), { start: L(10, 19, 3), end: L(10, 26, 3), state: "active" });
    assert.deepEqual(goalPrevWindow(g, "2026-10-21", 3, 1), { start: L(10, 12, 3), end: L(10, 19, 3) });
  });
});

describe("20. 評審 #4：since 起點一年前的目標，不把整段歷史拉進統計", () => {
  test("statsFromMs 與目標無關；10k 塊、since 一年前：buildGoals 量時間，統計窗只涵蓋趨勢那段", () => {
    const now = L(10, 19, 12);
    const goal = parseGoal(goalRow({ period: "since", start_on: "2025-10-19", scope: goalScopeJson(["G1"]), target_min: 1000 * 60 }), 6)!;
    const gFrom = goalsFromMs([goal], now, 6, 1)!;
    assert.equal(gFrom, new Date(2025, 9, 19, 6).getTime(), "一年前 06:00");
    const statsFrom = statsFromMs("week", "2026-10-19", 6, 1);
    assert.equal(statsFrom, L(8, 31, 6));
    assert.ok(statsFrom - gFrom > 300 * 24 * 60 * MIN, "目標要的歷史比統計窗早 300 天以上");
    // 10k 塊首尾相接，約 14 個月
    const spans: StatsSpan[] = [];
    let t = new Date(2025, 8, 1, 6).getTime();
    for (let i = 0; i < 10_000; i++) {
      const len = (30 + ((i * 7) % 80)) * MIN; // 30–109 分
      spans.push(sp("b" + String(i).padStart(5, "0"), ["c1", "c2", "c3"][i % 3], t, t + len, { nodeId: "n" + (i % 200), routeId: i % 5 === 0 ? "R1" : null }));
      t += len;
    }
    const last = spans[spans.length - 1];
    assert.ok((last.end ?? 0) > now, "資料涵蓋到現在");
    const inStats = spans.filter((s) => (s.end ?? now) > statsFrom && s.start < now);
    const inGoal = spans.filter((s) => (s.end ?? now) > gFrom && s.start < now);
    const nodesStats = new Set(inStats.map((s) => s.nodeId)).size;
    const t0 = performance.now();
    const views = buildGoals([goal], spans, CATS, { now, h: 6, weekStart: 1, thresholdMin: () => 240 });
    const ms = performance.now() - t0;
    console.log(`[perf] since 一年前、10k 塊：buildGoals ${ms.toFixed(1)} ms；統計窗內 ${inStats.length} 塊（解節點最多 ${nodesStats} 個）／目標窗內 ${inGoal.length} 塊（不解節點）`);
    assert.equal(views.length, 1);
    assert.ok(views[0].cur.ms > 0);
    assert.ok(inStats.length < inGoal.length / 3, "統計窗內的塊遠少於目標窗");
    assert.ok(ms < 300, `${ms.toFixed(1)}ms`);
  });
});
