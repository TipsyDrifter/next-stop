/**
 * 同步引擎班 D-主-121「改名跟到底」——荷札 repository 的資料層（記憶體版與 SQLite 版跑同一套）＋ tagStore.reload 的整理 toast。
 * 跑法：`node --test scripts/tests/sync-engine-tag-rename.test.ts`（node 24，型別剝除預設開；零依賴）。
 *
 * 驗的事：
 *   改名／併入軟刪舊荷札的那筆 op 同時帶 renamed_to（SQLite 看 op；兩版都看列）；
 *   主人親手用回已刪的荷札＝去向清掉（同一筆 op）；復原改名＝去向一起寫回；
 *   拉取後整理：空殼的掛載轉到終點、殼再刪、筆記內文 #舊名 跟著改；鏈式（A→B→C）跟到底；繞圈與終點已死都不轉、殼留著；
 *   沒有殼＝不開交易。
 * 「另一台的併發掛載把舊名救回來」由測試直接改列模擬（引擎的編輯勝刪除在 Rust 端，不在這裡驗）。
 * SQLite：node:sqlite 記憶體庫＋`src-tauri/migrations` 全部依序跑；`../lib/db`、`./syncRepository`、`./index` 換替身
 * （載入法同 `tag-repo-create.test.ts`；假批次把 op 收進 `db.ops` 給測試看）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const FAKE_DB = `
let t = Date.parse("2026-10-26T03:00:00Z");
export function getDb() { const d = globalThis.__seTagDb; if (!d) throw new Error("測試沒設 __seTagDb"); return Promise.resolve(d); }
export function uuid() { return crypto.randomUUID(); }
export function nowUtcIso() { t += 1000; return new Date(t).toISOString(); }
`;
const FAKE_SYNC = `
export function newWriteBatch() { return { stmts: [], ops: [] }; }
export async function runWriteBatch(db, stmts, ops) { db.runBatch(stmts, ops); }
export async function ensureSyncTables() { return false; }
`;
const FAKE_INDEX = `
const kv = new Map();
export const nodeRepo = { getNode: async () => null };
export const settingsRepo = { get: async (k) => kv.get(k) ?? null, set: async (k, v) => void kv.set(k, v) };
`;
const STORE_FAKES: Record<string, string> = {
  "../data/tagRepo": `export const tagRepo = new Proxy({}, { get: (_, k) => { const r = globalThis.__seStoreRepo; const v = r[k]; return typeof v === "function" ? v.bind(r) : v; } });`,
  "../data": `export const settingsRepo = { get: async () => null, set: async () => undefined };`,
  "../lines/runtime": `export function lineTagEntityTables() { return []; }`,
  "../ui/notes/notesFlush": `export const notesFlush = { fn: async () => { globalThis.__seFlushes = (globalThis.__seFlushes ?? 0) + 1; } };`,
  "./uiStore": `export const useUiStore = { getState: () => ({ showToast: (t) => globalThis.__seToasts.push(t), setPage() {}, setMobileTab() {} }), subscribe() {} };`,
  "./notesStore": `export const useNotesStore = { getState: () => ({ editing: false, diaryEditingId: null, setEditing() {}, setDiaryEditing() {}, setSection() {}, loadInbox: async () => {}, loadNotes: async () => {}, loadDiary: async () => {}, loadMarks: async () => {} }) };`,
};
const dataUrl = (src: string) => "data:text/javascript," + encodeURIComponent(src);
registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = context.parentURL;
    if (parent !== undefined && parent.includes("/src/")) {
      if (specifier === "../lib/db") return { url: dataUrl(FAKE_DB), shortCircuit: true };
      if (specifier === "./syncRepository") return { url: dataUrl(FAKE_SYNC), shortCircuit: true };
      if (specifier === "./index" && parent.includes("/src/data/")) return { url: dataUrl(FAKE_INDEX), shortCircuit: true };
      if (parent.includes("/src/store/tagStore.ts") && STORE_FAKES[specifier]) return { url: dataUrl(STORE_FAKES[specifier]), shortCircuit: true };
      if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) {
        try {
          return nextResolve(specifier + ".ts", context);
        } catch {
          return nextResolve(specifier + "/index.ts", context);
        }
      }
    }
    return nextResolve(specifier, context);
  },
});

type Op = { tbl: string; row_id: string; op: string; cols: Record<string, unknown> };

function makeDb() {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = OFF");
  const dir = path.join(ROOT, "src-tauri/migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) raw.exec(readFileSync(path.join(dir, f), "utf8"));
  const bind = (args: unknown[] = []) => Object.fromEntries(args.map((v, i) => ["$" + (i + 1), v])) as Record<string, never>;
  const db = {
    raw,
    batches: 0,
    ops: [] as Op[],
    async select(sql: string, args?: unknown[]) {
      return raw.prepare(sql).all(bind(args)).map((r) => ({ ...r }));
    },
    async execute(sql: string, args?: unknown[]) {
      raw.prepare(sql).run(bind(args));
      return { rowsAffected: 0 };
    },
    runBatch(stmts: { sql: string; args: unknown[] }[], ops: Op[]) {
      db.batches++;
      raw.exec("BEGIN");
      try {
        for (const st of stmts) raw.prepare(st.sql).run(bind(st.args));
        raw.exec("COMMIT");
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      }
      db.ops.push(...ops);
    },
  };
  return db;
}

const { MemoryTagRepository } = await import("../../src/data/memoryTagRepository.ts");
const { SqliteTagRepository } = await import("../../src/data/sqliteTagRepository.ts");
const { tagId, taggingId, followRename } = await import("../../src/data/tagRepository.ts");
const { buildIndex, planRename } = await import("../../src/domain/tags.ts");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Repo = any;

/** 記憶體版的筆記替身（reconcile 改內文用）：bodiesWithHash／setBodyRaw／getNote */
function memNotes() {
  const notes = new Map<string, { id: string; kind: string; body: string; title: null; entry_date: null; noted_at: string }>();
  return {
    notes,
    getNote: async (id: string) => notes.get(id) ?? null,
    bodiesWithHash: async () => [...notes.values()].filter((x) => x.body.includes("#")).map((x) => ({ id: x.id, body: x.body })),
    setBodyRaw: (id: string, body: string) => {
      const x = notes.get(id);
      if (x) x.body = body;
    },
  };
}

