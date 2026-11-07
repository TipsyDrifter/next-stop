/**
 * ambience — 天空氛圍層對外出口（整合席／今日視圖從這裡取）
 * 一般只需要 SkyLayer；今日頁另外掛 MoodStage（會經過的東西），設定頁掛 MoodSettings。
 */
export { SkyLayer } from "./SkyLayer";
export type { SkyLayerProps } from "./SkyLayer";
export { buildStarfield, mulberry32 } from "./starfield";
export type { SkyDensity, SkyVariant, SkyDot, Starfield, CssVars } from "./starfield";
export { usePrefersReducedMotion, useSkyVariant } from "./useAmbience";
export { MoodStage } from "./MoodStage";
export { MoodSettings } from "./MoodSettings";
