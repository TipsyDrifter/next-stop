/**
 * useTimetableForeground——桌機頁回前景時重讀 DB＋「回來時主動問」（車次①a 契約 §5.2、0-10；丙席）。
 * 回前景＝`hidden→visible`；桌機 `focus` 須距上次 `blur` ≥10 分鐘才算（短暫切去別的視窗不算「回來」）。
 * 每次回來：`store.refresh()`（計時用時間戳、背景不累加，回前景先重讀）→ `onVisible?.()` → `ask` 時 `store.autoAsk("foreground", true)`。
 * 手機不用這支（回前景由 TimetableMobileAgent 處理，頁面不重複掛）。
 */
import { useEffect, useRef } from "react";
import { MIN } from "../../domain/timetable";
import { useTimetableStore } from "../../store/timetableStore";

export interface TimetableForegroundOptions {
  ask: boolean;
  onVisible?: () => void;
}

const FOCUS_GAP_MS = 10 * MIN;

export function useTimetableForeground(opts: TimetableForegroundOptions): void {
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    if (typeof document === "undefined") return;
    let awaySince = 0; // 上次 blur／hidden 的時刻；0＝不在「離開」狀態
    let busy = false;

    const fire = (): void => {
      awaySince = 0;
      if (busy) return;
      busy = true;
      void useTimetableStore
        .getState()
        .refresh()
        .then(() => {
          optsRef.current.onVisible?.();
          if (optsRef.current.ask) useTimetableStore.getState().autoAsk("foreground", true);
        })
        .finally(() => {
          busy = false;
        });
    };
    const onVisibility = (): void => {
      if (document.visibilityState === "visible") fire();
      else awaySince = Date.now();
    };
    const onBlur = (): void => {
      if (!awaySince) awaySince = Date.now();
    };
    const onFocus = (): void => {
      if (awaySince && Date.now() - awaySince >= FOCUS_GAP_MS) fire();
      else awaySince = 0;
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
    };
  }, []);
}
