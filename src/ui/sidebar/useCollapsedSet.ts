import { useCallback, useState } from "react";

/**
 * 側邊欄群組標題收合／展開記憶（第三梯 v1.29；回饋筆記②）
 */
export function useCollapsedSet(storageKey: string): [ReadonlySet<string>, (id: string) => void] {
  const [set, setState] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set();
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return new Set();
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? new Set(parsed.filter((x): x is string => typeof x === "string")) : new Set();
    } catch {
      return new Set();
    }
  });

  const toggle = useCallback(
    (id: string) => {
      setState((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        try {
          localStorage.setItem(storageKey, JSON.stringify([...next]));
        } catch {
          /* localStorage 不可用時僅維持當次記憶體狀態 */
        }
        return next;
      });
    },
    [storageKey],
  );

  return [set, toggle];
}
