/**
 * 側板的「移動到…」（磨光⑤ B1；契約 §1 B1、D-主-55／56）——列車、車廂、支線、車票（含臨時車票）、站的操作列左槽。
 *
 * `useMoveTo(node)` 回兩塊：`button` 放進 ActionsRow 的左槽、`picker` 接在 ActionsRow 下方（內嵌版 AttachPicker；
 * 側板內容只有 288px 寬，浮層版 300px 會撐出橫捲軸）。挑選器借旅客筆記「變待辦」的「掛到哪」：
 * 依節點種類決定能挑什麼（domain/moveTo 的 moveTargetRule）、藏掉自己與子樹（excludeId）、目前所在的父節點標「目前位置」。
 * 挑到＝`moveNodeTo`（放到新父節點最後、toast 附「復原」）。
 *
 * 大綱列 ⋯ 的「移動到…」走 `requestMoveTo`：選中＋開側板＋在這裡打開挑選器（只有側板一個家）。
 * 晚一拍才開：側板剛掛上時 PanelFrame 會把焦點收進面板根，挑選器要等那之後才拿得到搜尋框的焦點。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { NodeKind, NodeRow } from "../../domain";
import type { AttachTarget } from "../../domain/notes";
import { currentDest, moveTargetRule } from "../../domain/moveTo";
import { nodeRepo } from "../../data";
import { useNodeStore } from "../../store/nodeStore";
import { AttachPicker } from "../common/AttachPicker";
import type { AttachKind } from "../notes/useAttachOptions";
import { FieldRow } from "./fields";
import { Roundel } from "../notes/notesBits";
import { reattachTo } from "../common/quickadd/reattach";
import { moveNodeTo, useMoveRequest } from "../common/moveTo";
import "../notes/notes.css";
import "../common/moveTo.css";

export interface NodeLocationInfo {
  route: NodeRow | null;
  /** 完整階層名稱（如 ["日文", "單字", "第1週"]；無路線時為 []） */
  segments: string[];
  /** 父節點種類（根層臨時票＝null，路線直屬＝"route"） */
  parentKind: NodeKind | null;
  /** 此節點底下是否有活子項（空支線判斷「轉為車票」用） */
  hasKids: boolean;
}

