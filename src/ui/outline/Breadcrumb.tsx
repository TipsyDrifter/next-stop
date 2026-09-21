/**
 * Breadcrumb——zoom 聚焦時的麵包屑（路線名 › … › 聚焦節點），每段可點回跳；最後一段＝目前聚焦（不可點）。
 * 視覺＝原型頁首的 .overline（燙金 10px／.4em 字距）位置與樣式，只是把「幹線 — 代碼」換成路徑；分隔「›」；Esc 退一層（純鍵盤，不另畫提示）。
 * 對應 UI Flow 2.0a。取捨：只做文字鏈，不做下拉／截斷選單——深度 >6 時靠 zoom 本身已把路徑縮短。
 */
import type { Crumb } from "./useOutlineController";

interface BreadcrumbProps {
  items: Crumb[];
  onJump: (id: string | null) => void;
}

export function Breadcrumb({ items, onJump }: BreadcrumbProps) {
  if (!items.length) return null;
  return (
    <nav aria-label="聚焦路徑" className="overline crumbs" title="Esc 退一層">
      {items.map((c, i) => {
        const last = i === items.length - 1;
        return (
          <span key={c.id ?? "$route"} className="crumb">
            {i > 0 && <span aria-hidden>›</span>}
            {last ? (
              <span aria-current="location">{c.label}</span>
            ) : (
              <button type="button" tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={() => onJump(c.id)} aria-label={`回到「${c.label}」`}>
                {c.label}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}