interface Harness {
  repo: Repo;
  /** SQLite 才有：寫過的 op */
  ops: () => Op[] | null;
  batches: () => number | null;
  /** 一列荷札（含已刪） */
  tag: (key: string) => Promise<{ id: string; name: string; deleted_at: string | null; renamed_to?: string | null } | null>;
  /** 模擬「另一台的併發掛載把舊名救回來」：列復活（去向不動）＋掛一筆 entity 上去 */
  reviveWithTagging: (key: string, entityType: string, entityId: string) => Promise<void>;
  /** 模擬「另一台真的刪了這枚」（沒有去向） */
  hardDelete: (key: string) => Promise<void>;
  addNote: (id: string, body: string) => Promise<void>;
  noteBody: (id: string) => Promise<string>;
  aliveTaggingsOf: (key: string) => Promise<{ entity_type: string; entity_id: string }[]>;
}

const makers: [string, () => Harness][] = [
  [
    "memory",
    () => {
      const kv = new Map<string, string>();
      const settingsRepo = { get: async (k: string) => kv.get(k) ?? null, set: async (k: string, v: string) => void kv.set(k, v) };
      const nr = memNotes();
      const repo = new MemoryTagRepository({ getNode: async () => null } as never, nr as never, settingsRepo as never, { seed: false });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const inner = repo as any;
      return {
        repo,
        ops: () => null,
        batches: () => null,
        tag: async (key) => inner.tags.get(await tagId(key)) ?? null,
        reviveWithTagging: async (key, entityType, entityId) => {
          const tid = await tagId(key);
          const t = inner.tags.get(tid);
          t.deleted_at = null;
          const id = await taggingId(entityType as never, entityId, tid);
          inner.taggings.set(id, { id, entity_type: entityType, entity_id: entityId, tag_id: tid, created_at: "x", updated_at: "x", deleted_at: null });
        },
        hardDelete: async (key) => {
          const t = inner.tags.get(await tagId(key));
          t.deleted_at = "2026-10-26T09:00:00.000Z";
          t.renamed_to = null;
        },
        addNote: async (id, body) => {
          nr.notes.set(id, { id, kind: "note", body, title: null, entry_date: null, noted_at: "2026-10-26T00:00:00.000Z" });
          await repo.syncBodyTags(id, body);
        },
        noteBody: async (id) => nr.notes.get(id)?.body ?? "",
        aliveTaggingsOf: async (key) => {
          const tid = await tagId(key);
          return [...inner.taggings.values()]
            .filter((g: { tag_id: string; deleted_at: string | null }) => g.tag_id === tid && g.deleted_at === null)
            .map((g: { entity_type: string; entity_id: string }) => ({ entity_type: g.entity_type, entity_id: g.entity_id }));
        },
      };
    },
  ],
  [
    "sqlite",
    () => {
      const db = makeDb();
      (globalThis as Record<string, unknown>).__seTagDb = db;
      const repo = new SqliteTagRepository();
      return {
        repo,
        ops: () => db.ops,
        batches: () => db.batches,
        tag: async (key) => (await db.select(`SELECT * FROM tags WHERE id = $1`, [await tagId(key)]))[0] as never,
        reviveWithTagging: async (key, entityType, entityId) => {
          const tid = await tagId(key);
          db.raw.prepare(`UPDATE tags SET deleted_at = NULL WHERE id = $1`).run({ $1: tid } as never);
          const id = await taggingId(entityType as never, entityId, tid);
          db.raw
            .prepare(`INSERT INTO taggings (id, entity_type, entity_id, tag_id, created_at, updated_at) VALUES ($1,$2,$3,$4,'x','x')`)
            .run({ $1: id, $2: entityType, $3: entityId, $4: tid } as never);
        },
        hardDelete: async (key) => {
          db.raw
            .prepare(`UPDATE tags SET deleted_at = '2026-10-26T09:00:00.000Z', renamed_to = NULL WHERE id = $1`)
            .run({ $1: await tagId(key) } as never);
        },
        addNote: async (id, body) => {
          db.raw
            .prepare(`INSERT INTO notes (id, kind, body, noted_at, created_at, updated_at) VALUES ($1,'note',$2,'2026-10-26T00:00:00.000Z','x','x')`)
            .run({ $1: id, $2: body } as never);
          await repo.syncBodyTags(id, body);
        },
        noteBody: async (id) => ((await db.select(`SELECT body FROM notes WHERE id = $1`, [id]))[0] as { body: string }).body,
        aliveTaggingsOf: async (key) =>
          (await db.select(`SELECT entity_type, entity_id FROM taggings WHERE tag_id = $1 AND deleted_at IS NULL ORDER BY entity_id`, [
            await tagId(key),
          ])) as never,
      };
    },
  ],
];

