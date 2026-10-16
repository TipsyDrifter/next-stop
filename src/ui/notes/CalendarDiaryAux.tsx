/**
 * CalendarDiaryAux——日曆當日清單浮層底部的「日記」一段（桌機；旅客筆記車次④契約 §5.4、§0-0 定案 0-5 甲＝D-筆-53）。
 *
 * mount 的 `calendarDayAux`（插槽在 DayPopover 締切段之後；整合席填 mount）。借核心浮層的 `.pop-sec`／`h4`／`.rule`。
 *   有日記＝「N 篇日記 ›」、沒有＝「寫這天的日記 ›」；未來的日子整段不畫（日記不能寫未來）。
 *   點：關浮層 → 切到旅客筆記頁 → 日記子畫面那一天；沒有日記就順手開草稿。
 * 資料：`listDiaryMarks(day, day)` 一次（浮層每換一天重查，便宜）。鍵盤：這一列是 button，Tab 可及；浮層的 ↑↓ 環是核心的、不含它。
 */
import { useEffect, useState } from "react";
import { noteRepo } from "../../data/noteRepo";
import { todayKey } from "../../lib/date";
import { useNotesStore } from "../../store/notesStore";
import { useUiStore } from "../../store/uiStore";
import { notesFlush } from "./notesFlush";
import "./notes-md.css";

export function CalendarDiaryAux({ day, close }: { day: string; close(): void }) {
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const future = day > todayKey(dayStartHour);
  const [count, setCount] = useState<{ day: string; n: number } | null>(null);

  useEffect(() => {
    if (future) return;
    let alive = true;
    noteRepo
      .listDiaryMarks(day, day)
      .then((m) => alive && setCount({ day, n: m[day] ?? 0 }))
      .catch((e) => {
        console.warn("CalendarDiaryAux.listDiaryMarks 失敗", e);
        if (alive) setCount({ day, n: 0 });
      });
    return () => {
      alive = false;
    };
  }, [day, future]);

  if (future) return null;
  const n = count?.day === day ? count.n : null;

  const go = async () => {
    close();
    await notesFlush.fn?.();
    useUiStore.getState().setPage("notes");
    const st = useNotesStore.getState();
    st.openDiaryAt(day);
    // 草稿要等日記子畫面掛上之後再開：它掛上時（dev 的 StrictMode 會「掛上→假卸載→再掛上」）的卸載收尾會把還是空白的草稿收掉
    if (!n) setTimeout(() => useNotesStore.getState().openDiaryDraft(), 0);
  };

  return (
    <div className="pop-sec ns-notes-dayaux">
      <h4>
        日記<span className="rule" />
      </h4>
      <button type="button" className="ns-notes-dayauxrow" disabled={n === null} onClick={() => void go()}>
        {n === null ? "…" : n > 0 ? `${n} 篇日記` : "寫這天的日記"}
        {n !== null && (
          <span className="ar" aria-hidden>
            ›
          </span>
        )}
      </button>
    </div>
  );
}
