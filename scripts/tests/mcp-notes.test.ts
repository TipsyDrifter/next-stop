/** 外部助理・筆記工具（src/mcp/tools/notes.ts）：memory repository 跑讀寫、參數錯誤、跨 kind、陣列上限。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { load, makeCtx } from "./mcp-ctx.ts";
import type { McpCtx, McpTool } from "../../src/mcp/types.ts";

const { NOTE_TOOLS } = await load<typeof import("../../src/mcp/tools/notes.ts")>("../../src/mcp/tools/notes.ts");
const { McpUserError } = await load<typeof import("../../src/mcp/types.ts")>("../../src/mcp/types.ts");

const tool = (name: string): McpTool => {
  const t = NOTE_TOOLS.find((x) => x.name === name);
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

/** 幹線 → 路線 → 列車 → 車廂，外加一張臨時車票（掛不上筆記） */
async function seedTree(ctx: McpCtx) {
  const r = ctx.deps.nodeRepo;
  const line = await r.create({ kind: "line", name: "本線", parentId: null });
  const route = await r.create({ kind: "route", name: "日文", parentId: line.id });
  const train = await r.create({ kind: "train", name: "N3 文法", parentId: route.id });
  const car = await r.create({ kind: "car", name: "第一課", parentId: train.id });
  const other = await r.create({ kind: "train", name: "聽力", parentId: route.id });
  const ticket = await r.create({ kind: "ticket", name: "買文具", parentId: null });
  return { line, route, train, car, other, ticket };
}

test("spec：名稱、模組、權限、annotations、描述長度", () => {
  assert.deepEqual(
    NOTE_TOOLS.map((t) => t.name),
    ["find-notes", "get-note", "add-notes", "update-notes", "delete-notes"],
  );
  for (const t of NOTE_TOOLS) {
    assert.equal(t.module, "notes");
    assert.ok(t.description.length <= 400, `${t.name} 描述太長`);
    assert.equal(t.annotations.openWorldHint, false);
    const read = t.name.startsWith("find-") || t.name.startsWith("get-");
    assert.equal(t.access, read ? "read" : "write");
    assert.equal(t.annotations.readOnlyHint, read);
    assert.equal(t.annotations.destructiveHint, t.name.startsWith("update-") || t.name.startsWith("delete-"));
  }
});

test("add-notes → get-note／find-notes 讀得回來；tags 補進內文並掛上荷札", async () => {
  const ctx = await makeCtx();
  const out = await call(ctx, "add-notes", {
    notes: [
      { title: "搬家清單", body: "先打包書櫃 #生活", tags: ["專案/搬家", "#生活"] },
      { body: "  縮排保留\n\n", inbox: true },
    ],
  });
  assert.deepEqual(out.changed, ["notes", "tags", "taggings"]);
  assert.match(out.toast, /2 則筆記/);
  const [a, b] = out.data.created;
  assert.equal(b.inbox, true);

  const got = await call(ctx, "get-note", { id: a.id });
  assert.equal(got.data.title, "搬家清單");
  assert.equal(got.data.body, "先打包書櫃 #生活\n\n#專案/搬家");
  assert.deepEqual(got.data.tags.sort(), ["專案/搬家", "生活"].sort());
  assert.equal(got.data.inbox, false);
  assert.match(got.data.date, /^\d{4}-\d{2}-\d{2}$/);
  // 荷札是從內文推導的 taggings（tagRepo 讀得到）
  const tags = await ctx.deps.tagRepo.listTagsOf("note", a.id);
  assert.deepEqual(tags.map((t) => t.name_key).sort(), ["生活", "專案/搬家"].sort());

  const inbox = await call(ctx, "get-note", { id: b.id });
  assert.equal(inbox.data.body, "  縮排保留");
  assert.equal(inbox.data.inbox, true);

  // 篩選
  assert.equal((await call(ctx, "find-notes", {})).data.notes.length, 2);
  assert.deepEqual((await call(ctx, "find-notes", { inbox: true })).data.notes.map((n: { id: string }) => n.id), [b.id]);
  assert.deepEqual((await call(ctx, "find-notes", { inbox: false })).data.notes.map((n: { id: string }) => n.id), [a.id]);
  assert.deepEqual((await call(ctx, "find-notes", { query: "書櫃" })).data.notes.map((n: { id: string }) => n.id), [a.id]);
  // 荷札含子荷札
  const byTag = await call(ctx, "find-notes", { tag: "#專案" });
  assert.deepEqual(byTag.data.notes.map((n: { id: string }) => n.id), [a.id]);
  assert.deepEqual(byTag.data.notes[0].tags, ["生活", "專案/搬家"]);
  assert.equal((await call(ctx, "find-notes", { tag: "專案", inbox: true })).data.notes.length, 0);
  assert.equal((await call(ctx, "find-notes", { query: "沒有這個字" })).summary, "沒有符合的筆記");
});

