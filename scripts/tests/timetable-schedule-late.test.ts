/**
 * 時刻表線④・使用者改題 D-時-80「誤點的單發票拖上來」——用記憶體 repository 實測寫入路線（改題席）。
 * 跑法：`node --test scripts/tests/timetable-schedule-late.test.ts`（node 24，型別剝除預設開；零依賴）。
 *
 * store（timetableScheduleStore）本身連著 React／uiStore／tauri，node 載不起來；這裡照 `nodeStore.updateNode` 的兩步
 * （有 scheduled_on ⇒ 先 `reschedule(id, d, 今天)`，再 `update(id, { scheduled_time }, { dateKey, dayStartHour })`）
 * 走 `planTimeWrite`／`planUndo` 吐出來的寫入，確認今日列與 listCalendar 真的換了，並把已知限制（繰越）釘住。
 * 載入法同 `ticket-time.test.ts`：resolve hook 補 `.ts`、`../lib/db` 換替身。
 */
import { describe, test } from "node:test";
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
import type { TimeWrite } from "../../src/domain/timetableSchedule.ts";

const { MemoryNodeRepository } = await import("../../src/data/memoryRepository.ts");
const { fixedRule } = await import("../../src/domain/repeat.ts");
const { lateItemsOf, planTimeWrite, planUndo } = await import("../../src/domain/timetableSchedule.ts");

type Repo = InstanceType<typeof MemoryNodeRepository>;
const H = 6;

/** 照 nodeStore.updateNode 的順序執行一筆 setTime（帶 scheduledOn ⇒ 先改道 reschedule） */
async function exec(repo: Repo, w: TimeWrite, today: string): Promise<void> {
  assert.equal(w.op, "setTime");
  if (w.op !== "setTime") return;
  if (w.scheduledOn !== undefined) await repo.reschedule(w.id, w.scheduledOn, today);
  await repo.update(w.id, { scheduled_time: w.time }, { dateKey: today, dayStartHour: H });
}

describe("D-時-80：誤點單發票 → 排到今天 → 撤回（MemoryNodeRepository）", () => {
  test("seedDemo（mock 的那一份）本來就有誤點的單發票與定期券漏班", async () => {
    const repo = new MemoryNodeRepository();
    repo.seedDemo();
    const today = todayKey(H);
    const late = lateItemsOf(await repo.listToday(today, H), today);
    assert.ok(late.items.length >= 2, `誤點單發票 ${late.items.length} 張`);
    assert.ok(late.repeatCount >= 1, `定期券漏班 ${late.repeatCount} 班`);
    for (const it of late.items) {
      assert.ok(it.lateFrom !== null && it.lateFrom < today);
      assert.equal(it.date, today);
    }
  });

  test("排上去：執行日＝今天、時刻寫進去、今日列不再是誤點、listCalendar 今天有它；撤回：回原日＋原時刻、又是誤點", async () => {
    const repo = new MemoryNodeRepository();
    const today = todayKey(H);
    const from = addDays(today, -3);
    const n = await repo.create({ kind: "ticket", name: "誤點票", parentId: null, scheduledOn: from });
    await repo.update(n.id, { scheduled_time: "09:30", estimate_min: 45 }, { dateKey: today, dayStartHour: H });

    const before = lateItemsOf(await repo.listToday(today, H), today).items.find((i) => i.nodeId === n.id);
    assert.ok(before, "改之前在誤點清單");
    assert.equal(before.time, "09:30");
    assert.equal(before.estimateMin, 45);

    await exec(repo, planTimeWrite(before, "14:15"), today);
    const after = (await repo.listToday(today, H)).find((r) => r.id === n.id);
    assert.equal(after?.bucket, "today");
    assert.equal(after?.scheduled_on, today);
    assert.equal(after?.scheduled_time, "14:15");
    assert.equal(lateItemsOf(await repo.listToday(today, H), today).items.some((i) => i.nodeId === n.id), false);
    const cal = await repo.listCalendar(today, today, { todayDateKey: today, dayStartHour: H });
    assert.equal(cal.entries.find((e) => e.node_id === n.id)?.time, "14:15");
    // reschedule 從過去挪到今天＝繰越：carried_from 記成原日（今日頁會出「自 M/D 繰越」）
    assert.equal(after?.carried_from, from);

    await exec(repo, planUndo(before), today);
    const back = (await repo.listToday(today, H)).find((r) => r.id === n.id);
    assert.equal(back?.bucket, "late");
    assert.equal(back?.scheduled_on, from);
    assert.equal(back?.scheduled_time, "09:30");
    // 已知限制（施工回報〈使用者改題〉）：撤回不會把 carried_from 還原成改之前的值（這張原本是 null）
    assert.equal(back?.carried_from, from);
  });

  test("定期券漏班：改執行日會被主線擋（REPEAT_RESCHEDULE_MSG）——所以不進清單", async () => {
    const repo = new MemoryNodeRepository();
    repo.seedDemo();
    const today = todayKey(H);
    const rows = await repo.listToday(today, H);
    const rep = rows.find((r) => r.bucket === "late" && r.repeat_rule && r.occurrence === null && r.status !== "done");
    assert.ok(rep, "seed 有一班定期券漏班");
    await assert.rejects(repo.reschedule(rep.id, today, today));
  });
});

