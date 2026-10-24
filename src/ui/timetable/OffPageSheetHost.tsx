/**
 * OffPageSheetHost——頁外面板宿主（車次② 契約 0-9、§5.3；乙席）。兩個全域代理（TimetableDesktopAgent／TimetableMobileAgent）
 * 渲染它：**目前不在時刻表頁**（桌機 `uiStore.page !== "timetable"`、手機 `uiStore.mobileTab !== "timetable"`）時才畫既有的
 * `DesktopSheetHost`／`MobileSheetHost`；在時刻表頁時回 null（頁裡那份照舊）。同一時間只有一份。
 * 用途：從今日頁發車第一次碰到的路線要先選分類、長時間運行待確認時先問「其實到幾點」——這兩個面板都在時刻表的 `store.sheet`，
 * 不在時刻表頁也要跳。換頁時開著的面板跟到新頁（新頁不是時刻表頁 ⇒ 這裡畫）。
 *
 * 焦點（0-9）：`DialogShell` 不做 focus trap、也不把焦點移進對話框，焦點會留在今日頁容器上、`useTodayKeyboard` 照樣收鍵
 * （Space 蓋済、Delete 刪列、n 再發一次）。所以面板打開時記下 `document.activeElement`，下一個 frame 把焦點移進面板；
 * 面板關掉（或本元件卸載）時，記下的元件還在 DOM 裡就還給它。焦點在面板裡時，鍵盤事件不會冒泡到今日頁容器
 * （面板畫在 App 根的代理裡，不在今日頁的 DOM 底下）。只在不在時刻表頁時做（頁裡那份的焦點行為不動）。
 * 「下一個 frame」用 setTimeout(0) 而不是 rAF：背景分頁不跑 rAF（實測：預覽分頁在背景時焦點一直沒移進來）。
 *
 * UI 丙-4 C1／C3：兩個 host 換了殼（桌機 DialogShell size M＋黏底 foot、手機 MSheet），這裡不用跟著改——
 * 桌機的 DialogShell 畫在本元件的 div 裡，照舊找得到 `[role="dialog"]`；手機的 MSheet portal 到 body，這裡找不到就不動，
 * 由 MSheet 自己的焦點三規則（useDialogFocus：開啟落 sheet、關閉還焦點）接手。按鈕列 portal 進 foot 仍在 dialog 裡，焦點擋得住。
 *
 * 焦點落點（偏離契約字面的保守選擇）：契約寫「第一個可聚焦元件，沒有才移到 [role="dialog"]」。桌機 DialogShell 的第一個
 * 可聚焦元件是標題列的「×」——焦點落在那裡時按 Space／Enter（主人本來想在今日頁蓋済／開側板）會直接把面板關掉。
 * 所以一律落在 `[role="dialog"]` 本身（先給 `tabIndex=-1`）：鍵盤事件一樣被擋在面板裡，Tab 從面板開頭往下走，
 * Space／Enter 不會誤按到任何鈕。
 */
import { useEffect, useRef } from "react";
import { useTimetableStore } from "../../store/timetableStore";
import { useUiStore } from "../../store/uiStore";
import { DesktopSheetHost } from "./DesktopSheetHost";
import { MobileSheetHost } from "./mobile/MobileSheetHost";
import "./timetable.css";

export function OffPageSheetHost({ shell }: { shell: "desktop" | "mobile" }) {
  const page = useUiStore((s) => s.page);
  const tab = useUiStore((s) => s.mobileTab);
  const onPage = shell === "desktop" ? page === "timetable" : tab === "timetable";
  if (onPage) return null;
  return <FocusedHost shell={shell} />;
}

/** 不在時刻表頁時的那一份：宿主＋焦點管理 */
function FocusedHost({ shell }: { shell: "desktop" | "mobile" }) {
  const open = useTimetableStore((s) => s.sheet !== null);
  const wrap = useRef<HTMLDivElement>(null);
  const prev = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    prev.current = document.activeElement;
    // 下一輪事件迴圈才移（子元件自己的 autofocus effect 先跑；用 setTimeout 不用 rAF：背景分頁不跑 rAF）
    const t = setTimeout(() => {
      const dialog = wrap.current?.querySelector<HTMLElement>('[role="dialog"]');
      if (!dialog) return;
      // 面板自己已經把焦點放進來（例：選擇器的搜尋框）就不搶
      if (dialog.contains(document.activeElement)) return;
      if (!dialog.hasAttribute("tabindex")) dialog.tabIndex = -1;
      dialog.focus({ preventScroll: true });
    }, 0);
    return () => {
      clearTimeout(t);
      const el = prev.current;
      prev.current = null;
      if (el instanceof HTMLElement && el.isConnected) el.focus({ preventScroll: true });
    };
  }, [open]);

  return (
    <div ref={wrap} className="ns-tt-offpage" data-shell-host={shell}>
      {shell === "desktop" ? <DesktopSheetHost /> : <MobileSheetHost />}
    </div>
  );
}
