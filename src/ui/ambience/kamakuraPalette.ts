/**
 * kamakuraPalette.ts — 第四梯 4B 旗艦時光動態主題「水鏡鎌倉・湖上列車」純函式調色盤與生機排程引擎
 *
 * 設計目標：
 *   1. 依一天分鐘數（0..1439）在 OKLab 感知色彩空間平滑連續插值（含 1439→0 跨午夜無縫閉環），絕無生硬跳變：
 *      - 朝霧黎明（05:00–07:00）：淡霧青紫透出柔金朝霞，湖面薄霧與柔和金粉水波。
 *      - 晴空碧水（07:00–16:00）：通透清澈的鎌倉海空蔚藍、遠方潔白層雲，湖面映照晴空與細碎波光。
 *      - 黃昏魔幻暮色（16:00–18:45）：天頂青檸淡藍 → 中層琥珀蛋黃 → 地平線珊瑚橙紅與晚霞紫紅，水面絢麗倒影與金色碎光。
 *      - 星月夜行（18:45–05:00）：深邃群青藍紫夜空、星辰、升起明月與湖面銀白月光水路，對岸山腳點起琥珀萬家燈火。
 *   2. 支援晴朗水鏡（clear）與微雨山嵐（rain）平滑過渡，以及緩慢自然的晴雨交替週期（auto）。
 *   3. 嚴格保證 24 小時每一分鐘（0..1439）紙卡（.techo-card / .ticket）與頁首文字皆通過 WCAG AA 對比度守門。
 *   4. 零 React／零 DOM 執行期耦合，可直接由 `node --test` 毫秒級驗證。
 */
import { browserClock, type MoodClock, type MoodMode, type MoodParts } from "./moodDirector.ts";

export type KamakuraTimeMode = "auto" | "dawn" | "day" | "dusk" | "night";
export type KamakuraWeatherMode = "auto" | "clear" | "rain";
export type KamakuraPhase = "dawn" | "day" | "dusk" | "night";
export type KamakuraRole = "full" | "light" | "dark";

export type RgbaTuple = readonly [number, number, number, number];

export const KAMAKURA_PRESET_MINUTES: Record<Exclude<KamakuraTimeMode, "auto">, number> = {
  dawn: 360,  // 06:00 朝霧柔金
  day: 690,   // 11:30 晴空碧水
  dusk: 1055, // 17:35 魔幻暮色（青檸→琥珀→珊瑚→紫紅）
  night: 1320 // 22:00 星月夜行
};

export const KAMAKURA_PHASE_LABELS: Record<KamakuraPhase, string> = {
  dawn: "朝霧黎明",
  day: "晴空碧水",
  dusk: "黃昏暮色",
  night: "星月夜行",
};

export function parseKamakuraTime(raw: string | null | undefined): KamakuraTimeMode {
  if (raw === "dawn" || raw === "day" || raw === "dusk" || raw === "night" || raw === "auto") {
    return raw;
  }
  return "auto";
}

export function parseKamakuraWeather(raw: string | null | undefined): KamakuraWeatherMode {
  if (raw === "clear" || raw === "rain" || raw === "auto") {
    return raw;
  }
  return "auto";
}

export function parseKamakuraRole(raw: string | null | undefined): KamakuraRole {
  if (raw === "light" || raw === "dark") return raw;
  return "full";
}

/** 將任意分鐘數正規化至 [0, 1440) 區間 */
export function normalizeMinuteOfDay(minuteOfDay: number): number {
  if (!Number.isFinite(minuteOfDay)) return 720;
  return ((minuteOfDay % 1440) + 1440) % 1440;
}

export interface KamakuraPhaseWeights {
  dawn: number;
  day: number;
  dusk: number;
  night: number;
}

/**
 * 計算 24 小時（0..1439 分鐘）四幅手繪母圖（朝霧／晴空／暮色／星夜）的連續平滑疊化權重：
 *   - 四項權重恆 >= 0 且總和恆為 1.0，任意時刻至多兩幅相鄰時段同時參與混合（省 GPU 且零鬼影）。
 *   - 四大駐足預設時刻（dawn=360, day=690, dusk=1055, night=1320）精準對應單一母圖權重 1.0。
 *   - 跨午夜（1439 → 0）皆為純星夜（night=1.0），閉環無跳變。
 */
export function kamakuraPhaseWeightsAt(minuteOfDay: number): KamakuraPhaseWeights {
  const m = normalizeMinuteOfDay(minuteOfDay);
  // 04:45 (285) -> 06:00 (360): 星夜漸染為朝霧黎明
  if (m >= 285 && m < 360) {
    const t = smoothstep((m - 285) / (360 - 285));
    return { dawn: t, day: 0, dusk: 0, night: 1 - t };
  }
  // 06:00 (360) -> 08:15 (495): 朝霧散開為晴空碧水
  if (m >= 360 && m < 495) {
    const t = smoothstep((m - 360) / (495 - 360));
    return { dawn: 1 - t, day: t, dusk: 0, night: 0 };
  }
  // 08:15 (495) -> 15:50 (950): 全日晴空碧水
  if (m >= 495 && m < 950) {
    return { dawn: 0, day: 1, dusk: 0, night: 0 };
  }
  // 15:50 (950) -> 17:35 (1055): 晴空漸入玫瑰暮色
  if (m >= 950 && m < 1055) {
    const t = smoothstep((m - 950) / (1055 - 950));
    return { dawn: 0, day: 1 - t, dusk: t, night: 0 };
  }
  // 17:35 (1055) -> 18:05 (1085): 駐留魔幻玫瑰暮色峰值
  if (m >= 1055 && m < 1085) {
    return { dawn: 0, day: 0, dusk: 1, night: 0 };
  }
  // 18:05 (1085) -> 19:15 (1155): 暮色餘暉沉入星月夜行
  if (m >= 1085 && m < 1155) {
    const t = smoothstep((m - 1085) / (1155 - 1085));
    return { dawn: 0, day: 0, dusk: 1 - t, night: t };
  }
  // 19:15..24:00 ∪ 00:00..04:45：靜夜深海與銀白月路
  return { dawn: 0, day: 0, dusk: 0, night: 1 };
}

/**
 * 依一天分鐘數判定四大時段相位：
 *   - 朝霧黎明：05:00–07:00（300..419）
 *   - 晴空碧水：07:00–16:00（420..959）
 *   - 黃昏暮色：16:00–18:45（960..1124）
 *   - 星月夜行：18:45–05:00（1125..1439 ∪ 0..299）
 */
export function kamakuraPhaseAt(minuteOfDay: number): KamakuraPhase {
  const m = normalizeMinuteOfDay(minuteOfDay);
  if (m >= 300 && m < 420) return "dawn";
  if (m >= 420 && m < 960) return "day";
  if (m >= 960 && m < 1125) return "dusk";
  return "night";
}

/**
 * 解析實際生效的分鐘數（與 4A `data-kamakura-role` 契約精準對齊）：
 * - `role === "light"`（水鏡鎌倉·晝代表）：一律維持白晝象限（310..1109）。
 *   若 `timeMode` 為 `"dawn" | "day" | "dusk"` 則取該駐足時段；若為 `"auto"` 且即時分鐘在 `310..1109` 則跟隨即時流轉；否則取 `day`（690）。
 * - `role === "dark"`（水鏡鎌倉·夜代表）：一律維持星夜象限（<310 || >=1110）。
 *   若 `timeMode === "auto"` 且即時分鐘在 `<310 || >=1110` 則跟隨即時夜色流轉；否則取 `night`（1320）。
 * - `role === "full"`（水鏡鎌倉全天候模式或未指定之單支環境）：完整依 `timeMode` 走 24h 連續流轉或駐足四時段。
 */
