/**
 * useAmbience.ts — 氛圍層的兩個小 hook（reduced-motion／場景判定）
 *
 * prefers-reduced-motion → 動畫強制關（CSS 也有同名保險，見 styles/ambience.css）
 * 「藏起來就停」在 motionSleep.ts，天象排程在 moodDirector.ts。
 */
import { useEffect, useState } from "react";
import type { SkyVariant } from "./starfield";

/** 系統「減少動態」偏好；跟著系統設定即時變動 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    setReduced(mq.matches);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

/**
 * 場景判定：'auto' ＝跟著 <html data-theme> 走（uiStore.applyTheme 寫的那一個屬性）。
 * 原型的 .theme-galaxy → 專案既有機制 data-theme；同時收 "galaxy" 字面值，
 * 讓 E1 若把主題值改名成 pastel／galaxy 也不必回頭改本層。
 */
export function useSkyVariant(pref: SkyVariant | "auto"): SkyVariant {
  const read = () => document.documentElement.getAttribute("data-theme");
  const [attr, setAttr] = useState<string | null>(read);

  useEffect(() => {
    if (pref !== "auto") return;
    const el = document.documentElement;
    const ob = new MutationObserver(() => setAttr(el.getAttribute("data-theme")));
    ob.observe(el, { attributes: true, attributeFilter: ["data-theme"] });
    setAttr(el.getAttribute("data-theme")); // 掛載到 loadSettings 之間可能已換過主題
    return () => ob.disconnect();
  }, [pref]);

  if (pref !== "auto") return pref;
  return attr === "dark" || attr === "galaxy" ? "galaxy" : "pastel";
}
