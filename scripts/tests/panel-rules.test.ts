// 詳情面板純規則單元測試（手機殼班 D-主-82：桌機側板與手機詳情頁同一份；src/ui/panel/panelRules.ts）
// 跑法：node --test scripts/tests/panel-rules.test.ts（node 24 直接剝除型別；不進 tsc——tsconfig 只 include src）
// panelRules.ts 只 import type＋domain/repeat.ts、domain/node.ts；repeat.ts 的 `../lib/date` 沒寫副檔名 ⇒ 用 registerHooks 補 .ts（同 core-polish7.test.ts）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    const fromSrc = context.parentURL !== undefined && context.parentURL.includes("/src/");
    if (fromSrc && specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) {
      try {
        return nextResolve(specifier + ".ts", context);
      } catch {
        return nextResolve(specifier + "/index.ts", context);
      }
    }
    return nextResolve(specifier, context);
  },
});

// 靜態 import 會在 registerHooks 之前就被載入，所以一律動態 import
const P = await import("../../src/ui/panel/panelRules.ts");
const { serializeRule, fixedRule, afterRule } = await import("../../src/domain/repeat.ts");

const TODAY = "2026-10-25"; // 週日
const base = { repeat_rule: null as string | null, scheduled_on: null as string | null };

test("draftOf：沒規則＝不重複；起算日 執行日＞今天", () => {
  assert.deepEqual(P.draftOf(base, TODAY), {
    mode: "none",
    freq: "daily",
    byweekday: [],
    monthday: null,
    days: null,
    start: TODAY,
    interval: 1,
    endMode: "none",
    until: null,
    count: null,
  });
  assert.equal(P.draftOf({ ...base, scheduled_on: "2026-10-28" }, TODAY).start, "2026-10-28");
});

test("draftOf：legacy 自由文字＝乘車券（只認 parseRule）", () => {
  assert.equal(P.draftOf({ ...base, repeat_rule: "每週一" }, TODAY).mode, "none");
});

test("draftOf ⇄ buildRule 來回不變（每週／每月／完成後）", () => {
  for (const rule of [
    fixedRule("weekly", "2026-10-20", { byweekday: [1, 3] }),
    fixedRule("monthly", "2026-10-20", { bymonthday: [15] }),
    fixedRule("daily", "2026-10-20"),
    afterRule(3, "2026-10-20"),
  ]) {
    const d = P.draftOf({ ...base, repeat_rule: serializeRule(rule) }, TODAY);
    assert.deepEqual(P.buildRule(d), rule);
  }
});

test("buildRule：不完整的規則不送（回 null）", () => {
  const d = P.draftOf(base, TODAY);
  assert.equal(P.buildRule({ ...d, mode: "fixed", freq: "weekly", byweekday: [] }), null);
  assert.equal(P.buildRule({ ...d, mode: "fixed", freq: "monthly", monthday: null }), null);
  assert.equal(P.buildRule({ ...d, mode: "after", days: null }), null);
  assert.equal(P.missingHint({ ...d, mode: "fixed", freq: "weekly", byweekday: [] }), "選一個星期");
});

test("票種轉換：切定期券＝固定排程（桌機預設頻率每日、一點就是完整規則）；切回＝不重複", () => {
  const d = P.draftOf({ ...base, scheduled_on: "2026-10-26" }, TODAY);
  const teiki = P.switchFare(d, true);
  assert.equal(teiki.mode, "fixed");
  assert.deepEqual(P.buildRule(teiki), fixedRule("daily", "2026-10-26"));
  assert.equal(P.switchFare(teiki, false).mode, "none");
  // 已經是完成後間隔：切「定期券」不動模式
  const after = P.switchMode(d, "after");
  assert.equal(after.days, 1);
  assert.equal(P.switchFare(after, true).mode, "after");
});

test("fillFixed：每週預帶起算日的星期、每月預帶號數", () => {
  const d = P.draftOf({ ...base, scheduled_on: "2026-10-28" }, TODAY); // 週三
  assert.deepEqual(P.fillFixed({ ...d, mode: "fixed", freq: "weekly" }).byweekday, [3]);
  assert.equal(P.fillFixed({ ...d, mode: "fixed", freq: "monthly" }).monthday, 28);
});

