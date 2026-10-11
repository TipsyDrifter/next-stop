/**
 * MobileDiaryEntry——手機日記的一篇（車次②契約 §5.3；D-筆-1／24；原型 app.js diaryEntry／diaryBodyHtml 的 mob 分支）。
 * 同檔另有 `MobileDiaryDraft`（「寫日記／補記／再寫一篇」的草稿）。
 *
 * 一篇由上而下：metaline（「寫於 09:12」／「寫於 10/2 23:40（補記）」＋荷札空位＋「改日期」「刪除」）
 *   → 標題（選填）→ 內文讀寫兩態 → 右下字數。
 * 讀寫兩態（D-筆-24）：平常是 plainParagraphs 排的段落；點一下進打字框（store.setDiaryEditing）；
 *   打字框失焦（點外面）＝回閱讀並立即存檔。手機沒有 Esc，返回鍵＝離開打字框＝失焦，同一條路。
 * 存檔（與 MobileNotePage 同法）：本地 state 即時反映打字，去抖 500ms 呼叫 store.saveDiaryEntry（只送變了的欄）；
 *   失焦／改日期／刪除前／卸載（翻日、切 tab）立即送。所有存檔排成一條 promise 鏈依序送。
 * 同步後別台改了這一篇：沒在打字、也沒有還沒送出的字，才跟上新內容（契約 §3.6 末段，與 NoteContent 同法）。
 *
 * 草稿不落庫：內容只在本元件；按「存檔」才 store.saveDiaryDraft（空的＝丟棄、不 toast）。
 *   「取消」有內容時先亮一行提示，再按一次才放棄（與捕捉面板同一句）。Enter 是換行（手機鍵盤沒有 Ctrl+Enter），存檔靠按鈕。
 *   草稿內容另存在模組層（draftMemo）：切到別的 tab 再回來（元件卸載重掛）時同一天的草稿原樣還在。
 *   鍵盤彈出時把草稿捲進視野：打字框聚焦、視覺視窗變矮（軟鍵盤升起）時各捲一次，存檔鈕跟著打字框露出來。
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MutableRefObject } from "react";
import { useUiStore } from "../../../store/uiStore";
import { useNotesStore } from "../../../store/notesStore";
import { addDays, dayKeyOf } from "../../../lib/date";
import {
  diaryDraftMeta,
  diaryPlaceholder,
  entryWrittenLabel,
  fmtShortDay,
  plainParagraphs,
} from "../../../domain/notes";
import type { NoteListItem } from "../../../data/noteRepository";
import { MobileDatePicker } from "../../common/MobileDatePicker";
import { charCount, hhmm } from "./mobileDiaryBits";

/** IME 護欄：組字中（含 Android 部分 IME 只送 229、不帶 isComposing）一律不攔鍵 */
function imeBusy(e: KeyboardEvent, composing: MutableRefObject<boolean>): boolean {
  return e.nativeEvent.isComposing || e.keyCode === 229 || composing.current;
}

/** 讀態段落 */
function Paragraphs({ body, placeholder }: { body: string; placeholder: string }) {
  const paras = plainParagraphs(body);
  if (paras.length === 0) return <p className="ph">{placeholder}</p>;
  return (
    <>
      {paras.map((lines, i) => (
        <p key={i}>
          {lines.map((l, k) => (
            <span key={k}>
              {k > 0 && <br />}
              {l}
            </span>
          ))}
        </p>
      ))}
    </>
  );
}

/** 打字框自動長高 */
function useAutoGrow(ref: MutableRefObject<HTMLTextAreaElement | null>, deps: unknown[]): void {
  useLayoutEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = ta.scrollHeight + "px";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/**
 * 軟鍵盤升起時把 el 捲進 `.m-page` 的視野（block: nearest＝已經看得到就不動）。
 * visualViewport 在鍵盤升起時變矮（useViewportHeight 也吃同一個事件）；聚焦當下鍵盤可能還沒升好，所以兩邊都捲。
 */
function useKeepInView(active: boolean, target: MutableRefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (!active) return;
    const vv = window.visualViewport;
    const reveal = () => window.setTimeout(() => target.current?.scrollIntoView({ block: "nearest" }), 60);
    reveal();
    vv?.addEventListener("resize", reveal);
    return () => vv?.removeEventListener("resize", reveal);
  }, [active, target]);
}

/* ═════════════════════ 既有的一篇 ═════════════════════ */

export interface MobileDiaryEntryProps {
  n: NoteListItem;
  today: string;
}

