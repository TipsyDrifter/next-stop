/**
 * 種預設資料前先等同步一趟（時刻表分類、售票口分類、幹線共用）。
 * 已加入同步的裝置先把別台的東西拉下來：別台已經有資料、或刪過預設的，這台才不會用預設值蓋回去。
 */
import { MOCK_MODE } from "../data";
import { useSyncStore } from "./syncStore";

/** 等同步這一趟收完（最多 ms）；boot 回來發現這台沒加入或開關關著就不等 */
export function waitForSyncSettle(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const s0 = useSyncStore.getState();
    const lastAt0 = s0.status?.last_sync_at ?? null;
    let sawWorking = s0.working;
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsub();
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const unsub = useSyncStore.subscribe((s) => {
      // boot 回來了、但這台沒加入或開關關著 ⇒ 不必等
      if (s.status && !(s.status.joined && s.status.enabled)) finish();
      if (s.status && (s.status.last_sync_at ?? null) !== lastAt0) finish();
      if (s.working) sawWorking = true;
      else if (sawWorking) finish();
    });
  });
}

/** 種預設資料前的閘門：已加入、開著、在線才等（boot 還沒回來當作可能已加入） */
export async function settleBeforeSeeding(ms = 10_000): Promise<void> {
  if (MOCK_MODE) return;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  const st = useSyncStore.getState().status;
  if (st === null || (st.joined && st.enabled)) await waitForSyncSettle(ms);
}
