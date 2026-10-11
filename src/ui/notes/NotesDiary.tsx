/**
 * NotesDiary——日記子畫面（桌機；車次②契約 §5.1；D-筆-10／11／22／24／27；原型 app.js deskDiary）。
 *
 * 兩欄：本文欄（頁首大日期列＋一天的各篇／草稿／空狀態，或頁內搜尋結果）｜當天足跡欄（Footprints）。
 * 日記以日為單位：一天可多篇（舊在上、新在下，契約 0-4）；草稿永遠接在當天末尾。
 *
 * 跟 NotesView 的分工：NotesView 持有小浮層（pop）、flushThen、鍵盤表；本元件把
 *   ・flush（各篇沒送出的字＋非空草稿自動存、空草稿丟棄）交給 `flushRef`
 *   ・鍵盤表要的幾個「只有本元件知道」的動作（Esc 的層次、焦點到草稿、↑↓ 在結果列）交給 `apiRef`
 * 草稿內容放在這裡（不落庫；store 只有 diaryDraftOpen 一個旗標）。
 *
 * 搜尋：搜尋框有字＝本文區換成跨日結果列；點一則跳到那天並選中那篇，**搜尋字保留**（Esc 才清，契約 §3.6）——
 *   所以「正在看某一則」是本地旗標 `browsing`：跳過去或翻日就看那天，回搜尋框打字或聚焦就回結果列（回報 deviations）。
 */
import { useCallback, useEffect, useRef, useState, type MutableRefObject, type RefObject } from "react";
import { useNotesStore } from "../../store/notesStore";
import { useUiStore } from "../../store/uiStore";
import { diaryDraftMeta, diaryEmptyText, diaryPlaceholder } from "../../domain/notes";
import { DiaryHeader } from "./DiaryHeader";
import { DiaryDraft, DiaryEntry } from "./DiaryEntry";
import { DiarySearchList } from "./DiarySearchList";
import { Footprints } from "./Footprints";
import { IconPen, IconPlus, Kbd, useTodayKey } from "./notesBits";

/** 日記子畫面的小浮層：大日期的挑選器／某一篇的改日期 */
export type DiaryPopKind = "day" | "entrydate";
/** 大日期挑選器的 pop id（不是任何一篇的 id） */
export const DIARY_DAY_POP = "$diaryday";

/** 給 NotesView 鍵盤表用的動作 */
export interface DiaryApi {
  /** Esc（焦點不在輸入框時）：清搜尋／草稿二段確認／離開編輯；回傳有沒有處理 */
  escape(): boolean;
  /** W：草稿已開 ⇒ 焦點到草稿內文 */
  focusDraft(): void;
  /** 結果列正在畫面上 ⇒ ↑↓ 把焦點交給它（回 true＝已處理） */
  moveInHits(delta: 1 | -1): boolean;
  /** 搜尋字還在、正在看某一天時要寫日記：先回到日視圖 */
  showDay(): void;
}

export interface NotesDiaryProps {
  flushRef: MutableRefObject<(() => Promise<void>) | null>;
  apiRef: MutableRefObject<DiaryApi | null>;
  flushThen(fn: () => void): Promise<void>;
  pop: { id: string; kind: DiaryPopKind } | null;
  setPop(p: { id: string; kind: DiaryPopKind } | null): void;
  searchRef: RefObject<HTMLInputElement | null>;
  /** 焦點回頁面（鍵盤表接得上） */
  focusHome(): void;
  /** 刪除一篇（NotesView 先把選取移到下一篇） */
  onDelete(id: string): void;
}

