/**
 * 並行回饋專卷・第一梯前端面板與建票純規則單元測試（feat/fb-w1-panels）。
 * 跑法：node --test scripts/tests/fb-w1-panels.test.ts
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

const Q = await import("../../src/ui/common/quickadd/quickAddModel.ts");
const P = await import("../../src/ui/panel/panelRules.ts");
const M = await import("../../src/domain/moveTo.ts");

describe("第一梯 1A・操作 2：建票「車票｜支線」場景分流", () => {
  const ROUTE = { routeId: "r-jp", nodeId: null, nodeKind: "route" as const };
  const BRANCH = { routeId: "r-jp", nodeId: "b-vocab", nodeKind: "branch" as const };
  const TRAIN = { routeId: "r-jp", nodeId: "t-week1", nodeKind: "train" as const };

  test("掛載於路線或支線時 canChoose 為 true，可切換建立車票或支線", () => {
    assert.deepEqual(Q.resolveQuickTarget(ROUTE, "ticket"), {
      kind: "ticket",
      parentId: null,
      routeTagId: "r-jp",
      canChoose: true,
    });
    assert.deepEqual(Q.resolveQuickTarget(ROUTE, "branch"), {
      kind: "branch",
      parentId: "r-jp",
      routeTagId: null,
      canChoose: true,
    });
    assert.deepEqual(Q.resolveQuickTarget(BRANCH, "ticket"), {
      kind: "ticket",
      parentId: "b-vocab",
      routeTagId: null,
      canChoose: true,
    });
    assert.deepEqual(Q.resolveQuickTarget(BRANCH, "branch"), {
      kind: "branch",
      parentId: "b-vocab",
      routeTagId: null,
      canChoose: true,
    });
  });

  test("掛載於列車或無路線時 canChoose 為 false，一律建立車票", () => {
    assert.deepEqual(Q.resolveQuickTarget(TRAIN, "branch"), {
      kind: "ticket",
      parentId: "t-week1",
      routeTagId: null,
      canChoose: false,
    });
    assert.deepEqual(Q.resolveQuickTarget(Q.NO_DEST, "branch"), {
      kind: "ticket",
      parentId: null,
      routeTagId: null,
      canChoose: false,
    });
  });

  test("切為支線時 stubLook 票根標「支」、虛線、票種「支線」", () => {
    assert.deepEqual(Q.stubLook(Q.resolveQuickTarget(ROUTE, "branch")), {
      badge: "支",
      dashed: true,
      lineName: "支線",
      fare: "支線",
    });
  });
});

describe("第一梯 1B・畫面 2：定期券重複區塊精簡模式選項", () => {
  test("ACTIVE_MODE_OPTIONS 僅保留「固定排程｜完成後間隔」二選一，切回一般票由上方票種切換負責", () => {
    assert.deepEqual(
      P.ACTIVE_MODE_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
      [
        { value: "fixed", label: "固定排程" },
        { value: "after", label: "完成後間隔" },
      ],
    );
  });
});

describe("第一梯 1A・Bug 1 ＋ 操作 8 UI：多選祖先去重啟用移動規則", () => {
  test("同時選中「支線＋子列車＋孫車票」時，去重後只留頂層支線，moveTargetRule 一致不衝突", () => {
    const parents: Record<string, string | null> = {
      b1: "r1",
      t1: "b1",
      tk1: "t1",
    };
    const roots = M.dedupeSubtreeRoots(["b1", "t1", "tk1"], (id) => parents[id] ?? null);
    assert.deepEqual(roots, ["b1"]);
    const rule = M.moveTargetRule("branch");
    assert.ok(rule !== null);
    assert.equal(rule.label, "移到哪條路線或支線");
  });
});
