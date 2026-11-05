/**
 * 週方針的純函式（`src/domain/weekAims.ts`；戊 契約 §2、§3）＋同步登記（Rust 欄白名單 vs migration、TS 核心表名、本地鍵不進白名單）。
 * 跑法：`node --test scripts/tests/week-aims.test.ts`（node 24，型別剝除；零依賴）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AIM_ATTACH_KINDS,
  DAY_MAX,
  DAY_MIN,
  KEY_AIMS_FOLD,
  KEY_AIMS_REVIEW_SEEN,
  KEY_WEEK_AIMS_FOLD,
  KEY_WEEK_AIMS_REVIEW_SEEN,
  MAX_AIMS,
  WEEK_AIM_ID_NAMESPACE,
  adjacentKey,
  aimLimitMessage,
  aimNumeral,
  aimsOfKey,
  aimsOfWeek,
  carryAimId,
  carryCandidates,
  checkAimText,
  dayRangeWindow,
  defaultFolded,
  defaultFoldedOf,
  doneCount,
  foldValue,
  foldedOf,
  foldedOfKey,
  isLastDayOfWeek,
  keyRowBounds,
  monthKeyOf,
  pendingReviewKeys,
  pendingReviewWeek,
  periodOfKey,
  periodRangeOf,
  periodTitle,
  planDefaultDay,
  planHint,
  planSaveWeek,
  reviewMinutesText,
  stationIdOfKey,
  stationKeyOf,
  stationWindow,
  ticketPlacement,
  weekEndOf,
  weekOnOf,
  weekRangeText,
  weekRelText,
  yearKeyOf,
  type WeekAimRow,
} from "../../src/domain/weekAims.ts";
import { uuidv5 } from "../../src/lib/uuidv5.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function row(p: Partial<WeekAimRow> & { id: string }): WeekAimRow {
  return {
    week_on: "2026-10-26",
    text: p.id,
    node_id: null,
    position: 0,
    done_at: null,
    carried_from: null,
    account_id: null,
    device_id: null,
    created_at: "2026-10-26T00:00:00.000Z",
    updated_at: "2026-10-26T00:00:00.000Z",
    synced_at: null,
    deleted_at: null,
    ...p,
  };
}

describe("週的算術", () => {
  test("weekOnOf：週一起算／週日起算", () => {
    assert.equal(weekOnOf("2026-11-01", 1), "2026-10-26"); // 週日
    assert.equal(weekOnOf("2026-10-26", 1), "2026-10-26");
    assert.equal(weekOnOf("2026-11-02", 1), "2026-11-02");
    assert.equal(weekOnOf("2026-11-01", 0), "2026-11-01");
    assert.equal(weekOnOf("2026-10-31", 0), "2026-10-25");
    assert.equal(weekEndOf("2026-10-26"), "2026-11-01");
    assert.equal(weekRangeText("2026-10-26"), "10/26 – 11/1");
  });

  test("weekRelText：這週／上週／下週／M/D 那週", () => {
    assert.equal(weekRelText("2026-10-26", "2026-10-28", 1), "這週");
    assert.equal(weekRelText("2026-10-19", "2026-10-28", 1), "上週");
    assert.equal(weekRelText("2026-11-02", "2026-10-28", 1), "下週");
    assert.equal(weekRelText("2026-10-05", "2026-10-28", 1), "10/5 那週");
    assert.equal(weekRelText("2025-10-27", "2026-11-02", 1), "2025/10/27 那週");
  });

  test("isLastDayOfWeek：週一起算＝週日；週日起算＝週六", () => {
    assert.equal(isLastDayOfWeek("2026-11-01", 1), true);
    assert.equal(isLastDayOfWeek("2026-10-31", 1), false);
    assert.equal(isLastDayOfWeek("2026-10-31", 0), true);
  });

  test("aimsOfWeek：區間內、沒刪、照順序（撞號看建立時間）；改了週起始日的舊列照落在包含它的週", () => {
    const rows = [
      row({ id: "b", position: 1 }),
      row({ id: "a", position: 0 }),
      row({ id: "c", position: 1, created_at: "2026-10-25T00:00:00.000Z" }),
      row({ id: "x", deleted_at: "2026-10-27T00:00:00.000Z" }),
      row({ id: "n", week_on: "2026-11-02" }),
    ];
    assert.deepEqual(aimsOfWeek(rows, "2026-10-26").map((r) => r.id), ["a", "c", "b"]);
    // 改成週日起算：10/25 那週（10/25–10/31）包含 week_on 10/26 的舊列
    assert.deepEqual(aimsOfWeek(rows, "2026-10-25").map((r) => r.id), ["a", "c", "b"]);
    assert.deepEqual(doneCount([row({ id: "1", done_at: "x" }), row({ id: "2" })]), { done: 1, total: 2 });
  });
});

describe("文字與寫方針框", () => {
  test("checkAimText：正規化空白、空字擋、超長擋", () => {
    assert.equal(checkAimText("  跑\n三次  "), "跑 三次");
    assert.throws(() => checkAimText("   "), /不能是空的/);
    assert.throws(() => checkAimText("字".repeat(61)), /最多 60 個字/);
    assert.equal(aimNumeral(0), "一、");
    assert.equal(aimNumeral(4), "五、");
  });

  test("planSaveWeek：新、改、刪、換位置；空字列略過", () => {
    const cur = [row({ id: "a", text: "甲", position: 0 }), row({ id: "b", text: "乙", position: 1, node_id: "R" }), row({ id: "c", text: "丙", position: 2 })];
    const p = planSaveWeek(cur, [
      { id: "b", text: "乙", nodeId: null, carriedFrom: null },
      { id: "a", text: "甲改", nodeId: null, carriedFrom: null },
      { id: null, text: "  ", nodeId: null, carriedFrom: null },
      { id: null, text: "丁", nodeId: "R2", carriedFrom: null },
    ]);
    assert.deepEqual(p.creates, [{ id: null, text: "丁", nodeId: "R2", position: 2, carriedFrom: null }]);
    assert.deepEqual(p.updates, [
      { id: "b", nodeId: null, position: 0 },
      { id: "a", text: "甲改", position: 1 },
    ]);
    assert.deepEqual(p.deletes, ["c"]);
    assert.deepEqual(planSaveWeek(cur, cur.map((r) => ({ id: r.id, text: r.text, nodeId: r.node_id, carriedFrom: null }))), {
      creates: [],
      updates: [],
      deletes: [],
    });
  });

  test("planSaveWeek：上限五句；兩台合起來已經六句的週不加新句照樣能存", () => {
    const six = Array.from({ length: 6 }, (_, i) => row({ id: `r${i}`, text: `句${i}`, position: i }));
    const keep = six.map((r) => ({ id: r.id, text: r.text, nodeId: null, carriedFrom: null }));
    assert.doesNotThrow(() => planSaveWeek(six, keep));
    assert.throws(() => planSaveWeek(six, [...keep, { id: null, text: "七", nodeId: null, carriedFrom: null }]), new RegExp(`最多 ${MAX_AIMS} 句`));
    assert.doesNotThrow(() => planSaveWeek(six, [...keep.slice(0, 4), { id: null, text: "新", nodeId: null, carriedFrom: null }]));
  });

  test("carryCandidates：沒済、沒刪，照順序", () => {
    const rows = [row({ id: "a", position: 1 }), row({ id: "b", done_at: "x" }), row({ id: "c", position: 0 }), row({ id: "d", deleted_at: "x" })];
    assert.deepEqual(carryCandidates(rows).map((r) => r.id), ["c", "a"]);
  });
});

describe("排成車票", () => {
  test("ticketPlacement：能放就放底下（支線、列車）；路線＝臨時票＋路線標籤；沒掛＝臨時票（丁放寬後，D-主-281）", () => {
    assert.deepEqual(ticketPlacement(null), { parentId: null, routeTagId: null });
    assert.deepEqual(ticketPlacement({ id: "T", kind: "train", route_id: "R" }), { parentId: "T", routeTagId: null });
    // 路線底下還是不能直接放票（路線＝支線｜列車｜車站）
    assert.deepEqual(ticketPlacement({ id: "R", kind: "route", route_id: null }), { parentId: null, routeTagId: "R" });
    // 支線底下可以直接放票 ⇒ 排成車票建在支線底下
    assert.deepEqual(ticketPlacement({ id: "B", kind: "branch", route_id: "R" }), { parentId: "B", routeTagId: null });
    assert.deepEqual(AIM_ATTACH_KINDS, ["route", "branch"]);
  });

  test("planDefaultDay：這週還沒過的第一天；過去的週＝今天", () => {
    assert.equal(planDefaultDay("2026-10-28", "2026-10-26"), "2026-10-28");
    assert.equal(planDefaultDay("2026-10-28", "2026-11-02"), "2026-11-02");
    assert.equal(planDefaultDay("2026-10-28", "2026-10-19"), "2026-10-28");
  });

  test("planHint：沒排不畫；全済而方針還沒済＝提示（不自動蓋）", () => {
    assert.equal(planHint(false, undefined), null);
    assert.equal(planHint(false, { planned: 0, done: 0 }), null);
    assert.equal(planHint(false, { planned: 2, done: 1 }), "已排 2 張・済 1");
    assert.equal(planHint(false, { planned: 2, done: 2 }), "排的票都済了");
    assert.equal(planHint(true, { planned: 2, done: 2 }), "已排 2 張・済 2");
  });
});

describe("收合與回顧", () => {
  test("defaultFolded：週首到週二展開、週三起收合（兩種週起始日）", () => {
    assert.equal(defaultFolded("2026-10-26", "2026-10-26"), false); // 一
    assert.equal(defaultFolded("2026-10-27", "2026-10-26"), false); // 二
    assert.equal(defaultFolded("2026-10-28", "2026-10-26"), true); // 三
    assert.equal(defaultFolded("2026-11-01", "2026-10-26"), true); // 日
    assert.equal(defaultFolded("2026-10-25", "2026-10-25"), false); // 週日起算：日
    assert.equal(defaultFolded("2026-10-27", "2026-10-25"), false); // 二
    assert.equal(defaultFolded("2026-10-28", "2026-10-25"), true); // 三
  });

  test("foldedOf：只認這週記的；別週＝預設", () => {
    assert.equal(foldedOf(foldValue("2026-10-26", true), "2026-10-26", "2026-10-26"), true);
    assert.equal(foldedOf(foldValue("2026-10-26", false), "2026-10-29", "2026-10-26"), false);
    assert.equal(foldedOf(foldValue("2026-10-19", true), "2026-10-26", "2026-10-26"), false);
    assert.equal(foldedOf("壞值", "2026-10-29", "2026-10-26"), true);
    assert.equal(foldedOf(null, "2026-10-26", "2026-10-26"), false);
  });

  test("pendingReviewWeek：上週有方針、還沒看過才出", () => {
    assert.equal(pendingReviewWeek("2026-11-02", 1, true, null), "2026-10-26");
    assert.equal(pendingReviewWeek("2026-11-02", 1, false, null), null);
    assert.equal(pendingReviewWeek("2026-11-02", 1, true, "2026-10-26"), null);
    assert.equal(pendingReviewWeek("2026-11-02", 1, true, "2026-10-19"), "2026-10-26");
  });

  test("reviewMinutesText", () => {
    assert.equal(reviewMinutesText(null), null);
    assert.equal(reviewMinutesText(0), null);
    assert.equal(reviewMinutesText(45), "45m");
    assert.equal(reviewMinutesText(220), "3h40m");
    assert.equal(reviewMinutesText(120), "2h");
  });
});

describe("同步登記", () => {
  test("Rust core.rs 的 week_aims 欄白名單＝migration 的主人資料欄；必填＝NOT NULL 沒 DEFAULT", () => {
    const rs = readFileSync(path.join(ROOT, "src-tauri/src/sync/tables/core.rs"), "utf8");
    const block = rs.slice(rs.indexOf("const WEEK_AIMS_COLS"), rs.indexOf("];", rs.indexOf("const WEEK_AIMS_COLS")));
    const cols = [...block.matchAll(/\("(\w+)", (true|false)\)/g)].map((m) => [m[1], m[2] === "true"]);
    assert.deepEqual(cols, [
      ["week_on", false],
      ["text", false],
      ["node_id", false],
      ["position", true],
      ["done_at", false],
      ["carried_from", false],
      ["created_at", false],
      ["updated_at", false],
      ["deleted_at", false],
    ]);
    assert.match(rs, /required: &\["week_on", "text"\]/);
    assert.match(rs, /since: Some\("week_aims"\)/);
    const sql = readFileSync(path.join(ROOT, "src-tauri/migrations", readdirSqlWeekAims()), "utf8");
    for (const [c] of cols) assert.match(sql, new RegExp(`\\n\\s+${c}\\s`), `migration 沒有欄 ${c}`);
  });

  test("TS 核心表名有 week_aims、本地鍵不進同步白名單、合併通知有名詞", async () => {
    const { CORE_SYNC_TABLES, SYNC_SETTINGS_KEYS } = await import("../../src/data/syncTables.ts");
    assert.equal(CORE_SYNC_TABLES[CORE_SYNC_TABLES.length - 1], "week_aims");
    assert.ok(!SYNC_SETTINGS_KEYS.includes(KEY_WEEK_AIMS_FOLD));
    assert.ok(!SYNC_SETTINGS_KEYS.includes(KEY_WEEK_AIMS_REVIEW_SEEN));
    const merge = readFileSync(path.join(ROOT, "src/domain/syncMerge.ts"), "utf8");
    assert.match(merge, /week_aims: \{ noun: "方針", unit: "句" \}/);
  });
});

/** week_aims 那支 migration 的檔名（改正式號後檔名會變，從 migrations.rs 的登記行讀） */
function readdirSqlWeekAims(): string {
  const all = readFileSync(path.join(ROOT, "src-tauri/src/migrations.rs"), "utf8");
  const m = all.match(/mig!\(\d+, "(\d{4}_week_aims)"/);
  assert.ok(m, "migrations.rs 沒登記 week_aims");
  return `${m![1]}.sql`;
}

/* ───────────── 方針擴充：月、年、車站（辛；契約 2026-11-04 §1、§2、§7）。上面週方針的測試一條不動 ───────────── */

describe("期間鍵", () => {
  test("編解碼往返：週、月、年、站；週的鍵不是車站", () => {
    assert.equal(periodOfKey("2026-11-02"), "week");
    assert.equal(monthKeyOf("2026-11-04"), "M2026-11");
    assert.equal(periodOfKey(monthKeyOf("2026-11-04")), "month");
    assert.equal(yearKeyOf("2026-11-04"), "Y2026");
    assert.equal(periodOfKey(yearKeyOf("2026-11-04")), "year");
    const id = "0f3c9d2e-1111-4222-8333-444455556666";
    assert.equal(stationKeyOf(id), `S${id}`);
    assert.equal(periodOfKey(stationKeyOf(id)), "station");
    assert.equal(stationIdOfKey(stationKeyOf(id)), id);
    assert.equal(stationIdOfKey("2026-11-02"), null);
    assert.equal(stationIdOfKey("M2026-11"), null);
    assert.equal(stationIdOfKey("Y2026"), null);
  });

  test("periodRangeOf：週首～+6、月底（平年、閏年、大小月）、整年；車站丟 RangeError", () => {
    assert.deepEqual(periodRangeOf("2026-10-26"), { from: "2026-10-26", to: "2026-11-01" });
    assert.deepEqual(periodRangeOf("M2026-11"), { from: "2026-11-01", to: "2026-11-30" });
    assert.deepEqual(periodRangeOf("M2026-12"), { from: "2026-12-01", to: "2026-12-31" });
    assert.deepEqual(periodRangeOf("M2026-02"), { from: "2026-02-01", to: "2026-02-28" });
    assert.deepEqual(periodRangeOf("M2028-02"), { from: "2028-02-01", to: "2028-02-29" });
    assert.deepEqual(periodRangeOf("Y2026"), { from: "2026-01-01", to: "2026-12-31" });
    assert.throws(() => periodRangeOf(stationKeyOf("x")), RangeError);
  });

  test("adjacentKey：週 ±7 天、月底與跨年、年 ±1；車站丟 RangeError；一路翻十二個月回得來", () => {
    assert.equal(adjacentKey("2026-10-26", 1), "2026-11-02");
    assert.equal(adjacentKey("2026-11-02", -1), "2026-10-26");
    assert.equal(adjacentKey("2026-12-28", 1), "2027-01-04");
    assert.equal(adjacentKey("M2026-10", 1), "M2026-11");
    assert.equal(adjacentKey("M2026-12", 1), "M2027-01");
    assert.equal(adjacentKey("M2027-01", -1), "M2026-12");
    assert.equal(adjacentKey("Y2026", 1), "Y2027");
    assert.equal(adjacentKey("Y2026", -1), "Y2025");
    assert.throws(() => adjacentKey(stationKeyOf("x"), 1), RangeError);
    let k = "M2026-03";
    for (let i = 0; i < 12; i++) k = adjacentKey(k, 1);
    assert.equal(k, "M2027-03");
    for (let i = 0; i < 12; i++) k = adjacentKey(k, -1);
    assert.equal(k, "M2026-03");
  });

  test("aimsOfKey：週＝區間、不混月年站；其他＝等於鍵；都濾已刪、照順序", () => {
    const rows = [
      row({ id: "w", week_on: "2026-10-26" }),
      row({ id: "w2", week_on: "2026-10-27" }), // 改過週起始日的舊列：一樣落在包含它的週
      row({ id: "m2", week_on: "M2026-11", position: 1 }),
      row({ id: "m1", week_on: "M2026-11", position: 0 }),
      row({ id: "mx", week_on: "M2026-11", deleted_at: "x" }),
      row({ id: "m0", week_on: "M2026-10" }),
      row({ id: "y", week_on: "Y2026" }),
      row({ id: "s", week_on: "Sabc" }),
    ];
    assert.deepEqual(aimsOfKey(rows, "2026-10-26").map((r) => r.id), ["w", "w2"]);
    assert.deepEqual(aimsOfKey(rows, "M2026-11").map((r) => r.id), ["m1", "m2"]);
    assert.deepEqual(aimsOfKey(rows, "Y2026").map((r) => r.id), ["y"]);
    assert.deepEqual(aimsOfKey(rows, "Sabc").map((r) => r.id), ["s"]);
    assert.deepEqual(aimsOfKey(rows, "Sother"), []);
    // 舊匯出照舊：混合資料裡也只撈週
    assert.deepEqual(aimsOfWeek(rows, "2026-10-26").map((r) => r.id), ["w", "w2"]);
  });

  test("keyRowBounds：週＝區間；其他＝鍵本身", () => {
    assert.deepEqual(keyRowBounds("2026-10-26"), { from: "2026-10-26", to: "2026-11-01" });
    assert.deepEqual(keyRowBounds("M2026-11"), { from: "M2026-11", to: "M2026-11" });
    assert.deepEqual(keyRowBounds("Sabc"), { from: "Sabc", to: "Sabc" });
  });
});

describe("車站期間", () => {
  const st = (id: string, arrived_on: string | null = null, expected_on: string | null = null) => ({ id, arrived_on, expected_on });

  test("沒有上一站＝頭不限；沒有預定日＝尾不限", () => {
    const a = st("a");
    assert.deepEqual(stationWindow(a, [a, st("b")]), { from: DAY_MIN, to: DAY_MAX });
    assert.equal(DAY_MIN, "0000-01-01");
    assert.equal(DAY_MAX, "9999-12-31");
    const withDue = st("a", null, "2026-12-06");
    assert.deepEqual(stationWindow(withDue, [withDue]), { from: DAY_MIN, to: DAY_MAX });
  });

  test("上一站到站日～這站到站日；還沒到不看預定日（D-主-383）", () => {
    const a = st("a", "2026-10-01");
    const b = st("b", null, "2026-12-06");
    assert.deepEqual(stationWindow(b, [a, b]), { from: "2026-10-01", to: DAY_MAX });
    const b2 = st("b", "2026-11-20", "2026-12-06");
    assert.deepEqual(stationWindow(b2, [a, b2]), { from: "2026-10-01", to: "2026-11-20" });
    assert.deepEqual(stationWindow(a, [a, b2]), { from: DAY_MIN, to: "2026-10-01" });
  });

  test("上一站還沒到：往前找最近一個到過的；都沒到過＝不限", () => {
    const a = st("a", "2026-10-01");
    const b = st("b");
    const c = st("c", null, "2027-01-01");
    assert.deepEqual(stationWindow(c, [a, b, c]), { from: "2026-10-01", to: DAY_MAX });
    assert.deepEqual(stationWindow(c, [st("a"), b, c]), { from: DAY_MIN, to: DAY_MAX });
  });

  test("不限的一端算得出能照字串比的日界線視窗（不會出現 +010000 年）", () => {
    const w = dayRangeWindow({ from: DAY_MIN, to: DAY_MAX }, 6);
    assert.ok(w.start < "2000-01-01T00:00:00.000Z");
    assert.ok(w.end > "2999-01-01T00:00:00.000Z");
    assert.ok(Number.isFinite(Date.parse(w.start)) && Number.isFinite(Date.parse(w.end)));
    assert.equal(dayRangeWindow({ from: "2026-11-01", to: "2026-11-30" }, 6).start, new Date(2026, 10, 1, 6).toISOString());
    assert.equal(dayRangeWindow({ from: "2026-11-01", to: "2026-11-30" }, 6).end, new Date(2026, 11, 1, 6).toISOString());
  });
});

describe("各期間的預設與字", () => {
  test("planDefaultDay：鍵或範圍；月、年＝max(今天, 期首)，過去那一期＝今天；車站＝今天", () => {
    assert.equal(planDefaultDay("2026-11-04", "M2026-11"), "2026-11-04");
    assert.equal(planDefaultDay("2026-11-04", "M2026-12"), "2026-12-01");
    assert.equal(planDefaultDay("2026-11-04", "M2026-10"), "2026-11-04");
    assert.equal(planDefaultDay("2026-11-04", "Y2026"), "2026-11-04");
    assert.equal(planDefaultDay("2026-11-04", "Y2027"), "2027-01-01");
    assert.equal(planDefaultDay("2026-11-04", "Y2025"), "2026-11-04");
    assert.equal(planDefaultDay("2026-11-04", stationKeyOf("x")), "2026-11-04");
    assert.equal(planDefaultDay("2026-11-04", { from: DAY_MIN, to: DAY_MAX }), "2026-11-04");
    assert.equal(planDefaultDay("2026-11-04", { from: "2026-10-01", to: "2026-10-31" }), "2026-11-04");
    assert.equal(planDefaultDay("2026-11-04", { from: "2026-11-10", to: "2026-11-30" }), "2026-11-10");
  });

  test("defaultFoldedOf：週同舊函式；月 1～7 日展開；年 1 月展開；車站展開；過去收、未來開", () => {
    assert.equal(defaultFoldedOf("week", "2026-10-27", "2026-10-26"), false);
    assert.equal(defaultFoldedOf("week", "2026-10-28", "2026-10-26"), true);
    assert.equal(defaultFoldedOf("month", "2026-11-01", "M2026-11"), false);
    assert.equal(defaultFoldedOf("month", "2026-11-07", "M2026-11"), false);
    assert.equal(defaultFoldedOf("month", "2026-11-08", "M2026-11"), true);
    assert.equal(defaultFoldedOf("month", "2026-11-04", "M2026-10"), true);
    assert.equal(defaultFoldedOf("month", "2026-11-04", "M2026-12"), false);
    assert.equal(defaultFoldedOf("year", "2026-01-31", "Y2026"), false);
    assert.equal(defaultFoldedOf("year", "2026-02-01", "Y2026"), true);
    assert.equal(defaultFoldedOf("year", "2026-11-04", "Y2025"), true);
    assert.equal(defaultFoldedOf("year", "2026-11-04", "Y2027"), false);
    assert.equal(defaultFoldedOf("station", "2026-11-04", stationKeyOf("x")), false);
  });

  test("foldedOfKey：只認這一期記的；別期與壞值＝預設", () => {
    assert.equal(foldedOfKey(foldValue("M2026-11", false), "2026-11-20", "M2026-11"), false);
    assert.equal(foldedOfKey(foldValue("M2026-10", false), "2026-11-20", "M2026-11"), true);
    assert.equal(foldedOfKey(foldValue("Y2026", true), "2026-01-02", "Y2026"), true);
    assert.equal(foldedOfKey(foldValue("Sabc", true), "2026-11-04", "Sabc"), true);
    assert.equal(foldedOfKey(foldValue("Sabc", true), "2026-11-04", "Sdef"), false);
    assert.equal(foldedOfKey(foldValue("2026-10-26", true), "2026-10-26", "2026-10-26"), true);
    assert.equal(foldedOfKey("壞值", "2026-11-20", "M2026-11"), true);
    assert.equal(foldedOfKey(null, "2026-11-02", "M2026-11"), false);
  });

  test("periodTitle：本週／本月／今年；翻到別期；車站", () => {
    const today = "2026-11-04";
    assert.deepEqual(periodTitle("2026-11-02", today, 1), { title: "本週方針", latin: "This week", range: "11/2 – 11/8", rel: "這週" });
    assert.equal(periodTitle("2026-10-26", today, 1).title, "上週的方針");
    assert.deepEqual(periodTitle("M2026-11", today, 1), { title: "本月方針", latin: "November", range: "11/1 – 11/30", rel: "這個月" });
    assert.deepEqual(periodTitle("M2026-10", today, 1), { title: "10月的方針", latin: "October", range: "10/1 – 10/31", rel: "上個月" });
    assert.equal(periodTitle("M2026-12", today, 1).rel, "下個月");
    assert.equal(periodTitle("M2026-08", today, 1).rel, "8月");
    assert.equal(periodTitle("M2025-11", today, 1).title, "2025年11月的方針");
    assert.deepEqual(periodTitle("Y2026", today, 1), { title: "今年方針", latin: "2026", range: "1/1 – 12/31", rel: "今年" });
    assert.deepEqual(periodTitle("Y2025", today, 1), { title: "2025 年的方針", latin: "2025", range: "1/1 – 12/31", rel: "去年" });
    assert.equal(periodTitle("Y2027", today, 1).rel, "明年");
    assert.equal(periodTitle("Y2020", today, 1).rel, "2020 年");
    assert.equal(periodTitle(stationKeyOf("x"), today, 1).rel, "這一站");
    assert.equal(periodTitle(stationKeyOf("x"), today, 1).range, "");
  });
});

describe("回顧排隊", () => {
  const none = { week: null, month: null, year: null };
  const all = () => true;

  test("新的一年第一週：週→月→年依序", () => {
    assert.deepEqual(pendingReviewKeys("2027-01-04", 1, all, none), ["2026-12-28", "M2026-12", "Y2026"]);
  });

  test("上一期沒方針就跳過；不會出這一期", () => {
    assert.deepEqual(pendingReviewKeys("2027-01-04", 1, (k) => k === "M2026-12", none), ["M2026-12"]);
    assert.deepEqual(pendingReviewKeys("2027-01-04", 1, () => false, none), []);
    assert.ok(!pendingReviewKeys("2026-11-04", 1, all, none).includes("M2026-11"));
  });

  test("看過就不再出，各記各的；記的是更早那期還是要出；關掉一張就輪下一張", () => {
    assert.deepEqual(pendingReviewKeys("2026-11-04", 1, all, { week: "2026-10-26", month: "M2026-10", year: "Y2025" }), []);
    assert.deepEqual(pendingReviewKeys("2026-11-04", 1, all, { week: "2026-10-26", month: "M2026-09", year: "Y2024" }), ["M2026-10", "Y2025"]);
    assert.deepEqual(pendingReviewKeys("2026-11-04", 1, all, { week: "2026-10-26", month: "M2026-10", year: "Y2024" }), ["Y2025"]);
    assert.deepEqual(pendingReviewKeys("2026-11-04", 1, all, { week: "2026-10-19", month: "M2026-10", year: "Y2025" }), ["2026-10-26"]);
  });

  test("週的判斷跟舊的 pendingReviewWeek 一致（兩種週起始日）", () => {
    for (const ws of [0, 1] as const) {
      const old = pendingReviewWeek("2026-11-04", ws, true, null);
      assert.equal(pendingReviewKeys("2026-11-04", ws, (k) => k === old, none)[0], old);
    }
  });
});

describe("方針擴充的寫入與本地鍵", () => {
  test("五句上限的字隨期間；週的字不變", () => {
    assert.equal(aimLimitMessage("2026-10-26"), "一週最多 5 句");
    assert.equal(aimLimitMessage("M2026-11"), "一個月最多 5 句");
    assert.equal(aimLimitMessage("Y2026"), "一年最多 5 句");
    assert.equal(aimLimitMessage("Sabc"), "一站最多 5 句");
    const six = ["一", "二", "三", "四", "五", "六"].map((t) => ({ id: null, text: t, nodeId: null, carriedFrom: null }));
    assert.throws(() => planSaveWeek([], six), /一週最多 5 句/);
    assert.throws(() => planSaveWeek([], six, "M2026-11"), /一個月最多 5 句/);
    assert.throws(() => planSaveWeek([], six, "Y2026"), /一年最多 5 句/);
    assert.throws(() => planSaveWeek([], six, "Sabc"), /一站最多 5 句/);
  });

  test("carryAimId：週的 id 算法結果不變（金樣）；同一句帶到不同期＝不同 id", async () => {
    assert.equal(await carryAimId("source-1", "2026-11-02"), "cfc5b01b-6cc8-5700-bcc2-ca1d67e7522a");
    assert.equal(await carryAimId("source-1", "2026-11-02"), await uuidv5(WEEK_AIM_ID_NAMESPACE, "carry:source-1|2026-11-02"));
    const m = await carryAimId("source-1", "M2026-12");
    assert.equal(m, await uuidv5(WEEK_AIM_ID_NAMESPACE, "carry:source-1|M2026-12"));
    assert.equal(m, await carryAimId("source-1", "M2026-12"));
    assert.notEqual(m, await carryAimId("source-1", "M2027-01"));
    assert.notEqual(await carryAimId("source-1", "Y2027"), await carryAimId("source-1", "Sabc"));
  });

  test("新的本地鍵不進同步白名單；週沿用舊鍵", async () => {
    const { SYNC_SETTINGS_KEYS } = await import("../../src/data/syncTables.ts");
    assert.equal(KEY_AIMS_FOLD.week, KEY_WEEK_AIMS_FOLD);
    assert.equal(KEY_AIMS_REVIEW_SEEN.week, KEY_WEEK_AIMS_REVIEW_SEEN);
    assert.deepEqual([KEY_AIMS_FOLD.month, KEY_AIMS_FOLD.year, KEY_AIMS_FOLD.station], ["aims_fold_month", "aims_fold_year", "aims_fold_station"]);
    assert.deepEqual([KEY_AIMS_REVIEW_SEEN.month, KEY_AIMS_REVIEW_SEEN.year], ["aims_review_seen_month", "aims_review_seen_year"]);
    for (const k of [...Object.values(KEY_AIMS_FOLD), ...Object.values(KEY_AIMS_REVIEW_SEEN)]) assert.ok(!SYNC_SETTINGS_KEYS.includes(k), k);
  });
});
