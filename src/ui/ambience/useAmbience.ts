/**
 * useAmbience.ts — 氛圍層的四個小 hook（reduced-motion／分頁可見性／場景判定／天象排程）
 *
 * 原型 JS 邏輯照搬（移植規格 §2）：
 *   - prefers-reduced-motion → 動畫強制關（CSS 也有同名保險，見 styles/ambience.css）
 *   - visibilitychange → 分頁隱藏時暫停動畫（is-paused）並清掉排程，回來再續
 *   - 天象（流星／列車）排程間隔與「上一班沒跑完就不放下一班」的守門照 C1／C2 原型
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { CssVars, SkyVariant } from "./starfield";

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

/** 分頁是否隱藏（背景分頁＝暫停動畫與排程，省電且不做無人看的功） */
export function usePageHidden(): boolean {
  const [hidden, setHidden] = useState(() => document.hidden);
  useEffect(() => {
    const onChange = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", onChange);
    setHidden(document.hidden);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return hidden;
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

/** 一次天象（流星或一班列車）；id 換新＝重新掛載＝動畫從頭跑 */
export interface Flight {
  id: number;
  style: CssVars;
}

export interface FlightSchedule {
  /** 排程開關：density='full' 且未開減少動態才給 true */
  enabled: boolean;
  /** 分頁隱藏：凍結畫面、清掉排程 */
  paused: boolean;
  /** 元件生命中第一次的等待（原型：載入後先來一班給人看見） */
  firstDelay: () => number;
  /** 之後每一次的間隔 */
  nextDelay: () => number;
  /** true＝跑完才排下一班（C1 做法）；false＝放行的同時就排下一班（C2 做法） */
  chainOnEnd: boolean;
  /** 這一班的位置／時長（寫進 style 的自訂屬性） */
  makeStyle: () => CssVars;
}

/**
 * 天象排程器：把 C1／C2 兩種節奏收成同一支。
 * 回傳的 flight 為 null＝天上沒東西（不掛 DOM，零成本）。
 */
export function useFlightScheduler(opts: FlightSchedule): {
  flight: Flight | null;
  onFlightEnd: () => void;
} {
  const { enabled, paused } = opts;
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const ctl = useRef({ timer: null as number | null, active: false, seq: 0, first: true });
  const [flight, setFlight] = useState<Flight | null>(null);

  const clear = useCallback(() => {
    const c = ctl.current;
    if (c.timer !== null) {
      window.clearTimeout(c.timer);
      c.timer = null;
    }
  }, []);

  const arm = useCallback(
    (ms: number) => {
      const c = ctl.current;
      clear();
      c.timer = window.setTimeout(() => {
        c.timer = null;
        const o = optsRef.current;
        if (!o.enabled || o.paused || document.hidden) return;
        if (c.active) {
          // 上一班還在天上（原型的 trainBusy／meteor.fly 守門）：這一輪跳過
          if (!o.chainOnEnd) arm(o.nextDelay());
          return;
        }
        c.active = true;
        c.seq += 1;
        setFlight({ id: c.seq, style: o.makeStyle() });
        if (!o.chainOnEnd) arm(o.nextDelay());
      }, ms);
    },
    [clear],
  );

  const onFlightEnd = useCallback(() => {
    ctl.current.active = false;
    setFlight(null);
    const o = optsRef.current;
    if (o.chainOnEnd && o.enabled && !o.paused) arm(o.nextDelay());
  }, [arm]);

  useEffect(() => {
    const c = ctl.current;
    if (!enabled) {
      clear();
      c.active = false;
      setFlight(null);
      return;
    }
    if (paused) {
      // 畫面凍結交給 CSS animation-play-state；這裡只把排程收掉
      clear();
      return;
    }
    // 跑完才排下一班的模式（C1）：天上還有東西時不重複排，等 animationend
    if (!(optsRef.current.chainOnEnd && c.active)) {
      arm(c.first ? optsRef.current.firstDelay() : optsRef.current.nextDelay());
    }
    c.first = false;
    return clear;
  }, [enabled, paused, arm, clear]);

  return { flight, onFlightEnd };
}

/** 排程用亂數＝即時 Math.random（只有星圖需要 seeded；天象每次不同才自然） */
export const rand = (a: number, b: number): number => a + Math.random() * (b - a);
