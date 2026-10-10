/**
 * MobileNotePage——手機的筆記整頁（車次①契約 §5.3；D-筆-1／6／24；原型 app.js mobNotePage＋noteEditor 的 mob 分支）。
 *
 * 由上而下：左上「‹ 筆記」返回 → metaline（掛在哪・日期，各開一個底部面板）→ 標題（選填）
 *   → 內文讀寫兩態 → 底部「變待辦」「刪除」＋字數。
 *
 * 讀寫兩態（D-筆-24）：閱讀態＝plainParagraphs 排的段落（Markdown 在車次④）；點一下進打字框；
 *   打字框失焦（點外面）或按返回＝回閱讀並存檔。
 * 存檔：本地 state 即時反映打字，去抖 500ms 呼叫 store.saveNote；失焦／返回／卸載（切 tab）立即送。
 *   所有存檔排成一條 promise 鏈依序送——新筆記第一次存檔是 create，第二次必須等它回來（拿到 id）才是 update，
 *   否則連打會建出兩則。是不是草稿在鏈上**輪到時**才讀 store（不是排進去時）。
 * 新筆記（draftNew）：不打字就離開＝丟棄、不落庫、不吐 toast（原型施工決定 14）；掛在哪／日期在第一次存檔前不可改。
 *
 * 顯示用的那一則：store.notes 裡找；找不到時沿用上一次看到的（例：路線篩選開著、把它換掛到別條路線後，
 *   重載的列表裡就沒有它了——頁面不該因此自己關掉）。真正要關頁的兩種情況由本頁自己判：
 *   刪除（按鈕）與變待辦確定（預覽關掉時那則已不在）。
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { useNodeStore } from "../../../store/nodeStore";
import { useUiStore } from "../../../store/uiStore";
import { useNotesStore } from "../../../store/notesStore";
import { dayKeyOf, todayKey, addDays } from "../../../lib/date";
import { fmtMonthDay, plainParagraphs } from "../../../domain/notes";
import type { NoteListItem, NotePatch } from "../../../data/noteRepository";
import { MobileAttachPicker, RouteRoundel } from "./MobileAttachPicker";
import { MobileDatePick, shiftIsoToDay } from "./MobileDatePick";

const WEEK = ["日", "一", "二", "三", "四", "五", "六"];
function weekday(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  return WEEK[new Date(y, m - 1, d).getDay()];
}

/** 字數：去掉空白後的字元數（原型 charCount） */
function charCount(s: string): number {
  return s.replace(/\s/g, "").length;
}

