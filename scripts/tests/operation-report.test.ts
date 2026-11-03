/**
 * ② 運行報告・純函式（契約 `docs/research/2026-11-02-主線-運行報告-契約.md` §3、§4、§7）。
 * 跑法：`node --test scripts/tests/operation-report.test.ts`（node 24；零依賴）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildOperationReport,
  deltaText,
  factsFrom,
  oneLine,
  weekStartOf,
  yearAgoDay,
  type ReportDayRow,
  type ReportFacts,
  type ReportSumRow,
} from "../../src/domain/report.ts";
import { reportTimeFacts } from "../../src/domain/reportTime.ts";
import { addDays, dayWindow } from "../../src/lib/date.ts";

const H = 4;
const TODAY = "2026-11-04"; // 週三
/** 那天日界線開頭之後 hours 小時的時刻 */
const at = (day: string, hours: number) => new Date(Date.parse(dayWindow(day, H).start) + hours * 3_600_000).toISOString();
const NOW = Date.parse(at(TODAY, 10)); // 今天 14:00（日界線 04:00 起 10 小時）

function facts(o: Partial<ReportFacts> = {}): ReportFacts {
  return {
    today: TODAY,
    dayStartHour: H,
    weekStart: 1,
    days: 7,
    seals: [],
    late: [],
    dueSoon: [],
    dueByDay: {},
    routes: { r1: { id: "r1", name: "日文", code: "J", color: null }, r2: { id: "r2", name: "開發", code: "E1", color: null } },
    time: null,
    money: null,
    notes: null,
    yearAgo: null,
    dayNotes: null,
    ...o,
  };
}
const seal = (day: string, hours: number, routeId: string | null = null, nodeId = Math.random().toString(36)) => ({ at: at(day, hours), nodeId, routeId });
const dayRows = (r: ReturnType<typeof buildOperationReport>) => r.rows.filter((x): x is ReportDayRow => x.kind === "day");
const sumRows = (r: ReturnType<typeof buildOperationReport>) => r.rows.filter((x): x is ReportSumRow => x.kind === "sum");

test("小工具：週首、去年同日、一行、比較字", () => {
  assert.equal(weekStartOf("2026-11-04", 1), "2026-11-02");
  assert.equal(weekStartOf("2026-11-04", 0), "2026-11-01");
  assert.equal(weekStartOf("2026-11-02", 1), "2026-11-02");
  assert.equal(yearAgoDay("2026-11-04"), "2025-11-04");
  assert.equal(yearAgoDay("2028-02-29"), null);
  assert.equal(oneLine("", "\n\n# 標題行\n內文"), "標題行");
  assert.equal(oneLine(null, "- [ ] 待辦"), "待辦");
  assert.equal(oneLine("  有標題 ", "內文"), "有標題");
  assert.equal(deltaText(3), "▲3");
  assert.equal(deltaText(-65), "▼65");
  assert.equal(deltaText(0), "持平");
  assert.equal(factsFrom(TODAY), addDays(TODAY, -36));
});

test("乘車卡：今天的済、按路線分組（多到少、最多 4 列）、誤點、比上週同一天到同一個時刻", () => {
  const lw = addDays(TODAY, -7);
  const r = buildOperationReport(
    facts({
      seals: [
        seal(TODAY, 1, "r1"),
        seal(TODAY, 2, "r1"),
        seal(TODAY, 3, "r2"),
        seal(TODAY, 4, null),
        seal(TODAY, 5, "gone"), // 路線不在（刪了）＝跟臨時票一組
        seal(lw, 2), // 上週同一天、時刻在今天之前 ⇒ 算
        seal(lw, 12), // 上週同一天、晚於今天此刻 ⇒ 不算
        seal(addDays(TODAY, -1), 3),
      ],
      late: [{ day: addDays(TODAY, -2) }, { day: addDays(TODAY, -2) }, { day: addDays(TODAY, -40) }],
    }),
    NOW,
  );
  assert.equal(r.ride.seals, 5);
  assert.equal(r.ride.late, 3);
  assert.deepEqual(r.ride.routes, [
    { routeId: "r1", n: 2 },
    { routeId: null, n: 2 },
    { routeId: "r2", n: 1 },
  ]);
  assert.equal(r.ride.cmp, 4);
  assert.equal(r.brief.seals, 5);
  assert.equal(r.brief.recordedMs, null);
  assert.equal(r.brief.spent, null);
});

test("表格：7 天、今天在最上、今天不標誤點、誤點歸到原本那天", () => {
  const r = buildOperationReport(
    facts({
      seals: [seal(TODAY, 1), seal(addDays(TODAY, -2), 1)],
      late: [{ day: addDays(TODAY, -2) }, { day: TODAY }],
      dueByDay: { [addDays(TODAY, -3)]: 2 },
    }),
    NOW,
  );
  const days = dayRows(r);
  assert.equal(days.length, 7);
  assert.equal(days[0].day, TODAY);
  assert.ok(days[0].isToday);
  assert.equal(days[0].late, 0);
  assert.equal(days[2].late, 1);
  assert.equal(days[2].seals, 1);
  assert.equal(days[3].due, 2);
  assert.equal(days[6].day, addDays(TODAY, -6));
  // 模組沒通車：那幾欄 null
  assert.equal(days[0].timeMs, null);
  assert.equal(days[0].spent, null);
  assert.equal(days[0].notes, null);
  assert.equal(r.hasDayNotes, false);
});

