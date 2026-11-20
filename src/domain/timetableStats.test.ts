/**
 * v1.33 第三梯 3B・時刻表深度統計進化單元測試
 * 涵蓋：
 *   1. 功能 1：執行次數（N 次）統計（依分類／依路線／依 #荷札／未掛荷札、碎塊與待確認排除、重疊切片單塊不重複計次）與依時數｜依次數切換排序
 *   2. 操作 2：依路線原地樹狀手風琴展開（路線 › 支線 › 列車 › 車廂 › 車票 ＋ 路線直屬／容器直屬／已刪除項目歸戶），驗證各層級加總嚴格不漏算、不重算
 *   3. 功能 2 ＋ G1：釘選自訂統計專題卡 ＆ 18:00 獨立切日線（跨午夜 23:30→07:30、凌晨後入睡 01:30→08:30、跨全域 06:00 皆完整歸入同一睡眠營業日，跨 18:00 則切入兩睡眠日）
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { MIN, type TimeCategoryRow } from "./timetable.ts";
import {
  ROUTE_GONE,
  ROUTE_NONE,
  ROUTE_NOROUTE,
  buildRouteTrees,
  buildStatTopics,
  buildStats,
  classifySpans,
  fmtCountDelta,
  normalizeStatTopicInput,
  parseStatTopic,
  routeKeyOf,
  serializeTopicScope,
  sortRouteShares,
  sortRouteTreeNodes,
  sortShareGroups,
  sortTagShareRows,
  topicsEndMs,
  topicsFromMs,
  windowTotals,
  type NodeRoute,
  type RouteTreeNode,
  type RouteTreeNodeInput,
  type StatTopicRowLike,
  type StatsSpan,
  type StatsTagRow,
} from "./timetableStats.ts";

/** 本地 (月, 日, 時, 分) 時間戳（2026 年） */
const L = (m: number, d: number, h = 0, mi = 0): number => new Date(2026, m - 1, d, h, mi).getTime();

const sp = (id: string, cat: string, start: number, end: number | null, o: Partial<StatsSpan> = {}): StatsSpan => ({
  id,
  categoryId: cat,
  start,
  end,
  ack: false,
  estimateMin: null,
  nodeId: null,
  routeId: null,
  tagKeys: [],
  ...o,
});

const cat = (id: string, parent: string | null, name: string, position = 0): TimeCategoryRow => ({
  id,
  parent_id: parent,
  name,
  glyph: null,
  color_idx: 1,
  position,
  default_min: null,
  archived_at: null,
  account_id: null,
  device_id: null,
  created_at: "2026-10-01T00:00:00.000Z",
  updated_at: "2026-10-01T00:00:00.000Z",
  synced_at: null,
  deleted_at: null,
});

const CATS: TimeCategoryRow[] = [
  cat("G1", null, "本務", 0),
  cat("G2", null, "生活", 1),
  cat("c-code", "G1", "寫程式", 0),
  cat("c-jp", "G1", "讀日文", 1),
  cat("c-sleep", "G2", "睡眠", 0),
];

