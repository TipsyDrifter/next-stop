/**
 * 預設幹線與售票口預設分類的種植時機（癸，D-主-531）。表裡還沒有東西（含墓碑）才種，所以只有第一次裝和清空之後會發生。
 * 開機跑一次；每趟同步之後再看一次，別台按「一起清空」不重開 App，靠這一條補上。
 * 不擋開機：等同步的這段時間畫面照常可用。時刻表分類在 timetableStore 自己種（頁面要等它才算載好）。
 */
import { nodeRepo } from "../data";
import { ticketRepo } from "../data/ticketRepository";
import { settleBeforeSeeding } from "./syncSettle";
import { onAfterPull, refreshAfterPull } from "./syncStore";

let running: Promise<void> | null = null;

function seedOnce(): Promise<void> {
  if (!running) {
    running = (async () => {
      const [nodes, categories] = await Promise.all([nodeRepo.countAllNodes(), ticketRepo.countCustomCategoriesIncludingDeleted()]);
      if (nodes > 0 && categories > 0) return;
      await settleBeforeSeeding();
      const changed: string[] = [];
      if (nodes === 0 && (await nodeRepo.ensureStarterLines())) changed.push("nodes");
      if (categories === 0 && (await ticketRepo.ensureDefaultCategories()) > 0) changed.push("tk_categories");
      if (changed.length) await refreshAfterPull({ changed_tables: changed });
    })()
      .catch((e: unknown) => console.warn("[next-stop] 種預設資料失敗：", e instanceof Error ? e.message : String(e)))
      .finally(() => {
        running = null;
      });
  }
  return running;
}

/** App 開機流程叫一次；回傳取消登記 */
export function startStarterSeed(): () => void {
  void seedOnce();
  return onAfterPull(() => void seedOnce());
}
