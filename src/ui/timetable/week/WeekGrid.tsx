/**
 * WeekGrid——週視圖的格子（③ 契約 §5.5、0-10；D-時-54、66；丙席）。兩殼共用 DOM，差異在 CSS 與標籤長短。
 * 長相＝原型 `prototypes/時刻表-src/v-g.js` weekHtml（`.vg-w*`）→ 正式版 `.ns-tt-week-*`（timetable.css §K）。
 *
 *   div.ns-tt-week-grid
 *   ├ div.ns-tt-week-head      角落＋7 個 div.ns-tt-week-h（「週一」＋「10/13」＋那天已記錄時數；今天赭字＋赭菱形〔UI 丙-4 D8〕、未來淡掉）
 *   └ div.ns-tt-week-body      高＝24 × 每小時（桌機 20px、手機 28px），整天不捲
 *       ├ div.ns-tt-week-hrs   日界線起每 3 小時一個時刻
 *       ├ 7 × div.ns-tt-week-col[.is-today]
 *       │    i（每 3 小時一條虛線）、div.ns-tt-week-fut（現在以後極淡橫紋）、
 *       │    button.ns-tt-week-gap（空白：點了補記那段）、button.ns-tt-week-b[.is-pend|.is-live|.is-tiny]（塊）、
 *       │    div.ns-tt-week-now（今天那欄的現在線）
 *       └ div.ns-tt-week-tip.techo-card   桌機滑過一塊的 tooltip（手機不出，點塊直接跳軸——§5.11 替代；UI 丙-4 D4 材質＝.techo-card）
 *
 * 位置一律用百分比（相對那天的窗），塊最小 2px 高（CSS）；運行中那塊長到 `now`。資料是 `WeekResult`（統計 store 算好的）。
 */
import { useRef, useState, type CSSProperties } from "react";
import { MIN, colorSlot, fmtClock, fmtDur, type AxisItem } from "../../../domain/timetable";
import type { WeekResult } from "../../../store/timetableStatsStore";
import { TT_TEXT, useTimetableStore } from "../../../store/timetableStore";
import { useUiStore } from "../../../store/uiStore";

export type WeekBlockItem = Extract<AxisItem, { kind: "block" }>;

export interface WeekGridProps {
  week: WeekResult;
  shell: "desktop" | "mobile";
  /** 畫面上的現在（每分鐘跳；現在線、未來橫紋、運行中那塊的長度用它） */
  now: number;
  onBlock(dateKey: string, it: WeekBlockItem): void;
  onGap(from: number, to: number): void;
}

const HOUR = 60 * MIN;
const pad2 = (n: number): string => (n < 10 ? "0" + n : String(n));
const pct = (x: number): string => (Math.max(0, Math.min(1, x)) * 100).toFixed(3) + "%";

function mdOf(key: string): string {
  const [, m, d] = key.split("-").map(Number);
  return `${m}/${d}`;
}

function weekdayOf(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).getDay();
}

interface Tip {
  text: string;
  x: number;
  y: number;
  below: boolean;
}

