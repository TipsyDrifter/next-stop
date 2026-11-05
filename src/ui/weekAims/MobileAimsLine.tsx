/**
 * MobileAimsLine——手機的方針（戊 D-主-262；方針擴充 辛 §7；原型場景 one-m-today／two-m-sheet）。吃任何期間鍵。
 *
 * 一行「本週方針 日期 ── 済 d/n ›」，點開底部面板：上方分頁 本週｜本月｜今年｜下一站（車站鍵沒有分頁），每句蓋済、排成車票，底下「改方針」「回顧… ›」。
 *   - 今日分頁（`upper`、`autoReview`）：那一行底下多兩行上層，有句子才出、沒句子不佔位，點了開面板到那一格。
 *     新的一期、上一期有方針又還沒看過回顧 ⇒ 一行字換成「回顧上週／上個月／去年 ›」，點開面板就是那張回顧，關掉才輪下一張
 *     （D-主-373；☎2：不自動彈面板，免得擋住今日清單）。
 *   - 行程表：週條下方看週條那一週；展開月曆時看本月（看月曆正在翻的那個月）。
 *   - 車庫年鑑（`navigable`）：看今年；面板裡 ‹ › 翻年（D-主-378）、翻到別年時多「回今年」。
 * 沒寫方針＝一行「本週方針 ── 寫方針 ›」，點了直接開寫方針；`navigable` 時改開面板（今年沒寫也要翻得到別年，面板裡有「寫方針」），字寫「還沒寫」。
 * 面板三種內容：清單／排成車票（某一句）／回顧（某一期）。返回鍵與下滑＝關面板（MSheet 自己登記）。
 *
 * 下一站分頁：每條路線的下一站有方針的才列。點站名＝`onOpenStation(車站 id)`（開車站小卡）；沒接時開那一站的寫方針。
 * 路線第二層：`aimKey` 給下一站、`heading="下一站方針"`、`onTap`＝開車站小卡（有句子才掛）。
 */
import { useEffect, useMemo, useState } from "react";
import {
  adjacentKey,
  aimNumeral,
  aimsBrief,
  aimsOfKey,
  currentKeyOf,
  isLastDayOfPeriod,
  isPastPeriod,
  nextStationsOfRoutes,
  periodOfKey,
  periodShortLabel,
  periodStepText,
  periodTabs,
  periodTitle,
  reviewCueText,
  reviewTitle,
  ribbonSegments,
  stationHeadText,
  stationKeyOf,
  type WeekAimRow,
} from "../../domain/weekAims";
import { compareSiblings } from "../../domain/nodeOrder";
import { useNodeStore } from "../../store/nodeStore";
import { useWeekAimStore } from "../../store/weekAimStore";
import { MSheet } from "../common/MSheet";
import { IconBack, IconChevron } from "../common/icons";
import { useAimToday, useAimView, usePendingReviews } from "./useWeekAims";
import { AimStamp, PlanLine, RouteMark, RouteTag, StationMark } from "./parts";
import { PlanTicketForm, usePlanForm } from "./PlanTicketPop";
import { ReviewList } from "./WeekAimsReview";
import { WeekAimsEditorHost } from "./WeekAimsEditor";
import "./weekAims.css";

const NEXT_TAB = "next";
const EMPTY: WeekAimRow[] = [];

type Pane = { kind: "list"; tab: string } | { kind: "plan"; aim: WeekAimRow; aimKey: string; back: string } | { kind: "review"; aimKey: string };

export interface MobileAimsLineProps {
  /** 期間鍵（週首／M…／Y…／S<車站 id>） */
  aimKey: string;
  /** 今日分頁：那一行底下多兩行上層 */
  upper?: boolean;
  /** 今日分頁：新的一期排隊回顧（一行字換掉，不彈面板） */
  autoReview?: boolean;
  /** 面板裡 ‹ › 翻期（年鑑） */
  navigable?: boolean;
  /** 面板裡按了「回今年」：完整搜尋落到別年時這一行看的是那一年，由外面換回來（年鑑） */
  onBackToCurrent?: () => void;
  /** 下一站分頁點站名＝開車站小卡（今日分頁接） */
  onOpenStation?: (stationId: string) => void;
  /** 換掉標題字（路線第二層「下一站方針」）：前面一枚 ◎ */
  heading?: string;
  /** 有句子時點這一行不開面板、改叫這支（路線第二層開車站小卡） */
  onTap?: () => void;
}

