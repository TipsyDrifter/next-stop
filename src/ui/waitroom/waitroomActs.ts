/**
 * waitroomActs——候車室的實現動作與跳轉（兩殼共用；壬 D-主-511、D-主-520）。只叫 store 與 repository，不畫東西。
 *
 * 實現＝轉成對應模組的記錄；做什麼看願望所屬種類的 action（`wishActionOf`，種類查不到時開票），按鈕字＝WISH_ACTION_LABEL：
 *   entry 記一筆：先回售票口頁（桌機關設定面板再換頁；手機換 tab），再 ticketStore.buyWish 開記一筆預填；
 *          存了那筆，售票口寫回 entry_id（既有機制）→ 讀時判斷成「實現了」。
 *   ticket 開票：建一張臨時車票（收件匣，或掛一條路線的標籤；可帶日期），願望的荷札帶給票。
 *   route  開路線：在一條幹線下建路線（路線必掛幹線；不走 routeFlows.createRoute——它會切頁），預設色同新增路線對話框；
 *          路線掛不上荷札（tags 只收車票／列車／車廂），不帶。
 *   diary  寫日記：在那天建一篇日記（內文＝表單的字；荷札用 `#名稱` 寫進內文再 syncNoteTags——日記的荷札跟著內文走）。
 *   time   記時間：timetableRepo.fill 補記一段（分類必選、起訖不能超過現在、備註預填），荷札掛到那一塊。
 *   後四種建完 setWishTarget 記下去向（node／note／block），toast 帶「復原」（刪掉那筆記錄＋清掉 target）。
 * 實現了的列點名稱＝跳到那筆帳／那張票／那條路線／那篇日記／那一塊時間。
 * 殼看 `<html data-shell>`（同 lines/ticketTagEntities.ts 的 gotoTicket）。
 */
import { nodeRepo } from "../../data";
import { noteRepo } from "../../data/noteRepo";
import { tagRepo } from "../../data/tagRepo";
import { timetableRepo } from "../../data/timetableRepository";
import { useNodeStore } from "../../store/nodeStore";
import { useNotesStore } from "../../store/notesStore";
import { useTagStore } from "../../store/tagStore";
import { useTicketStore } from "../../store/ticketStore";
import { useTimetableStore } from "../../store/timetableStore";
import { useUiStore } from "../../store/uiStore";
import { bodyWithTag } from "../../domain/tags";
import { TK_TAG_WISH } from "../../domain/ticketTags";
import { TT_TAG_BLOCK } from "../../domain/timetableTags";
import type { RealizedWish, WishRow, WishTargetKind } from "../../domain/ticketAids";
import { attachQuickTags } from "../common/quickadd/useQuickAdd";
import { jumpToNode } from "../common/QuickJump";
import { jumpToNodeMobile } from "../mobile/routeMapReveal";
import { routePresetColor } from "../common/ColorPicker";
import { defaultRouteColorIndex } from "../panel/routeFlowRules";
import { notesFlush } from "../notes/notesFlush";
import { gotoTimetable, openBlock } from "../../lines/timetableTagEntities";

export function shellNow(): "desktop" | "mobile" {
  return typeof document !== "undefined" && document.documentElement.getAttribute("data-shell") === "mobile" ? "mobile" : "desktop";
}

function toast(message: string, undo?: () => void): void {
  useUiStore.getState().showToast(undo ? { message, actionLabel: "復原", onAction: undo } : { message });
}

/** 回售票口頁（桌機關掉設定面板再換頁；手機換 tab） */
function gotoTicket(): void {
  const ui = useUiStore.getState();
  if (shellNow() === "desktop") {
    ui.setSettingsOpen(false);
    ui.setPage("ticket");
  } else ui.setMobileTab("ticket");
}

/** 「記一筆」：先到售票口，再開記一筆（預填金額、名稱、分類、荷札） */
export function buyFromWaitroom(id: string): void {
  gotoTicket();
  void useTicketStore.getState().buyWish(id);
}

