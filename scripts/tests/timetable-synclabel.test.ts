/**
 * 時刻表線③ 同步清單列（`src/lines/timetableSyncLabel.ts`）的純函式測試（③ 契約 0-13、D-時-58、0-3；丙席）。
 * 跑法：`node --test scripts/tests/timetable-synclabel.test.ts`（node 24，型別剝除；零依賴）。
 *
 * 文案：正式版由 `timetable.mount.tsx` 傳 `TT_TEXT`（store 在 node 載不起來）；這裡傳一份同形的測試字表，
 * 驗的是「怎麼組」（日期省略、運行中、已刪除補一句、欄值怎麼印、不認得的欄退回 null）。核心 `describeMerge` 的接法另驗一支。
 * 時區：測資用本地時刻 `T(...)`（同 timetable-logic.test.ts），ISO 由它轉。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  blockLabel,
  blockSyncLabel,
  categorySyncLabel,
  goalSyncLabel,
  localStamp,
  mdOfKey,
  scopeNames,
  type SyncLabelLookup,
  type SyncLabelText,
} from "../../src/lines/timetableSyncLabel.ts";
import { describeMerge } from "../../src/domain/syncMerge.ts";
import type { TimeBlockRow, TimeCategoryRow, TimeGoalRow } from "../../src/domain/timetable.ts";
import type { MergeNotice } from "../../src/data/syncRepository.ts";

const T = (mo: number, d: number, h: number, mi = 0): number => new Date(2026, mo - 1, d, h, mi).getTime();
const iso = (ms: number): string => new Date(ms).toISOString();

const TEXT: SyncLabelText = {
  syncBlockGone: "後來又被整理掉，現在不在軸上了",
  syncRunningFrom: "起",
  syncCatLabel: (n) => `分類『${n}』`,
  syncGoalLabel: (n) => `目標『${n}』`,
  syncCatGone: "已刪除的分類",
  syncNodeGone: "一張車票",
  syncRouteGone: "一條路線",
  syncTopLevel: "（頂層）",
  syncNoEstimate: "沒預估",
  syncNoDefault: "沒預設",
  syncNoScope: "（沒有分類）",
  syncRunning: "運行中",
  syncAck: "已確認",
  syncPending: "待確認",
  syncArchived: "已封存",
  syncNotArchived: "沒封存",
  syncCols: {
    time_blocks: { started_at: "開始時刻", ended_at: "結束時刻", category_id: "分類" },
    time_categories: { parent_id: "分組" },
    time_goals: { target_min: "目標時數" },
  },
  goalPeriodWord: { day: "每日", week: "每週", month: "每月", since: "從某天起", until: "到某天為止", range: "單一區間" },
  goalDirectionWord: { atLeast: "至少", atMost: "至多" },
};

const CATS: Record<string, string> = { "c-class": "上課", "c-create": "創作", "c-study": "學習", "g-duty": "主線" };
const NODES: Record<string, string> = { "n-1": "期中報告" };
const ROUTES: Record<string, string> = { "r-1": "資工課業" };

function look(now: number, h = 6): SyncLabelLookup {
  return {
    now,
    dayStartHour: h,
    categoryName: (id) => CATS[id] ?? null,
    nodeName: (id) => NODES[id] ?? null,
    routeName: (id) => ROUTES[id] ?? null,
  };
}

function block(over: Partial<TimeBlockRow>): TimeBlockRow {
  return {
    id: "b-1",
    category_id: "c-class",
    started_at: iso(T(10, 17, 10, 50)),
    ended_at: iso(T(10, 17, 13, 0)),
    estimate_min: null,
    node_id: null,
    route_id: null,
    long_run_ack: 0,
    account_id: null,
    device_id: null,
    created_at: iso(T(10, 17, 10, 50)),
    updated_at: iso(T(10, 17, 13, 0)),
    synced_at: null,
    deleted_at: null,
    ...over,
  };
}

function notice(col: string, mine: unknown, theirs: unknown): MergeNotice {
  return {
    kind: "overwritten",
    tbl: "time_blocks",
    row_id: "b-1",
    col,
    mine,
    theirs,
    winner: "theirs",
    by_me: true,
    their_device: "d",
    hlc: "1",
    at: iso(T(10, 19, 14, 40)),
  } as MergeNotice;
}

describe("time_blocks 的 label", () => {
  test("別天：「10/17 上課 10:50–13:00」", () => {
    assert.equal(blockLabel(block({}), look(T(10, 19, 15)), TEXT), "10/17 上課 10:50–13:00");
  });
  test("今天省日期", () => {
    const b = block({ started_at: iso(T(10, 19, 10, 50)), ended_at: iso(T(10, 19, 13, 0)) });
    assert.equal(blockLabel(b, look(T(10, 19, 15)), TEXT), "上課 10:50–13:00");
  });
  test("運行中：「HH:MM 起」", () => {
    const b = block({ started_at: iso(T(10, 19, 14, 5)), ended_at: null });
    assert.equal(blockLabel(b, look(T(10, 19, 15)), TEXT), "上課 14:05 起");
  });
  test("日期跟日界線日：凌晨 02:00 的塊在 06:00 日界線下算前一天，03:00 日界線下也算前一天，01:00 日界線下算當天", () => {
    const b = block({ started_at: iso(T(10, 18, 2, 0)), ended_at: iso(T(10, 18, 2, 30)) });
    const now = T(10, 19, 15);
    assert.equal(blockLabel(b, look(now, 6), TEXT), "10/17 上課 02:00–02:30");
    assert.equal(blockLabel(b, look(now, 3), TEXT), "10/17 上課 02:00–02:30");
    assert.equal(blockLabel(b, look(now, 1), TEXT), "10/18 上課 02:00–02:30");
  });
  test("分類找不到：「已刪除的分類」", () => {
    assert.equal(blockLabel(block({ category_id: "zzz" }), look(T(10, 19, 15)), TEXT), "10/17 已刪除的分類 10:50–13:00");
  });
});

describe("time_blocks 的 note（D-時-58、0-3 R1）", () => {
  test("活著的塊：沒有 note", () => {
    assert.equal(blockSyncLabel(block({}), look(T(10, 19, 15)), TEXT).note, undefined);
  });
  test("已刪除（被整理掉）：補一句，label 照常", () => {
    const r = blockSyncLabel(block({ deleted_at: iso(T(10, 19, 14)) }), look(T(10, 19, 15)), TEXT);
    assert.equal(r.note, "後來又被整理掉，現在不在軸上了");
    assert.equal(r.label, "10/17 上課 10:50–13:00");
    assert.equal(r.cols, TEXT.syncCols.time_blocks);
  });
});

describe("time_blocks 的 fmt（R5）", () => {
  const fmt = blockSyncLabel(block({}), look(T(10, 19, 15)), TEXT).fmt!;
  test("時刻欄＝本地 M/D HH:MM", () => {
    assert.equal(fmt("ended_at", iso(T(10, 19, 14, 35))), "10/19 14:35");
    assert.equal(fmt("started_at", iso(T(10, 3, 9, 5))), "10/3 09:05");
    assert.equal(fmt("ended_at", null), "運行中");
    assert.equal(fmt("started_at", "不是時間"), null);
  });
  test("外鍵欄＝名字；找不到有退路", () => {
    assert.equal(fmt("category_id", "c-create"), "創作");
    assert.equal(fmt("category_id", "gone"), "已刪除的分類");
    assert.equal(fmt("node_id", "n-1"), "期中報告");
    assert.equal(fmt("node_id", "gone"), "一張車票");
    assert.equal(fmt("node_id", null), null);
    assert.equal(fmt("route_id", "r-1"), "資工課業");
    assert.equal(fmt("route_id", "gone"), "一條路線");
  });
  test("預估、確認", () => {
    assert.equal(fmt("estimate_min", 90), "1h30m");
    assert.equal(fmt("estimate_min", null), "沒預估");
    assert.equal(fmt("long_run_ack", 1), "已確認");
    assert.equal(fmt("long_run_ack", 0), "待確認");
    assert.equal(fmt("long_run_ack", 7), null);
  });
  test("不認得的欄 ⇒ null（退回核心 fmtMergeValue）", () => {
    assert.equal(fmt("updated_at", iso(T(10, 19, 1))), null);
  });
  test("接上核心 describeMerge：值印成本地時刻、分類名", () => {
    assert.equal(
      describeMerge(notice("ended_at", iso(T(10, 19, 14, 35)), iso(T(10, 19, 14, 50))), fmt),
      "這台改成「10/19 14:35」、另一台改成「10/19 14:50」——留下另一台後改的",
    );
    assert.equal(describeMerge(notice("category_id", "c-class", "c-create"), fmt), "這台改成「上課」、另一台改成「創作」——留下另一台後改的");
    // 不給 fmt：原樣（UUID／ISO 照印）
    assert.equal(describeMerge(notice("category_id", "c-class", "c-create")), "這台改成「c-class」、另一台改成「c-create」——留下另一台後改的");
  });
});

describe("time_categories", () => {
  const row: TimeCategoryRow = {
    id: "c-create",
    parent_id: "g-duty",
    name: "創作",
    glyph: "創",
    color_idx: 5,
    position: 0,
    default_min: 180,
    archived_at: null,
    account_id: null,
    device_id: null,
    created_at: "",
    updated_at: "",
    synced_at: null,
    deleted_at: null,
  };
  const r = categorySyncLabel(row, look(T(10, 19, 15)), TEXT);
  test("label＝分類『名字』", () => assert.equal(r.label, "分類『創作』"));
  test("fmt：分組名、預設長度、封存", () => {
    assert.equal(r.fmt!("parent_id", "g-duty"), "主線");
    assert.equal(r.fmt!("parent_id", null), "（頂層）");
    assert.equal(r.fmt!("default_min", 120), "2h");
    assert.equal(r.fmt!("default_min", null), "沒預設");
    assert.equal(r.fmt!("archived_at", iso(T(10, 1, 1))), "已封存");
    assert.equal(r.fmt!("archived_at", null), "沒封存");
    assert.equal(r.fmt!("name", "創作"), null);
  });
});

describe("time_goals", () => {
  const row: TimeGoalRow = {
    id: "g-1",
    name: "夜行列車",
    scope: JSON.stringify({ categories: ["c-create", "c-study"] }),
    period: "since",
    target_min: 10800,
    direction: "atLeast",
    start_on: "2026-09-07",
    end_on: null,
    position: 0,
    archived_at: null,
    account_id: null,
    device_id: null,
    created_at: "",
    updated_at: "",
    synced_at: null,
    deleted_at: null,
  };
  const r = goalSyncLabel(row, look(T(10, 19, 15)), TEXT);
  test("label＝目標『名字』", () => assert.equal(r.label, "目標『夜行列車』"));
  test("S3：目標時數印「180h」不是「10800」", () => assert.equal(r.fmt!("target_min", 10800), "180h"));
  test("fmt：分類名「・」串、期間字、方向字、M/D", () => {
    assert.equal(r.fmt!("scope", row.scope), "創作・學習");
    assert.equal(r.fmt!("period", "until"), "到某天為止");
    assert.equal(r.fmt!("period", "fortnight"), null);
    assert.equal(r.fmt!("direction", "atMost"), "至多");
    assert.equal(r.fmt!("start_on", "2026-10-01"), "10/1");
    assert.equal(r.fmt!("end_on", null), null);
    assert.equal(r.fmt!("archived_at", null), "沒封存");
  });
  test("scope：已刪的分類略過；全刪光＝（沒有分類）；解不開＝null", () => {
    assert.equal(scopeNames(JSON.stringify({ categories: ["c-create", "gone"] }), look(0), TEXT), "創作");
    assert.equal(scopeNames(JSON.stringify({ categories: ["gone"] }), look(0), TEXT), "（沒有分類）");
    assert.equal(scopeNames("{oops", look(0), TEXT), null);
    assert.equal(scopeNames(JSON.stringify({ tags: [] }), look(0), TEXT), null);
  });
  test("⑥ scope v2（D-時-113、§5.7）：{v:2,cats} 印分類名；cats 空＝（沒有分類）；v≠2、只有 cats、v:2 配 categories、非物件＝null", () => {
    assert.equal(scopeNames(JSON.stringify({ v: 2, cats: ["c-create", "gone"] }), look(0), TEXT), "創作");
    assert.equal(scopeNames(JSON.stringify({ v: 2, cats: [] }), look(0), TEXT), "（沒有分類）");
    assert.equal(scopeNames(JSON.stringify({ v: 3, cats: ["c-create"] }), look(0), TEXT), null);
    assert.equal(scopeNames(JSON.stringify({ cats: ["c-create"] }), look(0), TEXT), null);
    assert.equal(scopeNames(JSON.stringify({ v: 2, categories: ["c-create"] }), look(0), TEXT), null);
    assert.equal(scopeNames("[1]", look(0), TEXT), null);
    assert.equal(scopeNames("null", look(0), TEXT), null);
  });
});

describe("小工具", () => {
  test("mdOfKey／localStamp", () => {
    assert.equal(mdOfKey("2026-01-05"), "1/5");
    assert.equal(localStamp(T(12, 31, 23, 59)), "12/31 23:59");
  });
  test("純度：只 import domain/timetable.ts、lib/date.ts 與型別", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../src/lines/timetableSyncLabel.ts", import.meta.url), "utf8");
    const froms = Array.from(src.matchAll(/^import\s+(type\s+)?[^;]*?from\s+"([^"]+)"/gm)).map((m) => (m[1] ? "type:" : "") + m[2]);
    assert.deepEqual(froms.sort(), ["../domain/timetable.ts", "../lib/date.ts", "type:./types.ts"].sort());
  });
});

/* ───────── ④ 契約 §4 第 10 項（#73 R5） ───────── */

