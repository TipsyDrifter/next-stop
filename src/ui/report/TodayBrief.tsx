/**
 * TodayBrief——今日頁的「今日小結」一行（② 運行報告 D-主-184；使用者 11-01 定：兩端都放）。
 * 視覺真相＝prototypes/design-stats-review-運行報告.html?scr=today&device=desk|mob。
 *
 * `済 N　記錄 Xh　花了 N　運行報告 ›`：整條是一顆按鈕、點了進運行報告。桌機在頁首日期下方（PageHeader `below`），
 * 手機在「今天的列車」上方。某條線沒通車就不出那一段；數字是事實（0 也照寫）。
 * 口徑同運行報告的卡片：済＝domain/seals.ts；記錄＝時刻表統計「日」的已記錄；花了＝售票口今天的支出。
 * 今天清單變動、回到前景、每分鐘（時間塊在跑、別頁記的帳）重讀；第一次還沒讀到就不畫（不留空殼）。
 */
import { fmtDur } from "../../domain/timetable";
import { moneyText } from "../../domain/ticket";
import { useReportStore } from "../../store/reportStore";
import { openReport, type ReportShellKind } from "./reportJumps";
import { useReload } from "./useReportReload";
import "./report.css";

export function TodayBrief({ shell }: { shell: ReportShellKind }) {
  const brief = useReportStore((s) => s.brief);
  useReload(() => void useReportStore.getState().loadBrief(shell), 60_000);
  if (!brief) return null;
  const parts = [`済 ${brief.seals}`];
  if (brief.recordedMs !== null) parts.push(`記錄 ${fmtDur(brief.recordedMs)}`);
  if (brief.spent !== null) parts.push(`花了 ${moneyText(brief.spent, brief.decimals, { whole: true })}`);
  return (
    <button
      type="button"
      className={`ns-rp-brief${shell === "mobile" ? " is-mobile" : ""}`}
      onClick={() => openReport(shell)}
      aria-label={`今日小結：${parts.join("、")}。點了看運行報告`}
    >
      <span className="facts">
        <span>
          済 <b className="num">{brief.seals}</b>
        </span>
        {brief.recordedMs !== null && (
          <span>
            記錄 <b className="num">{fmtDur(brief.recordedMs)}</b>
          </span>
        )}
        {brief.spent !== null && (
          <span>
            花了 <b className="amt">{moneyText(brief.spent, brief.decimals, { whole: true })}</b>
          </span>
        )}
      </span>
      <span className="to">
        運行報告 <span aria-hidden="true">›</span>
      </span>
    </button>
  );
}
