// 荷札別線實體存活登記表（時刻表⑥ 契約 0-6 (a)；零行為插槽）
// 跑法：node --test scripts/tests/tag-entity-alive.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import {
  otherEntitiesAliveSql,
  otherEntityAliveMemory,
  setTagEntityAlive,
  tagEntityAliveList,
  uncountedTagEntityTypes,
} from "../../src/data/tagEntityAlive.ts";

// 記憶體版荷札 repository 直載用：src 裡沒帶副檔名的相對 import 補 .ts、`../lib/db` 換成假的（只要 nowUtcIso）
const FAKE_DB = `export function nowUtcIso() { return new Date().toISOString(); }`;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL !== undefined && context.parentURL.includes("/src/")) {
      if (specifier === "../lib/db") return { url: "data:text/javascript," + encodeURIComponent(FAKE_DB), shortCircuit: true };
      if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) return nextResolve(specifier + ".ts", context);
    }
    return nextResolve(specifier, context);
  },
});

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

/* ── 磨光③ 0-1：counts:false 的類型（例 timetable:block-off）——記憶體版 repository 的兩個讀取點 ── */

async function memRepo() {
  const { MemoryTagRepository } = await import("../../src/data/memoryTagRepository.ts");
  const settings = new Map<string, string>();
  const settingsRepo = { get: async (k: string) => settings.get(k) ?? null, set: async (k: string, v: string) => void settings.set(k, v) };
  const repo = new MemoryTagRepository({} as never, { getNote: async () => null } as never, settingsRepo as never, { seed: false });
  await repo.attach("timetable:category", "c3", "拖延");
  await repo.attach("timetable:block-off", "b1", "拖延");
  await repo.attach("timetable:block", "b2", "拖延");
  return repo;
}
const spec = (type: `${string}:${string}`, counts?: false) => ({ type, existsSql: "1", aliveMemory: async () => true, ...(counts === false ? { counts } : {}) });

test("counts:false：loadIndexSource 帶 uncounted、listUnder 的「別處」不列（明指那一種的照給）", async () => {
  setTagEntityAlive([spec("timetable:block"), spec("timetable:category"), spec("timetable:block-off", false)]);
  try {
    assert.deepEqual(uncountedTagEntityTypes(), ["timetable:block-off"]);
    const repo = await memRepo();
    const src = await repo.loadIndexSource();
    assert.deepEqual(src.uncounted, ["timetable:block-off"]);
    assert.equal(src.taggings.filter((g) => g.entityType === "timetable:block-off").length, 1, "掛載照樣在（給時刻表讀）");
    const under = await repo.listUnder("拖延");
    assert.deepEqual(under.map((x) => (x.kind === "other" ? x.entityType : x.kind)).sort(), ["timetable:block", "timetable:category"]);
    const asked = await repo.listUnder("拖延", "timetable:block-off");
    assert.deepEqual(asked.map((x) => x.id), ["b1"]);
  } finally {
    setTagEntityAlive([]);
  }
});

test("counts:false 沒人登記：loadIndexSource 沒有 uncounted 欄位、listUnder 全列（同插槽之前）", async () => {
  setTagEntityAlive([spec("timetable:block"), spec("timetable:category"), spec("timetable:block-off")]);
  try {
    const repo = await memRepo();
    const src = await repo.loadIndexSource();
    assert.ok(!("uncounted" in src));
    assert.equal((await repo.listUnder("拖延")).length, 3);
  } finally {
    setTagEntityAlive([]);
  }
});