describe("#73 R5：TT_TEXT.syncCols 的 glyph／position 欄名是中文", () => {
  // TT_TEXT 在 store（node 載不起來）⇒ 讀原始碼裡 syncCols 那一段的字面值
  const syncColsOf = async (): Promise<Record<string, Record<string, string>>> => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../src/store/timetableStore.ts", import.meta.url), "utf8");
    const start = src.indexOf("syncCols: {");
    assert.ok(start >= 0, "找不到 syncCols");
    const body = src.slice(start, src.indexOf("} as {", start));
    const out: Record<string, Record<string, string>> = {};
    for (const t of ["time_blocks", "time_categories", "time_goals"]) {
      const m = new RegExp(`${t}: \{([^}]*)\}`).exec(body);
      assert.ok(m, `找不到 ${t}`);
      out[t] = Object.fromEntries(Array.from(m[1].matchAll(/(\w+): "([^"]*)"/g)).map((x) => [x[1], x[2]]));
    }
    return out;
  };
  const CJK = /^[㐀-鿿　-〿]+$/;
  test("time_categories.glyph＝圓牌字、time_categories.position＝排序、time_goals.position＝排序", async () => {
    const cols = await syncColsOf();
    assert.equal(cols.time_categories.glyph, "圓牌字");
    assert.equal(cols.time_categories.position, "排序");
    assert.equal(cols.time_goals.position, "排序");
  });
  test("三張表每個欄名都是中文（沒有漏網的英文欄名）", async () => {
    const cols = await syncColsOf();
    for (const [t, m] of Object.entries(cols)) for (const [k, v] of Object.entries(m)) assert.match(v, CJK, `${t}.${k}`);
  });
  test("接上 categorySyncLabel／goalSyncLabel：cols 帶得出這兩欄，fmt 退回核心（null）", async () => {
    const cols = await syncColsOf();
    const text: SyncLabelText = { ...TEXT, syncCols: { time_blocks: cols.time_blocks, time_categories: cols.time_categories, time_goals: cols.time_goals } };
    const cat = categorySyncLabel({ name: "創作" } as TimeCategoryRow, look(T(10, 19, 15)), text);
    assert.equal(cat.cols?.glyph, "圓牌字");
    assert.equal(cat.cols?.position, "排序");
    assert.equal(cat.fmt!("glyph", "創"), null);
    const goal = goalSyncLabel({ name: "夜行列車" } as TimeGoalRow, look(T(10, 19, 15)), text);
    assert.equal(goal.cols?.position, "排序");
  });
});
