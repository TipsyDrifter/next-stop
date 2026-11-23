/**
 * SkyLayer.tsx — 天空氛圍層（主題本體的一部分，不是裝飾開關）
 *
 * 視覺真相（移植規格 §0 鐵律 2）：
 *   粉彩星空（亮）＝prototypes/m3-mood-c2-pastel.html `.sky`／`.halo`／`.bokeh`／`.star` 段
 *   銀河鐵道（暗）＝prototypes/m3-mood-c1-galaxy.html `.sky`／`.moon`／`.dust`／`.star` 段
 *   水鏡鎌倉（24h 時光動態，v1.34 4B）＝KamakuraStage（連續天色、遠山燈火、湖上列車與水鏡倒影、晴雨山嵐）
 *   減量檔位（本次 ② 路線圖用）＝prototypes/m3-ext-routemap.html 同名段，密度數字見 starfield.ts
 *
 * 三個檔位（規格 §2 星空密度階梯）：
 *   full    今日視圖：全量星點
 *   reduced 路線圖／日曆：減量星點、呼吸放慢 6–12s  ← 預設值
 *   none    工具頁（設定等）：只留漸層與大氣，靜態
 *
 * 技術鐵則：動畫只動 transform／opacity；prefers-reduced-motion 強制關；
 *          藏起來就停（useMotionSleep → <html data-motion-asleep>，規則在 ui/ambience/mood.css）。
 */
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { buildStarfield, twinkleAt } from "./starfield";
import type { SkyDensity, SkyDot, SkyVariant } from "./starfield";
import { usePrefersReducedMotion, useSkyVariant } from "./useAmbience";
import { useMotionSleep } from "./motionSleep";
import { useMoodStore } from "./moodStore";
import { duskTintAt, type DuskTint } from "./moodDirector";
import { KamakuraStage, useIsKamakuraSkin } from "./KamakuraStage";
// 樣式（styles/ambience.css）由 src/index.css 集中 import——見該檔檔頭的注入順序說明

function minuteNow(): number {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

const NO_TINT: DuskTint = { dawn: 0, dusk: 0, night: 0 };
/** 一步很小，看不出在變；不用 CSS 長轉場，平常就不佔任何一格畫面 */
const TINT_TICK_MS = 5 * 60_000;

function useDuskTint(enabled: boolean, asleep: boolean): DuskTint {
  const [tint, setTint] = useState(() => (enabled ? duskTintAt(minuteNow()) : NO_TINT));
  useEffect(() => {
    if (!enabled) {
      setTint(NO_TINT);
      return;
    }
    if (asleep) return; // 睡著不算；醒來當場補到現在的時間
    const tick = () => setTint(duskTintAt(minuteNow()));
    tick();
    const t = window.setInterval(tick, TINT_TICK_MS);
    return () => window.clearInterval(t);
  }, [enabled, asleep]);
  return tint;
}

/** 粉彩場景的七顆光斑（遠處燈火在霧裡失焦）——位置與大小在 ambience.css，逐字取自原型 */
const BOKEH = ["b1", "b2", "b3", "b4", "b5", "b6", "b7"] as const;

const TWINKLE_TICK_MS = 250;
const TWINKLE_STEPS = 40;

function useStarTwinkle(rootRef: RefObject<HTMLDivElement | null>, stars: SkyDot[], running: boolean, keepFrame: boolean) {
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const els = [...root.querySelectorAll<HTMLElement>(".sky-star")];
    if (!running) {
      if (!keepFrame) for (const el of els) el.style.removeProperty("opacity");
      else if (els.length && !els[0].style.opacity) paintFrame(els, stars);
      return;
    }
    const last = new Array<number>(els.length).fill(-1);
    const tick = () => {
      const t = performance.now() / 1000;
      els.forEach((el, i) => {
        const tw = stars[i]?.twinkle;
        if (!tw) return;
        const q = Math.round(twinkleAt(t, tw) * TWINKLE_STEPS);
        if (q !== last[i]) {
          last[i] = q;
          el.style.opacity = String(q / TWINKLE_STEPS);
        }
      });
    };
    tick();
    const id = window.setInterval(tick, TWINKLE_TICK_MS);
    return () => window.clearInterval(id);
  }, [rootRef, stars, running, keepFrame]);
}

