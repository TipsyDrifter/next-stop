/**
 * MobileFilterBar——售票口手機清單視圖頂部常駐篩選與排序列（v1.32 2B-2）。
 *
 * 免進獨立搜尋頁即可一鍵點選：
 *   - 左側橫向輕巧捲動 `.ns-tk-m-fbar-scroll`：`分類 ｜ 路線 ｜ 帳戶 ｜ #荷札 ｜ 類型 ｜ 搜尋／期間`
 *   - 右端常駐排序鈕 `.ns-tk-m-fsort`：`日期・新到舊 ｜ 日期・舊到新 ｜ 金額・大到小 ｜ 金額・小到大`
 *   - 當月直篩作用中或跨月搜尋中時，下方附 `.ns-tk-m-fsum` 篩選筆數／收支小計與「清除」鈕。
 *
 * 嚴守手機觸控與 `useBackLayer`：各挑選抽屜走共用 `MSheet`（`backId="ticket.mfilter"`），返回鍵一次收起。
 */
import { Fragment, useEffect, useMemo, useState } from "react";
import { useTicketStore } from "../../../store/ticketStore";
import { useNodeStore } from "../../../store/nodeStore";
import { groupRoutesByLine } from "../../notes/useAttachOptions";
import { useTagStore } from "../../../store/tagStore";
import { TK_TAG_ENTRY, entityTagMap, tagNameOf } from "../../../domain/ticketTags";
import {
  archivedAccounts,
  categorySubtreeIds,
  groupAccounts,
  type CategoryKind,
  type EntryKind,
} from "../../../domain/ticket";
import {
  DEFAULT_ENTRY_SORT,
  ENTRY_SORTS,
  ENTRY_SORT_TEXT,
  filterChips,
  isFilterActive,
  isInMonthFilterActive,
  routeCtx,
  type EntryFilter,
  type ViewCtx,
} from "../../../domain/ticketView";
import { roundelStyle } from "../../common/roundel";
import { MSheet } from "../../common/MSheet";
import { IconChevron } from "../../common/icons";
import { useBackLayer } from "../../mobile/backStack";
import { FILTER_KINDS } from "../view/FilterChips";
import { chooseSort } from "../view/sortChoice";
import { MobileCatDrill } from "./MobileCatDrill";
import { IconSearch } from "./MobileSearchSheet";

type PickerKind = "cat" | "route" | "acct" | "tag" | "kind" | "sort";

export interface MobileFilterBarProps {
  searching: boolean;
  summaryText: string | null;
  onOpenSearchSheet(): void;
}

