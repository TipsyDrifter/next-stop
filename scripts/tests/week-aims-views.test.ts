/**
 * 方針擴充——畫面要的期間算術與字（`src/domain/weekAims.ts`；辛 契約 2026-11-04 §7）。
 * 跑法：`node --test scripts/tests/week-aims-views.test.ts`（node 24，型別剝除；零依賴）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  aimsBrief,
  currentKeyOf,
  isLastDayOfPeriod,
  isPastPeriod,
  nextStationOf,
  nextStationsOfRoutes,
  stationCardSub,
  stationDayMarks,
  periodNavText,
  periodOverline,
  periodShortLabel,
  periodStepText,
  periodTabs,
  reviewCueText,
  reviewLatin,
  reviewTitle,
  ribbonSegments,
  stationHeadText,
  upperKeyOf,
  type WeekAimRow,
} from "../../src/domain/weekAims.ts";

const TODAY = "2026-11-04"; // 週三；週一起算的週首 11/2

describe("方針擴充：期間算術", () => {
  test("currentKeyOf：週看每週起始日，月、年不受影響", () => {
    assert.equal(currentKeyOf("week", TODAY, 1), "2026-11-02");
    assert.equal(currentKeyOf("week", TODAY, 0), "2026-11-01");
    assert.equal(currentKeyOf("month", TODAY, 1), "M2026-11");
    assert.equal(currentKeyOf("month", TODAY, 0), "M2026-11");
    assert.equal(currentKeyOf("year", TODAY, 1), "Y2026");
  });

  test("isLastDayOfPeriod：這一期最後一天才算；車站沒有最後一天", () => {
    assert.equal(isLastDayOfPeriod("2026-11-02", "2026-11-08"), true);
    assert.equal(isLastDayOfPeriod("2026-11-02", "2026-11-07"), false);
    assert.equal(isLastDayOfPeriod("M2026-11", "2026-11-30"), true);
    assert.equal(isLastDayOfPeriod("M2026-02", "2026-02-28"), true);
    assert.equal(isLastDayOfPeriod("M2026-11", "2026-11-29"), false);
    assert.equal(isLastDayOfPeriod("Y2026", "2026-12-31"), true);
    assert.equal(isLastDayOfPeriod("Y2026", TODAY), false);
    assert.equal(isLastDayOfPeriod("Sabc", TODAY), false);
  });

  test("isPastPeriod：過去的才算；這一期、未來、車站都不算", () => {
    assert.equal(isPastPeriod("2026-10-26", TODAY, 1), true);
    assert.equal(isPastPeriod("2026-11-02", TODAY, 1), false);
    assert.equal(isPastPeriod("2026-11-09", TODAY, 1), false);
    assert.equal(isPastPeriod("M2026-10", TODAY, 1), true);
    assert.equal(isPastPeriod("M2026-11", TODAY, 1), false);
    assert.equal(isPastPeriod("Y2025", TODAY, 1), true);
    assert.equal(isPastPeriod("Y2027", TODAY, 1), false);
    assert.equal(isPastPeriod("Sabc", TODAY, 1), false);
  });

  test("upperKeyOf（D-主-375）：週→月、月→年；跨月的週今天落在裡面就看今天那個月", () => {
    assert.equal(upperKeyOf("2026-11-02", TODAY), "M2026-11");
    assert.equal(upperKeyOf("2026-10-26", "2026-11-01"), "M2026-11");
    assert.equal(upperKeyOf("2026-10-26", TODAY), "M2026-10");
    assert.equal(upperKeyOf("M2026-11", TODAY), "Y2026");
    assert.equal(upperKeyOf("M2027-01", TODAY), "Y2027");
    assert.equal(upperKeyOf("Y2026", TODAY), null);
    assert.equal(upperKeyOf("Sabc", TODAY), null);
  });
});

describe("方針擴充：字", () => {
  test("periodNavText：月、年要看得出哪一年", () => {
    assert.equal(periodNavText("2026-11-02"), "11/2 – 11/8");
    assert.equal(periodNavText("M2026-11"), "2026年11月");
    assert.equal(periodNavText("Y2026"), "2026年");
    assert.equal(periodNavText("Sabc"), "");
  });

  test("periodStepText／periodOverline／reviewLatin", () => {
    assert.deepEqual(periodStepText("2026-11-02"), { prev: "上一週", next: "下一週", unit: "週" });
    assert.deepEqual(periodStepText("M2026-11"), { prev: "上個月", next: "下個月", unit: "月" });
    assert.deepEqual(periodStepText("Y2026"), { prev: "上一年", next: "下一年", unit: "年" });
    assert.equal(periodOverline("2026-11-02").zh, "週方針");
    assert.equal(periodOverline("M2026-11").zh, "月方針");
    assert.equal(periodOverline("Y2026").zh, "年方針");
    assert.equal(periodOverline("Sabc").zh, "車站方針");
    assert.equal(reviewLatin("2026-11-02"), "Weekly review");
    assert.equal(reviewLatin("Sabc"), "Station review");
  });

  test("reviewTitle：本週／上週／本月／上個月／今年／去年／這一站", () => {
    assert.equal(reviewTitle("2026-11-02", TODAY, 1), "本週回顧");
    assert.equal(reviewTitle("2026-10-26", TODAY, 1), "上週回顧");
    assert.equal(reviewTitle("M2026-11", TODAY, 1), "本月回顧");
    assert.equal(reviewTitle("M2026-10", TODAY, 1), "上個月回顧");
    assert.equal(reviewTitle("Y2026", TODAY, 1), "今年回顧");
    assert.equal(reviewTitle("Y2025", TODAY, 1), "去年回顧");
    assert.equal(reviewTitle("Sabc", TODAY, 1), "這一站回顧");
  });

  test("reviewCueText（D-主-373）：手機一行的字", () => {
    assert.equal(reviewCueText("2026-10-26", TODAY, 1), "回顧上週");
    assert.equal(reviewCueText("M2026-10", TODAY, 1), "回顧上個月");
    assert.equal(reviewCueText("Y2025", TODAY, 1), "回顧去年");
  });

  test("periodShortLabel：這一期用本週／本月／今年，別期照關係寫", () => {
    assert.equal(periodShortLabel("2026-11-02", TODAY, 1), "本週");
    assert.equal(periodShortLabel("2026-11-09", TODAY, 1), "下週");
    assert.equal(periodShortLabel("M2026-11", TODAY, 1), "本月");
    assert.equal(periodShortLabel("M2026-08", TODAY, 1), "8月");
    assert.equal(periodShortLabel("Y2026", TODAY, 1), "今年");
    assert.equal(periodShortLabel("Y2024", TODAY, 1), "2024 年");
  });

  test("stationHeadText：站名・到站日優先，再來預定日；沒日期只有站名", () => {
    assert.equal(stationHeadText({ name: "考過 N5", arrived_on: null, expected_on: "2026-12-06" }), "考過 N5・12/6");
    assert.equal(stationHeadText({ name: "考過 N5", arrived_on: "2026-12-05", expected_on: "2026-12-06" }), "考過 N5・12/5");
    assert.equal(stationHeadText({ name: "考過 N5", arrived_on: null, expected_on: null }), "考過 N5");
    assert.equal(stationHeadText(null), "");
  });

  test("aimsBrief：句・句，不放數字", () => {
    const row = (text: string, done: boolean) => ({ text, done_at: done ? "2026-11-01T00:00:00.000Z" : null }) as WeekAimRow;
    assert.equal(aimsBrief([row("甲", false), row("乙", true), row("丙", false)]), "甲・乙・丙");
    assert.equal(aimsBrief([]), "");
  });
});

describe("方針擴充：一行與分頁", () => {
  test("ribbonSegments（§7）：本週／本月／今年扣掉正在看的那一期", () => {
    assert.deepEqual(ribbonSegments("2026-11-02", TODAY, 1), [
      { key: "M2026-11", label: "本月" },
      { key: "Y2026", label: "今年" },
    ]);
    assert.deepEqual(ribbonSegments("M2026-11", TODAY, 1), [
      { key: "2026-11-02", label: "本週" },
      { key: "Y2026", label: "今年" },
    ]);
    assert.deepEqual(ribbonSegments("Y2026", TODAY, 1), [
      { key: "2026-11-02", label: "本週" },
      { key: "M2026-11", label: "本月" },
    ]);
  });

  test("periodTabs：看別期時那一格換成那一期；車站沒有分頁", () => {
    assert.deepEqual(
      periodTabs("2026-11-02", TODAY, 1).map((t) => t.label),
      ["本週", "本月", "今年"],
    );
    assert.deepEqual(periodTabs("2026-11-09", TODAY, 1), [
      { key: "2026-11-09", label: "下週" },
      { key: "M2026-11", label: "本月" },
      { key: "Y2026", label: "今年" },
    ]);
    assert.deepEqual(periodTabs("Y2025", TODAY, 1)[2], { key: "Y2025", label: "去年" });
    assert.deepEqual(periodTabs("Sabc", TODAY, 1), []);
  });
});

describe("方針擴充：下一站", () => {
  const st = (id: string, parent_id: string, arrived_on: string | null) => ({ id, parent_id, arrived_on });

  test("stationDayMarks：有預定日、還沒到站、路線還在跑才標；同一天照順序", () => {
    const routes = [
      { id: "r1", arrived_on: null, name: "日文" },
      { id: "r2", arrived_on: "2026-10-01", name: "收進車庫的" },
    ];
    const st = (id: string, parent_id: string | null, expected_on: string | null, arrived_on: string | null = null) => ({ id, parent_id, expected_on, arrived_on });
    const marks = stationDayMarks(
      [
        st("a", "r1", "2026-11-25"),
        st("b", "r1", "2026-11-25"),
        st("到過", "r1", "2026-11-26", "2026-11-20"),
        st("沒定", "r1", null),
        st("車庫", "r2", "2026-11-27"),
        st("孤兒", "不見的路線", "2026-11-28"),
        st("沒路線", null, "2026-11-29"),
      ],
      routes,
    );
    assert.deepEqual([...marks.keys()], ["2026-11-25"]);
    assert.deepEqual(marks.get("2026-11-25")?.map((m) => m.station.id), ["a", "b"]);
    assert.equal(marks.get("2026-11-25")?.[0].route.name, "日文");
  });

  test("stationCardSub：還有 N 天／就是今天／晚了 N 天／沒定／到站；路線名可省", () => {
    const st = (expected_on: string | null, arrived_on: string | null = null) => ({ name: "考過 N5", expected_on, arrived_on });
    assert.equal(stationCardSub(st("2026-12-06"), "日文", "2026-11-04"), "日文・預定 12/6（日）・還有 32 天");
    assert.equal(stationCardSub(st("2026-11-04"), "日文", "2026-11-04"), "日文・預定 11/4（三）・就是今天");
    assert.equal(stationCardSub(st("2026-11-02"), "日文", "2026-11-04"), "日文・預定 11/2（一）・晚了 2 天");
    assert.equal(stationCardSub(st(null), "日文", "2026-11-04"), "日文・還沒定預定日");
    assert.equal(stationCardSub(st("2026-12-06", "2026-11-04"), "日文", "2026-11-04"), "日文・11/4（三）到站");
    assert.equal(stationCardSub(st("2026-12-06"), null, "2026-11-04"), "預定 12/6（日）・還有 32 天");
  });

  test("nextStationOf：跳過到過的站；後面都到了或沒有＝null", () => {
    const list = [st("a", "r", "2026-10-01"), st("b", "r", null), st("c", "r", "2026-11-01"), st("d", "r", null)];
    assert.equal(nextStationOf({ id: "a" }, list)?.id, "b");
    assert.equal(nextStationOf({ id: "b" }, list)?.id, "d");
    assert.equal(nextStationOf({ id: "d" }, list), null);
    assert.equal(nextStationOf({ id: "不在清單" }, list), null);
  });

  test("nextStationsOfRoutes：每條路線第一個還沒到的站；全到站的路線略過", () => {
    const routes = [{ id: "r1" }, { id: "r2" }, { id: "r3" }];
    const stations = [st("a", "r1", "2026-10-01"), st("b", "r1", null), st("c", "r1", null), st("x", "r2", "2026-10-01")];
    assert.deepEqual(
      nextStationsOfRoutes(routes, stations).map((n) => [n.route.id, n.station.id]),
      [["r1", "b"]],
    );
  });
});
