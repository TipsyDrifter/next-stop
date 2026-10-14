/**
 * dev 線別解析（並行地基契約 §9；配額＝並行開發公約 §八）。
 *
 * 三條功能線各在自己的 worktree 開 dev，彼此不能撞 vite port，也不能共用 dev identifier
 * （identifier 決定 %APPDATA% 底下的資料夾＝dev 用的 DB）。這支是「哪條線用哪組配額」的唯一來源：
 *   - vite.config.ts 拿 port（vite 由 tauri 的 beforeDevCommand 叫起，只能自己解析）
 *   - scripts/dev.ts 拿設定檔與實際要跑的指令
 *   - scripts/probes/dev-quota.ts 對帳
 *
 * 解析順序（決策 10）：
 *   1. NS_DEV_LINE（去頭尾空白、轉小寫）。五個合法值之一就用它；有值但不合法＝丟錯、不啟動
 *   2. 沒設 ⇒ 看分支名：`feat/(notes|timetable|ticket|core)-…` ⇒ 該線
 *   3. 其餘（main、feat/foundation、detached HEAD、不在 git 裡）⇒ main（主桌配額）
 * 為什麼要看分支名：agent 的 shell 環境變數不跨指令保留，漏設就會靜默用 1425／.dev 撞主桌。
 *
 * 純 TS、只用可剝除語法——node 直接跑（`node scripts/dev.ts`），vite 打包設定檔時也吃得下。
 */
import { execFileSync } from "node:child_process";

export type DevLine = "main" | "notes" | "timetable" | "ticket" | "core";

/** 第五席 core＝主線小車次（調度派的核心功能車次：今日串流、車票預定時刻；公約 §八 2026-10-10 加） */
export const DEV_LINES: readonly DevLine[] = ["main", "notes", "timetable", "ticket", "core"];

/** HMR port 一律是 `port + 1`（只在 TAURI_DEV_HOST 有設時用到）。main 的設定檔就是現行那份，一個字都不動 */
export const DEV_QUOTA: Record<DevLine, { port: number; identifier: string; conf: string }> = {
  main: { port: 1425, identifier: "app.shitetsu.nextstop.dev", conf: "src-tauri/tauri.dev.conf.json" },
  notes: { port: 1435, identifier: "app.shitetsu.nextstop.dev.notes", conf: "src-tauri/tauri.dev.notes.conf.json" },
  timetable: {
    port: 1445,
    identifier: "app.shitetsu.nextstop.dev.timetable",
    conf: "src-tauri/tauri.dev.timetable.conf.json",
  },
  ticket: { port: 1455, identifier: "app.shitetsu.nextstop.dev.ticket", conf: "src-tauri/tauri.dev.ticket.conf.json" },
  core: { port: 1465, identifier: "app.shitetsu.nextstop.dev.core", conf: "src-tauri/tauri.dev.core.conf.json" },
};

const BRANCH_RE = /^feat\/(notes|timetable|ticket|core)-/;

function isDevLine(v: string): v is DevLine {
  return (DEV_LINES as readonly string[]).includes(v);
}

/** 只解析 NS_DEV_LINE 這個值本身（dev.ts 的 `--line` 也走這裡，規則一致） */
export function parseDevLine(raw: string): DevLine {
  const v = raw.trim().toLowerCase();
  if (!isDevLine(v)) {
    throw new Error(`NS_DEV_LINE／--line 的值「${raw}」不認得；合法值：${DEV_LINES.join("、")}`);
  }
  return v;
}

/** 目前分支名；不在 git 裡或指令失敗回 null（detached HEAD 會回 "HEAD"，照規則落到 main） */
export function currentBranch(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * 參數都省略＝讀真的 `process.env` 與真的分支名。測試（probe）傳假的進來。
 * `branch` 傳 `null` 代表「沒有分支資訊」，不會再去問 git。
 */
export function resolveDevLine(
  env: Record<string, string | undefined> = process.env,
  branch?: string | null,
): { line: DevLine; source: "env" | "branch" | "default" } {
  const raw = env.NS_DEV_LINE;
  if (raw !== undefined && raw.trim() !== "") return { line: parseDevLine(raw), source: "env" };
  const b = branch === undefined ? currentBranch() : branch;
  const m = b ? BRANCH_RE.exec(b) : null;
  if (m) return { line: m[1] as DevLine, source: "branch" };
  return { line: "main", source: "default" };
}

/** dev.ts 實際會跑的指令（`pnpm exec` 之後的部分）。main 必須等於現行 `tauri dev -c src-tauri/tauri.dev.conf.json` */
export function devCommand(line: DevLine, mode: "tauri" | "vite"): string[] {
  return mode === "tauri" ? ["tauri", "dev", "-c", DEV_QUOTA[line].conf] : ["vite"];
}
