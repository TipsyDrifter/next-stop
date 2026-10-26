/**
 * 外部助理的 WebView 端接線（契約 §3；D-主-90）。只掛在桌機殼（App.tsx 桌機分支），畫面上什麼都不畫。
 *
 *   掛上 → 先等兩個 listen 掛好，再 `mcp_register_tools` 把工具表交給 Rust（Rust 收到之前回助理「App 還在啟動」；
 *          順序反過來的話，Rust 看到工具表就開始轉呼叫，listener 還沒掛上的那一則會白等 30 秒逾時）
 *   `mcp:call`    → 用正式 repository 跑工具 → `mcp_reply`；寫入成功 ⇒ 與同步拉取相同的重載＋一句 toast（刪除類帶「復原」）
 *   `mcp:blocked` → 助理碰到關著的功能：同一個功能一個 session 只提示一次，toast 帶「去設定」
 *
 * 前例：系統匣 `tray.rs` emit `tt-tray` → `TimetableDesktopAgent` listen（Rust 發事件、WebView 執行）。
 * 主視窗按 ✕ 只是藏起來，WebView 照跑，所以 App 縮在系統匣時助理照樣能用（旅客筆記⑤已驗過藏窗時同步照跑）。
 */
import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { MOCK_MODE, nodeRepo, settingsRepo } from "../data";
import { noteRepo } from "../data/noteRepo";
import { tagRepo } from "../data/tagRepo";
import { timetableRepo } from "../data/timetableRepository";
import { ticketRepo } from "../data/ticketRepository";
import { todayKey } from "../lib/date";
import { refreshAfterPull } from "../store/syncStore";
import { KEY_LONG_RUN_MAX, LONG_RUN_MAX_DEFAULT } from "../store/timetableStore";
import { useUiStore } from "../store/uiStore";
import { toolSpecs } from "./registry";
import { runMcpCall } from "./run";
import { MCP_MODULE_LABEL, type ChangedTable, type McpAccess, type McpModule } from "./types";

interface CallEvent {
  id: string;
  tool: string;
  args: unknown;
  access: Record<McpModule, McpAccess>;
}

const DEPS = { nodeRepo, noteRepo, tagRepo, timetableRepo, ticketRepo };

/** 同 timetableStore 的 parseLongRunMax（每次呼叫現讀：另一台改了上限、同步過來也立刻生效） */
async function longRunMaxMin(): Promise<number> {
  const raw = await settingsRepo.get(KEY_LONG_RUN_MAX).catch(() => null);
  if (raw === null || raw === "") return LONG_RUN_MAX_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : LONG_RUN_MAX_DEFAULT;
}

function reload(tables: readonly ChangedTable[]): Promise<void> {
  return refreshAfterPull({ changed_tables: [...tables] }).catch((e) => console.warn("[mcp] 重載失敗：", e));
}

async function onCall({ id, tool, args, access }: CallEvent): Promise<void> {
  const dayStartHour = useUiStore.getState().dayStartHour;
  const now = new Date();
  const { reply, outcome } = await runMcpCall(id, tool, args, {
    deps: DEPS,
    today: todayKey(dayStartHour, now),
    dayStartHour,
    now,
    longRunMaxMin: await longRunMaxMin(),
    access,
  });
  await invoke("mcp_reply", { reply }).catch((e) => console.warn("[mcp] 回覆失敗：", e));
  if (!outcome) return;
  if (outcome.changed?.length) await reload(outcome.changed);
  if (!outcome.toast) return;
  const undo = outcome.undo;
  useUiStore.getState().showToast(
    undo
      ? {
          message: outcome.toast,
          actionLabel: "復原",
          onAction: () => void undo().then(reload, (e) => console.warn("[mcp] 復原失敗：", e)),
        }
      : { message: outcome.toast },
  );
}

export function McpBridge() {
  useEffect(() => {
    if (MOCK_MODE) return;
    let alive = true;
    const unlisten: UnlistenFn[] = [];
    const hinted = new Set<string>();

    void (async () => {
      const subs = await Promise.all([
        listen<CallEvent>("mcp:call", ({ payload }) => void onCall(payload)),
        listen<{ module: McpModule | "overview"; readOnly?: boolean }>("mcp:blocked", ({ payload }) => {
          const key = `${payload.module}:${payload.readOnly ? "w" : "r"}`;
          if (hinted.has(key)) return;
          hinted.add(key);
          const label = payload.module === "overview" ? "總覽" : MCP_MODULE_LABEL[payload.module];
          useUiStore.getState().showToast({
            message: payload.readOnly ? `外部助理想改「${label}」，目前只開放只看` : `外部助理想用「${label}」，還沒開放`,
            actionLabel: "去設定",
            onAction: () => useUiStore.getState().openSettings("assistant"),
          });
        }),
      ]);
      if (!alive) return subs.forEach((u) => u());
      unlisten.push(...subs);
      await invoke("mcp_register_tools", { tools: toolSpecs() });
    })().catch((e) => console.warn("[mcp] 接線失敗：", e));

    return () => {
      alive = false;
      for (const u of unlisten) u();
    };
  }, []);
  return null;
}
