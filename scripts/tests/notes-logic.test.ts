// 旅客筆記・純函式單元測試（車次①契約 §4.4）
// 跑法：node --test scripts/tests/notes-logic.test.ts（node 24 直接剝除型別；不進 tsc——tsconfig 只 include src）
//
// 前 48 項＝原型 prototypes/旅客筆記-src/smoke.mjs 的邏輯斷言逐條移植（mdToHtml 兩項改成 plainParagraphs；
// 日期那一項換成本線實際有的 fmtMonthDay／fmtMonthHeader／monthKey＋lib/date 的 addDays）；
// 之後是車次①新增：D-筆-25 冒號後空白、escapeLike、支線視同路線、isInboxTicket 的 done、三枚票根輪替等。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CAPTURE_STUBS,
  STUB_HINT,
  STUB_LABEL,
  captureToast,
  escapeLike,
  excerpt,
  firstLine,
  fmtMonthDay,
  fmtMonthHeader,
  isBuiltinStub,
  isInboxTicket,
  lineCount,
  matchesQuery,
  monthKey,
  needsPreview,
  nextStub,
  noteTitle,
  parseRoutePrefix,
  plainParagraphs,
  previewDestination,
  resolveDestination,
  splitTodoLines,
  stripBullet,
  addMonths,
  clampDay,
  dayMark,
  diaryDraftMeta,
  diaryEmptyText,
  diaryPlaceholder,
  diaryToast,
  entryWrittenLabel,
  fmtShortDay,
  footprintDayKeys,
  footprintSummary,
  groupFootprints,
  hasFootprint,
  isBackfilled,
  monthDays,
  monthLeadBlanks,
  toDiaryHit,
  weekdayHeads,
  weekdayOrder,
  weekdayZh,
  footprintLogs,
  footprintSeals,
  MISSING_NODE_NAME,
  NOTE_NODE_KINDS,
  descendantIds,
  nodeNotesLine,
  quickHitLabel,
  stripMdLine,
  resolveLeaveText,
  applyCapturePreset,
  exclusiveNodeFilter,
  type NoteItemLike,
  type RoutePrefix,
  type CaptureStub,
  type FootprintDay,
  type FootprintLog,
  type FootprintLogSrc,
  type FootprintNodeSrc,
  type FootprintOccSrc,
  type FootprintSeal,
  type RouteLike,
  NS_PROD_IDENTIFIER,
  captureWindowFromSearch,
  shouldApplyAutostartDefault,
  captureWindowTransition,
  captureWindowReleaseEarly,
  captureWindowToastText,
  CAPTURE_DB_NOT_READY,
  autostartDefaultOnce,
  type AutostartDefaultDeps,
  createShareDrainer,
  shareBody,
  shareToastText,
  type SharedItemLike,
} from "../../src/domain/notes.ts";
import { addDays, dayWindow } from "../../src/lib/date.ts";

const routes: RouteLike[] = [
  { id: "r1", code: "CUM", name: "用量監控" },
  { id: "r2", code: "NS", name: "私鐵手帳" },
  { id: "r3", code: "CLUB", name: "社團" },
  { id: "r4", code: "JP", name: "日文" },
  { id: "r5", code: "N", name: "NS 延伸" }, // 刻意：短代碼與長名稱重疊，測「取最長」
];
const pr = (s: string) => parseRoutePrefix(s, routes);
/** 原型的票根四枚（含日記）；車次①預設三枚另測 */
const STUBS4: readonly CaptureStub[] = ["inbox", "todo", "note", "diary"];

/* ═══ 原型 smoke.mjs 移植（48 項） ═══ */

/* ── 路線前綴（16） ── */
test("前綴：代碼＋半形冒號", () => {
  const p = pr("CUM:查 API 限額")!;
  assert.equal(p.routeId, "r1");
  assert.equal(p.body, "查 API 限額");
  assert.equal(p.matched, "CUM:");
});
test("前綴：代碼＋全形冒號", () => {
  const p = pr("NS：收件匣按鈕太擠")!;
  assert.equal(p.routeId, "r2");
  assert.equal(p.body, "收件匣按鈕太擠");
});
test("前綴：代碼不分大小寫", () => {
  assert.equal(pr("cum：小寫也認")!.routeId, "r1");
  assert.equal(pr("Club: 混合")!.routeId, "r3");
});
test("前綴：全名＋全形冒號", () => {
  const p = pr("用量監控：圖表被切掉")!;
  assert.equal(p.routeId, "r1");
  assert.equal(p.body, "圖表被切掉");
});
test("前綴：全名＋半形冒號", () => {
  assert.equal(pr("日文:て形複習")!.routeId, "r4");
});
test("前綴：冒號後的空白（半形／全形）會去掉", () => {
  assert.equal(pr("JP：　 單字")!.body, "單字");
});
test("前綴：容許前導空白，prefixLen 含前導", () => {
  const p = pr("  CUM：x")!;
  assert.equal(p.routeId, "r1");
  assert.equal(p.prefixLen, 6);
  assert.equal(p.body, "x");
});
test("前綴：只有前綴、還沒打內文也認（打字當下就要出票根）", () => {
  const p = pr("CUM：")!;
  assert.equal(p.routeId, "r1");
  assert.equal(p.body, "");
});
test("前綴：同時命中取最長（「NS 延伸：」不被代碼 N 吃掉）", () => {
  assert.equal(pr("NS 延伸：x")!.routeId, "r5");
  assert.equal(pr("N：x")!.routeId, "r5");
  assert.equal(pr("NS：x")!.routeId, "r2");
});
test("前綴：不認得的前綴＝null", () => {
  assert.equal(pr("TODO: 買牛奶"), null);
  assert.equal(pr("會議：下午三點"), null);
});
test("前綴：「備註：」不誤判", () => {
  assert.equal(pr("備註：明天再看"), null);
});
test("前綴：不在開頭＝null", () => {
  assert.equal(pr("記得 CUM：門檻"), null);
  assert.equal(pr("今天要做 NS:x"), null);
});
test("前綴：代碼後面不是冒號＝null（NSX：、CUMULATIVE:）", () => {
  assert.equal(pr("NSX：x"), null);
  assert.equal(pr("CUMULATIVE: x"), null);
});
test("前綴：沒有冒號＝null", () => {
  assert.equal(pr("CUM 告警"), null);
});
test("前綴：空字串／沒有路線＝null", () => {
  assert.equal(pr(""), null);
  assert.equal(parseRoutePrefix("CUM：x", []), null);
});
test("前綴：多行文字只看第一行開頭", () => {
  const p = pr("CUM：第一行\n第二行")!;
  assert.equal(p.routeId, "r1");
  assert.equal(p.body, "第一行\n第二行");
});

/* ── 多行拆解（13） ── */
const triples = (text: string) => splitTodoLines(text).map((x) => [x.text, x.isHeading, x.checked]);
test("拆解：標題行（全形冒號結尾）預設不勾", () => {
  assert.deepEqual(triples("今天要做的事：\n・回信\n・買影印卡"), [
    ["今天要做的事：", true, false],
    ["回信", false, true],
    ["買影印卡", false, true],
  ]);
});
test("拆解：標題行（半形冒號、尾端空白）", () => {
  const r = splitTodoLines("Today:  \n- a");
  assert.equal(r[0].isHeading, true);
  assert.equal(r[1].text, "a");
});
test("拆解：Markdown 標題「## 」也當標題行並去掉井號", () => {
  const r = splitTodoLines("## 週末\n- 洗衣服");
  assert.deepEqual([r[0].text, r[0].isHeading], ["週末", true]);
});
test("拆解：條列符號 ・ • ‧ · ● ○ ■ □", () => {
  const r = splitTodoLines("・a\n•b\n‧c\n·d\n●e\n○f\n■g\n□h");
  assert.deepEqual(r.map((x) => x.text), ["a", "b", "c", "d", "e", "f", "g", "h"]);
});
test("拆解：條列符號 - * + 與全形－＊（需要後接空白）", () => {
  const r = splitTodoLines("- a\n* b\n+ c\n－ d\n＊ e");
  assert.deepEqual(r.map((x) => x.text), ["a", "b", "c", "d", "e"]);
});
test("拆解：不吃「**粗體**」與「-5 度」這種不是條列的開頭", () => {
  const r = splitTodoLines("**重要**的事\n-5 度要穿外套");
  assert.deepEqual(r.map((x) => x.text), ["**重要**的事", "-5 度要穿外套"]);
});
test("拆解：數字條列 1. 2、 3) (4) 5） 全形１．", () => {
  const r = splitTodoLines("1. a\n2、b\n3) c\n(4) d\n5）e\n１．f");
  assert.deepEqual(r.map((x) => x.text), ["a", "b", "c", "d", "e", "f"]);
});
test("拆解：數字後面接數字不當條列（10.5 交報告）", () => {
  assert.equal(splitTodoLines("10.5 交報告")[0].text, "10.5 交報告");
});
test("拆解：核取框 [ ] [x] 一併去掉", () => {
  const r = splitTodoLines("- [ ] a\n- [x] b");
  assert.deepEqual(r.map((x) => x.text), ["a", "b"]);
});
test("拆解：空行、純空白行、只有條列符號的行略過", () => {
  const r = splitTodoLines("a\n\n   \n　\n- \nb\r\nc");
  assert.deepEqual(r.map((x) => x.text), ["a", "b", "c"]);
});
test("拆解：前後空白（含全形空白）去掉", () => {
  assert.equal(splitTodoLines("　 ・ 買電池 　")[0].text, "買電池");
});
test("lineCount 只算非空行", () => {
  assert.equal(lineCount("a\n\n b \n　"), 2);
  assert.equal(lineCount(""), 0);
  assert.equal(lineCount("買電池"), 1);
});
test("needsPreview：只有「待辦」且多行才跳預覽", () => {
  assert.equal(needsPreview("todo", "a\nb"), true);
  assert.equal(needsPreview("todo", "a\n\n"), false);
  assert.equal(needsPreview("inbox", "a\nb"), false);
  assert.equal(needsPreview("note", "a\nb"), false);
  assert.equal(needsPreview("diary", "a\nb"), false);
});

