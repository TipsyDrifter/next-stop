/**
 * 寫方針框開著時同步進來（`planSaveWeek` 的 base 參數）：框記下開啟當下的列，存檔時跟現況三方比對。
 * 跑法：`node --test scripts/tests/week-aims-merge.test.ts`（node 24，型別剝除；零依賴）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { aimConflictNotice, planSaveWeek, type AimDraft, type WeekAimRow } from "../../src/domain/weekAims.ts";

function row(id: string, position: number, p: Partial<WeekAimRow> = {}): WeekAimRow {
  return {
    id,
    week_on: "M2026-11",
    text: id,
    node_id: null,
    position,
    done_at: null,
    carried_from: null,
    account_id: null,
    device_id: null,
    created_at: "2026-11-01T00:00:00.000Z",
    updated_at: "2026-11-01T00:00:00.000Z",
    synced_at: null,
    deleted_at: null,
    ...p,
  };
}
const d = (id: string | null, text = id ?? "", nodeId: string | null = null, carriedFrom: string | null = null): AimDraft => ({ id, text, nodeId, carriedFrom });
const KEY = "M2026-11";

describe("框開著時別處改了這一期", () => {
  test("別處刪了 X（base 有、現況沒有）：丟掉，不走 creates，不復活", () => {
    const base = [d("x"), d("a")];
    const p = planSaveWeek([row("a", 1)], base, KEY, base);
    assert.deepEqual(p.creates, []);
    assert.deepEqual(p.deletes, []);
    assert.deepEqual(p.updates, [{ id: "a", position: 0 }], "X 的位置不留空");
    assert.deepEqual(p.conflict, { dropped: ["x"], theirs: [] });
  });

  test("別處刪了 X、這邊還改了字：一樣丟掉，字留在提示裡", () => {
    const p = planSaveWeek([], [d("x", "改過的字")], KEY, [d("x")]);
    assert.deepEqual(p.creates, []);
    assert.deepEqual(p.conflict?.dropped, ["改過的字"]);
  });

  test("這邊也刪了 X：沒有撞到，不提示", () => {
    const p = planSaveWeek([row("a", 0)], [d("a")], KEY, [d("x"), d("a")]);
    assert.deepEqual(p, { creates: [], updates: [], deletes: [] });
  });

  test("別處新寫 Y（現況有、base 沒有）：不刪，接在草稿後面", () => {
    const base = [d("a"), d("b")];
    const p = planSaveWeek([row("a", 0), row("y", 1), row("b", 2)], base, KEY, base);
    assert.deepEqual(p.deletes, []);
    assert.deepEqual(p.updates, [
      { id: "b", position: 1 },
      { id: "y", position: 2 },
    ]);
    assert.deepEqual(p.conflict, { dropped: [], theirs: [{ id: "y", text: "y" }] });
  });

  test("這邊刪的句子（base 有、現況有、草稿沒有）照舊刪", () => {
    const p = planSaveWeek([row("a", 0), row("b", 1)], [d("a")], KEY, [d("a"), d("b")]);
    assert.deepEqual(p.deletes, ["b"]);
    assert.equal(p.conflict, undefined);
  });

  test("五句上限不因別處的句子擋存檔：草稿自己五句＋別處兩句", () => {
    const base = [d("a"), d("b"), d("c")];
    const drafts = [...base, d(null, "丁"), d(null, "戊")];
    const cur = [row("a", 0), row("b", 1), row("c", 2), row("y", 3), row("z", 4)];
    const p = planSaveWeek(cur, drafts, KEY, base);
    assert.equal(p.creates.length, 2);
    assert.deepEqual(p.creates.map((c) => c.position), [3, 4]);
    assert.deepEqual(p.updates, [
      { id: "y", position: 5 },
      { id: "z", position: 6 },
    ]);
    assert.deepEqual(p.deletes, []);
  });

  test("草稿自己第六句照擋；別處刪掉的那句不算在內", () => {
    const six = ["1", "2", "3", "4", "5", "6"].map((t) => d(null, t));
    assert.throws(() => planSaveWeek([], six, KEY, []), /一個月最多 5 句/);
    const base = [d("x"), d("a"), d("b"), d("c"), d("e")];
    assert.doesNotThrow(() => planSaveWeek([row("a", 1), row("b", 2), row("c", 3), row("e", 4)], [...base, d(null, "新")], KEY, base));
  });

  test("別處改了字、這邊沒動：不把舊字蓋回去；這邊也改了＝這邊的字", () => {
    const base = [d("a", "舊甲", "R1"), d("b", "舊乙", "R1")];
    const cur = [row("a", 0, { text: "別處改的甲", node_id: "R2" }), row("b", 1, { text: "別處改的乙", node_id: "R2" })];
    const p = planSaveWeek(cur, [d("a", "舊甲", "R1"), d("b", "這邊改的乙", "R3")], KEY, base);
    assert.deepEqual(p.updates, [{ id: "b", text: "這邊改的乙", nodeId: "R3" }]);
    assert.equal(p.conflict, undefined);
  });

  test("帶過來的決定性 id（不在 base）：現況沒有＝照舊 create（D-主-252）；已被別處帶過來＝同一列，不重複、不算別處新寫的", () => {
    const base = [d("a")];
    const carry = d("carry-id", "帶來的句子", null, "src");
    const created = planSaveWeek([row("a", 0)], [...base, carry], KEY, base);
    assert.deepEqual(created.creates, [{ id: "carry-id", text: "帶來的句子", nodeId: null, position: 1, carriedFrom: "src" }]);
    assert.equal(created.conflict, undefined);
    const both = planSaveWeek([row("a", 0), row("carry-id", 1, { text: "帶來的句子" })], [...base, carry], KEY, base);
    assert.deepEqual(both, { creates: [], updates: [], deletes: [] });
  });

  test("開框時就在的帶來列被別處刪掉（在 base）：不復活", () => {
    const base = [d("carry-id", "帶來的句子", null, "src")];
    const p = planSaveWeek([], base, KEY, base);
    assert.deepEqual(p.creates, []);
    assert.deepEqual(p.conflict?.dropped, ["帶來的句子"]);
  });

  test("不給 base：舊行為一個字都不變（外部助理 save-aim 走這條）", () => {
    const p = planSaveWeek([row("a", 0), row("y", 1)], [d("a"), d("x")], KEY);
    assert.deepEqual(p, {
      creates: [{ id: "x", text: "x", nodeId: null, position: 1, carriedFrom: null }],
      updates: [],
      deletes: ["y"],
    });
  });

  test("aimConflictNotice：一句寫句子、多句寫句數；沒撞到＝null", () => {
    assert.equal(aimConflictNotice({ creates: [], updates: [], deletes: [] }), null);
    assert.equal(aimConflictNotice({ creates: [], updates: [], deletes: [], conflict: { dropped: ["X"], theirs: [] } }), "「X」在別處刪掉了，沒有存回去");
    assert.equal(
      aimConflictNotice({ creates: [], updates: [], deletes: [], conflict: { dropped: [], theirs: [{ id: "y", text: "Y" }] } }),
      "「Y」是別處新寫的，也留著",
    );
    assert.equal(
      aimConflictNotice({
        creates: [],
        updates: [],
        deletes: [],
        conflict: { dropped: ["X", "X2"], theirs: [{ id: "y", text: "Y" }, { id: "z", text: "Z" }] },
      }),
      "2 句在別處刪掉了，沒有存回去；2 句是別處新寫的，也留著",
    );
  });
});
