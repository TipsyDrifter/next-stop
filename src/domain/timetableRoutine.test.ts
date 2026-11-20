/**
 * v1.33 第三梯 3B・作息範本生效區間（G2：起日 start_day ～ 結束日 end_day）單元測試
 * 涵蓋：
 *   1. 日期格式與起訖順序驗證（checkRoutineDates / normalizeRoutineDate）
 *   2. 邊界日落地判定（day < start_day、day === start_day、區間內、day === end_day、day > end_day）
 *   3. 已到期範本狀態與小籤文案（已到期（YYYY-MM-DD 止）），不必封存即自動停止排入新日程
 *   4. 歷史已落地的日程（time_plans）在範本到期後依然完整保留不變
 *   5. 學期交替（weekdayOwners）：已到期範本或區間不重疊範本不會佔用新範本的週幾
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  WEEKDAYS_WORK,
  autoRoutineFor,
  checkRoutineDates,
  dayRoutineOf,
  isRoutineActiveOn,
  isRoutineExpired,
  materializeRows,
  planApplyRoutine,
  planEnsureMaterialized,
  routineRangeStatus,
  routinesOverlapDates,
  serializeRoutineItems,
  weekdayOwners,
  type TimePlanRow,
  type TimeRoutineRow,
} from "./timetableRoutine.ts";

function mkRoutine(id: string, overrides: Partial<TimeRoutineRow> = {}): TimeRoutineRow {
  return {
    id,
    name: `範本 ${id}`,
    items: serializeRoutineItems([
      { cat: "c-study", s: "09:00", e: "12:00", n: "上午課程" },
      { cat: "c-code", s: "14:00", e: "17:00", n: "專題實作" },
    ]),
    weekdays: WEEKDAYS_WORK, // 週一～週五
    start_day: null,
    end_day: null,
    position: 0,
    archived_at: null,
    account_id: null,
    device_id: null,
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
    synced_at: null,
    deleted_at: null,
    ...overrides,
  };
}

describe("G2 · 作息範本生效起日／結束日（start_day ～ end_day）", () => {
  test("checkRoutineDates：支援單填起日、單填結束日、雙填或全空（長期有效）；無效日期與結束早於起日拋出 RangeError", () => {
    assert.deepEqual(checkRoutineDates(null, null), { start_day: null, end_day: null });
    assert.deepEqual(checkRoutineDates("", "  "), { start_day: null, end_day: null });
    assert.deepEqual(checkRoutineDates("2026-09-07", null), { start_day: "2026-09-07", end_day: null });
    assert.deepEqual(checkRoutineDates(null, "2027-01-15"), { start_day: null, end_day: "2027-01-15" });
    assert.deepEqual(checkRoutineDates("2026-09-07", "2026-09-07"), {
      start_day: "2026-09-07",
      end_day: "2026-09-07",
    });

    assert.throws(() => checkRoutineDates("2026-09-10", "2026-09-09"), /不能早於/);
    assert.throws(() => checkRoutineDates("2026-02-30", null), /日期格式/);
    assert.throws(() => checkRoutineDates(null, "2026/12/31"), /日期格式/);
  });

  test("autoRoutineFor & planEnsureMaterialized：精準遵守 start_day 與 end_day 邊界（含當天有效，範圍外不排入）", async () => {
    // 2026-09-07（週一）～ 2026-09-11（週五）生效的短期課表
    const sem = mkRoutine("fall", {
      name: "大三上課表",
      start_day: "2026-09-07",
      end_day: "2026-09-11",
      position: 0,
    });

    // 起日之前（2026-09-04 週五）：不生效
    assert.equal(isRoutineActiveOn(sem, "2026-09-04"), false);
    assert.equal(autoRoutineFor("2026-09-04", [sem]), null);
    assert.deepEqual(await planEnsureMaterialized("2026-09-04", [], [sem]), []);

    // 起日當天（2026-09-07 週一）：生效！
    assert.equal(isRoutineActiveOn(sem, "2026-09-07"), true);
    assert.equal(autoRoutineFor("2026-09-07", [sem])?.id, "fall");
    assert.equal((await planEnsureMaterialized("2026-09-07", [], [sem])).length, 2);

    // 結束日當天（2026-09-11 週五）：生效！
    assert.equal(isRoutineActiveOn(sem, "2026-09-11"), true);
    assert.equal(autoRoutineFor("2026-09-11", [sem])?.id, "fall");
    assert.equal((await planEnsureMaterialized("2026-09-11", [], [sem])).length, 2);

    // 結束日之後（2026-09-14 下週一）：自動停止排入新日程！
    assert.equal(isRoutineActiveOn(sem, "2026-09-14"), false);
    assert.equal(autoRoutineFor("2026-09-14", [sem]), null);
    assert.deepEqual(await planEnsureMaterialized("2026-09-14", [], [sem]), []);
    // 「這天不套」也不需要為已到期範本多寫墓碑列
    assert.deepEqual(await planApplyRoutine("2026-09-14", [], null, [sem]), { upserts: [], deletes: [] });
  });

  test("過去已落地的歷史日程保持完整不變，且管理清單顯示溫和的「已到期（YYYY-MM-DD 止）」小籤", async () => {
    const sem = mkRoutine("fall", {
      name: "大三上課表",
      start_day: "2026-09-07",
      end_day: "2027-01-15",
    });

    // 在 2027-01-15（週五）落地成 time_plans 列
    const landedUpserts = await materializeRows("2027-01-15", sem);
    const landedRows: TimePlanRow[] = landedUpserts.map((u) => ({
      id: u.id,
      day: u.day,
      start_hm: u.start_hm,
      end_hm: u.end_hm,
      category_id: u.category_id,
      node_id: u.node_id,
      routine_id: u.routine_id,
      label: u.label,
      account_id: null,
      device_id: null,
      created_at: "2027-01-15T06:00:00.000Z",
      updated_at: "2027-01-15T06:00:00.000Z",
      synced_at: null,
      deleted_at: null,
    }));

    // 時間來到 2027-02-22（下學期開學，舊課表早已到期且未手動封存）
    const today = "2027-02-22";
    assert.equal(isRoutineExpired(sem, today), true);
    const status = routineRangeStatus(sem, today);
    assert.equal(status.expired, true);
    assert.equal(status.badge, "已到期（2027-01-15 止）");

    // 回頭翻看 2027-01-15：已落地的歷史日程完整保留！
    const pastDay = await dayRoutineOf("2027-01-15", landedRows, [sem], today);
    assert.equal(pastDay.materialized, true);
    assert.equal(pastDay.routineId, "fall");
    assert.equal(pastDay.segs.length, 2);

    // 看今天 2027-02-22（週一）：舊課表不再自動顯示或落地
    const curDay = await dayRoutineOf("2027-02-22", [], [sem], today);
    assert.equal(curDay.materialized, false);
    assert.equal(curDay.routineId, null);
    assert.equal(curDay.segs.length, 0);
  });

  test("學期無縫交接：已到期或區間不重疊的前序範本不會卡住新範本的自動落地與週幾歸屬", () => {
    const fall = mkRoutine("fall", {
      name: "上學期課表",
      start_day: "2026-09-07",
      end_day: "2027-01-15",
      position: 0,
    });
    const spring = mkRoutine("spring", {
      name: "下學期課表",
      start_day: "2027-02-22",
      end_day: "2027-06-25",
      position: 1,
    });

    assert.equal(routinesOverlapDates(fall, spring), false);
    // 上學期週一選 fall，下學期週一自動交棒給 spring（不必手動封存 fall）
    assert.equal(autoRoutineFor("2026-10-12", [fall, spring])?.id, "fall");
    assert.equal(autoRoutineFor("2027-03-01", [fall, spring])?.id, "spring");
    // 寒假期間（2027-02-01 週一）兩者皆不套用
    assert.equal(autoRoutineFor("2027-02-01", [fall, spring]), null);

    // 編輯 spring 時，fall 的區間不重疊，週一～週五不會被標成「已給上學期課表」
    const ownersForSpring = weekdayOwners([fall, spring], { today: "2026-12-01", forRoutine: spring });
    assert.equal(ownersForSpring[0], "spring");
    // 在 2027-03-01，fall 已到期，傳入 today 時週一歸屬 spring
    const ownersInSpring = weekdayOwners([fall, spring], "2027-03-01");
    assert.equal(ownersInSpring[0], "spring");
  });
});
