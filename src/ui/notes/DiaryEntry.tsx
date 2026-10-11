/**
 * DiaryEntry——日記的一篇與草稿（桌機；車次②契約 §5.1；D-筆-1／10／24；原型 app.js diaryEntry／diaryBodyHtml）。
 *
 * 一篇（DiaryEntry）：
 *   篇頭「寫於 09:12」／「寫於 10/2 23:40（補記）」（0-5：補記＝寫下那天的日界線日 ≠ 歸屬日）
 *        ＋荷札掛牌位置（空；③ 填）＋「改日期」（共用 DatePicker，max＝今天；只改 entry_date）
 *   標題（選填）＋內文讀寫兩態：閱讀＝plainParagraphs；點一下或（選中後）Enter 進打字框；Esc／blur 回閱讀並立即存檔
 *   底部：字數・刪除
 * 存檔：標題與內文各自去抖 500ms 累積成一個 patch，blur／Esc 立即送出；每篇一條自己的存檔鏈，
 *   flush 函式經 `register` 交給 NotesDiary，換日／換子畫面／搜尋跳轉前先 await（與 NoteContent 同法）。
 * 別台同步改了這一篇：沒在打字、也沒有沒送出的字才跟上 store（契約 §3.6 末條）。
 *
 * 草稿（DiaryDraft）：「寫日記／補記／再寫一篇」。內容放在 NotesDiary（不落庫；換日前非空就自動存、空的丟棄）；
 *   存檔鍵（registry 的 notes.diary.save）或「存檔」鈕才 create；Esc 有字先問一次（同捕捉框那句）。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { NoteListItem } from "../../data/noteRepository";
import { useNotesStore } from "../../store/notesStore";
import { entryWrittenLabel, plainParagraphs } from "../../domain/notes";
import { DatePicker } from "../common/DatePicker";
import { addDays } from "../../lib/date";
import { matches } from "../shell/hotkeys";
import { Kbd, capsOf, dayOf, fmtShort, fmtTime } from "./notesBits";

type Patch = { title?: string; body?: string };

/** 閱讀態的段落（與 NoteContent 同一種排法） */
function Paragraphs({ body }: { body: string }) {
  const paras = plainParagraphs(body);
  if (!paras.length) return <p className="ph">（空白，點一下開始寫）</p>;
  return (
    <>
      {paras.map((lines, i) => (
        <p key={i}>
          {lines.map((l, j) => (
            <span key={j}>
              {j > 0 && <br />}
              {l}
            </span>
          ))}
        </p>
      ))}
    </>
  );
}

const countChars = (s: string) => s.replace(/\s/g, "").length;

function autosize(ta: HTMLTextAreaElement | null) {
  if (!ta) return;
  ta.style.height = "auto";
  ta.style.height = `${ta.scrollHeight}px`;
}

/* ═══════════ 一篇 ═══════════ */

export interface DiaryEntryProps {
  item: NoteListItem;
  selected: boolean;
  editing: boolean;
  today: string;
  dayStartHour: number;
  /** 「改日期」小浮層開著（只會開在一篇上） */
  datePopOpen: boolean;
  onToggleDatePop(): void;
  onCloseDatePop(): void;
  onPickDate(day: string): void;
  onDelete(): void;
  /** 交出這一篇的 flush；回傳取消登記 */
  register(id: string, flush: () => Promise<void>): () => void;
}

