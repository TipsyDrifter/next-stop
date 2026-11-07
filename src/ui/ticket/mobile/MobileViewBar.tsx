/**
 * MobileViewBar——售票口手機頁的分頁籤列「清單｜月曆｜統計｜帳戶」＋末端「管帳」（②契約 §5.3；丙席擁有）。
 * 售票口④ 第二輪（D-票-77、79）：第四格「帳戶」（MobileAccountsView）。壬（D-主-513）：原第五格「願望」拆除、移到候車室頁，回四格。
 *   開 `scroll`，排法照視覺規範 §2.2 段數欄（D-主-285，Tabs 自己量）：放得下就平分、放不下才橫捲＋末段露半格。
 *   實量：「管帳」約 57px，籤列 375 寬剩 318、412 寬剩 355；兩字籤字寬約 37px＋每邊最少 12px 內距＝61px×4＝244 ⇒ 兩種寬都四格平分。
 *   更窄的螢幕放不下時 Tabs 自動落回露半格；選中籤換了會自己捲進視野；左右滑換頁照樣四格走得到。
 *
 * UI 丙-5 H1（契約 §1 H1、B2）：自畫的 `.ns-tk-mviews` 三等分 tablist 退役，換成今日頂帶下一列同款 `.ns-tabrow`——
 *   共用 <Tabs>（籤字「日曆」→「月曆」）＋末端 span.mgr 文字鈕「管帳」（＝手機唯一的管帳入口；開 MobileTicketOffice 的管帳 sheet）。
 *   跟丙-4 時刻表同一做法：籤列住在頁內 sticky 的 div.ns-tk-mtop（不走 MobileTopBand 的 tabsRow 插槽：那要改集中檔 MobileShell）。
 *   狀態照舊在 `ticketStore.view`（己-2 B5 起記本機、冷啟動回上次；原 0-17 不持久化）；←→ Home End 由 Tabs 自己處理。
 *
 * 同檔另出 `useViewSwipe`：內容區左右滑換視圖（門檻同 useSubSwipe：邊緣 24px 不算、|dx| ≥ 56、1.5 倍主導）。
 * 只掛在 `.ns-tk-mlist`／`.ns-tk-mcal`／`.ns-tk-mstats`／`.ns-tk-mac` 直向捲動容器（CSS 給 touch-action: pan-y）；
 * 往左滑＝下一個視圖、往右滑＝上一個，到頭不繞回。帳戶頁能長按拖曳：拖曳中（`html.dr-dragging`）的那一下不算滑動。
 */
import { useEffect, type RefObject } from "react";
import { useTicketStore } from "../../../store/ticketStore";
import type { TicketView } from "../../../domain/ticketView";
import { Tabs, type TabItem } from "../../common/Tabs";

const TABS: readonly TabItem<TicketView>[] = [
  { key: "list", label: "清單" },
  { key: "calendar", label: "月曆" },
  { key: "stats", label: "統計" },
  { key: "accounts", label: "帳戶" },
];
const ORDER: readonly TicketView[] = TABS.map((t) => t.key);

/** 系統返回手勢的邊緣保留帶（px）；換頁門檻（px）與橫向主導比——與 useSubSwipe 同值 */
const EDGE_PX = 24;
const SWIPE_PX = 56;
const SWIPE_RATIO = 1.5;

function stepView(cur: TicketView, d: 1 | -1): TicketView | null {
  const i = ORDER.indexOf(cur) + d;
  return i < 0 || i >= ORDER.length ? null : ORDER[i];
}

export function MobileViewBar({ manageOpen, onManage }: { manageOpen: boolean; onManage(): void }) {
  const view = useTicketStore((s) => s.view);
  const setView = useTicketStore((s) => s.setView);
  return (
    <div className="ns-tk-mtop ns-tabrow">
      <Tabs items={TABS} value={view} onChange={(v) => void setView(v)} scroll aria-label="售票口檢視" />
      <span className="mgr">
        <button
          type="button"
          className="ns-btn btn-text ns-btn--sm"
          // 可讀名＝看得到的「管帳」；開的是什麼放 title（同時刻表「管理」）
          title="管帳：分類、帳戶順序、預算、定期帳、常用票種、幣別"
          aria-haspopup="dialog"
          aria-expanded={manageOpen}
          onClick={onManage}
        >
          管帳
        </button>
      </span>
    </div>
  );
}

/**
 * 內容區左右滑換視圖。輸入框、趨勢圖內起手不算（趨勢圖要點條、手指常帶一點橫移；丙-5 起搜尋條件不再是頁內橫捲 chips 列）。
 * pointer 事件（滑鼠拖曳在 ?mock=1 也能驗）；直向捲動時瀏覽器發 pointercancel，等於自動放棄。
 */
export function useViewSwipe(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let sx = 0;
    let sy = 0;
    let pid = -1;
    let active = false;

    const down = (e: PointerEvent) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, [contenteditable], .ns-tk-mst-trend")) return;
      const w = window.innerWidth;
      if (e.clientX < EDGE_PX || e.clientX > w - EDGE_PX) return;
      sx = e.clientX;
      sy = e.clientY;
      pid = e.pointerId;
      active = true;
    };
    const up = (e: PointerEvent) => {
      if (!active || e.pointerId !== pid) return;
      active = false;
      const dx = e.clientX - sx;
      const dy = e.clientY - sy;
      if (Math.abs(dx) < SWIPE_PX || Math.abs(dx) <= SWIPE_RATIO * Math.abs(dy)) return;
      const st = useTicketStore.getState();
      const next = stepView(st.view, dx < 0 ? 1 : -1);
      if (!next) return;
      // 滑動換頁的那一下不要再被當成點擊（點到格子／列會跳走）：之後 350ms 內的 click 吞掉
      swallowUntil = Date.now() + 350;
      void st.setView(next);
    };
    const cancel = (e: PointerEvent) => {
      if (e.pointerId === pid) active = false;
    };
    // 長按浮起拖曳（帳戶頁）時手指的橫移不是換頁
    const move = (e: PointerEvent) => {
      if (active && e.pointerId === pid && document.documentElement.classList.contains("dr-dragging")) active = false;
    };
    let swallowUntil = 0;
    const click = (e: MouseEvent) => {
      if (Date.now() >= swallowUntil) return;
      swallowUntil = 0;
      e.stopPropagation();
      e.preventDefault();
    };

    el.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("click", click, true);
    return () => {
      el.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("click", click, true);
    };
  }, [ref]);
}
