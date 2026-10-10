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
  type CaptureStub,
  type RouteLike,
} from "../../src/domain/notes.ts";
import { addDays } from "../../src/lib/date.ts";

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

/* ── 票根：車次①三枚 ── */
test("CAPTURE_STUBS：車次①只有三枚（日記在車次②）", () => {
  assert.deepEqual([...CAPTURE_STUBS], ["inbox", "todo", "note"]);
});
test("nextStub：預設三枚，正向輪替頭尾相接", () => {
  assert.equal(nextStub("inbox", 1), "todo");
  assert.equal(nextStub("todo", 1), "note");
  assert.equal(nextStub("note", 1), "inbox");
});
test("nextStub：預設三枚，反向輪替頭尾相接", () => {
  assert.equal(nextStub("inbox", -1), "note");
  assert.equal(nextStub("note", -1), "todo");
});
test("nextStub：不在清單裡的票根（diary）從第一枚起算", () => {
  assert.equal(nextStub("diary", 1), "todo");
});
test("票根文字：標籤與小字", () => {
  assert.equal(STUB_LABEL.inbox, "收件匣");
  assert.equal(STUB_HINT.todo, "排進今天");
  assert.equal(STUB_HINT.note, "存進筆記");
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
