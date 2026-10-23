/**
 * FilterChips——搜尋開著時頁首第三列的篩選 chips＋結果摘要（②契約 §5.1 `.ns-tk-filters`、0-14；乙席）。長相照原型 filterRow()／popHtml()：
 *
 *   div.ns-tk-filters
 *   ├─ span.ns-tk-chipwrap × 5   button.ns-tk-fchip[.is-on]「期間 <b>10/1–10/31</b> ▾」→ 點開 div.ns-tk-pop.ns-tk-fpop 小浮層
 *   ├─ span.ns-tk-chipwrap       第六顆「排序」（磨光⑥ 契約 §2-4；D-票-64）：日期・新到舊（預設，chip 不亮）／日期・舊到新／金額・大到小／金額・小到大
 *   │     期間：快選「全部／本月／今年／自訂」＋自訂時兩顆日期 chip（DatePicker）
 *   │     帳戶：全部帳戶＋未封存帳戶（orderAccounts）＋「封存」分區
 *   │     分類：支出／收入兩棵樹；勾主分類＝含全部子分類（只存主分類 id）；子分類可單勾
 *   │     類型：支出／收入／轉帳／校正（多選）
 *   │     路線：任一條／未掛路線／各路線（roundel＋名）
 *   └─ 右端 .ns-tk-found「找到 N 筆 · 支出 X · 收入 Y」＋「清除」；沒有條件時淡字提示
 *
 * chip 上的值字取自 domain `filterChips`（與手機同一份字）；摘要取自 `resultSummary`。浮層鍵盤：↑↓ 移、Enter 選、Esc 收（自理，不漏給頁面鍵盤表）。
 *
 * 另 export `SortButton`：一般清單（沒在搜尋）頁首的「排序」（TicketLedger 掛）。選「日期・新到舊」以外的 ⇒ 開搜尋、期間＝現在看的月份、
 * 套上那個排序（store.searchMonthSorted；金額排序要有邊界的範圍）。排序 chip 在沒有條件時選非預設也走同一條路。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { useTicketStore } from "../../../store/ticketStore";
import { useNodeStore } from "../../../store/nodeStore";
import { useUiStore } from "../../../store/uiStore";
import { todayKey } from "../../../lib/date";
import { DatePicker } from "../../common/DatePicker";
import {
  MAIN_CURRENCY,
  UNCAT_EXPENSE_ID,
  UNCAT_INCOME_ID,
  categoryTree,
  monthOf,
  monthRange,
  orderAccounts,
  type CategoryRow,
  type EntryKind,
} from "../../../domain/ticket";
import {
  DEFAULT_ENTRY_SORT,
  ENTRY_SORTS,
  ENTRY_SORT_TEXT,
  dayStep,
  filterChips,
  isFilterActive,
  resultSummary,
  routeCtx,
  type EntryFilter,
  type EntrySort,
  type ViewCtx,
} from "../../../domain/ticketView";
import type { NodeRow } from "../../../domain/node";
import { TkIcon, TkRoundel, acctLabel } from "../TicketLedger";
import { chooseSort } from "./sortChoice";

type ChipKey = "period" | "acct" | "cat" | "kind" | "route" | "sort";

const CHIPS: readonly { key: ChipKey; label: string; field: keyof EntryFilter }[] = [
  { key: "period", label: "期間", field: "from" },
  { key: "acct", label: "帳戶", field: "accountId" },
  { key: "cat", label: "分類", field: "categoryIds" },
  { key: "kind", label: "類型", field: "kinds" },
  { key: "route", label: "路線", field: "routeId" },
];

const KINDS: readonly { k: EntryKind; label: string }[] = [
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

/** 小浮層（TicketPanel 的 Pop 同一套鍵：焦點落在選中項、↑↓ 移、Esc 收；多選的浮層 Enter 不收） */
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
    e.stopPropagation(); // ↑↓／Enter／Esc／Tab 不漏給 useTicketKeyboard
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

function PeriodPop({ f, onClose }: { f: EntryFilter; onClose(): void }) {
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const today = todayKey(dayStartHour);
  const m = monthRange(monthOf(today));
  const y = today.slice(0, 4);
  const yr = { from: `${y}-01-01`, toExcl: `${Number(y) + 1}-01-01` };
  const auto: PeriodMode =
    f.from === null && f.toExcl === null
      ? "all"
      : f.from === m.from && f.toExcl === m.toExcl
        ? "month"
        : f.from === yr.from && f.toExcl === yr.toExcl
          ? "year"
          : "custom";
  const [custom, setCustom] = useState(auto === "custom");
  const mode: PeriodMode = custom ? "custom" : auto;
  const [pick, setPick] = useState<"from" | "to" | null>(null);
  const patch = (p: Partial<EntryFilter>) => void useTicketStore.getState().patchFilter(p);
  const from = f.from ?? m.from;
  const toIncl = f.toExcl !== null ? dayStep(f.toExcl, -1) : today;

  const quick: readonly [PeriodMode, string][] = [
    ["all", "全部"],
    ["month", "本月"],
    ["year", "今年"],
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
              if (k === "all") patch({ from: null, toExcl: null });
              else if (k === "month") patch(m);
              else if (k === "year") patch(yr);
              else if (f.from === null && f.toExcl === null) patch({ from: m.from, toExcl: dayStep(today, 1) });
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
                  patch({ from: d, toExcl: f.toExcl ?? dayStep(toIncl, 1) });
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
                  patch({ from, toExcl: dayStep(d, 1) });
                }}
                onClose={() => setPick(null)}
              />
            )}
          </span>
        </div>
      )}
      <p className="ns-tk-pop-note">預設搜尋全部月份</p>
    </FPop>
  );
}

