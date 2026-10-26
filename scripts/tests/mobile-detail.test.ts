// 手機殼班・手機詳情頁純邏輯單元測試（D-主-69／75／78；src/ui/mobile/detail/detailModel.ts）
// 跟桌機側板共用的規則（重複規則草稿、票種轉換、現況／検印）的測試在 panel-rules.test.ts（D-主-82）
// 跑法：node --test scripts/tests/mobile-detail.test.ts（node 24 直接剝除型別；不進 tsc——tsconfig 只 include src）
// detailModel.ts 只 import type＋domain/repeat.ts；repeat.ts 的 `../lib/date` 沒寫副檔名 ⇒ 用 registerHooks 補 .ts（同 core-polish7.test.ts）。
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
const M = await import("../../src/ui/mobile/detail/detailModel.ts");
const { serializeRule, fixedRule, parseRule } = await import("../../src/domain/repeat.ts");

test("clampInt：夾範圍、非數字＝null", () => {
  assert.equal(M.clampInt("40", 1, 31), 31);
  assert.equal(M.clampInt("0", 1, 31), 1);
  assert.equal(M.clampInt("abc", 1, 31), null);
  assert.equal(M.clampInt(7, 1, 31), 7);
});

test("timeCardOf：班次日＝目前班次 ?? 執行日；済／運休看班次；rule 模式的值＝每班", () => {
  const node = {
    id: "n1", name: "跑步", kind: "ticket", parent_id: "t1", route_id: "r1", status: "todo",
    repeat_rule: serializeRule(fixedRule("daily", "2026-10-20")), scheduled_on: "2026-10-26",
    scheduled_time: "07:00", estimate_min: 30, due_on: null, carried_from: null,
  } as unknown as Parameters<typeof M.timeCardOf>[0];
  const c = M.timeCardOf(node, { id: "o1", status: "skipped", due_on: "2026-10-25" });
  assert.equal(c.railDate, "2026-10-25");
  assert.equal(c.suspended, true);
  assert.equal(c.done, false);
  assert.equal(c.ruleTime, "07:00");
  assert.equal(c.fare, "定期券");
  assert.ok(parseRule(node.repeat_rule));
  const plain = M.timeCardOf({ ...node, repeat_rule: null, parent_id: null, status: "done" }, undefined);
  assert.equal(plain.railDate, "2026-10-26");
  assert.equal(plain.done, true);
  assert.equal(plain.fare, "臨時券");
});

test("splitLogs：新到舊、競合另列、計數只算手記", () => {
  const logs = [
    { id: "a", event: null, logged_at: "2026-10-24T01:00:00Z" },
    { id: "b", event: "conflict", logged_at: "2026-10-24T03:00:00Z" },
    { id: "c", event: "done", logged_at: "2026-10-24T02:00:00Z" },
    { id: "d", event: null, logged_at: "2026-10-24T04:00:00Z" },
  ];
  const s = M.splitLogs(logs);
  assert.deepEqual(s.entries.map((l) => l.id), ["d", "c", "a"]);
  assert.deepEqual(s.conflicts.map((l) => l.id), ["b"]);
  assert.equal(s.manual, 2);
  assert.deepEqual(M.splitLogs(undefined), { entries: [], conflicts: [], manual: 0 });
});

test("fmtLogStamp：壞字串原樣回傳", () => {
  assert.equal(M.fmtLogStamp("nope"), "nope");
  assert.match(M.fmtLogStamp("2026-10-24T01:05:00Z"), /^\d{1,2}\/\d{1,2} \d{2}:\d{2}$/);
});
