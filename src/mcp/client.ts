/**
 * 外部助理（MCP）設定頁呼叫 Rust 的薄層——契約 `docs/research/2026-10-25-主線-MCP接口班-契約.md` §3（commands）、§5（信任層）。
 *
 * 只給〈外部助理〉籤（`src/ui/settings/ExternalAssistantTab.tsx`）用；工具執行那條路（`mcp:call` → `mcp_reply`）在 `bridge.ts`，不經這裡。
 * Rust 端 commands（`src-tauri/src/mcp/`，serde camelCase）與本檔的名稱、形狀一一對應：
 *   mcp_status → McpStatus；mcp_set_access { module, access } → McpStatus；mcp_rotate_token → McpStatus；mcp_recent → McpRecent[]
 *
 * 三種環境：
 *   - 桌機 Tauri：直接 invoke。
 *   - `?mock=1`（瀏覽器預覽）：記憶體假狀態（埠 18920、假金鑰、全關、幾筆假紀錄），分頁才看得到東西；
 *     `?mock=1&mcp=busy` 模擬連接埠被占用（截圖與檢查錯誤列用）；`?mock=1&mcp=starting` 模擬還在等埠空出來（收官磨光 A2）。
 *   - Android：Rust 端編譯期就沒有 mcp 模組（`#[cfg(desktop)]`），一律不呼叫，直接回錯（手機殼本來也不畫這一籤）。
 */
import { invoke } from "@tauri-apps/api/core";
import { MOCK_MODE } from "../data";
import { MCP_MODULES, type McpAccess, type McpModule } from "./types";

export interface McpStatus {
  port: number;
  /** 例 `http://127.0.0.1:18920/mcp` */
  url: string;
  /** 連線金鑰原文（設定頁只露最後 4 碼；複製時用全文） */
  token: string;
  /** 端點有沒有聽起來；false 時看 `error` */
  listening: boolean;
  /** 給人看的一句中文（例「連接埠 18920 被占用，外部助理連不進來」）；沒事＝null */
  error: string | null;
  access: Record<McpModule, McpAccess>;
  /** TS 註冊上去的工具數 */
  toolCount: number;
  /** App 本體 exe 的絕對路徑（Rust `current_exe`）；Claude Desktop 的 stdio 轉接用 */
  exePath: string;
}

export interface McpRecent {
  /** ISO 8601 時刻 */
  at: string;
  kind: "write" | "blocked" | "error";
  module: McpModule | "overview" | null;
  /** 一行中文（例「建立 3 張車票（任務）」「沒有開放：帳目」） */
  summary: string;
}

/* ───────── 環境判斷 ───────── */

function onAndroid(): boolean {
  return typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
}

function urlFlag(name: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return new URLSearchParams(window.location.search).get(name);
  } catch {
    return null;
  }
}

const NOT_ON_MOBILE = "外部助理只能在桌機上連。";

function guard(): void {
  if (!MOCK_MODE && onAndroid()) throw new Error(NOT_ON_MOBILE);
}

/* ───────── mock ───────── */

const MOCK_PORT = 18920;

function mockToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function minutesAgo(n: number): string {
  return new Date(Date.now() - n * 60_000).toISOString();
}

let mock: { status: McpStatus; recent: McpRecent[] } | null = null;

function mockState() {
  if (mock) return mock;
  const busy = urlFlag("mcp") === "busy";
  const starting = urlFlag("mcp") === "starting";
  const url = `http://127.0.0.1:${MOCK_PORT}/mcp`;
  mock = {
    status: {
      port: MOCK_PORT,
      url,
      token: "mock0000000000000000000000000000000000000000003f9c",
      listening: !busy && !starting,
      // 字同 Rust server.rs 的 bind_error_message（收官磨光 A2 改過）
      error: busy ? `連接埠 ${MOCK_PORT} 已被占用，外部助理連不進來。完全結束私鐵手帳（系統匣圖示 →「結束」）再打開試試。` : null,
      access: Object.fromEntries(MCP_MODULES.map((m) => [m, "off"])) as Record<McpModule, McpAccess>,
      toolCount: 38,
      exePath: "C:\\Users\\you\\AppData\\Local\\私鐵手帳\\私鐵手帳.exe",
    },
    // 新的在前（Rust 環形緩衝也照這個順序回）
    recent: [
      { at: minutesAgo(2), kind: "write", module: "tasks", summary: "建立 3 張車票（任務）" },
      { at: minutesAgo(9), kind: "write", module: "timetable", summary: "補記 1 個時間塊（時刻表）" },
      { at: minutesAgo(13), kind: "blocked", module: "ledger", summary: "沒有開放：帳目" },
      { at: minutesAgo(31), kind: "error", module: "notes", summary: "找不到這則筆記（筆記）" },
    ],
  };
  return mock;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/* ───────── API ───────── */

export async function mcpStatus(): Promise<McpStatus> {
  if (MOCK_MODE) return clone(mockState().status);
  guard();
  return invoke<McpStatus>("mcp_status");
}

export async function mcpSetAccess(module: McpModule, access: McpAccess): Promise<McpStatus> {
  if (MOCK_MODE) {
    const s = mockState().status;
    s.access = { ...s.access, [module]: access };
    return clone(s);
  }
  guard();
  return invoke<McpStatus>("mcp_set_access", { module, access });
}

export async function mcpRotateToken(): Promise<McpStatus> {
  if (MOCK_MODE) {
    const s = mockState().status;
    s.token = mockToken();
    return clone(s);
  }
  guard();
  return invoke<McpStatus>("mcp_rotate_token");
}

export async function mcpRecent(): Promise<McpRecent[]> {
  if (MOCK_MODE) return clone(mockState().recent);
  guard();
  return invoke<McpRecent[]>("mcp_recent");
}

/* ───────── 複製用的字 ───────── */

/** 「複製 Claude Code 指令」 */
export function claudeCodeCommand(s: Pick<McpStatus, "url" | "token">): string {
  return `claude mcp add --transport http --scope user nextstop ${s.url} --header "Authorization: Bearer ${s.token}"`;
}

/** 「複製 Claude Desktop 設定」＝貼進 `claude_desktop_config.json` 的一段（stdio 轉接，契約 §2-①） */
export function claudeDesktopConfig(s: Pick<McpStatus, "url" | "token" | "exePath">): string {
  return JSON.stringify(
    {
      mcpServers: {
        nextstop: {
          command: s.exePath,
          args: ["--mcp-stdio"],
          env: { NS_MCP_URL: s.url, NS_MCP_TOKEN: s.token },
        },
      },
    },
    null,
    2,
  );
}

/** 金鑰只露最後 4 碼 */
export function maskToken(token: string): string {
  return token ? `••••••••${token.slice(-4)}` : "";
}
