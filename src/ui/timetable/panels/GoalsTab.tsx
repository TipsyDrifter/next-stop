/**
 * GoalsTab——「分類與設定」對話框的「目標」籤（UI 丙-4 B3；契約 §1 B3、§5 P2）。
 * 不進統計頁也管得到時數目標：沒封存的目標一列一個（`ManagerRow`：名稱、分類色點、⋯ 編輯…／封存／刪除），
 * 點列或「編輯…」開 GoalPanel（`openSheet({kind:"goal", goalId, back:"goals"})`，換掉這個對話框、做完回到這一籤）；「＋ 新增目標」文字鈕；已封存摺疊＋「還原」。
 * 沒有目標時 `EmptyState inline`（它的鈕就是「新增目標」，同頁上方那顆隱藏——規範 §2.7 同一動作一個入口）。
 *
 * - 資料直接向 repository 讀（`listGoals`＋`parseGoal`，同 GoalPanel 的補讀）：統計頁沒開時 `timetableStatsStore.goalList` 是空的，
 *   這個籤不能靠它。寫入一律走 store（archiveGoal／deleteGoal 都帶 toast「復原」），寫完 store 的 `rev` 會變 ⇒ 重讀一次。
 *   讀到之前什麼都不畫（§1.8：資料未到不畫空狀態）。
 * - 刪除照 GoalPanel 現行的做法：不另問，toast 帶「復原」（規範 §2.4：可復原的直接做）。
 * - 目標沒有排序 API（position 由新增順序決定）⇒ ManagerRow 的 ↑↓ 在這一籤藏起來（CSS），不畫一排永遠禁用的箭頭。
 * - 名字下一行淡字＝期間＋範圍（「每週至少 10h・創作」）；ManagerRow 沒有這個插槽，畫成緊接的 `li.ns-tt-mgr-subli`（同分類籤）。
 * - 分類色點：範圍裡第一個分類的色（只綁荷札的目標＝淡墨點）。
 */
import { useEffect, useState, type MouseEvent } from "react";
import { parseGoal, type Goal } from "../../../domain/timetableStats";
import { TT_TAG_GOAL } from "../../../domain/timetableTags";
import { timetableRepo } from "../../../data/timetableRepository";
import { TT_TEXT, useTimetableStore } from "../../../store/timetableStore";
import { useTagStore } from "../../../store/tagStore";
import { useUiStore } from "../../../store/uiStore";
import { ManagerList, ManagerRow, SwatchDot, type PopMenuItem } from "../../common/ManagerRow";
import { EmptyState } from "../../common/EmptyState";
import { IconPlus } from "../../common/icons";
import { catColor, goalPeriodText, scopeText } from "../stats/format";
import { tagNameOf } from "../parts/TimetableTagChips";

const T = TT_TEXT.statsUi;

/** 目標清單（含封存；未刪除、讀得懂的）；null＝還沒讀到 */
function useGoals(): Goal[] | null {
  const rev = useTimetableStore((s) => s.rev);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const [goals, setGoals] = useState<Goal[] | null>(null);
  useEffect(() => {
    let alive = true;
    timetableRepo
      .listGoals()
      .then((rows) => {
        if (!alive) return;
        const out: Goal[] = [];
        for (const r of rows) {
          if (r.deleted_at !== null) continue;
          const g = parseGoal(r, dayStartHour);
          if (g) out.push(g);
        }
        setGoals(out);
      })
      .catch((e) => {
        console.warn("時刻表：目標清單讀不到", e);
        if (alive) setGoals((g) => g ?? []);
      });
    return () => {
      alive = false;
    };
  }, [rev, dayStartHour]);
  return goals;
}

