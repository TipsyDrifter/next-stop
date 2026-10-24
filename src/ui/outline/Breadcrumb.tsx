/**
 * Breadcrumb——zoom 聚焦時的麵包屑（路線名 › … › 聚焦節點），每段可點回跳；最後一段＝目前聚焦（不可點）。
 * 位置＝頁首眉標（PageHeader 的 `.ns-pagehead-overline`）：聚焦時取代「幹線 — 代碼」那行（UI 丙-3 契約 §5 P2）。
 * 字＝**兩主題都正體黑體**（不套 `.ns-ovl-*`：粉彩的拉丁斜體套中文會合成假斜體），色沿用眉標（粉彩靛藍、銀河金）；分隔「›」；
 * Esc 退一層（純鍵盤，不另畫提示）。對應 UI Flow 2.0a。
 * 根元素是 span[role=navigation]：它被放進眉標的 <p> 裡（Outline.tsx 的 portal），<nav> 不能當 <p> 的子元素。
 * 取捨：只做文字鏈，不做下拉／截斷選單——深度 >6 時靠 zoom 本身已把路徑縮短；放不下就換行。
 */
import type { Crumb } from "./useOutlineController";

interface BreadcrumbProps {
  items: Crumb[];
  onJump: (id: string | null) => void;
}

export function Breadcrumb({ items, onJump }: BreadcrumbProps) {
  if (!items.length) return null;
  return (
    <span role="navigation" aria-label="目前位置" className="ns-outline-crumbs" title="Esc 退一層">
      {items.map((c, i) => {
        const last = i === items.length - 1;
        return (
          <span key={c.id ?? "$route"} className="crumb">
            {i > 0 && (
              <span aria-hidden className="sep">
                ›
              </span>
            )}
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
    </span>
  );
}