export function WeekGrid({ week, shell, now, onBlock, onGap }: WeekGridProps) {
  const catById = useTimetableStore((s) => s.catById);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const isDesk = shell === "desktop";
  const hourPx = isDesk ? 20 : 28;
  const pending = new Set(week.pendingIds);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const T = TT_TEXT.weekUi;

  const showTip = (el: HTMLElement, text: string): void => {
    const body = bodyRef.current;
    if (!isDesk || !body) return;
    const br = body.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const x = Math.max(80, Math.min(br.width - 80, r.left + r.width / 2 - br.left));
    const top = r.top - br.top;
    setTip(top < 40 ? { text, x, y: r.bottom - br.top, below: true } : { text, x, y: top, below: false });
  };

  const hours: number[] = [];
  for (let i = 0; i < 24; i += 3) hours.push(i);

  return (
    <div className={"ns-tt-week-grid" + (isDesk ? " is-desk" : "")} style={{ "--ns-tt-week-hpx": hourPx + "px" } as CSSProperties}>
      <div className="ns-tt-week-head">
        <span className="ns-tt-week-corner" aria-hidden="true" />
        {week.days.map((d) => {
          const future = d.start > now;
          return (
            <div key={d.dateKey} className={"ns-tt-week-h" + (d.isToday ? " is-today" : "") + (future ? " is-future" : "")}>
              <span className="ns-tt-week-hd">
                <b>{T.weekdays[weekdayOf(d.dateKey)]}</b>
                <span className="ns-tt-num">{mdOf(d.dateKey)}</span>
              </span>
              <span className="ns-tt-week-hsum ns-tt-num">{future || d.recordedMs < MIN ? " " : fmtDur(d.recordedMs)}</span>
            </div>
          );
        })}
      </div>

      <div className="ns-tt-week-body" ref={bodyRef} onPointerLeave={() => setTip(null)}>
        <div className="ns-tt-week-hrs" aria-hidden="true">
          {hours.map((i) => (
            <span key={i} className="ns-tt-num" style={{ top: pct(i / 24) }}>
              {pad2((dayStartHour + i) % 24)}
            </span>
          ))}
        </div>

        {week.days.map((d) => {
          const D = d.end - d.start;
          const at = (t: number): number => (t - d.start) / D;
          return (
            <div key={d.dateKey} className={"ns-tt-week-col" + (d.isToday ? " is-today" : "")}>
              {hours.slice(1).map((i) => (
                <i key={i} style={{ top: pct(i / 24) }} aria-hidden="true" />
              ))}
              {now < d.end && <div className="ns-tt-week-fut" style={{ top: pct(at(now)) }} aria-hidden="true" />}

              {d.items.map((it) => {
                if (it.kind === "gap") {
                  const label = T.gapTip(fmtClock(it.from), fmtClock(it.to), fmtDur(it.to - it.from));
                  return (
                    <button
                      type="button"
                      key={"g" + it.from}
                      className="ns-tt-week-gap"
                      style={{ top: pct(at(it.from)), height: pct((it.to - it.from) / D) }}
                      aria-label={label}
                      onPointerEnter={() => setTip(null)}
                      onClick={() => onGap(it.from, it.to)}
                    />
                  );
                }
                const s = it.span;
                const cat = catById[s.categoryId];
                const name = cat?.name ?? "？";
                const to = it.running ? Math.min(now, d.end) : it.to;
                const whole = (s.end ?? now) - s.start;
                const isPend = pending.has(s.id);
                const isTiny = whole < MIN;
                const hpx = ((to - it.from) / HOUR) * hourPx;
                const label = T.blockTip(name, fmtClock(s.start), s.end === null ? T.running : fmtClock(s.end), fmtDur(whole), isPend, isTiny);
                const showName = hpx >= 15;
                const tall = isDesk && hpx >= 34;
                const style = {
                  top: pct(at(it.from)),
                  height: pct((to - it.from) / D),
                  "--c": `var(--ns-tt-cat-${colorSlot(cat?.color_idx ?? 8)})`,
                } as CSSProperties;
                return (
                  <button
                    type="button"
                    key={s.id + ":" + it.from}
                    className={
                      "ns-tt-week-b" +
                      (isPend ? " is-pend" : "") +
                      (it.running ? " is-live" : "") +
                      (isTiny || it.zero ? " is-tiny" : "") +
                      (tall ? " is-tall" : "")
                    }
                    style={style}
                    aria-label={label}
                    onPointerEnter={(e) => showTip(e.currentTarget, label)}
                    onClick={() => onBlock(d.dateKey, it)}
                  >
                    {showName && <span>{isDesk ? name : (cat?.glyph ?? Array.from(name)[0])}</span>}
                    {tall && <small className="ns-tt-num">{fmtClock(s.start)}</small>}
                  </button>
                );
              })}

              {now >= d.start && now < d.end && (
                <div className="ns-tt-week-now" style={{ top: pct(at(now)) }} aria-hidden="true">
                  <b />
                </div>
              )}
            </div>
          );
        })}

        {isDesk && (
          <div
            className={"ns-tt-week-tip techo-card" + (tip ? " is-on" : "") + (tip?.below ? " is-below" : "")}
            style={tip ? { left: tip.x + "px", top: tip.y + "px" } : undefined}
            aria-hidden="true"
          >
            {tip?.text}
          </div>
        )}
      </div>
    </div>
  );
}
