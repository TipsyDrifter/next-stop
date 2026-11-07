/**
 * RouteBoard——桌機路線看板（⑫；契約 docs/research/2026-11-06-⑫看板與篩選-契約.md §1；視覺真相 prototypes/看板與篩選-⑫.html 01／02／07）。
 * 路線大綱（含聚焦）的「看板」分頁：頁首、分頁籤、分欄 chip 在 Outline，這裡是欄區、拖曳、新增列與多選。
 *
 * 三種分欄（欄的算術在 useRouteBoard／domain/board）：
 *   - 依狀態：放到別欄＝改現況，放到済＝蓋済（boardActions）；欄內不排序，所以只標欄不畫線。
 *   - 依列車：同欄、跨欄都能排，寫 sort_key（moveWithUndo＋鄰居錨）；能不能放走 dropVerdict，理由顯示同大綱。
 *   - 依車站：放到別欄＝改 station_id；欄內不排序。
 * 動作都附復原（boardActions／moveWithUndo）。外部落點：書封路線列（同大綱）。
 * 車庫裡的路線唯讀（契約 §1）：不新增、不換欄、不蓋章、不進多選，起拖就一句理由。
 * 點卡＝選中＋開側板（放手才開，拖曳不開）；Ctrl／Shift＋點＝多選（scope board），拖其中一張＝整批。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type MutableRefObject } from "react";
import type { NodeRow } from "../../domain";
import { BOARD_GROUP_LABEL, type BoardCard as BoardCardModel, type BoardGroup } from "../../domain/board";
import { PARKED_ADD_WHY } from "../../domain/depot";
import { useBoardStore } from "../../store/boardStore";
import { EMPTY_TREE, useNodeStore, type TreeIndex } from "../../store/nodeStore";
import { selectedIn, useSelectionStore } from "../../store/selectionStore";
import { useUiStore } from "../../store/uiStore";
import { useDragReorder, type DropPlace } from "../common/dragReorder";
import { IconChevron } from "../common/icons";
import { PopMenu } from "../common/PopMenu";
import { QuickAddLauncher, QuickAddRow, type QuickDefaults, type QuickDest } from "../common/quickadd";
import { dragBatch, pickClick } from "../common/selection/desktopSelection";
import { armOpenOnClick } from "../common/selection/openOnClick";
import { SelectionBar } from "../common/selection/SelectionBar";
import { useSelectable } from "../common/selection/useSelectable";
import { dropOnRoute, routeTargetVerdict } from "../outline/useOutlineDrag";
import { BoardCard } from "./BoardCard";
import { BoardColumns } from "./BoardColumns";
import { stampCard } from "./boardActions";
import { moveBoardCards, trainDropVerdict } from "./boardDrop";
import { boardCardMenu } from "./boardMenu";
import { useBoardKeyboard, type KeyColumn } from "./useBoardKeyboard";
import { useCardDefer } from "./useCardDefer";
import { ROUTE_LAYOUT_PANEL } from "./RouteViewTabs";
import { TOP_COL, type BoardColumnModel, useRouteBoard } from "./useRouteBoard";

const PARKED_DRAG_WHY = "已收進車庫——要改先回到運行";

/** 欄 → 建票列的預設（聚焦時掛到聚焦那一節；依列車＝那一欄的節點） */
function destOf(c: BoardColumnModel, routeId: string, zoom: NodeRow | null): QuickDest {
  const n = c.holder ?? zoom;
  if (n && (n.kind === "branch" || n.kind === "train" || n.kind === "car")) return { routeId, nodeId: n.id, nodeKind: n.kind };
  return { routeId, nodeId: null, nodeKind: "route" };
}

export interface RouteBoardProps {
  board: ReturnType<typeof useRouteBoard>;
  group: BoardGroup;
  routeId: string;
  tree: TreeIndex;
  zoom: NodeRow | null;
  parked: boolean;
  today: string;
  /** 看板的鍵盤表：Outline 的容器 onKeyDown 轉交（焦點留在容器，同大綱） */
  keysRef: MutableRefObject<((e: import("react").KeyboardEvent<HTMLElement>) => void) | null>;
  focusContainer(): void;
  escape(): void;
  /** 頁首「＋ 新增 ▾」的車票：seq 換＝開第一個能新增的那一欄 */
  addSeq: number;
  /** 依車站但這條路線還沒有車站：開路線詳情（車站在那裡加） */
  openRoutePanel(): void;
}

