import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CHAIN_DEFAULT_MIN,
  CHAIN_STARTER_PRESETS,
  CHAIN_STEP_MAX,
  CHAIN_STEP_MIN,
  chainTotalMin,
  formatChainDuration,
  getStarterPresetMeta,
  normalizeStepEstimateMin,
  parseChainSteps,
  resolveStarterPresetSteps,
  resolveStepTitle,
  serializeChainSteps,
  validateChainInput,
  type TimeChainStep,
} from "./timetableChain.ts";

describe("timetableChain domain", () => {
  it("parseChainSteps 安全過濾壞資料並正規化 estimateMin", () => {
    assert.deepEqual(parseChainSteps(""), []);
    assert.deepEqual(parseChainSteps("not json"), []);
    assert.deepEqual(parseChainSteps('{"a":1}'), []);

    const raw = JSON.stringify([
      null,
      123,
      { categoryId: "", estimateMin: 20 },
      { categoryId: "cat-1", label: "  喚醒伸展 \n ", estimateMin: 2, note: "  多喝水 ", location: " 客廳 " },
      { categoryId: "cat-2", estimateMin: 999 },
      { categoryId: "cat-3", estimateMin: "abc" },
    ]);
    const steps = parseChainSteps(raw);
    assert.equal(steps.length, 3);
    assert.deepEqual(steps[0], {
      categoryId: "cat-1",
      label: "喚醒伸展",
      estimateMin: CHAIN_STEP_MIN,
      note: "多喝水",
      location: "客廳",
    });
    assert.deepEqual(steps[1], {
      categoryId: "cat-2",
      estimateMin: CHAIN_STEP_MAX,
    });
    assert.deepEqual(steps[2], {
      categoryId: "cat-3",
      estimateMin: CHAIN_DEFAULT_MIN,
    });
  });

  it("serializeChainSteps 與 parseChainSteps 往返一致且清除空白選填欄位", () => {
    const input: TimeChainStep[] = [
      { categoryId: "c1", label: "  暖身 ", estimateMin: 10.4, note: "   ", location: "" },
      { categoryId: "c2", estimateMin: 45, note: "開啟專注模式", location: "書房" },
    ];
    const json = serializeChainSteps(input);
    const parsed = parseChainSteps(json);
    assert.deepEqual(parsed, [
      { categoryId: "c1", label: "暖身", estimateMin: 10 },
      { categoryId: "c2", estimateMin: 45, note: "開啟專注模式", location: "書房" },
    ]);
  });

  it("validateChainInput 正確驗證名稱、步驟數與欄位限制", () => {
    const validStep: TimeChainStep = { categoryId: "c1", estimateMin: 25 };
    assert.ok(validateChainInput("", [validStep]));
    assert.ok(validateChainInput("   ", [validStep]));
    assert.ok(validateChainInput("a".repeat(41), [validStep]));
    assert.ok(validateChainInput("晨間", []));
    assert.ok(validateChainInput("晨間", [{ categoryId: "", estimateMin: 25 }]));
    assert.ok(validateChainInput("晨間", [{ categoryId: "c1", estimateMin: 2 }]));
    assert.ok(validateChainInput("晨間", [{ categoryId: "c1", estimateMin: 500 }]));
    assert.ok(validateChainInput("晨間", Array.from({ length: 21 }, () => validStep)));
    assert.equal(validateChainInput("晨間啟動", [validStep]), null);
  });

  it("chainTotalMin 與 formatChainDuration 格式化正確", () => {
    assert.equal(chainTotalMin([]), 0);
    assert.equal(
      chainTotalMin([
        { categoryId: "c1", estimateMin: 10 },
        { categoryId: "c2", estimateMin: 20 },
        { categoryId: "c3", estimateMin: 10 },
      ]),
      40,
    );
    assert.equal(formatChainDuration(0), "0 分");
    assert.equal(formatChainDuration(55), "55 分");
    assert.equal(formatChainDuration(60), "1 小時");
    assert.equal(formatChainDuration(75), "1 小時 15 分");
    assert.equal(normalizeStepEstimateMin(undefined), 25);
  });

  it("resolveStepTitle 優先使用步驟名稱，其次分類名，最後未指定", () => {
    assert.equal(resolveStepTitle({ categoryId: "c1", label: "晨間閱讀", estimateMin: 20 }, "學習"), "晨間閱讀");
    assert.equal(resolveStepTitle({ categoryId: "c1", label: "   ", estimateMin: 20 }, "學習"), "學習");
    assert.equal(resolveStepTitle({ categoryId: "c1", estimateMin: 20 }, undefined), "未指定");
  });

  it("resolveStarterPresetSteps 依分類名稱智慧配對，找不到則退回第一個可用分類", () => {
    assert.equal(CHAIN_STARTER_PRESETS.length, 3);
    assert.equal(getStarterPresetMeta("morning")?.name, "晨間啟動");
    assert.equal(getStarterPresetMeta("unknown"), null);

    const starterCats = [
      { id: "id-create", name: "創作" },
      { id: "id-study", name: "學習" },
      { id: "id-work", name: "工作" },
      { id: "id-chore", name: "家務" },
      { id: "id-sport", name: "運動" },
      { id: "id-hobby", name: "興趣" },
    ];

    const morning = resolveStarterPresetSteps("morning", starterCats);
    assert.equal(morning.length, 3);
    assert.equal(morning[0].categoryId, "id-sport");
    assert.equal(morning[0].label, "喚醒伸展");
    assert.equal(morning[0].estimateMin, 10);
    assert.equal(morning[1].categoryId, "id-study");
    assert.equal(morning[2].categoryId, "id-work");

    const deepwork = resolveStarterPresetSteps("deepwork", starterCats);
    assert.equal(deepwork.length, 3);
    assert.equal(deepwork[1].categoryId, "id-create");
    assert.equal(deepwork[1].estimateMin, 45);

    const bedtime = resolveStarterPresetSteps("bedtime", starterCats);
    assert.equal(bedtime.length, 3);
    assert.equal(bedtime[0].categoryId, "id-chore");
    assert.equal(bedtime[1].categoryId, "id-create");
    assert.equal(bedtime[2].categoryId, "id-hobby");

    // 找不到關鍵字時退回第一個可用分類
    const fallbackCats = [{ id: "only-one", name: "日常雜項" }];
    const fallbackMorning = resolveStarterPresetSteps("morning", fallbackCats);
    assert.ok(fallbackMorning.every((s) => s.categoryId === "only-one"));
    assert.deepEqual(resolveStarterPresetSteps("nonexistent", starterCats), []);
  });
});
