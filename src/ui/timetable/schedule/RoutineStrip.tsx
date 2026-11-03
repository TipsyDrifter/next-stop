/**
 * RoutineStrip——日程預定欄最左的作息窄帶（⑦ 契約 §3〈畫面〉；原型回報 1：A 案；原型 `.ns-tt-rt*`；C 席）。兩殼共用 DOM。
 *
 *   div.ns-tt-rt-strip（桌機 80px、手機 48px；寬度由 schedule7.css 的 --rt-w 給，預定欄的 lanes 同時往右讓出這一條）
 *     button.ns-tt-rt[.is-short|.is-future|.is-open|.is-live]（左緣 3px 分類色條＋淡分類底；跟車票卡分開、不搶 lane）
 *       span.ns-tt-rt-n   名字（段自己的名字，沒有就分類名；segName）
 *       span.ns-tt-rt-t   起訖（只有桌機、段夠高才印）
 *       span.ns-tt-rt-r   短說法：桌機「準點」「晚 20 分」＋「少 30 分」、「沒記到」；手機「準點」「晚 20」「沒記」（✎5，不用 ◆）
 *
 * 完整句子（fmtRoutineDelta）在 title 與面板。段可以重疊（✎3：照樣疊，不並排）。點一段＝開它的小面板（sheet routine；兩殼都一下就開——
 * 窄帶放不下「打開 ›」，車票卡那套「先點亮再打開」不適用）。挑位置／拖曳時整條不吃指標（點下去落到預定欄排時刻，原型回報 1）。
 * 那天沒有作息 ⇒ 呼叫端不畫這一條（ScheduleGrid 的 hasRoutine）。
 */
import type { CSSProperties } from "react";
import { colorSlot } from "../../../domain/timetable";
import { fmtRoutineDelta, segName } from "../../../domain/timetableRoutine";
import { clockMinutes } from "../../../lib/date";
import { useTimetableStore } from "../../../store/timetableStore";
import { minFrac, pct } from "./scheduleModel";
import { rtShortLines } from "./routineModel";
import type { SchedulePage } from "./useSchedulePage";
import "./schedule7.css";

export function RoutineStrip({ page, hourPx, swallowClick }: { page: SchedulePage; hourPx: number; swallowClick(): boolean }) {
  const catById = useTimetableStore((s) => s.catById);
  const { routineDay, routineCmp, dayStartHour, shell, openRoutineId, picked } = page;
  if (!routineDay || !routineDay.segs.length) return null;
  const desk = shell === "desktop";

  return (
    <div className={"ns-tt-rt-strip" + (picked ? " is-passive" : "")} role="group" aria-label="作息">
      {routineDay.segs.map((g) => {
        const s = clockMinutes(g.s);
        const e = clockMinutes(g.e);
        if (s === null || e === null || e <= s) return null;
        const cat = g.cat ? catById[g.cat] : undefined;
        const name = segName(g, cat?.name ?? null) ?? "？";
        const c = routineCmp.get(g.id);
        const hpx = ((e - s) / 60) * hourPx - 2;
        const short = hpx < (desk ? 30 : 26);
        const lines = c ? rtShortLines(c, desk) : [];
        // 夠高才印第二行（桌機 ≥40px、手機 ≥44px）；短段：桌機把第一行接在名字後，手機 48px 放不下兩個詞 ⇒ 只留名字（實機截圖：「早… 準…」）
        const shown = short ? (desk ? lines.slice(0, 1) : []) : lines.slice(0, hpx >= (desk ? 40 : 44) ? 2 : 1);
        const full = c ? fmtRoutineDelta(c) : null;
        const title = `${name}　${g.s}–${g.e}${full ? "・" + full : ""}`;
        const style = {
          "--c": `var(--ns-tt-cat-${colorSlot(cat?.color_idx ?? 8)})`,
          top: `calc(${pct(minFrac(s, dayStartHour))} + 1px)`,
          height: `calc(${pct((e - s) / 1440)} - 2px)`,
        } as CSSProperties;
        const cls =
          "ns-tt-rt" +
          (short ? " is-short" : "") +
          (c?.state === "upcoming" ? " is-future" : "") +
          (c?.state === "running" ? " is-live" : "") +
          (openRoutineId === g.id ? " is-open" : "");
        return (
          <button
            type="button"
            key={g.id}
            className={cls}
            style={style}
            title={title}
            aria-label={title}
            data-rt-id={g.id}
            onClick={(ev) => {
              ev.stopPropagation();
              if (swallowClick()) return;
              page.openRoutine(g.id);
            }}
          >
            <span className="ns-tt-rt-n">{name}</span>
            {desk && !short && hpx >= 54 && (
              <span className="ns-tt-rt-t ns-tt-num">
                {g.s}–{g.e}
              </span>
            )}
            {shown.map((l, i) => (
              <span key={i} className={"ns-tt-rt-r is-" + l.tone}>
                {l.t}
              </span>
            ))}
          </button>
        );
      })}
    </div>
  );
}
