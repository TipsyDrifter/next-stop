/**
 * Rust `src-tauri/src/mcp/config.rs` 的埠表 ↔ `scripts/dev-line.ts` 的 dev 席位對帳（契約 §3：兩處收不進同一個常數，用測試比對）。
 * 每個 dev identifier 都要有自己的埠、彼此不撞、正式版固定 18920；新增 dev 線時漏配埠，這裡就紅。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEV_QUOTA } from "../dev-line.ts";

const src = readFileSync(new URL("../../src-tauri/src/mcp/config.rs", import.meta.url), "utf8");
const table = new Map([...src.matchAll(/\("(app\.shitetsu\.nextstop[a-z0-9.]*)",\s*(\d+)\)/g)].map((m) => [m[1], Number(m[2])]));

test("正式版 18920；每條 dev 線都有埠、互不相撞", () => {
  assert.equal(table.get("app.shitetsu.nextstop"), 18920);
  for (const [line, q] of Object.entries(DEV_QUOTA)) {
    assert.ok(table.has(q.identifier), `dev 線 ${line}（${q.identifier}）在 config.rs 沒有埠`);
  }
  const ports = [...table.values()];
  assert.equal(new Set(ports).size, ports.length, `埠重複：${ports}`);
});
