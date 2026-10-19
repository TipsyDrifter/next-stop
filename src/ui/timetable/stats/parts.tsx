/**
 * stats/parts——統計頁的小件（乙席）：環比字 `Delta`、迷你長條 `MiniBar`、鍵帽 `Kbd`。
 */
import { useEffect, useState, type CSSProperties } from "react";
import { fmtDelta } from "../../../domain/timetableStats";
import { TT_TEXT } from "../../../store/timetableStore";
import type { Seg } from "./stack";

/**
 * 環比（D-時-49／〈原型定案〉1）：「▲3h10m」「▼45m」「持平」，中性墨色。
 * 桌機滑過看 title、兩殼點一下冒一個小泡「多 3h10m（上期 18h）」（2.6 秒自己收）。
 */
export function Delta({
  ms,
  prevMs,
  showTitle = true,
  inert = false,
}: {
  ms: number;
  prevMs: number;
  showTitle?: boolean;
  /** 放在按鈕裡（依路線的可點列）時用：只留 title、不是可互動元件（不巢狀互動） */
  inert?: boolean;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => setOpen(false), 2600);
    return () => clearTimeout(t);
  }, [open]);
  const text = fmtDelta(ms);
  const tip = TT_TEXT.statsUi.deltaTip(ms, prevMs);
  const flat = text === "持平";
  return (
    <span
      className={"ns-tt-stats-dl" + (flat ? " is-flat" : "")}
      title={showTitle ? tip : undefined}
      role={inert ? undefined : "button"}
      tabIndex={inert ? undefined : -1}
      aria-label={tip}
      onClick={
        inert
          ? undefined
          : (e) => {
              e.stopPropagation();
              setOpen((v) => !v);
            }
      }
    >
      {flat ? (
        text
      ) : (
        <>
          <i aria-hidden="true">{text[0]}</i>
          {text.slice(1)}
        </>
      )}
      {open && (
        <span className="ns-tt-stats-dl-tip" role="status">
          {tip}
        </span>
      )}
    </span>
  );
}

/** 迷你長條（D-時-63：清單頂層列用它代替單色點；趨勢明細的頂層也用） */
export function MiniBar({ segs, className = "" }: { segs: readonly Seg[]; className?: string }) {
  const total = segs.reduce((s, x) => s + x.ms, 0);
  return (
    <span className={"ns-tt-stats-mini" + (className ? " " + className : "")} aria-hidden="true">
      {total > 0 ? (
        segs.map((s) => <i key={s.id} style={{ "--c": s.color, flexGrow: s.ms } as CSSProperties} />)
      ) : (
        <i className="is-empty" />
      )}
    </span>
  );
}

/** 鍵帽（桌機才畫） */
export function Kbd({ k }: { k: string }) {
  return (
    <kbd className="ns-tt-kbd" aria-hidden="true">
      {k}
    </kbd>
  );
}