/** 願望掛的荷札名稱（讀不到＝空，不擋實現） */
async function wishTags(wishId: string): Promise<{ name: string; key: string }[]> {
  try {
    return (await tagRepo.listTagsOf(TK_TAG_WISH, wishId)).map((t) => ({ name: t.name, key: t.name_key }));
  } catch (e) {
    console.warn("[waitroom] 讀願望的荷札失敗", e);
    return [];
  }
}

/** 記下去向＋toast「復原」（復原＝刪記錄、願望回到等候） */
async function markRealized(w: WishRow, kind: WishTargetKind, id: string, message: string, removeRecord: () => Promise<void>): Promise<void> {
  await useTicketStore.getState().setWishTarget(w.id, { kind, id });
  toast(message, () => {
    void (async () => {
      try {
        await removeRecord();
      } catch (e) {
        console.warn("[waitroom] 復原時刪記錄失敗", e);
      }
      await useTicketStore.getState().setWishTarget(w.id, null);
    })();
  });
}

/** 開票：收件匣＝不給路線、不給日期；掛路線＝臨時票帶那條的標籤 */
export async function realizeAsTicket(w: WishRow, input: { name: string; routeId: string | null; day: string | null }): Promise<boolean> {
  const name = input.name.replace(/\s+/g, " ").trim();
  if (!name) {
    toast("票名不能是空的");
    return false;
  }
  const row = await useNodeStore.getState().createNode({
    kind: "ticket",
    name,
    parentId: null,
    routeTagId: input.routeId ?? undefined,
    scheduledOn: input.day ?? undefined,
  });
  if (!row) {
    toast(useNodeStore.getState().error ?? "沒有開成功——請再試一次");
    return false;
  }
  // 願望的荷札帶給票（失敗 attachQuickTags 自己說；票已經開好，不擋）
  await attachQuickTags(
    row.id,
    (await wishTags(w.id)).map((t) => t.name),
  );
  await markRealized(w, "node", row.id, "開了車票", async () => {
    await useNodeStore.getState().deleteNode(row.id);
  });
  return true;
}

/** 開路線：在幹線 lineId 下建一條路線（預設色同新增路線對話框：前三格輪流） */
export async function realizeAsRoute(w: WishRow, input: { name: string; lineId: string }): Promise<boolean> {
  const name = input.name.replace(/\s+/g, " ").trim();
  if (!name) {
    toast("路線名不能是空的");
    return false;
  }
  const ns = useNodeStore.getState();
  const row = await ns.createNode({
    kind: "route",
    name,
    parentId: input.lineId,
    color: routePresetColor(defaultRouteColorIndex(ns.routes.length)),
  });
  if (!row) {
    toast(useNodeStore.getState().error ?? "沒有開成功——請再試一次");
    return false;
  }
  await markRealized(w, "node", row.id, "開了路線", async () => {
    await useNodeStore.getState().deleteNode(row.id);
  });
  return true;
}

/** 日記的畫面重讀（旅客筆記線的 reload，同同步拉到東西時） */
async function reloadNotes(): Promise<void> {
  await useNotesStore.getState().reload({ changed: ["notes", "tags", "taggings"], wiped: false, shell: shellNow() });
}

/** 寫日記：在 day 建一篇日記；願望的荷札以 `#名稱` 補進內文最後一行，再照內文同步掛載 */
export async function realizeAsDiary(w: WishRow, input: { body: string; day: string }): Promise<boolean> {
  let body = input.body.replace(/\s+$/, "");
  if (!body.trim()) {
    toast("日記要有內容");
    return false;
  }
  for (const t of await wishTags(w.id)) body = bodyWithTag(body, t.key, t.name);
  let id: string;
  try {
    const row = await noteRepo.create({ kind: "diary", body, title: "", inbox: false, entryDate: input.day });
    id = row.id;
  } catch (e) {
    toast(e instanceof Error ? e.message : "日記沒有寫成——請再試一次");
    return false;
  }
  try {
    await useTagStore.getState().syncNoteTags(id, body);
  } catch (e) {
    console.warn("[waitroom] 日記的荷札沒掛上", e);
  }
  await reloadNotes().catch(() => undefined);
  await markRealized(w, "note", id, "寫進日記了", async () => {
    await noteRepo.softDelete(id);
    await reloadNotes().catch(() => undefined);
  });
  return true;
}

