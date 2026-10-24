/**
 * SidePanelFrame——桌機右側「詳情側板」的外框（視覺規範 §2.4「詳情側板」：同殼、340、× 在標題列）。
 * UI 丙-5（契約 §0、☎-1）從 `panel/DetailPanel.tsx` 私有的 PanelFrame 原樣搬來：核心側板與售票口大票用同一支殼。
 * 核心側板不傳任何新 prop ⇒ DOM、焦點、Esc 跟搬家前一模一樣。
 *
 * 解剖（樣式在 `panel/panel.css`；**本檔不 import 它**：DetailPanel 由 App 靜態載入、panel.css 一定在，
 *   這裡再 import 的話，售票口先載到本檔時會把 panel.css 的注入順序提前、改到它跟 techo.css／各線 css 的疊放）：
 *   aside.panel[role=complementary][tabIndex=-1][aria-label]（＋className、＋data-skin）
 *     └ .panel-sheet（紙材質、從右滑入）
 *         ├ button.panel-close（× 在紙的右上角，常駐 ink-faint）
 *         └ .panel-scroll（內容可捲）
 * 寬度吃 `--panel-w`（340）；以 flex 子項佔位（父層須為 flex row）。
 *
 * 新增的選填 props（丙-5）：
 *   - `onEscape`：面板內 Esc 做什麼（預設＝onClose）。售票口給 `requestEscape`（新票有內容先問，不直接關）。
 *   - `ariaLabel`（預設「詳情側板」）／`closeLabel`（× 的 aria-label，預設「關閉詳情側板」）。
 *   - `className`：加在 aside 上，`panel` 一定保留（例 "ns-tk-panel"：售票口鍵盤表用它判斷焦點在大票裡）。
 *   - `skin`："paper"（預設，不寫屬性）｜"ticket"（aside 加 `data-skin="ticket"`；票皮樣式由售票口 css 寫）。
 *
 * 焦點：開啟時把焦點移進面板（鍵盤流 `.` 開板後 Tab 就能進欄位）；卸載時若焦點無處可去，還給開板前的元素。
 * Esc：面板內聚焦時（IME 組字中不攔）preventDefault＋stopPropagation，再叫 onEscape ?? onClose——不往頁根冒。
 * `hidden`：不佔欄、不可聚焦（核心 A12「這頁不畫空板」：用 display:none 收、外框保持掛載）。
 */
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { XIcon } from "./fields";

export interface SidePanelFrameProps {
  onClose: () => void;
  children: ReactNode;
  /** 收起：不佔欄、不可聚焦（display:none；外框保持掛載） */
  hidden?: boolean;
  /** 面板內 Esc（預設＝onClose）；售票口給 requestEscape */
  onEscape?: () => void;
  /** aside 的讀屏名稱（預設「詳情側板」） */
  ariaLabel?: string;
  /** × 的讀屏名稱（預設「關閉詳情側板」） */
  closeLabel?: string;
  /** 加在 aside 上（"panel" 一定保留） */
  className?: string;
  /** 皮：paper（預設）／ticket（data-skin="ticket"，樣式在售票口 css） */
  skin?: "paper" | "ticket";
}

export function SidePanelFrame({
  onClose,
  children,
  hidden = false,
  onEscape,
  ariaLabel = "詳情側板",
  closeLabel = "關閉詳情側板",
  className,
  skin = "paper",
}: SidePanelFrameProps) {
  const ref = useRef<HTMLElement>(null);
  const prevFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!prevFocus.current && document.activeElement instanceof HTMLElement) prevFocus.current = document.activeElement;
    ref.current?.focus({ preventScroll: true });
    return () => {
      const prev = prevFocus.current;
      const active = document.activeElement;
      if (prev && prev.isConnected && (active === null || active === document.body)) prev.focus({ preventScroll: true });
    };
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      (onEscape ?? onClose)();
    }
  };

  return (
    <aside
      ref={ref}
      tabIndex={-1}
      role="complementary"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className={className ? "panel " + className : "panel"}
      data-skin={skin === "ticket" ? "ticket" : undefined}
      hidden={hidden}
      style={hidden ? { display: "none" } : undefined}
    >
      <div className="panel-sheet">
        <button type="button" aria-label={closeLabel} title="關閉（Esc）" onClick={onClose} className="panel-close">
          <XIcon size={14} />
        </button>
        <div className="panel-scroll">{children}</div>
      </div>
    </aside>
  );
}
