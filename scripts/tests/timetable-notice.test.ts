/**
 * 時刻表 ①c・通知純函式單元測試 D 區（①b①c 契約 §4.8；丙席）。
 * 跑法：`node --test scripts/tests/timetable-notice.test.ts`（node 24，型別剝除預設開；零依賴）。
 * 時區：測資一律用 `new Date(y, m-1, d, h, mi).getTime()` 造本地時刻（同 timetable-logic.test.ts）。
 *
 * D1–D9 全是真斷言（丙 Stage 1）。D7 的「冪等推演」照 noticePending.ts 的套用規則在記憶體裡重演（那支模組 import store，node 載不進來）。
 *
 * 車次②（② 契約 §4.5；丙）：D-②1–D-②5（運行中那班「分類・任務名」、16 字截字、任務的預計時間當門檻、不給新欄＝①c 原樣、
 * 與 timetableLink 的 runLabel／clipLabel 對帳＋三支純函式檔只 import ./timetable.ts）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MIN,
  TIMETABLE_ID_NAMESPACE,
  fmtClock,
  fmtDur,
  planArriveBefore,
  planDepartPending,
  thresholdOf,
  type Span,
  type TimeBlockRow,
  type TimeCategoryRow,
  type WritePlan,
} from "../../src/domain/timetable.ts";
import {
  CAT_PALETTE,
  NOTICE_TILES_MAX,
  PENDING_DEPART_UNTIL_NEXT,
  TT_NOTICE_TEXT,
  buildNoticeState,
  noticeDepartCategoryOk,
  noticeRunName,
  noticeTiles,
  pendingIsValid,
  reminderOf,
  reminderSig,
  reminderToKeep,
  sortPending,
  tileOf,
  type PendingAction,
  type PendingOutcome,
} from "../../src/domain/timetableNotice.ts";
import { clipLabel, runLabel } from "../../src/domain/timetableLink.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");

/* ───────── 測試用小工具 ───────── */

/** 今天本地 (h, mi) */
const T = (h: number, mi: number, d = 0): number => new Date(2026, 9, 13 + d, h, mi).getTime();
const ISO = (ms: number): string => new Date(ms).toISOString();
const STAMP = ISO(T(3, 0));

function cat(id: string, parent: string | null, position: number, extra: Partial<TimeCategoryRow> = {}): TimeCategoryRow {
  return {
    id,
    parent_id: parent,
    name: extra.name ?? id,
    glyph: null,
    color_idx: 1,
    position,
    default_min: null,
    archived_at: null,
    account_id: null,
    device_id: null,
    created_at: STAMP,
    updated_at: STAMP,
    synced_at: null,
    deleted_at: null,
    ...extra,
  };
}

function block(id: string, categoryId: string, start: number, end: number | null, extra: Partial<TimeBlockRow> = {}): TimeBlockRow {
  return {
    id,
    category_id: categoryId,
    started_at: ISO(start),
    ended_at: end === null ? null : ISO(end),
    estimate_min: null,
    node_id: null,
    route_id: null,
    long_run_ack: 0,
    account_id: null,
    device_id: null,
    created_at: STAMP,
    updated_at: STAMP,
    synced_at: null,
    deleted_at: null,
    ...extra,
  };
}

const mk = (id: string, categoryId: string, start: number, end: number | null, ack = false): Span => ({ id, categoryId, start, end, ack });

/** 把 WritePlan 套到 spans（＝timetable-logic.test.ts 的 apply；insert 有 fixedId 就用它） */
function apply(spans: readonly Span[], plan: WritePlan): Span[] {
  const map = new Map<string, Span>();
  for (const s of spans) map.set(s.id, { ...s });
  for (const p of plan.patches) {
    const s = map.get(p.id);
    if (!s) continue;
    if (p.start !== undefined) s.start = p.start;
    if (p.end !== undefined) s.end = p.end;
    if (p.categoryId !== undefined) s.categoryId = p.categoryId;
    if (p.ack !== undefined) s.ack = p.ack;
  }
  plan.inserts.forEach((i, n) => {
    const id = i.fixedId ?? i.key ?? `ins-${n}`;
    map.set(id, { id, categoryId: i.categoryId, start: i.start, end: i.end, ack: i.ack });
  });
  for (const d of plan.deletes) map.delete(d);
  return Array.from(map.values()).sort((a, b) => a.start - b.start);
}

/** 非零長度（零長度＝被收掉、畫面上不存在） */
const alive = (spans: readonly Span[]): Span[] => spans.filter((s) => !(s.end !== null && s.end <= s.start));

