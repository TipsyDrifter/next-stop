/**
 * NoteContent——筆記內容欄（桌機；車次①契約 §5.1；D-筆-1／6／24）。
 *
 *   metaline：「掛在哪」（●路線名 › 節點名／沒掛／原節點已刪除；點開 AttachPicker depth="node"，含「摘掉」）
 *             ・日期「10 月 5 日」（點開 DatePop 改 noted_at，保留原時刻）
 *   標題（選填）＋內文讀寫兩態（D-筆-24）：
 *     閱讀＝plainParagraphs 排成段落與換行（Markdown 在車次④）；點一下或 Enter（頁面按鍵表 notes.open）進編輯
 *           車次③：內文的 #荷札 畫成行內小牌（點＝荷札頁，「‹ 回到剛才 <標題>」回這則）
 *           車次④：閱讀態換成 Markdown 排版（MdBody；InlineBody 刪檔），連結外開、點它不進編輯
 *     編輯＝textarea 自動長高；Esc／blur 回閱讀並立即存檔；Tab 不攔
 *           車次③：游標處打 # 出荷札建議（useInlineTagSuggest；建議開著時 Esc 只收建議）；
 *           離開編輯、存檔鏈 flush 之後 `tagStore.syncNoteTags`（契約 0-13：不是每次去抖存檔都解析）
 *   底部：變待辦・記成日記（車次②）・刪除・字數
 *
 * 存檔：標題與內文各自去抖 500ms 累積成一個 NotePatch，blur／Esc／換選取前立即送出（flush）。
 * `saveNote(patch)` 寫的是 store 當下的 selectedNoteId，所以**換選取之前一定要先 flush**——
 * flush 函式透過 `flushRef` 交給 NotesView，所有會換選取的入口（點列表、↑↓、新筆記、換子畫面、篩選）都先 await 它。
 * 新筆記（draftNew）的第一次非空存檔由 store 建檔並接手選取；那一下 key 從草稿換成新 id，本地欄位不重設（字不會被吃掉）。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from "react";
import type { NotePatch } from "../../data/noteRepository";
import { useNotesStore } from "../../store/notesStore";
import { useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";
import { todayKey } from "../../lib/date";
import { fmtMonthDay, noteTitle } from "../../domain/notes";
import { useTagStore } from "../../store/tagStore";
import { AttachPicker } from "./AttachPicker";
import { CaptureButton } from "./CaptureButton";
import { DatePop } from "./DatePop";
import { Roundel, capsOf, dayOf, isoWithDay } from "./notesBits";
import { MdBody } from "./md/MdBody";
import { resolveLeaveNote } from "./leaveSync";
import { useInlineTagSuggest } from "./tags/useInlineTagSuggest";
import { noteBackRef } from "./tags/backRefs";

export type NotePopKind = "where" | "date";

export interface NoteContentProps {
  flushRef: MutableRefObject<(() => Promise<void>) | null>;
  pop: { id: string; kind: NotePopKind } | null;
  setPop(p: { id: string; kind: NotePopKind } | null): void;
  readRef: MutableRefObject<HTMLDivElement | null>;
  /** 刪除（NotesView 先把選取移到下一則再刪） */
  onDelete(id: string): void;
  /** 變待辦（NotesView 先 flush 再開預覽） */
  onTodo(id: string): void;
  /** 記成日記（車次②；NotesView 先 flush、把選取交給下一則再轉） */
  onToDiary(id: string): void;
  /** 回到清單焦點（標題欄 Esc） */
  onBackToList(): void;
}

const DRAFT = "$draft";

