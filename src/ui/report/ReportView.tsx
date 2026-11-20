/**
 * ReportView——桌機「運行報告」頁（② 運行報告 ＋ v1.33「一日運行專頁（手帳跨頁 Daily Spread）」）。
 *
 *   - 總表態（`focusedDay === null`）：頁首「運行報告」＋ `ReportBody`
 *   - 專頁態（`focusedDay !== null`）：留在「運行報告」模組內展開左右雙頁手帳跨頁 `ReportDaySpread`，
 *     返回總表時自動還原原本的捲動位置，並以 `lastVisitedDay` 溫和微標記剛才檢視過的那一列。
 */
import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import { PageHeader } from "../common/PageHeader";
import { useHotkeyRevision } from "../shell/useHotkeyRevision";
import { capsOfHotkey } from "../shell/hotkeys";
import { ErrorBar } from "../common/ErrorBar";
import { todayKey } from "../../lib/date";
import { useNodeStore } from "../../store/nodeStore";
import { useReportStore } from "../../store/reportStore";
import { useUiStore } from "../../store/uiStore";
import { openFullSearch } from "../search/openFullSearch";
import { ReportDaySpread } from "./ReportDaySpread";
import { ReportBody } from "./ReportParts";
import { useReportReload } from "./useReportReload";
import "./report.css";

const WEEK_ZH = ["週日", "週一", "週二", "週三", "週四", "週五", "週六"];

export function ReportView() {
  useHotkeyRevision();
  const report = useReportStore((s) => s.report);
  const days = useReportStore((s) => s.days);
  const error = useReportStore((s) => s.error);
  const focusedDay = useReportStore((s) => s.focusedDay);
  const spread = useReportStore((s) => s.spread);
  const spreadLoading = useReportStore((s) => s.spreadLoading);
  const setDays = useReportStore((s) => s.setDays);
  const openDaySpread = useReportStore((s) => s.openDaySpread);
  const closeDaySpread = useReportStore((s) => s.closeDaySpread);
  const lines = useNodeStore((s) => s.lines);
  const routes = useNodeStore((s) => s.routes);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  useReportReload("desktop");

  const rootRef = useRef<HTMLElement>(null);
  const liveScrollRef = useRef(useReportStore.getState().savedScrollTop);
  const prevFocusedRef = useRef<string | null>(focusedDay);

  const routesById = useMemo(() => {
    const out: Record<string, (typeof routes)[number]> = {};
    for (const r of routes) out[r.id] = r;
    return out;
  }, [routes]);

  const handleOpenDay = useCallback(
    (targetDay: string) => {
      const top = rootRef.current?.scrollTop ?? liveScrollRef.current;
      liveScrollRef.current = top;
      openDaySpread(targetDay, "desktop", top);
    },
    [openDaySpread],
  );

  // 進入單日專頁捲回頂部；退回總表時自動還原原本的捲動位置
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (focusedDay !== null) {
      if (prevFocusedRef.current === null) {
        useReportStore.getState().setSavedScrollTop(liveScrollRef.current);
      }
      prevFocusedRef.current = focusedDay;
      root.scrollTop = 0;
    } else if (prevFocusedRef.current !== null && report) {
      prevFocusedRef.current = null;
      const targetTop = useReportStore.getState().savedScrollTop;
      liveScrollRef.current = targetTop;
      root.scrollTop = targetTop;
    }
  }, [focusedDay, report]);

  const today = report?.today ?? todayKey(dayStartHour);
  const day = report
    ? new Date(Number(report.today.slice(0, 4)), Number(report.today.slice(5, 7)) - 1, Number(report.today.slice(8, 10)))
    : null;

  return (
    <section
      ref={rootRef}
      className="page ns-report"
      aria-label="運行報告"
      onScroll={(e) => {
        if (focusedDay === null) {
          liveScrollRef.current = e.currentTarget.scrollTop;
        }
      }}
    >
      <div className="sheet">
        {focusedDay ? (
          <ReportDaySpread
            day={focusedDay}
            today={today}
            shell="desktop"
            spread={spread}
            loading={spreadLoading}
            routesById={routesById}
            onClose={closeDaySpread}
          />
        ) : (
          <>
            <PageHeader
              variant="name"
              overline={{ zh: "運行報告", latin: "Operation Report" }}
              title="運行報告"
              aside={day ? `${day.getMonth() + 1}月${day.getDate()}日 ${WEEK_ZH[day.getDay()]}` : undefined}
              search={{ onOpen: () => openFullSearch(), title: `搜尋（${capsOfHotkey("global.fullsearch")}）` }}
            />
            {error && (
              <ErrorBar
                message={`運行報告讀取失敗：${error}`}
                onRetry={() => void useReportStore.getState().load("desktop")}
              />
            )}
            {report && (
              <ReportBody
                r={report}
                shell="desktop"
                days={days}
                onDays={setDays}
                lines={lines}
                routes={routes}
                onOpenDay={handleOpenDay}
              />
            )}
          </>
        )}
      </div>
    </section>
  );
}
