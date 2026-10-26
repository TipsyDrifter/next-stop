/**
 * MCP 工具表的整體規則（契約 §4）＋總覽與執行包裝：
 *   名稱唯一、kebab-case；annotations 與 access 一致；描述不超長；overview 只放開著的功能；
 *   runMcpCall 把 McpUserError 原文交給助理、內部錯標明、找不到工具不丟例外。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { load, makeCtx } from "./mcp-ctx.ts";

type Registry = typeof import("../../src/mcp/registry.ts");
type Run = typeof import("../../src/mcp/run.ts");
type Types = typeof import("../../src/mcp/types.ts");

describe("工具表", async () => {
  const { MCP_TOOLS, toolSpecs } = await load<Registry>("../../src/mcp/registry.ts");
  const { MCP_MODULES } = await load<Types>("../../src/mcp/types.ts");

  test("名稱唯一、kebab-case「動詞-名詞」", () => {
    const names = MCP_TOOLS.map((t) => t.name);
    assert.equal(new Set(names).size, names.length, `重名：${names.filter((n, i) => names.indexOf(n) !== i)}`);
    for (const n of names) assert.match(n, /^[a-z]+(-[a-z]+)+$/, n);
  });

  test("annotations 與 access 一致；全部 openWorldHint:false", () => {
    for (const t of MCP_TOOLS) {
      assert.equal(t.annotations.openWorldHint, false, t.name);
      if (t.access === "read") {
        assert.equal(t.annotations.readOnlyHint, true, `${t.name} 讀取要 readOnlyHint`);
        assert.equal(t.annotations.destructiveHint, false, t.name);
      } else {
        assert.equal(t.annotations.readOnlyHint, false, `${t.name} 寫入不能 readOnlyHint`);
      }
      if (/^(update|complete|reschedule|delete|apply|skip)-/.test(t.name)) {
        assert.equal(t.annotations.destructiveHint, true, `${t.name} 要 destructiveHint`);
      }
    }
  });

  test("module 只能是五個功能或 overview；描述非空且不超過 400 字", () => {
    for (const t of MCP_TOOLS) {
      assert.ok(t.module === "overview" || (MCP_MODULES as readonly string[]).includes(t.module), `${t.name}：${t.module}`);
      assert.ok(t.description.length > 0 && t.description.length <= 400, `${t.name} 描述 ${t.description.length} 字`);
      assert.equal(t.inputSchema.type, "object", t.name);
    }
  });

  test("五個功能都有讀；可寫的功能都有寫", () => {
    for (const m of MCP_MODULES) {
      assert.ok(MCP_TOOLS.some((t) => t.module === m && t.access === "read"), `${m} 沒有讀取工具`);
      assert.ok(MCP_TOOLS.some((t) => t.module === m && t.access === "write"), `${m} 沒有寫入工具`);
    }
  });

  test("toolSpecs 不帶 handler、可 JSON 化", () => {
    const specs = toolSpecs();
    assert.equal(specs.length, MCP_TOOLS.length);
    for (const s of specs) assert.equal("run" in s, false);
    assert.doesNotThrow(() => JSON.stringify(specs));
  });
});

describe("get-overview 與 runMcpCall", async () => {
  const { runMcpCall } = await load<Run>("../../src/mcp/run.ts");

  test("全部可讀：五段都在", async () => {
    const ctx = await makeCtx();
    const { reply } = await runMcpCall("1", "get-overview", {}, ctx);
    assert.equal(reply.isError, false, reply.text);
    const data = JSON.parse(reply.text.split("\n")[1]);
    for (const k of ["tasks", "running", "ledgerToday", "inbox", "diaryToday"]) assert.ok(k in data, k);
    assert.equal(data.notOpen, undefined);
  });

  test("關著的功能一個字都不給，只列在 notOpen", async () => {
    const ctx = await makeCtx({ access: { ledger: "off", diary: "off" } });
    const { reply } = await runMcpCall("2", "get-overview", {}, ctx);
    const data = JSON.parse(reply.text.split("\n")[1]);
    assert.equal(data.ledgerToday, undefined);
    assert.equal(data.diaryToday, undefined);
    assert.deepEqual([...data.notOpen].sort(), ["帳目", "日記"].sort());
  });

  test("找不到工具：回錯但不丟例外", async () => {
    const ctx = await makeCtx();
    const { reply } = await runMcpCall("3", "no-such-tool", {}, ctx);
    assert.equal(reply.isError, true);
    assert.match(reply.text, /沒有這支工具/);
  });

  test("參數錯：McpUserError 原文給助理；寫入沒成功不記 write", async () => {
    const ctx = await makeCtx();
    const { reply, outcome } = await runMcpCall("4", "add-tasks", { tasks: "不是陣列" }, ctx);
    assert.equal(reply.isError, true);
    assert.doesNotMatch(reply.text, /App 內部錯誤/);
    assert.equal(reply.write, false);
    assert.equal(outcome, null);
  });
});

describe("整合：欄位檢查收成全模組、刪除帶復原", async () => {
  const { runMcpCall } = await load<Run>("../../src/mcp/run.ts");

  test("任何模組拼錯欄位都回錯、一筆都不寫", async () => {
    const ctx = await makeCtx();
    const { reply } = await runMcpCall("5", "add-notes", { notes: [{ body: "x", tagz: ["a"] }] }, ctx);
    assert.equal(reply.isError, true);
    assert.match(reply.text, /不認得的欄位：tagz/);
    assert.equal((await ctx.deps.noteRepo.listNotes()).length, 0);
  });

  test("delete-notes 的 undo 放回原狀、回傳要重載的表", async () => {
    const ctx = await makeCtx();
    const add = await runMcpCall("6", "add-notes", { notes: [{ body: "留著" }] }, ctx);
    assert.equal(add.reply.isError, false, add.reply.text);
    const id = (await ctx.deps.noteRepo.listNotes())[0].id;
    const del = await runMcpCall("7", "delete-notes", { ids: [id] }, ctx);
    assert.equal(del.reply.isError, false, del.reply.text);
    assert.equal((await ctx.deps.noteRepo.listNotes()).length, 0);
    assert.ok(del.outcome?.undo);
    assert.deepEqual(await del.outcome!.undo!(), ["notes"]);
    assert.equal((await ctx.deps.noteRepo.listNotes()).length, 1);
  });
});
