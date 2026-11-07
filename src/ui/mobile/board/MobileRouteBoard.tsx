/**
 * MobileRouteBoard——手機路線看板（⑫；契約 docs/research/2026-11-06-⑫看板與篩選-契約.md §1、§4；視覺真相 prototypes/看板與篩選-⑫.html 03）。
 * 路線第二層的「看板」分頁：抬頭、麵包屑在 MobileRouteMap，這裡是分頁列、欄區與卡；頁底建票列（`MobileBoardAdd`）與選取列要當殼的直接子節點，由 MobileRouteMap 掛。
 *
 * 語意全部同桌機 RouteBoard（欄的算術 useRouteBoard、落點 boardDrop、動作 boardActions／boardMenu 那一組）：
 *   依狀態＝改現況、依列車＝寫 sort_key（欄內可排序）、依車站＝改 station_id；車庫裡的路線唯讀，起拖就一句理由。
 * 手機多的：點卡開詳情頁、⋯ 開底部面板；長按原地放開＝多選（D-主-152），多選中點卡＝加選或取消、拖其中一張＝整批。
 * 建票列跟著目前那一欄：依列車＝掛到那一欄的節點、依車站＝建好掛到那一站；依狀態新票都在未開始，建好跳過去（建好的東西要出現在眼前）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { NodeRow } from "../../../domain";
import { BOARD_GROUP_LABEL, type BoardCard as BoardCardModel, type BoardGroup } from "../../../domain/board";
import { PARKED_ADD_WHY } from "../../../domain/depot";
import { useBoardStore, type RouteLayout } from "../../../store/boardStore";
import { useNodeStore, type TreeIndex } from "../../../store/nodeStore";
import { useSelectionStore } from "../../../store/selectionStore";
import { useUiStore } from "../../../store/uiStore";
import { BoardCard } from "../../board/BoardCard";
import { stampCard } from "../../board/boardActions";
import { moveBoardCards, trainDropVerdict } from "../../board/boardDrop";
import { TOP_COL, type useRouteBoard, type BoardColumnModel } from "../../board/useRouteBoard";
import type { DropPlace } from "../../common/dragReorder";
import { IconChevron } from "../../common/icons";
import { MSheet, MSheetItem } from "../../common/MSheet";
import { DoneToggleChip, MobileQuickAdd, type QuickDefaults, type QuickDest, type QuickHere } from "../../common/quickadd";
import { Tabs } from "../../common/Tabs";
import { useBackLayer } from "../backStack";
import { useMobileDetailStore } from "../detail/mobileDetailStore";
import { useSelectable } from "../../common/selection/useSelectable";
import { SelectCheck, batchDragIds, pressSelect, tapSelect, usePruneSelection, useScopeSelection } from "../mobileSelect";
import { MobileBoardCardSheet } from "./MobileBoardCardSheet";
import { DOCK_TYPE, MobileBoardColumns } from "./MobileBoardColumns";

const SHEET_LAYER = "core.boardSheet";
const PARKED_DRAG_WHY = "已收進車庫——要改先回到運行";
const GROUPS: readonly BoardGroup[] = ["status", "train", "station"];
/** 跳轉落點留在卡上多久（同大綱的閃一下） */
const REVEAL_MS = 1600;

/** 大綱｜看板的分頁內容 id（ARIA：Tabs 的 aria-controls ↔ 內容的 role="tabpanel"） */
export const ROUTE_LAYOUT_PANEL: Readonly<Record<RouteLayout, string>> = { outline: "m-route-panel-outline", board: "m-route-panel-board" };

/** 路線第二層抬頭下面那一列：大綱｜看板＋（看板分頁）分欄 */
export function MobileRouteLayoutTabs() {
  const value = useBoardStore((s) => s.routeLayout);
  const group = useBoardStore((s) => s.boardGroup);
  const [open, setOpen] = useState(false);
  return (
    <div className="ns-tabrow m-bd-tabrow">
      <Tabs<RouteLayout>
        aria-label="大綱或看板"
        value={value}
        onChange={(v) => useBoardStore.getState().setRouteLayout(v)}
        getPanelId={(k) => ROUTE_LAYOUT_PANEL[k]}
        items={[
          { key: "outline", label: "大綱" },
          { key: "board", label: "看板" },
        ]}
      />
      {value === "board" && (
        <span className="mgr">
          <button type="button" className="ns-bd-fchip m-bd-group" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
            <span className="lb">分欄</span>
            <b>{BOARD_GROUP_LABEL[group]}</b>
            <IconChevron open size={12} className="chev" />
          </button>
        </span>
      )}
      {open && (
        <MSheet list title="分欄" onClose={() => setOpen(false)}>
          {GROUPS.map((g) => (
            <MSheetItem
              key={g}
              onClick={() => {
                setOpen(false);
                useBoardStore.getState().setBoardGroup(g);
                // 換分欄＝多選的語意換了（選的是這幾欄的卡），清掉
                if (useSelectionStore.getState().scope === "board") useSelectionStore.getState().clear();
              }}
            >
              {BOARD_GROUP_LABEL[g]}
              {g === group && <span className="m-tks-aside m-bd-check">✓</span>}
            </MSheetItem>
          ))}
        </MSheet>
      )}
    </div>
  );
}

