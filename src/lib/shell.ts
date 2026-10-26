/**
 * 目前是不是手機殼：`useShell` 把殼寫進 `<html data-shell>`，store 與非 React 的地方讀這裡。
 * 沒有 document（node 測試）＝桌機。
 */
export function isMobileShell(): boolean {
  return typeof document !== "undefined" && document.documentElement.dataset.shell === "mobile";
}
