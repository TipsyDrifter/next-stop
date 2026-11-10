/**
 * TimetableCoverAux——時刻表頁的書封頁務件（丁 D-主-236；規則 D-主-234「頁務件＝這一頁的目錄或篩選，點了留在這頁」；
 * 視覺真相＝prototypes/design-structure-側欄.html A1「時刻表」欄）。經 `timetable.mount.tsx` 的 `sidebarAux` 掛上；
 * 之前時刻表沒掛，書封畫的是「我的路線」，點了會跳去路線圖（盤點附錄 C）。
 *
 *   div.lines.page-aux.ns-tt-cover（頁務件共用骨架在 sidebar.css〈頁務件的共用骨架〉：h2 固定、.page-aux-body 自己捲）
 *   ├ h2「時刻表 TIMETABLE」
 *   ├ 運行中那班（分類圓牌＋名稱＋「HH:MM 発」＋計時）；點了＝打開「改這一班」（同運行列點出發時間）。停車中不畫。
 *   ├ h2.sub「今天 TODAY」＋三組編成條＋每組時數（同軸頂 DaySummary 的口徑，只換成今天）
 *   ├ 「目標 N 項 ▸」預設收合一行（1366×768 擠不下四段；本機記住開合）；展開＝每個進行中的目標一列「名稱　12h / 30h」＋細條，
 *   │   點了＝切到統計（目標卡在那裡）
 *   └ h2.sub「分類 CATEGORIES」＋組（小字）→ 分類（圓牌＋名稱＋今天時數）；點分類＝切到統計、只看這個分類（同 Ctrl+P `@分類`）
 *
 * 目標的進度借 `timetableStatsStore.goals`（統計頁算的那一份）：還沒算過就請它算一次，算完放手（`release`），
 * 統計頁本身掛著時不放（它自己管）。資料變了（`rev`）而目標區開著就再算一次。
 */
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { colorSlot, fmtClock, fmtDur, fmtHMS, groupedCategories, msOf, toSpan, totalsByCategory, totalsByGroup, MIN } from "../../domain/timetable";
import { useTimetableStore } from "../../store/timetableStore";
import { useTimetableStatsStore } from "../../store/timetableStatsStore";
import { useUiStore } from "../../store/uiStore";
import { timetableRepo } from "../../data/timetableRepository";
import { dayWindow } from "../../lib/date";
import { CategoryBadge } from "./CategoryBadge";
import { useCollapsedSet } from "../sidebar/useCollapsedSet";
import { useNow } from "./useNow";
import "./coverAux.css";

const GOALS_OPEN_KEY = "ns.timetable.coverGoalsOpen";

function readGoalsOpen(): boolean {
  try {
    return localStorage.getItem(GOALS_OPEN_KEY) === "1";
  } catch {
    return false;
  }
}
function writeGoalsOpen(on: boolean): void {
  try {
    localStorage.setItem(GOALS_OPEN_KEY, on ? "1" : "0");
  } catch {
    /* 私密視窗或封鎖儲存：只是不記住 */
  }
}

/** 點分類＝切到統計、只看這個分類（荷札那一面看不到分類過濾，先切回分類面；同 quickJump.ts openCategoryStats） */
function showCategoryStats(id: string): void {
  useTimetableStore.getState().setView("stats");
  const st = useTimetableStatsStore.getState();
  if (st.shareBy !== "cat") st.setShareBy("cat");
  st.setFilter({ kind: "cat", id });
}

