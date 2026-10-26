/** MCP 時刻表工具（`src/mcp/tools/timetable.ts`）：memory repository 跑讀寫、參數錯、陣列上限、長塊確認。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { load, makeCtx } from "./mcp-ctx.ts";
import type { McpCtx, McpTool } from "../../src/mcp/types.ts";

const { TIMETABLE_TOOLS } = await load<typeof import("../../src/mcp/tools/timetable.ts")>("../../src/mcp/tools/timetable.ts");
const { McpUserError } = await load<typeof import("../../src/mcp/types.ts")>("../../src/mcp/types.ts");
const { addDays } = await load<typeof import("../../src/lib/date.ts")>("../../src/lib/date.ts");

const MIN = 60_000;
const HOUR = 60 * MIN;
const tool = (name: string): McpTool => {
  const t = TIMETABLE_TOOLS.find((x) => x.name === name);
  assert.ok(t, name);
  return t;
};
const call = (name: string, args: Record<string, unknown>, ctx: McpCtx) => tool(name).run(args, ctx);
const pad2 = (n: number): string => String(n).padStart(2, "0");
/** ms → 本地 'YYYY-MM-DDTHH:MM' */
const local = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
/** 現在往前 h 小時、對齊到分 */
const ago = (ctx: McpCtx, h: number): number => Math.floor((ctx.now.getTime() - h * HOUR) / MIN) * MIN;
const userError = (re?: RegExp) => (e: unknown) => e instanceof McpUserError && (!re || re.test(e.message));

type BlockView = { id: string; categoryId: string; category: string; group?: string; start: string; end: string | null; minutes: number; running?: true; pending?: true; task?: { id: string; name?: string } };

async function setup(opts: Parameters<typeof makeCtx>[0] = {}) {
  const ctx = await makeCtx(opts);
  const repo = ctx.deps.timetableRepo;
  const g = await repo.createCategory({ parentId: null, name: "學習", colorIdx: 1, defaultMin: null });
  const read = await repo.createCategory({ parentId: g.id, name: "讀書", colorIdx: 1, defaultMin: null });
  const code = await repo.createCategory({ parentId: g.id, name: "寫程式", colorIdx: 2, defaultMin: 60 });
  const old = await repo.createCategory({ parentId: g.id, name: "舊分類", colorIdx: 3, defaultMin: null });
  await repo.updateCategory(old.id, { archived: true });
  return { ctx, repo, group: g.id, read: read.id, code: code.id, old: old.id };
}

const range = (ctx: McpCtx) => ({ from: addDays(ctx.today, -3), to: ctx.today });
async function blocksOf(ctx: McpCtx): Promise<BlockView[]> {
  return ((await call("find-time-blocks", range(ctx), ctx)).data as { blocks: BlockView[] }).blocks;
}

test("工具 spec：命名、模組、權限、annotations、描述長度", () => {
  assert.equal(TIMETABLE_TOOLS.length, 8);
  for (const t of TIMETABLE_TOOLS) {
    assert.match(t.name, /^[a-z]+(-[a-z]+)+$/);
    assert.equal(t.module, "timetable");
    assert.ok(t.description.length <= 400, `${t.name} 描述 ${t.description.length} 字`);
    assert.equal(t.annotations.openWorldHint, false);
    const read = t.name.startsWith("find-") || t.name.startsWith("get-");
    assert.equal(t.access, read ? "read" : "write");
    assert.equal(t.annotations.readOnlyHint, read);
    assert.equal(t.annotations.destructiveHint, /^(update|stop|delete)-/.test(t.name), t.name);
  }
});