test("toggleWeekday：最後一顆不給熄（原樣回傳同一個陣列＝呼叫端認得出沒變）；新增排序", () => {
  const only = [3];
  assert.equal(P.toggleWeekday(only, 3), only);
  assert.notEqual(P.toggleWeekday([1, 3], 3), only);
  assert.deepEqual(P.toggleWeekday([3], 1), [1, 3]);
  assert.deepEqual(P.toggleWeekday([1, 3], 1), [3]);
});

test("repeatAside：完整＝一句話；不完整且庫裡有舊規則＝仍照舊規則發車", () => {
  const saved = serializeRule(fixedRule("daily", "2026-10-20"));
  const d = P.draftOf({ ...base, repeat_rule: saved }, TODAY);
  assert.equal(P.repeatAside(d, saved), "每天重複");
  assert.equal(
    P.repeatAside({ ...d, freq: "weekly", byweekday: [] }, saved),
    "仍照「每天重複」發車——選一個星期後生效",
  );
  assert.equal(P.repeatAside(P.draftOf(base, TODAY), null), "不重複");
});

test("mdwText：10/26（週一）", () => {
  assert.equal(P.mdwText("2026-10-26"), "10/26（週一）");
});

/* 三、現況／検印 */
const weekly = serializeRule(fixedRule("weekly", "2026-10-04", { byweekday: [1, 3, 5] }));

test("statusChoices：活著的定期券不給「已完成」＋指路；退役的與一般票四格全給", () => {
  const live = P.statusChoices({ repeat_rule: weekly, status: "todo" });
  assert.deepEqual(live.options.map((o) => o.value), ["todo", "doing", "paused"]);
  assert.equal(live.note, "定期券：在検印欄蓋班次");
  const retired = P.statusChoices({ repeat_rule: weekly, status: "done" });
  assert.equal(retired.options.length, 4);
  assert.equal(retired.note, null);
  // legacy 自由文字規則＝乘車券（只認 parseRule）
  assert.equal(P.statusChoices({ repeat_rule: "每天早上", status: "todo" }).options.length, 4);
});

test("stampViewOf：車票＝済章；列車／車廂不畫（用現況）；定期券＝本班済／運休，本班日＝班次 due_on ＞ scheduled_on", () => {
  const ticket = { kind: "ticket" as const, repeat_rule: null, status: "todo" as const, scheduled_on: "2026-10-25" };
  assert.deepEqual(P.stampViewOf(ticket, undefined), {
    mode: "plain", done: false, suspended: false, railDate: null, meta: "點一下蓋章", action: "蓋章完成", retiredNote: null,
  });
  assert.equal(P.stampViewOf({ ...ticket, status: "done" }, undefined).meta, "已完成");
  assert.equal(P.stampViewOf({ ...ticket, kind: "train" }, undefined).mode, "none");

  const teiki = { ...ticket, repeat_rule: weekly, scheduled_on: "2026-10-26" };
  const fresh = P.stampViewOf(teiki, undefined);
  assert.equal(fresh.mode, "teiki");
  assert.equal(fresh.railDate, "2026-10-26");
  assert.equal(fresh.meta, "點一下蓋本班");
  const done = P.stampViewOf(teiki, { id: "o", due_on: "2026-10-23", status: "done" });
  assert.deepEqual([done.done, done.suspended, done.railDate, done.meta], [true, false, "2026-10-23", "本班已済"]);
  const susp = P.stampViewOf({ ...teiki, kind: "train" }, { id: "o", due_on: "2026-10-23", status: "skipped" });
  assert.deepEqual([susp.mode, susp.done, susp.suspended, susp.meta], ["teiki", false, true, "本班運休"]);
});

test("stampViewOf：退役定期券走一般那一套＋指路句（車票＝取消済章、列車＝更改狀態）", () => {
  const retiredTicket = { kind: "ticket" as const, repeat_rule: weekly, status: "done" as const, scheduled_on: null };
  const t = P.stampViewOf(retiredTicket, undefined);
  assert.deepEqual([t.mode, t.done, t.retiredNote], ["plain", true, "定期券跑完或已停用——取消済章、放寬結束條件就會重新排班"]);
  const c = P.stampViewOf({ ...retiredTicket, kind: "car" }, undefined);
  assert.deepEqual([c.mode, c.retiredNote], ["none", "定期券跑完或已停用——更改狀態、放寬結束條件就會重新排班"]);
});

