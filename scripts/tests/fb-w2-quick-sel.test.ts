/**
 * 並行回饋專卷・第二梯（fe-panels-ux）單元測試：
 *   - `@路線`（依幹線分組、含空白路線名、`@路線/` 子樹）與 `#荷札` 打字即時補完規則
 *   - `=`／`〆=` 締切同乘車日語法與 `mergeQuick` 同步推進
 *   - `14:00-15:30` 起訖時段語法與時間膠囊 `14:00–15:30 · 1h30` 顯示
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseQuickAdd } from "../../src/domain/quickAdd.ts";
import { formatClockSpanSummary } from "../../src/domain/clockSpan.ts";
import { NO_DEST, mergeQuick } from "../../src/ui/common/quickadd/quickAddModel.ts";
import {
  buildDestSuggestions,
  detectQuickTrigger,
  formatDestInsertion,
  replaceTriggerRange,
  type SuggestLine,
  type SuggestRoute,
} from "../../src/ui/common/quickadd/quickSuggestModel.ts";
import type { AttachOption } from "../../src/ui/notes/useAttachOptions.ts";

const LINES: SuggestLine[] = [
  { id: "L1", name: "學習" },
  { id: "L2", name: "工作" },
];

const ROUTES: SuggestRoute[] = [
  { id: "r1", name: "日文", code: "JP", color: "var(--route-preset-1)", line_id: "L1" },
  { id: "r2", name: "Work Trip", code: "WT", color: "var(--route-preset-2)", line_id: "L2" },
  { id: "r3", name: "日常雜務", code: null, color: "var(--route-preset-3)", line_id: null },
];

const TREES = new Map<string, readonly AttachOption[]>([
  [
    "r1",
    [
      { id: "b1", kind: "branch", name: "單字", depth: 0, selectable: true },
      { id: "tk1", kind: "ticket", name: "N4 第1課", depth: 1, selectable: true },
    ],
  ],
  [
    "r2",
    [
      { id: "tr1", kind: "train", name: "Phase 1", depth: 0, selectable: true },
    ],
  ],
]);

describe("第二梯 2A・操作 4：@路線 ＆ #荷札 即時補完觸發與幹線分組", () => {
  test("detectQuickTrigger：辨識句首與空白後的 @／#，忽略信箱與已結束字詞", () => {
    assert.deepEqual(detectQuickTrigger("背單字 @", 5), {
      kind: "dest",
      start: 4,
      end: 5,
      rawQuery: "",
      quoted: false,
    });
    assert.deepEqual(detectQuickTrigger('出差 @"Work Tr', 12), {
      kind: "dest",
      start: 3,
      end: 12,
      rawQuery: '"Work Tr',
      quoted: true,
    });
    assert.equal(detectQuickTrigger("寄信給 user@example.com", 20), null);
    assert.deepEqual(detectQuickTrigger("整理筆記 #學", 7), {
      kind: "tag",
      start: 5,
      end: 7,
      q: "學",
    });
    // 方針輸入框關閉 #荷札 觸發時，只認 @ 不認 #
    assert.equal(detectQuickTrigger("本週重點 #學習", 8, { allowDest: true, allowTag: false }), null);
  });

  test("buildDestSuggestions：第一層依幹線分組（幹線・○○ ／ 其他），@路線/ 展開支線與車票", () => {
    const top = buildDestSuggestions({
      rawQuery: "",
      routes: ROUTES,
      lines: LINES,
      allowSubNode: true,
      treesByRoute: TREES,
    });
    const headers = top.rows.filter((r) => r.type === "header").map((r) => r.label);
    assert.deepEqual(headers, ["幹線・學習", "幹線・工作", "其他"]);
    assert.equal(top.picks.length, 3);

    const sub = buildDestSuggestions({
      rawQuery: "日文/",
      routes: ROUTES,
      lines: LINES,
      allowSubNode: true,
      treesByRoute: TREES,
    });
    assert.equal(sub.routeScope?.id, "r1");
    // 第 0 項為掛在「日文」路線本身，第 1、2 項為支線「單字」與車票「N4 第1課」
    assert.equal(sub.picks.length, 3);
    assert.equal(sub.picks[1]?.opt?.kind, "branch");
    assert.equal(sub.picks[2]?.opt?.kind, "ticket");
  });

  test("含空白路線與子節點名稱補完插入後，可被 parseQuickAdd 100% 往返辨識", () => {
    const ins = formatDestInsertion("Work Trip", "Phase 1");
    assert.equal(ins, '@"Work Trip"/"Phase 1" ');
    const replaced = replaceTriggerRange('準備簡報 @"Work Tr 明天', 5, 14, ins);
    assert.equal(replaced.text, '準備簡報 @"Work Trip"/"Phase 1" 明天');

    const parsed = parseQuickAdd(replaced.text, {
      today: "2026-11-20",
      dayStartHour: 4,
      routes: ROUTES,
      tasksOf: (rid) => (TREES.get(rid) ?? []).map((o) => ({ id: o.id, name: o.name, kind: o.kind })),
    });
    assert.equal(parsed.name, "準備簡報");
    assert.equal(parsed.scheduledOn, "2026-11-21");
    assert.deepEqual(parsed.dest, { routeId: "r2", nodeId: "tr1" });
  });

  test("方針輸入框選取 @路線 時，乾淨剝離 @... 標記不留多餘空白", () => {
    assert.deepEqual(replaceTriggerRange("念完 N4 文法 @日文", 9, 12, ""), {
      text: "念完 N4 文法",
      caret: 8,
    });
    assert.deepEqual(replaceTriggerRange("@JP 念完 N4 文法", 0, 3, ""), {
      text: "念完 N4 文法",
      caret: 0,
    });
  });
});

describe("第二梯 2A・操作 5 ＋ 操作 10：= 同乘車日語法與 14:00-15:30 時間膠囊", () => {
  const ctx = {
    today: "2026-11-20",
    dayStartHour: 4,
    routes: ROUTES,
    tasksOf: (rid: string) => (TREES.get(rid) ?? []).map((o) => ({ id: o.id, name: o.name, kind: o.kind })),
  };

  test("打 `明天 14:00-15:30 = @日文/N4 第1課` 同步亮起締切同乘車日、時間膠囊與掛載車票", () => {
    const p = parseQuickAdd('複習單字 明天 14:00-15:30 = @"日文"/"N4 第1課"', ctx);
    const v = mergeQuick(
      p,
      {},
      { dest: NO_DEST, scheduledOn: "2026-11-20" },
      (id) => (id === "tk1" ? "ticket" : null),
    );
    assert.equal(v.name, "複習單字");
    assert.equal(v.scheduledOn, "2026-11-21");
    assert.equal(v.syncDueWithScheduled, true);
    assert.equal(v.dueOn, "2026-11-21");
    assert.equal(v.scheduledTime, "14:00");
    assert.equal(v.estimateMin, 90);
    assert.deepEqual(v.dest, { routeId: "r1", nodeId: "tk1", nodeKind: "ticket" });
    assert.equal(formatClockSpanSummary(v.scheduledTime, v.estimateMin), "14:00–15:30 · 1h30");

    // 當使用者再用 chip 改乘車日為 11/25 時，`=` 同步將 dueOn 推進至 11/25
    const v2 = mergeQuick(p, { scheduledOn: "2026-11-25" }, { dest: NO_DEST, scheduledOn: "2026-11-20" }, () => "ticket");
    assert.equal(v2.scheduledOn, "2026-11-25");
    assert.equal(v2.dueOn, "2026-11-25");
    assert.equal(v2.syncDueWithScheduled, true);
  });

  test("行內編輯初始 due_on === scheduled_on 時，輸入明確 `〆11/30` 自動解除同乘車日並套用新締切", () => {
    const p = parseQuickAdd("繳交報告 〆11/30", ctx);
    const v = mergeQuick(
      p,
      {},
      { dest: NO_DEST, scheduledOn: "2026-11-22", dueOn: "2026-11-22", syncDueWithScheduled: true },
      () => null,
    );
    assert.equal(v.syncDueWithScheduled, false);
    assert.equal(v.dueOn, "2026-11-30");
  });
});
