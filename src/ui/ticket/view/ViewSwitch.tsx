/**
 * ViewSwitch——售票口頁首的「清單｜日曆｜統計」（②契約 §5.1 `.ns-tk-headrow.is-views`；乙席擁有）。
 *
 *   div.ns-tk-views[role=tablist] > button[role=tab][aria-selected]×3（右下角 kbd 1／2／3，取自 registry；樣式 ticket.css §H）
 * 切到月曆／統計時搜尋收起（0-15：搜尋是清單的一種狀態，不是第四個視圖；原型同）——鍵盤 1／2／3 走同一支 switchView。
 */
import { useTicketStore } from "../../../store/ticketStore";
import type { TicketView } from "../../../domain/ticketView";
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
  { view: "calendar", label: "日曆", hotkey: "ticket.view.calendar" },
  { view: "stats", label: "統計", hotkey: "ticket.view.stats" },
];

export function ViewSwitch() {
  const view = useTicketStore((s) => s.view);
  return (
    <div className="ns-tk-views" role="tablist" aria-label="視圖">
      {VIEW_TABS.map((t) => (
        <button
          key={t.view}
          type="button"
          role="tab"
          aria-selected={view === t.view}
          className={"ns-tk-view" + (view === t.view ? " is-on" : "")}
          onMouseDown={(e) => e.preventDefault() /* 焦點留在頁內（鍵盤表接得到） */}
          onClick={() => switchView(t.view)}
        >
          {t.label}
          <kbd className="ns-tk-kbd">{capsOf(t.hotkey)}</kbd>
        </button>
      ))}
    </div>
  );
}