test("switchMode：同模式不動；完成後間隔沒填過天數＝1、填過的留著；固定排程補齊", () => {
  const d = P.draftOf({ ...base, scheduled_on: "2026-10-28" }, TODAY);
  assert.equal(P.switchMode(d, "none"), d);
  assert.equal(P.switchMode({ ...d, days: 5 }, "after").days, 5);
  const fixed = P.switchMode({ ...d, freq: "weekly" }, "fixed");
  assert.deepEqual([fixed.mode, fixed.byweekday], ["fixed", [3]]);
});

test("選項字（桌機 Choice 與手機 Segmented 同一份）", () => {
  assert.deepEqual(P.MODE_OPTIONS.map((o) => o.label), ["不重複", "固定排程", "完成後間隔"]);
  assert.deepEqual(P.FREQ_OPTIONS.map((o) => o.label), ["每日", "每週", "每月"]);
  assert.deepEqual(P.STATUS_OPTIONS.map((o) => o.label), ["未開始", "進行中", "已完成", "途中下車"]);
  assert.deepEqual(P.PRIORITY_OPTIONS.map((o) => o.label), ["低", "中", "高"]);
});

test("teikiState：活著／退役／legacy 文字票", () => {
  assert.deepEqual(P.teikiState({ repeat_rule: weekly, status: "doing" }), { teiki: true, retired: false });
  assert.deepEqual(P.teikiState({ repeat_rule: weekly, status: "done" }), { teiki: false, retired: true });
  assert.deepEqual(P.teikiState({ repeat_rule: "每天早上", status: "done" }), { teiki: false, retired: false });
});

test("stampViewOf.action：章這顆鈕的讀屏名稱（桌機 aria-label 同一句）", () => {
  const ticket = { kind: "ticket" as const, repeat_rule: null, status: "done" as const, scheduled_on: null };
  assert.equal(P.stampViewOf(ticket, undefined).action, "取消完成");
  const teiki = { ...ticket, repeat_rule: weekly, status: "todo" as const };
  assert.equal(P.stampViewOf(teiki, undefined).action, "蓋本班済章");
  assert.equal(P.stampViewOf(teiki, { id: "o", due_on: "2026-10-23", status: "done" }).action, "取消本班済章");
  assert.equal(P.stampViewOf(teiki, { id: "o", due_on: "2026-10-23", status: "skipped" }).action, "取消本班運休");
});

// 第三輪（D-主-83）：子孫數的那把尺——openKidsOf（改已完成要不要問）；刪除改問 repository（common/deleteNodeFlow）
test("kidCountOf：路線樹有這張＝照樹算到底的數（含 0）", () => {
  assert.equal(P.kidCountOf("train", 8, { child_total: 2 }), 8);
  assert.equal(P.kidCountOf("car", 0, { child_total: 3 }), 0);
});

test("kidCountOf：不在樹裡、切片有子項＝null（車廂也一樣——車廂可以套車廂，直屬數不能冒充子孫數）", () => {
  // 評審情境：車廂 C 底下兩個子車廂、各 3 張票 ⇒ 子孫 8、直屬 2；舊碼對車廂回 2（刪除不問、改已完成算錯）
  assert.equal(P.kidCountOf("car", null, { child_total: 2 }), null);
  assert.equal(P.kidCountOf("train", null, { child_total: 2 }), null);
});

test("kidCountOf：不在樹裡、切片說沒有子項＝0；切片也沒有＝null；車票／車站一律 0", () => {
  assert.equal(P.kidCountOf("car", null, { child_total: 0 }), 0);
  assert.equal(P.kidCountOf("train", null, undefined), null);
  assert.equal(P.kidCountOf("ticket", null, undefined), 0);
  assert.equal(P.kidCountOf("station", null, { child_total: 0 }), 0);
});

test("⑥ 間隔與結束條件：draftOf ⇄ buildRule 來回不變，改別格不會洗掉（D-主-297）", () => {
  for (const rule of [
    { ...fixedRule("weekly", "2026-10-20", { byweekday: [1], interval: 2 }), until: "2026-12-31" },
    { ...fixedRule("monthly", "2026-10-20", { bymonthday: [15], interval: 3 }), count: 5 },
    { ...afterRule(3, "2026-10-20"), count: 4 },
    { ...afterRule(3, "2026-10-20"), until: "2026-11-30" },
  ]) {
    const d = P.draftOf({ ...base, repeat_rule: serializeRule(rule) }, TODAY);
    assert.deepEqual(P.buildRule(d), rule);
    assert.deepEqual(P.buildRule({ ...d, start: "2026-10-21" }), { ...rule, start: "2026-10-21" });
  }
});

