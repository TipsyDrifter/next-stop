/**
 * useTicketKeyboard——售票口頁的「導航模式」按鍵表（車次①契約 §5.6；scope `ticket`；乙席接線）。
 * 寫法照 `useTimetableKeyboard.ts`：IME 護欄 → isEditableTarget 放行 → 對話框／確認窗開著整張表停用 →
 * `resolveHotkey("ticket", e)` → switch。
 *
 * 九個 id 以字串字面值出現（`pnpm probe:hotkeys` 牙齒 3）。掛在頁根 `div.page.ns-tk`（`ref`），
 * 讓「Ctrl+6 直達後」與「點過詳情板的按鈕之後」N／Esc／[ ] 都接得到；清單 `ul.ns-tk-list` 是焦點容器：
 *   - ↑↓／Enter／Delete／Tab 只在焦點不在詳情板裡時作用（詳情板的按鈕與小浮層自理 ↑↓ Enter）
 *   - Tab（下一個帳戶篩選）只在焦點正好在清單上時接（契約「清單焦點時」），其餘照瀏覽器移焦點
 *   - 聚焦中的 button 上的 Enter 放行（讓按鈕自己被按）
 * `ticket-entry.*` 由輸入欄自理，不在這張表（TicketPanel）。全域 `Ctrl+6` 由地基的 `navHotkeys()` 產生，不在這張表。
 */
import { useEffect, type RefObject } from "react";
import { isEditableTarget, resolveHotkey } from "../shell/hotkeys";
import { useTicketStore } from "../../store/ticketStore";
import { useUiStore } from "../../store/uiStore";

/** 焦點落到詳情板的金額欄（ticket.open；也給雙擊用） */
export function focusPanelAmount(root: HTMLElement | null): void {
  // 詳情板在 select 之後才渲染：等這一輪 commit 完（不用 rAF：視窗在背景時 rAF 不跑）
  setTimeout(() => {
    const el = root?.querySelector<HTMLInputElement>(".ns-tk-panel .ns-tk-amtin");
    el?.focus();
    el?.select();
  });
}

/** 讓選中的那一行捲進視野 */
function revealSelected(root: HTMLElement): void {
  setTimeout(() => {
    const id = useTicketStore.getState().selectedId;
    if (!id) return;
    root.querySelector(`#tk-row-${CSS.escape(id)}`)?.scrollIntoView({ block: "nearest" });
  });
}

export function useTicketKeyboard(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.isComposing || e.keyCode === 229) return;
      if (isEditableTarget(e.target)) return;
      const s = useTicketStore.getState();
      if (s.dialog !== null || useUiStore.getState().confirm !== null) return; // 對話框自己吃鍵（DialogShell／ConfirmDialog）
      const hit = resolveHotkey("ticket", e);
      if (!hit) return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      const inPanel = !!target?.closest(".ns-tk-panel, .ns-tk-pop, .ns-datepick");
      const onButton = target?.tagName === "BUTTON";
      const list = el.querySelector<HTMLElement>(".ns-tk-list");
      switch (hit.id) {
        case "ticket.new":
          s.openNew();
          break;
        case "ticket.move.up":
        case "ticket.move.down":
          if (inPanel) return;
          s.moveSelection(hit.id === "ticket.move.up" ? -1 : 1);
          list?.focus({ preventScroll: true });
          revealSelected(el);
          break;
        case "ticket.open":
          if (inPanel || onButton) return;
          if (!s.selectedId) {
            s.moveSelection(1); // 沒選＝選第一筆
            revealSelected(el);
          } else {
            if (s.panel.kind !== "entry") s.openEntry(s.selectedId);
            focusPanelAmount(el);
          }
          break;
        case "ticket.delete":
          if (inPanel || !s.selectedId) return;
          void s.deleteEntry(s.selectedId);
          list?.focus({ preventScroll: true });
          break;
        case "ticket.month.prev":
          void s.stepMonth(-1);
          break;
        case "ticket.month.next":
          void s.stepMonth(1);
          break;
        case "ticket.account.next":
          if (!list || target !== list) return; // 只在清單焦點時；其餘照瀏覽器移焦點
          void s.cycleFilter();
          break;
        case "ticket.escape":
          if (s.panel.kind === "none" && s.selectedId === null) return;
          s.requestEscape();
          list?.focus({ preventScroll: true });
          break;
        default:
          return;
      }
      e.preventDefault();
      e.stopPropagation();
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, [ref]);
}