export function RouteBoard({ board, group, routeId, tree, zoom, parked, today, keysRef, focusContainer, escape, addSeq, openRoutePanel }: RouteBoardProps) {
  const { columns, items, order, topId, topKind } = board;
  const occurrences = useNodeStore((s) => s.currentOccurrences);
  const selectedId = useUiStore((s) => s.selectedId);
  const picked = useSelectionStore((s) => (s.scope === "board" ? s.ids : null));
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [freshId, setFreshId] = useState<string | null>(null);
  const defer = useCardDefer();

  // 建票列：一次開一欄；換路線、換聚焦、換分欄＝收起
  const [adding, setAdding] = useState<{ col: string; seq: number } | null>(null);
  const zoomId = zoom?.id ?? null;
  useEffect(() => setAdding(null), [routeId, zoomId, parked, group]);
  const addable = useCallback(
    (c: BoardColumnModel) => !parked && (group !== "status" || c.status === "todo"),
    [parked, group],
  );
  const lastAddSeq = useRef(addSeq);
  useEffect(() => {
    if (addSeq === lastAddSeq.current) return;
    lastAddSeq.current = addSeq;
    const first = columns.find(addable);
    if (first) setAdding({ col: first.key, seq: addSeq });
  }, [addSeq, columns, addable]);

  // 車庫裡的路線唯讀：Ctrl＋點、Ctrl＋A、⋯「選取」都進不了多選（selectionStore 那一關）
  useSelectable("board", () => !parked);
  // 多選只留畫面上看得到的；換路線、換聚焦不跨
  useEffect(() => useSelectionStore.getState().prune("board", order), [order, parked]);
  useEffect(() => {
    if (useSelectionStore.getState().scope === "board") useSelectionStore.getState().clear();
  }, [routeId, zoomId]);

  // 跳轉落點（boardReveal）：捲到那張（選中由跳轉做了）；畫出來才算數
  const reveal = useBoardStore((s) => s.cardReveal);
  useEffect(() => {
    if (!reveal || !order.includes(reveal.id)) return;
    useBoardStore.getState().consumeCardReveal();
    requestAnimationFrame(() => document.querySelector(`[data-node-id="${CSS.escape(reveal.id)}"]`)?.scrollIntoView({ block: "center", inline: "nearest" }));
  }, [reveal, order]);

  const flashFresh = (id: string) => {
    setFreshId(id);
    window.setTimeout(() => setFreshId((cur) => (cur === id ? null : cur)), 800);
  };
  const stamp = (n: NodeRow) => void stampCard(n).then((stamped) => stamped && flashFresh(n.id));

  const moveTo = (ids: readonly string[], colKey: string, anchor?: { after: string | null; before: string | null }) =>
    moveBoardCards({ group, columns, tree, routeId, topId, onStamped: flashFresh }, ids, colKey, anchor);

  useDragReorder({
    root,
    items,
    columns: { lines: group === "train" },
    canDrag: () => (parked ? PARKED_DRAG_WHY : true),
    onRefuse: (_id, why) => useUiStore.getState().showToast({ message: why }, 3600),
    dragIds: (id) => dragBatch("board", id, order),
    resolve: (ids, place: DropPlace) => {
      if (place.kind === "target") return place.type === "route" ? routeTargetVerdict(ids, place.target) : "這裡放不下";
      if (group !== "train") return true;
      return trainDropVerdict({ id: topId, kind: topKind }, ids, place.col ?? TOP_COL, place.after, place.before);
    },
    onDrop: (ids, place) => {
      if (place.kind === "target") {
        if (place.type === "route") dropOnRoute(ids, place.target);
        return;
      }
      moveTo(ids, place.col ?? TOP_COL, { after: place.after, before: place.before });
    },
  });

  const onPress = (node: NodeRow, e: MouseEvent<HTMLElement>) => {
    if ((e.target as HTMLElement).closest("input")) return;
    e.preventDefault();
    const ui = useUiStore.getState();
    if (pickClick("board", node.id, order, e, ui.selectedId)) {
      focusContainer();
      return;
    }
    armOpenOnClick(e, () => {
      if (useUiStore.getState().selectedId === node.id) useUiStore.getState().setPanelOpen(true);
    });
    ui.select(node.id);
    focusContainer();
  };

  const keyColumns = useMemo<KeyColumn[]>(
    () => columns.map((c) => ({ key: c.key, ids: c.rows.flatMap((r) => (r.type === "card" ? [r.card.node.id] : [])) })),
    [columns],
  );
  const keys = useBoardKeyboard({
    columns: keyColumns,
    order,
    node: (id) => useNodeStore.getState().tree.byId[id],
    stamp: (n) => {
      if (!parked) stamp(n);
    },
    shift: (ids, col) => {
      if (parked) useUiStore.getState().showToast({ message: PARKED_DRAG_WHY }, 3600);
      else moveTo(ids, col.key);
    },
    escape,
  });
  keysRef.current = keys;
  useEffect(() => () => void (keysRef.current = null), [keysRef]);

  const renderCard = (card: BoardCardModel<NodeRow>) => {
    const n = card.node;
    const path = card.crumb.length ? card.crumb.join(" › ") : n.parent_id === null ? "臨時車票" : null;
    return (
      <BoardCard
        key={n.id}
        node={n}
        today={today}
        occurrence={occurrences[n.id]}
        // 依列車的路徑就是欄與小標
        path={group === "train" ? null : path}
        showStatus={group !== "status"}
        selected={selectedId === n.id}
        picked={!!picked?.includes(n.id)}
        fresh={freshId === n.id}
        stampWhy={parked ? PARKED_ADD_WHY : undefined}
        onStamp={stamp}
        menu={() => boardCardMenu(n, { today, parked, order, openDefer: defer.open })}
        onPress={onPress}
        returnFocus={focusContainer}
      />
    );
  };

  const renderAdd = (c: BoardColumnModel) => {
    if (!addable(c)) return null;
    if (adding?.col === c.key) return <AddRow key={adding.seq} column={c} routeId={routeId} zoom={zoom} onClose={(kb) => { setAdding(null); if (kb) focusContainer(); }} />;
    return (
      <ul className="ns-bd-add">
        <QuickAddLauncher label="新增車票…" onOpen={() => setAdding((cur) => ({ col: c.key, seq: (cur?.seq ?? 0) + 1 }))} />
      </ul>
    );
  };

  const noStations = group === "station" && columns.length === 1;

  return (
    <div id={ROUTE_LAYOUT_PANEL.board} role="tabpanel" className="ns-bd" aria-label={`看板・${BOARD_GROUP_LABEL[group]}`}>
      {/* 樹還沒載到（剛換路線）不畫欄：不然會閃一下空欄 */}
      {tree !== EMPTY_TREE && (
      <BoardColumns
        columns={columns}
        rootRef={setRoot}
        train={group === "train"}
        renderCard={renderCard}
        renderAdd={renderAdd}
        emptyText={parked ? "沒有車票" : "拖到這裡"}
        onOpenDone={() => useUiStore.getState().toggleHideDone()}
        tail={
          noStations ? (
            <div className="ns-bd-nostation">
              <p>這條路線還沒有車站。</p>
              <button type="button" className="ns-btn btn-ghost ns-btn--sm" onClick={openRoutePanel}>
                到路線詳情加車站
              </button>
            </div>
          ) : null
        }
      />
      )}
      {defer.popover}
      <SelectionBar scope="board" lookup={(id) => useNodeStore.getState().tree.byId[id]} />
    </div>
  );
}

