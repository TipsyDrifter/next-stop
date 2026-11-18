/**
 * `src/domain/duration.ts` 純函式單元測試（v1.32 2A-2）。
 * 跑法：`node --test "src/domain/duration.test.ts"`
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  DURATION_DEFAULT_MAX,
  DURATION_GOAL_MAX,
  MATRIX_BASE_HOURS,
  MATRIX_EXT_HOURS,
  MATRIX_MINUTES,
  composeMatrixHour,
  composeMatrixMinute,
  formatDurationShort,
  normalizeDurationText,
  parseDurationInput,
  splitDurationMatrix,
} from "./duration.ts";

describe("normalizeDurationText：全形與空白正規化", () => {
  test("全形數字、字母、冒號、句點與全形空白轉半形小寫", () => {
    assert.equal(normalizeDurationText("　２．５Ｈ　"), "2.5h");
    assert.equal(normalizeDurationText("０２：３０"), "02:30");
    assert.equal(normalizeDurationText("１小時　１０分"), "1小時 10分");
  });
});

describe("parseDurationInput：多格式智慧解析", () => {
  test("空字串與純空白 → null（清除／不預估）", () => {
    assert.equal(parseDurationInput(""), null);
    assert.equal(parseDurationInput("   "), null);
    assert.equal(parseDurationInput("　"), null);
  });

  test("純數字分鐘", () => {
    assert.equal(parseDurationInput("70"), 70);
    assert.equal(parseDurationInput("45"), 45);
    assert.equal(parseDurationInput("1"), 1);
    assert.equal(parseDurationInput("０９０"), 90);
  });

  test("小數與整數小時", () => {
    assert.equal(parseDurationInput("2.5h"), 150);
    assert.equal(parseDurationInput("2.5小時"), 150);
    assert.equal(parseDurationInput("2.5 hr"), 150);
    assert.equal(parseDurationInput("2.5hrs"), 150);
    assert.equal(parseDurationInput("2h"), 120);
    assert.equal(parseDurationInput("2時"), 120);
    assert.equal(parseDurationInput("0.5h"), 30);
    assert.equal(parseDurationInput("1.25h"), 75);
    assert.equal(parseDurationInput("２．５ｈ"), 150);
  });

  test("複合時分", () => {
    assert.equal(parseDurationInput("1h10"), 70);
    assert.equal(parseDurationInput("1h10m"), 70);
    assert.equal(parseDurationInput("1小時10分"), 70);
    assert.equal(parseDurationInput("1小時10分鐘"), 70);
    assert.equal(parseDurationInput("1小時10"), 70);
    assert.equal(parseDurationInput("1h 30m"), 90);
    assert.equal(parseDurationInput("1hr 30min"), 90);
    assert.equal(parseDurationInput("2h05"), 125);
    assert.equal(parseDurationInput("2小時5分"), 125);
    assert.equal(parseDurationInput("１Ｈ３０Ｍ"), 90);
  });

  test("冒號時分", () => {
    assert.equal(parseDurationInput("1:10"), 70);
    assert.equal(parseDurationInput("02:30"), 150);
    assert.equal(parseDurationInput("0:45"), 45);
    assert.equal(parseDurationInput("１：１０"), 70);
    // 分鐘不足兩位或 >=60 拒收
    assert.equal(parseDurationInput("1:5"), undefined);
    assert.equal(parseDurationInput("1:60"), undefined);
  });

  test("帶分字尾", () => {
    assert.equal(parseDurationInput("90m"), 90);
    assert.equal(parseDurationInput("90分"), 90);
    assert.equal(parseDurationInput("90分鐘"), 90);
    assert.equal(parseDurationInput("90min"), 90);
    assert.equal(parseDurationInput("90 mins"), 90);
  });

  test("邊界值、allowZero、上限夾回與非法輸入", () => {
    assert.equal(parseDurationInput("0"), undefined);
    assert.equal(parseDurationInput("0m"), undefined);
    assert.equal(parseDurationInput("0h"), undefined);
    assert.equal(parseDurationInput("0:00"), undefined);
    assert.equal(parseDurationInput("0", { allowZero: true }), 0);
    assert.equal(parseDurationInput("0h0m", { allowZero: true }), 0);
    assert.equal(parseDurationInput("-15"), undefined);
    assert.equal(parseDurationInput("-1h"), undefined);
    assert.equal(parseDurationInput("abc"), undefined);
    assert.equal(parseDurationInput("2.5"), undefined); // 無單位小數避免打 2.5h 中途誤判為 3m
    assert.equal(parseDurationInput("1h75m"), undefined);
    // 預設上限 1440，目標模式可放寬至 60000
    assert.equal(parseDurationInput("9999"), DURATION_DEFAULT_MAX);
    assert.equal(parseDurationInput("40h"), DURATION_DEFAULT_MAX);
    assert.equal(parseDurationInput("40h", { maxMin: DURATION_GOAL_MAX }), 2400);
    assert.equal(parseDurationInput("12.5h", { maxMin: DURATION_GOAL_MAX }), 750);
    assert.equal(parseDurationInput("2000h", { maxMin: DURATION_GOAL_MAX }), DURATION_GOAL_MAX);
  });
});

describe("formatDurationShort 與雙排矩陣拆解／組合", () => {
  test("formatDurationShort 與 parseDurationInput 雙向往返一致", () => {
    assert.equal(formatDurationShort(45), "45m");
    assert.equal(formatDurationShort(60), "1h");
    assert.equal(formatDurationShort(65), "1h05");
    assert.equal(formatDurationShort(70), "1h10");
    assert.equal(formatDurationShort(150), "2h30");
    for (const v of [5, 15, 25, 60, 65, 70, 90, 150, 300, 480, 1440]) {
      assert.equal(parseDurationInput(formatDurationShort(v)), v);
    }
  });

  test("splitDurationMatrix 拆解標準格與自訂分鐘", () => {
    assert.deepEqual(MATRIX_BASE_HOURS, [0, 1, 2, 3]);
    assert.deepEqual(MATRIX_EXT_HOURS, [4, 5, 6, 8]);
    assert.deepEqual(MATRIX_MINUTES, [0, 10, 15, 20, 30, 40, 45, 50]);

    assert.deepEqual(splitDurationMatrix(null), { hours: null, mins: null, isCustomMin: false });
    assert.deepEqual(splitDurationMatrix(0), { hours: null, mins: null, isCustomMin: false });
    assert.deepEqual(splitDurationMatrix(30), { hours: 0, mins: 30, isCustomMin: false });
    assert.deepEqual(splitDurationMatrix(60), { hours: 1, mins: 0, isCustomMin: false });
    assert.deepEqual(splitDurationMatrix(70), { hours: 1, mins: 10, isCustomMin: false });
    assert.deepEqual(splitDurationMatrix(25), { hours: 0, mins: 25, isCustomMin: true });
    assert.deepEqual(splitDurationMatrix(95), { hours: 1, mins: 35, isCustomMin: true });
    assert.deepEqual(splitDurationMatrix(300), { hours: 5, mins: 0, isCustomMin: false });
  });

  test("composeMatrixHour / composeMatrixMinute 點兩下秒組時長與清除", () => {
    // 從 null 點 1h → 60，再點 10m → 70
    const step1 = composeMatrixHour(null, 1);
    assert.equal(step1, 60);
    const step2 = composeMatrixMinute(step1, 10);
    assert.equal(step2, 70);

    // 點 2h 再點 30m → 150（2.5h）
    assert.equal(composeMatrixMinute(composeMatrixHour(null, 2), 30), 150);

    // 從 null 直接點 30m → 30
    const onlyMin = composeMatrixMinute(null, 30);
    assert.equal(onlyMin, 30);

    // 0h + 00m 在 allowNull 時清除為 null
    assert.equal(composeMatrixMinute(onlyMin, 0), null);
    assert.equal(composeMatrixHour(60, 0), null);
    assert.equal(composeMatrixHour(null, 0), null);

    // allowNull=false 時保底正數分鐘
    assert.equal(composeMatrixHour(60, 0, { allowNull: false }), 15);
    assert.equal(composeMatrixMinute(30, 0, { allowNull: false }), 15);
  });
});
