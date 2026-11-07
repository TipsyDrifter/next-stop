/**
 * useExternalIntake——把外面丟進來的連結接進 App（⑬ 外部入口；契約 第二節）。兩端共用：
 * 三個時機（掛上＝冷啟動、回前景、原生敲門）同 `useShareIntake`；取＋逐筆跑＋確認才刪、同時只跑一趟的規則在 `createExternalDrainer`。
 *
 * 冷啟動要等資料：資料庫打不開（降版閘門）就不取，連結留在佇列裡等下一次；
 * 路線要等 App 自動開好第一條——不等的話，App 那支 `openRoute(第一條)` 可能比連結的跳轉晚回來，把畫面蓋回第一條路線。
 */
import { useEffect } from "react";
import { MOCK_MODE } from "../../data";
import { createExternalDrainer } from "../../domain/externalLink";
import { dbUsable } from "../../lib/db";
import { useNodeStore } from "../../store/nodeStore";
import { externalAck, externalBridgeUsable, externalTake, onExternalOpen } from "./externalBridge";
import { runExternalLink } from "./runExternalAction";

/** App 的自動開路線最多等這麼久（真的卡住也要讓連結跑） */
const ROUTE_SETTLE_MAX_MS = 2_000;

async function nodeStoreSettled(): Promise<void> {
  const first = useNodeStore.getState();
  if (first.routes.length === 0) await first.loadSidebar();
  const settled = (): boolean => {
    const s = useNodeStore.getState();
    return (s.routeId !== null && !s.loading) || s.liveRoutes.length === 0;
  };
  if (settled()) return;
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      unsub();
      resolve();
    };
    const timer = setTimeout(done, ROUTE_SETTLE_MAX_MS);
    // 等這個同步段走完才判斷：openRoute 先設 routeId、同一段才設 loading，夾在中間會以為已經好了
    const unsub = useNodeStore.subscribe(() => {
      queueMicrotask(() => {
        if (settled()) done();
      });
    });
  });
}

const drain = createExternalDrainer({
  take: async () => {
    if (!MOCK_MODE && !(await dbUsable())) return [];
    return externalTake();
  },
  run: async (it) => {
    await nodeStoreSettled();
    await runExternalLink(it.url, it.at);
  },
  ack: externalAck,
  onError: (e) => console.warn("[external] 取連結失敗：", e),
});

export function useExternalIntake(): void {
  useEffect(() => {
    if (!externalBridgeUsable()) return;
    void drain();
    const onVisible = () => {
      if (document.visibilityState === "visible") void drain();
    };
    document.addEventListener("visibilitychange", onVisible);
    let unlisten: (() => void) | null = null;
    let alive = true;
    void onExternalOpen(() => void drain()).then((un) => {
      if (alive) unlisten = un;
      else un();
    });
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", onVisible);
      unlisten?.();
    };
  }, []);
}