test("find-time-categories：分類樹，預設不列封存", async () => {
  const { ctx, old } = await setup();
  const r = await call("find-time-categories", {}, ctx);
  const groups = (r.data as { groups: { name: string; categories: { id: string; name: string; defaultMin?: number }[] }[] }).groups;
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].categories.map((c) => c.name), ["讀書", "寫程式"]);
  assert.equal(groups[0].categories[1].defaultMin, 60);
  const all = await call("find-time-categories", { includeArchived: true }, ctx);
  const cats = (all.data as { groups: { categories: { id: string; archived?: boolean }[] }[] }).groups[0].categories;
  assert.equal(cats.find((c) => c.id === old)?.archived, true);
  await assert.rejects(call("find-time-categories", { includeArchived: "yes" }, ctx), userError());
});

test("add-time-blocks：補記、讀得回來、蓋到既有的會回報", async () => {
  const { ctx, read, code } = await setup();
  const r = await call(
    "add-time-blocks",
    {
      blocks: [
        { categoryId: read, start: local(ago(ctx, 5)), end: local(ago(ctx, 4)) },
        { categoryId: code, start: local(ago(ctx, 3)), end: local(ago(ctx, 2)) },
      ],
    },
    ctx,
  );
  assert.deepEqual(r.changed, ["time_blocks"]);
  assert.ok(r.toast?.includes("2"));
  let blocks = await blocksOf(ctx);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].category, "讀書");
  assert.equal(blocks[0].group, "學習");
  assert.equal(blocks[0].minutes, 60);
  assert.equal(blocks[0].start, local(ago(ctx, 5)));
  assert.equal(blocks[1].end, local(ago(ctx, 2)));

  // 蓋到讀書那塊的後半 ⇒ 縮短 1 塊
  const cover = await call("add-time-blocks", { blocks: [{ categoryId: code, start: local(ago(ctx, 4.5)), end: local(ago(ctx, 3.5)) }] }, ctx);
  assert.deepEqual(cover.data && (cover.data as { covered: unknown }).covered, { removed: 0, shortened: 1, splitCount: 0 });
  assert.match(cover.summary, /縮短 1 塊/);
  blocks = await blocksOf(ctx);
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].minutes, 30);
});

test("add-time-blocks：參數錯一律 McpUserError、一筆都不寫", async () => {
  const { ctx, read, group, old } = await setup();
  const ok = { categoryId: read, start: local(ago(ctx, 3)), end: local(ago(ctx, 2)) };
  const bad = async (blocks: unknown, re?: RegExp) => assert.rejects(call("add-time-blocks", { blocks }, ctx), userError(re));
  await bad([ok, { ...ok, start: "2026/10/25 14:00" }], /YYYY-MM-DDTHH:MM/);
  await bad([ok, { ...ok, start: "2026-02-30T10:00" }], /YYYY-MM-DDTHH:MM/);
  await bad([{ ...ok, categoryId: group }], /分組/);
  await bad([{ ...ok, categoryId: old }], /封存/);
  await bad([{ ...ok, categoryId: "nope" }], /找不到/);
  await bad([{ ...ok, end: ok.start }], /晚於/);
  await bad([{ ...ok, end: local(ctx.now.getTime() + HOUR) }], /未來/);
  await bad([], /至少一筆/);
  await bad(Array.from({ length: 51 }, () => ok), /最多 50/);
  await bad([{ categoryId: read }], /缺少/);
  assert.equal((await blocksOf(ctx)).length, 0);
  // 50 筆剛好可以
  const fifty = Array.from({ length: 50 }, (_, i) => ({ categoryId: read, start: local(ago(ctx, 60 - i)), end: local(ago(ctx, 60 - i) + 30 * MIN) }));
  const r = await call("add-time-blocks", { blocks: fifty }, ctx);
  assert.match(r.summary, /50 塊/);
});