export function TimetableCoverAux() {
  const running = useTimetableStore((s) => s.running);
  const categories = useTimetableStore((s) => s.categories);
  const catById = useTimetableStore((s) => s.catById);
  const todayBlocks = useTimetableStore((s) => s.todayBlocks);
  const todayKey = useTimetableStore((s) => s.todayKey);
  const view = useTimetableStore((s) => s.view);
  const rev = useTimetableStore((s) => s.rev);
  const openSheet = useTimetableStore((s) => s.openSheet);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const goals = useTimetableStatsStore((s) => s.goals);
  const filter = useTimetableStatsStore((s) => s.filter);
  const now = useNow(running ? 1000 : 60_000);
  const [goalsOpen, setGoalsOpen] = useState(readGoalsOpen);
  const [collapsedGroups, toggleGroupFold] = useCollapsedSet("ns.sidebar.collapsed_tt_groups");
  /** 收合時那一行的「N 項」＝沒封存的目標數（只讀列，不算進度；展開才借統計算） */
  const [goalCount, setGoalCount] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    timetableRepo.listGoals().then(
      (rows) => alive && setGoalCount(rows.filter((r) => r.archived_at === null && r.deleted_at === null).length),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [rev]);

  const groups = useMemo(() => groupedCategories(categories), [categories]);
  const { byCat, byGroup, total } = useMemo(() => {
    const w = dayWindow(todayKey, dayStartHour);
    const t = totalsByCategory(todayBlocks.map(toSpan), { start: msOf(w.start), end: msOf(w.end) }, now);
    const g = totalsByGroup(t, categories);
    return { byCat: t, byGroup: g, total: Object.values(g).reduce((a, b) => a + b, 0) };
  }, [todayBlocks, todayKey, dayStartHour, categories, now]);

  // 目標：開著才要數字；統計頁沒掛著就借算一次、算完放手
  useEffect(() => {
    if (!goalsOpen) return;
    const st = useTimetableStatsStore.getState();
    void st.load();
    if (useTimetableStore.getState().view !== "stats") st.release("stats");
  }, [goalsOpen, rev]);

  const activeGoals = goals.filter((g) => g.state === "active");
  /** 組的顏色＝它第一個分類的色（組本身多半沒設色，三段條才分得出來） */
  const groupColor = (g: { group: { color_idx: number }; children: { color_idx: number }[] }) => colorSlot(g.children[0]?.color_idx ?? g.group.color_idx);
  const toggleGoals = () => {
    setGoalsOpen((on) => {
      writeGoalsOpen(!on);
      return !on;
    });
  };
  const pickedCat = view === "stats" && filter?.kind === "cat" ? filter.id : null;
  const runCat = running ? (catById[running.category_id] ?? null) : null;

  return (
    <div className="lines page-aux ns-tt-cover" aria-label="時刻表的目錄">
      <h2>時刻表 TIMETABLE</h2>
      <div className="page-aux-body">
        {running && (
          <button
            type="button"
            className="ns-tt-cover-run"
            title="改這一班"
            onClick={() => openSheet({ kind: "edit", blockId: running.id })}
          >
            <CategoryBadge cat={runCat} size="sm" live />
            <span className="nm">
              <b>{runCat?.name ?? "（分類已刪除）"}</b>
              <small>{fmtClock(msOf(running.started_at))} 発</small>
            </span>
            <span className="el">{fmtHMS(now - msOf(running.started_at))}</span>
          </button>
        )}

        <h2 className="sub">今天 TODAY</h2>
        <div className="ns-tt-cover-today">
          {total >= MIN && (
            <div className="bar" aria-hidden="true">
              {groups.map((g) => {
                const ms = byGroup[g.group.id] ?? 0;
                if (ms <= 0) return null;
                const style = { flex: ms, "--c": `var(--ns-tt-cat-${groupColor(g)})` } as CSSProperties;
                return <i key={g.group.id} style={style} />;
              })}
            </div>
          )}
          <dl>
            {groups.map((g) => (
              <div key={g.group.id}>
                <dt>
                  <i style={{ "--c": `var(--ns-tt-cat-${groupColor(g)})` } as CSSProperties} aria-hidden="true" />
                  {g.group.name}
                </dt>
                <dd>{fmtDur(byGroup[g.group.id] ?? 0)}</dd>
              </div>
            ))}
          </dl>
        </div>

        <button type="button" className="line-item ns-tt-cover-goalbtn" aria-expanded={goalsOpen} onClick={toggleGoals}>
          <span className="line-name">本週目標</span>
          <span className="n">{goalsOpen ? "▾" : `${goalCount ?? "…"} 項 ▸`}</span>
        </button>
        {goalsOpen && (
          <div className="ns-tt-cover-goals">
            {activeGoals.length === 0 ? (
              <p className="none">沒有進行中的目標</p>
            ) : (
              activeGoals.map((g) => (
                <button
                  key={g.goal.id}
                  type="button"
                  className="line-item ns-tt-cover-goal"
                  title="在統計看這個目標"
                  onClick={() => useTimetableStore.getState().setView("stats")}
                >
                  <span className="row">
                    <span className="line-name">{g.goal.name}</span>
                    <span className="n">
                      {fmtDur(g.cur.ms)} / {fmtDur(g.goal.targetMin * MIN)}
                    </span>
                  </span>
                  <span className="track" aria-hidden="true">
                    <i style={{ width: `${Math.min(100, Math.round(g.cur.ratio * 100))}%` }} />
                  </span>
                </button>
              ))
            )}
          </div>
        )}

        <h2 className="sub">分類 CATEGORIES</h2>
        <div className="ns-tt-cover-cats" role="group" aria-label="點分類＝在統計只看它">
          {groups.map(({ group, children }) => {
            const folded = collapsedGroups.has(group.id);
            return (
              <div key={group.id}>
                <div
                  className={`trunk trunk-toggle${folded ? " is-folded" : ""}`}
                  role="button"
                  tabIndex={0}
                  aria-expanded={!folded}
                  title={folded ? `展開「${group.name}」（${children.length} 項）` : `收合「${group.name}」`}
                  onClick={() => toggleGroupFold(group.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      toggleGroupFold(group.id);
                    }
                  }}
                >
                  <span>{group.name}</span>
                  <span className="trunk-caret" aria-hidden="true">
                    {folded ? `${children.length} ▸` : "▾"}
                  </span>
                </div>
                {!folded &&
                  children.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className={`line-item ns-tt-cover-cat${pickedCat === c.id ? " active" : ""}`}
                      aria-pressed={pickedCat === c.id}
                      title={`在統計只看「${c.name}」`}
                      onClick={() => showCategoryStats(c.id)}
                    >
                      <CategoryBadge cat={c} size="sm" />
                      <span className="line-name">{c.name}</span>
                      {(byCat[c.id] ?? 0) >= MIN && <span className="n">{fmtDur(byCat[c.id])}</span>}
                    </button>
                  ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