/* ── 票根 × 路線前綴的去處對照表（Plan 第〇節，每一格；8） ── */
const table: [CaptureStub, boolean, string, boolean, boolean][] = [
  // stub, hasRoute, target, withRoute, consumePrefix
  ["inbox", false, "inbox", false, false],
  ["inbox", true, "note", true, true],
  ["todo", false, "today", false, false],
  ["todo", true, "today", true, true],
  ["note", false, "note", false, false],
  ["note", true, "note", true, true],
  ["diary", false, "diary", false, false],
  ["diary", true, "diary", false, false],
];
for (const [stub, has, target, withRoute, consumePrefix] of table) {
  test(`去處：${stub} × ${has ? "有" : "沒有"}路線前綴 → ${target}`, () => {
    assert.deepEqual(resolveDestination(stub, has), { target, withRoute, consumePrefix });
  });
}

/* ── toast（3）＋票根輪替（1） ── */
test("toast：收件匣附受付章", () => {
  assert.deepEqual(captureToast("inbox", resolveDestination("inbox", false), ""), {
    text: "已放進收件匣",
    stamp: "uketsuke",
  });
});
test("toast：收件匣＋路線要講清楚「不進收件匣」", () => {
  const t = captureToast("inbox", resolveDestination("inbox", true), "用量監控");
  assert.match(t.text, /筆記.*用量監控.*不進收件匣/);
  assert.equal(t.stamp, null);
});
test("toast：待辦／筆記／日記", () => {
  assert.equal(captureToast("todo", resolveDestination("todo", false), "").text, "已排進今日");
  assert.equal(captureToast("todo", resolveDestination("todo", true), "社團").text, "已排進今日 · 社團");
  assert.equal(captureToast("note", resolveDestination("note", true), "日文").text, "已存進筆記 · 日文");
  assert.equal(captureToast("note", resolveDestination("note", false), "").text, "已存進筆記");
  assert.equal(captureToast("diary", resolveDestination("diary", true), "日文").text, "已記在今天的日記");
});
test("票根 Tab 輪替（四枚、頭尾相接）", () => {
  assert.equal(nextStub("inbox", 1, STUBS4), "todo");
  assert.equal(nextStub("diary", 1, STUBS4), "inbox");
  assert.equal(nextStub("inbox", -1, STUBS4), "diary");
  assert.equal(nextStub("note", -1, STUBS4), "todo");
});

/* ── 預覽框落點與收件匣定義（2） ── */
const TODAY = "2026-10-05";
const pd = (f: { routeId?: string; parentId?: string; scheduledOn?: string }, names = {}) =>
  previewDestination(
    { routeId: f.routeId ?? null, parentId: f.parentId ?? null, scheduledOn: f.scheduledOn ?? null },
    TODAY,
    names,
  );
test("previewDestination", () => {
  assert.equal(pd({ scheduledOn: TODAY }), "今日");
  assert.equal(pd({ scheduledOn: "2026-10-08" }), "10 月 8 日");
  assert.equal(pd({ parentId: "x" }, { parent: "v0.3 告警通知" }), "v0.3 告警通知");
  assert.equal(pd({ routeId: "r1" }, { route: "用量監控" }), "用量監控");
  assert.equal(pd({}), "收件匣");
});
const ticket = {
  kind: "ticket" as const,
  parent_id: null as string | null,
  scheduled_on: null as string | null,
  route_id: null as string | null,
  status: "todo" as const,
  deleted_at: null as string | null,
};
test("isInboxTicket（D-筆-17 清空定義）", () => {
  assert.equal(isInboxTicket(ticket), true);
  assert.equal(isInboxTicket({ ...ticket, scheduled_on: "2026-10-05" }), false);
  assert.equal(isInboxTicket({ ...ticket, parent_id: "n" }), false);
  assert.equal(isInboxTicket({ ...ticket, route_id: "r" }), false);
  assert.equal(isInboxTicket({ ...ticket, deleted_at: "x" }), false);
});

/* ── 閱讀態段落（原 mdToHtml 兩項）＋標題摘要（1）＋搜尋（1） ── */
test("plainParagraphs：空行切段、段內保留換行、不解析任何標記", () => {
  assert.deepEqual(plainParagraphs("## 小標\n\n- a\n- **b**\n\n段落一\n同段第二行"), [
    ["## 小標"],
    ["- a", "- **b**"],
    ["段落一", "同段第二行"],
  ]);
});
test("plainParagraphs：純空白行也算空行、CRLF、空字串", () => {
  assert.deepEqual(plainParagraphs("a\r\n \r\n　\r\nb"), [["a"], ["b"]]);
  assert.deepEqual(plainParagraphs(""), []);
  assert.deepEqual(plainParagraphs("<script>x</script>"), [["<script>x</script>"]]);
});
test("noteTitle／excerpt", () => {
  assert.equal(noteTitle({ title: "", body: "## 起因\n內文" }), "起因");
  assert.equal(noteTitle({ title: "  有標題 ", body: "x" }), "有標題");
  assert.equal(noteTitle({ title: "", body: "" }), "（空白）");
  assert.equal(excerpt({ title: "", body: "第一行\n- 第二行" }, 50), "第二行");
  assert.equal(excerpt({ title: "T", body: "甲乙丙丁" }, 2), "甲乙…");
});
test("matchesQuery 比對標題與內文、不分大小寫", () => {
  assert.equal(matchesQuery({ title: "API 限額", body: "" }, "api"), true);
  assert.equal(matchesQuery({ title: "", body: "圖表被切掉" }, "切掉"), true);
  assert.equal(matchesQuery({ title: "a", body: "b" }, "zzz"), false);
  assert.equal(matchesQuery({ title: "a", body: "b" }, "  "), true);
});

/* ── 日期（1） ── */
test("日期工具", () => {
  assert.equal(addDays("2026-10-05", -5), "2026-09-30");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(fmtMonthDay("2026-10-05"), "10 月 5 日");
  assert.equal(fmtMonthHeader("2026-09"), "2026 年 9 月");
  assert.equal(monthKey("2026-09-30"), "2026-09");
});

/* ═══ 車次①新增 ═══ */

/* ── D-筆-25：冒號後空白可有可無，一併吃掉 ── */
test("D-筆-25：半形冒號後零個空白", () => {
  const p = pr("CUM:查限額")!;
  assert.equal(p.body, "查限額");
  assert.equal(p.matched, "CUM:");
});
test("D-筆-25：半形冒號後一個半形空白", () => {
  const p = pr("CUM: 查限額")!;
  assert.equal(p.body, "查限額");
  assert.equal(p.matched, "CUM:"); // matched 只到冒號；空白不算進前綴
});
test("D-筆-25：全形冒號後一個全形空白", () => {
  assert.equal(pr("CUM：　查限額")!.body, "查限額");
});
test("D-筆-25：冒號後多個半形＋全形＋Tab 混合", () => {
  assert.equal(pr("CUM：  　\t 查限額")!.body, "查限額");
  assert.equal(pr("用量監控:　　查限額")!.body, "查限額");
});
test("D-筆-25：只打前綴＋空白（還沒內文）也認、body 為空", () => {
  const p = pr("NS：   ")!;
  assert.equal(p.routeId, "r2");
  assert.equal(p.body, "");
});
test("D-筆-25：內文中間與尾端的空白不動", () => {
  assert.equal(pr("NS： a  b ")!.body, "a  b ");
});
test("前綴：前導全形空白與 Tab 也容許", () => {
  const p = pr("　\tCUM：x")!;
  assert.equal(p.routeId, "r1");
  assert.equal(p.prefixLen, 6);
});
test("前綴：冒號前有空白就不算（「CUM ：」）", () => {
  assert.equal(pr("CUM ：x"), null);
});
test("前綴：路線 code 為 null 只比全名", () => {
  const rs: RouteLike[] = [{ id: "z", code: null, name: "雜項" }];
  assert.equal(parseRoutePrefix("雜項：x", rs)!.routeId, "z");
  assert.equal(parseRoutePrefix("null：x", rs), null);
});

/* ── escapeLike ── */
test("escapeLike：% _ \\ 都加反斜線", () => {
  assert.equal(escapeLike("100%"), "100\\%");
  assert.equal(escapeLike("a_b"), "a\\_b");
  assert.equal(escapeLike("c:\\tmp"), "c:\\\\tmp");
});
test("escapeLike：一般文字與中文原樣", () => {
  assert.equal(escapeLike("查 API 限額"), "查 API 限額");
  assert.equal(escapeLike(""), "");
});
test("escapeLike：反斜線先於其他字元處理（不會重複跳脫）", () => {
  assert.equal(escapeLike("\\%"), "\\\\\\%");
});

/* ── previewDestination：支線視同路線（呼叫端把支線轉成 routeId、parentId=null） ── */
test("previewDestination：掛支線＝顯示路線名（支線視同路線）", () => {
  assert.equal(pd({ routeId: "r1", parentId: undefined }, { route: "用量監控" }), "用量監控");
});
test("previewDestination：有日期時日期優先於列車／路線", () => {
  assert.equal(pd({ scheduledOn: TODAY, parentId: "t", routeId: "r1" }, { parent: "x", route: "y" }), "今日");
  assert.equal(pd({ scheduledOn: "2026-11-01", routeId: "r1" }, { route: "y" }), "11 月 1 日");
});
test("previewDestination：列車優先於路線；名字缺時有後備字", () => {
  assert.equal(pd({ parentId: "t", routeId: "r1" }, { parent: "班次 A", route: "路線 B" }), "班次 A");
  assert.equal(pd({ parentId: "t" }), "列車");
  assert.equal(pd({ routeId: "r1" }), "路線");
});

