/**
 * Tabs——分頁籤：同一頁的 2～6 個視圖或子頁（視覺規範 §2.2；UI 丙-2 共用元件庫 #2）。
 *
 * 用途：時刻表六視圖、行程表四檢視、售票口三視圖、統計日週月、設定四分頁、手機今日｜行程表、手機旅客筆記四段。
 * 不用：表單內的單選 → `Segmented`（黑體相連方格，§2.2 右欄）；兩件事，不混用。
 * 位置：桌機＝頁首工具列第一格（`PageHeader` 的 `tabs`）；手機＝頂帶下一列（`MobileTopBand` 的 `tabsRow`，
 *   外面包 `.ns-tabrow`，末端「管理」放 `.ns-tabrow .mgr`）。
 *
 * 長相（照 10-12 手機原型 .seg；樣式在 `./tabs.css`，活樣本 prototypes/ui-brand/index.html §9）：
 *   文字籤、襯線 700、`--fs-tab`、字距 .22em、段間虛線；選中＝`--sel-line` 底線滑塊＋`--sel-fg` 字；高 `--ctl-tab`
 *   （桌機 36、手機 44，token 由 [data-shell="mobile"] 整組換）。
 *   `size`：省略＝跟殼走（手機殼自動成「獨立一列」：整列霧面玻璃底＋底線、撐滿）；"md"＝強制桌機形制（工具列內、不加底）；
 *   "mobile"＝強制獨立一列形制（高度仍跟殼的 token）。
 *   `scroll`：籤太多時橫捲（捲軸隱藏）；獨立一列形制且超過 4 段時，JS 量各籤自然寬、均勻補左右內距（`--tab-pad-x`），
 *   讓一列剛好「4 格＋第 5 格露一半」（籤字寬時退成 3 格半…）＝「還能捲」的提示（`peekPad`）；選中籤換了會自動捲進視野。
 *   底線滑塊：JS 量選中籤的中心寫進 `--ink-x`，換籤時滑過去（`--dur`／`--ease`；減少動態時不滑）；
 *   量不到（測試環境、未排版）時退回選中籤自己畫一條（CSS `::after`），不會沒有選中態。
 *   快捷鍵不內嵌鍵帽：放 `hotkeyTitle`（滑過的 title）與「?」指引（§2.2 鍵帽列）。
 *
 * ARIA：容器 `role="tablist"`＋`aria-label`；每籤 `role="tab"`＋`aria-selected`＋`.is-on`（§2.10）；
 *   給了 `getPanelId` 就補 `aria-controls`。禁用籤 `disabled`＋`title`＝為什麼（§1.8）。
 * 鍵盤：一個 Tab stop（選中籤 tabIndex 0、其餘 -1）；←→ 換籤（循環、跳過禁用，焦點與選中一起走＝自動啟用）；
 *   Home／End 到第一／最後一籤。處理過的鍵 preventDefault＋stopPropagation（不讓頁面容器的導航表或全域表再吃一次）。
 *
 * 另附 `TabsSelect`：主欄 <704 時 PageHeader 把分頁籤收成下拉（§2.1 狀態），同一份 items，底線 select 形制。
 * 樣式不在本檔 import：`tabs.css` 由 `src/index.css` 集中 @import（techo.css 之後、mobile.css 之前）。
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";

export interface TabItem<K extends string = string> {
  key: K;
  /** 籤上的字（純文字：下拉收合時也要用它當 option） */
  label: string;
  /** 滑過的說明，含快捷鍵，例「雨欄（1）」；鍵帽不內嵌在籤上 */
  hotkeyTitle?: string;
  disabled?: boolean;
  /** 禁用時滑過的說明（為什麼現在不能切） */
  why?: string;
}

export interface TabsProps<K extends string = string> {
  items: readonly TabItem<K>[];
  value: K;
  onChange: (key: K) => void;
  /** 省略＝跟殼走；"md"＝工具列內（不加底）；"mobile"＝獨立一列（整列玻璃） */
  size?: "md" | "mobile";
  /** 籤多時橫捲；手機殼超過 4 段末段露半格 */
  scroll?: boolean;
  /** 讀屏用名稱（預設「切換檢視」） */
  "aria-label"?: string;
  /** 對應分頁內容的 id（補 aria-controls） */
  getPanelId?: (key: K) => string;
  className?: string;
}

/** 手機殼一列放得下幾段；超過就橫捲、末段露半格（§2.2 段數欄） */
export const MOBILE_TABS_PER_ROW = 4;

/**
 * 漫遊焦點的下一格（Tabs／Segmented 共用，純函式）：從 `from` 往 `dir` 找下一個沒禁用的位置，循環；
 * "first"／"last"＝第一／最後一個沒禁用的。全部禁用回 -1。
 */
