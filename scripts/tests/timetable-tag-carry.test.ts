/**
 * 時刻表線⑥：repository 層的荷札（⑥ 契約 0-8、0-11、0-4；甲席資料）。
 * 跑法：`node --test scripts/tests/timetable-tag-carry.test.ts`（node 24，型別剝除預設開；零依賴）。
 *
 * memory 與 sqlite 兩個實作跑同一套：注入一個記憶體版的假荷札 repository（只有 listTagsOf／attach／setTags），看
 *   A. 切開／塗色切出的片段、合併留下的那塊會不會帶上手動荷札（carry 在時間資料寫完之後），`consumeTagWrites` 有寫才 true；
 *   B. 目標的荷札兩步寫（目標列 → setTags）、scope 的 v1／v2 與黏性、只綁荷札的目標改名、名稱不合法整筆不寫。
 * sqlite 走 node:sqlite 的記憶體庫＋0006／0011 兩支 migration（同 timetable-grid.test.ts 的假 db／假同步）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { MIN, isoOf } from "../../src/domain/timetable.ts";
import { goalScopeVersion } from "../../src/domain/timetableStats.ts";
import { TT_TAG_BLOCK, TT_TAG_GOAL } from "../../src/domain/timetableTags.ts";
import { applyBlockTagEdit, blockTagEditOf, carryBlockTags, checkTagNames } from "../../src/data/timetableTagCarry.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const HOUR = 60 * MIN;

/* ───────── 假的荷札 repository（key＝小寫名；不驗實體） ───────── */

interface FakeTags {
  listTagsOf(type: string, id: string): Promise<{ id: string; name: string; name_key: string; created_at: string; updated_at: string; deleted_at: null }[]>;
  attach(type: string, id: string, raw: string): Promise<{ key: string; name: string; created: boolean; already: boolean; receipt: Receipt }>;
  setTags(type: string, id: string, names: readonly string[]): Promise<{ receipt: Receipt; created: string[] }>;
  detach(type: string, id: string, key: string): Promise<Receipt>;
  keys(type: string, id: string): string[];
  attachCalls: number;
  setCalls: { type: string; id: string; names: string[] }[];
  failList?: boolean;
}
interface Receipt {
  createdTagIds: string[];
  createdTaggingIds: string[];
  tagsBefore: { id: string; name: string; deleted_at: string | null }[];
  taggingsBefore: { id: string; deleted_at: string | null }[];
  notesBefore: { id: string; body: string }[];
}
const emptyR = (): Receipt => ({ createdTagIds: [], createdTaggingIds: [], tagsBefore: [], taggingsBefore: [], notesBefore: [] });

