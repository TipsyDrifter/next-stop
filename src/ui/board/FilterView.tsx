/**
 * FilterView——桌機篩選清單（⑫；契約 docs/research/2026-11-06-⑫看板與篩選-契約.md §2、§3；視覺真相 prototypes/看板與篩選-⑫.html 04、x04）。
 * 路線一覽的「篩選」分頁：條件 chip 一列、常用篩選一排、結果數＋版面（清單｜看板）＋排序，下面是結果。
 *
 * 結果跨路線：検印走 boardActions、⋯ 走 boardMenu（行程表那組跨路線動作），不碰只認目前路線樹的 completeNodeFlow。
 * 點列開側板：DetailPanel 查不到切片就問 repository，不在目前樹裡的票一樣開得起來（行程表、完整搜尋同一條路）。
 * 看板版面＝跨路線依狀態四欄：只能換欄（moveCardsToStatus），狀態 chip 停用；依列車、依車站只在單條路線有意義，不給。
 * 済欄走「済 N・隱藏／顯示」（跟大綱同一個開關），收起來是窄條、仍可當落點；打開最多畫 100 張（欄在 useTaskFilter）。
 * 條件與常用篩選都在 boardStore；常用 chip 可拖曳排序（整顆 chip 就是一欄，放到哪顆上＝排到那顆的位置），⋯ 有往前、往後。
 * 蓋済的那一列在原地停一下才離開（useStampLinger）。車庫裡的票唯讀：不能蓋章、換欄，也進不了多選。
 * 指到已刪路線、荷札的條件：chip 淡掉，選單裡列出來可以拿掉；存檔不改寫（復原路線就回來）。
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { NodeRow } from "../../domain";
import { STATUS_COLUMN_LABEL, cardStatus, type BoardCard as BoardCardModel, type BoardStatus } from "../../domain/board";
import { PARKED_ADD_WHY } from "../../domain/depot";
import {
  DUE_LABEL,
  STATUS_COND_LABEL,
  TASK_SORT_LABEL,
  TEMP_ROUTE,
  isTaskDone,
  isTaskLate,
  type DueCond,
  type TaskSort,
  type TaskStatusCond,
} from "../../domain/taskFilter";
import { hasFilterConditions, useBoardStore } from "../../store/boardStore";
import { useNodeStore } from "../../store/nodeStore";
import { useSelectionStore } from "../../store/selectionStore";
import { useUiStore } from "../../store/uiStore";
import { useOutsideDismiss, placeBelow } from "../common/anchorPop";
import { rowContextMenu } from "../common/contextMenu";
import { useDragReorder, type DropPlace } from "../common/dragReorder";
import { IconChevron, IconClose, IconDots, IconEdit } from "../common/icons";
import { OverlineText } from "../common/PageHeader";
import { PopMenu, type PopMenuItem } from "../common/PopMenu";
import { PriorityMark } from "../common/PriorityMark";
import { DoneToggleChip } from "../common/quickadd";
import { dragBatch, pickClick } from "../common/selection/desktopSelection";
import { armOpenOnClick } from "../common/selection/openOnClick";
import { SelectionBar } from "../common/selection/SelectionBar";
import { useSelectable } from "../common/selection/useSelectable";
import { Tabs } from "../common/Tabs";
import { SealSuspended } from "../stamps";
import { BoardCard, cardMeta } from "./BoardCard";
import { BoardColumns } from "./BoardColumns";
import { moveCardsToStatus } from "./boardActions";
import { boardCardMenu, cardOverline } from "./boardMenu";
import { OVERVIEW_PANEL } from "./RouteViewTabs";
import { useBoardKeyboard } from "./useBoardKeyboard";
import { useCardDefer } from "./useCardDefer";
import { useStampLinger } from "./useStampLinger";
import { useTaskFilter, type FilterOption, type FilterRow, type TaskRow } from "./useTaskFilter";

type ChipKey = "routes" | "tags" | "due" | "status";

const PARKED_DRAG_WHY = "這條路線已收進車庫——要改先回到運行";
/** 清單｜看板的分頁內容 id */
const LAYOUT_PANEL = { list: "ns-filter-panel-list", board: "ns-filter-panel-board" } as const;

