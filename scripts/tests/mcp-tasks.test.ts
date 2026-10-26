/**
 * 任務模組的 MCP 工具（src/mcp/tools/tasks.ts；契約 §4、§7）：memory repository 跑每支工具的正常路徑、
 * 參數錯回 McpUserError、寫入後讀得回來、陣列上限、跨模組 id 當找不到、UI 規則（cascade 要明說、推遲挑不到過去、定期券不改期）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { load, makeCtx } from "./mcp-ctx.ts";
import type { McpCtx } from "../../src/mcp/types.ts";

const { TASK_TOOLS } = await load<typeof import("../../src/mcp/tools/tasks.ts")>("../../src/mcp/tools/tasks.ts");
const { McpUserError, MCP_BATCH_LIMIT } = await load<typeof import("../../src/mcp/types.ts")>("../../src/mcp/types.ts");
const { addDays } = await load<typeof import("../../src/lib/date.ts")>("../../src/lib/date.ts");
const { fixedRule } = await load<typeof import("../../src/domain/repeat.ts")>("../../src/domain/repeat.ts");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function call(name: string, args: Record<string, unknown>, ctx: McpCtx): Promise<Any> {
  const t = TASK_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`沒有 ${name}`);
  return t.run(args, ctx);
}

const isUserError = (re?: RegExp) => (e: unknown) => {
  assert.ok(e instanceof McpUserError, `應是 McpUserError：${String(e)}`);
  if (re) assert.match((e as Error).message, re);
  return true;
};

/** 幹線→路線→列車→兩張車票，外加一張根層臨時車票 */
async function seed(ctx: McpCtx) {
  const r = ctx.deps.nodeRepo;
  const line = await r.create({ kind: "line", name: "本線", parentId: null });
  const route = await r.create({ kind: "route", name: "引越し", parentId: line.id });
  const train = await r.create({ kind: "train", name: "荷造り", parentId: route.id });
  const t1 = await r.create({ kind: "ticket", name: "箱を買う", parentId: train.id, scheduledOn: ctx.today });
  const t2 = await r.create({ kind: "ticket", name: "本を詰める", parentId: train.id });
  const loose = await r.create({ kind: "ticket", name: "牛乳", parentId: null });
  return { line, route, train, t1, t2, loose };
}

async function repeatTicket(ctx: McpCtx, name = "晨跑") {
  const r = ctx.deps.nodeRepo;
  const n = await r.create({ kind: "ticket", name, parentId: null });
  await r.setRepeatRule(n.id, fixedRule("daily", ctx.today), ctx.today, ctx.dayStartHour);
  return (await r.getNode(n.id))!;
}

test("工具表：11 支、module 都是 tasks、描述 ≤ 400 字、讀寫 annotations 對", () => {
  assert.equal(TASK_TOOLS.length, 11);
  for (const t of TASK_TOOLS) {
    assert.equal(t.module, "tasks");
    assert.ok(t.description.length <= 400, `${t.name} ${t.description.length}`);
    assert.equal(t.annotations.readOnlyHint, t.access === "read", t.name);
  }
});

test("find-routes：幹線底下的路線與進度", async () => {
  const ctx = await makeCtx();
  const s = await seed(ctx);
  await ctx.deps.nodeRepo.setCompleted(s.t1.id, true, { dateKey: ctx.today, dayStartHour: ctx.dayStartHour });
  const o = await call("find-routes", {}, ctx);
  assert.equal(o.data.length, 1);
  assert.equal(o.data[0].name, "本線");
  assert.deepEqual(o.data[0].routes[0], { id: s.route.id, name: "引越し", tasks: "1/3" });
});

