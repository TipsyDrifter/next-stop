/** 外部助理・日記工具（src/mcp/tools/diary.ts）：memory repository 跑讀寫、足跡、參數錯誤、跨 kind、陣列上限。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { load, makeCtx } from "./mcp-ctx.ts";
import type { McpCtx, McpTool } from "../../src/mcp/types.ts";

const { DIARY_TOOLS } = await load<typeof import("../../src/mcp/tools/diary.ts")>("../../src/mcp/tools/diary.ts");
const { McpUserError } = await load<typeof import("../../src/mcp/types.ts")>("../../src/mcp/types.ts");
const { addDays } = await load<typeof import("../../src/lib/date.ts")>("../../src/lib/date.ts");

const tool = (name: string): McpTool => {
  const t = DIARY_TOOLS.find((x) => x.name === name);
  assert.ok(t, `沒有 ${name}`);
  return t;
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = async (ctx: McpCtx, name: string, args: Record<string, unknown>): Promise<any> => tool(name).run(args, ctx);
const rejects = (p: Promise<unknown>, re?: RegExp) =>
  assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof McpUserError, `要是 McpUserError，收到 ${String(e)}`);
    if (re) assert.match((e as Error).message, re);
    return true;
  });

test("spec：名稱、模組、權限、annotations、描述長度", () => {
  assert.deepEqual(
    DIARY_TOOLS.map((t) => t.name),
    ["find-diary-entries", "get-footprints", "add-diary-entries", "update-diary-entries", "delete-diary-entries"],
  );
  for (const t of DIARY_TOOLS) {
    assert.equal(t.module, "diary");
    assert.ok(t.description.length <= 400, `${t.name} 描述太長`);
    assert.equal(t.annotations.openWorldHint, false);
    const read = t.name.startsWith("find-") || t.name.startsWith("get-");
    assert.equal(t.access, read ? "read" : "write");
    assert.equal(t.annotations.readOnlyHint, read);
    assert.equal(t.annotations.destructiveHint, t.name.startsWith("update-") || t.name.startsWith("delete-"));
  }
});

test("add-diary-entries → find-diary-entries 讀得回來（預設今天、補記舊日子、荷札自動掛）", async () => {
  const ctx = await makeCtx();
  const y = addDays(ctx.today, -1);
  const out = await call(ctx, "add-diary-entries", {
    entries: [
      { body: "今天去爬山 #運動" },
      { body: "晚上看書", title: "讀書" },
      { body: "昨天的補記", entryDate: y },
    ],
  });
  assert.deepEqual(out.changed, ["notes", "tags", "taggings"]);
  assert.match(out.toast, /3 篇日記/);
  assert.deepEqual(out.data.created.map((c: { date: string }) => c.date), [ctx.today, ctx.today, y]);
  const firstId = out.data.created[0].id;
  assert.deepEqual((await ctx.deps.tagRepo.listTagsOf("note", firstId)).map((t) => t.name), ["運動"]);

  const day = await call(ctx, "find-diary-entries", { day: ctx.today });
  assert.equal(day.data.entries.length, 2);
  assert.equal(day.data.entries[0].body, "今天去爬山 #運動");
  assert.deepEqual(day.data.entries[0].tags, ["運動"]);
  assert.equal(day.data.entries[1].title, "讀書");
  assert.match(day.data.entries[0].time, /^\d{2}:\d{2}$/);
  assert.match(day.summary, /2 篇日記/);

  const rng = await call(ctx, "find-diary-entries", { from: y, to: ctx.today });
  assert.equal(rng.data.entries.length, 3);
  assert.equal(rng.data.entries[2].date, y); // 新的日子在前
  assert.equal(rng.data.entries[0].body, undefined); // 區間回摘要
  const rngQ = await call(ctx, "find-diary-entries", { from: y, to: ctx.today, query: "補記" });
  assert.deepEqual(rngQ.data.entries.map((e: { date: string }) => e.date), [y]);

  const q = await call(ctx, "find-diary-entries", { query: "看書" });
  assert.deepEqual(q.data.entries.map((e: { title: string }) => e.title), ["讀書"]);
  assert.match((await call(ctx, "find-diary-entries", { day: addDays(ctx.today, -5) })).summary, /沒有日記/);
});

test("參數錯誤回 McpUserError", async () => {
  const ctx = await makeCtx();
  const tomorrow = addDays(ctx.today, 1);
  await rejects(call(ctx, "find-diary-entries", {}), /day、from＋to，或 query/);
  await rejects(call(ctx, "find-diary-entries", { day: ctx.today, from: ctx.today, to: ctx.today }), /擇一/);
  await rejects(call(ctx, "find-diary-entries", { from: ctx.today }), /缺少 to/);
  await rejects(call(ctx, "find-diary-entries", { from: ctx.today, to: addDays(ctx.today, -1) }), /不能晚於/);
  await rejects(call(ctx, "find-diary-entries", { from: addDays(ctx.today, -62), to: ctx.today }), /最多查 62 天/);
  await call(ctx, "find-diary-entries", { from: addDays(ctx.today, -61), to: ctx.today }); // 62 天剛好可以
  await rejects(call(ctx, "find-diary-entries", { day: "2026/10/01" }), /YYYY-MM-DD/);
  await rejects(call(ctx, "get-footprints", { day: "昨天" }), /YYYY-MM-DD/);
  await rejects(call(ctx, "add-diary-entries", { entries: [{ body: "x", entryDate: tomorrow }] }), /未來/);
  await rejects(call(ctx, "add-diary-entries", { entries: [{}] }), /entries\[0\] 的 body 與 title 至少要有一個/);
  await rejects(call(ctx, "add-diary-entries", { entries: [{ body: "ok" }, { body: "" }] }), /entries\[1\] 的 body 與 title 至少要有一個/);
  await rejects(call(ctx, "add-diary-entries", { entries: [{ body: "x", entryDate: "2026-02-30" }] }), /沒有這一天/);
  assert.equal((await ctx.deps.noteRepo.listDiary(ctx.today)).length, 0); // 整批沒寫
  const many = Array.from({ length: 51 }, () => ({ body: "x" }));
  await rejects(call(ctx, "add-diary-entries", { entries: many }), /最多 50 筆/);
  await rejects(call(ctx, "delete-diary-entries", { ids: many.map((_, i) => `id${i}`) }), /最多 50 筆/);
  assert.equal((await call(ctx, "add-diary-entries", { entries: many.slice(0, 50) })).data.created.length, 50);
});

test("find-diary-entries 有上限並在摘要說截斷", async () => {
  const ctx = await makeCtx();
  const entries = Array.from({ length: 6 }, (_, i) => ({ body: `第 ${i} 天`, entryDate: addDays(ctx.today, -i) }));
  await call(ctx, "add-diary-entries", { entries });
  const r = await call(ctx, "find-diary-entries", { from: addDays(ctx.today, -10), to: ctx.today, limit: 4 });
  assert.equal(r.data.entries.length, 4);
  assert.equal(r.data.truncated, true);
  assert.match(r.summary, /只列最新的 4 篇/);
  assert.equal(r.data.entries[0].date, ctx.today);
  const q = await call(ctx, "find-diary-entries", { query: "天", limit: 2 });
  assert.equal(q.data.entries.length, 2);
  assert.equal(q.data.truncated, true);
});

test("update-diary-entries：改日子、標題、內文（荷札跟著內文）；整批檢查", async () => {
  const ctx = await makeCtx();
  const { data } = await call(ctx, "add-diary-entries", { entries: [{ body: "原文 #心情", title: "原標題" }, { body: "另一篇" }] });
  const [a, b] = data.created.map((c: { id: string }) => c.id);
  const y = addDays(ctx.today, -3);
  const out = await call(ctx, "update-diary-entries", {
    entries: [
      { id: a, entryDate: y, title: null, body: "改過 #天氣" },
      { id: b, title: "補標題" },
    ],
  });
  assert.deepEqual(out.changed, ["notes", "tags", "taggings"]);
  const day = await call(ctx, "find-diary-entries", { day: y });
  assert.equal(day.data.entries.length, 1);
  assert.equal(day.data.entries[0].body, "改過 #天氣");
  assert.equal(day.data.entries[0].title, undefined);
  assert.deepEqual((await ctx.deps.tagRepo.listTagsOf("note", a)).map((t) => t.name), ["天氣"]);
  assert.equal((await call(ctx, "find-diary-entries", { day: ctx.today })).data.entries[0].title, "補標題");

  assert.deepEqual((await call(ctx, "update-diary-entries", { entries: [{ id: b, title: "再改" }] })).changed, ["notes"]);
  await rejects(call(ctx, "update-diary-entries", { entries: [{ id: a, entryDate: addDays(ctx.today, 1) }] }), /未來/);
  await rejects(call(ctx, "update-diary-entries", { entries: [{ id: a }] }), /沒有要改的欄位/);
  await rejects(call(ctx, "update-diary-entries", { entries: [{ id: b, title: "不該寫" }, { id: "nope", title: "x" }] }), /整批都沒有寫入/);
  assert.equal((await call(ctx, "find-diary-entries", { day: ctx.today })).data.entries[0].title, "再改");
});

test("delete-diary-entries：軟刪除、可復原", async () => {
  const ctx = await makeCtx();
  const { data } = await call(ctx, "add-diary-entries", { entries: [{ body: "要刪的" }, { body: "留著的" }] });
  const [a] = data.created.map((c: { id: string }) => c.id);
  const out = await call(ctx, "delete-diary-entries", { ids: [a] });
  assert.deepEqual(out.changed, ["notes"]);
  assert.equal(out.data.deleted[0].date, ctx.today);
  assert.deepEqual((await call(ctx, "find-diary-entries", { day: ctx.today })).data.entries.map((e: { body: string }) => e.body), ["留著的"]);
  await rejects(call(ctx, "delete-diary-entries", { ids: [a] }), /找不到/);
  await ctx.deps.noteRepo.restore([a]);
  assert.equal((await call(ctx, "find-diary-entries", { day: ctx.today })).data.entries.length, 2);
});

test("跨 kind：筆記的 id 對日記工具一律是找不到；find-diary-entries 不列筆記", async () => {
  const ctx = await makeCtx();
  const note = await ctx.deps.noteRepo.create({ kind: "note", body: "一則筆記 關鍵字", inbox: false });
  await rejects(call(ctx, "update-diary-entries", { entries: [{ id: note.id, title: "x" }] }), /找不到/);
  await rejects(call(ctx, "delete-diary-entries", { ids: [note.id] }), /找不到/);
  assert.equal((await call(ctx, "find-diary-entries", { query: "關鍵字" })).data.entries.length, 0);
  assert.equal((await ctx.deps.noteRepo.getNote(note.id))?.deleted_at, null);
});

test("get-footprints：今天完成的車票與手記（dayStartHour 照 ctx）", async () => {
  const ctx = await makeCtx();
  const r = ctx.deps.nodeRepo;
  const line = await r.create({ kind: "line", name: "本線", parentId: null });
  const route = await r.create({ kind: "route", name: "日文", parentId: line.id });
  const train = await r.create({ kind: "train", name: "N3 文法", parentId: route.id });
  const ticket = await r.create({ kind: "ticket", name: "背單字", parentId: train.id });
  await r.setCompleted(ticket.id, true, { dateKey: ctx.today, dayStartHour: ctx.dayStartHour });
  await r.addWorkLog(ticket.id, "背了 30 個");

  const out = await call(ctx, "get-footprints", {});
  assert.equal(out.data.day, ctx.today);
  assert.deepEqual(
    out.data.seals.map((s: { name: string; kind: string }) => [s.name, s.kind]),
    [["背單字", "車票"]],
  );
  assert.match(out.data.seals[0].time, /^\d{2}:\d{2}$/);
  assert.deepEqual(out.data.logs.map((l: { ticket: string; body: string }) => [l.ticket, l.body]), [["背單字", "背了 30 個"]]);
  assert.equal(out.data.seals[0].taskId, ticket.id);
  assert.equal(out.data.logs[0].taskId, ticket.id);
  assert.match(out.summary, /1 枚済章、1 則手記/);

  const empty = await call(ctx, "get-footprints", { day: addDays(ctx.today, -30) });
  assert.match(empty.summary, /沒有/);
  assert.deepEqual(empty.data.seals, []);
});

test("只有標題的日記可以寫；補記附 writtenOn（寫下那天），當天寫的不附", async () => {
  const ctx = await makeCtx();
  const y = addDays(ctx.today, -2);
  const out = await call(ctx, "add-diary-entries", { entries: [{ title: "只有標題" }, { body: "補記的", entryDate: y }] });
  const day = await call(ctx, "find-diary-entries", { day: ctx.today });
  assert.equal(day.data.entries[0].title, "只有標題");
  assert.equal(day.data.entries[0].writtenOn, undefined);
  const back = await call(ctx, "find-diary-entries", { day: y });
  assert.equal(back.data.entries[0].id, out.data.created[1].id);
  assert.equal(back.data.entries[0].writtenOn, ctx.today);
  await rejects(call(ctx, "update-diary-entries", { entries: [{ id: out.data.created[0].id, entryDate: "2026-13-01" }] }));
});
