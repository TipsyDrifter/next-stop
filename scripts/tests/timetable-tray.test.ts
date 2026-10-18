/**
 * 時刻表 ①c・系統匣選單純函式單元測試 E 區（①b①c 契約 §4.9；丁席）。
 * 跑法：`node --test scripts/tests/timetable-tray.test.ts`（node 24，型別剝除預設開；零依賴）。
 *
 * 時區：測資一律用 `new Date(y, m-1, d, h, mi).getTime()` 造本地時刻（同 timetable-logic.test.ts）。
 *
 * 車次②（② 契約 §4.5；丙）：E-②1–E-②3（tooltip／header 帶任務名、16 字截字、與 timetableLink 的 runLabel／clipLabel 對帳）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { MIN, isoOf, type TimeBlockRow, type TimeCategoryRow } from "../../src/domain/timetable.ts";
import { noticeTiles } from "../../src/domain/timetableNotice.ts";
import {
  TRAY_MENU_OFF,
  TT_TRAY_TEXT,
  buildTrayMenu,
  trayElapsedMs,
  trayRunName,
  trayTooltipOf,
  type TrayMenuInput,
} from "../../src/domain/timetableTray.ts";
import { clipLabel, runLabel } from "../../src/domain/timetableLink.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** 本地時刻（2026-10-13） */
const T = (h: number, mi: number, s = 0): number => new Date(2026, 9, 13, h, mi, s).getTime();
const STAMP = "2026-10-01T00:00:00.000Z";

function cat(id: string, name: string, parent: string | null, position: number, extra: Partial<TimeCategoryRow> = {}): TimeCategoryRow {
  return {
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
    created_at: STAMP,
    updated_at: STAMP,
    deleted_at: null,
    ...extra,
  } as TimeCategoryRow;
}

function block(id: string, categoryId: string, start: number, end: number | null): TimeBlockRow {
  return {
    id,
    category_id: categoryId,
    started_at: isoOf(start),
    ended_at: end === null ? null : isoOf(end),
    estimate_min: null,
    node_id: null,
    route_id: null,
    long_run_ack: 0,
    account_id: null,
    device_id: null,
    created_at: STAMP,
    updated_at: STAMP,
    deleted_at: null,
  } as TimeBlockRow;
}

/** 兩組＋一個空組：本務（上課、創作、學習）、生活（睡覺、吃飯）、休閒（沒有子分類） */
const CATS: TimeCategoryRow[] = [
  cat("g1", "本務", null, 1),
  cat("g2", "生活", null, 2),
  cat("g3", "休閒", null, 3),
  cat("c1", "上課", "g1", 1),
  cat("c2", "創作", "g1", 2),
  cat("c3", "學習", "g1", 3),
  cat("c4", "睡覺", "g2", 1),
  cat("c5", "吃飯", "g2", 2),
];
const byId = (cs: readonly TimeCategoryRow[]): Record<string, TimeCategoryRow> => {
  const o: Record<string, TimeCategoryRow> = {};
  for (const c of cs) o[c.id] = c;
  return o;
};

function input(over: Partial<TrayMenuInput> = {}): TrayMenuInput {
  const categories = over.categories ?? CATS;
  return {
    enabled: true,
    tilesEnabled: true,
    running: null,
    catById: byId(categories),
    categories,
    tiles: noticeTiles(categories, ["c2", "c5"], [], over.running ? over.running.category_id : null),
    now: T(15, 55),
    ...over,
  };
}

describe("E 區・載入", () => {
  test("timetableTray.ts 能被 node 直接載入（只 import ./timetable.ts）", () => {
    assert.equal(typeof buildTrayMenu, "function");
    assert.equal(TT_TRAY_TEXT.tooltipIdle, "Next Stop・目前沒有列車在跑");
    assert.equal(TT_TRAY_TEXT.tooltipOff, "Next Stop");
  });
});

