/**
 * AimsBand——桌機的方針告示（戊 D-主-262；方針擴充 辛 §7；原型場景 one-*／shared-*）。一張告示，吃任何期間鍵。
 *
 * 位置與開關：
 *   - 今日頁首下方（`TodayAimsBand`）：`ribbon`＋`autoReview`。最下面一行露出另外兩層，切過去只活在這次打開（D-主-377），頭上多「回本週」；
 *     新的一期第一次打開 ⇒ 依 `pendingReviewKeys` 週→月→年一次一張回顧，關掉才出下一張（D-主-373）。
 *   - 行程表（`wide`）：月視圖看畫面那個月；週檢視看那一週；時段檢視 `pinFolded` 固定收合、可展開（D-主-379，不寫收合記憶）。
 *   - 車庫年鑑（`navigable`）：頭上 ‹ 年 › 只換告示那一年（D-主-378）。
 *   - 車站：`aimKey={stationKeyOf(id)}`，頭上寫站名・日期；沒有 ‹ ›。路線頁給 `heading="下一站方針"`：標題換字、前面一枚 ◎、不畫拉丁小字。
 * 頁首：標題・拉丁・日期 ── 済 d/n［改方針］［回顧…］▾。點頁首空白或 ▾ 收合（D-主-259：只記這一期、各台自己記）。
 * 每句：一、二…＋那句＋路線標（點了進路線）＋「已排 N 張・済 M／排的票都済了」＋淡淡的「排成車票」（hover 才亮）＋検印小圈／済小章。
 * 沒寫方針＝一行「還沒寫…的方針［寫方針］」，不佔版面。不遊戲化（D-主-264、376）：沒有連續期數、達成率。
 * 寫方針對話框也掛在這裡（store 的 editor 一開就畫；同頁有好幾個 host 時只有排第一的畫，見 WeekAimsEditorHost）。
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  adjacentKey,
  aimNumeral,
  currentKeyOf,
  isLastDayOfPeriod,
  isPastPeriod,
  periodOfKey,
  periodShortLabel,
  periodStepText,
  type ReviewPeriod,
} from "../../domain/weekAims";
import { useWeekAimStore } from "../../store/weekAimStore";
import { IconBack, IconChevron } from "../common/icons";
import { useAimView, usePendingReviews } from "./useWeekAims";
import { AimStamp, PlanLine, RouteTag, StationMark, aimPlacePath } from "./parts";
import { AimsRibbon } from "./AimsRibbon";
import { PlanTicketPop } from "./PlanTicketPop";
import { ReviewBoard } from "./WeekAimsReview";
import { WeekAimsEditorHost } from "./WeekAimsEditor";
import "./weekAims.css";

export interface AimsBandProps {
  /** 期間鍵（週首／M…／Y…／S<車站 id>） */
  aimKey: string;
  /** 行程表橫排 */
  wide?: boolean;
  /** 今日那張：最下面一行露出另外兩層（§7 AimsRibbon），切到別期時頭上多「回本週」 */
  ribbon?: boolean;
  /** 今日那張：新的一期自動排隊出回顧（D-主-373） */
  autoReview?: boolean;
  /** 頭上 ‹ › 翻期，只換這張告示（年鑑 D-主-378）；車站沒有 */
  navigable?: boolean;
  /** 固定收合、可展開，不寫收合記憶（時段檢視 D-主-379） */
  pinFolded?: boolean;
  /** 換掉標題字（路線頁「下一站方針」）：前面一枚 ◎、不畫拉丁小字 */
  heading?: string;
}