/** 用 index 算改名計畫再做（＝tagStore.runRename 的資料那半） */
async function rename(repo: Repo, key: string, to: string) {
  const plan = planRename(buildIndex(await repo.loadIndexSource()), key, to);
  assert.equal(plan.ok, true, `計畫要成立：${plan.ok ? "" : plan.reason}`);
  return repo.rename(plan);
}

for (const [name, make] of makers) {
  describe(`${name}：改名記去向`, () => {
    test("改名：舊荷札軟刪＋renamed_to＝新荷札 id，同一筆 op（deleted_at＋renamed_to＋updated_at）", async () => {
      const h = make();
      await h.repo.attach("timetable:block", "b1", "讀書");
      await rename(h.repo, "讀書", "學習");
      const old = await h.tag("讀書");
      const neu = await h.tag("學習");
      assert.ok(old && neu);
      assert.notEqual(old.deleted_at, null);
      assert.equal(old.renamed_to, neu.id);
      assert.equal(neu.deleted_at, null);
      assert.ok(!neu.renamed_to, "新荷札沒有去向");
      const ops = h.ops();
      if (ops) {
        const del = ops.filter((o) => o.tbl === "tags" && o.row_id === old.id && o.op === "delete");
        assert.equal(del.length, 1);
        assert.deepEqual(Object.keys(del[0].cols).sort(), ["deleted_at", "renamed_to", "updated_at"]);
        assert.equal(del[0].cols.renamed_to, neu.id);
        const ins = ops.find((o) => o.tbl === "tags" && o.row_id === neu.id && o.op === "upsert");
        assert.ok(ins && "renamed_to" in ins.cols && ins.cols.renamed_to === null, "新列 op 帶白名單全欄（含 renamed_to:null）");
      }
    });

    test("併入：去向＝併入目標；子荷札各記各的去向", async () => {
      const h = make();
      await h.repo.attach("timetable:block", "b1", "甲/x");
      await h.repo.attach("timetable:block", "b2", "乙");
      await rename(h.repo, "甲", "乙"); // 甲 是虛資料夾、甲/x 搬成 乙/x
      const ax = await h.tag("甲/x");
      const bx = await h.tag("乙/x");
      assert.equal(ax?.renamed_to, bx?.id);
      await h.repo.attach("timetable:block", "b3", "丙");
      await rename(h.repo, "丙", "乙"); // 真荷札併入真荷札
      assert.equal((await h.tag("丙"))?.renamed_to, (await h.tag("乙"))?.id);
    });

    test("主人親手用回已刪的舊名＝刻意重建：去向清掉、跟復活同一筆 op", async () => {
      const h = make();
      await h.repo.attach("timetable:block", "b1", "讀書");
      await rename(h.repo, "讀書", "學習");
      const before = h.ops()?.length ?? 0;
      const res = await h.repo.attach("note", "n9", "讀書");
      assert.equal(res.created, true, "復活算新建");
      const old = await h.tag("讀書");
      assert.equal(old?.deleted_at, null);
      assert.equal(old?.renamed_to ?? null, null);
      const ops = h.ops();
      if (ops) {
        const up = ops.slice(before).filter((o) => o.tbl === "tags" && o.row_id === old!.id);
        assert.equal(up.length, 1, "一筆 op");
        assert.equal(up[0].cols.deleted_at, null);
        assert.equal(up[0].cols.renamed_to, null);
      }
      // 再整理：它不是殼了，不會被收掉
      assert.deepEqual(await h.repo.reconcileRenamed(), []);
      assert.equal((await h.tag("讀書"))?.deleted_at, null);
    });

    test("復原改名：舊荷札活回來、去向一起清掉（不會變成殼被整理收走）", async () => {
      const h = make();
      await h.repo.attach("timetable:block", "b1", "讀書");
      const receipt = await rename(h.repo, "讀書", "學習");
      await h.repo.undo(receipt);
      const old = await h.tag("讀書");
      assert.equal(old?.deleted_at, null);
      assert.equal(old?.renamed_to ?? null, null);
      assert.deepEqual(await h.repo.reconcileRenamed(), []);
      assert.deepEqual(await h.aliveTaggingsOf("讀書"), [{ entity_type: "timetable:block", entity_id: "b1" }]);
    });
  });

  describe(`${name}：拉取後整理（reconcileRenamed）`, () => {
    test("沒有殼：回空陣列、不開交易", async () => {
      const h = make();
      await h.repo.attach("timetable:block", "b1", "讀書");
      await rename(h.repo, "讀書", "學習");
      const n = h.batches();
      assert.deepEqual(await h.repo.reconcileRenamed(), []);
      if (n !== null) assert.equal(h.batches(), n);
    });

    test("被救回來的空殼：掛載轉到新名、舊掛載軟刪、殼再刪（去向不動）；兩台跑出同一列（決定性 id）", async () => {
      const h = make();
      await h.repo.attach("timetable:block", "b1", "讀書");
      await rename(h.repo, "讀書", "學習");
      const target = await h.tag("學習");
      await h.reviveWithTagging("讀書", "timetable:block-off", "b7"); // 另一台離線時在舊名上點了排除
      const res = await h.repo.reconcileRenamed();
      assert.equal(res.length, 1);
      assert.deepEqual(
        { from: res[0].fromName, to: res[0].toName, key: res[0].toKey, moved: res[0].moved, toId: res[0].toId },
        { from: "讀書", to: "學習", key: "學習", moved: 1, toId: target?.id },
      );
      const shell = await h.tag("讀書");
      assert.notEqual(shell?.deleted_at, null, "殼收掉");
      assert.equal(shell?.renamed_to, target?.id, "去向不動");
      assert.deepEqual(await h.aliveTaggingsOf("讀書"), []);
      const onTarget = (await h.aliveTaggingsOf("學習")).map((g) => `${g.entity_type}|${g.entity_id}`).sort();
      assert.deepEqual(onTarget, ["timetable:block-off|b7", "timetable:block|b1"]);
      const ops = h.ops();
      if (ops) {
        const tgId = await taggingId("timetable:block-off", "b7", target!.id);
        assert.ok(ops.some((o) => o.tbl === "taggings" && o.row_id === tgId && o.op === "upsert"), "新掛載的 id 由 (type,entity,tag) 算出");
        const last = ops.filter((o) => o.tbl === "tags" && o.row_id === shell!.id).at(-1);
        assert.equal(last?.op, "delete");
        assert.deepEqual(Object.keys(last!.cols).sort(), ["deleted_at", "updated_at"]);
      }
      // 再跑一次：冪等
      assert.deepEqual(await h.repo.reconcileRenamed(), []);
    });

    test("筆記上的掛載：內文 #舊名 一起改成新名（不然下次存那則筆記會把舊名掛回來）；先叫 beforeBodyRewrite", async () => {
      const h = make();
      await h.repo.attach("timetable:block", "b1", "讀書");
      await rename(h.repo, "讀書", "學習");
      await h.reviveWithTagging("讀書", "timetable:block", "b0");
      await h.addNote("n1", "今天 #讀書 兩小時");
      // addNote 走 syncBodyTags ⇒ ensureTag 看到舊名是活的（被救回來的）、直接掛上，不清去向
      assert.ok((await h.tag("讀書"))?.renamed_to, "殼還是殼");
      let flushed = 0;
      const res = await h.repo.reconcileRenamed({ beforeBodyRewrite: async () => void flushed++ });
      assert.equal(flushed, 1);
      assert.equal(res[0].moved, 2);
      assert.equal(await h.noteBody("n1"), "今天 #學習 兩小時");
      assert.ok((await h.aliveTaggingsOf("學習")).some((g) => g.entity_type === "note" && g.entity_id === "n1"));
    });

    test("鏈式：甲→乙→丙（甲被救回來、乙已刪且有去向）⇒ 跟到丙", async () => {
      const h = make();
      await h.repo.attach("timetable:block", "b1", "甲");
      await rename(h.repo, "甲", "乙");
      await rename(h.repo, "乙", "丙");
      await h.reviveWithTagging("甲", "timetable:block-off", "b2");
      const res = await h.repo.reconcileRenamed();
      assert.equal(res.length, 1);
      assert.equal(res[0].toName, "丙");
      assert.deepEqual(await h.aliveTaggingsOf("丙").then((x) => x.map((g) => g.entity_id).sort()), ["b1", "b2"]);
      assert.notEqual((await h.tag("甲"))?.deleted_at, null);
      assert.notEqual((await h.tag("乙"))?.deleted_at, null, "乙照舊是刪的");
    });

    test("終點已死（另一台真的把新名刪了）：不轉、殼留著（維持編輯勝刪除的本意）", async () => {
      const h = make();
      await h.repo.attach("timetable:block", "b1", "讀書");
      await rename(h.repo, "讀書", "學習");
      await h.reviveWithTagging("讀書", "timetable:block-off", "b7");
      await h.hardDelete("學習");
      const n = h.batches();
      assert.deepEqual(await h.repo.reconcileRenamed(), []);
      if (n !== null) assert.equal(h.batches(), n, "不開交易");
      assert.equal((await h.tag("讀書"))?.deleted_at, null, "殼留著");
      assert.deepEqual(await h.aliveTaggingsOf("讀書"), [{ entity_type: "timetable:block-off", entity_id: "b7" }]);
    });
  });
}