/* ───────── 條件 chip ───────── */

function Chip({
  label,
  value,
  on,
  dead,
  open,
  disabled,
  title,
  onOpen,
  onClear,
}: {
  label: string;
  value?: string;
  on?: boolean;
  dead?: boolean;
  open?: boolean;
  disabled?: boolean;
  title?: string;
  onOpen(el: HTMLButtonElement): void;
  onClear?(): void;
}) {
  return (
    <button
      type="button"
      data-pop-toggle
      className={"ns-bd-fchip" + (on ? " is-on" : "") + (dead ? " is-dead" : "")}
      disabled={disabled}
      title={title}
      aria-haspopup="menu"
      aria-expanded={!!open}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => onOpen(e.currentTarget)}
    >
      <span className="lb">{label}</span>
      {value && <b>{value}</b>}
      {onClear ? (
        <span
          className="x"
          role="button"
          aria-label={`清除${label}`}
          onClick={(e) => {
            e.stopPropagation();
            onClear();
          }}
        >
          <IconClose size={11} />
        </span>
      ) : (
        !disabled && <IconChevron open size={12} className="chev" />
      )}
    </button>
  );
}

function Toggle({ label, on, onToggle }: { label: string; on: boolean; onToggle(v: boolean): void }) {
  return (
    <button
      type="button"
      className={"ns-bd-fchip is-toggle" + (on ? " is-on" : "")}
      aria-pressed={on}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onToggle(!on)}
    >
      {on ? <b>{label}</b> : <span className="lb">{label}</span>}
      {on && (
        <span className="x" aria-hidden>
          <IconClose size={11} />
        </span>
      )}
    </button>
  );
}

/** 複選的條件選單：長相同 PopMenu，但勾了不收（路線、荷札要連勾幾個） */
function CheckMenu({ anchor, label, options, picked, onToggle, onClose }: { anchor: HTMLElement | null; label: string; options: readonly FilterOption[]; picked: readonly string[]; onToggle(v: string): void; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useOutsideDismiss(ref, onClose, anchor);
  useLayoutEffect(() => {
    if (ref.current && anchor) setPos(placeBelow(anchor, ref.current));
  }, [anchor, options.length]);
  const focused = useRef(false);
  useEffect(() => {
    if (!pos || focused.current) return;
    focused.current = true;
    ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [pos]);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing || e.ctrlKey || e.metaKey) return;
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      anchor?.focus({ preventScroll: true });
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const btns = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    btns[(i + (e.key === "ArrowDown" ? 1 : -1) + btns.length) % btns.length]?.focus();
  };
  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      className="ns-popmenu ns-bd-checkmenu techo-card"
      style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? "visible" : "hidden" }}
      onKeyDown={onKeyDown}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <ul className="ns-popmenu-list" role="none">
        {options.length === 0 && <li className="ns-bd-checkempty">沒有可選的</li>}
        {options.map((o) => {
          const on = picked.includes(o.value);
          return (
            <li key={o.value} role="none">
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={on}
                className={"ns-popmenu-item" + (on ? " is-on" : "")}
                style={o.depth ? { paddingLeft: 14 + o.depth * 14 } : undefined}
                onClick={() => onToggle(o.value)}
              >
                <span>{o.label}</span>
                <kbd className="caps">{on ? "✓" : o.count}</kbd>
              </button>
            </li>
          );
        })}
      </ul>
    </div>,
    document.body,
  );
}

/* ───────── 常用篩選的名字（存、改名共用） ───────── */

