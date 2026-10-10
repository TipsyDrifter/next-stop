import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { DEV_QUOTA, resolveDevLine } from "./scripts/dev-line";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// dev port 吃線別（並行地基契約 §9.3；配額表在 scripts/dev-line.ts，HMR 用 port + 1）。
// 只在 serve 時解析——build 用不到 port，也不該因為 NS_DEV_LINE 打錯而失敗
const devPort = (command: string) =>
  command === "serve" ? DEV_QUOTA[resolveDevLine().line].port : DEV_QUOTA.main.port;

// https://vite.dev/config/
export default defineConfig(async ({ command }) => ({
  plugins: [react(), tailwindcss()],

  // 產出到 build/：依 file-organization 慣例 dist/ 放軟體產品（安裝包），前端 bundle 不佔用
  build: { outDir: "build" },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: devPort(command),
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: devPort(command) + 1,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
