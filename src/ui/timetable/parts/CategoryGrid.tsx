/**
 * CategoryGrid——分類格（車次①a 契約 §5.1；乙席）。兩殼共用 DOM，差異只在 CSS。
 * DOM（class 即契約）：依 `groupedCategories` 分段：
 *   div.ns-tt-group > span.ns-tt-group-name ＋ div.ns-tt-cats[.is-compact] > button.ns-tt-cat[.is-on][.is-live]
 *   （Badge＋span.ns-tt-cat-name＋有 totals 時 span.ns-tt-cat-sum）
 * ＝原型 `catGridHtml`（shared.js:402-406）＋丁案發車台格（v-d.js:boardHtml）。
 * 自己讀 store 的 `categories`；`runningId`＝運行中那一班的**分類 id**（＝原型 `r.cat === c.id` 的 is-live）。
 */
import { useMemo } from "react";
import { fmtDur, groupedCategories } from "../../../domain/timetable";
import { useTimetableStore } from "../../../store/timetableStore";
import { CategoryBadge } from "../CategoryBadge";

export interface CategoryGridProps {
  selected: string | null;
  onPick(id: string): void;
  compact?: boolean;
  /** 分類 id → 毫秒（發車台＝今日合計）；有給才畫 .ns-tt-cat-sum */
  totals?: Record<string, number>;
  /** 運行中那一班的分類 id（該格 .is-live） */
  runningId?: string | null;
}

export function CategoryGrid({ selected, onPick, compact = false, totals, runningId = null }: CategoryGridProps) {
  const categories = useTimetableStore((s) => s.categories);
  const groups = useMemo(() => groupedCategories(categories), [categories]);
  return (
    <>
      {groups.map(({ group, children }) => (
        <div className="ns-tt-group" key={group.id}>
          <span className="ns-tt-group-name">{group.name}</span>
          <div className={"ns-tt-cats" + (compact ? " is-compact" : "")}>
            {children.map((c) => {
              const live = runningId !== null && runningId === c.id;
              const sum = totals ? (totals[c.id] ?? 0) : 0;
              return (
                <button
                  type="button"
                  key={c.id}
                  className={"ns-tt-cat" + (selected === c.id ? " is-on" : "") + (live ? " is-live" : "")}
                  aria-pressed={selected === c.id ? true : undefined}
                  onClick={() => onPick(c.id)}
                >
                  {live && <span className="ns-tt-live-dot" aria-hidden="true" />}
                  <CategoryBadge cat={c} />
                  <span className="ns-tt-cat-name">{c.name}</span>
                  {totals && <span className="ns-tt-cat-sum ns-tt-num">{sum > 0 ? fmtDur(sum) : ""}</span>}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </>
  );
}