/** uuid v5（＝ttNoticeBridge.noticeBlockId 的算法，獨立用 node crypto 算） */
function uuidV5(ns: string, name: string): string {
  const nsBytes = Buffer.from(ns.replace(/-/g, ""), "hex");
  const h = createHash("sha1").update(Buffer.concat([nsBytes, Buffer.from(name, "utf8")])).digest();
  const b = Buffer.from(h.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;
  const x = b.toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/** 分類表：兩組六個子分類＋一個封存、一個已刪除（leaf 順序＝a b c d e f） */
function cats(): TimeCategoryRow[] {
  return [
    cat("G1", null, 0, { name: "本務" }),
    cat("G2", null, 1, { name: "生活" }),
    cat("a", "G1", 0, { name: "上課" }),
    cat("b", "G1", 1, { name: "學習" }),
    cat("c", "G1", 2, { name: "創作", glyph: "創", color_idx: 6, default_min: 120 }),
    cat("x", "G1", 3, { name: "封存的", archived_at: STAMP }),
    cat("d", "G2", 0, { name: "吃飯" }),
    cat("e", "G2", 1, { name: "休息" }),
    cat("f", "G2", 2, { name: "洗漱", default_min: 60 }),
    cat("y", "G2", 3, { name: "刪掉的", deleted_at: STAMP }),
  ];
}
const ids = (rows: readonly TimeCategoryRow[]): string[] => rows.map((c) => c.id);

describe("D 區・載入", () => {
  test("timetableNotice.ts 能被 node 直接載入（只 import ./timetable.ts）", () => {
    assert.equal(typeof noticeTiles, "function");
    assert.equal(typeof tileOf, "function");
    assert.equal(typeof buildNoticeState, "function");
    assert.equal(typeof sortPending, "function");
    assert.equal(typeof reminderOf, "function");
    assert.equal(PENDING_DEPART_UNTIL_NEXT, true); // 0-5：主對話裁乙
    assert.equal(CAT_PALETTE.light.length, 8);
    assert.equal(CAT_PALETTE.dark.length, 8);
    assert.equal(TT_NOTICE_TEXT.startedSuffix, " 発");
  });
});

describe("D 區（①b①c 契約 §4.8）", () => {
  test("D1 noticeTiles：釘選優先且照順序；封存／已刪除／頂層組略過；運行中不排除；補進來的照 leaf 順序；換車前後順序不變；不足補 leaf；n=5", () => {
    const cs = cats();
    // 釘選優先、照主人排的順序；封存 x、已刪 y、頂層組 G1、不存在的 zz 都略過
    assert.deepEqual(ids(noticeTiles(cs, ["f", "a", "c"], ["e", "x", "y", "G1", "zz", "b"], null)), ["e", "b", "a", "c", "f"]);
    // 補進來的照 leaf 順序排（不照最近排）：最近 f > d > a ⇒ 顯示 a d f
    assert.deepEqual(ids(noticeTiles(cs, ["f", "d", "a"], ["e"], null, 4)), ["e", "a", "d", "f"]);
    // 運行中那個不排除（D-時-32）：最近用過只有 a、正在跑 d ⇒ d 照放（而且當最近的第一名）
    const run = noticeTiles(cs, ["a"], [], "d");
    assert.equal(run.length, NOTICE_TILES_MAX);
    assert.ok(ids(run).includes("d"));
    assert.deepEqual(ids(run), ["a", "b", "c", "d", "e"]);
    // 運行中的分類開始超過 30 天（不在 recentIds）也排得進來
    assert.ok(ids(noticeTiles(cs, ["a", "b", "c", "e", "d"], [], "f")).includes("f"));
    // 換車：在格子裡換到另一格（d → b），格子順序不跳
    const before = noticeTiles(cs, ["d", "b", "a"], [], "d");
    const after = noticeTiles(cs, ["b", "d", "a"], [], "b");
    assert.deepEqual(ids(after), ids(before));
    // 新裝置：沒有最近、沒有釘選 ⇒ leaf 順序前 5 個
    assert.deepEqual(ids(noticeTiles(cs, [], [], null)), ["a", "b", "c", "d", "e"]);
    // n：預設 5；釘滿 5 個、運行中那個沒被釘 ⇒ 沒有亮的那格（主人接受）
    const full = noticeTiles(cs, ["d"], ["a", "b", "c", "e", "f"], "d");
    assert.deepEqual(ids(full), ["a", "b", "c", "e", "f"]);
    assert.equal(noticeTiles(cs, [], [], null, 3).length, 3);
    // tileOf：圓牌字 glyph ?? 名稱第一字、顏色＝CAT_PALETTE、門檻＝分類預設→全域
    const t = tileOf(cs.find((c) => c.id === "c")!, 840);
    assert.equal(t.glyph, "創");
    assert.equal(t.colorLight, CAT_PALETTE.light[5]);
    assert.equal(t.colorDark, CAT_PALETTE.dark[5]);
    assert.equal(t.thresholdMin, 120);
    assert.equal(t.reminderTitle, "創作已經跑了 2h，還在進行嗎？");
    const ta = tileOf(cs.find((c) => c.id === "a")!, 0);
    assert.equal(ta.glyph, "上");
    assert.equal(ta.thresholdMin, null); // 分類沒預設、全域 0 ⇒ 不排提醒
    assert.equal(ta.reminderTitle, null);
  });

  test("D2 buildNoticeState：停車中 running:null；subText 與 runningNoticeText 相同；預估 30 ⇒ running.thresholdMin=30、estimateText「預估 30m」", () => {
    const cs = cats();
    const catById: Record<string, TimeCategoryRow> = {};
    for (const c of cs) catById[c.id] = c;
    const base = { enabled: true, tilesEnabled: true, longRunEnabled: true, catById, categories: cs, recentIds: [] as string[], pins: [] as string[], globalMaxMin: 840 };

    const idle = buildNoticeState({ ...base, running: null });
    assert.equal(idle.v, 1);
    assert.equal(idle.running, null);
    assert.equal(idle.tiles.length, 5);
    assert.equal(idle.text.idleTitle, TT_NOTICE_TEXT.idleTitle);
    assert.equal(idle.text.publicRunning, "時刻表・運行中");
    assert.equal(idle.text.publicIdle, "時刻表・停車中");

    const start = T(14, 35);
    const r = block("blk", "c", start, null, { estimate_min: 30 });
    const s = buildNoticeState({ ...base, running: r });
    assert.ok(s.running);
    assert.equal(s.running.id, "blk");
    assert.equal(s.running.categoryId, "c");
    assert.equal(s.running.startedAt, start);
    assert.equal(s.running.startedLabel, "14:35 発");
    // ＝notice.ts runningNoticeText(name, started_at).title（`${name}・${fmtClock(msOf(started_at))} 発`）
    assert.equal(s.running.subText, `創作・${fmtClock(start)} 発`);
    assert.equal(s.running.subText, "創作・14:35 発");
    assert.equal(s.running.thresholdMin, 30); // 這一班的預估優先於分類預設 120
    assert.equal(s.running.reminderTitle, "創作已經跑了 30m，還在進行嗎？");
    // 展開版運行列的「・預估 30m」（Kotlin 接在 startedLabel 後面）；沒預估 ⇒ null
    assert.equal(s.running.estimateText, "預估 30m");
    const s60 = buildNoticeState({ ...base, running: block("blk", "c", start, null, { estimate_min: 60 }) });
    assert.equal(s60.running?.estimateText, "預估 1h");
    const s90 = buildNoticeState({ ...base, running: block("blk", "c", start, null, { estimate_min: 90 }) });
    assert.equal(s90.running?.estimateText, "預估 1h30m");
    const noEst = buildNoticeState({ ...base, running: block("blk", "c", start, null) });
    assert.equal(noEst.running?.estimateText, null);
    assert.equal(noEst.running?.thresholdMin, 120); // 沒預估 ⇒ 門檻退回分類預設
    // 運行中那格留在格子裡（亮起來由 Kotlin 判 categoryId）
    assert.ok(s.tiles.some((t) => t.categoryId === "c"));
    // 開關原樣帶過去
    const off = buildNoticeState({ ...base, enabled: false, tilesEnabled: false, longRunEnabled: false, running: r });
    assert.equal(off.enabled, false);
    assert.equal(off.tilesEnabled, false);
    assert.equal(off.longRunEnabled, false);
    // 分類已不在（同步途中）⇒「？」
    const ghost = buildNoticeState({ ...base, running: block("g", "gone", start, null) });
    assert.equal(ghost.running?.name, "？");
    assert.equal(ghost.running?.glyph, "？");
    assert.equal(ghost.running?.subText, "？・14:35 発");
  });

  /** 0-5 的反例：手機 10:00 在通知上點「工作」（離線）；桌機 10:05 換車「吃飯」；手機 11:00 回線才套 */
  function counterExample(): Span[] {
    return [mk("study", "study", T(9, 0), T(10, 5)), mk("meal", "meal", T(10, 5), null)];
  }
  const FIXED = "notice-fixed-id";

  test("D3 PENDING_DEPART_UNTIL_NEXT=false（甲）：0-5 反例下吃飯被收掉", () => {
    const spans = counterExample();
    const plan = planDepartPending(spans, { categoryId: "work", at: T(10, 0), now: T(11, 0), fixedId: FIXED, untilNext: false });
    assert.ok(plan);
    const out = alive(apply(spans, plan));
    assert.ok(!out.some((s) => s.categoryId === "meal"), "甲案：桌機較晚的吃飯被蓋掉");
    const work = out.find((s) => s.id === FIXED);
    assert.ok(work);
    assert.equal(work.start, T(10, 0));
    assert.equal(work.end, null); // 工作從 10:00 一路跑到現在
    assert.equal(out.find((s) => s.id === "study")?.end, T(10, 0));
  });

  test("D4 PENDING_DEPART_UNTIL_NEXT=true（乙）：0-5 反例下工作 10:00–10:05、吃飯 10:05–運行中", () => {
    assert.equal(PENDING_DEPART_UNTIL_NEXT, true); // 主對話 2026-10-13 裁乙：真機走的是這一條
    const spans = counterExample();
    const plan = planDepartPending(spans, { categoryId: "work", at: T(10, 0), now: T(11, 0), fixedId: FIXED, untilNext: PENDING_DEPART_UNTIL_NEXT });
    assert.ok(plan);
    const out = alive(apply(spans, plan));
    const work = out.find((s) => s.id === FIXED);
    assert.ok(work);
    assert.equal(work.start, T(10, 0));
    assert.equal(work.end, T(10, 5)); // 已結束、不運行
    const meal = out.find((s) => s.id === "meal");
    assert.ok(meal);
    assert.equal(meal.start, T(10, 5));
    assert.equal(meal.end, null); // 吃飯照樣運行中
    assert.equal(out.find((s) => s.id === "study")?.end, T(10, 0));
    assert.equal(out.filter((s) => s.end === null).length, 1);
    // 正常情況（沒有別台插隊）兩案結果相同
    const plain = [mk("study", "study", T(9, 0), null)];
    const pa = alive(apply(plain, planDepartPending(plain, { categoryId: "work", at: T(10, 0), now: T(11, 0), fixedId: FIXED, untilNext: false })!));
    const pb = alive(apply(plain, planDepartPending(plain, { categoryId: "work", at: T(10, 0), now: T(11, 0), fixedId: FIXED, untilNext: true })!));
    assert.deepEqual(pb, pa);
    // 下一班與 at 不足 1 分 ⇒ 整段被蓋住、不寫（noticePending 歸 dropped covered）
    const tight = [mk("meal", "meal", T(10, 0) + 30_000, null)];
    assert.equal(planDepartPending(tight, { categoryId: "work", at: T(10, 0), now: T(11, 0), fixedId: FIXED, untilNext: true }), null);
  });

  test("D5 sortPending：at 遞增、同 at 依 id；kind 不合法、at 非有限數 ⇒ invalid", () => {
    const A = (id: string, at: number, kind: string = "depart", categoryId: string | null = "c"): PendingAction =>
      ({ id, kind, categoryId, at, expectRunningId: null }) as PendingAction;
    const list: PendingAction[] = [
      A("b", 200),
      A("zz-bad-kind", 50, "teleport"),
      A("a", 200, "arrive", null),
      A("nan", Number.NaN),
      A("c", 100),
      A("inf", Number.POSITIVE_INFINITY, "arrive", null),
      A("no-cat", 10, "depart", null),
    ];
    const sorted = sortPending(list);
    assert.deepEqual(sorted.map((a) => a.id), ["c", "a", "b", "inf", "nan", "no-cat", "zz-bad-kind"]);
    assert.deepEqual(sorted.filter((a) => !pendingIsValid(a)).map((a) => a.id), ["inf", "nan", "no-cat", "zz-bad-kind"]);
    assert.equal(pendingIsValid(A("ok", 1, "arrive", null)), true);
    assert.equal(pendingIsValid(A("", 1, "arrive", null)), false);
    // 不改輸入
    assert.equal(list[0].id, "b");
    assert.deepEqual(sortPending([]), []);
  });

  test("D6 reminderOf：ack=1 ⇒ null；fireAt 在 60 秒內 ⇒ null；預估優先", () => {
    const c = cats().find((x) => x.id === "f")!; // 洗漱，分類預設 60 分
    const now = T(10, 0);
    const r = block("blk", "f", T(9, 30), null);
    const th = thresholdOf(r.estimate_min, c, 840);
    const rem = reminderOf(r, th, c.name, true, now);
    assert.deepEqual(rem, { blockId: "blk", fireAt: T(10, 30), title: "洗漱已經跑了 1h，還在進行嗎？" });
    // 未確認以外都不排
    assert.equal(reminderOf({ ...r, long_run_ack: 1 }, th, c.name, true, now), null);
    assert.equal(reminderOf(r, th, c.name, false, now), null); // 跑太久提醒關掉
    assert.equal(reminderOf(null, th, c.name, true, now), null);
    assert.equal(reminderOf(r, null, c.name, true, now), null); // 沒有門檻
    // fireAt 在 60 秒內（或已過）⇒ null
    assert.equal(reminderOf(r, th, c.name, true, T(10, 30) - 59_000), null);
    assert.equal(reminderOf(r, th, c.name, true, T(10, 31)), null);
    assert.ok(reminderOf(r, th, c.name, true, T(10, 30) - 61_000));
    // 預估優先：這一班預估 15 分 ⇒ 09:45
    const est = { ...r, estimate_min: 15 };
    const r2 = reminderOf(est, thresholdOf(est.estimate_min, c, 840), c.name, true, T(9, 31));
    assert.equal(r2?.fireAt, T(9, 45));
    assert.equal(r2?.title, `洗漱已經跑了 ${fmtDur(15 * MIN)}，還在進行嗎？`);
  });

  test("D6b reminderToKeep：已排好的同一個在提醒前 60 秒內不取消；到點、換班、新排才照 60 秒規則", () => {
    const c = cats().find((x) => x.id === "f")!; // 洗漱，分類預設 60 分 ⇒ 10:30 提醒
    const r = block("blk", "f", T(9, 30), null);
    const th = thresholdOf(r.estimate_min, c, 840);
    const far = reminderToKeep(r, th, c.name, true, T(10, 0), "");
    assert.ok(far);
    const sig = reminderSig(far);
    const inWindow = T(10, 30) - 30_000; // 59:30
    // 已排好的同一個 ⇒ 留著（不取消）
    assert.deepEqual(reminderToKeep(r, th, c.name, true, inWindow, sig), far);
    // 這個行程還沒排過（null）⇒ 也留著（Kotlin 手上可能有，重送保留 fired）
    assert.deepEqual(reminderToKeep(r, th, c.name, true, inWindow, null), far);
    // 剛取消過／排的是別的 ⇒ 60 秒內不新排
    assert.equal(reminderToKeep(r, th, c.name, true, inWindow, ""), null);
    assert.equal(reminderToKeep(r, th, c.name, true, inWindow, "other|1|x"), null);
    // 到點或過點 ⇒ 取消（人已經回到 App，收掉已響過的那則）
    assert.equal(reminderToKeep(r, th, c.name, true, T(10, 30), sig), null);
    assert.equal(reminderToKeep(r, th, c.name, true, T(10, 31), sig), null);
    // 確認過、關掉開關 ⇒ 取消
    assert.equal(reminderToKeep({ ...r, long_run_ack: 1 }, th, c.name, true, inWindow, sig), null);
    assert.equal(reminderToKeep(r, th, c.name, false, inWindow, sig), null);
    // 改了門檻（預估 45 ⇒ 10:15，簽章不同）⇒ 照新的算
    const est = { ...r, estimate_min: 45 };
    assert.equal(reminderToKeep(est, thresholdOf(45, c, 840), c.name, true, T(10, 15) - 30_000, sig), null);
  });

  test("D7 冪等推演：同一 depart 套兩次 ⇒ 第二次 duplicate；同一 arrive 套兩次 ⇒ 第二次空 plan", () => {
    // 照 noticePending.applyOne 的規則在記憶體重演（blockExists＝看這個 id 在不在，含已刪除）
    let spans: Span[] = [mk("study", "study", T(9, 0), null)];
    const existed = new Set<string>(spans.map((s) => s.id));
    const now = T(11, 0);
    const depart = (a: PendingAction): PendingOutcome => {
      const fixedId = uuidV5(TIMETABLE_ID_NAMESPACE, "notice:" + a.id);
      if (existed.has(fixedId)) return { kind: "duplicate" };
      const plan = planDepartPending(spans, { categoryId: a.categoryId!, at: a.at, now, fixedId, untilNext: PENDING_DEPART_UNTIL_NEXT });
      if (!plan) return { kind: "dropped", reason: "covered" };
      spans = apply(spans, plan);
      for (const s of spans) existed.add(s.id);
      return { kind: "departed", blockId: fixedId };
    };
    const act: PendingAction = { id: "8a6d0c34-1111-4222-8333-944455556666", kind: "depart", categoryId: "work", at: T(10, 0), expectRunningId: "study" };
    // 確定性 id：同一筆動作算幾次都一樣、不同動作不一樣
    assert.equal(uuidV5(TIMETABLE_ID_NAMESPACE, "notice:" + act.id), uuidV5(TIMETABLE_ID_NAMESPACE, "notice:" + act.id));
    assert.notEqual(uuidV5(TIMETABLE_ID_NAMESPACE, "notice:" + act.id), uuidV5(TIMETABLE_ID_NAMESPACE, "notice:other"));
    assert.match(uuidV5(TIMETABLE_ID_NAMESPACE, "notice:abc"), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // ＝瀏覽器裡 ttNoticeBridge.noticeBlockId("abc") 算出的值（Stage 0-C 實測、Web Crypto）
    assert.equal(uuidV5(TIMETABLE_ID_NAMESPACE, "notice:abc"), "144fd878-e4b7-5b61-a59f-32562ddf7b85");
    const first = depart(act);
    assert.equal(first.kind, "departed");
    const snapshot = JSON.stringify(spans);
    // JS 套到一半被殺、沒 ack ⇒ 下次又取到同一筆
    assert.deepEqual(depart(act), { kind: "duplicate" });
    assert.equal(JSON.stringify(spans), snapshot, "第二次不改任何東西");

    // 到着：規則本身冪等
    const at = T(10, 30);
    const p1 = planArriveBefore(spans, { at, now });
    assert.equal(p1.patches.length, 1);
    spans = apply(spans, p1);
    assert.equal(spans.filter((s) => s.end === null).length, 0);
    const p2 = planArriveBefore(spans, { at, now });
    assert.deepEqual(p2, { patches: [], inserts: [], deletes: [] });
    // 開始晚於 at 的運行中不動（noticePending 歸 dropped noRunning）
    const later = [mk("late", "meal", T(10, 40), null)];
    assert.equal(planArriveBefore(later, { at, now }).patches.length, 0);
  });

  test("D7b 通知／系統匣発車的分類判斷：封存的照樣套；已刪、頂層組、不在 ⇒ 不套；兩端共用同一支", () => {
    const cs = cats();
    const by = (id: string): TimeCategoryRow | undefined => cs.find((c) => c.id === id);
    assert.equal(noticeDepartCategoryOk(by("c")), true);
    assert.equal(noticeDepartCategoryOk(by("x")), true, "封存只是不出現在格子裡，分類還在 ⇒ 照樣発車");
    assert.equal(noticeDepartCategoryOk(by("y")), false, "已刪除");
    assert.equal(noticeDepartCategoryOk(by("G1")), false, "頂層組");
    assert.equal(noticeDepartCategoryOk(undefined), false);
    assert.equal(noticeDepartCategoryOk(null), false);
    // 兩端（Android 佇列、桌機系統匣）都走這一支、不再各自擋 archived_at
    for (const f of ["src/ui/timetable/noticePending.ts", "src/ui/timetable/noticeDesktop.ts"]) {
      const src = readFileSync(path.join(ROOT, f), "utf8");
      assert.ok(src.includes("noticeDepartCategoryOk("), `${f} 要用 noticeDepartCategoryOk`);
      assert.ok(!/archived_at\s*!==\s*null/.test(src), `${f} 不該再擋封存`);
    }
  });

  test("D8 CAT_PALETTE 與 theme.css 語意層 --cat-1..8（兩主題）逐值相同；timetable.css §A 只把 --ns-tt-cat-N 指回 var(--cat-N)", () => {
    // UI 丙-1：八色實值搬進 theme.css（:root, [data-theme]／[data-theme="dark"]），timetable.css §A 只留 var(--cat-N) 別名
    const theme = readFileSync(path.join(ROOT, "src/styles/theme.css"), "utf8");
    // 取該選擇器「第一個含 --cat-1: 的」區塊（theme.css 的 :root／[data-theme="dark"] 各有好幾塊）
    const grab = (selectorRe: RegExp): string[] => {
      const re = new RegExp(selectorRe.source, "gm");
      let m: RegExpExecArray | null;
      while ((m = re.exec(theme))) {
        const body = theme.slice(m.index + m[0].length, theme.indexOf("}", m.index));
        if (!/--cat-1:/.test(body)) continue;
        const out: string[] = [];
        const r = /--cat-(\d):\s*(#[0-9a-fA-F]{6})/g;
        let x: RegExpExecArray | null;
        while ((x = r.exec(body))) out[Number(x[1]) - 1] = x[2].toLowerCase();
        return out;
      }
      assert.fail(`theme.css 找不到含 --cat-* 的 ${selectorRe}`);
    };
    const light = grab(/^:root,\s*\[data-theme\]\s*\{/m);
    const dark = grab(/^\[data-theme="dark"\]\s*\{/m);
    assert.equal(light.length, 8);
    assert.equal(dark.length, 8);
    assert.deepEqual(light, CAT_PALETTE.light.map((c) => c.toLowerCase()));
    assert.deepEqual(dark, CAT_PALETTE.dark.map((c) => c.toLowerCase()));
    // timetable.css §A：每個 --ns-tt-cat-N 都指回 var(--cat-N)，不再自己寫色碼
    const tt = readFileSync(path.join(ROOT, "src/ui/timetable/timetable.css"), "utf8");
    for (let n = 1; n <= 8; n++) {
      assert.match(tt, new RegExp(`--ns-tt-cat-${n}:\\s*var\\(--cat-${n}\\)`), `timetable.css 的 --ns-tt-cat-${n} 要指回 var(--cat-${n})`);
    }
    assert.doesNotMatch(tt, /--ns-tt-cat-\d:\s*#/, "timetable.css 不再自己寫分類色色碼");
  });

  test("D9 TtNoticeStore.kt 含 §5.10.4 的五把 SharedPreferences 鍵字面值", () => {
    const kt = readFileSync(
      path.join(ROOT, "src-tauri/plugins/tauri-plugin-tt-notice/android/src/main/java/TtNoticeStore.kt"),
      "utf8",
    );
    for (const key of ["state", "pending", "reminder", "launch", "last_render"]) {
      assert.ok(kt.includes(`"${key}"`), `TtNoticeStore.kt 沒有 "${key}"`);
    }
    assert.ok(kt.includes(`"tt_notice"`), "SharedPreferences 檔名 tt_notice");
    assert.ok(kt.includes("MODE_PRIVATE"));
    // 牙齒（契約 §8 丙）：Kotlin 不碰 DB
    assert.ok(!/SQLiteDatabase|openOrCreateDatabase|next-stop-v2/.test(kt));
    // 展開版運行列讀 NoticeRunning.estimateText（欄位名字面值對帳）
    const renderer = readFileSync(
      path.join(ROOT, "src-tauri/plugins/tauri-plugin-tt-notice/android/src/main/java/TtNoticeRenderer.kt"),
      "utf8",
    );
    assert.ok(renderer.includes(`"estimateText"`), "TtNoticeRenderer.kt 要讀 estimateText");
  });
});

describe("D 區・②（② 契約 §4.5）", () => {
  const cs = cats();
  const catById: Record<string, TimeCategoryRow> = {};
  for (const c of cs) catById[c.id] = c;
  const base = { enabled: true, tilesEnabled: true, longRunEnabled: true, catById, categories: cs, recentIds: [] as string[], pins: [] as string[], globalMaxMin: 840 };
  const start = T(14, 35);

  test("D-②1 給 linkLabel ⇒ running.name、subText、reminderTitle 都是「創作・寫契約」；圓牌、顏色、tiles 照舊是分類的", () => {
    const r = block("blk", "c", start, null);
    const s = buildNoticeState({ ...base, running: r, linkLabel: "寫契約" });
    assert.ok(s.running);
    assert.equal(s.running.name, "創作・寫契約");
    assert.equal(s.running.subText, "創作・寫契約・14:35 発");
    assert.equal(s.running.reminderTitle, "創作・寫契約已經跑了 2h，還在進行嗎？"); // 分類預設 120
    assert.equal(s.running.glyph, "創");
    assert.equal(s.running.categoryId, "c");
    const plain = buildNoticeState({ ...base, running: r });
    assert.deepEqual(s.tiles, plain.tiles); // 格子是分類，不帶任務名
    assert.equal(s.running.colorLight, plain.running?.colorLight);
    // 分類已不在（同步途中）⇒「？・寫契約」
    const ghost = buildNoticeState({ ...base, running: block("g", "gone", start, null), linkLabel: "寫契約" });
    assert.equal(ghost.running?.name, "？・寫契約");
    assert.equal(ghost.running?.glyph, "？");
  });

  test("D-②2 linkLabel 超過 16 字被截（第 16 字是「…」）；剛好 16 字不截", () => {
    const r = block("blk", "c", start, null);
    const long = "一二三四五六七八九十一二三四五六七八九十"; // 20 字
    const s = buildNoticeState({ ...base, running: r, linkLabel: long });
    assert.equal(s.running?.name, "創作・一二三四五六七八九十一二三四五…");
    assert.equal(Array.from(s.running!.name.slice("創作・".length)).length, 16);
    assert.equal(s.running?.subText, "創作・一二三四五六七八九十一二三四五…・14:35 発");
    const sixteen = long.slice(0, 16);
    assert.equal(buildNoticeState({ ...base, running: r, linkLabel: sixteen }).running?.name, `創作・${sixteen}`);
  });

  test("D-②3 taskEstimateMin 60、分類 240 ⇒ running.thresholdMin === 60；預估優先於任務；任務 0／null ⇒ 退回分類", () => {
    const cs2 = cs.map((c) => (c.id === "c" ? { ...c, default_min: 240 } : c));
    const byId2: Record<string, TimeCategoryRow> = {};
    for (const c of cs2) byId2[c.id] = c;
    const b2 = { ...base, catById: byId2, categories: cs2 };
    const r = block("blk", "c", start, null);
    const s = buildNoticeState({ ...b2, running: r, taskEstimateMin: 60, linkLabel: "寫契約" });
    assert.equal(s.running?.thresholdMin, 60);
    assert.equal(s.running?.reminderTitle, "創作・寫契約已經跑了 1h，還在進行嗎？");
    assert.equal(thresholdOf(null, byId2.c, 840, 60)?.source, "task");
    const est = buildNoticeState({ ...b2, running: block("blk", "c", start, null, { estimate_min: 30 }), taskEstimateMin: 60 });
    assert.equal(est.running?.thresholdMin, 30);
    assert.equal(buildNoticeState({ ...b2, running: r, taskEstimateMin: 0 }).running?.thresholdMin, 240);
    assert.equal(buildNoticeState({ ...b2, running: r, taskEstimateMin: null }).running?.thresholdMin, 240);
    // 常用格的門檻不吃任務（從格子發車的那班沒有連結；§4.2-6 #3 不改）
    assert.equal(s.tiles.find((t) => t.categoryId === "c")?.thresholdMin, 240);
  });

  test("D-②4 不給新欄／給 null ＝ ①c 的狀態逐欄相同", () => {
    for (const r of [null, block("blk", "c", start, null, { estimate_min: 30 }), block("blk", "f", start, null), block("g", "gone", start, null)]) {
      const old = buildNoticeState({ ...base, running: r });
      assert.deepEqual(buildNoticeState({ ...base, running: r, linkLabel: null, taskEstimateMin: null }), old);
      assert.deepEqual(buildNoticeState({ ...base, running: r, linkLabel: undefined, taskEstimateMin: undefined }), old);
      assert.equal(JSON.stringify(buildNoticeState({ ...base, running: r, linkLabel: null })), JSON.stringify(old)); // 去重簽章不變
    }
    // ①c 的快照（D2 同一組）原樣成立
    const s = buildNoticeState({ ...base, running: block("blk", "c", start, null, { estimate_min: 30 }) });
    assert.equal(s.running?.subText, "創作・14:35 発");
    assert.equal(s.running?.thresholdMin, 30);
    assert.equal(s.running?.reminderTitle, "創作已經跑了 30m，還在進行嗎？");
  });

  test("D-②5 noticeRunName ＝ runLabel(cat, clipLabel(label))；三支純函式檔只 import ./timetable.ts", () => {
    const cases: (string | null)[] = [null, "", "寫契約", "一二三四五六七八九十一二三四五六", "一二三四五六七八九十一二三四五六七", "😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀"];
    for (const l of cases) {
      assert.equal(noticeRunName("創作", l), runLabel("創作", l === null ? null : clipLabel(l)), `label=${String(l)}`);
    }
    assert.equal(noticeRunName("創作", undefined), "創作");
    for (const f of ["timetableNotice.ts", "timetableTray.ts", "timetableLink.ts"]) {
      const src = readFileSync(path.join(ROOT, "src/domain", f), "utf8");
      const froms = Array.from(src.matchAll(/^import[\s\S]*?from\s+"([^"]+)";/gm)).map((m) => m[1]);
      assert.ok(froms.length > 0, f);
      assert.deepEqual(Array.from(new Set(froms)), ["./timetable.ts"], `${f} 只准 import ./timetable.ts`);
    }
  });
});