/** 一欄底部的建票列；依車站建好後把票掛到這一站 */
function AddRow({ column, routeId, zoom, onClose }: { column: BoardColumnModel; routeId: string; zoom: NodeRow | null; onClose(byKeyboard: boolean): void }) {
  const stationId = column.station?.id ?? null;
  const defaults = useMemo<QuickDefaults>(() => ({ dest: destOf(column, routeId, zoom), scheduledOn: null }), [column.key, routeId, zoom?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="ns-bd-add">
      <QuickAddRow
        variant="compact"
        defaults={defaults}
        here={{ kind: "route", routeId }}
        routeKind="ticket"
        placeholder="新增車票…"
        onClose={onClose}
        onCreated={(row) => {
          if (stationId) void useNodeStore.getState().updateNode(row.id, { station_id: stationId });
        }}
      />
    </div>
  );
}

/** 頁首下那一列右側：「分欄 ▾」（看板分頁才有） */
export function BoardGroupChip() {
  const group = useBoardStore((s) => s.boardGroup);
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const opts: readonly BoardGroup[] = ["status", "train", "station"];
  return (
    <>
      <button
        ref={btn}
        type="button"
        className="ns-bd-fchip"
        aria-haspopup="menu"
        aria-expanded={open}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="lb">分欄</span>
        <b>{BOARD_GROUP_LABEL[group]}</b>
        <IconChevron open size={12} className="chev" />
      </button>
      {open && (
        <PopMenu
          anchor={btn.current}
          overline={{ zh: "分欄", latin: "Columns" }}
          label="看板怎麼分欄"
          items={opts.map((g) => ({
            key: g,
            label: BOARD_GROUP_LABEL[g],
            caps: g === group ? "✓" : undefined,
            onSelect: () => {
              useBoardStore.getState().setBoardGroup(g);
              // 換分欄＝多選的語意換了（選的是這幾欄的卡），清掉
              if (selectedIn("board").length) useSelectionStore.getState().clear();
            },
          }))}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