export interface MobileRouteBoardProps {
  board: ReturnType<typeof useRouteBoard>;
  group: BoardGroup;
  routeId: string;
  tree: TreeIndex;
  zoom: NodeRow | null;
  parked: boolean;
  today: string;
  /** 跳到某一欄（建好車票後）；seq 換＝跳 */
  jumpTo: { key: string; seq: number };
  /** 目前看到哪一欄（頁底建票列跟著它） */
  onColumn(key: string): void;
  /** 依車站但這條路線還沒有車站：開路線詳情（車站在那裡加） */
  openRouteDetail(): void;
}

export function MobileRouteBoard({ board, group, routeId, tree, zoom, parked, today, jumpTo, onColumn, openRouteDetail }: MobileRouteBoardProps) {
  const { columns, items, order, topId, topKind, doneCount } = board;
  const occurrences = useNodeStore((s) => s.currentOccurrences);
  const hideDone = useUiStore((s) => s.hideDone);
  const toggleHideDone = useUiStore((s) => s.toggleHideDone);
  const picked = useScopeSelection("board");
  const selecting = picked.length > 0;
  const [sheetId, setSheetId] = useState<string | null>(null);
  const [freshId, setFreshId] = useState<string | null>(null);
  const closeSheet = () => setSheetId(null);
  useBackLayer(SHEET_LAYER, sheetId !== null, closeSheet);

  usePruneSelection("board", order);
  // 車庫裡的路線唯讀（契約 §1）：長按、選單都進不了多選
  useSelectable("board", () => !parked);
  const zoomId = zoom?.id ?? null;
  // 換路線、換聚焦不跨
  useEffect(() => {
    const s = useSelectionStore.getState();
    if (s.scope === "board") s.clear();
  }, [routeId, zoomId]);
  // ⋯ 開著的那張不見了（刪了、搬走、同步收到刪除）：收掉
  useEffect(() => {
    if (sheetId && !tree.byId[sheetId]) setSheetId(null);
  }, [sheetId, tree]);

  // 跳轉落點（boardReveal）：跳到那一欄、捲到那張、亮一下
  const reveal = useBoardStore((s) => s.cardReveal);
  const [revealId, setRevealId] = useState<string | null>(null);
  useEffect(() => {
    if (!reveal || !order.includes(reveal.id)) return;
    useBoardStore.getState().consumeCardReveal();
    setRevealId(reveal.id);
    const t = window.setTimeout(() => setRevealId(null), REVEAL_MS);
    return () => window.clearTimeout(t);
  }, [reveal, order]);

  const flashFresh = (id: string) => {
    setFreshId(id);
    window.setTimeout(() => setFreshId((cur) => (cur === id ? null : cur)), 800);
  };
  const stamp = (n: NodeRow) => void stampCard(n).then((stamped) => stamped && flashFresh(n.id));

  const resolve = (ids: readonly string[], place: DropPlace) => {
    if (place.kind === "target") {
      if (place.type !== DOCK_TYPE) return "這裡放不下";
      return group === "train" ? trainDropVerdict({ id: topId, kind: topKind }, ids, place.target, null, null) : true;
    }
    if (group !== "train") return true;
    return trainDropVerdict({ id: topId, kind: topKind }, ids, place.col ?? TOP_COL, place.after, place.before);
  };

  const renderCard = (card: BoardCardModel<NodeRow>) => {
    const n = card.node;
    const path = card.crumb.length ? card.crumb.join(" › ") : n.parent_id === null ? "臨時車票" : null;
    const isPicked = picked.includes(n.id);
    return (
      <BoardCard
        key={n.id}
        node={n}
        today={today}
        occurrence={occurrences[n.id]}
        // 依列車的路徑就是欄與小標
        path={group === "train" ? null : path}
        showStatus={group !== "status"}
        selected={revealId === n.id}
        picked={isPicked}
        fresh={freshId === n.id}
        stampWhy={parked ? PARKED_ADD_WHY : undefined}
        leading={selecting ? <SelectCheck picked={isPicked} /> : undefined}
        onStamp={stamp}
        menu={() => []}
        onOpen={(node) => {
          if (!tapSelect("board", node.id, order)) useMobileDetailStore.getState().open(node.id);
        }}
        onMore={(node) => setSheetId(node.id)}
      />
    );
  };

  const noStations = group === "station" && columns.length === 1;
  const sheetNode = sheetId ? tree.byId[sheetId] : undefined;

  return (
    <div id={ROUTE_LAYOUT_PANEL.board} role="tabpanel" className={"m-bd-wrap" + (selecting ? " is-selecting" : "")} aria-label={`看板・${BOARD_GROUP_LABEL[group]}`}>
      <MobileBoardColumns
        columns={columns}
        items={items}
        train={group === "train"}
        memoryKey={`${routeId}:${zoomId ?? ""}:${group}`}
        renderCard={renderCard}
        renderColTop={(c) =>
          c.status === "done" && !c.shut && doneCount > 0 ? <DoneToggleChip className="m-bd-donetop" count={doneCount} showing onToggle={toggleHideDone} /> : null
        }
        emptyText={parked ? "沒有車票" : "拖到這裡"}
        onOpenDone={() => {
          if (hideDone) toggleHideDone();
        }}
        chipsEnd={group !== "status" && doneCount > 0 ? <DoneToggleChip count={doneCount} showing={!hideDone} onToggle={toggleHideDone} /> : null}
        note={
          noStations ? (
            <div className="m-bd-nostation">
              <p>這條路線還沒有車站。</p>
              <button type="button" className="ns-btn btn-ghost" onClick={openRouteDetail}>
                到路線詳情加車站
              </button>
            </div>
          ) : null
        }
        jumpTo={jumpTo}
        revealId={revealId}
        onColumn={onColumn}
        canDrag={() => (parked ? PARKED_DRAG_WHY : true)}
        onRefuse={(_id, why) => useUiStore.getState().showToast({ message: why }, 3600)}
        dragIds={(id) => batchDragIds("board", id, order)}
        resolve={resolve}
        onDrop={(ids, place) => {
          const ctx = { group, columns, tree: useNodeStore.getState().tree, routeId, topId, onStamped: flashFresh };
          if (place.kind === "target") moveBoardCards(ctx, ids, place.target);
          else moveBoardCards(ctx, ids, place.col ?? TOP_COL, { after: place.after, before: place.before });
        }}
        onPressRelease={(id) => {
          if (parked) useUiStore.getState().showToast({ message: PARKED_DRAG_WHY }, 3600);
          else pressSelect("board", id, order);
        }}
      />
      {sheetNode && <MobileBoardCardSheet node={sheetNode} today={today} parked={parked} order={order} backId={SHEET_LAYER} onClose={closeSheet} />}
    </div>
  );
}

