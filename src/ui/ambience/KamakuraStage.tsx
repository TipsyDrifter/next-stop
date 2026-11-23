/**
 * KamakuraStage.tsx — 第四梯 4B 旗艦時光動態主題「水鏡鎌倉・湖上列車」2.5D 手繪實景合成舞台
 *
 * 視覺架構（原生 16:9 · 3840×2160 4K 超採樣至 1920×1080 手繪畫作包）：
 *   - Z0 四時同構圖手繪底圖（朝霧 dawn · 晴空 day · 暮色 dusk · 星夜 night）：24h 依分鐘平滑疊化，遠山稜線與海灣岬角像素級鎖定。
 *   - Z1 對岸山腳星點燈火遮罩（lights_mask.webp）：晨昏入夜以柔和加法光場呼吸閃爍，並投射入水。
 *   - Z2 零條紋絲絨水鏡微晃 ＋ 對岸山腳微縮復古私鐵電車（含同步水鏡拉絲倒影、晝夜自動換光、雙節常規與全済三節特快編成）。
 *   - Z3 天象生機層：遠空掠水飛鳥、星夜流光、微雨山嵐薄霧與湖面透視雨滴漣漪。
 *   - Z4 色彩去污零毛邊前景層（低矮石砌步道、單橫桿舊木欄杆與左右曲折冬日細枯枝）：隨晝／暮／夜同步換光，橫屏嚴格錨定視窗寬度絕不裁切兩側樹枝。
 *
 * 雙端低功耗鐵則：
 *   - 嚴格接入 useMotionSleep() 與 usePrefersReducedMotion()：最小化、背景、閒置、關閉動態或減少動態時，僅靜態繪製 1 幀即停駐（0fps、零計時器）。
 *   - 動態運行時鎖定 24fps 動畫電影幀率，水波於獨立整數離屏畫布無重疊拼合後單次疊回（零橫條紋）。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useMotionSleep } from "./motionSleep";
import { usePrefersReducedMotion } from "./useAmbience";
import { useMoodStore } from "./moodStore";
import {
  ALL_KAMAKURA_CSS_VARS,
  KamakuraDirector,
  kamakuraCssVarsOf,
  kamakuraPaletteAt,
  kamakuraPhaseWeightsAt,
  parseKamakuraRole,
  resolveKamakuraMinute,
  resolveKamakuraRain,
  type KamakuraActorEvent,
  type KamakuraPhaseWeights,
  type KamakuraRole,
} from "./kamakuraPalette";

const HORIZON_SRC_RATIO = 617 / 1080;
const WALKWAY_SRC_RATIO = 0.09766;
const FRAME_MS = 1000 / 24;

interface LoadedPack {
  skyDawn: HTMLImageElement;
  skyDay: HTMLImageElement;
  skyDusk: HTMLImageElement;
  skyNight: HTMLImageElement;
  lights: HTMLImageElement;
  fgDay: HTMLImageElement;
  fgDusk: HTMLImageElement;
  fgNight: HTMLImageElement;
  trainDay2: HTMLCanvasElement;
  trainGlow2: HTMLCanvasElement;
  trainDay3: HTMLCanvasElement;
  trainGlow3: HTMLCanvasElement;
}

interface RunningTrain {
  id: number;
  long: boolean;
  dir: 1 | -1;
  u: number; // 0..1 橫越進度
  speed: number;
}

interface RunningBird {
  x: number;
  y: number;
  vx: number;
  phase: number;
}

interface RunningMeteor {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
}

interface RunningRipple {
  x: number;
  y: number;
  r: number;
  maxR: number;
  alpha: number;
}

interface KamakuraDomState {
  active: boolean;
  role: KamakuraRole;
  mobile: boolean;
}

function readKamakuraDomState(): KamakuraDomState {
  if (typeof document === "undefined") return { active: false, role: "full", mobile: false };
  const el = document.documentElement;
  return {
    active: el.getAttribute("data-skin") === "kamakura",
    role: parseKamakuraRole(el.getAttribute("data-kamakura-role")),
    mobile: el.getAttribute("data-shell") === "mobile",
  };
}

export function useKamakuraDomState(): KamakuraDomState {
  const [domState, setDomState] = useState<KamakuraDomState>(readKamakuraDomState);

  useEffect(() => {
    const el = document.documentElement;
    const sync = () => {
      const next = readKamakuraDomState();
      setDomState((prev) =>
        prev.active === next.active && prev.role === next.role && prev.mobile === next.mobile ? prev : next,
      );
    };
    const ob = new MutationObserver(sync);
    ob.observe(el, { attributes: true, attributeFilter: ["data-skin", "data-kamakura-role", "data-shell"] });
    sync();
    return () => ob.disconnect();
  }, []);

  return domState;
}

export function useIsKamakuraSkin(): boolean {
  return useKamakuraDomState().active;
}

function currentTimePair(): { minuteOfDay: number; epochMinutes: number } {
  const now = new Date();
  return {
    minuteOfDay: now.getHours() * 60 + now.getMinutes(),
    epochMinutes: Math.floor(now.getTime() / 60_000),
  };
}

function assetUrl(file: string): string {
  const base = import.meta.env.BASE_URL || "/";
  return `${base.endsWith("/") ? base : `${base}/`}kamakura/${file}`;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.decoding = "async";
    im.onload = () => resolve(im);
    im.onerror = reject;
    im.src = src;
  });
}

/** 離屏預製雙節與三節編成之「白晝遠岸松綠款」與「晨昏星夜暖窗款」精靈，執行期零像素處理開銷 */
function buildTrainSprites(raw: HTMLImageElement) {
  const makeTwoCar = (dayMode: boolean): HTMLCanvasElement => {
    const c = document.createElement("canvas");
    c.width = raw.width;
    c.height = raw.height;
    const g = c.getContext("2d")!;
    g.drawImage(raw, 0, 0);
    g.globalCompositeOperation = "source-atop";
    if (dayMode) {
      // 白晝對岸遠景：降低燈窗橘光感並帶入鎌倉海灣遠山空氣藍綠霧氣
      g.fillStyle = "rgba(74, 122, 152, 0.34)"; // 字面值：水鏡鎌倉畫布場景美術色（白晝遠岸空氣霧感）
      g.fillRect(0, 0, c.width, c.height);
    } else {
      // 晨昏與星夜：車體融入遠山群青紫靄，保留溫暖琥珀燈窗
      g.fillStyle = "rgba(46, 40, 88, 0.18)"; // 字面值：水鏡鎌倉畫布場景美術色（暮夜車體環境紫靄）
      g.fillRect(0, 0, c.width, c.height);
    }
    return c;
  };

  const makeThreeCar = (twoCar: HTMLCanvasElement): HTMLCanvasElement => {
    const w = twoCar.width;
    const h = twoCar.height;
    const midW = Math.round(w * 0.46);
    const c = document.createElement("canvas");
    c.width = w + midW;
    c.height = h;
    const g = c.getContext("2d")!;
    const half = Math.round(w * 0.5);
    g.drawImage(twoCar, 0, 0, half, h, 0, 0, half, h);
    g.drawImage(twoCar, Math.round(w * 0.27), 0, midW, h, half - 2, 0, midW + 4, h);
    g.drawImage(twoCar, half, 0, w - half, h, half + midW, 0, w - half, h);
    return c;
  };

  const trainDay2 = makeTwoCar(true);
  const trainGlow2 = makeTwoCar(false);
  return {
    trainDay2,
    trainGlow2,
    trainDay3: makeThreeCar(trainDay2),
    trainGlow3: makeThreeCar(trainGlow2),
  };
}

