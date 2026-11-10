/**
 * 丁・結構與版面——SQLite 版與記憶體版跑同一套：轉種類帶子項（D-主-246）、支線底下放車票（D-主-245）、
 * 路線一覽的 listRouteMembers（D-主-241）。
 * 跑法：`node --test scripts/tests/structure-sqlite.test.ts`（node 24；載入法同 core-polish7-sqlite.test.ts：
 * node:sqlite 記憶體庫＋全部 migrations，`../lib/db` 與 `./syncRepository` 換替身，不寫 oplog）。
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
let t = Date.now();
export function getDb() { return Promise.resolve(globalThis.__structDb); }
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

const { todayKey } = await import("../../src/lib/date.ts");
const { SqliteNodeRepository } = await import("../../src/data/sqliteNodeRepository.ts");
const { MemoryNodeRepository } = await import("../../src/data/memoryRepository.ts");

const TODAY = todayKey(3);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Repo = any;
const makers: [string, () => Repo][] = [
  [
    "sqlite",
    () => {
      (globalThis as Record<string, unknown>).__structDb = makeDb();
      return new SqliteNodeRepository();
    },
  ],
  ["memory", () => new MemoryNodeRepository()],
];

for (const [name, make] of makers) {
  describe(`${name}：結構與版面`, () => {
    async function base(repo: Repo) {
      const line = await repo.create({ kind: "line", name: "學習", parentId: null });
      const route = await repo.create({ kind: "route", name: "日文", parentId: line.id });
      return { line, route };
    }

    test("支線底下可以直接建車票、把車票搬進支線；車站底下照舊不行", async () => {
      const repo = make();
      const { route } = await base(repo);
      const br = await repo.create({ kind: "branch", name: "文法", parentId: route.id });
      const t = await repo.create({ kind: "ticket", name: "做 20 題", parentId: br.id });
      assert.equal((await repo.getNode(t.id)).parent_id, br.id);
      const train = await repo.create({ kind: "train", name: "N5", parentId: route.id });
      const t2 = await repo.create({ kind: "ticket", name: "背單字", parentId: train.id });
      await repo.move(t2.id, br.id, 0);
      assert.equal((await repo.getNode(t2.id)).parent_id, br.id);
      assert.equal((await repo.getNode(t2.id)).route_id, route.id);
    });

    test("有車廂的列車轉支線：車廂變列車、日期與重複清掉；轉回列車：列車變車廂", async () => {
      const repo = make();
      const { route } = await base(repo);
      const train = await repo.create({ kind: "train", name: "N5 文法", parentId: route.id, scheduledOn: TODAY });
      const car = await repo.create({ kind: "car", name: "て形", parentId: train.id });
      const tk = await repo.create({ kind: "ticket", name: "練習", parentId: train.id });
      await repo.setKind(train.id, "branch");
      const b = await repo.getNode(train.id);
      assert.equal(b.kind, "branch");
      assert.equal(b.scheduled_on, null);
      assert.equal(b.repeat_rule, null);
      assert.equal((await repo.getNode(car.id)).kind, "train");
      assert.equal((await repo.getNode(tk.id)).kind, "ticket");
      await repo.setKind(train.id, "train");
      assert.equal((await repo.getNode(train.id)).kind, "train");
      assert.equal((await repo.getNode(car.id)).kind, "car");
    });

    test("支線裡還有支線就不能轉列車（整筆不寫）", async () => {
      const repo = make();
      const { route } = await base(repo);
      const br = await repo.create({ kind: "branch", name: "主題", parentId: route.id });
      const inner = await repo.create({ kind: "branch", name: "子主題", parentId: br.id });
      await assert.rejects(() => repo.setKind(br.id, "train"), /支線/);
      assert.equal((await repo.getNode(br.id)).kind, "branch");
      assert.equal((await repo.getNode(inner.id)).kind, "branch");
    });

    test("listRouteMembers：路線樹裡活著的節點＋掛路線標籤的臨時車票；不含車站、幹線、路線、刪掉的", async () => {
      const repo = make();
      const { route } = await base(repo);
      const train = await repo.create({ kind: "train", name: "N5", parentId: route.id });
      const t = await repo.create({ kind: "ticket", name: "票", parentId: train.id });
      const temp = await repo.create({ kind: "ticket", name: "臨時", parentId: null, routeTagId: route.id });
      const gone = await repo.create({ kind: "ticket", name: "刪掉", parentId: train.id });
      await repo.addStation?.(route.id, "考過 N5");
      await repo.softDelete(gone.id);
      const ids = (await repo.listRouteMembers()).map((m: Repo) => m.id).sort();
      assert.deepEqual(ids, [train.id, t.id, temp.id].sort());
      const m = (await repo.listRouteMembers()).find((x: Repo) => x.id === temp.id);
      assert.deepEqual(m, { id: temp.id, kind: "ticket", status: "todo", route_id: route.id });
    });

    test("listSubtreeIds：算到底、不算刪掉的，跟 softDelete 接下來刪的同一批（刪除確認框的子項數；失物招領 §5-6）", async () => {
      const repo = make();
      const { route } = await base(repo);
      const train = await repo.create({ kind: "train", name: "N5", parentId: route.id });
      const car = await repo.create({ kind: "car", name: "て形", parentId: train.id });
      const t1 = await repo.create({ kind: "ticket", name: "直屬", parentId: train.id });
      const t2 = await repo.create({ kind: "ticket", name: "孫", parentId: car.id });
      const gone = await repo.create({ kind: "ticket", name: "先刪的", parentId: car.id });
      await repo.softDelete(gone.id);
      const ids = await repo.listSubtreeIds(train.id);
      assert.deepEqual([...ids].sort(), [train.id, car.id, t1.id, t2.id].sort());
      assert.deepEqual([...(await repo.softDelete(train.id))].sort(), [...ids].sort());
    });

    test("討論 5：自由席演化——車票加子項自動升格為列車／車廂，子項清空自動降格回車票，復原再升回", async () => {
      const repo = make();
      const { route } = await base(repo);
      // 1. 支線底下的自由席車票 → 新增子車票 → 自動升格為列車 (train)
      const br = await repo.create({ kind: "branch", name: "前期籌備", parentId: route.id });
      const freeTicket = await repo.create({ kind: "ticket", name: "場地確認", parentId: br.id });
      assert.equal((await repo.getNode(freeTicket.id)).kind, "ticket");

      const sub1 = await repo.create({ kind: "ticket", name: "聯絡管理員", parentId: freeTicket.id });
      assert.equal((await repo.getNode(freeTicket.id)).kind, "train", "支線下的車票加子項應升格為 train");

      // 2. 列車底下的車票 → 新增子車票 → 自動升格為車廂 (car)
      const subSub = await repo.create({ kind: "ticket", name: "準備提問清單", parentId: sub1.id });
      assert.equal((await repo.getNode(sub1.id)).kind, "car", "列車下的車票加子項應升格為 car");

      // 3. 刪除車廂底下唯一的子車票 → 車廂自動降格回車票 (ticket)
      await repo.softDelete(subSub.id);
      assert.equal((await repo.getNode(sub1.id)).kind, "ticket", "子項全刪後 car 應降格回 ticket");

      // 4. 復原剛刪掉的子車票 → 父節點再度升格為車廂 (car)
      await repo.restore([subSub.id]);
      assert.equal((await repo.getNode(sub1.id)).kind, "car", "復原子項後應再度升格為 car");

      // 5. 搬移最後一張子車票離開車廂 → 原父節點降格回 ticket；搬入另一張車票底下 → 新父節點升格
      const siblingTicket = await repo.create({ kind: "ticket", name: "備案場地", parentId: freeTicket.id });
      await repo.move(subSub.id, siblingTicket.id, 0);
      assert.equal((await repo.getNode(sub1.id)).kind, "ticket", "最後子項搬走後原車廂應降格為 ticket");
      assert.equal((await repo.getNode(siblingTicket.id)).kind, "car", "被搬入子項的車票應升格為 car");
    });
  });
}
