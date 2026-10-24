// UI 丙-3 F5（E20 手機補記）・手機 ⋯ sheet 改執行日的分流單元測試（契約 docs/research/2026-10-23-UI-丙3-契約.md §1 F5、§4-2）
// 跑法：node --test scripts/tests/mobile-pick-day.test.ts（node 24 直接剝除型別；不進 tsc——tsconfig 只 include src）
// 只 import pickDay.ts（純函式，不碰 React、store、repository）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { planPickDay, type PickDayInput } from "../../src/ui/mobile/pickDay.ts";

const TODAY = "2026-10-23";
const base: PickDayInput = { target: null, today: TODAY, current: TODAY, settled: false, repeat: false };
const plan = (p: Partial<PickDayInput>) => planPickDay({ ...base, ...p });

test("過去日＝補記（updateNode backfill）", () => {
  assert.deepEqual(plan({ target: "2026-10-22" }), { kind: "backfill", day: "2026-10-22" });
  assert.deepEqual(plan({ target: "2026-10-21", current: null }), { kind: "backfill", day: "2026-10-21" });
  // 誤點票（執行日在前天）補記到昨天也是補記
  assert.deepEqual(plan({ target: "2026-10-22", current: "2026-10-21" }), { kind: "backfill", day: "2026-10-22" });
});

test("今天以後＝照舊推遲；排到別天才出收據、排回今天不出", () => {
  assert.deepEqual(plan({ target: "2026-10-24" }), { kind: "reschedule", day: "2026-10-24", receipt: true });
  assert.deepEqual(plan({ target: TODAY, current: "2026-10-20" }), { kind: "reschedule", day: TODAY, receipt: false });
  assert.deepEqual(plan({ target: TODAY, current: null }), { kind: "reschedule", day: TODAY, receipt: false });
});

test("已済／運休擋（過去、未來、清除都擋），守門先於定期券", () => {
  for (const target of ["2026-10-22", "2026-10-24", null]) {
    assert.deepEqual(plan({ target, settled: true }), { kind: "blocked", why: "settled" });
  }
  assert.deepEqual(plan({ target: "2026-10-22", settled: true, repeat: true }), { kind: "blocked", why: "settled" });
});

test("定期券擋（不能補記、不能推遲）", () => {
  for (const target of ["2026-10-22", "2026-10-24", null]) {
    assert.deepEqual(plan({ target, repeat: true }), { kind: "blocked", why: "repeat" });
  }
});

test("挑回現值＝不動；清除執行日照舊", () => {
  assert.deepEqual(plan({ target: TODAY }), { kind: "noop" });
  assert.deepEqual(plan({ target: "2026-10-20", current: "2026-10-20" }), { kind: "noop" });
  assert.deepEqual(plan({ target: null }), { kind: "clear" });
  assert.deepEqual(plan({ target: null, current: null }), { kind: "noop" });
});
