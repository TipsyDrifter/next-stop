// 主線車次③「同步復活提示」・純函式單元測試（契約 §6.3 TS 段）
// 跑法：node --test scripts/tests/sync-merges.test.ts（node 24 直接剝除型別；不進 tsc——tsconfig 只 include src）
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MERGE_TEXT,
  TBL_NOUN,
  clipLabel,
  countNoun,
  describeMerge,
  fallbackLabel,
  fmtMergeValue,
  groupMerges,
  mergeFreshSince,
  mergeSubject,
  mergeToastKey,
  mergeToastText,
  nounOf,
} from "../../src/domain/syncMerge.ts";
import type { MergeNotice } from "../../src/data/syncRepository.ts";

function mk(p: Partial<MergeNotice> = {}): MergeNotice {
  return {
    kind: "revived",
    tbl: "notes",
    row_id: "9c1e0000-0000-4000-8000-00000000a1b2",
    col: null,
    mine: null,
    theirs: null,
    winner: "theirs",
    their_device: "edcf0000",
    by_me: true,
    hlc: "17607720000000003-edcf0000",
    at: "2026-10-17T06:32:10.004Z",
    ...p,
  };
}

/* ── 名詞 ── */

test("nounOf：已知表、未知表退「一筆資料」", () => {
  assert.equal(nounOf("notes"), "筆記");
  assert.equal(nounOf("time_blocks"), "一段時間");
  assert.equal(nounOf("tk_entries"), "一筆帳");
  assert.equal(nounOf("nodes"), "車票");
  assert.equal(nounOf("some_future_table"), "一筆資料");
  assert.equal(nounOf("constructor"), "一筆資料"); // 不被原型鏈上的名字騙
});

test("countNoun：量詞＋名詞；「一＋量詞」開頭的名詞剝掉那兩字", () => {
  assert.equal(countNoun("notes", 3), "3 則筆記");
  assert.equal(countNoun("time_blocks", 2), "2 段時間");
  assert.equal(countNoun("tk_entries", 2), "2 筆帳");
  assert.equal(countNoun("nodes", 1), "1 張車票");
  assert.equal(countNoun("unknown_tbl", 1), "1 筆資料");
  assert.equal(countNoun("tags", 4), "4 枚荷札");
});

test("TBL_NOUN 收齊核心三表與三線九張表", () => {
  for (const t of ["nodes", "work_logs", "occurrences", "notes", "tags", "taggings", "time_categories", "time_blocks", "tk_currencies", "tk_accounts", "tk_categories", "tk_entries"]) {
    assert.ok(TBL_NOUN[t], t);
  }
});

test("settings 表有名詞：Rust 對每張表都記通知，核心 settings（day_start_hour）不能掉成「一筆資料（hour）」", () => {
  assert.equal(nounOf("settings"), "設定");
  assert.equal(countNoun("settings", 1), "1 項設定");
  assert.equal(
    mergeToastText([mk({ kind: "overwritten", tbl: "settings", row_id: "day_start_hour", col: "value", by_me: false })], null),
    "有 1 項設定兩台改到同一格，留下後改的",
  );
});

test("fallbackLabel：名詞＋row_id 末 4 字", () => {
  assert.equal(fallbackLabel(mk()), "筆記（a1b2）");
  assert.equal(fallbackLabel(mk({ tbl: "time_blocks", row_id: "x-c3d4" })), "一段時間（c3d4）");
  assert.equal(fallbackLabel(mk({ tbl: "tk_entries", row_id: "e5f6" })), "一筆帳（e5f6）");
});

/* ── 值與截斷 ── */

test("fmtMergeValue：null／空白＝（空）、24 字截斷、物件 stringify", () => {
  assert.equal(fmtMergeValue(null), "（空）");
  assert.equal(fmtMergeValue(undefined), "（空）");
  assert.equal(fmtMergeValue("   "), "（空）");
  assert.equal(fmtMergeValue("買牛奶"), "買牛奶");
  const long = "一二三四五六七八九十".repeat(3); // 30 字
  assert.equal(fmtMergeValue(long), `${long.slice(0, 24)}…`);
  assert.equal(fmtMergeValue(long, 5), "一二三四五…");
  assert.equal(fmtMergeValue({ a: 1 }), '{"a":1}');
  assert.equal(fmtMergeValue(42), "42");
  // 代理對（emoji）不被切壞
  assert.equal(fmtMergeValue("😀".repeat(30)), `${"😀".repeat(24)}…`);
});

