/**
 * UI 丙-6（☎-1）：`TagRepository.create`——荷札頁「＋ 新荷札」的資料層（單純建一個荷札、掛 0 處）。
 * 跑法：`node --test scripts/tests/tag-repo-create.test.ts`（node 24，型別剝除預設開；零依賴）。
 *
 * 記憶體版與 SQLite 版跑同一套（D 指定兩版逐條對齊）：
 *   新名字建出掛 0 處的真荷札／已存在回 created:false、不寫、收據空（名稱沿用先建的）／復原刪掉／
 *   已刪除的復活、再復原又刪掉／normalizeName 擋下的名稱丟 RangeError、什麼都沒寫。
 * 另外 `tagStore.createTag`（store 的鄰居全換替身，tagRepo＝記憶體版）：選中新荷札、toast 字與復原、已存在只選中、非法名回 null。
 * SQLite：node:sqlite 記憶體庫＋`src-tauri/migrations` 全部依序跑；`../lib/db`、`./syncRepository`、`./index` 換替身
 * （載入法同 `core-polish7-sqlite.test.ts`；同步那半不在這裡驗）。
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
let t = Date.parse("2026-10-24T03:00:00Z");
export function getDb() { const d = globalThis.__tagCreateDb; if (!d) throw new Error("測試沒設 __tagCreateDb"); return Promise.resolve(d); }
export function uuid() { return crypto.randomUUID(); }
export function nowUtcIso() { t += 1000; return new Date(t).toISOString(); }
`;
const FAKE_SYNC = `
export function newWriteBatch() { return { stmts: [], ops: [] }; }
export async function runWriteBatch(db, stmts, ops) { db.runBatch(stmts, ops); }
export async function ensureSyncTables() { return false; }
`;
// sqlite 版 import 的 `./index`（集中檔，會碰 Tauri）：只借 nodeRepo／settingsRepo
const FAKE_INDEX = `
const kv = new Map();
export const nodeRepo = { getNode: async () => null };
export const settingsRepo = { get: async (k) => kv.get(k) ?? null, set: async (k, v) => void kv.set(k, v) };
`;
// tagStore 的鄰居（store 只測 createTag：toast 收進 globalThis.__toasts；tagRepo 由測試塞 globalThis.__storeTagRepo）
const STORE_FAKES: Record<string, string> = {
  "../data/tagRepo": `export const tagRepo = new Proxy({}, { get: (_, k) => { const r = globalThis.__storeTagRepo; const v = r[k]; return typeof v === "function" ? v.bind(r) : v; } });`,
  "../data": `export const settingsRepo = { get: async () => null, set: async () => undefined };`,
  "../lines/runtime": `export function lineTagEntityTables() { return []; }`,
  "../ui/notes/notesFlush": `export const notesFlush = { fn: null };`,
  "./uiStore": `export const useUiStore = { getState: () => ({ showToast: (t) => globalThis.__toasts.push(t), setPage() {}, setMobileTab() {} }), subscribe() {} };`,
  "./notesStore": `export const useNotesStore = { getState: () => ({ setSection() {}, loadInbox: async () => {}, loadNotes: async () => {}, loadDiary: async () => {}, loadMarks: async () => {} }) };`,
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

function makeDb() {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = OFF");
  const dir = path.join(ROOT, "src-tauri/migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) raw.exec(readFileSync(path.join(dir, f), "utf8"));
  const bind = (args: unknown[] = []) => Object.fromEntries(args.map((v, i) => ["$" + (i + 1), v])) as Record<string, never>;
  const db = {
    batches: 0,
    async select(sql: string, args?: unknown[]) {
      return raw.prepare(sql).all(bind(args)).map((r) => ({ ...r }));
    },
    async execute(sql: string, args?: unknown[]) {
      raw.prepare(sql).run(bind(args));
      return { rowsAffected: 0 };
    },
    runBatch(stmts: { sql: string; args: unknown[] }[]) {
      db.batches++;
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
  return db;
}

const { MemoryTagRepository } = await import("../../src/data/memoryTagRepository.ts");
const { SqliteTagRepository } = await import("../../src/data/sqliteTagRepository.ts");
const { isEmptyReceipt, tagId } = await import("../../src/data/tagRepository.ts");
const { buildIndex } = await import("../../src/domain/tags.ts");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Repo = any;
/** 每個 maker 回一顆乾淨的 repo＋「寫了幾個交易」的計數（記憶體版沒有交易，回 null 不驗） */
const makers: [string, () => { repo: Repo; batches: () => number | null }][] = [
  [
    "memory",
    () => {
      const kv = new Map<string, string>();
      const settingsRepo = { get: async (k: string) => kv.get(k) ?? null, set: async (k: string, v: string) => void kv.set(k, v) };
      const repo = new MemoryTagRepository({ getNode: async () => null } as never, { getNote: async () => null, bodiesWithHash: async () => [] } as never, settingsRepo as never, { seed: false });
      return { repo, batches: () => null };
    },
  ],
  [
    "sqlite",
    () => {
      const db = makeDb();
      (globalThis as Record<string, unknown>).__tagCreateDb = db;
      return { repo: new SqliteTagRepository(), batches: () => db.batches };
    },
  ],
];

