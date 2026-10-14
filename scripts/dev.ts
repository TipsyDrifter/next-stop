/**
 * dev 啟動器（並行地基契約 §9.4）。線別規則見 scripts/dev-line.ts。
 *
 *   node scripts/dev.ts print                     印出解析結果與實際會跑的指令，不啟動任何東西（＝pnpm dev:which）
 *   node scripts/dev.ts tauri [--line <線別>]     pnpm exec tauri dev -c <該線設定檔>（＝pnpm tauri:dev）
 *   node scripts/dev.ts vite  [--line <線別>]     pnpm exec vite
 *
 * `--line` 優先於 NS_DEV_LINE。決定好的線別會寫回子行程的 NS_DEV_LINE，
 * 讓 tauri 的 beforeDevCommand（pnpm dev → vite.config.ts）解析出同一條線、同一個 port。
 */
import { spawn } from "node:child_process";
import { DEV_QUOTA, devCommand, parseDevLine, resolveDevLine } from "./dev-line.ts";
import type { DevLine } from "./dev-line.ts";

const USAGE = "用法：node scripts/dev.ts <print|tauri|vite> [--line <main|notes|timetable|ticket|core>]";

function fail(msg: string): never {
  console.error(`[dev] ${msg}`);
  process.exit(1);
}

const [mode, ...rest] = process.argv.slice(2);
if (mode !== "print" && mode !== "tauri" && mode !== "vite") fail(USAGE);

let forced: DevLine | null = null;
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === "--line" && i + 1 < rest.length) {
    try {
      forced = parseDevLine(rest[++i]);
    } catch (e) {
      fail((e as Error).message);
    }
  } else {
    fail(`不認得的參數「${rest[i]}」。${USAGE}`);
  }
}

let line: DevLine;
let source: string;
if (forced) {
  line = forced;
  source = "--line";
} else {
  try {
    ({ line, source } = resolveDevLine());
  } catch (e) {
    fail((e as Error).message);
  }
}

const q = DEV_QUOTA[line];
const runMode = mode === "print" ? "tauri" : mode;
const args = ["exec", ...devCommand(line, runMode)];
const shown = `pnpm ${args.join(" ")}`;

if (mode === "print") {
  console.log(`線別        ${line}（來源：${source}）`);
  console.log(`vite port   ${q.port}`);
  console.log(`identifier  ${q.identifier}`);
  console.log(`設定檔      ${q.conf}`);
  console.log(`tauri 指令  ${shown}`);
  console.log(`vite 指令   pnpm exec ${devCommand(line, "vite").join(" ")}`);
  process.exit(0);
}

console.log(`[dev] 線別 ${line}（來源：${source}）· port ${q.port} · ${q.identifier} → ${shown}`);
// Windows 上 pnpm 是 .cmd，要 shell:true 才叫得起來；參數只有固定字與相對路徑，沒有要跳脫的字元
const child = spawn("pnpm", args, {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, NS_DEV_LINE: line },
});
child.on("error", (e) => fail(`啟動失敗：${e.message}`));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
