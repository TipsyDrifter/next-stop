/**
 * MSheet——手機底部 sheet（UI 丙-2 U4；契約 §1 #14；視覺規範 §2.4「手機底部 sheet」；活樣本 ui-brand §2.4 容器 `.ns-msheet*`）。
 *
 * 用途：手機上「一個明確的小任務」（＝桌機的 DialogShell）、「針對某一列的幾個動作」（＝桌機 PopMenu，動作清單型 `list`）、
 *   「挑日期／時間／分類」（＝桌機錨定 popover）。三套 sheet 基底（`.m-sheet`、`.ns-tk-msheet`、`.ns-notes-msheet`）收成這一支；
 *   舊的三套丙-3～6 套用完才刪（本班只建、不套頁面）。
 * 不用：看一整張票／帳的全部欄位、邊看邊改 → MFullPage；只要一個決定 → ConfirmDialog（置中）。
 *
 * 解剖（樣式在 common/msheet.css）：
 *   .ns-msheet-layer（fixed 全螢幕；inline 時 absolute 填滿父框）
 *     ├ .ns-msheet-veil   暗幕（--veil；點了＝關）
 *     └ .ns-msheet[role=dialog]  上緣 --radius-sheet、紙材質（不透明：票紙疊在紙色上）
 *         ├ .ns-msheet-head   拉柄 36×4＋（眉標）＋襯線 --fs-title 標題（無 ×）——整塊是拖曳把手
 *         ├ .ns-msheet-body   內容可捲（list 型改成 .ns-msheet-list：52px 列、最後一列「取消」）
 *         └ .ns-msheet-foot   黏底按鈕列（取消左框線、主鈕右實心墨，高 44；即時存的 sheet 不給）
 *
 * 高度 `height`：auto＝跟內容、上限 60%（§2.4「初始高 ≤60%」）／half＝固定 50%／full＝固定 90%。
 *   auto／half 往上拉把手 ≥48px ⇒ 展開到 90%（「可拉到 90%」）；展開後往下拉 ≥48px ⇒ 收回原高。
 * 關閉（四條路都叫 onClose）：下滑把手 ≥96px 或快速下撥、點暗幕、Android 返回鍵（useBackLayer 登記）、Esc（外接鍵盤）。
 *
 * ARIA：`role="dialog"`＋`aria-modal`；有 title ⇒ `aria-labelledby`，沒有 ⇒ `aria-label`（ariaLabel ?? overline）。拉柄 aria-hidden。
 * 鍵盤與焦點：開啟焦點落 sheet（子元件 autoFocus 優先）、開著掉 body 拉回、關閉還焦點——同 DialogShell 的焦點三規則（磨光⑤ 第 100 號；useDialogFocus）；
 *   Esc＝關（IME 組字中不攔；別人已 preventDefault 不搶；手機殼裡只有最上面那一層吃）；list 型 ↑↓ Home End 在動作列之間移動。
 * 返回層：預設 kind "sheet"；疊在全螢幕頁（MFullPage／"full"）上的子 sheet 傳 `backKind="dialog"`（backStack.ts 檔頭的規矩），
 *   同時 z-index 抬到全螢幕頁之上（.is-over）。返回鍵＝這一層自己的取消（onClose），不發明新語意。
 *   沒給 backKind、開的那一刻返回堆疊裡已有 "full" ⇒ 自動當 "dialog"（手機殼班反方評審 #5）：全螢幕頁裡掛的別線欄位
 *   （例：詳情頁筆記列「＋ 記一則」開的捕捉面板）不知道自己疊在全螢幕頁上，靠呼叫端記得傳 dialog 會漏——返回鍵先關底下的頁、面板留著。
 *   明寫 "sheet" 的照舊（要跟自己登記的 sheet 層合併的那幾處）。
 * `inline`：dev 樣本頁（Gallery）用——畫在父框裡（父框要 position: relative）、不 portal、不登記返回層、不搶焦點、沒有進場動畫。
 *
 * ── UI 丙-5（契約 §0 MSheet 那列）──
 *   - `dismissable={false}`：暫時不給關（售票口匯入寫入中）——點暗幕、下滑把手、返回鍵、Esc 都不關；返回層照登記、
 *     返回鍵與 Esc 被這一層吃掉（不漏到底下那層），把手仍可上拉展開。list 型的「取消」列跟著禁用。換回 true 就恢復。
 *   - `className`：加在 sheet 外框（.ns-msheet）上，給呼叫端自己的微調（例：售票口對話框宿主的 is-dialog is-<kind>）。
 *   - `MSheetItem cut`：這一列之前一道虛線撕線（同 PopMenuItem.cut）。
 *   - 列內小字摘要：`<MSheetItem>名稱<small>支出 3 · 收入 2</small></MSheetItem>`——小字換行在名稱下（msheet.css）。
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { backStack, useBackLayer } from "../mobile/backStack";
import { useDialogFocus } from "./DialogShell";
import "./msheet.css";

export type MSheetHeight = "auto" | "half" | "full";

export interface MSheetProps {
  /** 標題（襯線 --fs-title；無 ×）。動作清單型放那一列的名字（字級收成 --fs-h3） */
  title?: ReactNode;
  /** 標題上方的眉標（可省） */
  overline?: string;
  onClose: () => void;
  /** auto（預設，跟內容、上限 60%）／half（50%）／full（90%） */
  height?: MSheetHeight;
  /** 黏底按鈕列：取消在左（.btn-ghost）、主鈕在右（.btn-seal）；即時存的 sheet 不給 */
  foot?: ReactNode;
  /** 動作清單型（票卡 ⋯）：children 放 <MSheetItem>，殼自己在最後補一列「取消」 */
  list?: boolean;
  children?: ReactNode;
  /** 沒有 title 時的無障礙名稱（省略就用 overline） */
  ariaLabel?: string;
  /** 返回層 id（預設自動產生）；同一層有好幾個實例時給同一個 id 會合併（backStack refcount） */
  backId?: string;
  /** 返回層種類：一般 "sheet"；疊在全螢幕頁上的子 sheet 用 "dialog"。不給＝看開的那一刻底下有沒有全螢幕頁（檔頭） */
  backKind?: "sheet" | "dialog";
  /** dev 樣本頁用：畫在父框裡、不 portal、不登記返回層、不搶焦點 */
  inline?: boolean;
  /** false＝暫時不給關（暗幕／下滑／返回鍵／Esc 都不關；返回鍵與 Esc 被這層吃掉）。預設 true（UI 丙-5） */
  dismissable?: boolean;
  /** 加在 sheet 外框（.ns-msheet）上的 class（UI 丙-5） */
  className?: string;
}