describe("followRename：繞圈與跳數上限", () => {
  const rows = (pairs: [string, string | null, boolean][]) => {
    const m = new Map(pairs.map(([id, to, alive]) => [id, { id, renamed_to: to, deleted_at: alive ? null : "x" }]));
    return async (id: string) => m.get(id) ?? null;
  };
  test("A→B→A 繞圈 ⇒ null", async () => {
    assert.equal(await followRename("A", rows([["A", "B", true], ["B", "A", false]])), null);
  });
  test("終點存活 ⇒ 它；終點刪了 ⇒ null；查不到 ⇒ null；途經存活的殼照跟", async () => {
    assert.equal(await followRename("A", rows([["A", "B", true], ["B", null, true]])), "B");
    assert.equal(await followRename("A", rows([["A", "B", true], ["B", null, false]])), null);
    assert.equal(await followRename("A", rows([["A", "Z", true]])), null);
    assert.equal(await followRename("A", rows([["A", "B", true], ["B", "C", true], ["C", null, true]])), "C");
  });
  test("超過 10 跳 ⇒ null；剛好 10 跳 ⇒ 找得到", async () => {
    const chain = (n: number): [string, string | null, boolean][] =>
      Array.from({ length: n + 1 }, (_, i) => [`t${i}`, i < n ? `t${i + 1}` : null, i === n] as [string, string | null, boolean]);
    assert.equal(await followRename("t0", rows(chain(10))), "t10");
    assert.equal(await followRename("t0", rows(chain(11))), null);
  });
});