/** 欄 → 建票列的預設（聚焦時掛到聚焦那一節；依列車＝那一欄的節點；同桌機 RouteBoard） */
function destOf(c: BoardColumnModel | undefined, routeId: string, zoom: NodeRow | null): QuickDest {
  const n = c?.holder ?? zoom;
  if (n && (n.kind === "branch" || n.kind === "train" || n.kind === "car")) return { routeId, nodeId: n.id, nodeKind: n.kind };
  return { routeId, nodeId: null, nodeKind: "route" };
}

/** 頁底建票列（殼的直接子節點，同大綱那一條）：跟著目前那一欄 */
export function MobileBoardAdd({ column, routeId, zoom, onCreated }: { column: BoardColumnModel | undefined; routeId: string; zoom: NodeRow | null; onCreated(row: NodeRow): void }) {
  const zoomId = zoom?.id ?? null;
  const stationId = column?.station?.id ?? null;
  const stationRef = useRef(stationId);
  stationRef.current = stationId;
  const defaults = useMemo<QuickDefaults>(
    () => ({ dest: destOf(column, routeId, zoom), scheduledOn: null }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [column?.key, routeId, zoomId],
  );
  const here = useMemo<QuickHere>(() => ({ kind: "route", routeId }), [routeId]);
  return (
    <MobileQuickAdd
      defaults={defaults}
      here={here}
      routeKind="ticket"
      placeholder={column?.station ? `新增車票到「${column.station.name}」…` : "新增車票…"}
      onCreated={(row) => {
        if (stationRef.current) void useNodeStore.getState().updateNode(row.id, { station_id: stationRef.current });
        onCreated(row);
      }}
    />
  );
}
