/**
 * DiaryEntry——日記的一篇與草稿（桌機；車次②契約 §5.1；D-筆-1／10／24；原型 app.js diaryEntry／diaryBodyHtml）。
 *
 * 一篇（DiaryEntry）：
 *   篇頭「寫於 09:12」／「寫於 10/2 23:40（補記）」（0-5：補記＝寫下那天的日界線日 ≠ 歸屬日）
 *        ＋「改日期」（共用 DatePicker，max＝今天；只改 entry_date；車次③起傳 marks＝自畫月格、寫過的日子打點）
 *   標題（選填）＋內文讀寫兩態：閱讀＝plainParagraphs；點一下或（選中後）Enter 進打字框；Esc／blur 回閱讀並立即存檔
 *   車次③：篇頭不另列荷札（內文就是正本，原型 7）；閱讀態內文的 #荷札 畫成行內小牌（「‹ 回到剛才 M 月 D 日的日記」）；
 *     打字框游標處打 # 出荷札建議（useInlineTagSuggest）；離開編輯、存檔鏈 flush 之後 `tagStore.syncNoteTags`（契約 0-13）。
 *     草稿的解析由 store 在 saveDiaryDraft 建檔之後做。
 *   車次④：閱讀態換成 Markdown 排版（MdBody；與筆記同一支）。
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
import { entryWrittenLabel } from "../../domain/notes";
import { useTagStore } from "../../store/tagStore";
import { DatePicker } from "../common/DatePicker";
import { addDays } from "../../lib/date";
import { matches } from "../shell/hotkeys";
import { Kbd, capsOf, dayOf, fmtShort, fmtTime } from "./notesBits";
import { MdBody } from "./md/MdBody";
import { resolveLeaveDiary } from "./leaveSync";
import { useInlineTagSuggest } from "./tags/useInlineTagSuggest";
import { diaryBackRef } from "./tags/backRefs";
import { useDiaryPickMarks } from "./useDiaryPickMarks";

type Patch = { title?: string; body?: string };

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
  /** 這一篇有字沒存成功（saveDiaryEntry 回 false）：離開編輯時以本地為準（見 leaveSync） */
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
        if (!(await useNotesStore.getState().saveDiaryEntry(id, patch))) saveFailed.current = true;
      })
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
  const pickMarks = useDiaryPickMarks();
  const tagSug = useInlineTagSuggest(taRef, (next) => {
    setBody(next);
    queue({ body: next });
  });
  const startEditing = () => {
    st().selectDiaryEntry(id);
    st().setDiaryEditing(id);
  };
  /**
   * 離開編輯＝存檔送完 → 回閱讀態 → 解析荷札（與手機 MobileDiaryEntry.leaveEdit 同法）。
   * UI 丙-6 回修：setDiaryEditing(null) 會順手 loadDiary 重載當天，原本跟 flush 同一拍出發，重載先讀到舊字，
   *   resolveLeaveDiary 再把它當「別台後寫贏了」換掉本地＝剛打的字不見。排在存檔鏈後面，重載讀到的就是新字。
   */
  const leaveEditing = (focusRead: boolean) => {
    tagSug.close();
    const local = { title, body };
    // Esc 之後打字框卸載可能再補一個 blur（focusRead=false）：只升不降，免得蓋掉 Esc 要的「焦點回閱讀態」
    if (focusRead) focusReadNext.current = true;
    void flush().then(() => {
      if (st().diaryEditingId === id) st().setDiaryEditing(null);
      else if (focusRead) readRef.current?.focus({ preventScroll: true });
      // 編輯期間別台後寫贏了 ⇒ 本地換成 store 的、荷札依 store 的內文（leaveSync；與 NoteContent 同法）
      const r = resolveLeaveDiary(id, local, Object.keys(pending.current).length > 0 || saveFailed.current);
      if (r.remote) {
        setBody(r.body);
        if (document.activeElement !== titleRef.current) setTitle(r.title);
      }
      void useTagStore.getState().syncNoteTags(id, r.body);
    });
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
            today={today}
            markValue
            quick={[
              { label: "今天", day: today },
              { label: "昨天", day: addDays(today, -1) },
              { label: "前天", day: addDays(today, -2) },
            ]}
            {...pickMarks}
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
        {tagSug.popup}
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
              aria-label={`日記內文（按 ${capsOf("notes.open")} 編輯）`}
              onFocus={() => st().selectDiaryEntry(id)}
              onClick={startEditing}
            >
              <MdBody body={body} backRef={() => diaryBackRef(id, entryDay)} />
            </div>
            <div className="ns-notes-readhint">
              點一下或按 {capsOf("notes.open")}編輯・{capsOf("notes.escape")}或點外面結束</div>
          </>
        )}
      </div>

      <div className="ns-notes-actions">
        <span className="spacer" />
        <span className="ns-notes-wordcount">{countChars(body).toLocaleString()} 字</span>
        <button type="button" className="ns-notes-act quiet ns-btn ns-btn--sm btn-ghost ns-btn-danger" onClick={onDelete}>
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
  /** 「取消」鈕（NotesDiary 給的是跟 Esc 同一條二段確認） */
  onCancel(): void;
  /** 二段確認的第一下已按過（Esc 或「取消」；顯示「還沒存檔——再按一次就放棄」） */
  confirmEsc: boolean;
  /** 草稿欄位裡按 Esc：由 NotesDiary 判斷要先問還是直接收 */
  onEscape(): void;
}

export function DiaryDraft({ label, placeholder, title, body, onChange, onSave, onCancel, confirmEsc, onEscape }: DiaryDraftProps) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const tagSug = useInlineTagSuggest(taRef, (next) => onChange({ title, body: next }));
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
        {tagSug.popup}
        <textarea
          ref={taRef}
          className="ns-notes-ta"
          value={body}
          placeholder={placeholder}
          aria-label="日記內文"
          onChange={(e) => onChange({ title, body: e.target.value })}
          {...tagSug.bind}
          onBlur={tagSug.close}
          onKeyDown={(e) => {
            if (tagSug.onKeyDown(e)) return;
            onKeyDown(e);
          }}
        />
      </div>
      <div className="ns-notes-draftbar">
        {/* 提示推到最左、［取消］［存檔］靠右（取消在左、主鈕在右，視覺規範 §2.3；排法同 DialogShell foot＝變待辦，UI 丙-6 回修） */}
        {confirmEsc ? (
          // 四處同一句（UI 丙-6 C3：捕捉框兩殼、寫日記兩殼）；Esc 與「取消」鈕都走這條，所以不提 Esc
          <span className="hint warn" role="status">還沒存檔——再按一次就放棄</span>
        ) : (
          <span className="hint">
            <Kbd id="notes.diary.save" />
            存檔
          </span>
        )}
        <button type="button" className="ns-notes-btn ns-btn btn-ghost" onClick={onCancel}>
          取消
        </button>
        <button type="button" className="ns-notes-btn ns-btn btn-seal" onClick={onSave}>
          存檔
        </button>
      </div>
    </div>
  );
}
