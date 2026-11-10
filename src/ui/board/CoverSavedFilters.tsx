/**
 * 書封「我的路線」底下一段「常用篩選」（⑫；契約 §3）：有存才出現，點了切到路線圖的篩選分頁並套用。
 * 手機沒有書封，常用篩選只放篩選分頁頂那排 chip（契約 §4）。
 * 右邊的張數跟著資料變：只有存過篩選才查（去抖，一次寫入常常換好幾片切片）。
 * 本機還沒存過也要看得到另一台存的：同步拉完只讀那一格設定（有存才查任務）。
 * TICKET-1B：支援雙擊直接改名，列尾浮現「改名」與「刪除」常用圖示鈕。
 */
import { useEffect, useRef, useState } from "react";
import { useBoardStore } from "../../store/boardStore";
import { useNodeStore } from "../../store/nodeStore";
import { onAfterPull } from "../../store/syncStore";
import { useTagStore } from "../../store/tagStore";
import { useUiStore } from "../../store/uiStore";
import { IconClose, IconEdit } from "../common/icons";
import { useCollapsedSet } from "../sidebar/useCollapsedSet";
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
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const [collapsedSet, toggleFold] = useCollapsedSet("ns.sidebar.collapsed_saved_filters");
  const folded = collapsedSet.has("saved_filters");

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

  const startEdit = (id: string, name: string) => {
    setEditingId(id);
    setEditText(name);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  };

  const commitEdit = (id: string, oldName: string) => {
    const trimmed = editText.trim();
    setEditingId(null);
    if (trimmed && trimmed !== oldName) {
      void useBoardStore.getState().renameSaved(id, trimmed);
    }
  };

  if (!has) return null;
  return (
    <div className="ns-cover-saved">
      <h2
        className={`trunk-toggle${folded ? " is-folded" : ""}`}
        role="button"
        tabIndex={0}
        aria-expanded={!folded}
        title={folded ? `展開常用篩選（${saved.length} 項）` : "收合常用篩選"}
        onClick={() => toggleFold("saved_filters")}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggleFold("saved_filters");
          }
        }}
      >
        <span>常用篩選</span>
        <span className="trunk-caret" aria-hidden="true">
          {folded ? `${saved.length} ▸` : "▾"}
        </span>
      </h2>
      {!folded &&
        saved.map((s) => {
        const active = onFilterTab && activeId === s.id;
        const isEditing = editingId === s.id;
        return (
          <div key={s.id} className="line-row">
            {isEditing ? (
              <div className={`line-item${active ? " active" : ""}`}>
                <FilterGlyph />
                <input
                  ref={inputRef}
                  className="techo-input line-name"
                  value={editText}
                  aria-label={`改名：${s.name}`}
                  onChange={(e) => setEditText(e.target.value)}
                  onBlur={() => commitEdit(s.id, s.name)}
                  onKeyDown={(e) => {
                    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                    if (e.key === "Enter") {
                      e.preventDefault();
                      commitEdit(s.id, s.name);
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      setEditingId(null);
                    }
                  }}
                />
              </div>
            ) : (
              <button
                type="button"
                className={`line-item${active ? " active" : ""}`}
                aria-current={active ? "page" : undefined}
                title={`${s.name}（雙擊改名）`}
                onClick={() => openSavedFilter(s.id)}
                onDoubleClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  startEdit(s.id, s.name);
                }}
              >
                <FilterGlyph />
                <span className="line-name">{s.name}</span>
              </button>
            )}
            {counts[s.id] > 0 && (
              <span className="ns-routecount line-count" aria-hidden="true">
                {counts[s.id]}
              </span>
            )}
            {!isEditing && (
              <div className="ns-cover-saved-acts">
                <button
                  type="button"
                  className="ns-iconbtn is-dim ns-cover-saved-btn"
                  aria-label={`改名：${s.name}`}
                  title="改名（或雙擊）"
                  onClick={(e) => {
                    e.stopPropagation();
                    startEdit(s.id, s.name);
                  }}
                >
                  <IconEdit size={12} />
                </button>
                <button
                  type="button"
                  className="ns-iconbtn is-dim ns-cover-saved-btn is-danger"
                  aria-label={`刪除：${s.name}`}
                  title="刪除常用篩選"
                  onClick={(e) => {
                    e.stopPropagation();
                    void useBoardStore.getState().removeSaved(s.id);
                  }}
                >
                  <IconClose size={12} />
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
