// 荷札別線實體存活登記表（時刻表⑥ 契約 0-6 (a)；零行為插槽）
// 跑法：node --test scripts/tests/tag-entity-alive.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  otherEntitiesAliveSql,
  otherEntityAliveMemory,
  setTagEntityAlive,
  tagEntityAliveList,
} from "../../src/data/tagEntityAlive.ts";

test("沒有登記：SQL 片段與插槽之前逐字相同、記憶體一律算存活", async () => {
  setTagEntityAlive([]);
  assert.equal(otherEntitiesAliveSql(), "g.entity_type NOT IN ('node','note')");
  assert.equal(await otherEntityAliveMemory("timetable:block", "x"), true);
});

test("有登記：沒登記的類型照舊算存活、有登記的照 existsSql；記憶體問 aliveMemory", async () => {
  setTagEntityAlive([
    {
      type: "timetable:block",
      existsSql: "EXISTS (SELECT 1 FROM time_blocks x WHERE x.id = g.entity_id AND x.deleted_at IS NULL)",
      aliveMemory: async (id) => id === "alive",
    },
  ]);
  assert.equal(
    otherEntitiesAliveSql(),
    "(g.entity_type NOT IN ('node','note','timetable:block') OR (g.entity_type = 'timetable:block' AND EXISTS (SELECT 1 FROM time_blocks x WHERE x.id = g.entity_id AND x.deleted_at IS NULL)))",
  );
  assert.equal(await otherEntityAliveMemory("timetable:block", "alive"), true);
  assert.equal(await otherEntityAliveMemory("timetable:block", "gone"), false);
  assert.equal(await otherEntityAliveMemory("ticket:x", "gone"), true);
  setTagEntityAlive([]);
});

test("node／note 與沒有冒號的類型不收；字串裡的單引號會跳脫", () => {
  setTagEntityAlive([
    { type: "node" as `${string}:${string}`, existsSql: "1", aliveMemory: async () => false },
    { type: "x:o'k", existsSql: "1", aliveMemory: async () => true },
  ]);
  assert.deepEqual(tagEntityAliveList().map((s) => s.type), ["x:o'k"]);
  assert.match(otherEntitiesAliveSql(), /'x:o''k'/);
  setTagEntityAlive([]);
});