test("add-time-blocks：超過 12 小時要 confirmLong，確認過的記成已確認", async () => {
  const { ctx, read } = await setup();
  const long = { categoryId: read, start: local(ago(ctx, 30)), end: local(ago(ctx, 15)) };
  await assert.rejects(call("add-time-blocks", { blocks: [long] }, ctx), userError(/12 小時.*confirmLong/));
  await call("add-time-blocks", { blocks: [{ ...long, confirmLong: true }] }, ctx);
  const r = await call("find-time-blocks", { from: addDays(ctx.today, -3), to: ctx.today }, ctx);
  const [b] = (r.data as { blocks: BlockView[] }).blocks;
  assert.equal(b.minutes, 15 * 60);
  assert.equal(b.pending, undefined); // 15h > 全域 14h，但 ack 了
});

test("start-time-block／stop-time-block：発車、換車、同一班不重發、到着", async () => {
  const { ctx, read, code } = await setup();
  const s1 = await call("start-time-block", { categoryId: read, at: local(ago(ctx, 1)) }, ctx);
  assert.deepEqual(s1.changed, ["time_blocks"]);
  assert.equal((s1.data as { block: BlockView }).block.running, true);

  const same = await call("start-time-block", { categoryId: read }, ctx);
  assert.equal(same.changed, undefined);
  assert.match(same.summary, /已經在跑了/);

  const s2 = await call("start-time-block", { categoryId: code, at: local(ago(ctx, 0.5)) }, ctx);
  const prev = (s2.data as { previous?: BlockView }).previous;
  assert.equal(prev?.category, "讀書");
  assert.equal(prev?.end, local(ago(ctx, 0.5)));
  assert.match(s2.summary, /到着/);

  const stop = await call("stop-time-block", {}, ctx);
  assert.deepEqual(stop.changed, ["time_blocks"]);
  assert.equal((stop.data as { block: BlockView }).block.category, "寫程式");
  assert.equal((await ctx.deps.timetableRepo.listRunning()).length, 0);

  const none = await call("stop-time-block", {}, ctx);
  assert.equal(none.changed, undefined);
  assert.match(none.summary, /沒有運行中/);
});

test("start-time-block：參數錯", async () => {
  const { ctx, read, group } = await setup();
  await assert.rejects(call("start-time-block", {}, ctx), userError(/categoryId/));
  await assert.rejects(call("start-time-block", { categoryId: group }, ctx), userError(/分組/));
  await assert.rejects(call("start-time-block", { categoryId: read, at: local(ctx.now.getTime() + 2 * HOUR) }, ctx), userError(/晚於現在/));
  await assert.rejects(call("start-time-block", { categoryId: read, estimateMin: 0 }, ctx), userError());
  assert.equal((await ctx.deps.timetableRepo.listRunning()).length, 0);
});

test("start-time-block：taskId 沿用車票上次的分類；任務關著不認車票", async () => {
  const { ctx, code } = await setup();
  const t = await ctx.deps.nodeRepo.create({ kind: "ticket", name: "寫報告", parentId: null });
  await assert.rejects(call("start-time-block", { taskId: t.id }, ctx), userError(/還沒記過時間/));
  await call("add-time-blocks", { blocks: [{ categoryId: code, start: local(ago(ctx, 3)), end: local(ago(ctx, 2)), taskId: t.id }] }, ctx);
  const r = await call("start-time-block", { taskId: t.id }, ctx);
  const b = (r.data as { block: BlockView }).block;
  assert.equal(b.categoryId, code);
  assert.deepEqual(b.task, { id: t.id, name: "寫報告" });
  await assert.rejects(call("start-time-block", { taskId: "nope" }, ctx), userError(/找不到這張車票/));

  const off = await setup({ access: { tasks: "off" } });
  await assert.rejects(call("start-time-block", { categoryId: off.code, taskId: t.id }, off.ctx), userError(/開放「任務」/));
});

