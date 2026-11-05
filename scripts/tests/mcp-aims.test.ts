/**
 * 方針的 MCP 工具（src/mcp/tools/aims.ts；方針擴充 辛 D-主-381）：memory repository 跑三支工具的正常路徑、
 * 參數不用拼內部鍵、五句與 60 字照舊且轉成 McpUserError、回傳不露期間鍵、權限歸 tasks、get-overview 帶這週方針。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { load, makeCtx } from "./mcp-ctx.ts";
import type { McpCtx } from "../../src/mcp/types.ts";

const { AIM_TOOLS } = await load<typeof import("../../src/mcp/tools/aims.ts")>("../../src/mcp/tools/aims.ts");
const { McpUserError } = await load<typeof import("../../src/mcp/types.ts")>("../../src/mcp/types.ts");
const { toolSpecs } = await load<typeof import("../../src/mcp/registry.ts")>("../../src/mcp/registry.ts");
const { runMcpCall } = await load<typeof import("../../src/mcp/run.ts")>("../../src/mcp/run.ts");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** 2026-11-04 是週三；日界線 6 點，中午固定在這一天 */
const NOW = new Date("2026-11-04T12:00:00+08:00");
const ctxOf = (opts: Parameters<typeof makeCtx>[0] = {}) => makeCtx({ now: NOW, ...opts });

function call(name: string, args: Record<string, unknown>, ctx: McpCtx): Promise<Any> {
  const t = AIM_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`沒有 ${name}`);
  return t.run(args, ctx);
}

const isUserError = (re?: RegExp) => (e: unknown) => {
  assert.ok(e instanceof McpUserError, `應是 McpUserError：${String(e)}`);
  if (re) assert.match((e as Error).message, re);
  return true;
};

/** 幹線→兩條路線；第一條有支線與兩個車站（第一站到了） */
async function seed(ctx: McpCtx) {
  const r = ctx.deps.nodeRepo;
  const line = await r.create({ kind: "line", name: "本線", parentId: null });
  const route = await r.create({ kind: "route", name: "日本語", parentId: line.id });
  const other = await r.create({ kind: "route", name: "引越し", parentId: line.id });
  const branch = await r.create({ kind: "branch", name: "文法", parentId: route.id });
  const ticket = await r.create({ kind: "ticket", name: "單字本", parentId: branch.id });
  const st1 = await r.create({ kind: "station", name: "N5", parentId: route.id });
  const st2 = await r.create({ kind: "station", name: "N4", parentId: route.id });
  await r.update(st1.id, { arrived_on: "2026-10-01" });
  return { line, route, other, branch, ticket, st1, st2 };
}

test("工具表：三支、module 都是 tasks、讀寫 annotations 對、參數不要內部鍵", () => {
  assert.deepEqual(AIM_TOOLS.map((t) => t.name), ["list-aims", "save-aim", "set-aim-done"]);
  for (const t of AIM_TOOLS) {
    assert.equal(t.module, "tasks");
    assert.ok(t.description.length <= 400, `${t.name} ${t.description.length}`);
    assert.equal(t.annotations.readOnlyHint, t.access === "read", t.name);
    assert.doesNotMatch(JSON.stringify(t.inputSchema), /week_on|M20|S<|Y20/, t.name);
  }
  assert.deepEqual(AIM_TOOLS.map((t) => t.access), ["read", "write", "write"]);
  const names = toolSpecs().map((s) => s.name);
  for (const t of AIM_TOOLS) assert.ok(names.includes(t.name), `${t.name} 要進 toolSpecs（Rust 靠它拿工具表）`);
});