/** 把手拖曳的門檻（px／px per ms） */
const CLOSE_PX = 96; // 往下拉超過＝關
const STEP_PX = 48; // 往上拉超過＝展開；展開後往下拉超過＝收回
const FLICK_PX = 24; // 快速下撥：至少這麼遠……
const FLICK_V = 0.5; // ……而且速度至少這麼快
const LIFT_MAX = 24; // 往上拉的阻尼上限（只示意「拉得動」，真正的展開在放手時）

interface DragState {
  id: number;
  y0: number;
  t0: number;
  dy: number;
}

export function MSheet({
  title,
  overline,
  onClose,
  height = "auto",
  foot,
  list = false,
  children,
  ariaLabel,
  backId,
  backKind: backKindProp,
  inline = false,
  dismissable = true,
  className,
}: MSheetProps) {
  const autoId = useId();
  // 沒給種類：看開的那一刻底下有沒有全螢幕頁，定下來就不改（之後底下的頁關掉也一樣——中途換種類會重登記、序號跑掉）。
  // 呼叫端給了就照給的走（含會隨狀態換的，例：售票口 MobileSheetHost）
  const [autoKind] = useState<"sheet" | "dialog">(() => (backStack.list().some((l) => l.kind === "full") ? "dialog" : "sheet"));
  const backKind = backKindProp ?? autoKind;
  const layerId = backId ?? `common.msheet${autoId}`;
  const titleId = `${autoId}-title`;
  const sheetRef = useRef<HTMLDivElement>(null);
  const drag = useRef<DragState | null>(null);
  const [expanded, setExpanded] = useState(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // 不給關的時候（丙-5 dismissable=false）四條關閉路一起擋：每條都走 tryClose，不直接叫 onClose
  const dismissRef = useRef(dismissable);
  dismissRef.current = dismissable;
  const tryClose = () => {
    if (dismissRef.current) onCloseRef.current();
  };

  // 返回鍵（只在手機殼生效；inline 樣本不登記）
  useBackLayer(layerId, !inline, tryClose, backKind);
  // 焦點三規則（inline 樣本不搶焦點）
  useDialogFocus(sheetRef, !inline);

  // Esc（外接鍵盤）：手機殼裡只有返回堆疊最上面那一層吃；別人已處理（defaultPrevented）就不搶
  useEffect(() => {
    if (inline) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing || e.keyCode === 229 || e.defaultPrevented) return;
      const top = backStack.top();
      if (top && top.id !== layerId && document.documentElement.dataset.shell === "mobile") return;
      e.preventDefault(); // 不給關時也吃掉這一下：Esc 不漏到底下那層
      if (dismissRef.current) onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inline, layerId]);

  /* ── 把手拖曳（拉柄＋標題那一塊；本文照常捲動） ── */
  const onHandleDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    // 標題列裡若放了可點的東西，交給它自己
    if ((e.target as HTMLElement).closest("button, a, input, textarea, select")) return;
    drag.current = { id: e.pointerId, y0: e.clientY, t0: e.timeStamp, dy: 0 };
    sheetRef.current?.classList.add("is-dragging");
    try {
      e.currentTarget.setPointerCapture(e.pointerId); // 手指滑出把手也跟得到；拿不到（指標已失效）就照常用冒泡的事件
    } catch {
      /* 沒有 capture 也能拖 */
    }
  };
  const onHandleMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    d.dy = e.clientY - d.y0;
    const el = sheetRef.current;
    if (!el) return;
    // 往下跟手；往上給阻尼（最多 LIFT_MAX），直接寫 style 不重畫
    const y = d.dy > 0 ? d.dy : Math.max(d.dy / 3, -LIFT_MAX);
    el.style.transform = `translateY(${y}px)`;
  };
  const endDrag = (e: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    const el = sheetRef.current;
    if (el) {
      el.classList.remove("is-dragging");
      el.style.transform = ""; // 交給 transition 彈回（或下面的狀態切換）
    }
    if (cancelled) return;
    const down = d.dy;
    const flick = down >= FLICK_PX && down / Math.max(1, e.timeStamp - d.t0) >= FLICK_V;
    const canExpand = height !== "full";
    if (down <= -STEP_PX) {
      if (canExpand && !expanded) setExpanded(true);
      return;
    }
    if (down >= CLOSE_PX || (flick && !expanded)) {
      tryClose(); // 不給關就只是彈回
      return;
    }
    if (expanded && (down >= STEP_PX || flick)) setExpanded(false);
  };

  /* ── list 型：↑↓ Home End 在動作列之間移動（Tab 照常） ── */
  const onSheetKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!list || e.nativeEvent.isComposing) return;
    const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
    if (!keys.includes(e.key)) return;
    const items = Array.from(sheetRef.current?.querySelectorAll<HTMLButtonElement>(".ns-msheet-item:not(:disabled)") ?? []);
    if (items.length === 0) return;
    e.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    let next: number;
    if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    else if (e.key === "ArrowDown") next = at < 0 ? 0 : (at + 1) % items.length;
    else next = at < 0 ? items.length - 1 : (at - 1 + items.length) % items.length;
    items[next].focus();
  };

  const hasHead = title != null || overline != null;
  const layer = (
    <div
      className={
        "ns-msheet-layer" + (inline ? " is-inline" : "") + (backKind === "dialog" ? " is-over" : "")
      }
    >
      <div className="ns-msheet-veil" aria-hidden="true" onClick={tryClose} />
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal={inline ? undefined : true}
        aria-labelledby={title != null ? titleId : undefined}
        aria-label={title != null ? undefined : ariaLabel ?? overline}
        tabIndex={-1}
        onKeyDown={onSheetKeyDown}
        className={
          "ns-msheet is-" +
          height +
          (expanded ? " is-expanded" : "") +
          (list ? " is-list" : "") +
          (foot != null ? " has-foot" : "") +
          (className ? " " + className : "")
        }
      >
        <div
          className={"ns-msheet-head" + (hasHead ? " has-title" : "")}
          onPointerDown={onHandleDown}
          onPointerMove={onHandleMove}
          onPointerUp={(e) => endDrag(e, false)}
          onPointerCancel={(e) => endDrag(e, true)}
        >
          <div className="ns-msheet-grip" aria-hidden="true" />
          {hasHead && (
            <div className="ns-msheet-title">
              {overline && <p className="techo-overline">{overline}</p>}
              {title != null && (
                <h2 id={titleId} className="techo-title">
                  {title}
                </h2>
              )}
            </div>
          )}
        </div>
        {list ? (
          <div className="ns-msheet-list">
            {children}
            <button type="button" className="ns-msheet-item is-cancel" disabled={!dismissable} onClick={tryClose}>
              取消
            </button>
          </div>
        ) : (
          <div className="ns-msheet-body">{children}</div>
        )}
        {foot != null && <div className="ns-msheet-foot">{foot}</div>}
      </div>
    </div>
  );

  if (inline || typeof document === "undefined") return layer;
  return createPortal(layer, document.body);
}

