/**
 * FilterChips——清單視圖常駐篩選膠囊列與排序鈕（②契約 §5.1 `.ns-tk-filters`；v1.32 2B-2 常駐當月直篩＋跨月搜尋雙模）。
 *
 * 兩種運作語義（同一套膠囊與浮層）：
 *   1. **當月直篩模式（`!searchOpen`）**：
 *      在 `.ns-tk-subbar` 常駐顯示 `分類 ｜ 路線 ｜ 帳戶 ｜ #荷札 ｜ 類型 ｜ 期間`，點選前五項直接更新 `listFilter`／`filterAccountId`，
 *      就地篩選當前瀏覽月份（DateNav 翻上／下個月自然沿用），列旁即時顯示篩選筆數／收支小計與「清除」鈕；
 *      若點 `期間` 並選為「全部／今年／自訂」，才將既有條件無縫升格為跨月搜尋模式（`promoteListFilterToSearch`）。
 *   2. **跨月搜尋模式（`searchOpen`）**：
 *      讀寫 `store.filter`，支援關鍵字＋跨月區間查詢。
 *
 * 另 export `SortButton`：右端常駐「排序」（當月直篩寫 `listSort`，跨月搜尋寫 `resultSort`）。
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { useTicketStore } from "../../../store/ticketStore";
import { useNodeStore } from "../../../store/nodeStore";
import { groupRoutesByLine } from "../../notes/useAttachOptions";
import { useTagStore } from "../../../store/tagStore";
import { useUiStore } from "../../../store/uiStore";
import { todayKey } from "../../../lib/date";
import { DatePicker } from "../../common/DatePicker";
import {
  UNCAT_EXPENSE_ID,
  UNCAT_INCOME_ID,
  categoryForest,
  categoryPath,
  categorySubtreeIds,
  monthOf,
  monthRange,
  monthTitle,
  orderAccounts,
  type CategoryNode,
  type CategoryRow,
  type EntryKind,
} from "../../../domain/ticket";
import {
  DEFAULT_ENTRY_SORT,
  EMPTY_FILTER,
  ENTRY_SORTS,
  ENTRY_SORT_TEXT,
  dayStep,
  filterChips,
  hasInMonthFacets,
  isFilterActive,
  routeCtx,
  type EntryFilter,
  type EntrySort,
  type ViewCtx,
} from "../../../domain/ticketView";
import type { NodeRow } from "../../../domain/node";
import type { TagIndex } from "../../../domain/tags";
import { TK_TAG_ENTRY, tagNameOf } from "../../../domain/ticketTags";
import { TkIcon, TkRoundel, acctLabel } from "../TicketLedger";
import { focusTicketSearch } from "./SearchBar";
import { chooseSort } from "./sortChoice";
import { CatTreeRow, ancestorIds, findNode, useCatOpen, visibleNodes } from "./catTree";

type ChipKey = "cat" | "route" | "acct" | "tag" | "kind" | "period";

const CHIPS: readonly { key: ChipKey; label: string; field: keyof EntryFilter }[] = [
  { key: "cat", label: "分類", field: "categoryIds" },
  { key: "route", label: "路線", field: "routeId" },
  { key: "acct", label: "帳戶", field: "accountId" },
  { key: "tag", label: "#荷札", field: "tagKeys" },
  { key: "kind", label: "類型", field: "kinds" },
  { key: "period", label: "期間", field: "from" },
];

export const FILTER_KINDS: readonly { k: EntryKind; label: string }[] = [
  { k: "expense", label: "支出" },
  { k: "income", label: "收入" },
  { k: "transfer", label: "轉帳" },
  { k: "adjust", label: "校正" },
];

const isUncat = (id: string): boolean => id === UNCAT_INCOME_ID || id === UNCAT_EXPENSE_ID;

/** 點外面收起（帶 data-pop-toggle 的開關鈕、日期浮層除外） */
function useOutside(ref: RefObject<HTMLElement | null>, onClose: () => void): void {
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target;
      if (!(t instanceof Node) || ref.current?.contains(t)) return;
      if (t instanceof Element && t.closest("[data-pop-toggle], .ns-datepick")) return;
      onClose();
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [ref, onClose]);
}

