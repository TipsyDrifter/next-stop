/**
 * 運行報告／今日小結什麼時候重讀（② 運行報告；契約 §2、§7）：
 *   - 掛上就讀一次；
 *   - 今天的清單變了（蓋済、取消、推遲、同步拉下來 ⇒ nodeStore.today 換了一份）；
 *   - 視窗回到前景；
 *   - `everyMs`（今日小結給 60 秒：時間塊在跑、別頁記的帳）——只在看得見時跑。
 * 讀的是本機 SQLite 幾句 SELECT，次數不多；同時多次叫由 store 只採最後一次。
 */
import { useEffect } from "react";
import { useNodeStore } from "../../store/nodeStore";
import { useReportStore, type ReportShell } from "../../store/reportStore";

export function useReload(run: () => void, everyMs: number | null = null): void {
  const todayRev = useNodeStore((s) => s.today);
  useEffect(() => {
    run();
    // run 是 store 的函式包一層（呼叫端每次 render 給新的箭頭函式）：依賴只看今天清單，免得每次 render 都重讀
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [todayRev]);
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible") run();
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onVis);
    const timer = everyMs
      ? window.setInterval(() => {
          if (document.visibilityState === "visible") run();
        }, everyMs)
      : null;
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onVis);
      if (timer !== null) window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [everyMs]);
}

export function useReportReload(shell: ReportShell): void {
  useReload(() => void useReportStore.getState().load(shell));
}
