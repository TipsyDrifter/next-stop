/**
 * 刪一個節點（大綱、今日、行程表、側板、手機、收件匣）的純規則與流程本體（失物招領 §5-6，D-主-321）。
 * 零 runtime store／data import：`scripts/tests/delete-node-flow.test.ts` 用 node 直接載入本檔；
 * 接到 repository、store、確認框與 toast 的那一層在 `./deleteNodeFlow.ts`（同 panel/routeFlowRules 與 routeFlows 的分法）。
 *
 * 流程本體為什麼也放這裡：這一支修的正是流程上的錯（失敗也跳 toast、復原還原到上一批、子項數各算各的），
 * 只測文案擋不住，要連「什麼時候問、什麼時候 toast、復原帶哪幾個 id」一起測。
 */

/** 子項幾個以上要先問（規格書 §4、視覺規範 §2.4） */
export const DELETE_CONFIRM_MIN = 5;

export interface DeleteConfirmText {
  title: string;
  body: string;
  confirmLabel: string;
}

/**
 * 要不要先問、問什麼。count＝底下的子孫數（算到底，不含自己）；null＝查不到。
 * 查不到一律問：寧可多問一次，也不要不問就連同一整串子項刪掉。回 null＝不用問。
 */
export function deleteNodeConfirm(name: string, count: number | null): DeleteConfirmText | null {
  if (count === null) {
    return {
      title: `刪除「${name}」？`,
      body: "底下如果有子項會一起刪除；6 秒內可從底部提示復原。",
      confirmLabel: "刪除",
    };
  }
  if (count < DELETE_CONFIRM_MIN) return null;
  return {
    title: `連同 ${count} 個子項一起刪除？`,
    body: `「${name}」底下的 ${count} 個項目會一起刪除；6 秒內可從底部提示復原。`,
    confirmLabel: "一起刪除",
  };
}

/** 刪完的收據。removed＝這一刀實際刪掉幾個（連自己） */
export function deletedNodeToast(name: string, removed: number): string {
  return `已刪除「${name}」${removed > 1 ? `（含 ${removed - 1} 個子項）` : ""}`;
}

/** 流程要用到的外部能力（`deleteNodeFlow.ts` 接真的；測試接假的） */
export interface DeleteNodeDeps<N> {
  /** 連自己帶子孫的 id（跟 softDelete 會刪的同一批）；丟錯＝查不到 */
  subtreeIds(id: string): Promise<string[]>;
  /** 別線的附加句（接縫 #62） */
  hints(node: N, descendantIds: readonly string[]): Promise<string>;
  /** 開確認框 */
  confirm(text: DeleteConfirmText, onConfirm: () => void): void;
  /** 軟刪除、回這一刀的 id；失敗回 [] */
  remove(id: string): Promise<string[]>;
  /** 放回這一刀 */
  restore(ids: string[]): Promise<void>;
  /** 收據＋「復原」 */
  toast(message: string, onUndo: () => void): void;
}

export interface DeleteNodeHooks {
  /**
   * 真的要刪的那一刻（不用問＝馬上；要問＝按下確認之後）。不給＝直接刪。
   * 各頁在這裡包住刪除，做自己的事：算下一列、收 zoom、播離場動畫、重讀清單；`del()` 回 true＝刪成功（toast 已出）。
   */
  around?: (del: () => Promise<boolean>) => void | Promise<unknown>;
  /** 復原做完之後（側板選回那張、收件匣重讀清單） */
  onRestored?: () => void | Promise<void>;
}

/** 流程本體：查子孫 → 該問就問（接附加句）→ 刪 → **成功才** toast → 復原只放回這一刀的 ids */
export async function runDeleteNode<N extends { id: string; name: string }>(
  deps: DeleteNodeDeps<N>,
  node: N,
  hooks: DeleteNodeHooks = {},
): Promise<void> {
  const del = async (): Promise<boolean> => {
    const ids = await deps.remove(node.id);
    if (!ids.length) return false; // 失敗：deps.remove 已記錯；不出 toast，免得「復原」去還原別的東西
    deps.toast(deletedNodeToast(node.name, ids.length), () => {
      void (async () => {
        await deps.restore(ids);
        await hooks.onRestored?.();
      })();
    });
    return true;
  };
  const go = (): void => {
    void (hooks.around ? hooks.around(del) : del());
  };

  let descendants: string[] | null = null;
  try {
    descendants = (await deps.subtreeIds(node.id)).filter((x) => x !== node.id);
  } catch (e) {
    console.warn("刪除前查子項失敗", e);
  }
  const text = deleteNodeConfirm(node.name, descendants ? descendants.length : null);
  if (!text) {
    go();
    return;
  }
  // 別線的查詢失敗不能卡住刪除（hints 自己也吞錯；這裡再包一層，保證框一定開得出來）
  const extra = await deps.hints(node, descendants ?? []).catch((e) => {
    console.warn("刪除確認框的附加句失敗", e);
    return "";
  });
  deps.confirm({ ...text, body: extra ? `${text.body} ${extra}` : text.body }, go);
}
