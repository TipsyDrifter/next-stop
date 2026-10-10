/**
 * NotesView——旅客筆記桌機頁根（車次①契約 §5.1；原型 prototypes/旅客筆記-src/ app.js deskMain／deskInbox／deskNotes）。
 *
 * 版面：`div.page.ns-notes`（頁殼契約同今日頁；天空由 App 掛、本頁不碰）三欄 flex、各欄自己捲：
 *   NotesSide（本線頁務件：收件匣・筆記切換＋路線篩選）｜ 收件匣 NotesInbox  或  NotesList ＋ NoteContent
 *
 * 本檔是桌機的「控制器」：選取、離場動畫、小浮層開關、存檔 flush、鍵盤表的動作分派都在這裡，
 * 子元件只畫與轉發。資料一律經 notesStore 的動作（UI 不碰 repository）。
 *
 * 鍵盤：`useNotesKeyboard` 掛在根節點 onKeyDown（契約 §5.6）；焦點容器＝收件匣清單／筆記清單（listbox，tabIndex=0）。
 * 從 Ctrl+P 跳來（契約 0-2 甲／§5.1）：uiStore.selectedId 是收件匣裡的車票 ⇒ 切到收件匣並選中它（每個 id 只接手一次，
 * 不然之後每次重載收件匣都會把主人拉回來）。不清 uiStore 的選取（那是今日／大綱共用的，§8-14）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNotesStore } from "../../store/notesStore";
import { useUiStore } from "../../store/uiStore";
import { addDays, todayKey } from "../../lib/date";
import { NotesSide } from "./NotesSide";
import {
  NotesInbox,
  inboxItemsOf,
  refOf,
  type InboxItem,
  type InboxOp,
  type InboxPopKind,
} from "./NotesInbox";
import { NotesList } from "./NotesList";
import { NoteContent, type NotePopKind } from "./NoteContent";
import { useNotesKeyboard } from "./useNotesKeyboard";
import { reducedMotion } from "./notesBits";
import "./notes.css";

type Pop = { id: string; kind: InboxPopKind | NotePopKind };

export function NotesView() {
  const section = useNotesStore((s) => s.section);
  const inboxNotes = useNotesStore((s) => s.inboxNotes);
  const inboxTickets = useNotesStore((s) => s.inboxTickets);
  const inboxSelected = useNotesStore((s) => s.inboxSelected);
  const uiSelectedId = useUiStore((s) => s.selectedId);

  const [pop, setPop] = useState<Pop | null>(null);
  const [leaving, setLeaving] = useState<string | null>(null);
  const inboxListRef = useRef<HTMLUListElement>(null);
  const notesListRef = useRef<HTMLUListElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const readRef = useRef<HTMLDivElement>(null);
  const flushRef = useRef<(() => Promise<void>) | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const items = useMemo(() => inboxItemsOf(inboxNotes, inboxTickets), [inboxNotes, inboxTickets]);

  /* ── 進頁：載兩份清單；焦點給目前子畫面的清單 ── */
  useEffect(() => {
    const st = useNotesStore.getState();
    void st.loadInbox();
    void st.loadNotes();
  }, []);

  const focusList = useCallback((which?: "inbox" | "notes") => {
    const s = which ?? useNotesStore.getState().section;
    const ref = s === "inbox" ? inboxListRef : notesListRef;
    // 清單已在畫面上就直接給；還沒畫出來（剛換子畫面）就等下一輪；清單空了（沒有 ul）就給頁根，
    // 鍵盤表才不會斷線。不用 rAF：視窗在背景時 rAF 不跑
    const give = () => (ref.current ?? rootRef.current)?.focus({ preventScroll: true });
    if (ref.current) give();
    else setTimeout(give, 0);
  }, []);

  useEffect(() => {
    focusList(section);
    setPop(null);
  }, [section, focusList]);

  /* ── 收件匣：桌機恆有一則選中（清單非空時） ── */
  useEffect(() => {
    if (section !== "inbox" || leaving) return;
    if (!items.length) return;
    if (!inboxSelected || !items.some((it) => it.id === inboxSelected.id)) {
      useNotesStore.getState().selectInbox(refOf(items[0]));
    }
  }, [section, items, inboxSelected, leaving]);

  /* ── 從 Ctrl+P 跳來 ── */
  const consumedJump = useRef<string | null>(null);
  useEffect(() => {
    if (!uiSelectedId || consumedJump.current === uiSelectedId) return;
    if (!inboxTickets.some((t) => t.id === uiSelectedId)) return;
    consumedJump.current = uiSelectedId;
    const st = useNotesStore.getState();
    st.setSection("inbox");
    st.selectInbox({ kind: "ticket", id: uiSelectedId });
  }, [uiSelectedId, inboxTickets]);

  /* ── 換選取前先把內容欄沒送出的字存掉 ── */
  const flushThen = useCallback(async (fn: () => void) => {
    await flushRef.current?.();
    fn();
  }, []);

  const changeSection = (s: "inbox" | "notes") =>
    void flushThen(() => {
      useNotesStore.getState().setSection(s);
    });
  const changeFilter = (routeId: string | "none" | undefined) =>
    void flushThen(() => {
      const cur = useNotesStore.getState().notesQuery;
      void useNotesStore.getState().setNotesQuery({ ...cur, routeId });
    });

  /* ═══ 收件匣動作 ═══ */
  const selectedItem = (): InboxItem | null => {
    const sel = useNotesStore.getState().inboxSelected;
    return (sel && items.find((it) => it.id === sel.id)) ?? null;
  };

  /** 送走一則：先播離場動畫、把選取交給下一則，再呼叫 store；焦點回清單（按鈕跟著那一則消失了） */
  const leave = (it: InboxItem, fn: () => Promise<void>) => {
    setPop(null);
    const idx = items.findIndex((x) => x.id === it.id);
    const next = items[idx + 1] ?? items[idx - 1] ?? null;
    const run = async () => {
      setLeaving(null);
      const st = useNotesStore.getState();
      if (st.inboxSelected?.id === it.id) st.selectInbox(next ? refOf(next) : null);
      focusList("inbox");
      await fn();
      // 送走的是最後一則：清單整個收掉，焦點會掉到 body——接回頁根
      if (document.activeElement === document.body) focusList("inbox");
    };
    if (reducedMotion()) void run();
    else {
      setLeaving(it.id);
      setTimeout(() => void run(), 210);
    }
  };

  const today = () => todayKey(useUiStore.getState().dayStartHour);

  const inboxOp = (it: InboxItem, op: InboxOp) => {
    const st = useNotesStore.getState();
    if (st.inboxSelected?.id !== it.id) st.selectInbox(refOf(it));
    if (it.kind === "note") {
      if (op === "todo") return st.openPreviewFromNote(it.id);
      if (op === "keep") return leave(it, () => st.keepNote(it.id));
      if (op === "del") return leave(it, () => st.deleteNote(it.id));
      return;
    }
    switch (op) {
      case "today":
        return leave(it, () => st.scheduleTicket(it.id, today()));
      case "tomorrow":
        return leave(it, () => st.scheduleTicket(it.id, addDays(today(), 1)));
      case "someday":
      case "attach":
      case "route":
        setPop((p) => (p && p.id === it.id && p.kind === op ? null : { id: it.id, kind: op }));
        return;
      case "del":
        return leave(it, () => st.deleteTicket(it.id));
    }
  };

  /* ═══ 筆記動作 ═══ */
  const notesNow = () => useNotesStore.getState().notes;

  const selectNote = (id: string) =>
    void flushThen(() => {
      setPop(null);
      useNotesStore.getState().selectNote(id);
    });

  const newNote = () =>
    void flushThen(() => {
      setPop(null);
      useNotesStore.getState().startNewNote();
    });

  const deleteNote = (id: string) => {
    const list = notesNow();
    const idx = list.findIndex((n) => n.id === id);
    const next = list[idx + 1] ?? list[idx - 1] ?? null;
    setPop(null);
    // 這一則要被刪：沒送出的字丟掉也無妨，但仍先送（復原時內容要是最新的）
    void flushThen(() => {
      const st = useNotesStore.getState();
      st.selectNote(next ? next.id : null);
      focusList("notes");
      void st.deleteNote(id);
    });
  };

  const noteTodo = (id: string) => void flushThen(() => useNotesStore.getState().openPreviewFromNotePage(id));

  /* ═══ 鍵盤表 ═══ */
  const onKeyDown = useNotesKeyboard(
    {
      move(delta) {
        const st = useNotesStore.getState();
        if (st.section === "inbox") {
          if (!items.length) return;
          let i = items.findIndex((it) => it.id === st.inboxSelected?.id);
          i = i < 0 ? 0 : Math.min(items.length - 1, Math.max(0, i + delta));
          st.selectInbox(refOf(items[i]));
          return;
        }
        const list = st.notes;
        if (!list.length) return;
        let i = list.findIndex((n) => n.id === st.selectedNoteId);
        i = i < 0 ? (delta > 0 ? 0 : list.length - 1) : Math.min(list.length - 1, Math.max(0, i + delta));
        selectNote(list[i].id);
        notesListRef.current?.focus({ preventScroll: true });
      },
      open() {
        const st = useNotesStore.getState();
        if (st.section === "inbox") {
          const it = selectedItem();
          if (!it) return;
          inboxListRef.current
            ?.querySelector<HTMLButtonElement>(`[data-iid="${CSS.escape(it.id)}"] .ns-notes-destrow button`)
            ?.focus();
          return;
        }
        if (st.selectedNoteId || st.draftNew) st.setEditing(true);
      },
      todo() {
        const st = useNotesStore.getState();
        if (st.section === "inbox") {
          const it = selectedItem();
          if (it) inboxOp(it, it.kind === "note" ? "todo" : "today");
          return;
        }
        if (st.selectedNoteId) noteTodo(st.selectedNoteId);
      },
      tomorrow() {
        const it = useNotesStore.getState().section === "inbox" ? selectedItem() : null;
        if (it?.kind === "ticket") inboxOp(it, "tomorrow");
      },
      keep() {
        const it = useNotesStore.getState().section === "inbox" ? selectedItem() : null;
        if (it?.kind === "note") inboxOp(it, "keep");
      },
      attach() {
        const it = useNotesStore.getState().section === "inbox" ? selectedItem() : null;
        if (it?.kind === "ticket") inboxOp(it, "attach");
      },
      route() {
        const it = useNotesStore.getState().section === "inbox" ? selectedItem() : null;
        if (it?.kind === "ticket") inboxOp(it, "route");
      },
      del() {
        const st = useNotesStore.getState();
        if (st.section === "inbox") {
          const it = selectedItem();
          if (it) inboxOp(it, "del");
          return;
        }
        if (st.selectedNoteId) deleteNote(st.selectedNoteId);
      },
      search() {
        if (useNotesStore.getState().section !== "notes") return;
        searchRef.current?.focus();
        searchRef.current?.select();
      },
      escape() {
        if (pop) {
          setPop(null);
          focusList();
          return true;
        }
        const st = useNotesStore.getState();
        if (st.section === "notes" && st.editing) {
          void flushRef.current?.();
          st.setEditing(false);
          return true;
        }
        return false;
      },
    },
    pop !== null,
  );

  const inboxPop = pop && (pop.kind === "someday" || pop.kind === "attach" || pop.kind === "route")
    ? { id: pop.id, kind: pop.kind }
    : null;
  const notePop = pop && (pop.kind === "where" || pop.kind === "date") ? { id: pop.id, kind: pop.kind } : null;

  return (
    <div ref={rootRef} className="page ns-notes" tabIndex={-1} onKeyDown={onKeyDown}>
      <NotesSide onSection={changeSection} onFilter={changeFilter} />
      {section === "inbox" ? (
        <NotesInbox
          items={items}
          selectedId={inboxSelected?.id ?? null}
          leavingId={leaving}
          pop={inboxPop}
          listRef={inboxListRef}
          onSelect={(it) => {
            useNotesStore.getState().selectInbox(refOf(it));
          }}
          onOp={inboxOp}
          onClosePop={() => {
            setPop(null);
            focusList("inbox");
          }}
          onPickDay={(it, d) => leave(it, () => useNotesStore.getState().scheduleTicket(it.id, d))}
          onPickNode={(it, nodeId) => leave(it, () => useNotesStore.getState().attachTicket(it.id, nodeId))}
          onPickRoute={(it, routeId) => leave(it, () => useNotesStore.getState().tagTicket(it.id, routeId))}
        />
      ) : (
        <>
          <NotesList listRef={notesListRef} searchRef={searchRef} onSelect={selectNote} onNew={newNote} />
          <NoteContent
            flushRef={flushRef}
            pop={notePop}
            setPop={setPop}
            readRef={readRef}
            onDelete={deleteNote}
            onTodo={noteTodo}
            onBackToList={() => focusList("notes")}
          />
        </>
      )}
    </div>
  );
}
