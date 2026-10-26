/**
 * 執行一次工具呼叫，把結果收成 Rust `mcp_reply` 要的形狀。純邏輯、不碰 Tauri／store，`node --test` 可直接測；
 * 真正的接線（listen／invoke／刷新畫面／toast）在 `McpBridge.tsx`。
 */
import { checkKeys } from "./args";
import { findTool } from "./registry";
import { McpUserError, type McpCtx, type McpOutcome } from "./types";

export interface McpReply {
  id: string;
  ok: boolean;
  text: string;
  isError: boolean;
  write: boolean;
  summary: string | null;
}

export interface McpRunResult {
  reply: McpReply;
  /** 成功的寫入才有：畫面重載與 toast 用 */
  outcome: McpOutcome | null;
}

/** 摘要一行＋資料 JSON（模型讀；空資料只回摘要） */
export function outcomeText(o: McpOutcome): string {
  return o.data === undefined ? o.summary : `${o.summary}\n${JSON.stringify(o.data)}`;
}

export async function runMcpCall(id: string, tool: string, args: unknown, ctx: McpCtx): Promise<McpRunResult> {
  const t = findTool(tool);
  if (!t) {
    return { reply: { id, ok: true, text: `沒有這支工具：${tool}`, isError: true, write: false, summary: null }, outcome: null };
  }
  const write = t.access === "write";
  const a = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
  try {
    checkKeys(a, t.inputSchema);
    const o = await t.run(a, ctx);
    return { reply: { id, ok: true, text: outcomeText(o), isError: false, write, summary: o.summary }, outcome: write ? o : null };
  } catch (e) {
    // 助理能自己修正的錯原文給它；其他是 App 內部錯，也照實說（它才知道要停手、不是改參數重試）
    // ok＝false 只給 App 內部錯：Rust 把它記進設定頁的最近紀錄（助理自己修得了的錯不記）
    const user = e instanceof McpUserError;
    const msg = user ? e.message : `App 內部錯誤：${e instanceof Error ? e.message : String(e)}`;
    return { reply: { id, ok: user, text: msg, isError: true, write: false, summary: null }, outcome: null };
  }
}
