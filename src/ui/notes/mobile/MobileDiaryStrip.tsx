/**
 * MobileDiaryStrip——手機日記頁頂部的月份記號條（車次②契約 §5.3；D-筆-20；原型 app.js mobDiary 的 strip、styles.css:999-1012）。
 *
 * 一條橫捲的日格：直排月名「10 月」→「‹ 9月」（跳上個月最後一天）→ 本月每一天 →（看的是過去的月）「10月 ›」。
 *   每格：上小字星期、中日數、下記號點——有日記實心（--accent）、只有足跡空心、都沒有不畫；
 *   今天外框、選中（＝日記頁正在看的那天）實線框＋亮底、未來的日子灰掉不可點。
 * 週首（D-筆-29）：讀 uiStore.weekStart（1＝週一、0＝週日），每週第一天前多一道虛線分隔——橫條沒有「欄」，
 *   週首只能用分隔來表達；星期小字照 getDay() 寫，不受週首影響。
 * 月份：畫的是 store 的 marksMonth（＝日記頁那天的月；記號也是這個月的），不是今天的月。
 *
 * 觸控：日格 44×58（契約原寫 40 寬、「量過若難按改 44」——手機殼鐵則觸控 ≥44，直接取 44）。
 * 進頁與換日時把選中格捲到橫條中央：只改橫條自己的 scrollLeft，不用 scrollIntoView
 *   （它會連 `.m-page` 的直向捲動一起動，主人正在往下看足跡時會被拉回頂端）。
 */
import { useLayoutEffect, useRef } from "react";
import { useUiStore } from "../../../store/uiStore";
import { addMonths, dayMark, fmtMonthDay, monthDays, monthKey, weekdayZh } from "../../../domain/notes";
import { addDays } from "../../../lib/date";
import { reducedMotion } from "./mobileDiaryBits";

export interface MobileDiaryStripProps {
  /** YYYY-MM：要畫的月（store.marksMonth） */
  month: string;
  /** 選中的日（store.diaryDay） */
  day: string;
  today: string;
  diaryMarks: Readonly<Record<string, number>>;
  footprintDays: readonly string[];
  onPick(day: string): void;
}

function getDay(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).getDay();
}

export function MobileDiaryStrip({ month, day, today, diaryMarks, footprintDays, onPick }: MobileDiaryStripProps) {
  const weekStart = useUiStore((s) => s.weekStart);
  const ref = useRef<HTMLDivElement>(null);
  const first = useRef(true);

  const days = monthDays(month);
  const fp = new Set(footprintDays);
  const prevMonth = addMonths(month, -1);
  const nextMonth = addMonths(month, 1);
  const hasNext = nextMonth <= monthKey(today);
  const monthNo = (mk: string) => Number(mk.slice(5));

  // 選中格捲到中央（第一次直接到位，之後平滑；減量動態一律直接到位）
  useLayoutEffect(() => {
    const strip = ref.current;
    if (!strip) return;
    const el = strip.querySelector<HTMLElement>(".ns-notes-mday.sel") ?? strip.querySelector<HTMLElement>(".ns-notes-mday.today");
    if (!el) return;
    const left = el.offsetLeft - strip.clientWidth / 2 + el.offsetWidth / 2;
    strip.scrollTo({ left: Math.max(0, left), behavior: first.current || reducedMotion() ? "auto" : "smooth" });
    first.current = false;
  }, [day, month]);

  return (
    <div className="ns-notes-mstrip" ref={ref} role="group" aria-label={`${monthNo(month)} 月的日期`}>
      <span className="ml" aria-hidden>
        {monthNo(month)} 月
      </span>
      <button
        type="button"
        className="ns-notes-mday is-nav"
        aria-label={`上個月（跳到 ${monthNo(prevMonth)} 月底）`}
        onClick={() => onPick(addDays(month + "-01", -1))}
      >
        <span className="w" aria-hidden>
          ‹
        </span>
        <span className="d sm">{monthNo(prevMonth)}月</span>
      </button>
      {days.map((k, i) => {
        const mark = dayMark(diaryMarks[k] ?? 0, fp.has(k));
        const future = k > today;
        const cls = [
          "ns-notes-mday",
          mark,
          k === today ? "today" : "",
          k === day ? "sel" : "",
          i > 0 && getDay(k) === weekStart ? "wk" : "",
        ]
          .filter(Boolean)
          .join(" ");
        const note = mark === "diary" ? "，有日記" : mark === "fp" ? "，只有足跡" : "";
        return (
          <button
            key={k}
            type="button"
            className={cls}
            disabled={future}
            aria-pressed={k === day}
            aria-current={k === today ? "date" : undefined}
            aria-label={`${fmtMonthDay(k)}${note}`}
            onClick={() => onPick(k)}
          >
            <span className="w" aria-hidden>
              {weekdayZh(k)}
            </span>
            <span className="d" aria-hidden>
              {Number(k.slice(8))}
            </span>
            {mark && <i className="dot" aria-hidden />}
          </button>
        );
      })}
      {hasNext && (
        <button
          type="button"
          className="ns-notes-mday is-nav"
          aria-label={`下個月（跳到 ${monthNo(nextMonth)} 月 1 日）`}
          onClick={() => onPick(nextMonth + "-01")}
        >
          <span className="w" aria-hidden>
            ›
          </span>
          <span className="d sm">{monthNo(nextMonth)}月</span>
        </button>
      )}
    </div>
  );
}