function NamePop({ anchor, initial, submit, onSave, onClose }: { anchor: HTMLElement | null; initial: string; submit: string; onSave(name: string): void; onClose(): void }) {
  const ref = useRef<HTMLFormElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [v, setV] = useState(initial);
  useOutsideDismiss(ref, onClose, anchor);
  useLayoutEffect(() => {
    if (ref.current && anchor) {
      const p = placeBelow(anchor, ref.current);
      if (p) setPos({ top: p.top, left: Math.max(12, Math.min(anchor.getBoundingClientRect().right - ref.current.offsetWidth, p.left)) });
    }
  }, [anchor]);
  useEffect(() => {
    if (!pos) return;
    input.current?.focus();
    input.current?.select();
  }, [pos === null]); // eslint-disable-line react-hooks/exhaustive-deps
  return createPortal(
    <form
      ref={ref}
      className="ns-bd-namepop techo-card"
      style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? "visible" : "hidden" }}
      onSubmit={(e) => {
        e.preventDefault();
        if (v.trim()) onSave(v);
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <p className="techo-overline">
        <OverlineText value={{ zh: "常用篩選", latin: "Saved filter" }} />
      </p>
      <div className="row">
        <input ref={input} className="techo-input" value={v} placeholder="名稱" aria-label="名稱" onChange={(e) => setV(e.target.value)} />
        <button type="submit" className="ns-btn btn-seal ns-btn--sm" disabled={!v.trim()}>
          {submit}
        </button>
      </div>
    </form>,
    document.body,
  );
}

/* ───────── 常用 chip 一排 ───────── */

/** 給 ResultRow 的動作：物件不換（內容讀最新的），列才不會因為它重畫 */
interface RowHandlers {
  press(n: NodeRow, e: MouseEvent<HTMLElement>): void;
  stamp(n: TaskRow): void;
  menu(n: TaskRow): PopMenuItem[];
  focusBack(): void;
}

