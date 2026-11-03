/**
 * mobileSelect——手機多選與拖曳的共用小件（回饋乙 D-主-152／153；契約 docs/research/2026-11-01-回饋乙-契約.md §0 ☎2、☎3④、§4）。
 * 今日、行程表、路線圖第二層三處同一套：
 *   - 長按原地放開＝進多選並勾這張；已經在多選中＝加選（不要把選好的整批換掉）——`pressSelect`
 *   - 多選中點卡片＝加選／取消（selectionStore.selectionClick 的 touchMode）——`tapSelect`
 *   - 卡片被選中的樣子：左側勾選圈（`SelectCheck`）＋選中底（--sel-bg，樣式在 mobile-select.css）
 *   - 滑動手勢的字跟著那一列變（例：定期券左滑＝「運休」、未來的票＝「晚一天」）——`usePressedSwipe`
 *     共用元件的 SwipeAction.label 是固定字；這裡在清單根節點的 capture 階段記下按的是哪一列，
 *     給元件一個 getter 物件，元件讀 `swipe.left` 的那一刻才照那一列決定動作與字（不改共用元件）。
 */
import { useEffect, useMemo, useRef } from "react";
import type { SwipeAction } from "../common/dragReorder";
import { selectionClick, useSelectionStore, type SelectionScope } from "../../store/selectionStore";
import "./mobile-select.css";

const EMPTY: string[] = [];

/** 這一頁目前選了哪些（別頁的不算）；ids 照畫面順序 */
export function useScopeSelection(scope: SelectionScope): string[] {
  return useSelectionStore((s) => (s.scope === scope && s.ids.length ? s.ids : EMPTY));
}

/** 長按原地放開：沒在多選＝進多選並勾這張；已在多選＝加選（已勾的不動） */
export function pressSelect(scope: SelectionScope, id: string, order: readonly string[]): void {
  const s = useSelectionStore.getState();
  if (s.scope === scope && s.ids.length) {
    if (!s.ids.includes(id)) s.toggle(scope, id, order);
    return;
  }
  s.start(scope, id);
}

/** 多選中點卡片＝加選或取消；回 false＝不在多選中（照卡片原本的單擊） */
export function tapSelect(scope: SelectionScope, id: string, order: readonly string[]): boolean {
  return selectionClick(scope, id, order, { ctrl: false, shift: false }, { touchMode: true });
}

/** 這一頁在多選中嗎（給滑動手勢的 enabled 用：多選中不滑） */
export function isSelecting(scope: SelectionScope): boolean {
  const s = useSelectionStore.getState();
  return s.scope === scope && s.ids.length > 0;
}

/** 清單換了：拿掉已經不在畫面上的；離開這一頁（卸載）時清掉這一頁的多選 */
export function usePruneSelection(scope: SelectionScope, visible: readonly string[]): void {
  const key = visible.join("|");
  const ref = useRef(visible);
  ref.current = visible;
  useEffect(() => {
    useSelectionStore.getState().prune(scope, ref.current);
  }, [scope, key]);
  useEffect(
    () => () => {
      if (useSelectionStore.getState().scope === scope) useSelectionStore.getState().clear();
    },
    [scope],
  );
}

/** 拖起選中的那一張＝整批一起走（照畫面順序）；拖沒選的那張＝只有它 */
export function batchDragIds(scope: SelectionScope, id: string, order: readonly string[]): string[] {
  const s = useSelectionStore.getState();
  if (s.scope !== scope || !s.ids.includes(id)) return [id];
  const want = new Set(s.ids);
  return order.filter((x) => want.has(x));
}

/** 左側勾選圈（多選中才畫；選中＝實心靛＋勾） */
export function SelectCheck({ picked }: { picked: boolean }) {
  return (
    <span className={"m-sel-check" + (picked ? " is-on" : "")} aria-hidden>
      <i>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
          <path d="M3.6 8.4 6.6 11.2 12.4 4.8" />
        </svg>
      </i>
    </span>
  );
}

export interface SwipePair {
  right?: SwipeAction;
  left?: SwipeAction;
}

/**
 * 滑動手勢照「按下的那一列」決定動作（理由見檔頭）。`forId` 回那一列的左右動作（沒有＝那一側滑不開）。
 * 回傳的物件交給 useDragReorder 的 `swipe`；同一個 root 掛一次。
 */
export function usePressedSwipe(root: HTMLElement | null, forId: (id: string) => SwipePair): SwipePair {
  const pressed = useRef<string | null>(null);
  const fn = useRef(forId);
  fn.current = forId;
  useEffect(() => {
    if (!root) return;
    const onDown = (e: PointerEvent) => {
      pressed.current = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-drag-id]")?.dataset.dragId ?? null;
    };
    root.addEventListener("pointerdown", onDown, true);
    return () => root.removeEventListener("pointerdown", onDown, true);
  }, [root]);
  return useMemo<SwipePair>(
    () => ({
      get right() {
        const id = pressed.current;
        return id ? fn.current(id).right : undefined;
      },
      get left() {
        const id = pressed.current;
        return id ? fn.current(id).left : undefined;
      },
    }),
    [],
  );
}
