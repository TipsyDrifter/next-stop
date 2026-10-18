/**
 * useMinuteTick——「現在」的分鐘節拍（主線階段②；契約 §2.1）。
 *
 * 回傳 `Date.now()`，每到整分更新一次：`setTimeout` 等到下一個 :00 秒，再 `setInterval(60_000)`；
 * 頁面從背景回前景（`visibilitychange → visible`）立刻補一次——手機背景時計時器會被凍住，回來那一分鐘不能停在舊時間。
 * 用途：已過時刻轉赭、現在線、「下一班」。多個元件各叫各的就好（一分鐘一次，成本可忽略）。
 *
 * StrictMode 雙掛載：計時器全在 effect 內建立、cleanup 全數清掉，重入不會疊加。
 */
import { useEffect, useState } from "react";

export function useMinuteTick(): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let interval: ReturnType<typeof setInterval> | undefined;
    const tick = () => setNow(Date.now());

    // 先對齊到下一個整分，之後每 60 秒一次
    const wait = 60_000 - (Date.now() % 60_000);
    timeout = setTimeout(() => {
      tick();
      interval = setInterval(tick, 60_000);
    }, wait);

    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      if (timeout !== undefined) clearTimeout(timeout);
      if (interval !== undefined) clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return now;
}