test("save-aim：期間＋日期落進對的那一期；回傳與 list-aims 都不露期間鍵", async () => {
  const ctx = await ctxOf();
  const s = await seed(ctx);
  const repo = ctx.deps.weekAimRepo;
  const week = await call("save-aim", { text: " 背  單字 ", period: "week" }, ctx);
  assert.deepEqual(week.changed, ["week_aims"]);
  assert.ok(week.toast);
  assert.equal(week.data.text, "背 單字", "字的正規化同寫方針框");
  await call("save-aim", { text: "十月的事", period: "month", date: "2026-10-15" }, ctx);
  await call("save-aim", { text: "今年考過", period: "year", attachTo: s.route.id }, ctx);
  await call("save-aim", { text: "模擬考兩回", stationId: s.st2.id }, ctx);

  assert.equal((await repo.listKeys(["2026-11-02"])).length, 1, "週一起算，週三落在 11/2 那週");
  assert.equal((await repo.listKeys(["M2026-10"])).length, 1);
  assert.equal((await repo.listKeys(["Y2026"]))[0].node_id, s.route.id);
  assert.equal((await repo.listKeys([`S${s.st2.id}`])).length, 1);

  const listed = await call("list-aims", {}, ctx);
  const text = JSON.stringify(listed.data);
  assert.doesNotMatch(text, /"M20|"Y20|week_on/);
  assert.deepEqual(listed.data.map((p: Any) => p.period), ["week", "month", "year", "station"]);
  assert.deepEqual([listed.data[0].from, listed.data[0].to], ["2026-11-02", "2026-11-08"]);
  assert.equal(listed.data[2].aims[0].attachedTo.name, "日本語");
  assert.equal(listed.data[3].station.name, "N4");
  assert.equal(listed.data[3].station.route, "日本語");
  assert.equal(listed.data[1].total, 0, "這個月沒寫（十月那句不算）");
});

test("週首跟著設定：週日起算時週三落在 11/1 那週", async () => {
  const ctx = await ctxOf({ weekStart: 0 });
  await call("save-aim", { text: "週日起算", period: "week" }, ctx);
  assert.equal((await ctx.deps.weekAimRepo.listKeys(["2026-11-01"])).length, 1);
  const listed = await call("list-aims", { period: "week" }, ctx);
  assert.equal(listed.data[0].from, "2026-11-01");
});

test("list-aims：篩期間與日期；車站三種看法；預設不列沒寫的車站", async () => {
  const ctx = await ctxOf();
  const s = await seed(ctx);
  await call("save-aim", { text: "十月", period: "month", date: "2026-10-20" }, ctx);
  await call("save-aim", { text: "到站的那站", stationId: s.st1.id }, ctx);

  const oct = await call("list-aims", { period: "month", date: "2026-10-01" }, ctx);
  assert.equal(oct.data.length, 1);
  assert.equal(oct.data[0].aims[0].text, "十月");
  assert.equal(oct.data[0].title, "10月的方針");

  const byDate = await call("list-aims", { date: "2026-10-20" }, ctx);
  assert.deepEqual(byDate.data.map((p: Any) => p.period), ["week", "month", "year"]);

  const dflt = await call("list-aims", {}, ctx);
  assert.equal(dflt.data.filter((p: Any) => p.period === "station").length, 0, "下一站沒寫＝不列");

  const next = await call("list-aims", { period: "station" }, ctx);
  assert.deepEqual(next.data.map((p: Any) => p.station.name), ["N4"], "第二條路線沒車站、第一條的下一站是 N4，沒寫也列");

  const route = await call("list-aims", { period: "station", routeId: s.route.id }, ctx);
  assert.deepEqual(route.data.map((p: Any) => p.station.name), ["N5", "N4"]);
  assert.equal(route.data[0].aims[0].text, "到站的那站");

  const one = await call("list-aims", { stationId: s.st1.id }, ctx);
  assert.equal(one.data[0].station.arrivedOn, "2026-10-01");

  await assert.rejects(call("list-aims", { period: "week", stationId: s.st1.id }, ctx), isUserError(/period:station/));
  await assert.rejects(call("list-aims", { stationId: s.st1.id, date: "2026-11-01" }, ctx), isUserError(/不看日期/));
  await assert.rejects(call("list-aims", { stationId: s.ticket.id }, ctx), isUserError(/找不到車站/));
  await assert.rejects(call("list-aims", { routeId: s.ticket.id, period: "station" }, ctx), isUserError(/找不到路線/));
  await assert.rejects(call("list-aims", { period: "decade" }, ctx), isUserError(/period/));
  await assert.rejects(call("list-aims", { date: "11/4" }, ctx), isUserError(/YYYY-MM-DD/));
});