function fakeTags(): FakeTags {
  const m = new Map<string, Map<string, string>>();
  const ent = (type: string, id: string): Map<string, string> => {
    const k = type + "|" + id;
    let e = m.get(k);
    if (!e) m.set(k, (e = new Map()));
    return e;
  };
  const f: FakeTags = {
    attachCalls: 0,
    setCalls: [],
    async listTagsOf(type, id) {
      if (f.failList) throw new Error("讀不到");
      return [...ent(type, id).entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([k, n]) => ({ id: "t-" + k, name: n, name_key: k, created_at: "", updated_at: "", deleted_at: null }));
    },
    async attach(type, id, raw) {
      f.attachCalls++;
      const k = raw.replace(/^#/, "").toLowerCase();
      const e = ent(type, id);
      const already = e.has(k);
      e.set(k, raw.replace(/^#/, ""));
      const r = emptyR();
      if (!already) r.createdTaggingIds.push(`${type}|${id}|${k}`);
      return { key: k, name: raw, created: false, already, receipt: r };
    },
    async setTags(type, id, names) {
      f.setCalls.push({ type, id, names: [...names] });
      const e = ent(type, id);
      const want = new Map(names.map((n) => [n.replace(/^#/, "").toLowerCase(), n.replace(/^#/, "")] as const));
      const r = emptyR();
      for (const k of [...e.keys()]) if (!want.has(k)) {
        e.delete(k);
        r.taggingsBefore.push({ id: k, deleted_at: null });
      }
      for (const [k, n] of want) if (!e.has(k)) {
        e.set(k, n);
        r.createdTaggingIds.push(k);
      }
      return { receipt: r, created: [] };
    },
    async detach(type, id, key) {
      const r = emptyR();
      if (ent(type, id).delete(key)) r.taggingsBefore.push({ id: key, deleted_at: null });
      return r;
    },
    keys(type, id) {
      return [...ent(type, id).keys()].sort();
    },
  };
  return f;
}

/* ───────── 假 db／假同步（同 timetable-grid.test.ts） ───────── */

const FAKE_DB = `
export function getDb() { const d = globalThis.__ttDb; if (!d) throw new Error("測試沒設 __ttDb"); return Promise.resolve(d); }
export function uuid() { return crypto.randomUUID(); }
export function nowUtcIso() { return new Date().toISOString(); }
`;
const FAKE_SYNC = `
export function newWriteBatch() { return { stmts: [], ops: [] }; }
export async function runWriteBatch(db, stmts, ops) { db.runBatch(stmts, ops); }
export async function ensureSyncTables() { return false; }
`;
const dataUrl = (src: string) => "data:text/javascript," + encodeURIComponent(src);
registerHooks({
  resolve(specifier, context, nextResolve) {
    const fromSrc = context.parentURL !== undefined && context.parentURL.includes("/src/");
    if (fromSrc) {
      if (specifier === "../lib/db") return { url: dataUrl(FAKE_DB), shortCircuit: true };
      if (specifier === "./syncRepository") return { url: dataUrl(FAKE_SYNC), shortCircuit: true };
      if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) return nextResolve(specifier + ".ts", context);
    }
    return nextResolve(specifier, context);
  },
});

interface TestDb {
  select(sql: string, args?: unknown[]): Promise<Record<string, unknown>[]>;
  execute(sql: string, args?: unknown[]): Promise<void>;
  runBatch(stmts: { sql: string; args: unknown[] }[], ops: unknown[]): void;
}
function makeSqliteDb(): TestDb {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = OFF");
  raw.exec(readFileSync(path.join(ROOT, "src-tauri/migrations/0006_timetable_blocks.sql"), "utf8"));
  raw.exec(readFileSync(path.join(ROOT, "src-tauri/migrations/0011_timetable_goals.sql"), "utf8"));
  const bind = (args: unknown[] = []) => Object.fromEntries(args.map((v, i) => ["$" + (i + 1), v])) as Record<string, never>;
  return {
    async select(sql, args) {
      return raw.prepare(sql).all(bind(args)).map((r) => ({ ...r }));
    },
    async execute(sql, args) {
      raw.prepare(sql).run(bind(args));
    },
    runBatch(stmts) {
      raw.exec("BEGIN");
      try {
        for (const st of stmts) raw.prepare(st.sql).run(bind(st.args));
        raw.exec("COMMIT");
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      }
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRepo = any;
const IMPLS: { name: string; make: (tags: FakeTags | null) => Promise<AnyRepo> }[] = [
  {
    name: "memory",
    make: async (tags) => {
      const { MemoryTimetableRepository } = await import("../../src/data/memoryTimetableRepository.ts");
      return new MemoryTimetableRepository({ seedDemo: false, nodeRepo: {} as never, tagRepo: tags as never });
    },
  },
  {
    name: "sqlite",
    make: async (tags) => {
      (globalThis as { __ttDb?: TestDb }).__ttDb = makeSqliteDb();
      const { SqliteTimetableRepository } = await import("../../src/data/sqliteTimetableRepository.ts");
      return new SqliteTimetableRepository({ tagRepo: tags as never });
    },
  },
];

const goalInput = (o: Record<string, unknown> = {}) => ({
  name: "夜行列車",
  categoryIds: [] as string[],
  period: "since",
  targetMin: 180 * 60,
  direction: "atLeast",
  startOn: "2026-10-01",
  endOn: null,
  ...o,
});

for (const { name, make } of IMPLS) {
  const base = Math.floor(Date.now() / MIN) * MIN - 10 * HOUR;
  const m = (x: number) => base + x * MIN;

  describe(`A. 手動荷札跟著塊的 id 走（${name}）`, () => {
    test("splitMulti 切成三段 ⇒ 兩個新段都帶原塊的手動荷札（換分類的段也帶）；consumeTagWrites 讀完歸零", async () => {
      const tags = fakeTags();
      const repo = await make(tags);
      const a = (await repo.fill("cat-a", isoOf(m(0)), isoOf(m(60)))).block.id;
      await tags.attach(TT_TAG_BLOCK, a, "podcast");
      assert.equal(repo.consumeTagWrites(), false, "還沒搬過");
      const rows = await repo.splitMulti(a, [isoOf(m(20)), isoOf(m(40))], ["cat-a", "cat-b", "cat-a"]);
      assert.equal(rows.length, 3);
      for (const r of rows) assert.deepEqual(tags.keys(TT_TAG_BLOCK, r.id), ["podcast"], r.category_id);
      assert.equal(repo.consumeTagWrites(), true);
      assert.equal(repo.consumeTagWrites(), false, "讀完歸零");
    });
    test("合併進鄰居 ⇒ 留下的那塊＝兩塊手動荷札的聯集", async () => {
      const tags = fakeTags();
      const repo = await make(tags);
      const a = (await repo.fill("cat-a", isoOf(m(0)), isoOf(m(60)))).block.id;
      const b = (await repo.fill("cat-b", isoOf(m(60)), isoOf(m(120)))).block.id;
      await tags.attach(TT_TAG_BLOCK, a, "甲");
      await tags.attach(TT_TAG_BLOCK, b, "乙");
      const p = await repo.merge(b, "prev", isoOf(m(-60)));
      assert.equal(p.keepId, a);
      assert.deepEqual(tags.keys(TT_TAG_BLOCK, a), ["乙", "甲"]);
      assert.equal(repo.consumeTagWrites(), true);
    });
    test("塗色把運行中那班切成兩段 ⇒ 後段（新 id）帶上手動荷札", async () => {
      const tags = fakeTags();
      const repo = await make(tags);
      const R = (await repo.depart("cat-r", isoOf(m(300)))).block.id;
      await tags.attach(TT_TAG_BLOCK, R, "podcast");
      await repo.paint("cat-x", isoOf(m(330)), isoOf(m(360)), "fill");
      const running = (await repo.listRunning())[0];
      assert.notEqual(running.id, R);
      assert.deepEqual(tags.keys(TT_TAG_BLOCK, running.id), ["podcast"]);
    });
    test("沒有手動荷札 ⇒ 不 attach、consumeTagWrites 是 false；沒注入荷札 repository 也照常寫時間資料", async () => {
      const tags = fakeTags();
      const repo = await make(tags);
      const a = (await repo.fill("cat-a", isoOf(m(0)), isoOf(m(60)))).block.id;
      await repo.splitMulti(a, [isoOf(m(30))], ["cat-a", "cat-b"]);
      assert.equal(tags.attachCalls, 0);
      assert.equal(repo.consumeTagWrites(), false);
      const bare = await make(null);
      const x = (await bare.fill("cat-a", isoOf(m(0)), isoOf(m(60)))).block.id;
      assert.equal((await bare.splitMulti(x, [isoOf(m(30))], ["cat-a", "cat-b"])).length, 2);
      assert.equal(bare.consumeTagWrites(), false);
    });
    test("長時間運行選「其實在做別的」⇒ 切出的那段不帶原塊的手動荷札（D-時-132）；原塊照留", async () => {
      const tags = fakeTags();
      const repo = await make(tags);
      const R = (await repo.depart("cat-r", isoOf(m(300)))).block.id;
      await tags.attach(TT_TAG_BLOCK, R, "podcast");
      tags.attachCalls = 0;
      await repo.resolveLongRun(R, isoOf(m(330)), "cat", "cat-x");
      const rows = await repo.listBlocks(isoOf(m(0)), isoOf(Date.now() + HOUR));
      const other = rows.filter((r: { id: string }) => r.id !== R);
      assert.equal(other.length, 1, "切出一段");
      assert.equal(other[0].category_id, "cat-x");
      assert.deepEqual(tags.keys(TT_TAG_BLOCK, other[0].id), [], "那段是別的活動 ⇒ 不搬");
      assert.deepEqual(tags.keys(TT_TAG_BLOCK, R), ["podcast"]);
      assert.equal(tags.attachCalls, 0);
      assert.equal(repo.consumeTagWrites(), false);
    });
    test("刪塊／撤回刪塊、刪目標／撤回、撤回塗色 ⇒ consumeTagWrites 為 true（index 只收存活實體的荷札，要重載）", async () => {
      const tags = fakeTags();
      const repo = await make(tags);
      const a = (await repo.fill("cat-a", isoOf(m(0)), isoOf(m(60)))).block.id;
      repo.consumeTagWrites();
      await repo.softDelete(a);
      assert.equal(repo.consumeTagWrites(), true, "softDelete");
      await repo.restore(a);
      assert.equal(repo.consumeTagWrites(), true, "restore");
      const g = await repo.createGoal(goalInput({ tagNames: ["高效"] }));
      repo.consumeTagWrites();
      await repo.deleteGoal(g.id);
      assert.equal(repo.consumeTagWrites(), true, "deleteGoal");
      await repo.restoreGoal(g.id);
      assert.equal(repo.consumeTagWrites(), true, "restoreGoal");
      const p = await repo.paint("cat-x", isoOf(m(10)), isoOf(m(20)), "fill");
      repo.consumeTagWrites();
      assert.equal(await repo.undoPaint(p.undo), true);
      assert.equal(repo.consumeTagWrites(), true, "undoPaint");
    });
  });

  describe(`B. 目標的荷札（${name}）`, () => {
    test("只綁荷札 ⇒ scope v2、目標列寫好後 setTags；改名（patch 沒帶荷札）照 taggings 驗證、仍是 v2、不動荷札", async () => {
      const tags = fakeTags();
      const repo = await make(tags);
      const row = await repo.createGoal(goalInput({ tagNames: ["#高效"] }));
      assert.equal(goalScopeVersion(row.scope), 2);
      assert.deepEqual(tags.keys(TT_TAG_GOAL, row.id), ["高效"]);
      assert.equal(repo.consumeTagWrites(), true);
      await repo.updateGoal(row.id, { name: "夜行列車２" });
      const g = await repo.getGoal(row.id);
      assert.equal(g.name, "夜行列車２");
      assert.equal(goalScopeVersion(g.scope), 2);
      assert.equal(tags.setCalls.length, 1, "patch 沒帶 tagNames ⇒ 不動荷札");
    });
    test("v2 黏性：摘光荷札（改成只綁分類）仍寫 v2；v1 目標不帶荷札照舊 v1；v1 目標掛上荷札 ⇒ v2", async () => {
      const tags = fakeTags();
      const repo = await make(tags);
      const g2 = await repo.createGoal(goalInput({ categoryIds: ["c1"], tagNames: ["高效"] }));
      await repo.updateGoal(g2.id, { tagNames: [] });
      assert.equal(goalScopeVersion((await repo.getGoal(g2.id)).scope), 2);
      assert.deepEqual(tags.keys(TT_TAG_GOAL, g2.id), []);
      const g1 = await repo.createGoal(goalInput({ categoryIds: ["c1"] }));
      assert.equal(goalScopeVersion(g1.scope), 1);
      assert.equal(tags.setCalls.filter((c) => c.id === g1.id).length, 0, "沒給 tagNames ⇒ 不呼叫 setTags");
      await repo.updateGoal(g1.id, { name: "改名" });
      assert.equal(goalScopeVersion((await repo.getGoal(g1.id)).scope), 1);
      await repo.updateGoal(g1.id, { tagNames: ["拖延"] });
      assert.equal(goalScopeVersion((await repo.getGoal(g1.id)).scope), 2);
      assert.deepEqual(tags.keys(TT_TAG_GOAL, g1.id), ["拖延"]);
    });
    test("舊版把 v2 蓋回 v1（逐欄 LWW）而 taggings 還在 ⇒ 下次寫入回到 v2", async () => {
      const tags = fakeTags();
      const repo = await make(tags);
      const g = await repo.createGoal(goalInput({ categoryIds: ["c1"], tagNames: ["高效"] }));
      // 模擬舊版寫回 v1
      if (name === "memory") (repo as { goals: Map<string, { scope: string }> }).goals.get(g.id)!.scope = JSON.stringify({ categories: ["c1"] });
      else await (globalThis as { __ttDb?: TestDb }).__ttDb!.execute(`UPDATE time_goals SET scope = $1 WHERE id = $2`, [JSON.stringify({ categories: ["c1"] }), g.id]);
      assert.equal(goalScopeVersion((await repo.getGoal(g.id)).scope), 1);
      await repo.updateGoal(g.id, { targetMin: 200 * 60 });
      assert.equal(goalScopeVersion((await repo.getGoal(g.id)).scope), 2);
    });
    test("荷札名稱不合法 ⇒ RangeError（旅客筆記的訊息）、目標列不寫", async () => {
      const tags = fakeTags();
      const repo = await make(tags);
      await assert.rejects(() => repo.createGoal(goalInput({ tagNames: ["高 效"] })), /荷札名稱不能有空白/);
      assert.equal((await repo.listGoals()).length, 0);
      await assert.rejects(() => repo.createGoal(goalInput({ tagNames: [] })), /至少選一個分類或荷札/);
    });
  });
}

describe("C. carryBlockTags", () => {
  test("to 已經有的不重掛；同一對只做一次；from 沒有手動荷札不寫", async () => {
    const tags = fakeTags();
    await tags.attach(TT_TAG_BLOCK, "A", "甲");
    await tags.attach(TT_TAG_BLOCK, "A", "乙");
    await tags.attach(TT_TAG_BLOCK, "X", "甲");
    tags.attachCalls = 0;
    const wrote = await carryBlockTags(
      [
        { to: "X", from: "A" },
        { to: "X", from: "A" },
        { to: "Y", from: "B" },
        { to: "A", from: "A" },
      ],
      tags as never,
    );
    assert.equal(wrote, true);
    assert.deepEqual(tags.keys(TT_TAG_BLOCK, "X"), ["乙", "甲"]);
    assert.equal(tags.attachCalls, 1, "只補掛「乙」");
    assert.equal(await carryBlockTags([{ to: "Y", from: "B" }], tags as never), false);
    assert.equal(await carryBlockTags([{ to: "Y", from: "A" }], null), false, "沒有荷札 repository");
  });
  test("讀荷札失敗 ⇒ 只 warn、回 false（不丟錯）", async () => {
    const tags = fakeTags();
    tags.failList = true;
    const warn = console.warn;
    let warned = 0;
    console.warn = () => void warned++;
    try {
      assert.equal(await carryBlockTags([{ to: "X", from: "A" }], tags as never), false);
    } finally {
      console.warn = warn;
    }
    assert.equal(warned, 1);
  });
  test("改一塊的荷札只套差集：index 未載（基準＝[]）時加一個新的，既有的手動荷札不會被摘掉（評審後）", async () => {
    const tags = fakeTags();
    await tags.attach(TT_TAG_BLOCK, "B", "podcast");
    await tags.attach(TT_TAG_BLOCK, "B", "高效");
    // 面板打開時 index 還沒載 ⇒ 基準是空的；主人在上面加了「新」
    const edit = blockTagEditOf([], ["新"]);
    assert.deepEqual(edit, { add: ["新"], remove: [] });
    assert.equal(await applyBlockTagEdit(tags as never, "B", edit!), true);
    assert.deepEqual(tags.keys(TT_TAG_BLOCK, "B"), ["podcast", "新", "高效"], "基準外的照留");
    // 對照：舊寫法（整份 setTags）會摘光
    const old = fakeTags();
    await old.attach(TT_TAG_BLOCK, "B", "podcast");
    await old.setTags(TT_TAG_BLOCK, "B", ["新"]);
    assert.deepEqual(old.keys(TT_TAG_BLOCK, "B"), ["新"]);
  });
  test("blockTagEditOf：只摘主人親手摘的、只掛新加的；沒變回 null；# 與大小寫依 key 去重", async () => {
    assert.deepEqual(blockTagEditOf(["podcast", "高效"], ["高效", "新"]), { add: ["新"], remove: ["podcast"] });
    assert.equal(blockTagEditOf(["podcast", "高效"], ["#高效", "Podcast"]), null);
    assert.equal(blockTagEditOf([], []), null);
    assert.deepEqual(blockTagEditOf(["a"], ["新", "#新"]), { add: ["新"], remove: ["a"] });
    const tags = fakeTags();
    await tags.attach(TT_TAG_BLOCK, "B", "podcast");
    await tags.attach(TT_TAG_BLOCK, "B", "高效");
    assert.equal(await applyBlockTagEdit(tags as never, "B", { add: ["新"], remove: ["podcast"] }), true);
    assert.deepEqual(tags.keys(TT_TAG_BLOCK, "B"), ["新", "高效"]);
    // 冪等：本來就沒掛的摘、已經掛著的掛 ⇒ 沒寫
    assert.equal(await applyBlockTagEdit(tags as never, "B", { add: ["高效"], remove: ["podcast"] }), false);
  });
  test("checkTagNames：去掉 #、去重（依 key）、不合法丟旅客筆記的理由", () => {
    assert.deepEqual(checkTagNames(["#高效", "高效", "Podcast", "podcast"]), ["高效", "Podcast"]);
    assert.throws(() => checkTagNames(["2026"]), /只有數字/);
    assert.throws(() => checkTagNames(["a#b"]), /不能有 #/);
  });
});