function paintFrame(els: HTMLElement[], stars: SkyDot[]): void {
  const t = performance.now() / 1000;
  els.forEach((el, i) => {
    const tw = stars[i]?.twinkle;
    if (tw) el.style.opacity = String(Math.round(twinkleAt(t, tw) * TWINKLE_STEPS) / TWINKLE_STEPS);
  });
}

export interface SkyLayerProps {
  /** 星點密度檔位；預設 'reduced'（路線圖檔位） */
  density?: SkyDensity;
  /** 場景；預設 'auto'＝跟著 <html data-theme> 走。傳固定值可強制單一場景（截圖／原型比對用） */
  variant?: SkyVariant | "auto";
  /** 額外 class（給整合席微調層級用；一般不需要） */
  className?: string;
  /** 星星會不會閃；手機傳 false（省電，D-主-460） */
  twinkle?: boolean;
}

export function SkyLayer({ density = "reduced", variant = "auto", className, twinkle = true }: SkyLayerProps) {
  const scene = useSkyVariant(variant);
  const isKamakura = useIsKamakuraSkin() && variant === "auto";
  // 這層一直掛著，全 App 的「有沒有人在看」從這裡開始算
  const asleep = useMotionSleep() !== null;
  const reduced = usePrefersReducedMotion();
  const off = useMoodStore((s) => s.mode) === "off";
  const level = useMoodStore((s) => s.level);
  const duskOn = useMoodStore((s) => s.parts.dusk);
  const rootRef = useRef<HTMLDivElement>(null);

  // 星圖只在場景／密度變動時重算；seeded＝每次算出來都是同一片天
  const field = useMemo(() => buildStarfield(scene, density), [scene, density]);

  // 水鏡鎌倉啟用時由 KamakuraStage 接管天空與星月呼吸，不重複啟動粉彩／銀河計時器
  useStarTwinkle(
    rootRef,
    field.stars,
    !isKamakura && twinkle && !asleep && !off && !reduced,
    !isKamakura && !off && !reduced,
  );

  // 晨昏／入夜染光跟隨全站常駐的 SkyLayer（水鏡鎌倉由自身 24h 調色盤連續插值）
  const tint = useDuskTint(!isKamakura && !off && !reduced && duskOn, asleep);
  const tintScale = level === "mid" ? 1 : 0.7;

  if (isKamakura) {
    const kmClass = ["sky-layer", "sky--kamakura", className ?? ""].filter(Boolean).join(" ");
    return (
      <div ref={rootRef} className={kmClass} aria-hidden="true">
        <KamakuraStage twinkle={twinkle && density !== "none"} />
      </div>
    );
  }

  const skyClass = ["sky-layer", `sky--${scene}`, className ?? ""]
    .filter(Boolean)
    .join(" ");

  return (
    <div ref={rootRef} className={skyClass} aria-hidden="true">
      {scene === "pastel" ? (
        <>
          <div className="sky-halo" />
          {BOKEH.map((b) => (
            <div key={b} className={`sky-bokeh sky-${b}`} />
          ))}
        </>
      ) : (
        <div className="sky-moon" />
      )}

      {field.dust.map((d) => (
        <i key={d.id} className={d.className} style={d.style} />
      ))}
      {field.stars.map((s) => (
        <i key={s.id} className={s.className} style={s.style} />
      ))}
      {tint.dawn > 0 && <i className="mood-tint mood-tint--dawn" style={{ opacity: tint.dawn * tintScale }} />}
      {tint.dusk > 0 && <i className="mood-tint mood-tint--dusk" style={{ opacity: tint.dusk * tintScale }} />}
      {tint.night > 0 && <i className="mood-tint mood-tint--night" style={{ opacity: tint.night * tintScale }} />}
    </div>
  );
}