test("save-aim 改字、掛與取下；沒變不寫；句序不動", async () => {
  const ctx = await ctxOf();
  const s = await seed(ctx);
  const a = await call("save-aim", { text: "第一句", period: "month" }, ctx);
  const b = await call("save-aim", { text: "第二句", period: "month" }, ctx);

  const edited = await call("save-aim", { id: a.data.id, text: "第一句改" }, ctx);
  assert.equal(edited.data.text, "第一句改");
  assert.deepEqual(edited.changed, ["week_aims"]);

  const hung = await call("save-aim", { id: b.data.id, attachTo: s.branch.id }, ctx);
  assert.equal(hung.data.attachedTo.name, "文法");
  assert.equal(hung.data.attachedTo.route, "日本語");

  const off = await call("save-aim", { id: b.data.id, attachTo: null }, ctx);
  assert.equal(off.data.attachedTo, undefined);

  const same = await call("save-aim", { id: a.data.id, text: "第一句改" }, ctx);
  assert.equal(same.changed, undefined, "沒變不寫、不跳 toast");
  assert.equal(same.toast, undefined);

  const rows = await ctx.deps.weekAimRepo.listKeys(["M2026-11"]);
  assert.deepEqual(rows.filter((r: Any) => !r.deleted_at).map((r: Any) => r.text), ["第一句改", "第二句"]);
});

test("save-aim 的規則：五句、60 字、空字不會變成刪除、只掛路線或支線、不拼內部鍵", async () => {
  const ctx = await ctxOf();
  const s = await seed(ctx);
  const made: Any[] = [];
  for (let i = 0; i < 5; i++) made.push(await call("save-aim", { text: `句${i}`, period: "year" }, ctx));
  await assert.rejects(call("save-aim", { text: "第六句", period: "year" }, ctx), isUserError(/一年最多 5 句/));
  // 別期不受影響（各算各的）
  await call("save-aim", { text: "月的第一句", period: "month" }, ctx);
  // 滿了照樣能改字
  await call("save-aim", { id: made[0].data.id, text: "句零" }, ctx);

  await assert.rejects(call("save-aim", { text: "長".repeat(61), period: "month" }, ctx), isUserError(/60 個字/));
  await assert.rejects(call("save-aim", { id: made[1].data.id, text: "長".repeat(61) }, ctx), isUserError(/60 個字/));
  await assert.rejects(call("save-aim", { id: made[1].data.id, text: "   " }, ctx), isUserError(/不能是空的/));
  assert.equal((await ctx.deps.weekAimRepo.listKeys(["Y2026"])).filter((r: Any) => !r.deleted_at).length, 5, "空字沒有刪掉那句");

  await assert.rejects(call("save-aim", { period: "month" }, ctx), isUserError(/text/));
  await assert.rejects(call("save-aim", { text: "沒期間" }, ctx), isUserError(/period/));
  await assert.rejects(call("save-aim", { text: "x", period: "station" }, ctx), isUserError(/stationId/));
  await assert.rejects(call("save-aim", { text: "x", period: "month", stationId: s.st2.id }, ctx), isUserError(/period:station/));
  await assert.rejects(call("save-aim", { text: "x", stationId: s.st2.id, date: "2026-11-04" }, ctx), isUserError(/不看日期/));
  await assert.rejects(call("save-aim", { text: "x", stationId: s.route.id }, ctx), isUserError(/找不到車站/));
  await assert.rejects(call("save-aim", { text: "x", period: "month", attachTo: s.ticket.id }, ctx), isUserError(/路線或支線/));
  await assert.rejects(call("save-aim", { id: made[1].data.id, period: "month", text: "換期" }, ctx), isUserError(/別的期間/));
  await assert.rejects(call("save-aim", { id: made[1].data.id }, ctx), isUserError(/text 或 attachTo/));
  await assert.rejects(call("save-aim", { id: "沒這句", text: "x" }, ctx), isUserError(/找不到方針/));
});

