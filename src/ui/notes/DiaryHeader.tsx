/**
 * DiaryHeader——日記子畫面的頁首（桌機；車次②契約 §5.1；D-筆-27／30；UI 丙-6 H3 換成共用 PageHeader）。
 *
 *   PageHeader 身分式（視覺規範 §2.1）：
 *     眉標 {日記, Diary}（粉彩只畫拉丁斜體、銀河「日記 — DIARY」；不帶年份）
 *     大標＝共用 DateNav（‹ 大日期 › 今天）：點大日期開共用 DatePicker（anchor 模式；快選 今天／昨天／前天＋月格，max＝今天；
 *           寫過日記的日子下方朱點——車次③ 0-6 甲、D-筆-46 修訂，記號由 useDiaryPickMarks 給）；› 在今天停用；
 *           「今天」chip 一律可按（10-22 裁定）
 *     補述＝週幾＋年；日付印＝DateSeal 92
 *     工具列：［✎ 寫日記］（過去的日子＝「✎ 補記」；空狀態出現時藏，規範 §2.7）［搜尋］（放大鏡；點了才展開一列）
 *   搜尋列 `DiarySearchBar`（同檔；搜尋展開時才畫，NotesDiary 把它放在本文欄頂、足跡卡不受影響）：頁內搜尋框
 *     （有字＝本文區換成跨日結果列）。`/` 鍵＝展開並聚焦（NotesView → DiaryApi.openSearch）。
 *     框空著按 Esc（或再按一次放大鏡）＝收起、焦點回頁面；有字按 Esc＝清字、框留著。
 *
 * 翻日一律經 NotesView 的 flushThen（先存正在打的字、非空草稿）——由呼叫端包好再傳進來。
 */
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useNotesStore } from "../../store/notesStore";
import { addDays } from "../../lib/date";
import { weekdayZh } from "../../domain/notes";
import { DatePicker } from "../common/DatePicker";
import { DateNav } from "../common/DateNav";
import { PageHeader } from "../common/PageHeader";
import { IconEdit } from "../common/icons";
import { useDiaryPickMarks } from "./useDiaryPickMarks";
import { DateSeal } from "../stamps";
import { IconSearch, capsOf, dateOfKey } from "./notesBits";

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
  /** 工具列「✎ 寫日記／補記」；null＝不畫（空狀態出現時：同一動作同頁一個入口） */
  onWrite: (() => void) | null;
  /** 搜尋列展開著（放大鏡 aria-expanded） */
  searchOpen: boolean;
  /** 放大鏡 */
  onSearchButton(): void;
}

/** 大標裡 DateNav 的 class（DatePicker 的 anchor 用它找標題鈕：G 鍵開的時候沒有點擊事件可拿） */
const DAYNAV = "ns-notes-daynav";

export function DiaryHeader({
  day,
  today,
  pickOpen,
  onTogglePick,
  onClosePick,
  onPick,
  onStep,
  onToday,
  onWrite,
  searchOpen,
  onSearchButton,
}: DiaryHeaderProps) {
  // DatePicker 掛 body、貼著大日期開（anchor 模式）：點大字或按 G 都從 DOM 找標題鈕
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    setAnchor(pickOpen ? document.querySelector<HTMLElement>(`.${DAYNAV} .t`) : null);
  }, [pickOpen]);

  const atToday = day >= today;
  const isToday = day === today;
  const pickMarks = useDiaryPickMarks();
  const [, m, d] = day.split("-").map(Number);
  const writeCaps = capsOf("notes.diary.write");
  const searchCaps = capsOf("notes.search");

  return (
    <>
      <PageHeader
        variant="identity"
        className="ns-notes-dhead"
        overline={{ zh: "日記", latin: "Diary" }}
        title={
          <DateNav
            className={DAYNAV}
            unit="day"
            title={`${m}月${d}日`}
            onPrev={() => onStep(-1)}
            onNext={() => onStep(1)}
            nextDisabled={atToday}
            onToday={onToday}
            isToday={isToday}
            onTitle={onTogglePick}
            titleExpanded={pickOpen}
          />
        }
        aside={
          <>
            <span>週{weekdayZh(day)}</span>
            <span>{day.slice(0, 4)}年</span>
          </>
        }
        stamp={<DateSeal date={dateOfKey(day)} size={92} rotate={-4} className="ns-notes-dateseal" title={`日付印 ${day}`} />}
        add={
          onWrite
            ? {
                label: isToday ? "寫日記" : "補記",
                icon: <IconEdit />,
                title: `${isToday ? "寫日記" : "補記這一天"}${writeCaps ? `（${writeCaps}）` : ""}`,
                onClick: onWrite,
              }
            : undefined
        }
        search={{ onOpen: onSearchButton, title: `搜尋日記${searchCaps ? `（${searchCaps}）` : ""}`, expanded: searchOpen }}
      />
      {pickOpen && anchor && (
        <DatePicker
          anchor={anchor}
          label="跳到哪一天"
          value={day}
          max={today}
          today={today}
          markValue
          quick={[
            { label: "今天", day: today },
            { label: "昨天", day: addDays(today, -1) },
            { label: "前天", day: addDays(today, -2) },
          ]}
          {...pickMarks}
          onPick={onPick}
          onClose={onClosePick}
        />
      )}
    </>
  );
}

export interface DiarySearchBarProps {
  searchRef: RefObject<HTMLInputElement | null>;
  /** 搜尋框有字、按 Enter／↓：交給結果列（開第一則／焦點到第一列） */
  onSearchEnter(): void;
  onSearchDown(): void;
  /** 打字（要從「看某一則」回到結果列） */
  onSearchTyping(): void;
  /** 搜尋框空著按 Esc：收起搜尋列、焦點回頁面 */
  onSearchLeave(): void;
}

/** 日記搜尋列（頁首放大鏡展開的那一列）；框裡的字掛上時取 store 的搜尋字，收起只在沒字時發生，所以不會丟字 */
export function DiarySearchBar({ searchRef, onSearchEnter, onSearchDown, onSearchTyping, onSearchLeave }: DiarySearchBarProps) {
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
  // store 被別處清掉（Esc、同步 wiped、「清除搜尋」）⇒ 框跟著清
  useEffect(() => {
    if (!storeQuery && text) setText("");
  }, [storeQuery]); // 只看 store 那邊的變化

  return (
    <div className="ns-notes-dsubbar">
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
  );
}
