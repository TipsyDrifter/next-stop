/**
 * WeekAimsBand——桌機的「本週方針」告示（戊 D-主-262；原型場景 a-today／a-fold／a-plan／a-review／a-week）。
 *
 * 兩個位置、同一個元件：
 *   - 今日頁首下方（`<WeekAimsBand />`）：看今天那週；新的一週第一次打開、上週有方針而且還沒看過回顧 ⇒ 直接換成「上週回顧」（D-主-260）。
 *   - 行程表「週」檢視頂端（`<WeekAimsBand day={週首} wide />`）：看畫面上那一週，四句橫排。
 * 頁首：本週方針・This week・日期 ── 済 d/n［改方針］［回顧這週 ›］（只在這週最後一天）▾。點頁首空白或 ▾ 收合（D-主-259：只記這週、各台自己記）。
 * 每句：一、二…＋那句＋路線標（點了進路線）＋「已排 N 張・済 M／排的票都済了」＋淡淡的「排成車票」（hover 才亮）＋検印小圈／済小章。
 * 沒寫方針＝一行「本週方針 ── 還沒寫這週的方針［寫方針］」，不佔版面。不遊戲化（D-主-264）：沒有連續週數、達成率。
 * 寫方針對話框也掛在這裡（store 的 editor 一開就畫；同頁只會有一張帶子）。
 */
import { useEffect, useState, type CSSProperties } from "react";
import { addDays } from "../../lib/date";
import { aimNumeral, isLastDayOfWeek, weekRangeText, weekRelText } from "../../domain/weekAims";
import { useWeekAimStore } from "../../store/weekAimStore";
import { IconChevron } from "../common/icons";
import { useWeekAims } from "./useWeekAims";
import { AimStamp, PlanLine, RouteTag, aimPlacePath } from "./parts";
import { PlanTicketPop } from "./PlanTicketPop";
import { ReviewBoard } from "./WeekAimsReview";
import { WeekAimsEditorHost } from "./WeekAimsEditor";
import "./weekAims.css";

