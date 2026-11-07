/**
 * MobileFilterView——手機篩選清單（⑫；契約 docs/research/2026-11-06-⑫看板與篩選-契約.md §2、§3、§4；視覺真相 prototypes/看板與篩選-⑫.html 06、x06）。
 * 路線圖第一層的「篩選」分頁：條件 chip 橫捲（點了開底部面板）、常用 chip 一排、結果數＋版面＋排序、結果；條件不是預設時頁底黏「存成常用…」。
 *
 * 語意全部同桌機 FilterView：比對與選項 useTaskFilter、條件與常用 boardStore。
 * 結果跨路線：検印走 boardActions、⋯ 走 MobileBoardCardSheet（行程表那組跨路線動作），不碰只認目前路線樹的 nodeFlows。
 * 清單版面用手機票卡（MobileTicket），長按原地放開＝多選（清單照排序排，不能拖）；看板版面＝跨路線依狀態四欄，只能換欄。
 * 蓋済的那一列：結果會把它濾掉，先在原地停一下給人看到章才離開（useStampLinger，同桌機）。
 * 看板版面的済欄走「済 N・隱藏／顯示」（跟大綱同一個開關），收起來是窄條；打開最多畫 100 張（欄在 useTaskFilter）。
 * 車庫裡的票唯讀：不能蓋章、換欄，也進不了多選。
 * 常用 chip：點＝套用；長按原地放開或 ⋯＝改名、更新條件、前後移、刪除（附復原）；長按拖＝排序（同桌機）。
 * 指到已刪路線、荷札的條件：chip 淡掉，面板裡列出來可以拿掉；存檔不改寫（復原路線就回來）。
 * 這個元件回 Fragment：頁、存成常用、選取列都要當殼的直接子節點（mobile-select.css 的落點做法）。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { NodeRow } from "../../../domain";
import { cardStatus, STATUS_COLUMN_LABEL, type BoardCard as BoardCardModel, type BoardStatus } from "../../../domain/board";
import { PARKED_ADD_WHY } from "../../../domain/depot";
import { DUE_LABEL, STATUS_COND_LABEL, TASK_SORT_LABEL, TEMP_ROUTE, isTaskLate, type DueCond, type TaskSort, type TaskStatusCond } from "../../../domain/taskFilter";
import { hasFilterConditions, useBoardStore } from "../../../store/boardStore";
import { useNodeStore } from "../../../store/nodeStore";
import { useUiStore } from "../../../store/uiStore";
import { BoardCard } from "../../board/BoardCard";
import { moveCardsToStatus } from "../../board/boardActions";
import { useSavedCounts } from "../../board/useSavedCounts";
import { useStampLinger } from "../../board/useStampLinger";
import { useTaskFilter, type FilterOption, type TaskRow } from "../../board/useTaskFilter";
import { useDragReorder, type DropPlace } from "../../common/dragReorder";
import { IconChevron, IconClose, IconDots } from "../../common/icons";
import { MSheet, MSheetItem } from "../../common/MSheet";
import { DoneToggleChip } from "../../common/quickadd";
import { useSelectable } from "../../common/selection/useSelectable";
import { Tabs } from "../../common/Tabs";
import { useMinuteTick } from "../../schedule/useMinuteTick";
import { useBackLayer } from "../backStack";
import { useMobileDetailStore } from "../detail/mobileDetailStore";
import { MobileSelectionBar } from "../MobileSelectionBar";
import { SelectCheck, batchDragIds, pressSelect, tapSelect, usePruneSelection, useScopeSelection } from "../mobileSelect";
import { MobileTextSheet } from "../MobileTextSheet";
import { MobileTicket } from "../MobileTicket";
import { cardFromTreeNode } from "../routemap/routeMapActions";
import { MobileBoardCardSheet } from "./MobileBoardCardSheet";
import { DOCK_TYPE, MobileBoardColumns } from "./MobileBoardColumns";

const CARD_LAYER = "core.filterCardSheet";
const PARKED_WHY = "這條路線已收進車庫——要改先回到運行";
/** 分頁內容的 id（ARIA：Tabs 的 aria-controls ↔ 內容的 role="tabpanel"） */
export const OVERVIEW_PANEL = { routes: "m-overview-panel-routes", filter: "m-overview-panel-filter" } as const;
const LAYOUT_PANEL = { list: "m-filter-panel-list", board: "m-filter-panel-board" } as const;

