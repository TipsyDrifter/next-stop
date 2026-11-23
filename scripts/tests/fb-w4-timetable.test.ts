/**
 * 第四梯回饋專卷（fe-pickers-board · D-FB-7）時刻表日程整合單元測試：
 *   1. 4A／4B／4C 統一顯示推導 `planItemDisplay`（預留席虛線卡、轉正、Mode A 本班填空、Mode B 待辦入座、期間自由券區間徽章）
 *   2. 空白軸上下拖拉區間計算 `computeDragCreateRange`（正向／反向拖拉、15m 吸附、日界夾限）
 *   3. Mode B 待辦入座資格與排序（`canSeatIntoSlot`、`isEligibleSeatCandidate`、`sortSeatCandidates`）
 *   4. `schedBlocksOf` 對 Mode B 入座車票繼承母預留時長（無獨立預估時繼承 `slotEstimateMin` 撐開完整車廂高度與並排車道，不壓成 30m 無預估細條）
 *   5. 端到端投影串接（`MemoryNodeRepository` → `listToday` / `listCalendar` → `timeGridModel` → `planItemOf` → `schedBlocksOf` → `daySummary`）：
 *      - 4A 預留席雙向同步（今日頁 ⇄ 時刻表日程）與原地轉正
 *      - 4C Mode A 本班填空僅套用當班、下週維持原名
 *      - 4C Mode B 待辦入座隱藏空殼、單一區塊滿高渲染、`daySummary` 時數只算一次（不雙重計算）、釋出後還原
 *      - 4B 期間自由券排上時刻表日程軸自動收斂為單日票，撤回還原區間
 *
 * 跑法：`node --test scripts/tests/fb-w4-timetable.test.ts`
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    const fromSrc = context.parentURL !== undefined && context.parentURL.includes("/src/");
    if (fromSrc && specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) {
      try {
        return nextResolve(specifier + ".ts", context);
      } catch {
        return nextResolve(specifier + "/index.ts", context);
      }
    }
    return nextResolve(specifier, context);
  },
});

const {
  ADD_PLACEHOLDER_KEY,
  PLACEHOLDER_UI,
  canSeatIntoSlot,
  computeDragCreateRange,
  isAddPlaceholder,
  isEligibleSeatCandidate,
  isPlaceholderNode,
  planItemDisplay,
  sortSeatCandidates,
} = await import("../../src/ui/timetable/schedule/scheduleSeatModel.ts");
const { schedBlocksOf } = await import("../../src/ui/timetable/schedule/slotModel.ts");
const { timeGridModel } = await import("../../src/ui/schedule/timeGridModel.ts");
const {
  daySummary,
  planItemOf,
  planTimeWrite,
  planUndo,
} = await import("../../src/domain/timetableSchedule.ts");
const { fixedRule } = await import("../../src/domain/repeat.ts");
const { MemoryNodeRepository } = await import("../../src/data/memoryRepository.ts");

describe("4A／4B／4C：planItemDisplay 統一顯示推導", () => {
  test("4A 預留席車票（is_placeholder = 1）呈現虛線標記與「預留席」小牌，轉正後恢復實線正式車票", () => {
    const placeholderDisp = planItemDisplay(
      { kind: "single", customTitle: null, seatedInto: null },
      { name: "預留席", is_placeholder: 1, scheduled_on: "2026-10-05", scheduled_end: null },
      "數學",
    );
    assert.equal(placeholderDisp.isPlaceholder, true);
    assert.equal(placeholderDisp.badgeKind, "placeholder");
    assert.equal(placeholderDisp.badgeText, PLACEHOLDER_UI.tag);
    assert.equal(placeholderDisp.title, "預留席");

    const promotedDisp = planItemDisplay(
      { kind: "single", customTitle: null, seatedInto: null },
      { name: "算微積分習題", is_placeholder: null, scheduled_on: "2026-10-05", scheduled_end: null },
      "數學",
    );
    assert.equal(promotedDisp.isPlaceholder, false);
    assert.equal(promotedDisp.badgeKind, null);
    assert.equal(promotedDisp.badgeText, null);
    assert.equal(promotedDisp.title, "算微積分習題");
  });

  test("4C Mode A 本班填空呈現「具體內容（↻ 母定期名）」，不畫虛線框", () => {
    const disp = planItemDisplay(
      { kind: "repeat", customTitle: "念線代 Ch.3", seatedInto: null },
      { name: "學習", is_placeholder: null, scheduled_on: "2026-10-05", scheduled_end: null },
      "資工",
    );
    assert.equal(disp.title, "念線代 Ch.3");
    assert.equal(disp.originNote, "↻ 學習");
    assert.equal(disp.fullTitle, "念線代 Ch.3（↻ 學習）");
    assert.equal(disp.isPlaceholder, false);
    assert.equal(disp.badgeKind, "filled");
    assert.equal(disp.badgeText, "↻ 學習");
  });

  test("4C Mode B 待辦入座呈現「待辦名（入座 ↻ 母空位名）」與「入座 母單次預留名」", () => {
    const recurringSeat = planItemDisplay(
      {
        kind: "single",
        customTitle: null,
        seatedInto: {
          slotNodeId: "slot-1",
          slotName: "學習",
          dueOn: "2026-10-05",
          isRecurring: true,
          slotTime: "14:00",
          slotEstimateMin: 120,
        },
      },
      { name: "寫作業 2", is_placeholder: null, scheduled_on: "2026-10-05", scheduled_end: null },
      "資工",
    );
    assert.equal(recurringSeat.title, "寫作業 2");
    assert.equal(recurringSeat.badgeKind, "seated");
    assert.equal(recurringSeat.badgeText, "入座 ↻ 學習");
    assert.equal(recurringSeat.fullTitle, "寫作業 2（入座 ↻ 學習）");
    assert.equal(recurringSeat.isPlaceholder, false);

    const singleSeat = planItemDisplay(
      {
        kind: "single",
        customTitle: null,
        seatedInto: {
          slotNodeId: "ph-1",
          slotName: "日文預留",
          dueOn: "2026-10-05",
          isRecurring: false,
          slotTime: "19:00",
          slotEstimateMin: 60,
        },
      },
      { name: "背 N5 單字", is_placeholder: null, scheduled_on: "2026-10-05", scheduled_end: null },
      "日文",
    );
    assert.equal(singleSeat.badgeText, "入座 日文預留");
    assert.equal(singleSeat.fullTitle, "背 N5 單字（入座 日文預留）");
  });

  test("4B 期間自由券在待排清單／未定時籤帶呈現區間徽章", () => {
    const rangeDisp = planItemDisplay(
      { kind: "single", customTitle: null, seatedInto: null },
      { name: "讀完《鐵道史》", is_placeholder: null, scheduled_on: "2026-10-02", scheduled_end: "2026-10-04" },
      "閱讀",
    );
    assert.equal(rangeDisp.title, "讀完《鐵道史》");
    assert.equal(rangeDisp.badgeKind, "range");
    assert.equal(rangeDisp.badgeText, "10/2–10/4");
    assert.equal(rangeDisp.fullTitle, "讀完《鐵道史》（10/2–10/4）");
  });
});

describe("4A 空白區拖拉建立預留席與 4C 候選篩選排序", () => {
  test("isAddPlaceholder 相容新舊記號，computeDragCreateRange 支援向下與向上拖拉並夾在日界內", () => {
    assert.equal(isAddPlaceholder(ADD_PLACEHOLDER_KEY), true);
    assert.equal(isAddPlaceholder("addadhoc"), true);
    assert.equal(isAddPlaceholder("2026-10-05-n1"), false);

    // 向下拖拉 14:00 -> 16:00
    assert.deepEqual(computeDragCreateRange(14 * 60, 16 * 60, 4), {
      startMin: 14 * 60,
      endMin: 16 * 60,
      durationMin: 120,
    });
    // 原地輕拉保底 15 分
    assert.deepEqual(computeDragCreateRange(10 * 60, 10 * 60 + 3, 4), {
      startMin: 10 * 60,
      endMin: 10 * 60 + 15,
      durationMin: 15,
    });
    // 向上反向拖拉 15:00 -> 13:30（包含起點格）
    assert.deepEqual(computeDragCreateRange(15 * 60, 13 * 60 + 30, 4), {
      startMin: 13 * 60 + 30,
      endMin: 15 * 60 + 15,
      durationMin: 105,
    });
  });

  test("canSeatIntoSlot、isEligibleSeatCandidate 與 sortSeatCandidates 同路線優先排序", () => {
    assert.equal(
      canSeatIntoSlot({ kind: "repeat", done: false, skipped: false, seatedInto: null }, { is_placeholder: null }),
      true,
    );
    assert.equal(
      canSeatIntoSlot({ kind: "single", done: false, skipped: false, seatedInto: null }, { is_placeholder: 1 }),
      true,
    );
    assert.equal(
      canSeatIntoSlot({ kind: "single", done: false, skipped: false, seatedInto: null }, { is_placeholder: null }),
      false,
    );
    assert.equal(
      canSeatIntoSlot({ kind: "repeat", done: true, skipped: false, seatedInto: null }, { is_placeholder: null }),
      false,
    );

    const base = {
      kind: "ticket" as const,
      status: "todo" as const,
      deleted_at: null,
      repeat_rule: null,
      is_placeholder: null,
    };
    assert.equal(isEligibleSeatCandidate({ ...base, id: "t1" }, "slot1", false), true);
    assert.equal(isEligibleSeatCandidate({ ...base, id: "slot1" }, "slot1", false), false);
    assert.equal(isEligibleSeatCandidate({ ...base, id: "t2", is_placeholder: 1 }, "slot1", false), false);
    assert.equal(isEligibleSeatCandidate({ ...base, id: "t3", repeat_rule: '{"kind":"daily"}' }, "slot1", false), false);
    assert.equal(isEligibleSeatCandidate({ ...base, id: "t4" }, "slot1", true), false);

    const sorted = sortSeatCandidates(
      [
        {
          id: "c-other",
          name: "買文具",
          route_id: "r-life",
          scheduled_on: "2026-10-05",
          scheduled_end: null,
          created_at: "2026-10-01T00:00:00Z",
        },
        {
          id: "c-same-unsched",
          name: "複習離散",
          route_id: "r-cs",
          scheduled_on: null,
          scheduled_end: null,
          created_at: "2026-10-01T00:00:00Z",
        },
        {
          id: "c-same-today",
          name: "寫作業 2",
          route_id: "r-cs",
          scheduled_on: "2026-10-05",
          scheduled_end: null,
          created_at: "2026-10-02T00:00:00Z",
        },
      ],
      { preferredRouteId: "r-cs", targetDate: "2026-10-05" },
    );
    assert.deepEqual(
      sorted.map((x) => x.id),
      ["c-same-today", "c-same-unsched", "c-other"],
    );
    assert.equal(isPlaceholderNode({ is_placeholder: 1 }), true);
    assert.equal(isPlaceholderNode({ is_placeholder: null }), false);
  });
});

describe("4A + 4B + 4C：時刻表日程完整投影與單次時數計入整合測試", () => {
  test("預留席雙向互通、Mode A 本班填空、Mode B 待辦入座（繼承 2h 滿高＋時數不重算）與期間自由券收斂撤回", async () => {
    const repo = new MemoryNodeRepository();
    const DAY = "2026-10-05"; // 週一
    const NEXT_MON = "2026-10-12";
    const H = 4;

    const line = await repo.create({ kind: "line", name: "學業", parentId: null });
    const csRoute = await repo.create({ kind: "route", name: "資工", parentId: line.id, color: "var(--route-1)" });

    // 1. 4A：從時刻表日程空白區建立 09:00–10:30（90m）預留席車票 ⇒ 同時出現在 listToday 與 listCalendar
    const placeholder = await repo.create({
      kind: "ticket",
      name: csRoute.name,
      parentId: null,
      routeTagId: csRoute.id,
      scheduledOn: DAY,
      scheduledTime: "09:00",
      estimateMin: 90,
      dayStartHour: H,
      isPlaceholder: true,
    });
    const todayBefore = await repo.listToday(DAY, H);
    assert.equal(
      todayBefore.some((r) => r.id === placeholder.id && r.is_placeholder === 1),
      true,
      "時刻表建立的預留席車票必須同步出現在今日頁",
    );

    // 2. 建立每週一 14:00–16:00（120m）定期班次「學習」，以及一張無預估時長的待辦車票「寫作業 2」
    const weeklyStudy = await repo.create({
      kind: "ticket",
      name: "學習",
      parentId: null,
      routeTagId: csRoute.id,
      scheduledOn: DAY,
      scheduledTime: "14:00",
      estimateMin: 120,
      dayStartHour: H,
    });
    await repo.setRepeatRule(weeklyStudy.id, fixedRule("weekly", DAY, { byweekday: [1] }), DAY, H);
    const hwTicket = await repo.create({
      kind: "ticket",
      name: "寫作業 2",
      parentId: null,
      routeTagId: csRoute.id,
      scheduledOn: null,
      estimateMin: null,
      dayStartHour: H,
    });

    // 3. 4C Mode A：先對下週一（10/12）填寫本班內容「念線代 Ch.3」，驗證當週（10/05）維持原名
    await repo.setRunCustomTitle(weeklyStudy.id, NEXT_MON, "念線代 Ch.3");
    const nextCal = await repo.listCalendar(NEXT_MON, NEXT_MON, { todayDateKey: DAY, dayStartHour: H });
    const nextGrid = timeGridModel({
      days: [NEXT_MON],
      entries: nextCal.entries,
      dues: nextCal.dues,
      nodes: nextCal.nodes,
      dayStartHour: H,
    })[0];
    const nextItem = planItemOf(nextGrid.blocks[0].entry, nextCal.nodes[weeklyStudy.id]);
    assert.equal(
      planItemDisplay(nextItem, nextCal.nodes[weeklyStudy.id], csRoute.name).fullTitle,
      "念線代 Ch.3（↻ 學習）",
    );

    // 4. 4C Mode B：在 10/05 將無預估時長的「寫作業 2」入座頂替 14:00（2h）的「學習」班次
    await repo.seatTicketIntoSlot(weeklyStudy.id, DAY, hwTicket.id);

    const cal = await repo.listCalendar(DAY, DAY, { todayDateKey: DAY, dayStartHour: H });
    const gDay = timeGridModel({
      days: [DAY],
      entries: cal.entries,
      dues: cal.dues,
      nodes: cal.nodes,
      dayStartHour: H,
    })[0];
    const items = Object.fromEntries(
      [...gDay.blocks, ...gDay.untimed].map((x) => {
        const it = planItemOf(x.entry, cal.nodes[x.entry.node_id]);
        return [it.key, it];
      }),
    );
    const sBlocks = schedBlocksOf(gDay, {}, H);

    // 斷言：10/05 時間軸上只有「預留席（09:00, 90m）」與「寫作業 2（14:00, 繼承 120m）」，空殼「學習」已隱藏
    assert.deepEqual(
      sBlocks.map((b) => ({
        key: b.key,
        startMin: b.startMin,
        endMin: b.endMin,
        noEstimate: b.noEstimate,
      })),
      [
        { key: `${DAY}-${placeholder.id}`, startMin: 9 * 60, endMin: 10 * 60 + 30, noEstimate: false },
        { key: `${DAY}-${hwTicket.id}`, startMin: 14 * 60, endMin: 16 * 60, noEstimate: false },
      ],
    );

    // 斷言：ScheduleSummary 的 daySummary 只計入 2 班、合計 90 + 120 = 210 分鐘（絕不把空殼 120m 重複算成 330m！）
    const sum = daySummary(Object.values(items), new Map(), false);
    assert.equal(sum.planned, 2);
    assert.equal(sum.plannedMin, 210);

    // 4A 原地轉正：將預留席填入具體標題並清掉 is_placeholder ⇒ 轉為正式實線車票
    await repo.update(placeholder.id, { name: "算微積分習題", is_placeholder: null }, { dateKey: DAY, dayStartHour: H });
    const promotedNode = await repo.getNode(placeholder.id);
    assert.equal(isPlaceholderNode(promotedNode), false);
    assert.equal(
      planItemDisplay(items[`${DAY}-${placeholder.id}`], promotedNode, csRoute.name).isPlaceholder,
      false,
    );

    // 5. 釋出預留席後，「學習」14:00–16:00 班次自動恢復現身
    await repo.releaseSeatedSlot(weeklyStudy.id, DAY);
    const calReleased = await repo.listCalendar(DAY, DAY, { todayDateKey: DAY, dayStartHour: H });
    assert.equal(
      calReleased.entries.some((e) => e.node_id === weeklyStudy.id && e.date === DAY && e.time === "14:00"),
      true,
    );

    // 6. 4B：期間自由券 10/05~10/07 在 10/06 拖上時刻表 15:00 ⇒ 收斂為 10/06 單日票，撤回還原區間
    const rangeNode = await repo.create({
      kind: "ticket",
      name: "整理筆記",
      parentId: null,
      routeTagId: csRoute.id,
      scheduledOn: "2026-10-05",
      scheduledEnd: "2026-10-07",
      dayStartHour: H,
    });
    const rangeCal = await repo.listCalendar("2026-10-05", "2026-10-07", { todayDateKey: DAY, dayStartHour: H });
    const oct6Entry = rangeCal.entries.find((e) => e.node_id === rangeNode.id && e.date === "2026-10-06");
    assert.ok(oct6Entry);
    const oct6Item = planItemOf(oct6Entry, rangeCal.nodes[rangeNode.id]);

    const write = planTimeWrite(oct6Item, "15:00");
    assert.deepEqual(write, {
      op: "setTime",
      id: rangeNode.id,
      time: "15:00",
      scheduledOn: "2026-10-06",
      scheduledEnd: null,
    });
    const undo = planUndo(oct6Item);
    assert.deepEqual(undo, {
      op: "setTime",
      id: rangeNode.id,
      time: null,
      scheduledOn: "2026-10-05",
      scheduledEnd: "2026-10-07",
    });
  });
});
