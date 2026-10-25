/**
 * 完整搜尋兩殼共用的零件（視覺真相＝prototypes/主線-完整搜尋.html；樣式在 ./full-search.css）：
 *   - 結果列（D-主-116）：類型徽章（同 Ctrl+P 的 ResultBadge）＋襯線名稱（命中高亮、済劃線＋朱「済」）＋淡字路線＋日期；
 *     命中在概要／乘務記錄 ⇒ 下一行「概要：…摘錄…」。列上不放操作鈕（桌機操作在側板、手機點了就跳）。
 *     桌機一行排完（grid 五欄）；手機兩行（名稱＋済／淡字路線＋日期）。
 *   - 篩選列（D-主-114）：狀態、種類＝分段單選；路線＝下拉 chip（選項由呼叫端開：桌機 PopMenu、手機底部 sheet）。
 *   - 統計行、搜尋框。
 */
import type { ReactNode, Ref } from "react";
import {
  excerptOf,
  splitHits,
  FIELD_LABEL,
  KIND_FILTER_LABEL,
  STATUS_FILTER_LABEL,
  type DateCell,
  type FullSearchFilter,
  type KindFilter,
  type StatusFilter,
} from "../../domain/fullSearch";
import { useSearchStore } from "../../store/searchStore";
import { ResultBadge } from "../common/QuickJump";
import { IconSearch } from "../common/icons";
import type { FullSearchRowModel, RouteOption } from "./useFullSearchResults";
import "./full-search.css";

/** 一段文字照命中切開、命中段包 <mark> */
function Marked({ text, term }: { text: string; term: string }) {
  return (
    <>
      {splitHits(text, term).map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}
    </>
  );
}

/** 日期欄：「締」「下一班」畫成淡字小標（締切的小標赭色）；過了還沒済整格赭色 */
function DateText({ cell }: { cell: DateCell | null }) {
  if (!cell) return <span className="ns-fs-date" />;
  return (
    <span className={`ns-fs-date${cell.tag === "締" ? " is-due" : ""}${cell.late ? " is-late" : ""}`}>
      {cell.tag && <span className="tg">{cell.tag}</span>}
      {cell.text}
    </span>
  );
}

function Excerpt({ row, term }: { row: FullSearchRowModel; term: string }) {
  const { hit } = row;
  if (hit.field === "name" || !hit.text) return null;
  return (
    <span className="ns-fs-x">
      <span className="src">{FIELD_LABEL[hit.field]}：</span>
      {excerptOf(hit.text, term).map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}
    </span>
  );
}

interface RowProps {
  row: FullSearchRowModel;
  term: string;
  id: string;
  active: boolean;
  onPick(): void;
  onGo?: () => void;
}

/** 桌機結果列（一行；摘錄在第二行） */
export function FullSearchRow({ row, term, id, active, onPick, onGo }: RowProps) {
  const { hit, done, context, date } = row;
  return (
    <li
      id={id}
      role="option"
      aria-selected={active}
      className={`ns-fs-row${active ? " is-active" : ""}${done ? " is-done" : ""}`}
      onClick={onPick}
      onDoubleClick={onGo}
    >
      <ResultBadge node={hit.node} done={done} />
      <span className="ns-fs-nl">
        <span className="ns-fs-name">
          <Marked text={hit.node.name} term={hit.field === "name" ? term : ""} />
        </span>
        {done && (
          <span className="ns-fs-seal" aria-label="已完成">
            済
          </span>
        )}
      </span>
      <span className="ns-fs-ctx">{context}</span>
      <DateText cell={date} />
      <Excerpt row={row} term={term} />
    </li>
  );
}

/** 手機結果列（兩行；點一下＝跳轉） */
export function FullSearchMobileRow({ row, term, id, active, onPick }: RowProps) {
  const { hit, done, context, date } = row;
  return (
    <li id={id} role="option" aria-selected={active} className={`ns-fs-mrow${done ? " is-done" : ""}`} onClick={onPick}>
      <ResultBadge node={hit.node} done={done} />
      <span className="min-w-0">
        <span className="l1">
          <span className="ns-fs-name">
            <Marked text={hit.node.name} term={hit.field === "name" ? term : ""} />
          </span>
          {done && (
            <span className="ns-fs-seal" aria-label="已完成">
              済
            </span>
          )}
        </span>
        <span className="l2">
          <span className="ctx">{context}</span>
          {date && <DateText cell={date} />}
        </span>
        <Excerpt row={row} term={term} />
      </span>
    </li>
  );
}

