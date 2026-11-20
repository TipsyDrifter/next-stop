/**
 * v1.33 3A-3 G6：溫柔回顧提醒（月底回顧／年底回顧／車站預計到站前提醒）與「本期已知悉」去重單元測試。
 * 執行：`node --test src/domain/reminders.test.ts`
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_REMINDER_SETTINGS,
  activeGentleReviews,
  buildReminderPlan,
  monthEndReviewWindow,
  parseReminderSettings,
  parseTarget,
  yearEndReviewWindow,
  type ReminderFacts,
  type ReminderSettings,
} from "./reminders.ts";
import { clockInstant } from "../lib/date.ts";

const ALL_OFF: ReminderSettings = {
  ...DEFAULT_REMINDER_SETTINGS,
  dueEve: false,
  dueDay: false,
  late: false,
  timed: false,
  review: false,
  reviewMonth: false,
  reviewYear: false,
  stationSoon: false,
  routine: false,
  repeat: false,
  sync: false,
  backup: false,
};

function makeFacts(today: string, stationSoon: ReminderFacts["stationSoon"] = []): ReminderFacts {
  return {
    today,
    dayStartHour: 6,
    dues: [],
    lates: [],
    timed: [],
    aimWeeks: [],
    repeats: [],
    routines: [],
    stationSoon,
  };
}

describe("G6 月底回顧與年底回顧視窗判定", () => {
  test("monthEndReviewWindow：每月最後 2 天對應當月，次月 1 日對應上個月（含閏年／平年二月），平時為 null", () => {
    assert.equal(monthEndReviewWindow("2026-11-18"), null);
    assert.equal(monthEndReviewWindow("2026-11-28"), null);

    const nov29 = monthEndReviewWindow("2026-11-29");
    assert.equal(nov29?.aimKey, "M2026-11");
    assert.equal(nov29?.endDay, "2026-12-01");

    const nov30 = monthEndReviewWindow("2026-11-30");
    assert.equal(nov30?.aimKey, "M2026-11");

    // 次月 1 日仍回顧前一個月
    const dec1 = monthEndReviewWindow("2026-12-01");
    assert.equal(dec1?.aimKey, "M2026-11");

    // 平年 2 月（28 天）：2/27、2/28、3/1
    assert.equal(monthEndReviewWindow("2026-02-26"), null);
    assert.equal(monthEndReviewWindow("2026-02-27")?.aimKey, "M2026-02");
    assert.equal(monthEndReviewWindow("2026-03-01")?.aimKey, "M2026-02");

    // 閏年 2 月（29 天）：2/27 不觸發、2/28 與 2/29 觸發
    assert.equal(monthEndReviewWindow("2024-02-27"), null);
    assert.equal(monthEndReviewWindow("2024-02-28")?.aimKey, "M2024-02");
    assert.equal(monthEndReviewWindow("2024-02-29")?.aimKey, "M2024-02");
  });

  test("yearEndReviewWindow：12/28～12/31 對應當年，次年 1/1～1/2 對應前一年，其餘為 null", () => {
    assert.equal(yearEndReviewWindow("2026-12-27"), null);
    assert.equal(yearEndReviewWindow("2026-12-28")?.aimKey, "Y2026");
    assert.equal(yearEndReviewWindow("2026-12-31")?.aimKey, "Y2026");
    assert.equal(yearEndReviewWindow("2027-01-01")?.aimKey, "Y2026");
    assert.equal(yearEndReviewWindow("2027-01-02")?.aimKey, "Y2026");
    assert.equal(yearEndReviewWindow("2027-01-03"), null);
  });
});

describe("G6 溫柔回顧提示、車站預計到站前提醒與「本期已知悉」閉環", () => {
  test("activeGentleReviews：支援月底、年底與 3 天內車站預計到站，並在標記已知悉後不再重複打擾", () => {
    const settings: ReminderSettings = {
      ...ALL_OFF,
      reviewMonth: true,
      reviewYear: true,
      stationSoon: true,
    };

    const stationSoon = [
      {
        stationId: "st_today",
        name: "考過 N4",
        expectedOn: "2026-12-30",
        routeId: "r_jp",
        routeName: "日文檢定",
      },
      {
        stationId: "st_3d",
        name: "交初稿",
        expectedOn: "2027-01-02",
        routeId: "r_thesis",
        routeName: "專題",
      },
      {
        stationId: "st_far",
        name: "太遠的車站",
        expectedOn: "2027-01-10",
        routeId: "r_thesis",
        routeName: "專題",
      },
    ];

    const prompts = activeGentleReviews({ today: "2026-12-30", stationSoon }, settings, {});
    assert.deepEqual(
      prompts.map((p) => p.kind),
      ["review-year", "review-month", "station-soon", "station-soon"],
    );
    assert.deepEqual(prompts[0]?.target, { kind: "review", weekOn: "Y2026" });
    assert.deepEqual(prompts[1]?.target, { kind: "review", weekOn: "M2026-12" });
    assert.ok(prompts[2]?.body.includes("就是今天"));
    assert.ok(prompts[3]?.body.includes("還有 3 天"));

    // 標記年底與 st_today「本期已知悉」後不再出現，其餘保留
    const sent = {
      "review-year:Y2026": 1700000000000,
      "station-soon:st_today:2026-12-30": 1700000000000,
    };
    const afterAck = activeGentleReviews({ today: "2026-12-30", stationSoon }, settings, sent);
    assert.deepEqual(
      afterAck.map((p) => p.key),
      ["review-month:M2026-12", "station-soon:st_3d:2027-01-02"],
    );
  });

  test("buildReminderPlan、parseReminderSettings 與 parseTarget：排程通知與序列化往返一致", () => {
    const parsed = parseReminderSettings('{"reviewMonth":false,"stationSoon":false}');
    assert.equal(parsed.reviewMonth, false);
    assert.equal(parsed.reviewYear, true);
    assert.equal(parsed.stationSoon, false);

    const now = clockInstant("2026-11-29", "10:00")!;
    const facts = makeFacts("2026-11-29", [
      {
        stationId: "st1",
        name: "期中發表",
        expectedOn: "2026-12-01",
        routeId: "r1",
        routeName: "專題",
      },
    ]);
    const plan = buildReminderPlan(
      facts,
      { ...ALL_OFF, reviewMonth: true, stationSoon: true },
      {},
      now,
    );
    assert.deepEqual(
      plan.map((x) => x.kind),
      ["station-soon", "review-month"],
    );

    // 標記已知悉後排程一併排除
    const planAfterAck = buildReminderPlan(
      facts,
      { ...ALL_OFF, reviewMonth: true, stationSoon: true },
      { "review-month:M2026-11": now, "station-soon:st1:2026-12-01": now },
      now,
    );
    assert.deepEqual(planAfterAck, []);

    // station target JSON 往返
    const rawTarget = JSON.stringify({ kind: "station", stationId: "st1", routeId: "r1" });
    assert.deepEqual(parseTarget(rawTarget), { kind: "station", stationId: "st1", routeId: "r1" });
    assert.deepEqual(parseTarget('{"kind":"station","stationId":"st1","routeId":null}'), {
      kind: "station",
      stationId: "st1",
      routeId: null,
    });
  });
});