export function MobileNotePage({ onBack }: { onBack(): void }) {
  const selectedNoteId = useNotesStore((s) => s.selectedNoteId);
  const draftNew = useNotesStore((s) => s.draftNew);
  const editing = useNotesStore((s) => s.editing);
  const hasPreview = useNotesStore((s) => s.preview !== null);
  const found = useNotesStore((s) => (s.selectedNoteId ? (s.notes.find((n) => n.id === s.selectedNoteId) ?? null) : null));
  const setEditing = useNotesStore((s) => s.setEditing);
  const selectNote = useNotesStore((s) => s.selectNote);
  const setNoteDate = useNotesStore((s) => s.setNoteDate);
  const setNoteAttach = useNotesStore((s) => s.setNoteAttach);
  const deleteNote = useNotesStore((s) => s.deleteNote);
  const openPreviewFromNotePage = useNotesStore((s) => s.openPreviewFromNotePage);
  const routes = useNodeStore((s) => s.routes);
  const dayStartHour = useUiStore((s) => s.dayStartHour);

  /* 顯示用的那一則（見檔頭）＋換掛後的就地覆寫 */
  const lastNote = useRef<NoteListItem | null>(found);
  if (found) lastNote.current = found;
  const note = found ?? (selectedNoteId && lastNote.current?.id === selectedNoteId ? lastNote.current : null);

  const [title, setTitle] = useState(note?.title ?? "");
  const [body, setBody] = useState(note?.body ?? "");
  const [pop, setPop] = useState<"attach" | "date" | null>(null);
  const latest = useRef({ title, body });
  latest.current = { title, body };
  const saved = useRef({ title: note?.title ?? "", body: note?.body ?? "" });
  const inited = useRef(!!note || draftNew);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const timer = useRef<number | undefined>(undefined);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const leaving = useRef(false);
  /** 變待辦預覽是從本頁開的（記那則的 id）：預覽關掉時若這則已不在＝已變成車票，關頁 */
  const fromPreview = useRef<string | null>(null);

  // 打開時 store 還沒載到這一則（少見）：載到的第一刻補初值
  useEffect(() => {
    if (inited.current || !note) return;
    inited.current = true;
    setTitle(note.title ?? "");
    setBody(note.body);
    saved.current = { title: note.title ?? "", body: note.body };
  }, [note]);

  /** 排一次存檔到鏈尾；回傳鏈尾（await 它＝之前排的全部送完） */
  const enqueueSave = (): Promise<void> => {
    window.clearTimeout(timer.current);
    chain.current = chain.current
      .then(async () => {
        const cur = latest.current;
        const st = useNotesStore.getState();
        if (st.draftNew) {
          if (!cur.title.trim() && !cur.body.trim()) return; // 空筆記不建
          saved.current = { ...cur };
          await st.saveNote({ title: cur.title, body: cur.body });
          return;
        }
        if (!st.selectedNoteId) return;
        const patch: NotePatch = {};
        if (cur.title !== saved.current.title) patch.title = cur.title;
        if (cur.body !== saved.current.body) patch.body = cur.body;
        if (patch.title === undefined && patch.body === undefined) return;
        saved.current = { ...cur };
        await st.saveNote(patch);
      })
      .catch((e) => console.warn("MobileNotePage 存檔失敗", e));
    return chain.current;
  };
  const scheduleSave = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void enqueueSave(), 500);
  };

  // 卸載（切到別的 tab）＝立即送出還在去抖的那一筆
  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
      if (!leaving.current) void enqueueSave();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // 變待辦確定後這則已被 soft delete：store.confirmPreview 收預覽時把 selectedNoteId 清成 null（契約 §3.6 實作），
  // 取消則原樣留著 ⇒ 預覽關掉時選取已不是那則、或列表裡已沒它 ＝ 回列表
  useEffect(() => {
    const id = fromPreview.current;
    if (hasPreview || !id) return;
    fromPreview.current = null;
    const st = useNotesStore.getState();
    if (st.selectedNoteId !== id || !st.notes.some((n) => n.id === id)) {
      leaving.current = true;
      setEditing(false);
      selectNote(null);
      onBack();
    }
  }, [hasPreview, selectNote, setEditing, onBack]);

  // 打字框自動長高；進編輯時游標放末尾
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = ta.scrollHeight + "px";
  }, [body, editing]);
  useEffect(() => {
    const ta = taRef.current;
    if (!editing || !ta) return;
    ta.focus();
    const end = ta.value.length;
    ta.setSelectionRange(end, end);
  }, [editing]);

  const back = async () => {
    leaving.current = true;
    await enqueueSave();
    setEditing(false);
    selectNote(null); // 草稿還空著＝丟棄（store.selectNote 的規則）
    onBack();
  };

  const toTodo = async () => {
    await enqueueSave();
    const id = useNotesStore.getState().selectedNoteId;
    if (!id) return; // 空草稿：沒有東西可變
    setEditing(false);
    fromPreview.current = id;
    openPreviewFromNotePage(id);
  };

  const remove = async () => {
    leaving.current = true;
    window.clearTimeout(timer.current);
    await chain.current;
    const id = useNotesStore.getState().selectedNoteId;
    setEditing(false);
    selectNote(null);
    onBack();
    if (id) void deleteNote(id);
  };

  const imeBusy = (e: KeyboardEvent) => e.nativeEvent.isComposing || e.keyCode === 229 || composing.current;

  /* metaline */
  const today = todayKey(dayStartHour);
  const day = note ? dayKeyOf(note.noted_at, dayStartHour) : today;
  const route = note?.route_id ? (routes.find((r) => r.id === note.route_id) ?? null) : null;
  const nodeLabel = note && note.node_kind && note.node_kind !== "route" ? note.node_name : null;
  const paras = plainParagraphs(body);
  const canMeta = !!note;

  return (
    <div className="ns-notes-mpage">
      <div className="ns-notes-mback">
        <button type="button" className="b" onClick={() => void back()}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
            <path d="M10 3.5L5.5 8l4.5 4.5" />
          </svg>
          筆記
        </button>
      </div>

      <article className="ns-notes-msheetpage">
        <div className="ns-notes-mmetaline">
          <button
            type="button"
            className="ns-notes-mmetabtn"
            disabled={!canMeta}
            aria-label="掛在哪（換掛或摘掉）"
            onClick={() => setPop("attach")}
          >
            {note?.node_missing ? (
              <span className="faint">原節點已刪除</span>
            ) : route ? (
              <>
                <RouteRoundel route={route} className="ns-notes-mroundel xs" />
                <span>
                  {route.name}
                  {nodeLabel && <span className="faint"> › {nodeLabel}</span>}
                </span>
              </>
            ) : (
              <span>沒掛</span>
            )}
          </button>
          <span className="sep" aria-hidden>
            ・
          </span>
          <button
            type="button"
            className="ns-notes-mmetabtn"
            disabled={!canMeta}
            aria-label="改日期"
            onClick={() => setPop("date")}
          >
            {fmtMonthDay(day)}（{weekday(day)}）
          </button>
        </div>

        <input
          className="ns-notes-mtitlein"
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            scheduleSave();
          }}
          onBlur={() => void enqueueSave()}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || imeBusy(e)) return;
            e.preventDefault();
            setEditing(true);
          }}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          placeholder="標題（可不寫）"
          aria-label="標題"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="next"
        />

        <div className="ns-notes-mbodywrap">
          {editing ? (
            <textarea
              ref={taRef}
              className="ns-notes-mta"
              value={body}
              onChange={(e) => {
                setBody(e.target.value);
                scheduleSave();
              }}
              onBlur={() => {
                void enqueueSave();
                setEditing(false);
              }}
              onCompositionStart={() => {
                composing.current = true;
              }}
              onCompositionEnd={() => {
                composing.current = false;
              }}
              placeholder="寫點什麼…"
              aria-label="內文"
              spellCheck={false}
            />
          ) : (
            <div
              className="ns-notes-mread"
              role="button"
              tabIndex={0}
              aria-label="內文（點一下編輯）"
              onClick={() => setEditing(true)}
              onKeyDown={(e) => {
                if (e.key !== "Enter" || imeBusy(e)) return;
                e.preventDefault();
                setEditing(true);
              }}
            >
              {paras.length === 0 ? (
                <p className="ph">（空白，點一下開始寫）</p>
              ) : (
                paras.map((lines, i) => (
                  <p key={i}>
                    {lines.map((l, k) => (
                      <span key={k}>
                        {k > 0 && <br />}
                        {l}
                      </span>
                    ))}
                  </p>
                ))
              )}
            </div>
          )}
        </div>

        <div className="ns-notes-mactions">
          <button type="button" className="ns-notes-mbtn" onClick={() => void toTodo()} disabled={!body.trim() && !title.trim()}>
            變待辦
          </button>
          <button type="button" className="ns-notes-mbtn" onClick={() => void remove()}>
            刪除
          </button>
          <span className="ns-notes-mwordcount">{charCount(body).toLocaleString()} 字</span>
        </div>
      </article>

      {pop === "attach" && note && (
        <MobileAttachPicker
          title="掛在哪"
          depth="node"
          value={{
            routeId: note.route_id,
            nodeId: note.node_kind && note.node_kind !== "route" ? note.node_id : null,
            nodeKind: (note.node_kind as "route" | "branch" | "train" | "car" | null) ?? null,
          }}
          onPick={(t) => {
            setPop(null);
            void setNoteAttach(note.id, t.nodeId ?? t.routeId);
          }}
          onClear={
            note.node_id
              ? () => {
                  setPop(null);
                  void setNoteAttach(note.id, null);
                }
              : undefined
          }
          clearLabel="摘掉"
          onClose={() => setPop(null)}
        />
      )}
      {pop === "date" && note && (
        <MobileDatePick
          title="改日期"
          value={day}
          max={today}
          quick={[
            { label: "今天", day: today },
            { label: "昨天", day: addDays(today, -1) },
          ]}
          onPick={(d) => {
            setPop(null);
            if (d !== day) void setNoteDate(note.id, shiftIsoToDay(note.noted_at, day, d));
          }}
          onClose={() => setPop(null)}
        />
      )}
    </div>
  );
}
