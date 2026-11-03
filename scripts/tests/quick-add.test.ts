/**
 * 建票列快速語法解析（回饋甲 D-主-135）。
 * 跑法：`node --test scripts/tests/quick-add.test.ts`。純函式、零依賴。
 *
 * 基準日 2026-11-02 是週一，日界線 06:00。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseQuickAdd, stripTokens, type QuickAddCtx } from "../../src/domain/quickAdd.ts";

const ctx: QuickAddCtx = {
  today: "2026-11-02",
  dayStartHour: 6,
  routes: [
    { id: "r1", name: "生活", code: "LIFE" },
    { id: "r2", name: "工作", code: "wk" },
    { id: "r3", name: "A/B", code: null },
  ],
  tasksOf: (routeId) =>
    routeId === "r1"
      ? [
          { id: "t1", name: "採買", kind: "train" },
          { id: "c1", name: "超市", kind: "car" },
        ]
      : [],
};
const ctxNoTasks: QuickAddCtx = { ...ctx, tasksOf: undefined };
const sunday: QuickAddCtx = { ...ctx, today: "2026-11-08" }; // 週日

const on = (text: string, c: QuickAddCtx = ctx) => parseQuickAdd(text, c).scheduledOn;

describe("沒有片段", () => {
  test("空字串、只有空白", () => {
    const p = parseQuickAdd("", ctx);
    assert.equal(p.name, "");
    assert.deepEqual(p.tokens, []);
    assert.deepEqual(p.tags, []);
    assert.equal(parseQuickAdd("  　 ", ctx).name, "");
  });
  test("一般名稱原樣（連同自己打的空白）", () => {
    const p = parseQuickAdd("買牛奶 和  雞蛋", ctx);
    assert.equal(p.name, "買牛奶 和  雞蛋");
    assert.deepEqual(p.tokens, []);
  });
  test("首尾空白 trim", () => {
    assert.equal(parseQuickAdd("  買牛奶 ", ctx).name, "買牛奶");
  });
});

describe("片段要用空白隔開：黏在字裡的不認", () => {
  test("「明天的報告」「報告明天」不被吃", () => {
    for (const t of ["明天的報告", "報告明天", "買14:00的票", "整理11/15資料", "寫週一報告", "去@生活吧", "完成!高"]) {
      const p = parseQuickAdd(t, ctx);
      assert.equal(p.name, t, t);
      assert.deepEqual(p.tokens, [], t);
    }
  });
  test("前後有空白或在頭尾就認", () => {
    assert.equal(on("明天 的報告"), "2026-11-03");
    assert.equal(parseQuickAdd("明天 的報告", ctx).name, "的報告");
    assert.equal(on("報告 明天"), "2026-11-03");
  });
  test("全形空白也算隔開", () => {
    const p = parseQuickAdd("買牛奶　明天　14:00　!高", ctx);
    assert.equal(p.name, "買牛奶");
    assert.equal(p.scheduledOn, "2026-11-03");
    assert.equal(p.scheduledTime, "14:00");
    assert.equal(p.priority, "high");
  });
  test("URL 裡的日期樣子不動", () => {
    const p = parseQuickAdd("看 https://a.com/11/15 資料", ctx);
    assert.deepEqual(p.tokens, []);
  });
});

describe("執行日", () => {
  test("今天／明天／後天／大後天", () => {
    assert.equal(on("x 今天"), "2026-11-02");
    assert.equal(on("x 明天"), "2026-11-03");
    assert.equal(on("x 後天"), "2026-11-04");
    assert.equal(on("x 大後天"), "2026-11-05");
  });
  test("週一～週日：今天起最近、含今天（基準日是週一）", () => {
    assert.equal(on("x 週一"), "2026-11-02"); // 含今天
    assert.equal(on("x 週二"), "2026-11-03");
    assert.equal(on("x 週五"), "2026-11-06");
    assert.equal(on("x 週日"), "2026-11-08");
    assert.equal(on("x 週天"), "2026-11-08");
    assert.equal(on("x 周三"), "2026-11-04");
    assert.equal(on("x 星期四"), "2026-11-05");
  });
  test("週X：基準日是週日時，週一排到明天、週日是今天", () => {
    assert.equal(on("x 週日", sunday), "2026-11-08");
    assert.equal(on("x 週一", sunday), "2026-11-09");
    assert.equal(on("x 週六", sunday), "2026-11-14");
  });
  test("下週一～下週日：下一個日曆週", () => {
    assert.equal(on("x 下週一"), "2026-11-09");
    assert.equal(on("x 下週三"), "2026-11-11");
    assert.equal(on("x 下週日"), "2026-11-15");
    assert.equal(on("x 下週一", sunday), "2026-11-09"); // 週日的「下週一」＝明天
    assert.equal(on("x 下週日", sunday), "2026-11-15");
  });
  test("11/15、11-15、11月15日、2026/11/15", () => {
    assert.equal(on("x 11/15"), "2026-11-15");
    assert.equal(on("x 11-15"), "2026-11-15");
    assert.equal(on("x 11月15日"), "2026-11-15");
    assert.equal(on("x 2026/11/15"), "2026-11-15");
    assert.equal(on("x 2026-12-01"), "2026-12-01");
    assert.equal(on("x 1/5"), "2027-01-05");
  });
  test("只寫月日且已過今天＝明年；剛好今天不算過", () => {
    assert.equal(on("x 11/01"), "2027-11-01");
    assert.equal(on("x 11/02"), "2026-11-02");
    assert.equal(on("x 10/31"), "2027-10-31");
    assert.equal(on("x 2/29"), "2028-02-29"); // 2027 沒有 2/29，往後找
  });
  test("寫了年就照寫（過去也行）", () => {
    assert.equal(on("x 2025/1/5"), "2025-01-05");
  });
  test("不存在的日子不認", () => {
    for (const t of ["13/1", "2/30", "0/5", "11/31", "2026/2/29"]) {
      const p = parseQuickAdd(`x ${t}`, ctx);
      assert.equal(p.scheduledOn, undefined, t);
      assert.equal(p.name, `x ${t}`, t);
    }
  });
  test("單獨的數字、年份不當日期", () => {
    const p = parseQuickAdd("買 2026 3 個", ctx);
    assert.deepEqual(p.tokens, []);
  });
  test("token 位置與 raw", () => {
    const p = parseQuickAdd("買牛奶 明天 ok", ctx);
    assert.deepEqual(p.tokens, [{ kind: "date", start: 4, end: 6, raw: "明天" }]);
    assert.equal(p.name, "買牛奶 ok");
  });
});

describe("幾點", () => {
  const time = (t: string, c: QuickAddCtx = ctx) => parseQuickAdd(`x ${t}`, c).scheduledTime;
  test("14:00、9:30、14點、9點半、14點30分", () => {
    assert.equal(time("14:00"), "14:00");
    assert.equal(time("9:30"), "09:30");
    assert.equal(time("14點"), "14:00");
    assert.equal(time("9點半"), "09:30");
    assert.equal(time("14點30分"), "14:30");
    assert.equal(time("9點30"), "09:30");
  });
  test("全形冒號", () => {
    assert.equal(time("14：00"), "14:00");
  });
  test("下午／晚上 +12", () => {
    assert.equal(time("下午3點"), "15:00");
    assert.equal(time("下午3點半"), "15:30");
    assert.equal(time("下午3:30"), "15:30");
    assert.equal(time("晚上8點"), "20:00");
    assert.equal(time("下午12點"), "12:00");
    assert.equal(time("下午15點"), "15:00");
    assert.equal(time("上午9點"), "09:00");
    assert.equal(time("早上7點"), "07:00");
  });
  test("營業日表記：25:00、凌晨 1 點照 parseClockInput", () => {
    assert.equal(time("25:00"), "25:00");
    assert.equal(time("1:00"), "25:00"); // 日界線 06:00 下 1:00＝25:00
    assert.equal(time("凌晨1點"), "25:00");
    assert.equal(time("晚上12點"), "24:00");
  });
  test("超出範圍不認（留在名稱）", () => {
    for (const t of ["30:00", "9:75", "下午3點99"]) {
      const p = parseQuickAdd(`x ${t}`, ctx);
      assert.equal(p.scheduledTime, undefined, t);
      assert.equal(p.name, `x ${t}`, t);
    }
  });
  test("日界線 0 點時 25:00 不合法", () => {
    assert.equal(time("25:00", { ...ctx, dayStartHour: 0 }), undefined);
    assert.equal(time("23:30", { ...ctx, dayStartHour: 0 }), "23:30");
  });
  test("光一個數字不當時間", () => {
    assert.deepEqual(parseQuickAdd("買 14 個", ctx).tokens, []);
    assert.deepEqual(parseQuickAdd("買 1400", ctx).tokens, []);
  });
});

describe("長度", () => {
  const len = (t: string) => parseQuickAdd(`x ${t}`, ctx).estimateMin;
  test("30分、1h、1h30、90m、1.5h", () => {
    assert.equal(len("30分"), 30);
    assert.equal(len("1h"), 60);
    assert.equal(len("1h30"), 90);
    assert.equal(len("90m"), 90);
    assert.equal(len("1.5h"), 90);
  });
  test("大小寫、中文單位", () => {
    assert.equal(len("2H"), 120);
    assert.equal(len("45min"), 45);
    assert.equal(len("90分鐘"), 90);
    assert.equal(len("2小時"), 120);
    assert.equal(len("1小時30分"), 90);
    assert.equal(len("1h30m"), 90);
    assert.equal(len("０．５h".normalize("NFKC")), 30);
  });
  test("0、超過一天、分鐘 ≥ 60 不認", () => {
    for (const t of ["0分", "0h", "25h", "1h75", "3000m"]) {
      const p = parseQuickAdd(`x ${t}`, ctx);
      assert.equal(p.estimateMin, undefined, t);
      assert.equal(p.name, `x ${t}`, t);
    }
  });
  test("不跟時間打架：14點30分是時間、30分是長度", () => {
    const p = parseQuickAdd("x 14點30分 30分", ctx);
    assert.equal(p.scheduledTime, "14:30");
    assert.equal(p.estimateMin, 30);
    assert.equal(p.name, "x");
  });
});

describe("締切", () => {
  const due = (t: string) => parseQuickAdd(`x ${t}`, ctx);
  test("〆／締切／截止 後面直接接日期", () => {
    assert.equal(due("〆11/30").dueOn, "2026-11-30");
    assert.equal(due("締切11/30").dueOn, "2026-11-30");
    assert.equal(due("截止11/30").dueOn, "2026-11-30");
    assert.equal(due("〆2026/12/25").dueOn, "2026-12-25");
  });
  test("接相對日", () => {
    assert.equal(due("締切明天").dueOn, "2026-11-03");
    assert.equal(due("〆週五").dueOn, "2026-11-06");
    assert.equal(due("〆下週一").dueOn, "2026-11-09");
  });
  test("不影響執行日；token 種類是 due", () => {
    const p = parseQuickAdd("報告 明天 〆11/30", ctx);
    assert.equal(p.scheduledOn, "2026-11-03");
    assert.equal(p.dueOn, "2026-11-30");
    assert.deepEqual(p.tokens.map((t) => t.kind), ["date", "due"]);
    assert.equal(p.name, "報告");
  });
  test("後面不是日期就不認", () => {
    for (const t of ["〆", "〆報告", "截止日"]) {
      const p = parseQuickAdd(`x ${t}`, ctx);
      assert.equal(p.dueOn, undefined, t);
      assert.equal(p.name, `x ${t}`, t);
    }
  });
});

describe("優先", () => {
  const pri = (t: string) => parseQuickAdd(`x ${t}`, ctx).priority;
  test("!高 !中 !低", () => {
    assert.equal(pri("!高"), "high");
    assert.equal(pri("!中"), "mid");
    assert.equal(pri("!低"), "low");
  });
  test("!1 !2 !3、!!＝高", () => {
    assert.equal(pri("!1"), "high");
    assert.equal(pri("!2"), "mid");
    assert.equal(pri("!3"), "low");
    assert.equal(pri("!!"), "high");
  });
  test("全形驚嘆號", () => {
    assert.equal(pri("！高"), "high");
    assert.equal(pri("！！"), "high");
  });
  test("其他不認", () => {
    for (const t of ["!", "!4", "!!!", "!高高", "!x"]) {
      const p = parseQuickAdd(`x ${t}`, ctx);
      assert.equal(p.priority, undefined, t);
      assert.equal(p.name, `x ${t}`, t);
    }
  });
});

describe("荷札", () => {
  test("可多個、/ 分層、去重", () => {
    const p = parseQuickAdd("買牛奶 #採買 #旅行/日本 #採買", ctx);
    assert.deepEqual(p.tags, [
      { name: "採買", key: "採買" },
      { name: "旅行/日本", key: "旅行/日本" },
    ]);
    assert.equal(p.tokens.filter((t) => t.kind === "tag").length, 3); // 三個都反白
    assert.equal(p.name, "買牛奶");
  });
  test("大小寫：name 保留、key 小寫", () => {
    const p = parseQuickAdd("x #ToDo", ctx);
    assert.deepEqual(p.tags, [{ name: "ToDo", key: "todo" }]);
  });
  test("照 parseTags：純數字、色碼、黏在字後的 # 不算", () => {
    for (const t of ["x #2026", "x #AD3D2B", "x#採買"]) {
      const p = parseQuickAdd(t, ctx);
      assert.deepEqual(p.tags, [], t);
      assert.equal(p.name, t, t);
    }
  });
  test("token 位置含 #", () => {
    const p = parseQuickAdd("買 #採買 好", ctx);
    assert.deepEqual(p.tokens, [{ kind: "tag", start: 2, end: 5, raw: "#採買" }]);
    assert.equal(p.name, "買 好");
  });
  test("#明天 是荷札，不是執行日", () => {
    const p = parseQuickAdd("x #明天", ctx);
    assert.deepEqual(p.tags, [{ name: "明天", key: "明天" }]);
    assert.equal(p.scheduledOn, undefined);
  });
});

describe("掛到", () => {
  const dest = (t: string, c: QuickAddCtx = ctx) => parseQuickAdd(`x ${t}`, c).dest;
  test("代碼、全名，不分大小寫", () => {
    assert.deepEqual(dest("@LIFE"), { routeId: "r1", nodeId: null });
    assert.deepEqual(dest("@life"), { routeId: "r1", nodeId: null });
    assert.deepEqual(dest("@生活"), { routeId: "r1", nodeId: null });
    assert.deepEqual(dest("@WK"), { routeId: "r2", nodeId: null });
    assert.deepEqual(dest("@工作"), { routeId: "r2", nodeId: null });
  });
  test("@路線/列車、@路線/車廂", () => {
    assert.deepEqual(dest("@生活/採買"), { routeId: "r1", nodeId: "t1" });
    assert.deepEqual(dest("@life/超市"), { routeId: "r1", nodeId: "c1" });
  });
  test("路線名含 / 時整段先當路線名", () => {
    assert.deepEqual(dest("@A/B"), { routeId: "r3", nodeId: null });
  });
  test("找不到的不認、留在名稱", () => {
    for (const t of ["@不存在", "@", "@生活/不存在", "@不存在/採買", "@wk/採買"]) {
      const p = parseQuickAdd(`x ${t}`, ctx);
      assert.equal(p.dest, undefined, t);
      assert.equal(p.name, `x ${t}`, t);
      assert.deepEqual(p.tokens, [], t);
    }
  });
  test("沒給 tasksOf＝不認第二段", () => {
    const p = parseQuickAdd("x @生活/採買", ctxNoTasks);
    assert.equal(p.dest, undefined);
    assert.equal(p.name, "x @生活/採買");
    assert.deepEqual(parseQuickAdd("x @生活", ctxNoTasks).dest, { routeId: "r1", nodeId: null });
  });
  test("路線底下沒有該列車 ⇒ 不認", () => {
    assert.equal(dest("@工作/採買"), undefined);
  });
});

describe("同一種寫兩次取最後一個", () => {
  test("日期、幾點、優先、掛到、長度、締切", () => {
    const p = parseQuickAdd("x 明天 後天 9:00 10:00 !低 !高 @生活 @工作 30分 1h 〆11/20 〆11/30", ctx);
    assert.equal(p.scheduledOn, "2026-11-04");
    assert.equal(p.scheduledTime, "10:00");
    assert.equal(p.priority, "high");
    assert.deepEqual(p.dest, { routeId: "r2", nodeId: null });
    assert.equal(p.estimateMin, 60);
    assert.equal(p.dueOn, "2026-11-30");
    assert.equal(p.name, "x");
    assert.equal(p.tokens.length, 12); // 重複的也都認成片段、都從名稱拿掉
  });
});

describe("組合句", () => {
  test("買牛奶 明天 14:00 !高 #採買 @生活", () => {
    const text = "買牛奶 明天 14:00 !高 #採買 @生活";
    const p = parseQuickAdd(text, ctx);
    assert.equal(p.name, "買牛奶");
    assert.equal(p.scheduledOn, "2026-11-03");
    assert.equal(p.scheduledTime, "14:00");
    assert.equal(p.priority, "high");
    assert.deepEqual(p.tags, [{ name: "採買", key: "採買" }]);
    assert.deepEqual(p.dest, { routeId: "r1", nodeId: null });
    assert.deepEqual(p.tokens.map((t) => t.kind), ["date", "time", "priority", "tag", "dest"]);
    // token 位置對得回原文
    for (const t of p.tokens) assert.equal(text.slice(t.start, t.end), t.raw);
  });
  test("片段在名稱中間：兩側空白收成一個", () => {
    const p = parseQuickAdd("買 明天 牛奶 #採買 和 雞蛋", ctx);
    assert.equal(p.name, "買 牛奶 和 雞蛋");
  });
  test("全部都是片段 ⇒ name 空字串", () => {
    const p = parseQuickAdd("明天 14:00", ctx);
    assert.equal(p.name, "");
    assert.equal(p.tokens.length, 2);
  });
  test("tokens 照位置排（荷札在前也一樣）", () => {
    const p = parseQuickAdd("#採買 買牛奶 明天", ctx);
    assert.deepEqual(p.tokens.map((t) => t.kind), ["tag", "date"]);
    assert.ok(p.tokens[0].start < p.tokens[1].start);
  });
  test("沒寫的欄位不出現", () => {
    const p = parseQuickAdd("買牛奶", ctx);
    for (const k of ["scheduledOn", "scheduledTime", "estimateMin", "dueOn", "priority", "dest"] as const) {
      assert.equal(k in p, false, k);
    }
  });
});

describe("stripTokens", () => {
  test("拿掉某種片段，其他不動", () => {
    const text = "買牛奶 明天 14:00 !高";
    assert.equal(stripTokens(text, "date", ctx), "買牛奶 14:00 !高");
    assert.equal(stripTokens(text, "time", ctx), "買牛奶 明天 !高");
    assert.equal(stripTokens(text, "priority", ctx), "買牛奶 明天 14:00");
  });
  test("同種多個全拿掉", () => {
    assert.equal(stripTokens("買 明天 牛奶 後天", "date", ctx), "買 牛奶");
    assert.equal(stripTokens("x #a1 y #b2", "tag", ctx), "x y");
  });
  test("片段在開頭：開頭空白一起拿掉；在結尾：前面空白一起拿掉", () => {
    assert.equal(stripTokens("明天 買牛奶", "date", ctx), "買牛奶");
    assert.equal(stripTokens("買牛奶 明天", "date", ctx), "買牛奶");
  });
  test("沒有該種片段 ⇒ 原樣（含使用者自己的空白）", () => {
    assert.equal(stripTokens("買牛奶  明天 ", "dest", ctx), "買牛奶  明天 ");
    assert.equal(stripTokens("", "date", ctx), "");
  });
  test("各種 kind 都拿得掉", () => {
    assert.equal(stripTokens("x 1h30", "length", ctx), "x");
    assert.equal(stripTokens("x 〆11/30", "due", ctx), "x");
    assert.equal(stripTokens("x @生活", "dest", ctx), "x");
    assert.equal(stripTokens("x #採買", "tag", ctx), "x");
  });
  test("全形空白也收", () => {
    assert.equal(stripTokens("買牛奶　明天　14:00", "date", ctx), "買牛奶 14:00");
  });
  test("拿掉 date 不會誤傷 due", () => {
    assert.equal(stripTokens("x 明天 〆11/30", "date", ctx), "x 〆11/30");
  });
  test("拿完再解析一次，那種片段消失", () => {
    const text = "買牛奶 明天 14:00 !高 #採買 @生活";
    const p = parseQuickAdd(stripTokens(text, "date", ctx), ctx);
    assert.equal(p.scheduledOn, undefined);
    assert.equal(p.scheduledTime, "14:00");
    assert.equal(p.name, "買牛奶");
  });
});