/* ── isInboxTicket 補 ── */
test("isInboxTicket：status='done' 不算收件匣", () => {
  assert.equal(isInboxTicket({ ...ticket, status: "done" }), false);
  assert.equal(isInboxTicket({ ...ticket, status: "doing" }), true);
});
test("isInboxTicket：不是車票（列車）不算", () => {
  assert.equal(isInboxTicket({ ...ticket, kind: "train" }), false);
});

/* ── 票根：車次②四枚（0-11 加入日記） ── */
test("CAPTURE_STUBS：車次②四枚（含日記）", () => {
  assert.deepEqual([...CAPTURE_STUBS], ["inbox", "todo", "note", "diary"]);
  assert.equal(CAPTURE_STUBS.length, 4);
});
test("nextStub：預設四枚，正向輪替頭尾相接", () => {
  assert.equal(nextStub("inbox", 1), "todo");
  assert.equal(nextStub("todo", 1), "note");
  assert.equal(nextStub("note", 1), "diary");
  assert.equal(nextStub("diary", 1), "inbox");
});
test("nextStub：預設四枚，反向輪替頭尾相接", () => {
  assert.equal(nextStub("inbox", -1), "diary");
  assert.equal(nextStub("diary", -1), "note");
  assert.equal(nextStub("note", -1), "todo");
});
test("nextStub：不在清單裡的票根（已不通車的登記 id）從第一枚起算", () => {
  assert.equal(nextStub("ticket.gone", 1), "todo");
});
test("resolveDestination：日記票根不吃路線前綴（原文照留、不掛路線）", () => {
  assert.deepEqual(resolveDestination("diary", true), { target: "diary", withRoute: false, consumePrefix: false });
  assert.equal(STUB_LABEL.diary, "日記");
  assert.equal(STUB_HINT.diary, "記在今天");
});
test("票根文字：標籤與小字", () => {
  assert.equal(STUB_LABEL.inbox, "收件匣");
  assert.equal(STUB_HINT.todo, "排進今天");
  assert.equal(STUB_HINT.note, "存進筆記");
});

/* ── 票根：車次② 捕捉目的地註冊點（D-筆-36；假登記一枚） ── */
test("nextStub：內建四枚＋一枚登記的＝五枚輪替，頭尾相接", () => {
  const five: readonly CaptureStub[] = [...STUBS4, "timetable.time"];
  assert.equal(nextStub("diary", 1, five), "timetable.time");
  assert.equal(nextStub("timetable.time", 1, five), "inbox");
  assert.equal(nextStub("inbox", -1, five), "timetable.time");
  assert.equal(nextStub("timetable.time", -1, five), "diary");
});
test("isBuiltinStub：內建四枚是、登記的 id 不是", () => {
  for (const s of STUBS4) assert.equal(isBuiltinStub(s), true);
  assert.equal(isBuiltinStub("timetable.time"), false);
  assert.equal(isBuiltinStub(""), false);
});

/* ── 捕捉存檔的組合（store.saveCapture 用的同一條路） ── */
test("組合：收件匣＋路線前綴 ⇒ 筆記掛路線、內文吃掉前綴與空白", () => {
  const p = pr("CUM： 查 API 限額")!;
  const d = resolveDestination("inbox", !!p);
  const body = d.consumePrefix ? p.body : "CUM： 查 API 限額";
  assert.deepEqual([d.target, d.withRoute, body], ["note", true, "查 API 限額"]);
});
test("組合：待辦＋路線前綴＋多行 ⇒ 跳預覽、前綴不進清單", () => {
  const text = "NS：今天：\n・修按鈕\n・寫測試";
  const p = pr(text)!;
  const body = resolveDestination("todo", true).consumePrefix ? p.body : text;
  assert.equal(needsPreview("todo", body), true);
  assert.deepEqual(splitTodoLines(body).map((x) => x.text), ["今天：", "修按鈕", "寫測試"]);
  assert.equal(splitTodoLines(body)[0].checked, false);
});

/* ── stripBullet／firstLine／excerpt 補 ── */
test("stripBullet：# 標題回 hashHeading=true；七個井號不是標題", () => {
  assert.deepEqual(stripBullet("### 小標"), { text: "小標", hashHeading: true });
  assert.equal(stripBullet("####### x").hashHeading, false);
});
test("firstLine：跳過空行與只有符號的行、去 > 與 **", () => {
  assert.equal(firstLine("\n\n> **重點**在這"), "重點在這");
  assert.equal(firstLine(""), "");
});
test("excerpt：沒標題且只有一行 ⇒ 摘要為空", () => {
  assert.equal(excerpt({ title: null, body: "只有一行" }, 50), "");
});
test("matchesQuery：title 為 null 也能比內文", () => {
  assert.equal(matchesQuery({ title: null, body: "電池" }, "電池"), true);
});

/* ── 日期格式補 ── */
test("fmtMonthHeader：吃 YYYY-MM-DD 與 YYYY-MM 結果相同", () => {
  assert.equal(fmtMonthHeader("2026-01-31"), "2026 年 1 月");
  assert.equal(fmtMonthHeader("2026-01"), "2026 年 1 月");
});
test("fmtMonthDay：月日不補零", () => {
  assert.equal(fmtMonthDay("2026-01-09"), "1 月 9 日");
});

/* ═══ 車次②：日記與當天足跡（契約 §4.4） ═══ */

const seal = (o: Partial<FootprintSeal>): FootprintSeal => ({
  id: "s",
  nodeId: "n",
  name: "票",
  kind: "ticket",
  routeId: null,
  at: "2026-10-08T01:00:00.000Z",
  mood: null,
  dueOn: null,
  ...o,
});
const flog = (o: Partial<FootprintLog>): FootprintLog => ({
  id: "w",
  nodeId: "n",
  nodeName: "票",
  body: "手記",
  at: "2026-10-08T01:00:00.000Z",
  nodeMissing: false,
  ...o,
});
const fday = (o: Partial<FootprintDay>): FootprintDay => ({ day: "2026-10-08", seals: [], logs: [], moods: [], blocks: null, ...o });

