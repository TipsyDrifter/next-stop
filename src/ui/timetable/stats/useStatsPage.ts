/**
 * useStatsPage——統計頁兩殼共用的掛載邏輯與「待確認清單 → 其實到幾點 → 回清單」的接續（③ 契約 §5.3、0-7；乙席）。
 *
 * - 掛上：`timetableStatsStore.load()`（叫了就算「開著」，之後上游變了自動重算）；卸下：`release("stats")`。
 * - 每分鐘：`checkDay()`（#72：換日時「本期」跟著換；只比字串）。
 * - 待確認清單點一列 ⇒ `markPendingReturn` 記下從哪來，再 `openSheet({ kind: "longRun", blockId, then: null })`（照契約）。
 *   longRun 面板確認成功（store 自己把 sheet 收成 null、`dismissedLongRunId` 不動）⇒ 等統計重算完：
 *   清單還有東西 ⇒ 重開同一張清單（即時少一列）；清空了 ⇒ toast「都確認好了」。
 *   被略過（× ／Esc／點暗幕 ⇒ `closeSheet` 把 `dismissedLongRunId` 設成這一塊）⇒ 不接續，整個收掉。
 *   不改 `TimetableSheet.longRun.then` 的型別（修正席同時在動 store），接續狀態只活在這個模組。
 */
import { useEffect } from "react";
import { TT_TEXT, useTimetableStore } from "../../../store/timetableStore";
import { useTimetableStatsStore } from "../../../store/timetableStatsStore";
import { useUiStore } from "../../../store/uiStore";
import type { PendingItem } from "../../../domain/timetableStats";
import { useNow } from "../useNow";

interface PendingReturn {
  blockId: string;
  goalId: string | null;
  from: number;
  to: number;
}

let pendingReturn: PendingReturn | null = null;

/** 清單點一列之前叫：記住回哪一張清單 */
export function markPendingReturn(r: PendingReturn): void {
  pendingReturn = r;
}

/** 這張清單現在該列哪些（期間＝正在看的那一期；目標＝那個目標現在的範圍） */
export function pendingItemsFor(goalId: string | null | undefined): PendingItem[] {
  const st = useTimetableStatsStore.getState();
  if (goalId) return st.goals.find((g) => g.goal.id === goalId)?.cur.pendingItems ?? [];
  return st.result?.pending ?? [];
}

/** 模組層訂閱（只裝一次）：longRun 收起來時決定要不要回清單 */
let watching = false;
function watchLongRunClose(): void {
  if (watching) return;
  watching = true;
  useTimetableStore.subscribe((s, p) => {
    const r = pendingReturn;
    if (!r) return;
    const was = p.sheet;
    if (!(was && was.kind === "longRun" && was.blockId === r.blockId)) return;
    if (s.sheet !== null) {
      // 換成別的面板（例如 longRun 裡又開了別的東西）：這趟接續作廢
      if (!(s.sheet.kind === "longRun" && s.sheet.blockId === r.blockId)) pendingReturn = null;
      return;
    }
    pendingReturn = null;
    const dismissed = s.dismissedLongRunId === r.blockId && p.dismissedLongRunId !== r.blockId;
    if (dismissed) return;
    // 寫入 → refresh → rev 變 ⇒ 統計已排了重算；load() 回的是那一趟（含合併進來的）的 promise
    void useTimetableStatsStore
      .getState()
      .load()
      .then(() => {
        const tt = useTimetableStore.getState();
        if (tt.sheet !== null) return; // 這段時間使用者自己開了別的面板：不搶
        const left = pendingItemsFor(r.goalId);
        if (left.length) tt.openSheet({ kind: "pendingList", from: r.from, to: r.to, goalId: r.goalId });
        else useUiStore.getState().showToast({ message: TT_TEXT.pendingAllDone }, 4000);
      })
      .catch(() => undefined);
  });
}

/** 兩殼的統計頁掛上時叫 */
export function useStatsPage(): number {
  const now = useNow(60_000);
  // 子元件的 effect 比殼（TimetableView／MobileTimetable）的 init 先跑：等 ready 才 load（甲席回報「要在 init(shell) 之後」，
  // period 的本機鍵分兩殼記、要先知道是哪一殼）
  const ready = useTimetableStore((s) => s.ready);
  useEffect(() => {
    watchLongRunClose();
    if (!ready) return;
    void useTimetableStatsStore.getState().load();
    return () => useTimetableStatsStore.getState().release("stats");
  }, [ready]);
  useEffect(() => {
    useTimetableStatsStore.getState().checkDay();
  }, [now]);
  return now;
}