test("每週合計（週一起）：本週沒過完比上週同樣天數、過去的週不完整就沒有合計、近 7 天最後一列上週合計（參考）", () => {
  // 今天週三：本週＝週一～週三 3 天；上週同期＝上週一～三
  const mon = "2026-11-02";
  const lastMon = "2026-10-26";
  const r = buildOperationReport(
    facts({
      seals: [seal(mon, 1), seal(TODAY, 1), seal(lastMon, 1), seal(addDays(lastMon, 1), 1), seal(addDays(lastMon, 2), 1), seal(addDays(lastMon, 5), 1)],
    }),
    NOW,
  );
  const sums = sumRows(r);
  assert.equal(sums.length, 2);
  const [thisWeek, ref] = sums;
  assert.equal(thisWeek.which, "this");
  assert.equal(thisWeek.seals, 2);
  assert.deepEqual(thisWeek.cmp?.seals, 2 - 3);
  assert.equal(thisWeek.cmpLabel, "比上週同期");
  assert.equal(ref.reference, true);
  assert.equal(ref.which, "last");
  assert.equal(ref.seals, 4);
  assert.equal(ref.cmp, null);
  // 列的順序：本週三天 → 本週合計 → 上週剩下四天 → 上週合計（參考）
  assert.deepEqual(
    r.rows.map((x) => (x.kind === "day" ? x.day.slice(5) : x.reference ? "ref" : "sum")),
    ["11-04", "11-03", "11-02", "sum", "11-01", "10-31", "10-30", "10-29", "ref"],
  );
});

test("近 30 天：完整的週才有合計、比上一整週；最舊的不完整週沒有合計", () => {
  const r = buildOperationReport(facts({ days: 30 }), NOW);
  const days = dayRows(r);
  assert.equal(days.length, 30);
  const sums = sumRows(r);
  // 本週（3 天）＋ 4 個完整週；最舊那段（30−3−28＝−1 ⇒ 實際 30 = 3 + 4×7 − 1）不完整
  assert.equal(sums[0].which, "this");
  assert.ok(sums.slice(1).every((s) => !s.reference && s.cmpLabel === "比上週"));
  assert.equal(sums[1].which, "last");
  assert.equal(sums[2].which, "week");
  // 每個合計列前面那一週都是 7 天（本週除外）
  let run = 0;
  for (const x of r.rows) {
    if (x.kind === "day") run++;
    else {
      if (x.which !== "this") assert.equal(run, 7);
      run = 0;
    }
  }
  assert.ok(sums.every((s) => s.cmp !== null)); // 讀進來的範圍夠比
});

test("今天剛好是週末（週日）：本週完整、標「比上週」", () => {
  const sun = "2026-11-08";
  const r = buildOperationReport(facts({ today: sun }), Date.parse(at(sun, 5)));
  const [s] = sumRows(r);
  assert.equal(s.which, "this");
  assert.equal(s.cmpLabel, "比上週");
  assert.equal(dayRows(r).length, 7);
});

test("時刻表卡：前三分類＋其他、比較用 prevSameSpanMs；表格每天", () => {
  const r = buildOperationReport(
    facts({
      time: {
        byDay: { [TODAY]: 400 * 60_000, [addDays(TODAY, -1)]: 60 * 60_000 },
        todayCats: [
          { id: "a", name: "讀書", ms: 180 },
          { id: "b", name: "開發", ms: 130 },
          { id: "c", name: "通勤", ms: 50 },
          { id: "d", name: "休息", ms: 30 },
          { id: "e", name: "家事", ms: 10 },
        ],
        prevSameSpanMs: 260 * 60_000,
      },
    }),
    NOW,
  );
  assert.equal(r.time?.ms, 400 * 60_000);
  assert.deepEqual(r.time?.cats.map((c) => [c.name, c.ms]), [["讀書", 180], ["開發", 130], ["通勤", 50], ["其他", 40]]);
  assert.equal(r.time?.cmp, 140 * 60_000);
  assert.equal(dayRows(r)[1].timeMs, 60 * 60_000);
  assert.equal(r.max.timeMs, 400 * 60_000);
  assert.equal(r.brief.recordedMs, 400 * 60_000);
});

