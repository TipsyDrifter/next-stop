/**
 * MobileNotes——旅客筆記手機分頁（底部第三格；車次①契約 §5.3；D-筆-13／20：手機與桌機同一車次、功能對等）。
 *
 * 頁根照手機殼契約：`.m-page`（唯一的捲動容器；MobileShell.tsx 檔頭）＋本線 `.ns-notes-m`。
 *   頂部兩段切換「收件匣 N／筆記 N」（日記等車次②）→ 收件匣卡片（MobileNoteInbox）或筆記列表（MobileNoteList）；
 *   點進一則筆記＝整頁（MobileNotePage，左上「‹ 筆記」返回）。
 * 捕捉面板與變待辦預覽不在這裡：它們是全域浮層（NotesMobileOverlay），每個 tab 都叫得出來。
 *
 * 狀態：子畫面（section）與選取共用 notesStore（桌機同一份）。「整頁開著」是本頁的 useState，不進 store——
 *   它只活在這一格 tab：切走再回來回到列表，與 MobileToday 的 action sheet 同一套理由；
 *   也免得桌機選中的那則在視窗縮成手機時直接把整頁蓋上來。
 * 載入：進頁載一次收件匣與筆記（store 的 loadInbox／loadNotes）；之後由各動作自己重載、同步由 mount.reload 重載。
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNotesStore } from "../../../store/notesStore";
import { MobileNoteInbox } from "./MobileNoteInbox";
import { MobileNoteList } from "./MobileNoteList";
import { MobileNotePage } from "./MobileNotePage";
import "../notes-mobile.css";

export function MobileNotes() {
  const section = useNotesStore((s) => s.section);
  const setSection = useNotesStore((s) => s.setSection);
  const inboxCount = useNotesStore((s) => s.inboxNotes.length + s.inboxTickets.length);
  const notes = useNotesStore((s) => s.notes);
  const notesQuery = useNotesStore((s) => s.notesQuery);
  const loadInbox = useNotesStore((s) => s.loadInbox);
  const loadNotes = useNotesStore((s) => s.loadNotes);
  const selectNote = useNotesStore((s) => s.selectNote);
  const startNewNote = useNotesStore((s) => s.startNewNote);
  const setNotesQuery = useNotesStore((s) => s.setNotesQuery);
  const [pageOpen, setPageOpen] = useState(false);
  /** 「筆記 N」的 N＝筆記總數：只在沒有篩選、沒有搜尋時更新（篩選中的列表長度不是總數） */
  const [notesTotal, setNotesTotal] = useState<number | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const listScroll = useRef(0);

  useEffect(() => {
    void loadInbox();
    void loadNotes();
  }, [loadInbox, loadNotes]);

  useEffect(() => {
    if (!notesQuery.routeId && !(notesQuery.query ?? "").trim()) setNotesTotal(notes.length);
  }, [notes, notesQuery]);

  // 進整頁捲到頂；回列表捲回原位
  useLayoutEffect(() => {
    const el = pageRef.current;
    if (!el) return;
    el.scrollTop = pageOpen ? 0 : listScroll.current;
  }, [pageOpen]);

  const openPage = (id: string | null) => {
    listScroll.current = pageRef.current?.scrollTop ?? 0;
    if (id) selectNote(id);
    else {
      // 新筆記一定不含搜尋字（還沒寫），搜尋開著的話建好也不會出現在列表裡、整頁拿不到它的掛在哪／日期
      // ⇒ 按「新筆記」＝離開搜尋。路線篩選保留（store 建草稿時會掛那條路線，照原型 newNote）
      const q = useNotesStore.getState().notesQuery;
      if ((q.query ?? "").trim()) void setNotesQuery({ ...q, query: undefined });
      startNewNote();
    }
    setPageOpen(true);
  };

  const showPage = section === "notes" && pageOpen;

  return (
    <div className="m-page ns-notes-m" ref={pageRef}>
      {showPage ? (
        <MobileNotePage onBack={() => setPageOpen(false)} />
      ) : (
        <>
          <div className="ns-notes-mtabs" role="group" aria-label="收件匣・筆記">
            <div className="in">
              <button
                type="button"
                className={section === "inbox" ? "on" : ""}
                aria-pressed={section === "inbox"}
                onClick={() => setSection("inbox")}
              >
                收件匣<span className="n">{inboxCount}</span>
              </button>
              <button
                type="button"
                className={section === "notes" ? "on" : ""}
                aria-pressed={section === "notes"}
                onClick={() => setSection("notes")}
              >
                筆記{notesTotal !== null && <span className="n">{notesTotal}</span>}
              </button>
            </div>
          </div>
          {section === "inbox" ? (
            <MobileNoteInbox />
          ) : (
            <MobileNoteList onOpen={(id) => openPage(id)} onNew={() => openPage(null)} />
          )}
        </>
      )}
    </div>
  );
}