/** 大號底線搜尋框（左放大鏡、右「清除」或鍵帽提示） */
export function FullSearchField({
  inputRef,
  hint,
  autoFocus,
}: {
  inputRef?: Ref<HTMLInputElement>;
  /** 沒字時右側的提示（桌機＝Ctrl+Shift+F 鍵帽）；手機不給 */
  hint?: ReactNode;
  autoFocus?: boolean;
}) {
  const query = useSearchStore((s) => s.query);
  const setQuery = useSearchStore((s) => s.setQuery);
  return (
    <label className="ns-fs-field">
      <IconSearch />
      <input
        ref={inputRef}
        autoFocus={autoFocus}
        type="text"
        inputMode="search"
        enterKeyHint="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="找車票、路線、概要或乘務記錄…"
        spellCheck={false}
        autoComplete="off"
        aria-label="完整搜尋"
      />
      {query ? (
        <button
          type="button"
          className="ns-fs-clear"
          aria-label="清除搜尋字"
          title="清除（Esc）"
          onClick={(e) => {
            e.preventDefault();
            setQuery("");
            (e.currentTarget.parentElement?.querySelector("input") as HTMLInputElement | null)?.focus();
          }}
        >
          ×
        </button>
      ) : (
        hint && <span className="ns-fs-keys">{hint}</span>
      )}
    </label>
  );
}

const STATUS_OPTS: readonly StatusFilter[] = ["all", "open", "done"];
const KIND_OPTS: readonly KindFilter[] = ["all", "ticket", "tree"];

/** 一組分段單選（篩選）；「済」那一段用朱色襯線字，跟清單上的済同一個字 */
function SegGroup<V extends string>({
  label,
  options,
  text,
  value,
  onChange,
}: {
  label: string;
  options: readonly V[];
  text: Record<V, string>;
  value: V;
  onChange(v: V): void;
}) {
  return (
    <span className="ns-fs-fgrp">
      <span className="lb" aria-hidden>
        {label}
      </span>
      <span className="ns-fs-seg" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button key={o} type="button" role="radio" aria-checked={value === o} onClick={() => onChange(o)}>
            {text[o] === "済" ? <span className="sl">済</span> : text[o]}
          </button>
        ))}
      </span>
    </span>
  );
}

/** 路線 chip 上的字 */
export function routeFilterText(route: FullSearchFilter["route"], options: readonly RouteOption[], routeName: (id: string) => string | undefined) {
  if (route === "all") return "全部";
  if (route === "temp") return "臨時車票";
  return options.find((r) => r.id === route.routeId)?.name ?? routeName(route.routeId) ?? "（已刪除）";
}

/** 三組篩選；路線 chip 按下去由呼叫端開選單（`onRoute` 拿到 chip 按鈕） */
export function FullSearchFilters({
  routeText,
  routeOpen,
  onRoute,
  separators,
}: {
  routeText: string;
  routeOpen: boolean;
  onRoute(anchor: HTMLButtonElement): void;
  /** 手機橫向 chip 列：組與組之間畫虛線小隔 */
  separators?: boolean;
}) {
  const filter = useSearchStore((s) => s.filter);
  const setFilter = useSearchStore((s) => s.setFilter);
  const gap = separators ? <span className="ns-fs-gap" aria-hidden /> : null;
  return (
    <div className="ns-fs-filters">
      <SegGroup label="狀態" options={STATUS_OPTS} text={STATUS_FILTER_LABEL} value={filter.status} onChange={(status) => setFilter({ status })} />
      {gap}
      <SegGroup label="種類" options={KIND_OPTS} text={KIND_FILTER_LABEL} value={filter.kind} onChange={(kind) => setFilter({ kind })} />
      {gap}
      <span className="ns-fs-fgrp">
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={routeOpen}
          className={`ns-fs-fchip${filter.route !== "all" ? " is-on" : ""}`}
          onClick={(e) => onRoute(e.currentTarget)}
        >
          路線 <b>{routeText}</b>
          <span className="chev" aria-hidden>
            ▾
          </span>
        </button>
      </span>
    </div>
  );
}

/** 統計行：「找到 N 件」（有篩選再補「・全部 M 件」＋清除篩選）；右側排序說明（桌機） */
export function FullSearchStats({
  count,
  total,
  filtered,
  pending,
  showOrder,
}: {
  count: number;
  total: number;
  filtered: boolean;
  pending: boolean;
  showOrder?: boolean;
}) {
  const resetFilter = useSearchStore((s) => s.resetFilter);
  return (
    <div className="ns-fs-stats" role="status">
      {pending ? (
        <span>搜尋中…</span>
      ) : (
        <span>
          找到<b>{count}</b>件{filtered && <>・全部 {total} 件</>}
        </span>
      )}
      {filtered && (
        <button type="button" className="btn-text" onClick={resetFilter}>
          清除篩選
        </button>
      )}
      {showOrder && <span className="ord">名稱 → 概要 → 乘務記錄</span>}
    </div>
  );
}

/** 清單尾：還有就畫哨兵（接下一批），沒有就畫「共 N 件・到底了」 */
export function ListTail({ more, total, sentinelRef }: { more: boolean; total: number; sentinelRef: Ref<HTMLDivElement> }) {
  return more ? (
    <div ref={sentinelRef} className="ns-fs-more">
      往下捲，接著載入
    </div>
  ) : (
    <div className="ns-fs-end">共 {total} 件・到底了</div>
  );
}
