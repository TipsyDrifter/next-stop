/**
 * ReportFilterBar——運行報告的跨模組篩選列（幹線／路線 ＋ `#荷札` 多選 AND）與彈性期間控制列（v1.33 3A-2）。
 *
 * 雙殼對等：
 *   - 跨模組篩選列：依「幹線／路線（含車庫已到站路線與未掛路線）」與「`#荷札`（多選 AND 交集，父含子）」即時過濾全頁統計
 *   - 期間維度升級：`今日 ｜ 近 7 天 ｜ 近 30 天 ｜ 按月翻頁（‹ YYYY-MM ›） ｜ 自訂區間（起日～迄日，複用 DatePicker / MobileDatePicker）`
 *   - 桌機使用錨定 `.techo-card` 浮層（`placeBelow` ＋ `useOutsideDismiss`）；手機使用共用 `MSheet` ＋ `useBackLayer` 返回層
 */
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { NodeRow } from "../../domain";
import { collectAvailableTags } from "../../domain/notesFilter";
import {
  isReportFilterActive,
  shiftReportMonth,
  type ReportPeriodMode,
  type ReportPeriodSpec,
  type ReportScopeFilter,
  type ResolvedReportRange,
} from "../../domain/report";
import { addDays } from "../../lib/date";
import { useReportStore } from "../../store/reportStore";
import { useTagStore } from "../../store/tagStore";
import { placeBelow, useOutsideDismiss } from "../common/anchorPop";
import { DateNav } from "../common/DateNav";
import { DatePicker, shortDayKey, type DateQuick } from "../common/DatePicker";
import { IconCalendar, IconChevron, IconClose, IconSearch } from "../common/icons";
import { MobileDatePicker } from "../common/MobileDatePicker";
import { MSheet } from "../common/MSheet";
import { Tabs, type TabItem } from "../common/Tabs";
import { useBackLayer } from "../mobile/backStack";
import { RouteBadge } from "./ReportParts";
import type { ReportShellKind } from "./reportJumps";

const REPORT_TAG_ENTITY_TYPES: readonly string[] = [
  "node",
  "note",
  "timetable:block",
  "timetable:category",
  "ticket:entry",
  "ticket:repeat",
];

const PERIOD_TABS: readonly TabItem<ReportPeriodMode>[] = [
  { key: "today", label: "今日" },
  { key: "7d", label: "近 7 天" },
  { key: "30d", label: "近 30 天" },
  { key: "month", label: "按月" },
  { key: "custom", label: "自訂區間" },
];

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
      className="techo-card ns-rp-pop"
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

function scopeSame(a: ReportScopeFilter, b: ReportScopeFilter): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "line" && b.kind === "line") return a.lineId === b.lineId;
  if (a.kind === "route" && b.kind === "route") return a.routeId === b.routeId;
  return true;
}

/* ═══════════ 頂部跨模組篩選列（幹線／路線 ＋ #荷札 多選 AND） ═══════════ */

