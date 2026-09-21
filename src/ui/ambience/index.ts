/**
 * ambience — 天空氛圍層對外出口（整合席／今日視圖從這裡取）
 * 一般只需要 SkyLayer；Meteor／TrainSilhouette 由 SkyLayer 依 density 自動掛，
 * 單獨匯出是給 M3 ③ 的儀式觸發（蓋済叫一班列車）留的接口。
 */
export { SkyLayer } from "./SkyLayer";
export type { SkyLayerProps } from "./SkyLayer";
export { Meteor } from "./Meteor";
export type { MeteorProps } from "./Meteor";
export { TrainSilhouette } from "./TrainSilhouette";
export type { TrainSilhouetteProps } from "./TrainSilhouette";
export { buildStarfield, mulberry32 } from "./starfield";
export type { SkyDensity, SkyVariant, SkyDot, Starfield, CssVars } from "./starfield";
export { usePageHidden, usePrefersReducedMotion, useSkyVariant } from "./useAmbience";
