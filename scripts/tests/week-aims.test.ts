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
  KEY_WEEK_AIMS_FOLD,
  KEY_WEEK_AIMS_REVIEW_SEEN,
  MAX_AIMS,
  aimNumeral,
  aimsOfWeek,
  carryCandidates,
  checkAimText,
  defaultFolded,
  doneCount,
  foldValue,
  foldedOf,
  isLastDayOfWeek,
  pendingReviewWeek,
  planDefaultDay,
  planHint,
  planSaveWeek,
  reviewMinutesText,
  ticketPlacement,
  weekEndOf,
  weekOnOf,
  weekRangeText,
  weekRelText,
  type WeekAimRow,
} from "../../src/domain/weekAims.ts";

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
    assert.match(merge, /week_aims: \{ noun: "週方針", unit: "句" \}/);
  });
});

/** week_aims 那支 migration 的檔名（改正式號後檔名會變，從 migrations.rs 的登記行讀） */
function readdirSqlWeekAims(): string {
  const all = readFileSync(path.join(ROOT, "src-tauri/src/migrations.rs"), "utf8");
  const m = all.match(/mig!\(\d+, "(\d{4}_week_aims)"/);
  assert.ok(m, "migrations.rs 沒登記 week_aims");
  return `${m![1]}.sql`;
}