let cachedPackPromise: Promise<LoadedPack> | null = null;

function ensureKamakuraPack(): Promise<LoadedPack> {
  if (!cachedPackPromise) {
    cachedPackPromise = Promise.all([
      loadImage(assetUrl("sky_dawn.webp")),
      loadImage(assetUrl("sky_day.webp")),
      loadImage(assetUrl("sky_dusk.webp")),
      loadImage(assetUrl("sky_night.webp")),
      loadImage(assetUrl("lights_mask.webp")),
      loadImage(assetUrl("fg_day.webp")),
      loadImage(assetUrl("fg_dusk.webp")),
      loadImage(assetUrl("fg_night.webp")),
      loadImage(assetUrl("train_enoden.webp")),
    ]).then(([skyDawn, skyDay, skyDusk, skyNight, lights, fgDay, fgDusk, fgNight, rawTrain]) => ({
      skyDawn,
      skyDay,
      skyDusk,
      skyNight,
      lights,
      fgDay,
      fgDusk,
      fgNight,
      ...buildTrainSprites(rawTrain),
    }));
  }
  return cachedPackPromise;
}

/** 以 source-atop 在離屏畫布平滑混合同透明遮罩之晝／暮／夜前景，100% 維持邊緣去污乾淨度且每分鐘至多執行一次 */
function blendForegroundOnce(
  target: HTMLCanvasElement,
  pack: LoadedPack,
  weights: KamakuraPhaseWeights,
): void {
  const fw = pack.fgDusk.width;
  const fh = pack.fgDusk.height;
  if (target.width !== fw || target.height !== fh) {
    target.width = fw;
    target.height = fh;
  }
  const g = target.getContext("2d")!;
  g.clearRect(0, 0, fw, fh);

  const wDay = weights.day + weights.dawn * 0.30;
  const wDusk = weights.dusk + weights.dawn * 0.70;
  const wNight = weights.night;

  // 挑選權重最大者作基底（alpha 100% 精準鎖定），再以 source-atop 疊入次要時段色調
  let baseImg = pack.fgDusk;
  let overlayImg: HTMLImageElement | null = null;
  let overlayAlpha = 0;

  if (wDay >= wDusk && wDay >= wNight) {
    baseImg = pack.fgDay;
    if (wDusk > 0.01) {
      overlayImg = pack.fgDusk;
      overlayAlpha = wDusk / (wDay + wDusk);
    }
  } else if (wNight >= wDusk && wNight >= wDay) {
    baseImg = pack.fgNight;
    if (wDusk > 0.01) {
      overlayImg = pack.fgDusk;
      overlayAlpha = wDusk / (wNight + wDusk);
    }
  } else {
    baseImg = pack.fgDusk;
    if (wDay > wNight && wDay > 0.01) {
      overlayImg = pack.fgDay;
      overlayAlpha = wDay / (wDusk + wDay);
    } else if (wNight > 0.01) {
      overlayImg = pack.fgNight;
      overlayAlpha = wNight / (wDusk + wNight);
    }
  }

  g.globalCompositeOperation = "source-over";
  g.globalAlpha = 1;
  g.drawImage(baseImg, 0, 0);

  if (overlayImg && overlayAlpha > 0.01) {
    g.globalCompositeOperation = "source-atop";
    g.globalAlpha = overlayAlpha;
    g.drawImage(overlayImg, 0, 0);
  }

  g.globalAlpha = 1;
  g.globalCompositeOperation = "source-over";
}

