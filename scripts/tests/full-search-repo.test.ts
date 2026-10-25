/**
 * 完整搜尋班・repository 的 searchFull——SQLite 版與記憶體版跑同一套（契約 §3 D-主-112、§5）。
 * 跑法：`node --test scripts/tests/full-search-repo.test.ts`（node 24，型別剝除預設開；零依賴）。
 * 載入法照 core-polish7-sqlite.test.ts：node:sqlite 記憶體庫＋全部 migration、db／sync 換替身。
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
let t = Date.now(); // 接近真實時間：今天蓋的章要落在真實的日界線視窗內
export function getDb() { return Promise.resolve(globalThis.__fullSearchDb); }
export function uuid() { return crypto.randomUUID(); }
export function nowUtcIso() { t += 1000; return new Date(t).toISOString(); }
`;
const FAKE_SYNC = `
export function newWriteBatch() { return { stmts: [], ops: [] }; }
export async function runWriteBatch(db, stmts, ops) { db.runBatch(stmts, ops); }
export async function occurrenceId(n, d) { return n + "|" + d; }
export async function ensureSyncTables() { return false; }
`;
const dataUrl = (src: string) => "data:text/javascript," + encodeURIComponent(src);
registerHooks({
  resolve(specifier, context, nextResolve) {
    const fromSrc = context.parentURL !== undefined && context.parentURL.includes("/src/");
    if (fromSrc) {
      if (specifier === "../lib/db") return { url: dataUrl(FAKE_DB), shortCircuit: true };
      if (specifier === "./syncRepository") return { url: dataUrl(FAKE_SYNC), shortCircuit: true };
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
  return {
    async select(sql: string, args?: unknown[]) {
      return raw.prepare(sql).all(bind(args)).map((r) => ({ ...r }));
    },
    async execute(sql: string, args?: unknown[]) {
      raw.prepare(sql).run(bind(args));
      return { rowsAffected: 0 };
    },
    runBatch(stmts: { sql: string; args: unknown[] }[]) {
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

const { SqliteNodeRepository } = await import("../../src/data/sqliteNodeRepository.ts");
const { MemoryNodeRepository } = await import("../../src/data/memoryRepository.ts");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Repo = any;
const makers: [string, () => Repo][] = [
  [
    "sqlite",
    () => {
      (globalThis as Record<string, unknown>).__fullSearchDb = makeDb();
      return new SqliteNodeRepository();
    },
  ],
  ["memory", () => new MemoryNodeRepository()],
];

/** 直接塞一列 work_logs（公開 API 寫不出「body 有字的系統事件」或「已刪的手記」）：SQLite 寫庫、memory 寫它的私有 Map */
function plantLog(repo: Repo, p: { node_id: string; body: string; event: string | null; deleted_at?: string }) {
  const row = {
    id: crypto.randomUUID(),
    logged_at: "2026-10-25T01:00:00Z",
    created_at: "2026-10-25T01:00:00Z",
    updated_at: "2026-10-25T01:00:00Z",
    account_id: null,
    device_id: null,
    synced_at: null,
    deleted_at: null,
    ...p,
  };
  if (repo instanceof MemoryNodeRepository) {
    (repo as Repo).logs.set(row.id, row);
    return;
  }
  const db = (globalThis as Repo).__fullSearchDb;
  void db.execute(
    "INSERT INTO work_logs (id, node_id, body, logged_at, event, deleted_at) VALUES ($1, $2, $3, $4, $5, $6)",
    [row.id, row.node_id, row.body, row.logged_at, row.event, row.deleted_at],
  );
}

for (const [name, make] of makers) {
  describe(`${name}：searchFull`, () => {
    test("命中欄：名稱 → 概要 → 乘務記錄（手記）；一個節點只回一筆、帶那一欄的原文", async () => {
      const repo = make();
      const line = await repo.create({ kind: "line", name: "會議幹線", parentId: null });
      const route = await repo.create({ kind: "route", name: "週會", parentId: line.id });
      const train = await repo.create({ kind: "train", name: "十月", parentId: route.id });
      const byName = await repo.create({ kind: "ticket", name: "準備會議資料", parentId: train.id, description: "會議也在概要裡" });
      const byDesc = await repo.create({ kind: "ticket", name: "投影片", parentId: train.id, description: "週三的會議要用" });
      const byLog = await repo.create({ kind: "ticket", name: "錄音", parentId: null });
      await repo.addWorkLog(byLog.id, "舊的一則：會議延後");
      await repo.addWorkLog(byLog.id, "新的一則：會議改到下午");
      await repo.addWorkLog(byLog.id, "跟主題無關");
      const none = await repo.create({ kind: "ticket", name: "不相干", parentId: null });
      // 系統事件的 body 剛好含查詢字（衝突列的 body 是 JSON）、已刪的手記：都不算命中（反方評審 #7：済事件 body 空，光蓋済是空斷言）
      plantLog(repo, { node_id: none.id, body: '{"name":"會議"}', event: "conflict" });
      plantLog(repo, { node_id: none.id, body: "刪掉的會議手記", event: null, deleted_at: "2026-10-25T00:00:00Z" });

      const hits = await repo.searchFull("會議");
      const by = new Map(hits.map((h: Repo) => [h.node.id, h]));
      assert.equal(by.has(line.id), false, "幹線不進結果（同 Ctrl+P）");
      assert.equal(by.get(byName.id).field, "name");
      assert.equal(by.get(byName.id).text, null);
      assert.equal(by.get(byDesc.id).field, "description");
      assert.equal(by.get(byDesc.id).text, "週三的會議要用");
      assert.equal(by.get(byLog.id).field, "log");
      assert.equal(by.get(byLog.id).text, "新的一則：會議改到下午", "取最新一則命中的手記");
      assert.equal(by.has(none.id), false);
      assert.equal(hits.length, 3);
    });

    test("不設上限、字面比對（% _ 反斜線）、不分大小寫、不含已刪除", async () => {
      const repo = make();
      for (let i = 0; i < 120; i++) await repo.create({ kind: "ticket", name: `Meeting ${i}`, parentId: null });
      assert.equal((await repo.searchFull("meeting")).length, 120, "超過 Ctrl+P 的 50 也全回");
      const lit = await repo.create({ kind: "ticket", name: "100%_完成 a\\b", parentId: null });
      await repo.create({ kind: "ticket", name: "ab 不該被 a\\b 撈到", parentId: null });
      assert.deepEqual((await repo.searchFull("%_")).map((h: Repo) => h.node.id), [lit.id]);
      assert.deepEqual((await repo.searchFull("完成 a\\b")).map((h: Repo) => h.node.id), [lit.id]);
      await repo.softDelete(lit.id);
      assert.equal((await repo.searchFull("%_")).length, 0, "刪掉的不回");
      assert.deepEqual(await repo.searchFull("   "), []);
    });
  });
}