/** 小浮層（焦點落在選中項、↑↓ 移、Esc 收；多選的浮層 Enter 不收） */
function FPop({ label, onClose, tall, children }: { label: string; onClose(): void; tall?: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useOutside(ref, onClose);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    (el.querySelector<HTMLElement>(".opt.on, [aria-pressed='true']") ?? el.querySelector<HTMLElement>(".opt, button"))?.focus({ preventScroll: true });
  }, []);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const opts = Array.from(ref.current?.querySelectorAll<HTMLElement>(".opt:not([disabled]), .ns-tk-quick button, .ns-tk-datechip") ?? []);
    const i = opts.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!opts.length) return;
      const n = opts.length;
      const j = i < 0 ? (e.key === "ArrowDown" ? 0 : n - 1) : (i + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
      opts[j].focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key !== "Tab" && e.key !== "Enter") {
      return;
    }
    e.stopPropagation();
  };
  return (
    <div ref={ref} className={"ns-tk-pop ns-tk-fpop" + (tall ? " is-tall" : "")} role="dialog" aria-label={label} onKeyDown={onKeyDown}>
      {children}
    </div>
  );
}

function Opt({ on, onPick, children, className }: { on: boolean; onPick(): void; children: ReactNode; className?: string }) {
  return (
    <button type="button" className={"opt" + (on ? " on" : "") + (className ? ` ${className}` : "")} aria-pressed={on} onClick={onPick}>
      {children}
    </button>
  );
}

/* ───────── 各欄的浮層 ───────── */

type PeriodMode = "all" | "month" | "year" | "custom";

