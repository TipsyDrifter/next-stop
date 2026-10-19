/**
 * GoalCards——時數目標區（③ 契約 §5.2-5；D-時-56、60、61、62、64、67；乙席）。
 * 只展開進行中的；未開始與已結束收成一行「另有 1 個未開始、1 個已結束 ›」，點了展開（D-時-64，兩殼一樣）。
 * 卡片＝名稱（右上：結果章／「收起來」／⋯）、期間與方向・範圍、進度條、數字與狀態、節奏、上一期、待確認（獨立一行在卡尾，D-時-67）。
 * 目標的期跟正在看的期無關（永遠是「現在」所在的那一期），所以換期時這一區不變。
 */
import { useState, type ReactNode } from "react";
import { fmtDur, MIN } from "../../../domain/timetable";
import type { GoalView } from "../../../domain/timetableStats";
import { TT_TEXT, useTimetableStore } from "../../../store/timetableStore";
import { useTimetableStatsStore } from "../../../store/timetableStatsStore";
import { goalPeriodText, md, scopeText, useCatById } from "./format";

type Stamp = { text: string; tone: "gold" | "ink" | "late" };

function stampOf(v: GoalView): Stamp | null {
  const g = v.goal;
  if (v.state === "ended") {
    if (g.direction === "atLeast") return v.cur.met ? { text: TT_TEXT.goalMet, tone: "gold" } : { text: TT_TEXT.goalMissed, tone: "ink" };
    return v.cur.over ? { text: TT_TEXT.statsUi.stampOver, tone: "late" } : { text: TT_TEXT.goalKept, tone: "gold" };
  }
  if (v.state === "active" && g.direction === "atLeast" && v.cur.met) return { text: TT_TEXT.goalMet, tone: "gold" };
  return null;
}

