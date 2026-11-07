/**
 * useBoardKeyboard——看板的鍵盤流（⑫；路線看板、篩選清單共用；手機沒有）。鍵位在 ui/shell/hotkeys.ts 的 board 組。
 *
 * 游標＝uiStore.selectedId（側板跟著它，同大綱）。↑↓ 在欄內移、←→ 跳到隔壁有卡的欄（同一列高度附近）；
 * Enter 開側板、Space 蓋済、Alt＋←→ 把這張（或選取的那批）換到隔壁欄、Ctrl＋A 全選、Esc 先清多選再交給呼叫端。
 * 表本身放在容器的 onKeyDown：輸入框、按鈕上的 Enter／Space 放行（同大綱的雙模式鐵則）。
 * 選單選完、卡被搬走時焦點會掉到 body、keydown 不經過容器：window 掛後援（同時刻表 F2，契約 0-13），開著對話框不接。
 */
import { useCallback, useEffect, useRef, type KeyboardEvent } from "react";
import type { NodeRow } from "../../domain";
import { selectAll, clearIfAny } from "../common/selection/desktopSelection";
import { selectedIn } from "../../store/selectionStore";
import { useUiStore } from "../../store/uiStore";
import { isEditableTarget, resolveHotkey } from "../shell/hotkeys";

/** 鍵盤要的最小欄形狀（RouteBoard、FilterView 都給得出來） */
export interface KeyColumn {
  key: string;
  ids: string[];
}

export interface BoardKeyOptions {
  columns: readonly KeyColumn[];
  order: readonly string[];
  node(id: string): NodeRow | undefined;
  stamp(node: NodeRow): void;
  /** 換到另一欄；回 false＝這一頁不能換（唯讀） */
  shift(ids: readonly string[], column: KeyColumn): void;
  escape(): void;
}

function reveal(id: string): void {
  requestAnimationFrame(() => document.querySelector(`[data-node-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" }));
}

export function useBoardKeyboard(o: BoardKeyOptions) {
  const handle = useCallback(
    (e: KeyboardEvent<HTMLElement> | globalThis.KeyboardEvent) => {
      if (e.keyCode === 229 || ("nativeEvent" in e ? e.nativeEvent : e).isComposing) return;
      if (isEditableTarget(e.target)) return;
      const onButton = e.target instanceof HTMLElement && e.target.tagName === "BUTTON";
      if (onButton && (e.key === "Enter" || e.key === " ")) return;
      const hit = resolveHotkey("board", e);
      if (!hit) return;

      const ui = useUiStore.getState();
      const cursor = ui.selectedId && o.order.includes(ui.selectedId) ? ui.selectedId : null;
      const go = (id: string | undefined) => {
        if (!id) return;
        ui.select(id);
        reveal(id);
      };
      const colIdx = cursor ? o.columns.findIndex((c) => c.ids.includes(cursor)) : -1;
      const rowIdx = cursor && colIdx >= 0 ? o.columns[colIdx].ids.indexOf(cursor) : 0;
      /** 往左右找第一個有卡的欄 */
      const nextFilled = (dir: 1 | -1): KeyColumn | undefined => {
        for (let i = colIdx + dir; i >= 0 && i < o.columns.length; i += dir) if (o.columns[i].ids.length) return o.columns[i];
        return undefined;
      };

      switch (hit.id) {
        case "board.move.up":
          if (!cursor) go(o.order[0]);
          else go(o.columns[colIdx].ids[Math.max(0, rowIdx - 1)]);
          break;
        case "board.move.down":
          if (!cursor) go(o.order[0]);
          else go(o.columns[colIdx].ids[Math.min(o.columns[colIdx].ids.length - 1, rowIdx + 1)]);
          break;
        case "board.move.left":
        case "board.move.right": {
          if (!cursor) {
            go(o.order[0]);
            break;
          }
          const c = nextFilled(hit.id === "board.move.left" ? -1 : 1);
          if (c) go(c.ids[Math.min(c.ids.length - 1, rowIdx)]);
          break;
        }
        case "board.shift.left":
        case "board.shift.right": {
          if (!cursor) break;
          const c = o.columns[colIdx + (hit.id === "board.shift.left" ? -1 : 1)];
          if (!c) break;
          const picked = selectedIn("board");
          o.shift(picked.includes(cursor) ? picked : [cursor], c);
          break;
        }
        case "board.open":
          if (cursor) ui.setPanelOpen(true);
          else go(o.order[0]);
          break;
        case "board.complete": {
          const n = cursor ? o.node(cursor) : undefined;
          if (n) o.stamp(n);
          break;
        }
        case "board.select.all":
          selectAll("board", o.order);
          break;
        case "board.escape":
          if (!clearIfAny("board")) o.escape();
          break;
        default:
          return;
      }
      e.preventDefault();
      e.stopPropagation();
    },
    [o],
  );
  const latest = useRef(handle);
  latest.current = handle;
  useEffect(() => {
    const onWindow = (e: globalThis.KeyboardEvent) => {
      if (e.target === document.body && !document.querySelector('[role="dialog"], [role="alertdialog"]')) latest.current(e);
    };
    window.addEventListener("keydown", onWindow);
    return () => window.removeEventListener("keydown", onWindow);
  }, []);
  return handle;
}
