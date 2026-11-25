/**
 * ChildTicketsSection——v1.36 三段式大硬券（D-1.36-6）下半主段「直屬子車票清單」（雙端共用）。
 *
 * - 當 `node.kind === "train" || node.kind === "car"` 時顯示。
 * - 先讀當前 `tree.childrenOf[node.id]`；若節點不在當前樹（從今日／行程表／搜尋打開），則呼叫 `nodeRepo.listChildren(node.id)` 補撈。
 * - 支援：完成計數 `d/t`、每張子票原地蓋 `済` / 取消 `済`、顯示「下車」途中下車章、點擊子票名切換詳情查看、以及行內「＋ 新增子車票」輕量入口。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseRule, type NodeRow } from "../../domain";
import { nodeRepo } from "../../data";
import { isSettling, useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";
import { useMobileDetailStore } from "../mobile/detail/mobileDetailStore";
import { changeStatusFlow, openKidsOf, panelStampFlow } from "../outline/nodeFlows";

export interface ChildTicketsSectionProps {
  node: NodeRow;
  variant: "desktop" | "mobile";
}

export function ChildTicketsSection({ node, variant }: ChildTicketsSectionProps) {
  const isParentKind = node.kind === "train" || node.kind === "car";
  const tree = useNodeStore((s) => s.tree);
  const today = useNodeStore((s) => s.today);
  const currentOccurrences = useNodeStore((s) => s.currentOccurrences);
  const routes = useNodeStore((s) => s.routes);

  const inTree = Boolean(tree.byId[node.id]);
  const [remoteChildren, setRemoteChildren] = useState<NodeRow[] | null>(null);
  const [rev, setRev] = useState(0);

  const fetchRemote = useCallback(async () => {
    if (!isParentKind || inTree) return;
    try {
      const rows = await nodeRepo.listChildren(node.id);
      setRemoteChildren(rows);
    } catch {
      setRemoteChildren([]);
    }
  }, [isParentKind, inTree, node.id]);

  useEffect(() => {
    if (!isParentKind || inTree) {
      setRemoteChildren(null);
      return;
    }
    let alive = true;
    void nodeRepo
      .listChildren(node.id)
      .then((rows) => {
        if (alive) setRemoteChildren(rows);
      })
      .catch(() => {
        if (alive) setRemoteChildren([]);
      });
    return () => {
      alive = false;
    };
  }, [isParentKind, inTree, node.id, node.updated_at, tree, today, currentOccurrences, rev]);

  const children = useMemo<NodeRow[]>(() => {
    if (!isParentKind) return [];
    if (inTree) {
      return (tree.childrenOf[node.id] ?? [])
        .map((id) => tree.byId[id])
        .filter((r): r is NodeRow => Boolean(r));
    }
    return remoteChildren ?? [];
  }, [isParentKind, inTree, tree, node.id, remoteChildren]);

  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [freshId, setFreshId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (adding) inputRef.current?.focus();
  }, [adding]);

  if (!isParentKind) return null;

  const isMobile = variant === "mobile";
  const route = node.route_id ? routes.find((r) => r.id === node.route_id) : undefined;
  const canAdd = !route?.arrived_on;

  const total = children.length;
  const doneCount = children.filter((c) => {
    const isTeiki = parseRule(c.repeat_rule) !== null && c.status !== "done";
    if (isTeiki) return currentOccurrences[c.id]?.status === "done";
    return c.status === "done";
  }).length;
  const heading = total > 0 && children.every((c) => c.kind === "ticket") ? "子車票" : "直屬子項";

  const openChild = (childId: string) => {
    if (isMobile) useMobileDetailStore.getState().open(childId);
    else useUiStore.getState().select(childId);
  };

  const toggleStamp = (child: NodeRow) => {
    if (isSettling(child.id)) return;
    const isTeiki = parseRule(child.repeat_rule) !== null && child.status !== "done";
    const opts = isMobile ? ({ retractCard: true } as const) : undefined;
    if (isTeiki) {
      const r = panelStampFlow(child, currentOccurrences[child.id], opts);
      if (r === true) setFreshId(child.id);
    } else {
      const done = child.status === "done";
      if (!done) setFreshId(child.id);
      changeStatusFlow(child, done ? "todo" : "done", openKidsOf(child), opts);
    }
    if (!inTree) {
      // 補撈模式：store 寫完後再拉一次最新子項清單
      setTimeout(() => {
        setRev((x) => x + 1);
        void fetchRemote();
      }, 120);
    }
  };

  const submitAdd = async () => {
    const name = draft.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      useUiStore.getState().setCollapsed(node.id, false);
      const created = await useNodeStore.getState().createNode({
        kind: "ticket",
        name,
        parentId: node.id,
      });
      if (created) {
        setDraft("");
        setAdding(false);
        if (!inTree) {
          setRev((x) => x + 1);
          await fetchRemote();
        }
      }
    } finally {
      setBusy(false);
    }
  };

  if (total === 0 && !adding) {
    if (!canAdd) return null;
    return (
      <div className={isMobile ? "m-dt-kids is-empty" : "panel-kids is-empty"}>
        <button
          type="button"
          className={isMobile ? "m-dt-kids-addbtn" : "panel-kids-addbtn"}
          onClick={() => setAdding(true)}
        >
          ＋ 新增子車票
        </button>
      </div>
    );
  }

  return (
    <div className={isMobile ? "m-dt-kids" : "panel-kids"}>
      <div className={isMobile ? "m-dt-kids-head" : "panel-kids-head"}>
        <span className={isMobile ? "m-dt-kids-title" : "panel-kids-title"}>
          {heading}
          {total > 0 && (
            <span className={isMobile ? "m-dt-kids-count" : "panel-kids-count"}>
              {doneCount}/{total}
            </span>
          )}
        </span>
        {canAdd && !adding && (
          <button
            type="button"
            className={isMobile ? "m-dt-kids-addbtn" : "panel-kids-addbtn"}
            onClick={() => setAdding(true)}
          >
            ＋ 新增子車票
          </button>
        )}
      </div>

      {total > 0 && (
        <ul className={isMobile ? "m-dt-kids-list" : "panel-kids-list"}>
          {children.map((child) => {
            const isTeiki = parseRule(child.repeat_rule) !== null && child.status !== "done";
            const occ = currentOccurrences[child.id];
            const done = isTeiki ? occ?.status === "done" : child.status === "done";
            const paused = !isTeiki && child.status === "paused";
            const fresh = freshId === child.id && done;

            return (
              <li
                key={child.id}
                className={
                  (isMobile ? "m-dt-kid" : "panel-kid") +
                  (done ? " is-done" : "") +
                  (paused ? " is-paused" : "")
                }
              >
                <button
                  type="button"
                  className={
                    (isMobile ? "m-dt-kid-stamp" : "panel-kid-stamp") +
                    (done ? " is-on" : "") +
                    (fresh ? " is-fresh" : "")
                  }
                  aria-label={done ? `取消済章：${child.name}` : `蓋済：${child.name}`}
                  aria-pressed={done}
                  title={done ? "取消済章" : "蓋済"}
                  onClick={() => toggleStamp(child)}
                  onAnimationEnd={() => setFreshId(null)}
                >
                  <span aria-hidden="true">済</span>
                </button>

                <button
                  type="button"
                  className={isMobile ? "m-dt-kid-name" : "panel-kid-name"}
                  title={`查看「${child.name}」詳情`}
                  onClick={() => openChild(child.id)}
                >
                  {child.kind === "car" && (
                    <span className={isMobile ? "m-dt-kid-kind" : "panel-kid-kind"} aria-hidden="true">
                      廂
                    </span>
                  )}
                  <span className={isMobile ? "m-dt-kid-text" : "panel-kid-text"}>{child.name}</span>
                </button>

                {paused && (
                  <span className={isMobile ? "m-dt-kid-geshya" : "panel-kid-geshya"} title="途中下車">
                    下車
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {adding && (
        <div className={isMobile ? "m-dt-kids-form" : "panel-kids-form"}>
          <input
            ref={inputRef}
            type="text"
            className={isMobile ? "m-dt-kids-in" : "panel-kids-in"}
            placeholder="輸入子車票名稱…"
            aria-label="新增子車票名稱"
            enterKeyHint="done"
            autoComplete="off"
            value={draft}
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === "Enter") {
                e.preventDefault();
                void submitAdd();
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setDraft("");
                setAdding(false);
              }
            }}
          />
          <button
            type="button"
            className="ns-btn ns-btn--sm btn-ghost"
            disabled={busy}
            onClick={() => {
              setDraft("");
              setAdding(false);
            }}
          >
            取消
          </button>
          <button
            type="button"
            className="ns-btn ns-btn--sm btn-seal"
            disabled={busy || !draft.trim()}
            onClick={() => void submitAdd()}
          >
            新增
          </button>
        </div>
      )}
    </div>
  );
}