describe("1. 執行次數（N 次）統計與依時數｜依次數排序切換", () => {
  test("windowTotals & buildStats：分類、路線、荷札與未掛荷札皆正確計算次數；重疊切兩片只計 1 次；碎塊與待確認不計入", () => {
    const now = L(11, 18, 20, 0);
    // 1. longCode: 08:00-12:00（被 midJp 09:30-10:00 從中間切開成兩段，但仍是同一時間塊 ⇒ 1 次，3.5h）
    // 2. midJp: 09:30-10:00（1 次，30m）
    // 3. jp2: 13:00-13:20（1 次，20m）
    // 4. jp3: 14:00-14:15（1 次，15m）
    // 5. tiny: 15:00-15:00:45（45s 碎塊 ⇒ 不計時數也不計次）
    // 6. pending: 16:00-19:30（超過 180m 門檻未確認 ⇒ 待確認，不計入已記錄次數）
    const spans: StatsSpan[] = [
      sp("longCode", "c-code", L(11, 18, 8, 0), L(11, 18, 12, 0), {
        routeId: "R-DEV",
        tagKeys: ["專注/深度", "專注"],
      }),
      sp("midJp", "c-jp", L(11, 18, 9, 30), L(11, 18, 10, 0), {
        routeId: "R-JP",
        tagKeys: ["日文/單字"],
      }),
      sp("jp2", "c-jp", L(11, 18, 13, 0), L(11, 18, 13, 20), {
        routeId: "R-JP",
        tagKeys: ["日文/文法"],
      }),
      sp("jp3", "c-jp", L(11, 18, 14, 0), L(11, 18, 14, 15), {
        routeId: "R-JP",
        tagKeys: [],
      }),
      sp("tiny", "c-jp", L(11, 18, 15, 0), L(11, 18, 15, 0) + 45_000, {
        routeId: "R-JP",
      }),
      sp("pending", "c-code", L(11, 18, 16, 0), L(11, 18, 19, 30), {
        routeId: "R-DEV",
      }),
    ];

    const th = (s: StatsSpan): number | null => (s.id === "pending" ? 180 : null);
    const r = buildStats({
      spans,
      cats: CATS,
      goals: [],
      period: "day",
      key: "2026-11-18",
      now,
      h: 6,
      weekStart: 1,
      thresholdMin: th,
      routeOf: (s) => s.routeId ?? ROUTE_NONE,
      tagRows: (cur, prev) => [
        { key: "專注", name: "專注", seg: "專注", depth: 1, parent: null, hasKids: true, real: true, ms: cur["專注"] ?? 0, prevMs: prev["專注"] ?? 0 },
        { key: "專注/深度", name: "專注/深度", seg: "深度", depth: 2, parent: "專注", hasKids: false, real: true, ms: cur["專注/深度"] ?? 0, prevMs: prev["專注/深度"] ?? 0 },
        { key: "日文", name: "日文", seg: "日文", depth: 1, parent: null, hasKids: true, real: false, ms: cur["日文"] ?? 0, prevMs: prev["日文"] ?? 0 },
        { key: "日文/單字", name: "日文/單字", seg: "單字", depth: 2, parent: "日文", hasKids: false, real: true, ms: cur["日文/單字"] ?? 0, prevMs: prev["日文/單字"] ?? 0 },
        { key: "日文/文法", name: "日文/文法", seg: "文法", depth: 2, parent: "日文", hasKids: false, real: true, ms: cur["日文/文法"] ?? 0, prevMs: prev["日文/文法"] ?? 0 },
      ],
    });

    assert.equal(r.cur.recordedCount, 4, "longCode + midJp + jp2 + jp3 共 4 次");
    assert.equal(r.cur.countByCategory["c-code"], 1, "longCode 被切開仍只算 1 次");
    assert.equal(r.cur.countByCategory["c-jp"], 3, "midJp + jp2 + jp3 共 3 次");
    assert.equal(r.cur.byCategory["c-code"], 210 * MIN, "3.5 小時");
    assert.equal(r.cur.byCategory["c-jp"], 65 * MIN, "30 + 20 + 15 = 65 分");

    // 頂層分類群組次數加總與排序切換
    const g1 = r.groups.find((g) => g.id === "G1")!;
    assert.equal(g1.count, 4);
    // 預設依時數：c-code (210m, 1次) > c-jp (65m, 3次)
    assert.deepEqual(g1.children.map((c) => c.id), ["c-code", "c-jp"]);
    // 切換依次數：c-jp (3次) > c-code (1次)
    const byCountGroups = sortShareGroups(r.groups, "count", CATS);
    assert.deepEqual(byCountGroups[0].children.map((c) => c.id), ["c-jp", "c-code"]);

    // 路線排序切換：依時數 R-DEV (210m, 1次) > R-JP (65m, 3次)；依次數 R-JP > R-DEV
    assert.deepEqual(r.routes.map((x) => [x.key, x.count]), [["R-DEV", 1], ["R-JP", 3]]);
    const byCountRoutes = sortRouteShares(r.routes, "count");
    assert.deepEqual(byCountRoutes.map((x) => [x.key, x.count]), [["R-JP", 3], ["R-DEV", 1]]);

    // 荷札樹狀次數與排序切換：父層「日文」含兩塊不同子荷札＝2 次；「專注」同塊同時掛父子只算 1 次
    const tagByKey = new Map<string, StatsTagRow>(r.tags.map((t) => [t.key, t]));
    assert.equal(tagByKey.get("專注")!.count, 1);
    assert.equal(tagByKey.get("日文")!.count, 2);
    assert.equal(r.cur.untaggedCount, 1, "jp3 未掛荷札＝1 次");

    const tagsByMs = sortTagShareRows(r.tags, "ms");
    assert.deepEqual(tagsByMs.map((t) => t.key), ["專注", "專注/深度", "日文", "日文/單字", "日文/文法"]);
    const tagsByCount = sortTagShareRows(r.tags, "count");
    assert.deepEqual(tagsByCount.map((t) => t.key), ["日文", "日文/單字", "日文/文法", "專注", "專注/深度"]);

    assert.equal(fmtCountDelta(3), "▲3次");
    assert.equal(fmtCountDelta(-2), "▼2次");
    assert.equal(fmtCountDelta(0), "持平");
  });

  test("sortRouteShares：無論依時數或依次數，特殊桶（無路線任務／已刪除任務／沒連任務）永遠排在真實路線之後", () => {
    const rows = [
      { key: ROUTE_NONE, ms: 500 * MIN, prevMs: 0, count: 20, prevCount: 0 },
      { key: ROUTE_NOROUTE, ms: 200 * MIN, prevMs: 0, count: 10, prevCount: 0 },
      { key: ROUTE_GONE, ms: 100 * MIN, prevMs: 0, count: 8, prevCount: 0 },
      { key: "R-A", ms: 120 * MIN, prevMs: 0, count: 1, prevCount: 0 },
      { key: "R-B", ms: 30 * MIN, prevMs: 0, count: 4, prevCount: 0 },
    ];
    assert.deepEqual(sortRouteShares(rows, "ms").map((r) => r.key), [
      "R-A",
      "R-B",
      ROUTE_NOROUTE,
      ROUTE_GONE,
      ROUTE_NONE,
    ]);
    assert.deepEqual(sortRouteShares(rows, "count").map((r) => r.key), [
      "R-B",
      "R-A",
      ROUTE_NOROUTE,
      ROUTE_GONE,
      ROUTE_NONE,
    ]);
  });
});

