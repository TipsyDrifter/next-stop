/**
 * useTodayDnd——今日清單的原生 HTML5 拖曳排序（M3 ③ WP5；D-③-3 甲，不裝任何 dnd 依賴）。
 *
 * 契約（WP2 定，不改簽名）：
 *   useTodayDnd(rows, onMove) → { rowProps(id, index): Record<string, unknown> }
 *   - rows＝畫面順序的今日列（含誤點／締切段）
 *   - onMove(id, index)＝TodayView 接到 controller.moveTo → `nodeStore.moveToday`
 *     （拖曳與 Alt+↑↓ 的**唯一**入口；失敗回 {ok:false, reason}，controller 已負責 toast）
 *   - index 以「today 分區的可見順序」計，語義與 `reorderIds(ids, id, index)` 一致：
 *     先把自己抽掉，再插進剩下清單的第 index 位 —— 與 Alt+↑↓ 的 `i + delta` 完全同一條路。
 *     故「插進第 k 個縫」的 index ＝ k > from ? k - 1 : k（見 dropIndex）。
 *
 * ⚠ mousedown 與原生 DnD 的衝突（實測，不是推測）
 *   Chromium 的 mousedown 預設動作同時是**拖曳的起手式**——被 preventDefault 掉，
 *   `draggable` 元素就再也發不出 dragstart。
 *   實證：同一顆瀏覽器、同一頁注入兩塊 draggable div，A 的 mousedown preventDefault、B 不動，
 *   同樣拖一次 → B 收到 DRAGSTART，A 一個事件都沒有。
 *   處置（整合席）：TodayRow 的 onMouseDown 已收窄成「只有列內按鈕才 preventDefault」，
 *   票面本體不擋 → 拖得動；不選字改由 today.css 的 `user-select:none` 負責。
 *   本檔因此**不再**在 rowProps 裡覆寫 onMouseDown。
 *
 * 誤點／締切段（bucket !== "today"）**不可拖、也不可拖進今日**：
 *   TodayView 沒有把 rowProps 展開到誤點列，所以它們天生就不 draggable、也不接受落點；
 *   但「拖不動又不回話」對主人是啞巴 UI → 本檔在 effect 裡替誤點列補上 draggable，
 *   dragstart 一律 preventDefault（拖曳當場取消）並轉呼 onMove(id, 0)——`moveToday` 對不在
 *   today 分區的 id 會**在動資料之前**就回 {ok:false, reason}，reason 由 controller 吐成 toast。
 *   提示文案因此只有 store 一個出處，跟 Alt+↑↓ 撞誤點列時說的是同一句話。
 *
 * 落點指示只動 transform／opacity（情境 6；M2_設計生產線.md:191）：
 *   本檔只吐 `data-dnd-drag` / `data-dnd-drop="before|after"` 兩個屬性，線怎麼畫在 today.css
 *   的 DnD 段（.ticket-li 的 ::before／::after 常駐、平時 opacity:0，用 techo 的 .dash 語彙）。
 *   落點跟現況相同（挪過去等於沒挪）時不畫線、放手也不寫資料庫。
 *
 * StrictMode 雙掛載：狀態全在元件內（卸載即清），effect 掛的 listener 在 cleanup 全數卸除、
 *   draggable 屬性一併還原，重入不會疊加（照 ambience/useFlightScheduler 的 clear 模式）。
 */
import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import type { TodayRow } from "../../data";

export interface TodayDnd {
  /** 展開到今日列根元素上的 props（draggable／onDragStart／onDragOver／onDrop…） */
  rowProps(id: string, index: number): Record<string, unknown>;
}

/** 目前懸停的落點：畫在第 index 列的哪一邊 */
interface DropAt {
  id: string;
  index: number;
  edge: "before" | "after";
}

/** 「插進第 k 個縫」→ moveToday 的 index（自己先被抽掉，所以往下拖要減一） */
function dropIndex(from: number, k: number): number {
  return k > from ? k - 1 : k;
}

