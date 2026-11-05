// ⑥ 重複任務補完的引擎測試（src/domain/repeat.ts；D-主-291～296）
// 跑法：node --test scripts/tests/repeat-engine.test.ts（repeat.ts 的 `../lib/date` 沒寫副檔名 ⇒ 用 registerHooks 補）
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

const R = await import("../../src/domain/repeat.ts");
const { fixedRule, afterRule, parseRule, serializeRule, projectFixed, currentDue, describeRule, describeEnd } = R;

type Occ = { due_on: string; status: "done" | "skipped"; completed_at: string | null; updated_at: string };
const done = (due: string, at = `${due}T12:00:00.000Z`): Occ => ({ due_on: due, status: "done", completed_at: at, updated_at: at });
const skipped = (due: string, at = `${due}T12:00:00.000Z`): Occ => ({ due_on: due, status: "skipped", completed_at: null, updated_at: at });

// 2026-11-02 是週一
const MON = "2026-11-02";

test("每 2 週：只有隔週的指定星期有班，基準是起算日那一週", () => {
  const rule = fixedRule("weekly", MON, { byweekday: [1, 4], interval: 2 });
  assert.deepEqual(projectFixed(rule, MON, "2026-11-30"), ["2026-11-02", "2026-11-05", "2026-11-16", "2026-11-19", "2026-11-30"]);
});

test("每 2 週：週日屬於它前面那個週一開頭的一週（不跟 week_start 偏好）", () => {
  const rule = fixedRule("weekly", MON, { byweekday: [0], interval: 2 });
  assert.deepEqual(projectFixed(rule, MON, "2026-11-30"), ["2026-11-08", "2026-11-22"]);
});

test("每 3 天：從起算日起算", () => {
  const rule = fixedRule("daily", MON, { interval: 3 });
  assert.deepEqual(projectFixed(rule, MON, "2026-11-11"), ["2026-11-02", "2026-11-05", "2026-11-08", "2026-11-11"]);
});

test("每 3 個月：跨年、夾月底", () => {
  const rule = fixedRule("monthly", "2026-11-30", { bymonthday: [31], interval: 3 });
  assert.deepEqual(projectFixed(rule, "2026-11-01", "2027-06-30"), ["2026-11-30", "2027-02-28", "2027-05-31"]);
});

test("interval 超過上限夾回；最大間隔仍算得出下一班（不會被誤判成跑完）", () => {
  const raw = { ...fixedRule("monthly", MON, { bymonthday: [2] }), interval: 999 };
  const p = parseRule(serializeRule(raw as never));
  assert.equal(p?.mode === "fixed" ? p.interval : 0, 12);
  const yearly = parseRule(serializeRule(fixedRule("monthly", MON, { bymonthday: [2], interval: 12 })))!;
  assert.equal(currentDue(yearly, [done(MON)], MON), "2027-11-02");
  const wk = parseRule(serializeRule(fixedRule("weekly", MON, { byweekday: [1], interval: 52 })))!;
  assert.equal(currentDue(wk, [done(MON)], MON), "2027-11-01");
});

test("describeRule：間隔 1 的字不變，N 期加上去", () => {
  assert.equal(describeRule(fixedRule("daily", MON)), "每天重複");
  assert.equal(describeRule(fixedRule("daily", MON, { interval: 3 })), "每 3 天");
  assert.equal(describeRule(fixedRule("weekly", MON, { byweekday: [1, 3] })), "每週一・三");
  assert.equal(describeRule(fixedRule("weekly", MON, { byweekday: [1, 3], interval: 2 })), "每 2 週 一・三");
  assert.equal(describeRule(fixedRule("monthly", MON, { bymonthday: [15] })), "每月 15 號");
  assert.equal(describeRule(fixedRule("monthly", MON, { bymonthday: [15], interval: 3 })), "每 3 個月 15 號");
});

test("describeEnd：到某天、做滿 N 次；沒結束條件＝null", () => {
  assert.equal(describeEnd(fixedRule("daily", MON)), null);
  assert.equal(describeEnd({ ...fixedRule("daily", MON), until: "2026-12-31" }), "到 12/31");
  assert.equal(describeEnd({ ...fixedRule("daily", MON), until: "2027-01-31" }), "到 2027/1/31");
  assert.equal(describeEnd({ ...afterRule(3, MON), count: 5 }), "共 5 次");
  assert.equal(describeEnd({ ...afterRule(3, MON), count: 5 }, 2), "還剩 3 班");
});