export function stepRoving(
  disabled: readonly boolean[],
  from: number,
  dir: 1 | -1 | "first" | "last",
): number {
  const n = disabled.length;
  if (n === 0) return -1;
  if (dir === "first") return disabled.findIndex((d) => !d);
  if (dir === "last") {
    for (let i = n - 1; i >= 0; i--) if (!disabled[i]) return i;
    return -1;
  }
  const start = from < 0 || from >= n ? (dir === 1 ? -1 : n) : from;
  for (let k = 1; k <= n; k++) {
    const i = (((start + dir * k) % n) + n) % n;
    if (!disabled[i]) return i;
  }
  return -1;
}

/**
 * 末段露半格的補白（純函式）：籤的自然寬 `widths`（不含補白）、列寬 `rowW`，回每籤左右各要再補幾 px，
 * 讓第 k 籤（k ≤ perRow，取放得下的最大 k）剛好在列的右緣被切一半——前 k 格完整、第 k+1 格露半格。
 * 解 Σ_{i<k}(w_i+2p) + (w_k+2p)/2 = rowW ⇒ p = (rowW − Σ_{i<k} w_i − w_k/2) / (2k+1)；k 從大到小找第一個 p ≥ 0。
 * 籤數 ≤ perRow 或連第一格都放不下半格時回 0（照自然寬捲）。
 */
export function peekPad(widths: readonly number[], rowW: number, perRow = MOBILE_TABS_PER_ROW): number {
  if (widths.length <= perRow || rowW <= 0) return 0;
  for (let k = Math.min(perRow, widths.length - 1); k >= 1; k--) {
    let before = 0;
    for (let i = 0; i < k; i++) before += widths[i];
    const p = (rowW - before - widths[k] / 2) / (2 * k + 1);
    if (p >= 0) return p;
  }
  return 0;
}

/** 方向鍵 → stepRoving 的方向；`vertical` 連 ↑↓ 一起收（Segmented 照 radiogroup 慣例） */
export function rovingDir(key: string, vertical = false): 1 | -1 | "first" | "last" | null {
  switch (key) {
    case "ArrowRight":
      return 1;
    case "ArrowLeft":
      return -1;
    case "ArrowDown":
      return vertical ? 1 : null;
    case "ArrowUp":
      return vertical ? -1 : null;
    case "Home":
      return "first";
    case "End":
      return "last";
    default:
      return null;
  }
}