test("運行太久：発車／到着前要確認；給 at＝結束在那一刻", async () => {
  const { ctx, read, code } = await setup();
  await call("start-time-block", { categoryId: read, at: local(ago(ctx, 20)) }, ctx); // 20h > 全域 14h
  let blocks = await blocksOf(ctx);
  assert.equal(blocks.at(-1)?.pending, true);
  await assert.rejects(call("start-time-block", { categoryId: code }, ctx), userError(/跑了 20 小時.*confirmLong/));
  await assert.rejects(call("stop-time-block", {}, ctx), userError(/stop-time-block 帶 at/));
  const stop = await call("stop-time-block", { at: local(ago(ctx, 12)) }, ctx);
  const b = (stop.data as { block: BlockView }).block;
  assert.equal(b.end, local(ago(ctx, 12)));
  assert.equal(b.minutes, 8 * 60);
  blocks = await blocksOf(ctx);
  assert.equal(blocks.at(-1)?.pending, undefined);
  await assert.rejects(call("stop-time-block", { at: "x" }, ctx), userError(/YYYY-MM-DDTHH:MM/));

  // confirmLong：長度沒錯 ⇒ 記成已確認再換車
  const keep = await setup();
  await call("start-time-block", { categoryId: keep.read, at: local(ago(keep.ctx, 16)) }, keep.ctx);
  const s = await call("start-time-block", { categoryId: keep.code, confirmLong: true }, keep.ctx);
  const prev = (s.data as { previous?: BlockView }).previous;
  assert.equal(prev?.category, "讀書");
  assert.equal(prev?.pending, undefined);
});

test("stop-time-block：at 早於発車回錯", async () => {
  const { ctx, read } = await setup();
  await call("start-time-block", { categoryId: read, at: local(ago(ctx, 1)) }, ctx);
  await assert.rejects(call("stop-time-block", { at: local(ago(ctx, 2)) }, ctx), userError(/早於/));
  await assert.rejects(call("stop-time-block", { at: local(ctx.now.getTime() + HOUR) }, ctx), userError(/晚於現在/));
});

test("update-time-blocks：改分類與起訖、運行中那班只改分類／開始", async () => {
  const { ctx, read, code, old } = await setup();
  await call("add-time-blocks", { blocks: [{ categoryId: read, start: local(ago(ctx, 5)), end: local(ago(ctx, 4)) }] }, ctx);
  const [b] = await blocksOf(ctx);
  const r = await call("update-time-blocks", { blocks: [{ id: b.id, categoryId: code, end: local(ago(ctx, 3)) }] }, ctx);
  assert.deepEqual(r.changed, ["time_blocks"]);
  const [b2] = await blocksOf(ctx);
  assert.equal(b2.id, b.id);
  assert.equal(b2.category, "寫程式");
  assert.equal(b2.minutes, 120);

  await call("start-time-block", { categoryId: read, at: local(ago(ctx, 1)) }, ctx);
  const run = (await blocksOf(ctx)).find((x) => x.running)!;
  await call("update-time-blocks", { blocks: [{ id: run.id, categoryId: code }] }, ctx);
  const run2 = (await blocksOf(ctx)).find((x) => x.running)!;
  assert.equal(run2.category, "寫程式");
  assert.equal(run2.start, run.start);

  const bad = async (blocks: unknown, re: RegExp) => assert.rejects(call("update-time-blocks", { blocks }, ctx), userError(re));
  await bad([{ id: run.id, end: local(ago(ctx, 0.5)) }], /stop-time-block/);
  await bad([{ id: "nope", categoryId: code }], /找不到/);
  await bad([{ id: b.id }], /至少要給/);
  await bad([{ id: b.id, categoryId: old }], /封存/);
  await bad([{ id: b.id, start: local(ago(ctx, 2)) }], /晚於開始/);
  await bad([{ id: b.id, start: local(ago(ctx, 20)) }], /12 小時/);
  await bad(Array.from({ length: 51 }, () => ({ id: b.id, categoryId: code })), /最多 50/);
  const ok = await call("update-time-blocks", { blocks: [{ id: b.id, start: local(ago(ctx, 20)), confirmLong: true }] }, ctx);
  assert.match(ok.summary, /改了 1 塊/);
  const [b3] = await blocksOf(ctx);
  assert.equal(b3.minutes, 17 * 60);
  assert.equal(b3.pending, undefined);
});