test("find-tasks：關鍵字、路線、狀態、收件匣；什麼都沒給回錯", async () => {
  const ctx = await makeCtx();
  const s = await seed(ctx);
  const byQuery = await call("find-tasks", { query: "箱" }, ctx);
  assert.deepEqual(byQuery.data.map((x: Any) => x.id), [s.t1.id]);
  assert.equal(byQuery.data[0].route, "引越し");
  assert.equal(byQuery.data[0].hlc, undefined);
  assert.equal(byQuery.data[0].updated_at, undefined);

  const byRoute = await call("find-tasks", { routeId: s.route.id }, ctx);
  assert.equal(byRoute.data.length, 3); // 列車＋兩張票

  await ctx.deps.nodeRepo.setCompleted(s.t2.id, true, { dateKey: ctx.today, dayStartHour: ctx.dayStartHour });
  const open = await call("find-tasks", { routeId: s.route.id, status: "open" }, ctx);
  assert.deepEqual(open.data.map((x: Any) => x.name).sort(), ["箱を買う", "荷造り"].sort());
  const inbox = await call("find-tasks", { inbox: true }, ctx);
  assert.deepEqual(inbox.data.map((x: Any) => x.id), [s.loose.id]);

  await assert.rejects(call("find-tasks", {}, ctx), isUserError(/至少/));
  await assert.rejects(call("find-tasks", { status: "壞" , inbox: true }, ctx), isUserError(/status/));
  await assert.rejects(call("find-tasks", { routeId: s.t1.id }, ctx), isUserError(/找不到路線/));
});

test("find-tasks-by-date：區間每天的班次＋今天的誤點；區間太長回錯", async () => {
  const ctx = await makeCtx();
  const s = await seed(ctx);
  const r = ctx.deps.nodeRepo;
  const late = await r.create({ kind: "ticket", name: "昨天的票", parentId: null, scheduledOn: addDays(ctx.today, -1) });
  await r.update(s.t2.id, { due_on: addDays(ctx.today, 2) }, { dateKey: ctx.today, dayStartHour: ctx.dayStartHour });
  const run = await repeatTicket(ctx);

  const o = await call("find-tasks-by-date", { from: ctx.today, to: addDays(ctx.today, 2) }, ctx);
  const day0 = o.data.days.find((d: Any) => d.date === ctx.today);
  assert.ok(day0.tasks.some((t: Any) => t.id === s.t1.id && t.status === "open"));
  assert.ok(day0.tasks.some((t: Any) => t.id === run.id && t.repeat === true));
  // 定期券每天一班
  assert.equal(o.data.days.filter((d: Any) => d.tasks.some((t: Any) => t.id === run.id)).length, 3);
  assert.deepEqual(o.data.dues, [{ date: addDays(ctx.today, 2), id: s.t2.id, name: "本を詰める" }]);
  assert.deepEqual(o.data.late, [{ id: late.id, name: "昨天的票", scheduledOn: addDays(ctx.today, -1) }]);

  const future = await call("find-tasks-by-date", { from: addDays(ctx.today, 1), to: addDays(ctx.today, 1) }, ctx);
  assert.equal(future.data.late, undefined);

  await assert.rejects(call("find-tasks-by-date", { from: ctx.today, to: addDays(ctx.today, 100) }, ctx), isUserError(/最多查/));
  await assert.rejects(call("find-tasks-by-date", { from: "2026/10/01", to: ctx.today }, ctx), isUserError(/YYYY-MM-DD/));
});

test("get-task：詳情、子項、作業記錄；別的模組的 id 與已刪的票當找不到", async () => {
  const ctx = await makeCtx();
  const s = await seed(ctx);
  await ctx.deps.nodeRepo.addWorkLog(s.train.id, "紙箱十個");
  const o = await call("get-task", { id: s.train.id }, ctx);
  assert.equal(o.data.name, "荷造り");
  assert.deepEqual(o.data.children.map((c: Any) => c.id).sort(), [s.t1.id, s.t2.id].sort());
  assert.equal(o.data.openDescendants, 2);
  assert.ok(o.data.workLogs.some((l: Any) => l.body === "紙箱十個"));
  assert.ok(o.data.workLogs.some((l: Any) => l.event === "発券"));

  const note = await ctx.deps.noteRepo.create({ kind: "note", body: "筆記", inbox: true });
  await assert.rejects(call("get-task", { id: note.id }, ctx), isUserError(/找不到/));
  await assert.rejects(call("complete-tasks", { tasks: [{ id: note.id, done: true }] }, ctx), isUserError(/找不到/));
  await assert.rejects(call("get-task", { id: "no-such" }, ctx), isUserError(/找不到/));
  await assert.rejects(call("get-task", { id: s.route.id }, ctx), isUserError(/找不到/)); // 路線看 find-routes
  await ctx.deps.nodeRepo.softDelete(s.t1.id);
  await assert.rejects(call("get-task", { id: s.t1.id }, ctx), isUserError(/找不到/));
  await assert.rejects(call("get-task", {}, ctx), isUserError(/缺少 id/));
});

