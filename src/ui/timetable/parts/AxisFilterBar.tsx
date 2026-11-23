/**
 * AxisFilterBar——時刻表「時間軸／兩欄右軸」的篩選與排序列（v1.32 2B-2）。
 *
 * 兩殼共用：
 *   - 左側篩選群：`分類 ▾`、`路線 ▾`（含未掛路線、路線與支線）、`#荷札 ▾`（組合交集）、精巧關鍵字搜尋框
 *   - 右側排序鈕：`排序 ▾`（早→晚／新→舊／長→短／短→長）
 *   - 桌機：排序用共用 `PopMenu`；多選／樹狀挑選用錨定 `.techo-card` 浮層（`placeBelow` ＋ `useOutsideDismiss`）
 *   - 手機：一律開共用 `MSheet`（內建 `useBackLayer` 返回鍵登記）
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { NodeRow } from "../../../domain/node";
import type { TimeCategoryRow } from "../../../domain/timetable";
import {
  NO_ROUTE_FILTER,
  TIMETABLE_SORT_OPTIONS,
} from "../../../domain/timetableFilter";
import { collectAvailableTags } from "../../../domain/notesFilter";
import { isMobileShell } from "../../../lib/shell";
import { useNodeStore } from "../../../store/nodeStore";
import { useTagStore } from "../../../store/tagStore";
import { useTimetableStore } from "../../../store/timetableStore";
import { placeBelow, useOutsideDismiss } from "../../common/anchorPop";
import { IconChevron, IconClose, IconSearch } from "../../common/icons";
import { MSheet, MSheetItem } from "../../common/MSheet";
import { PopMenu, type PopMenuItem } from "../../common/PopMenu";
import { groupRoutesByLine } from "../../notes/useAttachOptions";
import { CategoryBadge } from "../CategoryBadge";
import { RouteRoundel } from "./LinkPicker";
import { tagNameOf } from "./TimetableTagChips";

type OpenMenu = "cat" | "route" | "tag" | "sort" | null;

interface AnchoredPopProps {
  anchor: HTMLElement | null;
  label: string;
  onClose: () => void;
  children: ReactNode;
}

function AnchoredPop({ anchor, label, onClose, children }: AnchoredPopProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useOutsideDismiss(ref, onClose, anchor);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !anchor) return;
    const p = placeBelow(anchor, el);
    if (p) setPos(p);
  }, [anchor, children]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.ctrlKey || e.metaKey) return;
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      anchor?.focus({ preventScroll: true });
    }
  };

  return createPortal(
    <div
      ref={ref}
      role="group"
      aria-label={label}
      onKeyDown={onKeyDown}
      onMouseDown={(e) => e.stopPropagation()}
      className="techo-card ns-tt-fpop"
      style={{
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
        visibility: pos ? "visible" : "hidden",
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

export function AxisFilterBar() {
  const categories = useTimetableStore((s) => s.categories);
  const catById = useTimetableStore((s) => s.catById);
  const axisFilter = useTimetableStore((s) => s.axisFilter);
  const axisBranchNodeIds = useTimetableStore((s) => s.axisBranchNodeIds);
  const linkInfo = useTimetableStore((s) => s.linkInfo);
  const setAxisFilter = useTimetableStore((s) => s.setAxisFilter);
  const toggleAxisCategory = useTimetableStore((s) => s.toggleAxisCategory);
  const toggleAxisTagKey = useTimetableStore((s) => s.toggleAxisTagKey);
  const setAxisRouteFilter = useTimetableStore((s) => s.setAxisRouteFilter);

  const liveLines = useNodeStore((s) => s.liveLines);
  const liveRoutes = useNodeStore((s) => s.liveRoutes);
  const routeGroups = useMemo(() => groupRoutesByLine(liveRoutes, liveLines), [liveRoutes, liveLines]);
  const tagIndex = useTagStore((s) => s.index);

  useEffect(() => {
    const ts = useTagStore.getState();
    if (!ts.index && !ts.loading) void ts.loadIndex();
  }, []);

  const [openMenu, setOpenMenu] = useState<OpenMenu>(null);
  const closeMenu = useCallback(() => {
    setOpenMenu(null);
    setTagSearch("");
  }, []);

  const catBtnRef = useRef<HTMLButtonElement>(null);
  const routeBtnRef = useRef<HTMLButtonElement>(null);
  const tagBtnRef = useRef<HTMLButtonElement>(null);
  const sortBtnRef = useRef<HTMLButtonElement>(null);

  /* ── 關鍵字搜尋（支援中文組字 IME，不搶時刻表單鍵快捷鍵） ── */
  const [draftQuery, setDraftQuery] = useState(axisFilter.query);
  const composingRef = useRef(false);

  useEffect(() => {
    if (!composingRef.current) setDraftQuery(axisFilter.query);
  }, [axisFilter.query]);

  /* ── 分類階層整理（分組 → 子分類） ── */
  const catGroups = useMemo(() => {
    const selectedSet = new Set(axisFilter.categoryIds);
    const live = categories.filter(
      (c) => c.deleted_at === null && (c.archived_at === null || selectedSet.has(c.id)),
    );
    const groups = live.filter((c) => c.parent_id === null);
    const byParent = new Map<string, TimeCategoryRow[]>();
    const orphans: TimeCategoryRow[] = [];
    for (const c of live) {
      if (c.parent_id === null) continue;
      if (groups.some((g) => g.id === c.parent_id)) {
        const list = byParent.get(c.parent_id) ?? [];
        list.push(c);
        byParent.set(c.parent_id, list);
      } else {
        orphans.push(c);
      }
    }
    return { groups, byParent, orphans };
  }, [categories, axisFilter.categoryIds]);

  /* ── 路線與支線展開清單（打開選單時載入各活路線底下的活支線） ── */
  const [branchesByRoute, setBranchesByRoute] = useState<Record<string, NodeRow[]>>({});
  useEffect(() => {
    if (openMenu !== "route") return;
    let alive = true;
    void (async () => {
      const store = useTimetableStore.getState();
      const entries = await Promise.all(
        liveRoutes.map(async (r) => {
          try {
            const nodes = await store.routeNodes(r.id);
            const branches = nodes
              .filter((n) => n.kind === "branch" && n.deleted_at === null && n.arrived_on === null)
              .sort((a, b) => a.position - b.position);
            return [r.id, branches] as const;
          } catch {
            return [r.id, [] as NodeRow[]] as const;
          }
        }),
      );
      if (!alive) return;
      setBranchesByRoute(Object.fromEntries(entries));
    })();
    return () => {
      alive = false;
    };
  }, [openMenu, liveRoutes]);

  /* ── 可選荷札清單（時刻表塊與分類預設荷札，含父層階層） ── */
  const [tagSearch, setTagSearch] = useState("");
  const tagComposingRef = useRef(false);
  useEffect(() => {
    if (openMenu !== "tag") setTagSearch("");
  }, [openMenu]);

  const availableTags = useMemo(
    () =>
      collectAvailableTags(tagIndex, {
        entityTypes: ["timetable:block", "timetable:category"],
        selectedKeys: axisFilter.tagKeys,
      }),
    [tagIndex, axisFilter.tagKeys],
  );

  const visibleTags = useMemo(() => {
    const q = tagSearch.trim().toLowerCase();
    if (!q) return availableTags;
    const clean = q.startsWith("#") ? q.slice(1) : q;
    return availableTags.filter(
      (t) => t.name.toLowerCase().includes(clean) || t.key.toLowerCase().includes(clean),
    );
  }, [availableTags, tagSearch]);

  /* ── 按鈕標籤摘要 ── */
  const catBtnLabel = useMemo(() => {
    const ids = axisFilter.categoryIds;
    if (ids.length === 0) return "分類";
    if (ids.length === 1) return catById[ids[0]]?.name ?? "分類";
    return `分類 ${ids.length}`;
  }, [axisFilter.categoryIds, catById]);

  const routeBtnLabel = useMemo(() => {
    const rid = axisFilter.routeId;
    if (rid === null) return "路線";
    if (rid === NO_ROUTE_FILTER) return "未掛路線";
    const routeHit = liveRoutes.find((r) => r.id === rid);
    if (routeHit) return routeHit.name;
    const isBranch = rid in axisBranchNodeIds || linkInfo[rid]?.kind === "branch";
    const infoName = linkInfo[rid]?.name;
    if (infoName) return isBranch ? `› ${infoName}` : infoName;
    for (const bs of Object.values(branchesByRoute)) {
      const b = bs.find((x) => x.id === rid);
      if (b) return `› ${b.name}`;
    }
    return "路線";
  }, [axisFilter.routeId, liveRoutes, axisBranchNodeIds, linkInfo, branchesByRoute]);

  const tagBtnLabel = useMemo(() => {
    const keys = axisFilter.tagKeys;
    if (keys.length === 0) return "#荷札";
    if (keys.length === 1) return `#${tagNameOf(keys[0])}`;
    return `#荷札 ${keys.length}`;
  }, [axisFilter.tagKeys]);

  const currentSortOpt =
    TIMETABLE_SORT_OPTIONS.find((o) => o.value === axisFilter.sort) ?? TIMETABLE_SORT_OPTIONS[0];
  const sortBtnLabel = axisFilter.sort === "timeAsc" ? "排序" : currentSortOpt.shortLabel;

  const toggleMenu = (m: Exclude<OpenMenu, null>) => {
    setOpenMenu((cur) => (cur === m ? null : m));
  };

  const mobile = isMobileShell();

  const sortMenuItems = useMemo<PopMenuItem[]>(
    () =>
      TIMETABLE_SORT_OPTIONS.map((o) => ({
        key: o.value,
        label: `${axisFilter.sort === o.value ? "✓ " : ""}${o.label}`,
        onSelect: () => setAxisFilter({ sort: o.value }),
      })),
    [axisFilter.sort, setAxisFilter],
  );

  /* ── 三個篩選面板內容（桌機浮層與手機 MSheet 共用） ── */
  const categoryBody = (
    <div className="ns-tt-fpop-body">
      <div className="ns-tt-fpop-head">
        <span className="techo-overline">篩選分類（可複選）</span>
        {axisFilter.categoryIds.length > 0 && (
          <button
            type="button"
            className="ns-btn btn-text ns-btn--sm"
            onClick={() => setAxisFilter({ categoryIds: [] })}
          >
            清除
          </button>
        )}
      </div>
      <div className="ns-tt-fpop-scroll">
        {catGroups.groups.map((g) => {
          const groupOn = axisFilter.categoryIds.includes(g.id);
          const kids = catGroups.byParent.get(g.id) ?? [];
          return (
            <div key={g.id} className="ns-tt-fcat-grp">
              <button
                type="button"
                className={"ns-tt-fopt is-group" + (groupOn ? " is-on" : "")}
                aria-pressed={groupOn}
                onClick={() => toggleAxisCategory(g.id)}
              >
                <span className="ns-tt-fopt-check" aria-hidden="true">
                  {groupOn ? "✓" : ""}
                </span>
                <span className="ns-tt-fopt-name">{g.name}</span>
                <span className="ns-tt-fopt-hint">整組</span>
              </button>
              {kids.map((c) => {
                const on = axisFilter.categoryIds.includes(c.id);
                return (
                  <button
                    key={c.id}
                    type="button"
                    className={"ns-tt-fopt is-child" + (on || groupOn ? " is-on" : "")}
                    aria-pressed={on}
                    onClick={() => toggleAxisCategory(c.id)}
                  >
                    <span className="ns-tt-fopt-check" aria-hidden="true">
                      {on ? "✓" : groupOn ? "·" : ""}
                    </span>
                    <CategoryBadge cat={c} size="sm" />
                    <span className="ns-tt-fopt-name">{c.name}</span>
                  </button>
                );
              })}
            </div>
          );
        })}
        {catGroups.orphans.map((c) => {
          const on = axisFilter.categoryIds.includes(c.id);
          return (
            <button
              key={c.id}
              type="button"
              className={"ns-tt-fopt" + (on ? " is-on" : "")}
              aria-pressed={on}
              onClick={() => toggleAxisCategory(c.id)}
            >
              <span className="ns-tt-fopt-check" aria-hidden="true">
                {on ? "✓" : ""}
              </span>
              <CategoryBadge cat={c} size="sm" />
              <span className="ns-tt-fopt-name">{c.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );

  const routeBody = (
    <div className="ns-tt-fpop-body">
      <div className="ns-tt-fpop-head">
        <span className="techo-overline">篩選路線或支線</span>
      </div>
      <div className="ns-tt-fpop-scroll">
        <button
          type="button"
          className={"ns-tt-fopt" + (axisFilter.routeId === null ? " is-on" : "")}
          aria-pressed={axisFilter.routeId === null}
          onClick={() => {
            void setAxisRouteFilter(null, false);
            closeMenu();
          }}
        >
          <span className="ns-tt-fopt-check" aria-hidden="true">
            {axisFilter.routeId === null ? "✓" : ""}
          </span>
          <span className="ns-tt-fopt-name">全部路線</span>
        </button>
        <button
          type="button"
          className={"ns-tt-fopt" + (axisFilter.routeId === NO_ROUTE_FILTER ? " is-on" : "")}
          aria-pressed={axisFilter.routeId === NO_ROUTE_FILTER}
          onClick={() => {
            void setAxisRouteFilter(NO_ROUTE_FILTER, false);
            closeMenu();
          }}
        >
          <span className="ns-tt-fopt-check" aria-hidden="true">
            {axisFilter.routeId === NO_ROUTE_FILTER ? "✓" : ""}
          </span>
          <RouteRoundel route={null} />
          <span className="ns-tt-fopt-name">未掛路線</span>
        </button>
        {routeGroups.map((lg) => (
          <div key={lg.lineId ?? "other"} className="ns-tt-fline-sec">
            <div className="ns-tt-fline-hd">{lg.header}</div>
            {lg.routes.map((r) => {
              const rOn = axisFilter.routeId === r.id;
              const branches = branchesByRoute[r.id] ?? [];
              return (
                <div key={r.id} className="ns-tt-fcat-grp">
                  <button
                    type="button"
                    className={"ns-tt-fopt" + (rOn ? " is-on" : "")}
                    aria-pressed={rOn}
                    onClick={() => {
                      void setAxisRouteFilter(r.id, false);
                      closeMenu();
                    }}
                  >
                    <span className="ns-tt-fopt-check" aria-hidden="true">
                      {rOn ? "✓" : ""}
                    </span>
                    <RouteRoundel route={r} />
                    <span className="ns-tt-fopt-name">{r.name}</span>
                  </button>
                  {branches.map((b) => {
                    const bOn = axisFilter.routeId === b.id;
                    return (
                      <button
                        key={b.id}
                        type="button"
                        className={"ns-tt-fopt is-branch" + (bOn ? " is-on" : "")}
                        aria-pressed={bOn}
                        onClick={() => {
                          void setAxisRouteFilter(b.id, true);
                          closeMenu();
                        }}
                      >
                        <span className="ns-tt-fopt-check" aria-hidden="true">
                          {bOn ? "✓" : ""}
                        </span>
                        <span className="ns-tt-fopt-branchmark" aria-hidden="true">
                          ›
                        </span>
                        <span className="ns-tt-fopt-name">{b.name}</span>
                        <span className="ns-tt-fopt-hint">支線</span>
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );

  const tagBody = (
    <div className="ns-tt-fpop-body">
      <div className="ns-tt-fpop-head">
        <span className="techo-overline">荷札組合篩選（同時符合）</span>
        {axisFilter.tagKeys.length > 0 && (
          <button
            type="button"
            className="ns-btn btn-text ns-btn--sm"
            onClick={() => setAxisFilter({ tagKeys: [] })}
          >
            清除
          </button>
        )}
      </div>
      {availableTags.length > 6 && (
        <label className="ns-tt-fpop-search">
          <IconSearch size={13} />
          <input
            type="search"
            value={tagSearch}
            placeholder="篩選荷札…"
            aria-label="篩選荷札名稱"
            onCompositionStart={() => {
              tagComposingRef.current = true;
            }}
            onCompositionEnd={(e) => {
              tagComposingRef.current = false;
              setTagSearch(e.currentTarget.value);
            }}
            onChange={(e) => setTagSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229 || tagComposingRef.current) {
                e.stopPropagation();
                return;
              }
              if (e.key === "Escape" && tagSearch) {
                e.preventDefault();
                e.stopPropagation();
                setTagSearch("");
              } else if (e.key !== "Escape" && !e.ctrlKey && !e.metaKey) {
                e.stopPropagation();
              }
            }}
          />
        </label>
      )}
      <div className="ns-tt-fpop-scroll">
        {visibleTags.length === 0 ? (
          <p className="ns-tt-fpop-empty">
            {availableTags.length === 0 ? "目前尚無已掛在時間塊或分類的荷札" : "沒有符合的荷札"}
          </p>
        ) : (
          visibleTags.map((t) => {
            const on = axisFilter.tagKeys.includes(t.key);
            return (
              <button
                key={t.key}
                type="button"
                className={"ns-tt-fopt" + (on ? " is-on" : "")}
                style={t.depth > 0 ? { paddingLeft: `${8 + t.depth * 14}px` } : undefined}
                aria-pressed={on}
                onClick={() => toggleAxisTagKey(t.key)}
              >
                <span className="ns-tt-fopt-check" aria-hidden="true">
                  {on ? "✓" : ""}
                </span>
                <span className="ns-tt-fopt-name">#{t.name}</span>
                {t.count > 0 && <span className="ns-tt-fopt-hint ns-tt-num">{t.count}</span>}
              </button>
            );
          })
        )}
      </div>
    </div>
  );

  return (
    <div className="ns-tt-fbar" role="region" aria-label="時間塊篩選與排序">
      <div className="ns-tt-fbar-filters">
        <button
          ref={catBtnRef}
          type="button"
          data-pop-toggle=""
          className={"chip ns-chip ns-tt-fbtn" + (axisFilter.categoryIds.length > 0 ? " is-on" : "")}
          aria-expanded={openMenu === "cat"}
          onClick={() => toggleMenu("cat")}
        >
          <span className="ns-tt-fbtn-txt">{catBtnLabel}</span>
          <IconChevron open={openMenu === "cat"} size={12} />
        </button>

        <button
          ref={routeBtnRef}
          type="button"
          data-pop-toggle=""
          className={"chip ns-chip ns-tt-fbtn" + (axisFilter.routeId !== null ? " is-on" : "")}
          aria-expanded={openMenu === "route"}
          onClick={() => toggleMenu("route")}
        >
          <span className="ns-tt-fbtn-txt">{routeBtnLabel}</span>
          <IconChevron open={openMenu === "route"} size={12} />
        </button>

        <button
          ref={tagBtnRef}
          type="button"
          data-pop-toggle=""
          className={"chip ns-chip ns-tt-fbtn" + (axisFilter.tagKeys.length > 0 ? " is-on" : "")}
          aria-expanded={openMenu === "tag"}
          onClick={() => toggleMenu("tag")}
        >
          <span className="ns-tt-fbtn-txt">{tagBtnLabel}</span>
          <IconChevron open={openMenu === "tag"} size={12} />
        </button>

        <label className={"ns-tt-fsearch" + (draftQuery.trim().length > 0 ? " is-on" : "")}>
          <IconSearch size={13} />
          <input
            type="search"
            value={draftQuery}
            placeholder="關鍵字…"
            aria-label="關鍵字篩選時間塊"
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={(e) => {
              composingRef.current = false;
              const val = e.currentTarget.value;
              setDraftQuery(val);
              setAxisFilter({ query: val });
            }}
            onChange={(e) => {
              const val = e.target.value;
              setDraftQuery(val);
              if (!composingRef.current) setAxisFilter({ query: val });
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229 || composingRef.current) {
                e.stopPropagation();
                return;
              }
              if (e.ctrlKey || e.metaKey) return;
              e.stopPropagation();
              if (e.key === "Escape") {
                if (draftQuery) {
                  e.preventDefault();
                  setDraftQuery("");
                  setAxisFilter({ query: "" });
                } else {
                  e.currentTarget.blur();
                }
              }
            }}
          />
          {draftQuery.length > 0 && (
            <button
              type="button"
              className="ns-tt-fsearch-clear"
              aria-label="清除關鍵字"
              title="清除關鍵字"
              onClick={() => {
                setDraftQuery("");
                setAxisFilter({ query: "" });
              }}
            >
              <IconClose size={11} />
            </button>
          )}
        </label>
      </div>

      <button
        ref={sortBtnRef}
        type="button"
        data-pop-toggle=""
        className={"chip ns-chip ns-tt-fbtn is-sort" + (axisFilter.sort !== "timeAsc" ? " is-on" : "")}
        aria-expanded={openMenu === "sort"}
        aria-label={`排序：${currentSortOpt.label}`}
        title={`排序：${currentSortOpt.label}`}
        onClick={() => toggleMenu("sort")}
      >
        <span className="ns-tt-fbtn-txt">{sortBtnLabel}</span>
        <IconChevron open={openMenu === "sort"} size={12} />
      </button>

      {/* ── 桌機浮層 ── */}
      {!mobile && openMenu === "cat" && (
        <AnchoredPop anchor={catBtnRef.current} label="篩選分類" onClose={closeMenu}>
          {categoryBody}
        </AnchoredPop>
      )}
      {!mobile && openMenu === "route" && (
        <AnchoredPop anchor={routeBtnRef.current} label="篩選路線或支線" onClose={closeMenu}>
          {routeBody}
        </AnchoredPop>
      )}
      {!mobile && openMenu === "tag" && (
        <AnchoredPop anchor={tagBtnRef.current} label="荷札組合篩選" onClose={closeMenu}>
          {tagBody}
        </AnchoredPop>
      )}
      {!mobile && openMenu === "sort" && (
        <PopMenu
          anchor={sortBtnRef.current}
          overline={{ zh: "排序", latin: "Sort" }}
          label="時間塊排序"
          items={sortMenuItems}
          onClose={closeMenu}
        />
      )}

      {/* ── 手機 MSheet ── */}
      {mobile && openMenu === "cat" && (
        <MSheet backId="tt.axis.filter" overline="篩選" title="分類" onClose={closeMenu}>
          {categoryBody}
        </MSheet>
      )}
      {mobile && openMenu === "route" && (
        <MSheet backId="tt.axis.filter" overline="篩選" title="路線與支線" onClose={closeMenu}>
          {routeBody}
        </MSheet>
      )}
      {mobile && openMenu === "tag" && (
        <MSheet backId="tt.axis.filter" overline="篩選" title="荷札組合" onClose={closeMenu}>
          {tagBody}
        </MSheet>
      )}
      {mobile && openMenu === "sort" && (
        <MSheet list backId="tt.axis.filter.sort" overline="排序" title="時間塊排序" onClose={closeMenu}>
          {TIMETABLE_SORT_OPTIONS.map((o) => (
            <MSheetItem
              key={o.value}
              onClick={() => {
                setAxisFilter({ sort: o.value });
                closeMenu();
              }}
            >
              {axisFilter.sort === o.value ? `✓ ${o.label}` : o.label}
            </MSheetItem>
          ))}
        </MSheet>
      )}
    </div>
  );
}
