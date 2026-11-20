/**
 * TopicsTab——「分類與設定」對話框的「專題」籤（v1.33 功能 2 ＋ G1）。
 * 支援在不離開任何時刻表視圖的情況下管理釘選統計專題（新增、編輯、拖曳／↑↓排序、封存、還原、刪除）。
 */
import { useEffect, useState, type MouseEvent } from "react";
import { indexOfAnchor, useDragReorder } from "../../common/dragReorder";
import "./routines-tab.css";
import { parseStatTopic, type StatTopic } from "../../../domain/timetableStats";
import { timetableRepo } from "../../../data/timetableRepository";
import { TT_TEXT, useTimetableStore } from "../../../store/timetableStore";
import { useTimetableStatsStore } from "../../../store/timetableStatsStore";
import { useNodeStore } from "../../../store/nodeStore";
import { useTagStore } from "../../../store/tagStore";
import { useUiStore } from "../../../store/uiStore";
import { ManagerList, ManagerRow, SwatchDot, type PopMenuItem } from "../../common/ManagerRow";
import { EmptyState } from "../../common/EmptyState";
import { IconPlus } from "../../common/icons";
import { catColor, scopeText } from "../stats/format";
import { tagNameOf } from "../parts/TimetableTagChips";

const T = TT_TEXT.statsUi;
const pad2 = (h: number): string => String(h).padStart(2, "0");

function useTopics(): StatTopic[] | null {
  const rev = useTimetableStore((s) => s.rev);
  const [topics, setTopics] = useState<StatTopic[] | null>(null);
  useEffect(() => {
    let alive = true;
    timetableRepo
      .listStatTopics()
      .then((rows) => {
        if (!alive) return;
        const out: StatTopic[] = [];
        for (const r of rows) {
          const parsed = parseStatTopic(r);
          if (parsed) out.push(parsed);
        }
        setTopics(out);
      })
      .catch((e) => {
        console.warn("時刻表：專題清單讀不到", e);
        if (alive) setTopics((prev) => prev ?? []);
      });
    return () => {
      alive = false;
    };
  }, [rev]);
  return topics;
}

