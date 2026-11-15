/**
 * 票根改掛（v1.31 D-1.31-5「點票根直接改掛路線／列車」；操作 1＋討論 4）——今日列票根、行程表列圓牌、行內編輯列「掛到」膠囊共用。
 * 放在 quickadd：它就是建票列「掛到」那一格的「既有票」版本（同一個 AttachPicker、同一個 AnchoredLayer 浮層殼）。
 *
 *   currentDestOf(node)  目前所在的父節點 → AttachPicker 的 value 形狀（順手把父節點名記進 notesBits 快取，膠囊字才寫得出「路線 › 列車」）
 *   reattachTo(node, t)  搬過去：t＝挑到的路線／支線／列車／車廂（走共用 `moveNodeTo`：落在尾端＋toast 附「復原」）；
 *                        t＝null＝摘掉路線、變回無路線的臨時車票（只有車票能這樣；`moveToAnchor(null)`，同一筆寫入換標籤）
 *   ReattachPicker       錨定浮層版的「掛到哪」挑選器（共用 AttachPicker＋建票列的 AnchoredLayer，不另刻彈窗）：
 *                        能挑哪些種類照 domain/moveTo 的 moveTargetRule（與側板「移動到…」同一把尺）、藏掉自己與子樹、目前位置不可點
 *   useReattach(node)    列用的小鉤子：open(anchor)／picker 節點／這種節點能不能搬
 *
 * 浮層 portal 到 body，但 React 事件仍沿元件樹冒回列上（列的 mousedown＝選列＋把焦點收回清單容器、鍵盤快捷鍵也掛在容器）——
 * 一律在挑選器外包一層吞掉，免得點進搜尋框的那一下焦點被搶走、或在框裡打字觸發今日頁的單鍵快捷鍵。
 */
import { useEffect, useState, type ReactNode, type SyntheticEvent } from "react";
import type { NodeKind, NodeRow } from "../../../domain";
import type { AttachTarget } from "../../../domain/notes";
import { currentDest, moveTargetRule } from "../../../domain/moveTo";
import { anchorAround } from "../../../domain/nodeOrder";
import { nodeRepo } from "../../../data";
import { APPEND } from "../../../store/batchActions";
import { useNodeStore } from "../../../store/nodeStore";
import { useUiStore } from "../../../store/uiStore";
import { AttachPicker } from "../AttachPicker";
import { moveNodeTo } from "../moveTo";
import { AnchoredLayer } from "./QuickAddPickers";
import { rememberNodeName } from "../../notes/notesBits";
import "../../notes/notes.css";
import "./reattach.css";

type NodeLike = Pick<NodeRow, "id" | "kind" | "parent_id" | "route_id">;

const toast = (message: string) => useUiStore.getState().showToast({ message }, 4000);

/** 父節點的種類＋名字：路線直屬（parent_id＝路線 id）→ 已載入的樹／今日切片 → 都沒有才問 repository */
async function parentOf(node: NodeLike): Promise<{ kind: NodeKind; name: string } | null> {
  const pid = node.parent_id;
  if (!pid) return null;
  const s = useNodeStore.getState();
  const route = s.routes.find((r) => r.id === pid);
  if (route) return { kind: "route", name: route.name };
  const hit = s.tree.byId[pid] ?? s.today.byId[pid] ?? (await nodeRepo.getNode(pid));
  return hit ? { kind: hit.kind, name: hit.name } : null;
}

/** 目前所在的位置（挑選器標「目前位置」、行內編輯列「掛到」膠囊的初值） */
export async function currentDestOf(node: NodeLike): Promise<AttachTarget> {
  const p = await parentOf(node);
  if (p && node.parent_id && p.kind !== "route") rememberNodeName(node.parent_id, p.name);
  return currentDest(node.parent_id, p?.kind ?? null, node.route_id);
}

/** 同步版的粗估（還沒問到父節點種類前先畫得出來；父節點不是路線時先當列車，currentDestOf 回來再換） */
export function guessDestOf(node: NodeLike): AttachTarget {
  if (!node.parent_id) return { routeId: node.route_id, nodeId: null, nodeKind: node.route_id ? "route" : null };
  if (useNodeStore.getState().routes.some((r) => r.id === node.parent_id)) {
    return { routeId: node.parent_id, nodeId: null, nodeKind: "route" };
  }
  return { routeId: node.route_id, nodeId: node.parent_id, nodeKind: "train" };
}

/** 兩個位置是不是同一處（行內編輯列存檔時判斷「掛到」有沒有真的改） */
export function sameDest(a: Pick<AttachTarget, "routeId" | "nodeId">, b: Pick<AttachTarget, "routeId" | "nodeId">): boolean {
  return a.routeId === b.routeId && a.nodeId === b.nodeId;
}

/** 這種節點能不能改掛（幹線、路線不在這裡搬；車站另有路線對話框） */
export function canReattach(kind: NodeKind): boolean {
  return kind !== "station" && moveTargetRule(kind) !== null;
}