test("delete-time-blocks：軟刪除、運行中的不能刪", async () => {
  const { ctx, read } = await setup();
  await call("add-time-blocks", { blocks: [{ categoryId: read, start: local(ago(ctx, 5)), end: local(ago(ctx, 4)) }] }, ctx);
  const [b] = await blocksOf(ctx);
  await call("start-time-block", { categoryId: read, at: local(ago(ctx, 1)) }, ctx);
  const run = (await blocksOf(ctx)).find((x) => x.running)!;
  await assert.rejects(call("delete-time-blocks", { ids: [b.id, run.id] }, ctx), userError(/運行中/));
  await assert.rejects(call("delete-time-blocks", { ids: ["nope"] }, ctx), userError(/找不到/));
  await assert.rejects(call("delete-time-blocks", { ids: [] }, ctx), userError());
  await assert.rejects(call("delete-time-blocks", { ids: Array.from({ length: 51 }, () => b.id) }, ctx), userError(/最多 50/));
  assert.equal((await blocksOf(ctx)).length, 2);
  const r = await call("delete-time-blocks", { ids: [b.id] }, ctx);
  assert.deepEqual(r.changed, ["time_blocks"]);
  assert.deepEqual((await blocksOf(ctx)).map((x) => x.id), [run.id]);
  assert.ok(await ctx.deps.timetableRepo.getBlock(b.id, { withDeleted: true })); // 軟刪除：列還在
  await assert.rejects(call("delete-time-blocks", { ids: [b.id] }, ctx), userError(/找不到/));
});

test("find-time-blocks：區間檢查、任務關著只給車票 id", async () => {
  const { ctx, code } = await setup({ access: { tasks: "off" } });
  await assert.rejects(call("find-time-blocks", { from: "2026-01-01", to: "2026-03-01" }, ctx), userError(/31 天/));
  await assert.rejects(call("find-time-blocks", { from: ctx.today, to: addDays(ctx.today, -1) }, ctx), userError(/晚於/));
  await assert.rejects(call("find-time-blocks", {}, ctx), userError(/from/));
  const t = await ctx.deps.nodeRepo.create({ kind: "ticket", name: "寫報告", parentId: null });
  await ctx.deps.timetableRepo.fill(code, new Date(ago(ctx, 3)).toISOString(), new Date(ago(ctx, 2)).toISOString(), { link: { nodeId: t.id, routeId: null } });
  const [b] = await blocksOf(ctx);
  assert.deepEqual(b.task, { id: t.id });
  const one = await call("find-time-blocks", { from: ctx.today }, ctx);
  assert.match(one.summary, new RegExp(`^${ctx.today} 共`));
});

test("get-time-stats：各分類合計、碎塊不算、待確認另計", async () => {
  const { ctx, read, code } = await setup();
  await call(
    "add-time-blocks",
    {
      blocks: [
        { categoryId: read, start: local(ago(ctx, 40)), end: local(ago(ctx, 39)) },
        { categoryId: code, start: local(ago(ctx, 38)), end: local(ago(ctx, 36)) },
        { categoryId: read, start: local(ago(ctx, 35)), end: local(ago(ctx, 34.5)) },
      ],
    },
    ctx,
  );
  // 待確認：直接用 repository 補一塊 16h 沒 ack 的（工具會要 confirmLong 並記成已確認）
  await ctx.deps.timetableRepo.fill(read, new Date(ago(ctx, 33)).toISOString(), new Date(ago(ctx, 17)).toISOString());
  // 碎塊：30 秒
  const t0 = ago(ctx, 10);
  await ctx.deps.timetableRepo.fill(code, new Date(t0).toISOString(), new Date(t0 + 30_000).toISOString());
  const r = await call("get-time-stats", { from: addDays(ctx.today, -3), to: ctx.today }, ctx);
  const d = r.data as {
    recordedMinutes: number;
    pending: { count: number; minutes: number };
    groups: { name: string; minutes: number }[];
    categories: { name: string; group?: string; minutes: number }[];
  };
  assert.equal(d.recordedMinutes, 210);
  assert.deepEqual(d.pending, { count: 1, minutes: 16 * 60 });
  assert.deepEqual(d.categories.map((c) => [c.name, c.minutes]), [["寫程式", 120], ["讀書", 90]]);
  assert.equal(d.categories[0].group, "學習");
  assert.deepEqual(d.groups, [{ id: d.groups[0] && (d.groups[0] as { id: string }).id, name: "學習", minutes: 210 }]);
  assert.match(r.summary, /1 塊待確認/);
  await assert.rejects(call("get-time-stats", { from: "2026-01-01", to: "2026-12-31" }, ctx), userError(/92 天/));
});