test("clampDay：未來夾到今天、今天與過去不動", () => {
  assert.equal(clampDay("2026-10-11", "2026-10-10"), "2026-10-10");
  assert.equal(clampDay("2026-10-10", "2026-10-10"), "2026-10-10");
  assert.equal(clampDay("2026-09-30", "2026-10-10"), "2026-09-30");
});
test("isBackfilled：同日 false、不同日 true", () => {
  assert.equal(isBackfilled("2026-10-08", "2026-10-08"), false);
  assert.equal(isBackfilled("2026-10-05", "2026-10-08"), true);
});
test("entryWrittenLabel：當天寫＝寫於 HH:MM；補記＝寫於 M/D HH:MM（補記）", () => {
  assert.equal(entryWrittenLabel("2026-10-08", "2026-10-08", "09:12", "10/8"), "寫於 09:12");
  assert.equal(entryWrittenLabel("2026-10-02", "2026-10-05", "23:40", "10/5"), "寫於 10/5 23:40（補記）");
});
test("diaryEmptyText：今天／其他天", () => {
  assert.deepEqual(diaryEmptyText(true), { text: "今天還沒有寫日記", button: "寫日記" });
  assert.deepEqual(diaryEmptyText(false), { text: "這天沒有寫日記", button: "補記" });
});
test("diaryPlaceholder：今天／其他天", () => {
  assert.equal(diaryPlaceholder(true), "今天過得怎麼樣…");
  assert.equal(diaryPlaceholder(false), "那天發生了什麼…（翻翻足跡）");
});
test("diaryDraftMeta：今天的日記／補記 M 月 D 日", () => {
  assert.equal(diaryDraftMeta(true, "2026-10-10"), "今天的日記");
  assert.equal(diaryDraftMeta(false, "2026-10-02"), "補記 10 月 2 日");
});
test("diaryToast：三種 × 今天", () => {
  for (const k of ["capture", "convert", "draft"] as const) assert.equal(diaryToast(k, "2026-10-10", "2026-10-10"), "已記在今天的日記");
});
test("diaryToast：三種 × 非今天", () => {
  assert.equal(diaryToast("capture", "2026-10-05", "2026-10-10"), "已記成 10 月 5 日的日記");
  assert.equal(diaryToast("convert", "2026-10-05", "2026-10-10"), "已記成 10 月 5 日的日記");
  assert.equal(diaryToast("draft", "2026-10-05", "2026-10-10"), "已補記在 10 月 5 日");
});
test("groupFootprints：seals／logs 依 at 升冪", () => {
  const f = groupFootprints(
    "2026-10-08",
    [seal({ id: "b", nodeId: "b", at: "2026-10-08T05:00:00.000Z" }), seal({ id: "a", nodeId: "a", at: "2026-10-08T02:00:00.000Z" })],
    [flog({ id: "y", at: "2026-10-08T09:00:00.000Z" }), flog({ id: "x", at: "2026-10-08T03:00:00.000Z" })],
    null,
  );
  assert.deepEqual(f.seals.map((s) => s.id), ["a", "b"]);
  assert.deepEqual(f.logs.map((l) => l.id), ["x", "y"]);
  assert.equal(f.blocks, null);
});
test("groupFootprints：同 nodeId＋at 去重（退役定期券的邊角）", () => {
  const at = "2026-10-08T04:00:00.000Z";
  const f = groupFootprints("2026-10-08", [seal({ id: "n1", nodeId: "n1", at }), seal({ id: "o1", nodeId: "n1", at })], [], null);
  assert.equal(f.seals.length, 1);
});
test("groupFootprints：moods 只取非 null、依完成時刻", () => {
  const f = groupFootprints(
    "2026-10-08",
    [
      seal({ id: "c", nodeId: "c", at: "2026-10-08T06:00:00.000Z", mood: "red" }),
      seal({ id: "a", nodeId: "a", at: "2026-10-08T01:00:00.000Z", mood: "green" }),
      seal({ id: "b", nodeId: "b", at: "2026-10-08T03:00:00.000Z", mood: null }),
    ],
    [],
    null,
  );
  assert.deepEqual(f.moods, ["green", "red"]);
});
test("groupFootprints：不改輸入陣列", () => {
  const seals = [seal({ id: "b", nodeId: "b", at: "2026-10-08T05:00:00.000Z" }), seal({ id: "a", nodeId: "a", at: "2026-10-08T02:00:00.000Z" })];
  const before = seals.map((s) => s.id).join();
  groupFootprints("2026-10-08", seals, [], []);
  assert.equal(seals.map((s) => s.id).join(), before);
});
test("hasFootprint：null／全空 false；済章、手記、心情任一 true", () => {
  assert.equal(hasFootprint(null), false);
  assert.equal(hasFootprint(fday({})), false);
  assert.equal(hasFootprint(fday({ seals: [seal({})] })), true);
  assert.equal(hasFootprint(fday({ logs: [flog({})] })), true);
  assert.equal(hasFootprint(fday({ moods: ["yellow"] })), true);
});
test("hasFootprint：只有時間塊不算有足跡", () => {
  const block = { id: "b", label: "讀書", glyph: null, colorIdx: 0, from: "x", to: "y", running: false };
  assert.equal(hasFootprint(fday({ blocks: [block] })), false);
});
test("footprintSummary：済章＋手記／只有済章／沒有足跡", () => {
  assert.equal(footprintSummary(fday({ seals: [seal({}), seal({ id: "2", nodeId: "2" })], logs: [flog({})] })), "2 枚済章・1 則手記");
  assert.equal(footprintSummary(fday({ seals: [seal({})] })), "1 枚済章");
  assert.equal(footprintSummary(fday({})), "沒有足跡");
  assert.equal(footprintSummary(null), "沒有足跡");
});
test("footprintDayKeys：以 dayOf 模擬 06:00 日界線分桶、去重、升冪", () => {
  // UTC+8 的日界線 06:00：本地 10/9 05:30（＝UTC 10/8 21:30）仍算 10/8
  const dayOf = (iso: string) => {
    const local = new Date(Date.parse(iso) + 8 * 3600_000 - 6 * 3600_000);
    return local.toISOString().slice(0, 10);
  };
  const keys = footprintDayKeys(
    ["2026-10-08T21:30:00Z", "2026-10-08T23:00:00Z", "2026-10-07T03:00:00Z", "2026-10-08T21:31:00Z"],
    dayOf,
  );
  assert.deepEqual(keys, ["2026-10-07", "2026-10-08", "2026-10-09"]);
});
test("dayMark：有日記＞只有足跡＞空", () => {
  assert.equal(dayMark(2, true), "diary");
  assert.equal(dayMark(0, true), "fp");
  assert.equal(dayMark(0, false), "");
});
test("monthDays：閏年 2 月 29 天、31 天月", () => {
  const feb = monthDays("2028-02");
  assert.equal(feb.length, 29);
  assert.equal(feb[28], "2028-02-29");
  assert.equal(monthDays("2026-10").length, 31);
  assert.equal(monthDays("2026-10")[0], "2026-10-01");
});
test("addMonths：跨年前後", () => {
  assert.equal(addMonths("2026-12", 1), "2027-01");
  assert.equal(addMonths("2026-01", -1), "2025-12");
});
test("monthLeadBlanks：吃 weekStart（2026-10-01 是週四）", () => {
  assert.equal(monthLeadBlanks("2026-10", 1), 3); // 一二三 空
  assert.equal(monthLeadBlanks("2026-10", 0), 4); // 日一二三 空
  assert.equal(monthLeadBlanks("2026-11", 0), 0); // 11/1 是週日
  assert.equal(monthLeadBlanks("2026-06", 1), 0); // 6/1 是週一
});
test("weekdayHeads／weekdayOrder：週一起與週日起", () => {
  assert.equal(weekdayHeads(1).join(""), "一二三四五六日");
  assert.equal(weekdayHeads(0).join(""), "日一二三四五六");
  assert.deepEqual(weekdayOrder(1), [1, 2, 3, 4, 5, 6, 0]);
});
test("weekdayZh／fmtShortDay", () => {
  assert.equal(weekdayZh("2026-10-08"), "四");
  assert.equal(fmtShortDay("2026-10-05"), "10/5");
});
test("toDiaryHit：標題或第一行＋摘要", () => {
  const h = toDiaryHit({ id: "d1", entry_date: "2026-10-05", title: null, body: "第一行\n第二行" }, 20);
  assert.deepEqual(h, { id: "d1", day: "2026-10-05", title: "第一行", excerpt: "第二行" });
});

/* ═══ 車次②・足跡來源過濾（footprintSeals／footprintLogs＝SQLite §3.4 (a)(b)(c) 的同義過濾；mock 走這兩支） ═══ */

const W = { start: "2026-10-07T22:00:00.000Z", end: "2026-10-08T22:00:00.000Z" };
const node = (o: Partial<FootprintNodeSrc>): FootprintNodeSrc => ({
  id: "n1",
  name: "票",
  kind: "ticket",
  route_id: "r1",
  status: "done",
  completed_at: "2026-10-08T03:00:00.000Z",
  mood: null,
  deleted_at: null,
  ...o,
});
const occ = (o: Partial<FootprintOccSrc>): FootprintOccSrc => ({
  id: "o1",
  node_id: "n1",
  due_on: "2026-10-08",
  status: "done",
  completed_at: "2026-10-08T04:00:00.000Z",
  mood: null,
  deleted_at: null,
  ...o,
});
const wlog = (o: Partial<FootprintLogSrc>): FootprintLogSrc => ({
  id: "w1",
  node_id: "n1",
  body: "手記",
  logged_at: "2026-10-08T05:00:00.000Z",
  event: null,
  deleted_at: null,
  ...o,
});

test("footprintSeals (a)：只收 train／car／ticket、done、存活、完成時刻在視窗內", () => {
  const nodes = [
    node({ id: "t", kind: "train" }),
    node({ id: "c", kind: "car" }),
    node({ id: "k", kind: "ticket" }),
    node({ id: "r", kind: "route" }),
    node({ id: "s", kind: "station" }),
    node({ id: "todo", status: "todo", completed_at: null }),
    node({ id: "del", deleted_at: "2026-10-08T06:00:00.000Z" }),
  ];
  assert.deepEqual(footprintSeals(W, nodes, []).map((s) => s.id), ["t", "c", "k"]);
});
test("footprintSeals (a)：視窗是 [start, end)——start 算、end 不算", () => {
  const nodes = [node({ id: "a", completed_at: W.start }), node({ id: "b", completed_at: W.end })];
  assert.deepEqual(footprintSeals(W, nodes, []).map((s) => s.id), ["a"]);
});
test("footprintSeals (a)：欄位對應（nodeId＝自己、dueOn null、mood 讀 nodes.mood）", () => {
  const [s] = footprintSeals(W, [node({ id: "k", name: "寄信", route_id: "r9", mood: "yellow" })], []);
  assert.deepEqual(s, {
    id: "k",
    nodeId: "k",
    name: "寄信",
    kind: "ticket",
    routeId: "r9",
    at: "2026-10-08T03:00:00.000Z",
    mood: "yellow",
    dueOn: null,
  });
});
test("footprintSeals (b)：定期券班次 done 才算（運休不列）、mood 讀 occurrences.mood、帶 dueOn", () => {
  const rep = node({ id: "rep", status: "todo", completed_at: null, name: "背單字" });
  const seals = footprintSeals(W, [rep], [
    occ({ id: "o1", node_id: "rep", mood: "green" }),
    occ({ id: "o2", node_id: "rep", status: "skipped", completed_at: null }),
  ]);
  assert.equal(seals.length, 1);
  assert.deepEqual(
    [seals[0].id, seals[0].nodeId, seals[0].name, seals[0].mood, seals[0].dueOn],
    ["o1", "rep", "背單字", "green", "2026-10-08"],
  );
});
test("footprintSeals (b)：班次已刪、節點已刪、節點不在、補済落在別天 ⇒ 都不列", () => {
  const rep = node({ id: "rep", status: "todo", completed_at: null });
  const gone = node({ id: "gone", status: "todo", completed_at: null, deleted_at: "2026-10-08T06:00:00.000Z" });
  const seals = footprintSeals(W, [rep, gone], [
    occ({ id: "x1", node_id: "rep", deleted_at: "2026-10-08T07:00:00.000Z" }),
    occ({ id: "x2", node_id: "gone" }),
    occ({ id: "x3", node_id: "nowhere" }),
    occ({ id: "x4", node_id: "rep", due_on: "2026-10-08", completed_at: "2026-10-09T01:00:00.000Z" }),
  ]);
  assert.equal(seals.length, 0);
});
test("footprintSeals＋groupFootprints：退役定期券同時走 (a)(b) 且同一時刻 ⇒ 只留一枚（§8-4）", () => {
  const at = "2026-10-08T08:00:00.000Z";
  const retired = node({ id: "rep", status: "done", completed_at: at });
  const raw = footprintSeals(W, [retired], [occ({ id: "o9", node_id: "rep", completed_at: at })]);
  assert.equal(raw.length, 2);
  assert.equal(groupFootprints("2026-10-08", raw, [], null).seals.length, 1);
});
test("footprintLogs：只收手記（event null）、body 非空、存活、在視窗內", () => {
  const logs = [
    wlog({ id: "ok" }),
    wlog({ id: "ev1", event: "issued", body: "" }),
    wlog({ id: "ev2", event: "done", body: "" }),
    wlog({ id: "ev3", event: "conflict", body: "{}" }),
    wlog({ id: "empty", body: "" }),
    wlog({ id: "del", deleted_at: "2026-10-08T09:00:00.000Z" }),
    wlog({ id: "out", logged_at: W.end }),
  ];
  assert.deepEqual(footprintLogs(W, logs, [node({})]).map((l) => l.id), ["ok"]);
});
test("footprintLogs：節點已 soft delete ⇒ 不列；節點不在 ⇒ 列出且標「（原車票已刪除）」", () => {
  const nodes = [node({ id: "alive", name: "整理筆記" }), node({ id: "dead", deleted_at: "2026-10-08T06:00:00.000Z" })];
  const out = footprintLogs(
    W,
    [wlog({ id: "a", node_id: "alive" }), wlog({ id: "d", node_id: "dead" }), wlog({ id: "m", node_id: "missing" })],
    nodes,
  );
  assert.deepEqual(
    out.map((l) => [l.id, l.nodeName, l.nodeMissing]),
    [
      ["a", "整理筆記", false],
      ["m", MISSING_NODE_NAME, true],
    ],
  );
  assert.equal(MISSING_NODE_NAME, "（原車票已刪除）");
});
test("footprintSeals：以 dayWindow 模擬 06:00 日界線——本地 05:30 完成的算前一天", () => {
  const h = 6;
  const at = new Date(2026, 9, 9, 5, 30).toISOString(); // 本地 10/9 05:30
  const n = [node({ id: "late", completed_at: at })];
  assert.equal(footprintSeals(dayWindow("2026-10-08", h), n, []).length, 1);
  assert.equal(footprintSeals(dayWindow("2026-10-09", h), n, []).length, 0);
});

