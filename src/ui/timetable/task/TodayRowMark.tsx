/**
 * TodayRowMark——手機票卡上的「正在跑」標記（車次② 契約 §5.1 手機、0-11；丙）。
 * 段一只寫好、不登記；段二填值 commit 才掛進 `todayRowActions` 的 `Mobile`（畫在 `MobileTicket` 的 `.m-tk-meta` 之後，§6.1 #S5）。
 *
 * 畫的條件＝運行中那班 `node_id === nodeId` **而且** 不是唯讀 **而且** `railDate === null || railDate <= today`；否則 null。
 * 今日子頁與行程表串流共用 `MobileTicket`：行程表裡同一個重複任務每天一張卡、nodeId 都一樣——歷史班次是唯讀、
 * 未來班次的 railDate 在今天之後，兩種都不畫 ⇒ 只亮今天那一張（§9-12 的兩張目前班次邊角遇到記回報）。
 * 長相＝桌機同一個 `RunMark`（`.is-m`：小一號、經過時間只到分）；點了換到時刻表 tab。
 */
import { useTimetableStore } from "../../../store/timetableStore";
import { RunMark } from "./TodayRowDepart";
import "../timetable.css";

export function TodayRowMark({
  nodeId,
  readOnly,
  railDate,
  today,
}: {
  nodeId: string;
  name: string;
  readOnly: boolean;
  railDate: string | null;
  today: string;
}) {
  const running = useTimetableStore((s) => (s.running !== null && s.running.node_id === nodeId ? s.running : null));
  if (!running || readOnly || (railDate !== null && railDate > today)) return null;
  return <RunMark block={running} shell="mobile" />;
}