describe("E 區（①b①c 契約 §4.9）", () => {
  test("E1 停車中／運行中兩種 spec", () => {
    const idle = buildTrayMenu(input());
    assert.ok(idle);
    assert.equal(idle.header, "目前沒有列車在跑");
    assert.equal(idle.running, false);
    assert.equal(idle.runningCategoryId, null);
    // 常用＝noticeTiles（最近用過 創作、吃飯，不足補 leaf；照 leaf 順序排）
    assert.deepEqual(
      idle.quick.map((c) => c.label),
      ["上課", "創作", "學習", "睡覺", "吃飯"],
    );
    // 沒有子分類的組（休閒）不列
    assert.deepEqual(
      idle.groups.map((g) => [g.label, g.items.map((c) => c.id)]),
      [
        ["本務", ["c1", "c2", "c3"]],
        ["生活", ["c4", "c5"]],
      ],
    );

    const run = block("b1", "c2", T(14, 35), null);
    const spec = buildTrayMenu(input({ running: run, now: T(15, 55, 30) }));
    assert.ok(spec);
    assert.equal(spec.header, "創作・14:35 発（1h20m）");
    assert.equal(spec.running, true);
    assert.equal(spec.runningCategoryId, "c2");
    // 運行中的那個留在常用裡（D-時-32；Rust 畫成打勾、不能點）
    assert.ok(spec.quick.some((c) => c.id === "c2"));

    // 格子關掉 ⇒ quick 空、groups 照舊
    const noTiles = buildTrayMenu(input({ running: run, tilesEnabled: false }));
    assert.ok(noTiles);
    assert.deepEqual(noTiles.quick, []);
    assert.equal(noTiles.groups.length, 2);

    // 運行中那班的分類已經不在（同步途中）⇒「？」
    const ghost = buildTrayMenu(input({ running: block("b2", "gone", T(15, 0), null), now: T(15, 30) }));
    assert.ok(ghost);
    assert.equal(ghost.header, "？・15:00 発（30m）");
  });

  test("E2 封存的分類不出現在 groups（也不出現在常用）", () => {
    const cats = CATS.map((c) => (c.id === "c3" ? { ...c, archived_at: STAMP } : c));
    const spec = buildTrayMenu(input({ categories: cats }));
    assert.ok(spec);
    const all = spec.groups.flatMap((g) => g.items.map((c) => c.id));
    assert.ok(!all.includes("c3"));
    assert.deepEqual(all, ["c1", "c2", "c4", "c5"]);
    assert.ok(!spec.quick.some((c) => c.id === "c3"));
    // 已刪除的也一樣
    const del = CATS.map((c) => (c.id === "c4" ? { ...c, deleted_at: STAMP } : c));
    const s2 = buildTrayMenu(input({ categories: del }));
    assert.ok(s2);
    assert.ok(!s2.groups.flatMap((g) => g.items.map((c) => c.id)).includes("c4"));
  });

  test("E3 enabled=false ⇒ null（呼叫端改送 TRAY_MENU_OFF：空 header＝Rust 建回「開啟／結束」）", () => {
    assert.equal(buildTrayMenu(input({ enabled: false })), null);
    assert.equal(buildTrayMenu(input({ enabled: false, running: block("b1", "c2", T(14, 35), null) })), null);
    assert.equal(TRAY_MENU_OFF.header, "");
    assert.deepEqual(TRAY_MENU_OFF, { header: "", running: false, quick: [], groups: [], runningCategoryId: null });
  });

  test("E4 elapsed 59 秒內 spec 不變（去重）", () => {
    const run = block("b1", "c2", T(14, 35), null);
    const a = buildTrayMenu(input({ running: run, now: T(15, 55, 0) }));
    const b = buildTrayMenu(input({ running: run, now: T(15, 55, 59) }));
    const c = buildTrayMenu(input({ running: run, now: T(15, 56, 0) }));
    assert.deepEqual(a, b);
    assert.equal(JSON.stringify(a), JSON.stringify(b));
    assert.notDeepEqual(a, c);
    assert.equal(c?.header, "創作・14:35 発（1h21m）");
    // 取整是「往下」：1h20m59s 仍是 1h20m；時鐘倒退（now < start）＝0
    assert.equal(trayElapsedMs(T(14, 35), T(15, 55, 59)), 80 * MIN);
    assert.equal(trayElapsedMs(T(14, 35), T(14, 0)), 0);
    // tooltip 同理
    const tip = (now: number) => trayTooltipOf({ enabled: true, running: run, catById: byId(CATS), now });
    assert.equal(tip(T(15, 55, 0)), tip(T(15, 55, 59)));
  });

  test("E5 tooltip 全文「Next Stop・創作・14:35 発（1h20m）」", () => {
    const run = block("b1", "c2", T(14, 35), null);
    const catById = byId(CATS);
    assert.equal(trayTooltipOf({ enabled: true, running: run, catById, now: T(15, 55, 10) }), "Next Stop・創作・14:35 発（1h20m）");
    assert.equal(TT_TRAY_TEXT.tooltip("創作", T(14, 35), 80 * MIN), "Next Stop・創作・14:35 発（1h20m）");
    assert.equal(trayTooltipOf({ enabled: true, running: null, catById, now: T(15, 55) }), "Next Stop・目前沒有列車在跑");
    // 運行中顯示關掉 ⇒ 不透露運行狀態
    assert.equal(trayTooltipOf({ enabled: false, running: run, catById, now: T(15, 55) }), "Next Stop");
  });

  test("E6 tray.rs 含選單 id 前綴 \"tt:arrive\"、\"tt:depart:\" 與事件名 \"tt-tray\"", () => {
    const rs = readFileSync(resolve(ROOT, "src-tauri/src/tray.rs"), "utf8");
    assert.ok(rs.includes('"tt:arrive"'), "tray.rs 要有 \"tt:arrive\"");
    assert.ok(rs.includes('"tt:depart:"'), "tray.rs 要有 \"tt:depart:\"");
    assert.ok(rs.includes('"tt-tray"'), "tray.rs 要有 \"tt-tray\"");
    // Rust 的 spec 欄位與 JS 同名（serde camelCase）：runningCategoryId ⇔ running_category_id
    assert.ok(/rename_all\s*=\s*"camelCase"/.test(rs));
    assert.ok(rs.includes("running_category_id"));
    // TrayAction 的 JSON 形狀：tag = "kind"、depart 帶 categoryId（＝JS TrayAction）
    assert.ok(rs.includes('tag = "kind"'));
    assert.ok(rs.includes('rename = "categoryId"'));
    // tray_set_status 多了選填的 menu（①a 呼叫照舊成立）
    assert.ok(/menu:\s*Option<TrayMenuSpec>/.test(rs));
    // JS 端（Agent）聽的事件名、mock 解析的 id 前綴是同一套字
    const agent = readFileSync(resolve(ROOT, "src/ui/timetable/TimetableDesktopAgent.tsx"), "utf8");
    assert.ok(agent.includes('"tt-tray"'));
    assert.ok(agent.includes('"tt:arrive"'));
    assert.ok(agent.includes('"tt:depart:"'));
  });
});