describe("沙盒後修正 觀察一：每天一班的定期券前一班沒済，今天不算漏班（D-④-4 漏班收斂為最新一班）", () => {
  /** 那一天的星期幾（0＝週日；同 seedDemo 的 dow） */
  const dowOf = (key: string): number => {
    const [y, m, d] = key.split("-").map(Number);
    return new Date(y, m - 1, d).getDay();
  };

  test("每天一班：昨天那班沒交代 ⇒ 換到今天時引擎把班次推到今天（bucket today），lateRepeatCount 0", async () => {
    const repo = new MemoryNodeRepository();
    const today = todayKey(H);
    const yesterday = addDays(today, -1);
    const n = await repo.create({ kind: "ticket", name: "每天一班", parentId: null });
    // 昨天建、昨天那班就是目前班次（scheduled_on＝昨天）
    await repo.setRepeatRule(n.id, fixedRule("daily", addDays(today, -5)), yesterday, H);
    assert.equal((await repo.getNode(n.id))?.scheduled_on, yesterday);
    // 今日切片還停在昨天（＝F1 的狀況）時，它在昨天那份是 today、不是 late
    const stale = (await repo.listToday(yesterday, H)).find((r) => r.id === n.id);
    assert.equal(stale?.bucket, "today");
    // 換日：loadToday(今天) 會先 syncRepeats(今天) ⇒ 班次推到今天；昨天那班沒有記錄＝只留統計缺口，不是漏班
    await repo.syncRepeats(today, H);
    const rows = await repo.listToday(today, H);
    const row = rows.find((r) => r.id === n.id);
    assert.equal(row?.scheduled_on, today);
    assert.equal(row?.bucket, "today");
    assert.equal(lateItemsOf(rows, today).repeatCount, 0);
  });

  test("對照：每週一班、上一個規則日（2 天前）沒交代 ⇒ 班次停在那天（late），lateRepeatCount 1", async () => {
    const repo = new MemoryNodeRepository();
    const today = todayKey(H);
    const missed = addDays(today, -2);
    const n = await repo.create({ kind: "ticket", name: "每週一班", parentId: null });
    await repo.setRepeatRule(n.id, fixedRule("weekly", addDays(today, -20), { byweekday: [dowOf(missed)] }), missed, H);
    await repo.syncRepeats(today, H);
    const rows = await repo.listToday(today, H);
    const row = rows.find((r) => r.id === n.id);
    assert.equal(row?.scheduled_on, missed);
    assert.equal(row?.bucket, "late");
    assert.equal(lateItemsOf(rows, today).repeatCount, 1);
  });
});
