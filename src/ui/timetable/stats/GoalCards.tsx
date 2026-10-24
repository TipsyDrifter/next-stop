/**
 * GoalCards——時數目標區（③ 契約 §5.2-5；D-時-56、60、61、62、64、67；乙席）。
 * 只展開進行中的；未開始與已結束收成一行「另有 1 個未開始、1 個已結束 ›」，點了展開（D-時-64，兩殼一樣）。
 * 卡片＝名稱（右上：結果章／「收起來」／⋯）、期間與方向・範圍、進度條、數字與狀態、節奏、上一期、待確認（獨立一行在卡尾，D-時-67）。
 * 目標的期跟正在看的期無關（永遠是「現在」所在的那一期），所以換期時這一區不變。
 *
 * ⑥（§5.4；D-時-122、123；丙席）：範圍字帶 `#荷札`（`goal.tagKeys` → 顯示名）；範圍空了（`emptyScope`，而且沒有綁分類＝綁的荷札都被刪了）⇒
 * 卡上一行「綁的荷札已經不在了」＋「重新選範圍 ›」、不畫條。荷札頁點「目標『…』」⇒ `focusGoalCard(id)`：捲到那張卡、描金閃一下
 * （收在「另有…」裡的先展開；卡還沒畫出來就等它畫出來）。
 *
 * UI 丙-4 D6（視覺規範 §2.6 列的 ⋯、§2.7 空狀態）：
 *   - 卡右上的 ⋯ 從「點了直接開 GoalPanel」改成 `.ns-iconbtn`＋`PopMenu`：編輯…（開 GoalPanel）／封存／刪除（赭、放最後）。
 *     封存、刪除走 store 現成的 archiveGoal／deleteGoal——跟 GoalPanel 的鈕同一條路：不另跳確認框，store 出 toast＋「復原」。
 *   - 區段標的「＋目標」拿掉 `--sm`（跟頁上其他次鈕一樣高）；沒有目標時改成卡內一行 EmptyState（action「＋ 目標」），
 *     區段標的「＋目標」同時藏起來（§2.7 同一動作同頁一個入口）。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { EmptyState } from "../../common/EmptyState";
import { IconDots, IconPlus } from "../../common/icons";
import { PopMenu, type PopMenuItem } from "../../common/PopMenu";
import { fmtDur, MIN } from "../../../domain/timetable";
import type { GoalView } from "../../../domain/timetableStats";
import { TT_TEXT, useTimetableStore } from "../../../store/timetableStore";
import { useTimetableStatsStore } from "../../../store/timetableStatsStore";
import { goalPeriodText, md, scopeText, useCatById, useTagNameOf } from "./format";

/* ───────── ⑥ 荷札頁跳過來：捲到那張卡（模組層一個待辦 id＋事件；卡區掛著就立刻處理，沒掛就等它掛上） ───────── */

const FOCUS_EVENT = "ns-tt-goal-focus";
let pendingFocus: string | null = null;

/** 荷札頁「目標『…』」的跳轉用（`lines/timetableTagEntities.ts`）：統計頁已經在畫面上就立刻捲，還沒有就等卡區掛上 */
export function focusGoalCard(goalId: string): void {
  pendingFocus = goalId;
  if (typeof window !== "undefined") window.dispatchEvent(new Event(FOCUS_EVENT));
}

type Stamp = { text: string; tone: "gold" | "ink" | "late" };

/** UI 丙-4 D6：目標卡 ⋯ 選單與空狀態的字（只在這一支用；封存／刪除沿用 GoalPanel 的 statsUi.archive／remove） */
const GOAL_MENU = {
  edit: "編輯…",
  more: (name: string) => `更多動作：${name}`,
  label: (name: string) => `「${name}」的動作`,
  emptyTitle: "還沒有目標。",
  emptyDesc: "例如：每週創作 10 小時",
  emptyAction: "目標",
} as const;