/**
 * 搬到 t（null＝摘掉路線變臨時車票）。成功回 true（toast＋復原已出）；同一處或被擋下回 false（toast 一句）。
 */
export async function reattachTo(node: NodeLike, t: Pick<AttachTarget, "routeId" | "nodeId"> | null): Promise<boolean> {
  if (t === null) return detach(node);
  // 掛路線標籤的臨時車票（parent_id null）再挑同一條路線＝原地不動（moveNodeTo 對 parent null 一律當新位置）
  if (node.kind === "ticket" && node.parent_id === null && t.nodeId === null && t.routeId === node.route_id) {
    toast("已經在這裡了");
    return false;
  }
  return moveNodeTo(node.id, { routeId: t.routeId, nodeId: t.nodeId });
}

/** 摘掉路線：車票搬回根層、清路線標籤（＝無路線的臨時車票）；復原＝搬回原父或原路線、原鄰居之間 */
async function detach(node: NodeLike): Promise<boolean> {
  if (node.kind !== "ticket") return false;
  if (node.parent_id === null && node.route_id === null) {
    toast("已經是無路線的臨時車票了");
    return false;
  }
  const ns = () => useNodeStore.getState();
  const anchor = anchorAround(await nodeRepo.listSiblingIds(node.id), node.id);
  const origParent = node.parent_id ?? node.route_id;
  const r = await ns().moveToAnchor([node.id], null, APPEND);
  if (!r.ok) {
    toast(r.reason ?? "沒有搬成功——請再試一次");
    return false;
  }
  useUiStore.getState().showToast({
    message: "已摘下路線——成了臨時車票",
    actionLabel: "復原",
    onAction: () =>
      void (async () => {
        const back = await ns().moveToAnchor([node.id], origParent, anchor);
        if (!back.ok) toast(back.reason ?? "復原失敗——請再試一次");
      })(),
  });
  return true;
}

const stop = (e: SyntheticEvent) => e.stopPropagation();

/** 吞掉從 portal 浮層沿 React 樹冒回列上的事件（見檔頭） */
export function StopBubble({ children }: { children: ReactNode }) {
  return (
    <span
      className="ns-reattach-host"
      onMouseDown={stop}
      onPointerDown={stop}
      onClick={stop}
      onDoubleClick={stop}
      onContextMenu={stop}
      onKeyDown={stop}
    >
      {children}
    </span>
  );
}

export interface ReattachPickerProps {
  node: NodeRow;
  anchor: HTMLElement;
  onClose(): void;
  /**
   * 給了＝只回報挑了什麼（行內編輯列：存檔時才搬，與其他膠囊同一個節奏）；沒給＝挑到就搬（票根）。
   * null＝挑了「無路線（臨時車票）」。
   */
  onPick?(t: AttachTarget | null): void;
}

export function ReattachPicker({ node, anchor, onClose, onPick }: ReattachPickerProps) {
  const rule = moveTargetRule(node.kind);
  const [value, setValue] = useState<AttachTarget | null>(null);

  useEffect(() => {
    let alive = true;
    void currentDestOf(node).then((v) => {
      if (alive) setValue(v);
    });
    return () => {
      alive = false;
    };
    // 只看這個節點與它的位置
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id, node.parent_id, node.route_id]);

  if (!rule || value === null) return null;
  const pick = (t: AttachTarget | null) => {
    onClose();
    if (onPick) onPick(t);
    else void reattachTo(node, t);
  };
  return (
    <StopBubble>
      <AnchoredLayer anchor={anchor} onClose={onClose} selfDismiss>
        <AttachPicker
          depth={rule.depth}
          kinds={rule.depth === "node" ? rule.kinds : undefined}
          routeSelectable={rule.routeSelectable}
          float
          label={rule.label}
          value={value}
          excludeId={node.id}
          currentNote="目前位置"
          onPick={(t) => pick(t)}
          onClear={node.kind === "ticket" && (node.parent_id !== null || node.route_id !== null) ? () => pick(null) : undefined}
          clearLabel="無路線（臨時車票）"
          onClose={onClose}
        />
      </AnchoredLayer>
    </StopBubble>
  );
}

/**
 * 列用：`open(anchor)` 開／收挑選器（同一顆鈕再按＝收）、`picker` 放進列裡（實際畫在 body）。
 * `onDone`：收起後要做的事（今日列＝焦點還給清單容器，鍵盤流接得下去）。
 */
export function useReattach(node: NodeRow | undefined, onDone?: () => void) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const can = !!node && canReattach(node.kind);
  const close = () => {
    setAnchor(null);
    onDone?.();
  };
  return {
    can,
    isOpen: anchor !== null,
    open: (el: HTMLElement) => setAnchor((cur) => (cur ? null : el)),
    picker: can && node && anchor ? <ReattachPicker node={node} anchor={anchor} onClose={close} /> : null,
  };
}