test("add-tasks：臨時車票掛路線標籤、放進列車、時刻／締切／優先度寫進去讀得回來", async () => {
  const ctx = await makeCtx();
  const s = await seed(ctx);
  const o = await call(
    "add-tasks",
    {
      tasks: [
        { name: "訂搬家公司", routeId: s.route.id, scheduledOn: ctx.today, scheduledTime: "14:00", dueOn: addDays(ctx.today, 3), priority: "high", estimateMin: 30 },
        { name: "收書架", parentId: s.train.id, description: "**先拆**" },
      ],
    },
    ctx,
  );
  assert.deepEqual(o.changed, ["nodes", "work_logs"]);
  assert.match(o.toast, /2 張/);
  const [a, b] = o.data;
  const na = await ctx.deps.nodeRepo.getNode(a.id);
  assert.equal(na!.parent_id, null);
  assert.equal(na!.route_id, s.route.id);
  assert.equal(na!.scheduled_time, "14:00");
  assert.equal(na!.due_on, addDays(ctx.today, 3));
  assert.equal(na!.priority, "high");
  assert.equal(na!.estimate_min, 30);
  const nb = await ctx.deps.nodeRepo.getNode(b.id);
  assert.equal(nb!.parent_id, s.train.id);
  assert.equal(nb!.description, "**先拆**");
  const back = await call("get-task", { id: a.id }, ctx);
  assert.equal(back.data.time, "14:00");
  assert.equal(back.data.route, "引越し");
});

test("add-tasks：參數錯整次拒絕、一筆都不建；規則錯逐筆回報", async () => {
  const ctx = await makeCtx();
  const s = await seed(ctx);
  const before = (await ctx.deps.nodeRepo.listSerials());
  await assert.rejects(call("add-tasks", { tasks: [] }, ctx), isUserError(/至少一筆/));
  await assert.rejects(call("add-tasks", { tasks: [{ name: "好" }, { name: "" }] }, ctx), isUserError(/name/));
  await assert.rejects(call("add-tasks", { tasks: [{ name: "昨天", scheduledOn: addDays(ctx.today, -1) }] }, ctx), isUserError(/不能早於今天/));
  await assert.rejects(call("add-tasks", { tasks: [{ name: "凌晨", scheduledTime: "05:00" }] }, ctx), isUserError(/25:00/));
  await assert.rejects(call("add-tasks", { tasks: [{ name: "x", parentId: s.train.id, routeId: s.route.id }] }, ctx), isUserError(/只能給一個/));
  const many = Array.from({ length: MCP_BATCH_LIMIT + 1 }, (_, i) => ({ name: `票${i}` }));
  await assert.rejects(call("add-tasks", { tasks: many }, ctx), isUserError(/最多 50 筆/));
  assert.deepEqual(await ctx.deps.nodeRepo.listSerials(), before);

  // 一筆掛錯層（車票不能直接放路線底下）、一筆正常 ⇒ 部分成功
  const o = await call("add-tasks", { tasks: [{ name: "錯層", parentId: s.route.id }, { name: "正常" }] }, ctx);
  assert.equal(o.data[0].ok, false);
  assert.match(o.data[0].error, /車票不能掛在路線底下/);
  assert.equal(o.data[1].ok, true);
  // 全部失敗 ⇒ McpUserError
  await assert.rejects(call("add-tasks", { tasks: [{ name: "x", parentId: "no-such" }] }, ctx), isUserError(/找不到父節點/));
});

