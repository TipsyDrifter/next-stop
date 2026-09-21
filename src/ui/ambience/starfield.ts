/**
 * starfield.ts — 星點生成（seeded random，每次開檔同一片天）
 *
 * 視覺真相＝prototypes/m3-mood-c2-pastel.html（粉彩・全量）／m3-mood-c1-galaxy.html（銀河・全量）
 *           ／m3-ext-routemap.html（兩主題・減量檔位，配方逐字）
 * 拍板依據＝移植規格 §2「星空密度階梯」：
 *   full    今日視圖＝C2 48 星／C1 90 塵＋56 星（呼吸 4–9s／4–11s）＋事件動態（M3 ③ 掛）
 *   reduced 路線圖＝C2 32 星／C1 70 塵＋36 星，呼吸放慢 6–12s，無流星無列車
 *   none    工具頁＝只留漸層與大氣（halo／bokeh／月牙／銀河帶），零星點零動態
 *
 * 亂數鐵則：mulberry32（C1 原型做法）＋定值 seed，且**逐格取數的順序照抄原型**
 * ——順序一變，同一顆 seed 也會長出另一片天，減量檔位就對不上 routemap 原型的截圖。
 */
import type { CSSProperties } from "react";

/** 場景＝主題本體：粉彩星空（亮）／銀河鐵道（暗） */
export type SkyVariant = "pastel" | "galaxy";
/** 密度檔位（規格 §2 階梯） */
export type SkyDensity = "full" | "reduced" | "none";

/** style 物件要放 CSS 自訂屬性（--x／--o…），用 pattern index signature 讓 tsc 收得下 */
export type CssVars = CSSProperties & Record<`--${string}`, string>;

export interface SkyDot {
  id: string;
  className: string;
  style: CssVars;
}

export interface Starfield {
  /** 銀河場景的靜態星塵；粉彩場景為空陣列 */
  dust: SkyDot[];
  /** 會呼吸的星 */
  stars: SkyDot[];
}

/** C1 原型逐字：seeded random，比稿時看的是同一片天 */
export function mulberry32(a: number): () => number {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 全量檔位 seed＝C1 原型值；減量檔位 seed＝routemap 原型值（沿用＝星圖與原型截圖對得上） */
const SEED_FULL = 20260806;
const SEED_REDUCED = 20260827;

interface PastelProfile {
  count: number;
  /** 前 n 顆放大並帶柔光 */
  big: number;
  oBigBase: number;
  oBigSpan: number;
  oBase: number;
  oSpan: number;
  /** 呼吸週期 base + rnd*span 秒 */
  dBase: number;
  dSpan: number;
  seed: number;
}

const PASTEL: Record<"full" | "reduced", PastelProfile> = {
  // C2 原型：48 顆、rnd(.8,.95)／rnd(.45,.85)、rnd(4,9)s
  full: { count: 48, big: 4, oBigBase: 0.8, oBigSpan: 0.15, oBase: 0.45, oSpan: 0.4, dBase: 4, dSpan: 5, seed: SEED_FULL },
  // routemap 原型：32 顆、.75+rnd*.15／.4+rnd*.35、6–12s
  reduced: { count: 32, big: 3, oBigBase: 0.75, oBigSpan: 0.15, oBase: 0.4, oSpan: 0.35, dBase: 6, dSpan: 6, seed: SEED_REDUCED },
};

interface GalaxyProfile {
  dust: number;
  stars: number;
  durBase: number;
  durSpan: number;
  seed: number;
}

const GALAXY: Record<"full" | "reduced", GalaxyProfile> = {
  // C1 原型：星塵 90＋呼吸星 56，4–11s
  full: { dust: 90, stars: 56, durBase: 4, durSpan: 7, seed: SEED_FULL },
  // routemap 原型：星塵 70＋呼吸星 36，6–12s
  reduced: { dust: 70, stars: 36, durBase: 6, durSpan: 6, seed: SEED_REDUCED },
};

/** 粉彩：稀、小、慢；只在天空上 62%、往上集中；書封蓋住左側 236px，故 x 從 18% 起 */
function buildPastel(density: "full" | "reduced"): Starfield {
  const p = PASTEL[density];
  const rnd = mulberry32(p.seed);
  const stars: SkyDot[] = [];
  for (let i = 0; i < p.count; i++) {
    // ⚠ 取數順序照原型：y → x → size → opacity → 週期 → 延遲
    const y = Math.pow(rnd(), 1.6) * 62;
    const big = i < p.big;
    const x = 18 + rnd() * 81;
    const size = big ? 2.2 + rnd() * 0.6 : 1 + rnd() * 0.9;
    const o = big ? p.oBigBase + rnd() * p.oBigSpan : p.oBase + rnd() * p.oSpan;
    const d = p.dBase + rnd() * p.dSpan;
    const dl = -(rnd() * 9);
    stars.push({
      id: `p${i}`,
      className: big ? "sky-star is-glow" : "sky-star",
      style: {
        "--x": `${x.toFixed(2)}%`,
        "--y": `${y.toFixed(2)}%`,
        "--s": `${size.toFixed(2)}px`,
        "--o": o.toFixed(2),
        "--d": `${d.toFixed(2)}s`,
        "--dl": `${dl.toFixed(2)}s`,
      },
    });
  }
  return { dust: [], stars };
}

/** 銀河：靜態星塵鋪底＋少數會呼吸的星（少數偏暖、少數稍亮帶一圈柔光） */
function buildGalaxy(density: "full" | "reduced"): Starfield {
  const g = GALAXY[density];
  const rnd = mulberry32(g.seed);

  // ⚠ 星塵先抽、星後抽（同一條亂數流）——順序照原型
  const dust: SkyDot[] = [];
  for (let i = 0; i < g.dust; i++) {
    const size = (0.8 + rnd() * 0.7).toFixed(2);
    const left = (rnd() * 100).toFixed(2);
    const top = (rnd() * 86).toFixed(2);
    const o = (0.18 + rnd() * 0.3).toFixed(2);
    dust.push({
      id: `d${i}`,
      className: "sky-dust",
      style: { left: `${left}%`, top: `${top}%`, width: `${size}px`, height: `${size}px`, "--o": o },
    });
  }

  const stars: SkyDot[] = [];
  for (let i = 0; i < g.stars; i++) {
    const r = rnd();
    const size = r < 0.12 ? 2.6 : r < 0.5 ? 1.8 : 1.3;
    const left = (rnd() * 100).toFixed(2);
    const top = (rnd() * 84).toFixed(2);
    const o0 = (0.28 + rnd() * 0.27).toFixed(2);
    const o1 = (0.72 + rnd() * 0.28).toFixed(2);
    const dur = (g.durBase + rnd() * g.durSpan).toFixed(1);
    const delay = (rnd() * 9).toFixed(1);
    const warm = rnd() < 0.18;
    stars.push({
      id: `g${i}`,
      className: `sky-star${warm ? " is-warm" : ""}${size > 2 ? " is-bright" : ""}`,
      style: {
        left: `${left}%`,
        top: `${top}%`,
        width: `${size}px`,
        height: `${size}px`,
        "--o0": o0,
        "--o1": o1,
        "--dur": `${dur}s`,
        "--delay": `-${delay}s`,
      },
    });
  }

  return { dust, stars };
}

export function buildStarfield(variant: SkyVariant, density: SkyDensity): Starfield {
  if (density === "none") return { dust: [], stars: [] };
  return variant === "pastel" ? buildPastel(density) : buildGalaxy(density);
}