function PeriodPop({ f, searchOpen, onClose }: { f: EntryFilter; searchOpen: boolean; onClose(): void }) {
  const month = useTicketStore((s) => s.month);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const today = todayKey(dayStartHour);
  const curMonthRange = monthRange(searchOpen ? monthOf(today) : month);
  const y = today.slice(0, 4);
  const yr = { from: `${y}-01-01`, toExcl: `${Number(y) + 1}-01-01` };
  const auto: PeriodMode = !searchOpen
    ? "month"
    : f.from === null && f.toExcl === null
      ? "all"
      : f.from === curMonthRange.from && f.toExcl === curMonthRange.toExcl
        ? "month"
        : f.from === yr.from && f.toExcl === yr.toExcl
          ? "year"
          : "custom";
  const [custom, setCustom] = useState(auto === "custom");
  const mode: PeriodMode = custom ? "custom" : auto;
  const [pick, setPick] = useState<"from" | "to" | null>(null);
  const applyCrossMonth = (p: Partial<EntryFilter>) => {
    const st = useTicketStore.getState();
    if (st.searchOpen) {
      void st.patchFilter(p);
      return;
    }
    // 當月直篩若選「全部」但尚未設任何分類／路線／帳戶／荷札條件，開搜尋框讓使用者打字找全部期間
    const hasAnyFacet = hasInMonthFacets(st.listFilter) || st.filterAccountId !== null;
    if (p.from === null && p.toExcl === null && !hasAnyFacet) {
      st.openSearch();
      focusTicketSearch();
      onClose();
      return;
    }
    void st.promoteListFilterToSearch(p);
  };
  const from = f.from ?? curMonthRange.from;
  const toIncl = f.toExcl !== null ? dayStep(f.toExcl, -1) : today;

  const quick: readonly [PeriodMode, string][] = [
    ["month", searchOpen ? "本月" : `當月（${Number(month.slice(5, 7))}月）`],
    ["year", "今年"],
    ["all", "全部"],
    ["custom", "自訂"],
  ];
  return (
    <FPop label="期間" onClose={onClose}>
      <p className="hd">期間</p>
      <div className="ns-tk-quick">
        {quick.map(([k, label]) => (
          <button
            key={k}
            type="button"
            aria-pressed={mode === k}
            onClick={() => {
              setCustom(k === "custom");
              setPick(null);
              if (k === "month") {
                if (searchOpen) void useTicketStore.getState().patchFilter(curMonthRange);
                else onClose();
              } else if (k === "all") applyCrossMonth({ from: null, toExcl: null });
              else if (k === "year") applyCrossMonth(yr);
              else if (!searchOpen || (f.from === null && f.toExcl === null)) {
                applyCrossMonth({ from: curMonthRange.from, toExcl: dayStep(today, 1) });
              }
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {mode === "custom" && (
        <div className="ns-tk-range">
          <span className="ns-tk-rangeslot">
            <button type="button" className="ns-tk-datechip" aria-expanded={pick === "from"} data-pop-toggle onClick={() => setPick(pick === "from" ? null : "from")}>
              {from.replace(/-/g, "/")}
            </button>
            {pick === "from" && (
              <DatePicker
                float
                className="ns-tk-datepop"
                label="從哪一天"
                value={from}
                markValue
                max={toIncl}
                onPick={(d) => {
                  setPick(null);
                  applyCrossMonth({ from: d, toExcl: f.toExcl ?? dayStep(toIncl, 1) });
                }}
                onClose={() => setPick(null)}
              />
            )}
          </span>
          –
          <span className="ns-tk-rangeslot">
            <button type="button" className="ns-tk-datechip" aria-expanded={pick === "to"} data-pop-toggle onClick={() => setPick(pick === "to" ? null : "to")}>
              {toIncl.replace(/-/g, "/")}
            </button>
            {pick === "to" && (
              <DatePicker
                float
                className="ns-tk-datepop"
                label="到哪一天"
                value={toIncl}
                markValue
                min={from}
                onPick={(d) => {
                  setPick(null);
                  applyCrossMonth({ from, toExcl: dayStep(d, 1) });
                }}
                onClose={() => setPick(null)}
              />
            )}
          </span>
        </div>
      )}
      <p className="ns-tk-pop-note">
        {searchOpen ? "預設搜尋全部月份" : `目前就地篩選 ${monthTitle(month)}；選今年／全部／自訂展開跨月查詢`}
      </p>
    </FPop>
  );
}

function AcctPop({ f, searchOpen, onClose }: { f: EntryFilter; searchOpen: boolean; onClose(): void }) {
  const accounts = useTicketStore((s) => s.accounts);
  const live = orderAccounts(accounts.filter((a) => a.deleted_at === null && a.archived_at === null));
  const archived = orderAccounts(accounts.filter((a) => a.deleted_at === null && a.archived_at !== null));
  const pick = (id: string | null) => {
    const st = useTicketStore.getState();
    if (searchOpen) void st.patchFilter({ accountId: id });
    else void st.setFilter(id);
    onClose();
  };
  return (
    <FPop label="帳戶" onClose={onClose}>
      <p className="hd">帳戶</p>
      <Opt on={f.accountId === null} onPick={() => pick(null)}>
        全部帳戶
      </Opt>
      <div className="sep" />
      {live.map((a) => (
        <Opt key={a.id} on={f.accountId === a.id} onPick={() => pick(a.id)}>
          {acctLabel(a, accounts)}
        </Opt>
      ))}
      <p className="hd">封存</p>
      {archived.length ? (
        archived.map((a) => (
          <Opt key={a.id} on={f.accountId === a.id} onPick={() => pick(a.id)} className="is-quiet">
            {acctLabel(a, accounts)}
          </Opt>
        ))
      ) : (
        <p className="ns-tk-pop-note">（沒有封存的帳戶）</p>
      )}
    </FPop>
  );
}

/**
 * 分類樹多選邏輯（桌機浮層與手機抽屜共用）：
 * 勾一個分類＝含它底下所有分類（只存那一個 id）；祖先勾著時點底下某一列＝拆成其他兄弟各自勾。
 */
export function toggleCategoryPick(
  sel: readonly string[],
  n: CategoryNode,
  categories: readonly CategoryRow[],
  catById: Readonly<Record<string, CategoryRow>>,
  forests: { expense: CategoryNode[]; income: CategoryNode[] },
): string[] {
  const up = ancestorIds(n.cat, catById);
  let above: string | null = null;
  for (let i = up.length - 1; i >= 0; i--) {
    if (sel.indexOf(up[i]) >= 0) {
      above = up[i];
      break;
    }
  }
  const id = n.cat.id;
  if (above) {
    const forest = forests[n.cat.kind];
    const path = categoryPath(n.cat, catById).map((c) => c.id);
    const adds: string[] = [];
    for (let k = path.indexOf(above); k >= 0 && k < path.length - 1; k++) {
      const kids = findNode(forest, path[k])?.children ?? [];
      for (const kid of kids) if (kid.cat.id !== path[k + 1]) adds.push(kid.cat.id);
    }
    return [...sel.filter((x) => x !== above), ...adds];
  }
  if (sel.indexOf(id) >= 0) return sel.filter((x) => x !== id);
  const under = new Set(categorySubtreeIds(id, categories));
  return [...sel.filter((x) => !under.has(x)), id];
}

function CatPop({ f, onPatch, onClose }: { f: EntryFilter; onPatch(p: Partial<EntryFilter>): void; onClose(): void }) {
  const categories = useTicketStore((s) => s.categories);
  const catById = useTicketStore((s) => s.catById);
  const sel = f.categoryIds;
  const [open, toggle] = useCatOpen(() => sel.flatMap((id) => ancestorIds(catById[id], catById)));
  const set = (ids: string[]) => onPatch({ categoryIds: ids });
  const forests = useMemo(
    () => ({
      expense: categoryForest(categories, "expense", { includeArchived: false }),
      income: categoryForest(categories, "income", { includeArchived: false }),
    }),
    [categories],
  );
  const pickedAbove = (c: CategoryRow): string | null => {
    const up = ancestorIds(c, catById);
    for (let i = up.length - 1; i >= 0; i--) if (sel.indexOf(up[i]) >= 0) return up[i];
    return null;
  };
  const tree = (kind: "expense" | "income") =>
    visibleNodes(forests[kind], open).map((n) => {
      const on = sel.indexOf(n.cat.id) >= 0 || pickedAbove(n.cat) !== null;
      return (
        <CatTreeRow key={n.cat.id} node={n} open={open.has(n.cat.id)} onToggle={toggle}>
          <Opt on={on} onPick={() => set(toggleCategoryPick(sel, n, categories, catById, forests))}>
            {isUncat(n.cat.id) ? <span className="unc">未分類</span> : <span className="t">{n.cat.name}</span>}
            {n.children.length > 0 && <span className="r">{n.children.length} 個子分類</span>}
          </Opt>
        </CatTreeRow>
      );
    });
  return (
    <FPop label="分類" onClose={onClose} tall>
      <p className="hd">支出</p>
      {tree("expense")}
      <p className="hd">收入</p>
      {tree("income")}
      <p className="ns-tk-pop-note">勾一個分類會包含它底下所有分類{sel.length > 0 && " · "}</p>
      {sel.length > 0 && (
        <Opt on={false} onPick={() => set([])} className="is-quiet">
          清除分類
        </Opt>
      )}
    </FPop>
  );
}

function KindPop({ f, onPatch, onClose }: { f: EntryFilter; onPatch(p: Partial<EntryFilter>): void; onClose(): void }) {
  const toggle = (k: EntryKind) => {
    const has = f.kinds.indexOf(k) >= 0;
    onPatch({ kinds: has ? f.kinds.filter((x) => x !== k) : [...f.kinds, k] });
  };
  return (
    <FPop label="類型" onClose={onClose}>
      <p className="hd">類型（可多選）</p>
      {FILTER_KINDS.map(({ k, label }) => (
        <Opt key={k} on={f.kinds.indexOf(k) >= 0} onPick={() => toggle(k)}>
          {label}
        </Opt>
      ))}
    </FPop>
  );
}

function RoutePop({
  f,
  onPatch,
  onClose,
  routes,
  lines,
}: {
  f: EntryFilter;
  onPatch(p: Partial<EntryFilter>): void;
  onClose(): void;
  routes: readonly NodeRow[];
  lines: readonly NodeRow[];
}) {
  const pick = (id: string | null | "none") => {
    onPatch({ routeId: id });
    onClose();
  };
  const live = useMemo(() => routes.filter((r) => r.deleted_at === null), [routes]);
  const groups = useMemo(() => groupRoutesByLine(live, lines), [live, lines]);
  return (
    <FPop label="路線" onClose={onClose}>
      <p className="hd">路線</p>
      <Opt on={f.routeId === null} onPick={() => pick(null)}>
        全部路線
      </Opt>
      <Opt on={f.routeId === "none"} onPick={() => pick("none")}>
        <TkRoundel route={null} />
        未選路線
      </Opt>
      {live.length > 0 && <div className="sep" />}
      {groups.map((g) => (
        <Fragment key={g.lineId ?? "other"}>
          <p className="hd">{g.header}</p>
          {g.routes.map((r) => (
            <Opt key={r.id} on={f.routeId === r.id} onPick={() => pick(r.id)}>
              <TkRoundel route={r} />
              {r.name}
            </Opt>
          ))}
        </Fragment>
      ))}
    </FPop>
  );
}

/** 荷札篩選的選項：樹的先序（父在子前），只列有帳掛過（含子孫）或已勾的；n＝掛了它（含子孫）的帳數（同一筆只算一次） */
export function tagFilterOptions(idx: TagIndex, sel: readonly string[]): { key: string; name: string; n: number }[] {
  const count: Record<string, number> = {};
  for (const e of idx.ents) {
    if (e.type !== TK_TAG_ENTRY) continue;
    const seen = new Set<string>();
    for (const k of e.keys) {
      for (let cur: string | null = k; cur && !seen.has(cur); cur = idx.byKey[cur]?.parent ?? null) seen.add(cur);
    }
    seen.forEach((k) => (count[k] = (count[k] ?? 0) + 1));
  }
  const out: { key: string; name: string; n: number }[] = [];
  const walk = (key: string) => {
    const node = idx.byKey[key];
    if (!node) return;
    const n = count[key] ?? 0;
    if (n > 0 || sel.indexOf(key) >= 0) out.push({ key, name: node.name, n });
    node.children.forEach(walk);
  };
  idx.roots.forEach(walk);
  return out;
}

function TagPop({ f, onPatch, onClose }: { f: EntryFilter; onPatch(p: Partial<EntryFilter>): void; onClose(): void }) {
  const index = useTagStore((s) => s.index);
  useEffect(() => {
    const st = useTagStore.getState();
    if (!st.index && !st.loading) void st.loadIndex();
  }, []);
  const sel = f.tagKeys ?? [];
  const set = (keys: string[]) => onPatch({ tagKeys: keys });
  const opts = useMemo(() => (index ? tagFilterOptions(index, sel) : []), [index, sel]);
  return (
    <FPop label="荷札" onClose={onClose} tall>
      <p className="hd">荷札（可多選）</p>
      {index === null ? (
        <p className="ns-tk-pop-note">正在讀荷札…</p>
      ) : opts.length === 0 ? (
        <p className="ns-tk-pop-note">還沒有帳掛荷札</p>
      ) : (
        opts.map((o) => {
          const on = sel.indexOf(o.key) >= 0;
          const segs = o.name.split("/");
          return (
            <Opt key={o.key} on={on} className="is-tag" onPick={() => set(on ? sel.filter((k) => k !== o.key) : [...sel, o.key])}>
              <span className={"ck" + (on ? " on" : "")} aria-hidden />
              <span className="tg">
                {segs.map((seg, i) => (
                  <span key={i}>
                    {i > 0 && <i className="sl">/</i>}
                    <span className={i < segs.length - 1 ? "pa" : "la"}>{seg}</span>
                  </span>
                ))}
              </span>
              <span className="r">{o.n} 筆</span>
            </Opt>
          );
        })
      )}
      <p className="ns-tk-pop-note">勾兩個以上＝掛了其中一個就算</p>
      {sel.length > 0 && (
        <Opt on={false} onPick={() => set([])} className="is-quiet">
          清除荷札
        </Opt>
      )}
    </FPop>
  );
}

/* ───────── 排序（磨光⑥ 契約 §2-4；v1.32 2B-2 當月就地排序） ───────── */

function SortPop({ current, onClose }: { current: EntrySort; onClose(): void }) {
  return (
    <FPop label="排序" onClose={onClose}>
      <p className="hd">排序</p>
      {ENTRY_SORTS.map((k) => (
        <Opt
          key={k}
          on={current === k}
          onPick={() => {
            onClose();
            if (k !== current) chooseSort(k);
          }}
        >
          {ENTRY_SORT_TEXT[k]}
        </Opt>
      ))}
    </FPop>
  );
}

/** 頁首下一列右端的「排序」：當月直篩讀 `listSort`、跨月搜尋讀 `resultSort` */
export function SortButton() {
  const searchOpen = useTicketStore((s) => s.searchOpen);
  const resultSort = useTicketStore((s) => s.resultSort);
  const listSort = useTicketStore((s) => s.listSort);
  const current = searchOpen ? resultSort : listSort;
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const btn = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    const prev = wasOpen.current;
    wasOpen.current = open;
    if (open || !prev) return;
    const t = setTimeout(() => {
      const a = document.activeElement;
      if (a !== null && a !== document.body) return;
      btn.current?.focus({ preventScroll: true });
    });
    return () => clearTimeout(t);
  }, [open]);
  return (
    <span className="ns-tk-chipwrap ns-tk-sortwrap">
      <button
        ref={btn}
        type="button"
        className={"ns-tk-fchip ns-tk-sortbtn" + (current !== DEFAULT_ENTRY_SORT ? " is-on" : "")}
        aria-expanded={open}
        aria-haspopup="dialog"
        data-pop-toggle
        onClick={() => setOpen(!open)}
      >
        排序
        {current !== DEFAULT_ENTRY_SORT && <b>{ENTRY_SORT_TEXT[current]}</b>}
        <TkIcon name="caret" size={10} />
      </button>
      {open && <SortPop current={current} onClose={close} />}
    </span>
  );
}

/* ───────── chips 列 ───────── */

export function FilterChips({ inMonthSummary }: { inMonthSummary?: string | null }) {
  const searchOpen = useTicketStore((s) => s.searchOpen);
  const filter = useTicketStore((s) => s.filter);
  const listFilter = useTicketStore((s) => s.listFilter);
  const filterAccountId = useTicketStore((s) => s.filterAccountId);
  const accById = useTicketStore((s) => s.accById);
  const catById = useTicketStore((s) => s.catById);
  const curByCode = useTicketStore((s) => s.curByCode);
  const lines = useNodeStore((s) => s.lines);
  const routes = useNodeStore((s) => s.routes);
  const tagIndex = useTagStore((s) => s.index);

  const effectiveFilter: EntryFilter = useMemo(
    () => (searchOpen ? filter : { ...listFilter, accountId: listFilter.accountId ?? filterAccountId }),
    [searchOpen, filter, listFilter, filterAccountId],
  );

  const ctx: ViewCtx = useMemo(
    () => ({ accById, catById, curByCode, ...routeCtx(routes), tagName: tagNameOf(tagIndex) }),
    [accById, catById, curByCode, routes, tagIndex],
  );
  const [pop, setPop] = useState<ChipKey | null>(null);
  const close = useCallback(() => setPop(null), []);

  // 浮層收起時焦點若掉到 body ⇒ 還給那顆 chip
  const lastPop = useRef<ChipKey | null>(null);
  useEffect(() => {
    const prev = lastPop.current;
    lastPop.current = pop;
    if (pop !== null || prev === null) return;
    const t = setTimeout(() => {
      const a = document.activeElement;
      if (a !== null && a !== document.body) return;
      document.querySelector<HTMLElement>(`.ns-tk-fchip[data-chip="${prev}"]`)?.focus({ preventScroll: true });
    });
    return () => clearTimeout(t);
  }, [pop]);

  const onPatch = useCallback(
    (p: Partial<EntryFilter>) => {
      const st = useTicketStore.getState();
      if (st.searchOpen) void st.patchFilter(p);
      else void st.patchListFilter(p);
    },
    [],
  );

  const vals: Partial<Record<keyof EntryFilter, string>> = {};
  for (const c of filterChips(effectiveFilter, ctx)) {
    vals[c.key] = c.label.replace(/^(期間|帳戶|分類|類型|路線|荷札) #?/, "");
  }
  const routeVal =
    effectiveFilter.routeId !== null && effectiveFilter.routeId !== "none"
      ? routes.find((r) => r.id === effectiveFilter.routeId)
      : undefined;
  const searchActive = searchOpen && isFilterActive(filter);

  return (
    <div className="ns-tk-filters" role="group" aria-label="篩選">
      {CHIPS.map((c) => {
        const val = vals[c.field];
        return (
          <span key={c.key} className="ns-tk-chipwrap">
            <button
              type="button"
              className={"ns-tk-fchip" + (val ? " is-on" : "")}
              aria-expanded={pop === c.key}
              data-pop-toggle
              data-chip={c.key}
              onClick={() => setPop(pop === c.key ? null : c.key)}
            >
              {c.label}
              {val && (
                <b>
                  {c.key === "route" && routeVal ? (
                    <>
                      <TkRoundel route={routeVal} />
                      {routeVal.name}
                    </>
                  ) : (
                    val
                  )}
                </b>
              )}
              <TkIcon name="caret" size={10} />
            </button>
            {pop === "period" && c.key === "period" && <PeriodPop f={effectiveFilter} searchOpen={searchOpen} onClose={close} />}
            {pop === "acct" && c.key === "acct" && <AcctPop f={effectiveFilter} searchOpen={searchOpen} onClose={close} />}
            {pop === "cat" && c.key === "cat" && <CatPop f={effectiveFilter} onPatch={onPatch} onClose={close} />}
            {pop === "kind" && c.key === "kind" && <KindPop f={effectiveFilter} onPatch={onPatch} onClose={close} />}
            {pop === "route" && c.key === "route" && <RoutePop f={effectiveFilter} onPatch={onPatch} onClose={close} routes={routes} lines={lines} />}
            {pop === "tag" && c.key === "tag" && <TagPop f={effectiveFilter} onPatch={onPatch} onClose={close} />}
          </span>
        );
      })}
      {searchOpen ? (
        searchActive ? (
          <button
            type="button"
            className="ns-btn ns-btn--sm btn-text ns-tk-btn ns-tk-fclear"
            title="清除全部條件"
            onClick={() => void useTicketStore.getState().patchFilter(EMPTY_FILTER)}
          >
            清除
          </button>
        ) : (
          <span className="ns-tk-found is-hint">打字或選條件就會開始找（預設找全部期間）</span>
        )
      ) : inMonthSummary ? (
        <>
          <span className="ns-tk-found" role="status">
            {inMonthSummary}
          </span>
          <button
            type="button"
            className="ns-btn ns-btn--sm btn-text ns-tk-btn ns-tk-fclear"
            title="清除當月篩選與排序"
            onClick={() => useTicketStore.getState().clearListFilter()}
          >
            清除
          </button>
        </>
      ) : null}
    </div>
  );
}
