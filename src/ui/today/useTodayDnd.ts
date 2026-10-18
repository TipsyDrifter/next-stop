/**
 * useTodayDnd——今日清單的原生 HTML5 拖曳排序（M3 ③ WP5；D-③-3 甲，不裝任何 dnd 依賴）。
 *
 * 契約（WP2 定，不改簽名）：
 *   useTodayDnd(rows, onMove) → { rowProps(id, index): Record<string, unknown> }
 *   - rows＝畫面順序的今日列（含誤點／締切段）
 *   - onMove(id, index)＝TodayView 接到 controller.moveTo → `nodeStore.moveToday`
 *     （拖曳與 Alt+↑↓ 的**唯一**入口；失敗回 {ok:false, reason}，controller 已負責 toast）
 *   - index 以「手排座標」計（主線②）：`manualOrderIds(rows)`＝沒時刻的 today 列，語義與
 *     `reorderIds(ids, id, index)` 一致：先把自己抽掉，再插進剩下清單的第 index 位 —— 與 Alt+↑↓ 的
 *     `i + delta` 完全同一條路。故「插進第 k 個縫」的 index ＝ k > from ? k - 1 : k（見 dropIndex）。
 *   - rowProps 的 index 是**畫面列序**（TodayView 的 `todayRows.map((r, i)`，今天分區、含有時刻的票），
 *     座標系和手排座標不同 ⇒ 進 onDragOver／onDrop 先 `manualIndexOfDisplay` 換算（契約 §0-1 第 8 條）。
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
 * 有時刻的票（主線② D-主-10：照時刻排，不能手排）：
 *   - 與誤點列同一機制——effect 補 draggable＋dragstart 當場取消並轉呼 onMove(id, 0)，store 回 `TIME_FIXED_ORDER_MSG`；
 *   - 也**不是落點**：dragover 不 preventDefault、不畫線（手排只在沒時刻的列之間成立）。
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
import { manualIndexOfDisplay, manualOrderIds, timeOfRow } from "../../domain/scheduledTime";

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

  /** 手排座標（＝moveToday 的座標系）：沒時刻的 today 列 id */
  const manualIds = () => manualOrderIds(st.current.rows);
  /** 畫面列序 → 手排座標。rowProps 的 index 是 `todayRows` 的列序（不含誤點／締切列），所以換算也用 today 分區的列 */
  const manualIndexAt = (displayIndex: number) =>
    manualIndexOfDisplay(
      st.current.rows.filter((r) => r.bucket === "today"),
      displayIndex,
    );

  const clear = useCallback(() => {
    setDragId(null);
    setDrop(null);
  }, []);

  /* ── 誤點／締切列與有時刻的票：按得動、拖不動；拖起來就當場取消，並讓 store 說明為什麼 ── */
  const lateReject = useCallback((e: globalThis.DragEvent) => {
    e.preventDefault(); // 取消這次拖曳＝拖不動
    const id = (e.currentTarget as HTMLElement).dataset.nodeId;
    if (id) st.current.onMove(id, 0); // moveToday 不動資料、直接回 reason → controller toast
  }, []);

  // 沒有 deps：誤點區摺疊／清單增刪都不會換掉 rows 的參照，每次 render 重掛最省心；
  // 清單最多 30 列、cleanup 全還原，重複掛載（含 StrictMode 雙掛載）不會疊。
  useEffect(() => {
    const lateIds = new Set(
      st.current.rows.filter((r) => r.bucket !== "today" || timeOfRow(r) !== null).map((r) => r.id),
    );
    if (!lateIds.size) return;
    // 記下原值再還原：有時刻的 today 列自己就有 rowProps 的 draggable=true（React 管），
    // cleanup 若一律寫 false，時刻被清掉之後 React 不會重寫（props 沒變）→ 那一列從此拖不動
    const marked: { el: HTMLElement; was: boolean }[] = [];
    document.querySelectorAll<HTMLElement>(".ns-today .ticket-li[data-node-id]").forEach((el) => {
      const id = el.dataset.nodeId;
      if (!id || !lateIds.has(id)) return;
      marked.push({ el, was: el.draggable });
      el.draggable = true;
      el.addEventListener("dragstart", lateReject);
    });
    return () => {
      marked.forEach(({ el, was }) => {
        el.draggable = was;
        el.removeEventListener("dragstart", lateReject);
      });
    };
  });

  const onDragStart = (id: string) => (e: DragEvent<HTMLElement>) => {
    if ((e.target as HTMLElement).closest("input")) {
      e.preventDefault(); // 輸入框裡的選字拖曳不算排序
      return;
    }
    // 有時刻的票：native 的 lateReject 已經取消這次拖曳並請 store 說話；這裡不能再 setDragId（拖曳被取消不會有 dragend，狀態會卡住）
    if (!manualIds().includes(id)) {
      e.preventDefault();
      return;
    }
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", id); // Firefox 沒有 payload 不發車；Chromium 無害
    setDragId(id);
    setDrop(null);
  };

  /**
   * 這一個事件落在哪一縫：onDragOver 與 onDrop 共用，都用**事件本身**的目標列和 clientY 現算。
   * 回 undefined＝這一列不是落點（不是我們發的車／有時刻的列）；null＝是落點但等於原位（什麼都不會變）。
   */
  const dropAtOf = (index: number, id: string, e: DragEvent<HTMLElement>, from: number): DropAt | null | undefined => {
    const target = st.current.rows.find((r) => r.id === id);
    if (target && timeOfRow(target) !== null) return undefined;
    const rect = e.currentTarget.getBoundingClientRect();
    const edge: DropAt["edge"] = e.clientY < rect.top + rect.height / 2 ? "before" : "after";
    // 落點等於原位（含拖到自己身上）＝這一放什麼都不會變 → 不畫線
    return dropIndex(from, manualIndexAt(edge === "after" ? index + 1 : index)) === from ? null : { id, index, edge };
  };

  const onDragOver = (index: number, id: string) => (e: DragEvent<HTMLElement>) => {
    const from = manualIds().indexOf(st.current.dragId ?? "");
    if (from < 0) return; // 不是我們發的車（例：從外面拖檔案進來）——不接手
    const next = dropAtOf(index, id, e, from);
    // 有時刻的列不當落點：不 preventDefault（收不到 drop、游標顯示禁止）、不畫線；上一縫的線順手收掉
    if (next === undefined) {
      if (st.current.drop) setDrop(null);
      return;
    }
    e.preventDefault(); // 有 preventDefault 才收得到 drop
    e.dataTransfer.dropEffect = "move";

    const cur = st.current.drop;
    const same = cur === next || (!!cur && !!next && cur.id === next.id && cur.edge === next.edge);
    if (!same) setDrop(next); // 只有真的換縫才 re-render（dragover 每幀都來）
  };

  // 落點不吃「上一次 dragover 存的縫」：放手那一刻可能沒收到終點列的 dragover（合成拖曳／快速放手），
  // 所以用 drop 事件自己的目標列和 clientY 現算一次；目標是有時刻的列＝不是落點，什麼都不動
  const onDrop = (index: number, id: string) => (e: DragEvent<HTMLElement>) => {
    const dragged = st.current.dragId;
    clear();
    if (!dragged) return;
    e.preventDefault();
    const from = manualIds().indexOf(dragged);
    if (from < 0) return;
    const at = dropAtOf(index, id, e, from);
    if (!at) return; // 有時刻的列，或落點＝原位就不寫資料庫（省一次 reload）
    const to = dropIndex(from, manualIndexAt(at.edge === "after" ? at.index + 1 : at.index));
    if (to !== from) onMove(dragged, to);
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
        onDrop: onDrop(index, id),
        onDragEnd: clear, // 丟到清單外／Esc 取消都走這裡
        "data-dnd-drag": dragId === id ? "1" : undefined,
        "data-dnd-drop": drop && drop.id === id ? drop.edge : undefined,
      };
    },
  };
}