export function WeekAimsBand({ day, wide = false }: { day?: string | null; wide?: boolean }) {
  const v = useWeekAims(day, !wide);
  const review = useWeekAimStore((s) => s.review);
  const [planFor, setPlanFor] = useState<string | null>(null);

  // 新的一週第一次打開：自動出上週回顧（只今日頁那張；關掉＝看過，store 記本地鍵）
  useEffect(() => {
    if (v.pendingReview && !useWeekAimStore.getState().review) void useWeekAimStore.getState().openReview(v.pendingReview);
  }, [v.pendingReview]);

  const rel = weekRelText(v.weekOn, v.today, v.weekStart);
  const showReview = review && (review.weekOn === v.weekOn || (!wide && review.weekOn === addDays(v.weekOn, -7)));
  const host = <WeekAimsEditorHost today={v.today} weekStart={v.weekStart} />;

  if (showReview) {
    return (
      <>
        <ReviewBoard weekOn={review.weekOn} today={v.today} weekStart={v.weekStart} placeOf={v.placeOf} />
        {host}
      </>
    );
  }

  const title = rel === "這週" ? "本週方針" : `${rel}的方針`;
  const latin = rel === "這週" ? "This week" : "Weekly aims";
  const openEditor = () => useWeekAimStore.getState().openEditor(v.weekOn);
  const toggle = () => void useWeekAimStore.getState().setFolded(v.weekOn, !v.folded);
  const empty = !v.loading && v.aims.length === 0;
  const lastDay = v.weekOn === v.curWeek && isLastDayOfWeek(v.today, v.weekStart);

  if (v.loading) return null;

  if (empty) {
    return (
      <>
        <section className={"wa is-folded" + (wide ? " is-wide" : "")} aria-label={title}>
          <div className="wa-board">
            <div className="wa-head">
              <h3 className="wa-ttl">{title}</h3>
              <span className="wa-latin">{latin}</span>
              <span className="wa-dt">{weekRangeText(v.weekOn)}</span>
              <span className="wa-rule" />
              <span className="wa-empty-note">還沒寫{rel}的方針</span>
              <button type="button" className="ns-btn btn-text ns-btn--sm" aria-haspopup="dialog" onClick={openEditor}>
                寫方針
              </button>
            </div>
          </div>
        </section>
        {host}
      </>
    );
  }

  const { done, total } = v.count;
  const folded = v.folded;
  return (
    <>
      <section
        className={"wa" + (folded ? " is-folded" : "") + (wide ? " is-wide" : "")}
        aria-label={title}
        style={wide ? ({ "--wa-cols": Math.min(Math.max(v.aims.length, 3), 5) } as CSSProperties) : undefined}
      >
        <div className="wa-board">
          <div
            className={"wa-head" + (folded ? " is-click" : "")}
            onClick={(e) => {
              // 收合時整列都能點開；展開時只有 ▾ 收（頁首的按鈕各做各的）
              if (folded && !(e.target as Element).closest("button")) toggle();
            }}
          >
            <h3 className="wa-ttl">{title}</h3>
            <span className="wa-latin">{latin}</span>
            <span className="wa-dt">{weekRangeText(v.weekOn)}</span>
            <span className="wa-rule" />
            <span className="wa-count" title={`済 ${done} 句，共 ${total} 句`}>
              済 <b>{done}</b>/{total}
            </span>
            {!folded && (
              <button type="button" className="ns-btn btn-text ns-btn--sm" aria-haspopup="dialog" onClick={openEditor}>
                改方針
              </button>
            )}
            {/* 回顧：這週最後一天（D-主-260）；行程表翻到過去的週也能回頭看 */}
            {!folded && (lastDay || v.weekOn < v.curWeek) && (
              <button type="button" className="ns-btn btn-text ns-btn--sm" onClick={() => void useWeekAimStore.getState().openReview(v.weekOn)}>
                {lastDay ? "回顧這週 ›" : "回顧 ›"}
              </button>
            )}
            <button
              type="button"
              className="ns-iconbtn wa-caret"
              aria-expanded={!folded}
              aria-label={`${folded ? "展開" : "收起"}${title}`}
              title={folded ? "展開" : "收起"}
              onClick={toggle}
            >
              <IconChevron />
            </button>
          </div>
          {!folded && (
            <ol className="wa-list">
              {v.aims.map((a, i) => {
                const place = v.placeOf(a.node_id);
                const count = a.node_id ? v.planned?.[a.node_id] : undefined;
                const planBtn =
                  a.done_at === null ? (
                    <button
                      type="button"
                      className={"ns-btn btn-text ns-btn--sm wa-plan" + (planFor === a.id ? " is-open" : "")}
                      aria-haspopup="dialog"
                      aria-expanded={planFor === a.id}
                      title={place ? `在「${aimPlacePath(place)}」建一張這週的車票` : "建一張這週的臨時車票"}
                      onClick={() => setPlanFor(planFor === a.id ? null : a.id)}
                    >
                      排成車票
                    </button>
                  ) : (
                    <span />
                  );
                return (
                  <li key={a.id} className={"wa-row" + (a.done_at ? " is-done" : "")}>
                    <span className="wa-num" aria-hidden>
                      {aimNumeral(i)}
                    </span>
                    {wide ? (
                      <>
                        <p className="wa-text">
                          <span className="t">{a.text}</span>
                          {place && <RouteTag place={place} shell="desktop" />}
                        </p>
                        <PlanLine aim={a} count={count} emptyText={a.done_at === null ? "還沒排票" : undefined} />
                        {a.done_at === null && planBtn}
                      </>
                    ) : (
                      <>
                        <div className="wa-main">
                          <p className="wa-text">
                            <span className="t" title={a.text}>
                              {a.text}
                            </span>
                            {place && <RouteTag place={place} shell="desktop" />}
                          </p>
                          <PlanLine aim={a} count={count} />
                        </div>
                        {planBtn}
                      </>
                    )}
                    <AimStamp aim={a} />
                    {planFor === a.id && <PlanTicketPop aim={a} weekOn={v.weekOn} today={v.today} onClose={() => setPlanFor(null)} />}
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </section>
      {host}
    </>
  );
}
