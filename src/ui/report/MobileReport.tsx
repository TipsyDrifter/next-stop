/**
 * MobileReport——手機「運行報告」頁（② 運行報告 D-主-183 ＋ v1.33「一日運行專頁」滿版子頁）。
 *
 *   - 總表保持掛載於底層 `.m-page`（返回時捲動位置零損耗保留，並微標記 `lastVisitedDay`）
 *   - 點選任一日期列時以 `MFullPage`（`backId="core.report-spread"`，接入 `useBackLayer`）開啟滿版單欄「一日運行專頁」：
 *     按 Android 返回鍵或左上 `‹ 運行報告` 先退回運行報告列表，而非退出頁面。
 */
import { useCallback, useMemo, useRef } from "react";
import { todayKey } from "../../lib/date";
import { ErrorBar } from "../common/ErrorBar";
import { MFullPage } from "../common/MFullPage";
import { useBackLayer } from "../mobile/backStack";
import { useNodeStore } from "../../store/nodeStore";
import { useReportStore } from "../../store/reportStore";
import { useUiStore } from "../../store/uiStore";
import { ReportDaySpread } from "./ReportDaySpread";
import { ReportBody } from "./ReportParts";
import { useReportReload } from "./useReportReload";
import "./report.css";

const WEEK_ZH = ["週日", "週一", "週二", "週三", "週四", "週五", "週六"];
const WEEK_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export default function MobileReport() {
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
  useReportReload("mobile");

  const pageRef = useRef<HTMLDivElement>(null);

  useBackLayer("core.report-spread", focusedDay !== null, closeDaySpread, "full");

  const routesById = useMemo(() => {
    const out: Record<string, (typeof routes)[number]> = {};
    for (const r of routes) out[r.id] = r;
    return out;
  }, [routes]);

  const handleOpenDay = useCallback(
    (targetDay: string) => {
      openDaySpread(targetDay, "mobile", pageRef.current?.scrollTop ?? 0);
    },
    [openDaySpread],
  );

  const today = report?.today ?? todayKey(dayStartHour);
  const day = report
    ? new Date(Number(report.today.slice(0, 4)), Number(report.today.slice(5, 7)) - 1, Number(report.today.slice(8, 10)))
    : null;

  return (
    <div ref={pageRef} className="m-page ns-report is-mobile" aria-label="運行報告">
      {error && (
        <ErrorBar
          message={`運行報告讀取失敗：${error}`}
          onRetry={() => void useReportStore.getState().load("mobile")}
        />
      )}
      {day && (
        <div className="ns-rp-mday">
          <span className="d">
            {day.getMonth() + 1}月{day.getDate()}日 {WEEK_ZH[day.getDay()]}
          </span>
          <span className="lt" lang="en">
            {MONTH_EN[day.getMonth()]} {day.getDate()}, {WEEK_EN[day.getDay()]}
          </span>
        </div>
      )}
      {report && (
        <ReportBody
          r={report}
          shell="mobile"
          days={days}
          onDays={setDays}
          lines={lines}
          routes={routes}
          onOpenDay={handleOpenDay}
        />
      )}

      {focusedDay && (
        <MFullPage
          title="一日運行專頁"
          left={{ label: "運行報告", back: true, onClick: closeDaySpread }}
          backId="core.report-spread"
        >
          <div className="ns-report is-mobile ns-rp-mspread-host">
            <ReportDaySpread
              day={focusedDay}
              today={today}
              shell="mobile"
              spread={spread}
              loading={spreadLoading}
              routesById={routesById}
              onClose={closeDaySpread}
            />
          </div>
        </MFullPage>
      )}
    </div>
  );
}
