// 旅客筆記・純函式單元測試（車次①契約 §4.4）
// 跑法：node --test scripts/tests/notes-logic.test.ts（node 24 直接剝除型別；不進 tsc——tsconfig 只 include src）
//
// 前 48 項＝原型 prototypes/旅客筆記-src/smoke.mjs 的邏輯斷言逐條移植（mdToHtml 兩項改成 plainParagraphs；
// 日期那一項換成本線實際有的 fmtMonthDay／fmtMonthHeader／monthKey＋lib/date 的 addDays）；
// 之後是車次①新增：D-筆-25 冒號後空白、escapeLike、支線視同路線、isInboxTicket 的 done、三枚票根輪替等。
import { test } from "node:test";
import assert from "node:assert/strict";
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
  type CaptureStub,
  type FootprintDay,
  type FootprintLog,
  type FootprintLogSrc,
  type FootprintNodeSrc,
  type FootprintOccSrc,
  type FootprintSeal,
  type RouteLike,
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
  assert.equal(diaryPlaceholder(false), "那天發生了什麼…（旁邊的足跡可以翻）");
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