export function GoalsTab() {
  const goals = useGoals();
  const catById = useTimetableStore((s) => s.catById);
  const openSheet = useTimetableStore((s) => s.openSheet);
  const archiveGoal = useTimetableStore((s) => s.archiveGoal);
  const deleteGoal = useTimetableStore((s) => s.deleteGoal);
  const tagIndex = useTagStore((s) => s.index);
  useEffect(() => {
    const st = useTagStore.getState();
    if (!st.index && !st.loading) void st.loadIndex();
  }, []);
  const [archOpen, setArchOpen] = useState(false);

  if (goals === null) return null;
  const active = goals.filter((g) => !g.archived);
  const archived = goals.filter((g) => g.archived);
  // 荷札：index 載好就看 index（timetable:goal），沒載好就是空的（只影響淡字那一行）
  const tagsOf = (g: Goal): string[] => (tagIndex ? useTagStore.getState().keysOf(TT_TAG_GOAL, g.id).map(tagNameOf) : []);
  const subOf = (g: Goal): string => `${goalPeriodText(g)}・${scopeText(g.categoryIds, catById, tagsOf(g))}`;
  const dotOf = (g: Goal): string => {
    const first = g.categoryIds.map((id) => catById[id]).find(Boolean);
    return first ? catColor(first) : "var(--color-ink-faint)";
  };
  // back "goals"：GoalPanel 做完回到這一籤（UI 丙-4 修，T7 評審 5），不是整個對話框關掉
  const edit = (id: string | null): void => openSheet({ kind: "goal", goalId: id, back: "goals" });

  // 點列（名稱或底下那行）＝編輯；列裡的按鈕（↑↓ 藏著、⋯）與選單自己處理
  const onListClick = (e: MouseEvent<HTMLElement>): void => {
    const t = e.target as HTMLElement;
    if (t.closest("button, input, select, a, [role='menu']")) return;
    const li = t.closest<HTMLElement>("li[data-id]");
    if (li?.dataset.id) edit(li.dataset.id);
  };

  return (
    <div className="ns-tt-mgr-goals">
      {active.length === 0 ? (
        <EmptyState
          tone="first"
          inline
          title="還沒有目標"
          desc="例如：每週創作 10 小時。"
          action={{ label: "新增目標", icon: <IconPlus />, onClick: () => edit(null) }}
        />
      ) : (
        <>
          <div className="ns-tt-mgr-goallist" onClick={onListClick}>
            <ManagerList label="時數目標">
              {active.map((g) => {
                const menu: PopMenuItem[] = [
                  { key: "edit", label: "編輯…", onSelect: () => edit(g.id) },
                  { key: "archive", label: T.archive, onSelect: () => void archiveGoal(g.id, true) },
                  { key: "delete", label: T.remove, cut: true, danger: true, onSelect: () => void deleteGoal(g.id) },
                ];
                return [
                  <ManagerRow
                    key={g.id}
                    name={g.name}
                    swatch={<SwatchDot color={dotOf(g)} />}
                    menu={menu}
                    dataId={g.id}
                    className="is-goal"
                  />,
                  <li key={g.id + "-sub"} className="ns-tt-mgr-subli is-goal" data-id={g.id}>
                    <span className="ns-tt-mgr-tags">{subOf(g)}</span>
                  </li>,
                ];
              })}
            </ManagerList>
          </div>
          <button type="button" className="ns-btn btn-text ns-btn--sm ns-tt-mgr-addbtn" onClick={() => edit(null)}>
            <IconPlus />
            新增目標
          </button>
        </>
      )}

      {archived.length > 0 && (
        <details className="ns-tt-mgr-archived" open={archOpen} onToggle={(e) => setArchOpen(e.currentTarget.open)}>
          <summary>
            已封存 {archived.length} 個<i aria-hidden="true">›</i>
          </summary>
          <div className="ns-tt-mgr-archived-list">
            {archived.map((g) => (
              <div key={g.id} className="ns-tt-mgr-row is-archived ns-tt-mgr-goal-arch">
                <SwatchDot color={dotOf(g)} />
                <span className="ns-tt-mgr-archived-name">
                  {g.name}
                  <small>{subOf(g)}</small>
                </span>
                <button type="button" className="ns-btn btn-ghost ns-btn--sm" onClick={() => void archiveGoal(g.id, false)}>
                  {T.restore}
                </button>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