/* ───────── tagStore.reload ───────── */

describe("tagStore.reload：拉到荷札變動 ⇒ 整理＋toast", async () => {
  type Toast = { message: string; actionLabel?: string; onAction?: () => void };
  const g = globalThis as Record<string, unknown>;
  const toasts: Toast[] = [];
  g.__seToasts = toasts;
  const nr = memNotes();
  const settingsRepo = { get: async () => null, set: async () => undefined };
  const repo = new MemoryTagRepository({ getNode: async () => null } as never, nr as never, settingsRepo as never, { seed: false });
  g.__seStoreRepo = repo;
  const { useTagStore } = await import("../../src/store/tagStore.ts");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inner = repo as any;

  test("有殼 ⇒ toast「『#舊名』已改名為『#新名』，掛在上面的東西跟過去了」＋看看；沒有荷札變動不整理", async () => {
    // 行程的第一趟 reload 一律補掃（整合版：pull 完被關掉的殼）——先消化掉它，下面才量得到「沒變動不整理」
    await useTagStore.getState().reload({ changed: [], wiped: false, shell: "desktop" });
    await repo.attach("timetable:block", "b1", "讀書");
    await rename(repo, "讀書", "學習");
    const tid = await tagId("讀書");
    inner.tags.get(tid).deleted_at = null;
    const gid = await taggingId("timetable:block-off", "b7", tid);
    inner.taggings.set(gid, { id: gid, entity_type: "timetable:block-off", entity_id: "b7", tag_id: tid, created_at: "x", updated_at: "x", deleted_at: null });

    toasts.length = 0;
    await useTagStore.getState().reload({ changed: ["notes"], wiped: false, shell: "desktop" });
    assert.equal(toasts.length, 0, "沒拉到 tags／taggings 不整理");
    assert.equal(inner.tags.get(tid).deleted_at, null);

    await useTagStore.getState().reload({ changed: ["taggings"], wiped: false, shell: "desktop" });
    assert.deepEqual(
      toasts.map((t) => [t.message, t.actionLabel]),
      [["「#讀書」已改名為「#學習」，掛在上面的東西跟過去了", "看看"]],
    );
    assert.notEqual(inner.tags.get(tid).deleted_at, null);

    toasts.length = 0;
    await useTagStore.getState().reload({ changed: ["tags"], wiped: false, shell: "desktop" });
    assert.equal(toasts.length, 0, "整理過了，再拉不重提");
  });
});
