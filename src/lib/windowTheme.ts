/**
 * windowTheme.ts——原生標題列跟著 App 的亮暗走（第三梯 ⑩，D-主-436）。
 * 以前標題列跟 OS：銀河＋亮色 Windows 是白標題列壓深色頁面，暗色商店主題更明顯。
 * null＝跟隨系統（Tauri 會把 WebView 的 prefers-color-scheme 也放回 OS，uiStore 的監聽接得到）。
 * 捕捉小窗沒有 window 權限也沒有標題列；Android 不支援——兩者都是拒絕，安靜略過。
 * ⚠ Windows 上它改的是 WebView2 profile 的 PreferredColorScheme：捕捉小窗的 prefers-color-scheme 也一起變。
 */
export function syncWindowTheme(theme: "light" | "dark" | null): void {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
  void import("@tauri-apps/api/window")
    .then(({ getCurrentWindow }) => getCurrentWindow().setTheme(theme))
    .catch(() => undefined);
}
