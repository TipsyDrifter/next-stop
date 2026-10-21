/**
 * Chevron——展開／收合的小箭頭（磨光⑤ K5：原本是 MobileRouteMap 檔內私有，桌機大綱要用同一枚，抽到這裡兩殼共用）。
 * 1.3px 細線幾何、stroke 走 currentColor（與 gnav／tabs.ts 同筆觸）；收合＝朝右（▸），展開＝轉 90° 朝下（▾）。
 * 只畫圖示、aria-hidden：可點的按鈕、aria-expanded、說明字都由呼叫端那顆 button 負責。
 * 轉場 .15s；系統要求減少動態時不轉（直接跳到終態）——用 CSS 媒體查詢做不了 inline style，這裡讀一次 matchMedia。
 */
const reduceMotion =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)")
    : null;

export function Chevron({ open, size = 12 }: { open: boolean; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      style={{ transform: open ? "rotate(90deg)" : undefined, transition: reduceMotion?.matches ? undefined : "transform .15s" }}
      aria-hidden
    >
      <path d="M6 3.5 10.5 8 6 12.5" />
    </svg>
  );
}
