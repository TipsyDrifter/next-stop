/**
 * v1.33 3A 運行報告完全體 ＋ G6 方針回顧轉日記 純函式單元測試。
 * 執行：`node --test src/domain/report.test.ts`
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_REPORT_FILTER,
  appendReviewToDiaryBody,
  buildOperationReport,
  buildSingleDayDetail,
  buildSingleDaySpread,
  filterCompletedGroups,
  formatAimsReviewDiary,
  formatReportMoney,
  formatReportMoneyDelta,
  formatReportSpreadDate,
  isReportFilterActive,
  matchesReportFilter,
  parseReportPeriodPref,
  reportFetchWindow,
  resolveReportRange,
  serializeReportPeriodPref,
  shiftReportMonth,
  sortRouteRanks,
  stepReportDay,
  type ReportFacts,
  type ReportRouteRef,
} from "./report.ts";
import { reportTimeFacts, slicePreparedTime } from "./reportTime.ts";
import { dayWindow } from "../lib/date.ts";

const TODAY = "2026-11-18"; // 週三

const ROUTES: Record<string, ReportRouteRef> = {
  r_jp: { id: "r_jp", name: "日文檢定", code: "J", color: "#2d6a4f", lineId: "l_study", arrivedOn: null },
  r_algo: { id: "r_algo", name: "演算法", code: "A", color: "#1d3557", lineId: "l_study", arrivedOn: null },
  r_depot: { id: "r_depot", name: "畢業製作", code: "G", color: "#6d597a", lineId: "l_work", arrivedOn: "2026-11-10" },
};

function isoOn(day: string, hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const [y, mo, d] = day.split("-").map(Number);
  return new Date(y, mo - 1, d, h, m, 0).toISOString();
}

function makeBaseFacts(overrides: Partial<ReportFacts> = {}): ReportFacts {
  const now = new Date(isoOn(TODAY, "20:00")).getTime();
  const time = reportTimeFacts({
    spans: [
      {
        id: "b1",
        categoryId: "c_read",
        start: new Date(isoOn(TODAY, "09:00")).getTime(),
        end: new Date(isoOn(TODAY, "10:30")).getTime(),
        ack: false,
        estimateMin: null,
        nodeId: "n1",
        routeId: "r_jp",
        tagKeys: ["讀書/日文", "專注"],
      },
      {
        id: "b2",
        categoryId: "c_code",
        start: new Date(isoOn("2026-11-17", "14:00")).getTime(),
        end: new Date(isoOn("2026-11-17", "16:00")).getTime(),
        ack: false,
        estimateMin: null,
        nodeId: "n2",
        routeId: "r_algo",
        tagKeys: ["讀書/資工"],
      },
      {
        id: "b3",
        categoryId: "c_code",
        start: new Date(isoOn("2026-11-15", "10:00")).getTime(),
        end: new Date(isoOn("2026-11-15", "11:00")).getTime(),
        ack: false,
        estimateMin: null,
        nodeId: null,
        routeId: "r_depot",
        tagKeys: ["專題"],
      },
    ],
    threshold: () => null,
    catTop: (id) => (id === "c_read" ? { id: "top_study", name: "學習" } : { id: "top_dev", name: "開發" }),
    from: "2026-10-10",
    today: TODAY,
    dayStartHour: 6,
    now,
    blockMeta: {
      b1: { categoryName: "閱讀", taskName: "N4 文法", note: "第三章", routeId: "r_jp" },
      b2: { categoryName: "刷題", taskName: "DP 練習", note: "", routeId: "r_algo" },
      b3: { categoryName: "收尾", taskName: null, note: "整理海報", routeId: "r_depot" },
    },
  });

  return {
    today: TODAY,
    dayStartHour: 6,
    weekStart: 1,
    days: 7,
    routes: ROUTES,
    seals: [
      {
        id: "s1",
        nodeId: "n1",
        name: "讀完 N4 第三章",
        kind: "ticket",
        routeId: "r_jp",
        at: isoOn(TODAY, "10:35"),
        dueOn: null,
        tagKeys: ["讀書/日文", "專注"],
      },
      {
        id: "occ_1",
        nodeId: "n_rep",
        name: "每日單字 30 個",
        kind: "ticket",
        routeId: "r_jp",
        at: isoOn(TODAY, "08:15"),
        dueOn: TODAY,
        tagKeys: ["讀書/日文"],
      },
      {
        id: "s2",
        nodeId: "n2",
        name: "解完背包問題",
        kind: "ticket",
        routeId: "r_algo",
        at: isoOn("2026-11-17", "16:10"),
        dueOn: null,
        tagKeys: ["讀書/資工"],
      },
      {
        id: "s_temp",
        nodeId: "n_temp",
        name: "寄掛號信",
        kind: "ticket",
        routeId: null,
        at: isoOn("2026-11-16", "12:00"),
        dueOn: null,
        tagKeys: ["生活"],
      },
    ],
    late: [{ day: "2026-11-16", nodeId: "n_late", routeId: "r_algo", tagKeys: ["讀書/資工"] }],
    dueSoon: [
      {
        day: "2026-11-20",
        nodeId: "n_due",
        name: "報名日檢",
        routeId: "r_jp",
        temp: false,
        tagKeys: ["讀書/日文"],
      },
    ],
    dueByDay: { "2026-11-18": 1, "2026-11-17": 1 },
    dueItems: [
      { id: "d1", day: "2026-11-18", routeId: "r_jp", tagKeys: ["讀書/日文"] },
      { id: "d2", day: "2026-11-17", routeId: "r_algo", tagKeys: ["讀書/資工"] },
    ],
    time,
    money: {
      decimals: 0,
      budget: { month: "2026-11", budget: 10000, used: 1850, remaining: 8150 },
      expenses: [
        {
          id: "e1",
          day: TODAY,
          at: isoOn(TODAY, "11:20"),
          minor: 350,
          category: "書籍",
          note: "N4 模擬試題",
          routeId: "r_jp",
          tagKeys: ["讀書/日文", "專注"],
        },
        {
          id: "e2",
          day: "2026-11-15",
          at: isoOn("2026-11-15", "18:00"),
          minor: 1500,
          category: "印刷",
          note: "專題展板輸出",
          routeId: "r_depot",
          tagKeys: ["專題"],
        },
      ],
    },
    notes: {
      notedAt: [isoOn(TODAY, "15:00"), isoOn("2026-11-17", "19:00")],
      diaryDays: [TODAY],
      noteItems: [
        { id: "nt1", at: isoOn(TODAY, "15:00"), routeId: "r_jp", tagKeys: ["讀書/日文", "專注"] },
        { id: "nt2", at: isoOn("2026-11-17", "19:00"), routeId: "r_algo", tagKeys: ["讀書/資工"] },
      ],
      diarySummaries: {
        [TODAY]: { id: "dia1", text: "今天把助詞跟授受動詞徹底弄懂了" },
      },
    },
    yearAgo: null,
    dayNotes: null,
    ...overrides,
  };
}

describe("3A-2 彈性期間解析與本機記憶編解碼", () => {
  test("resolveReportRange：今日、近 7 天、近 30 天、按月翻頁（當月夾至 today、過往月取整月）、自訂區間防呆", () => {
    assert.deepEqual(resolveReportRange(TODAY, { mode: "today" }), {
      mode: "today",
      from: "2026-11-18",
      to: "2026-11-18",
      month: "2026-11",
      label: "今日",
    });

    const r7 = resolveReportRange(TODAY, { mode: "7d" });
    assert.equal(r7.from, "2026-11-12");
    assert.equal(r7.to, "2026-11-18");

    const r30 = resolveReportRange(TODAY, { mode: "30d" });
    assert.equal(r30.from, "2026-10-20");
    assert.equal(r30.to, "2026-11-18");

    const curM = resolveReportRange(TODAY, { mode: "month", month: "2026-11" });
    assert.equal(curM.from, "2026-11-01");
    assert.equal(curM.to, "2026-11-18");
    assert.equal(curM.label, "2026年11月");

    const febLeap = resolveReportRange(TODAY, { mode: "month", month: "2024-02" });
    assert.equal(febLeap.from, "2024-02-01");
    assert.equal(febLeap.to, "2024-02-29");

    // 起訖顛倒自動對調，超過 today 自動夾回 today
    const custom = resolveReportRange(TODAY, {
      mode: "custom",
      customFrom: "2026-12-05",
      customTo: "2026-11-01",
    });
    assert.equal(custom.from, "2026-11-01");
    assert.equal(custom.to, "2026-11-18");
    assert.equal(custom.label, "11/1 – 11/18");
  });

  test("shiftReportMonth 與 reportFetchWindow 跨年翻月及擴充撈取窗", () => {
    assert.equal(shiftReportMonth("2026-01", -1), "2025-12");
    assert.equal(shiftReportMonth("2025-12", 1), "2026-01");

    const win = reportFetchWindow(TODAY, 1, { from: "2026-08-01", to: "2026-08-31" });
    // 2026-08-01 為週六，週一週首為 2026-07-27，再往前 7 天緩衝＝2026-07-20
    assert.equal(win.from, "2026-07-20");
    assert.equal(win.to, TODAY);
  });

  test("parseReportPeriodPref／serializeReportPeriodPref：相容舊版 7/30 並持久化期間模式", () => {
    assert.deepEqual(parseReportPeriodPref(null, TODAY), { mode: "7d" });
    assert.deepEqual(parseReportPeriodPref("30", TODAY), { mode: "30d" });
    assert.deepEqual(parseReportPeriodPref("7", TODAY), { mode: "7d" });

    const savedMonth = serializeReportPeriodPref({ mode: "month", month: "2026-09" });
    assert.deepEqual(parseReportPeriodPref(savedMonth, TODAY), { mode: "month", month: "2026-11" });

    const savedCustom = serializeReportPeriodPref({
      mode: "custom",
      customFrom: "2026-11-01",
      customTo: "2026-11-15",
    });
    assert.deepEqual(parseReportPeriodPref(savedCustom, TODAY), {
      mode: "custom",
      customFrom: "2026-11-01",
      customTo: "2026-11-15",
    });
  });
});

describe("3A-2 跨模組篩選（幹線／路線 ＋ #荷札 多選 AND 父含子）", () => {
  test("matchesReportFilter：全部、單一路線、整條幹線、未掛路線與多枚 #荷札 AND 交集", () => {
    assert.equal(isReportFilterActive(DEFAULT_REPORT_FILTER), false);
    assert.equal(isReportFilterActive({ scope: { kind: "none" }, tagKeys: [] }), true);

    // 幹線 l_study 同時命中 r_jp 與 r_algo，排除 r_depot 與 null
    const lineFilter = { scope: { kind: "line" as const, lineId: "l_study" }, tagKeys: [] };
    assert.equal(matchesReportFilter({ routeId: "r_jp" }, lineFilter, ROUTES), true);
    assert.equal(matchesReportFilter({ routeId: "r_algo" }, lineFilter, ROUTES), true);
    assert.equal(matchesReportFilter({ routeId: "r_depot" }, lineFilter, ROUTES), false);
    assert.equal(matchesReportFilter({ routeId: null }, lineFilter, ROUTES), false);

    // 未掛路線／臨時
    const noneFilter = { scope: { kind: "none" as const }, tagKeys: [] };
    assert.equal(matchesReportFilter({ routeId: null }, noneFilter, ROUTES), true);
    assert.equal(matchesReportFilter({ routeId: "r_jp" }, noneFilter, ROUTES), false);

    // 父荷札 #讀書 命中 #讀書/日文，搭配 #專注 做 AND 交集
    const andFilter = { scope: { kind: "all" as const }, tagKeys: ["讀書", "專注"] };
    assert.equal(matchesReportFilter({ routeId: "r_jp", tagKeys: ["讀書/日文", "專注"] }, andFilter, ROUTES), true);
    assert.equal(matchesReportFilter({ routeId: "r_jp", tagKeys: ["讀書/日文"] }, andFilter, ROUTES), false);
  });

  test("buildOperationReport 套用幹線＋#荷札篩選後，卡片、表格、路線排行與明細同步收斂", () => {
    const now = new Date(isoOn(TODAY, "20:00")).getTime();
    const filteredFacts = makeBaseFacts({
      period: { mode: "7d" },
      filter: { scope: { kind: "line", lineId: "l_study" }, tagKeys: ["讀書", "專注"] },
    });
    const rep = buildOperationReport(filteredFacts, now);
    assert.equal(rep.filterActive, true);
    // 今日兩枚済中只有 s1 同時具備 #讀書/日文 與 #專注
    assert.equal(rep.ride.seals, 1);
    assert.equal(rep.time?.ms, 90 * 60 * 1000);
    assert.equal(rep.money?.spent, 350);
    assert.equal(rep.notes?.count, 1);
    assert.equal(rep.completedTotal, 1);
    assert.equal(rep.routeRanks.length, 1);
    assert.equal(rep.routeRanks[0]?.routeId, "r_jp");
  });
});

describe("3A-1 單日運行全貌原地展開明細 ＆ 3A-2 路線排行與已完成車票歷史明細流", () => {
  test("dayDetails 組裝當日蓋済車票、時間塊明細、收支明細與日記一行預覽", () => {
    const now = new Date(isoOn(TODAY, "20:00")).getTime();
    const rep = buildOperationReport(makeBaseFacts({ period: { mode: "7d" } }), now);

    const todayDetail = rep.dayDetails[TODAY];
    assert.ok(todayDetail);
    // 依蓋章時刻排序：08:15 定期券 → 10:35 單發票
    assert.equal(todayDetail.seals.length, 2);
    assert.equal(todayDetail.seals[0]?.id, "occ_1");
    assert.equal(todayDetail.seals[0]?.dueOn, TODAY);
    assert.equal(todayDetail.seals[0]?.clock, "08:15");
    assert.equal(todayDetail.seals[1]?.name, "讀完 N4 第三章");

    assert.ok(todayDetail.time);
    assert.equal(todayDetail.time.totalMs, 90 * 60 * 1000);
    assert.equal(todayDetail.time.blocks.length, 1);
    assert.equal(todayDetail.time.blocks[0]?.startClock, "09:00");
    assert.equal(todayDetail.time.blocks[0]?.endClock, "10:30");
    assert.equal(todayDetail.time.blocks[0]?.taskName, "N4 文法");
    assert.equal(todayDetail.time.blocks[0]?.note, "第三章");

    assert.ok(todayDetail.money);
    assert.equal(todayDetail.money.totalSpent, 350);
    assert.equal(todayDetail.money.entries[0]?.note, "N4 模擬試題");

    assert.deepEqual(todayDetail.diary, {
      hasDiary: true,
      summary: "今天把助詞跟授受動詞徹底弄懂了",
    });

    // 沒寫日記的日子：hasDiary=false, summary=null
    const prevDetail = rep.dayDetails["2026-11-17"];
    assert.deepEqual(prevDetail?.diary, { hasDiary: false, summary: null });
  });

  test("routeRanks 與 sortRouteRanks：含車庫路線與臨時車票，支援切換車票／時數／支出排序", () => {
    const now = new Date(isoOn(TODAY, "20:00")).getTime();
    const rep = buildOperationReport(makeBaseFacts({ period: { mode: "7d" } }), now);

    // 預設依蓋済車票數：r_jp (2) → r_algo (1) → 臨時 (1) → r_depot (0)
    assert.equal(rep.routeRanks[0]?.routeId, "r_jp");
    assert.equal(rep.routeRanks[0]?.seals, 2);

    // 切換依投入時數：r_algo (2h) → r_jp (1.5h) → r_depot (1h) → 臨時 (0)
    const byTime = sortRouteRanks(rep.routeRanks, "time");
    assert.equal(byTime[0]?.routeId, "r_algo");
    assert.equal(byTime[0]?.timeMs, 120 * 60 * 1000);

    // 切換依相關支出：r_depot (1500, inDepot=true) → r_jp (350)
    const byMoney = sortRouteRanks(rep.routeRanks, "money");
    assert.equal(byMoney[0]?.routeId, "r_depot");
    assert.equal(byMoney[0]?.inDepot, true);
    assert.equal(byMoney[0]?.spent, 1500);
  });

  test("completedGroups 與 filterCompletedGroups：依營業日倒序分組並支援關鍵字即時過濾", () => {
    const now = new Date(isoOn(TODAY, "20:00")).getTime();
    const rep = buildOperationReport(makeBaseFacts({ period: { mode: "7d" } }), now);

    assert.equal(rep.completedTotal, 4);
    assert.deepEqual(
      rep.completedGroups.map((g) => g.day),
      ["2026-11-18", "2026-11-17", "2026-11-16"],
    );
    // 同日內新→舊：10:35 在 08:15 之前
    assert.equal(rep.completedGroups[0]?.items[0]?.id, "s1");
    assert.equal(rep.completedGroups[0]?.items[1]?.id, "occ_1");

    // 關鍵字查「定期 日文」只命中定期券班次 occ_1
    const hitOcc = filterCompletedGroups(rep.completedGroups, "定期 日文", ROUTES);
    assert.equal(hitOcc.total, 1);
    assert.equal(hitOcc.groups[0]?.items[0]?.id, "occ_1");

    // 關鍵字查「臨時」命中未掛路線車票
    const hitTemp = filterCompletedGroups(rep.completedGroups, "臨時", ROUTES);
    assert.equal(hitTemp.total, 1);
    assert.equal(hitTemp.groups[0]?.items[0]?.id, "s_temp");
  });

  test("slicePreparedTime：跨日界線的時間塊自動切齊營業日視窗", () => {
    const wStart = new Date(dayWindow(TODAY, 6).start).getTime();
    const res = slicePreparedTime({
      spans: [
        {
          id: "cross",
          categoryId: "c1",
          topCatId: "c1",
          topCatName: "睡眠",
          categoryName: "睡眠",
          start: wStart - 60 * 60 * 1000, // 05:00（屬於前一個營業日）
          end: wStart + 2 * 60 * 60 * 1000, // 08:00（今天佔 2 小時）
          ack: true,
          pending: false,
          routeId: null,
          taskName: null,
          note: "",
          tagKeys: [],
        },
      ],
      tableFloor: "2026-11-17",
      rangeFrom: "2026-11-17",
      rangeTo: TODAY,
      today: TODAY,
      dayStartHour: 6,
      now: wStart + 5 * 60 * 60 * 1000,
    });
    assert.equal(res.byDay["2026-11-17"], 60 * 60 * 1000);
    assert.equal(res.byDay[TODAY], 2 * 60 * 60 * 1000);
    assert.equal(res.dayDetails[TODAY]?.blocks[0]?.startClock, "06:00");
    assert.equal(res.dayDetails[TODAY]?.blocks[0]?.endClock, "08:00");
  });
});

describe("3A-3 G6：方針回顧轉日記純函式", () => {
  test("formatAimsReviewDiary 與 appendReviewToDiaryBody：格式化印記與路線，溫柔附加絕不覆蓋既有文字且冪等防重", () => {
    const md = formatAimsReviewDiary({
      title: "本月回顧",
      rangeText: "2026年11月",
      aims: [
        { text: "讀完 N4 文法", done: true, routeLabel: "日文檢定" },
        { text: "整理作品集", done: false, routeLabel: null },
      ],
    });

    assert.equal(
      md,
      "### 本月回顧（2026年11月）\n\n- [済] 讀完 N4 文法（日文檢定）\n- [ ] 整理作品集",
    );

    // 空白日記：直接建立內容
    const fresh = appendReviewToDiaryBody("", md);
    assert.equal(fresh.alreadyPresent, false);
    assert.equal(fresh.body, `${md}\n\n`);

    // 既有日記：溫柔以分隔線附加在文末，完整保留原本寫下的每一個字
    const existing = "今天傍晚去散步，晚風很舒服。";
    const appended = appendReviewToDiaryBody(existing, md);
    assert.equal(appended.alreadyPresent, false);
    assert.ok(appended.body.startsWith("今天傍晚去散步，晚風很舒服。\n\n---\n\n"));
    assert.ok(appended.body.includes("- [済] 讀完 N4 文法（日文檢定）"));

    // 再按一次：偵測已存在，不重複貼入第二份
    const again = appendReviewToDiaryBody(appended.body, md);
    assert.equal(again.alreadyPresent, true);
    assert.equal(again.body, appended.body);
  });
});

describe("v1.33 一日運行專頁（手帳跨頁 Daily Spread）與金額隱私遮罩同步", () => {
  test("stepReportDay 與 formatReportSpreadDate：前後翻日，達 today 時停住不進入未來", () => {
    assert.equal(stepReportDay("2026-11-18", -1, TODAY), "2026-11-17");
    assert.equal(stepReportDay("2026-11-17", 1, TODAY), "2026-11-18");
    assert.equal(stepReportDay("2026-11-18", 1, TODAY), "2026-11-18");
    assert.equal(stepReportDay("2026-11-18", 5, TODAY), "2026-11-18");
    assert.equal(formatReportSpreadDate("2026-11-18"), "2026年11月18日（週三）");
    assert.equal(formatReportSpreadDate("2026-11-15"), "2026年11月15日（週日）");
  });

  test("formatReportMoney 與 formatReportMoneyDelta：隱私遮罩開啟時一律輸出 ****，不洩漏金額與漲跌", () => {
    assert.equal(formatReportMoney(1850, 0, false), "1,850");
    assert.equal(formatReportMoney(1850, 0, true), "****");
    assert.equal(formatReportMoney(0, 0, true), "****");
    assert.equal(formatReportMoneyDelta(320, 0, false), "▲320");
    assert.equal(formatReportMoneyDelta(-120, 0, false), "▼120");
    assert.equal(formatReportMoneyDelta(320, 0, true), "****");
    assert.equal(formatReportMoneyDelta(0, 0, true), "****");
  });

  test("buildSingleDayDetail：不受外層跨模組篩選條件影響，還原該日完整客觀明細", () => {
    const now = new Date(isoOn(TODAY, "20:00")).getTime();
    const filteredFacts = makeBaseFacts({
      filter: { scope: { kind: "route", routeId: "r_algo" }, tagKeys: [] },
    });
    const rep = buildOperationReport(filteredFacts, now);
    // 外層報表因篩選 r_algo，今天済 = 0
    assert.equal(rep.ride.seals, 0);

    // 單日專頁直接從 facts 抽出該日完整實績（2 張済）
    const single = buildSingleDayDetail(filteredFacts, TODAY, now);
    assert.equal(single.seals.length, 2);
    assert.equal(single.money?.totalSpent, 350);
  });

  test("buildSingleDaySpread：支援區間外歷史單日，組裝完整日記段落、補記標記、車窓の問い與去重記事章", () => {
    const outDay = "2025-05-10";
    const now = new Date(isoOn(TODAY, "20:00")).getTime();
    const time = reportTimeFacts({
      spans: [
        {
          id: "b_old",
          categoryId: "c_study",
          start: new Date(isoOn(outDay, "14:00")).getTime(),
          end: new Date(isoOn(outDay, "16:30")).getTime(),
          ack: true,
          estimateMin: null,
          nodeId: "n_old",
          routeId: "r_jp",
          tagKeys: [],
        },
      ],
      threshold: () => null,
      catTop: () => ({ id: "c_study", name: "讀書" }),
      from: outDay,
      to: outDay,
      today: outDay,
      dayStartHour: 4,
      now,
      blockMeta: {
        b_old: {
          categoryName: "讀書",
          taskName: "五十音總複習",
          note: "完整寫完平假名與片假名聽寫練習，沒有截斷",
          routeId: "r_jp",
        },
      },
    });

    const spread = buildSingleDaySpread(
      {
        day: outDay,
        today: TODAY,
        dayStartHour: 4,
        routes: ROUTES,
        seals: [
          {
            id: "s_old",
            at: isoOn(outDay, "16:35"),
            nodeId: "n_old",
            name: "完成五十音總複習長標題車票（完整保留不截斷）",
            kind: "ticket",
            dueOn: null,
            routeId: "r_jp",
          },
        ],
        time,
        money: {
          decimals: 0,
          expenses: [
            {
              id: "e_old",
              day: outDay,
              at: isoOn(outDay, "17:10"),
              minor: 280,
              category: "學習教材",
              note: "車站旁獨立書店買的空白方格筆記本",
              routeId: "r_jp",
            },
          ],
        },
        diaries: [
          {
            id: "d_old",
            entryDate: outDay,
            title: "初夏午後的起點",
            body: "第一段：午後陽光斜照在木桌上，把五十音全部默寫了一遍。\n\n第二段：回程順道去買了一本亞麻封面的方格筆記本。",
            createdAt: isoOn("2025-05-11", "09:20"), // 隔天補記
            updatedAt: isoOn("2025-05-11", "09:25"),
          },
        ],
        reflections: [
          {
            id: "ref_other_day",
            prompt_key: "daily.good-day",
            category: "daily",
            question: "別天的題目",
            answer: "別天的回答",
            answered_on: TODAY,
            created_at: isoOn(TODAY, "21:00"),
            deleted_at: null,
          },
          {
            id: "ref_deleted",
            prompt_key: "self.kind-words",
            category: "self",
            question: "已刪除題目",
            answer: "不該顯示",
            answered_on: outDay,
            created_at: isoOn(outDay, "21:00"),
            deleted_at: isoOn(outDay, "21:05"),
          },
          {
            id: "ref_hit",
            prompt_key: "journey.language-dream",
            category: "journey",
            question: "正在學習的新技能或新語言，你最期待未來某天能用它體驗哪一個真實場景？",
            answer: "希望有一天能坐上京都往北的私鐵電車，不看翻譯直接讀懂沿線小站的站牌與地方誌。",
            answered_on: outDay,
            created_at: isoOn(outDay, "22:10"),
            deleted_at: null,
          },
        ],
        dayNotes: ["五十音站 到着", "五十音站 到着", "開業"],
      },
      now,
    );

    assert.equal(spread.day, outDay);
    assert.equal(spread.isToday, false);
    assert.equal(spread.detail.seals.length, 1);
    assert.equal(spread.detail.seals[0]?.name, "完成五十音總複習長標題車票（完整保留不截斷）");
    assert.equal(spread.detail.time?.totalMs, 150 * 60 * 1000);
    assert.equal(spread.detail.time?.blocks[0]?.note, "完整寫完平假名與片假名聽寫練習，沒有截斷");
    assert.equal(spread.detail.money?.totalSpent, 280);

    // 日記全文與補記標記完整保留
    assert.equal(spread.diaries?.length, 1);
    assert.equal(spread.diaries?.[0]?.title, "初夏午後的起點");
    assert.ok(spread.diaries?.[0]?.body.includes("第二段：回程順道去買了一本亞麻封面的方格筆記本。"));
    assert.equal(spread.diaries?.[0]?.isBackfilled, true);

    // 車窓の問い僅保留該日且未刪除的回答
    assert.equal(spread.reflections.length, 1);
    assert.equal(spread.reflections[0]?.id, "ref_hit");
    assert.equal(spread.reflections[0]?.categoryLabel, "旅途拾光");
    assert.ok(spread.reflections[0]?.answer.includes("私鐵電車"));

    // 記事章自動去重
    assert.deepEqual(spread.dayNotes, ["五十音站 到着", "開業"]);
  });
});