function SavedRow({ onRename }: { onRename(id: string, name: string, anchor: HTMLElement): void }) {
  const saved = useBoardStore((s) => s.saved);
  const active = useBoardStore((s) => s.activeSavedId);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [menu, setMenu] = useState<{ id: string; anchor: HTMLElement } | null>(null);
  const items = useMemo(() => saved.map((s) => ({ id: s.id })), [saved]);
  const store = () => useBoardStore.getState();

  useDragReorder({
    root,
    items,
    columns: { lines: false },
    resolve: (_ids, p: DropPlace) => (p.kind === "slot" ? true : "這裡放不下"),
    onDrop: (ids, p) => {
      if (p.kind !== "slot" || !p.col) return;
      const order = store().saved.map((s) => s.id);
      const from = order.indexOf(ids[0]);
      const to = order.indexOf(p.col);
      if (from < 0 || to < 0 || from === to) return;
      order.splice(from, 1);
      order.splice(to, 0, ids[0]);
      void store().reorderSaved(order);
    },
  });

  const menuItems = (id: string, name: string, anchor: HTMLElement): PopMenuItem[] => {
    const at = saved.findIndex((s) => s.id === id);
    /** 同手機：可點的替代（拖曳不能是唯一入口） */
    const step = (delta: -1 | 1) => {
      const list = saved.map((s) => s.id);
      list.splice(at, 1);
      list.splice(at + delta, 0, id);
      void store().reorderSaved(list);
    };
    return [
      { key: "rename", label: "改名…", onSelect: () => onRename(id, name, anchor) },
      {
        key: "update",
        label: "用目前的條件更新",
        onSelect: () =>
          void store()
            .updateSaved(id)
            .then((ok) => {
              if (ok) useUiStore.getState().showToast({ message: "已更新條件" }, 2600);
            }),
      },
      ...(saved.length > 1
        ? [
            { key: "front", label: "往前", disabled: at === 0, why: "已經在最前面", onSelect: () => step(-1) },
            { key: "back", label: "往後", disabled: at === saved.length - 1, why: "已經在最後面", onSelect: () => step(1) },
          ]
        : []),
      { key: "del", label: "刪除", cut: true, danger: true, onSelect: () => void store().removeSaved(id) },
    ];
  };

  if (!saved.length) return null;
  return (
    <div className="ns-bd-presets">
      <span className="plabel">常用</span>
      <div ref={setRoot} className="ns-bd-presetlist">
        {saved.map((s) => (
          <div
            key={s.id}
            className={"ns-bd-qchip" + (active === s.id ? " is-on" : "")}
            data-drag-id={s.id}
            data-drag-col={s.id}
            onContextMenu={(e) => {
              // 「改名…」的小卡要錨在這顆 chip 上
              const chip = e.currentTarget;
              rowContextMenu(() => ({ overline: { zh: "常用篩選", latin: "Saved" }, label: `「${s.name}」的動作`, items: menuItems(s.id, s.name, chip) }))(e);
            }}
          >
            <span
              role="button"
              tabIndex={0}
              className="name"
              aria-pressed={active === s.id}
              onClick={() => store().applySaved(s.id)}
              onDoubleClick={(e) => {
                e.preventDefault();
                const chip = e.currentTarget.closest<HTMLElement>(".ns-bd-qchip") ?? e.currentTarget;
                onRename(s.id, s.name, chip);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  store().applySaved(s.id);
                }
              }}
            >
              {s.name}
            </span>
            <button
              type="button"
              className="more"
              aria-label={`改名：${s.name}`}
              title="改名（或雙擊）"
              onClick={(e) => {
                const chip = e.currentTarget.closest<HTMLElement>(".ns-bd-qchip") ?? e.currentTarget;
                onRename(s.id, s.name, chip);
              }}
            >
              <IconEdit size={11} />
            </button>
            <button
              type="button"
              className="more is-danger"
              aria-label={`刪除：${s.name}`}
              title="刪除篩選"
              onClick={() => void store().removeSaved(s.id)}
            >
              <IconClose size={11} />
            </button>
            <button
              type="button"
              className="more"
              aria-haspopup="menu"
              aria-label={`「${s.name}」的更多動作`}
              title="更新、排序"
              onClick={(e) => setMenu({ id: s.id, anchor: e.currentTarget })}
            >
              <IconDots size={12} />
            </button>
          </div>
        ))}
      </div>
      {menu && (
        <PopMenu
          anchor={menu.anchor}
          overline={{ zh: "常用篩選", latin: "Saved" }}
          label="常用篩選的動作"
          items={menuItems(menu.id, saved.find((s) => s.id === menu.id)?.name ?? "", menu.anchor.closest<HTMLElement>(".ns-bd-qchip") ?? menu.anchor)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

/* ───────── 清單版面的一列（票形＋路線圓牌；.ticket 同大綱） ───────── */

const ResultRow = memo(function ResultRow({ row, today, selected, picked, fresh, parked, on }: { row: FilterRow; today: string; selected: boolean; picked: boolean; fresh: boolean; parked: boolean; on: RowHandlers }) {
  const { node, route, crumb, tags } = row;
  const occ = useNodeStore((s) => s.currentOccurrences[node.id]);
  const m = cardMeta(node, occ, today);
  const status = cardStatus(node, occ);
  const late = isTaskLate(node, occ, today);
  const done = isTaskDone(node, occ);
  const btn = useRef<HTMLButtonElement>(null);
  const [items, setItems] = useState<PopMenuItem[] | null>(null);
  return (
    <li
      className="ticket-li"
      data-node-id={node.id}
      onMouseDown={(e) => on.press(node, e)}
      onContextMenu={rowContextMenu(() => ({ overline: cardOverline(node), label: `「${node.name}」的動作`, items: on.menu(node), before: () => useUiStore.getState().select(node.id) }))}
    >
      <article className={"ticket" + (late ? " late-t" : "") + (selected ? " selected" : "") + (picked ? " is-picked" : "") + (done ? " done" : "") + (m.skipped ? " is-suspended" : "") + (fresh ? " fresh" : "")}>
        <div className="stub" style={{ color: route?.color ?? "var(--route-none)" }}>
          <span aria-hidden className={route ? "badge" : "badge dashed"}>
            {route ? (route.code ?? route.name.slice(0, 1)) : "臨"}
          </span>
          <span className="line-name">{route?.name ?? "臨時車票"}</span>
        </div>
        <div className="body">
          {m.teiki && <span className="fare-class teiki">定期券</span>}
          <p className="title">
            <PriorityMark priority={node.priority} />
            {node.name}
          </p>
          <div className="meta">
            {crumb.length > 0 && <span className="ns-bd-crumb">{crumb.join(" › ")}</span>}
            {(status === "doing" || status === "paused") && <span className="chip is-st">{STATUS_COLUMN_LABEL[status]}</span>}
            {m.next && <span className="chip next">{m.next}</span>}
            {m.run && <span className={"chip" + (m.run.late ? " late" : "")}>{m.run.text}</span>}
            {m.due && <span className={"chip" + (m.due.late ? " late" : "")}>{m.due.text}</span>}
            {tags.map((t) => (
              <span key={t} className="ns-bd-tag">
                #{t}
              </span>
            ))}
          </div>
        </div>
        {late && <span className="late-seal">延着</span>}
        <div className="stamp-zone">
          <button
            type="button"
            tabIndex={-1}
            className="stamp"
            disabled={parked}
            aria-pressed={done}
            aria-label={m.skipped ? "取消本班運休" : done ? "取消完成" : "蓋章完成"}
            title={parked ? PARKED_ADD_WHY : undefined}
            onClick={(e) => {
              e.stopPropagation();
              on.stamp(node);
            }}
          >
            <span className="hint" aria-hidden>
              検印
            </span>
            <span className="seal" aria-hidden>
              済
            </span>
          </button>
          {m.skipped && (
            <span className="stopover-slot">
              <SealSuspended title="運休（本班暫停）" />
            </span>
          )}
        </div>
        <button
          ref={btn}
          type="button"
          tabIndex={-1}
          className="row-more"
          aria-haspopup="menu"
          aria-expanded={items !== null}
          aria-label={`「${node.name}」的更多動作`}
          title="更多動作"
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation();
            setItems((cur) => (cur ? null : on.menu(node)));
          }}
        >
          <IconDots size={14} />
        </button>
        {items && (
          <span onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
            <PopMenu
              anchor={btn.current}
              overline={cardOverline(node)}
              label={`「${node.name}」的動作`}
              items={items}
              onClose={() => setItems(null)}
              returnFocus={() => {
                on.focusBack();
                return null;
              }}
            />
          </span>
        )}
      </article>
    </li>
  );
});

/* ───────── 頁 ───────── */

export function FilterView() {
  const { rows, columns, order, doneCount, boardLayout, deadRoutes, deadTags, options, today, tagName } = useTaskFilter();
  const filter = useBoardStore((s) => s.filter);
  const sort = useBoardStore((s) => s.sort);
  const layout = useBoardStore((s) => s.layout);
  const activeSavedId = useBoardStore((s) => s.activeSavedId);
  const loading = useBoardStore((s) => s.loading);
  const taskCount = useBoardStore((s) => s.tasks.length);
  const routes = useNodeStore((s) => s.routes);
  const occurrences = useNodeStore((s) => s.currentOccurrences);
  const selectedId = useUiStore((s) => s.selectedId);
  const hideDone = useUiStore((s) => s.hideDone);
  const picked = useSelectionStore((s) => (s.scope === "board" ? s.ids : null));
  const store = () => useBoardStore.getState();

  const rootRef = useRef<HTMLDivElement>(null);
  const focusBack = useCallback(() => rootRef.current?.focus({ preventScroll: true }), []);
  const [pop, setPop] = useState<{ k: ChipKey | "sort"; anchor: HTMLElement } | null>(null);
  const [namePop, setNamePop] = useState<{ anchor: HTMLElement; id: string | null; initial: string } | null>(null);
  const [boardRoot, setBoardRoot] = useState<HTMLDivElement | null>(null);
  const defer = useCardDefer();
  const { shown, stamp: stampRow, flash, freshId } = useStampLinger(rows, !boardLayout);

  const rowById = useMemo(() => new Map(shown.map((r) => [r.node.id, r])), [shown]);
  // 車庫裡的票不進多選（跨路線：只濾掉那幾張）；判準在 selectionStore 那一關
  useSelectable("board", (id) => !rowById.get(id)?.route?.arrived_on);
  useEffect(() => useSelectionStore.getState().prune("board", order), [order]);
  useEffect(() => void (useSelectionStore.getState().scope === "board" && useSelectionStore.getState().clear()), [layout]);

  const parkedOf = (n: NodeRow) => !!rowById.get(n.id)?.route?.arrived_on;
  const stamp = (n: TaskRow) => {
    if (!parkedOf(n)) stampRow(n);
  };
  const menuOf = (n: TaskRow) => boardCardMenu(n, { today, parked: parkedOf(n), order, openDefer: defer.open });
  const onPress = (node: NodeRow, e: MouseEvent<HTMLElement>) => {
    e.preventDefault();
    const ui = useUiStore.getState();
    if (pickClick("board", node.id, order, e, ui.selectedId)) {
      focusBack();
      return;
    }
    armOpenOnClick(e, () => {
      if (useUiStore.getState().selectedId === node.id) useUiStore.getState().setPanelOpen(true);
    });
    ui.select(node.id);
    focusBack();
  };

  const latest = useRef({ onPress, stamp, menuOf });
  latest.current = { onPress, stamp, menuOf };
  const handlers = useMemo<RowHandlers>(
    () => ({
      press: (n, e) => latest.current.onPress(n, e),
      stamp: (n) => latest.current.stamp(n),
      menu: (n) => latest.current.menuOf(n),
      focusBack,
    }),
    [focusBack],
  );

  /* 看板版面（欄在 useTaskFilter） */
  const items = useMemo(() => columns.flatMap((c) => c.rows.map((r) => ({ id: r.type === "card" ? r.card.node.id : r.id }))), [columns]);

  useDragReorder({
    root: boardRoot,
    items,
    columns: { lines: false },
    disabled: !boardLayout,
    canDrag: (id) => (rowById.get(id)?.route?.arrived_on ? PARKED_DRAG_WHY : true),
    onRefuse: (_id, why) => useUiStore.getState().showToast({ message: why }, 3600),
    dragIds: (id) => dragBatch("board", id, order, (x) => !rowById.get(x)?.route?.arrived_on),
    resolve: (_ids, p: DropPlace) => (p.kind === "slot" ? true : "這裡放不下"),
    onDrop: (ids, p) => {
      if (p.kind !== "slot" || !p.col) return;
      const nodes = ids.flatMap((id) => rowById.get(id)?.node ?? []);
      if (p.col === "done" && nodes.length === 1) flash(nodes[0].id);
      void moveCardsToStatus(nodes, p.col as BoardStatus);
    },
  });

  const keyColumns = useMemo(
    () =>
      boardLayout
        ? columns.map((c) => ({ key: c.key, ids: c.rows.flatMap((r) => (r.type === "card" ? [r.card.node.id] : [])) }))
        : [{ key: "list", ids: order }],
    [boardLayout, columns, order],
  );
  const keys = useBoardKeyboard({
    columns: keyColumns,
    order,
    node: (id) => rowById.get(id)?.node,
    stamp,
    shift: (ids, col) => {
      if (!boardLayout) return;
      const nodes = ids.flatMap((id) => rowById.get(id)?.node ?? []).filter((n) => !parkedOf(n));
      if (!nodes.length) useUiStore.getState().showToast({ message: PARKED_DRAG_WHY }, 3600);
      else void moveCardsToStatus(nodes, col.key as BoardStatus);
    },
    escape: () => {
      const ui = useUiStore.getState();
      if (ui.panelOpen) ui.setPanelOpen(false);
    },
  });

  const renderCard = (card: BoardCardModel<NodeRow>) => {
    const n = card.node;
    const r = rowById.get(n.id);
    return (
      <BoardCard
        key={n.id}
        node={n}
        today={today}
        occurrence={occurrences[n.id]}
        route={r?.route ?? null}
        path={card.crumb.length ? card.crumb.join(" › ") : null}
        selected={selectedId === n.id}
        picked={!!picked?.includes(n.id)}
        fresh={freshId === n.id}
        stampWhy={r?.route?.arrived_on ? PARKED_ADD_WHY : undefined}
        onStamp={stamp}
        menu={() => menuOf(n)}
        onPress={onPress}
        returnFocus={focusBack}
      />
    );
  };

  /* chip 的字 */
  const routeName = (id: string) => (id === TEMP_ROUTE ? "臨時車票" : (routes.find((r) => r.id === id)?.name ?? "已刪除的路線"));
  const many = (list: readonly string[], name: (v: string) => string) => (list.length ? name(list[0]) + (list.length > 1 ? ` +${list.length - 1}` : "") : undefined);
  const toggleIn = (list: readonly string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const openChip = (k: ChipKey | "sort") => (anchor: HTMLElement) => setPop((cur) => (cur?.k === k ? null : { k, anchor }));

  const hasCond = hasFilterConditions(filter);
  const canSave = hasCond && !activeSavedId;
  const guessName = () => {
    const parts = [many(filter.tags, (k) => `#${tagName(k)}`), many(filter.routes, routeName), filter.due && `締切${DUE_LABEL[filter.due]}`, filter.late && "誤點", filter.high && "高優先"].filter(Boolean);
    return parts.slice(0, 2).join("・");
  };

  let body: ReactNode;
  if (loading && !taskCount) body = null;
  else if (boardLayout)
    body = (
      <div className="ns-bd is-cross" aria-label="看板・依狀態">
        <BoardColumns columns={columns} rootRef={setBoardRoot} renderCard={renderCard} emptyText="拖到這裡" onOpenDone={() => useUiStore.getState().toggleHideDone()} />
      </div>
    );
  else if (!shown.length)
    body = (
      <p className="ns-bd-fempty">
        {hasCond ? "沒有符合的車票" : "沒有未済的車票"}
        {hasCond && (
          <button type="button" className="ns-btn btn-text ns-btn--sm" onClick={() => store().clearFilter()}>
            清除條件
          </button>
        )}
      </p>
    );
  else
    body = (
      <div className="ns-rm-read">
        <ul className="ticket-list ns-bd-results">
          {shown.map((r) => (
            <ResultRow
              key={r.node.id}
              row={r}
              today={today}
              selected={selectedId === r.node.id}
              picked={!!picked?.includes(r.node.id)}
              fresh={freshId === r.node.id}
              parked={!!r.route?.arrived_on}
              on={handlers}
            />
          ))}
        </ul>
      </div>
    );

  return (
    <div ref={rootRef} id={OVERVIEW_PANEL.filter} role="tabpanel" tabIndex={0} className="ns-bd-filter" onKeyDown={keys} aria-label="篩選清單">
      <div className="ns-bd-fbar">
        <Chip
          label="路線"
          value={many(filter.routes, routeName)}
          on={filter.routes.length > 0}
          dead={filter.routes.length > 0 && deadRoutes.length === filter.routes.length}
          title={deadRoutes.length ? "有條件指到已刪除的路線，那一條不算（復原路線就回來）" : undefined}
          open={pop?.k === "routes"}
          onOpen={openChip("routes")}
          onClear={filter.routes.length ? () => store().setFilter({ routes: [] }) : undefined}
        />
        <Chip
          label="荷札"
          value={many(filter.tags, (k) => `#${tagName(k)}`)}
          on={filter.tags.length > 0}
          dead={filter.tags.length > 0 && deadTags.length === filter.tags.length}
          title={deadTags.length ? "有條件指到已刪除的荷札，那一個不算" : undefined}
          open={pop?.k === "tags"}
          onOpen={openChip("tags")}
          onClear={filter.tags.length ? () => store().setFilter({ tags: [] }) : undefined}
        />
        <Chip
          label="締切"
          value={filter.due ? DUE_LABEL[filter.due] : undefined}
          on={!!filter.due}
          open={pop?.k === "due"}
          onOpen={openChip("due")}
          onClear={filter.due ? () => store().setFilter({ due: null }) : undefined}
        />
        <Chip
          label="狀態"
          value={boardLayout ? undefined : STATUS_COND_LABEL[filter.status]}
          on={!boardLayout && filter.status !== "open"}
          disabled={boardLayout}
          title={boardLayout ? "看板的四欄就是狀態" : undefined}
          open={pop?.k === "status"}
          onOpen={openChip("status")}
        />
        <Toggle label="誤點" on={filter.late} onToggle={(late) => store().setFilter({ late })} />
        <Toggle label="優先 高" on={filter.high} onToggle={(high) => store().setFilter({ high })} />
        <span className="sp" />
        <button type="button" className="ns-btn btn-text ns-btn--sm" disabled={!hasCond} onClick={() => store().clearFilter()}>
          清除
        </button>
        <button
          type="button"
          className="ns-btn btn-ghost ns-btn--sm"
          disabled={!canSave}
          title={activeSavedId ? "這組條件已經存過了" : hasCond ? undefined : "先選條件才能存"}
          onClick={(e) => setNamePop({ anchor: e.currentTarget, id: null, initial: guessName() })}
        >
          存成常用…
        </button>
      </div>

      <SavedRow onRename={(id, name, anchor) => setNamePop({ anchor, id, initial: name })} />

      <div className="ns-bd-fres">
        <span className="cnt">
          <b>{rows.length}</b>張
        </span>
        <span className="sp" />
        {boardLayout && doneCount > 0 && <DoneToggleChip count={doneCount} showing={!hideDone} onToggle={() => useUiStore.getState().toggleHideDone()} />}
        <Tabs<"list" | "board">
          size="md"
          aria-label="結果的版面"
          value={layout}
          onChange={(v) => store().setLayout(v)}
          getPanelId={(k) => LAYOUT_PANEL[k]}
          items={[
            { key: "list", label: "清單" },
            { key: "board", label: "看板" },
          ]}
        />
        <button
          type="button"
          className="ns-bd-fchip"
          aria-haspopup="menu"
          aria-expanded={pop?.k === "sort"}
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => openChip("sort")(e.currentTarget)}
        >
          <span className="lb">排序</span>
          <b>{TASK_SORT_LABEL[sort]}</b>
          <IconChevron open size={12} className="chev" />
        </button>
      </div>

      <div id={LAYOUT_PANEL[layout]} role="tabpanel" aria-label={layout === "board" ? "看板" : "清單"} style={{ display: "contents" }}>
        {body}
      </div>

      {pop?.k === "routes" && (
        <CheckMenu anchor={pop.anchor} label="路線" options={options("routes")} picked={filter.routes} onToggle={(v) => store().setFilter({ routes: toggleIn(store().filter.routes, v) })} onClose={() => setPop(null)} />
      )}
      {pop?.k === "tags" && (
        <CheckMenu anchor={pop.anchor} label="荷札" options={options("tags")} picked={filter.tags} onToggle={(v) => store().setFilter({ tags: toggleIn(store().filter.tags, v) })} onClose={() => setPop(null)} />
      )}
      {pop?.k === "due" && (
        <PopMenu
          anchor={pop.anchor}
          overline={{ zh: "締切", latin: "Due" }}
          label="締切"
          items={options("due").map((o) => ({
            key: o.value,
            label: o.label,
            caps: filter.due === o.value ? "✓" : String(o.count),
            onSelect: () => store().setFilter({ due: filter.due === o.value ? null : (o.value as DueCond) }),
          }))}
          onClose={() => setPop(null)}
        />
      )}
      {pop?.k === "status" && (
        <PopMenu
          anchor={pop.anchor}
          overline={{ zh: "狀態", latin: "Status" }}
          label="狀態"
          items={(["open", "done", "all"] as const).map((s: TaskStatusCond) => ({
            key: s,
            label: s === "open" ? `${STATUS_COND_LABEL[s]}（預設）` : STATUS_COND_LABEL[s],
            caps: filter.status === s ? "✓" : undefined,
            onSelect: () => store().setFilter({ status: s }),
          }))}
          onClose={() => setPop(null)}
        />
      )}
      {pop?.k === "sort" && (
        <PopMenu
          anchor={pop.anchor}
          overline={{ zh: "排序", latin: "Sort" }}
          label="排序"
          items={(["smart", "scheduled", "priority", "updated"] as const).map((s: TaskSort) => ({
            key: s,
            label: TASK_SORT_LABEL[s],
            caps: sort === s ? "✓" : undefined,
            onSelect: () => store().setSort(s),
          }))}
          onClose={() => setPop(null)}
        />
      )}
      {namePop && (
        <NamePop
          anchor={namePop.anchor}
          initial={namePop.initial}
          submit={namePop.id ? "改名" : "存"}
          onClose={() => setNamePop(null)}
          onSave={(name) => {
            if (namePop.id) void store().renameSaved(namePop.id, name);
            else {
              void store()
                .saveAs(name)
                .then((ok) => {
                  if (ok) useUiStore.getState().showToast({ message: "已存成常用" }, 2600);
                });
            }
            setNamePop(null);
          }}
        />
      )}
      {defer.popover}
      <SelectionBar scope="board" lookup={(id) => rowById.get(id)?.node} />
    </div>
  );
}

