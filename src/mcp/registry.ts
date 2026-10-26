/**
 * 外部助理工具表的唯一來源（契約 §3）。順序＝助理在 tools/list 看到的順序：總覽 → 任務 → 排行程 → 時刻表 → 筆記 → 日記 → 帳目。
 * Rust 只拿 `toolSpecs()`（不含 handler）做 tools/list 與開關把關；執行一律回到這裡。
 */
import type { McpTool, McpToolSpec } from "./types";
import { OVERVIEW_TOOLS } from "./tools/overview";
import { TASK_TOOLS } from "./tools/tasks";
import { SCHEDULE_TOOLS } from "./tools/schedule";
import { TIMETABLE_TOOLS } from "./tools/timetable";
import { NOTE_TOOLS } from "./tools/notes";
import { DIARY_TOOLS } from "./tools/diary";
import { LEDGER_TOOLS } from "./tools/ledger";

export const MCP_TOOLS: readonly McpTool[] = [
  ...OVERVIEW_TOOLS,
  ...TASK_TOOLS,
  ...SCHEDULE_TOOLS,
  ...TIMETABLE_TOOLS,
  ...NOTE_TOOLS,
  ...DIARY_TOOLS,
  ...LEDGER_TOOLS,
];

const BY_NAME = new Map(MCP_TOOLS.map((t) => [t.name, t]));

export function findTool(name: string): McpTool | undefined {
  return BY_NAME.get(name);
}

/** 送 Rust 註冊的那一份：去掉 handler，其餘欄位原樣 */
export function toolSpecs(): McpToolSpec[] {
  return MCP_TOOLS.map(({ run: _run, ...spec }) => spec);
}