test("update-tasks：改欄位、清除、時刻驗範圍；沒欄位回錯", async () => {
  const ctx = await makeCtx();
  const s = await seed(ctx);
  const o = await call(
    "update-tasks",
    { tasks: [{ id: s.t1.id, name: "大箱を買う", dueOn: addDays(ctx.today, 1), scheduledTime: "25:30", priority: "low", estimateMin: 15 }] },
    ctx,
  );
  assert.equal(o.data[0].ok, true);
  let n = (await ctx.deps.nodeRepo.getNode(s.t1.id))!;
  assert.equal(n.name, "大箱を買う");
  assert.equal(n.scheduled_time, "25:30");
  assert.equal(n.due_on, addDays(ctx.today, 1));
  await call("update-tasks", { tasks: [{ id: s.t1.id, dueOn: null, scheduledTime: null, estimateMin: null }] }, ctx);
  n = (await ctx.deps.nodeRepo.getNode(s.t1.id))!;
  assert.equal(n.due_on, null);
  assert.equal(n.scheduled_time, null);
  assert.equal(n.estimate_min, null);

  await assert.rejects(call("update-tasks", { tasks: [{ id: s.t1.id }] }, ctx), isUserError(/沒有要改的欄位/));
  await assert.rejects(call("update-tasks", { tasks: [{ id: s.t1.id, scheduledTime: "30:00" }] }, ctx), isUserError(/25:00/));
  await assert.rejects(call("update-tasks", { tasks: [{ id: s.t1.id, priority: "urgent" }] }, ctx), isUserError(/priority/));
  await assert.rejects(call("update-tasks", { tasks: [{ id: "no-such", name: "x" }] }, ctx), isUserError(/找不到/));
});

test("complete-tasks：済／取消済；有未済子項要 cascade；重複送不重複蓋", async () => {
  const ctx = await makeCtx();
  const s = await seed(ctx);
  const repo = ctx.deps.nodeRepo;
  await assert.rejects(call("complete-tasks", { tasks: [{ id: s.train.id, done: true }] }, ctx), isUserError(/cascade:true/));
  assert.equal((await repo.getNode(s.train.id))!.status, "todo");

  const o = await call("complete-tasks", { tasks: [{ id: s.train.id, done: true, cascade: true }] }, ctx);
  assert.equal(o.data[0].alsoDone, 2);
  for (const id of [s.train.id, s.t1.id, s.t2.id]) assert.equal((await repo.getNode(id))!.status, "done");
  assert.deepEqual(o.changed, ["nodes", "work_logs", "occurrences"]);

  const again = await call("complete-tasks", { tasks: [{ id: s.t1.id, done: true }] }, ctx);
  assert.match(again.data[0].note, /已經済了/);
  assert.equal(again.changed, undefined);

  await call("complete-tasks", { tasks: [{ id: s.t1.id, done: false }] }, ctx);
  assert.equal((await repo.getNode(s.t1.id))!.status, "todo");
  await assert.rejects(call("complete-tasks", { tasks: [{ id: s.t1.id }] }, ctx), isUserError(/done/));
});

test("complete-tasks：定期券済的是這一班、下一班排出；運休中的班不能直接済", async () => {
  const ctx = await makeCtx();
  const run = await repeatTicket(ctx);
  const repo = ctx.deps.nodeRepo;
  await call("complete-tasks", { tasks: [{ id: run.id, done: true }] }, ctx);
  let n = (await repo.getNode(run.id))!;
  assert.equal(n.status, "todo"); // 済蓋在班次上
  assert.equal(n.scheduled_on, addDays(ctx.today, 1));
  const twice = await call("complete-tasks", { tasks: [{ id: run.id, done: true }] }, ctx);
  assert.match(twice.data[0].note, /已済/);
  assert.equal((await repo.listOccurrences(run.id)).length, 1); // 沒有預先蓋到明天那班

  await call("complete-tasks", { tasks: [{ id: run.id, done: false }] }, ctx);
  n = (await repo.getNode(run.id))!;
  assert.equal(n.scheduled_on, ctx.today);

  await call("skip-tasks", { tasks: [{ id: run.id }] }, ctx);
  await assert.rejects(call("complete-tasks", { tasks: [{ id: run.id, done: true }] }, ctx), isUserError(/運休中/));
});

