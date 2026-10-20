/**
 * useGridDrag——方眼的拖曳選取（⑤ 契約 §5.2、§5.4、D-時-103；〈原型定案〉1；乙席）。
 *
 * - 按下的那一格＝錨點；移動超過門檻（滑鼠 4px、觸控 8px，契約 §9-4）才算拖，之後依指到的格更新 `cur`（夾在「現在那一格」以前）。
 *   沒移動過就放開＝點一下（onTap，交給呼叫端照 D-時-95 判斷）。
 * - 按在未來的格子：不開始拖（點一下照常，呼叫端 toast「還沒到」）。
 * - 手機（`edgeGuard`）：起點離螢幕左右邊 < 24px 不開始拖（讓給 Android 系統返回手勢，同 `MobileSegmentedBar` 的 EDGE_PX）；
 *   點一下照常；第一次被擋下時叫 `onEdge`（呼叫端 toast 一次說明）。
 * - 照 `SplitPanel.tsx` 的先例：pointerdown `preventDefault`、`setPointerCapture` 包 try/catch（合成事件沒有真指標）；
 *   格子區的 CSS 是 `touch-action: none; user-select: none`（§M）。拖完用一次性 capture click 擋掉誤點（＝`WeekStrip` 的 killNextClick）。
 * - 幾何：按下時量一次每一列軌道（`.ns-tt-grid-track`）的 rect；指標 → 第幾列＋列內比例 → 第幾格（格從窗頭連續編號、跨列不重來，
 *   同 `domain/timetableGrid.ts` 的 cellIndexAt）。
 *
 * 只管手勢；選區的 clampSel／snapEdges／paintModeOf 在呼叫端（GridView）做。
 */
