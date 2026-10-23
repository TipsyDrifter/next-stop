/**
 * MobileDiary——旅客筆記手機分頁的第三段「日記」（車次②契約 §5.3；D-筆-10／11／20／24／27；原型 app.js mobDiary）。
 *
 * 由上而下：月份記號條（MobileDiaryStrip）→ 大日期列（‹ 大日期 › 今天）→ 搜尋框
 *   → 本文（一張攤開的頁：當天各篇 MobileDiaryEntry＋草稿＋空狀態＋「再寫一篇」；搜尋有字時換成跨日結果列）
 *   → 當天足跡（MobileFootprints，可收合）。
 * 手機頁首（MobileTopBand）右上角不放任何東西（主人拍板：之後每頁右上角是 ⋯，售票口線做）——本頁的控制全在頁內。
 *
 * 狀態全在 notesStore（桌機同一份）：日、各篇、草稿開關、搜尋、足跡、月份記號；本元件只讀、呼叫動作。
 * 本地 state 只有三樣：足跡區展開（切 tab 回來重設為展開）、日期面板開著、搜尋框打到一半的字。
 *
 * 翻日（箭頭／月份條／今天／日期面板／搜尋結果）前的兩件事：
 *   1. 草稿有字 ⇒ 先存再翻（saveDiaryDraft；toast 帶復原）。store.setDiaryDay 會關草稿，不先存就丟了主人打的字。
 *   2. 打字中的那一篇：它卸載時自己把去抖中的那筆送出（MobileDiaryEntry），這裡不必管。
 * 「今天」跟著日界線（useTodayKey；設定一變就重算、每分鐘看一次）；跨過日界線不替主人換掉正在看的日子（契約 0-6）。
 *
 * 搜尋：注音組字中不送，去抖 150ms 呼叫 store.setDiaryQuery；點一則＝openDiaryHit（跳到那天、選中那篇並捲進視野），
 *   此時搜尋字保留在框裡、本文換回日視圖，框下一行「回到『…』的結果」可再叫回清單；清除鈕或刪空字＝回日視圖。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useUiStore } from "../../../store/uiStore";
import { useNotesStore } from "../../../store/notesStore";
import { addDays, dayKeyOf } from "../../../lib/date";
import {
  diaryEmptyText,
  fmtMonthDay,
  fmtShortDay,
  isBackfilled,
  toDiaryHit,
  weekdayZh,
} from "../../../domain/notes";
import { MobileDatePicker } from "../../common/MobileDatePicker";
import { useBackLayer } from "../../mobile/backStack";
import { useDiaryPickMarks } from "../useDiaryPickMarks";
import { MobileDiaryStrip } from "./MobileDiaryStrip";
import { MobileDiaryDraft, MobileDiaryEntry, type DraftHandle } from "./MobileDiaryEntry";
import { MobileFootprints } from "./MobileFootprints";
import { IconLeft, IconPen, IconPlus, IconRight, IconSearch, IconX, highlight, useTodayKey } from "./mobileDiaryBits";

export function MobileDiary() {
  const diaryDay = useNotesStore((s) => s.diaryDay);
  const allEntries = useNotesStore((s) => s.diaryEntries);
  const loading = useNotesStore((s) => s.diaryLoading);
  const draftOpen = useNotesStore((s) => s.diaryDraftOpen);
  const diaryQuery = useNotesStore((s) => s.diaryQuery);
  const hits = useNotesStore((s) => s.diaryHits);
  const fpDay = useNotesStore((s) => s.fpDay);
  const footprint = useNotesStore((s) => s.footprint);
  const marksMonth = useNotesStore((s) => s.marksMonth);
  const diaryMarks = useNotesStore((s) => s.diaryMarks);
  const footprintDays = useNotesStore((s) => s.footprintDays);
  const setDiaryDay = useNotesStore((s) => s.setDiaryDay);
  const openDiaryDraft = useNotesStore((s) => s.openDiaryDraft);
  const setDiaryQuery = useNotesStore((s) => s.setDiaryQuery);
  const openDiaryHit = useNotesStore((s) => s.openDiaryHit);
  const stepFpDay = useNotesStore((s) => s.stepFpDay);
  const fpBackToDiaryDay = useNotesStore((s) => s.fpBackToDiaryDay);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const today = useTodayKey();
  // 剛翻日、新的一天還沒載回來時，store 裡仍是前一天的篇：只畫屬於這一天的（與桌機 NotesDiary 同法，免得閃一下）
  const entries = useMemo(() => allEntries.filter((n) => n.entry_date === diaryDay), [allEntries, diaryDay]);

  const [fpOpen, setFpOpen] = useState(true);
  const [pickDay, setPickDay] = useState(false);
  // 磨光① 返回層：日期面板＝同「取消」
  useBackLayer("notes.diary.pickDay", pickDay, () => setPickDay(false));
  /** 日期面板的自畫月格記號（車次③ 0-6 甲、D-筆-46 修訂「手機版同一套」） */
  const pickMarks = useDiaryPickMarks();
  const [q, setQ] = useState(diaryQuery);
  /** 搜尋字還在、但主人點了某一則跳過去了 ⇒ 先看日視圖 */
  const [hitsHidden, setHitsHidden] = useState(false);
  const composing = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const draft = useRef<DraftHandle>({ title: "", body: "" });
  const scrollTo = useRef<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // 進頁：以 store 目前的日把三份資料補一次（第一次進日記由 setSection 載過；切 tab 回來時別台可能已改過）
  useEffect(() => {
    const st = useNotesStore.getState();
    void st.loadDiary();
    void st.loadFootprint();
    void st.loadMarks();
    return () => window.clearTimeout(timer.current);
  }, []);

  /** 翻日前：草稿有字先存（store.setDiaryDay 會關草稿） */
  const leaveDay = async (go: () => void) => {
    const st = useNotesStore.getState();
    if (st.diaryDraftOpen && (draft.current.title.trim() || draft.current.body.trim())) {
      const id = await st.saveDiaryDraft({ ...draft.current });
      if (!id && useNotesStore.getState().diaryDraftOpen) return; // 存檔失敗：草稿留著、不翻
    }
    go();
  };
  const goDay = (d: string) => void leaveDay(() => setDiaryDay(d));

  /* 搜尋 */
  const pushQuery = (text: string) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      setHitsHidden(false);
      if (useNotesStore.getState().diaryQuery === text) return;
      void setDiaryQuery(text);
    }, 150);
  };
  const clearQuery = () => {
    window.clearTimeout(timer.current);
    setQ("");
    setHitsHidden(false);
    void setDiaryQuery("");
  };
  const showHits = !!diaryQuery.trim() && !hitsHidden;

  const openHit = (id: string, day: string) =>
    void leaveDay(() => {
      scrollTo.current = id;
      setHitsHidden(true);
      openDiaryHit(id, day);
    });

  // 搜尋字被 store 清掉（同步 wiped／別處清空）⇒ 框也清
  useEffect(() => {
    if (!diaryQuery) setQ((cur) => (composing.current ? cur : ""));
  }, [diaryQuery]);

  // 跳到搜尋結果的那一篇：載到之後捲進視野
  useLayoutEffect(() => {
    const id = scrollTo.current;
    if (!id || showHits) return;
    const el = rootRef.current?.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(id)}"]`);
    if (!el) return;
    scrollTo.current = null;
    el.scrollIntoView({ block: "start" });
  }, [entries, showHits]);

  const isToday = diaryDay === today;
  const empty = diaryEmptyText(isToday);
  const hitQ = diaryQuery.trim();

  return (
    <div className="ns-notes-mdiary" ref={rootRef}>
      <MobileDiaryStrip
        month={marksMonth}
        day={diaryDay}
        today={today}
        diaryMarks={diaryMarks}
        footprintDays={footprintDays}
        onPick={goDay}
      />

      <div className="ns-notes-mdateline">
        <button type="button" className="ns-notes-marrow" aria-label="前一天" onClick={() => goDay(addDays(diaryDay, -1))}>
          <IconLeft />
        </button>
        <button
          type="button"
          className="ns-notes-mbigdate"
          aria-label={`${fmtMonthDay(diaryDay)}，點一下換日期`}
          onClick={() => setPickDay(true)}
        >
          {fmtMonthDay(diaryDay)}
          <span className="w">· {weekdayZh(diaryDay)}</span>
        </button>
        <button
          type="button"
          className="ns-notes-marrow"
          aria-label="後一天"
          disabled={diaryDay >= today}
          onClick={() => goDay(addDays(diaryDay, 1))}
        >
          <IconRight />
        </button>
        <button type="button" className="ns-notes-mtodaybtn" disabled={isToday} onClick={() => goDay(today)}>
          今天
        </button>
      </div>

      <div className="ns-notes-mtools">
        <label className="ns-notes-msearch">
          <IconSearch />
          <input
            className="ns-notes-minput"
            type="search"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              if (!composing.current) pushQuery(e.target.value);
            }}
            onFocus={() => setHitsHidden(false)}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={(e) => {
              composing.current = false;
              pushQuery(e.currentTarget.value);
            }}
            placeholder="搜尋日記"
            aria-label="搜尋日記"
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="search"
          />
          {q && (
            <button type="button" className="ns-notes-mclear" aria-label="清除搜尋" onClick={clearQuery}>
              <IconX />
            </button>
          )}
        </label>
      </div>
      {hitQ && hitsHidden && (
        <button type="button" className="ns-notes-mhitsback" onClick={() => setHitsHidden(false)}>
          <IconLeft size={13} />
          回到『{hitQ}』的 {hits.length} 則結果
        </button>
      )}

      {showHits ? (
        hits.length === 0 ? (
          <div className="ns-notes-mempty is-list">
            <p>找不到『{hitQ}』</p>
          </div>
        ) : (
          <ul className="ns-notes-mdhits">
            {hits.map((n) => {
              const h = toDiaryHit(n, 80);
              const back = isBackfilled(h.day, dayKeyOf(n.noted_at, dayStartHour));
              return (
                <li key={n.id}>
                  <button type="button" className="ns-notes-mdhit" onClick={() => openHit(n.id, h.day)}>
                    <span className="d">
                      {fmtShortDay(h.day)}（{weekdayZh(h.day)}）{back && <span className="bk">補記</span>}
                    </span>
                    <span className="t">{highlight(h.title, hitQ)}</span>
                    {h.excerpt && <span className="x">{highlight(h.excerpt, hitQ)}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        )
      ) : (
        <article className="ns-notes-msheetpage ns-notes-mdiarypage">
          {entries.map((n) => (
            <MobileDiaryEntry key={n.id} n={n} today={today} />
          ))}
          {draftOpen ? (
            <MobileDiaryDraft key={diaryDay} day={diaryDay} today={today} handle={draft} />
          ) : entries.length === 0 && !loading ? (
            <div className="ns-notes-mnodiary">
              <p>{empty.text}</p>
              <button type="button" className="ns-notes-mbtn ns-btn btn-ghost" onClick={openDiaryDraft}>
                <IconPen />
                {empty.button}
              </button>
            </div>
          ) : (
            <div className="ns-notes-mmorebtn">
              <button type="button" className="ns-notes-mbtn ns-btn btn-ghost" onClick={openDiaryDraft}>
                <IconPlus />
                再寫一篇
              </button>
            </div>
          )}
        </article>
      )}

      <MobileFootprints
        open={fpOpen}
        onToggle={() => setFpOpen((v) => !v)}
        fpDay={fpDay}
        diaryDay={diaryDay}
        today={today}
        footprint={footprint}
        onStep={stepFpDay}
        onBack={fpBackToDiaryDay}
      />

      {pickDay && (
        <MobileDatePicker
          title="跳到哪一天"
          value={diaryDay}
          max={today}
          today={today}
          {...pickMarks}
          quick={[
            { label: "今天", day: today },
            { label: "昨天", day: addDays(today, -1) },
          ]}
          onPick={(d) => {
            setPickDay(false);
            if (d !== diaryDay) goDay(d);
          }}
          onClose={() => setPickDay(false)}
        />
      )}
    </div>
  );
}