test("clipLabel：有『』只截裡面、括號留著；沒有就整段截", () => {
  assert.equal(clipLabel("車票『牙醫』", 12), "車票『牙醫』");
  assert.equal(clipLabel("車票『一二三四五六七八九十一二三』", 12), "車票『一二三四五六七八九十一二…』");
  assert.equal(clipLabel("14:45–15:00 運動與伸展操", 5), "14:45…");
});

/* ── 方向句（D-主-17／D-主-20） ── */

test("describeMerge：revived／kept 兩方向（by_me）", () => {
  assert.equal(describeMerge(mk({ kind: "revived" })), "你在這台刪過，另一台改過——回來了");
  assert.equal(describeMerge(mk({ kind: "kept", winner: "mine" })), "另一台刪過，但這台改過——留著");
});

test("describeMerge：overwritten 兩方向印兩邊的值", () => {
  const theirs = mk({ kind: "overwritten", col: "scheduled_time", mine: "15:00", theirs: "16:00", winner: "theirs" });
  assert.equal(describeMerge(theirs), "這台改成「15:00」、另一台改成「16:00」——留下另一台後改的");
  const mine = mk({ kind: "overwritten", col: "body", mine: "買牛奶和雞蛋", theirs: "買豆漿", winner: "mine" });
  assert.equal(describeMerge(mine), "另一台改成「買豆漿」、這台改成「買牛奶和雞蛋」——留下這台後改的");
});

test("describeMerge：第三台（by_me=false）三句都不指認「這台」", () => {
  const r = describeMerge(mk({ kind: "revived", by_me: false }));
  const k = describeMerge(mk({ kind: "kept", by_me: false }));
  const o = describeMerge(mk({ kind: "overwritten", col: "body", mine: "甲", theirs: "乙", by_me: false }));
  assert.equal(r, "一台刪過、另一台改過——回來了");
  assert.equal(k, "一台刪過、另一台改過——留著改過的");
  assert.equal(o, "一台改成「甲」、另一台改成「乙」——留下後改的");
  for (const s of [r, k, o]) assert.ok(!s.includes("這台") && !s.includes("你"), s);
});

test("describeMerge：overwritten 值為空印（空）", () => {
  assert.equal(
    describeMerge(mk({ kind: "overwritten", col: "description", mine: null, theirs: "補一句", winner: "theirs" })),
    "這台改成「（空）」、另一台改成「補一句」——留下另一台後改的",
  );
});

test("mergeSubject：cols 覆蓋 > 欄名原文；沒有 CONFLICT_COL_LABEL 退路", () => {
  const n = mk({ kind: "overwritten", tbl: "tags", col: "name" });
  assert.equal(mergeSubject("荷札（a1b2）", n), "荷札（a1b2） 的 name"); // tags.name 不准被印成「票名」
  assert.equal(mergeSubject("荷札（a1b2）", n, { name: "名字" }), "荷札（a1b2） 的 名字");
  assert.equal(mergeSubject("筆記（a1b2）", mk({ kind: "revived" })), "筆記（a1b2）"); // 沒有 col 就只回 label
});

/* ── 分組與排序（D-主-18） ── */

test("groupMerges：revived 在 kept 前、組內 at 新在前、同 at 比 hlc", () => {
  const list = [
    mk({ kind: "kept", row_id: "k1", at: "2026-10-17T09:00:00.000Z" }),
    mk({ kind: "overwritten", row_id: "o1", col: "body", at: "2026-10-17T08:00:00.000Z" }),
    mk({ kind: "revived", row_id: "r1", at: "2026-10-17T07:00:00.000Z" }),
    mk({ kind: "revived", row_id: "r2", at: "2026-10-17T08:00:00.000Z", hlc: "1-a" }),
    mk({ kind: "revived", row_id: "r3", at: "2026-10-17T08:00:00.000Z", hlc: "2-a" }),
    mk({ kind: "overwritten", row_id: "o2", col: "body", at: "2026-10-17T10:00:00.000Z" }),
  ];
  const g = groupMerges(list);
  assert.deepEqual(g.revived.map((n) => n.row_id), ["r3", "r2", "r1", "k1"]);
  assert.deepEqual(g.overwritten.map((n) => n.row_id), ["o2", "o1"]);
});