export function Tabs<K extends string = string>({
  items,
  value,
  onChange,
  size,
  scroll = false,
  "aria-label": ariaLabel = "切換檢視",
  getPanelId,
  className,
}: TabsProps<K>) {
  const listRef = useRef<HTMLDivElement>(null);
  const btnRefs = useRef<(HTMLButtonElement | null)[]>([]);
  /** 選中籤的中心（px，相對 tablist）；null＝量不到，退回 CSS ::after */
  const [inkX, setInkX] = useState<number | null>(null);
  /** 末段露半格：每籤左右各補的 px（只在手機獨立一列＋超過 4 段時非 0；寫進 --tab-pad-x） */
  const [padX, setPadX] = useState(0);
  const padRef = useRef(0);
  padRef.current = padX;
  const peek = scroll && items.length > MOBILE_TABS_PER_ROW;

  const place = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    // 露半格只在「獨立一列」形制成立（跟 tabs.css 的 .is-peek 規則同一個條件）
    const rowForm =
      size === "mobile" ||
      (size !== "md" && list.closest("[data-shell]")?.getAttribute("data-shell") === "mobile");
    if (peek && rowForm) {
      const cur = padRef.current;
      const widths = Array.from(list.querySelectorAll<HTMLElement>('[role="tab"]'), (t) =>
        Math.max(0, t.getBoundingClientRect().width - 2 * cur),
      );
      const next = Math.floor(peekPad(widths, list.clientWidth) * 10) / 10;
      if (Math.abs(next - cur) >= 0.5) setPadX(next); // 補白一變籤寬就變，ResizeObserver 會再叫一次 place 量滑塊
    } else if (padRef.current !== 0) {
      setPadX(0);
    }
    const sel = list.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    if (!sel || !sel.offsetWidth) {
      setInkX(null);
      return;
    }
    setInkX(sel.offsetLeft + sel.offsetWidth / 2);
    // 橫捲時把選中籤捲進視野（只動 scrollLeft，不用 scrollIntoView——那會連頁面一起捲）
    if (list.scrollWidth > list.clientWidth) {
      const l = sel.offsetLeft;
      const r = l + sel.offsetWidth;
      if (l < list.scrollLeft) list.scrollLeft = l;
      else if (r > list.scrollLeft + list.clientWidth) list.scrollLeft = r - list.clientWidth;
    }
  }, [peek, size]);

  // items 常是呼叫端每次渲染新建的陣列：用內容簽名當依賴，避免每次渲染都重掛 ResizeObserver
  const sig = JSON.stringify(items.map((it) => [it.key, it.label, !!it.disabled]));

  // 換籤、換 items：畫面出來之前就量好（不閃一幀 ::after）
  useLayoutEffect(() => {
    place();
  }, [place, value, sig]);

  // 籤寬會變：字型晚到、主欄縮放、手機殼撐滿——量 tablist 與每一籤
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    let alive = true;
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => place());
      ro.observe(list);
      list.querySelectorAll('[role="tab"]').forEach((t) => ro!.observe(t));
    }
    if (typeof document !== "undefined" && document.fonts?.ready) {
      void document.fonts.ready.then(() => {
        if (alive) place();
      });
    }
    return () => {
      alive = false;
      ro?.disconnect();
    };
  }, [place, sig]);

  const selIndex = items.findIndex((it) => it.key === value);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing || e.altKey || e.ctrlKey || e.metaKey) return;
    const dir = rovingDir(e.key);
    if (dir === null) return;
    const from = btnRefs.current.findIndex((b) => b === e.target);
    const next = stepRoving(
      items.map((it) => !!it.disabled),
      from >= 0 ? from : selIndex,
      dir,
    );
    if (next < 0) return;
    e.preventDefault();
    e.stopPropagation();
    btnRefs.current[next]?.focus();
    if (items[next].key !== value) onChange(items[next].key);
  };

  const cls = [
    "ns-tabs",
    size ? `ns-tabs--${size}` : "",
    scroll ? "is-scroll" : "",
    peek ? "is-peek" : "",
    inkX !== null ? "has-ink" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  // 沒有任何一籤可以 Tab 進來時（value 不在 items 裡），讓第一個沒禁用的籤當 Tab stop
  const tabStop = selIndex >= 0 && !items[selIndex].disabled ? selIndex : stepRoving(items.map((it) => !!it.disabled), -1, "first");

  return (
    <div
      ref={listRef}
      className={cls}
      role="tablist"
      aria-label={ariaLabel}
      aria-orientation="horizontal"
      data-tabs=""
      style={padX ? ({ "--tab-pad-x": `${padX}px` } as CSSProperties) : undefined}
      onKeyDown={onKeyDown}
    >
      {items.map((it, i) => {
        const on = it.key === value;
        return (
          <button
            key={it.key}
            ref={(el) => {
              btnRefs.current[i] = el;
            }}
            type="button"
            role="tab"
            className={on ? "is-on" : undefined}
            aria-selected={on}
            aria-controls={getPanelId?.(it.key)}
            tabIndex={i === tabStop ? 0 : -1}
            disabled={it.disabled}
            title={it.disabled ? (it.why ?? it.hotkeyTitle) : it.hotkeyTitle}
            onClick={() => {
              if (!on) onChange(it.key);
            }}
          >
            {it.label}
          </button>
        );
      })}
      {/* 底線滑塊：量到位置才插入（插入當下就是終值，不會從左邊滑進來）；減少動態時不滑（tabs.css 媒體查詢） */}
      {inkX !== null && (
        <i
          className="ns-tabs-ink"
          aria-hidden="true"
          style={{ "--ink-x": `${inkX}px` } as CSSProperties}
        />
      )}
    </div>
  );
}

export interface TabsSelectProps<K extends string = string> {
  items: readonly TabItem<K>[];
  value: K;
  onChange: (key: K) => void;
  "aria-label"?: string;
  className?: string;
}

/**
 * TabsSelect——分頁籤的窄版：主欄 <704 時 PageHeader 用它取代 Tabs（§2.1「分頁籤改下拉」）。
 * 底線 select（`.ns-select-wrap`＋`.techo-input`，overlay.css 既有）＋`.ns-tabs-select`（襯線 700、`--fs-tab`）。
 * 鍵盤與讀屏交給原生 <select>；選中即切（onChange 直接回 key）。
 */
export function TabsSelect<K extends string = string>({
  items,
  value,
  onChange,
  "aria-label": ariaLabel = "切換檢視",
  className,
}: TabsSelectProps<K>) {
  return (
    <span className={className ? `ns-select-wrap ${className}` : "ns-select-wrap"}>
      <select
        className="techo-input ns-tabs-select"
        aria-label={ariaLabel}
        value={value}
        onChange={(e) => onChange(e.currentTarget.value as K)}
      >
        {items.map((it) => (
          <option key={it.key} value={it.key} disabled={it.disabled}>
            {it.label}
          </option>
        ))}
      </select>
    </span>
  );
}
