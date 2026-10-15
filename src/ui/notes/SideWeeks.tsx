/**
 * SideWeeks——書封頁務件裡的「近 12 週」方格（桌機；旅客筆記車次③契約 §5.1、D-筆-45；示意＝prototypes/旅客筆記-日記選日期-參考圖.html）。
 *
 *   h2.sub「近 12 週 RECENT」＋ `div.ns-notes-weekgrid`：一欄一週（12 欄）、由上到下照 `uiStore.weekStart` 排七天；格 12×12、間距 3
 *   格＝`button.ns-notes-wk[.has][.today][.sel]`（未來 disabled）：寫過＝填墨、沒寫＝書封 hover 底、今天外框金、選中金菱形在格下
 *   aria-label「10 月 5 日，有日記」；只分「寫過／沒寫」兩階（不分深淺）
 *   點格＝ await notesFlush（存正在打的字、非空草稿）→ `setDiaryDay(day)`
 * 鍵盤：方格是一個 roving 焦點（Tab 只停一次）：↑↓ ±1 天、←→ ±1 週，Enter／Space＝按鈕本身。
 * 資料＝`notesStore.weekMarks`（區間＝本週末日往前 83 天；日記寫入、進日記子畫面、同步重載時 store 自己會更新）。
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useNotesStore } from "../../store/notesStore";
import { useUiStore } from "../../store/uiStore";
import { addDays, todayKey } from "../../lib/date";
import { fmtMonthDay } from "../../domain/notes";
import { notesFlush } from "./notesFlush";

/** 以 weekStart 對齊的「本週末日」往前 83 天（與 notesStore 的 weekGridRange 同一個口徑） */
function weekDays(today: string, weekStart: number): string[] {
  const [y, m, d] = today.split("-").map(Number);
  const dow = new Date(y, m - 1, d).getDay();
  const end = addDays(today, 6 - ((dow - weekStart + 7) % 7));
  const start = addDays(end, -83);
  return Array.from({ length: 84 }, (_, i) => addDays(start, i));
}

export function SideWeeks() {
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const weekStart = useUiStore((s) => s.weekStart);
  const marks = useNotesStore((s) => s.weekMarks);
  const diaryDay = useNotesStore((s) => s.diaryDay);
  const today = todayKey(dayStartHour);
  const days = useMemo(() => weekDays(today, weekStart), [today, weekStart]);
  const [focusDay, setFocusDay] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const moveDom = useRef(false);

  useEffect(() => {
    void useNotesStore.getState().loadWeekMarks();
  }, [today, weekStart]);

  const inGrid = (d: string) => d >= days[0] && d <= today;
  const cur = focusDay && inGrid(focusDay) ? focusDay : inGrid(diaryDay) ? diaryDay : today;

  useEffect(() => {
    if (!moveDom.current) return;
    moveDom.current = false;
    gridRef.current?.querySelector<HTMLElement>(`[data-day="${cur}"]`)?.focus({ preventScroll: true });
  }, [cur]);

  const pick = async (day: string) => {
    setFocusDay(day);
    await notesFlush.fn?.();
    useNotesStore.getState().setDiaryDay(day);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const step = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7 }[e.key];
    if (step === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    const next = addDays(cur, step);
    if (!inGrid(next)) return;
    moveDom.current = true;
    setFocusDay(next);
  };

  return (
    <div className="ns-notes-weeks" role="group" aria-label="近 12 週的日記">
      <h2 className="sub">近 12 週 RECENT</h2>
      <div ref={gridRef} className="ns-notes-weekgrid" onKeyDown={onKeyDown}>
        {days.map((d) => {
          const has = (marks[d] ?? 0) > 0;
          const future = d > today;
          const cls = ["ns-notes-wk", has && "has", d === today && "today", d === diaryDay && "sel"].filter(Boolean).join(" ");
          return (
            <button
              key={d}
              type="button"
              data-day={d}
              className={cls}
              disabled={future}
              tabIndex={d === cur ? 0 : -1}
              aria-label={`${fmtMonthDay(d)}，${has ? "有日記" : "沒寫"}${d === today ? "（今天）" : ""}`}
              aria-current={d === diaryDay ? "date" : undefined}
              title={`${fmtMonthDay(d)}${has ? `・${marks[d]} 篇` : ""}`}
              onClick={() => void pick(d)}
            />
          );
        })}
      </div>
      <p className="ns-notes-weekfoot">點一格＝跳到那天・更早的日子：點大日期</p>
    </div>
  );
}