test("groupMerges：kind 不認得的丟掉、不 throw", () => {
  const bad = { ...mk(), kind: "exploded" } as unknown as MergeNotice;
  const g = groupMerges([bad, mk({ row_id: "ok" })]);
  assert.deepEqual(g.revived.map((n) => n.row_id), ["ok"]);
  assert.deepEqual(g.overwritten, []);
  assert.deepEqual(groupMerges([]), { revived: [], overwritten: [] });
});

/* ── 新批與去重鍵（反駁 E1） ── */

test("mergeFreshSince：null ⇒ 整張；給鍵 ⇒ 只剩 at 更新的", () => {
  const a = mk({ row_id: "a", at: "2026-10-17T07:00:00.000Z" });
  const b = mk({ row_id: "b", at: "2026-10-17T08:00:00.000Z" });
  assert.equal(mergeFreshSince([b, a], null).length, 2);
  assert.deepEqual(mergeFreshSince([b, a], "2026-10-17T07:00:00.000Z").map((n) => n.row_id), ["b"]);
  assert.deepEqual(mergeFreshSince([b, a], "2026-10-17T08:00:00.000Z"), []);
});

test("mergeToastKey：空 ⇒ null；取最新一筆的 at（順序亂了也對）", () => {
  assert.equal(mergeToastKey([]), null);
  const a = mk({ at: "2026-10-17T07:00:00.000Z" });
  const b = mk({ at: "2026-10-17T08:00:00.000Z" });
  assert.equal(mergeToastKey([b, a]), b.at);
  assert.equal(mergeToastKey([a, b]), b.at);
});

/* ── toast 全文（§4.9） ── */

test("mergeToastText：單筆四種（有名字）", () => {
  assert.equal(mergeToastText([mk({ kind: "revived" })], "車票『牙醫』"), "你刪掉的車票『牙醫』因為另一台改過，回來了");
  assert.equal(mergeToastText([mk({ kind: "revived" })], "牙醫"), "你刪掉的『牙醫』因為另一台改過，回來了");
  assert.equal(mergeToastText([mk({ kind: "kept", winner: "mine" })], "牙醫"), "另一台刪過『牙醫』，但這台改過——留著");
  const o = mk({ kind: "overwritten", tbl: "nodes", col: "scheduled_time", winner: "theirs" });
  assert.equal(mergeToastText([o], "車票『牙醫』", { scheduled_time: "時刻" }), "車票『牙醫』的時刻兩台都改過，留下另一台後改的");
  assert.equal(mergeToastText([{ ...o, winner: "mine" }], "車票『牙醫』", { scheduled_time: "時刻" }), "車票『牙醫』的時刻兩台都改過，留下這台後改的");
});

test("mergeToastText：單筆解不到名字 ⇒「1 則筆記」句", () => {
  assert.equal(mergeToastText([mk({ kind: "revived" })], null), "你刪掉的 1 則筆記因為另一台改過，回來了");
  assert.equal(mergeToastText([mk({ kind: "kept" })], null), "另一台刪過 1 則筆記，但這台改過——留著");
  assert.equal(
    mergeToastText([mk({ kind: "overwritten", col: "body", winner: "mine" })], null),
    "有 1 則筆記兩台改到同一格，留下這台後改的",
  );
});

test("mergeToastText：第三台單筆不指認「你／這台」", () => {
  const r = mergeToastText([mk({ kind: "revived", by_me: false })], "牙醫");
  const k = mergeToastText([mk({ kind: "kept", by_me: false })], "牙醫");
  const o = mergeToastText([mk({ kind: "overwritten", col: "name", by_me: false })], "牙醫", { name: "票名" });
  assert.equal(r, "『牙醫』因為另一台改過，回來了");
  assert.equal(k, "『牙醫』一台刪過、另一台改過——留著");
  assert.equal(o, "『牙醫』的票名兩台都改過，留下後改的");
  for (const s of [r, k, o]) assert.ok(!s.includes("這台") && !s.includes("你"), s);
});