export function MobileDiaryEntry({ n, today }: MobileDiaryEntryProps) {
  const editing = useNotesStore((s) => s.diaryEditingId === n.id);
  const selected = useNotesStore((s) => s.diarySelectedId === n.id);
  const setDiaryEditing = useNotesStore((s) => s.setDiaryEditing);
  const selectDiaryEntry = useNotesStore((s) => s.selectDiaryEntry);
  const saveDiaryEntry = useNotesStore((s) => s.saveDiaryEntry);
  const setDiaryEntryDate = useNotesStore((s) => s.setDiaryEntryDate);
  const deleteDiaryEntry = useNotesStore((s) => s.deleteDiaryEntry);
  const dayStartHour = useUiStore((s) => s.dayStartHour);

  const [title, setTitle] = useState(n.title ?? "");
  const [body, setBody] = useState(n.body);
  const [pickDate, setPickDate] = useState(false);
  const latest = useRef({ title, body });
  latest.current = { title, body };
  const saved = useRef({ title: n.title ?? "", body: n.body });
  const chain = useRef<Promise<void>>(Promise.resolve());
  const timer = useRef<number | undefined>(undefined);
  const pending = useRef(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const composing = useRef(false);
  const titleFocused = useRef(false);

  /** 排一次存檔到鏈尾；回傳鏈尾（await 它＝之前排的全部送完） */
  const enqueueSave = (): Promise<void> => {
    window.clearTimeout(timer.current);
    pending.current = false;
    chain.current = chain.current
      .then(async () => {
        const cur = latest.current;
        const patch: { title?: string; body?: string } = {};
        if (cur.title !== saved.current.title) patch.title = cur.title;
        if (cur.body !== saved.current.body) patch.body = cur.body;
        if (patch.title === undefined && patch.body === undefined) return;
        saved.current = { ...cur };
        await saveDiaryEntry(n.id, patch);
      })
      .catch((e) => console.warn("MobileDiaryEntry 存檔失敗", e));
    return chain.current;
  };
  const scheduleSave = () => {
    window.clearTimeout(timer.current);
    pending.current = true;
    timer.current = window.setTimeout(() => void enqueueSave(), 500);
  };

  // 卸載（翻日、切 tab）＝立即送出還在去抖的那一筆
  useEffect(
    () => () => {
      if (pending.current) void enqueueSave();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // 同步／別處改了這篇：沒在打字、沒有未送出的字 ⇒ 跟上
  useEffect(() => {
    const incoming = { title: n.title ?? "", body: n.body };
    if (incoming.title === saved.current.title && incoming.body === saved.current.body) return;
    if (editing || titleFocused.current || pending.current) return;
    if (latest.current.title !== saved.current.title || latest.current.body !== saved.current.body) return;
    saved.current = incoming;
    setTitle(incoming.title);
    setBody(incoming.body);
  }, [n.title, n.body, editing]);

  useAutoGrow(taRef, [body, editing]);
  useEffect(() => {
    const ta = taRef.current;
    if (!editing || !ta) return;
    ta.focus();
    const end = ta.value.length;
    ta.setSelectionRange(end, end);
  }, [editing]);
  useKeepInView(editing, taRef as MutableRefObject<HTMLElement | null>);

  const notedDay = dayKeyOf(n.noted_at, dayStartHour);
  const entryDate = n.entry_date ?? notedDay;
  const meta = entryWrittenLabel(entryDate, notedDay, hhmm(n.noted_at), fmtShortDay(notedDay));

  const changeDate = async (d: string) => {
    setPickDate(false);
    if (d === entryDate) return;
    await enqueueSave();
    void setDiaryEntryDate(n.id, d);
  };
  const remove = async () => {
    await enqueueSave();
    void deleteDiaryEntry(n.id);
  };

  return (
    <div className={"ns-notes-mentry" + (selected ? " is-sel" : "")} data-entry-id={n.id}>
      <div className="ns-notes-mentrymeta">
        <span className="w">{meta}</span>
        <span className="ns-notes-mtagslot" />
        <span className="sp" />
        <button type="button" className="ns-notes-mmetabtn" aria-label="改日期（改這篇歸屬的日子）" onClick={() => setPickDate(true)}>
          改日期
        </button>
        <button type="button" className="ns-notes-mmetabtn quiet" onClick={() => void remove()}>
          刪除
        </button>
      </div>

      <input
        className="ns-notes-mtitlein"
        value={title}
        onChange={(e) => {
          setTitle(e.target.value);
          scheduleSave();
        }}
        onFocus={() => {
          titleFocused.current = true;
          selectDiaryEntry(n.id);
        }}
        onBlur={() => {
          titleFocused.current = false;
          void enqueueSave();
        }}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || imeBusy(e, composing)) return;
          e.preventDefault();
          setDiaryEditing(n.id);
        }}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        placeholder="標題（可不寫）"
        aria-label="日記標題"
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
              // 失焦時若 store 已換成別篇（點了另一篇的內文）就不清——那一篇的 setDiaryEditing 已經接手
              if (useNotesStore.getState().diaryEditingId === n.id) setDiaryEditing(null);
            }}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            placeholder="寫點什麼…"
            aria-label="日記內文"
            spellCheck={false}
          />
        ) : (
          <div
            className="ns-notes-mread"
            role="button"
            tabIndex={0}
            aria-label="日記內文（點一下編輯）"
            onClick={() => {
              selectDiaryEntry(n.id);
              setDiaryEditing(n.id);
            }}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || imeBusy(e, composing)) return;
              e.preventDefault();
              selectDiaryEntry(n.id);
              setDiaryEditing(n.id);
            }}
          >
            <Paragraphs body={body} placeholder="（空白，點一下開始寫）" />
          </div>
        )}
      </div>
      <p className="ns-notes-mentrywc">{charCount(body).toLocaleString()} 字</p>

      {pickDate && (
        <MobileDatePicker
          title="改到哪一天"
          value={entryDate}
          max={today}
          quick={[
            { label: "今天", day: today },
            { label: "昨天", day: addDays(today, -1) },
          ]}
          onPick={(d) => void changeDate(d)}
          onClose={() => setPickDate(false)}
        />
      )}
    </div>
  );
}