export function ReportFilterBar({
  shell,
  lines,
  routes,
  notesOpen,
}: {
  shell: ReportShellKind;
  lines: readonly NodeRow[];
  routes: readonly NodeRow[];
  notesOpen: boolean;
}) {
  const filter = useReportStore((s) => s.filter);
  const setScopeFilter = useReportStore((s) => s.setScopeFilter);
  const toggleTagKey = useReportStore((s) => s.toggleTagKey);
  const clearFilter = useReportStore((s) => s.clearFilter);

  const tagIndex = useTagStore((s) => s.index);
  const tagLoading = useTagStore((s) => s.loading);
  const tagLoadError = useTagStore((s) => s.loadError);

  const [scopeOpen, setScopeOpen] = useState(false);
  const [tagOpen, setTagOpen] = useState(false);
  const [tagQuery, setTagQuery] = useState("");
  const tagComposingRef = useRef(false);

  const scopeBtnRef = useRef<HTMLButtonElement>(null);
  const tagBtnRef = useRef<HTMLButtonElement>(null);

  const mobile = shell === "mobile";
  useBackLayer("report.filter.scope", mobile && scopeOpen, () => setScopeOpen(false), "sheet");
  useBackLayer("report.filter.tags", mobile && tagOpen, () => setTagOpen(false), "sheet");

  // 當 tagStore.index 更新且目前有啟用 #荷札 篩選時，自動重載事實以同步最新荷札索引
  useEffect(() => {
    if (!notesOpen) return;
    return useTagStore.subscribe((s, p) => {
      if (s.index !== p.index && useReportStore.getState().filter.tagKeys.length > 0) {
        void useReportStore.getState().load(shell);
      }
    });
  }, [notesOpen, shell]);

  const aliveLines = useMemo(() => lines.filter((l) => l.deleted_at === null), [lines]);
  const aliveRoutes = useMemo(() => routes.filter((r) => r.deleted_at === null), [routes]);

  const routeById = useMemo(() => {
    const out: Record<string, NodeRow> = {};
    for (const r of aliveRoutes) out[r.id] = r;
    return out;
  }, [aliveRoutes]);

  const lineByIdMap = useMemo(() => {
    const out: Record<string, NodeRow> = {};
    for (const l of aliveLines) out[l.id] = l;
    return out;
  }, [aliveLines]);

  const groupedRoutes = useMemo(() => {
    const liveByLine = new Map<string, NodeRow[]>();
    const ungroupedLive: NodeRow[] = [];
    const depotRoutes: NodeRow[] = [];

    for (const r of aliveRoutes) {
      if (r.arrived_on !== null) {
        depotRoutes.push(r);
        continue;
      }
      const lid = r.line_id ?? r.parent_id;
      if (lid && lineByIdMap[lid]) {
        const arr = liveByLine.get(lid);
        if (arr) arr.push(r);
        else liveByLine.set(lid, [r]);
      } else {
        ungroupedLive.push(r);
      }
    }
    return { liveByLine, ungroupedLive, depotRoutes };
  }, [aliveRoutes, lineByIdMap]);

  const tagOptions = useMemo(
    () =>
      collectAvailableTags(tagIndex, {
        entityTypes: REPORT_TAG_ENTITY_TYPES,
        selectedKeys: filter.tagKeys,
      }),
    [tagIndex, filter.tagKeys],
  );

  const visibleTagOptions = useMemo(() => {
    const q = tagQuery.trim().toLowerCase().replace(/^#/, "");
    if (!q) return tagOptions;
    return tagOptions.filter((o) => o.name.toLowerCase().includes(q) || o.key.includes(q));
  }, [tagOptions, tagQuery]);

  const tagNameOf = (key: string) => tagIndex?.byKey[key]?.name ?? key;
  const active = isReportFilterActive(filter);

  const pickScope = (next: ReportScopeFilter) => {
    setScopeFilter(next);
    setScopeOpen(false);
  };

  const renderScopeLabel = () => {
    const sc = filter.scope;
    if (sc.kind === "all") return <span>全部幹線・路線</span>;
    if (sc.kind === "none") return <span>未掛路線／臨時</span>;
    if (sc.kind === "line") {
      const l = lineByIdMap[sc.lineId];
      return <span>幹線：{l?.name ?? "未知幹線"}</span>;
    }
    const r = routeById[sc.routeId] ?? null;
    return (
      <>
        <RouteBadge route={r} temp={!r} />
        <span>{r?.name ?? "未知路線"}</span>
      </>
    );
  };

  const scopePickerBody = (
    <div className="ns-rp-pop-body">
      <div className="ns-rp-pop-list" role="listbox" aria-label="選擇幹線或路線">
        <button
          type="button"
          role="option"
          aria-selected={filter.scope.kind === "all"}
          className={"ns-rp-pop-opt" + (filter.scope.kind === "all" ? " is-on" : "")}
          onClick={() => pickScope({ kind: "all" })}
        >
          <span className="ns-rp-pop-check" aria-hidden="true">
            {filter.scope.kind === "all" ? "✓" : ""}
          </span>
          <span className="ns-rp-pop-name">全部幹線・路線</span>
        </button>

        <button
          type="button"
          role="option"
          aria-selected={filter.scope.kind === "none"}
          className={"ns-rp-pop-opt" + (filter.scope.kind === "none" ? " is-on" : "")}
          onClick={() => pickScope({ kind: "none" })}
        >
          <span className="ns-rp-pop-check" aria-hidden="true">
            {filter.scope.kind === "none" ? "✓" : ""}
          </span>
          <RouteBadge route={null} temp />
          <span className="ns-rp-pop-name">未掛路線／臨時車票</span>
        </button>

        {aliveLines.map((line) => {
          const lineRoutes = groupedRoutes.liveByLine.get(line.id) ?? [];
          const lineSpec: ReportScopeFilter = { kind: "line", lineId: line.id };
          const lineSelected = scopeSame(filter.scope, lineSpec);
          return (
            <div key={line.id} className="ns-rp-pop-group">
              <button
                type="button"
                role="option"
                aria-selected={lineSelected}
                className={"ns-rp-pop-opt is-line" + (lineSelected ? " is-on" : "")}
                onClick={() => pickScope(lineSpec)}
              >
                <span className="ns-rp-pop-check" aria-hidden="true">
                  {lineSelected ? "✓" : ""}
                </span>
                <span className="ns-rp-pop-name">{line.name}</span>
                <span className="ns-rp-pop-sub">幹線全部</span>
              </button>
              {lineRoutes.map((r) => {
                const rSpec: ReportScopeFilter = { kind: "route", routeId: r.id };
                const rSelected = scopeSame(filter.scope, rSpec);
                return (
                  <button
                    key={r.id}
                    type="button"
                    role="option"
                    aria-selected={rSelected}
                    className={"ns-rp-pop-opt is-indent" + (rSelected ? " is-on" : "")}
                    onClick={() => pickScope(rSpec)}
                  >
                    <span className="ns-rp-pop-check" aria-hidden="true">
                      {rSelected ? "✓" : ""}
                    </span>
                    <RouteBadge route={r} />
                    <span className="ns-rp-pop-name">{r.name}</span>
                  </button>
                );
              })}
            </div>
          );
        })}

        {groupedRoutes.ungroupedLive.length > 0 && (
          <div className="ns-rp-pop-group">
            <div className="ns-rp-pop-group-hd">其他路線</div>
            {groupedRoutes.ungroupedLive.map((r) => {
              const rSpec: ReportScopeFilter = { kind: "route", routeId: r.id };
              const rSelected = scopeSame(filter.scope, rSpec);
              return (
                <button
                  key={r.id}
                  type="button"
                  role="option"
                  aria-selected={rSelected}
                  className={"ns-rp-pop-opt" + (rSelected ? " is-on" : "")}
                  onClick={() => pickScope(rSpec)}
                >
                  <span className="ns-rp-pop-check" aria-hidden="true">
                    {rSelected ? "✓" : ""}
                  </span>
                  <RouteBadge route={r} />
                  <span className="ns-rp-pop-name">{r.name}</span>
                </button>
              );
            })}
          </div>
        )}

        {groupedRoutes.depotRoutes.length > 0 && (
          <div className="ns-rp-pop-group">
            <div className="ns-rp-pop-group-hd">車庫（已到站路線）</div>
            {groupedRoutes.depotRoutes.map((r) => {
              const rSpec: ReportScopeFilter = { kind: "route", routeId: r.id };
              const rSelected = scopeSame(filter.scope, rSpec);
              return (
                <button
                  key={r.id}
                  type="button"
                  role="option"
                  aria-selected={rSelected}
                  className={"ns-rp-pop-opt" + (rSelected ? " is-on" : "")}
                  onClick={() => pickScope(rSpec)}
                >
                  <span className="ns-rp-pop-check" aria-hidden="true">
                    {rSelected ? "✓" : ""}
                  </span>
                  <RouteBadge route={r} />
                  <span className="ns-rp-pop-name">{r.name}</span>
                  <span className="ns-rp-pop-sub">車庫</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );

  const tagPickerBody = (
    <div className="ns-rp-pop-body">
      <div className="ns-rp-pop-search">
        <IconSearch size={14} />
        <input
          type="search"
          className="techo-input"
          placeholder="搜尋 #荷札…"
          aria-label="搜尋荷札"
          defaultValue={tagQuery}
          onCompositionStart={() => {
            tagComposingRef.current = true;
          }}
          onCompositionEnd={(e) => {
            tagComposingRef.current = false;
            setTagQuery(e.currentTarget.value);
          }}
          onChange={(e) => {
            if (!tagComposingRef.current) setTagQuery(e.currentTarget.value);
          }}
        />
      </div>

      {filter.tagKeys.length > 1 && (
        <p className="ns-rp-pop-hint">多選採 AND 交集：同時掛有所選荷札的紀錄才計入</p>
      )}

      <div className="ns-rp-pop-list" role="listbox" aria-multiselectable="true" aria-label="荷札清單">
        {tagLoading && !tagIndex ? (
          <p className="ns-rp-pop-empty">載入荷札…</p>
        ) : tagLoadError && !tagIndex ? (
          <p className="ns-rp-pop-empty">
            荷札尚未載入{" "}
            <button type="button" className="ns-rp-inline-btn" onClick={() => void useTagStore.getState().loadIndex()}>
              重試
            </button>
          </p>
        ) : visibleTagOptions.length === 0 ? (
          <p className="ns-rp-pop-empty">{tagQuery.trim() ? "找不到符合的荷札" : "目前尚無荷札紀錄"}</p>
        ) : (
          visibleTagOptions.map((opt) => {
            const checked = filter.tagKeys.includes(opt.key);
            return (
              <button
                key={opt.key}
                type="button"
                role="option"
                aria-selected={checked}
                className={"ns-rp-pop-opt" + (checked ? " is-on" : "")}
                style={opt.depth > 0 ? { paddingInlineStart: `${10 + opt.depth * 14}px` } : undefined}
                onClick={() => toggleTagKey(opt.key)}
              >
                <span className="ns-rp-pop-check" aria-hidden="true">
                  {checked ? "✓" : ""}
                </span>
                <span className="ns-rp-pop-hash" aria-hidden="true">
                  #
                </span>
                <span className="ns-rp-pop-name">{opt.depth > 0 ? opt.seg : opt.name}</span>
                <span className="ns-rp-pop-sub">{opt.count}</span>
              </button>
            );
          })
        )}
      </div>

      {filter.tagKeys.length > 0 && (
        <div className="ns-rp-pop-foot">
          <span className="ns-rp-pop-sub">已選 {filter.tagKeys.length} 枚（AND 交集）</span>
          <button
            type="button"
            className="ns-rp-inline-btn"
            onClick={() => {
              for (const k of [...filter.tagKeys]) toggleTagKey(k);
            }}
          >
            清除荷札
          </button>
        </div>
      )}
    </div>
  );

  return (
    <div className="ns-rp-fbar" role="region" aria-label="運行報告篩選">
      <div className="ns-rp-fbar-row">
        <span className="ns-rp-fbar-k">篩選</span>
        <button
          ref={scopeBtnRef}
          type="button"
          data-pop-toggle="1"
          className={"chip ns-chip ns-rp-fbtn" + (filter.scope.kind !== "all" ? " is-on" : "")}
          aria-expanded={scopeOpen}
          aria-haspopup="dialog"
          onClick={() => {
            setTagOpen(false);
            setScopeOpen((v) => !v);
          }}
        >
          {renderScopeLabel()}
          <IconChevron size={12} className={"ns-rp-chev" + (scopeOpen ? " is-open" : "")} />
        </button>

        {notesOpen && (
          <button
            ref={tagBtnRef}
            type="button"
            data-pop-toggle="1"
            className={"chip ns-chip ns-rp-fbtn" + (filter.tagKeys.length > 0 ? " is-on" : "")}
            aria-expanded={tagOpen}
            aria-haspopup="dialog"
            onClick={() => {
              setScopeOpen(false);
              setTagOpen((v) => {
                if (v) setTagQuery("");
                return !v;
              });
            }}
          >
            <span className="ns-rp-hash" aria-hidden="true">
              #
            </span>
            <span>荷札</span>
            {filter.tagKeys.length > 0 && <span className="ns-rp-fcount">{filter.tagKeys.length}</span>}
            <IconChevron size={12} className={"ns-rp-chev" + (tagOpen ? " is-open" : "")} />
          </button>
        )}

        {filter.tagKeys.map((key) => {
          const name = tagNameOf(key);
          return (
            <button
              key={key}
              type="button"
              className="ns-rp-tag-pill"
              title={`移除 #${name} 篩選`}
              aria-label={`移除 #${name} 篩選`}
              onClick={() => toggleTagKey(key)}
            >
              <span className="h" aria-hidden="true">
                #
              </span>
              <span className="n">{name}</span>
              <IconClose size={11} />
            </button>
          );
        })}

        {active && (
          <button type="button" className="ns-rp-clear-btn" onClick={clearFilter}>
            清除篩選
          </button>
        )}
      </div>

      {scopeOpen &&
        (mobile ? (
          <MSheet
            title="依幹線・路線篩選"
            overline="篩選"
            backId="report.filter.scope"
            backKind="sheet"
            height="half"
            onClose={() => setScopeOpen(false)}
          >
            {scopePickerBody}
          </MSheet>
        ) : (
          <AnchoredPop anchor={scopeBtnRef.current} label="依幹線或路線篩選" onClose={() => setScopeOpen(false)}>
            {scopePickerBody}
          </AnchoredPop>
        ))}

      {tagOpen &&
        (mobile ? (
          <MSheet
            title="依 #荷札 組合篩選"
            overline="荷札篩選（AND）"
            backId="report.filter.tags"
            backKind="sheet"
            height="half"
            onClose={() => {
              setTagOpen(false);
              setTagQuery("");
            }}
          >
            {tagPickerBody}
          </MSheet>
        ) : (
          <AnchoredPop
            anchor={tagBtnRef.current}
            label="依荷札組合篩選"
            onClose={() => {
              setTagOpen(false);
              setTagQuery("");
            }}
          >
            {tagPickerBody}
          </AnchoredPop>
        ))}
    </div>
  );
}

/* ═══════════ 彈性期間切換列（今日｜近 7 天｜近 30 天｜按月｜自訂區間） ═══════════ */

export function ReportPeriodControls({
  shell,
  today,
  period,
  range,
  onChange,
}: {
  shell: ReportShellKind;
  today: string;
  period: ReportPeriodSpec;
  range: ResolvedReportRange;
  onChange: (spec: ReportPeriodSpec) => void;
}) {
  const mobile = shell === "mobile";
  const curMonth = today.slice(0, 7);

  const [pickSide, setPickSide] = useState<"from" | "to" | null>(null);
  const fromBtnRef = useRef<HTMLButtonElement>(null);
  const toBtnRef = useRef<HTMLButtonElement>(null);

  useBackLayer("report.period.from", mobile && pickSide === "from", () => setPickSide(null), "sheet");
  useBackLayer("report.period.to", mobile && pickSide === "to", () => setPickSide(null), "sheet");

  const quickFrom: DateQuick[] = useMemo(
    () => [
      { label: "7 天前", day: addDays(today, -6) },
      { label: "14 天前", day: addDays(today, -13) },
      { label: "30 天前", day: addDays(today, -29) },
      { label: "月初", day: `${curMonth}-01` },
    ],
    [today, curMonth],
  );

  const quickTo: DateQuick[] = useMemo(
    () => [
      { label: "今天", day: today },
      { label: "昨天", day: addDays(today, -1) },
    ],
    [today],
  );

  const selectMode = (mode: ReportPeriodMode) => {
    if (mode === period.mode) return;
    if (mode === "month") {
      onChange({ mode: "month", month: period.month ?? curMonth });
      return;
    }
    if (mode === "custom") {
      onChange({
        mode: "custom",
        customFrom: period.customFrom ?? range.from,
        customTo: period.customTo ?? range.to,
      });
      return;
    }
    onChange({ mode });
  };

  const [yy, mm] = range.month.split("-").map(Number);

  return (
    <div className="ns-rp-period">
      <Tabs
        items={PERIOD_TABS}
        value={period.mode}
        onChange={selectMode}
        size={mobile ? undefined : "md"}
        scroll
        aria-label="統計期間"
        className="ns-rp-days"
      />

      {period.mode === "month" && (
        <div className="ns-rp-period-sub">
          <DateNav
            unit="month"
            title={`${yy}年${mm}月`}
            isToday={range.month === curMonth}
            todayLabel="本月"
            nextDisabled={range.month >= curMonth}
            onPrev={() => onChange({ mode: "month", month: shiftReportMonth(range.month, -1) })}
            onNext={() => {
              const next = shiftReportMonth(range.month, 1);
              if (next <= curMonth) onChange({ mode: "month", month: next });
            }}
            onToday={() => onChange({ mode: "month", month: curMonth })}
          />
          <span className="ns-rp-period-span">
            {shortDayKey(range.from)} – {shortDayKey(range.to)}
          </span>
        </div>
      )}

      {period.mode === "custom" && (
        <div className="ns-rp-period-sub is-custom">
          <span className="ns-rp-period-lbl">區間</span>
          <button
            ref={fromBtnRef}
            type="button"
            data-pop-toggle="1"
            className={"chip ns-chip ns-rp-datebtn" + (pickSide === "from" ? " is-on" : "")}
            aria-haspopup="dialog"
            aria-expanded={pickSide === "from"}
            onClick={() => setPickSide((s) => (s === "from" ? null : "from"))}
          >
            <IconCalendar size={13} />
            <span>起 {range.from}</span>
          </button>
          <span className="ns-rp-period-tilde" aria-hidden="true">
            ～
          </span>
          <button
            ref={toBtnRef}
            type="button"
            data-pop-toggle="1"
            className={"chip ns-chip ns-rp-datebtn" + (pickSide === "to" ? " is-on" : "")}
            aria-haspopup="dialog"
            aria-expanded={pickSide === "to"}
            onClick={() => setPickSide((s) => (s === "to" ? null : "to"))}
          >
            <IconCalendar size={13} />
            <span>迄 {range.to}</span>
          </button>
          <div className="ns-rp-period-presets">
            <button
              type="button"
              className="chip ns-chip"
              onClick={() => onChange({ mode: "custom", customFrom: addDays(today, -13), customTo: today })}
            >
              近 14 天
            </button>
            <button
              type="button"
              className="chip ns-chip"
              onClick={() => onChange({ mode: "custom", customFrom: addDays(today, -89), customTo: today })}
            >
              近 90 天
            </button>
          </div>
        </div>
      )}

      {pickSide === "from" &&
        (mobile ? (
          <MobileDatePicker
            title="選擇起始日"
            value={range.from}
            max={range.to}
            today={today}
            quick={quickFrom}
            backId="report.period.from"
            backKind="sheet"
            onPick={(d) => {
              onChange({ mode: "custom", customFrom: d, customTo: range.to });
              setPickSide(null);
            }}
            onClose={() => setPickSide(null)}
          />
        ) : (
          <DatePicker
            label="選擇起始日"
            value={range.from}
            max={range.to}
            today={today}
            quick={quickFrom}
            markValue
            anchor={fromBtnRef.current}
            onPick={(d) => {
              onChange({ mode: "custom", customFrom: d, customTo: range.to });
              setPickSide(null);
            }}
            onClose={() => setPickSide(null)}
          />
        ))}

      {pickSide === "to" &&
        (mobile ? (
          <MobileDatePicker
            title="選擇結束日"
            value={range.to}
            min={range.from}
            max={today}
            today={today}
            quick={quickTo}
            backId="report.period.to"
            backKind="sheet"
            onPick={(d) => {
              onChange({ mode: "custom", customFrom: range.from, customTo: d });
              setPickSide(null);
            }}
            onClose={() => setPickSide(null)}
          />
        ) : (
          <DatePicker
            label="選擇結束日"
            value={range.to}
            min={range.from}
            max={today}
            today={today}
            quick={quickTo}
            markValue
            anchor={toBtnRef.current}
            onPick={(d) => {
              onChange({ mode: "custom", customFrom: range.from, customTo: d });
              setPickSide(null);
            }}
            onClose={() => setPickSide(null)}
          />
        ))}
    </div>
  );
}