function GoalCard({ v }: { v: GoalView }) {
  const catById = useCatById();
  const openSheet = useTimetableStore((s) => s.openSheet);
  const archiveGoal = useTimetableStore((s) => s.archiveGoal);
  const T = TT_TEXT.statsUi;
  const g = v.goal;
  const target = g.targetMin * MIN;
  const ms = v.cur.ms;
  const repeat = g.period === "day" || g.period === "week" || g.period === "month";
  const stamp = stampOf(v);
  const per = goalPeriodText(g) + (g.period === "until" && v.daysLeft !== null ? `・${TT_TEXT.goalDaysLeft(v.daysLeft)}` : "");
  const scopeLbl = v.state === "upcoming" ? T.scopeNotYet : repeat ? T.scopeNow[g.period as "day" | "week" | "month"] : v.state === "ended" ? T.scopeLast : T.scopeToNow;
  const over = v.state === "active" && g.direction === "atMost" && v.cur.over;
  const pct = Math.min(1, v.cur.ratio) * 100;

  let status: ReactNode = null;
  if (v.state === "upcoming") status = <span className="ns-tt-goal-when">{TT_TEXT.goalStarts(g.startOn ? md(g.startOn) : "？")}</span>;
  else if (v.state === "ended") status = <span className="ns-tt-goal-when">{TT_TEXT.goalEnded}</span>;
  else if (over) status = <span className="ns-tt-goal-over">{TT_TEXT.goalOver(ms - target)}</span>;
  else if (!(g.direction === "atLeast" && v.cur.met)) status = <span className="ns-tt-goal-left">{TT_TEXT.goalLeft(Math.max(0, target - ms), g.direction === "atMost")}</span>;

  const prev = v.prev;
  const prevVerdict = prev
    ? g.direction === "atLeast"
      ? prev.met
        ? TT_TEXT.goalMet
        : TT_TEXT.goalMissed
      : prev.over
        ? TT_TEXT.goalOver(prev.ms - target)
        : TT_TEXT.goalKept
    : "";
  const pendN = v.state === "upcoming" ? 0 : v.cur.pendingItems.length;

  const cls =
    "ns-tt-goal" +
    (g.direction === "atMost" ? " is-most" : "") +
    (over ? " is-over" : "") +
    (v.state === "active" && stamp ? " is-met" : "") +
    (v.state !== "active" ? " is-dim" : "") +
    (v.state === "ended" ? " is-ended" : "") +
    (v.state === "upcoming" ? " is-upcoming" : "");

  return (
    <article className={cls}>
      <div className="ns-tt-goal-h">
        <b className="ns-tt-goal-name">{g.name}</b>
        {stamp && <span className={"ns-tt-goal-stamp is-" + stamp.tone}>{stamp.text}</span>}
        {v.state === "ended" && (
          <button type="button" className="ns-tt-goal-hide" onClick={() => void archiveGoal(g.id, true)}>
            {TT_TEXT.goalHide}
          </button>
        )}
        <button type="button" className="ns-tt-goal-more" aria-label={T.goalEdit} title={T.goalEdit} onClick={() => openSheet({ kind: "goal", goalId: g.id })}>
          ⋯
        </button>
      </div>
      <p className="ns-tt-goal-sub">
        <span className="ns-tt-goal-per">{per}</span>
        <span>{scopeText(v.liveCategoryIds.length ? v.liveCategoryIds : g.categoryIds, catById)}</span>
      </p>
      {v.state !== "upcoming" && (
        <div className="ns-tt-goal-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
          <i style={{ width: `${pct.toFixed(1)}%` }} />
        </div>
      )}
      <div className="ns-tt-goal-num">
        <span>
          <span className="ns-tt-goal-scope">{scopeLbl}</span> <b className="ns-tt-num">{fmtDur(ms)}</b>
          <span className="ns-tt-num ns-tt-goal-of">／{fmtDur(target)}</span>
        </span>
        {status}
      </div>
      {v.paceMs !== null && (
        <p className="ns-tt-goal-pace">{TT_TEXT.goalPace(v.paceMs)}</p>
      )}
      {prev && repeat && (
        <p className="ns-tt-goal-prev">{T.prevLine(T.scopePrev[g.period as "day" | "week" | "month"], fmtDur(prev.ms), prevVerdict)}</p>
      )}
      {pendN > 0 && (
        <p className="ns-tt-goal-hint">
          {TT_TEXT.goalPendingHint(pendN)}
          <button
            type="button"
            onClick={() => openSheet({ kind: "pendingList", from: v.cur.start, to: v.cur.end, goalId: g.id })}
          >
            {T.pendingLook}
          </button>
        </p>
      )}
    </article>
  );
}

export function GoalCards() {
  const goals = useTimetableStatsStore((s) => s.goals);
  const openSheet = useTimetableStore((s) => s.openSheet);
  const [showRest, setShowRest] = useState(false);
  const T = TT_TEXT.statsUi;
  const active = goals.filter((v) => v.state === "active");
  const rest = goals.filter((v) => v.state !== "active");
  const upcoming = rest.filter((v) => v.state === "upcoming").length;
  const ended = rest.length - upcoming;

  return (
    <section className="ns-tt-goals">
      <div className="ns-tt-goals-h">
        <h3>{T.goalsTitle}</h3>
        <span className="rule" />
        <button type="button" className="ns-tt-goals-add" onClick={() => openSheet({ kind: "goal", goalId: null })}>
          {TT_TEXT.goalAdd}
        </button>
      </div>
      {goals.length === 0 ? (
        <p className="ns-tt-goals-none">{T.goalsNone}</p>
      ) : (
        <div className="ns-tt-goals-list">
          {active.map((v) => (
            <GoalCard key={v.goal.id} v={v} />
          ))}
          {rest.length > 0 && (
            <button type="button" className={"ns-tt-goals-rest" + (showRest ? " is-open" : "")} aria-expanded={showRest} onClick={() => setShowRest((x) => !x)}>
              {T.goalsMore(upcoming, ended)}
              <i aria-hidden="true">›</i>
            </button>
          )}
          {showRest && (
            <div className="ns-tt-goals-restlist">
              {rest.map((v) => (
                <GoalCard key={v.goal.id} v={v} />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