test("做滿 N 次：只數済，運休不算；済滿回 null", () => {
  const rule = { ...fixedRule("daily", MON), count: 2 };
  assert.equal(currentDue(rule, [done(MON)], MON), "2026-11-03");
  assert.equal(currentDue(rule, [done(MON), skipped("2026-11-03")], "2026-11-03"), "2026-11-04");
  assert.equal(currentDue(rule, [done(MON), skipped("2026-11-03"), done("2026-11-04")], "2026-11-04"), null);
});

test("做滿 N 次：完成後間隔同一把尺；起算日之前的済不算", () => {
  const rule = { ...afterRule(3, MON), count: 1 };
  assert.equal(currentDue(rule, [done(MON)], MON), null);
  assert.equal(currentDue(rule, [done("2026-10-01")], MON), "2026-10-04");
});

test("到某天為止：最後一班還沒交代就照舊是目前班次，交代了才跑完", () => {
  const rule = { ...fixedRule("daily", MON), until: "2026-11-03" };
  assert.equal(currentDue(rule, [], "2026-11-20"), "2026-11-03");
  assert.equal(currentDue(rule, [done("2026-11-03")], "2026-11-20"), null);
});

test("投影：做滿 N 次之後不畫假班次；運休不佔名額；済滿就空", () => {
  const rule = { ...fixedRule("daily", MON), count: 3 };
  const p1 = R.projectionRule(rule, [done(MON)], MON);
  assert.equal(p1.until, "2026-11-04");
  const p2 = R.projectionRule(rule, [done(MON), skipped("2026-11-03")], MON);
  assert.equal(p2.until, "2026-11-05");
  const p3 = R.projectionRule(rule, [done(MON), done("2026-11-03"), done("2026-11-04")], "2026-11-04");
  assert.deepEqual(projectFixed(p3, MON, "2026-12-01"), []);
  // 原本就有更早的結束日＝不放寬
  const p4 = R.projectionRule({ ...rule, until: "2026-11-03" }, [], MON);
  assert.equal(p4.until, "2026-11-03");
  // 沒有 count 原樣
  const plain = fixedRule("daily", MON);
  assert.equal(R.projectionRule(plain, [], MON), plain);
});

test("改日期：原班次日不再是班次、新日子變成班次，後面的班不受影響", () => {
  const weekly = fixedRule("weekly", MON, { byweekday: [3] }); // 週三 11/4、11/11…
  const moved = R.withRunMoved(weekly, "2026-11-04", "2026-11-06");
  assert.deepEqual(projectFixed(moved, MON, "2026-11-20"), ["2026-11-06", "2026-11-11", "2026-11-18"]);
  assert.equal(currentDue(moved, [], "2026-11-04"), "2026-11-06");
  assert.equal(R.runOrigin(moved, "2026-11-06"), "2026-11-04");
});

test("改日期：今天那班改走時，不會倒回去抓上週漏掉的那班", () => {
  const weekly = fixedRule("weekly", "2026-10-01", { byweekday: [3] });
  const moved = R.withRunMoved(weekly, "2026-11-04", "2026-11-06");
  assert.equal(currentDue(moved, [], "2026-11-04"), "2026-11-06");
});

test("改日期：改過的接著改同一格；改回原日＝拿掉，規則回到沒有 moves", () => {
  const daily = fixedRule("weekly", MON, { byweekday: [3] });
  const a = R.withRunMoved(daily, "2026-11-04", "2026-11-06");
  const b = R.withRunMoved(a, "2026-11-06", "2026-11-07");
  assert.deepEqual(b.moves, { "2026-11-04": "2026-11-07" });
  const c = R.withRunMoved(b, "2026-11-07", "2026-11-04");
  assert.equal("moves" in c, false);
  assert.equal(serializeRule(c), serializeRule(daily));
});

test("改日期：完成後間隔只動引擎算出的那一班，錨點一變就失效", () => {
  const rule = afterRule(3, MON);
  const m = R.withRunMoved(rule, "2026-11-05", "2026-11-08");
  assert.equal(currentDue(m, [done(MON)], MON), "2026-11-08");
  assert.equal(currentDue(m, [done("2026-11-03")], "2026-11-03"), "2026-11-06");
});

