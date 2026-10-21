/**
 * 「移動到…」（跨路線搬遷）的純邏輯（磨光⑤ B1；契約 docs/research/2026-10-21-主線-磨光⑤核心第二班-契約.md §1 B1）。
 *
 * 搬遷本身走既有 `nodeRepo.move`（檢查父子種類、拒絕搬進自己子樹、改寫子樹的 line_id／route_id 快取）；
 * 這裡只算挑選器要的三件事——可以挑哪些種類當新父節點、挑選器裡要藏掉哪些列（自己與整個子樹）、放到新父節點的第幾位。
 * 桌機 AttachPicker 與手機 MobileAttachPicker 共用。
 *
 * 零 runtime import（型別只用 `import type`）——`scripts/tests/move-to.test.ts` 用 node 直接載入本檔；
 * 不經 `domain/index.ts`（契約 §0：新純函式放新檔、直接 import）。
 */
import type { NodeKind } from "./node";

/** 挑選器樹裡能出現的節點種類（＝ useAttachOptions 的 AttachKind；這裡另寫一份，免得 domain 反過來 import ui） */
export type MoveTreeKind = "branch" | "train" | "car";

export interface MoveTargetRule {
  /** "route"＝只挑路線（站）；"node"＝點進路線再挑支線／列車／車廂 */
  depth: "route" | "node";
  /** depth="node" 時樹裡能挑的種類；其餘種類當群組頭（灰字、不可點） */
  kinds: MoveTreeKind[];
  /** 路線本身能不能當新父節點（列車、支線、站可以；車票、車廂不行） */
  routeSelectable: boolean;
  /** 挑選器的小標 */
  label: string;
}

/**
 * 依「要搬的節點」種類決定能挑的新父節點（與 `allowedChildKinds` 對齊，測試會逐條核）：
 *   車票、車廂 → 列車／車廂；列車、支線 → 路線／支線；站 → 路線。
 * 幹線、路線不在這裡搬（路線換幹線走路線對話框）⇒ null＝不出「移動到…」。
 */
export function moveTargetRule(kind: NodeKind): MoveTargetRule | null {
  switch (kind) {
    case "ticket":
    case "car":
      return { depth: "node", kinds: ["train", "car"], routeSelectable: false, label: "移到哪一班列車或車廂" };
    case "train":
    case "branch":
      return { depth: "node", kinds: ["branch"], routeSelectable: true, label: "移到哪條路線或支線" };
    case "station":
      return { depth: "route", kinds: [], routeSelectable: true, label: "移到哪條路線" };
    default:
      return null;
  }
}

/** 挑選器樹的一列（AttachOption 的最小形狀：前序攤平、depth 0＝路線的直接子節點） */
export interface MoveTreeOption {
  id: string;
  depth: number;
  selectable: boolean;
}

/**
 * 藏掉自己與整個子樹。輸入是 flattenAttachTree 的前序清單（父先子後），
 * 所以子樹＝自己之後、depth 比自己深的那一段，遇到不比自己深的就結束。
 * excludeId 不在清單裡（別條路線、或要搬的是車票）＝原樣回傳。
 */
export function excludeSubtree<T extends MoveTreeOption>(opts: readonly T[], excludeId: string | null | undefined): T[] {
  if (!excludeId) return opts.slice();
  const out: T[] = [];
  let skipDepth: number | null = null;
  for (const o of opts) {
    if (skipDepth !== null) {
      if (o.depth > skipDepth) continue;
      skipDepth = null;
    }
    if (o.id === excludeId) {
      skipDepth = o.depth;
      continue;
    }
    out.push(o);
  }
  return out;
}

/**
 * 搬遷模式的樹只留「挑得到的」與「底下有挑得到的」那些群組頭：
 * 例如搬列車時樹裡只有支線能挑，別的列車、車廂全是灰字，留著只是噪音。
 */
export function pruneToSelectable<T extends MoveTreeOption>(opts: readonly T[]): T[] {
  const keep = new Array<boolean>(opts.length).fill(false);
  for (let i = 0; i < opts.length; i++) {
    if (!opts[i].selectable) continue;
    keep[i] = true;
    // 往前把祖先（depth 逐層變淺的那幾列）標成要留
    let want = opts[i].depth - 1;
    for (let j = i - 1; j >= 0 && want >= 0; j--) {
      if (opts[j].depth === want) {
        keep[j] = true;
        want--;
      }
    }
  }
  return opts.filter((_, i) => keep[i]);
}

/** 放到新父節點的最後一個（照 notesStore.attachTicket：既有子節點的 max(position)+1；沒有子節點＝0） */
export function appendIndex(siblings: readonly { position: number }[]): number {
  return siblings.reduce((m, n) => Math.max(m, n.position), -1) + 1;
}

/** 新父節點的位置描述（給「目前位置」比對與 toast） */
export interface MoveDest {
  routeId: string | null;
  /** null＝直接掛在路線底下 */
  nodeId: string | null;
}

/** 新父節點的 id：挑節點＝那個節點；只挑路線＝路線本身（路線直屬的子節點 parent_id 就是路線 id） */
export function destParentId(dest: MoveDest): string | null {
  return dest.nodeId ?? dest.routeId;
}

/** 挑到的就是目前所在的父節點（同一個位置，不用搬）。臨時車票（parent_id null）挑什麼都是新位置 */
export function isSameParent(dest: MoveDest, parentId: string | null): boolean {
  return parentId !== null && destParentId(dest) === parentId;
}

/**
 * 目前所在的父節點，換成挑選器的 value 形狀（標「目前位置」用）。
 * parentKind＝父節點的種類；父節點是路線 ⇒ nodeId null；臨時車票（沒有父節點）⇒ 只帶路線標籤，讓挑選器先展開那條路線。
 */
export function currentDest(
  parentId: string | null,
  parentKind: NodeKind | null,
  routeId: string | null,
): { routeId: string | null; nodeId: string | null; nodeKind: "route" | MoveTreeKind | null } {
  if (!parentId || !parentKind) return { routeId, nodeId: null, nodeKind: null };
  if (parentKind === "route") return { routeId: parentId, nodeId: null, nodeKind: "route" };
  const k = parentKind === "branch" || parentKind === "train" || parentKind === "car" ? parentKind : null;
  return { routeId, nodeId: parentId, nodeKind: k };
}

/** 成功 toast：「已移到「英文・閱讀」」；直接掛在路線底下就只寫路線名 */
export function moveToastText(routeName: string | null, parentName: string | null): string {
  const parts = [routeName, parentName].filter((s): s is string => !!s);
  return parts.length ? `已移到「${parts.join("・")}」` : "已移動";
}