export function resolveKamakuraMinute(
  timeMode: KamakuraTimeMode,
  nowMinute: number,
  role: KamakuraRole = "full",
): number {
  const m = normalizeMinuteOfDay(nowMinute);
  if (role === "light") {
    if (timeMode === "dawn" || timeMode === "day" || timeMode === "dusk") {
      return KAMAKURA_PRESET_MINUTES[timeMode];
    }
    if (timeMode === "auto" && m >= 310 && m < 1110) {
      return m;
    }
    return KAMAKURA_PRESET_MINUTES.day;
  }
  if (role === "dark") {
    if (timeMode === "auto" && (m < 310 || m >= 1110)) {
      return m;
    }
    return KAMAKURA_PRESET_MINUTES.night;
  }
  if (timeMode !== "auto") return KAMAKURA_PRESET_MINUTES[timeMode];
  return m;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export function smoothstep(t: number): number {
  const c = clamp01(t);
  return c * c * (3 - 2 * c);
}

/**
 * 自然天象緩慢晴雨交替（單位：epoch 分鐘）：
 * 以 360 分鐘（6 小時）為一組自然呼吸週期，約 72% 時間為晴朗水鏡，約 28% 緩慢起霧轉為微雨山嵐再放晴，
 * 進出皆有 28 分鐘平滑漸變，絕不閃爍或突兀跳變。
 */
export function naturalRainAt(epochMinutes: number): number {
  if (!Number.isFinite(epochMinutes)) return 0;
  const period = 360;
  const phase = (((epochMinutes + 95) % period) + period) % period;
  // 232..260 漸起山嵐與微雨，260..324 煙雨期，324..352 雨歇雲散
  if (phase < 232 || phase >= 352) return 0;
  if (phase < 260) return smoothstep((phase - 232) / 28);
  if (phase < 324) return 1;
  return 1 - smoothstep((phase - 324) / 28);
}

export function resolveKamakuraRain(weatherMode: KamakuraWeatherMode, epochMinutes: number): number {
  if (weatherMode === "clear") return 0;
  if (weatherMode === "rain") return 1;
  return naturalRainAt(epochMinutes);
}

/* ═══════════════════════════════════════════════════
 * OKLab 感知均勻色彩空間轉換與 WCAG 對比度工具
 * ═══════════════════════════════════════════════════ */

export function parseColorRgba(raw: string): RgbaTuple {
  const s = raw.trim();
  const hex6 = /^#([0-9a-f]{6})$/i.exec(s);
  if (hex6) {
    const n = parseInt(hex6[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const rgba = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(s);
  if (rgba) {
    return [
      Math.round(Number(rgba[1])),
      Math.round(Number(rgba[2])),
      Math.round(Number(rgba[3])),
      rgba[4] === undefined ? 1 : clamp01(Number(rgba[4])),
    ];
  }
  throw new Error(`Invalid color string: ${raw}`);
}

function srgbByteToLinear(c: number): number {
  const v = clamp01(c / 255);
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function linearToSrgbByte(v: number): number {
  const c = clamp01(v);
  const s = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.round(clamp01(s) * 255);
}

interface Oklab {
  L: number;
  a: number;
  b: number;
}

function rgbToOklab(r: number, g: number, b: number): Oklab {
  const lr = srgbByteToLinear(r);
  const lg = srgbByteToLinear(g);
  const lb = srgbByteToLinear(b);

  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);

  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

function oklabToRgb(lab: Oklab): [number, number, number] {
  const l_ = lab.L + 0.3963377774 * lab.a + 0.2158037573 * lab.b;
  const m_ = lab.L - 0.1055613458 * lab.a - 0.0638541728 * lab.b;
  const s_ = lab.L - 0.0894841775 * lab.a - 1.291485548 * lab.b;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  const lr = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const lb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;

  return [linearToSrgbByte(lr), linearToSrgbByte(lg), linearToSrgbByte(lb)];
}

function toHex2(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n)))
    .toString(16)
    .padStart(2, "0");
}

export function formatHex([r, g, b]: readonly [number, number, number]): string {
  return `#${toHex2(r)}${toHex2(g)}${toHex2(b)}`;
}

export function formatRgba([r, g, b]: readonly [number, number, number], alpha: number): string {
  const a = Math.round(clamp01(alpha) * 1000) / 1000;
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${a})`;
}

export function lerpHex(hexA: string, hexB: string, t: number): string {
  const u = clamp01(t);
  if (u <= 0) return hexA.toLowerCase();
  if (u >= 1) return hexB.toLowerCase();
  const [r1, g1, b1] = parseColorRgba(hexA);
  const [r2, g2, b2] = parseColorRgba(hexB);
  const c1 = rgbToOklab(r1, g1, b1);
  const c2 = rgbToOklab(r2, g2, b2);
  const rgb = oklabToRgb({
    L: c1.L + (c2.L - c1.L) * u,
    a: c1.a + (c2.a - c1.a) * u,
    b: c1.b + (c2.b - c1.b) * u,
  });
  return formatHex(rgb);
}

/** 微雨山嵐柔化：在 OKLab 空間降低彩度並向溫潤煙雨色溫靠攏 */
function applyRainMood(hex: string, rainHex: string, rainAmount: number, chromaKeep = 0.58): string {
  const r = clamp01(rainAmount);
  if (r <= 0) return hex.toLowerCase();
  const [cr, cg, cb] = parseColorRgba(hex);
  const [rr, rg, rb] = parseColorRgba(rainHex);
  const base = rgbToOklab(cr, cg, cb);
  const target = rgbToOklab(rr, rg, rb);
  const desat: Oklab = {
    L: base.L,
    a: base.a * (1 - r * (1 - chromaKeep)),
    b: base.b * (1 - r * (1 - chromaKeep)),
  };
  return formatHex(
    oklabToRgb({
      L: desat.L + (target.L - desat.L) * (r * 0.68),
      a: desat.a + (target.a - desat.a) * (r * 0.68),
      b: desat.b + (target.b - desat.b) * (r * 0.68),
    }),
  );
}

export function relativeLuminance([r, g, b]: readonly [number, number, number, ...number[]]): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function compositeOver(fg: RgbaTuple, bg: RgbaTuple): RgbaTuple {
  const a = fg[3];
  return [
    fg[0] * a + bg[0] * (1 - a),
    fg[1] * a + bg[1] * (1 - a),
    fg[2] * a + bg[2] * (1 - a),
    1,
  ];
}

export function contrastRatio(fgRaw: string, bgRaw: string, backdropRaw?: string): number {
  const fg = parseColorRgba(fgRaw);
  const rawBg = parseColorRgba(bgRaw);
  const bg = rawBg[3] < 1 && backdropRaw ? compositeOver(rawBg, parseColorRgba(backdropRaw)) : rawBg;
  const compFg = fg[3] < 1 ? compositeOver(fg, bg) : fg;
  const l1 = relativeLuminance(compFg);
  const l2 = relativeLuminance(bg);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

function lerpNum(a: number, b: number, t: number): number {
  return a + (b - a) * clamp01(t);
}

function fmtNum(x: number, digits = 3): string {
  return String(Number(x.toFixed(digits)));
}

/* ═══════════════════════════════════════════════════
 * 24 小時連續場景關鍵幀（環狀 0..1440 分鐘無縫插值）
 * ═══════════════════════════════════════════════════ */

interface SceneStop {
  at: number;
  sky1: string;       // 天頂（同時承載透明頁首文字，白晝需清透高明度、入夜深邃群青）
  sky2: string;       // 中上天色（暮色：青檸過渡琥珀蛋黃）
  sky3: string;       // 中下天色（暮色：珊瑚橙紅）
  sky4: string;       // 地平線（暮色：晚霞紫紅）
  glowColor: string;  // 地平線霞光／朝陽／月暈主色
  glowAlpha: number;
  water1: string;     // 遠岸水面（映照地平線霞色）
  water2: string;     // 中景湖面（映照中層天色）
  water3: string;     // 近岸深水（映照天頂與岸影）
  shimmer: string;    // 水波碎光色（朝霧金粉／白晝銀青／暮色碎金／星夜銀白月路）
  shimmerAlpha: number;
  moonRoad: number;   // 湖面銀白月光水路強度（0..1）
  hillFar: string;    // 遠景鎌倉海灣山巒
  hillMid: string;    // 中遠景層山
  hillNear: string;   // 近岸林木山腳
  bankDark: string;   // 近景湖岸木柵剪影主色
  bankRim: string;    // 木柵上緣受光反光色
  causeway: string;   // 湖上軌道石堤色
  cloudMain: string;  // 遠方層雲本體
  cloudHi: string;    // 層雲受光邊緣
  cloudAlpha: number;
  mistColor: string;  // 湖面朝霧／山嵐雲霧色
  mistAlpha: number;  // 基礎薄霧濃度
  starAlpha: number;  // 星辰不透明度
  moonAlpha: number;  // 明月不透明度
  moonY: number;      // 明月高度百分比（越小越高）
  townAlpha: number;  // 18:00 後遠岸山城萬家燈火強度
  trainBody: string;  // 江之電風復古綠車身（入夜轉深剪影）
  trainCream: string; // 奶油白窗帶（入夜轉微暗剪影）
  trainTrim: string;  // 車身細金帶
  trainWin: string;   // 車廂窗色（白天映天光、暮色入夜透暖金燈光）
  trainHalo: number;  // 車窗暖暈（0..1，同時驅動水鏡倒影燈窗亮度）
  headlight: number;  // 車頭暖光束（0..1）
}

const SCENE_STOPS: readonly SceneStop[] = [
  // 01:00 靜夜深海・銀白月路
  {
    at: 60,
    sky1: "#0b142c",
    sky2: "#122142",
    sky3: "#1a3058",
    sky4: "#25416e",
    glowColor: "#5376a8",
    glowAlpha: 0.24,
    water1: "#213a63",
    water2: "#152645",
    water3: "#0c172d",
    shimmer: "#d6e6fb",
    shimmerAlpha: 0.48,
    moonRoad: 0.84,
    hillFar: "#162646",
    hillMid: "#101d37",
    hillNear: "#0b1427",
    bankDark: "#070e1c",
    bankRim: "#223454",
    causeway: "#121f38",
    cloudMain: "#293f66",
    cloudHi: "#486491",
    cloudAlpha: 0.14,
    mistColor: "#39527a",
    mistAlpha: 0.10,
    starAlpha: 0.94,
    moonAlpha: 0.96,
    moonY: 16,
    townAlpha: 0.86,
    trainBody: "#132033",
    trainCream: "#24344c",
    trainTrim: "#75684c",
    trainWin: "#ffe39c",
    trainHalo: 0.88,
    headlight: 0.90,
  },
  // 04:45 曉前群青
  {
    at: 285,
    sky1: "#131f3f",
    sky2: "#213158",
    sky3: "#36466e",
    sky4: "#555a7e",
    glowColor: "#8c7a98",
    glowAlpha: 0.30,
    water1: "#475074",
    water2: "#283658",
    water3: "#15203b",
    shimmer: "#d8def0",
    shimmerAlpha: 0.38,
    moonRoad: 0.46,
    hillFar: "#263354",
    hillMid: "#1b2642",
    hillNear: "#121a30",
    bankDark: "#0c1222",
    bankRim: "#29344e",
    causeway: "#1a253f",
    cloudMain: "#4d587c",
    cloudHi: "#7a7e9e",
    cloudAlpha: 0.20,
    mistColor: "#6d7596",
    mistAlpha: 0.24,
    starAlpha: 0.56,
    moonAlpha: 0.52,
    moonY: 25,
    townAlpha: 0.62,
    trainBody: "#19283b",
    trainCream: "#354459",
    trainTrim: "#877655",
    trainWin: "#ffe094",
    trainHalo: 0.76,
    headlight: 0.78,
  },
  // 05:25 朝霧初染（淡霧青紫緩緩透出柔金朝霞，湖面薄霧與金粉水波）
  {
    at: 325,
    sky1: "#adb5da",
    sky2: "#c6c1e0",
    sky3: "#e4cad6",
    sky4: "#f7d7b5",
    glowColor: "#ffe5bd",
    glowAlpha: 0.64,
    water1: "#eecab8",
    water2: "#b8b4d2",
    water3: "#8289b0",
    shimmer: "#ffebb8",
    shimmerAlpha: 0.62,
    moonRoad: 0.06,
    hillFar: "#8a8db0",
    hillMid: "#6f7498",
    hillNear: "#53597b",
    bankDark: "#323752",
    bankRim: "#6c6f8c",
    causeway: "#484e6c",
    cloudMain: "#f5dfe4",
    cloudHi: "#fff3e6",
    cloudAlpha: 0.46,
    mistColor: "#f3e6ec",
    mistAlpha: 0.58,
    starAlpha: 0.08,
    moonAlpha: 0.08,
    moonY: 30,
    townAlpha: 0.16,
    trainBody: "#33584b",
    trainCream: "#efe6d5",
    trainTrim: "#bfa06a",
    trainWin: "#fff1c7",
    trainHalo: 0.38,
    headlight: 0.36,
  },
  // 06:35 朝霞金粉・晨光初晴
  {
    at: 395,
    sky1: "#9fc4e6",
    sky2: "#bdd8ee",
    sky3: "#dde9f2",
    sky4: "#fae6c6",
    glowColor: "#fff2cf",
    glowAlpha: 0.56,
    water1: "#efe2c9",
    water2: "#a8cbe4",
    water3: "#75a2c6",
    shimmer: "#fff5d4",
    shimmerAlpha: 0.64,
    moonRoad: 0,
    hillFar: "#7c9ab6",
    hillMid: "#60809e",
    hillNear: "#466582",
    bankDark: "#2b3e50",
    bankRim: "#5f7688",
    causeway: "#465e73",
    cloudMain: "#f7f6f2",
    cloudHi: "#ffffff",
    cloudAlpha: 0.56,
    mistColor: "#eef4f8",
    mistAlpha: 0.34,
    starAlpha: 0,
    moonAlpha: 0,
    moonY: 34,
    townAlpha: 0,
    trainBody: "#2d614d",
    trainCream: "#f4ecda",
    trainTrim: "#c4a468",
    trainWin: "#eef7fb",
    trainHalo: 0.12,
    headlight: 0.10,
  },
  // 09:00 晴空朝凪（通透清澈的鎌倉海空蔚藍）
  {
    at: 540,
    sky1: "#8ec6ec",
    sky2: "#b4ddf6",
    sky3: "#d7effb",
    sky4: "#eff9fe",
    glowColor: "#ffffff",
    glowAlpha: 0.42,
    water1: "#c7ebfa",
    water2: "#7ec0e4",
    water3: "#4d96c0",
    shimmer: "#f7fdff",
    shimmerAlpha: 0.58,
    moonRoad: 0,
    hillFar: "#75a2c2",
    hillMid: "#5686a8",
    hillNear: "#3c6988",
    bankDark: "#253b48",
    bankRim: "#567280",
    causeway: "#3f5d70",
    cloudMain: "#f5fbff",
    cloudHi: "#ffffff",
    cloudAlpha: 0.70,
    mistColor: "#e8f6fc",
    mistAlpha: 0.08,
    starAlpha: 0,
    moonAlpha: 0,
    moonY: 38,
    townAlpha: 0,
    trainBody: "#295e49",
    trainCream: "#f6efe0",
    trainTrim: "#c8a768",
    trainWin: "#dff2fa",
    trainHalo: 0,
    headlight: 0,
  },
  // 13:00 白晝碧水（高透明度夏空與碧藍水鏡）
  {
    at: 780,
    sky1: "#86c0ea",
    sky2: "#aedaf5",
    sky3: "#d4eefb",
    sky4: "#eef9fd",
    glowColor: "#ffffff",
    glowAlpha: 0.46,
    water1: "#bfe8f9",
    water2: "#74b9e0",
    water3: "#438db8",
    shimmer: "#ffffff",
    shimmerAlpha: 0.64,
    moonRoad: 0,
    hillFar: "#6f9ec0",
    hillMid: "#5080a2",
    hillNear: "#376382",
    bankDark: "#233845",
    bankRim: "#536f7d",
    causeway: "#3b596c",
    cloudMain: "#f4faff",
    cloudHi: "#ffffff",
    cloudAlpha: 0.74,
    mistColor: "#e6f5fc",
    mistAlpha: 0.05,
    starAlpha: 0,
    moonAlpha: 0,
    moonY: 40,
    townAlpha: 0,
    trainBody: "#275b46",
    trainCream: "#f7f0e2",
    trainTrim: "#caa96a",
    trainWin: "#dcf1fa",
    trainHalo: 0,
    headlight: 0,
  },
  // 16:00 午後斜陽（空氣漸染暖香檳光）
  {
    at: 960,
    sky1: "#95c4df",
    sky2: "#bdd8df",
    sky3: "#e4e5cf",
    sky4: "#f9e2b8",
    glowColor: "#ffebb8",
    glowAlpha: 0.56,
    water1: "#ece0c2",
    water2: "#99bed2",
    water3: "#5e8fb0",
    shimmer: "#fff2c6",
    shimmerAlpha: 0.66,
    moonRoad: 0,
    hillFar: "#7894aa",
    hillMid: "#5b7890",
    hillNear: "#405c73",
    bankDark: "#293a47",
    bankRim: "#5b6d78",
    causeway: "#445868",
    cloudMain: "#fbf2e3",
    cloudHi: "#fffaf0",
    cloudAlpha: 0.64,
    mistColor: "#f7eedc",
    mistAlpha: 0.12,
    starAlpha: 0,
    moonAlpha: 0,
    moonY: 36,
    townAlpha: 0,
    trainBody: "#2c5947",
    trainCream: "#f3e8d2",
    trainTrim: "#cba768",
    trainWin: "#fff2cf",
    trainHalo: 0.18,
    headlight: 0.18,
  },
  // 17:35 黃昏魔幻暮色・核心高光時刻！
  // 天頂青檸淡藍 (#9ac8cc) → 中層琥珀蛋黃 (#efC874) → 珊瑚橙紅 (#f08c62) → 地平線晚霞紫紅 (#c46482)
  {
    at: 1055,
    sky1: "#9ac8cc",
    sky2: "#efc874",
    sky3: "#f08c62",
    sky4: "#c46482",
    glowColor: "#ffbe70",
    glowAlpha: 0.80,
    water1: "#d66e82",
    water2: "#e8a166",
    water3: "#5c557d",
    shimmer: "#ffe494",
    shimmerAlpha: 0.86,
    moonRoad: 0.08,
    hillFar: "#7c5d7e",
    hillMid: "#5b456b",
    hillNear: "#3d3054",
    bankDark: "#241e36",
    bankRim: "#594562",
    causeway: "#392f4f",
    cloudMain: "#f5a684",
    cloudHi: "#ffe09e",
    cloudAlpha: 0.60,
    mistColor: "#e89e8c",
    mistAlpha: 0.20,
    starAlpha: 0.06,
    moonAlpha: 0.14,
    moonY: 28,
    townAlpha: 0.42,
    trainBody: "#1f2e36",
    trainCream: "#cbbba8",
    trainTrim: "#cfa668",
    trainWin: "#ffe18e",
    trainHalo: 0.80,
    headlight: 0.82,
  },
  // 18:20 晚霞餘暉（珊瑚紫霞漸深，維持頂部清透讓晚間切換平滑自然）
  {
    at: 1100,
    sky1: "#9bb3d4",
    sky2: "#cfa4ba",
    sky3: "#df8378",
    sky4: "#a85678",
    glowColor: "#f08a6c",
    glowAlpha: 0.58,
    water1: "#b8637c",
    water2: "#9c6d88",
    water3: "#484770",
    shimmer: "#ffd998",
    shimmerAlpha: 0.64,
    moonRoad: 0.26,
    hillFar: "#635076",
    hillMid: "#473b62",
    hillNear: "#2e284b",
    bankDark: "#1c1930",
    bankRim: "#483e5c",
    causeway: "#2d2848",
    cloudMain: "#c98598",
    cloudHi: "#f5b498",
    cloudAlpha: 0.42,
    mistColor: "#b8849a",
    mistAlpha: 0.18,
    starAlpha: 0.28,
    moonAlpha: 0.42,
    moonY: 23,
    townAlpha: 0.76,
    trainBody: "#182334",
    trainCream: "#6e6c7e",
    trainTrim: "#9e865c",
    trainWin: "#ffe294",
    trainHalo: 0.86,
    headlight: 0.88,
  },
  // 18:50 星月夜行初臨（深邃群青藍紫夜空、星辰與明月升起）
  {
    at: 1130,
    sky1: "#111d3d",
    sky2: "#1c2e56",
    sky3: "#2b416c",
    sky4: "#3e537e",
    glowColor: "#63729e",
    glowAlpha: 0.32,
    water1: "#334974",
    water2: "#1d3054",
    water3: "#101c35",
    shimmer: "#d2e2f9",
    shimmerAlpha: 0.52,
    moonRoad: 0.72,
    hillFar: "#1e2f52",
    hillMid: "#152340",
    hillNear: "#0d172c",
    bankDark: "#091020",
    bankRim: "#263756",
    causeway: "#162440",
    cloudMain: "#354b74",
    cloudHi: "#566f9c",
    cloudAlpha: 0.18,
    mistColor: "#465d86",
    mistAlpha: 0.12,
    starAlpha: 0.86,
    moonAlpha: 0.88,
    moonY: 19,
    townAlpha: 0.90,
    trainBody: "#132033",
    trainCream: "#273750",
    trainTrim: "#7c6d4f",
    trainWin: "#ffe39a",
    trainHalo: 0.92,
    headlight: 0.92,
  },
];

function interpolateSceneAt(minuteOfDay: number): SceneStop {
  const m = normalizeMinuteOfDay(minuteOfDay);
  const n = SCENE_STOPS.length;
  let idxA = n - 1;
  let idxB = 0;
  let span = 1440 - SCENE_STOPS[n - 1].at + SCENE_STOPS[0].at;
  let offset = m >= SCENE_STOPS[n - 1].at ? m - SCENE_STOPS[n - 1].at : m + (1440 - SCENE_STOPS[n - 1].at);

  for (let i = 0; i < n - 1; i++) {
    const a = SCENE_STOPS[i];
    const b = SCENE_STOPS[i + 1];
    if (m >= a.at && m < b.at) {
      idxA = i;
      idxB = i + 1;
      span = b.at - a.at;
      offset = m - a.at;
      break;
    }
  }

  const sA = SCENE_STOPS[idxA];
  const sB = SCENE_STOPS[idxB];
  const t = smoothstep(span > 0 ? offset / span : 0);

  return {
    at: m,
    sky1: lerpHex(sA.sky1, sB.sky1, t),
    sky2: lerpHex(sA.sky2, sB.sky2, t),
    sky3: lerpHex(sA.sky3, sB.sky3, t),
    sky4: lerpHex(sA.sky4, sB.sky4, t),
    glowColor: lerpHex(sA.glowColor, sB.glowColor, t),
    glowAlpha: lerpNum(sA.glowAlpha, sB.glowAlpha, t),
    water1: lerpHex(sA.water1, sB.water1, t),
    water2: lerpHex(sA.water2, sB.water2, t),
    water3: lerpHex(sA.water3, sB.water3, t),
    shimmer: lerpHex(sA.shimmer, sB.shimmer, t),
    shimmerAlpha: lerpNum(sA.shimmerAlpha, sB.shimmerAlpha, t),
    moonRoad: lerpNum(sA.moonRoad, sB.moonRoad, t),
    hillFar: lerpHex(sA.hillFar, sB.hillFar, t),
    hillMid: lerpHex(sA.hillMid, sB.hillMid, t),
    hillNear: lerpHex(sA.hillNear, sB.hillNear, t),
    bankDark: lerpHex(sA.bankDark, sB.bankDark, t),
    bankRim: lerpHex(sA.bankRim, sB.bankRim, t),
    causeway: lerpHex(sA.causeway, sB.causeway, t),
    cloudMain: lerpHex(sA.cloudMain, sB.cloudMain, t),
    cloudHi: lerpHex(sA.cloudHi, sB.cloudHi, t),
    cloudAlpha: lerpNum(sA.cloudAlpha, sB.cloudAlpha, t),
    mistColor: lerpHex(sA.mistColor, sB.mistColor, t),
    mistAlpha: lerpNum(sA.mistAlpha, sB.mistAlpha, t),
    starAlpha: lerpNum(sA.starAlpha, sB.starAlpha, t),
    moonAlpha: lerpNum(sA.moonAlpha, sB.moonAlpha, t),
    moonY: lerpNum(sA.moonY, sB.moonY, t),
    townAlpha: lerpNum(sA.townAlpha, sB.townAlpha, t),
    trainBody: lerpHex(sA.trainBody, sB.trainBody, t),
    trainCream: lerpHex(sA.trainCream, sB.trainCream, t),
    trainTrim: lerpHex(sA.trainTrim, sB.trainTrim, t),
    trainWin: lerpHex(sA.trainWin, sB.trainWin, t),
    trainHalo: lerpNum(sA.trainHalo, sB.trainHalo, t),
    headlight: lerpNum(sA.headlight, sB.headlight, t),
  };
}

/* ═══════════════════════════════════════════════════
 * 手帳紙卡與墨色雙極性平滑協調（確保任意時刻 100% AA 高對比易讀）
 * ═══════════════════════════════════════════════════ */

interface UiPaletteStop {
  at: number;
  paper: string;
  paperHighRgb: string;
  paperHighAlpha: number;
  paperUsedRgb: string;
  paperUsedAlpha: number;
  ink: string;
  inkSoft: string;
  inkFaint: string;
  inkMid: string;
  book: string;
  bookInk: string;
  gold: string;
  goldSoft: string;
  goldInk: string;
  seal: string;
  late: string;
  onSeal: string;
  onInk: string;
  stampInk: string;
  arc: string;
  accent: string;
  accentSky: string;
}

/** 白晝系（05:10–18:30：朝霧珍珠白 → 鎌倉海風象牙白 → 暮色暖杏玻璃紙） */
const LIGHT_UI_STOPS: readonly UiPaletteStop[] = [
  // 05:15 朝霧珍珠紙
  {
    at: 315,
    paper: "#e6e3f0",
    paperHighRgb: "#fbf8fc",
    paperHighAlpha: 0.84,
    paperUsedRgb: "#f2edf6",
    paperUsedAlpha: 0.72,
    ink: "#21253a",
    inkSoft: "#414663",
    inkFaint: "#555a78",
    inkMid: "#4b506e",
    book: "#25314a",
    bookInk: "#ebeef7",
    gold: "#d9bf8e",
    goldSoft: "#e7d3aa",
    goldInk: "#6b501e",
    seal: "#ad3d2b",
    late: "#944d2d",
    onSeal: "#fbf8fc",
    onInk: "#fbf8fc",
    stampInk: "#414663",
    arc: "#9e7736",
    accent: "#424d8c",
    accentSky: "#3a447d",
  },
  // 12:00 鎌倉晴空海風紙（江之電松葉海青書封）
  {
    at: 720,
    paper: "#d9ecf7",
    paperHighRgb: "#f9fcff",
    paperHighAlpha: 0.82,
    paperUsedRgb: "#edf5fa",
    paperUsedAlpha: 0.70,
    ink: "#1b2a3b",
    inkSoft: "#384c61",
    inkFaint: "#4c6178",
    inkMid: "#42576d",
    book: "#1f383e",
    bookInk: "#eaf2f1",
    gold: "#d5b982",
    goldSoft: "#e5cf9f",
    goldInk: "#684e1c",
    seal: "#ad3e2d",
    late: "#944d2c",
    onSeal: "#f9fcff",
    onInk: "#f9fcff",
    stampInk: "#354b5e",
    arc: "#9b7634",
    accent: "#23587a",
    accentSky: "#214f6e",
  },
  // 17:35 黃昏暮色暖霞象牙紙
  {
    at: 1055,
    paper: "#f0dfd8",
    paperHighRgb: "#fdf7f2",
    paperHighAlpha: 0.86,
    paperUsedRgb: "#f5eae2",
    paperUsedAlpha: 0.74,
    ink: "#282238",
    inkSoft: "#49405c",
    inkFaint: "#5d5372",
    inkMid: "#534967",
    book: "#2c2642",
    bookInk: "#f2ece8",
    gold: "#dfbc84",
    goldSoft: "#ecd1a3",
    goldInk: "#6e4f1c",
    seal: "#b03d2e",
    late: "#964b2b",
    onSeal: "#fdf7f2",
    onInk: "#fdf7f2",
    stampInk: "#483f5b",
    arc: "#a17835",
    accent: "#594382",
    accentSky: "#4d3973",
  },
];

/** 星夜系（18:30–05:10：逢魔群青石板 → 靜夜深海月光票紙） */
const DARK_UI_STOPS: readonly UiPaletteStop[] = [
  // 19:00 初夜群青月光紙
  {
    at: 1140,
    paper: "#162238",
    paperHighRgb: "#202f4a",
    paperHighAlpha: 0.92,
    paperUsedRgb: "#1a273e",
    paperUsedAlpha: 0.90,
    ink: "#e8eef8",
    inkSoft: "#b3c1d8",
    inkFaint: "#94a4be",
    inkMid: "#a2b2cb",
    book: "#0e1626",
    bookInk: "#dde4f0",
    gold: "#d4ba82",
    goldSoft: "#e3cea0",
    goldInk: "#d4ba82",
    seal: "#dc6b51",
    late: "#d49a6e",
    onSeal: "#0e1626",
    onInk: "#0e1626",
    stampInk: "#a5b5ce",
    arc: "#d4ba82",
    accent: "#d4ba82",
    accentSky: "#b3c1d8",
  },
  // 01:30 深夜靜海月光紙
  {
    at: 90,
    paper: "#121d31",
    paperHighRgb: "#1b2840",
    paperHighAlpha: 0.93,
    paperUsedRgb: "#162136",
    paperUsedAlpha: 0.91,
    ink: "#e6edf7",
    inkSoft: "#afc0d7",
    inkFaint: "#91a2bc",
    inkMid: "#9fb0c9",
    book: "#0b1220",
    bookInk: "#dae2ee",
    gold: "#cfb57e",
    goldSoft: "#dfd0a2",
    goldInk: "#cfb57e",
    seal: "#da694f",
    late: "#d2986c",
    onSeal: "#0b1220",
    onInk: "#0b1220",
    stampInk: "#a2b2cb",
    arc: "#cfb57e",
    accent: "#cfb57e",
    accentSky: "#afc0d7",
  },
];

function lerpUiStop(a: UiPaletteStop, b: UiPaletteStop, t: number): UiPaletteStop {
  const s = smoothstep(t);
  return {
    at: lerpNum(a.at, b.at, s),
    paper: lerpHex(a.paper, b.paper, s),
    paperHighRgb: lerpHex(a.paperHighRgb, b.paperHighRgb, s),
    paperHighAlpha: lerpNum(a.paperHighAlpha, b.paperHighAlpha, s),
    paperUsedRgb: lerpHex(a.paperUsedRgb, b.paperUsedRgb, s),
    paperUsedAlpha: lerpNum(a.paperUsedAlpha, b.paperUsedAlpha, s),
    ink: lerpHex(a.ink, b.ink, s),
    inkSoft: lerpHex(a.inkSoft, b.inkSoft, s),
    inkFaint: lerpHex(a.inkFaint, b.inkFaint, s),
    inkMid: lerpHex(a.inkMid, b.inkMid, s),
    book: lerpHex(a.book, b.book, s),
    bookInk: lerpHex(a.bookInk, b.bookInk, s),
    gold: lerpHex(a.gold, b.gold, s),
    goldSoft: lerpHex(a.goldSoft, b.goldSoft, s),
    goldInk: lerpHex(a.goldInk, b.goldInk, s),
    seal: lerpHex(a.seal, b.seal, s),
    late: lerpHex(a.late, b.late, s),
    onSeal: lerpHex(a.onSeal, b.onSeal, s),
    onInk: lerpHex(a.onInk, b.onInk, s),
    stampInk: lerpHex(a.stampInk, b.stampInk, s),
    arc: lerpHex(a.arc, b.arc, s),
    accent: lerpHex(a.accent, b.accent, s),
    accentSky: lerpHex(a.accentSky, b.accentSky, s),
  };
}

function interpolateLightUi(m: number): UiPaletteStop {
  if (m <= LIGHT_UI_STOPS[0].at) return LIGHT_UI_STOPS[0];
  const last = LIGHT_UI_STOPS[LIGHT_UI_STOPS.length - 1];
  if (m >= last.at) return last;
  for (let i = 0; i < LIGHT_UI_STOPS.length - 1; i++) {
    const a = LIGHT_UI_STOPS[i];
    const b = LIGHT_UI_STOPS[i + 1];
    if (m >= a.at && m < b.at) {
      return lerpUiStop(a, b, (m - a.at) / (b.at - a.at));
    }
  }
  return LIGHT_UI_STOPS[1];
}

function interpolateDarkUi(m: number): UiPaletteStop {
  // 18:30 (1110) .. 24:00 .. 05:10 (310)
  const a = DARK_UI_STOPS[0]; // 1140
  const b = DARK_UI_STOPS[1]; // 90 (+1440 = 1530)
  const unwrapped = m < 310 ? m + 1440 : m;
  if (unwrapped <= a.at) return a;
  if (unwrapped <= 1530) {
    return lerpUiStop(a, b, (unwrapped - a.at) / (1530 - a.at));
  }
  // 01:30 (1530) -> 05:10 (1750) 平滑回初夜群青色溫
  return lerpUiStop(b, a, (unwrapped - 1530) / (1750 - 1530));
}

export interface KamakuraPalette {
  minuteOfDay: number;
  phase: KamakuraPhase;
  phaseLabel: string;
  isDark: boolean;
  rainAmount: number;
  weatherLabel: string;
  tokens: Record<string, string>;
  sceneVars: Record<string, string>;
}

export interface KamakuraPaletteOptions {
  /** 手機端停用多卡毛玻璃，並略提亮色紙卡不透明度以維持省電與溫潤度 */
  mobile?: boolean;
}

/**
 * 核心純函式：輸入一天分鐘數（0..1439）與降雨山嵐強度（0..1），
 * 產出完整的水鏡鎌倉主題 Tokens 與四層景深 CSS 變數。
 */
export function kamakuraPaletteAt(
  minuteOfDay: number,
  rainAmount = 0,
  options?: KamakuraPaletteOptions,
): KamakuraPalette {
  const m = normalizeMinuteOfDay(minuteOfDay);
  const rain = clamp01(rainAmount);
  const mobile = Boolean(options?.mobile);
  const phase = kamakuraPhaseAt(m);
  // 05:10（310）至 18:30（1110）採通透霧面亮紙，18:30 至 05:10 採群青月光暗紙，與天頂明度精準對齊
  const isDark = m < 310 || m >= 1110;

  const rawScene = interpolateSceneAt(m);

  // 微雨山嵐目標氛圍色（隨晝夜自動調整煙雨青灰或夜雨蒼藍）
  const rainSkyTop = isDark ? "#152133" : "#9db1bc";
  const rainSkyMid = isDark ? "#1e2e42" : "#b5c6ce";
  const rainSkyBot = isDark ? "#283a50" : "#cdd9de";
  const rainWaterTop = isDark ? "#24354a" : "#b2c4cc";
  const rainWaterMid = isDark ? "#1a293b" : "#8da4b0";
  const rainWaterBot = isDark ? "#111c2b" : "#647f8e";
  const rainHill = isDark ? "#1a2738" : "#6f8591";

  const sky1 = applyRainMood(rawScene.sky1, rainSkyTop, rain, 0.52);
  const sky2 = applyRainMood(rawScene.sky2, rainSkyMid, rain, 0.50);
  const sky3 = applyRainMood(rawScene.sky3, rainSkyMid, rain, 0.48);
  const sky4 = applyRainMood(rawScene.sky4, rainSkyBot, rain, 0.48);
  const water1 = applyRainMood(rawScene.water1, rainWaterTop, rain, 0.50);
  const water2 = applyRainMood(rawScene.water2, rainWaterMid, rain, 0.52);
  const water3 = applyRainMood(rawScene.water3, rainWaterBot, rain, 0.55);
  const hillFar = applyRainMood(rawScene.hillFar, rainHill, rain, 0.55);
  const hillMid = applyRainMood(rawScene.hillMid, rainHill, rain * 0.85, 0.58);
  const hillNear = applyRainMood(rawScene.hillNear, rainHill, rain * 0.65, 0.62);

  // 微雨時山嵐雲霧明顯浮現、星月隱入薄雲、波光轉為柔和雨滴漣漪
  const mistAlpha = clamp01(rawScene.mistAlpha + rain * (isDark ? 0.46 : 0.62));
  const starAlpha = clamp01(rawScene.starAlpha * (1 - rain * 0.85));
  const moonAlpha = clamp01(rawScene.moonAlpha * (1 - rain * 0.68));
  const moonRoad = clamp01(rawScene.moonRoad * (1 - rain * 0.62));
  const glowAlpha = clamp01(rawScene.glowAlpha * (1 - rain * 0.55));
  const shimmerAlpha = clamp01(rawScene.shimmerAlpha * (1 - rain * 0.42));
  const cloudAlpha = clamp01(lerpNum(rawScene.cloudAlpha, isDark ? 0.34 : 0.82, rain * 0.7));
  const trainHalo = clamp01(rawScene.trainHalo + rain * (isDark ? 0.06 : 0.22));

  const ui = isDark ? interpolateDarkUi(m) : interpolateLightUi(m);
  const paper = applyRainMood(ui.paper, isDark ? "#182334" : "#dfe7ec", rain * 0.6, 0.65);
  const [phr, phg, phb] = parseColorRgba(ui.paperHighRgb);
  const [pur, pug, pub] = parseColorRgba(ui.paperUsedRgb);
  const mobileAlphaBoost = !isDark && mobile ? 0.08 : 0;
  const paperHigh = formatRgba([phr, phg, phb], clamp01(ui.paperHighAlpha + rain * 0.03 + mobileAlphaBoost));
  const paperUsed = formatRgba([pur, pug, pub], clamp01(ui.paperUsedAlpha + rain * 0.03 + mobileAlphaBoost));

  const [ikr, ikg, ikb] = parseColorRgba(ui.ink);
  const [bkr, bkg, bkb] = parseColorRgba(ui.bookInk);
  const starlight = isDark ? "224, 235, 250" : "255, 255, 255";

  // 晨昏交界頂欄柔霧襯底：當黎明／黃昏交界幾分鐘內天頂處於中間明度時，為透明頁首與工具列輕墊一層柔霧確保 >= 5.5:1 對比，平時為全透明 0
  const skyTopLum = relativeLuminance(parseColorRgba(sky1));
  const headVeil = isDark
    ? formatRgba([10, 17, 34], skyTopLum > 0.08 ? clamp01((skyTopLum - 0.08) * 3.2) * 0.78 : 0)
    : formatRgba([253, 249, 246], skyTopLum < 0.46 ? clamp01((0.46 - skyTopLum) * 3.2) * 0.68 : 0);

  const tokens: Record<string, string> = {
    "--color-paper": paper,
    "--color-paper-high": paperHigh,
    "--color-paper-used": paperUsed,
    "--color-ink": ui.ink,
    "--color-ink-soft": ui.inkSoft,
    "--color-ink-faint": ui.inkFaint,
    "--ink-mid": ui.inkMid,
    "--color-book": ui.book,
    "--color-book-ink": ui.bookInk,
    "--cover-muted": formatRgba([bkr, bkg, bkb], isDark ? 0.60 : 0.66),
    "--cover-hover": formatRgba([bkr, bkg, bkb], isDark ? 0.05 : 0.07),
    "--color-gold": ui.gold,
    "--color-gold-soft": ui.goldSoft,
    "--color-gold-ink": ui.goldInk,
    "--color-seal": ui.seal,
    "--color-late": ui.late,
    "--color-on-seal": ui.onSeal,
    "--color-on-ink": ui.onInk,
    "--stamp-ink": ui.stampInk,
    "--arc": ui.arc,
    "--accent": ui.accent,
    "--accent-sky": ui.accentSky,
    "--color-line": formatRgba([ikr, ikg, ikb], isDark ? 0.15 : 0.16),
    "--color-dash": formatRgba([ikr, ikg, ikb], isDark ? 0.25 : 0.26),
    "--grid-dot": formatRgba([ikr, ikg, ikb], isDark ? 0.05 : 0.06),
    "--float-bg": paperHigh,
    // 夜間月光票紙（不透明度 0.92+）與手機殼一律停用毛玻璃，避免多卡背景動畫引發每幀 GPU readback
    "--float-blur": isDark || mobile ? "none" : "blur(14px) saturate(1.14)",
    "--glass-edge": isDark ? formatRgba([224, 235, 250], 0.15) : "rgba(255, 255, 255, 0.80)",
    "--glass-hi": isDark ? "inset 0 1px 0 rgba(224, 235, 250, 0.09)" : "inset 0 1px 0 rgba(255, 255, 255, 0.55)",
    "--shadow-card": isDark
      ? "0 1px 2px rgba(4, 9, 20, 0.42), 0 8px 22px rgba(4, 9, 20, 0.38)"
      : "0 0 0 1px rgba(32, 54, 78, 0.08), 0 2px 4px rgba(28, 48, 72, 0.07), 0 10px 24px rgba(28, 48, 72, 0.10)",
    "--shadow-card-hover": isDark
      ? "0 2px 5px rgba(4, 9, 20, 0.48), 0 12px 28px rgba(4, 9, 20, 0.44)"
      : "0 0 0 1px rgba(32, 54, 78, 0.12), 0 3px 6px rgba(28, 48, 72, 0.09), 0 14px 30px rgba(28, 48, 72, 0.14)",
    "--on-roundel": isDark ? "#0d1422" : "#182433",
    "--sky-top": sky1,
    "--sky-mid": sky2,
    "--sky-low": sky3,
    "--sky-horizon": sky4,
    "--sky-bot": sky4,
    "--starlight": starlight,
    "--route-preset-1": isDark ? "#9cc0eb" : "#2e628f",
    "--route-preset-2": isDark ? "#e6a493" : "#9c475c",
    "--route-preset-3": isDark ? "#98ccb0" : "#2c6b54",
    "--route-preset-4": isDark ? "#a4b0c4" : "#566578",
    "--route-e1-l": isDark ? "#9cc0eb" : "#b3d2ee",
    "--route-j-l": isDark ? "#e6a493" : "#f0bcc7",
    "--route-l2-l": isDark ? "#98ccb0" : "#b2dbc8",
    "--route-none-l": isDark ? "#a4b0c4" : "#cad2dc",
    "--skin-tt-solid": ui.paperHighRgb,
  };

  const sceneVars: Record<string, string> = {
    "--km-sky-1": sky1,
    "--km-sky-2": sky2,
    "--km-sky-3": sky3,
    "--km-sky-4": sky4,
    "--km-head-veil": headVeil,
    "--km-glow-color": rawScene.glowColor,
    "--km-glow-alpha": fmtNum(glowAlpha),
    "--km-water-1": water1,
    "--km-water-2": water2,
    "--km-water-3": water3,
    "--km-shimmer": rawScene.shimmer,
    "--km-shimmer-alpha": fmtNum(shimmerAlpha),
    "--km-moon-road": fmtNum(moonRoad),
    "--km-hill-far": hillFar,
    "--km-hill-mid": hillMid,
    "--km-hill-near": hillNear,
    "--km-bank-dark": rawScene.bankDark,
    "--km-bank-rim": rawScene.bankRim,
    "--km-causeway": rawScene.causeway,
    "--km-cloud-main": applyRainMood(rawScene.cloudMain, isDark ? "#2c3c52" : "#dce5ea", rain, 0.5),
    "--km-cloud-hi": applyRainMood(rawScene.cloudHi, isDark ? "#435770" : "#edf2f5", rain, 0.5),
    "--km-cloud-alpha": fmtNum(cloudAlpha),
    "--km-mist-color": applyRainMood(rawScene.mistColor, isDark ? "#33475e" : "#dce7ed", rain, 0.5),
    "--km-mist-alpha": fmtNum(mistAlpha),
    "--km-rain-alpha": fmtNum(rain),
    "--km-star-alpha": fmtNum(starAlpha),
    "--km-moon-alpha": fmtNum(moonAlpha),
    "--km-moon-y": `${fmtNum(rawScene.moonY, 1)}%`,
    "--km-town-alpha": fmtNum(rawScene.townAlpha * (1 - rain * 0.18)),
    "--km-town-light": "#ffcf82",
    "--km-train-body": rawScene.trainBody,
    "--km-train-cream": rawScene.trainCream,
    "--km-train-trim": rawScene.trainTrim,
    "--km-train-win": rawScene.trainWin,
    "--km-train-halo": fmtNum(trainHalo),
    "--km-train-headlight": fmtNum(clamp01(rawScene.headlight + rain * 0.15)),
    "--km-egret-fill": isDark ? "#cfdcf0" : "#fcfdff",
    "--km-fish-fill": isDark ? "#08101f" : "#1f455c",
  };

  const weatherLabel = rain >= 0.55 ? "微雨山嵐" : rain >= 0.18 ? "薄霧微雲" : "晴朗水鏡";

  return {
    minuteOfDay: m,
    phase,
    phaseLabel: KAMAKURA_PHASE_LABELS[phase],
    isDark,
    rainAmount: rain,
    weatherLabel,
    tokens,
    sceneVars,
  };
}

export function kamakuraCssVarsOf(palette: KamakuraPalette): Record<string, string> {
  return { ...palette.tokens, ...palette.sceneVars };
}

export const ALL_KAMAKURA_CSS_VARS: readonly string[] = Object.freeze(
  Object.keys(kamakuraCssVarsOf(kamakuraPaletteAt(720, 0))),
);

/* ═══════════════════════════════════════════════════
 * 水鏡鎌倉低頻生機與湖上列車排程器（支援睡眠零計時器）
 * ═══════════════════════════════════════════════════ */

export type KamakuraLifeKind = "egret" | "fish" | "walker" | "meteor";

export type KamakuraActorEvent =
  | { kind: "train"; long: boolean; direction: "ltr" | "rtl" }
  | { kind: "life"; life: KamakuraLifeKind };

export interface KamakuraDirectorConfig {
  mode: MoodMode;
  level: "lite" | "mid";
  parts: MoodParts;
  phase: KamakuraPhase;
  rainAmount: number;
  reduced: boolean;
}

const RESUME_MIN_MS = 250;

interface ArmedTimer {
  fn: () => void;
  due: number;
  id: unknown;
  remaining: number | null;
}

export class KamakuraDirector {
  private timers = new Map<string, ArmedTimer>();
  private awake = true;
  private cfg: KamakuraDirectorConfig | null = null;
  private schedKey: string | null = null;
  private trainRunning = false;
  private trainPending: boolean | null = null;
  private welcomed = false;
  private emit: (e: KamakuraActorEvent) => void;
  private clock: MoodClock;

  constructor(emit: (e: KamakuraActorEvent) => void, clock: MoodClock = browserClock) {
    this.emit = emit;
    this.clock = clock;
  }

  configure(cfg: KamakuraDirectorConfig): void {
    const prev = this.cfg;
    this.cfg = cfg;
    const key = [cfg.mode, cfg.level, cfg.parts.train, cfg.parts.birds, cfg.parts.meteor, cfg.reduced].join("|");
    if (key === this.schedKey) return;
    this.schedKey = key;
    this.clearAll();
    this.trainPending = null;
    this.trainRunning = false;

    if (cfg.mode === "off" || cfg.reduced) return;

    const ambient = cfg.mode === "ambient" || cfg.mode === "both";
    if (ambient && cfg.parts.train) {
      if (!this.welcomed && (!prev || prev.mode === "off" || prev.reduced)) {
        this.welcomed = true;
        this.later("welcome-train", 2400, () => {
          this.requestTrain(false);
          this.scheduleNextTrain();
        });
      } else {
        this.scheduleNextTrain();
      }
    }
    if (ambient && (cfg.parts.birds || cfg.parts.meteor)) {
      this.scheduleNextLife();
    }
  }

  setAwake(awake: boolean): void {
    if (awake === this.awake) return;
    this.awake = awake;
    if (awake) {
      for (const [name, t] of [...this.timers]) {
        this.later(name, t.remaining ?? RESUME_MIN_MS, t.fn);
      }
      return;
    }
    const now = this.clock.now();
    for (const t of this.timers.values()) {
      if (t.id !== null) this.clock.clearTimeout(t.id);
      t.id = null;
      t.remaining = Math.max(RESUME_MIN_MS, t.due - now);
    }
  }

  stamped(allDone: boolean): void {
    const cfg = this.cfg;
    if (!cfg || (cfg.mode !== "ritual" && cfg.mode !== "both") || cfg.reduced || !this.awake) return;
    this.requestTrain(allDone);
    if (allDone) {
      this.later("ritual-life", 650, () => this.fireLife(true));
    }
  }

  requestTrain(long: boolean): void {
    const cfg = this.cfg;
    if (!cfg || cfg.mode === "off" || cfg.reduced || !cfg.parts.train) return;
    if (this.trainRunning) {
      this.trainPending = long || this.trainPending === true;
      return;
    }
    this.runTrain(long);
  }

  trainEnded(): void {
    this.trainRunning = false;
    if (this.trainPending !== null) {
      const long = this.trainPending;
      this.trainPending = null;
      this.runTrain(long);
    }
  }

  destroy(): void {
    this.clearAll();
    this.schedKey = null;
    this.cfg = null;
  }

  get armedTimers(): number {
    let count = 0;
    for (const t of this.timers.values()) {
      if (t.id !== null) count += 1;
    }
    return count;
  }

  private runTrain(long: boolean): void {
    const cfg = this.cfg;
    if (!cfg || cfg.mode === "off" || cfg.reduced || !cfg.parts.train) return;
    this.trainRunning = true;
    const direction = this.clock.random() < 0.65 ? "rtl" : "ltr";
    this.emit({ kind: "train", long, direction });
  }

  private fireLife(celebrate = false): void {
    const cfg = this.cfg;
    if (!cfg || cfg.mode === "off" || cfg.reduced) return;

    const pool: KamakuraLifeKind[] = [];
    if (cfg.parts.birds) {
      if (cfg.phase !== "night") pool.push("egret");
      pool.push("fish");
      if (cfg.rainAmount < 0.75 && (cfg.phase === "dusk" || cfg.phase === "day" || cfg.phase === "dawn")) {
        pool.push("walker");
      }
    }
    if (cfg.parts.meteor && cfg.phase === "night" && cfg.rainAmount < 0.45) {
      pool.push("meteor");
    }
    if (pool.length === 0) return;

    if (celebrate && pool.includes("egret")) {
      this.emit({ kind: "life", life: "egret" });
      return;
    }
    if (celebrate && pool.includes("meteor")) {
      this.emit({ kind: "life", life: "meteor" });
      return;
    }

    const pick = pool[Math.floor(this.clock.random() * pool.length)];
    this.emit({ kind: "life", life: pick });
  }

  private span(minMs: number, maxMs: number): number {
    return minMs + this.clock.random() * (maxMs - minMs);
  }

  private scheduleNextTrain(): void {
    const cfg = this.cfg;
    if (!cfg || (cfg.mode !== "ambient" && cfg.mode !== "both") || cfg.reduced || !cfg.parts.train) return;
    const [lo, hi] = cfg.level === "mid" ? [32_000, 58_000] : [50_000, 92_000];
    this.later("train", this.span(lo, hi), () => {
      this.requestTrain(this.clock.random() < 0.25);
      this.scheduleNextTrain();
    });
  }

  private scheduleNextLife(): void {
    const cfg = this.cfg;
    if (!cfg || (cfg.mode !== "ambient" && cfg.mode !== "both") || cfg.reduced) return;
    if (!cfg.parts.birds && !cfg.parts.meteor) return;
    const [lo, hi] = cfg.level === "mid" ? [22_000, 44_000] : [36_000, 68_000];
    this.later("life", this.span(lo, hi), () => {
      this.fireLife(false);
      this.scheduleNextLife();
    });
  }

  private later(name: string, ms: number, fn: () => void): void {
    const prev = this.timers.get(name);
    if (prev && prev.id !== null) this.clock.clearTimeout(prev.id);
    const entry: ArmedTimer = { fn, due: this.clock.now() + ms, id: null, remaining: null };
    if (this.awake) {
      entry.id = this.clock.setTimeout(() => {
        this.timers.delete(name);
        fn();
      }, ms);
    } else {
      entry.remaining = ms;
    }
    this.timers.set(name, entry);
  }

  private clearAll(): void {
    for (const t of this.timers.values()) {
      if (t.id !== null) this.clock.clearTimeout(t.id);
    }
    this.timers.clear();
  }
}
