/**
 * dropRules——路線圖的列拖到哪裡可以放（回饋乙 D-主-151～153；契約 §3）。桌機大綱與手機路線圖第二層共用一份。
 *
 * 規則＝「移動到…」的種類限制（車票、車廂→列車／車廂；列車、支線→路線／支線），種類轉換同升降層（adaptKind：
 *   車廂到路線層變列車、列車進列車變車廂）。另外兩條：
 *   - 不能放進自己或自己的子孫底下（元件已把子孫藏起來，這裡再擋一次）；
 *   - 車票放到路線最上層：丁 D-主-245 起可以——路線底下的車票就是掛這條路線標籤的根層臨時車票（資料層 moveToAnchor 換成這種存法）。
 *     （之前只准本來就在最上層的臨時車票重排、列車裡的車票拖上來會被擋；巢狀放寬後「路線與支線底下可以直接放車票」。）
 * 回傳的 parentId 照 nodeStore.moveToAnchor 的慣例：路線 id＝路線最上層、其他節點 id＝放進它底下。
 *
 * 零 runtime import（型別只用 import type）：scripts/tests/drop-rules.test.ts 直接載入。
 */
import type { NodeKind, NodeRow } from "./node";

/** 樹的最小形狀（nodeStore.TreeIndex 的子集） */
export interface DropTree {
  byId: Record<string, Pick<NodeRow, "id" | "kind" | "parent_id">>;
  childrenOf: Record<string, string[]>;
}

/** 與 domain/node.ts allowedChildKinds 同表（這裡另寫一份免 runtime import；drop-rules 測試逐條核對兩邊一致） */
export function childKinds(parent: NodeKind): NodeKind[] {
  switch (parent) {
    case "line":
      return ["route"];
    case "route":
      return ["branch", "train", "station"];
    case "branch":
      return ["branch", "train", "ticket"];
    case "train":
    case "car":
      return ["car", "ticket"];
    default:
      return [];
  }
}

/** 種類跟著位置走（＝nodeStore.adaptKind）：放得下照舊；列車⇄車廂互換；都不行 null */
export function adaptTo(kind: NodeKind, parentKind: NodeKind): NodeKind | null {
  const ok = childKinds(parentKind);
  if (ok.includes(kind)) return kind;
  if (kind === "car" && ok.includes("train")) return "train";
  if (kind === "train" && ok.includes("car")) return "car";
  return null;
}

const KIND_WORD: Partial<Record<NodeKind, string>> = { train: "列車", car: "車廂", ticket: "車票", branch: "支線" };

/** 為什麼放不下（一句話，顯示在指標旁） */
function whyNot(kind: NodeKind, parentKind: NodeKind): string {
  if (kind === "ticket") return "車票要放在路線、支線、列車或車廂裡";
  if (kind === "branch") return parentKind === "route" || parentKind === "branch" ? "" : "支線要放在路線或支線底下";
  return `${KIND_WORD[kind] ?? "這一項"}放不進${KIND_WORD[parentKind] ?? "這裡"}`;
}

function isInside(tree: DropTree, id: string, ancestor: string): boolean {
  for (let cur = tree.byId[id]?.parent_id ?? null, guard = 0; cur && guard < 64; cur = tree.byId[cur]?.parent_id ?? null, guard++) {
    if (cur === ancestor) return true;
  }
  return false;
}

export type DropVerdict = { ok: true; parentId: string } | { ok: false; why: string };

/**
 * ids 要放到 `displayParent`（畫面上的父列 id；null＝這份清單的最上層）底下。
 * `top`＝最上層對應的節點：平常是路線（kind route）、聚焦（zoom）時是聚焦的那個節點。
 */
export function dropVerdict(
  tree: DropTree,
  top: { id: string; kind: NodeKind },
  ids: readonly string[],
  displayParent: string | null,
): DropVerdict {
  const parentId = displayParent ?? top.id;
  const parentKind = displayParent ? tree.byId[displayParent]?.kind : top.kind;
  if (!parentKind) return { ok: false, why: "要放進去的地方已經不在了" };
  for (const id of ids) {
    const n = tree.byId[id];
    if (!n) return { ok: false, why: "要搬的項目已經不在了" };
    if (id === parentId || isInside(tree, parentId, id)) return { ok: false, why: "不能放進自己底下" };
    // 丁 D-主-245：車票放到路線最上層＝掛這條路線標籤的根層臨時車票（資料層 moveToAnchor 換存法）
    if (n.kind === "ticket" && parentKind === "route") continue;
    if (!adaptTo(n.kind, parentKind)) return { ok: false, why: whyNot(n.kind, parentKind) || "放不進這裡" };
  }
  return { ok: true, parentId };
}