test("parseRule 保留 moves，壞的項丟掉；沒有 moves 的 JSON 逐字不變", () => {
  const plain = fixedRule("daily", MON);
  assert.equal(serializeRule(parseRule(serializeRule(plain))!), serializeRule(plain));
  const raw = JSON.stringify({ ...plain, moves: { "2026-11-04": "2026-11-06", bad: "x", "2026-11-05": 3 } });
  assert.deepEqual(parseRule(raw)?.moves, { "2026-11-04": "2026-11-06" });
});

test("runMoveBlock：歷史唯讀、起算與結束邊界、一天一班", () => {
  const rule = { ...fixedRule("weekly", MON, { byweekday: [3] }), until: "2026-12-31" };
  const today = "2026-11-04";
  assert.equal(R.runMoveBlock(rule, [], today, "2026-11-06", today), null);
  assert.equal(R.runMoveBlock(rule, [], today, today, today), null, "同一天是空操作，不擋");
  assert.match(R.runMoveBlock(rule, [], today, "2026-11-03", today)!, /今天以後/);
  assert.match(R.runMoveBlock(rule, [], today, "2027-01-01", today)!, /結束日/);
  assert.match(R.runMoveBlock(rule, [], today, "2026-11-11", today)!, /已經有一班/);
  assert.match(R.runMoveBlock(rule, [done(today)], today, "2026-11-06", today)!, /交代/);
  assert.match(R.runMoveBlock(rule, [], "2026-11-05", "2026-11-06", today)!, /不是接下來/);
  assert.equal(R.runMoveBlock(rule, [], "2026-11-11", "2026-11-12", today), null, "未來的班也能改");
});

test("runMoveBlock：完成後間隔只能改目前這一班；跑完的不能改", () => {
  const rule = afterRule(3, MON);
  assert.equal(R.runMoveBlock(rule, [], MON, "2026-11-08", MON), null);
  assert.match(R.runMoveBlock(rule, [], "2026-11-09", "2026-11-10", MON)!, /目前這一班/);
  const ended = { ...rule, count: 1 };
  assert.match(R.runMoveBlock(ended, [done(MON)], "2026-11-05", "2026-11-08", MON)!, /交代|跑完/);
});

test("一台改期、另一台蓋章（⑥ 沙盒 F-9）：蓋過的那班不會在新日子再出現；撤章就回來", () => {
  const weekly = fixedRule("weekly", MON, { byweekday: [3] });
  const moved = R.withRunMoved(weekly, "2026-11-04", "2026-11-06");
  assert.equal(currentDue(moved, [done("2026-11-04")], "2026-11-04"), "2026-11-11");
  assert.deepEqual([...R.settledMoveTargets(moved, [done("2026-11-04")])], ["2026-11-06"]);
  assert.equal(currentDue(moved, [], "2026-11-04"), "2026-11-06");
});

test("ruleValueText：同步清單的規則值講人話（⑥ 沙盒 F-7）", () => {
  const rule = { ...fixedRule("weekly", MON, { byweekday: [1] }), count: 5 };
  assert.equal(R.ruleValueText(serializeRule(rule)), "每週一 · 共 5 次");
  assert.equal(R.ruleValueText(serializeRule(R.withRunMoved(rule, MON, "2026-11-03"))), "每週一 · 共 5 次 · 改過 1 班日期");
  assert.equal(R.ruleValueText(null), "不重複");
  assert.equal(R.ruleValueText("每週一"), null);
});

test("sameSchedule：只改結束條件算同一個排程；改頻率、間隔、起算日不算", () => {
  const a = fixedRule("weekly", MON, { byweekday: [3] });
  assert.equal(R.sameSchedule(a, { ...a, until: "2026-12-31", count: 3 }), true);
  assert.equal(R.sameSchedule(a, { ...a, interval: 2 }), false);
  assert.equal(R.sameSchedule(a, { ...a, start: "2026-11-03" }), false);
  assert.equal(R.sameSchedule(a, afterRule(3, MON)), false);
});

test("keptMoves：今天以前與已有結局的留著，其他清掉", () => {
  const rule = { ...fixedRule("daily", MON), moves: { "2026-11-02": "2026-11-03", "2026-11-05": "2026-11-20", "2026-11-06": "2026-11-21" } };
  assert.deepEqual(R.keptMoves(rule, [{ due_on: "2026-11-21" }], "2026-11-04"), {
    "2026-11-02": "2026-11-03",
    "2026-11-06": "2026-11-21",
  });
});
