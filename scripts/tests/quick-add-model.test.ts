/**
 * 建票列的規則（回饋甲 D-主-127、128；src/ui/common/quickadd/quickAddModel.ts）。
 * 跑法：`node --test scripts/tests/quick-add-model.test.ts`。純函式。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  INBOX_NOTE,
  NO_DEST,
  leaveNote,
  mergeQuick,
  resolveQuickTarget,
  stubLook,
  type QuickDest,
} from "../../src/ui/common/quickadd/quickAddModel.ts";
import type { QuickAddParse } from "../../src/domain/quickAdd.ts";

const ROUTE: QuickDest = { routeId: "r1", nodeId: null, nodeKind: "route" };
const TRAIN: QuickDest = { routeId: "r1", nodeId: "t1", nodeKind: "train" };
const BRANCH: QuickDest = { routeId: "r1", nodeId: "b1", nodeKind: "branch" };
const parse = (p: Partial<QuickAddParse> = {}): QuickAddParse => ({ name: "買牛奶", tokens: [], tags: [], ...p });
const noKind = () => null;

describe("resolveQuickTarget：掛到決定建成什麼", () => {
  test("無路線＝臨時車票", () => {
    assert.deepEqual(resolveQuickTarget(NO_DEST, "train"), { kind: "ticket", parentId: null, routeTagId: null, canChoose: false });
  });
  test("路線＝列車（可選車票）", () => {
    assert.deepEqual(resolveQuickTarget(ROUTE, "train"), { kind: "train", parentId: "r1", routeTagId: null, canChoose: true });
  });
  test("路線＋車票＝掛路線標籤的臨時車票", () => {
    assert.deepEqual(resolveQuickTarget(ROUTE, "ticket"), { kind: "ticket", parentId: null, routeTagId: "r1", canChoose: true });
  });
  test("支線＝列車掛在支線底下", () => {
    assert.deepEqual(resolveQuickTarget(BRANCH, "train"), { kind: "train", parentId: "b1", routeTagId: null, canChoose: true });
  });
  test("支線＋車票＝車票直接掛在支線底下（丁 D-主-245）", () => {
    assert.deepEqual(resolveQuickTarget(BRANCH, "ticket"), { kind: "ticket", parentId: "b1", routeTagId: null, canChoose: true });
  });
  test("列車＝車票（不給選）", () => {
    assert.deepEqual(resolveQuickTarget(TRAIN, "train"), { kind: "ticket", parentId: "t1", routeTagId: null, canChoose: false });
  });
});

describe("mergeQuick：chip ＞ 文字 ＞ 預設", () => {
  const defaults = { dest: NO_DEST, scheduledOn: "2026-11-02" };
  test("預設", () => {
    const v = mergeQuick(parse(), {}, defaults, noKind);
    assert.equal(v.scheduledOn, "2026-11-02");
    assert.equal(v.dest, NO_DEST);
    assert.equal(v.on.size, 0);
  });
  test("文字認出來的蓋過預設、chip 亮", () => {
    const v = mergeQuick(parse({ scheduledOn: "2026-11-03", priority: "high", tags: [{ name: "採買", key: "採買" }] }), {}, defaults, noKind);
    assert.equal(v.scheduledOn, "2026-11-03");
    assert.equal(v.priority, "high");
    assert.deepEqual(v.tags, ["採買"]);
    assert.ok(v.on.has("date") && v.on.has("priority") && v.on.has("tags"));
  });
  test("chip 蓋過文字；清成無日期也算設過", () => {
    const v = mergeQuick(parse({ scheduledOn: "2026-11-03" }), { scheduledOn: null }, defaults, noKind);
    assert.equal(v.scheduledOn, null);
    assert.ok(v.on.has("date"));
  });
  test("@路線/列車：用查到的種類", () => {
    const v = mergeQuick(parse({ dest: { routeId: "r1", nodeId: "c1" } }), {}, defaults, () => "car");
    assert.deepEqual(v.dest, { routeId: "r1", nodeId: "c1", nodeKind: "car" });
  });
  test("位置型：不看 @", () => {
    const v = mergeQuick(parse({ dest: { routeId: "r1", nodeId: null } }), {}, defaults, noKind, true);
    assert.equal(v.dest, NO_DEST);
  });
  test("幾點那格：chip 設了就連長度一起以 chip 為準", () => {
    const v = mergeQuick(parse({ scheduledTime: "14:00", estimateMin: 30 }), { scheduledTime: "15:00", estimateMin: null }, defaults, noKind);
    assert.equal(v.scheduledTime, "15:00");
    assert.equal(v.estimateMin, null);
    assert.ok(v.on.has("time"));
  });
});

describe("leaveNote：票離開眼前才出收據", () => {
  const temp = resolveQuickTarget(NO_DEST, "train");
  const name = (id: string) => (id === "r2" ? "生活" : "日文");
  test("今日：今天的不出、無日期＝收件匣、別天＝排到", () => {
    assert.equal(leaveNote({ kind: "today", dateKey: "2026-11-02" }, { scheduledOn: "2026-11-02", target: temp, routeId: null }, name), null);
    assert.equal(leaveNote({ kind: "today", dateKey: "2026-11-02" }, { scheduledOn: null, target: temp, routeId: null }, name), INBOX_NOTE);
    assert.equal(
      leaveNote({ kind: "today", dateKey: "2026-11-02" }, { scheduledOn: "2026-11-15", target: temp, routeId: null }, name),
      "已排到 11/15（日）",
    );
  });
  test("路線圖：同一條不出、別條＝建到", () => {
    const t = resolveQuickTarget({ routeId: "r2", nodeId: null, nodeKind: "route" }, "train");
    assert.equal(leaveNote({ kind: "route", routeId: "r1" }, { scheduledOn: null, target: resolveQuickTarget(ROUTE, "train"), routeId: "r1" }, name), null);
    assert.equal(leaveNote({ kind: "route", routeId: "r1" }, { scheduledOn: null, target: t, routeId: "r2" }, name), "已建到「生活」");
  });
});

describe("stubLook：票根寫會建成什麼", () => {
  test("臨時車票＝虛線臨", () => {
    assert.deepEqual(stubLook(resolveQuickTarget(NO_DEST, "train")), { badge: "臨", dashed: true, lineName: "無路線", fare: "臨時券" });
  });
  test("列車＝列、乘車券", () => {
    const l = stubLook(resolveQuickTarget(ROUTE, "train"));
    assert.equal(l.badge, "列");
    assert.equal(l.fare, "乘車券");
  });
  test("掛路線標籤的車票＝臨、臨時券（票根與右上角同一個說法）", () => {
    const l = stubLook(resolveQuickTarget(ROUTE, "ticket"));
    assert.equal(l.badge, "臨");
    assert.equal(l.fare, "臨時券");
  });
});