export function MobileAimsLine({ aimKey, upper = false, autoReview = false, navigable = false, onBackToCurrent, onOpenStation, heading, onTap }: MobileAimsLineProps) {
  const v = useAimView(aimKey);
  const pending = usePendingReviews(autoReview);
  const [pane, setPane] = useState<Pane | null>(null);
  const st = useWeekAimStore.getState;
  const lists = useWeekAimStore((s) => s.weeks);

  const uppers = upper ? ribbonSegments(aimKey, v.today, v.weekStart) : [];
  const upperKeys = uppers.map((u) => u.key).join("|");
  useEffect(() => {
    for (const k of upperKeys ? upperKeys.split("|") : []) if (st().weeks[k] === undefined) void st().loadWeek(k);
  }, [upperKeys, st]);

  // ⑨ 提醒點開週末回顧：面板是這裡的狀態，收 store 的請求（hook 要排在提前 return 之前；只有週的那一行收）
  const reviewRequest = useWeekAimStore((s) => s.reviewRequest);
  const isWeekLine = periodOfKey(aimKey) === "week";
  useEffect(() => {
    if (!reviewRequest || !isWeekLine) return;
    setPane({ kind: "review", aimKey: reviewRequest });
    st().requestReview(null);
  }, [reviewRequest, isWeekLine, st]);

  if (v.loading) return null;

  const title = heading ?? v.head.title;
  const empty = v.aims.length === 0;
  const pendingKey = pending[0] ?? null;

  const openReview = (key: string) => {
    setPane({ kind: "review", aimKey: key });
    void st().openReview(key);
  };
  const close = () => {
    if (pane?.kind === "review") void st().closeReview();
    setPane(null);
  };
  const tap = () => {
    if (pendingKey) openReview(pendingKey);
    else if (empty && !navigable) st().openEditor(aimKey);
    else if (onTap && !empty) onTap();
    else setPane({ kind: "list", tab: aimKey });
  };

  const cue = pendingKey ? (
    <span className="wa-cue">{reviewCueText(pendingKey, v.today, v.weekStart)}</span>
  ) : empty ? (
    <span className="wa-cue">{navigable ? "還沒寫" : "寫方針"}</span>
  ) : (
    <span className="wa-count">
      済 <b>{v.count.done}</b>/{v.count.total}
    </span>
  );

  return (
    <>
      <section className="wa" aria-label={title}>
        <div className="wa-board">
          <button type="button" className="wa-mline" aria-haspopup="dialog" onClick={tap}>
            <span className={"wa-ttl" + (heading ? " wa-ttl-stn" : "")}>
              {heading && <StationMark />}
              {title}
            </span>
            <span className="wa-dt">{v.rangeText}</span>
            <span className="wa-rule" />
            {cue}
            <IconChevron />
          </button>
          {uppers.map(({ key, label }) => {
            const brief = aimsBrief(lists[key] ?? EMPTY);
            if (!brief) return null;
            return (
              <button key={key} type="button" className="wa-mrib" aria-haspopup="dialog" onClick={() => setPane({ kind: "list", tab: key })}>
                <span className="k">{label}</span>
                <span className="v">{brief}</span>
              </button>
            );
          })}
        </div>
      </section>

      {pane?.kind === "list" && (
        <AimsSheet
          lineKey={aimKey}
          tab={pane.tab}
          navigable={navigable}
          onBackToCurrent={onBackToCurrent}
          onTab={(tab) => setPane({ kind: "list", tab })}
          onClose={close}
          onPlan={(aim, key) => setPane({ kind: "plan", aim, aimKey: key, back: key })}
          onReview={openReview}
          onOpenStation={onOpenStation}
        />
      )}

      {pane?.kind === "plan" && (
        <PlanSheet aim={pane.aim} aimKey={pane.aimKey} today={v.today} onClose={() => setPane({ kind: "list", tab: pane.back })} />
      )}

      {pane?.kind === "review" && (
        <MSheet title={reviewTitle(pane.aimKey, v.today, v.weekStart)} className="wa-ms" onClose={close} height="half">
          <ReviewSub aimKey={pane.aimKey} />
          <ReviewList
            aimKey={pane.aimKey}
            today={v.today}
            weekStart={v.weekStart}
            placeOf={v.placeOf}
            onCarry={(next, toCarry) => {
              void st().closeReview();
              setPane(null);
              st().openEditor(next, toCarry);
            }}
          />
        </MSheet>
      )}

      <WeekAimsEditorHost today={v.today} weekStart={v.weekStart} />
    </>
  );
}

function ReviewSub({ aimKey }: { aimKey: string }) {
  const v = useAimView(aimKey);
  return <p className="wa-ms-sub">{v.rangeText}</p>;
}

