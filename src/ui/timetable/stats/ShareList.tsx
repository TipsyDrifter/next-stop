/**
 * ShareList——占比與環比（③ 契約 §5.2-3；D-時-50、63；乙席）。
 * 一條堆疊長條（子分類色、依頂層一組一組排、組間 1px 紙色縫；只畫已記錄）＋分組清單：
 * 頂層列＝› 展開、迷你長條（它的子分類色）、名稱、時數、百分比（分母＝已記錄）、環比；子分類列＝色點。
 * 點名稱＝趨勢只看那一類（再點取消，選中描金）。0 的分類不列；上期有、本期 0 的照列（時數「0m」）。
 *
 * ⑥（D-時-118、130；丙席）：卡頭多一組「分類｜荷札」分段鈕（`shareBy`，本機記住、兩殼各記；切面時 store 清掉另一種過濾）。
 * 「荷札」那一面的卡身＝`TagShareRows`（不畫堆疊長條）；分類這一面照舊，過濾改讀 `filter`（`{kind:"cat"}` 才算這一面的選中）。
 */
import { useState, type CSSProperties } from "react";
import { fmtDur } from "../../../domain/timetable";
import { fmtPct, type StatsResult } from "../../../domain/timetableStats";
import { TT_TEXT } from "../../../store/timetableStore";
import { useTimetableStatsStore } from "../../../store/timetableStatsStore";
import { catColor, useCatById } from "./format";
import { Delta, MiniBar } from "./parts";
import { groupSegs } from "./stack";
import { TagShareRows } from "./TagShareRows";

export function ShareList({ r, desktop }: { r: StatsResult; desktop: boolean }) {
  const catById = useCatById();
  const f = useTimetableStatsStore((s) => s.filter);
  const setFilter = useTimetableStatsStore((s) => s.setFilter);
  const shareBy = useTimetableStatsStore((s) => s.shareBy);
  const setShareBy = useTimetableStatsStore((s) => s.setShareBy);
  const filter = f && f.kind === "cat" ? f.id : null;
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [justOpened, setJustOpened] = useState<string | null>(null);
  const T = TT_TEXT.statsUi;
  const rec = r.cur.recordedMs;
  const nameOf = (id: string): string => catById[id]?.name ?? T.catGone;
  const live = r.groups.filter((g) => g.ms > 0);

  const toggleFilter = (id: string): void => setFilter(filter === id ? null : { kind: "cat", id });
  const TG = TT_TEXT.tags;

  const head = (
    <div className="ns-tt-stats-ch ns-tt-stats-shch">
      <h3>{T.shareTitle}</h3>
      <span className="ns-tt-stats-seg ns-tt-stats-shseg" role="group" aria-label={TG.shareGroup}>
        {(["cat", "tag"] as const).map((k) => (
          <button type="button" key={k} aria-pressed={shareBy === k} className={shareBy === k ? "is-on" : ""} onClick={() => setShareBy(k)}>
            {k === "cat" ? TG.shareCat : TG.shareTag}
          </button>
        ))}
      </span>
      <span className="ns-tt-stats-ch-note">{T.shareNote(TT_TEXT.statsCompare(r.period, r.compare === "sameSpan"))}</span>
    </div>
  );

  if (shareBy === "tag") {
    return (
      <section className="ns-tt-stats-card ns-tt-stats-share is-tag">
        {head}
        <TagShareRows r={r} desktop={desktop} />
      </section>
    );
  }

  return (
    <section className="ns-tt-stats-card ns-tt-stats-share">
      {head}
      <div className="ns-tt-stats-sbar" role="img" aria-label={live.map((g) => `${nameOf(g.id)} ${fmtPct(g.ms, rec)}`).join("、")}>
        {live.map((g) => (
          <span key={g.id} className="ns-tt-stats-sgrp" style={{ flexGrow: g.ms }}>
            {groupSegs(g, catById).map((s) => (
              <i key={s.id} style={{ "--c": s.color, flexGrow: s.ms } as CSSProperties} title={`${nameOf(s.id)} ${fmtDur(s.ms)}・${fmtPct(s.ms, rec)}`} />
            ))}
          </span>
        ))}
      </div>
      <div className="ns-tt-stats-list" role="list">
        {r.groups.map((g) => {
          const isOpen = !!open[g.id];
          const hasKids = g.children.length > 0;
          return (
            <div key={g.id} role="listitem">
              <div className={"ns-tt-stats-row is-top" + (filter === g.id ? " is-sel" : "") + (isOpen ? " is-open" : "")}>
                {hasKids ? (
                  <button
                    type="button"
                    className="ns-tt-stats-exp"
                    aria-expanded={isOpen}
                    aria-label={isOpen ? T.collapseKids : T.expandKids}
                    onClick={() => {
                      setOpen((o) => ({ ...o, [g.id]: !o[g.id] }));
                      setJustOpened(isOpen ? null : g.id);
                    }}
                  >
                    <i>›</i>
                  </button>
                ) : (
                  <span className="ns-tt-stats-exp is-blank" />
                )}
                <button
                  type="button"
                  className="ns-tt-stats-rname"
                  aria-pressed={filter === g.id}
                  title={desktop ? (filter === g.id ? T.filterOff : T.filterOn) : undefined}
                  onClick={() => toggleFilter(g.id)}
                >
                  <MiniBar segs={groupSegs(g, catById)} />
                  <span>{nameOf(g.id)}</span>
                </button>
                <span className="ns-tt-stats-rv ns-tt-num">{fmtDur(g.ms)}</span>
                <span className="ns-tt-stats-rp ns-tt-num">{fmtPct(g.ms, rec)}</span>
                <span className="ns-tt-stats-rd ns-tt-num">
                  <Delta ms={g.ms - g.prevMs} prevMs={g.prevMs} showTitle={desktop} />
                </span>
              </div>
              {isOpen && (
                <div className={"ns-tt-stats-kids" + (justOpened === g.id ? " is-new" : "")}>
                  {g.children.map((c) => (
                    <div key={c.id} className={"ns-tt-stats-row is-kid" + (filter === c.id ? " is-sel" : "")}>
                      <span className="ns-tt-stats-exp is-blank" />
                      <button
                        type="button"
                        className="ns-tt-stats-rname"
                        aria-pressed={filter === c.id}
                        title={desktop ? (filter === c.id ? T.filterOff : T.filterOn) : undefined}
                        onClick={() => toggleFilter(c.id)}
                      >
                        <i className="ns-tt-stats-dot" style={{ "--c": catColor(catById[c.id]) } as CSSProperties} aria-hidden="true" />
                        <span>{nameOf(c.id)}</span>
                      </button>
                      <span className="ns-tt-stats-rv ns-tt-num">{fmtDur(c.ms)}</span>
                      <span className="ns-tt-stats-rp ns-tt-num">{fmtPct(c.ms, rec)}</span>
                      <span className="ns-tt-stats-rd ns-tt-num">
                        <Delta ms={c.ms - c.prevMs} prevMs={c.prevMs} showTitle={desktop} />
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p className="ns-tt-stats-foot">{T.shareFoot}</p>
    </section>
  );
}
