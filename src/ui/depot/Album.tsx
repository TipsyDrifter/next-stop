/**
 * 印譜帳（車庫與回顧 D-主-217；原型 `albumSection`）：一個月一頁，駅スタンプ照日期一枚枚蓋上去。
 *   - 沒有章的月份不出現；沒有任何章時整段不畫（呼叫端不用判斷，本元件回 null）。
 *   - `‹ ›` 翻頁＝橫向捲動一頁（桌機一屏三頁、手機一屏一頁，也能直接滑）；掛上時停在最新那頁；捲到頭的那顆鈕禁用、全部放得下就不畫翻頁鈕。
 *   - 點車站章／路線章／開業一年章＝開那條路線的記錄簿；其他章不可點。
 */
import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { albumPages } from "../../domain/depotView";
import { fmtMD } from "../../domain/depot";
import type { StampKind, StampRow } from "../../domain/stamps";
import { StampImpression } from "./StampImpression";
import { useStampCtx } from "./depotParts";
import "./depot.css";

export interface AlbumProps {
  stamps: readonly StampRow[];
  onOpen: (routeId: string) => void;
  /** 剛蓋下的章 id（stampIn 動畫） */
  freshIds?: ReadonlySet<string>;
}

/** 印譜帳裡的章大小（原型 sizeOf）與格寬 */
export function albumSize(kind: StampKind): number {
  return kind === "route" || kind === "line" ? 96 : kind === "station" || kind === "route_year" ? 80 : kind === "seals" ? 74 : 78;
}
const cellW = (kind: StampKind) => (kind === "route" || kind === "line" ? 102 : 86);

export function Album({ stamps, onOpen, freshIds }: AlbumProps) {
  const ctx = useStampCtx();
  const pages = albumPages(stamps);
  const ref = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ prev: false, next: false, overflow: false });

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    const next = { overflow: max > 2, prev: el.scrollLeft > 2, next: el.scrollLeft < max - 2 };
    setEdge((cur) => (cur.overflow === next.overflow && cur.prev === next.prev && cur.next === next.next ? cur : next));
  }, []);

  const nPages = pages.length;
  // 掛上與頁數變了：停在最新那頁（最右）
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.scrollBehavior = "auto";
    el.scrollLeft = el.scrollWidth;
    el.style.scrollBehavior = "";
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    for (const c of el.children) ro.observe(c);
    return () => ro.disconnect();
  }, [nPages, measure]);
  // 章數變了（頁寬可能跟著變）也量一次；值沒變時 setEdge 不重畫
  useLayoutEffect(measure, [stamps, measure]);

  if (!nPages) return null;

  const page = (dir: 1 | -1) => {
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>(".ns-depot-apage");
    if (!el || !first) return;
    el.scrollBy({ left: dir * (first.offsetWidth + 16), behavior: "smooth" });
  };

  return (
    <>
      <div className="sec">
        <h3>印譜帳</h3>
        <span className="rule" />
        <span className="note">駅スタンプ {stamps.length} 枚</span>
        {edge.overflow && (
          <span className="ns-depot-pager">
            <button type="button" className="ns-iconbtn" onClick={() => page(-1)} disabled={!edge.prev} aria-label="上一頁" title="上一頁">
              ‹
            </button>
            <button type="button" className="ns-iconbtn" onClick={() => page(1)} disabled={!edge.next} aria-label="下一頁" title="下一頁">
              ›
            </button>
          </span>
        )}
      </div>
      <div className="ns-depot-album" ref={ref} onScroll={measure}>
        {pages.map((pg) => {
          const [y, m] = pg.month.split("-").map(Number);
          return (
            <section key={pg.month} className="ns-depot-apage ns-depot-paper" aria-label={`${y}年${m}月的駅スタンプ`}>
              <header className="ns-depot-apage-h">
                <b>{m}月</b>
                <span className="yr">{y}</span>
                <span className="cnt">{pg.stamps.length} 枚</span>
              </header>
              <div className="ns-depot-astamps">
                {pg.stamps.map((s, i) => {
                  const c = ctx(s);
                  const rid = c.routeId;
                  return (
                    <div key={s.id} className="ns-depot-acell" style={{ "--cw": `${cellW(s.kind)}px` } as CSSProperties}>
                      <StampImpression
                        stamp={s}
                        size={albumSize(s.kind)}
                        index={i}
                        routeCode={c.routeCode}
                        routeName={c.routeName}
                        openedOn={c.openedOn}
                        fresh={freshIds?.has(s.id)}
                        onOpen={rid ? () => onOpen(rid) : undefined}
                      />
                      <span className="dt">{fmtMD(s.stamped_on)}</span>
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}