export function NoteContent({
  flushRef,
  pop,
  setPop,
  readRef,
  onDelete,
  onTodo,
  onToDiary,
  onBackToList,
}: NoteContentProps) {
  const selectedId = useNotesStore((s) => s.selectedNoteId);
  const draftNew = useNotesStore((s) => s.draftNew);
  const editing = useNotesStore((s) => s.editing);
  const note = useNotesStore((s) => (s.selectedNoteId ? (s.notes.find((n) => n.id === s.selectedNoteId) ?? null) : null));
  const routes = useNodeStore((s) => s.routes);
  const dayStartHour = useUiStore((s) => s.dayStartHour);

  const key = selectedId ?? (draftNew ? DRAFT : null);

  /* ── 本地欄位（打字當下的真相；store 只在存檔後追上） ── */
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  /** 本地欄位目前是哪一則的內容（key）；null＝還沒從資料初始化 */
  const [initFor, setInitFor] = useState<string | null>(null);
  if (key !== initFor) {
    if (key === DRAFT) {
      setInitFor(DRAFT);
      setTitle("");
      setBody("");
    } else if (key && initFor === DRAFT) {
      setInitFor(key); // 草稿剛落庫：沿用正在打的字
    } else if (key && note) {
      setInitFor(key);
      setTitle(note.title ?? "");
      setBody(note.body);
    } else if (!key && initFor !== null) {
      setInitFor(null);
    }
  }

  /* ── 存檔佇列 ── */
  const pending = useRef<NotePatch>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chain = useRef<Promise<void>>(Promise.resolve());
  /** 這一則有字沒存成功（saveNote 回 false）：離開編輯時以本地為準，別讓 store 的舊值把本地的字換掉。換一則才清 */
  const saveFailed = useRef(false);
  const flush = useCallback((): Promise<void> => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const patch = pending.current;
    if (!Object.keys(patch).length) return chain.current;
    pending.current = {};
    chain.current = chain.current
      .then(async () => {
        if (!(await useNotesStore.getState().saveNote(patch))) saveFailed.current = true;
      })
      .catch((e: unknown) => console.warn("NoteContent：存檔失敗", e));
    return chain.current;
  }, []);
  const queue = (patch: NotePatch) => {
    Object.assign(pending.current, patch);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), 500);
  };
  useEffect(() => {
    flushRef.current = flush;
    return () => {
      void flush(); // 離開本頁（換頁）：選取沒變，直接送出
      flushRef.current = null;
    };
  }, [flush, flushRef]);

  useEffect(() => {
    saveFailed.current = false;
  }, [key]);

  // 別台同步／別處改了這一則（沒有在打字、也沒有沒送出的字）⇒ 跟上 store
  const noteStamp = note?.updated_at;
  useEffect(() => {
    if (!note || initFor !== note.id || editing || Object.keys(pending.current).length) return;
    if (document.activeElement instanceof HTMLInputElement && document.activeElement.classList.contains("ns-notes-titlein")) return;
    setTitle(note.title ?? "");
    setBody(note.body);
  }, [noteStamp]); // 只看 updated_at：其餘依賴（editing、initFor）變了不該觸發「跟上」

  /* ── 編輯態 ── */
  const taRef = useRef<HTMLTextAreaElement>(null);
  const focusReadNext = useRef(false);
  const autosize = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  };
  useLayoutEffect(() => {
    if (!editing) return;
    const ta = taRef.current;
    if (!ta) return;
    autosize();
    ta.focus({ preventScroll: true });
    const n = ta.value.length;
    ta.setSelectionRange(n, n);
  }, [editing, key]);
  useLayoutEffect(autosize, [body]);
  useEffect(() => {
    if (!editing && focusReadNext.current) {
      focusReadNext.current = false;
      readRef.current?.focus({ preventScroll: true });
    }
  }, [editing, readRef]);

  const tagSug = useInlineTagSuggest(taRef, (next) => {
    setBody(next);
    queue({ body: next });
  });

  const leaveEditing = (focusRead: boolean) => {
    tagSug.close();
    const local = { title, body };
    const known = useNotesStore.getState().selectedNoteId;
    // 存檔鏈落地之後才解析（草稿的第一次存檔由 store 建檔，id 要等它回來才有）
    void flush().then(() => {
      const nid = known ?? useNotesStore.getState().selectedNoteId;
      if (!nid) return;
      // 編輯期間別台後寫贏了（store 的字和本地不同、本地又沒有沒送出的字）⇒ 本地換成 store 的、荷札依 store 的內文（leaveSync）
      const r = resolveLeaveNote(nid, local, Object.keys(pending.current).length > 0 || saveFailed.current);
      if (r.remote && useNotesStore.getState().selectedNoteId === nid) {
        setBody(r.body);
        if (!(document.activeElement instanceof HTMLInputElement && document.activeElement.classList.contains("ns-notes-titlein"))) {
          setTitle(r.title);
        }
      }
      void useTagStore.getState().syncNoteTags(nid, r.body);
    });
    focusReadNext.current = focusRead;
    useNotesStore.getState().setEditing(false);
  };

  if (!key) {
    return (
      <section className="ns-notes-contentcol ns-notes-col techo-scroll" aria-label="筆記內容">
        <div className="ns-notes-sheetwrap">
          <article className="ns-notes-page">
            <div className="ns-notes-placeholder">
              <p>選一則筆記，或記一句</p>
              <CaptureButton variant="page" stub="note" />
            </div>
          </article>
        </div>
      </section>
    );
  }

  const id = note?.id ?? null; // 草稿＝null（還沒落庫：掛在哪／日期／變待辦都要等第一次存檔）
  const today = todayKey(dayStartHour);
  const day = note ? dayOf(note.noted_at, dayStartHour) : today;
  const myPop = pop && id && pop.id === id ? pop.kind : null;
  const route = note?.route_id ? (routes.find((r) => r.id === note.route_id) ?? null) : null;

  let where;
  if (!note || !note.node_id) where = <span className="faint">沒掛</span>;
  else if (note.node_missing) where = <span className="faint">原本掛的地方已刪除</span>;
  else
    where = (
      <>
        <Roundel route={route} />
        <span>
          {route?.name ?? note.node_name ?? ""}
          {note.node_kind && note.node_kind !== "route" && note.node_name ? (
            <>
              <span style={{ opacity: 0.6 }}> › </span>
              {note.node_name}
            </>
          ) : null}
        </span>
      </>
    );

  /** 小浮層收起（挑完或 Esc）：焦點回清單，鍵盤表接得上 */
  const closePop = () => {
    setPop(null);
    onBackToList();
  };

  const words = body.replace(/\s/g, "").length;

  return (
    <section className="ns-notes-contentcol ns-notes-col techo-scroll" aria-label="筆記內容">
      <div className="ns-notes-sheetwrap">
        <article className="ns-notes-page">
          <div className="ns-notes-measure">
            <div className="ns-notes-metaline">
              <button
                type="button"
                className="ns-notes-metabtn"
                data-pop-toggle=""
                aria-expanded={myPop === "where"}
                disabled={!id}
                title="換掛或摘掉"
                onClick={() => id && setPop(myPop === "where" ? null : { id, kind: "where" })}
              >
                {where}
              </button>
              <span className="sep">・</span>
              <button
                type="button"
                className="ns-notes-metabtn"
                data-pop-toggle=""
                aria-expanded={myPop === "date"}
                disabled={!id}
                title="改日期"
                onClick={() => id && setPop(myPop === "date" ? null : { id, kind: "date" })}
              >
                {fmtMonthDay(day)}
              </button>
              {myPop === "where" && note && (
                <AttachPicker
                  float
                  depth="node"
                  label="掛到哪"
                  value={{
                    routeId: note.route_id,
                    nodeId: note.node_kind === "route" ? null : note.node_id,
                    nodeKind: note.node_kind === "route" ? "route" : (note.node_kind as "branch" | "train" | "car" | null),
                  }}
                  onPick={(t) => {
                    closePop();
                    void useNotesStore.getState().setNoteAttach(note.id, t.nodeId ?? t.routeId);
                  }}
                  onClear={() => {
                    closePop();
                    void useNotesStore.getState().setNoteAttach(note.id, null);
                  }}
                  clearLabel="摘掉"
                  onClose={closePop}
                />
              )}
              {myPop === "date" && note && (
                <div style={{ position: "absolute", left: 110, top: 0 }}>
                  <DatePop
                    float
                    label="改日期"
                    value={day}
                    max={today}
                    onPick={(d) => {
                      closePop();
                      void useNotesStore.getState().setNoteDate(note.id, isoWithDay(note.noted_at, d));
                    }}
                    onClose={closePop}
                  />
                </div>
              )}
            </div>

            <input
              className="ns-notes-titlein"
              value={title}
              placeholder="標題（可不寫）"
              aria-label="標題"
              autoComplete="off"
              onChange={(e) => {
                setTitle(e.target.value);
                queue({ title: e.target.value });
              }}
              onBlur={() => void flush()}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (e.key === "Enter") {
                  e.preventDefault();
                  void flush();
                  useNotesStore.getState().setEditing(true);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  void flush();
                  onBackToList();
                }
              }}
            />

            <div className="ns-notes-bodywrap">
              {tagSug.popup}
              {editing ? (
                <textarea
                  ref={taRef}
                  className="ns-notes-ta"
                  value={body}
                  placeholder="寫點什麼…"
                  aria-label="內文"
                  onChange={(e) => {
                    setBody(e.target.value);
                    queue({ body: e.target.value });
                  }}
                  {...tagSug.bind}
                  onBlur={() => leaveEditing(false)}
                  onKeyDown={(e) => {
                    if (tagSug.onKeyDown(e)) return;
                    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                    if (e.key === "Escape") {
                      e.preventDefault();
                      e.stopPropagation();
                      leaveEditing(true);
                    }
                  }}
                />
              ) : (
                <>
                  <div
                    ref={readRef}
                    className="ns-notes-read ns-notes-md"
                    tabIndex={0}
                    role="textbox"
                    aria-readonly="true"
                    aria-label={`內文（按 ${capsOf("notes.open")} 編輯）`}
                    onClick={() => useNotesStore.getState().setEditing(true)}
                  >
                    <MdBody body={body} backRef={() => noteBackRef(id ?? "", note ? noteTitle({ title, body }) : "筆記")} />
                  </div>
                  <div className="ns-notes-readhint">
                    點一下或按 {capsOf("notes.open")}編輯・{capsOf("notes.escape")}或點外面結束</div>
                </>
              )}
            </div>

            <div className="ns-notes-actions">
              <button type="button" className="ns-notes-btn ns-btn ns-btn--sm btn-ghost" disabled={!id} onClick={() => id && onTodo(id)}>
                變待辦
              </button>
              <button
                type="button"
                className="ns-notes-btn ns-btn ns-btn--sm btn-ghost"
                disabled={!id}
                title="搬進當天的日記"
                onClick={() => id && onToDiary(id)}
              >
                記成日記
              </button>
              <button
                type="button"
                className="ns-notes-btn ns-btn ns-btn--sm btn-ghost ns-btn-danger"
                onClick={() => (id ? onDelete(id) : useNotesStore.getState().selectNote(null))}
              >
                刪除
              </button>
              <span className="spacer" />
              <span className="ns-notes-wordcount">{words.toLocaleString()} 字</span>
            </div>
          </div>
        </article>
      </div>
    </section>
  );
}