/** 索引裡這個 key 的節點（buildIndex：real＝表裡有活著的那列；total＝掛幾處） */
async function nodeOf(repo: Repo, key: string) {
  return buildIndex(await repo.loadIndexSource()).byKey[key] ?? null;
}

for (const [name, make] of makers) {
  describe(`${name}：tagRepo.create`, () => {
    test("新名字：建出一個掛 0 處的真荷札；前導 # 與前後空白照 normalizeName 收掉；收據記新建的 id", async () => {
      const { repo, batches } = make();
      const res = await repo.create("  #讀書/日文 ");
      assert.equal(res.created, true);
      assert.equal(res.key, "讀書/日文");
      assert.equal(res.name, "讀書/日文");
      assert.deepEqual(res.receipt.createdTagIds, [await tagId("讀書/日文")]);
      assert.equal(res.receipt.createdTaggingIds.length, 0, "沒有掛載");
      const node = await nodeOf(repo, "讀書/日文");
      assert.ok(node, "索引裡有它");
      assert.equal(node.real, true);
      assert.equal(node.total, 0, "掛 0 處");
      assert.equal(node.direct, 0);
      assert.equal((await repo.loadIndexSource()).taggings.length, 0);
      assert.equal((await nodeOf(repo, "讀書"))?.real, false, "父層是虛資料夾，不建列");
      assert.equal((await repo.loadIndexSource()).tags.length, 1);
      if (batches() !== null) assert.equal(batches(), 1, "一個交易");
    });

    test("已存在：created:false、收據空、不寫；名稱沿用先建的（大小寫不同也算同一個）", async () => {
      const { repo, batches } = make();
      await repo.create("AI/Tools");
      const before = batches();
      const again = await repo.create("ai/tools");
      assert.equal(again.created, false);
      assert.equal(again.key, "ai/tools");
      assert.equal(again.name, "AI/Tools", "沿用先建的 name");
      assert.equal(isEmptyReceipt(again.receipt), true);
      if (before !== null) assert.equal(batches(), before, "沒開交易");
      // 掛上去建的荷札也一樣算「已存在」
      await repo.attach("timetable:block", "b1", "等回覆");
      const viaAttach = await repo.create("#等回覆");
      assert.equal(viaAttach.created, false);
      assert.equal(isEmptyReceipt(viaAttach.receipt), true);
      assert.equal((await nodeOf(repo, "等回覆")).total, 1, "原本的掛載不動");
    });

    test("復原：新建的荷札刪掉（索引不見）；同名再建一次＝復活（收據記改前的 deleted_at），再復原又刪掉", async () => {
      const { repo } = make();
      const first = await repo.create("搬家");
      await repo.undo(first.receipt);
      assert.equal(await nodeOf(repo, "搬家"), null, "復原後不在索引裡");

      const revived = await repo.create("搬家");
      assert.equal(revived.created, true, "復活算新建（主人眼中它原本不在）");
      assert.equal(revived.receipt.createdTagIds.length, 0, "id 決定性：同一列復活，不是新列");
      assert.equal(revived.receipt.tagsBefore.length, 1);
      assert.notEqual(revived.receipt.tagsBefore[0].deleted_at, null, "記的是改前（已刪除）");
      assert.equal((await nodeOf(repo, "搬家")).real, true);

      await repo.undo(revived.receipt);
      assert.equal(await nodeOf(repo, "搬家"), null, "再復原回到刪除");
    });

    test("normalizeName 擋下的名稱：丟 RangeError(reason)、什麼都沒寫", async () => {
      const { repo, batches } = make();
      const bad: [string, string][] = [
        ["", "還沒有名稱"],
        ["#", "還沒有名稱"],
        ["  ", "還沒有名稱"],
        ["a//b", "斜線之間不能空著"],
        ["/a", "斜線之間不能空著"],
        ["兩 個字", "荷札名稱不能有空白"],
        ["a#b", "荷札名稱不能有 #"],
        ["2026", "荷札不能只有數字（像 #2026）"],
      ];
      for (const [raw, reason] of bad) {
        await assert.rejects(repo.create(raw), (e: unknown) => e instanceof RangeError && e.message === reason, `「${raw}」要擋：${reason}`);
      }
      assert.equal((await repo.loadIndexSource()).tags.length, 0);
      if (batches() !== null) assert.equal(batches(), 0);
    });
  });
}