/* ═══ 車次④：摘要去符號、子孫 id、側板列、Ctrl+P 列（契約 §4.3／§4.4） ═══ */

test("stripMdLine：標題與引用、條列、粗體照舊", () => {
  assert.equal(stripMdLine("## 今天"), "今天");
  assert.equal(stripMdLine("> 引一句"), "引一句");
  assert.equal(stripMdLine("- **重點**"), "重點");
});

test("stripMdLine：*斜體*、行內程式碼、連結只留字", () => {
  assert.equal(stripMdLine("這是 *重要* 的"), "這是 重要 的");
  assert.equal(stripMdLine("跑 `pnpm dev` 看看"), "跑 pnpm dev 看看");
  assert.equal(stripMdLine("看 [說明](https://x.com/a) 吧"), "看 說明 吧");
});

test("stripMdLine：分隔線與圍欄標記行整行丟掉；星號落單與條列不受影響", () => {
  assert.equal(stripMdLine("---"), "");
  assert.equal(stripMdLine("***"), "");
  assert.equal(stripMdLine("```js"), "");
  assert.equal(stripMdLine("~~~"), "");
  assert.equal(stripMdLine("a * b * c"), "a * b * c");
});

test("excerpt／noteTitle：圍欄內的行照留、圍欄標記行不出現", () => {
  const body = "前言\n```\n# 註解\nlet a = 1\n```\n---\n後記";
  assert.equal(excerpt({ title: "T", body }, 99), "前言 # 註解 let a = 1 後記");
  assert.equal(noteTitle({ title: null, body: "```\n# 註解\n```" }), "# 註解");
});

test("NOTE_NODE_KINDS：路線／支線／列車／車廂，沒有車票", () => {
  assert.deepEqual([...NOTE_NODE_KINDS], ["route", "branch", "train", "car"]);
});

test("descendantIds：深度優先前序、不含自己、沒有子孫＝空", () => {
  const ch = { r: ["a", "b"], a: ["a1", "a2"], b: ["b1"] };
  assert.deepEqual(descendantIds(ch, "r"), ["a", "a1", "a2", "b", "b1"]);
  assert.deepEqual(descendantIds(ch, "a"), ["a1", "a2"]);
  assert.deepEqual(descendantIds(ch, "zzz"), []);
});

test("descendantIds：有環也不無限迴圈、自己不會出現在結果裡", () => {
  const ch = { a: ["b"], b: ["c"], c: ["a", "b"] };
  assert.deepEqual(descendantIds(ch, "a"), ["b", "c"]);
});

const noteItem = (over: Partial<NoteItemLike>): NoteItemLike => ({
  id: "n1", kind: "note", title: null, body: "標題行\n第二行內容", entry_date: null,
  noted_at: "2026-10-05T04:00:00.000Z", node_id: null, inbox: 0,
  created_at: "2026-10-05T04:00:00.000Z", updated_at: "2026-10-05T04:00:00.000Z", deleted_at: null,
  route_id: null, node_name: null, node_kind: null, ...over,
});

test("nodeNotesLine：直接掛的 where＝null；掛在底下的「› 節點名」", () => {
  const direct = nodeNotesLine(noteItem({ node_id: "t1", node_name: "第三列車", node_kind: "train" }), "t1");
  assert.deepEqual(direct, { title: "標題行", excerpt: "第二行內容", where: null });
  const sub = nodeNotesLine(noteItem({ node_id: "c1", node_name: "車廂甲", node_kind: "car" }), "t1");
  assert.equal(sub.where, "› 車廂甲");
});

test("nodeNotesLine：摘要最多 40 字加「…」；沒有 here 一律當直接掛的", () => {
  const long = noteItem({ title: "T", body: "字".repeat(60), node_id: "c1", node_name: "車廂甲" });
  const l = nodeNotesLine(long, null);
  assert.equal(l.excerpt, "字".repeat(40) + "…");
  assert.equal(l.where, null);
});

test("quickHitLabel：筆記＝標題＋「M/D・路線名」；掛在路線上用節點名、掛在底下用 routeName；沒掛只有日期", () => {
  const dayOf = (iso: string) => iso.slice(0, 10);
  const onRoute = quickHitLabel(noteItem({ title: "讀書", node_id: "r1", node_name: "日文", node_kind: "route", route_id: "r1" }), { dayOf });
  assert.deepEqual(onRoute, { label: "讀書", aside: "10/5・日文" });
  const onCar = quickHitLabel(noteItem({ title: "讀書", node_id: "c1", node_name: "車廂甲", node_kind: "car", route_id: "r1" }), {
    dayOf,
    routeName: (id) => (id === "r1" ? "日文" : null),
  });
  assert.equal(onCar.aside, "10/5・日文");
  assert.equal(quickHitLabel(noteItem({ title: "讀書" }), { dayOf }).aside, "10/5");
});

test("quickHitLabel：日記＝「M/D（週X）」＋摘要 24 字", () => {
  const d = noteItem({ kind: "diary", entry_date: "2026-10-05", title: null, body: "第一行\n" + "字".repeat(30) });
  const r = quickHitLabel(d);
  assert.equal(r.label, "10/5（週" + weekdayZh("2026-10-05") + "）");
  assert.equal(r.aside, "字".repeat(24) + "…");
});

/* ─── 車次④（資料層增補）：摘要去符號的邊角、預掛節點、篩選互斥 ─── */

test("stripMdLine：有序編號保留（摘要裡「1.」本來就是內容）；全形條列、引用裡的粗體一起去", () => {
  assert.equal(stripMdLine("1. 第一步"), "1. 第一步");
  assert.equal(stripMdLine("・ 項目"), "項目");
  assert.equal(stripMdLine("> **重點**在這"), "重點在這");
  assert.equal(stripMdLine("### 小標 #靈感"), "小標 #靈感");
});

test("stripMdLine：#荷札（沒空白）不當標題剝；空字串與空白行＝空", () => {
  assert.equal(stripMdLine("#靈感 先記下來"), "#靈感 先記下來");
  assert.equal(stripMdLine(""), "");
  assert.equal(stripMdLine("   "), "");
});

test("stripMdLine：連結的字帶星號、程式碼裡的星號與乘號各自的處理", () => {
  assert.equal(stripMdLine("[**字**](https://x.com)"), "字");
  assert.equal(stripMdLine("算式 3 * 4 * 5"), "算式 3 * 4 * 5");
  assert.equal(stripMdLine("`a * b`"), "a * b");
});

test("firstLine：跳過圍欄標記行與分隔線，取第一行有字的", () => {
  assert.equal(firstLine("---\n\n```\n## 註解\n```\n正文"), "## 註解");
  assert.equal(firstLine("***\n   \n- 第一項"), "第一項");
});

const REL_ROUTES = [
  { id: "r1", code: "A", name: "私鐵手帳" },
  { id: "r2", code: "B", name: "日文" },
];
const PRESET = { nodeId: "t1", routeId: "r1", label: "私鐵手帳 › 第三列車" };
const prefixOf = (routeId: string, body: string): RoutePrefix => {
  const route = REL_ROUTES.find((r) => r.id === routeId)!;
  return { route, routeId, prefixLen: 3, matched: route.name + "：", body };
};

test("applyCapturePreset：沒有預掛節點＝原樣", () => {
  const p = prefixOf("r1", "內文");
  assert.deepEqual(applyCapturePreset("note", p, "私鐵手帳：內文", null, REL_ROUTES), { prefix: p, nodeId: null });
  assert.deepEqual(applyCapturePreset("todo", null, "買牛奶", null, REL_ROUTES), { prefix: null, nodeId: null });
});

test("applyCapturePreset：筆記／收件匣票根掛在預掛節點；同路線的前綴照吃", () => {
  const same = prefixOf("r1", "內文");
  for (const stub of ["note", "inbox"]) {
    const r = applyCapturePreset(stub, same, "私鐵手帳：內文", PRESET, REL_ROUTES);
    assert.equal(r.nodeId, "t1", stub);
    assert.equal(r.prefix, same, stub);
  }
  assert.deepEqual(applyCapturePreset("note", null, "沒前綴", PRESET, REL_ROUTES), { prefix: null, nodeId: "t1" });
});

