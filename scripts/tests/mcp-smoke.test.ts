/** MCP 工具層測試環境的煙霧測試：memory 版 McpCtx 組得起來、五個 repository 都能讀。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeCtx } from "./mcp-ctx.ts";

test("memory 版 McpCtx 組得起來、五個 repository 都能讀", async () => {
  const ctx = await makeCtx();
  assert.match(ctx.today, /^\d{4}-\d{2}-\d{2}$/);
  await ctx.deps.nodeRepo.listSidebar();
  await ctx.deps.noteRepo.listNotes();
  await ctx.deps.timetableRepo.listCategories();
  await ctx.deps.ticketRepo.listAccounts();
  await ctx.deps.tagRepo.recentKeys();
});
