/**
 * useTicketKeyboard——售票口頁的「導航模式」按鍵表（車次①契約 §5.6；scope `ticket`；乙席接線）。
 * 寫法照 `useTimetableKeyboard.ts`：IME 護欄 → isEditableTarget 放行 → 對話框／確認窗開著整張表停用 →
 * `resolveHotkey("ticket", e)` → switch。
 *
 * 十五個 id 以字串字面值出現（`pnpm probe:hotkeys` 牙齒 3；第②階段加 6 個，②契約 §5.4）。掛在頁根 `div.page.ns-tk`（`ref`），
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
import { todayKey } from "../../lib/date";
import { monthOf, type EntryRow } from "../../domain/ticket";
import { dayStep, isFilterActive } from "../../domain/ticketView";
import { defaultFocusDay, useCalFocus } from "./view/TicketCalendar";
import { switchView } from "./view/ViewSwitch";
import { focusTicketSearch } from "./view/SearchBar";

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

/** 搜尋結果畫在清單上時（0-15）：↑↓ 在結果裡移（store.moveSelection 只走月份清單的 days） */
function moveInResults(delta: 1 | -1): void {
  const s = useTicketStore.getState();
  // results 已照排序排好，畫面上的先後就是它的順序（金額排序是平面清單，resultDays 是空的）
  const flat: EntryRow[] = s.results ?? [];
  if (!flat.length) return;
  const i = s.selectedId === null ? -1 : flat.findIndex((e) => e.id === s.selectedId);
  if (i < 0) return s.select(flat[0].id);
  const j = i + delta;
  if (j >= 0 && j < flat.length) s.select(flat[j].id);
}

/** 月曆焦點格移 n 天（跨月 ⇒ 切月；不超過今天所在的月） */
function moveCalFocus(n: number): void {
  const s = useTicketStore.getState();
  const today = todayKey(useUiStore.getState().dayStartHour);
  const cur = useCalFocus.getState().day ?? defaultFocusDay(s.month, today);
  const next = dayStep(cur, n);
  const m = monthOf(next);
  if (m > monthOf(today)) return;
  useCalFocus.getState().setDay(next);
  if (m !== s.month) void s.setMonth(m);
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
          if (s.view === "calendar") {
            // 月曆：新票日期預填焦點格（§5.4）
            const d = useCalFocus.getState().day;
            s.openNew(d ? { dayKey: d } : undefined);
          } else s.openNew();
          break;
        /* ── 第②階段（②契約 §5.4） ── */
        case "ticket.search": {
          s.openSearch(); // 月曆／統計 ⇒ 先切清單
          focusTicketSearch(el); // 框在頁首下一列（UI 丙-5 A3）；搜尋剛打開那一輪還沒畫出來，setTimeout 等 commit
          break;
        }
        case "ticket.view.list":
          switchView("list");
          break;
        case "ticket.view.calendar":
          switchView("calendar");
          break;
        case "ticket.view.stats":
          switchView("stats");
          break;
        case "ticket.day.left":
        case "ticket.day.right":
          if (s.view !== "calendar" || inPanel) return; // 清單／統計視圖不作用、不 preventDefault
          moveCalFocus(hit.id === "ticket.day.left" ? -1 : 1);
          break;
        case "ticket.move.up":
        case "ticket.move.down":
          if (s.view === "calendar") {
            if (inPanel) return;
            moveCalFocus(hit.id === "ticket.move.up" ? -7 : 7); // 月曆：上一週／下一週
            break;
          }
          if (s.view !== "list") return; // 統計不作用（條是 button，Tab 走）
          if (inPanel) return;
          if (s.searchOpen && s.results !== null && isFilterActive(s.filter)) moveInResults(hit.id === "ticket.move.up" ? -1 : 1);
          else s.moveSelection(hit.id === "ticket.move.up" ? -1 : 1);
          list?.focus({ preventScroll: true });
          revealSelected(el);
          break;
        case "ticket.open":
          if (inPanel || onButton) return; // 聚焦中的按鈕自己被按（統計的條、月曆格）
          if (s.view === "calendar") {
            const d = useCalFocus.getState().day;
            if (d) void s.jumpToDay(d);
            break;
          }
          if (s.view !== "list") return;
          if (!s.selectedId) {
            if (s.searchOpen && s.results !== null && isFilterActive(s.filter)) moveInResults(1);
            else s.moveSelection(1); // 沒選＝選第一筆
            revealSelected(el);
          } else {
            if (s.panel.kind !== "entry") s.openEntry(s.selectedId);
            focusPanelAmount(el);
          }
          break;
        case "ticket.delete":
          if (s.view !== "list" || inPanel || !s.selectedId) return;
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
          // 0-15 的順序：搜尋框有字（框內 Esc 由輸入欄自理）／篩選開著 ⇒ 關搜尋；月曆統計 ⇒ 回清單；都沒有 ⇒ ①照舊
          //（詳情板開著時先收詳情板：搜尋結果裡看完一筆，Esc 先回結果、再一次才關搜尋）
          // 小浮層（篩選 chips／詳情板的 .ns-tk-pop、日期）自己收：本監聽掛在頁根的原生事件，比 React 的 stopPropagation 早到
          if (target?.closest(".ns-tk-pop, .ns-datepick")) return;
          if (s.searchOpen && s.panel.kind !== "none" && s.view === "list") {
            s.requestEscape();
            list?.focus({ preventScroll: true });
            break;
          }
          if (s.searchOpen) {
            s.closeSearch();
            break;
          }
          if (s.view !== "list") {
            void s.setView("list");
            break;
          }
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