test("applyCapturePreset：別條路線的前綴當一般文字（prefix＝null）、仍掛預掛節點", () => {
  const other = prefixOf("r2", "內文");
  assert.deepEqual(applyCapturePreset("note", other, "日文：內文", PRESET, REL_ROUTES), { prefix: null, nodeId: "t1" });
  assert.deepEqual(applyCapturePreset("inbox", other, "日文：內文", PRESET, REL_ROUTES), { prefix: null, nodeId: "t1" });
});

test("applyCapturePreset：待辦票根不建進樹——只借預掛節點的路線當標籤（合成前綴、內文＝原字）", () => {
  const r = applyCapturePreset("todo", null, "  買牛奶", PRESET, REL_ROUTES);
  assert.equal(r.nodeId, null);
  assert.equal(r.prefix?.route.id, "r1");
  assert.equal(r.prefix?.routeId, "r1");
  assert.equal(r.prefix?.matched, "");
  assert.equal(r.prefix?.body, "買牛奶");
  // 同路線的前綴照吃；別條路線的前綴也被預掛的路線取代
  const same = prefixOf("r1", "內文");
  assert.equal(applyCapturePreset("todo", same, "x", PRESET, REL_ROUTES).prefix, same);
  assert.equal(applyCapturePreset("todo", prefixOf("r2", "內文"), "x", PRESET, REL_ROUTES).prefix?.route.id, "r1");
});

test("applyCapturePreset：預掛節點沒有路線或路線已不在＝待辦照舊；日記與別線票根不受影響", () => {
  assert.deepEqual(applyCapturePreset("todo", null, "x", { ...PRESET, routeId: null }, REL_ROUTES), { prefix: null, nodeId: null });
  assert.deepEqual(applyCapturePreset("todo", null, "x", { ...PRESET, routeId: "gone" }, REL_ROUTES), { prefix: null, nodeId: null });
  const p = prefixOf("r2", "內文");
  assert.deepEqual(applyCapturePreset("diary", p, "x", PRESET, REL_ROUTES), { prefix: p, nodeId: null });
  assert.deepEqual(applyCapturePreset("tt.some", p, "x", PRESET, REL_ROUTES), { prefix: p, nodeId: null });
});

test("exclusiveNodeFilter：只有一個＝原樣；兩個同時有，剛設的那個勝出（P5）", () => {
  const U1 = { id: "t1", ids: ["c1"], label: "第三列車" };
  const U2 = { id: "t2", ids: [], label: "第四列車" };
  const none = {} as { routeId?: string; underNode?: typeof U1 };
  // 單一條件：不動
  assert.deepEqual(exclusiveNodeFilter(none, { routeId: "r1" }), { routeId: "r1" });
  assert.deepEqual(exclusiveNodeFilter(none, { underNode: U1 }), { underNode: U1 });
  // 目前是 routeId，新設 underNode（兩個都有）⇒ underNode 勝、routeId 清掉
  assert.deepEqual(exclusiveNodeFilter({ routeId: "r1" }, { routeId: "r1", underNode: U1 }), { routeId: undefined, underNode: U1 });
  // 目前是 underNode，新設 routeId ⇒ routeId 勝、underNode 清掉
  assert.deepEqual(exclusiveNodeFilter({ underNode: U1 }, { underNode: U1, routeId: "r2" }), { underNode: undefined, routeId: "r2" });
  // 換一個 underNode（同時帶著舊 routeId）⇒ 新的 underNode 勝
  assert.deepEqual(exclusiveNodeFilter({ underNode: U1 }, { underNode: U2, routeId: "r1" }), { underNode: U2, routeId: undefined });
});

test("exclusiveNodeFilter：不丟掉其他欄位（搜尋字、分頁）", () => {
  const U = { id: "t1", ids: [], label: "x" };
  const r = exclusiveNodeFilter(
    { routeId: "r1", query: "a" } as { routeId?: string; underNode?: typeof U; query?: string },
    { routeId: "r1", underNode: U, query: "a" },
  );
  assert.equal(r.query, "a");
  assert.equal(r.routeId, undefined);
});

test("resolveLeaveText：store 與本地相同（自己剛存出去的字）⇒ 用本地", () => {
  const r = resolveLeaveText({ title: "t", body: "我的字 #a" }, { title: "t", body: "我的字 #a" }, false);
  assert.equal(r.remote, false);
  assert.equal(r.body, "我的字 #a");
});

test("resolveLeaveText：store 內文不同、沒有未送出的字 ⇒ 遠端贏（標題內文都換成 store 的）", () => {
  const r = resolveLeaveText({ title: "舊題", body: "B 的字 #b" }, { title: "新題", body: "A 的整份 #a" }, false);
  assert.deepEqual(r, { remote: true, title: "新題", body: "A 的整份 #a" });
  assert.equal(resolveLeaveText({ title: "x", body: "b" }, { title: null, body: "a" }, false).title, "");
});

test("resolveLeaveText：還有未送出的字 ⇒ 本地為準（即使 store 不同）", () => {
  const r = resolveLeaveText({ title: "", body: "本地" }, { title: null, body: "遠端" }, true);
  assert.equal(r.remote, false);
  assert.equal(r.body, "本地");
});

test("resolveLeaveText：讀不到 store 那一則 ⇒ 本地為準", () => {
  assert.equal(resolveLeaveText({ title: "", body: "x" }, undefined, false).remote, false);
  assert.equal(resolveLeaveText({ title: "", body: "x" }, null, false).body, "x");
});

test("resolveLeaveText：尾端空白與空標題不算不同（草稿建檔會 trim、空標題存 null）", () => {
  assert.equal(resolveLeaveText({ title: "  ", body: "abc \n\n" }, { title: null, body: "abc" }, false).remote, false);
  assert.equal(resolveLeaveText({ title: "", body: "abc" }, { title: "", body: "abc" }, false).remote, false);
});

test("resolveLeaveText：存檔失敗時 store 還是舊值（呼叫端把失敗記成 hasUnsent）⇒ 本地的字不被舊值換掉", () => {
  const r = resolveLeaveText({ title: "", body: "我剛打的字 #新荷札" }, { title: null, body: "舊內文" }, true);
  assert.equal(r.remote, false);
  assert.equal(r.body, "我剛打的字 #新荷札");
});

// ───────────────────────── 階段⑤ 捕捉小窗（契約 §4.6）─────────────────────────

test("captureWindowFromSearch：?window=capture 為真，容許其他參數與順序", () => {
  assert.equal(captureWindowFromSearch("?window=capture"), true);
  assert.equal(captureWindowFromSearch("?mock=1&window=capture"), true);
  assert.equal(captureWindowFromSearch("?window=capture&mock=1&page=notes"), true);
});

test("captureWindowFromSearch：不分大小寫，值前後空白不影響", () => {
  assert.equal(captureWindowFromSearch("?WINDOW=Capture"), true);
  assert.equal(captureWindowFromSearch("?window=%20capture%20"), true);
});

test("captureWindowFromSearch：沒有、別的值、前綴、空字串、壞字串都是假", () => {
  assert.equal(captureWindowFromSearch(""), false);
  assert.equal(captureWindowFromSearch("?mock=1"), false);
  assert.equal(captureWindowFromSearch("?window=main"), false);
  assert.equal(captureWindowFromSearch("?window=capture-x"), false);
  assert.equal(captureWindowFromSearch("?capture=window"), false);
  assert.equal(captureWindowFromSearch("?window"), false);
  assert.equal(captureWindowFromSearch("%E0%A4%A"), false);
});

test("shouldApplyAutostartDefault：打包版＋正式 identifier＋沒做過 ⇒ 真", () => {
  assert.equal(shouldApplyAutostartDefault(true, NS_PROD_IDENTIFIER, null), true);
  assert.equal(shouldApplyAutostartDefault(true, "app.shitetsu.nextstop", ""), true);
});

test("shouldApplyAutostartDefault：做過（旗標 \"1\"）⇒ 假", () => {
  assert.equal(shouldApplyAutostartDefault(true, NS_PROD_IDENTIFIER, "1"), false);
});

test("shouldApplyAutostartDefault：dev／沙盒（非打包版或 identifier 不同）永遠假——不能動使用者真實的開機項目", () => {
  assert.equal(shouldApplyAutostartDefault(false, NS_PROD_IDENTIFIER, null), false);
  assert.equal(shouldApplyAutostartDefault(true, "app.shitetsu.nextstop.dev.notes", null), false);
  assert.equal(shouldApplyAutostartDefault(true, "app.shitetsu.nextstop.sandbox.a", null), false);
  assert.equal(shouldApplyAutostartDefault(true, "", null), false);
});

const ROOT_5 = resolve(import.meta.dirname, "../..");

/** 取 Rust 的 `pub const NAME: &str = "..."`（含 `#[allow(...)]` 在前面的）字串值 */
function rustConst(rs: string, name: string): string | null {
  const m = new RegExp(`pub const ${name}: &str = "([^"]*)"`).exec(rs);
  return m ? m[1] : null;
}
/** 取 TS 的 `export const NAME = "..."` 字串值 */
function tsConst(ts: string, name: string): string | null {
  const m = new RegExp(`export const ${name} = "([^"]*)"`).exec(ts);
  return m ? m[1] : null;
}