type ChipKey = "routes" | "tags" | "due" | "status" | "sort";

const toast = (message: string) => useUiStore.getState().showToast({ message }, 3600);
const store = () => useBoardStore.getState();

/* ───────── 條件 chip（長相同桌機 .ns-bd-fchip，觸控區撐到 44） ───────── */

function Chip({ label, value, on, dead, off, onOpen, onClear }: { label: string; value?: string; on?: boolean; dead?: boolean; off?: string; onOpen(): void; onClear?(): void }) {
  return (
    <button
      type="button"
      className={"ns-bd-fchip m-bf-chip" + (on ? " is-on" : "") + (dead ? " is-dead" : "") + (off ? " is-off" : "")}
      aria-haspopup={off ? undefined : "dialog"}
      aria-disabled={off ? true : undefined}
      onClick={off ? () => toast(off) : onOpen}
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
        !off && <IconChevron open size={12} className="chev" />
      )}
    </button>
  );
}

function Toggle({ label, on, onToggle }: { label: string; on: boolean; onToggle(v: boolean): void }) {
  return (
    <button type="button" className={"ns-bd-fchip m-bf-chip is-toggle" + (on ? " is-on" : "")} aria-pressed={on} onClick={() => onToggle(!on)}>
      {on ? <b>{label}</b> : <span className="lb">{label}</span>}
      {on && (
        <span className="x" aria-hidden>
          <IconClose size={11} />
        </span>
      )}
    </button>
  );
}

/** 複選條件的面板：點了就套用、不收（路線、荷札要連勾幾個）；「好」只是收起來 */
function CheckSheet({ title, options, picked, onToggle, onClose }: { title: string; options: readonly FilterOption[]; picked: readonly string[]; onToggle(v: string): void; onClose(): void }) {
  return (
    <MSheet
      title={title}
      onClose={onClose}
      foot={
        <button type="button" className="ns-btn btn-seal" onClick={onClose}>
          好
        </button>
      }
    >
      <div className="m-bf-opts">
        {options.length === 0 && <p className="m-tks-note">沒有可選的</p>}
        {options.map((o) => {
          const on = picked.includes(o.value);
          return (
            <button
              key={o.value}
              type="button"
              role="checkbox"
              aria-checked={on}
              className={"ns-msheet-item" + (on ? " is-on" : "")}
              style={o.depth ? { paddingLeft: `calc(var(--m-gutter) + ${o.depth * 14}px)` } : undefined}
              onClick={() => onToggle(o.value)}
            >
              {o.label}
              <span className="m-tks-aside m-bd-check">{on ? "✓" : o.count}</span>
            </button>
          );
        })}
      </div>
    </MSheet>
  );
}

/* ───────── 常用 chip 一排 ───────── */