/** 記時間：補記 [startMs, endMs) 一塊（分類必選）；願望的荷札掛到那一塊 */
export async function realizeAsTime(w: WishRow, input: { categoryId: string; startMs: number; endMs: number; note: string }): Promise<boolean> {
  if (!(input.startMs < input.endMs)) {
    toast("結束要晚於開始");
    return false;
  }
  if (input.endMs > Date.now()) {
    toast("還沒到的時間不能補記");
    return false;
  }
  let blockId: string;
  try {
    const r = await timetableRepo.fill(input.categoryId, new Date(input.startMs).toISOString(), new Date(input.endMs).toISOString(), {
      note: input.note.trim() || null,
    });
    blockId = r.block.id;
  } catch (e) {
    toast(e instanceof Error ? e.message : "時間沒有記成——請再試一次");
    return false;
  }
  const names = (await wishTags(w.id)).map((t) => t.name);
  if (names.length) {
    try {
      await tagRepo.setTags(TT_TAG_BLOCK, blockId, names);
      await useTagStore.getState().loadIndex();
    } catch (e) {
      console.warn("[waitroom] 時間塊的荷札沒掛上", e);
    }
  }
  const refreshTt = async () => {
    const tt = useTimetableStore.getState();
    if (tt.ready) await tt.refresh().catch(() => undefined);
  };
  await refreshTt();
  await markRealized(w, "block", blockId, "記好時間了", async () => {
    await timetableRepo.softDelete(blockId);
    await refreshTt();
  });
  return true;
}

/** 實現了的列：點名稱跳到那筆記錄 */
export async function gotoRealized(r: RealizedWish): Promise<void> {
  if (r.entry) {
    gotoTicket();
    void useTicketStore.getState().jumpToEntry(r.entry.id);
    return;
  }
  const t = r.target;
  if (!t) return;
  const shell = shellNow();
  if (t.kind === "note") {
    await notesFlush.fn?.();
    const ui = useUiStore.getState();
    if (shell === "desktop") {
      ui.setSettingsOpen(false);
      ui.setPage("notes");
    } else ui.setMobileTab("notes");
    const st = useNotesStore.getState();
    // target.name＝那篇的日期（getWishTargets）；空的話讀一次
    const day = t.name || (await noteRepo.getNote(t.id).catch(() => null))?.entry_date;
    if (day) st.openDiaryAt(day);
    st.selectDiaryEntry(t.id);
    return;
  }
  if (t.kind === "block") {
    const row = await timetableRepo.getBlock(t.id).catch(() => null);
    if (!row) {
      await gotoTimetable(shell);
      return;
    }
    await openBlock(row);
    return;
  }
  const row = await nodeRepo.getNode(t.id).catch(() => null);
  if (!row) {
    toast("找不到這張票（可能已經刪除）");
    return;
  }
  if (shell === "mobile") await jumpToNodeMobile(row);
  else await jumpToNode(row);
}

/** 願望的資料：沒暖過就暖（App 啟動時 TicketAgent 會叫；這裡是保險），再重讀一次——別處刪了開出的記錄，回到等候 */
export async function bootWaitroom(): Promise<void> {
  try {
    await useTicketStore.getState().warm();
    await useTicketStore.getState().refresh();
  } catch (e) {
    console.warn("[waitroom] 讀候車室失敗", e);
  }
}
