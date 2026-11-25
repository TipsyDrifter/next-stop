/**
 * TagPills — 全站 10 大畫面唯一指定「素雅無底色 #荷札 細框小牌」共用元件（D-1.36-2）。
 *
 * 規格：
 *   - 素雅無底色細框、方角 --radius-ctl (2px)，多層荷札於票面精簡印末段（#人脈/阿明 → #阿明），title 顯示完整路徑
 *   - 單列預設最多顯示 3 枚（max=3），超出收為 +N（title 列出隱藏荷札）
 *   - 點擊預設經 runAtomicNav 跳轉荷札頁；呼叫端可傳 onPick(key) 改做原地篩選
 *   - useEntityTagKeys 採 WeakMap<TagIndex, Map> 零 N+1 O(1) 查詢；若 index 尚未載入自動觸發一次 loadIndex()
 */
import { useEffect, useMemo, type MouseEvent } from "react";
import type { TagEntityType } from "../../data/tagRepository";
import { lastSeg, type TagIndex } from "../../domain/tags";
import { useTagStore } from "../../store/tagStore";
import { runAtomicNav } from "../../store/navHistoryStore";
import "./tagpills.css";

const EMPTY_KEYS: readonly string[] = [];

/** WeakMap 快取：每個 TagIndex 實例只掃一次 ents 建表，全站列表查詢 O(1) */
const entCache = new WeakMap<TagIndex, Map<string, readonly string[]>>();

function entityLookup(index: TagIndex): Map<string, readonly string[]> {
  let map = entCache.get(index);
  if (!map) {
    map = new Map<string, readonly string[]>();
    for (const e of index.ents) {
      if (e.keys.length) map.set(`${e.type}\u0001${e.id}`, e.keys);
    }
    entCache.set(index, map);
  }
  return map;
}

let requestedOnce = false;

/** 確保 tagStore.index 已觸發初次載入（冪等，零重複呼叫） */
export function useEnsureTagIndex(): TagIndex | null {
  const index = useTagStore((s) => s.index);
  useEffect(() => {
    if (index || requestedOnce) return;
    const st = useTagStore.getState();
    if (!st.index && !st.loading && !st.loadError) {
      requestedOnce = true;
      void st.loadIndex().finally(() => {
        if (!useTagStore.getState().index) requestedOnce = false;
      });
    }
  }, [index]);
  return index;
}

/** O(1) 取得某實體（如 node / note / ticket:entry / ticket:wish / timetable:block）掛載的荷札 keys */
export function useEntityTagKeys(entityType: TagEntityType, entityId: string | null | undefined): readonly string[] {
  const index = useEnsureTagIndex();
  return useMemo(() => {
    if (!index || !entityId) return EMPTY_KEYS;
    return entityLookup(index).get(`${entityType}\u0001${entityId}`) ?? EMPTY_KEYS;
  }, [index, entityType, entityId]);
}

/** 合併多個實體來源的荷札 keys（例：帳目同時合併 ticket:entry 與 ticket:repeat） */
export function useMergedEntityTagKeys(
  refs: readonly (readonly [TagEntityType, string | null | undefined])[],
): readonly string[] {
  const index = useEnsureTagIndex();
  const sig = refs.map(([t, id]) => `${t}:${id ?? ""}`).join("|");
  return useMemo(() => {
    if (!index) return EMPTY_KEYS;
    const map = entityLookup(index);
    const out: string[] = [];
    const seen = new Set<string>();
    for (const [t, id] of refs) {
      if (!id) continue;
      const ks = map.get(`${t}\u0001${id}`);
      if (!ks) continue;
      for (const k of ks) {
        if (!seen.has(k)) {
          seen.add(k);
          out.push(k);
        }
      }
    }
    return out.length ? out : EMPTY_KEYS;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, sig]);
}

export interface TagPillsProps {
  /** 要顯示的荷札 key 陣列（例如 ["人脈/阿明", "重要"]） */
  keys: readonly string[];
  /** 單列最多顯示幾枚（預設 3，超出收為 +N） */
  max?: number;
  /** 緊湊變體（用於時間塊、窄列等） */
  compact?: boolean;
  /** 點擊單枚荷札之行為；未傳預設經 runAtomicNav 跳轉荷札頁；傳 false 則為純唯讀不攔截點擊 */
  onPick?: ((key: string) => void) | false;
  className?: string;
}

export function TagPills({ keys, max = 3, compact = false, onPick, className }: TagPillsProps) {
  const index = useTagStore((s) => s.index);
  if (!keys.length) return null;

  const shown = keys.slice(0, max);
  const rest = keys.slice(max);
  const nameOf = (k: string) => index?.byKey[k]?.name ?? k;

  const handleClick = (e: MouseEvent, key: string) => {
    e.stopPropagation();
    if (onPick === false) return;
    if (onPick) {
      onPick(key);
      return;
    }
    void runAtomicNav(() => useTagStore.getState().openTagPage(key));
  };

  return (
    <span className={"ns-tagpills" + (compact ? " is-compact" : "") + (className ? ` ${className}` : "")}>
      {shown.map((k) => {
        const full = nameOf(k);
        const short = lastSeg(full);
        if (onPick === false) {
          return (
            <span key={k} className="ns-tagpill is-static" title={`#${full}`}>
              <span className="ns-tagpill-hash" aria-hidden>#</span>
              <span className="ns-tagpill-txt">{short}</span>
            </span>
          );
        }
        return (
          <button
            key={k}
            type="button"
            className="ns-tagpill"
            title={`#${full}`}
            aria-label={`荷札 #${full}`}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => handleClick(e, k)}
          >
            <span className="ns-tagpill-hash" aria-hidden>#</span>
            <span className="ns-tagpill-txt">{short}</span>
          </button>
        );
      })}
      {rest.length > 0 && (
        <span
          className="ns-tagpill-more"
          title={rest.map((k) => `#${nameOf(k)}`).join("  ")}
          aria-label={`另有 ${rest.length} 枚荷札`}
        >
          +{rest.length}
        </span>
      )}
    </span>
  );
}

/** 給定實體型別與 id 直接渲染素雅 #荷札小牌（零 N+1） */
export function EntityTagPills({
  entityType,
  entityId,
  max = 3,
  compact = false,
  onPick,
  className,
}: Omit<TagPillsProps, "keys"> & {
  entityType: TagEntityType;
  entityId: string | null | undefined;
}) {
  const keys = useEntityTagKeys(entityType, entityId);
  if (!keys.length) return null;
  return <TagPills keys={keys} max={max} compact={compact} onPick={onPick} className={className} />;
}

/** 時刻表窄時間塊濃縮 `#` 微記號（滑過顯示所有完整荷札名） */
export function TagDotHint({ keys, className }: { keys: readonly string[]; className?: string }) {
  const index = useTagStore((s) => s.index);
  if (!keys.length) return null;
  const tip = keys.map((k) => `#${index?.byKey[k]?.name ?? k}`).join("  ");
  return (
    <span className={"ns-tagdot" + (className ? ` ${className}` : "")} title={tip} aria-label={`荷札：${tip}`}>
      #
    </span>
  );
}
