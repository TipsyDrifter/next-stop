/**
 * SubTicketsDrawer — 今日頁母列車「子車票原地微展開」直屬子項抽屜（v1.36 D-1.36-2）。
 * 桌機（TodayRow）與手機（MobileTicket）共用同一支資料流與互動口徑。
 */
import { useEffect, useState } from "react";
import { isTaskKind, type NodeRow } from "../../domain";
import { nodeRepo } from "../../data";
import { isSettling, useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";
import { toggleStopoverFlow } from "../outline/nodeFlows";
import "./today-subtickets.css";

function mmdd(key: string): string {
  const p = key.split("-");
  return p.length === 3 ? `${Number(p[1])}/${Number(p[2])}` : key;
}

export interface SubTicketsDrawerProps {
  parentId: string;
  childDone: number;
  childTotal: number;
  mobile?: boolean;
  onOpenChild(id: string): void;
  onAfterAction?(): void;
}

export function SubTicketsDrawer({
  parentId,
  childDone,
  childTotal,
  mobile = false,
  onOpenChild,
  onAfterAction,
}: SubTicketsDrawerProps) {
  const [children, setChildren] = useState<NodeRow[] | null>(null);
  const [bump, setBump] = useState(0);
  // 今日切片或樹更新時（例如剛在側板／詳情改過子車票），自動重刷直屬子清單
  const todayRows = useNodeStore((s) => s.today.rows);
  const tree = useNodeStore((s) => s.tree);

  useEffect(() => {
    let alive = true;
    void nodeRepo
      .listChildren(parentId)
      .then((list) => {
        if (alive) setChildren(list);
      })
      .catch(() => {
        if (alive) setChildren([]);
      });
    return () => {
      alive = false;
    };
  }, [parentId, childDone, childTotal, todayRows, tree, bump]);

  const toggleChildStamp = async (kid: NodeRow) => {
    if (isSettling(kid.id)) return;
    const ns = useNodeStore.getState();
    const ui = useUiStore.getState();
    if (kid.status === "paused") {
      await toggleStopoverFlow(kid.id);
    } else if (kid.status === "done") {
      if (ui.completeCardFor === kid.id) ui.setCompleteCardFor(null);
      await ns.setCompleted(kid.id, false);
    } else {
      await ns.setCompleted(kid.id, true);
      if (isTaskKind(kid.kind) || kid.kind === "ticket") {
        ui.setCompleteCardFor(kid.id);
      }
    }
    setBump((n) => n + 1);
    onAfterAction?.();
  };

  return (
    <div
      className={mobile ? "m-subtickets" : "ns-subtickets"}
      role="region"
      aria-label="直屬子車票"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {children === null ? (
        <div className="ns-sub-empty">載入子車票中…</div>
      ) : children.length === 0 ? (
        <div className="ns-sub-empty">尚無直屬子車票</div>
      ) : (
        children.map((kid) => {
          const isDone = kid.status === "done";
          const isPaused = kid.status === "paused";
          const stampLabel = isPaused
            ? `解除「${kid.name}」的途中下車`
            : isDone
              ? `取消「${kid.name}」的完成章`
              : `將「${kid.name}」蓋章完成`;
          return (
            <div
              key={kid.id}
              className={
                "ns-sub-row" +
                (isDone ? " is-done" : "") +
                (isPaused ? " is-paused" : "")
              }
            >
              <button
                type="button"
                tabIndex={-1}
                className={
                  "ns-sub-stamp" +
                  (isDone ? " is-done" : "") +
                  (isPaused ? " is-paused" : "")
                }
                aria-label={stampLabel}
                aria-pressed={isDone}
                title={isPaused ? "途中下車中——點擊解除恢復" : isDone ? "取消済章" : "蓋章完成"}
                onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => {
                  e.stopPropagation();
                  void toggleChildStamp(kid);
                }}
              >
                {isDone ? "済" : isPaused ? "途" : ""}
              </button>
              <button
                type="button"
                tabIndex={-1}
                className="ns-sub-name"
                title={kid.name}
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenChild(kid.id);
                }}
              >
                {kid.name}
              </button>
              {kid.scheduled_on && (
                <span className="ns-sub-date" title={`乘車日 ${kid.scheduled_on}`}>
                  {mmdd(kid.scheduled_on)}
                </span>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
