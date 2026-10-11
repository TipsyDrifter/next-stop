/**
 * DiaryHeader——日記子畫面的頁首（桌機；車次②契約 §5.1；D-筆-27／30；原型 app.js deskDiary 的 header）。
 *
 *   眉標「日記 — DIARY · 2026」
 *   大日期列：‹（前一天）  大日期「10 月 5 日 · 日」（點開共用 DatePicker：快選 今天／昨天／前天＋日期欄，max＝今天）
 *             ›（已在今天＝反灰）  「今天」（已在今天＝反灰）
 *   頁內搜尋框（`/` 聚焦；有字＝本文區換成跨日結果列）
 *   右側日付印（核心 DateSeal，80px／-4°）
 *
 * 翻日一律經 NotesView 的 flushThen（先存正在打的字、非空草稿）——由呼叫端包好再傳進來。
 */
import { useEffect, useRef, useState, type RefObject } from "react";
import { useNotesStore } from "../../store/notesStore";
import { addDays } from "../../lib/date";
import { fmtMonthDay, weekdayZh } from "../../domain/notes";
import { DatePicker } from "../common/DatePicker";
import { DateSeal } from "../stamps";
import { IconLeft, IconRight, IconSearch, dateOfKey } from "./notesBits";

export interface DiaryHeaderProps {
  day: string;
  today: string;
  /** 大日期的挑選器開著 */
  pickOpen: boolean;
  onTogglePick(): void;
  onClosePick(): void;
  onPick(day: string): void;
  onStep(dir: 1 | -1): void;
  onToday(): void;
  searchRef: RefObject<HTMLInputElement | null>;
  /** 搜尋框有字、按 Enter／↓：交給結果列（開第一則／焦點到第一列） */
  onSearchEnter(): void;
  onSearchDown(): void;
  /** 打字（要從「看某一則」回到結果列） */
  onSearchTyping(): void;
  /** 搜尋框空著按 Esc：焦點回頁面 */
  onSearchLeave(): void;
}

export function DiaryHeader({
  day,
  today,
  pickOpen,
  onTogglePick,
  onClosePick,
  onPick,
  onStep,
  onToday,
  searchRef,
  onSearchEnter,
  onSearchDown,
  onSearchTyping,
  onSearchLeave,
}: DiaryHeaderProps) {
  const storeQuery = useNotesStore((s) => s.diaryQuery);
  const [text, setText] = useState(storeQuery);

  // 去抖 150ms 再查（契約 §3.6 setDiaryQuery）
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const t = setTimeout(() => void useNotesStore.getState().setDiaryQuery(text), 150);
    return () => clearTimeout(t);
  }, [text]);
  // store 被別處清掉（Esc、同步 wiped）⇒ 框跟著清
  useEffect(() => {
    if (!storeQuery && text) setText("");
  }, [storeQuery]); // 只看 store 那邊的變化

  const atToday = day >= today;

  return (
    <header className="ns-notes-dhead">
      <div className="ns-notes-dleft">
        <p className="techo-overline ns-notes-overline">日記 — DIARY · {day.slice(0, 4)}</p>
        <div className="ns-notes-dateline">
          <button type="button" className="ns-notes-arrow" aria-label="前一天" title="前一天" onClick={() => onStep(-1)}>
            <IconLeft size={15} />
          </button>
          <button
            type="button"
            className="ns-notes-bigdate"
            data-pop-toggle=""
            aria-expanded={pickOpen}
            aria-haspopup="dialog"
            title="跳到某一天"
            onClick={onTogglePick}
          >
            {fmtMonthDay(day)}
            <span className="w">· {weekdayZh(day)}</span>
          </button>
          <button
            type="button"
            className="ns-notes-arrow"
            aria-label="後一天"
            title="後一天"
            disabled={atToday}
            onClick={() => onStep(1)}
          >
            <IconRight size={15} />
          </button>
          <button type="button" className="ns-notes-todaybtn" disabled={day === today} onClick={onToday}>
            今天
          </button>
          {pickOpen && (
            <DatePicker
              float
              className="ns-notes-daypop"
              label="跳到哪一天"
              value={day}
              max={today}
              markValue
              quick={[
                { label: "今天", day: today },
                { label: "昨天", day: addDays(today, -1) },
                { label: "前天", day: addDays(today, -2) },
              ]}
              onPick={onPick}
              onClose={onClosePick}
            />
          )}
        </div>
        <label className="ns-notes-searchwrap ns-notes-dsearch">
          <IconSearch size={12} />
          <input
            ref={searchRef}
            className="techo-input ns-notes-search"
            placeholder="搜尋日記"
            aria-label="搜尋日記"
            autoComplete="off"
            value={text}
            onFocus={() => text.trim() && onSearchTyping()}
            onChange={(e) => {
              setText(e.target.value);
              onSearchTyping();
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                if (text) {
                  setText("");
                  void useNotesStore.getState().setDiaryQuery("");
                } else onSearchLeave();
              } else if ((e.key === "Enter" || e.key === "ArrowDown") && text.trim()) {
                e.preventDefault();
                // 去抖還沒送出的字先查完，結果列才是這個字的
                const st = useNotesStore.getState();
                const ready = st.diaryQuery === text ? Promise.resolve() : st.setDiaryQuery(text);
                const go = e.key === "Enter" ? onSearchEnter : onSearchDown;
                void ready.then(go);
              }
            }}
          />
        </label>
      </div>
      <DateSeal date={dateOfKey(day)} size={80} rotate={-4} className="ns-notes-dateseal" title={`日付印 ${day}`} />
    </header>
  );
}