test("reschedule-tasks：繰越寫 carried_from、清執行日、改時刻；挑不到過去；定期券不改期", async () => {
  const ctx = await makeCtx();
  const s = await seed(ctx);
  const repo = ctx.deps.nodeRepo;
  const tomorrow = addDays(ctx.today, 1);
  const o = await call("reschedule-tasks", { tasks: [{ id: s.t1.id, date: tomorrow, time: "09:30" }] }, ctx);
  assert.deepEqual(o.data[0].to, { date: tomorrow, time: "09:30" });
  assert.equal(o.data[0].carriedFrom, ctx.today);
  const n = (await repo.getNode(s.t1.id))!;
  assert.equal(n.scheduled_on, tomorrow);
  assert.equal(n.carried_from, ctx.today);
  assert.equal(n.scheduled_time, "09:30");

  await call("reschedule-tasks", { tasks: [{ id: s.t1.id, date: null }] }, ctx);
  assert.equal((await repo.getNode(s.t1.id))!.scheduled_on, null);

  await assert.rejects(call("reschedule-tasks", { tasks: [{ id: s.t2.id, date: addDays(ctx.today, -2) }] }, ctx), isUserError(/今天/));
  assert.equal((await repo.getNode(s.t2.id))!.scheduled_on, null);
  await assert.rejects(call("reschedule-tasks", { tasks: [{ id: s.t2.id }] }, ctx), isUserError(/缺少/));
  await assert.rejects(call("reschedule-tasks", { tasks: [{ id: s.train.id, date: "2026-13-01" }] }, ctx), isUserError(/YYYY-MM-DD/));

  const run = await repeatTicket(ctx);
  await assert.rejects(call("reschedule-tasks", { tasks: [{ id: run.id, date: tomorrow }] }, ctx), isUserError(/定期券/));
  // 定期券：帶目前班次日＝只改這一班的時刻
  await call("reschedule-tasks", { tasks: [{ id: run.id, date: ctx.today, time: "07:00" }] }, ctx);
  const back = await call("find-tasks-by-date", { from: ctx.today, to: tomorrow }, ctx);
  const times = back.data.days.map((d: Any) => d.tasks.find((t: Any) => t.id === run.id)?.time ?? null);
  assert.deepEqual(times, ["07:00", null]);
});

test("skip-tasks：運休／取消運休；一般車票擋下", async () => {
  const ctx = await makeCtx();
  const s = await seed(ctx);
  const run = await repeatTicket(ctx);
  const repo = ctx.deps.nodeRepo;
  const o = await call("skip-tasks", { tasks: [{ id: run.id }] }, ctx);
  assert.equal(o.data[0].nextRun, addDays(ctx.today, 1));
  assert.equal((await repo.listOccurrences(run.id))[0].status, "skipped");
  await call("skip-tasks", { tasks: [{ id: run.id, skip: false }] }, ctx);
  assert.equal((await repo.listOccurrences(run.id)).length, 0);
  // 提前請假：指定後天那一班
  await call("skip-tasks", { tasks: [{ id: run.id, date: addDays(ctx.today, 2) }] }, ctx);
  assert.equal((await repo.listOccurrences(run.id))[0].due_on, addDays(ctx.today, 2));
  // 過去的班＝歷史唯讀（repository 的 REPEAT_FUTURE_ONLY_MSG）
  await assert.rejects(call("skip-tasks", { tasks: [{ id: run.id, date: addDays(ctx.today, -1) }] }, ctx), isUserError(/目前或未來/));
  await assert.rejects(call("skip-tasks", { tasks: [{ id: s.t1.id }] }, ctx), isUserError(/只有定期券/));
});

test("delete-tasks：軟刪除、回報連帶刪幾個、同批重複不算錯", async () => {
  const ctx = await makeCtx();
  const s = await seed(ctx);
  const repo = ctx.deps.nodeRepo;
  const o = await call("delete-tasks", { ids: [s.train.id, s.t1.id, s.loose.id] }, ctx);
  assert.equal(o.data.results[0].alsoDeleted, 2);
  assert.match(o.data.results[1].note, /隨上層/);
  assert.equal(o.data.deletedIds.length, 4);
  assert.notEqual((await repo.getNode(s.t2.id))!.deleted_at, null);
  // 軟刪除＝可復原
  await repo.restore(o.data.deletedIds);
  assert.equal((await repo.getNode(s.t2.id))!.deleted_at, null);
  await assert.rejects(call("delete-tasks", { ids: [] }, ctx), isUserError(/至少一筆/));
  await assert.rejects(call("delete-tasks", { ids: [s.route.id] }, ctx), isUserError(/找不到/));
});

test("add-work-logs：寫進作業記錄、get-task 讀得回來；空內容回錯", async () => {
  const ctx = await makeCtx();
  const s = await seed(ctx);
  const o = await call("add-work-logs", { logs: [{ taskId: s.t1.id, body: "  量好尺寸  " }] }, ctx);
  assert.deepEqual(o.changed, ["work_logs"]);
  const back = await call("get-task", { id: s.t1.id }, ctx);
  assert.equal(back.data.workLogs[0].body, "量好尺寸");
  await assert.rejects(call("add-work-logs", { logs: [{ taskId: s.t1.id, body: " " }] }, ctx), isUserError(/body/));
});

