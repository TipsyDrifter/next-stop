/**
 * 外部助理（MCP）工具層的型別——契約 `docs/research/2026-10-25-主線-MCP接口班-契約.md` §3、§4。
 *
 * 分工：Rust（`src-tauri/src/mcp/`）只當門口——HTTP、金鑰、開關把關；`tools/call` 轉給主視窗的 WebView，
 * 由這一層用跟 UI 同一套 repository 執行（hlc、業務規則、同步語句全部沿用，D-主-90）。
 * 本檔與 `tools/*.ts` 都不 import store／UI：handler 只拿 `McpCtx.deps` 裡的 repository，
 * 所以 `node --test` 換成 memory repository 就能測；畫面刷新與 toast 由 `bridge.ts` 依 `McpOutcome.changed` 處理。
 */
import type { NodeRepository } from "../data/nodeRepository";
import type { NoteRepository } from "../data/noteRepository";
import type { TagRepository } from "../data/tagRepository";
import type { TimetableRepository } from "../data/timetableRepository";
import type { TicketRepository } from "../data/ticketRepository";

/** 設定頁〈外部助理〉的五個功能（＝開關的鍵；Rust `config.rs` 同名） */
export type McpModule = "tasks" | "timetable" | "notes" | "diary" | "ledger";
export const MCP_MODULES: readonly McpModule[] = ["tasks", "timetable", "notes", "diary", "ledger"];

/** 一個功能開到哪：關／只看／可改（介面長相由 ☎-1 定；內部一律三態，可改＝含只看） */
export type McpAccess = "off" | "read" | "write";

/** 工具歸屬：五個功能之一，或 `overview`（任一功能可讀就能用，內容只放開著的功能） */
export type McpToolModule = McpModule | "overview";

/** JSON Schema 的子集（夠描述工具參數就好；Rust 原樣轉給客戶端） */
export type JsonSchema = {
  type?: "object" | "array" | "string" | "integer" | "number" | "boolean" | "null" | readonly string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  items?: JsonSchema;
  enum?: readonly (string | number | null)[];
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  additionalProperties?: boolean;
};

/** 送給 Rust 註冊的那一份（不含 handler）；欄位名＝MCP 規格的 Tool 欄位 */
export interface McpToolSpec {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  module: McpToolModule;
  /** 要的權限：read＝只看就能用；write＝要「可改」 */
  access: "read" | "write";
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint?: boolean;
    openWorldHint: false;
  };
}

/** handler 能用的東西（App 裡是正式 repository；測試是 memory 版） */
export interface McpDeps {
  nodeRepo: NodeRepository;
  noteRepo: NoteRepository;
  tagRepo: TagRepository;
  timetableRepo: TimetableRepository;
  ticketRepo: TicketRepository;
}

export interface McpCtx {
  deps: McpDeps;
  /** 營業日的「今天」（照日界線算，`todayKey(dayStartHour)`） */
  today: string;
  dayStartHour: number;
  /** 現在時刻（測試可固定） */
  now: Date;
  /** 時刻表「跑太久」的全域上限（分；0＝關）＝設定 `timetable_long_run_max_min`，與統計頁同一個值 */
  longRunMaxMin: number;
  /** 這次呼叫當下各功能的開關（Rust 已經擋過；overview 用它決定放哪幾段） */
  access: Readonly<Record<McpModule, McpAccess>>;
}

/** 資料表名＝同步重載用的 `changed_tables` 同一套字（bridge 拿去觸發與同步拉取相同的重載） */
export type ChangedTable = string;

export interface McpOutcome {
  /** 一行中文摘要（給模型讀，也是 toast 的底稿） */
  summary: string;
  /** 給模型讀的精簡資料（JSON 化後接在摘要後面） */
  data?: unknown;
  /** 寫入時填：動到哪些表（bridge 依此重載畫面） */
  changed?: readonly ChangedTable[];
  /** 寫入時填：App 角落那句 toast（省略＝不跳） */
  toast?: string;
  /**
   * 刪除類填：toast 上的「復原」（App 裡可復原＝D-主-94）。只在這個 WebView 行程內有效，不給助理看、不進 JSON；
   * 回傳動到哪些表，bridge 復原後照樣重載。
   */
  undo?: () => Promise<readonly ChangedTable[]>;
}

export interface McpTool<A = Record<string, unknown>> extends McpToolSpec {
  run(args: A, ctx: McpCtx): Promise<McpOutcome>;
}

/**
 * 給助理看得懂、可以自己修正的錯（參數不對、找不到、規則不允許）。
 * bridge 轉成 MCP 的 tool-level error（`isError: true`），模型看得到內容；其他例外當成 App 內部錯誤回報。
 */
export class McpUserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpUserError";
  }
}

/** 陣列式寫入的上限（契約 §4） */
export const MCP_BATCH_LIMIT = 50;

/** 關著的功能回給助理的話（Rust 擋的那一份與這裡同字；`config.rs` 有測試對帳） */
export const MCP_MODULE_LABEL: Record<McpModule, string> = {
  tasks: "任務",
  timetable: "時刻表",
  notes: "筆記",
  diary: "日記",
  ledger: "帳目",
};
