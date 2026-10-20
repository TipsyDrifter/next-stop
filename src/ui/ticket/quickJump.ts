/**
 * 售票口線的 Ctrl+P 結果提供者（②契約 0-4、0-19；D-票-30：一般模式也出「帳目」一組最多 4 筆、前綴 `$` 只找帳；乙席）。
 * 經 mount 的 `quickJump` 登記（整合席填）；只在桌機（`lineQuickJumpProviders()` 只看 `page.status`）。
 *
 * - 查詢：store.searchEntries(term, limit)＝全部期間 queryEntries → matchesKeyword → 新到舊取 limit（純讀，不動售票口頁的搜尋狀態）。
 *   只打 `$`（term 空）⇒ 最近 limit 筆。
 * - 一列：glyph「帳」（磨光③ 2-17：車票那組才是「票」，帳目別撞字）；label＝`−80 午餐「備註」 · 現金`（支出 −、退款／收入 ＋；轉帳「80 現金 → 學生證」；校正「±N 精算 · 帳戶」）；
 *   aside＝`10/8`（shortDay）。長相照原型 entryLabel()。
 * - go：切到售票口頁 → jumpToEntry（切清單、到那筆的月、選中並攤開大票、捲到那一天）。
 */
import type { QuickJumpHit, QuickJumpProviderSpec } from "../../lines/types";
import { MAIN_CURRENCY, bareName, moneyText, type EntryRow } from "../../domain/ticket";
import { VIEW_TEXT, shortDay } from "../../domain/ticketView";
import { useTicketStore } from "../../store/ticketStore";
import { useUiStore } from "../../store/uiStore";
import { acctLabel } from "./TicketLedger";

/** 一筆帳在 Ctrl+P 的字（只讀 store 的情境；金額照原幣） */
export function entryJumpLabel(e: EntryRow): string {
  const s = useTicketStore.getState();
  const acc = (id: string | null) => acctLabel(id ? s.accById[id] : undefined, s.accounts);
  const dec = s.curByCode[e.currency]?.decimals ?? s.curByCode[MAIN_CURRENCY]?.decimals ?? 2;
  const abs = moneyText(Math.abs(e.amount_minor), dec);
  const cur = e.currency !== MAIN_CURRENCY ? ` ${e.currency}` : "";
  const note = e.note ? `「${e.note}」` : "";
  if (e.kind === "transfer") return `${abs}${cur} ${acc(e.account_id)} → ${acc(e.to_account_id)}${note}`;
  if (e.kind === "adjust") return `${moneyText(e.amount_minor, dec, { prefix: e.amount_minor > 0 ? "±" : undefined })}${cur} 精算${note} · ${acc(e.account_id)}`;
  // 支出 −（退款＝負的支出 ⇒ ＋）、收入 ＋
  const plus = e.kind === "income" ? e.amount_minor >= 0 : e.amount_minor < 0;
  const cat = e.category_id ? s.catById[e.category_id] : undefined;
  const catName = e.category_id === null ? "未分類" : cat ? bareName(cat.name) || cat.name : VIEW_TEXT.catGone;
  return `${plus ? "＋" : "−"}${abs}${cur} ${catName}${note} · ${acc(e.account_id)}`;
}

function hitOf(e: EntryRow): QuickJumpHit {
  return {
    id: e.id,
    label: entryJumpLabel(e),
    aside: shortDay(e.occurred_on),
    glyph: { text: "帳" },
    go: async () => {
      useUiStore.getState().setPage("ticket");
      await useTicketStore.getState().jumpToEntry(e.id);
    },
  };
}

export const TICKET_QUICK_JUMP: QuickJumpProviderSpec = {
  id: "ticket.entries",
  group: "帳目",
  prefix: "$",
  async search(term, limit) {
    const rows = await useTicketStore.getState().searchEntries(term.trim(), limit);
    return rows.map(hitOf);
  },
};