test("售票口卡：今天花了、最大兩個分類、比上週同一天到同一個時刻、預算原樣帶出", () => {
  const lw = addDays(TODAY, -7);
  const r = buildOperationReport(
    facts({
      money: {
        expenses: [
          { day: TODAY, at: at(TODAY, 1), minor: 255, category: "餐飲" },
          { day: TODAY, at: at(TODAY, 2), minor: 130, category: "交通" },
          { day: TODAY, at: at(TODAY, 3), minor: -20, category: "日用" }, // 退款
          { day: lw, at: at(lw, 1), minor: 300, category: "餐飲" },
          { day: lw, at: at(lw, 15), minor: 999, category: "餐飲" }, // 晚於此刻
        ],
        decimals: 0,
        budget: { month: "2026-11", budget: 12000, used: 385, remaining: 11615 },
      },
    }),
    NOW,
  );
  assert.equal(r.money?.spent, 365);
  assert.deepEqual(r.money?.topCats, [
    { name: "餐飲", minor: 255 },
    { name: "交通", minor: 130 },
  ]);
  assert.equal(r.money?.cmp, 65);
  assert.equal(r.money?.budget?.remaining, 11615);
  assert.equal(dayRows(r)[0].spent, 365);
  assert.equal(r.brief.spent, 365);
});

test("旅客筆記卡＋表格：則數、日記的日子、比較", () => {
  const lw = addDays(TODAY, -7);
  const r = buildOperationReport(
    facts({
      notes: {
        notedAt: [at(TODAY, 1), at(TODAY, 2), at(TODAY, 3), at(lw, 1), at(addDays(TODAY, -1), 1)],
        diaryDays: [TODAY, addDays(TODAY, -3)],
      },
    }),
    NOW,
  );
  assert.deepEqual(r.notes, { count: 3, diary: true, cmp: 2 });
  const days = dayRows(r);
  assert.equal(days[1].notes, 1);
  assert.equal(days[3].diary, true);
  assert.equal(days[2].diary, false);
  const [thisWeek] = sumRows(r);
  assert.equal(thisWeek.notes, 4);
  assert.equal(thisWeek.diaryDays, 1);
});

test("締切卡：今天起 7 天內、最多 3 筆", () => {
  const d = (day: string, name: string) => ({ day, nodeId: name, name, routeId: null, temp: true });
  const r = buildOperationReport(
    facts({ dueSoon: [d(TODAY, "a"), d(addDays(TODAY, 2), "b"), d(addDays(TODAY, 6), "c"), d(addDays(TODAY, 6), "d"), d(addDays(TODAY, 7), "e")] }),
    NOW,
  );
  assert.equal(r.due.count, 4);
  assert.deepEqual(r.due.items.map((x) => x.name), ["a", "b", "c"]);
});

test("記事欄：有來源才畫，按日帶出", () => {
  const r = buildOperationReport(facts({ dayNotes: { [addDays(TODAY, -1)]: ["E1 車站「同步」到着"] } }), NOW);
  assert.equal(r.hasDayNotes, true);
  assert.deepEqual(dayRows(r)[1].dayNotes, ["E1 車站「同步」到着"]);
  assert.deepEqual(dayRows(r)[0].dayNotes, []);
});

test("reportTimeFacts：每天已記錄（碎塊不算、待確認不算）、今天分類、上週同一段", () => {
  const span = (id: string, day: string, h0: number, h1: number | null, cat = "c1", ack = true) => ({
    id,
    categoryId: cat,
    start: Date.parse(at(day, h0)),
    end: h1 === null ? null : Date.parse(at(day, h1)),
    ack,
    estimateMin: null,
    nodeId: null,
    routeId: null,
    tagKeys: [],
  });
  const lw = addDays(TODAY, -7);
  const t = reportTimeFacts({
    spans: [
      span("a", TODAY, 1, 2),
      span("a2", TODAY, 2, 3, "c1a"), // 子分類：歸到主分類「讀書」
      span("b", TODAY, 3, 3.01, "c2"), // 36 秒＝碎塊
      span("c", TODAY, 5, null, "c2"), // 運行中，到 now（10 小時處）＝5h
      span("d", lw, 1, 2),
      span("e", lw, 11, 12), // 晚於此刻
      span("p", addDays(TODAY, -1), 1, 20, "c1", false), // 19 小時、沒確認、門檻 600 分 ⇒ 待確認
    ],
    threshold: () => 600,
    catTop: (id) => (id === "c1" ? { id: "c1", name: "讀書" } : id === "c1a" ? { id: "c1", name: "讀書" } : null),
    from: addDays(TODAY, -8),
    today: TODAY,
    dayStartHour: H,
    now: NOW,
  });
  assert.equal(t.byDay[TODAY], 7 * 3_600_000);
  assert.equal(t.byDay[addDays(TODAY, -1)], 0);
  assert.equal(t.byDay[lw], 2 * 3_600_000);
  assert.deepEqual(t.todayCats.map((c) => [c.name, c.ms]), [["已刪除的分類", 5 * 3_600_000], ["讀書", 2 * 3_600_000]]);
  assert.equal(t.prevSameSpanMs, 3_600_000);
});
