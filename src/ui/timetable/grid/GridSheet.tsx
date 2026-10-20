/**
 * GridSheet——方眼紙本體（⑤ 契約 §5.2、0-4；D-時-93、94、100、105；〈原型定案〉2、3、4；乙席）。
 * 長相＝原型 prototypes/時刻表-src/v-i.js gridHtml／colHeadHtml（.vi-sheet／.vi-rows／.vi-band…）→ 正式版 `.ns-tt-grid-*`（timetable.css §M）。
 *
 *   div.ns-tt-grid-sheet[.is-desk]
 *   ├ div.ns-tt-grid-colhead     時刻欄空白＋每格邊界的分（10 分格 :00 :10…；5 分只標 :00 :15 :30 :45；一列 2 小時「:00 :30 +1h :30」）
 *   └ div.ns-tt-grid-rows        24（或 12）列、撐滿高度；拖曳的指標事件掛這裡（GridView 給 handlers）
 *       └ div.ns-tt-grid-row[.is-nowrow][.is-noon]
 *           ├ span.ns-tt-grid-hr  列頭時刻（HH，日界線起）
 *           └ div.ns-tt-grid-track（格子；淡墨底）
 *               div.ns-tt-grid-fut   現在以後：極淡橫紋
 *               i.ns-tt-grid-band    色帶（照實際起訖；跨列折行；.is-pend 斜紋／.is-live 慢呼吸／.is-tiny 最少 2px／.is-cp .is-cn 不畫圓角）
 *               div.ns-tt-grid-lines 格線＝紙色的縫，疊在色帶上（細縫每格、粗縫每 15／30 分）
 *               div.ns-tt-grid-sl    選區（虛線＝拖到的格子、實心金＝真正會寫的那段）——RowSel 自己訂 useSelOverlayStore
 *               div.ns-tt-grid-now   現在線（朱色豎線＋菱形）
 *
 * 色帶上的字照實寬決定（＝原型）：≥13px 放圓牌字；桌機 ≥58px 加名稱；這一塊在這一天開頭那列（head）≥104px 再加起點時刻。
 *
 * 效能（沙盒 F1：200 塊、5 分格）：選區不從 props 進來——每一列的 `RowSel` 訂 `useSelOverlayStore` 自己那一列的字串，
 * 拖曳時 GridSheet 本身不重畫（props＝memo 過的 day、穩定的 handlers 與量到的尺寸）；`Band` 也是 memo、props 全是原始值，
 * 量到軌道寬（第一次掛上）或 now 每分鐘一跳時，只有長相真的變了的色帶重畫。
 */
import { memo, type CSSProperties, type RefObject } from "react";
import { colorSlot, fmtClock, MIN } from "../../../domain/timetable";
import type { RowRun } from "../../../domain/timetableGrid";
import { TT_TEXT } from "../../../store/timetableStore";
import { HOUR, pad2, pct, rowSelKey, useSelOverlayStore, type GridDay } from "./gridModel";
import type { GridDragHandlers } from "./useGridDrag";

export interface GridSheetProps {
  day: GridDay;
  dragging: boolean;
  rowsRef: RefObject<HTMLDivElement | null>;
  handlers: GridDragHandlers;
  /** 量到的軌道寬（px；色帶放不放字用）；還沒量到＝null */
  trackPx: number | null;
  /** 量到的列高（px；< 14 ⇒ .is-tight 字縮小） */
  rowPx: number | null;
}

/** 欄頭的刻度（〈原型定案〉4） */
function colHeadMarks(rowMs: number, cellMin: number): { left: string; label: string; hour: boolean }[] {
  const two = rowMs === 2 * HOUR;
  const step = two ? 30 : cellMin === 5 ? 15 : cellMin;
  const n = Math.round(rowMs / MIN / step);
  const out: { left: string; label: string; hour: boolean }[] = [];
  for (let i = 0; i < n; i++) {
    const m = i * step;
    const label = two && m >= 60 ? (m === 60 ? "+1h" : ":" + pad2(m - 60)) : ":" + pad2(m);
    out.push({ left: ((i / n) * 100).toFixed(3) + "%", label, hour: m % 60 === 0 && m > 0 });
  }
  return out;
}

interface BandProps {
  x0: number;
  x1: number;
  /** 分類色槽（colorSlot 的結果） */
  slot: number;
  glyph: string | null;
  name: string | null;
  start: string | null;
  pend: boolean;
  running: boolean;
  tiny: boolean;
  cp: boolean;
  cn: boolean;
}

/** 一段色帶；props 全是原始值（字放不放、起點時刻由 GridSheet 依實寬算好），memo 才擋得住 */
const Band = memo(function Band({ x0, x1, slot, glyph, name, start, pend, running, tiny, cp, cn }: BandProps) {
  const style = { left: pct(x0), width: pct(x1 - x0), "--c": `var(--ns-tt-cat-${slot})` } as CSSProperties;
  const cls =
    "ns-tt-grid-band" +
    (pend ? " is-pend" : "") +
    (running ? " is-live" : "") +
    (tiny ? " is-tiny" : "") +
    (cp ? " is-cp" : "") +
    (cn ? " is-cn" : "");
  return (
    <i className={cls} style={style}>
      {glyph !== null && <b>{glyph}</b>}
      {name !== null && (
        <span>
          {name}
          {start !== null && <small className="ns-tt-num">{start}</small>}
        </span>
      )}
    </i>
  );
});

