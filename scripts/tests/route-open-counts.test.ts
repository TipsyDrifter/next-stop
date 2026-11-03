/**
 * 回饋甲 D-主-130：路線列尾的未完成數（repository `routeOpenCounts`／純函式 buildRouteOpenCounts）。
 * 末端（沒有活著的子項）、未済的列車／車廂／車票，依 route_id 分組；掛路線標籤的臨時車票算進那條路線；收件匣的票不算。
 * 走記憶體 repository（SQLite 版是同一組條件的一句 GROUP BY）。跑法：`node --test scripts/tests/route-open-counts.test.ts`。
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

test("只數末端、未済的列車／車廂／車票；臨時票跟著路線標籤；收件匣不算", async () => {
  const repo = new MemoryNodeRepository();
  const line = await repo.create({ kind: "line", name: "學習", parentId: null });
  const ja = await repo.create({ kind: "route", name: "日文", parentId: line.id });
  const en = await repo.create({ kind: "route", name: "英文", parentId: line.id });
  // 日文：列車（有車廂＝不是末端）→ 車廂（有票＝不是末端）→ 兩張票（一張済）；另一班空列車（末端）；車站不算
  const train = await repo.create({ kind: "train", name: "文法", parentId: ja.id });
  const car = await repo.create({ kind: "car", name: "第一課", parentId: train.id });
  await repo.create({ kind: "ticket", name: "背單字", parentId: car.id });
  const doneTicket = await repo.create({ kind: "ticket", name: "做練習", parentId: car.id });
  await repo.create({ kind: "train", name: "聽力", parentId: ja.id });
  await repo.create({ kind: "station", name: "N3", parentId: ja.id });
  // 掛日文標籤的臨時車票＋收件匣的臨時車票
  await repo.create({ kind: "ticket", name: "查字典", parentId: null, routeTagId: ja.id });
  await repo.create({ kind: "ticket", name: "沒地方放", parentId: null });
  await repo.setCompleted(doneTicket.id, true);

  const counts = await repo.routeOpenCounts();
  // 背單字＋聽力＋查字典
  assert.equal(counts[ja.id], 3);
  assert.equal(counts[en.id], undefined, "0 的路線不出現");

  // 子項全刪掉＝車廂變回末端
  const desc = await repo.listRouteTree(ja.id);
  for (const n of desc.filter((x) => x.parent_id === car.id)) await repo.softDelete(n.id);
  const after = await repo.routeOpenCounts();
  // 第一課（末端了）＋聽力＋查字典
  assert.equal(after[ja.id], 3);
});
