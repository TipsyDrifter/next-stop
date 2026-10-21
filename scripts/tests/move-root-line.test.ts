/**
 * 磨光⑤ 沙盒 F1：臨時車票搬進列車再搬回根層（「移動到…」的復原），line_id 要跟著路線標籤的幹線，
 * 不能寫成 null（對面那台整表重算會算出幹線，兩台就對不起來）。
 * 跑法：`node --test scripts/tests/move-root-line.test.ts`。載入替身照 ticket-time.test.ts。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
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
      if (specifier === "../lib/db") return { url: dataUrl(FAKE_DB), shortCircuit: true };
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

const { MemoryNodeRepository } = await import("../../src/data/memoryRepository.ts");

test("臨時車票搬進同路線列車再搬回根層：line_id 回到路線標籤的幹線", async () => {
  const repo = new MemoryNodeRepository();
  const line = await repo.create({ kind: "line", name: "學習", parentId: null });
  const route = await repo.create({ kind: "route", name: "日文", parentId: line.id });
  const train = await repo.create({ kind: "train", name: "文法", parentId: route.id });
  const ticket = await repo.create({ kind: "ticket", name: "臨時", parentId: null, routeTagId: route.id });
  assert.equal(ticket.line_id, line.id);

  await repo.move(ticket.id, train.id, 0);
  await repo.move(ticket.id, null, 0);
  const back = await repo.getNode(ticket.id);
  assert.equal(back?.route_id, route.id);
  assert.equal(back?.line_id, line.id);
});

test("沒有路線標籤的根層節點搬回根層：line_id 仍是 null", async () => {
  const repo = new MemoryNodeRepository();
  const line = await repo.create({ kind: "line", name: "學習", parentId: null });
  const route = await repo.create({ kind: "route", name: "日文", parentId: line.id });
  const train = await repo.create({ kind: "train", name: "文法", parentId: route.id });
  const ticket = await repo.create({ kind: "ticket", name: "收件匣", parentId: null });
  await repo.move(ticket.id, train.id, 0);
  await repo.move(ticket.id, null, 0);
  const back = await repo.getNode(ticket.id);
  // 搬進列車時 route_id 已被快取成那條路線；搬回根層保留它當標籤，line_id 跟著
  assert.equal(back?.line_id, back?.route_id ? line.id : null);
});