/** 解析節點目前所在的完整路線階層路徑（支援跨路線從今日／行程表／搜尋點開） */
export function useNodeLocationInfo(node: NodeRow): NodeLocationInfo {
  const routes = useNodeStore((s) => s.routes);
  const activeRouteId = useNodeStore((s) => s.routeId);
  const tree = useNodeStore((s) => s.tree);
  const todayRow = useNodeStore((s) => s.today.byId[node.id]);
  const [remoteRows, setRemoteRows] = useState<{ routeId: string; rows: NodeRow[] } | null>(null);

  const route = node.route_id ? (routes.find((r) => r.id === node.route_id) ?? null) : null;
  const inActiveTree = Boolean(node.route_id && node.route_id === activeRouteId && (tree.byId[node.id] || node.parent_id === activeRouteId || node.parent_id === null));

  useEffect(() => {
    if (!node.route_id || inActiveTree) return;
    let alive = true;
    void nodeRepo
      .listRouteTree(node.route_id)
      .then((rows) => {
        if (alive && node.route_id) setRemoteRows({ routeId: node.route_id, rows });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [node.id, node.parent_id, node.route_id, inActiveTree, tree]);

  return useMemo(() => {
    if (!route) {
      const hasKids = (tree.childrenOf[node.id]?.length ?? 0) > 0 || (todayRow ? todayRow.child_total > 0 : false);
      return { route: null, segments: [], parentKind: null, hasKids };
    }
    const byId: Record<string, NodeRow | undefined> =
      inActiveTree
        ? tree.byId
        : remoteRows?.routeId === route.id
          ? Object.fromEntries(remoteRows.rows.map((r) => [r.id, r]))
          : {};
    const hasKids = inActiveTree
      ? (tree.childrenOf[node.id]?.length ?? 0) > 0
      : remoteRows?.routeId === route.id
        ? remoteRows.rows.some((r) => r.parent_id === node.id)
        : todayRow
          ? todayRow.child_total > 0
          : false;

    if (!node.parent_id || node.parent_id === route.id) {
      return {
        route,
        segments: [route.name],
        parentKind: node.parent_id === route.id ? "route" : null,
        hasKids,
      };
    }

    const parentNode = byId[node.parent_id];
    const parentKind: NodeKind | null = parentNode?.kind ?? null;
    const chain: string[] = [];
    const seen = new Set<string>([node.id]);
    let cur: string | null = node.parent_id;
    while (cur && cur !== route.id && !seen.has(cur)) {
      seen.add(cur);
      const hit: NodeRow | undefined = byId[cur];
      if (!hit) break;
      chain.push(hit.name);
      cur = hit.parent_id;
    }
    chain.reverse();
    return {
      route,
      segments: [route.name, ...chain],
      parentKind,
      hasKids,
    };
  }, [route, inActiveTree, tree, remoteRows, node.id, node.parent_id, todayRow]);
}

/** 父節點的種類：路線直屬（parent_id＝路線 id）、樹裡找得到、都不行才問 repository（今日頁開的票，樹多半沒載） */
async function parentKindOf(node: NodeRow): Promise<NodeKind | null> {
  const pid = node.parent_id;
  if (!pid) return null;
  const s = useNodeStore.getState();
  if (s.routes.some((r) => r.id === pid)) return "route";
  const t = s.tree.byId[pid] ?? s.today.byId[pid];
  if (t) return t.kind;
  const n = await nodeRepo.getNode(pid);
  return n?.kind ?? null;
}

/**
 * 搬完之後焦點常掉到 body：節點搬出目前這棵樹，側板會從樹切片換成補撈的那份、整塊重掛，原本那顆鈕已不在了。
 * 下一拍還在 body 才補：給重掛後的「移動到…」鈕，沒有就給側板本身（Esc 收側板、鍵盤流接得下去）。
 */
function refocusPanel(): void {
  setTimeout(() => {
    const a = document.activeElement;
    if (a && a !== document.body) return;
    const panel = document.querySelector<HTMLElement>("aside.panel");
    const btn = panel?.querySelector<HTMLElement>('button[data-move-trigger], button[aria-label="移動到…"]');
    (btn ?? panel)?.focus({ preventScroll: true });
  }, 0);
}

/**
 * Bug 5：任務詳情側板上方統一「掛在」欄位（列車／車廂／車票／支線共用，取代舊版只給臨時票的平鋪所屬路線）。
 * 顯示完整階層路徑（如「路線圓牌 日文 › 單字 › 第1週」或「無路線（臨時券）」），點擊直接展開全階層挑選器完成改掛。
 */
export function LocationFieldRow({
  node,
  info,
  bare = false,
}: {
  node: NodeRow;
  info?: NodeLocationInfo;
  /** true＝由外部 .fields 歸屬帶容器包覆，不再多包一層 .fields.panel-loc-fields */
  bare?: boolean;
}) {
  const loc = useNodeLocationInfo(node);
  const resolved = info ?? loc;
  const rule = moveTargetRule(node.kind);
  const [value, setValue] = useState<AttachTarget | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const req = useMoveRequest((s) => s.id);
  const isOpen = value !== null;

  useEffect(() => {
    const el = wrapRef.current;
    if (!isOpen || !el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => el.scrollIntoView({ block: "nearest" }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [isOpen]);

  const open = async () => {
    const kind = await parentKindOf(node);
    setValue(currentDest(node.parent_id, kind, node.route_id));
  };
  const close = () => {
    setValue(null);
    setTimeout(() => {
      const a = document.activeElement;
      if (!a || a === document.body) btnRef.current?.focus({ preventScroll: true });
    }, 0);
  };

  useEffect(() => {
    if (req !== node.id) return;
    useMoveRequest.getState().clear();
    void open();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req, node.id]);

  if (!rule) return null;
  const pathText = resolved.route ? resolved.segments.join(" › ") : "無路線（臨時券）";

  const inner = (
    <>
      <FieldRow label="掛在">
        <button
          ref={btnRef}
          type="button"
          data-pop-toggle
          data-move-trigger
          aria-haspopup="dialog"
          aria-expanded={isOpen}
          aria-label={`掛在：${pathText}`}
          title={`${pathText}（點一下改掛位置）`}
          className={"panel-loc-btn" + (isOpen ? " is-open" : "")}
          onClick={() => (isOpen ? close() : void open())}
        >
          {resolved.route ? (
            <Roundel route={resolved.route} />
          ) : (
            <span className="panel-loc-none" aria-hidden>
              臨
            </span>
          )}
          <span className={resolved.route ? "panel-loc-path" : "panel-loc-empty"}>{pathText}</span>
          <span className="panel-loc-chev" aria-hidden>
            ▾
          </span>
        </button>
      </FieldRow>
      {value !== null && (
        <div className="ns-moveto panel-loc-pop" ref={wrapRef}>
          <AttachPicker
            depth={rule.depth}
            kinds={rule.depth === "node" ? (rule.kinds as AttachKind[]) : undefined}
            routeSelectable={rule.routeSelectable}
            value={value}
            label={rule.label}
            excludeId={node.id}
            currentNote="目前位置"
            onPick={(t) => {
              close();
              void reattachTo(node, { routeId: t.routeId, nodeId: t.nodeId }).then(refocusPanel);
            }}
            onClear={
              node.kind === "ticket" && (node.parent_id !== null || node.route_id !== null)
                ? () => {
                    close();
                    void reattachTo(node, null).then(refocusPanel);
                  }
                : undefined
            }
            clearLabel="無路線（臨時車票）"
            onClose={close}
          />
        </div>
      )}
    </>
  );

  if (bare) return inner;
  return <div className="fields panel-loc-fields">{inner}</div>;
}

export function useMoveTo(node: NodeRow): { button: ReactNode; picker: ReactNode } {
  const rule = moveTargetRule(node.kind);
  /** 開著時＝挑選器的 value（目前位置）；null＝收著 */
  const [value, setValue] = useState<AttachTarget | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const req = useMoveRequest((s) => s.id);
  const isOpen = value !== null;

  // 挑選器一掛上就捲進視野（AttachPicker 自己也捲一次，但那時樹還沒載、清單是空的）；
  // 樹載好、清單長高之後再捲一次，免得清單下半截落在側板外
  useEffect(() => {
    const el = wrapRef.current;
    if (!isOpen || !el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => el.scrollIntoView({ block: "nearest" }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [isOpen]);

  const open = async () => {
    const kind = await parentKindOf(node);
    setValue(currentDest(node.parent_id, kind, node.route_id));
  };
  const close = () => {
    setValue(null);
    // 挑選器卸載後焦點會掉到 body：還給「移動到…」鈕（鍵盤流接得下去；Esc 收的也是這裡）
    // setTimeout 不用 rAF：rAF 在看不見的視窗裡不跑（代驗的背景分頁就是），焦點會永遠留在 body
    setTimeout(() => {
      const a = document.activeElement;
      if (!a || a === document.body) btnRef.current?.focus({ preventScroll: true });
    }, 0);
  };

  useEffect(() => {
    if (req !== node.id) return;
    useMoveRequest.getState().clear();
    // open 先 await 父節點種類才 setValue ⇒ 挑選器一定在這一輪 effect（含 PanelFrame 收焦點）跑完之後才掛上
    void open();
    // open 只讀 node 的欄位；以 req／id 為準
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req, node.id]);

  if (!rule) return { button: null, picker: null };

  const button = (
    <button
      ref={btnRef}
      type="button"
      // data-pop-toggle：AttachPicker 的「點外面收起」不把這顆當外面，否則按它收起後 click 又立刻打開
      data-pop-toggle
      aria-label="移動到…"
      aria-expanded={value !== null}
      title="搬到別的路線、列車或支線"
      onClick={() => (value ? close() : void open())}
      className="ns-btn ns-btn--sm btn-ghost" // UI 丙-1：跟同一列的 ActionButton 同一顆次鈕（§2.3）
    >
      移動到…
    </button>
  );

  const picker =
    value !== null ? (
      <div className="ns-moveto" ref={wrapRef}>
        <AttachPicker
          depth={rule.depth}
          kinds={rule.depth === "node" ? (rule.kinds as AttachKind[]) : undefined}
          routeSelectable={rule.routeSelectable}
          value={value}
          label={rule.label}
          excludeId={node.id}
          currentNote="目前位置"
          onPick={(t) => {
            close();
            void moveNodeTo(node.id, { routeId: t.routeId, nodeId: t.nodeId }).then(refocusPanel);
          }}
          onClose={close}
        />
      </div>
    ) : null;

  return { button, picker };
}