test("掛節點：只收路線／支線／列車／車廂；掛了就不進收件匣；find-notes 依節點篩", async () => {
  const ctx = await makeCtx();
  const t = await seedTree(ctx);
  const out = await call(ctx, "add-notes", {
    notes: [
      { body: "路線本身", nodeId: t.route.id },
      { body: "列車上", nodeId: t.train.id, inbox: true },
      { body: "車廂上", nodeId: t.car.id },
      { body: "別的列車", nodeId: t.other.id },
      { body: "沒掛" },
    ],
  });
  const [onRoute, onTrain, onCar, onOther, loose] = out.data.created.map((c: { id: string }) => c.id);
  assert.equal(out.data.created[1].inbox, undefined); // 掛了節點 ⇒ inbox 被蓋成 false
  const g = await call(ctx, "get-note", { id: onTrain });
  assert.equal(g.data.inbox, false);
  assert.deepEqual(g.data.attachedTo, { id: t.train.id, name: "N3 文法", kind: "列車" });

  const ids = async (nodeId: string) => (await call(ctx, "find-notes", { nodeId })).data.notes.map((n: { id: string }) => n.id).sort();
  assert.deepEqual(await ids(t.route.id), [onRoute, onTrain, onCar, onOther].sort());
  assert.deepEqual(await ids(t.train.id), [onTrain, onCar].sort());
  assert.deepEqual(await ids(t.car.id), [onCar]);
  assert.ok(!(await ids(t.route.id)).includes(loose));

  await rejects(call(ctx, "add-notes", { notes: [{ body: "x", nodeId: t.ticket.id }] }), /路線、支線、列車或車廂/);
  await rejects(call(ctx, "add-notes", { notes: [{ body: "x", nodeId: t.line.id }] }), /幹線/);
  await rejects(call(ctx, "add-notes", { notes: [{ body: "x", nodeId: "nope" }] }), /找不到節點/);
  await rejects(call(ctx, "find-notes", { nodeId: t.ticket.id }));
});

test("參數錯誤回 McpUserError，而且整批不寫", async () => {
  const ctx = await makeCtx();
  await rejects(call(ctx, "add-notes", { notes: [] }), /至少一筆/);
  await rejects(call(ctx, "add-notes", { notes: [{ body: "ok" }, {}] }), /notes\[1\] 的 body 與 title 至少要有一個/);
  await rejects(call(ctx, "add-notes", { notes: [{ body: "   ", title: "  " }] }), /至少要有一個/);
  await rejects(call(ctx, "add-notes", { notes: [{ body: 3 }] }), /要是字串/);
  await rejects(call(ctx, "add-notes", { notes: [{ body: "ok" }, { body: "x", tags: ["2026"] }] }), /notes\[1\]\.tags\[0\].*只有數字/);
  await rejects(call(ctx, "add-notes", { notes: [{ body: "x", tags: ["有 空白"] }] }), /空白/);
  await rejects(call(ctx, "add-notes", { notes: [{ body: "x", tags: ["ABC123"] }] }), /不會被當成荷札/);
  await rejects(call(ctx, "find-notes", { limit: 0 }));
  await rejects(call(ctx, "find-notes", { limit: 101 }));
  await rejects(call(ctx, "find-notes", { tag: "2026" }));
  await rejects(call(ctx, "get-note", {}), /缺少 id/);
  // 前面那筆合法的也沒有寫進去
  assert.equal((await call(ctx, "find-notes", {})).data.notes.length, 0);
});