function SavedRow({ onMenu }: { onMenu(id: string): void }) {
  const saved = useBoardStore((s) => s.saved);
  const active = useBoardStore((s) => s.activeSavedId);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const items = useMemo(() => saved.map((s) => ({ id: s.id })), [saved]);

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
    // 放開後瀏覽器還會補一個 click：面板晚一點開，那一下才落在 chip 上（共用元件會吞掉），不會落在剛開的暗幕上把面板關掉
    onPressRelease: (id) => void window.setTimeout(() => onMenu(id), 80),
  });

  if (!saved.length) return null;
  return (
    <div className="m-bf-saved">
      <span className="plabel">常用</span>
      <div ref={setRoot} className="m-bf-savedlist">
        {saved.map((s) => (
          <div key={s.id} className={"ns-bd-qchip m-bf-qchip" + (active === s.id ? " is-on" : "")} data-drag-id={s.id} data-drag-col={s.id}>
            <span role="button" tabIndex={0} className="name" aria-pressed={active === s.id} onClick={() => store().applySaved(s.id)}>
              {s.name}
            </span>
            <button type="button" className="more" aria-haspopup="dialog" aria-label={`「${s.name}」的動作`} onClick={() => onMenu(s.id)}>
              <IconDots size={12} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ───────── 頁 ───────── */

export function MobileFilterView() {
  const { rows, columns, order, doneCount, boardLayout, deadRoutes, deadTags, options, today, tagName } = useTaskFilter();
  const filter = useBoardStore((s) => s.filter);
  const sort = useBoardStore((s) => s.sort);
  const layout = useBoardStore((s) => s.layout);
  const saved = useBoardStore((s) => s.saved);
  const activeSavedId = useBoardStore((s) => s.activeSavedId);
  const loading = useBoardStore((s) => s.loading);
  const taskCount = useBoardStore((s) => s.tasks.length);
  const routes = useNodeStore((s) => s.routes);
  const occurrences = useNodeStore((s) => s.currentOccurrences);
  const counts = useSavedCounts();
  const hideDone = useUiStore((s) => s.hideDone);
  const toggleHideDone = useUiStore((s) => s.toggleHideDone);
  const now = useMinuteTick();
  const picked = useScopeSelection("board");
  const selecting = picked.length > 0;

  const [pop, setPop] = useState<ChipKey | null>(null);
  const [nameSheet, setNameSheet] = useState<{ id: string | null; initial: string } | null>(null);
  const [savedMenu, setSavedMenu] = useState<string | null>(null);
  const [sheetId, setSheetId] = useState<string | null>(null);
  const [listEl, setListEl] = useState<HTMLUListElement | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  useBackLayer(CARD_LAYER, sheetId !== null, () => setSheetId(null));

  const { shown, stamp: stampRow, flash, freshId } = useStampLinger(rows, !boardLayout);

  const rowById = useMemo(() => new Map(shown.map((r) => [r.node.id, r])), [shown]);
  // 車庫裡的票不進多選（跨路線：只濾掉那幾張）；判準在 selectionStore 那一關
  useSelectable("board", (id) => !rowById.get(id)?.route?.arrived_on);
  usePruneSelection("board", order);
  // ⋯ 開著的那張不在結果裡了（條件濾掉、刪了、同步收到刪除）：收掉，返回層跟著放掉
  useEffect(() => {
    if (sheetId && !rowById.has(sheetId)) setSheetId(null);
  }, [sheetId, rowById]);
  const parkedOf = (n: NodeRow) => !!rowById.get(n.id)?.route?.arrived_on;
  const stamp = (n: TaskRow) => {
    if (parkedOf(n)) return toast(PARKED_WHY);
    stampRow(n);
  };
  /** 長按原地放開：車庫裡的票講一句，其他進多選 */
  const pressPick = (id: string) => {
    if (rowById.get(id)?.route?.arrived_on) toast(PARKED_WHY);
    else pressSelect("board", id, order);
  };

  /* 清單版面：長按＝多選；不能拖（順序跟著排序走），手指一動就抖一下 */
  useDragReorder({
    root: listEl,
    scrollRef: pageRef,
    items: useMemo(() => shown.map((r) => ({ id: r.node.id })), [shown]),
    disabled: boardLayout,
    canDrag: () => "順序跟著排序走",
    onDrop: () => undefined,
    onPressRelease: pressPick,
  });

  /* 看板版面（欄在 useTaskFilter） */
  const items = useMemo(() => columns.flatMap((c) => c.rows.map((r) => ({ id: r.type === "card" ? r.card.node.id : r.id }))), [columns]);

  const dropTo = (ids: readonly string[], col: string) => {
    const nodes = ids.flatMap((id) => rowById.get(id)?.node ?? []);
    if (col === "done" && nodes.length === 1) flash(nodes[0].id);
    void moveCardsToStatus(nodes, col as BoardStatus);
  };

  const renderCard = (card: BoardCardModel<NodeRow>) => {
    const n = card.node;
    const r = rowById.get(n.id);
    const isPicked = picked.includes(n.id);
    return (
      <BoardCard
        key={n.id}
        node={n}
        today={today}
        occurrence={occurrences[n.id]}
        route={r?.route ?? null}
        path={card.crumb.length ? card.crumb.join(" › ") : null}
        picked={isPicked}
        fresh={freshId === n.id}
        stampWhy={r?.route?.arrived_on ? PARKED_ADD_WHY : undefined}
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

  /* chip 的字 */
  const routeName = (id: string) => (id === TEMP_ROUTE ? "臨時車票" : (routes.find((r) => r.id === id)?.name ?? "已刪除的路線"));
  const many = (list: readonly string[], name: (v: string) => string) => (list.length ? name(list[0]) + (list.length > 1 ? ` +${list.length - 1}` : "") : undefined);
  const toggleIn = (list: readonly string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const hasCond = hasFilterConditions(filter);
  const guessName = () =>
    [many(filter.tags, (k) => `#${tagName(k)}`), many(filter.routes, routeName), filter.due && `締切${DUE_LABEL[filter.due]}`, filter.late && "誤點", filter.high && "高優先"]
      .filter(Boolean)
      .slice(0, 2)
      .join("・");

  const menuTarget = saved.find((s) => s.id === savedMenu);
  const menuAt = menuTarget ? saved.indexOf(menuTarget) : -1;
  const stepSaved = (delta: -1 | 1) => {
    const list = saved.map((s) => s.id);
    const [id] = list.splice(menuAt, 1);
    list.splice(menuAt + delta, 0, id);
    setSavedMenu(null);
    void store().reorderSaved(list);
  };

  let body: ReactNode;
  if (loading && !taskCount) body = null;
  else if (boardLayout)
    body = (
      <MobileBoardColumns
        columns={columns}
        items={items}
        memoryKey="filter"
        renderCard={renderCard}
        renderColTop={(c) => (c.status === "done" && !c.shut && doneCount > 0 ? <DoneToggleChip className="m-bd-donetop" count={doneCount} showing onToggle={toggleHideDone} /> : null)}
        emptyText="拖到這裡"
        onOpenDone={() => {
          if (hideDone) toggleHideDone();
        }}
        canDrag={(id) => (rowById.get(id)?.route?.arrived_on ? PARKED_WHY : true)}
        onRefuse={(_id, why) => toast(why)}
        dragIds={(id) => batchDragIds("board", id, order).filter((x) => !rowById.get(x)?.route?.arrived_on)}
        resolve={(_ids, p) => (p.kind === "slot" || p.type === DOCK_TYPE ? true : "這裡放不下")}
        onDrop={(ids, p) => {
          if (p.kind === "target") dropTo(ids, p.target);
          else if (p.col) dropTo(ids, p.col);
        }}
        onPressRelease={pressPick}
      />
    );
  else if (!shown.length)
    body = (
      <div className="m-bf-empty">
        <p>{hasCond ? "沒有符合的車票" : "沒有未済的車票"}</p>
        {hasCond && (
          <button type="button" className="ns-btn btn-ghost" onClick={() => store().clearFilter()}>
            清除條件
          </button>
        )}
      </div>
    );
  else
    body = (
      <ul ref={setListEl} className="m-tk-list m-bf-list" data-no-fab>
        {shown.map((r) => {
          const n = r.node;
          const occ = occurrences[n.id];
          const card = { ...cardFromTreeNode(n, occ, null), late: isTaskLate(n, occ, today) ? ("inday" as const) : null, stampHint: null };
          const status = cardStatus(n, occ);
          const extra: ReactNode[] = [
            ...(r.crumb.length ? [<span className="m-bf-crumb">{r.crumb.join(" › ")}</span>] : []),
            ...(status === "doing" || status === "paused" ? [<span className="m-tk-chip">{STATUS_COLUMN_LABEL[status]}</span>] : []),
          ];
          return (
            <MobileTicket
              key={n.id}
              card={card}
              route={r.route ?? undefined}
              today={today}
              fresh={freshId === n.id}
              now={now}
              hideFare
              metaExtra={extra}
              onComplete={() => stamp(n)}
              onMore={() => setSheetId(n.id)}
              dragId={n.id}
              selecting={selecting}
              picked={picked.includes(n.id)}
              onPick={() => tapSelect("board", n.id, order)}
            />
          );
        })}
      </ul>
    );

  const sheetNode = sheetId ? rowById.get(sheetId)?.node : undefined;

  return (
    <>
      <div ref={pageRef} id={OVERVIEW_PANEL.filter} role="tabpanel" className={"m-page m2-page m-bf" + (boardLayout ? " is-board" : "") + (selecting ? " is-selecting" : "")} aria-label="篩選清單">
        <div className="m-bf-head">
          <div className="m-bf-chips">
            <Chip
              label="路線"
              value={many(filter.routes, routeName)}
              on={filter.routes.length > 0}
              dead={filter.routes.length > 0 && deadRoutes.length === filter.routes.length}
              onOpen={() => setPop("routes")}
              onClear={filter.routes.length ? () => store().setFilter({ routes: [] }) : undefined}
            />
            <Chip
              label="荷札"
              value={many(filter.tags, (k) => `#${tagName(k)}`)}
              on={filter.tags.length > 0}
              dead={filter.tags.length > 0 && deadTags.length === filter.tags.length}
              onOpen={() => setPop("tags")}
              onClear={filter.tags.length ? () => store().setFilter({ tags: [] }) : undefined}
            />
            <Chip
              label="締切"
              value={filter.due ? DUE_LABEL[filter.due] : undefined}
              on={!!filter.due}
              onOpen={() => setPop("due")}
              onClear={filter.due ? () => store().setFilter({ due: null }) : undefined}
            />
            <Chip
              label="狀態"
              value={boardLayout ? undefined : STATUS_COND_LABEL[filter.status]}
              on={!boardLayout && filter.status !== "open"}
              off={boardLayout ? "看板的四欄就是狀態" : undefined}
              onOpen={() => setPop("status")}
            />
            <Toggle label="誤點" on={filter.late} onToggle={(late) => store().setFilter({ late })} />
            <Toggle label="優先 高" on={filter.high} onToggle={(high) => store().setFilter({ high })} />
            {hasCond && (
              <button type="button" className="ns-btn btn-text m-bf-clear" onClick={() => store().clearFilter()}>
                清除
              </button>
            )}
          </div>
          <SavedRow onMenu={setSavedMenu} />
          <div className="m-bf-res">
            <span className="cnt">
              <b>{rows.length}</b>張
            </span>
            <span className="sp" />
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
            <button type="button" className="ns-bd-fchip m-bf-sort" aria-haspopup="dialog" onClick={() => setPop("sort")}>
              <span className="lb">依</span>
              <b>{TASK_SORT_LABEL[sort]}</b>
              <IconChevron open size={12} className="chev" />
            </button>
          </div>
        </div>
        <div id={LAYOUT_PANEL[layout]} role="tabpanel" aria-label={layout === "board" ? "看板" : "清單"} style={{ display: "contents" }}>
          {body}
        </div>
      </div>

      {hasCond && (
        <div className="m-bf-save">
          <button
            type="button"
            className="ns-btn btn-text techo-card"
            aria-disabled={activeSavedId ? true : undefined}
            onClick={() => (activeSavedId ? toast("這組條件已經存過了") : setNameSheet({ id: null, initial: guessName() }))}
          >
            存成常用…
          </button>
        </div>
      )}

      {pop === "routes" && (
        <CheckSheet
          title="路線"
          options={options("routes")}
          picked={filter.routes}
          onToggle={(v) => store().setFilter({ routes: toggleIn(store().filter.routes, v) })}
          onClose={() => setPop(null)}
        />
      )}
      {pop === "tags" && (
        <CheckSheet
          title="荷札"
          options={options("tags")}
          picked={filter.tags}
          onToggle={(v) => store().setFilter({ tags: toggleIn(store().filter.tags, v) })}
          onClose={() => setPop(null)}
        />
      )}
      {pop === "due" && (
        <MSheet list title="締切" onClose={() => setPop(null)}>
          {options("due").map((o) => (
            <MSheetItem
              key={o.value}
              onClick={() => {
                setPop(null);
                store().setFilter({ due: filter.due === o.value ? null : (o.value as DueCond) });
              }}
            >
              {o.label}
              <span className="m-tks-aside m-bd-check">{filter.due === o.value ? "✓" : o.count}</span>
            </MSheetItem>
          ))}
        </MSheet>
      )}
      {pop === "status" && (
        <MSheet list title="狀態" onClose={() => setPop(null)}>
          {(["open", "done", "all"] as const).map((s: TaskStatusCond) => (
            <MSheetItem
              key={s}
              onClick={() => {
                setPop(null);
                store().setFilter({ status: s });
              }}
            >
              {s === "open" ? `${STATUS_COND_LABEL[s]}（預設）` : STATUS_COND_LABEL[s]}
              {filter.status === s && <span className="m-tks-aside m-bd-check">✓</span>}
            </MSheetItem>
          ))}
        </MSheet>
      )}
      {pop === "sort" && (
        <MSheet list title="排序" onClose={() => setPop(null)}>
          {(["smart", "scheduled", "priority", "updated"] as const).map((s: TaskSort) => (
            <MSheetItem
              key={s}
              onClick={() => {
                setPop(null);
                store().setSort(s);
              }}
            >
              {TASK_SORT_LABEL[s]}
              {sort === s && <span className="m-tks-aside m-bd-check">✓</span>}
            </MSheetItem>
          ))}
        </MSheet>
      )}

      {menuTarget && (
        <MSheet list title={menuTarget.name} overline={`常用篩選・現在 ${counts[menuTarget.id] ?? 0} 張`} onClose={() => setSavedMenu(null)}>
          <MSheetItem
            onClick={() => {
              setSavedMenu(null);
              setNameSheet({ id: menuTarget.id, initial: menuTarget.name });
            }}
          >
            改名…
          </MSheetItem>
          <MSheetItem
            onClick={() => {
              setSavedMenu(null);
              void store()
                .updateSaved(menuTarget.id)
                .then((ok) => {
                  if (ok) useUiStore.getState().showToast({ message: "已更新條件" }, 2600);
                });
            }}
          >
            用目前的條件更新
          </MSheetItem>
          {saved.length > 1 && (
            <div className="m-tks-pair">
              <MSheetItem off={menuAt === 0} onClick={menuAt === 0 ? () => toast("已經在最前面") : () => stepSaved(-1)}>
                往前
              </MSheetItem>
              <MSheetItem off={menuAt === saved.length - 1} onClick={menuAt === saved.length - 1 ? () => toast("已經在最後面") : () => stepSaved(1)}>
                往後
              </MSheetItem>
            </div>
          )}
          <MSheetItem
            cut
            danger
            onClick={() => {
              setSavedMenu(null);
              void store().removeSaved(menuTarget.id);
            }}
          >
            刪除
          </MSheetItem>
        </MSheet>
      )}

      {nameSheet && (
        <MobileTextSheet
          title={nameSheet.id ? "改名" : "存成常用"}
          initial={nameSheet.initial}
          placeholder="名稱"
          submitLabel={nameSheet.id ? "改好了" : "存"}
          inputLabel="常用篩選的名稱"
          onSubmit={(name) => {
            const id = nameSheet.id;
            setNameSheet(null);
            if (id) void store().renameSaved(id, name);
            else {
              void store()
                .saveAs(name)
                .then((ok) => {
                  if (ok) useUiStore.getState().showToast({ message: "已存成常用" }, 2600);
                });
            }
          }}
          onClose={() => setNameSheet(null)}
        />
      )}

      {sheetNode && <MobileBoardCardSheet node={sheetNode} today={today} parked={parkedOf(sheetNode)} order={order} backId={CARD_LAYER} onClose={() => setSheetId(null)} />}

      <MobileSelectionBar scope="board" lookup={(id) => rowById.get(id)?.node} />
    </>
  );
}
