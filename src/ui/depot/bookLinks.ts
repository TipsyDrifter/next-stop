/**
 * 乘車記錄簿的四格事實與跳轉（車庫與回顧 D-主-218）——讀別線的公開 store（只讀），兩殼共用。
 *
 *   loadBookFacts(routeId)  済章數（車庫資料）、時刻表累計時數（連到這條路線的時間塊聯集）、花費累計、筆記數＋最近 5 則
 *   bookJump(kind, routeId) 點事實格：済章＝路線圖打開這條路線；時刻表＝時刻表統計；花費＝售票口看這條路線的帳；筆記＝旅客筆記篩這條路線
 */
import { nodeRepo } from "../../data";
import { noteRepo } from "../../data/noteRepo";
import type { NoteListItem } from "../../data/noteRepository";
import { MAIN_CURRENCY, moneyText } from "../../domain/ticket";
import { toLinkedSpan, unionMs } from "../../domain/timetableLink";
import { useNodeStore } from "../../store/nodeStore";
import { useNotesStore } from "../../store/notesStore";
import { useTicketStore } from "../../store/ticketStore";
import { useTimetableStore } from "../../store/timetableStore";
import { useUiStore } from "../../store/uiStore";
import { revealOnRouteMap } from "../mobile/routeMapReveal";

export interface BookFacts {
  routeId: string;
  /** 時刻表累計（毫秒）；讀不到＝null */
  hoursMs: number | null;
  /** 花費累計的字（「2,350」）；讀不到＝null */
  spend: string | null;
  noteCount: number;
  /** 最近 5 則（直接掛在路線上的在前） */
  notes: NoteListItem[];
}

export async function loadBookFacts(routeId: string): Promise<BookFacts> {
  const tree = await nodeRepo.listRouteTree(routeId).catch(() => []);
  const ids = [routeId, ...tree.map((n) => n.id)];
  const [hoursMs, spend, noteCount, notes] = await Promise.all([
    useTimetableStore
      .getState()
      .linkedBlocks({ routeId })
      .then((rows) => unionMs(rows.map(toLinkedSpan), Date.now()))
      .catch(() => null),
    (async () => {
      const t = useTicketStore.getState();
      await t.warm();
      await t.loadRouteSpend(routeId);
      const v = useTicketStore.getState().routeSpend[routeId];
      const dec = useTicketStore.getState().curByCode[MAIN_CURRENCY]?.decimals ?? 2;
      return v ? moneyText(v.total, dec, { whole: true }) : null;
    })().catch(() => null),
    noteRepo.countByNodes(ids).catch(() => 0),
    noteRepo.listByNodes(ids, routeId, 5).catch(() => []),
  ]);
  return { routeId, hoursMs, spend, noteCount, notes };
}

export type BookJump = "seals" | "time" | "spend" | "notes";

/** 點事實格（兩殼）：跳到該模組看這條路線 */
export function bookJump(kind: BookJump, routeId: string, shell: "desktop" | "mobile"): void {
  const ui = useUiStore.getState();
  switch (kind) {
    case "seals":
      openRouteOnMap(routeId, shell);
      return;
    case "time":
      if (shell === "mobile") ui.setMobileTab("timetable");
      else ui.setPage("timetable");
      useTimetableStore.getState().setView("stats");
      return;
    case "spend":
      if (shell === "mobile") ui.setMobileTab("ticket");
      else ui.setPage("ticket");
      void useTicketStore.getState().drillToList({ routeId, from: null, toExcl: null, kinds: [], accountId: null });
      return;
    case "notes": {
      if (shell === "mobile") ui.setMobileTab("notes");
      else ui.setPage("notes");
      const st = useNotesStore.getState();
      st.setSection("notes");
      void st.setNotesQuery({ routeId });
      return;
    }
  }
}

/** 在路線圖打開這條路線（已到站的也能看：大綱頂上一行「已收進車庫」） */
export function openRouteOnMap(routeId: string, shell: "desktop" | "mobile"): void {
  if (shell === "mobile") {
    revealOnRouteMap(routeId, null);
    return;
  }
  const ui = useUiStore.getState();
  ui.setPage("routemap");
  ui.setZoom(null);
  ui.select(null);
  void useNodeStore.getState().openRoute(routeId);
}
