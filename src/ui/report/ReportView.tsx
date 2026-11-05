/**
 * ReportView——桌機「運行報告」頁（② 運行報告；核心頁 `report`，gnav 第三排「回顧」、Ctrl+7；D-主-182）。
 * 視覺真相＝prototypes/design-stats-review-運行報告.html?v=AC。內容在 ReportParts（兩殼共用）。
 *
 * 頁首＝B 頁名式「運行報告」、眉標 Operation Report、補述＝今天日期；工具列只有搜尋鈕（＝完整搜尋頁，S2）。
 * 載入：進頁就讀；今天清單變動（蓋済、取消、同步拉下來）、視窗回到前景時再讀一次。
 */
import { PageHeader } from "../common/PageHeader";
import { useHotkeyRevision } from "../shell/useHotkeyRevision";
import { capsOfHotkey } from "../shell/hotkeys";
import { ErrorBar } from "../common/ErrorBar";
import { useNodeStore } from "../../store/nodeStore";
import { useReportStore } from "../../store/reportStore";
import { openFullSearch } from "../search/openFullSearch";
import { ReportBody } from "./ReportParts";
import { useReportReload } from "./useReportReload";
import "./report.css";

const WEEK_ZH = ["週日", "週一", "週二", "週三", "週四", "週五", "週六"];

export function ReportView() {
  useHotkeyRevision();
  const report = useReportStore((s) => s.report);
  const days = useReportStore((s) => s.days);
  const error = useReportStore((s) => s.error);
  const setDays = useReportStore((s) => s.setDays);
  const routes = useNodeStore((s) => s.routes);
  useReportReload("desktop");

  const day = report ? new Date(Number(report.today.slice(0, 4)), Number(report.today.slice(5, 7)) - 1, Number(report.today.slice(8, 10))) : null;
  return (
    <section className="page ns-report" aria-label="運行報告">
      <div className="sheet">
        <PageHeader
          variant="name"
          overline={{ zh: "運行報告", latin: "Operation Report" }}
          title="運行報告"
          aside={day ? `${day.getMonth() + 1}月${day.getDate()}日 ${WEEK_ZH[day.getDay()]}` : undefined}
          search={{ onOpen: () => openFullSearch(), title: `搜尋（${capsOfHotkey("global.fullsearch")}）` }}
        />
        {error && <ErrorBar message={`運行報告讀取失敗：${error}`} onRetry={() => void useReportStore.getState().load("desktop")} />}
        {report && <ReportBody r={report} shell="desktop" days={days} onDays={setDays} routes={routes} />}
      </div>
    </section>
  );
}