/** 目標卡右上的 ⋯（UI 丙-4 D6）：圖示鈕＋小選單；留在 Tab 順序裡（卡本身不可點，這是卡上動作唯一的鍵盤入口） */
function GoalMore({ id, name }: { id: string; name: string }) {
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const openSheet = useTimetableStore((s) => s.openSheet);
  const archiveGoal = useTimetableStore((s) => s.archiveGoal);
  const deleteGoal = useTimetableStore((s) => s.deleteGoal);
  const T = TT_TEXT.statsUi;
  const items: PopMenuItem[] = [
    { key: "edit", label: GOAL_MENU.edit, onSelect: () => openSheet({ kind: "goal", goalId: id }) },
    { key: "archive", label: T.archive, onSelect: () => void archiveGoal(id, true) },
    { key: "delete", label: T.remove, cut: true, danger: true, onSelect: () => void deleteGoal(id) },
  ];
  return (
    <>
      <button
        ref={btn}
        type="button"
        className="ns-iconbtn ns-tt-goal-more"
        aria-label={GOAL_MENU.more(name)}
        title={items.map((it) => it.label).join("、")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((x) => !x)}
      >
        <IconDots />
      </button>
      {open && (
        <PopMenu
          anchor={btn.current}
          overline={{ zh: "這個目標", latin: "Goal" }}
          label={GOAL_MENU.label(name)}
          items={items}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

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
  const tagNameOf = useTagNameOf();
  const openSheet = useTimetableStore((s) => s.openSheet);
  const archiveGoal = useTimetableStore((s) => s.archiveGoal);
  const T = TT_TEXT.statsUi;
  const g = v.goal;
  const tagNames = (g.tagKeys ?? []).map(tagNameOf);

  // ⑥：綁的荷札都不在了（分類本來就沒綁）⇒ 範圍空、不畫條（原型 vt-glost）
  if (v.emptyScope && g.categoryIds.length === 0) {
    return (
      <article className="ns-tt-goal is-dim is-lost" data-goal-id={g.id}>
        <div className="ns-tt-goal-h">
          <b className="ns-tt-goal-name">{g.name}</b>
          <GoalMore id={g.id} name={g.name} />
        </div>
        <p className="ns-tt-goal-sub">
          <span className="ns-tt-goal-per">{goalPeriodText(g)}</span>
        </p>
        <p className="ns-tt-goal-lost">
          <i className="ns-tt-stats-tglyph is-hollow" aria-hidden="true" />
          {TT_TEXT.tags.goalTagsGone}
          <button type="button" onClick={() => openSheet({ kind: "goal", goalId: g.id })}>
            {TT_TEXT.tags.goalRescope}
          </button>
        </p>
      </article>
    );
  }

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
    <article className={cls} data-goal-id={g.id}>
      <div className="ns-tt-goal-h">
        <b className="ns-tt-goal-name">{g.name}</b>
        {stamp && <span className={"ns-tt-goal-stamp is-" + stamp.tone}>{stamp.text}</span>}
        {v.state === "ended" && (
          <button type="button" className="ns-tt-goal-hide" onClick={() => void archiveGoal(g.id, true)}>
            {TT_TEXT.goalHide}
          </button>
        )}
        <GoalMore id={g.id} name={g.name} />
      </div>
      <p className="ns-tt-goal-sub">
        <span className="ns-tt-goal-per">{per}</span>
        <span>{scopeText(v.liveCategoryIds.length ? v.liveCategoryIds : g.categoryIds, catById, tagNames)}</span>
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
  const [focusTick, setFocusTick] = useState(0);
  const rootRef = useRef<HTMLElement>(null);
  const T = TT_TEXT.statsUi;
  const active = goals.filter((v) => v.state === "active");
  const rest = goals.filter((v) => v.state !== "active");

  // ⑥ 荷札頁跳過來（focusGoalCard）：事件只負責叫醒；真正的捲動等卡畫出來（goals 換了也再試）
  useEffect(() => {
    const wake = () => setFocusTick((n) => n + 1);
    window.addEventListener(FOCUS_EVENT, wake);
    return () => window.removeEventListener(FOCUS_EVENT, wake);
  }, []);
  useEffect(() => {
    const id = pendingFocus;
    if (id === null || !goals.length) return;
    if (!goals.some((v) => v.goal.id === id)) {
      pendingFocus = null; // 封存的、讀不懂的：不在卡區，就停在統計頁
      return;
    }
    if (!showRest && goals.some((v) => v.goal.id === id && v.state !== "active")) {
      setShowRest(true);
      return; // 展開之後這個 effect 會再跑一次
    }
    const el = rootRef.current?.querySelector<HTMLElement>(`[data-goal-id="${CSS.escape(id)}"]`);
    if (!el) return;
    pendingFocus = null;
    el.scrollIntoView({ block: "center" }); // 不用 smooth：剛換頁、統計還在重算，平滑捲動會被版面變動打斷（同原型）
    el.classList.remove("is-flash");
    void el.offsetWidth; // 重播動畫
    el.classList.add("is-flash");
    // 不在 cleanup 清：卡區重畫不該讓閃光卡住
    setTimeout(() => el.classList.remove("is-flash"), 1700);
  }, [focusTick, goals, showRest]);
  const upcoming = rest.filter((v) => v.state === "upcoming").length;
  const ended = rest.length - upcoming;
  const addGoal = () => openSheet({ kind: "goal", goalId: null });

  return (
    <section className="ns-tt-goals" ref={rootRef}>
      <div className="ns-tt-goals-h">
        <h3>{T.goalsTitle}</h3>
        <span className="rule" />
        {goals.length > 0 && (
          <button type="button" className="ns-btn btn-ghost" onClick={addGoal}>
            {TT_TEXT.goalAdd}
          </button>
        )}
      </div>
      {goals.length === 0 ? (
        <EmptyState
          inline
          tone="first"
          title={GOAL_MENU.emptyTitle}
          desc={GOAL_MENU.emptyDesc}
          action={{ label: GOAL_MENU.emptyAction, icon: <IconPlus />, onClick: addGoal }}
        />
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