export function MobileFilterBar({ searching, summaryText, onOpenSearchSheet }: MobileFilterBarProps) {
  const searchOpen = useTicketStore((s) => s.searchOpen);
  const filter = useTicketStore((s) => s.filter);
  const listFilter = useTicketStore((s) => s.listFilter);
  const listSort = useTicketStore((s) => s.listSort);
  const resultSort = useTicketStore((s) => s.resultSort);
  const filterAccountId = useTicketStore((s) => s.filterAccountId);
  const accounts = useTicketStore((s) => s.accounts);
  const categories = useTicketStore((s) => s.categories);
  const accById = useTicketStore((s) => s.accById);
  const catById = useTicketStore((s) => s.catById);
  const curByCode = useTicketStore((s) => s.curByCode);
  const lines = useNodeStore((s) => s.lines);
  const routes = useNodeStore((s) => s.routes);
  const tagIndex = useTagStore((s) => s.index);

  const [picker, setPicker] = useState<PickerKind | null>(null);
  const [catLevel, setCatLevel] = useState<Record<CategoryKind, string | null>>({ expense: null, income: null });

  useBackLayer("ticket.mfilter", picker !== null, () => setPicker(null));

  useEffect(() => {
    if (picker !== "tag") return;
    const ts = useTagStore.getState();
    if (!ts.index && !ts.loading) void ts.loadIndex();
  }, [picker]);

  const effectiveFilter: EntryFilter = useMemo(
    () => (searchOpen ? filter : { ...listFilter, accountId: listFilter.accountId ?? filterAccountId }),
    [searchOpen, filter, listFilter, filterAccountId],
  );

  const ctx: ViewCtx = useMemo(
    () => ({ accById, catById, curByCode, ...routeCtx(routes), tagName: tagNameOf(tagIndex) }),
    [accById, catById, curByCode, routes, tagIndex],
  );

  const vals: Partial<Record<keyof EntryFilter, string>> = {};
  for (const c of filterChips(effectiveFilter, ctx)) {
    vals[c.key] = c.label.replace(/^(期間|帳戶|分類|類型|路線|荷札) #?/, "");
  }

  const patchFacet = (p: Partial<EntryFilter>) => {
    const st = useTicketStore.getState();
    if (st.searchOpen) void st.patchFilter(p);
    else void st.patchListFilter(p);
  };

  const toggleCat = (id: string) => {
    const sel = effectiveFilter.categoryIds;
    if (sel.indexOf(id) >= 0) {
      patchFacet({ categoryIds: sel.filter((x) => x !== id) });
      return;
    }
    const under = new Set(categorySubtreeIds(id, categories));
    patchFacet({ categoryIds: [...sel.filter((x) => !under.has(x)), id] });
  };

  const toggleKind = (k: EntryKind) => {
    const sel = effectiveFilter.kinds;
    const has = sel.indexOf(k) >= 0;
    patchFacet({ kinds: has ? sel.filter((x) => x !== k) : [...sel, k] });
  };

  const tagKeys = effectiveFilter.tagKeys ?? [];
  const usedTags = useMemo(() => {
    const keys = new Set<string>();
    for (const ks of Object.values(entityTagMap(tagIndex, TK_TAG_ENTRY))) {
      for (const k of ks) {
        for (let cur: string | null = k; cur && !keys.has(cur); cur = tagIndex?.byKey[cur]?.parent ?? null) keys.add(cur);
      }
    }
    for (const k of tagKeys) keys.add(k);
    return [...keys].sort();
  }, [tagIndex, tagKeys]);
  const tagLabel = tagNameOf(tagIndex);
  const toggleTag = (k: string) => {
    const has = tagKeys.indexOf(k) >= 0;
    patchFacet({ tagKeys: has ? tagKeys.filter((x) => x !== k) : [...tagKeys, k] });
  };

  const pickAcct = (id: string | null) => {
    const st = useTicketStore.getState();
    if (st.searchOpen) void st.patchFilter({ accountId: id });
    else void st.setFilter(id);
    setPicker(null);
  };

  const pickRoute = (id: string | null | "none") => {
    patchFacet({ routeId: id });
    setPicker(null);
  };

  const openCrossMonthSearch = () => {
    const st = useTicketStore.getState();
    if (!st.searchOpen && isInMonthFilterActive(st.listFilter, st.listSort, st.filterAccountId)) {
      void st.promoteListFilterToSearch();
    }
    onOpenSearchSheet();
  };

  const currentSort = searchOpen ? resultSort : listSort;
  const sortOn = currentSort !== DEFAULT_ENTRY_SORT;
  const routeVal =
    effectiveFilter.routeId !== null && effectiveFilter.routeId !== "none"
      ? routes.find((r) => r.id === effectiveFilter.routeId)
      : undefined;
  const liveAccts = groupAccounts(accounts).flatMap((g) => g.accounts);
  const archivedAccts = archivedAccounts(accounts);
  const liveRoutes = useMemo(() => routes.filter((r) => r.deleted_at === null), [routes]);
  const routeGroups = useMemo(() => groupRoutesByLine(liveRoutes, lines), [liveRoutes, lines]);
  const searchChipActive = searching && (filter.text.trim() !== "" || filter.from !== null || filter.toExcl !== null);
  const searchChipVal =
    filter.text.trim() !== "" ? `「${filter.text.trim()}」` : vals.from ? vals.from : null;

  const closePicker = () => setPicker(null);
  const clearAll = () => {
    const st = useTicketStore.getState();
    if (st.searchOpen && isFilterActive(st.filter)) st.closeSearch();
    else st.clearListFilter();
  };

  return (
    <>
      <div className="ns-tk-m-fbar" role="group" aria-label="篩選與排序">
        <div className="ns-tk-m-fbar-scroll">
          <button
            type="button"
            className={"chip ns-chip ns-tk-mfchip" + (vals.categoryIds ? " is-on" : "")}
            aria-haspopup="dialog"
            aria-expanded={picker === "cat"}
            onClick={() => {
              setCatLevel({ expense: null, income: null });
              setPicker("cat");
            }}
          >
            分類{vals.categoryIds && <b>{vals.categoryIds}</b>}
          </button>

          <button
            type="button"
            className={"chip ns-chip ns-tk-mfchip" + (vals.routeId ? " is-on" : "")}
            aria-haspopup="dialog"
            aria-expanded={picker === "route"}
            onClick={() => setPicker("route")}
          >
            路線
            {vals.routeId && (
              <b>
                {routeVal ? (
                  <>
                    <span className="roundel" aria-hidden style={roundelStyle(routeVal.color)}>
                      {routeVal.code ?? routeVal.name.slice(0, 1)}
                    </span>
                    {routeVal.name}
                  </>
                ) : (
                  vals.routeId
                )}
              </b>
            )}
          </button>

          <button
            type="button"
            className={"chip ns-chip ns-tk-mfchip" + (vals.accountId ? " is-on" : "")}
            aria-haspopup="dialog"
            aria-expanded={picker === "acct"}
            onClick={() => setPicker("acct")}
          >
            帳戶{vals.accountId && <b>{vals.accountId}</b>}
          </button>

          <button
            type="button"
            className={"chip ns-chip ns-tk-mfchip" + (vals.tagKeys ? " is-on" : "")}
            aria-haspopup="dialog"
            aria-expanded={picker === "tag"}
            onClick={() => setPicker("tag")}
          >
            #荷札{vals.tagKeys && <b>{vals.tagKeys}</b>}
          </button>

          <button
            type="button"
            className={"chip ns-chip ns-tk-mfchip" + (vals.kinds ? " is-on" : "")}
            aria-haspopup="dialog"
            aria-expanded={picker === "kind"}
            onClick={() => setPicker("kind")}
          >
            類型{vals.kinds && <b>{vals.kinds}</b>}
          </button>

          <button
            type="button"
            className={"chip ns-chip ns-tk-mfchip" + (searchChipActive ? " is-on" : "")}
            aria-haspopup="dialog"
            onClick={openCrossMonthSearch}
          >
            <IconSearch size={13} />
            {searchChipVal ? <b>{searchChipVal}</b> : "搜尋／期間"}
          </button>
        </div>

        <button
          type="button"
          className={"ns-btn btn-ghost ns-btn--sm ns-tk-mfsort ns-tk-m-fsort" + (sortOn ? " is-on" : "")}
          aria-haspopup="dialog"
          aria-expanded={picker === "sort"}
          title={`排序：${ENTRY_SORT_TEXT[currentSort]}`}
          onClick={() => setPicker("sort")}
        >
          {sortOn ? ENTRY_SORT_TEXT[currentSort] : "排序"}
          <IconChevron open />
        </button>
      </div>

      {summaryText && (
        <div className="ns-tk-m-fsum" role="status">
          <span className="txt">{summaryText}</span>
          <button type="button" className="ns-btn btn-text ns-btn--sm" onClick={clearAll}>
            清除
          </button>
        </div>
      )}

      {picker === "cat" && (
        <MSheet
          title="篩選分類"
          height="full"
          backId="ticket.mfilter"
          onClose={closePicker}
          className="ns-tk-msh ns-tk-msearch-sheet"
          foot={
            <>
              <button
                type="button"
                className="ns-btn btn-ghost"
                disabled={effectiveFilter.categoryIds.length === 0}
                onClick={() => patchFacet({ categoryIds: [] })}
              >
                清除分類
              </button>
              <button type="button" className="ns-btn btn-ghost" onClick={closePicker}>
                完成
              </button>
            </>
          }
        >
          <div className="ns-tk-ms-secs">
            <div className="ns-tk-ms-sec">
              <p className="ns-tk-ms-sub">支出</p>
              <MobileCatDrill
                kind="expense"
                level={catLevel.expense}
                onLevel={(id) => setCatLevel((m) => ({ ...m, expense: id }))}
                picked={effectiveFilter.categoryIds}
                multi
                onPick={(c) => toggleCat(c.id)}
                rootLabel="支出"
                backId="ticket.mfilter.cat.expense"
                backKind="dialog"
              />
              <p className="ns-tk-ms-sub">收入</p>
              <MobileCatDrill
                kind="income"
                level={catLevel.income}
                onLevel={(id) => setCatLevel((m) => ({ ...m, income: id }))}
                picked={effectiveFilter.categoryIds}
                multi
                onPick={(c) => toggleCat(c.id)}
                rootLabel="收入"
                backId="ticket.mfilter.cat.income"
                backKind="dialog"
              />
            </div>
          </div>
        </MSheet>
      )}

      {picker === "route" && (
        <MSheet list title="篩選路線" backId="ticket.mfilter" onClose={closePicker} className="ns-tk-msh">
          <button
            type="button"
            className={"ns-msheet-item" + (effectiveFilter.routeId === null ? " is-on" : "")}
            aria-pressed={effectiveFilter.routeId === null}
            onClick={() => pickRoute(null)}
          >
            全部路線
          </button>
          <button
            type="button"
            className={"ns-msheet-item" + (effectiveFilter.routeId === "none" ? " is-on" : "")}
            aria-pressed={effectiveFilter.routeId === "none"}
            onClick={() => pickRoute("none")}
          >
            未掛路線
          </button>
          {routeGroups.map((g) => (
            <Fragment key={g.lineId ?? "other"}>
              <div role="presentation" className="ns-tk-mf-rgroup">
                {g.header}
              </div>
              {g.routes.map((r) => {
                const on = effectiveFilter.routeId === r.id;
                return (
                  <button
                    key={r.id}
                    type="button"
                    className={"ns-msheet-item" + (on ? " is-on" : "")}
                    aria-pressed={on}
                    onClick={() => pickRoute(r.id)}
                  >
                    <span className="ns-tk-mf-ritem">
                      <span className="roundel" aria-hidden style={roundelStyle(r.color)}>
                        {r.code ?? r.name.slice(0, 1)}
                      </span>
                      {r.name}
                    </span>
                  </button>
                );
              })}
            </Fragment>
          ))}
        </MSheet>
      )}

      {picker === "acct" && (
        <MSheet list title="篩選帳戶" backId="ticket.mfilter" onClose={closePicker} className="ns-tk-msh">
          <button
            type="button"
            className={"ns-msheet-item" + (effectiveFilter.accountId === null ? " is-on" : "")}
            aria-pressed={effectiveFilter.accountId === null}
            onClick={() => pickAcct(null)}
          >
            全部帳戶
          </button>
          {liveAccts.map((a) => {
            const on = effectiveFilter.accountId === a.id;
            return (
              <button
                key={a.id}
                type="button"
                className={"ns-msheet-item" + (on ? " is-on" : "")}
                aria-pressed={on}
                onClick={() => pickAcct(a.id)}
              >
                {a.name}
              </button>
            );
          })}
          {archivedAccts.map((a) => {
            const on = effectiveFilter.accountId === a.id;
            return (
              <button
                key={a.id}
                type="button"
                className={"ns-msheet-item" + (on ? " is-on" : "")}
                aria-pressed={on}
                onClick={() => pickAcct(a.id)}
              >
                {a.name}
                <small>封存</small>
              </button>
            );
          })}
        </MSheet>
      )}

      {picker === "tag" && (
        <MSheet
          title="篩選 #荷札"
          backId="ticket.mfilter"
          onClose={closePicker}
          className="ns-tk-msh ns-tk-msearch-sheet"
          foot={
            <>
              <button
                type="button"
                className="ns-btn btn-ghost"
                disabled={tagKeys.length === 0}
                onClick={() => patchFacet({ tagKeys: [] })}
              >
                清除荷札
              </button>
              <button type="button" className="ns-btn btn-ghost" onClick={closePicker}>
                完成
              </button>
            </>
          }
        >
          <div className="ns-tk-ms-secs">
            {tagIndex === null ? (
              <p className="ns-tk-ms-sub">正在讀荷札…</p>
            ) : usedTags.length === 0 ? (
              <p className="ns-tk-ms-sub">還沒有帳掛荷札</p>
            ) : (
              <div className="ns-tk-mchips">
                {usedTags.map((k) => {
                  const on = tagKeys.indexOf(k) >= 0;
                  return (
                    <button
                      key={k}
                      type="button"
                      className={"ns-tk-mchip" + (on ? " on" : "")}
                      aria-pressed={on}
                      onClick={() => toggleTag(k)}
                    >
                      #{tagLabel(k).split("/").join(" / ")}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </MSheet>
      )}

      {picker === "kind" && (
        <MSheet
          title="篩選類型"
          backId="ticket.mfilter"
          onClose={closePicker}
          className="ns-tk-msh ns-tk-msearch-sheet"
          foot={
            <>
              <button
                type="button"
                className="ns-btn btn-ghost"
                disabled={effectiveFilter.kinds.length === 0}
                onClick={() => patchFacet({ kinds: [] })}
              >
                清除類型
              </button>
              <button type="button" className="ns-btn btn-ghost" onClick={closePicker}>
                完成
              </button>
            </>
          }
        >
          <div className="ns-tk-ms-secs">
            <div className="ns-tk-mchips">
              {FILTER_KINDS.map((x) => {
                const on = effectiveFilter.kinds.indexOf(x.k) >= 0;
                return (
                  <button
                    key={x.k}
                    type="button"
                    className={"ns-tk-mchip" + (on ? " on" : "")}
                    aria-pressed={on}
                    onClick={() => toggleKind(x.k)}
                  >
                    {x.label}
                  </button>
                );
              })}
            </div>
          </div>
        </MSheet>
      )}

      {picker === "sort" && (
        <MSheet list title="排序" backId="ticket.mfilter" onClose={closePicker} className="ns-tk-msh">
          {ENTRY_SORTS.map((k) => {
            const on = currentSort === k;
            return (
              <button
                key={k}
                type="button"
                className={"ns-msheet-item" + (on ? " is-on" : "")}
                aria-pressed={on}
                onClick={() => {
                  closePicker();
                  if (!on) chooseSort(k);
                }}
              >
                {ENTRY_SORT_TEXT[k]}
              </button>
            );
          })}
        </MSheet>
      )}
    </>
  );
}
