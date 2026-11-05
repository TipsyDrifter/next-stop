/**
 * 失物招領 §5-6（D-主-321）：刪節點的共用流程——src/ui/common/deleteNodeRules.ts。
 * 大綱、今日、行程表、側板、手機、收件匣都走這一支；這裡釘住的是之前各寫各的時候出過錯的地方：
 * 子項數同一個口徑、≥5 才問、失敗不跳 toast、復原只放回這一刀（不是上一批）。
 * 跑法：`node --test scripts/tests/delete-node-flow.test.ts`（本檔只載 deleteNodeRules.ts，零依賴）。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  DELETE_CONFIRM_MIN,
  deleteNodeConfirm,
  deletedNodeToast,
  runDeleteNode,
  type DeleteConfirmText,
  type DeleteNodeDeps,
  type DeleteNodeHooks,
} from "../../src/ui/common/deleteNodeRules.ts";

type N = { id: string; name: string };
const NODE: N = { id: "a", name: "早會" };

describe("文案", () => {
  test("子項少於 5 不問；5 個起問、標題照視覺規範 §4", () => {
    assert.equal(DELETE_CONFIRM_MIN, 5);
    assert.equal(deleteNodeConfirm("早會", 0), null);
    assert.equal(deleteNodeConfirm("早會", 4), null);
    assert.deepEqual(deleteNodeConfirm("早會", 5), {
      title: "連同 5 個子項一起刪除？",
      body: "「早會」底下的 5 個項目會一起刪除；6 秒內可從底部提示復原。",
      confirmLabel: "一起刪除",
    });
  });

  test("查不到子項數＝一律問、標題寫名稱", () => {
    const t = deleteNodeConfirm("早會", null);
    assert.equal(t?.title, "刪除「早會」？");
    assert.equal(t?.confirmLabel, "刪除");
  });

  test("收據：沒子項不帶括號；有子項數的是實際刪掉的", () => {
    assert.equal(deletedNodeToast("早會", 1), "已刪除「早會」");
    assert.equal(deletedNodeToast("早會", 4), "已刪除「早會」（含 3 個子項）");
  });
});

/** 假的外部能力：記下發生過什麼；確認框不自動按，測試自己按 */
function harness(over: Partial<DeleteNodeDeps<N>> = {}) {
  const log = {
    removed: [] as string[],
    restored: [] as string[][],
    toasts: [] as { message: string; undo: () => void }[],
    confirms: [] as { text: DeleteConfirmText; yes: () => void }[],
    hintArgs: [] as (readonly string[])[],
  };
  const deps: DeleteNodeDeps<N> = {
    subtreeIds: async (id) => [id],
    hints: async (_n, ids) => {
      log.hintArgs.push(ids);
      return "";
    },
    confirm: (text, yes) => log.confirms.push({ text, yes }),
    remove: async (id) => {
      log.removed.push(id);
      return [id];
    },
    restore: async (ids) => {
      log.restored.push(ids);
    },
    toast: (message, undo) => log.toasts.push({ message, undo }),
    ...over,
  };
  return { deps, log };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const kids = (n: number) => ["a", ...Array.from({ length: n }, (_, i) => `c${i}`)];

describe("流程", () => {
  test("子項少：不問、直接刪、toast 帶復原", async () => {
    const { deps, log } = harness({ subtreeIds: async () => kids(4), remove: async () => kids(4) });
    await runDeleteNode(deps, NODE);
    await tick();
    assert.equal(log.confirms.length, 0);
    assert.equal(log.toasts[0].message, "已刪除「早會」（含 4 個子項）");
  });

  test("子項 ≥5：先問，附加句接在說明後面、拿到完整的子孫 id；按下確認才刪", async () => {
    const { deps, log } = harness({
      subtreeIds: async () => kids(5),
      hints: async (_n, ids) => {
        log.hintArgs.push(ids);
        return "這裡掛了 2 則筆記。";
      },
    });
    await runDeleteNode(deps, NODE);
    assert.equal(log.removed.length, 0, "還沒按確認");
    assert.deepEqual(log.hintArgs[0], kids(5).slice(1));
    assert.match(log.confirms[0].text.body, /復原。 這裡掛了 2 則筆記。$/);
    log.confirms[0].yes();
    await tick();
    assert.deepEqual(log.removed, ["a"]);
    assert.equal(log.toasts.length, 1);
  });

  test("查子項失敗：寧可問一次，也不要不問就刪", async () => {
    const { deps, log } = harness({
      subtreeIds: async () => {
        throw new Error("db");
      },
    });
    await runDeleteNode(deps, NODE);
    assert.equal(log.removed.length, 0);
    assert.equal(log.confirms[0].text.title, "刪除「早會」？");
  });

  test("附加句查詢丟錯：框照開、字不變", async () => {
    const { deps, log } = harness({
      subtreeIds: async () => kids(6),
      hints: async () => {
        throw new Error("別線壞了");
      },
    });
    await runDeleteNode(deps, NODE);
    assert.equal(log.confirms[0].text.body, "「早會」底下的 6 個項目會一起刪除；6 秒內可從底部提示復原。");
  });

  test("刪除失敗（回 []）：不跳 toast，around 拿到 false", async () => {
    const { deps, log } = harness({ remove: async () => [] });
    const seen: boolean[] = [];
    await runDeleteNode(deps, NODE, { around: async (del) => seen.push(await del()) });
    await tick();
    assert.deepEqual(seen, [false]);
    assert.equal(log.toasts.length, 0);
  });

  test("復原只放回這一刀：接連刪兩次，按第一張 toast 的復原還原的是第一批", async () => {
    const batches: Record<string, string[]> = { a: ["a", "c0"], b: ["b"] };
    const { deps, log } = harness({ remove: async (id) => batches[id] });
    await runDeleteNode(deps, NODE);
    await runDeleteNode(deps, { id: "b", name: "晚會" });
    await tick();
    log.toasts[0].undo();
    await tick();
    assert.deepEqual(log.restored, [["a", "c0"]]);
  });

  test("around 包住刪除：前後各做各頁的事；復原做完才叫 onRestored", async () => {
    const steps: string[] = [];
    const { deps, log } = harness({
      remove: async () => {
        steps.push("remove");
        return ["a"];
      },
      restore: async () => {
        steps.push("restore");
      },
    });
    const hooks: DeleteNodeHooks = {
      around: async (del) => {
        steps.push("before");
        if (await del()) steps.push("after");
      },
      onRestored: () => {
        steps.push("restored");
      },
    };
    await runDeleteNode(deps, NODE, hooks);
    await tick();
    log.toasts[0].undo();
    await tick();
    assert.deepEqual(steps, ["before", "remove", "after", "restore", "restored"]);
  });
});