export function DiaryEntry({
  item,
  selected,
  editing,
  today,
  dayStartHour,
  datePopOpen,
  onToggleDatePop,
  onCloseDatePop,
  onPickDate,
  onDelete,
  register,
}: DiaryEntryProps) {
  const id = item.id;
  const [title, setTitle] = useState(item.title ?? "");
  const [body, setBody] = useState(item.body);

  /* ── 存檔佇列 ── */
  const pending = useRef<Patch>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const flush = useCallback((): Promise<void> => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const patch = pending.current;
    if (!Object.keys(patch).length) return chain.current;
    pending.current = {};
    chain.current = chain.current
      .then(() => useNotesStore.getState().saveDiaryEntry(id, patch))
      .catch((e: unknown) => console.warn("DiaryEntry：存檔失敗", e));
    return chain.current;
  }, [id]);
  const queue = (patch: Patch) => {
    Object.assign(pending.current, patch);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), 500);
  };
  useEffect(() => {
    const off = register(id, flush);
    return () => {
      void flush(); // 這一篇離開畫面（換日、被刪、改到別天）：沒送出的字照樣送
      off();
    };
  }, [id, flush, register]);

  // 別台同步／別處改了這一篇（沒有在打字、也沒有沒送出的字）⇒ 跟上 store
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing || Object.keys(pending.current).length) return;
    if (document.activeElement === titleRef.current) return;
    setTitle(item.title ?? "");
    setBody(item.body);
  }, [item.updated_at]); // 只看 updated_at：editing 變了不該觸發「跟上」

  /* ── 讀寫兩態 ── */
  const taRef = useRef<HTMLTextAreaElement>(null);
  const readRef = useRef<HTMLDivElement>(null);
  const focusReadNext = useRef(false);
  useLayoutEffect(() => {
    if (!editing) return;
    const ta = taRef.current;
    if (!ta) return;
    autosize(ta);
    ta.focus({ preventScroll: true });
    const n = ta.value.length;
    ta.setSelectionRange(n, n);
  }, [editing]);
  useLayoutEffect(() => autosize(taRef.current), [body]);
  useEffect(() => {
    if (!editing && focusReadNext.current) {
      focusReadNext.current = false;
      readRef.current?.focus({ preventScroll: true });
    }
  }, [editing]);

  const st = useNotesStore.getState;
  const startEditing = () => {
    st().selectDiaryEntry(id);
    st().setDiaryEditing(id);
  };
  const leaveEditing = (focusRead: boolean) => {
    void flush();
    focusReadNext.current = focusRead;
    if (st().diaryEditingId === id) st().setDiaryEditing(null);
    else if (focusRead) readRef.current?.focus({ preventScroll: true });
  };

  const notedDay = dayOf(item.noted_at, dayStartHour);
  const meta = entryWrittenLabel(item.entry_date ?? notedDay, notedDay, fmtTime(item.noted_at), fmtShort(notedDay));
  const entryDay = item.entry_date ?? notedDay;

  return (
    <div
      className={`ns-notes-entry${selected ? " is-sel" : ""}`}
      data-did={id}
      onMouseDown={() => {
        if (!selected) st().selectDiaryEntry(id);
      }}
    >
      <div className="ns-notes-entrymeta">
        <span className="w">{meta}</span>
        <span className="ns-notes-tagslot" />
        <button
          type="button"
          className="ns-notes-metabtn"
          data-pop-toggle=""
          aria-expanded={datePopOpen}
          title="改到別天"
          onClick={onToggleDatePop}
        >
          改日期
        </button>
        {datePopOpen && (
          <DatePicker
            float
            className="ns-notes-dpop"
            label="改到哪一天"
            value={entryDay}
            max={today}
            markValue
            quick={[
              { label: "今天", day: today },
              { label: "昨天", day: addDays(today, -1) },
              { label: "前天", day: addDays(today, -2) },
            ]}
            onPick={onPickDate}
            onClose={onCloseDatePop}
          />
        )}
      </div>

      <input
        ref={titleRef}
        className="ns-notes-titlein"
        value={title}
        placeholder="標題（可不寫）"
        aria-label="日記標題"
        autoComplete="off"
        onFocus={() => st().selectDiaryEntry(id)}
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
            startEditing();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            void flush();
            readRef.current?.focus({ preventScroll: true });
          }
        }}
      />

      <div className="ns-notes-bodywrap">
        {editing ? (
          <textarea
            ref={taRef}
            className="ns-notes-ta"
            value={body}
            placeholder="寫點什麼…"
            aria-label="日記內文"
            onChange={(e) => {
              setBody(e.target.value);
              queue({ body: e.target.value });
            }}
            onBlur={() => leaveEditing(false)}
            onKeyDown={(e) => {
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
              className="ns-notes-read"
              tabIndex={0}
              role="textbox"
              aria-readonly="true"
              aria-label={`日記內文（按 ${capsOf("notes.open")} 編輯）`}
              onFocus={() => st().selectDiaryEntry(id)}
              onClick={startEditing}
            >
              <Paragraphs body={body} />
            </div>
            <div className="ns-notes-readhint">
              點一下或按 {capsOf("notes.open")} 編輯・{capsOf("notes.escape")} 或點外面回到閱讀
            </div>
          </>
        )}
      </div>

      <div className="ns-notes-actions">
        <span className="spacer" />
        <span className="ns-notes-wordcount">{countChars(body).toLocaleString()} 字</span>
        <button type="button" className="ns-notes-act quiet" onClick={onDelete}>
          刪除
        </button>
      </div>
    </div>
  );
}

/* ═══════════ 草稿 ═══════════ */

export interface DiaryDraftProps {
  /** 「今天的日記」／「補記 10 月 2 日」 */
  label: string;
  placeholder: string;
  title: string;
  body: string;
  onChange(next: { title: string; body: string }): void;
  /** 存檔（Ctrl+Enter 或「存檔」鈕） */
  onSave(): void;
  onCancel(): void;
  /** Esc 二段確認的第一下已按過（顯示「還有內容沒存…」） */
  confirmEsc: boolean;
  /** 草稿欄位裡按 Esc：由 NotesDiary 判斷要先問還是直接收 */
  onEscape(): void;
}

export function DiaryDraft({ label, placeholder, title, body, onChange, onSave, onCancel, confirmEsc, onEscape }: DiaryDraftProps) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    autosize(ta);
  }, [body]);
  useEffect(() => {
    taRef.current?.focus({ preventScroll: true });
    taRef.current?.scrollIntoView({ block: "nearest" });
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (matches(e, "notes.diary.save")) {
      e.preventDefault();
      onSave();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onEscape();
    }
  };

  return (
    <div className="ns-notes-entry is-draft">
      <div className="ns-notes-entrymeta">
        <span className="w">{label}</span>
      </div>
      <input
        className="ns-notes-titlein"
        value={title}
        placeholder="標題（可不寫）"
        aria-label="日記標題"
        autoComplete="off"
        onChange={(e) => onChange({ title: e.target.value, body })}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            taRef.current?.focus();
            return;
          }
          onKeyDown(e);
        }}
      />
      <div className="ns-notes-bodywrap">
        <textarea
          ref={taRef}
          className="ns-notes-ta"
          value={body}
          placeholder={placeholder}
          aria-label="日記內文"
          onChange={(e) => onChange({ title, body: e.target.value })}
          onKeyDown={onKeyDown}
        />
      </div>
      <div className="ns-notes-draftbar">
        <button type="button" className="ns-notes-btn primary" onClick={onSave}>
          存檔
        </button>
        <button type="button" className="ns-notes-btn" onClick={onCancel}>
          取消
        </button>
        {confirmEsc ? (
          <span className="hint warn">還有內容沒存——再按一次 {capsOf("notes.escape")} 放棄，或繼續打字</span>
        ) : (
          <span className="hint">
            <Kbd id="notes.diary.save" />
            存檔
          </span>
        )}
      </div>
    </div>
  );
}