import { useCallback, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

/** 系統返回手勢的邊緣保留帶（px；＝MobileSegmentedBar EDGE_PX） */
export const EDGE_PX = 24;
const MOUSE_SLOP = 4;
const TOUCH_SLOP = 8;

export interface GridDragState {
  anchor: number;
  cur: number;
}

export interface GridDragOpts {
  /** 寫入中、面板開著 ⇒ false（按下不理） */
  enabled: boolean;
  /** 手機：離左右邊 24px 內不開始拖 */
  edgeGuard: boolean;
  /** 每一列有幾格（rowMs ÷ cellMs） */
  cellsPerRow: number;
  /** 量軌道用：方眼列的容器（裡面的 `.ns-tt-grid-track` 依列序） */
  rowsRef: RefObject<HTMLElement | null>;
  /** 第 ci 格的開頭已經是未來（≥ now） */
  isFutureCell(ci: number): boolean;
  /** 現在那一格（拖不過它） */
  nowCell(): number;
  onTap(ci: number): void;
  /** 拖到的格變了（每一格只叫一次） */
  onDragMove(d: GridDragState): void;
  /** 放開（拖過）：anchor／cur 兩格 */
  onCommit(d: GridDragState): void;
  /** 拖到一半被取消（pointercancel、Esc） */
  onAbort(): void;
  onEdge?(): void;
}

interface Live {
  id: number;
  x0: number;
  y0: number;
  touch: boolean;
  anchor: number;
  cur: number;
  moved: boolean;
  future: boolean;
  edge: boolean;
  edgeTold: boolean;
  rects: DOMRect[];
}

const clamp = (x: number, a: number, b: number): number => Math.max(a, Math.min(b, x));

/** 指標 → 第幾格 */
function cellAt(rects: readonly DOMRect[], cpr: number, x: number, y: number): number {
  if (rects.length === 0) return 0;
  let row = rects.length - 1;
  for (let i = 0; i < rects.length; i++) {
    if (y < rects[i].bottom + 1) {
      row = i;
      break;
    }
  }
  const r = rects[row];
  const frac = r.width > 0 ? clamp((x - r.left) / r.width, 0, 0.99999) : 0;
  return row * cpr + Math.floor(frac * cpr);
}

function killNextClick(): void {
  const kill = (ev: Event): void => {
    ev.stopPropagation();
    ev.preventDefault();
  };
  window.addEventListener("click", kill, { capture: true, once: true });
  window.setTimeout(() => window.removeEventListener("click", kill, { capture: true }), 50);
}

export interface GridDragHandlers {
  onPointerDown(e: ReactPointerEvent<HTMLElement>): void;
  onPointerMove(e: ReactPointerEvent<HTMLElement>): void;
  onPointerUp(e: ReactPointerEvent<HTMLElement>): void;
  onPointerCancel(e: ReactPointerEvent<HTMLElement>): void;
}

export function useGridDrag(o: GridDragOpts): { drag: GridDragState | null; handlers: GridDragHandlers; cancel(): void } {
  const [drag, setDrag] = useState<GridDragState | null>(null);
  const live = useRef<Live | null>(null);
  const opts = useRef(o);
  opts.current = o;

  const cancel = useCallback((): void => {
    const d = live.current;
    live.current = null;
    if (d?.moved) {
      setDrag(null);
      opts.current.onAbort();
    }
  }, []);

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLElement>): void => {
    const op = opts.current;
    if (!op.enabled || e.button > 0) return;
    const target = e.target as Element | null;
    if (!target?.closest?.(".ns-tt-grid-track")) return;
    const box = op.rowsRef.current;
    if (!box) return;
    const rects = Array.from(box.querySelectorAll<HTMLElement>(".ns-tt-grid-track")).map((el) => el.getBoundingClientRect());
    const ci = cellAt(rects, op.cellsPerRow, e.clientX, e.clientY);
    const w = typeof window === "undefined" ? 0 : window.innerWidth;
    live.current = {
      id: e.pointerId,
      x0: e.clientX,
      y0: e.clientY,
      touch: e.pointerType !== "mouse",
      anchor: ci,
      cur: ci,
      moved: false,
      future: op.isFutureCell(ci),
      edge: op.edgeGuard && (e.clientX < EDGE_PX || e.clientX > w - EDGE_PX),
      edgeTold: false,
      rects,
    };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* 合成事件沒有真的指標：不抓也能拖 */
    }
    e.preventDefault();
  }, []);

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLElement>): void => {
    const d = live.current;
    if (!d || e.pointerId !== d.id) return;
    const op = opts.current;
    if (!d.moved) {
      if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < (d.touch ? TOUCH_SLOP : MOUSE_SLOP) || d.future) return;
      if (d.edge) {
        if (!d.edgeTold) {
          d.edgeTold = true;
          op.onEdge?.();
        }
        return;
      }
      d.moved = true;
      d.cur = Number.NaN; // 讓第一次一定送出
    }
    const ci = Math.min(cellAt(d.rects, op.cellsPerRow, e.clientX, e.clientY), op.nowCell());
    if (ci === d.cur) return;
    d.cur = ci;
    const st = { anchor: d.anchor, cur: ci };
    setDrag(st);
    op.onDragMove(st);
  }, []);

  const onPointerUp = useCallback((e: ReactPointerEvent<HTMLElement>): void => {
    const d = live.current;
    if (!d || e.pointerId !== d.id) return;
    live.current = null;
    const op = opts.current;
    if (!d.moved) {
      if (!d.edge || !d.edgeTold) op.onTap(d.anchor);
      return;
    }
    setDrag(null);
    killNextClick();
    op.onCommit({ anchor: d.anchor, cur: Number.isNaN(d.cur) ? d.anchor : d.cur });
  }, []);

  const onPointerCancel = useCallback(
    (e: ReactPointerEvent<HTMLElement>): void => {
      const d = live.current;
      if (!d || e.pointerId !== d.id) return;
      cancel();
    },
    [cancel],
  );

  const handlers = useMemo(
    () => ({ onPointerDown, onPointerMove, onPointerUp, onPointerCancel }),
    [onPointerDown, onPointerMove, onPointerUp, onPointerCancel],
  );
  return { drag, handlers, cancel };
}
