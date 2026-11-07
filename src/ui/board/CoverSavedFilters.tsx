/**
 * 書封「我的路線」底下一段「常用篩選」（⑫；契約 §3）：有存才出現，點了切到路線圖的篩選分頁並套用。
 * 手機沒有書封，常用篩選只放篩選分頁頂那排 chip（契約 §4）。
 * 右邊的張數跟著資料變：只有存過篩選才查（去抖，一次寫入常常換好幾片切片）。
 * 本機還沒存過也要看得到另一台存的：同步拉完只讀那一格設定（有存才查任務）。
 */
import { useEffect } from "react";
import { useBoardStore } from "../../store/boardStore";
import { useNodeStore } from "../../store/nodeStore";
import { onAfterPull } from "../../store/syncStore";
import { useTagStore } from "../../store/tagStore";
import { useUiStore } from "../../store/uiStore";
import { openSavedFilter } from "./openFilter";
import { useSavedCounts } from "./useSavedCounts";

function FilterGlyph() {
  return (
    <svg className="sf-ico" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" aria-hidden>
      <path d="M2 2.5h10L8.2 7.2v4L5.8 12.3V7.2Z" />
    </svg>
  );
}

export function CoverSavedFilters() {
  const saved = useBoardStore((s) => s.saved);
  const activeId = useBoardStore((s) => s.activeSavedId);
  const tab = useBoardStore((s) => s.overviewTab);
  const page = useUiStore((s) => s.page);
  const overview = useUiStore((s) => s.routeOverview);
  const tree = useNodeStore((s) => s.tree);
  // 沒開任何路線時 tree 不換，今日切片每次重載都換
  const todaySlice = useNodeStore((s) => s.today);
  const index = useTagStore((s) => s.index);
  const onFilterTab = page === "routemap" && overview && tab === "filter";

  useEffect(() => void useBoardStore.getState().ensureLoaded(), []);
  useEffect(() => onAfterPull(() => void useBoardStore.getState().reloadSaved()), []);
  const has = saved.length > 0;
  useEffect(() => {
    if (!has) return;
    if (!index) void useTagStore.getState().loadIndex();
    if (onFilterTab) return; // 篩選分頁開著：它自己會重查
    const t = window.setTimeout(() => void useBoardStore.getState().refresh(), 400);
    return () => window.clearTimeout(t);
  }, [has, tree, todaySlice, index, onFilterTab]);
  const counts = useSavedCounts();

  if (!has) return null;
  return (
    <div className="ns-cover-saved">
      <h2>常用篩選</h2>
      {saved.map((s) => {
        const active = onFilterTab && activeId === s.id;
        return (
          <div key={s.id} className="line-row">
            <button type="button" className={`line-item${active ? " active" : ""}`} aria-current={active ? "page" : undefined} title={s.name} onClick={() => openSavedFilter(s.id)}>
              <FilterGlyph />
              <span className="line-name">{s.name}</span>
            </button>
            {counts[s.id] > 0 && (
              <span className="ns-routecount line-count" aria-hidden="true">
                {counts[s.id]}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
