/**
 * 排行程（src/mcp/tools/schedule.ts；契約 §4、§7）：propose 只算不寫（原本→提案、那天幾班、撞時刻）、
 * apply 照方案寫（等同 reschedule-tasks）、過期／被改過整個拒絕、一個方案只套一次、參數錯回 McpUserError。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { load, makeCtx } from "./mcp-ctx.ts";
import type { McpCtx } from "../../src/mcp/types.ts";

const { SCHEDULE_TOOLS } = await load<typeof import("../../src/mcp/tools/schedule.ts")>("../../src/mcp/tools/schedule.ts");
const { McpUserError, MCP_BATCH_LIMIT } = await load<typeof import("../../src/mcp/types.ts")>("../../src/mcp/types.ts");
const { addDays } = await load<typeof import("../../src/lib/date.ts")>("../../src/lib/date.ts");
const { fixedRule } = await load<typeof import("../../src/domain/repeat.ts")>("../../src/domain/repeat.ts");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function call(name: string, args: Record<string, unknown>, ctx: McpCtx): Promise<Any> {
  const t = SCHEDULE_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`沒有 ${name}`);
  return t.run(args, ctx);
}

const isUserError = (re?: RegExp) => (e: unknown) => {
  assert.ok(e instanceof McpUserError, `應是 McpUserError：${String(e)}`);
  if (re) assert.match((e as Error).message, re);
  return true;
};

async function seed(ctx: McpCtx) {
  const r = ctx.deps.nodeRepo;
  const tomorrow = addDays(ctx.today, 1);
  const a = await r.create({ kind: "ticket", name: "寫報告", parentId: null, scheduledOn: ctx.today });
  const b = await r.create({ kind: "ticket", name: "回信", parentId: null });
  const c = await r.create({ kind: "ticket", name: "整理桌面", parentId: null });
  // 明天 10:00 已經有一張
  const busy = await r.create({ kind: "ticket", name: "看牙醫", parentId: null, scheduledOn: tomorrow });
  await r.update(busy.id, { scheduled_time: "10:00" }, { dateKey: ctx.today, dayStartHour: ctx.dayStartHour });
  return { a, b, c, busy, tomorrow };
}

test("工具表：propose 讀、apply 寫且 destructive；module 都是 tasks", () => {
  const [p, ap] = SCHEDULE_TOOLS;
  assert.equal(p.name, "propose-schedule");
  assert.equal(p.access, "read");
  assert.equal(p.annotations.readOnlyHint, true);
  assert.equal(ap.name, "apply-schedule");
  assert.equal(ap.access, "write");
  assert.equal(ap.annotations.destructiveHint, true);
  for (const t of SCHEDULE_TOOLS) {
    assert.equal(t.module, "tasks");
    assert.ok(t.description.length <= 400);
  }
});

test("propose-schedule：只算不寫；原本→提案、那天幾班、撞時刻（含方案內互撞）", async () => {
  const ctx = await makeCtx();
  const s = await seed(ctx);
  const repo = ctx.deps.nodeRepo;
  const before = await Promise.all([s.a, s.b, s.c].map((n) => repo.getNode(n.id)));
  const o = await call(
    "propose-schedule",
    {
      items: [
        { taskId: s.a.id, date: s.tomorrow, time: "10:00" },
        { taskId: s.b.id, date: s.tomorrow, time: "10:00" },
        { taskId: s.c.id, date: addDays(ctx.today, 3) },
      ],
    },
    ctx,
  );
  assert.match(o.data.planId, /[0-9a-f-]{36}/);
  assert.equal(o.changed, undefined);
  const [ia, ib, ic] = o.data.items;
  assert.deepEqual(ia.from, { date: ctx.today });
  assert.deepEqual(ia.to, { date: s.tomorrow, time: "10:00" });
  assert.deepEqual(ia.clashes.map((x: Any) => x.name).sort(), ["回信", "看牙醫"].sort());
  assert.ok(ib.clashes.some((x: Any) => x.name === "寫報告" && x.inPlan));
  assert.equal(ic.clashes, undefined);
  assert.deepEqual(o.data.days, [
    { date: s.tomorrow, existing: 1, proposed: 2 },
    { date: addDays(ctx.today, 3), existing: 0, proposed: 1 },
  ]);
  assert.match(o.summary, /2 張撞時刻/);
  // 一個字都沒寫
  const after = await Promise.all([s.a, s.b, s.c].map((n) => repo.getNode(n.id)));
  assert.deepEqual(after, before);
});

test("apply-schedule：照方案寫入（繰越、時刻），之後讀得回來；同一個方案只套一次", async () => {
  const ctx = await makeCtx();
  const s = await seed(ctx);
  const repo = ctx.deps.nodeRepo;
  const p = await call(
    "propose-schedule",
    { items: [{ taskId: s.a.id, date: s.tomorrow, time: "13:00" }, { taskId: s.b.id, date: addDays(ctx.today, 2) }] },
    ctx,
  );
  const o = await call("apply-schedule", { planId: p.data.planId }, ctx);
  assert.equal(o.data.length, 2);
  assert.ok(o.data.every((r: Any) => r.ok));
  assert.deepEqual(o.changed, ["nodes", "work_logs"]);
  assert.match(o.toast, /2 張/);
  const a = (await repo.getNode(s.a.id))!;
  assert.equal(a.scheduled_on, s.tomorrow);
  assert.equal(a.scheduled_time, "13:00");
  assert.equal(a.carried_from, ctx.today);
  assert.equal((await repo.getNode(s.b.id))!.scheduled_on, addDays(ctx.today, 2));
  await assert.rejects(call("apply-schedule", { planId: p.data.planId }, ctx), isUserError(/找不到這個方案/));
});

test("apply-schedule：過 30 分鐘就過期（看 ctx.now）", async () => {
  const ctx = await makeCtx();
  const s = await seed(ctx);
  const p = await call("propose-schedule", { items: [{ taskId: s.b.id, date: s.tomorrow }] }, ctx);
  const late = { ...ctx, now: new Date(ctx.now.getTime() + 31 * 60_000) };
  await assert.rejects(call("apply-schedule", { planId: p.data.planId }, late), isUserError(/過期/));
  assert.equal((await ctx.deps.nodeRepo.getNode(s.b.id))!.scheduled_on, null);
  // 29 分鐘內照樣能套
  const p2 = await call("propose-schedule", { items: [{ taskId: s.b.id, date: s.tomorrow }] }, ctx);
  const soon = { ...ctx, now: new Date(ctx.now.getTime() + 29 * 60_000) };
  await call("apply-schedule", { planId: p2.data.planId }, soon);
  assert.equal((await ctx.deps.nodeRepo.getNode(s.b.id))!.scheduled_on, s.tomorrow);
});

test("apply-schedule：提案後有一張被改過（或刪掉）就整個拒絕，一張都不寫", async () => {
  const ctx = await makeCtx();
  const s = await seed(ctx);
  const repo = ctx.deps.nodeRepo;
  const p = await call(
    "propose-schedule",
    { items: [{ taskId: s.a.id, date: s.tomorrow }, { taskId: s.b.id, date: s.tomorrow }] },
    ctx,
  );
  await repo.update(s.b.id, { name: "回信（急）" }, { dateKey: ctx.today, dayStartHour: ctx.dayStartHour });
  await assert.rejects(call("apply-schedule", { planId: p.data.planId }, ctx), isUserError(/回信.*被改過/));
  assert.equal((await repo.getNode(s.a.id))!.scheduled_on, ctx.today);

  const p2 = await call("propose-schedule", { items: [{ taskId: s.c.id, date: s.tomorrow }] }, ctx);
  await repo.softDelete(s.c.id);
  await assert.rejects(call("apply-schedule", { planId: p2.data.planId }, ctx), isUserError(/被改過或刪掉/));
});

test("propose-schedule：參數錯回 McpUserError（過去、重複、null 日期、找不到、上限、定期券改日期）", async () => {
  const ctx = await makeCtx();
  const s = await seed(ctx);
  await assert.rejects(call("propose-schedule", { items: [{ taskId: s.a.id, date: addDays(ctx.today, -1) }] }, ctx), isUserError(/今天/));
  await assert.rejects(
    call("propose-schedule", { items: [{ taskId: s.a.id, date: s.tomorrow }, { taskId: s.a.id, date: s.tomorrow }] }, ctx),
    isUserError(/兩次/),
  );
  await assert.rejects(call("propose-schedule", { items: [{ taskId: s.a.id, date: null }] }, ctx), isUserError(/reschedule-tasks/));
  await assert.rejects(call("propose-schedule", { items: [{ taskId: "no-such", date: s.tomorrow }] }, ctx), isUserError(/找不到/));
  await assert.rejects(call("propose-schedule", { items: [{ taskId: s.a.id, date: s.tomorrow, time: "5:00" }] }, ctx), isUserError(/HH:MM/));
  const many = Array.from({ length: MCP_BATCH_LIMIT + 1 }, () => ({ taskId: s.a.id, date: s.tomorrow }));
  await assert.rejects(call("propose-schedule", { items: many }, ctx), isUserError(/最多 50 筆/));
  await assert.rejects(call("apply-schedule", {}, ctx), isUserError(/planId/));

  const repo = ctx.deps.nodeRepo;
  const run = await repo.create({ kind: "ticket", name: "晨跑", parentId: null });
  await repo.setRepeatRule(run.id, fixedRule("daily", ctx.today), ctx.today, ctx.dayStartHour);
  await assert.rejects(call("propose-schedule", { items: [{ taskId: run.id, date: s.tomorrow }] }, ctx), isUserError(/定期券/));
  // 定期券帶目前班次日＝只改這一班的時刻（setRunTime），明天那班不受影響
  const p = await call("propose-schedule", { items: [{ taskId: run.id, date: ctx.today, time: "07:15" }] }, ctx);
  await call("apply-schedule", { planId: p.data.planId }, ctx);
  const cal = await repo.listCalendar(ctx.today, s.tomorrow, { todayDateKey: ctx.today, dayStartHour: ctx.dayStartHour });
  assert.deepEqual(
    cal.entries.filter((e) => e.node_id === run.id).map((e) => e.time),
    ["07:15", null],
  );
});

test("propose-schedule：已済的票不能排；不認得的欄位回錯", async () => {
  const ctx = await makeCtx();
  const s = await seed(ctx);
  await ctx.deps.nodeRepo.setCompleted(s.a.id, true, { dateKey: ctx.today, dayStartHour: ctx.dayStartHour });
  await assert.rejects(call("propose-schedule", { items: [{ taskId: s.a.id, date: s.tomorrow }] }, ctx), isUserError(/已済/));
  await assert.rejects(call("propose-schedule", { items: [{ id: s.b.id, date: s.tomorrow }] }, ctx), isUserError(/items\[0\] 不認得的欄位：id/));
});

test("apply-schedule：同一毫秒內改過也抓得到（比排程欄位，不只比 updated_at）", async () => {
  const ctx = await makeCtx();
  const s = await seed(ctx);
  const repo = ctx.deps.nodeRepo;
  const p = await call("propose-schedule", { items: [{ taskId: s.b.id, date: s.tomorrow }] }, ctx);
  // 模擬「提案後別處把它排到了後天」但時戳沒前進（同毫秒）
  const before = (await repo.getNode(s.b.id))!;
  await repo.reschedule(s.b.id, addDays(ctx.today, 2), ctx.today);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (repo as any).nodes.set(s.b.id, { ...(repo as any).nodes.get(s.b.id), updated_at: before.updated_at });
  await assert.rejects(call("apply-schedule", { planId: p.data.planId }, ctx), isUserError(/被改過/));
  assert.equal((await repo.getNode(s.b.id))!.scheduled_on, addDays(ctx.today, 2));
});