function bandProps(run: RowRun, day: GridDay, trackPx: number): BandProps {
  const cat = day.catById[run.categoryId] ?? null;
  const wp = (run.x1 - run.x0) * trackPx;
  const start = day.startOf[run.blockId];
  const showName = day.isDesk && wp >= 58;
  return {
    x0: run.x0,
    x1: run.x1,
    slot: colorSlot(cat?.color_idx ?? 8),
    glyph: wp >= 13 ? (cat ? (cat.glyph ?? Array.from(cat.name)[0] ?? "・") : "？") : null,
    name: showName ? (cat?.name ?? "？") : null,
    start: showName && run.head && wp >= 104 && start !== undefined ? fmtClock(start) : null,
    pend: day.pending.has(run.blockId),
    running: run.running,
    tiny: run.tiny,
    cp: run.contPrev,
    cn: run.contNext,
  };
}

/** 一列的選區（虛線＝拖到的格子、實心金＝真正會寫的那段）：只訂自己這一列的字串，拖曳時沒碰到的列不重畫 */
const RowSel = memo(function RowSel({ rs, re }: { rs: number; re: number }) {
  const key = useSelOverlayStore((st) => rowSelKey(st.ov, rs, re));
  if (!key) return null;
  const [raw, solid, live] = key.split("|");
  const piece = (v: string, cls: string, k: string) => {
    if (!v) return null;
    const [left, width] = v.split(",");
    return <i key={k} className={cls} style={{ left, width }} />;
  };
  return (
    <>
      {piece(raw, "is-raw", "r")}
      {piece(solid, "is-sel" + (live ? " is-live" : ""), "s")}
    </>
  );
});

export const GridSheet = memo(function GridSheet({ day, dragging, rowsRef, handlers, trackPx, rowPx }: GridSheetProps) {
  const { gw, now } = day;
  const L = gw.rowMs;
  const marks = colHeadMarks(L, day.cellMin);
  const major = Math.max(1, Math.round(L / (day.cellMin === 5 ? 15 * MIN : day.cellMin === 30 ? L : 30 * MIN)));
  const nowRow = now < gw.start ? -1 : now >= gw.end ? gw.rows : Math.floor((now - gw.start) / L);
  const byRow: RowRun[][] = Array.from({ length: gw.rows }, () => []);
  for (const r of day.runs) byRow[r.row]?.push(r);
  // 軌道寬還沒量到（第一次掛上）⇒ 這一輪先不畫色帶：GridView 的 layout effect 量完馬上重畫（畫面出來之前），
  // 色帶只建一次、字放不放一次就對（不先用猜的寬建 217 條、量完再改一輪；沙盒 F1）
  const tpx = trackPx;
  const linesStyle = { "--n": day.cpr, "--m": major } as CSSProperties;

  return (
    <div className={"ns-tt-grid-sheet" + (day.isDesk ? " is-desk" : "")}>
      <div className="ns-tt-grid-colhead" aria-hidden="true">
        <span />
        <div className="ns-tt-grid-colhead-t ns-tt-num">
          {marks.map((m) => (
            <span key={m.left} className={m.hour ? "is-h" : undefined} style={{ left: m.left }}>
              {m.label}
            </span>
          ))}
        </div>
      </div>
      <div
        ref={rowsRef}
        className={"ns-tt-grid-rows" + (rowPx !== null && rowPx < 14 ? " is-tight" : "") + (dragging ? " is-dragging" : "")}
        style={{ "--rows": gw.rows } as CSSProperties}
        role="application"
        aria-label={TT_TEXT.gridFoot(day.isDesk)}
        {...handlers}
      >
        {byRow.map((runs, r) => {
          const rs = gw.start + r * L;
          const re = Math.min(gw.end, rs + L);
          const hh = new Date(rs).getHours();
          const isNow = r === nowRow;
          const nowX = isNow ? pct((now - rs) / L) : null;
          return (
            <div key={r} className={"ns-tt-grid-row" + (isNow ? " is-nowrow" : "") + (hh === 12 ? " is-noon" : "")}>
              <span className="ns-tt-grid-hr ns-tt-num">{pad2(hh)}</span>
              <div className="ns-tt-grid-track">
                {r >= nowRow && <div className="ns-tt-grid-fut" style={{ left: nowX ?? 0 }} />}
                {tpx !== null && runs.map((run) => <Band key={run.blockId + ":" + r} {...bandProps(run, day, tpx)} />)}
                <div className="ns-tt-grid-lines" style={linesStyle} />
                <div className="ns-tt-grid-sl">
                  <RowSel rs={rs} re={re} />
                </div>
                {isNow && nowX !== null && (
                  <div className="ns-tt-grid-now" style={{ left: nowX }}>
                    <b />
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
});