export function NotesDiary({ flushRef, apiRef, flushThen, pop, setPop, searchRef, focusHome, onDelete }: NotesDiaryProps) {
  const day = useNotesStore((s) => s.diaryDay);
  const entries = useNotesStore((s) => s.diaryEntries);
  const selectedId = useNotesStore((s) => s.diarySelectedId);
  const editingId = useNotesStore((s) => s.diaryEditingId);
  const draftOpen = useNotesStore((s) => s.diaryDraftOpen);
  const query = useNotesStore((s) => s.diaryQuery);
  const hits = useNotesStore((s) => s.diaryHits);
  const loading = useNotesStore((s) => s.diaryLoading);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const today = useTodayKey();
  const isToday = day === today;
  const st = useNotesStore.getState;

  const colRef = useRef<HTMLElement>(null);
  const hitsRef = useRef<HTMLUListElement>(null);

  /* ── 搜尋結果 vs 日視圖 ── */
  const [browsing, setBrowsing] = useState(false);
  const showHits = !!query.trim() && !browsing;
  // 翻到別天（箭頭、月曆、跳轉）＝在看那一天
  const lastDay = useRef(day);
  useEffect(() => {
    if (lastDay.current === day) return;
    lastDay.current = day;
    if (query.trim()) setBrowsing(true);
    colRef.current?.scrollTo({ top: 0 }); // 契約 §5.1：換日後本文欄捲回頂
  }, [day, query]);
  useEffect(() => {
    if (!query.trim()) setBrowsing(false);
  }, [query]);

  /* ── 草稿（本地；不落庫） ── */
  const [draft, setDraft] = useState({ title: "", body: "" });
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [confirmEsc, setConfirmEsc] = useState(false);
  useEffect(() => {
    if (draftOpen) return;
    setDraft({ title: "", body: "" }); // 收起（存檔、取消、換日）＝下次打開是空白的
    setConfirmEsc(false);
  }, [draftOpen]);
  const draftHasText = () => !!(draftRef.current.title.trim() || draftRef.current.body.trim());

  const saveDraft = async () => {
    const id = await st().saveDiaryDraft(draftRef.current);
    if (id) focusHome();
  };
  const cancelDraft = () => {
    st().cancelDiaryDraft();
    focusHome();
  };
  const escapeDraft = () => {
    if (draftHasText() && !confirmEsc) setConfirmEsc(true);
    else cancelDraft();
  };

  /* ── flush：各篇沒送出的字＋草稿（非空＝自動存在原本那天；空＝丟棄） ── */
  const flushers = useRef(new Map<string, () => Promise<void>>());
  const register = useCallback((id: string, fn: () => Promise<void>) => {
    flushers.current.set(id, fn);
    return () => {
      if (flushers.current.get(id) === fn) flushers.current.delete(id);
    };
  }, []);
  const flush = useCallback(async () => {
    await Promise.all([...flushers.current.values()].map((f) => f()));
    const s = useNotesStore.getState();
    if (!s.diaryDraftOpen) return;
    const d = draftRef.current;
    if (d.title.trim() || d.body.trim()) await s.saveDiaryDraft(d);
    else s.cancelDiaryDraft();
  }, []);
  useEffect(() => {
    flushRef.current = flush;
    return () => {
      void flush(); // 離開本頁或換子畫面
      if (flushRef.current === flush) flushRef.current = null;
    };
  }, [flush, flushRef]);

  /* ── 給鍵盤表的動作 ── */
  useEffect(() => {
    apiRef.current = {
      escape() {
        const s = useNotesStore.getState();
        if (s.diaryQuery.trim()) {
          void s.setDiaryQuery("");
          return true;
        }
        if (s.diaryDraftOpen) {
          escapeDraft();
          return true;
        }
        if (s.diaryEditingId) {
          s.setDiaryEditing(null);
          return true;
        }
        return false;
      },
      focusDraft() {
        colRef.current?.querySelector<HTMLTextAreaElement>(".ns-notes-entry.is-draft textarea")?.focus();
      },
      moveInHits(delta) {
        if (!showHits) return false;
        const btns = hitsRef.current?.querySelectorAll<HTMLButtonElement>(".ns-notes-dhit > button");
        if (!btns?.length) return true;
        btns[delta > 0 ? 0 : btns.length - 1].focus();
        return true;
      },
      showDay() {
        setBrowsing(true);
      },
    };
    return () => {
      apiRef.current = null;
    };
  });

  /* ── 選中的那一篇捲進視野（鍵盤 ↑↓、從搜尋跳來） ── */
  useEffect(() => {
    if (!selectedId) return;
    colRef.current
      ?.querySelector<HTMLElement>(`[data-did="${CSS.escape(selectedId)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedId, entries]);

  /* ── 焦點保全：聚焦中的那一篇跟著換日／刪除／存檔消失時，焦點會掉到 body、鍵盤表就斷線——接回頁根 ── */
  const visibleCount = entries.filter((n) => n.entry_date === day).length;
  useEffect(() => {
    const a = document.activeElement;
    if (!a || a === document.body) focusHome();
  }, [day, visibleCount, draftOpen, showHits, editingId, focusHome]);

  const go = (fn: () => void) => {
    setPop(null);
    void flushThen(fn);
  };
  const openHit = (id: string, d: string) => {
    setBrowsing(true);
    go(() => st().openDiaryHit(id, d));
    focusHome();
  };

  // 剛翻日、新的一天還沒載回來：store 裡還是上一天的篇——只畫歸屬這一天的，免得上一天閃一下
  const visible = entries.filter((n) => n.entry_date === day);
  const dayPopOpen = pop?.kind === "day";
  const empty = diaryEmptyText(isToday);

  let main;
  if (showHits) {
    main = (
      <article className="ns-notes-page ns-notes-dpage ns-notes-hitpage">
        <DiarySearchList
          query={query}
          hits={hits}
          dayStartHour={dayStartHour}
          listRef={hitsRef}
          onOpen={openHit}
          onExitTop={() => searchRef.current?.focus()}
        />
      </article>
    );
  } else {
    main = (
      <article className="ns-notes-page ns-notes-dpage">
        <div className="ns-notes-measure">
          {visible.map((n) => (
            <DiaryEntry
              key={n.id}
              item={n}
              selected={selectedId === n.id}
              editing={editingId === n.id}
              today={today}
              dayStartHour={dayStartHour}
              datePopOpen={pop?.kind === "entrydate" && pop.id === n.id}
              onToggleDatePop={() =>
                setPop(pop?.kind === "entrydate" && pop.id === n.id ? null : { id: n.id, kind: "entrydate" })
              }
              onCloseDatePop={() => {
                setPop(null);
                focusHome();
              }}
              onPickDate={(d) => {
                setPop(null);
                focusHome();
                void flushThen(() => void st().setDiaryEntryDate(n.id, d));
              }}
              onDelete={() => onDelete(n.id)}
              register={register}
            />
          ))}
          {draftOpen ? (
            <DiaryDraft
              label={diaryDraftMeta(isToday, day)}
              placeholder={diaryPlaceholder(isToday)}
              title={draft.title}
              body={draft.body}
              onChange={(next) => {
                setDraft(next);
                setConfirmEsc(false);
              }}
              onSave={() => void saveDraft()}
              onCancel={cancelDraft}
              confirmEsc={confirmEsc}
              onEscape={escapeDraft}
            />
          ) : visible.length === 0 ? (
            loading ? null : (
              <div className="ns-notes-nodiary">
                <p>{empty.text}</p>
                <button type="button" className="ns-notes-btn" onClick={() => st().openDiaryDraft()}>
                  <IconPen size={13} />
                  {empty.button}
                  <Kbd id="notes.diary.write" />
                </button>
              </div>
            )
          ) : (
            <div className="ns-notes-more">
              <button type="button" className="ns-notes-btn" onClick={() => st().openDiaryDraft()}>
                <IconPlus size={12} />
                再寫一篇
                <Kbd id="notes.diary.write" />
              </button>
            </div>
          )}
        </div>
      </article>
    );
  }

  return (
    <>
      <section ref={colRef} className="ns-notes-diarycol ns-notes-col techo-scroll" aria-label="日記">
        <div className="ns-notes-sheetwrap">
          <DiaryHeader
            day={day}
            today={today}
            pickOpen={dayPopOpen}
            onTogglePick={() => setPop(dayPopOpen ? null : { id: DIARY_DAY_POP, kind: "day" })}
            onClosePick={() => {
              setPop(null);
              focusHome();
            }}
            onPick={(d) => {
              go(() => st().setDiaryDay(d));
              focusHome();
            }}
            onStep={(dir) => go(() => st().stepDiaryDay(dir))}
            onToday={() => go(() => st().goDiaryToday())}
            searchRef={searchRef}
            onSearchEnter={() => {
              const first = useNotesStore.getState().diaryHits[0];
              if (first) openHit(first.id, first.entry_date ?? day);
            }}
            onSearchDown={() => {
              setBrowsing(false);
              setTimeout(() => hitsRef.current?.querySelector<HTMLButtonElement>(".ns-notes-dhit > button")?.focus(), 0);
            }}
            onSearchTyping={() => setBrowsing(false)}
            onSearchLeave={focusHome}
          />
          {main}
        </div>
      </section>
      <Footprints today={today} />
    </>
  );
}
