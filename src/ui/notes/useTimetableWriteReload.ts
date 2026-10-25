/**
 * 足跡畫著的期間（桌機足跡卡、手機足跡區掛上就訂閱）：時刻表寫入——出發、抵達、改時間、同步、回前景——
 * 後 `useTimetableStore.rev` 變 ⇒ 重讀足跡（日記足跡班 D-筆-72）。只讀 rev，不改時刻表 store。
 */
import { useEffect } from "react";
import { useNotesStore } from "../../store/notesStore";
import { useTimetableStore } from "../../store/timetableStore";

export function useTimetableWriteReload(): void {
  useEffect(
    () =>
      useTimetableStore.subscribe((s, p) => {
        if (s.rev !== p.rev) void useNotesStore.getState().loadFootprint();
      }),
    [],
  );
}