test("對帳：capture.rs 與 shell.ts 的視窗 label／事件名逐字相同（規則 1-9）", () => {
  const rs = readFileSync(resolve(ROOT_5, "src-tauri/src/capture.rs"), "utf8");
  const ts = readFileSync(resolve(ROOT_5, "src/ui/notes/capture-window/shell.ts"), "utf8");
  assert.equal(rustConst(rs, "CAPTURE_WINDOW"), "capture");
  assert.equal(tsConst(ts, "CAPTURE_WINDOW"), "capture");
  assert.equal(rustConst(rs, "EV_CAPTURE_SHOW"), "notes:capture-show");
  assert.equal(tsConst(ts, "EV_CAPTURE_SHOW"), "notes:capture-show");
  assert.equal(rustConst(rs, "TRAY_MENU_ID"), "notes:capture");
  assert.equal(rustConst(rs, "MINIMIZED_ARG"), "--minimized");
  // 小窗存檔事件只有 JS 兩側用（Rust 不 emit）
  assert.equal(tsConst(ts, "EV_CAPTURED"), "notes:captured");
});

test("對帳：shell.ts 的 command 名都在 capture.rs 的 #[tauri::command] 函式裡，也都在 lib.rs 的 invoke_handler", () => {
  const rs = readFileSync(resolve(ROOT_5, "src-tauri/src/capture.rs"), "utf8");
  const ts = readFileSync(resolve(ROOT_5, "src/ui/notes/capture-window/shell.ts"), "utf8");
  const lib = readFileSync(resolve(ROOT_5, "src-tauri/src/lib.rs"), "utf8");
  for (const cmd of ["capture_hide", "capture_fit", "capture_status", "autostart_get", "autostart_set"]) {
    assert.ok(ts.includes(`"${cmd}"`), `shell.ts 要有 "${cmd}"`);
    assert.ok(new RegExp(String.raw`#\[tauri::command\]\s*pub (async )?fn ${cmd}\b`).test(rs), `capture.rs 要有 command ${cmd}`);
    assert.ok(lib.includes(`capture::${cmd},`), `lib.rs 的 invoke_handler 要有 capture::${cmd}`);
  }
});

test("對帳：lib.rs 手機那份 invoke_handler 不含 capture（手機不編 capture mod）", () => {
  const lib = readFileSync(resolve(ROOT_5, "src-tauri/src/lib.rs"), "utf8");
  const m = /#\[cfg\(mobile\)\]\s*let builder = builder\.invoke_handler/.exec(lib);
  const at = m ? m.index : -1;
  assert.ok(at >= 0, "找得到手機的 invoke_handler");
  const block = lib.slice(at, lib.indexOf("]);", at));
  assert.ok(!block.includes("capture::"));
});

test("對帳：capture::setup 會自己建小窗（conf 的 capture 是 create:false，沒人建就永遠沒有小窗）", () => {
  const rs = readFileSync(resolve(ROOT_5, "src-tauri/src/capture.rs"), "utf8");
  assert.ok(/fn build_capture_window\b/.test(rs), "要有 build_capture_window");
  const setupAt = rs.indexOf("pub fn setup<");
  const setupBody = rs.slice(setupAt, rs.indexOf("\n}\n", setupAt));
  assert.ok(setupBody.includes("build_capture_window(app)"), "setup 要叫 build_capture_window");
  // 硬條件：顯示主視窗（show_main_window）在建小窗之前
  assert.ok(setupBody.indexOf("show_main_window") < setupBody.indexOf("build_capture_window"));
  // 啟動參數用 args_os：args() 遇到非 Unicode 參數會 panic，而這是「絕不讓主視窗留在隱藏」的那一句
  assert.ok(setupBody.includes("std::env::args_os()") && !setupBody.includes("std::env::args()"));
});

test("對帳：tauri.conf.json 有 main（visible:false）與 capture（置頂、不上工作列、visible:false）兩個視窗", () => {
  const conf = JSON.parse(readFileSync(resolve(ROOT_5, "src-tauri/tauri.conf.json"), "utf8"));
  const [main, capture] = conf.app.windows;
  assert.equal(main.label, "main");
  assert.equal(main.visible, false);
  assert.notEqual(main.create, false); // 主視窗一定由 tauri 自己建
  assert.equal(capture.label, "capture");
  assert.equal(capture.visible, false);
  // create:false：Android 共用這份 conf，tauri 照 conf 建第二個視窗會把主畫面換成捕捉頁；桌機由 capture::setup 自己建
  assert.equal(capture.create, false);
  assert.equal(capture.alwaysOnTop, true);
  assert.equal(capture.skipTaskbar, true);
  assert.equal(capture.decorations, false);
  const cap = JSON.parse(readFileSync(resolve(ROOT_5, "src-tauri/capabilities/capture.json"), "utf8"));
  assert.deepEqual(cap.windows, ["capture"]);
  const def = JSON.parse(readFileSync(resolve(ROOT_5, "src-tauri/capabilities/default.json"), "utf8"));
  assert.deepEqual(def.windows, ["main"]);
});

test("對帳：Rust STAMP_GUARD 必須大於前端 CAPTURE_STAMP_MS（章調長時兩邊要一起調，否則章會被提早收掉）", () => {
  const rs = readFileSync(resolve(ROOT_5, "src-tauri/src/capture.rs"), "utf8");
  const ts = readFileSync(resolve(ROOT_5, "src/ui/notes/capture-window/shell.ts"), "utf8");
  const guard = /const STAMP_GUARD: Duration = Duration::from_millis\((\d+)\);/.exec(rs);
  const stamp = /export const CAPTURE_STAMP_MS = (\d+);/.exec(ts);
  assert.ok(guard, "capture.rs 要有 STAMP_GUARD 常數");
  assert.ok(stamp, "shell.ts 要有 CAPTURE_STAMP_MS 常數");
  assert.ok(Number(guard[1]) > Number(stamp[1]), `STAMP_GUARD(${guard[1]}) 要大於 CAPTURE_STAMP_MS(${stamp[1]})`);
});

test("對帳：熱鍵字樣只有 capture.rs 的 HOTKEY_ACCEL 一份，shell.ts 不再抄第二份（鍵帽走 capsOf(HOTKEY_ID)）", () => {
  const rs = readFileSync(resolve(ROOT_5, "src-tauri/src/capture.rs"), "utf8");
  const ts = readFileSync(resolve(ROOT_5, "src/ui/notes/capture-window/shell.ts"), "utf8");
  const accel = rustConst(rs, "HOTKEY_ACCEL");
  assert.ok(accel, "capture.rs 要有 HOTKEY_ACCEL");
  assert.ok(!ts.includes(accel), `shell.ts 不該有 "${accel}" 字面`);
});