/* ───────── tagStore.createTag ───────── */

describe("tagStore.createTag", async () => {
  type Toast = { message: string; actionLabel?: string; onAction?: () => void };
  const g = globalThis as Record<string, unknown>;
  const toasts: Toast[] = [];
  g.__toasts = toasts;
  const kv = new Map<string, string>();
  const settingsRepo = { get: async (k: string) => kv.get(k) ?? null, set: async (k: string, v: string) => void kv.set(k, v) };
  const repo = new MemoryTagRepository({ getNode: async () => null } as never, { getNote: async () => null, bodiesWithHash: async () => [] } as never, settingsRepo as never, { seed: false });
  g.__storeTagRepo = repo;
  const { useTagStore } = await import("../../src/store/tagStore.ts");
  const st = useTagStore.getState;

  test("新名字：建好、選中、toast「已建立 #X」＋復原；按復原＝刪掉、選取退回總覽", async () => {
    toasts.length = 0;
    useTagStore.setState({ renaming: { key: "x", draft: "x" }, back: { label: "剛才", restore() {} } });
    const res = await st().createTag("#專案/搬家");
    assert.ok(res);
    assert.equal(res.created, true);
    assert.equal(st().selectedKey, "專案/搬家");
    assert.equal(st().renaming, null, "同 select：收起改名");
    assert.equal(st().back, null, "同 select：清掉回到剛才");
    assert.deepEqual(st().openKeys["專案"], 1, "祖先展開");
    assert.equal(st().index?.byKey["專案/搬家"]?.total, 0);
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].message, "已建立 #專案/搬家");
    assert.equal(toasts[0].actionLabel, "復原");
    toasts[0].onAction?.();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(st().index?.byKey["專案/搬家"], undefined, "復原後不在索引");
    assert.equal(st().selectedKey, null, "選取退回總覽");
  });

  test("已存在：只選中、toast「已經有 #X 了」不帶復原（名稱照先建的）", async () => {
    await repo.create("Reading");
    toasts.length = 0;
    useTagStore.setState({ selectedKey: null });
    const res = await st().createTag("reading");
    assert.equal(res?.created, false);
    assert.equal(st().selectedKey, "reading");
    assert.deepEqual(toasts.map((t) => [t.message, t.actionLabel]), [["已經有 #Reading 了", undefined]]);
  });

  test("非法名：toast 原因、回 null、選取不動", async () => {
    toasts.length = 0;
    useTagStore.setState({ selectedKey: "reading" });
    const res = await st().createTag("a b");
    assert.equal(res, null);
    assert.equal(st().selectedKey, "reading");
    assert.deepEqual(toasts.map((t) => t.message), ["荷札名稱不能有空白"]);
  });
});
