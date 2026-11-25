/**
 * MonthGrid——月間頁：**一張紙，不是 42 張卡**（M3 ⑤ WP2；v1.37 2A-2 跨日行程色帶）。
 *
 * 結構：5～6 條週列容器（`.cal-week-row`），每週 7 欄 grid（`.cal-week-cells`）；
 *   若該週有「多日乘車日」票（`isMultiDayTicket`），於日期數字列下方、一般單日票小列上方
 *   疊放連續橫跨多格的行程色帶層（`.cal-week-ribbons`），支援多條不重疊車道 lane 與跨週斷開圓角標示。
 *   已由色帶呈現的多日票不再於每日格內小列重複刷滿（點進 DayPopover 仍可看到完整當日行程）。
 *   期間自由券（`isFlexibleRangeTicket`）維持低調區間小標，不搶佔多日色帶視覺主場。
 *
 * 星期列用控制器的 `weekOrder`（依設定的週首排；預設一…六・日）＋`WEEKDAY_LABEL`（六日＝`.we` 淡）。
 */
import { useMemo, useRef, type CSSProperties } from "react";
import { WEEKDAY_LABEL } from "../../domain";
import { formatDateRangeBadge } from "../../domain/dateRange";
import { compareSiblings } from "../../domain/nodeOrder";
import { stationDayMarks } from "../../domain/weekAims";
import { useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";
import { useStationCard } from "../weekAims/StationCard";
import { CalendarCell, useAddOutOfTabOrder, useDateDropTargets } from "./CalendarCell";
import { layoutMultiDayRibbons } from "./multiDayRibbon";
import { useCalendar } from "./useCalendarController";

const EMPTY_ENTRIES: never[] = [];

type CssVars = CSSProperties & Record<`--${string}`, string | number>;

const cx = (...parts: Array<string | false | undefined>) => parts.filter(Boolean).join(" ");

export function MonthGrid() {
  const c = useCalendar();
  const gridRef = useRef<HTMLDivElement>(null);
  useAddOutOfTabOrder(gridRef); // 格線只留落點格一個 Tab stop
  useDateDropTargets(gridRef); // 回饋乙：格子是「拖到日期＝改期」的落點
  const stations = useNodeStore((s) => s.stations);
  const allRoutes = useNodeStore((s) => s.routes);
  const stationMarks = useMemo(
    () => stationDayMarks([...stations].sort(compareSiblings), allRoutes),
    [stations, allRoutes],
  );
  const stationCard = useStationCard();

  const routeById = useMemo(() => new Map(c.routes.map((r) => [r.id, r] as const)), [c.routes]);
  const allNodes = useMemo(() => Object.values(c.nodes), [c.nodes]);

  // 將 35/42 格切分為 5～6 條週列，逐週計算多日行程色帶車道
  const weekRows = useMemo(() => {
    const rows: Array<{
      key: string;
      days: string[];
      ribbons: ReturnType<typeof layoutMultiDayRibbons>;
    }> = [];
    for (let i = 0; i < c.days.length; i += 7) {
      const slice = c.days.slice(i, i + 7);
      if (slice.length === 0) continue;
      rows.push({
        key: slice[0],
        days: slice,
        ribbons: layoutMultiDayRibbons(slice, allNodes, c.today, {
          rangeFrom: c.range.from,
          rangeTo: c.range.to,
        }),
      });
    }
    return rows;
  }, [c.days, allNodes, c.today, c.range.from, c.range.to]);

  // 鍵盤焦點的落點：選取格 →（本月的）今天 → 本月 1 日
  const focusDay =
    c.selectedDay && c.selectedDay >= c.range.from && c.selectedDay <= c.range.to
      ? c.selectedDay
      : c.today >= c.range.from && c.today <= c.range.to
        ? c.today
        : c.range.from;

  const openTicketPanel = (nodeId: string) => {
    const ui = useUiStore.getState();
    ui.select(nodeId);
    ui.setPanelOpen(true);
  };

  return (
    <div className="month-card">
      <div className="wk-head" aria-hidden>
        {c.weekOrder.map((d) => (
          <span key={d} className={d === 0 || d === 6 ? "we" : undefined}>
            {WEEKDAY_LABEL[d]}
          </span>
        ))}
      </div>
      <div ref={gridRef} className="grid cal-month-weeks" role="group" aria-label="月曆">
        {weekRows.map((wk) => {
          const lanes = wk.ribbons.laneCount;
          const rowStyle: CssVars | undefined = lanes > 0 ? { "--cal-ribbon-lanes": lanes } : undefined;
          return (
            <div
              key={wk.key}
              className={cx("cal-week-row", lanes > 0 && "has-ribbons")}
              style={rowStyle}
            >
              <div className="cal-week-cells">
                {wk.days.map((day) => {
                  const inRange = day >= c.range.from && day <= c.range.to;
                  return (
                    <CalendarCell
                      key={day}
                      day={day}
                      inRange={inRange}
                      isToday={day === c.today}
                      isPast={day < c.today}
                      entries={c.byDate.entries[day] ?? EMPTY_ENTRIES}
                      dues={c.byDate.dues[day] ?? EMPTY_ENTRIES}
                      count={c.byDate.counts[day]}
                      nodes={c.nodes}
                      routes={c.routes}
                      focusable={inRange && day === focusDay}
                      open={c.popTarget?.day === day}
                      truncate
                      onOpen={(anchor) => c.openDay(day, anchor)}
                      onAdd={() => c.addOn(day)}
                      onTip={(anchor) => (anchor ? c.showTip(day, anchor) : c.hideTip())}
                      stationMarks={stationMarks.get(day)}
                      onStation={stationCard.open}
                      hiddenNodeIds={wk.ribbons.coveredNodeIds}
                    />
                  );
                })}
              </div>
              {lanes > 0 && (
                <div className="cal-week-ribbons" role="list" aria-label="多日行程">
                  {wk.ribbons.segments.map((seg) => {
                    const route = seg.node.route_id ? routeById.get(seg.node.route_id) : undefined;
                    const rangeText = seg.node.scheduled_on
                      ? formatDateRangeBadge(seg.node.scheduled_on, seg.node.scheduled_end)
                      : "";
                    const statusSuffix = seg.done ? "（已済）" : seg.paused ? "（途中下車）" : seg.late ? "（誤點）" : "";
                    const style: CssVars = {
                      gridColumn: `${seg.startCol + 1} / span ${seg.span}`,
                      gridRow: seg.lane + 1,
                      "--ribbon-c": route?.color ?? "var(--route-none)",
                    };
                    return (
                      <button
                        key={`${wk.key}-${seg.nodeId}`}
                        type="button"
                        role="listitem"
                        className={cx(
                          "cal-ribbon",
                          seg.continuesLeft && "is-cont-l",
                          seg.continuesRight && "is-cont-r",
                          seg.done && "is-done",
                          seg.paused && "is-paused",
                          seg.late && "is-late",
                        )}
                        style={style}
                        title={`${seg.node.name}（${rangeText}）${statusSuffix}`}
                        aria-label={`多日行程：${seg.node.name}，${rangeText}${statusSuffix}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          openTicketPanel(seg.nodeId);
                        }}
                      >
                        {seg.continuesLeft && (
                          <span className="cal-ribbon-cont" aria-hidden>
                            ‹
                          </span>
                        )}
                        <span className="cal-ribbon-name">{seg.node.name}</span>
                        {seg.span >= 2 && rangeText && (
                          <span className="cal-ribbon-range" aria-hidden>
                            {rangeText}
                          </span>
                        )}
                        {seg.done && (
                          <span className="cal-ribbon-seal" aria-hidden>
                            済
                          </span>
                        )}
                        {seg.continuesRight && (
                          <span className="cal-ribbon-cont" aria-hidden>
                            ›
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {stationCard.node}
    </div>
  );
}
