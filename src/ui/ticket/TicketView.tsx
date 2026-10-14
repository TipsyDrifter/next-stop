/**
 * TicketView——售票口桌機頁（車次①契約 §5.1；乙席）。根 `div.page.ns-tk`，照今日頁殼契約（三欄 flex、各欄自己捲）。
 *
 *   div.page.ns-tk（tabIndex=-1；鍵盤表 useTicketKeyboard 掛這裡，清單 ul.ns-tk-list 是焦點容器）
 *   ├─ TicketLedger（main.ns-tk-ledger：頁首＋帳簿）
 *   ├─ TicketPanel（aside.ns-tk-panel：大票／帳戶版；store.panel＝none 時不渲染）
 *   └─ DesktopDialogHost（新增帳戶／分類管理／幣別與匯率／匯入票）
 * 帳戶頁務件 TicketSide 不在這裡——經 mount 的 sidebarAux 掛進書封（D-票-22）。
 *
 * - 進頁：`init("desktop")`（冪等；失敗寫在 store.error，帳簿顯示並可重試）。
 * - 焦點：進頁、詳情板收起、對話框關掉、toast 動作鈕按完之後，沒人持有焦點就還給清單（同時刻表頁的做法），
 *   N／↑↓／[ ] 才接得到。
 * - 剛存好的新票：詳情板攤開那一筆時蓋章帶 stampIn（freshId；只蓋一次）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useTicketStore } from "../../store/ticketStore";
import { TicketLedger } from "./TicketLedger";
import { TicketPanel } from "./TicketPanel";
import { DesktopDialogHost } from "./DesktopDialogHost";
import { focusPanelAmount, useTicketKeyboard } from "./useTicketKeyboard";
import "./ticket.css";

export function TicketView() {
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const panel = useTicketStore((s) => s.panel);
  const dialog = useTicketStore((s) => s.dialog);
  const ready = useTicketStore((s) => s.ready);
  const entries = useTicketStore((s) => s.entries);

  useEffect(() => {
    void useTicketStore
      .getState()
      .init("desktop")
      .catch(() => undefined); // 載入失敗寫在 store.error，帳簿上顯示
  }, []);

  useTicketKeyboard(rootRef);

  const backToList = useCallback(() => {
    setTimeout(() => (listRef.current ?? rootRef.current)?.focus({ preventScroll: true }), 0);
  }, []);

  // 沒人持有焦點（body）⇒ 還給清單：詳情板換內容、對話框關掉、toast「復原」按完（帳重讀）之後
  useEffect(() => {
    if (dialog !== null) return;
    const a = document.activeElement;
    if (a === document.body || a === null) backToList();
  }, [ready, panel.kind, dialog, entries, backToList]);

  // 新票存好 → 詳情板切到那一筆：那一次蓋章帶動畫
  const [freshId, setFreshId] = useState<string | null>(null);
  const prevKind = useRef(panel.kind);
  useEffect(() => {
    if (prevKind.current === "new" && panel.kind === "entry") setFreshId(panel.id);
    else if (panel.kind !== "entry" || panel.id !== freshId) setFreshId(null);
    prevKind.current = panel.kind;
  }, [panel]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = useCallback((id: string) => {
    useTicketStore.getState().openEntry(id);
    focusPanelAmount(rootRef.current);
  }, []);

  return (
    <div ref={rootRef} className="page ns-tk" tabIndex={-1} aria-label="售票口" data-panel={panel.kind}>
      <TicketLedger listRef={listRef} onOpen={open} />
      <TicketPanel freshId={freshId} onBackToList={backToList} />
      <DesktopDialogHost />
    </div>
  );
}