describe("2. 依路線原地樹狀手風琴展開（路線 › 支線 › 列車 › 車廂 › 車票）加總嚴格不重不漏", () => {
  const mkNode = (
    id: string,
    kind: string,
    name: string,
    parentId: string | null,
    position = 0,
    deletedAt: string | null = null,
  ): RouteTreeNodeInput => ({
    id,
    route_id: "R1",
    parent_id: parentId,
    kind,
    name,
    position,
    status: "todo",
    deleted_at: deletedAt,
  });

  /** 遞迴驗證每個展開父節點的直接子列加總 === 父節點自身的 ms 與 count */
  function assertTreeExactPartition(nodes: readonly RouteTreeNode[], expectedMs: number, expectedCount: number): void {
    const sumMs = nodes.reduce((acc, n) => acc + n.ms, 0);
    const sumCount = nodes.reduce((acc, n) => acc + n.count, 0);
    assert.equal(sumMs, expectedMs, "頂層子列時數加總須嚴格等於路線總時數");
    assert.equal(sumCount, expectedCount, "頂層子列次數加總須嚴格等於路線總次數");

    const checkNode = (n: RouteTreeNode): void => {
      if (n.children.length > 0) {
        const childMs = n.children.reduce((acc, c) => acc + c.ms, 0);
        const childCount = n.children.reduce((acc, c) => acc + c.count, 0);
        assert.equal(childMs, n.ms, `${n.name} 子列時數加總須等於本層時數`);
        assert.equal(childCount, n.count, `${n.name} 子列次數加總須等於本層次數`);
        for (const c of n.children) checkNode(c);
      }
    };
    for (const n of nodes) checkNode(n);
  }

  test("完整五層階層 ＋ 容器直屬紀錄 ＋ 路線直屬臨時班次 ＋ 掛路線臨時車票 ＋ 已刪車票：層層加總 100% 吻合", () => {
    const now = L(11, 18, 22, 0);
    const nodesR1: RouteTreeNodeInput[] = [
      mkNode("B1", "branch", "後端支線", "R1", 0),
      mkNode("T1", "train", "API 列車", "B1", 0),
      mkNode("C1", "car", "認證車廂", "T1", 0),
      mkNode("K1", "ticket", "JWT 簽發車票", "C1", 0),
      mkNode("K2", "ticket", "Refresh 車票", "C1", 1),
      mkNode("B-EMPTY", "branch", "空支線（0 時數不應出現）", "R1", 1),
      mkNode("K-TEMP", "ticket", "路線臨時車票", null, 2), // parent_id === null, route_id === R1
      mkNode("K-DEL", "ticket", "已刪除車票", "C1", 3, "2026-11-18T10:00:00.000Z"),
    ];

    const nodeRouteMap = new Map<string, NodeRoute>([
      ["K1", { gone: false, routeId: "R1" }],
      ["K2", { gone: false, routeId: "R1" }],
      ["T1", { gone: false, routeId: "R1" }],
      ["K-TEMP", { gone: false, routeId: "R1" }],
      ["K-DEL", { gone: true, routeId: null }],
    ]);
    const routeOf = (s: StatsSpan): string =>
      routeKeyOf(s, s.nodeId === null ? undefined : nodeRouteMap.get(s.nodeId));

    const spans: StatsSpan[] = [
      // K1: 2 筆，共 90m
      sp("s1", "c-code", L(11, 18, 8, 0), L(11, 18, 9, 0), { nodeId: "K1", routeId: "R1" }),
      sp("s2", "c-code", L(11, 18, 9, 0), L(11, 18, 9, 30), { nodeId: "K1", routeId: "R1" }),
      // K2: 3 筆，共 45m
      sp("s3", "c-code", L(11, 18, 10, 0), L(11, 18, 10, 15), { nodeId: "K2", routeId: "R1" }),
      sp("s4", "c-code", L(11, 18, 10, 15), L(11, 18, 10, 30), { nodeId: "K2", routeId: "R1" }),
      sp("s5", "c-code", L(11, 18, 10, 30), L(11, 18, 10, 45), { nodeId: "K2", routeId: "R1" }),
      // T1 列車本身也有 1 筆直屬時間塊：30m
      sp("s6", "c-code", L(11, 18, 11, 0), L(11, 18, 11, 30), { nodeId: "T1", routeId: "R1" }),
      // 路線臨時車票 K-TEMP：1 筆，20m
      sp("s7", "c-code", L(11, 18, 13, 0), L(11, 18, 13, 20), { nodeId: "K-TEMP", routeId: "R1" }),
      // 路線直屬（臨時班次／未指定車票）：1 筆，40m
      sp("s8", "c-code", L(11, 18, 14, 0), L(11, 18, 14, 40), { nodeId: null, routeId: "R1" }),
      // 已刪除車票（塊上仍帶 routeId="R1"）：1 筆，25m
      sp("s9", "c-code", L(11, 18, 15, 0), L(11, 18, 15, 25), { nodeId: "K-DEL", routeId: "R1" }),
    ];

    const r = buildStats({
      spans,
      cats: CATS,
      goals: [],
      period: "day",
      key: "2026-11-18",
      now,
      h: 6,
      weekStart: 1,
      thresholdMin: () => null,
      routeOf,
      nodesByRoute: { R1: nodesR1 },
    });

    const routeRow = r.routes.find((x) => x.key === "R1")!;
    assert.equal(routeRow.ms, (90 + 45 + 30 + 20 + 40 + 25) * MIN, "250 分鐘");
    assert.equal(routeRow.count, 9, "共 9 次");

    const tree = r.routeTrees["R1"];
    assert.ok(tree && tree.length === 4, "後端支線 + 路線臨時車票 + 路線直屬 + 已刪除項目");
    assertTreeExactPartition(tree, routeRow.ms, routeRow.count);

    // 檢查五層結構：B1 (165m, 6次) › T1 (165m, 6次) › [C1 (135m, 5次), 直屬紀錄 (30m, 1次)]
    const b1 = tree.find((n) => n.id === "B1")!;
    assert.equal(b1.ms, 165 * MIN);
    assert.equal(b1.count, 6);
    const t1 = b1.children[0];
    assert.equal(t1.id, "T1");
    assert.equal(t1.ms, 165 * MIN);
    assert.equal(t1.count, 6);
    assert.deepEqual(t1.children.map((c) => [c.id, c.ms / MIN, c.count]), [
      ["C1", 135, 5],
      ["T1:__direct__", 30, 1],
    ]);

    const c1 = t1.children[0];
    // 依時數：K1 (90m, 2次) > K2 (45m, 3次)
    assert.deepEqual(c1.children.map((k) => [k.id, k.ms / MIN, k.count]), [
      ["K1", 90, 2],
      ["K2", 45, 3],
    ]);
    // 切換依次數：K2 (3次) > K1 (2次)，且真實節點仍在 direct 與 gone 之前
    const treeByCount = sortRouteTreeNodes(tree, "count");
    assertTreeExactPartition(treeByCount, routeRow.ms, routeRow.count);
    const c1ByCount = treeByCount.find((n) => n.id === "B1")!.children[0].children[0];
    assert.deepEqual(c1ByCount.children.map((k) => k.id), ["K2", "K1"]);

    // 臨時車票標記
    const tempTicket = tree.find((n) => n.id === "K-TEMP")!;
    assert.equal(tempTicket.isTempTicket, true);

    // buildRouteTrees 獨立呼叫結果一致
    const standalone = buildRouteTrees({
      spans,
      period: "day",
      key: "2026-11-18",
      now,
      h: 6,
      weekStart: 1,
      thresholdMin: () => null,
      routeOf,
      nodesByRoute: { R1: nodesR1 },
    });
    assert.deepEqual(standalone, r.routeTrees);
  });
});

