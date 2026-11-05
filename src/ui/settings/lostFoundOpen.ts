/**
 * 失物招領 toast 的「打開」：撿回之後跳到它（契約 §2.5）。兩殼都先把失物招領的畫面收起來，再走各自既有的跳轉。
 *
 * 跳得到的種類：
 *   路線、支線、列車、車廂、車票、車站 → 完整搜尋與 Ctrl+P 那支（桌機 `jumpToNode`、手機 `jumpToNodeMobile`），邊界規則只有那一份
 *   筆記、日記 → Ctrl+P 的 `jumpNote`／`jumpDiary`
 *   帳目 → 售票口的 `jumpToEntry`（Ctrl+P 的帳目列同一支）
 * 不帶「打開」：幹線（沒有自己的畫面，跳轉會回「不屬於任何路線」）；荷札（Ctrl+P 用 name_key 開荷札頁，清單列沒有）；
 *   時間塊（`openBlock` 不對外）；週方針、目標、作息、定期帳、願望、常用票種、預算（沒有單筆跳轉）。
 */
import { nodeRepo } from "../../data";
import { noteRepo } from "../../data/noteRepo";
import type { LostItem, LostKindKey } from "../../domain/lostFound";
import { dayKeyOf } from "../../lib/date";
import { useLostFoundStore, type LostOpener } from "../../store/lostFoundStore";
import { useTicketStore } from "../../store/ticketStore";
import { useUiStore } from "../../store/uiStore";
import { jumpToNode } from "../common/QuickJump";
import { jumpToNodeMobile } from "../mobile/routeMapReveal";
import { jumpDiary, jumpNote } from "../notes/quickJumpNotes";

const OPENABLE: ReadonlySet<LostKindKey> = new Set<LostKindKey>(["route", "branch", "train", "car", "ticket", "station", "note", "diary", "tk_entry"]);

const gone = () => useUiStore.getState().showToast({ message: "找不到這一筆，可能又被刪了" });

async function open(item: Pick<LostItem, "kind" | "table" | "id">, mobile: boolean): Promise<void> {
  const ui = useUiStore.getState();
  useLostFoundStore.getState().closeRescue();
  if (!mobile) ui.setSettingsOpen(false);
  if (item.table === "nodes") {
    const node = await nodeRepo.getNode(item.id);
    if (!node || node.deleted_at !== null) return gone();
    await (mobile ? jumpToNodeMobile(node) : jumpToNode(node));
    return;
  }
  if (item.kind === "note") return jumpNote(item.id);
  if (item.kind === "diary") {
    const note = await noteRepo.getNote(item.id);
    if (!note) return gone();
    return jumpDiary(item.id, note.entry_date || dayKeyOf(note.noted_at, ui.dayStartHour));
  }
  if (item.kind === "tk_entry") {
    if (mobile) ui.setMobileTab("ticket");
    else ui.setPage("ticket");
    await useTicketStore.getState().jumpToEntry(item.id);
  }
}

/** 給 store：這一種跳得到就回動作，跳不到回 null（toast 不帶鈕） */
export function lostOpener(mobile: boolean): LostOpener {
  return (item) => (OPENABLE.has(item.kind) ? () => void open(item, mobile).catch(gone) : null);
}
