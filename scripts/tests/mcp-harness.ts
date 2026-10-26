/**
 * MCP 工具層的測試環境（契約 §7）：把 `../lib/db` 換成替身、補 `.ts` 副檔名，再用 memory repository 組一份 `McpCtx`。
 * 各模組的測試檔第一行 `import "./mcp-harness.ts"`（先裝載入鉤子），之後才 import `src/mcp/**`。
 * 跑法：`node --test "scripts/tests/mcp-*.test.ts"`（node 24 型別剝除；零依賴）。
 */
import { registerHooks } from "node:module";

const FAKE_DB = `
let t = Date.now();
export function getDb() { throw new Error("測試不碰 sqlite"); }
export function uuid() { return crypto.randomUUID(); }
export function nowUtcIso() { t += 1000; return new Date(t).toISOString(); }
`;
const dataUrl = (src: string) => "data:text/javascript," + encodeURIComponent(src);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const fromSrc = context.parentURL !== undefined && context.parentURL.includes("/src/");
    if (fromSrc) {
      if (specifier === "../lib/db" || specifier === "../../lib/db") return { url: dataUrl(FAKE_DB), shortCircuit: true };
      if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) {
        try {
          return nextResolve(specifier + ".ts", context);
        } catch {
          return nextResolve(specifier + "/index.ts", context);
        }
      }
    }
    return nextResolve(specifier, context);
  },
});

export type { McpCtx } from "../../src/mcp/types.ts";
