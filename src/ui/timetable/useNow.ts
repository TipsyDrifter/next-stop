/**
 * useNow——畫面上的「現在」（車次①a 契約 §2.0；甲席 Stage 0）。
 * 計時用時間戳：畫面每 interval 用「現在減開始」重算，背景不累加（契約 §1-7）。
 * `document.visibilityState === "visible"` 時每 interval 回 `Date.now()`；回前景立即更新一次。
 */
import { useEffect, useState } from "react";

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = (): void => {
      if (timer !== null) return;
      setNow(Date.now());
      timer = setInterval(() => setNow(Date.now()), intervalMs);
    };
    const stop = (): void => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };
    const onVis = (): void => {
      if (document.visibilityState === "visible") start();
      else stop();
    };
    onVis();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [intervalMs]);
  return now;
}
