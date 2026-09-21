/**
 * useVisualViewportHeight——軟鍵盤彈出時把 App 根高度改吃「視覺視窗」高（v1.1.0 評審 B2 的修正）。
 *
 * 為什麼需要：Android 端 `MainActivity.kt` 呼叫 `enableEdgeToEdge()`，decor 不再 fitSystemWindows，
 *   於是即使 manifest 寫了 `windowSoftInputMode="adjustResize"`，IME 也可能只是**疊在畫面上**、
 *   視窗不縮——`100dvh` 跟著不變，而建票輸入列是 flex column 的第三段（貼在 tab bar 之上），
 *   就被鍵盤整條蓋住，主人看不到自己正在打的字。己-4「開臨時車票（含注音組字）」是 v1.1.0
 *   最核心的寫入動作，不能押在「但願視窗會縮」上。
 *
 * 作法：`window.visualViewport` 在多數 Chromium 版本上「就算版面視窗沒縮，也會回報鍵盤佔掉的高度」。
 *   偵測到視覺視窗比版面視窗矮 ≥ KEYBOARD_MIN_INSET 時，把實際高度寫進 `--m-vvh`，
 *   mobile.css 的根規則是 `height: var(--m-vvh, 100dvh)` → 版面整條往上縮，輸入列回到鍵盤上方。
 *
 * 為什麼是「沒有就當沒發生」：
 *   - WebView 不回報 → 差值恆 0 → 從不寫入 → 回落 100dvh，等同本檔不存在（不會把畫面弄壞）。
 *   - 這條路走不通的最終退路是 Kotlin 端取 IME inset 當 padding（記在回報〈評審與修正〉B2），
 *     那要真機驗，不在無機可驗的本輪動。
 *
 * 兩個守門（都是為了不誤傷）：
 *   1. `scale > 1.01`＝主人在縮放頁面（雙指放大），視覺視窗本來就會變矮，這不是鍵盤 → 不接手。
 *   2. 差值要 ≥ 80px 才算鍵盤；小差值多半是系統列／捲軸的零頭，接手只會讓版面抖動。
 *
 * 桌機零改變（鐵則 1）：`active` 為 false 時整支 effect 直接 return，桌機連 listener 都不掛；
 *   即使誤掛，`--m-vvh` 也只有 mobile.css 的 `@media (max-width:767px)` 區塊在消費。
 */
import { useEffect } from "react";

/** 視覺視窗要比版面視窗矮多少，才認定是軟鍵盤（px）。系統列零頭一律小於這個數 */
const KEYBOARD_MIN_INSET = 80;

export function useVisualViewportHeight(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const vv = window.visualViewport;
    if (!vv) return;

    const root = document.documentElement;
    const apply = () => {
      const covered = window.innerHeight - vv.height;
      if (vv.scale <= 1.01 && covered >= KEYBOARD_MIN_INSET) {
        root.style.setProperty("--m-vvh", `${Math.round(vv.height)}px`);
      } else {
        root.style.removeProperty("--m-vvh");
      }
    };

    apply();
    vv.addEventListener("resize", apply);
    // 有些機型鍵盤彈出時走的是「視覺視窗位移」而不是 resize，scroll 一併聽，成本是兩個事件
    vv.addEventListener("scroll", apply);
    return () => {
      vv.removeEventListener("resize", apply);
      vv.removeEventListener("scroll", apply);
      root.style.removeProperty("--m-vvh");
    };
  }, [active]);
}