test("reschedule-tasks：已済的票不能推遲；誤點票帶原日期只改時刻；支線說沒有執行日", async () => {
  const ctx = await makeCtx();
  const s = await seed(ctx);
  const repo = ctx.deps.nodeRepo;
  const tomorrow = addDays(ctx.today, 1);
  await repo.setCompleted(s.t1.id, true, { dateKey: ctx.today, dayStartHour: ctx.dayStartHour });
  // 同 pickDay.ts 第 1 條（SETTLED_DEFER_MSG）：已済的不推遲，也不默默蓋繰越章
  await assert.rejects(call("reschedule-tasks", { tasks: [{ id: s.t1.id, date: tomorrow }] }, ctx), isUserError(/已済.*取消済/));
  const n = (await repo.getNode(s.t1.id))!;
  assert.equal(n.scheduled_on, ctx.today);
  assert.equal(n.carried_from, null);

  const yesterday = addDays(ctx.today, -1);
  const late = await repo.create({ kind: "ticket", name: "誤點票", parentId: null, scheduledOn: yesterday });
  const o = await call("reschedule-tasks", { tasks: [{ id: late.id, date: yesterday, time: "10:00" }] }, ctx);
  assert.deepEqual(o.data[0].to, { date: yesterday, time: "10:00" });
  assert.equal((await repo.getNode(late.id))!.scheduled_on, yesterday);

  const branch = await repo.create({ kind: "branch", name: "支線", parentId: s.route.id });
  await assert.rejects(call("reschedule-tasks", { tasks: [{ id: branch.id, date: tomorrow }] }, ctx), isUserError(/支線.*沒有執行日/));
  await assert.rejects(call("update-tasks", { tasks: [{ id: branch.id, scheduledTime: "10:00" }] }, ctx), isUserError(/沒有預定時刻/));
});

test("退役的定期券（跟著上層一起完成）：運休與改期都說清楚、取消済可以復活", async () => {
  const ctx = await makeCtx();
  const s = await seed(ctx);
  const repo = ctx.deps.nodeRepo;
  const run = await repo.create({ kind: "ticket", name: "每日點檢", parentId: s.train.id });
  await repo.setRepeatRule(run.id, fixedRule("daily", ctx.today), ctx.today, ctx.dayStartHour);
  await call("complete-tasks", { tasks: [{ id: s.train.id, done: true, cascade: true }] }, ctx);
  assert.equal((await repo.getNode(run.id))!.status, "done");
  await assert.rejects(call("skip-tasks", { tasks: [{ id: run.id }] }, ctx), isUserError(/不再排班/));
  await assert.rejects(call("reschedule-tasks", { tasks: [{ id: run.id, date: ctx.today, time: "08:00" }] }, ctx), isUserError(/不再排班/));
  const o = await call("complete-tasks", { tasks: [{ id: run.id, done: false }] }, ctx);
  assert.match(o.data[0].note, /恢復排班/);
  assert.equal((await repo.getNode(run.id))!.status, "todo");
});

test("拼錯或不認得的欄位回錯（不默默忽略），一筆都不寫", async () => {
  const ctx = await makeCtx();
  const s = await seed(ctx);
  const before = await ctx.deps.nodeRepo.listSerials();
  await assert.rejects(call("add-tasks", { tasks: [{ name: "x", due: ctx.today }] }, ctx), isUserError(/tasks\[0\] 不認得的欄位：due/));
  await assert.rejects(call("add-tasks", { tasks: [{ name: "x" }], dryRun: true }, ctx), isUserError(/不認得的欄位：dryRun/));
  await assert.rejects(call("update-tasks", { tasks: [{ id: s.t1.id, scheduled_on: ctx.today }] }, ctx), isUserError(/scheduled_on/));
  await assert.rejects(call("find-tasks", { keyword: "箱" }, ctx), isUserError(/可用：query/));
  assert.deepEqual(await ctx.deps.nodeRepo.listSerials(), before);
  // 工具表的形狀不受包裝影響
  for (const t of TASK_TOOLS) assert.equal(typeof t.run, "function");
});