function AcctPop({ f, onClose }: { f: EntryFilter; onClose(): void }) {
  const accounts = useTicketStore((s) => s.accounts);
  const live = orderAccounts(accounts.filter((a) => a.deleted_at === null && a.archived_at === null));
  const archived = orderAccounts(accounts.filter((a) => a.deleted_at === null && a.archived_at !== null));
  const pick = (id: string | null) => {
    void useTicketStore.getState().patchFilter({ accountId: id });
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

function CatPop({ f, onClose }: { f: EntryFilter; onClose(): void }) {
  const categories = useTicketStore((s) => s.categories);
  const sel = f.categoryIds;
  const set = (ids: string[]) => void useTicketStore.getState().patchFilter({ categoryIds: ids });
  const toggleMain = (p: CategoryRow, kids: readonly CategoryRow[]) => {
    const kidIds = new Set(kids.map((k) => k.id));
    const rest = sel.filter((id) => id !== p.id && !kidIds.has(id));
    set(sel.indexOf(p.id) >= 0 ? rest : [...rest, p.id]);
  };
  const toggleSub = (p: CategoryRow, kids: readonly CategoryRow[], c: CategoryRow) => {
    if (sel.indexOf(p.id) >= 0) {
      // 主分類勾著（＝全部子分類）⇒ 拆成「其他子分類各自勾」
      set([...sel.filter((id) => id !== p.id), ...kids.filter((k) => k.id !== c.id).map((k) => k.id)]);
      return;
    }
    set(sel.indexOf(c.id) >= 0 ? sel.filter((id) => id !== c.id) : [...sel, c.id]);
  };
  const tree = (kind: "expense" | "income") =>
    categoryTree(categories, kind, { includeArchived: false }).map(({ parent: p, children }) => {
      const mainOn = sel.indexOf(p.id) >= 0;
      const open = children.length > 0 && (mainOn || children.some((c) => sel.indexOf(c.id) >= 0));
      return (
        <div key={p.id}>
          <Opt on={mainOn} onPick={() => toggleMain(p, children)}>
            {isUncat(p.id) ? <span className="unc">未分類</span> : p.name}
            {children.length > 0 && <span className="r">{children.length} 個子分類</span>}
          </Opt>
          {open && (
            <div className="ns-tk-subopts">
              {children.map((c) => (
                <Opt key={c.id} on={mainOn || sel.indexOf(c.id) >= 0} onPick={() => toggleSub(p, children, c)}>
                  {c.name}
                </Opt>
              ))}
            </div>
          )}
        </div>
      );
    });
  return (
    <FPop label="分類" onClose={onClose} tall>
      <p className="hd">支出</p>
      {tree("expense")}
      <p className="hd">收入</p>
      {tree("income")}
      <p className="ns-tk-pop-note">勾主分類會包含所有子分類{sel.length > 0 && " · "}</p>
      {sel.length > 0 && (
        <Opt on={false} onPick={() => set([])} className="is-quiet">
          清除分類</Opt>
      )}
    </FPop>
  );
}

function KindPop({ f, onClose }: { f: EntryFilter; onClose(): void }) {
  const toggle = (k: EntryKind) => {
    const has = f.kinds.indexOf(k) >= 0;
    void useTicketStore.getState().patchFilter({ kinds: has ? f.kinds.filter((x) => x !== k) : [...f.kinds, k] });
  };
  return (
    <FPop label="類型" onClose={onClose}>
      <p className="hd">類型（可多選）</p>
      {KINDS.map(({ k, label }) => (
        <Opt key={k} on={f.kinds.indexOf(k) >= 0} onPick={() => toggle(k)}>
          {label}
        </Opt>
      ))}
    </FPop>
  );
}

function RoutePop({ f, onClose, routes }: { f: EntryFilter; onClose(): void; routes: readonly NodeRow[] }) {
  const pick = (id: string | null | "none") => {
    void useTicketStore.getState().patchFilter({ routeId: id });
    onClose();
  };
  const live = routes.filter((r) => r.deleted_at === null);
  return (
    <FPop label="路線" onClose={onClose}>
      <p className="hd">路線</p>
      <Opt on={f.routeId === null} onPick={() => pick(null)}>
        全部路線</Opt>
      <Opt on={f.routeId === "none"} onPick={() => pick("none")}>
        <TkRoundel route={null} />
        未選路線
      </Opt>
      {live.length > 0 && <div className="sep" />}
      {live.map((r) => (
        <Opt key={r.id} on={f.routeId === r.id} onPick={() => pick(r.id)}>
          <TkRoundel route={r} />
          {r.name}
        </Opt>
      ))}
    </FPop>
  );
}

/* ───────── 排序（磨光⑥ 契約 §2-4；D-票-64） ───────── */

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

/** 一般清單頁首的「排序」鈕（清單永遠是日期・新到舊；選別的 ⇒ 開這個月的搜尋） */
export function SortButton() {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const btn = useRef<HTMLButtonElement>(null);
  // Esc 收起時焦點若掉到 body ⇒ 還給鈕（同 chips）；選了排序會換成搜尋畫面、鈕卸載，交給 TicketLedger 的焦點補位
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
        className="ns-tk-fchip ns-tk-sortbtn"
        aria-expanded={open}
        aria-haspopup="dialog"
        data-pop-toggle
        onClick={() => setOpen(!open)}
      >
        排序
        <TkIcon name="caret" size={10} />
      </button>
      {open && <SortPop current={DEFAULT_ENTRY_SORT} onClose={close} />}
    </span>
  );
}

/* ───────── chips 列 ───────── */

export function FilterChips() {
  const searchOpen = useTicketStore((s) => s.searchOpen);
  const filter = useTicketStore((s) => s.filter);
  const results = useTicketStore((s) => s.results);
  const resultSort = useTicketStore((s) => s.resultSort);
  const accById = useTicketStore((s) => s.accById);
  const catById = useTicketStore((s) => s.catById);
  const curByCode = useTicketStore((s) => s.curByCode);
  const routes = useNodeStore((s) => s.routes);
  const ctx: ViewCtx = useMemo(() => ({ accById, catById, curByCode, ...routeCtx(routes) }), [accById, catById, curByCode, routes]);
  const [pop, setPop] = useState<ChipKey | null>(null);
  const close = useCallback(() => setPop(null), []);
  useEffect(() => {
    if (!searchOpen) setPop(null);
  }, [searchOpen]);
  // 浮層收起（Esc、單選挑完）時焦點若掉到 body ⇒ 還給那顆 chip（鍵盤接得下去；點外面收起時焦點已在別處，不搶）
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
  if (!searchOpen) return null;

  // chip 上的值：domain filterChips 的字去掉欄名前綴（「未掛路線」本身就是值）
  const vals: Partial<Record<keyof EntryFilter, string>> = {};
  for (const c of filterChips(filter, ctx)) vals[c.key] = c.label.replace(/^(期間|帳戶|分類|類型|路線) /, "");
  const routeVal = filter.routeId !== null && filter.routeId !== "none" ? routes.find((r) => r.id === filter.routeId) : undefined;
  const active = isFilterActive(filter);
  const dec = curByCode[MAIN_CURRENCY]?.decimals ?? 2;

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
            {pop === "period" && c.key === "period" && <PeriodPop f={filter} onClose={close} />}
            {pop === "acct" && c.key === "acct" && <AcctPop f={filter} onClose={close} />}
            {pop === "cat" && c.key === "cat" && <CatPop f={filter} onClose={close} />}
            {pop === "kind" && c.key === "kind" && <KindPop f={filter} onClose={close} />}
            {pop === "route" && c.key === "route" && <RoutePop f={filter} onClose={close} routes={routes} />}
          </span>
        );
      })}
      {/* 第六顆：排序（預設不亮，同其他 chip「沒設條件」的樣子） */}
      <span className="ns-tk-chipwrap">
        <button
          type="button"
          className={"ns-tk-fchip" + (resultSort !== DEFAULT_ENTRY_SORT ? " is-on" : "")}
          aria-expanded={pop === "sort"}
          data-pop-toggle
          data-chip="sort"
          onClick={() => setPop(pop === "sort" ? null : "sort")}
        >
          排序
          {resultSort !== DEFAULT_ENTRY_SORT && <b>{ENTRY_SORT_TEXT[resultSort]}</b>}
          <TkIcon name="caret" size={10} />
        </button>
        {pop === "sort" && <SortPop current={resultSort} onClose={close} />}
      </span>
      {active ? (
        // 摘要與「清除」綁在一起：chip 多一顆後窄欄會折行，兩個一起換到下一行靠右，不讓「清除」單獨落到行首
        <span className="ns-tk-foundwrap">
          <span className="ns-tk-found" aria-live="polite">
            {results ? resultSummary(results, dec) : "正在找…"}
          </span>
          <button
            type="button"
            className="ns-btn ns-btn--sm btn-ghost ns-tk-btn"
            title="清除全部條件"
            onClick={() => void useTicketStore.getState().patchFilter({ text: "", from: null, toExcl: null, accountId: null, categoryIds: [], kinds: [], routeId: null })}
          >
            清除
          </button>
        </span>
      ) : (
        <span className="ns-tk-found is-hint">打字或選條件就會開始找（預設找全部期間）</span>
      )}
    </div>
  );
}
