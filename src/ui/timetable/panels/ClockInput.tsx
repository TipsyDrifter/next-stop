/**
 * ClockInput——丙-2（契約 §1 第 6 件）起本體搬到 `src/ui/common/ClockInput.tsx`（全 App 一支，加了 variant／quick／relative）。
 * 這裡只轉出，時刻表的呼叫端（controls.tsx Stepper、BlockPanel 的 ClockInputHandle）不動；丙-3～6 改 import 後刪本檔。
 */
export * from "../../common/ClockInput";