test("mergeToastText：同類同表 N 筆三種", () => {
  const rs = [mk({ row_id: "1" }), mk({ row_id: "2" }), mk({ row_id: "3" })];
  assert.equal(mergeToastText(rs, null), "你刪掉的 3 則筆記因為另一台改過，回來了");
  const ks = rs.map((n) => ({ ...n, kind: "kept" as const, tbl: "time_blocks" }));
  assert.equal(mergeToastText(ks, null), "另一台刪過 3 段時間，但這台改過——留著");
  const os = rs.slice(0, 2).map((n) => ({ ...n, kind: "overwritten" as const, col: "body" }));
  assert.equal(mergeToastText(os, null), "有 2 則筆記兩台改到同一格，留下後改的");
});

test("mergeToastText：混合（含同類同表但有第三台）⇒「同步時有 N 處…」", () => {
  const mixed = [mk(), mk({ kind: "overwritten", tbl: "nodes", col: "name" }), mk({ kind: "kept", tbl: "tk_entries" }), mk({ tbl: "nodes" })];
  assert.equal(mergeToastText(mixed, null), "同步時有 4 處兩台撞到——看看是哪些");
  assert.equal(mergeToastText([mk(), mk({ by_me: false })], null), "同步時有 2 處兩台撞到——看看是哪些");
});

test("反駁 E1：舊 1 筆＋新 1 筆 revived，經 mergeFreshSince 後是單筆句、不是「2 則」", () => {
  const old = mk({ row_id: "old", at: "2026-10-17T07:00:00.000Z" });
  const fresh = mk({ row_id: "new", at: "2026-10-17T08:00:00.000Z" });
  const list = [fresh, old];
  const batch = mergeFreshSince(list, old.at);
  assert.equal(batch.length, 1);
  assert.equal(mergeToastText(batch, null), "你刪掉的 1 則筆記因為另一台改過，回來了");
  assert.notEqual(mergeToastText(list, null), mergeToastText(batch, null));
});

test("§6.1 #24 的兩顆 toast：4 筆種子＝混合句；補的那一筆＝單筆句", () => {
  const seed = [
    mk({ kind: "overwritten", tbl: "nodes", col: "scheduled_time", at: "2026-10-17T08:57:00.000Z" }),
    mk({ kind: "revived", tbl: "notes", at: "2026-10-17T08:55:00.000Z" }),
    mk({ kind: "kept", tbl: "tk_entries", by_me: false, at: "2026-10-17T08:51:00.000Z" }),
    mk({ kind: "revived", tbl: "nodes", at: "2026-10-17T08:48:00.000Z" }),
  ];
  assert.equal(mergeToastText(seed, null), "同步時有 4 處兩台撞到——看看是哪些");
  const added = mk({ kind: "overwritten", tbl: "notes", col: "body", winner: "mine", at: "2026-10-17T09:00:00.000Z" });
  const list = [added, ...seed];
  const batch = mergeFreshSince(list, mergeToastKey(seed));
  assert.equal(mergeToastText(batch, null), "有 1 則筆記兩台改到同一格，留下這台後改的");
});

test("toast 長度：最長的單筆句（12 字名＋欄名）在 40 字內（#59 兩行上限）", () => {
  const label = clipLabel("車票『一二三四五六七八九十一二三四五』", 12);
  const o = mk({ kind: "overwritten", tbl: "nodes", col: "time_overrides", winner: "theirs" });
  const s = mergeToastText([o], label, { time_overrides: "本班時刻" });
  assert.ok(Array.from(s).length <= 40, `${Array.from(s).length}：${s}`);
});

test("MERGE_TEXT：標題與兩組小標照契約（D-主-18 後標題改「最近兩台撞到的」）", () => {
  assert.equal(MERGE_TEXT.title, "最近兩台撞到的");
  assert.equal(MERGE_TEXT.groupRevived, "刪了又回來");
  assert.equal(MERGE_TEXT.groupOverwritten, "兩邊都改了、後改的留下");
  assert.equal(MERGE_TEXT.ack, "知道了");
  assert.equal(MERGE_TEXT.look, "看看");
  assert.equal(MERGE_TEXT.ackFailed("橋接不通"), "沒清成：橋接不通");
});
