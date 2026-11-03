/**
 * ② 運行報告・済的定義（D-主-181；契約 `docs/research/2026-11-02-主線-運行報告-契約.md` §1）。
 * 跑法：`node --test scripts/tests/seals.test.ts`（node 24；零依賴）。
 *
 * 兩件事：純函式的語義（mock 走它）；SQLite 的兩句 SELECT（node:sqlite 記憶體庫＋全部 migration）跟純函式吐一樣的東西。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  SEAL_NODE_SQL,
  SEAL_OCC_SQL,
  countSealsByDay,
  dedupeSeals,
  sealOfRow,
  sealsInWindow,
  type SealNodeSrc,
  type SealOccSrc,
  type SealRow,
} from "../../src/domain/seals.ts";
import { dayKeyOf, dayWindow } from "../../src/lib/date.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const W = { start: "2026-10-31T22:00:00.000Z", end: "2026-11-01T22:00:00.000Z" };
const IN = "2026-11-01T03:00:00.000Z";
const OUT = "2026-11-02T03:00:00.000Z";

const node = (o: Partial<SealNodeSrc> & { id: string }): SealNodeSrc => ({
  name: o.id,
  kind: "ticket",
  route_id: null,
  status: "done",
  completed_at: IN,
  mood: null,
  deleted_at: null,
  ...o,
});
const occ = (o: Partial<SealOccSrc> & { id: string; node_id: string }): SealOccSrc => ({
  due_on: "2026-11-01",
  status: "done",
  completed_at: IN,
  mood: null,
  deleted_at: null,
  ...o,
});

test("(a) 只收 train／car／ticket、done、存活、完成時刻在窗內", () => {
  const nodes = [
    node({ id: "t", kind: "train" }),
    node({ id: "c", kind: "car" }),
    node({ id: "k" }),
    node({ id: "r", kind: "route" }),
    node({ id: "st", kind: "station" }),
    node({ id: "b", kind: "branch" }),
    node({ id: "todo", status: "todo" }),
    node({ id: "del", deleted_at: IN }),
    node({ id: "late", completed_at: OUT }),
    node({ id: "edge", completed_at: W.end }),
    node({ id: "start", completed_at: W.start }),
  ];
  assert.deepEqual(sealsInWindow(W, nodes, []).map((s) => s.id), ["t", "c", "k", "start"]);
});

test("(b) 班次 done 才算（運休不算）、班次或節點刪了不算、帶 dueOn", () => {
  const rep = node({ id: "rep", status: "todo" });
  const gone = node({ id: "gone", status: "todo", deleted_at: IN });
  const seals = sealsInWindow(W, [rep, gone], [
    occ({ id: "o1", node_id: "rep", due_on: "2026-10-31" }),
    occ({ id: "o2", node_id: "rep", status: "skipped" }),
    occ({ id: "o3", node_id: "rep", deleted_at: IN }),
    occ({ id: "o4", node_id: "gone" }),
    occ({ id: "o5", node_id: "nowhere" }),
  ]);
  assert.deepEqual(seals.map((s) => [s.id, s.nodeId, s.dueOn]), [["o1", "rep", "2026-10-31"]]);
});

test("dedupeSeals：同節點同時刻只留一枚、依時刻排序", () => {
  const a = { nodeId: "x", at: "2026-11-01T05:00:00.000Z", id: "x" };
  const b = { nodeId: "x", at: "2026-11-01T05:00:00.000Z", id: "ox" };
  const c = { nodeId: "y", at: "2026-11-01T04:00:00.000Z", id: "y" };
  assert.deepEqual(dedupeSeals([a, b, c]).map((s) => s.id), ["y", "x"]);
});

test("countSealsByDay：照日界線歸日（06:00 前算前一天）", () => {
  const h = 6;
  const early = new Date(2026, 10, 2, 5, 30).toISOString(); // 本地 11/2 05:30 ⇒ 11/1
  const later = new Date(2026, 10, 2, 7, 0).toISOString(); // ⇒ 11/2
  const got = countSealsByDay(
    [
      { nodeId: "a", at: early },
      { nodeId: "b", at: later },
      { nodeId: "b", at: later },
    ],
    (iso) => dayKeyOf(iso, h),
  );
  assert.deepEqual(got, { "2026-11-01": 1, "2026-11-02": 1 });
});

test("SQLite 兩句 SELECT＝純函式（同一批資料）", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = OFF");
  const dir = path.join(ROOT, "src-tauri/migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) db.exec(readFileSync(path.join(dir, f), "utf8"));
  db.exec("PRAGMA foreign_keys = OFF"); // 有的 migration 自己開回來；這裡只驗 SELECT，路線不必真的存在
  const cols = db.prepare("PRAGMA table_info(nodes)").all() as { name: string; notnull: number; dflt_value: unknown }[];
  const insertNode = (n: SealNodeSrc) => {
    const row: Record<string, unknown> = {
      id: n.id,
      name: n.name,
      kind: n.kind,
      route_id: n.route_id,
      status: n.status,
      completed_at: n.completed_at,
      mood: n.mood,
      deleted_at: n.deleted_at,
    };
    // 其他 NOT NULL 又沒有預設值的欄：填個型別對的值
    for (const c of cols) if (!(c.name in row) && c.notnull && c.dflt_value === null) row[c.name] = c.name.endsWith("_at") ? IN : c.name === "position" ? 0 : "";
    const keys = Object.keys(row);
    db.prepare(`INSERT INTO nodes (${keys.join(",")}) VALUES (${keys.map((k) => "$" + k).join(",")})`).run(
      Object.fromEntries(keys.map((k) => ["$" + k, row[k] as never])),
    );
  };
  const ocols = db.prepare("PRAGMA table_info(occurrences)").all() as { name: string; notnull: number; dflt_value: unknown }[];
  const insertOcc = (o: SealOccSrc) => {
    const row: Record<string, unknown> = { ...o };
    for (const c of ocols) if (!(c.name in row) && c.notnull && c.dflt_value === null) row[c.name] = c.name.endsWith("_at") ? IN : "";
    const keys = Object.keys(row);
    db.prepare(`INSERT INTO occurrences (${keys.join(",")}) VALUES (${keys.map((k) => "$" + k).join(",")})`).run(
      Object.fromEntries(keys.map((k) => ["$" + k, row[k] as never])),
    );
  };
  const nodes = [
    node({ id: "t", kind: "train", route_id: "r1" }),
    node({ id: "k", mood: "green" }),
    node({ id: "todo", status: "todo" }),
    node({ id: "del", deleted_at: IN }),
    node({ id: "late", completed_at: OUT }),
    node({ id: "rep", status: "done" }), // 退役定期券：(a)(b) 同一時刻
    node({ id: "st", kind: "station" }),
  ];
  const occs = [occ({ id: "o1", node_id: "rep" }), occ({ id: "o2", node_id: "rep", due_on: "2026-10-30", status: "skipped", completed_at: IN })];
  nodes.forEach(insertNode);
  occs.forEach(insertOcc);
  const bind = { $1: W.start, $2: W.end } as Record<string, never>;
  const rows = [
    ...(db.prepare(SEAL_NODE_SQL).all(bind) as unknown as SealRow[]),
    ...(db.prepare(SEAL_OCC_SQL).all(bind) as unknown as SealRow[]),
  ].map((r) => sealOfRow({ ...r }));
  const key = (s: { id: string; nodeId: string; at: string }) => `${s.id}|${s.nodeId}|${s.at}`;
  assert.deepEqual(dedupeSeals(rows).map(key).sort(), dedupeSeals(sealsInWindow(W, nodes, occs)).map(key).sort());
  assert.equal(dedupeSeals(rows).length, 3); // t、k、rep（o1 與 rep 同時刻併成一枚）
  // dayWindow 給的窗跟這裡的 W 同型（UTC ISO）
  assert.ok(dayWindow("2026-11-01", 6).start.endsWith("Z"));
});
