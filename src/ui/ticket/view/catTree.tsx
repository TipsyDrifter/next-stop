/**
 * catTree——分類選單的「可展開樹」小件（售票口④ 第二輪 D-票-78；桌機席）。
 * 給：記一筆分類欄的「全部分類」（TicketPanel CategoryCombo）、搜尋篩選的分類浮層（FilterChips）、預算的分類挑選（BudgetEditor）、
 *   分類管理的「移到…」（CategoryManager，兩殼共用）。
 * 長相借荷札樹（notes/tags/TagTree）：每列左邊 › 展開鈕（有子才有、展開時轉 90°）＋縮排 `--d`；點名字＝選它（任何一層都能選）。
 *   列＝`div.ns-tk-ctree`（`--d`＝深度）：`button.cr`（不進 Tab 順序，鍵盤用 →／←）＋呼叫端自己的 `.opt` 鈕。
 * 展開狀態各元件自己管（`useCatOpen`）；`visibleNodes` 攤平出畫面上看得到的列（↑↓ 照它走）。
 * 鍵盤（焦點在列裡的 `.opt` 上）：→ 展開、← 收起（已收起＝跳到上一層那一列）；不往上冒（浮層與頁面的鍵盤表不會接到）。
 * 樣式在 ticket-4b.css「分類樹」區。
 */
import { useCallback, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { categoryPath, type CategoryNode, type CategoryRow } from "../../../domain/ticket";
import { TkIcon } from "../TicketLedger";
import "../ticket-4b.css";

/** 前序攤平，只走展開的節點（＝畫面上看得到的列，帶 depth） */
export function visibleNodes(forest: readonly CategoryNode[], open: ReadonlySet<string>): CategoryNode[] {
  const out: CategoryNode[] = [];
  const walk = (list: readonly CategoryNode[]): void => {
    for (const n of list) {
      out.push(n);
      if (n.children.length && open.has(n.cat.id)) walk(n.children);
    }
  };
  walk(forest);
  return out;
}

/** 在樹裡找某個分類的節點（沒有＝null） */
export function findNode(forest: readonly CategoryNode[], id: string): CategoryNode | null {
  for (const n of forest) {
    if (n.cat.id === id) return n;
    const hit = findNode(n.children, id);
    if (hit) return hit;
  }
  return null;
}

/** 上層一串的 id（頂層 → 直屬上層，不含自己）；用來把選中的那一個展開到看得見 */
export function ancestorIds(cat: CategoryRow | undefined, catById: Readonly<Record<string, CategoryRow>>): string[] {
  return cat ? categoryPath(cat, catById).slice(0, -1).map((c) => c.id) : [];
}

/** 展開狀態：回 [開著的 id 集合, 切換(id, 指定開關?), 整組換掉] */
export function useCatOpen(initial?: () => Iterable<string>): [ReadonlySet<string>, (id: string, open?: boolean) => void, (ids: Iterable<string>) => void] {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(initial ? initial() : []));
  const toggle = useCallback((id: string, want?: boolean) => {
    setOpen((cur) => {
      const on = want ?? !cur.has(id);
      if (on === cur.has(id)) return cur;
      const next = new Set(cur);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const reset = useCallback((ids: Iterable<string>) => setOpen(new Set(ids)), []);
  return [open, toggle, reset];
}

/**
 * 展開鈕（有子才是鈕；沒有＝同寬空格對齊）。浮層與選單裡不進 Tab 順序（焦點在 `.opt`、鍵盤用 →／←）；
 * `focusable`＝進 Tab 順序（分類管理：列上能聚焦的只有名稱輸入框，→／← 在那裡是移游標，展開只能靠這顆）。
 */
export function CatCaret({ node, open, onToggle, focusable = false }: { node: CategoryNode; open: boolean; onToggle(id: string): void; focusable?: boolean }) {
  if (!node.children.length) return <span className="cr" aria-hidden />;
  return (
    <button
      type="button"
      className={"cr" + (open ? " open" : "")}
      tabIndex={focusable ? 0 : -1}
      aria-label={`${open ? "收合" : "展開"} ${node.cat.name}`}
      aria-expanded={open}
      onMouseDown={(e) => e.preventDefault() /* 焦點留在原處（分類欄的輸入框、浮層裡的選項） */}
      onClick={(e) => {
        e.stopPropagation();
        onToggle(node.cat.id);
      }}
    >
      <TkIcon name="right" size={10} />
    </button>
  );
}

/**
 * 一列：展開鈕＋呼叫端的選項鈕（children）。焦點在列裡時 →／← 展開收起（← 在收起的列上＝焦點跳到上一層那一列的 `.opt`）。
 */
export function CatTreeRow({
  node,
  open,
  onToggle,
  children,
}: {
  node: CategoryNode;
  open: boolean;
  onToggle(id: string, open?: boolean): void;
  children: ReactNode;
}) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "ArrowRight") {
      if (node.children.length && !open) onToggle(node.cat.id, true);
    } else if (e.key === "ArrowLeft") {
      if (node.children.length && open) onToggle(node.cat.id, false);
      else {
        // 跳到上一層那一列：往前找第一個 depth 比自己淺的列
        let p = e.currentTarget.previousElementSibling;
        while (p && !(p instanceof HTMLElement && p.classList.contains("ns-tk-ctree") && Number(p.dataset.depth) < node.depth)) p = p.previousElementSibling;
        (p as HTMLElement | null)?.querySelector<HTMLElement>(".opt")?.focus();
      }
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };
  return (
    <div className="ns-tk-ctree" data-depth={node.depth} style={{ "--d": node.depth } as CSSProperties} onKeyDown={onKeyDown}>
      <CatCaret node={node} open={open} onToggle={onToggle} />
      {children}
    </div>
  );
}

/** 分類名前的淡字路徑（短寫＝只留直屬上層一段，同帳簿列「外食 › 拉麵」）＋名字；完整路徑由呼叫端放 title（categoryLabel） */
export function CatShortName({ cat, catById }: { cat: CategoryRow; catById: Readonly<Record<string, CategoryRow>> }) {
  const path = categoryPath(cat, catById);
  const parent = path.length > 1 ? path[path.length - 2] : null;
  return (
    <>
      {parent && <span className="path">{parent.name} ›</span>}
      {cat.name}
    </>
  );
}
