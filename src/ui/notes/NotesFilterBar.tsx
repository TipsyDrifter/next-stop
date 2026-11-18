/**
 * NotesFilterBar——旅客筆記「筆記列表」與「收件匣」共用的排序切換 ＋ `#荷札` 組合篩選條（v1.32 2B-2）。
 *
 * 雙殼對等：
 *   - 排序切換：`最近修改` ｜ `建立時間`（複用共用 `Segmented` `compact`）
 *   - `#荷札` 組合篩選：讀取 `useTagStore.index`（尚未載入時自動 `loadIndex()`），
 *     支援多選 AND 交集與父荷札含子荷札，選中時呈現可個別摘除的 `#荷札 ×` 膠囊與一鍵「清除」
 *   - 桌機開錨定 `.techo-card` 浮層（`placeBelow` ＋ `useOutsideDismiss`）；手機開共用 `MSheet`（含 `backId` 返回層）
 */
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  NOTE_SORT_OPTIONS,
  collectAvailableTags,
  type AvailableTagOption,
  type NoteSort,
} from "../../domain/notesFilter";
import { isMobileShell } from "../../lib/shell";
import { useNotesStore } from "../../store/notesStore";
import { useTagStore } from "../../store/tagStore";
import { placeBelow, useOutsideDismiss } from "../common/anchorPop";
import { IconChevron, IconClose, IconSearch } from "../common/icons";
import { MSheet } from "../common/MSheet";
import { Segmented } from "../common/Segmented";
import { IconTag } from "./notesBits";
import "./notes.css";

export interface NotesFilterBarProps {
  shell?: "desktop" | "mobile";
  sort: NoteSort;
  onSortChange: (sort: NoteSort) => void;
  sortLabel?: string;
  selectedTagKeys: readonly string[];
  onToggleTagKey: (key: string) => void;
  onClearTagKeys: () => void;
  /** 要統計與篩選的荷札實體種類：筆記列表傳 `["note"]`；收件匣傳 `["note", "node"]` */
  entityTypes: readonly string[];
  /** 限定統計特定 id 集合（如收件匣內的待整理筆記＋臨時車票） */
  allowedIds?: ReadonlySet<string>;
  /** 排除子種類（筆記列表排除 `"diary"`） */
  excludeKinds?: readonly string[];
  /** 手機 `MSheet` 返回堆疊識別碼 */
  backId: string;
  /** 左側前置篩選元件（例如桌機收件匣的「全部｜筆記｜臨時車票」種類膠囊） */
  leading?: ReactNode;
  /** 是否有荷札以外的連動篩選啟用（若給 `onClearAll`，一鍵同時清掉） */
  hasExtraFilter?: boolean;
  onClearAll?: () => void;
  /** 筆記列表設為 true：當 `tagStore.index` 變動且有啟用荷札篩選時自動重載筆記清單 */
  syncNotesOnTagChange?: boolean;
  className?: string;
}

interface AnchoredTagPopProps {
  anchor: HTMLElement | null;
  label: string;
  onClose: () => void;
  children: ReactNode;
}

