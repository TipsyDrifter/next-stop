/**
 * MobileReport——手機「運行報告」頁（② 運行報告 D-主-183；`MobileTabKey` 的 report，不在 tab bar 上）。
 * 視覺真相＝prototypes/design-stats-review-運行報告.html?v=AC&device=mob。內容在 ReportParts（兩殼共用）。
 *
 * 頂帶＝「‹ 運行報告／OPERATION REPORT」（MobileShell 給 onBack）；頁頂一行今天日期；卡片單欄；表格五欄、記事改成日期格下面跨整列一行。
 * 頂帶本來就有全域搜尋鈕，不另加。入口＝更多頁「回顧」段、今日頁的今日小結。
 */
import { ErrorBar } from "../common/ErrorBar";
import { useNodeStore } from "../../store/nodeStore";
import { useReportStore } from "../../store/reportStore";
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
  const setDays = useReportStore((s) => s.setDays);
  const routes = useNodeStore((s) => s.routes);
  useReportReload("mobile");

  const day = report ? new Date(Number(report.today.slice(0, 4)), Number(report.today.slice(5, 7)) - 1, Number(report.today.slice(8, 10))) : null;
  return (
    <div className="m-page ns-report is-mobile" aria-label="運行報告">
      {error && <ErrorBar message={`運行報告讀取失敗：${error}`} onRetry={() => void useReportStore.getState().load("mobile")} />}
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
      {report && <ReportBody r={report} shell="mobile" days={days} onDays={setDays} routes={routes} />}
    </div>
  );
}
