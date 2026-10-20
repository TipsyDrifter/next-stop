/**
 * MobileNotes——旅客筆記手機分頁（底部第三格；車次①契約 §5.3；D-筆-13／20：手機與桌機同一車次、功能對等）。
 *
 * 頁根照手機殼契約：`.m-page`（唯一的捲動容器；MobileShell.tsx 檔頭）＋本線 `.ns-notes-m`。
 *   頂部三段切換「收件匣 N／筆記 N／日記」→ 收件匣卡片（MobileNoteInbox）、筆記列表（MobileNoteList）
 *   或日記（MobileDiary，車次②）；點進一則筆記＝整頁（MobileNotePage，左上「‹ 筆記」返回）。
 *   日記不帶數字（日記以日為單位，沒有「全部日記」的總數；契約 §5.3）。
 * 捕捉面板與變待辦預覽不在這裡：它們是全域浮層（NotesMobileOverlay），每個 tab 都叫得出來。
 *
 * 狀態：子畫面（section）與選取共用 notesStore（桌機同一份）。「整頁開著」是本頁的 useState，不進 store——
 *   它只活在這一格 tab：切走再回來回到列表，與 MobileToday 的 action sheet 同一套理由；
 *   也免得桌機選中的那則在視窗縮成手機時直接把整頁蓋上來。
 * 載入：進頁載一次收件匣與筆記（store 的 loadInbox／loadNotes）；之後由各動作自己重載、同步由 mount.reload 重載。
 *
 * 車次③：第四段「荷札」（契約 §5.5）——荷札樹（MobileTags）；樹裡點一個（`tagStore.selectedKey` 非 null）＝清單整頁
 *   （MobileTagPage，左上「‹ 荷札」返回），與筆記整頁同法取代頂部分段。進頁跑一次通車補掛（`ensureBackfill`，契約 0-9／0-10）。
 *   從別處進荷札（行內小牌、路線圖詳情）＝section 換成 "tags" ⇒ 筆記整頁關掉（契約 §3.6 末）；
 *   筆記整頁裡的小牌給的「回到剛才」會把整頁再打開（`openTagFromNote`）。
 *
 * 車次④：別處（路線圖詳情的筆記列）要開一則的整頁＝`notesStore.requestMobileOpenNote(id)`（0-12）；本頁的 effect 接手
 *   （清篩選→找到那則→開整頁），請求清回 null——「整頁開著」仍是本頁的 state。「筆記 N」改讀 store 的 `notesTotal`（0-16）。
 *
 * 磨光① A7：別處要指出收件匣的一張臨時票＝核心請求槽 `useRevealStore` 的 target "inbox"（routeMapReveal.ts `revealInbox`）；本頁接手。
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNotesStore } from "../../../store/notesStore";
import { useTagStore } from "../../../store/tagStore";
import { useRevealStore } from "../../mobile/routeMapReveal";
import { noteTitle } from "../../../domain/notes";
import { MobileNoteInbox } from "./MobileNoteInbox";
import { MobileNoteList } from "./MobileNoteList";
import { MobileNotePage } from "./MobileNotePage";
import { MobileDiary } from "./MobileDiary";
import { MobileTags } from "./MobileTags";
import { MobileTagPage } from "./MobileTagPage";
import "../notes-mobile.css";

export function MobileNotes() {
  const section = useNotesStore((s) => s.section);
  const tagKey = useTagStore((s) => s.selectedKey);
  // 真荷札數（虛資料夾不算）——與桌機書封頁務件同口徑（NotesCoverAux）
  const tagCount = useTagStore((s) => (s.index ? Object.values(s.index.byKey).filter((x) => x.real).length : null));
  const setSection = useNotesStore((s) => s.setSection);
  const inboxCount = useNotesStore((s) => s.inboxNotes.length + s.inboxTickets.length);
  // 「筆記 N」＝筆記總數（store 的 countNotes；階段④ 0-16——不再數已載入的頁）
  const notesTotal = useNotesStore((s) => s.notesTotal);
  const mobileOpenNoteId = useNotesStore((s) => s.mobileOpenNoteId);
  const loadInbox = useNotesStore((s) => s.loadInbox);
  const loadNotes = useNotesStore((s) => s.loadNotes);
  const selectNote = useNotesStore((s) => s.selectNote);
  const startNewNote = useNotesStore((s) => s.startNewNote);
  const setNotesQuery = useNotesStore((s) => s.setNotesQuery);
  const [pageOpen, setPageOpen] = useState(false);
  const pageRef = useRef<HTMLDivElement>(null);
  const listScroll = useRef(0);

  useEffect(() => {
    void loadInbox();
    void loadNotes();
  }, [loadInbox, loadNotes]);

  // 通車補掛（每台一次；守門在 store）＝進旅客筆記頁就跑，不等第一次點「荷札」
  useEffect(() => {
    void useTagStore.getState().ensureBackfill();
  }, []);

  // 換到荷札段（含從別處 openTagPage 進來）＝筆記整頁關掉
  useEffect(() => {
    if (section === "tags") setPageOpen(false);
  }, [section]);

  /** 筆記整頁內文的行內小牌：進荷札清單頁，「回到剛才」＝回這一則的整頁（契約 0-16） */
  const openTagFromNote = (key: string, noteId: string | null) => {
    const st = useNotesStore.getState();
    const n = noteId ? st.notes.find((x) => x.id === noteId) : undefined;
    void useTagStore.getState().openTagPage(
      key,
      noteId
        ? {
            label: n ? noteTitle(n) : "筆記",
            restore: () => {
              const s = useNotesStore.getState();
              s.setSection("notes");
              s.selectNote(noteId);
              setPageOpen(true);
            },
          }
        : undefined,
    );
  };

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

  /**
   * 從別處開一則筆記的整頁（階段④ 0-12：路線圖詳情的筆記列 → `requestMobileOpenNote`）。
   * 先清掉路線／節點篩選與搜尋（不然列表裡可能沒有它，整頁拿不到它的掛在哪／日期；同 MobileTagPage 的 goNote）、
   * 還沒載到就往下翻頁；在收件匣的＝收件匣段選中；找不到（已刪）＝停在筆記段列表。接手後把請求清回 null。
   */
  const openPageRef = useRef(openPage);
  openPageRef.current = openPage;
  useEffect(() => {
    if (!mobileOpenNoteId) return;
    const id = mobileOpenNoteId;
    useNotesStore.setState({ mobileOpenNoteId: null });
    void (async () => {
      const ns = useNotesStore.getState();
      const q = ns.notesQuery;
      // 沒篩選也重載一次：剛掛上的那則可能還不在手上的列表裡（進頁那一趟載入還在路上）
      if (q.routeId || q.underNode || (q.query ?? "").trim()) await ns.setNotesQuery({});
      else await ns.loadNotes();
      for (let i = 0; i < 20; i++) {
        const s = useNotesStore.getState();
        if (s.notes.some((n) => n.id === id) || !s.notesHasMore) break;
        await s.loadMoreNotes();
      }
      const st = useNotesStore.getState();
      if (st.notes.some((n) => n.id === id)) {
        st.setSection("notes");
        openPageRef.current(id);
        return;
      }
      await st.loadInbox();
      if (useNotesStore.getState().inboxNotes.some((n) => n.id === id)) {
        st.setSection("inbox");
        st.selectInbox({ kind: "note", id });
        return;
      }
      st.setSection("notes");
    })();
  }, [mobileOpenNoteId]);

  /**
   * 別處指出收件匣的一張臨時票（磨光① A7：手機搜尋、荷札頁點臨時票 → 核心 `revealInbox`，請求槽 target "inbox"）：
   * 收下就銷帳（切走再回來不重播）→ 手上沒有就重載收件匣 → 換到收件匣段、選中（去處列展開）、捲到它。
   * 已經不在收件匣（剛被排走）＝只停在收件匣段。
   */
  const revealReq = useRevealStore((s) => (s.req?.target === "inbox" ? s.req : null));
  useEffect(() => {
    if (!revealReq) return;
    useRevealStore.getState().consume(revealReq.nonce);
    const id = revealReq.nodeId;
    void (async () => {
      if (id && !useNotesStore.getState().inboxTickets.some((t) => t.id === id)) await useNotesStore.getState().loadInbox();
      const st = useNotesStore.getState();
      setPageOpen(false);
      st.setSection("inbox");
      if (!id || !st.inboxTickets.some((t) => t.id === id)) return;
      st.selectInbox({ kind: "ticket", id });
      requestAnimationFrame(() => {
        const li = pageRef.current?.querySelector<HTMLElement>(".ns-notes-mitem.is-sel");
        const reduce = !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
        li?.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
      });
    })();
  }, [revealReq]);

  const showPage = section === "notes" && pageOpen;
  const showTagPage = section === "tags" && tagKey !== null;

  return (
    <div className="m-page ns-notes-m" ref={pageRef}>
      {showPage ? (
        <MobileNotePage onBack={() => setPageOpen(false)} onOpenTag={openTagFromNote} />
      ) : showTagPage ? (
        <MobileTagPage onOpenNote={(id) => openPage(id)} />
      ) : (
        <>
          <div className="ns-notes-mtabs" role="group" aria-label="收件匣・筆記・日記・荷札">
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
              <button
                type="button"
                className={section === "diary" ? "on" : ""}
                aria-pressed={section === "diary"}
                onClick={() => setSection("diary")}
              >
                日記
              </button>
              <button
                type="button"
                className={section === "tags" ? "on" : ""}
                aria-pressed={section === "tags"}
                onClick={() => setSection("tags")}
              >
                荷札{tagCount !== null && <span className="n">{tagCount}</span>}
              </button>
            </div>
          </div>
          {section === "inbox" ? (
            <MobileNoteInbox />
          ) : section === "diary" ? (
            <MobileDiary />
          ) : section === "tags" ? (
            <MobileTags />
          ) : (
            <MobileNoteList onOpen={(id) => openPage(id)} onNew={() => openPage(null)} />
          )}
        </>
      )}
    </div>
  );
}