test("陣列上限 50", async () => {
  const ctx = await makeCtx();
  const many = Array.from({ length: 51 }, (_, i) => ({ body: `第 ${i} 則` }));
  await rejects(call(ctx, "add-notes", { notes: many }), /最多 50 筆/);
  await rejects(call(ctx, "delete-notes", { ids: many.map((_, i) => `id${i}`) }), /最多 50 筆/);
  const ok = await call(ctx, "add-notes", { notes: many.slice(0, 50) });
  assert.equal(ok.data.created.length, 50);
});

test("find-notes 有上限並在摘要說截斷", async () => {
  const ctx = await makeCtx();
  await call(ctx, "add-notes", { notes: Array.from({ length: 5 }, (_, i) => ({ body: `n${i}` })) });
  const r = await call(ctx, "find-notes", { limit: 3 });
  assert.equal(r.data.notes.length, 3);
  assert.equal(r.data.truncated, true);
  assert.match(r.summary, /只列最新的 3 則/);
  // 新的在前
  assert.deepEqual(r.data.notes.map((n: { title: string }) => n.title), ["n4", "n3", "n2"]);
  const all = await call(ctx, "find-notes", { limit: 5 });
  assert.equal(all.data.truncated, undefined);
});

test("update-notes：標題、內文、荷札增減、整理出收件匣、掛與不掛", async () => {
  const ctx = await makeCtx();
  const t = await seedTree(ctx);
  const { data } = await call(ctx, "add-notes", {
    notes: [
      { title: "舊標題", body: "內容 #待查 #靈感" },
      { body: "收件匣的", inbox: true },
    ],
  });
  const [a, b] = data.created.map((c: { id: string }) => c.id);

  const out = await call(ctx, "update-notes", {
    notes: [
      { id: a, title: null, removeTags: ["待查"], addTags: ["已查"] },
      { id: b, inbox: false },
    ],
  });
  assert.deepEqual(out.changed, ["notes", "tags", "taggings"]);
  const ga = await call(ctx, "get-note", { id: a });
  assert.equal(ga.data.title, undefined);
  assert.equal(ga.data.body, "內容 #靈感\n\n#已查");
  assert.deepEqual((await ctx.deps.tagRepo.listTagsOf("note", a)).map((x) => x.name).sort(), ["已查", "靈感"].sort());
  assert.equal((await call(ctx, "get-note", { id: b })).data.inbox, false);

  // 換整份內文 ⇒ 荷札跟著內文重算
  await call(ctx, "update-notes", { notes: [{ id: a, body: "全部改掉" }] });
  assert.deepEqual(await ctx.deps.tagRepo.listTagsOf("note", a), []);

  // 掛上、拿掉
  await call(ctx, "update-notes", { notes: [{ id: a, nodeId: t.train.id }] });
  assert.equal((await call(ctx, "get-note", { id: a })).data.attachedTo.id, t.train.id);
  await rejects(call(ctx, "update-notes", { notes: [{ id: a, inbox: true }] }), /不能放回收件匣/);
  await call(ctx, "update-notes", { notes: [{ id: a, nodeId: null, inbox: true }] });
  const back = await call(ctx, "get-note", { id: a });
  assert.equal(back.data.attachedTo, undefined);
  assert.equal(back.data.inbox, true);
  // 收件匣的筆記掛上節點 ⇒ 存進筆記的家
  await call(ctx, "update-notes", { notes: [{ id: a, nodeId: t.car.id }] });
  assert.equal((await call(ctx, "get-note", { id: a })).data.inbox, false);

  // 只改標題 ⇒ 不動荷札表
  const onlyTitle = await call(ctx, "update-notes", { notes: [{ id: a, title: "新標題" }] });
  assert.deepEqual(onlyTitle.changed, ["notes"]);

  await rejects(call(ctx, "update-notes", { notes: [{ id: a }] }), /沒有要改的欄位/);
  await rejects(call(ctx, "update-notes", { notes: [{ id: a, removeTags: ["沒有這個"] }] }), /內文沒有荷札/);
  await rejects(call(ctx, "update-notes", { notes: [{ id: a, title: "x" }, { id: a, title: "y" }] }), /出現兩次/);
  await rejects(call(ctx, "update-notes", { notes: [{ id: a, title: "不該寫" }, { id: "nope", title: "x" }] }), /nope.*整批都沒有寫入/);
  assert.equal((await call(ctx, "get-note", { id: a })).data.title, "新標題");
});

