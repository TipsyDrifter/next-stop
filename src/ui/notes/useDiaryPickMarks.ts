/**
 * useDiaryPickMarks——日記頁的日期挑選器要傳給共用 `DatePicker`／`MobileDatePicker` 的三個 props
 * （旅客筆記車次③ 0-6 甲、D-筆-46 修訂：有日記的日子在自畫月格上打朱點）。
 *
 * 用法（桌機與手機同一支）：`const pick = useDiaryPickMarks();` 然後 `<DatePicker … {...pick} />`。
 *   - `marks`：目前顯示那個月有日記的日子（先借 notesStore.diaryMarks 墊著——同一個月就不閃空——再以查回來的為準）
 *   - `onMonthChange`：月格掛上時與每次換月呼叫，補查那個月（notesStore.diaryDaysOf）
 *   - `marksLabel`：「寫過日記」
 * 挑選器沒開時什麼都不查（月格沒掛上就不會呼叫 onMonthChange）。
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { useNotesStore } from "../../store/notesStore";

export interface DiaryPickMarks {
  marks: ReadonlySet<string>;
  onMonthChange(month: string): void;
  marksLabel: string;
}

export function useDiaryPickMarks(): DiaryPickMarks {
  const [month, setMonth] = useState<string | null>(null);
  const [days, setDays] = useState<{ month: string; days: readonly string[] } | null>(null);
  const latest = useRef<string | null>(null);
  // 同一個月的 store 記號：寫完一篇後 diaryMarks 會先更新，挑選器重開時立刻看得到
  const storeMonth = useNotesStore((s) => s.marksMonth);
  const storeMarks = useNotesStore((s) => s.diaryMarks);

  const onMonthChange = useCallback((m: string) => {
    latest.current = m;
    setMonth(m);
    void useNotesStore
      .getState()
      .diaryDaysOf(m)
      .then((d) => {
        if (latest.current === m) setDays({ month: m, days: d });
      });
  }, []);

  const marks = useMemo(() => {
    const out = new Set<string>();
    if (month && month === storeMonth) for (const [k, n] of Object.entries(storeMarks)) if (n > 0) out.add(k);
    if (days && days.month === month) for (const k of days.days) out.add(k);
    return out;
  }, [month, days, storeMonth, storeMarks]);

  return { marks, onMonthChange, marksLabel: "寫過日記" };
}
