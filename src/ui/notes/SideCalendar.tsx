/**
 * SideCalendar——日記子畫面的頁務件月曆（桌機；車次②契約 §5.1；D-筆-10／20／29；原型 app.js deskCalendar、styles.css:321-347）。
 *
 * 原型畫在書封（--cover-* token）；本線頁務件是「頁」材質，所以顏色換成 --color-ink-*／--ns-hover／--ns-sel（同 NotesSide 檔頭的理由）。
 *   月份列：‹ 上個月 「2026 年 10 月」 下個月 ›（已在今天的月＝反灰）
 *   欄頭與格：週首讀 uiStore.weekStart（D-筆-29；1＝週一、0＝週日），欄頭／前置空格用 domain 的 weekdayHeads／monthLeadBlanks
 *   格：有日記＝實心金點、只有足跡＝空心點、今天＝外框、本文那天＝底色＋上緣金菱形；未來日不可點
 * 點某一天 ⇒ 本文與足跡都換到那天（經 NotesView 的 flushThen，先存正在打的字）。
 */
import { useNotesStore } from "../../store/notesStore";
import { useUiStore } from "../../store/uiStore";
import {
  addMonths,
  dayMark,
  fmtMonthDay,
  fmtMonthHeader,
  monthDays,
  monthKey,
  monthLeadBlanks,
  weekdayHeads,
} from "../../domain/notes";
import { IconLeft, IconRight, useTodayKey } from "./notesBits";

export function SideCalendar({ onPickDay }: { onPickDay(day: string): void }) {
  const month = useNotesStore((s) => s.marksMonth);
  const diaryMarks = useNotesStore((s) => s.diaryMarks);
  const footprintDays = useNotesStore((s) => s.footprintDays);
  const diaryDay = useNotesStore((s) => s.diaryDay);
  const weekStart = useUiStore((s) => s.weekStart);
  const today = useTodayKey();

  const fp = new Set(footprintDays);
  const atMax = month >= monthKey(today);
  const lead = monthLeadBlanks(month, weekStart);
  const step = (n: number) => void useNotesStore.getState().setMarksMonth(addMonths(month, n));

  return (
    <div className="ns-notes-cal">
      <div className="ns-notes-calhead">
        <button type="button" className="ns-notes-calnav" aria-label="上個月" title="上個月" onClick={() => step(-1)}>
          <IconLeft size={12} />
        </button>
        <span className="m">{fmtMonthHeader(month)}</span>
        <button
          type="button"
          className="ns-notes-calnav"
          aria-label="下個月"
          title="下個月"
          disabled={atMax}
          onClick={() => step(1)}
        >
          <IconRight size={12} />
        </button>
      </div>
      <div className="ns-notes-calgrid" role="group" aria-label={`${fmtMonthHeader(month)}的日記`}>
        {weekdayHeads(weekStart).map((w) => (
          <span key={w} className="wd" aria-hidden>
            {w}
          </span>
        ))}
        {Array.from({ length: lead }, (_, i) => (
          <span key={`lead${i}`} aria-hidden />
        ))}
        {monthDays(month).map((key) => {
          const mark = dayMark(diaryMarks[key] ?? 0, fp.has(key));
          const cls = [
            "ns-notes-calday",
            mark,
            mark ? "has" : "",
            key === today ? "today" : "",
            key === diaryDay ? "sel" : "",
          ]
            .filter(Boolean)
            .join(" ");
          const label = `${fmtMonthDay(key)}${mark === "diary" ? "，有日記" : mark === "fp" ? "，只有足跡" : ""}`;
          return (
            <button
              key={key}
              type="button"
              className={cls}
              aria-label={label}
              aria-current={key === today ? "date" : undefined}
              aria-pressed={key === diaryDay}
              disabled={key > today}
              onClick={() => onPickDay(key)}
            >
              {Number(key.slice(8))}
              {mark && <i className="dot" aria-hidden />}
            </button>
          );
        })}
      </div>
      <div className="ns-notes-callegend" aria-hidden>
        <span>
          <i className="a" />
          有日記
        </span>
        <span>
          <i className="b" />
          只有足跡
        </span>
      </div>
    </div>
  );
}
