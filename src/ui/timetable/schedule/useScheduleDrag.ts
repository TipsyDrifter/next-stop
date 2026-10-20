/**
 * useScheduleDrag——日程的拖曳排時刻（④ 契約 §5.5、D-時-78；〈原型定案〉7；乙席）。
 *
 * 來源兩種：還沒排清單的項（src "list"）、預定欄裡已排的卡（src "card"）。目標只有預定欄。
 * - 桌機（滑鼠）：按下後移動 > 4px 就開始拖。
 * - 手機（觸控）：長按 0.4 秒浮起來再拖；0.4 秒內移動 > 8px ＝ 使用者在捲，放手不管。
 *   浮起來之後擋掉捲動（document 上一支非 passive 的 touchmove）。真觸控會不會被捲動搶走要 AVD／真機驗（契約 §9-3）。
 * - 指標位置 → 預定欄裡的比例 → 吸附 15 分（`snapFrac`）。卡：減掉抓的位置（卡頂對齊落點）；清單：落點在指標上方 10px。
 * - 拖到預定欄邊緣自動捲（requestAnimationFrame）。放開：在欄裡 ⇒ onDrop(key, 分鐘)；拖出去 ⇒ 取消（清單項另外 onMiss）。
 * - 拖完的那一下 click 吞掉（350ms），免得放開又觸發「點選／開面板」。
 *
 * 狀態只有畫面要的（落點分鐘、指標座標）；資料寫入由呼叫端的 onDrop 走 store.placeAt。
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { snapFrac } from "./scheduleModel";

export type DragSrc = "list" | "card";

export interface DragView {
  key: string;
  src: DragSrc;
  /** 落點（牆鐘分鐘，已吸附）；不在欄裡＝null */
  min: number | null;
  /** 指標的視窗座標（清單項的浮籤跟著它） */
  x: number;
  y: number;
}

interface Pending {
  key: string;
  src: DragSrc;
  el: HTMLElement;
  pointerId: number;
  touch: boolean;
  x0: number;
  y0: number;
  x: number;
  y: number;
  grabDy: number;
  mode: "pending" | "drag";
  timer: ReturnType<typeof setTimeout> | null;
  min: number | null;
}

export interface ScheduleDragOpts {
  /** 能不能拖（過去的日子、寫入中 ⇒ false） */
  enabled: boolean;
  dayStartHour: number;
  /** 預定欄（量比例用；高＝一整天） */
  pcolRef: RefObject<HTMLElement | null>;
  /** 捲動的那一層（自動捲、判斷指標在不在可見範圍） */
  scrollRef: RefObject<HTMLElement | null>;
  onDrop(key: string, min: number): void;
  onMiss?(src: DragSrc): void;
}

const LONG_PRESS_MS = 400;
const MOUSE_SLOP = 4;
const TOUCH_SLOP = 8;
const EDGE = 44;

