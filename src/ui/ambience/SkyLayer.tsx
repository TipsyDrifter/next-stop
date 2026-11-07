/**
 * SkyLayer.tsx — 天空氛圍層（主題本體的一部分，不是裝飾開關）
 *
 * 視覺真相（移植規格 §0 鐵律 2）：
 *   粉彩星空（亮）＝prototypes/m3-mood-c2-pastel.html `.sky`／`.halo`／`.bokeh`／`.star` 段
 *   銀河鐵道（暗）＝prototypes/m3-mood-c1-galaxy.html `.sky`／`.moon`／`.dust`／`.star` 段
 *   減量檔位（本次 ② 路線圖用）＝prototypes/m3-ext-routemap.html 同名段，密度數字見 starfield.ts
 * 拍板依據：決策記錄〈M3 · 發車〉決策 10（C1/C2 原生動態全隨主題進 M3；事件動態只在今日視圖）
 *          ＋〈① 比稿拍板〉（延伸原型定稿路線圖頁的減量密度）。
 *
 * 三個檔位（規格 §2 星空密度階梯）：
 *   full    今日視圖：全量星點
 *   reduced 路線圖／日曆：減量星點、呼吸放慢 6–12s  ← 預設值
 *   none    工具頁（設定等）：只留漸層與大氣，靜態
 * 會經過的東西（流星、列車、候鳥）不在這裡，只在今日頁的 MoodStage（⑪）。
 *
 * 技術鐵則：動畫只動 transform／opacity；prefers-reduced-motion 強制關；
 *          藏起來就停（useMotionSleep → <html data-motion-asleep>，規則在 ui/ambience/mood.css）。
 *
 * 掛載（整合席 App.tsx；本席不動 App.tsx）：
 *   <SkyLayer />                       路線圖／日曆等頁（預設 reduced，跟著 data-theme 換場景）
 *   <SkyLayer density="full" />        今日視圖
 *   <SkyLayer density="none" />        工具頁
 *   ⚠ 天空是 position:fixed; z-index:0 的底層——同層的兄弟節點（書封側欄、主欄、側板）
 *     必須自帶 position:relative 與 z-index ≥ 1，否則會被天空蓋住（原型 .cover z-index:2／
 *     .page,.sheet z-index:1 就是為此）。詳見 styles/ambience.css 檔頭。
 */
import { useEffect, useMemo, useRef, type RefObject } from "react";
import { buildStarfield, twinkleAt } from "./starfield";
import type { SkyDensity, SkyDot, SkyVariant } from "./starfield";
import { usePrefersReducedMotion, useSkyVariant } from "./useAmbience";
import { useMotionSleep } from "./motionSleep";
import { useMoodStore } from "./moodStore";
// 樣式（styles/ambience.css）由 src/index.css 集中 import——見該檔檔頭的注入順序說明

/** 粉彩場景的七顆光斑（遠處燈火在霧裡失焦）——位置與大小在 ambience.css，逐字取自原型 */
const BOKEH = ["b1", "b2", "b3", "b4", "b5", "b6", "b7"] as const;

/**
 * 每秒更新 4 次；不透明度四捨五入到 1/40，沒變的那顆不寫。
 * 成本跟「每秒出幾格畫面」成正比、跟星星數量關係不大：10 次時手機真機約 60%／一顆核心（⑪ 1.26.0-dev 實量），
 * 無頭量測 10→4 次約降到三分之一（D-主-460）。手機不閃，只畫一格錯落的亮度（twinkle=false）。
 */
const TWINKLE_TICK_MS = 250;
const TWINKLE_STEPS = 40;

/**
 * 星星的呼吸。三種狀態：
 *   running        每 TWINKLE_TICK_MS 更新
 *   !running＋keep 停在當下那一格（睡著，或手機不閃時開場先畫一格）
 *   !running       清掉行內值，回到 CSS 的靜態亮度（關閉、減少動態）
 * 沒在跑時一個計時器都不留。
 */
function useStarTwinkle(rootRef: RefObject<HTMLDivElement | null>, stars: SkyDot[], running: boolean, keepFrame: boolean) {
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const els = [...root.querySelectorAll<HTMLElement>(".sky-star")];
    if (!running) {
      if (!keepFrame) for (const el of els) el.style.removeProperty("opacity");
      // 一格都還沒畫過（手機不閃、或一開場就睡著）：補畫一格，星星才有明有暗，不會全在最亮
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
  // 這層一直掛著，全 App 的「有沒有人在看」從這裡開始算
  const asleep = useMotionSleep() !== null;
  const reduced = usePrefersReducedMotion();
  const off = useMoodStore((s) => s.mode) === "off";
  const rootRef = useRef<HTMLDivElement>(null);

  // 星圖只在場景／密度變動時重算；seeded＝每次算出來都是同一片天
  const field = useMemo(() => buildStarfield(scene, density), [scene, density]);

  // 睡著、手機＝定在一格（keepFrame）；關閉、減少動態＝回靜態亮度
  useStarTwinkle(rootRef, field.stars, twinkle && !asleep && !off && !reduced, !off && !reduced);

  const skyClass = ["sky-layer", `sky--${scene}`, className ?? ""]
    .filter(Boolean)
    .join(" ");

  return (
    <div ref={rootRef} className={skyClass} aria-hidden="true">
        {scene === "pastel" ? (
          <>
            {/* 極淡彩虹光暈：霧裡被月光折出的一抹色（靜態） */}
            <div className="sky-halo" />
            {BOKEH.map((b) => (
              <div key={b} className={`sky-bokeh sky-${b}`} />
            ))}
          </>
        ) : (
          /* 月牙＋月暈（凹面透明＝真的月牙）；銀河帶在 .sky--galaxy::before */
          <div className="sky-moon" />
        )}

        {field.dust.map((d) => (
          <i key={d.id} className={d.className} style={d.style} />
        ))}
        {field.stars.map((s) => (
          <i key={s.id} className={s.className} style={s.style} />
        ))}
    </div>
  );
}