/** 底部面板：期間分頁＋那一期的清單（或下一站）。換分頁不換殼，面板不會重新滑一次 */
function AimsSheet({
  lineKey,
  tab,
  navigable,
  onBackToCurrent,
  onTab,
  onClose,
  onPlan,
  onReview,
  onOpenStation,
}: {
  lineKey: string;
  tab: string;
  navigable: boolean;
  onBackToCurrent?: () => void;
  onTab(tab: string): void;
  onClose(): void;
  onPlan(aim: WeekAimRow, aimKey: string): void;
  onReview(aimKey: string): void;
  onOpenStation?: (stationId: string) => void;
}) {
  const { today, weekStart } = useAimToday();
  const isNext = tab === NEXT_TAB;
  const title = isNext ? "下一站方針" : periodTitle(tab, today, weekStart).title;

  // 分頁的三格看這一行那一期（行程表翻到下週＝那一格寫下週）；面板裡翻年時那一格跟著換
  const tabs = periodTabs(lineKey, today, weekStart).map((t) =>
    !isNext && periodOfKey(t.key) === periodOfKey(tab) ? { key: tab, label: periodShortLabel(tab, today, weekStart) } : t,
  );
  // 一打開就把另外幾格載好，換分頁時面板高度不會空一下
  useEffect(() => {
    const st = useWeekAimStore.getState();
    for (const t of tabs) if (st.weeks[t.key] === undefined) void st.loadWeek(t.key);
    // 只在打開時看一次；翻期時那一格由 useAimView 自己載
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <MSheet title={title} className="wa-ms" onClose={onClose} height="auto" ariaLabel={title}>
      {tabs.length > 0 && (
        <div className="wa-mtabs" role="tablist" aria-label="方針的期間">
          {tabs.map((t) => (
            <button key={t.key} type="button" role="tab" aria-selected={t.key === tab} className={t.key === tab ? "on" : ""} onClick={() => onTab(t.key)}>
              {t.label}
            </button>
          ))}
          <button type="button" role="tab" aria-selected={isNext} className={isNext ? "on" : ""} onClick={() => onTab(NEXT_TAB)}>
            下一站
          </button>
        </div>
      )}
      {isNext ? (
        <NextStationsPane onClose={onClose} onOpenStation={onOpenStation} />
      ) : (
        <PeriodPane aimKey={tab} navigable={navigable} onBackToCurrent={onBackToCurrent} onTab={onTab} onClose={onClose} onPlan={onPlan} onReview={onReview} />
      )}
    </MSheet>
  );
}

/** 面板裡一期的清單：日期＋済、每句、改方針、回顧 */
function PeriodPane({
  aimKey,
  navigable,
  onBackToCurrent,
  onTab,
  onClose,
  onPlan,
  onReview,
}: {
  aimKey: string;
  navigable: boolean;
  onBackToCurrent?: () => void;
  onTab(tab: string): void;
  onClose(): void;
  onPlan(aim: WeekAimRow, aimKey: string): void;
  onReview(aimKey: string): void;
}) {
  const v = useAimView(aimKey);
  const st = useWeekAimStore.getState;
  const edit = () => {
    onClose();
    st().openEditor(aimKey);
  };
  if (v.loading) return null;

  const period = v.period;
  const lastDay = isLastDayOfPeriod(aimKey, v.today);
  const isCurrent = period !== "station" && aimKey === currentKeyOf(period, v.today, v.weekStart);
  const prevKey = period === "station" ? null : adjacentKey(aimKey, -1);
  const canNav = navigable && period === "year";
  const step = periodStepText(aimKey);

  return (
    <>
      <div className="wa-ms-head">
        {canNav && (
          <button type="button" className="ns-iconbtn" aria-label={step.prev} title={step.prev} onClick={() => onTab(adjacentKey(aimKey, -1))}>
            <IconBack />
          </button>
        )}
        <p className="wa-ms-sub">
          {v.rangeText}
          {v.aims.length > 0 && (
            <>
              {"　"}済 <b>{v.count.done}</b>/{v.count.total}
            </>
          )}
        </p>
        {canNav && (
          <button type="button" className="ns-iconbtn" aria-label={step.next} title={step.next} onClick={() => onTab(adjacentKey(aimKey, 1))}>
            <IconChevron />
          </button>
        )}
      </div>
      {v.aims.length === 0 && <p className="wa-ms-empty">還沒寫{v.head.rel}的方針。</p>}
      {v.aims.map((a, i) => {
        const place = v.placeOf(a.node_id);
        return (
          <div key={a.id} className={"wa-mrow" + (a.done_at ? " is-done" : "")}>
            <span className="wa-num">{aimNumeral(i)}</span>
            <div>
              <p className="wa-text">
                <span className="t">{a.text}</span>
                {place && <RouteTag place={place} shell="mobile" onGo={onClose} />}
              </p>
              <PlanLine aim={a} count={v.countOf(a)} />
              {a.done_at === null && (
                <div className="act">
                  <button type="button" className="ns-btn btn-ghost ns-btn--sm" onClick={() => onPlan(a, aimKey)}>
                    排成車票
                  </button>
                </div>
              )}
            </div>
            <AimStamp aim={a} />
          </div>
        );
      })}
      <div className="wa-ms-links">
        <button type="button" className="ns-btn btn-ghost ns-btn--sm" onClick={edit}>
          {v.aims.length === 0 ? "寫方針" : "改方針"}
        </button>
        {v.aims.length > 0 && (lastDay || isPastPeriod(aimKey, v.today, v.weekStart) || period === "station") && (
          <button type="button" className="ns-btn btn-text ns-btn--sm" onClick={() => onReview(aimKey)}>
            回顧{lastDay ? v.head.rel : ""} ›
          </button>
        )}
        {canNav && !isCurrent && (
          <button
            type="button"
            className="ns-btn btn-text ns-btn--sm"
            onClick={() => {
              onTab(currentKeyOf("year", v.today, v.weekStart));
              onBackToCurrent?.();
            }}
          >
            回今年
          </button>
        )}
        {isCurrent && !lastDay && prevKey && (
          <button type="button" className="ns-btn btn-text ns-btn--sm" onClick={() => onReview(prevKey)}>
            回顧{periodTitle(prevKey, v.today, v.weekStart).rel} ›
          </button>
        )}
      </div>
    </>
  );
}

/** 下一站分頁：每條路線的下一站有方針的 */
function NextStationsPane({ onClose, onOpenStation }: { onClose(): void; onOpenStation?: (stationId: string) => void }) {
  const routes = useNodeStore((s) => s.liveRoutes);
  const stations = useNodeStore((s) => s.stations);
  const lists = useWeekAimStore((s) => s.weeks);
  const nexts = useMemo(() => nextStationsOfRoutes(routes, [...stations].sort(compareSiblings)), [routes, stations]);
  const keys = useMemo(() => nexts.map((n) => stationKeyOf(n.station.id)), [nexts]);
  useEffect(() => {
    void useWeekAimStore.getState().loadKeys(keys);
  }, [keys]);

  const shown = nexts
    .map((n) => {
      const key = stationKeyOf(n.station.id);
      return { ...n, key, aims: aimsOfKey(lists[key] ?? EMPTY, key) };
    })
    .filter((n) => n.aims.length > 0);

  if (!shown.length) return <p className="wa-ms-empty">還沒有車站寫方針。</p>;
  return (
    <>
      {shown.map(({ route, station, key, aims }) => (
        <section key={key} className="wa-nx" aria-label={station.name}>
          <button
            type="button"
            className="wa-nx-head"
            aria-haspopup="dialog"
            onClick={() => {
              onClose();
              if (onOpenStation) onOpenStation(station.id);
              else useWeekAimStore.getState().openEditor(key);
            }}
          >
            <RouteMark route={route} />
            <span className="nm">{stationHeadText(station)}</span>
            <span className="rt">{route.name}</span>
            <IconChevron />
          </button>
          {aims.map((a, i) => (
            <div key={a.id} className={"wa-mrow" + (a.done_at ? " is-done" : "")}>
              <span className="wa-num">{aimNumeral(i)}</span>
              <div>
                <p className="wa-text">
                  <span className="t">{a.text}</span>
                </p>
              </div>
              <AimStamp aim={a} />
            </div>
          ))}
        </section>
      ))}
    </>
  );
}

export function PlanSheet({ aim, aimKey, today, onClose }: { aim: WeekAimRow; aimKey: string; today: string; onClose(): void }) {
  const f = usePlanForm(aim, aimKey, today);
  return (
    <MSheet
      title="排成車票"
      className="wa-ms"
      onClose={onClose}
      height="auto"
      backKind="dialog"
      foot={
        <>
          <button type="button" className="ns-btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="ns-btn btn-seal"
            disabled={f.busy || !f.name.trim()}
            onClick={() => void f.submit().then((ok) => ok && onClose())}
          >
            発券
          </button>
        </>
      }
    >
      <PlanTicketForm f={f} today={today} />
    </MSheet>
  );
}
