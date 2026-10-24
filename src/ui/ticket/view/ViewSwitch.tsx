/**
 * ViewSwitch——售票口「清單｜月曆｜統計」的資料與切換動作（②契約 §5.1；UI 丙-5 A2 換共用 Tabs）。
 *
 * 長相交給共用 `Tabs`（經 PageHeader 的 `tabs` 格；底線滑塊，窄版自動換下拉）：本檔只出
 *   - `VIEW_TABS`：三個視圖的字與快捷鍵 id（「日曆」→「月曆」，UI 丙-5 A2）
 *   - `viewTabItems()`：給 Tabs 的 items；鍵帽不內嵌，寫進 `hotkeyTitle`（滑過的 title「月曆（2）」，字取自 registry）
 *   - `switchView()`：點籤與鍵盤 1／2／3（useTicketKeyboard）共用
 * 切到月曆／統計時搜尋收起（0-15：搜尋是清單的一種狀態，不是第四個視圖；原型同）。
 */
import { useTicketStore } from "../../../store/ticketStore";
import type { TicketView } from "../../../domain/ticketView";
import type { TabItem } from "../../common/Tabs";
import { formatChord, hotkeyById } from "../../shell/hotkeys";

/** 鍵帽字（registry 單一來源；同 TicketLedger 的 capsOf，這裡自己取以免與 TicketLedger 互相 import） */
function capsOf(id: string): string {
  const hk = hotkeyById(id);
  return hk ? formatChord(hk.chords[0]).join("+") : "";
}

/** 切視圖（點與鍵盤共用）：離開清單 ⇒ 搜尋收起；已在該視圖＝不動 */
export function switchView(v: TicketView): void {
  const s = useTicketStore.getState();
  if (v !== "list" && s.searchOpen) s.closeSearch();
  if (s.view !== v) void s.setView(v);
}

export const VIEW_TABS: readonly { view: TicketView; label: string; hotkey: string }[] = [
  { view: "list", label: "清單", hotkey: "ticket.view.list" },
  { view: "calendar", label: "月曆", hotkey: "ticket.view.calendar" },
  { view: "stats", label: "統計", hotkey: "ticket.view.stats" },
];

/** 共用 Tabs 的 items（hotkeyTitle＝「清單（1）」；registry 沒有這個鍵就只寫字） */
export function viewTabItems(): TabItem<TicketView>[] {
  return VIEW_TABS.map((t) => {
    const caps = capsOf(t.hotkey);
    return { key: t.view, label: t.label, hotkeyTitle: caps ? `${t.label}（${caps}）` : t.label };
  });
}