describe("E 區・②（② 契約 §4.5）", () => {
  const run = block("b1", "c2", T(14, 35), null);
  const catById = byId(CATS);

  test("E-②1 tooltip「Next Stop・創作・寫契約・14:35 発（1h20m）」；linkLabel null／不給＝跟 ①c 一樣", () => {
    assert.equal(
      trayTooltipOf({ enabled: true, running: run, catById, now: T(15, 55, 10), linkLabel: "寫契約" }),
      "Next Stop・創作・寫契約・14:35 発（1h20m）",
    );
    assert.equal(trayTooltipOf({ enabled: true, running: run, catById, now: T(15, 55, 10), linkLabel: null }), "Next Stop・創作・14:35 発（1h20m）");
    // 停車中、關掉照舊（任務名不透露）
    assert.equal(trayTooltipOf({ enabled: true, running: null, catById, now: T(15, 55), linkLabel: "寫契約" }), "Next Stop・目前沒有列車在跑");
    assert.equal(trayTooltipOf({ enabled: false, running: run, catById, now: T(15, 55), linkLabel: "寫契約" }), "Next Stop");
  });

  test("E-②2 header「創作・寫契約・14:35 発（1h20m）」；分類不在 ⇒「？・寫契約」；超過 16 字截字", () => {
    const spec = buildTrayMenu(input({ running: run, now: T(15, 55, 30), linkLabel: "寫契約" }));
    assert.ok(spec);
    assert.equal(spec.header, "創作・寫契約・14:35 発（1h20m）");
    assert.equal(spec.runningCategoryId, "c2"); // 其餘欄位不受任務名影響
    const plain = buildTrayMenu(input({ running: run, now: T(15, 55, 30) }));
    assert.deepEqual({ ...spec, header: "" }, { ...plain, header: "" });
    const ghost = buildTrayMenu(input({ running: block("b2", "gone", T(15, 0), null), now: T(15, 30), linkLabel: "寫契約" }));
    assert.equal(ghost?.header, "？・寫契約・15:00 発（30m）");
    const long = "一二三四五六七八九十一二三四五六七八九十"; // 20 字
    const cut = buildTrayMenu(input({ running: run, now: T(15, 55, 30), linkLabel: long }));
    assert.equal(cut?.header, "創作・一二三四五六七八九十一二三四五…・14:35 発（1h20m）");
    // 停車中不帶任務名
    assert.equal(buildTrayMenu(input({ linkLabel: "寫契約" }))?.header, "目前沒有列車在跑");
  });

  test("E-②3 trayRunName ＝ timetableLink 的 runLabel(cat, clipLabel(label))（本檔不能 import timetableLink，副本對帳）", () => {
    const cases: (string | null)[] = [null, "", "寫契約", "一二三四五六七八九十一二三四五六", "一二三四五六七八九十一二三四五六七", "😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀"];
    for (const l of cases) {
      assert.equal(trayRunName("創作", l), runLabel("創作", l === null ? null : clipLabel(l)), `label=${String(l)}`);
    }
    assert.equal(trayRunName("創作", undefined), "創作");
  });
});
