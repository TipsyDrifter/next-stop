/**
 * 主線・磨光⑦（試用回饋第二班）——記憶體 repository 測試。SQLite 版同一套規則在沙盒驗（契約 §7）。
 * 跑法：`node --test scripts/tests/core-polish7.test.ts`（node 24，型別剝除預設開；零依賴）。
 * 載入法同 `ticket-time.test.ts`：`module.registerHooks` 補 `.ts`、把 `../lib/db` 換成替身。
 *
 * - D-主-68（接縫 #102）：今天先済每日定期券、再把它所在的列車「一起完成」⇒ 今日清單還要看得到那張票。
 * - D-主-67：日期欄親手選到今天以前＝補記（直接済在那一天）；推遲、復原不算。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

const FAKE_DB = `
let t = Date.now(); // 接近真實時間：今天蓋的章要落在真實的日界線視窗內
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

// 靜態 import 會在 registerHooks 之前就被載入，所以需要 resolve hook 的檔一律動態 import
const { MemoryNodeRepository } = await import("../../src/data/memoryRepository.ts");
const { fixedRule } = await import("../../src/domain/repeat.ts");

const H = 6;
const TODAY = todayKey(H);

async function trainWithDaily() {
  const repo = new MemoryNodeRepository();
  const line = await repo.create({ kind: "line", name: "日語", parentId: null });
  const route = await repo.create({ kind: "route", name: "N5", parentId: line.id });
  const train = await repo.create({ kind: "train", name: "N5 文法", parentId: route.id, scheduledOn: TODAY });
  const daily = await repo.create({ kind: "ticket", name: "背 N5 單字", parentId: train.id, scheduledOn: TODAY });
  await repo.setRepeatRule(daily.id, fixedRule("daily", addDays(TODAY, -7)), TODAY, H);
  return { repo, train, daily };
}

describe("#102 今日清單收「今天済過、同一天又被上層一起完成退役」的定期券", () => {
  test("先済定期券、再一起完成列車 ⇒ 定期券退役，但今日清單還在、落在今天、班次是済", async () => {
    const { repo, train, daily } = await trainWithDaily();
    await repo.setCompleted(daily.id, true, { dateKey: TODAY, dayStartHour: H });
    assert.ok((await repo.listToday(TODAY, H)).some((r) => r.id === daily.id), "済完當下就在");

    await repo.setCompleted(train.id, true, { cascade: true, dateKey: TODAY, dayStartHour: H });
    const node = await repo.getNode(daily.id);
    assert.equal(node?.status, "done", "連帶完成＝退役");
    assert.ok(node?.scheduled_on && node.scheduled_on > TODAY, "scheduled_on 已被推到明天（舊查詢第四條撈不到的原因）");

    const row = (await repo.listToday(TODAY, H)).find((r) => r.id === daily.id);
    assert.ok(row, "退役後今日清單還看得到");
    assert.equal(row.bucket, "today");
    assert.equal(row.occurrence?.status, "done");
  });

  test("今天沒交代過、只是被連帶退役的定期券 ⇒ 照舊不冒出來（連帶完成不寫班次紀錄）", async () => {
    const { repo, train, daily } = await trainWithDaily();
    // 定期券排在明天才有班（今天不是它的班次日）：直接把列車一起完成
    await repo.setRepeatRule(daily.id, fixedRule("daily", addDays(TODAY, 1)), TODAY, H);
    await repo.setCompleted(train.id, true, { cascade: true, dateKey: TODAY, dayStartHour: H });
    assert.equal((await repo.getNode(daily.id))?.status, "done");
    assert.equal((await repo.listToday(TODAY, H)).some((r) => r.id === daily.id), false);
  });
});

const { backfillAtOf } = await import("../../src/data/nodeRepository.ts");
const { dayWindow } = await import("../../src/lib/date.ts");

describe("D-主-67 日期欄親手選到今天以前＝補記（直接済在那一天）", () => {
  const YDAY = addDays(TODAY, -1);
  const lastSec = (day: string): string => new Date(Date.parse(dayWindow(day, H).end) - 1000).toISOString();

  test("backfill：未済的單張票改到昨天 ⇒ 済、完成時刻＝昨天日界線前一秒、済事件同時刻；不進今天的今日清單", async () => {
    const repo = new MemoryNodeRepository();
    const t = await repo.create({ kind: "ticket", name: "補寫日記", parentId: null, scheduledOn: TODAY });
    const r = await repo.reschedule(t.id, YDAY, TODAY, { backfill: true, dayStartHour: H });
    assert.deepEqual(r, { backfilled: true });
    const n = await repo.getNode(t.id);
    assert.equal(n?.status, "done");
    assert.equal(n?.scheduled_on, YDAY);
    assert.equal(n?.completed_at, lastSec(YDAY));
    assert.equal(n?.carried_from, null, "往過去挪不長繰越");
    const done = (await repo.listWorkLogs(t.id)).filter((l) => l.event === "done");
    assert.equal(done.length, 1);
    assert.equal(done[0].logged_at, lastSec(YDAY));
    assert.equal((await repo.listToday(TODAY, H)).some((x) => x.id === t.id), false, "不進今天的清單（不會冒延着）");
  });

  test("有預定時刻 ⇒ 完成時刻＝那天那個時刻；25:00＝隔天 01:00（營業日表記）", () => {
    const base = { status: "todo" as const, repeat_rule: null };
    assert.equal(backfillAtOf({ ...base, scheduled_time: "14:00" }, YDAY, TODAY, H, 0), new Date(`${YDAY}T14:00:00`).toISOString());
    const [y, m, d] = YDAY.split("-").map(Number);
    assert.equal(backfillAtOf({ ...base, scheduled_time: "25:00" }, YDAY, TODAY, H, 0), new Date(y, m - 1, d + 1, 1, 0).toISOString());
  });

  test("不算補記的：沒帶 backfill（推遲／復原）、改到今天或以後、已済、有未完成子票", async () => {
    const repo = new MemoryNodeRepository();
    const late = await repo.create({ kind: "ticket", name: "誤點票", parentId: null, scheduledOn: TODAY });
    assert.deepEqual(await repo.reschedule(late.id, YDAY, TODAY), { backfilled: false });
    assert.equal((await repo.getNode(late.id))?.status, "todo", "復原把誤點票放回過去的原執行日，不是補記");
    assert.deepEqual(await repo.reschedule(late.id, TODAY, TODAY, { backfill: true, dayStartHour: H }), { backfilled: false });
    const base = { status: "todo" as const, repeat_rule: null, scheduled_time: null };
    assert.equal(backfillAtOf(base, null, TODAY, H, 0), null);
    assert.equal(backfillAtOf({ ...base, status: "done" }, YDAY, TODAY, H, 0), null);
    assert.equal(backfillAtOf(base, YDAY, TODAY, H, 1), null, "有未完成子票的列車照舊誤點，不連帶完成整串");

    const { repo: r2, train } = await trainWithDaily();
    assert.deepEqual(await r2.reschedule(train.id, YDAY, TODAY, { backfill: true, dayStartHour: H }), { backfilled: false });
    assert.equal((await r2.getNode(train.id))?.status, "todo");
  });
});
