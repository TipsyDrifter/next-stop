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
  mergeAfterOf,
  mergeCellKey,
  mergeFreshSince,
  mergeSubject,
  mergeToastKey,
  mergeObjectKey,
  mergeToastText,
  nounOf,
  sameAsRecorded,
  winnerValue,
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
    "有 1 項設定兩台都改過，留下後改的",
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

test("clipLabel：有「」只截裡面、括號留著；沒有就整段截", () => {
  assert.equal(clipLabel("車票「牙醫」", 12), "車票「牙醫」");
  assert.equal(clipLabel("車票「一二三四五六七八九十一二三」", 12), "車票「一二三四五六七八九十一二…」");
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

test("describeMerge（接縫 #77）：不給 fmt ⇒ 逐字不變（長字串、物件、null 都走 fmtMergeValue）", () => {
  const cases: MergeNotice[] = [
    mk({ kind: "overwritten", col: "ended_at", mine: "2026-10-19T06:35:00.000Z", theirs: "2026-10-19T07:10:00.000Z", winner: "theirs" }),
    mk({ kind: "overwritten", col: "scope", mine: { a: 1 }, theirs: null, winner: "mine" }),
    mk({ kind: "overwritten", col: "body", mine: "甲", theirs: "乙", by_me: false }),
    mk({ kind: "revived" }),
    mk({ kind: "kept", by_me: false }),
  ];
  for (const n of cases) {
    assert.equal(describeMerge(n, undefined), describeMerge(n));
  }
  assert.equal(
    describeMerge(cases[0]),
    "這台改成「2026-10-19T06:35:00.000Z」、另一台改成「2026-10-19T07:10:00.000Z」——留下另一台後改的",
  );
});

test("describeMerge（接縫 #77）：給 fmt ⇒ overwritten 兩邊用它的字；回 null 的欄退回 fmtMergeValue", () => {
  const seen: Array<[string, unknown]> = [];
  const fmt = (col: string, v: unknown): string | null => {
    seen.push([col, v]);
    return col === "ended_at" ? `<${String(v).slice(11, 16)}>` : null;
  };
  const t = mk({ kind: "overwritten", col: "ended_at", mine: "2026-10-19T06:35:00.000Z", theirs: "2026-10-19T07:10:00.000Z", winner: "theirs" });
  assert.equal(describeMerge(t, fmt), "這台改成「<06:35>」、另一台改成「<07:10>」——留下另一台後改的");
  assert.deepEqual(seen.map((x) => x[0]), ["ended_at", "ended_at"]);
  const other = mk({ kind: "overwritten", col: "name", mine: "甲", theirs: "乙", winner: "mine" });
  assert.equal(describeMerge(other, fmt), "另一台改成「乙」、這台改成「甲」——留下這台後改的");
  // fmt 丟錯 ⇒ 退回，不 throw
  const boom = (): string | null => {
    throw new Error("x");
  };
  assert.equal(describeMerge(other, boom), describeMerge(other));
  // revived／kept 不問 fmt
  seen.length = 0;
  describeMerge(mk({ kind: "revived" }), fmt);
  assert.equal(seen.length, 0);
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
  assert.equal(mergeToastText([mk({ kind: "revived" })], "車票「牙醫」"), "你刪掉的車票「牙醫」因為另一台改過，回來了");
  assert.equal(mergeToastText([mk({ kind: "revived" })], "牙醫"), "你刪掉的「牙醫」因為另一台改過，回來了");
  assert.equal(mergeToastText([mk({ kind: "kept", winner: "mine" })], "牙醫"), "另一台刪過「牙醫」，但這台改過——留著");
  const o = mk({ kind: "overwritten", tbl: "nodes", col: "scheduled_time", winner: "theirs" });
  assert.equal(mergeToastText([o], "車票「牙醫」", { scheduled_time: "時刻" }), "車票「牙醫」的時刻兩台都改過，留下另一台後改的");
  assert.equal(mergeToastText([{ ...o, winner: "mine" }], "車票「牙醫」", { scheduled_time: "時刻" }), "車票「牙醫」的時刻兩台都改過，留下這台後改的");
});

test("mergeToastText：括號改「」之後（丙-7）——名字自帶「」的前綴標籤不重包；時段列的分類名帶「」仍整段包起來", () => {
  assert.equal(mergeToastText([mk({ kind: "revived" })], "車票「讀「哈利」」"), "你刪掉的車票「讀「哈利」」因為另一台改過，回來了");
  assert.equal(mergeToastText([mk({ kind: "revived" })], "10/18 讀「書」 09:00"), "你刪掉的「10/18 讀「書」 09:00」因為另一台改過，回來了");
  assert.equal(clipLabel("車票「讀「哈利」」", 12), "車票「讀「哈利」」");
  assert.equal(clipLabel("車票「讀「一二三四五六七八九十」」", 12), "車票「讀「一二三四五六七八九十…」");
  // 回歸：時段列分類名帶「」⇒ 不算前綴型，整段截 12 字
  assert.equal(clipLabel("10/18 讀「哈利波特」系列 09:00–10:00", 12), "10/18 讀「哈利波特…");
});

test("mergeToastText：單筆解不到名字 ⇒「1 則筆記」句", () => {
  assert.equal(mergeToastText([mk({ kind: "revived" })], null), "你刪掉的 1 則筆記因為另一台改過，回來了");
  assert.equal(mergeToastText([mk({ kind: "kept" })], null), "另一台刪過 1 則筆記，但這台改過——留著");
  assert.equal(
    mergeToastText([mk({ kind: "overwritten", col: "body", winner: "mine" })], null),
    "有 1 則筆記兩台都改過，留下這台後改的",
  );
});

test("mergeToastText：第三台單筆不指認「你／這台」", () => {
  const r = mergeToastText([mk({ kind: "revived", by_me: false })], "牙醫");
  const k = mergeToastText([mk({ kind: "kept", by_me: false })], "牙醫");
  const o = mergeToastText([mk({ kind: "overwritten", col: "name", by_me: false })], "牙醫", { name: "票名" });
  assert.equal(r, "「牙醫」因為另一台改過，回來了");
  assert.equal(k, "「牙醫」一台刪過、另一台改過——留著");
  assert.equal(o, "「牙醫」的票名兩台都改過，留下後改的");
  for (const s of [r, k, o]) assert.ok(!s.includes("這台") && !s.includes("你"), s);
});

test("mergeToastText：同類同表 N 筆三種", () => {
  const rs = [mk({ row_id: "1" }), mk({ row_id: "2" }), mk({ row_id: "3" })];
  assert.equal(mergeToastText(rs, null), "你刪掉的 3 則筆記因為另一台改過，回來了");
  const ks = rs.map((n) => ({ ...n, kind: "kept" as const, tbl: "time_blocks" }));
  assert.equal(mergeToastText(ks, null), "另一台刪過 3 段時間，但這台改過——留著");
  const os = rs.slice(0, 2).map((n) => ({ ...n, kind: "overwritten" as const, col: "body" }));
  assert.equal(mergeToastText(os, null), "有 2 則筆記兩台都改過，留下後改的");
});

test("mergeToastText：混合（含同類同表但有第三台）⇒「同步時有 N 處…」", () => {
  const mixed = [mk(), mk({ kind: "overwritten", tbl: "nodes", col: "name" }), mk({ kind: "kept", tbl: "tk_entries" }), mk({ tbl: "nodes", row_id: "n2" })];
  assert.equal(mergeToastText(mixed, null), "同步時有 4 處兩台撞到——看看是哪些");
  assert.equal(mergeToastText([mk(), mk({ row_id: "n2", by_me: false })], null), "同步時有 2 處兩台撞到——看看是哪些");
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
    mk({ kind: "revived", tbl: "nodes", row_id: "n2", at: "2026-10-17T08:48:00.000Z" }),
  ];
  assert.equal(mergeToastText(seed, null), "同步時有 4 處兩台撞到——看看是哪些");
  const added = mk({ kind: "overwritten", tbl: "notes", col: "body", winner: "mine", at: "2026-10-17T09:00:00.000Z" });
  const list = [added, ...seed];
  const batch = mergeFreshSince(list, mergeToastKey(seed));
  assert.equal(mergeToastText(batch, null), "有 1 則筆記兩台都改過，留下這台後改的");
});

/* ── 主線④ #82：數的是物件，不是通知筆數 ── */

test("#82 反例：同一塊兩欄同時被蓋 ⇒ 一句列兩個欄名、不說「2 段」", () => {
  const a = mk({ kind: "overwritten", tbl: "time_blocks", row_id: "b1", col: "category_id", winner: "theirs" });
  const b = mk({ kind: "overwritten", tbl: "time_blocks", row_id: "b1", col: "ended_at", winner: "theirs" });
  const cols = { category_id: "分類", ended_at: "結束時刻" };
  const named = mergeToastText([a, b], "10/18 工作 09:00", cols);
  assert.equal(named, "「10/18 工作 09:00」的分類、結束時刻兩台都改過，留下另一台後改的");
  const unnamed = mergeToastText([a, b], null, cols);
  assert.equal(unnamed, "有 1 段時間兩台改到同樣的 2 處，留下另一台後改的");
  for (const s of [named, unnamed]) assert.ok(!s.includes("2 段"), s);
});

test("#82 長度：12 字名＋兩個 4 字欄名的兩欄句在 40 字內（#59 兩行上限）", () => {
  const label = clipLabel("車票「一二三四五六七八九十一二三四五」", 12);
  const a = mk({ kind: "overwritten", tbl: "nodes", row_id: "x", col: "c1", winner: "theirs" });
  const b = mk({ kind: "overwritten", tbl: "nodes", row_id: "x", col: "c2", winner: "theirs" });
  const s = mergeToastText([a, b], label, { c1: "本班時刻", c2: "預定時刻" });
  assert.ok(Array.from(s).length <= 40, `${Array.from(s).length}：${s}`);
});

test("#82：同一塊兩欄、留下的不是同一台 ⇒ 不指認「這台／另一台」", () => {
  const a = mk({ kind: "overwritten", tbl: "time_blocks", row_id: "b1", col: "category_id", winner: "mine" });
  const b = mk({ kind: "overwritten", tbl: "time_blocks", row_id: "b1", col: "ended_at", winner: "theirs" });
  const s = mergeToastText([a, b], "睡覺", { category_id: "分類", ended_at: "結束時刻" });
  assert.equal(s, "「睡覺」的分類、結束時刻兩台都改過，留下後改的");
});

test("#82：同一樣東西三欄以上只說幾個地方；兩樣東西各一欄仍是「2 段」", () => {
  const cs = ["a", "b", "c"].map((col) => mk({ kind: "overwritten", tbl: "time_blocks", row_id: "b1", col }));
  assert.equal(mergeToastText(cs, "睡覺"), "「睡覺」有 3 個地方兩台都改過，留下另一台後改的");
  const two = [mk({ kind: "overwritten", tbl: "time_blocks", row_id: "b1", col: "a" }), mk({ kind: "overwritten", tbl: "time_blocks", row_id: "b2", col: "a" })];
  assert.equal(mergeToastText(two, null), "有 2 段時間兩台都改過，留下後改的");
});

test("#82：混合句的 N 也是樣數（同一塊兩欄＋一則筆記 ⇒ 2 處）", () => {
  const list = [
    mk({ kind: "overwritten", tbl: "time_blocks", row_id: "b1", col: "a" }),
    mk({ kind: "overwritten", tbl: "time_blocks", row_id: "b1", col: "b" }),
    mk({ kind: "revived", tbl: "notes", row_id: "n1" }),
  ];
  assert.equal(mergeToastText(list, null), "同步時有 2 處兩台撞到——看看是哪些");
});

/* ── 主線④ #81：刪改相撞之後又不在了，toast 不說反話 ── */

test("#81 反例：revived／kept 但現在已經不在了 ⇒ 不說「回來了」「留著」", () => {
  const r = mk({ kind: "revived", tbl: "time_blocks", row_id: "s" });
  const k = mk({ kind: "kept", tbl: "time_blocks", row_id: "s" });
  const gone = new Set([mergeObjectKey(r)]);
  for (const n of [r, k]) {
    const named = mergeToastText([n], "10/18 社交 16:…", undefined, gone);
    const unnamed = mergeToastText([n], null, undefined, gone);
    assert.equal(named, "「10/18 社交 16:…」一台刪過、另一台改過，現在已經不在了");
    assert.equal(unnamed, "有 1 段時間一台刪過、另一台改過，現在已經不在了");
    for (const s of [named, unnamed]) assert.ok(!s.includes("回來了") && !s.includes("留著"), s);
  }
  // 不在集合裡的照舊
  assert.equal(mergeToastText([r], "睡覺", undefined, new Set()), "你刪掉的「睡覺」因為另一台改過，回來了");
});

test("#81：多樣東西全都不在了 ⇒ 結果句；有的在有的不在 ⇒ 混合句", () => {
  const a = mk({ kind: "revived", tbl: "time_blocks", row_id: "a" });
  const b = mk({ kind: "revived", tbl: "time_blocks", row_id: "b" });
  assert.equal(mergeToastText([a, b], null, undefined, new Set([mergeObjectKey(a), mergeObjectKey(b)])), "有 2 段時間一台刪過、另一台改過，現在已經不在了");
  assert.equal(mergeToastText([a, b], null, undefined, new Set([mergeObjectKey(a)])), "同步時有 2 處兩台撞到——看看是哪些");
});

test("#81 → 磨光② A4：overwritten 的列在 gone 裡 ⇒ 不說「留下這台後改的」；不在集合裡照舊", () => {
  // 主線④ 時 overwritten 不看 gone；A4 起「那一列現在不在了」也用 gone 表示（syncStore 把 currentCells 的 gone 併進來）
  const o = mk({ kind: "overwritten", col: "body", winner: "mine" });
  assert.equal(mergeToastText([o], null, undefined, new Set([mergeObjectKey(o)])), "有 1 則筆記兩台都改過，現在已經不在了");
  assert.equal(mergeToastText([o], null, undefined, new Set()), "有 1 則筆記兩台都改過，留下這台後改的");
});

test("toast 長度：最長的單筆句（12 字名＋欄名）在 40 字內（#59 兩行上限）", () => {
  const label = clipLabel("車票「一二三四五六七八九十一二三四五」", 12);
  const o = mk({ kind: "overwritten", tbl: "nodes", col: "time_overrides", winner: "theirs" });
  const s = mergeToastText([o], label, { time_overrides: "本班時刻" });
  assert.ok(Array.from(s).length <= 40, `${Array.from(s).length}：${s}`);
});

/* ── 磨光② A4：清單與 toast 在整理之後組句 ── */

test("A4 winnerValue／mergeCellKey：留下誰的值；鍵含欄、col null 當空字串", () => {
  assert.equal(winnerValue(mk({ kind: "overwritten", mine: "甲", theirs: "乙", winner: "mine" })), "甲");
  assert.equal(winnerValue(mk({ kind: "overwritten", mine: "甲", theirs: "乙", winner: "theirs" })), "乙");
  const a = mergeCellKey({ tbl: "time_blocks", row_id: "b1", col: "ended_at" });
  assert.equal(a, "time_blocks\u0000b1\u0000ended_at");
  assert.notEqual(a, mergeCellKey({ tbl: "time_blocks", row_id: "b1", col: "category_id" }));
  assert.equal(mergeCellKey({ tbl: "notes", row_id: "n", col: null }), "notes\u0000n\u0000");
});

test("A4 sameAsRecorded：120 字截斷照 Rust 規則比", () => {
  const long = `${"甲".repeat(120)}尾巴`;
  const recorded = `${"甲".repeat(120)}…`; // Rust clip_value 的樣子
  assert.equal(sameAsRecorded(recorded, long), true);
  assert.equal(sameAsRecorded(recorded, `${"乙".repeat(120)}尾巴`), false);
  // 剛好 120 字不截：通知記的是原字串
  const exact = "字".repeat(120);
  assert.equal(sameAsRecorded(exact, exact), true);
  assert.equal(sameAsRecorded(exact, `${exact}多`), false);
  // 代理對（emoji）以 code point 計，不切壞
  const emoji = `${"😀".repeat(121)}`;
  assert.equal(sameAsRecorded(`${"😀".repeat(120)}…`, emoji), true);
});

test("A4 sameAsRecorded：JSON 容器照 Rust 600 字上限比（沙盒 S2′：171 字的 scope 不該被當成「之後又被整理過」）", () => {
  const scope = JSON.stringify({ categories: Array.from({ length: 5 }, (_, i) => `${i}`.repeat(36)) });
  assert.ok(scope.length > 120 && scope.length <= 600);
  assert.equal(sameAsRecorded(scope, scope), true, "≤600 的容器 Rust 不截，現值也不能被截");
  const huge = `[${"字".repeat(700)}]`;
  const recordedHuge = `${Array.from(huge).slice(0, 600).join("")}…`;
  assert.equal(sameAsRecorded(recordedHuge, huge), true, ">600 照 Rust 截在 600＋…");
  // 一般字串仍是 120
  assert.equal(sameAsRecorded(`${"甲".repeat(120)}…`, `${"甲".repeat(130)}`), true);
});

test("A4 sameAsRecorded：數字字串對數字、null／undefined、其餘 JSON 比", () => {
  assert.equal(sameAsRecorded(3, "3"), true);
  assert.equal(sameAsRecorded("3", 3), true);
  assert.equal(sameAsRecorded("3.0", 3), true);
  assert.equal(sameAsRecorded(3, "4"), false);
  assert.equal(sameAsRecorded(null, undefined), true);
  assert.equal(sameAsRecorded(undefined, null), true);
  assert.equal(sameAsRecorded(null, ""), false);
  assert.equal(sameAsRecorded("", 0), false); // 空字串不是數字
  assert.equal(sameAsRecorded("05:30", "05:30"), true);
  assert.equal(sameAsRecorded("05:30", "05:00"), false);
  assert.equal(sameAsRecorded("2026-10-20T05:30:00Z", "2026-10-20T05:00:00Z"), false);
  assert.equal(sameAsRecorded({ a: 1 }, { a: 1 }), true);
});

test("A4 mergeAfterOf：revived 看 gone、overwritten 看 cells；查不到＝undefined", () => {
  const r = mk({ kind: "revived", tbl: "time_blocks", row_id: "s" });
  assert.deepEqual(mergeAfterOf(r, new Set([mergeObjectKey(r)])), { gone: true });
  assert.equal(mergeAfterOf(r, new Set()), undefined);
  assert.equal(mergeAfterOf(r), undefined);
  const o = mk({ kind: "overwritten", tbl: "time_blocks", row_id: "b", col: "ended_at", mine: "05:00", theirs: "05:30", winner: "theirs" });
  const k = mergeCellKey(o);
  assert.equal(mergeAfterOf(o, undefined, new Map()), undefined);
  assert.equal(mergeAfterOf(o, undefined, new Map([[k, { gone: false, value: "05:30" }]])), undefined);
  assert.deepEqual(mergeAfterOf(o, undefined, new Map([[k, { gone: false, value: "05:00" }]])), { changed: true, now: "05:00" });
  assert.deepEqual(mergeAfterOf(o, undefined, new Map([[k, { gone: true }]])), { gone: true });
  // overwritten 不看 gone 集合（列不在由 cells 說）
  assert.equal(mergeAfterOf(o, new Set([mergeObjectKey(o)]), new Map()), undefined);
});

test("A4 describeMerge：revived／kept × gone × note", () => {
  const g = { gone: true } as const;
  assert.equal(describeMerge(mk({ kind: "revived" }), undefined, g), "你在這台刪過，另一台改過——現在已經不在了");
  assert.equal(describeMerge(mk({ kind: "kept", winner: "mine" }), undefined, g), "另一台刪過，但這台改過——現在已經不在了");
  assert.equal(describeMerge(mk({ kind: "revived", by_me: false }), undefined, g), "一台刪過、另一台改過——現在已經不在了");
  assert.equal(describeMerge(mk({ kind: "kept", by_me: false }), undefined, g), "一台刪過、另一台改過——現在已經不在了");
  // 線給 note ⇒ 用線的話取代通用尾句，只出現一次
  const note = "後來又被整理掉，現在不在軸上了";
  const s = describeMerge(mk({ kind: "revived" }), undefined, g, note);
  assert.equal(s, "你在這台刪過，另一台改過（後來又被整理掉，現在不在軸上了）");
  assert.equal(s.split(note).length - 1, 1);
  assert.ok(!s.includes("回來了") && !s.includes("現在已經不在了"), s);
  // 沒 after、有 note ⇒ 原句＋（note）（＝原本清單元件自己接的那一段）
  assert.equal(describeMerge(mk({ kind: "revived" }), undefined, undefined, note), `你在這台刪過，另一台改過——回來了（${note}）`);
  assert.equal(describeMerge(mk({ kind: "kept", by_me: false }), undefined, undefined, "甲"), "一台刪過、另一台改過——留著改過的（甲）");
});

test("A4 describeMerge：overwritten × gone／changed × note", () => {
  const o = mk({ kind: "overwritten", col: "ended_at", mine: "05:00", theirs: "05:30", winner: "theirs" });
  const base = "這台改成「05:00」、另一台改成「05:30」——留下另一台後改的";
  assert.equal(describeMerge(o), base);
  assert.equal(describeMerge(o, undefined, { gone: true }), `${base}（後來又不在了）`);
  assert.equal(describeMerge(o, undefined, { gone: true }, "被整理掉了"), `${base}（被整理掉了）`);
  assert.equal(describeMerge(o, undefined, { changed: true, now: "05:00" }), `${base}（後來又被整理成「05:00」）`);
  assert.equal(describeMerge(o, undefined, { changed: true, now: "05:00" }, "甲"), `${base}（後來又被整理成「05:00」）（甲）`);
  assert.equal(describeMerge(o, undefined, undefined, "甲"), `${base}（甲）`);
  // 現值也走 fmt（線的人話）；現值空 ⇒（空）
  const fmt = (_c: string, v: unknown) => (typeof v === "string" ? `10/20 ${v}` : null);
  assert.equal(
    describeMerge(o, fmt, { changed: true, now: "05:00" }),
    "這台改成「10/20 05:00」、另一台改成「10/20 05:30」——留下另一台後改的（後來又被整理成「10/20 05:00」）",
  );
  assert.equal(describeMerge(o, undefined, { changed: true, now: null }), `${base}（後來又被整理成「（空）」）`);
});

test("A4 mergeToastText：單欄 overwritten 的 changed／gone（有名字、沒名字）", () => {
  const o = mk({ kind: "overwritten", tbl: "time_blocks", row_id: "b1", col: "ended_at", winner: "theirs" });
  const cols = { ended_at: "結束時刻" };
  const changed = new Set([mergeCellKey(o)]);
  const gone = new Set([mergeObjectKey(o)]);
  assert.equal(mergeToastText([o], "睡覺", cols, undefined, changed), "「睡覺」的結束時刻兩台都改過，之後又被整理過");
  assert.equal(mergeToastText([o], null, cols, undefined, changed), "有 1 段時間兩台都改過，之後又被整理過");
  assert.equal(mergeToastText([o], "睡覺", cols, gone), "「睡覺」的結束時刻兩台都改過，現在已經不在了");
  assert.equal(mergeToastText([o], null, cols, gone), "有 1 段時間兩台都改過，現在已經不在了");
  // 不在了優先於又被整理過
  assert.equal(mergeToastText([o], "睡覺", cols, gone, changed), "「睡覺」的結束時刻兩台都改過，現在已經不在了");
  // 別格的鍵不影響
  const other = new Set([mergeCellKey({ ...o, col: "category_id" })]);
  assert.equal(mergeToastText([o], "睡覺", cols, undefined, other), "「睡覺」的結束時刻兩台都改過，留下另一台後改的");
});

test("A4 mergeToastText：同一樣東西多欄——任一欄 changed／gone ⇒ 句尾換掉", () => {
  const a = mk({ kind: "overwritten", tbl: "time_blocks", row_id: "b1", col: "category_id", winner: "theirs" });
  const b = mk({ kind: "overwritten", tbl: "time_blocks", row_id: "b1", col: "ended_at", winner: "theirs" });
  const cols = { category_id: "分類", ended_at: "結束時刻" };
  const changed = new Set([mergeCellKey(b)]);
  assert.equal(mergeToastText([a, b], "睡覺", cols, undefined, changed), "「睡覺」的分類、結束時刻兩台都改過，之後又被整理過");
  assert.equal(mergeToastText([a, b], null, cols, undefined, changed), "有 1 段時間兩台改到同樣的 2 處，之後又被整理過");
  assert.equal(mergeToastText([a, b], "睡覺", cols, new Set([mergeObjectKey(a)])), "「睡覺」的分類、結束時刻兩台都改過，現在已經不在了");
  const cs = ["a", "b", "c"].map((col) => mk({ kind: "overwritten", tbl: "time_blocks", row_id: "b1", col }));
  assert.equal(mergeToastText(cs, "睡覺", undefined, undefined, new Set([mergeCellKey(cs[2])])), "「睡覺」有 3 個地方兩台都改過，之後又被整理過");
});

test("A4 mergeToastText：多樣東西的句子不動；舊呼叫（不給 changed）逐字不變", () => {
  const two = [mk({ kind: "overwritten", tbl: "time_blocks", row_id: "b1", col: "a" }), mk({ kind: "overwritten", tbl: "time_blocks", row_id: "b2", col: "a" })];
  const all = new Set(two.map(mergeCellKey));
  assert.equal(mergeToastText(two, null, undefined, new Set(two.map(mergeObjectKey)), all), "有 2 段時間兩台都改過，留下後改的");
  const o = mk({ kind: "overwritten", tbl: "nodes", col: "scheduled_time", winner: "theirs" });
  const cols = { scheduled_time: "時刻" };
  const old = mergeToastText([o], "車票「牙醫」", cols);
  assert.equal(old, "車票「牙醫」的時刻兩台都改過，留下另一台後改的");
  assert.equal(mergeToastText([o], "車票「牙醫」", cols, undefined, undefined), old);
  assert.equal(mergeToastText([o], "車票「牙醫」", cols, new Set(), new Set()), old);
});

test("MERGE_TEXT：標題與兩組小標照契約（D-主-18 後標題改「最近兩台撞到的」）", () => {
  assert.equal(MERGE_TEXT.title, "最近兩台撞到的");
  assert.equal(MERGE_TEXT.groupRevived, "刪了又回來");
  assert.equal(MERGE_TEXT.groupOverwritten, "兩邊都改了、後改的留下");
  assert.equal(MERGE_TEXT.ack, "知道了");
  assert.equal(MERGE_TEXT.look, "看看");
  assert.equal(MERGE_TEXT.ackFailed("橋接不通"), "沒清掉：橋接不通");
});