function AnchoredTagPop({ anchor, label, onClose, children }: AnchoredTagPopProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useOutsideDismiss(ref, onClose, anchor);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !anchor) return;
    const p = placeBelow(anchor, el);
    if (p) setPos(p);
  }, [anchor, children]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.ctrlKey || e.metaKey) return;
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      anchor?.focus({ preventScroll: true });
    }
  };

  return createPortal(
    <div
      ref={ref}
      role="group"
      aria-label={label}
      onKeyDown={onKeyDown}
      onMouseDown={(e) => e.stopPropagation()}
      className="techo-card ns-notes-tagpop"
      style={{
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
        visibility: pos ? "visible" : "hidden",
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

export function NotesFilterBar({
  shell,
  sort,
  onSortChange,
  sortLabel = "排序依據",
  selectedTagKeys,
  onToggleTagKey,
  onClearTagKeys,
  entityTypes,
  allowedIds,
  excludeKinds,
  backId,
  leading,
  hasExtraFilter = false,
  onClearAll,
  syncNotesOnTagChange = false,
  className,
}: NotesFilterBarProps) {
  const mobile = (shell ?? (isMobileShell() ? "mobile" : "desktop")) === "mobile";
  const tagIndex = useTagStore((s) => s.index);
  const tagLoading = useTagStore((s) => s.loading);
  const tagLoadError = useTagStore((s) => s.loadError);

  const [open, setOpen] = useState(false);
  const [filterText, setFilterText] = useState("");
  const tagComposingRef = useRef(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const ts = useTagStore.getState();
    if (!ts.index && !ts.loading && !ts.loadError) {
      void ts.loadIndex();
    }
  }, []);

  useEffect(() => {
    if (!syncNotesOnTagChange) return;
    return useTagStore.subscribe((s, p) => {
      if (s.index !== p.index && useNotesStore.getState().notesTagKeys.length > 0) {
        void useNotesStore.getState().loadNotes();
      }
    });
  }, [syncNotesOnTagChange]);

  const tagOptions = useMemo(
    () =>
      collectAvailableTags(tagIndex, {
        entityTypes,
        allowedIds,
        excludeKinds,
        selectedKeys: selectedTagKeys,
      }),
    [tagIndex, entityTypes, allowedIds, excludeKinds, selectedTagKeys],
  );

  const selectedSet = useMemo(() => new Set(selectedTagKeys), [selectedTagKeys]);

  const filteredOptions = useMemo(() => {
    const q = filterText.trim().toLowerCase();
    if (!q) return tagOptions;
    return tagOptions.filter(
      (opt) => opt.name.toLowerCase().includes(q) || opt.seg.toLowerCase().includes(q),
    );
  }, [tagOptions, filterText]);

  const displayNameOf = (key: string): string => {
    return tagIndex?.byKey[key]?.name ?? key;
  };

  const hasTags = selectedTagKeys.length > 0;
  const canClearAll = hasTags || hasExtraFilter;
  const handleClear = () => {
    if (onClearAll) onClearAll();
    else onClearTagKeys();
  };

  const closePicker = () => {
    setOpen(false);
    setFilterText("");
  };

  const renderPickerBody = () => (
    <div className="ns-notes-tagpop-in">
      <div className="ns-notes-tagpop-hd">
        <span className="ov">荷札組合篩選{hasTags ? ` · 已選 ${selectedTagKeys.length}` : ""}</span>
        {hasTags && (
          <button
            type="button"
            className="ns-notes-tagpop-clr"
            onClick={() => onClearTagKeys()}
          >
            清除
          </button>
        )}
      </div>

      {tagOptions.length > 6 && (
        <label className="ns-notes-tagpop-q">
          <IconSearch size={12} />
          <input
            type="search"
            className="techo-input"
            value={filterText}
            onCompositionStart={() => {
              tagComposingRef.current = true;
            }}
            onCompositionEnd={(e) => {
              tagComposingRef.current = false;
              setFilterText(e.currentTarget.value);
            }}
            onChange={(e) => setFilterText(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229 || tagComposingRef.current) {
                e.stopPropagation();
                return;
              }
              if (e.key === "Escape" && filterText) {
                e.preventDefault();
                e.stopPropagation();
                setFilterText("");
              } else if (e.key !== "Escape" && !e.ctrlKey && !e.metaKey) {
                e.stopPropagation();
              }
            }}
            placeholder="篩選荷札名稱…"
            aria-label="篩選荷札名稱"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
      )}

      {!tagIndex && tagLoading ? (
        <p className="ns-notes-tagpop-empty">載入荷札…</p>
      ) : !tagIndex && tagLoadError ? (
        <div className="ns-notes-tagpop-empty">
          <span>荷札尚未載入</span>
          <button
            type="button"
            className="ns-notes-tagpop-clr"
            onClick={() => void useTagStore.getState().loadIndex()}
          >
            重試
          </button>
        </div>
      ) : filteredOptions.length === 0 ? (
        <p className="ns-notes-tagpop-empty">
          {tagOptions.length === 0 ? "目前沒有可用的 #荷札" : `找不到「${filterText.trim()}」`}
        </p>
      ) : (
        <div className="ns-notes-tagpop-list techo-scroll" role="group" aria-label="可選荷札">
          {filteredOptions.map((opt: AvailableTagOption) => {
            const checked = selectedSet.has(opt.key);
            const searching = filterText.trim().length > 0;
            return (
              <button
                key={opt.key}
                type="button"
                role="checkbox"
                aria-checked={checked}
                className={`ns-notes-tagpop-item${checked ? " is-on" : ""}`}
                style={!searching && opt.depth > 0 ? { paddingLeft: `${10 + opt.depth * 14}px` } : undefined}
                onClick={() => onToggleTagKey(opt.key)}
              >
                <span className={`ck${checked ? " is-on" : ""}`} aria-hidden>
                  {checked ? "✓" : ""}
                </span>
                <span className="nm">
                  <span className="hash">#</span>
                  {searching ? opt.name : opt.seg}
                </span>
                <span className="cnt">{opt.count}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );

  const rootCls = [
    mobile ? "ns-notes-mfbar-wrap" : "ns-notes-fbar-wrap",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={rootCls}>
      <div className={mobile ? "ns-notes-mfbar" : "ns-notes-fbar"}>
        {leading}
        <button
          ref={btnRef}
          type="button"
          className={`ns-notes-fbtn${hasTags ? " is-on" : ""}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => {
            if (!open) {
              const ts = useTagStore.getState();
              if (!ts.index && !ts.loading) void ts.loadIndex();
            }
            setOpen((v) => !v);
          }}
        >
          <IconTag size={12} />
          <span>#荷札{hasTags ? ` ${selectedTagKeys.length}` : ""}</span>
          <IconChevron open={open} size={11} />
        </button>

        {canClearAll && !hasTags && onClearAll && (
          <button type="button" className="ns-notes-fclear" onClick={handleClear}>
            清除篩選
          </button>
        )}

        <div className="ns-notes-fsort">
          <Segmented
            options={NOTE_SORT_OPTIONS}
            value={sort}
            onChange={onSortChange}
            compact
            aria-label={sortLabel}
          />
        </div>
      </div>

      {hasTags && (
        <div className={mobile ? "ns-notes-mfbar-tags" : "ns-notes-fbar-tags"} role="group" aria-label="已選荷札篩選">
          {selectedTagKeys.map((key) => {
            const label = displayNameOf(key);
            return (
              <span key={key} className="ns-notes-ftag">
                <span className="nm">#{label}</span>
                <button
                  type="button"
                  className="rm"
                  title="移除此荷札篩選"
                  aria-label={`移除 #${label} 篩選`}
                  onClick={() => onToggleTagKey(key)}
                >
                  <IconClose size={11} />
                </button>
              </span>
            );
          })}
          <button type="button" className="ns-notes-fclear" onClick={handleClear}>
            清除
          </button>
        </div>
      )}

      {open &&
        (mobile ? (
          <MSheet title="篩選 #荷札" onClose={closePicker} backId={backId} backKind="sheet">
            {renderPickerBody()}
          </MSheet>
        ) : (
          <AnchoredTagPop anchor={btnRef.current} label="篩選荷札" onClose={closePicker}>
            {renderPickerBody()}
          </AnchoredTagPop>
        ))}
    </div>
  );
}