test("⑥ switchEnd：預帶一個值，一選就完整；切回不結束不留值", () => {
  const d = P.switchMode(P.draftOf(base, TODAY), "fixed");
  const u = P.switchEnd(d, "until", TODAY);
  assert.equal(u.until, "2026-11-24");
  assert.equal(P.buildRule(u)?.until, "2026-11-24");
  const c = P.switchEnd(d, "count", TODAY);
  assert.equal(P.buildRule(c)?.count, 10);
  const none = P.switchEnd(c, "none", TODAY);
  assert.equal(P.buildRule(none)?.count, null);
});

test("⑥ stampViewOf：跑完但一枚済都沒有（最後一班運休）不畫済（沙盒 F-8）", () => {
  const n = { kind: "ticket", repeat_rule: serializeRule(fixedRule("daily", "2026-10-20")), status: "done", scheduled_on: null, completed_at: null } as never;
  const v = P.stampViewOf(n, undefined);
  assert.equal(v.done, false);
  assert.equal(v.action, "取消運休，回到運行");
});

test("⑥ pickEnd：預帶次數不高於已做次數就抬到下限，一選不會立刻跑完", () => {
  const d = P.switchMode(P.draftOf(base, TODAY), "fixed");
  assert.equal(P.pickEnd(d, "count", TODAY, 12).count, 13);
  assert.equal(P.pickEnd(d, "count", TODAY, 3).count, 10);
  assert.equal(P.pickEnd(d, "until", TODAY, 12).endMode, "until");
});

test("⑥ pickFreq：間隔夾進新頻率的上限；每週預帶星期", () => {
  const d = P.switchMode(P.draftOf({ ...base, scheduled_on: "2026-10-28" }, TODAY), "fixed");
  assert.equal(P.pickFreq({ ...d, interval: 30 }, "monthly").interval, 12);
  assert.equal(P.pickFreq({ ...d, interval: 30 }, "weekly").interval, 30);
  assert.deepEqual(P.pickFreq(d, "weekly").byweekday, [3]);
});

test("⑥ runDateBounds：今天起、不早於起算日、不晚於結束日（同 runMoveBlock 的尺）", () => {
  assert.deepEqual(P.runDateBounds(null, TODAY), { min: TODAY, max: undefined });
  assert.deepEqual(P.runDateBounds({ ...fixedRule("daily", "2026-10-30"), until: "2026-12-31" }, TODAY), { min: "2026-10-30", max: "2026-12-31" });
  assert.equal(P.runDateBounds(fixedRule("daily", "2026-01-01"), TODAY).min, TODAY);
});

test("⑥ 結束條件沒填好＝不完整、不送；結束日早於起算日也算", () => {
  const d = P.switchMode(P.draftOf(base, TODAY), "fixed");
  assert.equal(P.buildRule({ ...d, endMode: "until", until: null }), null);
  assert.equal(P.missingHint({ ...d, endMode: "until", until: null }), "選一個結束日");
  assert.equal(P.buildRule({ ...d, endMode: "until", until: "2026-01-01" }), null);
  assert.equal(P.missingHint({ ...d, endMode: "until", until: "2026-01-01" }), "結束日要在起算日之後");
  assert.equal(P.buildRule({ ...d, endMode: "count", count: null }), null);
  assert.equal(P.missingHint({ ...d, endMode: "count", count: null }), "填一個次數");
});

test("⑥ repeatAside 帶結束條件；給已做次數才寫還剩", () => {
  const rule = { ...fixedRule("weekly", "2026-10-20", { byweekday: [1, 3] }), count: 5 };
  const d = P.draftOf({ ...base, repeat_rule: serializeRule(rule) }, TODAY);
  assert.equal(P.repeatAside(d, null), "每週一・三 · 共 5 次");
  assert.equal(P.repeatAside(d, null, 2), "每週一・三 · 還剩 3 班");
  const u = { ...d, endMode: "until" as const, until: "2026-12-31", count: null };
  assert.equal(P.repeatAside(u, null), "每週一・三 · 到 12/31");
});
