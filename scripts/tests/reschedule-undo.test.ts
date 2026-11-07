/**
 * 推遲後按復原：票回到原本的手排位置，不掉到今天清單最後（點子清單 2026-11-01 回饋乙 F-2）。
 * 跑法：`node --test scripts/tests/reschedule-undo.test.ts`（載入法同 core-polish7.test.ts）。
 * 這裡照 `nodeStore.updateNode` 的兩步走（reschedule 再 update 其餘欄位），store 只是把這兩步串起來。
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

import { addDays, todayKey } from "../../src/lib/date.ts";

const { MemoryNodeRepository } = await import("../../src/data/memoryRepository.ts");

const H = 6;
const TODAY = todayKey(H);
const TOMORROW = addDays(TODAY, 1);

/** 今天三張票，手排成 a b c */
async function threeTickets() {
  const repo = new MemoryNodeRepository();
  const line = await repo.create({ kind: "line", name: "線", parentId: null });
  const route = await repo.create({ kind: "route", name: "路", parentId: line.id });
  const train = await repo.create({ kind: "train", name: "車", parentId: route.id });
  const mk = (name: string) => repo.create({ kind: "ticket", name, parentId: train.id, scheduledOn: TODAY });
  const [a, b, c] = [await mk("a"), await mk("b"), await mk("c")];
  await repo.assignTodayPositions([a.id, b.id, c.id]);
  const names = async () =>
    (await repo.listToday(TODAY, H)).filter((r) => r.bucket === "today" && ["a", "b", "c"].includes(r.name)).map((r) => r.name);
  return { repo, a, b, c, names };
}

async function undo(repo: InstanceType<typeof MemoryNodeRepository>, id: string, snap: { scheduled_on: string | null; carried_from: string | null; today_position: number | null }) {
  const { scheduled_on, ...rest } = snap;
  await repo.reschedule(id, scheduled_on, TODAY);
  await repo.update(id, rest, { dateKey: TODAY, dayStartHour: H });
}

test("推遲中間那張再復原 ⇒ 回到原位、沒有多一枚繰越章", async () => {
  const { repo, b, names } = await threeTickets();
  const node = (await repo.getNode(b.id))!;
  const snap = { scheduled_on: node.scheduled_on, carried_from: node.carried_from, today_position: node.today_position };
  assert.equal(snap.today_position, 1);

  await repo.reschedule(b.id, TOMORROW, TODAY);
  assert.deepEqual(await names(), ["a", "c"], "推遲後離開今天");
  assert.equal((await repo.getNode(b.id))?.today_position, null, "離開今天會清掉手排位置");

  await undo(repo, b.id, snap);
  assert.deepEqual(await names(), ["a", "b", "c"], "復原回到中間，不掉到最後");
  const after = (await repo.getNode(b.id))!;
  assert.equal(after.scheduled_on, TODAY);
  assert.equal(after.carried_from, null, "反悔完票上不留繰越章");
  assert.equal(after.today_position, 1);
});

test("清除執行日再復原 ⇒ 同樣回到原位", async () => {
  const { repo, a, names } = await threeTickets();
  const node = (await repo.getNode(a.id))!;
  const snap = { scheduled_on: node.scheduled_on, carried_from: node.carried_from, today_position: node.today_position };
  await repo.reschedule(a.id, null, TODAY);
  assert.deepEqual(await names(), ["b", "c"]);
  await undo(repo, a.id, snap);
  assert.deepEqual(await names(), ["a", "b", "c"]);
});

test("沒有手排位置的票復原 ⇒ 照舊走新聚合尾插，不會寫出奇怪的值", async () => {
  const { repo, c, names } = await threeTickets();
  await repo.update(c.id, { today_position: null }, { dateKey: TODAY, dayStartHour: H });
  const node = (await repo.getNode(c.id))!;
  const snap = { scheduled_on: node.scheduled_on, carried_from: node.carried_from, today_position: node.today_position };
  await repo.reschedule(c.id, TOMORROW, TODAY);
  await undo(repo, c.id, snap);
  assert.deepEqual(await names(), ["a", "b", "c"]);
});
