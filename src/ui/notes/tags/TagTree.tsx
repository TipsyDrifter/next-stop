/**
 * TagTree——書封頁務件裡的荷札樹（桌機；旅客筆記車次③契約 §5.1；原型 app.js treeRowsHtml、styles.css:139-151、191-215）。
 *
 *   `input.ns-notes-treefilter`（placeholder「篩選荷札」；頁面鍵 `/` 聚焦——NotesView 經 `treeFilterRef` 找它）
 *   樹列 `div.ns-notes-treerow[.active][.virtual]`（`--d`＝深度）：
 *     `button.cr` 展開／收合（有子才有）＋ `button.line-item.ns-notes-treenm`（小圖示：真荷札實線、虛資料夾空心；末段名；右側 total）
 *   選中＝`.active`（書封的金菱形語彙）；從別處進來（`openTagPage`）時祖先已由 store 展開，這裡把選中列捲進視野。
 * 展開狀態、篩選字都在 tagStore（桌機書封樹與手機樹共用一份；兩殼永不同時渲染）。
 */
import { useEffect, useMemo, useRef, type KeyboardEvent } from "react";
import { flattenTree } from "../../../domain/tags";
import { useTagStore } from "../../../store/tagStore";
import { IconCaret, IconSearch } from "../notesBits";
import { TagGlyph } from "./TagChip";

/** 樹篩選框（頁面鍵 `/` 由 NotesView 聚焦它；書封裡的元件拿不到 NotesView 的 ref） */
export const treeFilterRef: { current: HTMLInputElement | null } = { current: null };

export function TagTree() {
  const index = useTagStore((s) => s.index);
  const openKeys = useTagStore((s) => s.openKeys);
  const filter = useTagStore((s) => s.treeFilter);
  const selectedKey = useTagStore((s) => s.selectedKey);
  const rows = useMemo(() => (index ? flattenTree(index, openKeys, filter) : []), [index, openKeys, filter]);
  const boxRef = useRef<HTMLDivElement>(null);
  const inRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    treeFilterRef.current = inRef.current;
    return () => {
      if (treeFilterRef.current === inRef.current) treeFilterRef.current = null;
    };
  }, []);

  // 選中列捲進視野（從側板牌子、行內小牌、Ctrl+P 進來時）
  useEffect(() => {
    if (!selectedKey) return;
    const el = boxRef.current?.querySelector<HTMLElement>(`[data-tkey="${CSS.escape(selectedKey)}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedKey, rows.length]);

  const st = useTagStore.getState;
  const onFilterKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter") {
      e.preventDefault();
      const first = rows.find((r) => r.node.real) ?? rows[0];
      if (first) st().select(first.key);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (filter) st().setTreeFilter("");
      else document.querySelector<HTMLElement>(".page.ns-notes")?.focus({ preventScroll: true });
    }
  };

  return (
    <div className="ns-notes-auxtree">
      <label className="ns-notes-treefilter">
        <IconSearch size={11} />
        <input
          ref={inRef}
          value={filter}
          placeholder="篩選荷札"
          aria-label="篩選荷札"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => st().setTreeFilter(e.target.value)}
          onKeyDown={onFilterKey}
        />
      </label>
      <div ref={boxRef} className="ns-notes-tree" role="tree" aria-label="荷札">
        {!index ? null : !rows.length ? (
          <p className="ns-notes-treeempty">{filter ? "沒有符合的荷札" : "還沒有荷札"}</p>
        ) : (
          rows.map((r) => {
            const x = r.node;
            const active = x.key === selectedKey;
            return (
              <div
                key={x.key}
                data-tkey={x.key}
                role="treeitem"
                aria-selected={active}
                aria-expanded={r.hasKids ? r.open : undefined}
                className={`ns-notes-treerow${active ? " active" : ""}${x.real ? "" : " virtual"}`}
                style={{ ["--d" as string]: x.depth - 1 }}
              >
                {r.hasKids ? (
                  <button
                    type="button"
                    className={`cr${r.open ? " open" : ""}`}
                    aria-label={r.open ? `收合 ${x.seg}` : `展開 ${x.seg}`}
                    tabIndex={-1}
                    onClick={() => st().toggleOpen(x.key)}
                  >
                    <IconCaret size={10} />
                  </button>
                ) : (
                  <span className="cr" />
                )}
                <button
                  type="button"
                  className="line-item ns-notes-treenm"
                  title={x.real ? `#${x.name}` : `#${x.name}（僅作上層分類，未直接使用）`}
                  onClick={() => st().select(x.key)}
                >
                  <TagGlyph real={x.real} />
                  <span className="t">{x.seg}</span>
                  <span className="n">{x.total}</span>
                </button>
              </div>
            );
          })
        )}
      </div>
      {index && rows.some((r) => !r.node.real) && (
        <p className="ns-notes-treelegend">
          <TagGlyph real={false} size={12} />
          上層分類（沒有直接掛在上面的項目）
        </p>
      )}
    </div>
  );
}