/* ───────── 反方評審補的 ───────── */

test("時刻輸入：也收營業日寫法（前一天的 25:30＝隔天 01:30）；超出範圍回錯", async () => {
  const { ctx, read } = await setup();
  const t = ago(ctx, 3);
  const d = new Date(t);
  const prev = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1);
  const biz = `${prev.getFullYear()}-${pad2(prev.getMonth() + 1)}-${pad2(prev.getDate())}T${pad2(d.getHours() + 24)}:${pad2(d.getMinutes())}`;
  await call("add-time-blocks", { blocks: [{ categoryId: read, start: biz, end: local(t + HOUR) }] }, ctx);
  const [b] = await blocksOf(ctx);
  assert.equal(b.start, local(t));
  assert.equal(b.minutes, 60);
  const bad = async (start: string) =>
    assert.rejects(call("add-time-blocks", { blocks: [{ categoryId: read, start, end: local(t + HOUR) }] }, ctx), userError(/YYYY-MM-DDTHH:MM/));
  await bad("2026-10-24T48:00");
  await bad("2026-10-24T23:60");
  await bad("2026-02-30T25:00");
});

test("add／update：不到 1 分鐘回錯（＝BlockPanel 結束夾在開始+1 分）", async () => {
  const { ctx, read } = await setup();
  const t = ago(ctx, 2);
  await assert.rejects(
    call("add-time-blocks", { blocks: [{ categoryId: read, start: new Date(t).toISOString(), end: new Date(t + 30_000).toISOString() }] }, ctx),
    userError(/1 分鐘/),
  );
  await call("add-time-blocks", { blocks: [{ categoryId: read, start: local(t), end: local(t + HOUR) }] }, ctx);
  const [b] = await blocksOf(ctx);
  await assert.rejects(call("update-time-blocks", { blocks: [{ id: b.id, end: new Date(t + 20_000).toISOString() }] }, ctx), userError(/1 分鐘/));
});

test("start-time-block：已經在跑的判定照 UI 三條路（tapCategory／DepartPanel／departFromTask）", async () => {
  const { ctx, read, code } = await setup();
  const t = await ctx.deps.nodeRepo.create({ kind: "ticket", name: "寫報告", parentId: null });
  const t2 = await ctx.deps.nodeRepo.create({ kind: "ticket", name: "改講稿", parentId: null });
  await call("start-time-block", { categoryId: read, taskId: t.id, at: local(ago(ctx, 2)) }, ctx);
  // tapCategory：只給分類、同分類 ⇒ 在跑
  assert.equal((await call("start-time-block", { categoryId: read }, ctx)).changed, undefined);
  // departFromTask：只給車票、同一張 ⇒ 在跑（不先查上次的分類）
  assert.equal((await call("start-time-block", { taskId: t.id }, ctx)).changed, undefined);
  // DepartPanel：同分類、換了一張票 ⇒ 照發
  const s1 = await call("start-time-block", { categoryId: read, taskId: t2.id, at: local(ago(ctx, 1.5)) }, ctx);
  assert.deepEqual(s1.changed, ["time_blocks"]);
  // DepartPanel：同一張票、換了分類 ⇒ 照發
  const s2 = await call("start-time-block", { categoryId: code, taskId: t2.id, at: local(ago(ctx, 1)) }, ctx);
  assert.deepEqual(s2.changed, ["time_blocks"]);
  const run = (await blocksOf(ctx)).find((x) => x.running)!;
  assert.equal(run.category, "寫程式");
  assert.equal(run.task?.id, t2.id);
  // 同分類同一張 ⇒ 在跑
  assert.equal((await call("start-time-block", { categoryId: code, taskId: t2.id }, ctx)).changed, undefined);
});