describe("3. 釘選自訂統計專題 ＆ 18:00 獨立切日線（G1 睡眠觀察）", () => {
  const mkTopicRow = (o: Partial<StatTopicRowLike> = {}): StatTopicRowLike => ({
    id: "topic-sleep",
    name: "🌙 睡眠觀察",
    scope: serializeTopicScope({ categoryIds: ["c-sleep"], tagNames: ["#睡眠"] }),
    day_start_hour: 18,
    position: 0,
    archived_at: null,
    deleted_at: null,
    ...o,
  });

  test("normalizeStatTopicInput & parseStatTopic：欄位驗證、荷札正規化與前向相容", () => {
    const norm = normalizeStatTopicInput({
      name: "  🌙 睡眠觀察  ",
      categoryIds: ["c-sleep", "c-sleep"],
      routeIds: ["R1"],
      nodeIds: ["N1"],
      tagNames: ["#Sleep/Deep", "sleep/deep", "#好眠"],
      dayStartHour: 18,
    });
    assert.equal(norm.name, "🌙 睡眠觀察");
    assert.deepEqual(norm.categoryIds, ["c-sleep"]);
    assert.deepEqual(norm.tagNames, ["Sleep/Deep", "好眠"], "依大小寫無關 key 去重並保留首次顯示名");
    assert.equal(norm.dayStartHour, 18);

    const parsed = parseStatTopic(mkTopicRow({ scope: norm.scope, day_start_hour: 18 }))!;
    assert.deepEqual(parsed.tagKeys, ["sleep/deep", "好眠"]);
    assert.deepEqual(parsed.tagNames, ["Sleep/Deep", "好眠"]);
    assert.equal(parsed.dayStartHour, 18);

    // 跟隨全域（dayStartHour = null）
    const followGlobal = parseStatTopic(mkTopicRow({ day_start_hour: null }))!;
    assert.equal(followGlobal.dayStartHour, null);

    // 錯誤輸入阻擋
    assert.throws(
      () => normalizeStatTopicInput({ name: "", categoryIds: ["c-sleep"], dayStartHour: null }),
      /專題名稱/,
    );
    assert.throws(
      () => normalizeStatTopicInput({ name: "空範圍", categoryIds: [], dayStartHour: null }),
      /至少一個/,
    );
    assert.throws(
      () => normalizeStatTopicInput({ name: "壞切日", categoryIds: ["c-sleep"], dayStartHour: 24 }),
      /00:00～23:00/,
    );
    // 未來版本 v=99 溫和回傳 null
    assert.equal(parseStatTopic(mkTopicRow({ scope: '{"v":99,"cats":["c-sleep"]}' })), null);
  });

  test("18:00 睡眠切日線 vs 全域 06:00：昨晚 23:30→07:30 與凌晨 01:30→08:30 皆完整歸入同一睡眠日，不因 06:00 切碎", () => {
    // 情境：2026-11-18（週三）上午 10:00 起床看統計（全域 h = 6，週一為週起點）
    const now = L(11, 18, 10, 0);
    const spans: StatsSpan[] = [
      // 週一晚（11/16 23:30 → 11/17 07:30，8h）：跨午夜且跨 06:00！在 18:00 切日下完整屬於 2026-11-16 睡眠日（8h, 1 次）
      sp("mon-sleep", "c-sleep", L(11, 16, 23, 30), L(11, 17, 7, 30)),
      // 週二晚熬夜凌晨後入睡（11/18 01:30 → 11/18 08:30，7h）：跨 06:00！在 18:00 切日下完整屬於 2026-11-17 睡眠日（7h, 1 次）
      sp("tue-sleep", "c-sleep", L(11, 18, 1, 30), L(11, 18, 8, 30)),
    ];

    // 先對照全域 06:00 下會發生什麼：11/17 的 06:00-07:30 (1.5h) 與 11/18 01:30-06:00 (4.5h) 被湊進 11/17，11/18 剩 06:00-08:30 (2.5h)！
    const cls = classifySpans(spans, now, () => null);
    const globalNov17 = windowTotals(
      spans,
      cls,
      { start: L(11, 17, 6, 0), end: L(11, 18, 6, 0) },
      now,
      () => ROUTE_NONE,
    );
    assert.equal(globalNov17.recordedMs, 6 * 60 * MIN, "全域 06:00 會把兩晚切碎混在一起");
    assert.equal(globalNov17.recordedCount, 2, "全域 06:00 單日會誤算成 2 次");

    // 啟用 18:00 專屬切日線的睡眠觀察專題（看本週）
    const sleepTopic = parseStatTopic(mkTopicRow({ day_start_hour: 18 }))!;
    const [weekView] = buildStatTopics([sleepTopic], spans, CATS, {
      period: "week",
      followCurrent: true,
      ref: "2026-11-18",
      now,
      h: 6,
      weekStart: 1,
      thresholdMin: () => null,
    });

    assert.equal(weekView.effectiveDayStartHour, 18);
    assert.equal(weekView.key, "2026-11-16", "本週自 11/16 18:00 起");
    assert.equal(weekView.totalMs, 15 * 60 * MIN, "8h + 7h = 15h");
    assert.equal(weekView.count, 2, "兩晚完整各計 1 次，共 2 次，絕不被 06:00 切成 4 次");
    assert.equal(weekView.elapsedDays, 2, "11/16 18:00 與 11/17 18:00 兩個睡眠日已開始（11/18 18:00 尚未開始）");
    assert.equal(weekView.avgDayMs, 7.5 * 60 * MIN, "日均 7h 30m");

    const d16 = weekView.days.find((d) => d.dateKey === "2026-11-16")!;
    const d17 = weekView.days.find((d) => d.dateKey === "2026-11-17")!;
    const d18 = weekView.days.find((d) => d.dateKey === "2026-11-18")!;
    assert.deepEqual([d16.ms / MIN, d16.count], [480, 1], "11/16 睡眠日完整 8h · 1 次");
    assert.deepEqual([d17.ms / MIN, d17.count, d17.isToday], [420, 1, true], "11/17 睡眠日完整 7h · 1 次（11/18 10:00 仍處於此睡眠日）");
    assert.deepEqual([d18.ms, d18.future], [0, true], "11/18 18:00 今晚尚未到來");

    // 切到「日」視圖（followCurrent=true，11/18 10:00 剛醒來）：直接顯示昨晚（11/17 18:00～11/18 18:00）的 7h · 1 次！
    const [dayView] = buildStatTopics([sleepTopic], spans, CATS, {
      period: "day",
      followCurrent: true,
      ref: "2026-11-18",
      now,
      h: 6,
      weekStart: 1,
      thresholdMin: () => null,
    });
    assert.equal(dayView.key, "2026-11-17");
    assert.equal(dayView.totalMs, 7 * 60 * MIN);
    assert.equal(dayView.count, 1);
    assert.equal(dayView.days.length, 7, "日視圖展開近 7 個睡眠日明細與迷你趨勢條");
  });

  test("跨 18:00 邊界的傍晚小睡（17:00→19:00）精準依 18:00 切分至前後兩個睡眠日；topicsFromMs 涵蓋最早時間戳", () => {
    const now = L(11, 18, 21, 0);
    const spans: StatsSpan[] = [
      sp("evening-nap", "c-sleep", L(11, 17, 17, 0), L(11, 17, 19, 0)),
    ];
    const sleepTopic = parseStatTopic(mkTopicRow({ day_start_hour: 18 }))!;
    const [view] = buildStatTopics([sleepTopic], spans, CATS, {
      period: "week",
      followCurrent: true,
      ref: "2026-11-18",
      now,
      h: 6,
      weekStart: 1,
      thresholdMin: () => null,
    });
    const d16 = view.days.find((d) => d.dateKey === "2026-11-16")!;
    const d17 = view.days.find((d) => d.dateKey === "2026-11-17")!;
    assert.equal(d16.ms, 60 * MIN, "17:00–18:00 歸 11/16 睡眠日");
    assert.equal(d17.ms, 60 * MIN, "18:00–19:00 歸 11/17 睡眠日");
    assert.equal(view.totalMs, 120 * MIN);
    assert.equal(view.count, 1, "週總計仍為同一塊（1 次）");

    // topicsFromMs / topicsEndMs 範圍檢查
    const earlyTopic = parseStatTopic(mkTopicRow({ id: "t0", day_start_hour: 0 }))!;
    const fromMs = topicsFromMs([sleepTopic, earlyTopic], "day", true, "2026-11-18", L(11, 18, 10, 0), 6, 1)!;
    const endMs = topicsEndMs([sleepTopic, earlyTopic], "day", true, "2026-11-18", L(11, 18, 10, 0), 6, 1)!;
    assert.ok(fromMs <= L(11, 11, 18, 0), "涵蓋 18:00 切日專題近 7 日趨勢起點");
    assert.ok(endMs >= L(11, 19, 0, 0), "涵蓋 00:00 切日專題當日結尾");
  });
});