export function AimsBand({ aimKey, wide = false, ribbon = false, autoReview = false, navigable = false, pinFolded = false, heading }: AimsBandProps) {
  // 翻期只活在這張告示；外面換了 aimKey（換頁、跨年）就回外面給的那一期
  const [nav, setNav] = useState<{ base: string; key: string } | null>(null);
  const wanted = nav && nav.base === aimKey ? nav.key : aimKey;

  // 翻月、翻年時新那一期載到之前先留著上一期：告示不會空一下、底下的格子不會跳
  const wantedLoaded = useWeekAimStore((s) => s.weeks[wanted] !== undefined);
  const shown = useRef(wanted);
  if (wantedLoaded) shown.current = wanted;
  const key = shown.current;
  useEffect(() => {
    if (wanted !== shown.current) void useWeekAimStore.getState().loadWeek(wanted);
  }, [wanted]);

  const v = useAimView(key);
  const review = useWeekAimStore((s) => s.review);
  const [planFor, setPlanFor] = useState<string | null>(null);
  const [pinOpen, setPinOpen] = useState(false);
  const pending = usePendingReviews(autoReview);
  const nextReview = pending[0] ?? null;

  // 新的一期第一次打開：排隊的回顧一次一張（只今日那張；關掉＝看過，store 記本地鍵，下一張接著出）
  // 當下有別張回顧開著（使用者自己開的、車站小卡裡的）就等它關掉再補
  const reviewOpen = review !== null;
  useEffect(() => {
    if (nextReview && !useWeekAimStore.getState().review) void useWeekAimStore.getState().openReview(nextReview);
  }, [nextReview, reviewOpen]);

  const period = periodOfKey(key);
  const showReview =
    review &&
    !review.inCard &&
    (review.weekOn === key ||
      (autoReview && (pending.includes(review.weekOn) || (period !== "station" && review.weekOn === adjacentKey(key, -1)))));
  const host = <WeekAimsEditorHost today={v.today} weekStart={v.weekStart} />;

  if (showReview) {
    return (
      <>
        <ReviewBoard aimKey={review.weekOn} today={v.today} weekStart={v.weekStart} placeOf={v.placeOf} />
        {host}
      </>
    );
  }

  if (v.loading) return null;

  const { latin } = v.head;
  const title = heading ?? v.head.title;
  const rel = v.head.rel;
  const openEditor = () => useWeekAimStore.getState().openEditor(key);
  const toggle = () => {
    if (pinFolded) setPinOpen((o) => !o);
    else void useWeekAimStore.getState().setFolded(key, !v.folded);
  };
  const folded = pinFolded ? !pinOpen : v.folded;
  const empty = v.aims.length === 0;
  const lastDay = isLastDayOfPeriod(key, v.today);
  const pickToday = (p: ReviewPeriod) => {
    const st = useWeekAimStore.getState();
    st.setTodayPick(p);
    // 點了就是要看：切過去的那一期一律攤開
    void st.setFolded(currentKeyOf(p, v.today, v.weekStart), false);
  };

  const canNav = navigable && period !== "station";
  const curOfPeriod = period === "station" ? key : currentKeyOf(period, v.today, v.weekStart);
  const shift = (dir: -1 | 1) => {
    setPlanFor(null);
    setNav({ base: aimKey, key: adjacentKey(key, dir) });
  };
  const step = periodStepText(key);
  const titleEl = heading ? (
    <h3 className="wa-ttl wa-ttl-stn">
      <StationMark />
      {title}
    </h3>
  ) : (
    <h3 className="wa-ttl">{title}</h3>
  );
  const latinEl = heading ? null : canNav ? (
    <span className="wa-nav">
      <button type="button" className="ns-iconbtn" aria-label={step.prev} title={step.prev} onClick={() => shift(-1)}>
        <IconBack />
      </button>
      <span className="wa-latin">{latin}</span>
      <button type="button" className="ns-iconbtn" aria-label={step.next} title={step.next} onClick={() => shift(1)}>
        <IconChevron />
      </button>
    </span>
  ) : (
    <span className="wa-latin">{latin}</span>
  );
  // 翻到別年時回這一年：不能只清翻期——完整搜尋落到別年時外面給的 aimKey 就是那一年，清了還是那一年（D-主-382）；
  // 今日切到別期時回本週（兩者不會同時出現：今日那張不翻期）
  const backEl =
    canNav && key !== curOfPeriod ? (
      <button
        type="button"
        className="ns-btn btn-text ns-btn--sm"
        onClick={() => {
          setPlanFor(null);
          setNav({ base: aimKey, key: curOfPeriod });
        }}
      >
        回{periodShortLabel(curOfPeriod, v.today, v.weekStart)}
      </button>
    ) : ribbon && period !== "week" ? (
      <button type="button" className="ns-btn btn-text ns-btn--sm" onClick={() => useWeekAimStore.getState().setTodayPick("week")}>
        回本週
      </button>
    ) : null;
  const ribbonEl = ribbon ? <AimsRibbon current={key} today={v.today} folded={folded || empty} onPick={pickToday} /> : null;

  if (empty) {
    return (
      <>
        <section className={"wa is-folded" + (wide ? " is-wide" : "")} aria-label={title}>
          <div className="wa-board">
            <div className="wa-head">
              {titleEl}
              {latinEl}
              <span className="wa-dt">{v.rangeText}</span>
              <span className="wa-rule" />
              <span className="wa-empty-note">還沒寫{rel}的方針</span>
              <button type="button" className="ns-btn btn-text ns-btn--sm" aria-haspopup="dialog" onClick={openEditor}>
                寫方針
              </button>
              {backEl}
            </div>
            {ribbonEl}
          </div>
        </section>
        {host}
      </>
    );
  }

  const { done, total } = v.count;
  // 回顧：這一期最後一天（D-主-260）；翻到過去的那一期也能回頭看；車站隨時能看（D-主-374）
  const canReview = lastDay || isPastPeriod(key, v.today, v.weekStart) || period === "station";
  // 浮層標題：週維持「這週」的舊字，其他期間照關係寫
  const planWhen = period === "week" ? "這週" : rel;
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
            {titleEl}
            {latinEl}
            <span className="wa-dt">{v.rangeText}</span>
            <span className="wa-rule" />
            <span className="wa-count" title={`済 ${done} 句，共 ${total} 句`}>
              済 <b>{done}</b>/{total}
            </span>
            {!folded && (
              <button type="button" className="ns-btn btn-text ns-btn--sm" aria-haspopup="dialog" onClick={openEditor}>
                改方針
              </button>
            )}
            {!folded && canReview && (
              <button type="button" className="ns-btn btn-text ns-btn--sm" onClick={() => void useWeekAimStore.getState().openReview(key)}>
                {lastDay ? `回顧${rel} ›` : "回顧 ›"}
              </button>
            )}
            {backEl}
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
                const count = v.countOf(a);
                const planBtn =
                  a.done_at === null ? (
                    <button
                      type="button"
                      className={"ns-btn btn-text ns-btn--sm wa-plan" + (planFor === a.id ? " is-open" : "")}
                      aria-haspopup="dialog"
                      aria-expanded={planFor === a.id}
                      title={place ? `在「${aimPlacePath(place)}」建一張${planWhen}的車票` : `建一張${planWhen}的臨時車票`}
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
                    {planFor === a.id && <PlanTicketPop aim={a} weekOn={key} today={v.today} onClose={() => setPlanFor(null)} />}
                  </li>
                );
              })}
            </ol>
          )}
          {ribbonEl}
        </div>
      </section>
      {host}
    </>
  );
}
