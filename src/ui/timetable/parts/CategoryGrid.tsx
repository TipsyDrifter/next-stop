/**
 * CategoryGrid——分類格（車次①a 契約 §5.1；乙席）。兩殼共用 DOM，差異只在 CSS。
 * DOM（class 即契約）：依 `groupedCategories` 分段：
 *   div.ns-tt-group > span.ns-tt-group-name ＋ div.ns-tt-cats[.is-compact] > button.ns-tt-cat[.is-on][.is-live]
 *   （Badge＋span.ns-tt-cat-name＋有 totals 時 span.ns-tt-cat-sum）
 * ＝原型 `catGridHtml`（shared.js:402-406）＋丁案發車台格（v-d.js:boardHtml）。
 * 自己讀 store 的 `categories`；`runningId`＝運行中那一班的**分類 id**（＝原型 `r.cat === c.id` 的 is-live）。
 * 車次②（② 契約〈原型拍板〉4；乙席）：`memId`＝連到的票上次用的分類 ⇒ 那一格 `.is-mem` 描金虛線＋右上角「上次」小牌
 * （＝原型 `v-f.js` gridHtml 的 mem／`.vf-mem`／`.vf-memtag`）。
 * UI 丙-4 D7：一個分類都沒有（全封存了、或還沒建）時，原本什麼都不畫——發車台、面板裡只剩一片空白、不知道下一步。
 *   改成卡內一行 EmptyState（inline），鈕「分類與設定」開分類管理（＝頁首那顆的名字；空狀態教第一步，不算第二入口）。
 *   compact（面板裡、方眼塗色列）不給鈕、只寫去哪建：鈕會用 openSheet 換掉正在填的面板。
 */
import { useMemo } from "react";
import { fmtDur, groupedCategories } from "../../../domain/timetable";
import { TT_TEXT, useTimetableStore } from "../../../store/timetableStore";
import { EmptyState } from "../../common/EmptyState";
import { CategoryBadge } from "../CategoryBadge";

/** 沒有分類時的字（UI 丙-4 D7；只在這一支用） */
const CAT_EMPTY = { title: "還沒有分類。", desc: "先建一個分類，時間才有地方記。", descCompact: "先到「分類與設定」建一個分類。" } as const;

export interface CategoryGridProps {
  selected: string | null;
  onPick(id: string): void;
  compact?: boolean;
  /** 分類 id → 毫秒（發車台＝今日合計）；有給才畫 .ns-tt-cat-sum */
  totals?: Record<string, number>;
  /** 運行中那一班的分類 id（該格 .is-live） */
  runningId?: string | null;
  /** ②：上次用的分類 id（該格 .is-mem＋「上次」） */
  memId?: string | null;
}

export function CategoryGrid({ selected, onPick, compact = false, totals, runningId = null, memId = null }: CategoryGridProps) {
  const categories = useTimetableStore((s) => s.categories);
  const openSheet = useTimetableStore((s) => s.openSheet);
  const groups = useMemo(() => groupedCategories(categories), [categories]);
  if (!groups.some((g) => g.children.length > 0)) {
    return (
      <EmptyState
        inline
        tone="first"
        className="ns-tt-cats-empty"
        title={CAT_EMPTY.title}
        desc={compact ? CAT_EMPTY.descCompact : CAT_EMPTY.desc}
        // compact＝面板裡（補記、改一塊、發車、長時間確認…）：openSheet 會把當前面板整個換掉（補記草稿丟失、
        // longRun 沒走「略過」就被換掉）⇒ 不給鈕，只指路（UI 丙-4 修，T7 評審 6）
        action={compact ? undefined : { label: TT_TEXT.settingsBtn, onClick: () => openSheet({ kind: "categories" }) }}
      />
    );
  }
  return (
    <>
      {groups.map(({ group, children }) => (
        <div className="ns-tt-group" key={group.id}>
          <span className="ns-tt-group-name">{group.name}</span>
          <div className={"ns-tt-cats" + (compact ? " is-compact" : "")}>
            {children.map((c) => {
              const live = runningId !== null && runningId === c.id;
              const sum = totals ? (totals[c.id] ?? 0) : 0;
              const mem = memId !== null && memId === c.id;
              return (
                <button
                  type="button"
                  key={c.id}
                  className={"ns-tt-cat" + (selected === c.id ? " is-on" : "") + (live ? " is-live" : "") + (mem ? " is-mem" : "")}
                  aria-pressed={selected === c.id ? true : undefined}
                  onClick={() => onPick(c.id)}
                >
                  <CategoryBadge cat={c} live={live} />
                  <span className="ns-tt-cat-name">{c.name}</span>
                  {totals && <span className="ns-tt-cat-sum ns-tt-num">{sum > 0 ? fmtDur(sum) : ""}</span>}
                  {mem && <em className="ns-tt-cat-memtag">上次</em>}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </>
  );
}