test("update-time-blocks：運行中那班 start 最多往前 24 小時", async () => {
  const { ctx, read } = await setup();
  await call("start-time-block", { categoryId: read, at: local(ago(ctx, 1)) }, ctx);
  const run = (await blocksOf(ctx)).find((x) => x.running)!;
  await assert.rejects(call("update-time-blocks", { blocks: [{ id: run.id, start: local(ago(ctx, 26)), confirmLong: true }] }, ctx), userError(/24 小時/));
  await assert.rejects(call("update-time-blocks", { blocks: [{ id: run.id, start: local(ago(ctx, 20)) }] }, ctx), userError(/12 小時/));
  await call("update-time-blocks", { blocks: [{ id: run.id, start: local(ago(ctx, 20)), confirmLong: true }] }, ctx);
  const run2 = (await blocksOf(ctx)).find((x) => x.running)!;
  assert.equal(run2.start, local(ago(ctx, 20)));
});

test("update-time-blocks：剛到着（到着晚於 ctx.now）的那塊照樣能改分類", async () => {
  const { ctx, read, code } = await setup({ now: new Date(Date.now() - 5 * MIN) });
  await call("start-time-block", { categoryId: read, at: local(ago(ctx, 1)) }, ctx);
  await ctx.deps.timetableRepo.arrive(); // repository 用真的現在 ⇒ 比 ctx.now 晚 5 分
  const [b] = await blocksOf(ctx);
  const r = await call("update-time-blocks", { blocks: [{ id: b.id, categoryId: code }] }, ctx);
  assert.match(r.summary, /改了 1 塊/);
  assert.equal((await blocksOf(ctx))[0].category, "寫程式");
});

test("update-time-blocks：照 find 的輸出回填沒改的起訖（秒被取整）＝沒動，不重問長塊、不挪秒", async () => {
  const { ctx, repo, read, code } = await setup();
  const t0 = ago(ctx, 20) + 20_000;
  await repo.fill(code, new Date(t0).toISOString(), new Date(t0 + 13 * HOUR).toISOString(), { ack: true });
  const [b] = await blocksOf(ctx);
  await call("update-time-blocks", { blocks: [{ id: b.id, categoryId: read, start: b.start, end: b.end! }] }, ctx);
  const row = await repo.getBlock(b.id);
  assert.equal(row?.category_id, read);
  assert.equal(new Date(row!.started_at).getTime(), t0);
  assert.equal(new Date(row!.ended_at!).getTime(), t0 + 13 * HOUR);
});

test("delete-time-blocks：重複的 id 只刪一次，錯誤位置照原陣列", async () => {
  const { ctx, read } = await setup();
  await call("add-time-blocks", { blocks: [{ categoryId: read, start: local(ago(ctx, 5)), end: local(ago(ctx, 4)) }] }, ctx);
  const [b] = await blocksOf(ctx);
  await assert.rejects(call("delete-time-blocks", { ids: [b.id, b.id, "nope"] }, ctx), userError(/ids\[2\]/));
  const r = await call("delete-time-blocks", { ids: [b.id, b.id] }, ctx);
  assert.match(r.summary, /1 塊/);
});