test("delete-notes：軟刪除、找不到就整批不刪、App 可復原", async () => {
  const ctx = await makeCtx();
  const { data } = await call(ctx, "add-notes", { notes: [{ body: "一" }, { body: "二" }] });
  const [a, b] = data.created.map((c: { id: string }) => c.id);
  await rejects(call(ctx, "delete-notes", { ids: [a, "nope"] }), /找不到/);
  assert.equal((await call(ctx, "find-notes", {})).data.notes.length, 2);

  const out = await call(ctx, "delete-notes", { ids: [a, a] });
  assert.deepEqual(out.changed, ["notes"]);
  assert.equal(out.data.deleted.length, 1);
  await rejects(call(ctx, "get-note", { id: a }), /找不到/);
  assert.deepEqual((await call(ctx, "find-notes", {})).data.notes.map((n: { id: string }) => n.id), [b]);
  await rejects(call(ctx, "delete-notes", { ids: [a] }), /找不到/); // 已刪的再刪＝找不到
  await ctx.deps.noteRepo.restore([a]);
  assert.equal((await call(ctx, "get-note", { id: a })).data.body, "一");
});

test("跨 kind：日記的 id 對筆記工具一律是找不到；find-notes 不列日記", async () => {
  const ctx = await makeCtx();
  const diary = await ctx.deps.noteRepo.create({ kind: "diary", body: "今天的日記 #生活", inbox: false, entryDate: ctx.today });
  await ctx.deps.tagRepo.syncBodyTags(diary.id, diary.body);
  await rejects(call(ctx, "get-note", { id: diary.id }), /找不到/);
  await rejects(call(ctx, "update-notes", { notes: [{ id: diary.id, title: "x" }] }), /找不到/);
  await rejects(call(ctx, "delete-notes", { ids: [diary.id] }), /找不到/);
  assert.equal((await call(ctx, "find-notes", { query: "日記" })).data.notes.length, 0);
  assert.equal((await call(ctx, "find-notes", { tag: "生活" })).data.notes.length, 0);
  assert.equal((await ctx.deps.noteRepo.getNote(diary.id))?.deleted_at, null);
});

test("add-notes：只有標題也能建（同 UI：標題與內文都空才不建）；只給 tags 也算有內文", async () => {
  const ctx = await makeCtx();
  const out = await call(ctx, "add-notes", { notes: [{ title: "只有標題" }, { tags: ["靈感"] }] });
  const [a, b] = out.data.created.map((c: { id: string }) => c.id);
  const ga = await call(ctx, "get-note", { id: a });
  assert.equal(ga.data.title, "只有標題");
  assert.equal(ga.data.body, "");
  assert.equal((await call(ctx, "get-note", { id: b })).data.body, "#靈感");
});

test("荷札同步失敗不讓整個呼叫失敗（筆記已寫進去；同 tagStore.syncNoteTags 吞掉）", async () => {
  const ctx = await makeCtx();
  ctx.deps.tagRepo.syncBodyTags = async () => {
    throw new Error("模擬失敗");
  };
  const warn = console.warn;
  console.warn = () => {};
  try {
    const out = await call(ctx, "add-notes", { notes: [{ body: "有荷札 #靈感" }] });
    assert.deepEqual(out.changed, ["notes"]);
    assert.equal((await call(ctx, "get-note", { id: out.data.created[0].id })).data.body, "有荷札 #靈感");
    const up = await call(ctx, "update-notes", { notes: [{ id: out.data.created[0].id, body: "改過 #待查" }] });
    assert.deepEqual(up.changed, ["notes"]);
  } finally {
    console.warn = warn;
  }
});

test("clockOf：日界線之後的凌晨是營業日表記（≥ 24:00）", async () => {
  const { clockOf } = await load<typeof import("../../src/mcp/tools/notes.ts")>("../../src/mcp/tools/notes.ts");
  const iso = new Date(2026, 9, 25, 1, 30).toISOString(); // 10/25 01:30，日界線 06:00 ⇒ 屬 10/24
  assert.equal(clockOf(iso, "2026-10-24", 6), "25:30");
  assert.equal(clockOf(new Date(2026, 9, 24, 9, 5).toISOString(), "2026-10-24", 6), "09:05");
});
