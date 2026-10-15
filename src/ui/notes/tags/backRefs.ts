/**
 * 「‹ 回到剛才」的進入點（桌機；旅客筆記車次③契約 0-16）：各入口最知道「剛才在哪」，在這裡把 label 與 restore 組好。
 *
 *   panelBackRef      任務側板的牌子：回原頁、重新選中那張票、側板打開（label＝「<路線名> 路線大綱」／頁名）
 *   pageBackRef       Ctrl+P：回開啟時的頁（label＝頁名）
 *   noteBackRef       筆記內文的行內小牌：回筆記子畫面並選中那則（label＝筆記標題）
 *   diaryBackRef      日記內文的行內小牌：回那天並選中那篇（label＝「M 月 D 日的日記」）
 */
import type { TagBackRef } from "../../../store/tagStore";
import { useUiStore, type PageId } from "../../../store/uiStore";
import { useNodeStore } from "../../../store/nodeStore";
import { useNotesStore } from "../../../store/notesStore";
import { pageById } from "../../shell/pages";
import { fmtMonthDay } from "../../../domain/notes";
import { notesFlush } from "../notesFlush";

/** 頁名（路線圖頁有開著的路線＝「<路線名> 路線大綱」） */
export function pageLabel(page: PageId): string {
  if (page === "routemap") {
    const ns = useNodeStore.getState();
    const r = ns.routeId ? ns.routes.find((x) => x.id === ns.routeId) : null;
    if (r) return `${r.name} 路線大綱`;
  }
  return pageById(page).label;
}

export function pageBackRef(): TagBackRef {
  const page = useUiStore.getState().page;
  return { label: pageLabel(page), restore: () => useUiStore.getState().setPage(page) };
}

export function panelBackRef(nodeId: string): TagBackRef {
  const ui = useUiStore.getState();
  const page = ui.page;
  const panelWasOpen = ui.panelOpen;
  return {
    label: pageLabel(page),
    restore: () => {
      const u = useUiStore.getState();
      u.setPage(page);
      u.select(nodeId);
      if (panelWasOpen) u.setPanelOpen(true);
    },
  };
}

export function noteBackRef(noteId: string, title: string): TagBackRef {
  return {
    label: title,
    restore: () => {
      void (async () => {
        await notesFlush.fn?.();
        const st = useNotesStore.getState();
        st.setSection("notes");
        st.selectNote(noteId);
      })();
    },
  };
}

export function diaryBackRef(entryId: string, day: string): TagBackRef {
  return {
    label: `${fmtMonthDay(day)}的日記`,
    restore: () => {
      void (async () => {
        await notesFlush.fn?.();
        const st = useNotesStore.getState();
        st.openDiaryAt(day);
        st.selectDiaryEntry(entryId);
      })();
    },
  };
}