test("掛的路線被刪：標籤消失、句子留著", async () => {
  const ctx = await ctxOf();
  const s = await seed(ctx);
  await call("save-aim", { text: "留著", period: "week", attachTo: s.other.id }, ctx);
  await ctx.deps.nodeRepo.softDelete(s.other.id);
  const listed = await call("list-aims", { period: "week" }, ctx);
  assert.equal(listed.data[0].aims[0].text, "留著");
  assert.equal(listed.data[0].aims[0].attachedTo, undefined);
});

test("set-aim-done：蓋済、取消、狀態沒變不寫、找不到回錯", async () => {
  const ctx = await ctxOf();
  const a = await call("save-aim", { text: "蓋我", period: "week" }, ctx);
  const id = a.data.id;

  const on = await call("set-aim-done", { id }, ctx);
  assert.equal(on.data.done, true);
  assert.equal(on.data.doneAt, NOW.toISOString());
  assert.deepEqual(on.changed, ["week_aims"]);

  const again = await call("set-aim-done", { id, done: true }, ctx);
  assert.equal(again.changed, undefined);
  assert.equal(again.data.doneAt, NOW.toISOString(), "不重戳");

  const offed = await call("set-aim-done", { id, done: false }, ctx);
  assert.equal(offed.data.done, undefined);
  assert.equal((await ctx.deps.weekAimRepo.getAim(id))!.done_at, null);

  await assert.rejects(call("set-aim-done", { id: "沒這句" }, ctx), isUserError(/找不到方針/));
  await assert.rejects(call("set-aim-done", {}, ctx), isUserError(/缺少 id/));
  await ctx.deps.weekAimRepo.deleteAim(id);
  await assert.rejects(call("set-aim-done", { id }, ctx), isUserError(/找不到方針/));
});

test("runMcpCall：拼錯欄位回錯、寫入記 write、看的工具不記", async () => {
  const ctx = await ctxOf();
  const bad = await runMcpCall("1", "save-aim", { text: "x", peroid: "week" }, ctx);
  assert.equal(bad.reply.isError, true);
  assert.match(bad.reply.text, /不認得的欄位：peroid/);
  const ok = await runMcpCall("2", "save-aim", { text: "x", period: "week" }, ctx);
  assert.equal(ok.reply.write, true);
  assert.deepEqual(ok.outcome?.changed, ["week_aims"]);
  const read = await runMcpCall("3", "list-aims", {}, ctx);
  assert.equal(read.reply.write, false);
  assert.equal(read.outcome, null);
  const limit = await runMcpCall("4", "save-aim", { text: "長".repeat(61), period: "week" }, ctx);
  assert.equal(limit.reply.isError, true);
  assert.doesNotMatch(limit.reply.text, /App 內部錯誤/, "60 字是助理修得了的錯");
});

test("get-overview：任務可讀才帶這週方針；只帶這週", async () => {
  const ctx = await ctxOf();
  await call("save-aim", { text: "這週的", period: "week" }, ctx);
  await call("save-aim", { text: "這個月的", period: "month" }, ctx);
  const { reply } = await runMcpCall("1", "get-overview", {}, ctx);
  const data = JSON.parse(reply.text.split("\n")[1]);
  assert.deepEqual(data.weekAims.aims.map((a: Any) => a.text), ["這週的"]);
  assert.deepEqual([data.weekAims.done, data.weekAims.total], [0, 1]);
  assert.match(reply.text.split("\n")[0], /這週方針済 0\/1/);

  const closed = await ctxOf({ access: { tasks: "off" } });
  const r2 = await runMcpCall("2", "get-overview", {}, closed);
  assert.equal(JSON.parse(r2.reply.text.split("\n")[1]).weekAims, undefined);
});
