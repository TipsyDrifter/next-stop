/**
 * 第三梯回饋專卷（fe-pickers-board · feat/fb-w3-aims）單元測試：
 *   1. 【畫面 1 · D-FB-6】`resolveInitialWorkbenchKeys`：從週／月／年任一入口推導三欄初始期間鍵與聚焦欄（含跨月、跨年、兩種週起始日）
 *   2. 【畫面 1 · D-FB-6】`WorkbenchLedger` 多期間草稿帳本：翻閱 `‹ 期 ›` 保留未存草稿、句內 `Shift+Enter` 換行與 160 字長句差異偵測、`dirtyPeriodKeys` 依「年 → 月 → 週 → 車站」拓撲排序存檔
 *   3. 【畫面 1 · D-FB-6】跨尺度一鍵引流（`carryDraftAcrossColumns`／`carryRowIntoLedger`）：已存方針與「剛打字尚未存檔的新方針」跨欄引流（今年 → 本月 → 本週、年／月 → 車站），銜接 `planSaveWeek` 一次落庫不斷鏈、防重複帶入與五句上限保護
 *   4. 【討論 4 · D-FB-6】方針掛載收斂為路線一鍵秒選（`pickTargetOfRoute` ＋ `resolveAimRouteId` 歷史支線相容），且「排成車票 `ticketPlacement`」維持支援 `branch`／`train`／`car`／`ticket` 細粒度落點
 *
 * 跑法：`node --test scripts/tests/fb-w3-aims.test.ts`
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = context.parentURL;
    if (parent !== undefined && parent.includes("/src/") && specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) {
      return nextResolve(specifier + ".ts", context);
    }
    return nextResolve(specifier, context);
  },
});

const {
  AIM_ATTACH_KINDS,
  AIM_TEXT_MAX,
  MAX_AIMS,
  planSaveWeek,
  resolveAimRouteId,
  stationKeyOf,
  ticketPlacement,
  upperKeyOf,
} = await import("../../src/domain/weekAims.ts");

const {
  carryDraftAcrossColumns,
  carryRowIntoLedger,
  dirtyPeriodKeys,
  draftsOfAims,
  flowTargetShort,
  isPeriodDirty,
  pickTargetOfRoute,
  resolveInitialWorkbenchKeys,
  sameAimDrafts,
} = await import("../../src/ui/weekAims/aimWorkbenchModel.ts");

function makeAimRow(p: {
  id: string;
  week_on: string;
  text: string;
  node_id?: string | null;
  position?: number;
  done_at?: string | null;
  carried_from?: string | null;
}) {
  return {
    id: p.id,
    week_on: p.week_on,
    text: p.text,
    node_id: p.node_id ?? null,
    position: p.position ?? 0,
    done_at: p.done_at ?? null,
    carried_from: p.carried_from ?? null,
    account_id: null,
    device_id: null,
    created_at: "2026-11-01T00:00:00.000Z",
    updated_at: "2026-11-01T00:00:00.000Z",
    synced_at: null,
    deleted_at: null,
  };
}

describe("畫面 1：展開式「行路企劃書」三欄初始期間推導", () => {
  const today = "2026-11-20"; // 週五（週一起算週首＝2026-11-16）

  test("從本週／下週／跨年週開啟：右欄鎖定該週，中／左欄自動對齊所屬月與年", () => {
    assert.deepEqual(resolveInitialWorkbenchKeys("2026-11-16", today, 1), {
      yearKey: "Y2026",
      monthKey: "M2026-11",
      weekKey: "2026-11-16",
      focusScale: "week",
    });
    assert.deepEqual(resolveInitialWorkbenchKeys("2026-12-07", today, 1), {
      yearKey: "Y2026",
      monthKey: "M2026-12",
      weekKey: "2026-12-07",
      focusScale: "week",
    });
    assert.deepEqual(resolveInitialWorkbenchKeys("2025-12-29", today, 1), {
      yearKey: "Y2025",
      monthKey: "M2025-12",
      weekKey: "2025-12-29",
      focusScale: "week",
    });
  });

  test("從本月或指定月開啟：中欄聚焦該月，非本月時右欄取週首必在該月內的第一週", () => {
    assert.deepEqual(resolveInitialWorkbenchKeys("M2026-11", today, 1), {
      yearKey: "Y2026",
      monthKey: "M2026-11",
      weekKey: "2026-11-16",
      focusScale: "month",
    });

    for (const ws of [0, 1] as const) {
      const dec = resolveInitialWorkbenchKeys("M2026-12", today, ws);
      assert.equal(dec.focusScale, "month");
      assert.equal(dec.yearKey, "Y2026");
      assert.equal(dec.monthKey, "M2026-12");
      assert.equal(upperKeyOf(dec.weekKey, today), "M2026-12");
    }
  });

  test("從今年或歷史年份開啟：左欄聚焦該年，歷史年自動對齊 1 月與首週", () => {
    assert.deepEqual(resolveInitialWorkbenchKeys("Y2026", today, 1), {
      yearKey: "Y2026",
      monthKey: "M2026-11",
      weekKey: "2026-11-16",
      focusScale: "year",
    });

    const y2025 = resolveInitialWorkbenchKeys("Y2025", today, 1);
    assert.equal(y2025.focusScale, "year");
    assert.equal(y2025.yearKey, "Y2025");
    assert.equal(y2025.monthKey, "M2025-01");
    assert.equal(upperKeyOf(y2025.weekKey, today), "M2025-01");
  });

  test("flowTargetShort：隨目標欄翻期動態呈現自然短標", () => {
    assert.equal(flowTargetShort("M2026-11", today, 1), "本月");
    assert.equal(flowTargetShort("M2026-12", today, 1), "下個月");
    assert.equal(flowTargetShort("M2026-09", today, 1), "9月");
    assert.equal(flowTargetShort("2026-11-16", today, 1), "本週");
    assert.equal(flowTargetShort("2026-11-23", today, 1), "下週");
    assert.equal(flowTargetShort(stationKeyOf("stn-1"), today, 1), "本站");
  });
});

describe("畫面 1：多期間草稿帳本、多行長句（160 字）與拓撲存檔順序", () => {
  test("AIM_TEXT_MAX 為 160 且保留 Shift+Enter 句內換行；空白列不誤判 dirty", () => {
    assert.equal(AIM_TEXT_MAX, 160);
    const saved = [makeAimRow({ id: "a1", week_on: "Y2026", text: "第一行\n第二行" })];
    const base = draftsOfAims(saved);
    assert.equal(
      sameAimDrafts(
        [...base, { id: null, text: "   \n  ", nodeId: null, carriedFrom: null }],
        base,
      ),
      true,
    );
    assert.equal(
      sameAimDrafts(
        [{ id: "a1", text: "第一行\n第二行（補充）", nodeId: null, carriedFrom: null }],
        base,
      ),
      false,
    );
  });

  test("dirtyPeriodKeys：同場翻閱多期不丟草稿，並嚴格按「年 → 月 → 週 → 車站」順序回傳待存鍵", () => {
    const cleanRows = [makeAimRow({ id: "w0", week_on: "2026-11-09", text: "上週原句" })];
    const ledger = {
      "Sstn-9": {
        base: [],
        drafts: [{ id: null, text: "車站新方針", nodeId: "R1", carriedFrom: null }],
      },
      "2026-11-23": {
        base: [],
        drafts: [{ id: null, text: "下週新方針", nodeId: null, carriedFrom: null }],
      },
      "2026-11-09": {
        base: draftsOfAims(cleanRows),
        drafts: draftsOfAims(cleanRows),
      },
      "M2026-12": {
        base: [],
        drafts: [{ id: null, text: "十二月方針", nodeId: null, carriedFrom: null }],
      },
      "Y2026": {
        base: [],
        drafts: [{ id: null, text: "年度方針", nodeId: null, carriedFrom: null }],
      },
      "M2026-11": {
        base: [],
        drafts: [{ id: null, text: "十一月方針", nodeId: null, carriedFrom: null }],
      },
    };

    assert.equal(isPeriodDirty(ledger["2026-11-09"]), false);
    assert.deepEqual(dirtyPeriodKeys(ledger), [
      "Y2026",
      "M2026-11",
      "M2026-12",
      "2026-11-23",
      "Sstn-9",
    ]);
  });
});

describe("畫面 1：跨尺度一鍵引流（含尚未存檔的新句連貫落庫）", () => {
  test("在「今年」新打一句 110 字多行方針，未存檔直接點「帶入本月 ›」再點「帶入本週 ›」，三欄可一次 planSaveWeek 完整銜接", async () => {
    const longMultiline =
      "把私鐵手帳的體驗磨到真正順手、零門檻，讓每天早晚打開時都像翻開喜愛的亞麻紙手札一樣安定從容\n同時把日文初學者的每日聽讀習慣溫柔地融入通勤與睡前時光裡，不急躁但持續累積真實語感與詞彙量";
    assert.ok(Array.from(longMultiline).length > 60 && Array.from(longMultiline).length <= 160);

    let ledger = {
      Y2026: {
        base: [],
        drafts: [{ id: null, text: longMultiline, nodeId: "route-1", carriedFrom: null }],
      },
      "M2026-11": { base: [], drafts: [] },
      "2026-11-16": { base: [], drafts: [] },
    };

    // 1. 今年（未存新句）→ 帶入本月
    const step1 = await carryDraftAcrossColumns({
      ledger,
      sourceKey: "Y2026",
      sourceIndex: 0,
      targetKey: "M2026-11",
      makeUuid: () => "11111111-2222-4333-8444-555555555555",
    });
    assert.equal(step1.status, "carried");
    ledger = step1.ledger;

    // 來源今年草稿自動補上穩定 UUID，本月草稿 carriedFrom 指向它
    const yearDraft = ledger.Y2026.drafts[0];
    const monthDraft = ledger["M2026-11"].drafts[0];
    assert.equal(yearDraft.id, "11111111-2222-4333-8444-555555555555");
    assert.equal(monthDraft.carriedFrom, yearDraft.id);
    assert.equal(monthDraft.nodeId, "route-1");
    assert.equal(monthDraft.text, longMultiline);

    // 重複點擊「帶入本月 ›」不會重複新增
    const dup = await carryDraftAcrossColumns({
      ledger,
      sourceKey: "Y2026",
      sourceIndex: 0,
      targetKey: "M2026-11",
    });
    assert.equal(dup.status, "already_carried");
    assert.equal(dup.ledger["M2026-11"].drafts.length, 1);

    // 2. 本月 → 帶入本週
    const step2 = await carryDraftAcrossColumns({
      ledger,
      sourceKey: "M2026-11",
      sourceIndex: 0,
      targetKey: "2026-11-16",
    });
    assert.equal(step2.status, "carried");
    ledger = step2.ledger;
    const weekDraft = ledger["2026-11-16"].drafts[0];
    assert.equal(weekDraft.carriedFrom, monthDraft.id);

    // 3. 驗證三欄皆可直接通過領域層 planSaveWeek（保留預設 id、carriedFrom 與句內換行）
    for (const key of dirtyPeriodKeys(ledger)) {
      const plan = planSaveWeek([], ledger[key].drafts, key, ledger[key].base);
      assert.equal(plan.creates.length, 1);
      assert.equal(plan.creates[0].id, ledger[key].drafts[0].id);
      assert.equal(plan.creates[0].text, longMultiline);
      assert.equal(plan.creates[0].carriedFrom, ledger[key].drafts[0].carriedFrom);
    }
  });

  test("目標欄已滿 MAX_AIMS（5 句）時回傳 target_full 不寫入第 6 句", async () => {
    const five = Array.from({ length: MAX_AIMS }, (_, i) => ({
      id: `m-${i}`,
      text: `第 ${i + 1} 句`,
      nodeId: null,
      carriedFrom: null,
    }));
    const ledger = {
      Y2026: {
        base: [],
        drafts: [{ id: "y-1", text: "年度第六方向", nodeId: null, carriedFrom: null }],
      },
      "M2026-11": { base: five, drafts: five },
    };
    const res = await carryDraftAcrossColumns({
      ledger,
      sourceKey: "Y2026",
      sourceIndex: 0,
      targetKey: "M2026-11",
    });
    assert.equal(res.status, "target_full");
    assert.equal(res.ledger["M2026-11"].drafts.length, MAX_AIMS);
  });
});

describe("討論 4：方針掛路線一鍵秒選、歷史支線相容與「排成車票」細粒度落點", () => {
  test("AIM_ATTACH_KINDS 僅含 route；歷史掛支線的方針透過 resolveAimRouteId 與 pickTargetOfRoute 平滑收斂至母路線", async () => {
    assert.deepEqual(AIM_ATTACH_KINDS, ["route"]);
    const byId = {
      R1: { id: "R1", kind: "route" as const, parent_id: null, route_id: null, deleted_at: null },
      B1: { id: "B1", kind: "branch" as const, parent_id: "R1", route_id: "R1", deleted_at: null },
    };

    const resolvedRouteId = resolveAimRouteId("B1", byId);
    assert.equal(resolvedRouteId, "R1");
    assert.deepEqual(pickTargetOfRoute(resolvedRouteId), {
      routeId: "R1",
      nodeId: null,
      nodeKind: "route",
    });
    assert.deepEqual(pickTargetOfRoute(null), {
      routeId: null,
      nodeId: null,
      nodeKind: null,
    });

    // 將歷史掛支線 B1 的上一期方針帶入新期間時，自動收斂掛在母路線 R1
    const legacyRow = makeAimRow({ id: "old-1", week_on: "2026-11-09", text: "延續舊目標", node_id: "B1" });
    const carried = await carryRowIntoLedger({
      ledger: { "2026-11-16": { base: [], drafts: [] } },
      srcRow: legacyRow,
      targetKey: "2026-11-16",
      resolveRouteId: (nid) => resolveAimRouteId(nid, byId),
    });
    assert.equal(carried.status, "carried");
    assert.equal(carried.carriedDraft?.nodeId, "R1");
  });

  test("排成車票 ticketPlacement 持續支援路線、支線、列車與車廂細粒度落點（葉節點安全退回所屬路線標籤）", () => {
    assert.deepEqual(ticketPlacement({ id: "R1", kind: "route", route_id: null }), {
      parentId: null,
      routeTagId: "R1",
    });
    assert.deepEqual(ticketPlacement({ id: "B1", kind: "branch", route_id: "R1" }), {
      parentId: "B1",
      routeTagId: null,
    });
    assert.deepEqual(ticketPlacement({ id: "T1", kind: "train", route_id: "R1" }), {
      parentId: "T1",
      routeTagId: null,
    });
    assert.deepEqual(ticketPlacement({ id: "C1", kind: "car", route_id: "R1" }), {
      parentId: "C1",
      routeTagId: null,
    });
    assert.deepEqual(ticketPlacement({ id: "K1", kind: "ticket", route_id: "R1" }), {
      parentId: null,
      routeTagId: "R1",
    });
  });
});
