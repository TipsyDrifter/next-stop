/**
 * MonthHeaderNotes——頁首的「頁邊手寫＋統計列」（M3 ⑤ WP5）。
 *
 * 擺放位置：本元件回傳的 fragment 掛在 `.date-line` 之內（CalendarView），`.margin-note` 因此自然
 *   接在「September」後面（原型 :887），`.month-stats` 由 calendar.css 的 `flex-basis:100%` 換到
 *   下一行（等效原型 :454 `margin-top:10px`）。樣式（含粉彩／銀河的分工）都在 calendar.css :446-463。
 *
 * 手寫定量（規格 §6）：**粉彩只有頁邊手寫、銀河只有手寫統計**，兩者不重疊。
 *   - 頁邊手寫（粉彩，原型 :887「12日 mockup 締切」）＝本區間內今天（含）以後最近的一個未完成締切；
 *     沒有就不畫——手寫是「真的有事」才寫的一筆，不是版面裝飾（§6：載真資料、不做標語）。
 *   - 統計列文案逐字＝原型 :889-892：粉彩「完成 X/Y・締切 N 件」／銀河「蓋了 X 張，還有 Y 班・締切 N 件」。
 *     X＝done、Y（粉彩）＝total、Y（銀河）＝open＝total−done−skipped、N＝區間內未完成締切件數
 *     （＝各格〆 的加總，與格角〆 同一把尺）。
 *
 * 口徑一律取 `useCalendar().stats`（controller 只計落在 `range` 內的，換月不會閃到上一區間的數字）。
 */
import { useMemo } from "react";
import { useCalendar } from "./useCalendarController";

export interface MonthHeaderNotesProps {
  /** 目前視圖的資料區間（月＝1 日～月底、週＝一～日） */
  range: { from: string; to: string };
  /** 日界線今天（跨 03:00 重算） */
  today: string;
}

/** 頁邊是一行手寫，長票名會把日期行撐歪——超過就收尾（手寫本來就是簡寫） */
const NOTE_MAX = 12;

export function MonthHeaderNotes({ range, today }: MonthHeaderNotesProps) {
  const { byDate, nodes, stats } = useCalendar();
  const { total, done, open, dues } = stats;

  /** 區間內、今天（含）以後最近的一個未完成締切（`byDate.dues` 只含未完成，含無執行日的票） */
  const next = useMemo(() => {
    const from = range.from > today ? range.from : today;
    const day = Object.keys(byDate.dues)
      .filter((d) => d >= from && d <= range.to && byDate.dues[d].length > 0)
      .sort()[0];
    if (!day) return null;
    const name = nodes[byDate.dues[day][0].node_id]?.name;
    if (!name) return null;
    return {
      day: Number(day.slice(8, 10)),
      name: name.length > NOTE_MAX ? `${name.slice(0, NOTE_MAX)}…` : name,
      full: name,
    };
  }, [byDate.dues, nodes, range.from, range.to, today]);

  return (
    <>
      {/* 頁邊手寫（粉彩；銀河由 calendar.css 隱藏） */}
      {next && (
        <span className="margin-note" title={`${next.day}日 ${next.full} 締切`}>
          {next.day}日 {next.name} 締切
        </span>
      )}

      <p className="month-stats">
        <span className="theme-pastel-only">
          完成{" "}
          <b>
            {done}/{total}
          </b>
          <span className="sep">・</span>締切 <b>{dues} 件</b>
        </span>
        <span className="theme-galaxy-only">
          蓋了 <b>{done}</b> 張，還有 <b>{open}</b> 班<span className="sep">・</span>締切 <b>{dues}</b> 件
        </span>
      </p>
    </>
  );
}