export function TopicsTab() {
  const topics = useTopics();
  const catById = useTimetableStore((s) => s.catById);
  const routes = useNodeStore((s) => s.routes);
  const treeById = useNodeStore((s) => s.tree.byId);
  const statRouteNames = useTimetableStatsStore((s) => s.routeNames);
  const statNodeNames = useTimetableStatsStore((s) => s.goalNodeNames);
  const openSheet = useTimetableStore((s) => s.openSheet);
  const archiveStatTopic = useTimetableStore((s) => s.archiveStatTopic);
  const deleteStatTopic = useTimetableStore((s) => s.deleteStatTopic);
  const reorderStatTopics = useTimetableStore((s) => s.reorderStatTopics);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const tagIndex = useTagStore((s) => s.index);

  useEffect(() => {
    const st = useTagStore.getState();
    if (!st.index && !st.loading) void st.loadIndex();
  }, []);

  const [archOpen, setArchOpen] = useState(false);
  const activeIds = (topics ?? []).filter((t) => !t.archived).map((t) => t.id);
  const [listEl, setListEl] = useState<HTMLDivElement | null>(null);

  useDragReorder({
    root: listEl,
    items: activeIds.map((id) => ({ id })),
    onDrop: (ids, place) => {
      if (place.kind !== "slot") return;
      const at = indexOfAnchor(activeIds, ids, place);
      if (at === null) return;
      const order = activeIds.filter((x) => !ids.includes(x));
      order.splice(at, 0, ...ids);
      void reorderStatTopics(order);
    },
  });

  const move = (id: string, delta: 1 | -1): void => {
    const i = activeIds.indexOf(id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= activeIds.length) return;
    const next = activeIds.slice();
    next[i] = activeIds[j];
    next[j] = activeIds[i];
    void reorderStatTopics(next);
  };

  if (topics === null) return null;
  const active = topics.filter((t) => !t.archived);
  const archived = topics.filter((t) => t.archived);
  const routeById = new Map(routes.map((r) => [r.id, r.name] as const));

  const subOf = (t: StatTopic): string => {
    const tags = t.tagKeys.map((k, idx) => (tagIndex ? tagNameOf(k) : (t.tagNames[idx] ?? k)));
    const extra = [
      ...t.routeIds.map((rid) => routeById.get(rid) ?? statRouteNames[rid]?.name ?? "路線"),
      ...t.nodeIds.map((nid) => treeById[nid]?.name ?? statNodeNames[nid]?.name ?? "項目"),
    ];
    const cut = t.dayStartHour === null ? `跟隨全域（${pad2(dayStartHour)}:00）` : `${pad2(t.dayStartHour)}:00 切日`;
    return `${cut}・${scopeText(t.categoryIds, catById, tags, extra)}`;
  };

  const dotOf = (t: StatTopic): string => {
    const first = t.categoryIds.map((id) => catById[id]).find(Boolean);
    return first ? catColor(first) : "var(--color-ink-faint)";
  };

  const edit = (id: string | null): void => openSheet({ kind: "topic", topicId: id, back: "topics" });

  const onListClick = (e: MouseEvent<HTMLElement>): void => {
    const el = e.target as HTMLElement;
    if (el.closest("button, input, select, a, [role='menu']")) return;
    const li = el.closest<HTMLElement>("li[data-id]");
    if (li?.dataset.id) edit(li.dataset.id);
  };

  return (
    <div className="ns-tt-mgr-goals">
      {active.length === 0 ? (
        <EmptyState
          tone="first"
          inline
          title="還沒有釘選統計專題"
          desc="例如「🌙 睡眠觀察（18:00 切日）」或「📚 畢業專題」。"
          action={{ label: "新增專題", icon: <IconPlus />, onClick: () => edit(null) }}
        />
      ) : (
        <>
          <div className="ns-tt-mgr-goallist is-sortable" onClick={onListClick} ref={setListEl}>
            <ManagerList label="釘選統計專題">
              {active.map((t, i) => {
                const menu: PopMenuItem[] = [
                  { key: "edit", label: "編輯…", onSelect: () => edit(t.id) },
                  { key: "archive", label: T.archive, cut: true, onSelect: () => void archiveStatTopic(t.id, true) },
                  { key: "delete", label: T.remove, danger: true, onSelect: () => void deleteStatTopic(t.id) },
                ];
                return [
                  <ManagerRow
                    key={t.id}
                    name={t.name}
                    swatch={<SwatchDot color={dotOf(t)} />}
                    menu={menu}
                    onUp={i > 0 ? () => move(t.id, -1) : undefined}
                    onDown={i < active.length - 1 ? () => move(t.id, 1) : undefined}
                    dataId={t.id}
                    dragId={t.id}
                  />,
                  <li key={`${t.id}-sub`} className="ns-tt-mgr-subli" data-id={t.id} aria-hidden="true">
                    <span className="ns-tt-mgr-tags">{subOf(t)}</span>
                  </li>,
                ];
              })}
            </ManagerList>
          </div>
          <button type="button" className="ns-btn btn-text ns-btn--sm ns-tt-mgr-addbtn" onClick={() => edit(null)}>
            <IconPlus />
            新增專題
          </button>
        </>
      )}

      {archived.length > 0 && (
        <details className="ns-tt-mgr-archived" open={archOpen} onToggle={(e) => setArchOpen(e.currentTarget.open)}>
          <summary>
            已封存 {archived.length} 個<i aria-hidden="true">›</i>
          </summary>
          <div className="ns-tt-mgr-archived-list">
            {archived.map((t) => (
              <div key={t.id} className="ns-tt-mgr-row is-archived">
                <span className="ns-tt-mgr-archived-name">
                  {t.name}
                  <small>{subOf(t)}</small>
                </span>
                <button
                  type="button"
                  className="ns-btn btn-ghost ns-btn--sm"
                  onClick={() => void archiveStatTopic(t.id, false)}
                >
                  {T.restore}
                </button>
                <button
                  type="button"
                  className="ns-btn btn-ghost ns-btn--sm ns-btn-danger"
                  onClick={() => void deleteStatTopic(t.id)}
                >
                  {T.remove}
                </button>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