/* ═════════════════════ 草稿 ═════════════════════ */

/** 切 tab（卸載）再回來時還原同一天的草稿；存檔成功或放棄就清掉 */
let draftMemo: { day: string; title: string; body: string } | null = null;

export interface DraftHandle {
  /** 草稿目前的內容（MobileDiary 翻日前用：有字就先存再翻） */
  title: string;
  body: string;
}

export interface MobileDiaryDraftProps {
  day: string;
  today: string;
  /** 由 MobileDiary 持有：每次打字更新，翻日／跳搜尋結果前讀它 */
  handle: MutableRefObject<DraftHandle>;
}

export function MobileDiaryDraft({ day, today, handle }: MobileDiaryDraftProps) {
  const saveDiaryDraft = useNotesStore((s) => s.saveDiaryDraft);
  const cancelDiaryDraft = useNotesStore((s) => s.cancelDiaryDraft);
  const restored = draftMemo && draftMemo.day === day ? draftMemo : null;
  const [title, setTitle] = useState(restored?.title ?? "");
  const [body, setBody] = useState(restored?.body ?? "");
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [saving, setSaving] = useState(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const composing = useRef(false);
  const [focused, setFocused] = useState(false);
  const isToday = day === today;

  handle.current = { title, body };
  const hasText = !!(title.trim() || body.trim());

  // 卸載時記住（有字才記）；存檔／放棄會先把 draftMemo 清掉再關
  const memoRef = useRef({ day, title, body });
  memoRef.current = { day, title, body };
  useEffect(
    () => () => {
      const m = memoRef.current;
      if (useNotesStore.getState().diaryDraftOpen && (m.title.trim() || m.body.trim())) draftMemo = { ...m };
    },
    [],
  );

  useAutoGrow(taRef, [body]);
  useEffect(() => {
    taRef.current?.focus();
  }, []);
  useKeepInView(focused, wrapRef);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const id = await saveDiaryDraft({ title, body });
      // 成功（回 id）或空草稿（回 null 且 store 已關草稿）都清掉記憶；失敗時草稿還開著，內容留著
      if (id || !useNotesStore.getState().diaryDraftOpen) draftMemo = null;
    } finally {
      setSaving(false);
    }
  };

  const cancel = () => {
    if (hasText && !confirmCancel) {
      setConfirmCancel(true);
      return;
    }
    draftMemo = null;
    cancelDiaryDraft();
  };

  const onType = () => {
    if (confirmCancel) setConfirmCancel(false);
  };

  return (
    <div className="ns-notes-mentry is-draft" ref={wrapRef}>
      <div className="ns-notes-mentrymeta">
        <span className="w">{diaryDraftMeta(isToday, day)}</span>
      </div>
      <input
        className="ns-notes-mtitlein"
        value={title}
        onChange={(e) => {
          setTitle(e.target.value);
          onType();
        }}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || imeBusy(e, composing)) return;
          e.preventDefault();
          taRef.current?.focus();
        }}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        placeholder="標題（可不寫）"
        aria-label="日記標題"
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="next"
      />
      <div className="ns-notes-mbodywrap">
        <textarea
          ref={taRef}
          className="ns-notes-mta is-draft"
          value={body}
          onChange={(e) => {
            setBody(e.target.value);
            onType();
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          placeholder={diaryPlaceholder(isToday)}
          aria-label="日記內文"
          spellCheck={false}
        />
      </div>
      {confirmCancel && <p className="ns-notes-mwarn">還有內容沒存——再按一次取消就放棄</p>}
      <div className="ns-notes-mdraftbar">
        <button
          type="button"
          className="ns-notes-mbtn primary"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => void save()}
          disabled={saving}
        >
          存檔
        </button>
        <button type="button" className="ns-notes-mbtn" onMouseDown={(e) => e.preventDefault()} onClick={cancel}>
          取消
        </button>
      </div>
    </div>
  );
}