export function useScheduleDrag(o: ScheduleDragOpts) {
  const [view, setView] = useState<DragView | null>(null);
  const p = useRef<Pending | null>(null);
  const noClickUntil = useRef(0);
  const raf = useRef(0);
  const opts = useRef(o);
  opts.current = o;

  /** 指標 → 落點 */
  const measure = useCallback((x: number, y: number, d: Pending): number | null => {
    const pc = opts.current.pcolRef.current;
    const sc = opts.current.scrollRef.current;
    if (!pc || !sc) return null;
    const r = pc.getBoundingClientRect();
    const s = sc.getBoundingClientRect();
    const inY = y >= s.top && y <= s.bottom;
    const pad = d.src === "card" ? 40 : 10;
    const inX = x >= r.left - pad && x <= r.right + pad;
    if (!inX || !inY || r.height <= 0) return null;
    return snapFrac((y - r.top - d.grabDy) / r.height, opts.current.dayStartHour);
  }, []);

  const publish = useCallback((d: Pending) => {
    setView({ key: d.key, src: d.src, min: d.min, x: d.x, y: d.y });
  }, []);

  const stopAuto = (): void => {
    cancelAnimationFrame(raf.current);
    raf.current = 0;
  };

  const startDrag = useCallback(
    (d: Pending) => {
      d.mode = "drag";
      d.el.classList.add("is-lifted");
      if (d.touch && typeof navigator !== "undefined" && "vibrate" in navigator) {
        try {
          navigator.vibrate(12);
        } catch {
          /* 沒有震動就算了 */
        }
      }
      d.min = measure(d.x, d.y, d);
      publish(d);
      const loop = (): void => {
        const cur = p.current;
        if (!cur || cur.mode !== "drag") return;
        const sc = opts.current.scrollRef.current;
        if (sc) {
          const r = sc.getBoundingClientRect();
          let v = 0;
          if (cur.y < r.top + EDGE && cur.y > r.top - 60) v = -Math.ceil((r.top + EDGE - cur.y) / 5);
          else if (cur.y > r.bottom - EDGE && cur.y < r.bottom + 60) v = Math.ceil((cur.y - (r.bottom - EDGE)) / 5);
          if (v && cur.min !== null) {
            sc.scrollTop += v;
            const m = measure(cur.x, cur.y, cur);
            if (m !== cur.min) {
              cur.min = m;
              publish(cur);
            }
          }
        }
        raf.current = requestAnimationFrame(loop);
      };
      stopAuto();
      raf.current = requestAnimationFrame(loop);
    },
    [measure, publish],
  );

  const end = useCallback(
    (drop: boolean) => {
      const d = p.current;
      if (!d) return;
      p.current = null;
      if (d.timer) clearTimeout(d.timer);
      stopAuto();
      if (d.mode !== "drag") return;
      d.el.classList.remove("is-lifted");
      noClickUntil.current = Date.now() + 350;
      setView(null);
      if (!drop) return;
      if (d.min !== null) opts.current.onDrop(d.key, d.min);
      else opts.current.onMiss?.(d.src);
    },
    [],
  );

  // document 層的 move／up：拖曳中指標會離開來源元素
  useEffect(() => {
    const onMove = (e: PointerEvent): void => {
      const d = p.current;
      if (!d || e.pointerId !== d.pointerId) return;
      d.x = e.clientX;
      d.y = e.clientY;
      if (d.mode === "pending") {
        const dist = Math.hypot(e.clientX - d.x0, e.clientY - d.y0);
        if (!d.touch && dist > MOUSE_SLOP) startDrag(d);
        else if (d.touch && dist > TOUCH_SLOP) {
          if (d.timer) clearTimeout(d.timer);
          p.current = null; // 在捲：放手不管
        }
        return;
      }
      e.preventDefault();
      const m = measure(d.x, d.y, d);
      d.min = m;
      publish(d);
    };
    const onUp = (e: PointerEvent): void => {
      if (p.current && e.pointerId === p.current.pointerId) end(true);
    };
    const onCancel = (e: PointerEvent): void => {
      if (p.current && e.pointerId === p.current.pointerId) end(false);
    };
    // 浮起來之後：手指拖的是那張票，不是捲頁
    const onTouchMove = (e: TouchEvent): void => {
      if (p.current && p.current.mode === "drag") e.preventDefault();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && p.current?.mode === "drag") {
        e.preventDefault();
        e.stopPropagation();
        end(false);
      }
    };
    const onCtx = (e: Event): void => {
      if (p.current) e.preventDefault();
    };
    document.addEventListener("pointermove", onMove, { passive: false });
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onCancel);
    document.addEventListener("touchmove", onTouchMove, { passive: false });
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("contextmenu", onCtx);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onCancel);
      document.removeEventListener("touchmove", onTouchMove);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("contextmenu", onCtx);
      const d = p.current;
      if (d?.timer) clearTimeout(d.timer);
      d?.el.classList.remove("is-lifted");
      p.current = null;
      stopAuto();
    };
  }, [end, measure, publish, startDrag]);

  /** 綁在可拖的元素上（清單項、卡） */
  const onPointerDown = useCallback(
    (key: string, src: DragSrc) => (e: ReactPointerEvent<HTMLElement>) => {
      if (!opts.current.enabled || e.button > 0 || p.current) return;
      const el = e.currentTarget;
      const touch = e.pointerType === "touch" || e.pointerType === "pen";
      let grabDy = 10;
      if (src === "card") grabDy = e.clientY - el.getBoundingClientRect().top;
      const d: Pending = {
        key,
        src,
        el,
        pointerId: e.pointerId,
        touch,
        x0: e.clientX,
        y0: e.clientY,
        x: e.clientX,
        y: e.clientY,
        grabDy,
        mode: "pending",
        timer: null,
        min: null,
      };
      if (touch)
        d.timer = setTimeout(() => {
          if (p.current === d && d.mode === "pending") startDrag(d);
        }, LONG_PRESS_MS);
      p.current = d;
    },
    [startDrag],
  );

  /** 拖完那一下的 click 要吞掉 */
  const swallowClick = useCallback((): boolean => Date.now() < noClickUntil.current, []);

  return { drag: view, onPointerDown, swallowClick };
}
