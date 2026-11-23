/**
 * 回饋專卷 第四梯（4A 免標題預留席車票、4B 期間自由券區間挑選與抽屜收據、4C 定期班次填空／入座 UI 規則）單元測試。
 * 跑法：`node --test scripts/tests/fb-w4-today-range.test.ts`
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { dayRangeRole, stepRangePick } from "../../src/ui/common/datePickRules.ts";
import {
  NO_DEST,
  dateRangeChipText,
  leaveNote,
  mergeQuick,
  resolveQuickTarget,
  stubLook,
  type QuickDest,
} from "../../src/ui/common/quickadd/quickAddModel.ts";
import {
  canActAsSeatSlot,
  canBeSeatedCandidate,
  formatRunOriginText,
  formatSeatBadgeText,
} from "../../src/ui/common/seating/seatRules.ts";
import { parseQuickAdd, type QuickRouteRef } from "../../src/domain/quickAdd.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");

const ROUTES: readonly QuickRouteRef[] = [
  { id: "r-jp", name: "日文", code: "JP" },
  { id: "r-cs", name: "演算法", code: "CS" },
];
const ROUTE_JP: QuickDest = { routeId: "r-jp", nodeId: null, nodeKind: "route" };

describe("datePickRules：4B 區間雙擊點選狀態機與月格角色", () => {
  test("stepRangePick：第一下定起日、第二下自動正規化先後順序、同一天收斂為單日", () => {
    const first = stepRangePick(null, "2026-10-12");
    assert.deepEqual(first, { kind: "start", draftStart: "2026-10-12" });

    // 第二下選較晚日期
    const forward = stepRangePick("2026-10-12", "2026-10-16");
    assert.deepEqual(forward, { kind: "commit", start: "2026-10-12", end: "2026-10-16" });

    // 第二下選較早日期 → 自動對調，不產生倒置區間
    const backward = stepRangePick("2026-10-12", "2026-10-09");
    assert.deepEqual(backward, { kind: "commit", start: "2026-10-09", end: "2026-10-12" });

    // 兩下點同一天 → 收斂成單日（end: null）
    const same = stepRangePick("2026-10-12", "2026-10-12");
    assert.deepEqual(same, { kind: "commit", start: "2026-10-12", end: null });
  });

  test("dayRangeRole：正確標示起日、中間日、訖日與單日", () => {
    assert.equal(dayRangeRole("2026-10-10", "2026-10-10", "2026-10-12"), "start");
    assert.equal(dayRangeRole("2026-10-11", "2026-10-10", "2026-10-12"), "mid");
    assert.equal(dayRangeRole("2026-10-12", "2026-10-10", "2026-10-12"), "end");
    assert.equal(dayRangeRole("2026-10-09", "2026-10-10", "2026-10-12"), null);
    assert.equal(dayRangeRole("2026-10-10", "2026-10-10", null), "single");
  });
});

describe("quickAddModel：4A 免標題預留席車票與 4B 期間區間合流", () => {
  const today = "2026-10-12"; // 週一

  test("4A：『@日文 2h』與『#學習 14:00-16:00』免標題自動生成預留席車票，票根標『預 · 預留席』", () => {
    const p1 = parseQuickAdd("@日文 2h", { today, routes: ROUTES, weekStart: 1 });
    const v1 = mergeQuick(
      p1,
      {},
      { dest: NO_DEST, scheduledOn: today },
      () => null,
      false,
      (d) => (d.routeId === "r-jp" ? "日文" : null),
    );
    assert.equal(v1.isPlaceholder, true);
    assert.equal(v1.effectiveName, "日文");
    assert.equal(v1.estimateMin, 120);

    const look = stubLook(resolveQuickTarget(v1.dest), v1.isPlaceholder);
    assert.deepEqual(look, { badge: "預", dashed: true, lineName: "預留席", fare: "預留席" });

    const p2 = parseQuickAdd("#學習 14:00-16:00", { today, routes: ROUTES, weekStart: 1 });
    const v2 = mergeQuick(p2, {}, { dest: NO_DEST, scheduledOn: today }, () => null);
    assert.equal(v2.isPlaceholder, true);
    assert.equal(v2.effectiveName, "學習");
    assert.equal(v2.scheduledTime, "14:00");
    assert.equal(v2.estimateMin, 120);
  });

  test("4A：透過膠囊點選路線＋時長但未打標題時，同樣可作為預留席送出；純空白輸入則不可送出", () => {
    const emptyParse = parseQuickAdd("", { today, routes: ROUTES, weekStart: 1 });

    // 純空白（無路線／荷札）：effectiveName 為空，空白 Enter 維持關閉草稿列行為
    const blank = mergeQuick(emptyParse, {}, { dest: NO_DEST, scheduledOn: today }, () => null);
    assert.equal(blank.isPlaceholder, false);
    assert.equal(blank.effectiveName, "");

    // 在路線下透過膠囊選了 60 分鐘時長但沒打標題：自動生成預留席
    const chipPh = mergeQuick(
      emptyParse,
      { estimateMin: 60 },
      { dest: ROUTE_JP, scheduledOn: today },
      () => null,
      false,
      () => "日文",
    );
    assert.equal(chipPh.isPlaceholder, true);
    assert.equal(chipPh.effectiveName, "日文");
  });

  test("4B：文字區間語法『本週』『10/10~10/12』與膠囊區間合流，涵蓋今日時不出『已排走』收據", () => {
    const pThisWeek = parseQuickAdd("讀完第三章 本週", { today, routes: ROUTES, weekStart: 1 });
    const vThisWeek = mergeQuick(pThisWeek, {}, { dest: NO_DEST, scheduledOn: today }, () => null);
    assert.equal(vThisWeek.scheduledOn, "2026-10-12");
    assert.equal(vThisWeek.scheduledEnd, "2026-10-18");
    assert.equal(dateRangeChipText(vThisWeek.scheduledOn!, vThisWeek.scheduledEnd, today), "10/12–10/18");

    const target = resolveQuickTarget(vThisWeek.dest);
    // 本週涵蓋今日（2026-10-12）→ 票直接出現在今日頁「期間自由券」抽屜，不彈離開收據
    assert.equal(
      leaveNote(
        { kind: "today", dateKey: today },
        { scheduledOn: vThisWeek.scheduledOn, scheduledEnd: vThisWeek.scheduledEnd, target, routeId: null },
        () => null,
      ),
      null,
    );

    // 下週不涵蓋今日 → 彈「已排入期間 …」收據
    const pNextWeek = parseQuickAdd("寫週報 下週", { today, routes: ROUTES, weekStart: 1 });
    const vNextWeek = mergeQuick(pNextWeek, {}, { dest: NO_DEST, scheduledOn: today }, () => null);
    assert.equal(vNextWeek.scheduledOn, "2026-10-19");
    assert.equal(vNextWeek.scheduledEnd, "2026-10-25");
    assert.equal(
      leaveNote(
        { kind: "today", dateKey: today },
        { scheduledOn: vNextWeek.scheduledOn, scheduledEnd: vNextWeek.scheduledEnd, target, routeId: null },
        () => null,
      ),
      "已排入期間 10/19–10/25",
    );
  });
});

describe("seatRules：4C 預留席空位資格、入座候選過濾與徽章文案", () => {
  const DAILY_RULE = JSON.stringify({
    v: 1,
    mode: "fixed",
    freq: "daily",
    interval: 1,
    byweekday: null,
    bymonthday: null,
    start: "2026-10-01",
    until: null,
    count: null,
  });

  test("canActAsSeatSlot：定期券未結案班次與單日預留席可作為入座空位；一般車票、期間自由券、已結案不可", () => {
    // 定期券班次
    assert.equal(
      canActAsSeatSlot({
        repeat_rule: DAILY_RULE,
        is_placeholder: null,
        scheduled_on: "2026-10-12",
        scheduled_end: null,
        status: "todo",
      }),
      true,
    );
    // 單日預留席
    assert.equal(
      canActAsSeatSlot({
        repeat_rule: null,
        is_placeholder: 1,
        scheduled_on: "2026-10-12",
        scheduled_end: null,
        status: "todo",
      }),
      true,
    );
    // 期間自由券不可當入座空位
    assert.equal(
      canActAsSeatSlot({
        repeat_rule: null,
        is_placeholder: 1,
        scheduled_on: "2026-10-12",
        scheduled_end: "2026-10-18",
        status: "todo",
      }),
      false,
    );
    // 已結案班次不可當入座空位
    assert.equal(
      canActAsSeatSlot(
        {
          repeat_rule: DAILY_RULE,
          is_placeholder: null,
          scheduled_on: "2026-10-12",
          scheduled_end: null,
          status: "todo",
        },
        true,
      ),
      false,
    );
  });

  test("canBeSeatedCandidate：只允許未完成、非定期、非預留席、尚未入座的一般待辦入座", () => {
    const seated = new Set(["t-already"]);
    assert.equal(
      canBeSeatedCandidate(
        { id: "t-ok", kind: "ticket", repeat_rule: null, is_placeholder: null, status: "todo" },
        "slot-1",
        seated,
      ),
      true,
    );
    // 排除空位自身、已入座者、預留席、定期券、已完成、支線
    assert.equal(
      canBeSeatedCandidate(
        { id: "slot-1", kind: "ticket", repeat_rule: null, is_placeholder: null, status: "todo" },
        "slot-1",
        seated,
      ),
      false,
    );
    assert.equal(
      canBeSeatedCandidate(
        { id: "t-already", kind: "ticket", repeat_rule: null, is_placeholder: null, status: "todo" },
        "slot-1",
        seated,
      ),
      false,
    );
    assert.equal(
      canBeSeatedCandidate(
        { id: "t-ph", kind: "ticket", repeat_rule: null, is_placeholder: 1, status: "todo" },
        "slot-1",
        seated,
      ),
      false,
    );
    assert.equal(
      canBeSeatedCandidate(
        {
          id: "t-rep",
          kind: "ticket",
          repeat_rule: DAILY_RULE,
          is_placeholder: null,
          status: "todo",
        },
        "slot-1",
        seated,
      ),
      false,
    );
    assert.equal(
      canBeSeatedCandidate(
        { id: "b-1", kind: "branch", repeat_rule: null, is_placeholder: null, status: "todo" },
        "slot-1",
        seated,
      ),
      false,
    );
  });

  test("formatSeatBadgeText ＆ formatRunOriginText：徽章與母定期副標格式清晰溫潤", () => {
    assert.equal(
      formatSeatBadgeText({
        slotNodeId: "s1",
        dueOn: "2026-10-12",
        slotName: "每日閱讀席",
        slotTime: "20:00",
        slotEstimateMin: 60,
        isRecurring: true,
      }),
      "入座 ↻ 每日閱讀席 · 1h",
    );
    assert.equal(
      formatSeatBadgeText({
        slotNodeId: "s2",
        dueOn: "2026-10-12",
        slotName: "日文 · 預留席",
        slotTime: "14:00",
        slotEstimateMin: 45,
        isRecurring: false,
      }),
      "入座 日文 · 預留席 · 45 分",
    );
    assert.equal(formatRunOriginText("每日閱讀席", 90), "↻ 每日閱讀席 · 1h30");
  });
});

describe("視覺規範門禁：新增與修改之 CSS 零裸色碼、零 8px–16px 塑膠圓角、朱色專款專用", () => {
  const cssFiles = [
    "src/ui/common/seating/flexible-seating.css",
    "src/ui/common/datepicker.css",
    "src/ui/common/defer.css",
  ];

  for (const rel of cssFiles) {
    test(`${rel} 遵守 theme.css 語意 token 與圓角規範`, () => {
      const raw = readFileSync(path.join(ROOT, rel), "utf8");
      const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, "");
      assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(stripped), false, `${rel} 不得含裸 #hex 色碼`);
      assert.equal(/\brgba?\s*\(\s*\d|\bhsla?\s*\(\s*\d/.test(stripped), false, `${rel} 不得含裸 rgb()/hsl() 數值`);
      assert.equal(/border-radius\s*:\s*(?:8|9|1[0-6])px\b/.test(stripped), false, `${rel} 不得使用 8px–16px 圓角`);
      if (rel === "src/ui/common/seating/flexible-seating.css") {
        assert.equal(/--color-seal\b/.test(stripped), false, "flexible-seating.css 不得誤用朱印色 --color-seal");
      }
    });
  }
});