export function useTodayDnd(rows: TodayRow[], onMove: (id: string, index: number) => void): TodayDnd {
  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<DropAt | null>(null);

  // 最新值放 ref：listener／handler 不吃舊 closure（沿 useTodayController 的做法）
  const st = useRef({ rows, onMove, dragId, drop });
  st.current = { rows, onMove, dragId, drop };

  /** today 分區的 id（＝moveToday 的座標系） */
  const todayIds = () => st.current.rows.filter((r) => r.bucket === "today").map((r) => r.id);

  const clear = useCallback(() => {
    setDragId(null);
    setDrop(null);
  }, []);

  /* ── 誤點／締切列：按得動、拖不動；拖起來就當場取消，並讓 store 說明為什麼 ── */
  const lateReject = useCallback((e: globalThis.DragEvent) => {
    e.preventDefault(); // 取消這次拖曳＝拖不動
    const id = (e.currentTarget as HTMLElement).dataset.nodeId;
    if (id) st.current.onMove(id, 0); // moveToday 不動資料、直接回 reason → controller toast
  }, []);

  // 沒有 deps：誤點區摺疊／清單增刪都不會換掉 rows 的參照，每次 render 重掛最省心；
  // 清單最多 30 列、cleanup 全還原，重複掛載（含 StrictMode 雙掛載）不會疊。
  useEffect(() => {
    const lateIds = new Set(st.current.rows.filter((r) => r.bucket !== "today").map((r) => r.id));
    if (!lateIds.size) return;
    const marked: HTMLElement[] = [];
    document.querySelectorAll<HTMLElement>(".ns-today .ticket-li[data-node-id]").forEach((el) => {
      const id = el.dataset.nodeId;
      if (!id || !lateIds.has(id)) return;
      el.draggable = true;
      el.addEventListener("dragstart", lateReject);
      marked.push(el);
    });
    return () => {
      marked.forEach((el) => {
        el.draggable = false;
        el.removeEventListener("dragstart", lateReject);
      });
    };
  });

  const onDragStart = (id: string) => (e: DragEvent<HTMLElement>) => {
    if ((e.target as HTMLElement).closest("input")) {
      e.preventDefault(); // 輸入框裡的選字拖曳不算排序
      return;
    }
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", id); // Firefox 沒有 payload 不發車；Chromium 無害
    setDragId(id);
    setDrop(null);
  };

  const onDragOver = (index: number, id: string) => (e: DragEvent<HTMLElement>) => {
    const from = todayIds().indexOf(st.current.dragId ?? "");
    if (from < 0) return; // 不是我們發的車（例：從外面拖檔案進來）——不接手
    e.preventDefault(); // 有 preventDefault 才收得到 drop
    e.dataTransfer.dropEffect = "move";

    const rect = e.currentTarget.getBoundingClientRect();
    const edge: DropAt["edge"] = e.clientY < rect.top + rect.height / 2 ? "before" : "after";
    // 落點等於原位（含拖到自己身上）＝這一放什麼都不會變 → 不畫線
    const next: DropAt | null =
      dropIndex(from, edge === "after" ? index + 1 : index) === from ? null : { id, index, edge };

    const cur = st.current.drop;
    const same = cur === next || (!!cur && !!next && cur.id === next.id && cur.edge === next.edge);
    if (!same) setDrop(next); // 只有真的換縫才 re-render（dragover 每幀都來）
  };

  const onDrop = (e: DragEvent<HTMLElement>) => {
    const id = st.current.dragId;
    const at = st.current.drop; // 落點以最後一次 dragover 算出來的那一縫為準
    clear();
    if (!id) return;
    e.preventDefault();
    const from = todayIds().indexOf(id);
    if (from < 0 || !at) return; // 落點＝原位就不寫資料庫（省一次 reload）
    const to = dropIndex(from, at.edge === "after" ? at.index + 1 : at.index);
    if (to !== from) onMove(id, to);
  };

  return {
    rowProps(id, index) {
      return {
        draggable: true,
        onDragStart: onDragStart(id),
        onDragEnter: (e: DragEvent<HTMLElement>) => {
          if (st.current.dragId) e.preventDefault();
        },
        onDragOver: onDragOver(index, id),
        onDrop,
        onDragEnd: clear, // 丟到清單外／Esc 取消都走這裡
        "data-dnd-drag": dragId === id ? "1" : undefined,
        "data-dnd-drop": drop && drop.id === id ? drop.edge : undefined,
      };
    },
  };
}