test("對帳：小窗 css 把 Toast 排進票下面靠的選擇器（.ns-card[role=status]）在 Toast.tsx 還對得上", () => {
  const css = readFileSync(resolve(ROOT_5, "src/ui/notes/capture-window/capture-window.css"), "utf8");
  const toast = readFileSync(resolve(ROOT_5, "src/ui/common/Toast.tsx"), "utf8");
  assert.ok(css.includes('.ns-card[role="status"]'));
  assert.ok(toast.includes('role="status"') && /className="ns-card\b/.test(toast), "Toast.tsx 要有 role=status 與 ns-card");
});

/* ═══ 階段⑤ 小窗前端（契約 §4.3／§0-0 D-筆-61／0-15）═══ */

const OPEN_C = { capture: true, preview: false };
const OPEN_P = { capture: false, preview: true };
const CLOSED = { capture: false, preview: false };

test("captureWindowTransition：存檔飛行中收起＝saved（捕捉票、預覽框建立都算）", () => {
  assert.equal(captureWindowTransition(OPEN_C, CLOSED, true), "saved");
  assert.equal(captureWindowTransition(OPEN_P, CLOSED, true), "saved");
});

test("captureWindowTransition：不是存檔收的＝esc（Esc 放棄、預覽框取消）", () => {
  assert.equal(captureWindowTransition(OPEN_C, CLOSED, false), "esc");
  assert.equal(captureWindowTransition(OPEN_P, CLOSED, false), "esc");
});

test("captureWindowTransition：沒收起就不動（剛開、票換成預覽框、還開著、本來就關著）", () => {
  assert.equal(captureWindowTransition(CLOSED, OPEN_C, false), null);
  assert.equal(captureWindowTransition(OPEN_C, OPEN_P, true), null); // 多行待辦：存檔換成預覽框，小窗長高不收
  assert.equal(captureWindowTransition(OPEN_C, OPEN_C, true), null);
  assert.equal(captureWindowTransition(CLOSED, CLOSED, true), null);
});

const NO_PV = null;
const cap = (text: string, stub = "inbox") => ({ capture: { text, stub }, preview: NO_PV });

test("captureWindowReleaseEarly：有字的捕捉票存檔＝馬上還前景（D-筆-61：Enter 後立刻打的字不能掉）", () => {
  assert.equal(captureWindowReleaseEarly(cap("買牛奶"), "save"), true);
  assert.equal(captureWindowReleaseEarly(cap("買牛奶", "todo"), "save"), true); // 單行待辦直接建票
  assert.equal(captureWindowReleaseEarly(cap("甲\n乙", "note"), "save"), true); // 非待辦票根的多行照存
  assert.equal(captureWindowReleaseEarly(cap("今天：寫報告", "diary"), "save"), true);
});

test("captureWindowReleaseEarly：不會寫入的情況不還（空字、多行待辦轉預覽框、沒有票）", () => {
  assert.equal(captureWindowReleaseEarly(cap("   \n "), "save"), false);
  assert.equal(captureWindowReleaseEarly(cap("甲\n乙", "todo"), "save"), false); // 小窗要留著給人挑哪幾行
  assert.equal(captureWindowReleaseEarly({ capture: null, preview: NO_PV }, "save"), false);
});

test("captureWindowReleaseEarly：預覽框確定——單筆、或至少勾了一行才還", () => {
  const lines = (...c: boolean[]) => c.map((checked) => ({ checked }));
  assert.equal(captureWindowReleaseEarly({ capture: null, preview: { single: true, lines: lines() } }, "confirm"), true);
  assert.equal(captureWindowReleaseEarly({ capture: null, preview: { single: false, lines: lines(false, true) } }, "confirm"), true);
  assert.equal(captureWindowReleaseEarly({ capture: null, preview: { single: false, lines: lines(false, false) } }, "confirm"), false);
  assert.equal(captureWindowReleaseEarly({ capture: null, preview: NO_PV }, "confirm"), false);
});

test("對帳：shell.ts 的收法含 revive，Rust HideMode 有對應變體", () => {
  const rs = readFileSync(resolve(ROOT_5, "src-tauri/src/capture.rs"), "utf8");
  const ts = readFileSync(resolve(ROOT_5, "src/ui/notes/capture-window/shell.ts"), "utf8");
  assert.ok(/export type CaptureHideMode = [^;]*"revive"/.test(ts));
  assert.ok(/pub enum HideMode \{[^}]*Revive/.test(rs));
});

test("captureWindowToastText：plugin-sql 的 not loaded 換成「主視窗還在啟動」，其餘照原文", () => {
  assert.equal(captureWindowToastText("database sqlite:next-stop-v2.db not loaded"), CAPTURE_DB_NOT_READY);
  assert.equal(captureWindowToastText("Database NOT  LOADED"), CAPTURE_DB_NOT_READY);
  assert.equal(captureWindowToastText("error returned from database: UNIQUE constraint failed"), null);
  assert.equal(captureWindowToastText("存檔失敗——請再試一次"), null);
});

function fakeAutostart(over: Partial<{ isProd: boolean; available: boolean; enabled: boolean; name: string; debugBuild: boolean; flag: string | null; enableFails: boolean; getFails: boolean }> = {}) {
  const o = { isProd: true, available: true, enabled: false, name: NS_PROD_IDENTIFIER, debugBuild: false, flag: null as string | null, enableFails: false, getFails: false, ...over };
  const log: string[] = [];
  const deps: AutostartDefaultDeps = {
    isProd: o.isProd,
    async get() {
      if (o.getFails) throw new Error("bridge down");
      return { available: o.available, enabled: o.enabled, name: o.name, debugBuild: o.debugBuild };
    },
    async enable() {
      log.push("enable");
      if (o.enableFails) throw new Error("拒絕存取");
    },
    async readFlag() {
      return o.flag;
    },
    async writeFlag() {
      log.push("flag");
    },
  };
  return { deps, log };
}

test("autostartDefaultOnce：正式版第一次 ⇒ enable 再寫旗標", async () => {
  const { deps, log } = fakeAutostart();
  assert.deepEqual(await autostartDefaultOnce(deps), { kind: "enabled" });
  assert.deepEqual(log, ["enable", "flag"]);
});

test("autostartDefaultOnce：enable 失敗也寫旗標（只做一次），回 failed 讓呼叫端 toast", async () => {
  const { deps, log } = fakeAutostart({ enableFails: true });
  assert.deepEqual(await autostartDefaultOnce(deps), { kind: "failed", error: "拒絕存取" });
  assert.deepEqual(log, ["enable", "flag"]);
});

test("autostartDefaultOnce：已經開著 ⇒ 不再 enable、只補旗標", async () => {
  const { deps, log } = fakeAutostart({ enabled: true });
  assert.deepEqual(await autostartDefaultOnce(deps), { kind: "already" });
  assert.deepEqual(log, ["flag"]);
});

test("autostartDefaultOnce：做過、dev、沙盒 identifier、正式 identifier 的 debug exe、外掛沒掛、橋接壞掉 ⇒ 什麼都不碰（旗標也不寫）", async () => {
  for (const over of [
    { flag: "1" },
    { isProd: false },
    { name: "app.shitetsu.nextstop.sandbox.a" },
    { debugBuild: true }, // 沙盒流程換回正式 identifier 的 debug exe：與安裝版共用 Run 值名，不能去改它
    { available: false },
    { getFails: true },
  ]) {
    const { deps, log } = fakeAutostart(over);
    assert.deepEqual(await autostartDefaultOnce(deps), { kind: "skipped" }, JSON.stringify(over));
    assert.deepEqual(log, [], JSON.stringify(over));
  }
});

/* ═══ 手機分享進收件匣：createShareDrainer（⑤ 手機沙盒 M7） ═══ */

/** 假的 Kotlin 佇列＋收件匣；`gate` 讓測試決定 create 什麼時候完成（模擬「收到一半又被敲門」） */
function fakeShare(initial: SharedItemLike[] = []) {
  const queue: SharedItemLike[] = [...initial];
  const inbox: string[] = [];
  const toasts: number[] = [];
  const errors: unknown[] = [];
  let takes = 0;
  let gate: Promise<void> | null = null;
  const deps = {
    take: async () => {
      takes++;
      return [...queue];
    },
    create: async (body: string) => {
      if (gate) await gate;
      inbox.push(body);
    },
    ack: async (ids: string[]) => {
      for (const id of ids) {
        const i = queue.findIndex((q) => q.id === id);
        if (i >= 0) queue.splice(i, 1);
      }
    },
    after: (count: number) => {
      toasts.push(count);
    },
    onError: (e: unknown) => {
      errors.push(e);
    },
  };
  return {
    deps,
    queue,
    inbox,
    toasts,
    errors,
    get takes() {
      return takes;
    },
    hold() {
      let release!: () => void;
      gate = new Promise<void>((r) => (release = r));
      return () => {
        gate = null;
        release();
      };
    },
  };
}

test("shareBody：標題不在內文裡 ⇒ 第一行標題；在內文裡或沒有 ⇒ 只放內文", () => {
  assert.equal(shareBody({ id: "1", text: " 內文 ", subject: "標題" }), "標題\n內文");
  assert.equal(shareBody({ id: "1", text: "標題 與內文", subject: "標題" }), "標題 與內文");
  assert.equal(shareBody({ id: "1", text: "內文", subject: "  " }), "內文");
  assert.equal(shareBody({ id: "1", text: "內文" }), "內文");
});

test("shareToastText：一則／多則", () => {
  assert.equal(shareToastText(1), "收到分享，放進收件匣了");
  assert.equal(shareToastText(3), "收到 3 則分享，放進收件匣了");
});

test("createShareDrainer：收一則 ⇒ 進收件匣、ack、提示一次", async () => {
  const f = fakeShare([{ id: "a", text: "第一則" }]);
  await createShareDrainer(f.deps)();
  assert.deepEqual(f.inbox, ["第一則"]);
  assert.equal(f.queue.length, 0);
  assert.deepEqual(f.toasts, [1]);
});

test("createShareDrainer：佇列空 ⇒ 不提示", async () => {
  const f = fakeShare();
  await createShareDrainer(f.deps)();
  assert.deepEqual(f.toasts, []);
  assert.equal(f.takes, 1);
});

test("createShareDrainer：收到一半又被敲門（M7）⇒ 這輪收完再取一次，第二則不用等下次回前景", async () => {
  const f = fakeShare([{ id: "a", text: "第一則" }]);
  const drain = createShareDrainer(f.deps);
  const release = f.hold();
  const first = drain();
  // 第一則還卡在 create 時，第二則進佇列、事件敲門
  f.queue.push({ id: "b", text: "第二則" });
  await drain();
  release();
  await first;
  assert.deepEqual(f.inbox, ["第一則", "第二則"]);
  assert.equal(f.queue.length, 0);
  assert.deepEqual(f.toasts, [2], "整輪只提示一次、合計則數");
});

test("createShareDrainer：敲門好幾次也只多取一輪", async () => {
  const f = fakeShare([{ id: "a", text: "一" }]);
  const drain = createShareDrainer(f.deps);
  const release = f.hold();
  const first = drain();
  f.queue.push({ id: "b", text: "二" });
  await drain();
  await drain();
  await drain();
  release();
  await first;
  assert.deepEqual(f.inbox, ["一", "二"]);
  assert.equal(f.takes, 2, "第一輪＋一次重取（重取那輪沒人再敲門就停）");
});

test("createShareDrainer：create 失敗 ⇒ 不 ack（下次再取不丟字）、記錯、不提示；之後可再跑", async () => {
  const f = fakeShare([{ id: "a", text: "一" }]);
  let fail = true;
  const deps = {
    ...f.deps,
    create: async (body: string) => {
      if (fail) throw new Error("db");
      f.inbox.push(body);
    },
  };
  const drain = createShareDrainer(deps);
  await drain();
  assert.equal(f.queue.length, 1);
  assert.equal(f.errors.length, 1);
  assert.deepEqual(f.toasts, []);
  fail = false;
  await drain();
  assert.deepEqual(f.inbox, ["一"]);
  assert.deepEqual(f.toasts, [1]);
});

test("createShareDrainer：第一批成功、重取那批失敗 ⇒ 已收的照樣提示", async () => {
  const f = fakeShare([{ id: "a", text: "一" }]);
  let calls = 0;
  const deps = {
    ...f.deps,
    take: async () => {
      calls++;
      if (calls === 2) throw new Error("bridge");
      return [...f.queue];
    },
  };
  const drain = createShareDrainer(deps);
  const release = f.hold();
  const first = drain();
  await drain();
  release();
  await first;
  assert.deepEqual(f.inbox, ["一"]);
  assert.equal(f.errors.length, 1);
  assert.deepEqual(f.toasts, [1]);
});

test("createShareDrainer：空內文（只有空白）不建筆記但照樣 ack", async () => {
  const f = fakeShare([{ id: "a", text: "   " }]);
  await createShareDrainer(f.deps)();
  assert.deepEqual(f.inbox, []);
  assert.equal(f.queue.length, 0);
  assert.deepEqual(f.toasts, [1]);
});