export function KamakuraStage({ twinkle: _twinkle = true }: { twinkle?: boolean }) {
  const domState = useKamakuraDomState();
  const isKamakura = domState.active;
  const asleep = useMotionSleep() !== null;
  const reduced = usePrefersReducedMotion();

  const mode = useMoodStore((s) => s.mode);
  const level = useMoodStore((s) => s.level);
  const parts = useMoodStore((s) => s.parts);
  const kamakuraTime = useMoodStore((s) => s.kamakuraTime);
  const kamakuraWeather = useMoodStore((s) => s.kamakuraWeather);
  const ritualSeq = useMoodStore((s) => s.ritualSeq);
  const ritualAllDone = useMoodStore((s) => s.ritualAllDone);

  const [clockPair, setClockPair] = useState(currentTimePair);
  const [pack, setPack] = useState<LoadedPack | null>(null);

  useEffect(() => {
    if (!isKamakura) return;
    let alive = true;
    ensureKamakuraPack()
      .then((loaded) => {
        if (alive) setPack(loaded);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [isKamakura]);

  // 每分鐘推進一次連續天色與自然天象；睡眠／最小化時立即清除計時器（0% CPU）
  useEffect(() => {
    if (!isKamakura || asleep) return;
    if (kamakuraTime !== "auto" && kamakuraWeather !== "auto") return;
    setClockPair(currentTimePair());
    const id = window.setInterval(() => setClockPair(currentTimePair()), 60_000);
    return () => window.clearInterval(id);
  }, [isKamakura, asleep, kamakuraTime, kamakuraWeather]);

  const effectiveMinute = resolveKamakuraMinute(kamakuraTime, clockPair.minuteOfDay, domState.role);
  const effectiveRain = resolveKamakuraRain(kamakuraWeather, clockPair.epochMinutes);
  const palette = useMemo(
    () => kamakuraPaletteAt(effectiveMinute, effectiveRain, { mobile: domState.mobile }),
    [effectiveMinute, effectiveRain, domState.mobile],
  );
  const weights = useMemo(() => kamakuraPhaseWeightsAt(effectiveMinute), [effectiveMinute]);

  // 將 24h 連續插值變數與當前時段相位寫入 :root，離開水鏡鎌倉時 100% 清除乾淨
  useLayoutEffect(() => {
    const root = document.documentElement;
    if (!isKamakura) return;
    const vars = kamakuraCssVarsOf(palette);
    for (const [k, v] of Object.entries(vars)) {
      root.style.setProperty(k, v);
    }
    root.setAttribute("data-km-phase", palette.phase);
    if (domState.role === "full") {
      const targetTheme = palette.isDark ? "dark" : "light";
      if (root.getAttribute("data-theme") !== targetTheme) {
        root.setAttribute("data-theme", targetTheme);
      }
    }
  }, [isKamakura, domState.role, palette]);

  useLayoutEffect(() => {
    if (isKamakura) return;
    const root = document.documentElement;
    for (const k of ALL_KAMAKURA_CSS_VARS) {
      root.style.removeProperty(k);
    }
    root.removeAttribute("data-km-phase");
  }, [isKamakura]);

  useEffect(() => {
    return () => {
      const root = document.documentElement;
      for (const k of ALL_KAMAKURA_CSS_VARS) {
        root.style.removeProperty(k);
      }
      root.removeAttribute("data-km-phase");
    };
  }, []);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scenicRef = useRef<HTMLDivElement>(null);

  // 動態演員狀態（存於 ref 供 24fps Canvas 直接讀取，不觸發 React 重繪）
  const actorsRef = useRef<{
    trains: RunningTrain[];
    birds: RunningBird[];
    meteors: RunningMeteor[];
    ripples: RunningRipple[];
    parallaxX: number;
    seq: number;
  }>({
    trains: [],
    birds: [
      { x: 0.74, y: 0.25, vx: -0.017, phase: 0 },
      { x: 0.79, y: 0.22, vx: -0.016, phase: 1.7 },
    ],
    meteors: [],
    ripples: [],
    parallaxX: 0,
    seq: 0,
  });

  const directorRef = useRef<KamakuraDirector | null>(null);
  if (!directorRef.current) {
    directorRef.current = new KamakuraDirector((ev: KamakuraActorEvent) => {
      const st = actorsRef.current;
      st.seq += 1;
      if (ev.kind === "train") {
        const dir: 1 | -1 = ev.direction === "ltr" ? 1 : -1;
        st.trains.push({
          id: st.seq,
          long: ev.long,
          dir,
          u: 0,
          speed: 0.036 + Math.random() * 0.006, // 約 25–28 秒寧靜橫越對岸山腳
        });
        if (st.trains.length > 2) st.trains.shift();
      } else if (ev.life === "egret") {
        st.birds.push({
          x: 1.06,
          y: 0.20 + Math.random() * 0.18,
          vx: -(0.018 + Math.random() * 0.006),
          phase: Math.random() * 6.28,
        });
        if (st.birds.length > 5) st.birds.shift();
      } else if (ev.life === "meteor") {
        st.meteors.push({
          x: 0.42 + Math.random() * 0.44,
          y: 0.08 + Math.random() * 0.18,
          vx: -0.26,
          vy: 0.11,
          life: 0,
          maxLife: 1.15,
        });
      }
    });
  }
  const director = directorRef.current;

  useEffect(() => {
    if (!isKamakura) {
      director.destroy();
      actorsRef.current.trains = [];
      actorsRef.current.meteors = [];
      actorsRef.current.ripples = [];
      return;
    }
    director.configure({
      mode,
      level,
      parts,
      phase: palette.phase,
      rainAmount: palette.rainAmount,
      reduced,
    });
  }, [director, isKamakura, mode, level, parts, palette.phase, palette.rainAmount, reduced]);

  useEffect(() => () => director.destroy(), [director]);

  useEffect(() => {
    director.setAwake(!asleep);
  }, [director, asleep]);

  const motionAllowed = mode !== "off" && !reduced;
  useEffect(() => {
    if (!motionAllowed || !parts.train) actorsRef.current.trains = [];
    if (!motionAllowed) {
      actorsRef.current.meteors = [];
      actorsRef.current.ripples = [];
    }
  }, [motionAllowed, parts.train]);

  const prevRitual = useRef(ritualSeq);
  useEffect(() => {
    if (ritualSeq === prevRitual.current) return;
    prevRitual.current = ritualSeq;
    if (isKamakura) director.stamped(ritualAllDone);
  }, [director, isKamakura, ritualSeq, ritualAllDone]);

  // 滑鼠微視差（僅桌機清醒且開啟天象時監聽，極輕量無重排）
  useEffect(() => {
    if (!isKamakura || domState.mobile || asleep || !motionAllowed) {
      actorsRef.current.parallaxX = 0;
      return;
    }
    const onMove = (e: PointerEvent) => {
      const nx = e.clientX / Math.max(1, window.innerWidth) - 0.5;
      actorsRef.current.parallaxX = -nx;
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, [isKamakura, domState.mobile, asleep, motionAllowed]);

  // 離屏畫布快取（避免每幀重複建構物件或重複混色前景）
  const buffersRef = useRef<{
    upper: HTMLCanvasElement | null;
    water: HTMLCanvasElement | null;
    fgBlend: HTMLCanvasElement | null;
    fgCacheKey: string;
  }>({
    upper: null,
    water: null,
    fgBlend: null,
    fgCacheKey: "",
  });

  const liveSceneRef = useRef({
    weights,
    palette,
    parts,
    motionAllowed,
    mobile: domState.mobile,
  });
  liveSceneRef.current = { weights, palette, parts, motionAllowed, mobile: domState.mobile };

  // 核心繪製與 24fps 動畫迴圈（睡眠／減少動態／mode=off 時僅繪製 1 幀靜態畫作，0fps 零耗電！）
  useEffect(() => {
    if (!isKamakura || !pack) return;
    const canvas = canvasRef.current;
    const host = scenicRef.current;
    if (!canvas || !host) return;

    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;

    const bufs = buffersRef.current;
    if (!bufs.upper) bufs.upper = document.createElement("canvas");
    if (!bufs.water) bufs.water = document.createElement("canvas");
    if (!bufs.fgBlend) bufs.fgBlend = document.createElement("canvas");

    const drawOneFrame = (nowMs: number, dtSec: number) => {
      const rect = host.getBoundingClientRect();
      const maxDpr = liveSceneRef.current.mobile ? 1.5 : 1.75;
      const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
      const w = Math.max(2, Math.round(rect.width * dpr));
      const h = Math.max(2, Math.round(rect.height * dpr));

      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        bufs.upper!.width = w;
        bufs.upper!.height = h;
        bufs.water!.width = w;
        bufs.water!.height = h;
      }

      const { weights: wt, palette: pal, parts: pt, motionAllowed: allowMotion } = liveSceneRef.current;
      const rain = pal.rainAmount;
      const fgKey = `${wt.dawn.toFixed(3)}|${wt.day.toFixed(3)}|${wt.dusk.toFixed(3)}|${wt.night.toFixed(3)}`;
      if (bufs.fgCacheKey !== fgKey) {
        blendForegroundOnce(bufs.fgBlend!, pack, wt);
        bufs.fgCacheKey = fgKey;
      }

      const offCtx = bufs.upper!.getContext("2d")!;
      const waterCtx = bufs.water!.getContext("2d")!;
      const actors = actorsRef.current;
      const t = nowMs * 0.001;
      const isPortrait = w / h < 1.05;

      const sw = pack.skyDusk.width;
      const sh = pack.skyDusk.height;
      // 原生 16:9 母圖：在 1920×1080 滿版環境下精準對齊，僅留 2.8% 微視差出血邊界
      const scale = Math.max(w / sw, h / sh) * 1.028;
      const dw = sw * scale;
      const dh = sh * scale;
      const dx = (w - dw) * 0.5 + actors.parallaxX * (w * 0.008);
      const dy = !isPortrait
        ? Math.max(h - dh, h * 0.52 - dh * HORIZON_SRC_RATIO)
        : h * 0.53 - dh * HORIZON_SRC_RATIO;
      const horizonY = Math.round(dy + dh * HORIZON_SRC_RATIO);

      // ── 1. 離屏繪製 24h 連續疊化手繪底圖（至多兩張 > 0 權重母圖參與疊合）──
      offCtx.globalCompositeOperation = "source-over";
      offCtx.globalAlpha = 1;
      const entries: [number, HTMLImageElement][] = [
        [wt.dawn, pack.skyDawn],
        [wt.day, pack.skyDay],
        [wt.dusk, pack.skyDusk],
        [wt.night, pack.skyNight],
      ];
      entries.sort((a, b) => b[0] - a[0]);
      offCtx.drawImage(entries[0][1], dx, dy, dw, dh);
      if (entries[1][0] > 0.005) {
        offCtx.globalAlpha = entries[1][0] / (entries[0][0] + entries[1][0]);
        offCtx.drawImage(entries[1][1], dx, dy, dw, dh);
        offCtx.globalAlpha = 1;
      }

      // 對岸山腳星點萬家燈火柔和呼吸
      const townAlpha = Number(pal.sceneVars["--km-town-alpha"] || 0);
      if (townAlpha > 0.04) {
        offCtx.save();
        offCtx.globalCompositeOperation = "lighter";
        const pulse = allowMotion ? 0.82 + 0.18 * Math.sin(t * 1.65) : 0.9;
        offCtx.globalAlpha = Math.min(0.85, townAlpha * 0.65 * pulse);
        offCtx.drawImage(pack.lights, dx, dy, dw, dh);
        offCtx.restore();
      }

      // 微雨山嵐：僅於上半部天空輕染清透藍灰雨意並於遠山腳浮起水彩薄霧帶（絕不整面蓋灰霧，保持水鏡與前景清澈通透！）
      if (rain > 0.03) {
        offCtx.save();
        offCtx.fillStyle = pal.isDark
          ? `rgba(28, 42, 74, ${(rain * 0.18).toFixed(3)})` // 字面值：水鏡鎌倉畫布場景美術色（夜雨天色微降彩）
          : `rgba(76, 92, 128, ${(rain * 0.20).toFixed(3)})`; // 字面值：水鏡鎌倉畫布場景美術色（晝雨天色微降彩）
        offCtx.fillRect(0, 0, w, horizonY + 3);
        const mistTop = Math.round(46 * dpr);
        const mistBot = Math.round(8 * dpr);
        const mistGrad = offCtx.createLinearGradient(0, horizonY - mistTop, 0, horizonY + mistBot);
        const mistRgb = pal.isDark ? "140, 162, 206" : "222, 230, 248";
        mistGrad.addColorStop(0, `rgba(${mistRgb}, 0)`); // 字面值：水鏡鎌倉畫布場景美術色（山嵐漸層上緣）
        mistGrad.addColorStop(0.56, `rgba(${mistRgb}, ${(rain * (pal.isDark ? 0.20 : 0.30)).toFixed(3)})`); // 字面值：水鏡鎌倉畫布場景美術色（山嵐核心霧帶）
        mistGrad.addColorStop(1, `rgba(${mistRgb}, 0.04)`); // 字面值：水鏡鎌倉畫布場景美術色（山嵐水際淡出）
        offCtx.fillStyle = mistGrad;
        offCtx.fillRect(0, horizonY - mistTop, w, mistTop + mistBot);
        offCtx.restore();
      }

      // 遠空候鳥（僅白晝／晨昏且開啟候鳥時輕掠遠空）
      if (allowMotion && pt.birds && !pal.isDark && dtSec > 0) {
        offCtx.save();
        offCtx.strokeStyle = wt.dusk > 0.4 ? "rgba(38, 34, 72, 0.48)" : "rgba(44, 66, 94, 0.42)"; // 字面值：水鏡鎌倉畫布場景美術色（遠空飛鳥剪影）
        offCtx.lineWidth = Math.max(1.1, w * 0.001);
        for (let i = actors.birds.length - 1; i >= 0; i--) {
          const b = actors.birds[i];
          b.x += b.vx * dtSec;
          if (b.x < -0.08) {
            if (i >= 2) {
              actors.birds.splice(i, 1);
              continue;
            }
            b.x = 1.08;
          }
          const bx = b.x * w;
          const by = b.y * horizonY + Math.sin(t * 2.3 + b.phase) * 3.2;
          const wing = Math.sin(t * 5.0 + b.phase) * 3.8;
          offCtx.beginPath();
          offCtx.moveTo(bx - 5.5, by - wing);
          offCtx.quadraticCurveTo(bx - 1.8, by - 1.5, bx, by);
          offCtx.quadraticCurveTo(bx + 1.8, by - 1.5, bx + 5.5, by - wing);
          offCtx.stroke();
        }
        offCtx.restore();
      }

      // 星夜流星（僅夜間且開啟流星時偶爾劃過）
      if (allowMotion && pt.meteor && pal.isDark && actors.meteors.length > 0 && dtSec > 0) {
        offCtx.save();
        for (let i = actors.meteors.length - 1; i >= 0; i--) {
          const m = actors.meteors[i];
          m.life += dtSec;
          if (m.life >= m.maxLife) {
            actors.meteors.splice(i, 1);
            continue;
          }
          const prog = m.life / m.maxLife;
          const mx = (m.x + m.vx * m.life) * w;
          const my = (m.y + m.vy * m.life) * horizonY;
          const tailX = mx - m.vx * 0.22 * w;
          const tailY = my - m.vy * 0.22 * horizonY;
          const alphaM = Math.sin(prog * Math.PI) * 0.85;
          const mg = offCtx.createLinearGradient(tailX, tailY, mx, my);
          mg.addColorStop(0, "rgba(224, 236, 255, 0)"); // 字面值：水鏡鎌倉畫布場景美術色（星夜流光尾端）
          mg.addColorStop(1, `rgba(240, 246, 255, ${alphaM.toFixed(3)})`); // 字面值：水鏡鎌倉畫布場景美術色（星夜流光前端）
          offCtx.strokeStyle = mg;
          offCtx.lineWidth = Math.max(1.3, w * 0.0011);
          offCtx.beginPath();
          offCtx.moveTo(tailX, tailY);
          offCtx.lineTo(mx, my);
          offCtx.stroke();
        }
        offCtx.restore();
      }

      // 先將完整無縫底圖繪入主畫布
      ctx.drawImage(bufs.upper!, 0, 0);

      // ── 2. 零條紋絲絨水鏡微晃：於獨立整數離屏畫布無重疊寫入，再單次疊回主畫布 ──
      const waterH = h - horizonY;
      if (allowMotion && waterH > 6) {
        const strips = Math.min(160, Math.max(56, Math.round(waterH / 3)));
        waterCtx.globalAlpha = 1;
        for (let i = 0; i < strips; i++) {
          const y0 = Math.round(horizonY + (i / strips) * waterH);
          const y1 = Math.round(horizonY + ((i + 1) / strips) * waterH);
          const shStrip = y1 - y0;
          if (shStrip <= 0) continue;

          const u = (i + 0.5) / strips;
          const waveAmp = (0.28 + u * u * 4.2) * (1 + rain * 0.45);
          const shiftX = Math.sin(u * 25.0 - t * 1.75) * waveAmp + Math.cos(u * 12.0 + t * 1.0) * (waveAmp * 0.42);
          waterCtx.drawImage(bufs.upper!, 0, y0, w, shStrip, shiftX, y0, w, shStrip);
        }
        ctx.save();
        ctx.globalAlpha = 0.50;
        ctx.drawImage(bufs.water!, 0, horizonY, w, waterH, 0, horizonY, w, waterH);
        ctx.restore();

        if (townAlpha > 0.05) {
          ctx.save();
          ctx.globalCompositeOperation = "lighter";
          ctx.globalAlpha = Math.min(0.32, townAlpha * 0.26 * (0.85 + 0.15 * Math.sin(t * 2.0)));
          ctx.drawImage(pack.lights, dx, horizonY - sh * HORIZON_SRC_RATIO * scale, dw, dh * 1.05);
          ctx.restore();
        }
      }

      // ── 3. 對岸山腳微縮列車 ＋ 水鏡暖光倒影（定案位置：緊貼遠山水際線 horizonY）──
      if (allowMotion && pt.train && actors.trains.length > 0) {
        const trainHalo = Number(pal.sceneVars["--km-train-halo"] || 0);
        const useGlowSprite = trainHalo >= 0.30 || wt.dusk > 0.35 || wt.night > 0.35 || wt.dawn > 0.45;
        const trainH = Math.max(12, Math.round(h * 0.021));
        const trackY = horizonY;

        for (let i = actors.trains.length - 1; i >= 0; i--) {
          const tr = actors.trains[i];
          if (dtSec > 0) tr.u += tr.speed * dtSec;
          if (tr.u >= 1) {
            actors.trains.splice(i, 1);
            director.trainEnded();
            continue;
          }

          const sprite = tr.long
            ? useGlowSprite
              ? pack.trainGlow3
              : pack.trainDay3
            : useGlowSprite
              ? pack.trainGlow2
              : pack.trainDay2;
          const trainW = Math.round(trainH * (sprite.width / sprite.height));
          const totalRun = w + trainW + 48;
          const tx = tr.dir === 1 ? -trainW - 24 + tr.u * totalRun : w + 24 - tr.u * totalRun;
          const ty = trackY - Math.round(trainH * 0.94);

          // (a) 水際微縮倒影與暖金拉絲光暈
          ctx.save();
          const refH = Math.max(8, Math.round(trainH * 0.85));
          const slices = 6;
          for (let s = 0; s < slices; s++) {
            const f0 = s / slices;
            const f1 = (s + 1) / slices;
            const ry0 = Math.round(trackY + 1 + f0 * refH);
            const ry1 = Math.round(trackY + 1 + f1 * refH);
            if (ry1 <= ry0) continue;
            const rdx = Math.sin(t * 3.2 + s * 1.4) * (0.6 + f0 * 1.8);
            ctx.globalAlpha = (0.40 - f0 * 0.30) * (1 - rain * 0.2);
            ctx.save();
            if (tr.dir === -1) {
              ctx.translate(tx + rdx + trainW, 0);
              ctx.scale(-1, 1);
              ctx.drawImage(
                sprite,
                0,
                sprite.height * (1 - f1),
                sprite.width,
                sprite.height * (f1 - f0),
                0,
                ry0,
                trainW,
                ry1 - ry0,
              );
            } else {
              ctx.drawImage(
                sprite,
                0,
                sprite.height * (1 - f1),
                sprite.width,
                sprite.height * (f1 - f0),
                tx + rdx,
                ry0,
                trainW,
                ry1 - ry0,
              );
            }
            ctx.restore();
          }

          if (useGlowSprite) {
            ctx.globalCompositeOperation = "lighter";
            const glowR = trainW * 0.55;
            const cxGlow = tx + trainW * 0.5;
            const cyGlow = trackY + refH * 0.5;
            const glow = ctx.createRadialGradient(cxGlow, cyGlow, 1, cxGlow, cyGlow, glowR);
            glow.addColorStop(0, `rgba(255, 206, 136, ${(0.28 * Math.max(0.45, trainHalo)).toFixed(3)})`); // 字面值：水鏡鎌倉畫布場景美術色（對岸列車水鏡暖金倒影）
            glow.addColorStop(1, "rgba(255, 170, 130, 0)"); // 字面值：水鏡鎌倉畫布場景美術色（對岸列車水鏡倒影淡出）
            ctx.fillStyle = glow;
            ctx.fillRect(tx - 16, trackY, trainW + 32, refH * 1.8);
          }
          ctx.restore();

          // (b) 對岸山腳微縮列車本體
          ctx.save();
          if (tr.dir === -1) {
            ctx.translate(tx + trainW, 0);
            ctx.scale(-1, 1);
            ctx.drawImage(sprite, 0, ty, trainW, trainH);
          } else {
            ctx.drawImage(sprite, tx, ty, trainW, trainH);
          }
          ctx.restore();
        }
      }

      // ── 4. 微雨山嵐：湖面透視雨滴漣漪圈 ──
      if (allowMotion && rain > 0.15 && waterH > 12) {
        if (dtSec > 0 && Math.random() < rain * 0.48 && actors.ripples.length < 32) {
          actors.ripples.push({
            x: Math.random() * w,
            y: horizonY + Math.pow(Math.random(), 0.75) * waterH * 0.84,
            r: 2 * dpr,
            maxR: (18 + Math.random() * 32) * dpr,
            alpha: 0.44 * rain,
          });
        }
        ctx.save();
        ctx.lineWidth = Math.max(1, dpr * 0.85);
        for (let i = actors.ripples.length - 1; i >= 0; i--) {
          const rp = actors.ripples[i];
          if (dtSec > 0) {
            rp.r += 22 * dpr * dtSec;
            rp.alpha *= Math.pow(0.42, dtSec);
          }
          if (rp.r > rp.maxR || rp.alpha < 0.02) {
            actors.ripples.splice(i, 1);
            continue;
          }
          const persp = 0.18 + 0.22 * ((rp.y - horizonY) / Math.max(1, waterH));
          ctx.strokeStyle = pal.isDark
            ? `rgba(216, 230, 255, ${rp.alpha.toFixed(3)})` // 字面值：水鏡鎌倉畫布場景美術色（夜雨漣漪環）
            : `rgba(255, 236, 244, ${rp.alpha.toFixed(3)})`; // 字面值：水鏡鎌倉畫布場景美術色（晝暮雨滴漣漪環）
          ctx.beginPath();
          ctx.ellipse(rp.x, rp.y, rp.r, rp.r * persp, 0, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.restore();
      }

      // ── 5. Z4 原生 16:9 零毛邊前景層（橫屏嚴格鎖定視窗寬度 w，與背景 dh 脫鉤，絕不裁切兩側冬枝！）──
      const fgCanvas = bufs.fgBlend!;
      if (!isPortrait) {
        const fgW = w * 1.028;
        const fgH = fgW * (fgCanvas.height / fgCanvas.width);
        const fgX = (w - fgW) * 0.5 - actors.parallaxX * (w * 0.022);
        const naturalWalkwayH = fgW * (sh / sw) * WALKWAY_SRC_RATIO;
        const sinkY = Math.max(0, naturalWalkwayH - h * 0.112);
        const fgY = h - fgH + sinkY + 2;
        ctx.drawImage(fgCanvas, fgX, fgY, fgW, fgH);
      } else {
        // 手機直屏：確保右側 834 曲折冬枝與步道缺口優雅入鏡，底緣輕巧不壓版
        const fgScale = Math.max((w * 2.05) / fgCanvas.width, (h * 0.35) / fgCanvas.height);
        const fgW = fgCanvas.width * fgScale;
        const fgH = fgCanvas.height * fgScale;
        const fgX = (w - fgW) * 0.66 - actors.parallaxX * (w * 0.018);
        const fgY = h - fgH + 2;
        ctx.drawImage(fgCanvas, fgX, fgY, fgW, fgH);
      }

      // 微雨清晰斜雨絲（雙層景深雨絲，還原初版通透細雨質感）
      if (allowMotion && rain > 0.15) {
        ctx.save();
        ctx.strokeStyle = pal.isDark
          ? `rgba(222, 234, 255, ${(rain * 0.28).toFixed(3)})` // 字面值：水鏡鎌倉畫布場景美術色（夜雨斜雨絲）
          : `rgba(238, 244, 255, ${(rain * 0.32).toFixed(3)})`; // 字面值：水鏡鎌倉畫布場景美術色（晝暮斜雨絲）
        ctx.lineWidth = Math.max(1.1, dpr * 0.85);
        const dxRain = -7 * dpr;
        const dyRain = 25 * dpr;
        for (let r = 0; r < 52; r++) {
          const rx = ((r * 97 * dpr + nowMs * 0.28 * dpr) % (w + 120)) - 60;
          const ry = ((r * 151 * dpr + nowMs * 0.86 * dpr) % (h + 80)) - 40;
          ctx.beginPath();
          ctx.moveTo(rx, ry);
          ctx.lineTo(rx + dxRain, ry + dyRain);
          ctx.stroke();
        }
        ctx.restore();
      }
    };

    // 靜態單幀繪製（當睡眠、減少動態或天象關閉時，繪完 1 幀即完全停駐 0fps）
    const shouldAnimate = !asleep && motionAllowed;
    drawOneFrame(performance.now(), 0);

    const ro =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => {
            drawOneFrame(performance.now(), 0);
          })
        : null;
    ro?.observe(host);

    if (!shouldAnimate) {
      return () => ro?.disconnect();
    }

    let rafId = 0;
    let lastMs = performance.now();
    const tick = (nowMs: number) => {
      rafId = window.requestAnimationFrame(tick);
      if (document.hidden) {
        lastMs = nowMs;
        return;
      }
      const elapsed = nowMs - lastMs;
      if (elapsed < FRAME_MS) return;
      const dtSec = Math.min(0.1, elapsed * 0.001);
      lastMs = nowMs;
      drawOneFrame(nowMs, dtSec);
    };
    rafId = window.requestAnimationFrame(tick);

    return () => {
      window.cancelAnimationFrame(rafId);
      ro?.disconnect();
    };
  }, [isKamakura, pack, asleep, motionAllowed, weights, palette, domState.mobile]);

  if (!isKamakura) return null;

  return (
    <div className="km-stage" data-level={level} data-phase={palette.phase} aria-hidden="true">
      <div className="km-sky-backdrop" />
      <div ref={scenicRef} className="km-scenic">
        <canvas ref={canvasRef} className="km-canvas" />
      </div>
      <div className="km-head-veil" />
    </div>
  );
}
