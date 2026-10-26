/**
 * useLongPressReorder——手機今日 today 分區的長按拖曳排序（手機殼班 D-主-74；原型 `prototypes/主線-手機殼班.html` Q4）。
 * 算術在 reorderDrag.ts（有單測）；本檔只管指標事件與 DOM 位移。寫入由呼叫端 `onDrop(id, to)`＝useMobileToday.moveTo
 * （跟 ⋯ 上移／下移同一支 moveToday、同一組守門）。
 *
 * 手感（原型 Q4 定稿）：
 *   - 按住票卡 400ms（LIFT_DELAY_MS）→ 抬起（陰影＋微放大），跟手指走；其他沒時刻的票讓位；虛線框＝放開會落的位置。
 *     按著還沒滿 400ms 時卡片微微下沉（is-pressing），手指一動超過 8px（MOVE_SLOP_PX）＝當成捲動、不抬。
 *   - 只有手排座標裡的票抬得起來（today 分區、沒時刻；`ids`）；有時刻的票長按抖一下（is-nudge）＋`onNudge`（呼叫端 toast 理由，D-主-80）；
 *     誤點區的票什麼都不做。検印、⋯ 與卡上其他按鈕上按住不觸發（`closest("button, a, input…")`）。
 *   - 抬起後擋掉捲動（touchmove preventDefault）；拖到捲動區上下緣自動捲。
 *
 * 實作取捨：
 *   - 拖曳中的位移直接寫 DOM（`--m-drag-y`／`--m-drop-y`／transform），不經 React state——每個 pointermove 重畫整張清單太重。
 *   - 放開後先把卡留在落點（不立刻清位移），等 store 重載、清單換成新順序那一次 render 才在 layout effect 裡一次清掉
 *     （React 依 key 搬好 DOM、位移歸零，畫面上剛好不動）；1.5 秒內沒換（寫入失敗，store 已吐 toast）就動畫退回原位。
 *   - touchmove 監聽一直掛著、非 passive：Chrome 在 touchstart 那一刻決定這串觸控能不能被擋，抬起之後才掛就來不及了。
 *     沒抬起時它什麼都不做，照常捲。
 */
import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import {
  LIFT_DELAY_MS,
  MOVE_SLOP_PX,
  anchorAt,
  dropIndex,
  dropOffset,
  edgeScrollStep,
  shiftOf,
  type DropAnchor,
  type Slot,
} from "./reorderDrag";

export interface LongPressReorderOpts {
  /** 掛事件的清單（今日分區的 <ul>；callback ref 拿到的元素——清單是條件渲染，掛上來才綁事件）；卡是它底下的 `li[data-node-id]` */
  list: HTMLElement | null;
  /** 捲動容器（.m-page）：自動捲與位移補償用 */
  scrollRef: RefObject<HTMLElement | null>;
  /** 手排座標（manualOrderIds，畫面順序）：只有這些抬得起來 */
  ids: readonly string[];
  /** 長按了一張不能手排的卡：回 true＝抖一下（有時刻的 today 票） */
  nudgeable(id: string): boolean;
  /** 抖完那一下（D-主-80：呼叫端 toast 說為什麼不能拖） */
  onNudge?(id: string): void;
  /** 放開落位：插在 `at` 那兩張之間（抬起那一刻的鄰居；呼叫端對最新座標換算，見 reorderDrag DropAnchor）。跟原位不同才叫 */
  onDrop(id: string, at: DropAnchor): void;
}

/** 放開後等清單換成新順序的上限；過了就當寫入失敗，退回原位 */
const SETTLE_TIMEOUT_MS = 1500;
const NUDGE_MS = 360;

interface Press {
  pointerId: number;
  id: string;
  li: HTMLElement;
  x0: number;
  y0: number;
  timer: number;
}

interface Drag {
  pointerId: number;
  id: string;
  /** 抬起那一刻的手排座標（from／to 都是這份的 index；放開時換成鄰居錨） */
  order: string[];
  from: number;
  to: number;
  lis: HTMLElement[];
  slots: Slot[];
  amount: number;
  y0: number;
  scroll0: number;
  lastY: number;
  raf: number;
}