export interface MSheetItemProps {
  onClick: () => void;
  children: ReactNode;
  /** 破壞性動作（刪除、封存）：赭字，放在最後（§2.4「破壞性項目最後且赭字」） */
  danger?: boolean;
  disabled?: boolean;
  /** 禁用時寫「為什麼不能」（§1.8） */
  title?: string;
  /** 這一列之前畫一道虛線撕線（同 PopMenuItem.cut；UI 丙-5） */
  cut?: boolean;
  /** 呼叫端自己的微調 class（UI 丙-7 T5：時刻表「発車」列的朱字、右側小字排版）；加在 .ns-msheet-item 後面 */
  className?: string;
  /**
   * 「做不到、但點了說為什麼」（手機殼班 D-主-76；觸控沒有 hover，`disabled`＋title 的理由看不到）：
   * 淡掉（.is-off）＋`aria-disabled`，**onClick 照常觸發**——呼叫端在裡面吐理由（toast）、不做事。↑↓ 仍停得到。
   * 淡字樣式目前由用它的呼叫端帶（MobileTicketSheet → mobile/routemap/ticket-sheet.css）。
   */
  off?: boolean;
  /** 讀屏名稱（列面只有短字時補全句，例：排程格「明天」→「推遲到明天 10/11」） */
  ariaLabel?: string;
}

/** 動作清單型 sheet 的一列（52px 列＝--row-menu 手機值；左對齊、底線分隔） */
export function MSheetItem({
  onClick,
  children,
  danger = false,
  disabled = false,
  title,
  cut = false,
  className,
  off = false,
  ariaLabel,
}: MSheetItemProps) {
  return (
    <button
      type="button"
      className={
        "ns-msheet-item" +
        (danger ? " is-danger" : "") +
        (cut ? " is-cut" : "") +
        (off ? " is-off" : "") +
        (className ? " " + className : "")
      }
      onClick={onClick}
      disabled={disabled}
      aria-disabled={off || undefined}
      aria-label={ariaLabel}
      title={title}
    >
      {children}
    </button>
  );
}