export function useLongPressReorder({ list, scrollRef, ids, nudgeable, onNudge, onDrop }: LongPressReorderOpts): void {
  // 事件處理器跟著清單元素掛一次，最新的 ids／回呼走 ref
  const opts = useRef({ ids, nudgeable, onNudge, onDrop });
  opts.current = { ids, nudgeable, onNudge, onDrop };
  /** 放開後等新順序的那一次：清位移的函式＋退回計時器 */
  const settle = useRef<{ clear: (animate: boolean) => void; timer: number } | null>(null);

  // 清單順序換了（store 重載回來）＝落位完成：paint 之前把位移清掉，畫面不跳
  const idsKey = ids.join("|");
  useLayoutEffect(() => {
    const s = settle.current;
    if (!s) return;
    settle.current = null;
    window.clearTimeout(s.timer);
    s.clear(false);
  }, [idsKey]);

  useEffect(() => {
    if (!list) return;
    let press: Press | null = null;
    let drag: Drag | null = null;
    let swallowClickUntil = 0;

    const liOf = (id: string) => list.querySelector<HTMLElement>(`li[data-node-id="${CSS.escape(id)}"]`);

    const endPress = () => {
      if (!press) return;
      window.clearTimeout(press.timer);
      press.li.classList.remove("is-pressing");
      press = null;
    };

    /** 清掉這次拖曳寫在 DOM 上的一切；animate=false＝關掉過場一次清（新順序已經畫好時） */
    const clearStyles = (lis: HTMLElement[], animate: boolean) => {
      if (!animate) list.classList.add("is-settling");
      for (const li of lis) {
        li.classList.remove("is-lifted", "is-dropping");
        li.style.removeProperty("transform");
        li.style.removeProperty("--m-drag-y");
        li.style.removeProperty("--m-drop-y");
      }
      list.classList.remove("is-dragging");
      if (!animate) {
        void list.offsetHeight; // 先讓「無過場」生效再拿掉 class，免得下一次拖曳也沒過場
        list.classList.remove("is-settling");
      }
    };

    const layout = (d: Drag) => {
      const scroller = scrollRef.current;
      const dy = d.lastY - d.y0 + ((scroller?.scrollTop ?? 0) - d.scroll0);
      const f = d.slots[d.from];
      d.to = dropIndex(d.slots, d.from, f.top + f.height / 2 + dy);
      d.lis.forEach((li, i) => {
        if (i === d.from) {
          li.style.setProperty("--m-drag-y", `${dy}px`);
          li.style.setProperty("--m-drop-y", `${dropOffset(d.slots, d.from, d.to)}px`);
        } else {
          const s = shiftOf(i, d.from, d.to, d.amount);
          if (s) li.style.transform = `translateY(${s}px)`;
          else li.style.removeProperty("transform");
        }
      });
    };

    /** 拖到捲動區上下緣：每格捲一點，捲完重排一次（位移補償在 layout 裡） */
    const tick = () => {
      if (!drag) return;
      const scroller = scrollRef.current;
      if (scroller) {
        const r = scroller.getBoundingClientRect();
        const step = edgeScrollStep(drag.lastY, r.top, r.bottom);
        if (step) {
          const before = scroller.scrollTop;
          scroller.scrollTop = before + step;
          if (scroller.scrollTop !== before) layout(drag);
        }
      }
      drag.raf = requestAnimationFrame(tick);
    };

    const lift = (p: Press) => {
      const { ids: order } = opts.current;
      const from = order.indexOf(p.id);
      const lis = order.map(liOf);
      if (from < 0 || lis.some((li) => !li)) return; // 清單剛好在重畫：放棄這一下
      const els = lis as HTMLElement[];
      const slots = els.map((li) => {
        const r = li.getBoundingClientRect();
        return { top: r.top, height: r.height };
      });
      const gap = parseFloat(getComputedStyle(list).rowGap) || 8;
      p.li.classList.remove("is-pressing");
      p.li.classList.add("is-lifted");
      list.classList.add("is-dragging");
      try {
        list.setPointerCapture(p.pointerId); // 滑鼠拖出清單外也跟得到；觸控本來就隱式 capture
      } catch {
        /* 指標已失效：照常用冒泡的事件 */
      }
      drag = {
        pointerId: p.pointerId,
        id: p.id,
        order: [...order],
        from,
        to: from,
        lis: els,
        slots,
        amount: slots[from].height + gap,
        y0: p.y0,
        scroll0: scrollRef.current?.scrollTop ?? 0,
        lastY: p.y0,
        raf: 0,
      };
      layout(drag);
      drag.raf = requestAnimationFrame(tick);
    };

    const finishDrag = (commit: boolean) => {
      const d = drag;
      if (!d) return;
      drag = null;
      cancelAnimationFrame(d.raf);
      try {
        list.releasePointerCapture(d.pointerId);
      } catch {
        /* 已經放掉了 */
      }
      swallowClickUntil = performance.now() + 300; // 放開那一下不要變成點擊
      if (!commit || d.to === d.from) {
        clearStyles(d.lis, true);
        return;
      }
      // 落位：卡滑進虛線框、其他卡維持讓位，等新順序畫出來（useLayoutEffect）再一次清
      const li = d.lis[d.from];
      li.classList.remove("is-lifted");
      li.classList.add("is-dropping");
      li.style.setProperty("--m-drag-y", li.style.getPropertyValue("--m-drop-y") || "0px");
      if (settle.current) {
        window.clearTimeout(settle.current.timer);
        settle.current.clear(false);
      }
      const lis = d.lis;
      settle.current = {
        clear: (animate) => clearStyles(lis, animate),
        timer: window.setTimeout(() => {
          if (!settle.current) return;
          settle.current = null;
          clearStyles(lis, true);
        }, SETTLE_TIMEOUT_MS),
      };
      opts.current.onDrop(d.id, anchorAt(d.order, d.id, d.to));
    };

    const onDown = (e: PointerEvent) => {
      if (press || drag || !e.isPrimary || e.button !== 0) return;
      const t = e.target as HTMLElement;
      // 検印、⋯ 與卡上其他可點的東西上按住不觸發
      if (t.closest("button, a, input, textarea, select")) return;
      const li = t.closest<HTMLElement>("li[data-node-id]");
      if (!li || !list.contains(li)) return;
      const id = li.dataset.nodeId!;
      const canDrag = opts.current.ids.includes(id);
      if (!canDrag && !opts.current.nudgeable(id)) return;
      if (canDrag) li.classList.add("is-pressing");
      const p: Press = {
        pointerId: e.pointerId,
        id,
        li,
        x0: e.clientX,
        y0: e.clientY,
        timer: window.setTimeout(() => {
          if (press !== p) return;
          press = null;
          if (canDrag) {
            lift(p);
          } else {
            // 有時刻的票：抖一下（照時刻排、不能手排）＋呼叫端 toast 說為什麼（D-主-80；只抖不說＝隱性知識）
            li.classList.remove("is-nudge");
            void li.offsetWidth;
            li.classList.add("is-nudge");
            window.setTimeout(() => li.classList.remove("is-nudge"), NUDGE_MS);
            opts.current.onNudge?.(id);
          }
        }, LIFT_DELAY_MS),
      };
      press = p;
    };

    const onMove = (e: PointerEvent) => {
      if (press && e.pointerId === press.pointerId) {
        if (Math.hypot(e.clientX - press.x0, e.clientY - press.y0) > MOVE_SLOP_PX) endPress();
        return;
      }
      if (drag && e.pointerId === drag.pointerId) {
        drag.lastY = e.clientY;
        layout(drag);
      }
    };

    const onUp = (e: PointerEvent) => {
      if (press && e.pointerId === press.pointerId) endPress();
      if (drag && e.pointerId === drag.pointerId) finishDrag(true);
    };

    const onCancel = (e: PointerEvent) => {
      if (press && e.pointerId === press.pointerId) endPress();
      if (drag && e.pointerId === drag.pointerId) finishDrag(false);
    };

    // 抬起之後擋捲動；沒抬起時什麼都不做（監聽要一直在，見檔頭）
    const onTouchMove = (e: TouchEvent) => {
      if (drag && e.cancelable) e.preventDefault();
    };
    // 長按不要跳系統選單
    const onContextMenu = (e: Event) => {
      if (press || drag) e.preventDefault();
    };
    const onClick = (e: MouseEvent) => {
      if (performance.now() < swallowClickUntil) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    list.addEventListener("pointerdown", onDown);
    list.addEventListener("pointermove", onMove);
    list.addEventListener("pointerup", onUp);
    list.addEventListener("pointercancel", onCancel);
    list.addEventListener("touchmove", onTouchMove, { passive: false });
    list.addEventListener("contextmenu", onContextMenu);
    list.addEventListener("click", onClick, true);
    return () => {
      endPress();
      finishDrag(false);
      list.removeEventListener("pointerdown", onDown);
      list.removeEventListener("pointermove", onMove);
      list.removeEventListener("pointerup", onUp);
      list.removeEventListener("pointercancel", onCancel);
      list.removeEventListener("touchmove", onTouchMove);
      list.removeEventListener("contextmenu", onContextMenu);
      list.removeEventListener("click", onClick, true);
    };
  }, [list, scrollRef]);
}
