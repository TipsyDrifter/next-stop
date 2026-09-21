/**
 * TrainSilhouette.tsx — 地平線帶＋私鐵三節電車剪影（事件動態，只在今日視圖＝density='full' 啟用）
 *
 * 視覺真相＝m3-mood-c2-pastel.html `.horizon`／`.train` 段（粉彩）
 *           ／m3-mood-c1-galaxy.html `.horizon`／`.train` 段（銀河）；SVG 路徑逐字。
 * 邊界（決策 10＋移植規格 §2）：路線圖／日曆等頁**不出現列車**——由 SkyLayer 依 density 決定掛不掛。
 *
 * 節奏（原型逐字）：
 *   粉彩 載入 5s 先過一班，之後每 75–120s 一班，行駛 20s（translateX -300px → 110vw）
 *   銀河 載入 9s 先過一班，之後每 180–360s 一班，行駛 15s（translateX -200px → 100vw）
 * 地平線帶本身是靜態的（線＋遠處地面），列車不在時仍留著；一班跑完即卸載列車。
 */
import type { CSSProperties } from "react";
import { useFlightScheduler, rand } from "./useAmbience";
import type { CssVars, SkyVariant } from "./starfield";

export interface TrainSilhouetteProps {
  variant: SkyVariant;
  /** false＝不排程（非今日視圖／系統開了減少動態） */
  enabled: boolean;
  /** 分頁隱藏 */
  paused: boolean;
}

export function TrainSilhouette({ variant, enabled, paused }: TrainSilhouetteProps) {
  const pastel = variant === "pastel";

  const { flight, onFlightEnd } = useFlightScheduler({
    enabled,
    paused,
    chainOnEnd: !pastel,
    firstDelay: () => (pastel ? 5000 : 9000),
    nextDelay: () => (pastel ? rand(75000, 120000) : rand(180000, 360000)),
    makeStyle: (): CssVars => {
      // 粉彩行駛 20s（原型以 --dur 帶）；銀河行駛 15s 寫死在 keyframes，不需要參數
      if (pastel) return { "--dur": "20s" };
      return {};
    },
  });

  return (
    <div
      className={`sky-horizon sky-horizon--${variant}${paused ? " is-paused" : ""}`}
      aria-hidden="true"
    >
      {flight &&
        (pastel ? (
          <PastelTrain key={flight.id} style={flight.style} onAnimationEnd={onFlightEnd} />
        ) : (
          <GalaxyTrain key={flight.id} style={flight.style} onAnimationEnd={onFlightEnd} />
        ))}
    </div>
  );
}

interface TrainSvgProps {
  style: CSSProperties;
  onAnimationEnd: () => void;
}

/** 粉彩：三節電車遠景剪影（集電弓／車體／轉向架＋一排暖光車窗）——C2 原型逐字 */
function PastelTrain({ style, onAnimationEnd }: TrainSvgProps) {
  return (
    <svg
      className="sky-train"
      viewBox="0 0 262 26"
      fill="none"
      style={style}
      onAnimationEnd={onAnimationEnd}
      aria-hidden="true"
    >
      <g fill="currentColor">
        {/* 集電弓 */}
        <path d="M22 8 L28 3 L34 8" stroke="currentColor" strokeWidth="1" fill="none" strokeLinecap="round" />
        <path d="M228 8 L234 3 L240 8" stroke="currentColor" strokeWidth="1" fill="none" strokeLinecap="round" />
        {/* 三節車體 */}
        <path d="M4 22 V11 q0-3 3-3 h77 v14 Z" />
        <rect x="89" y="8" width="84" height="14" />
        <path d="M178 8 h77 q3 0 3 3 v11 h-80 Z" />
        {/* 轉向架 */}
        <rect x="12" y="22" width="16" height="3" rx="1" />
        <rect x="60" y="22" width="16" height="3" rx="1" />
        <rect x="97" y="22" width="16" height="3" rx="1" />
        <rect x="149" y="22" width="16" height="3" rx="1" />
        <rect x="186" y="22" width="16" height="3" rx="1" />
        <rect x="234" y="22" width="16" height="3" rx="1" />
      </g>
      {/* 車窗：一點暖光 */}
      <g fill="rgba(255,236,200,.9)">
        <rect x="12" y="11" width="9" height="6" rx="1" />
        <rect x="25" y="11" width="9" height="6" rx="1" />
        <rect x="38" y="11" width="9" height="6" rx="1" />
        <rect x="51" y="11" width="9" height="6" rx="1" />
        <rect x="64" y="11" width="9" height="6" rx="1" />
        <rect x="95" y="11" width="9" height="6" rx="1" />
        <rect x="108" y="11" width="9" height="6" rx="1" />
        <rect x="121" y="11" width="9" height="6" rx="1" />
        <rect x="134" y="11" width="9" height="6" rx="1" />
        <rect x="147" y="11" width="9" height="6" rx="1" />
        <rect x="160" y="11" width="9" height="6" rx="1" />
        <rect x="184" y="11" width="9" height="6" rx="1" />
        <rect x="197" y="11" width="9" height="6" rx="1" />
        <rect x="210" y="11" width="9" height="6" rx="1" />
        <rect x="223" y="11" width="9" height="6" rx="1" />
        <rect x="236" y="11" width="9" height="6" rx="1" />
      </g>
    </svg>
  );
}

/** 銀河：暗身、亮窗、集電弓、前燈與尾燈；幾扇拉了窗簾——C1 原型逐字 */
function GalaxyTrain({ style, onAnimationEnd }: TrainSvgProps) {
  return (
    <svg
      className="sky-train"
      viewBox="0 0 188 18"
      width="188"
      height="18"
      style={style}
      onAnimationEnd={onAnimationEnd}
      aria-hidden="true"
    >
      <g fill="currentColor">
        <rect x="0" y="4" width="60" height="11" rx="2" />
        <rect x="64" y="4" width="60" height="11" rx="2" />
        <rect x="128" y="4" width="60" height="11" rx="2" />
        <rect x="60" y="8.5" width="4" height="2" />
        <rect x="124" y="8.5" width="4" height="2" />
        <rect x="6" y="15" width="10" height="2" rx=".5" />
        <rect x="44" y="15" width="10" height="2" rx=".5" />
        <rect x="70" y="15" width="10" height="2" rx=".5" />
        <rect x="108" y="15" width="10" height="2" rx=".5" />
        <rect x="134" y="15" width="10" height="2" rx=".5" />
        <rect x="172" y="15" width="10" height="2" rx=".5" />
      </g>
      <path d="M86 4 l3 -2.6 h8" fill="none" stroke="currentColor" strokeWidth=".9" strokeLinecap="round" />
      {/* 車窗：幾扇拉了窗簾（暗一點），不要整排 LED */}
      <g fill="rgba(255,226,176,.58)">
        <rect x="5" y="6.5" width="4" height="4.5" />
        <rect x="12" y="6.5" width="4" height="4.5" />
        <rect x="19" y="6.5" width="4" height="4.5" opacity=".4" />
        <rect x="26" y="6.5" width="4" height="4.5" />
        <rect x="33" y="6.5" width="4" height="4.5" />
        <rect x="40" y="6.5" width="4" height="4.5" opacity=".35" />
        <rect x="47" y="6.5" width="4" height="4.5" />
        <rect x="69" y="6.5" width="4" height="4.5" />
        <rect x="76" y="6.5" width="4" height="4.5" opacity=".4" />
        <rect x="83" y="6.5" width="4" height="4.5" />
        <rect x="90" y="6.5" width="4" height="4.5" />
        <rect x="97" y="6.5" width="4" height="4.5" />
        <rect x="104" y="6.5" width="4" height="4.5" opacity=".45" />
        <rect x="111" y="6.5" width="4" height="4.5" />
        <rect x="133" y="6.5" width="4" height="4.5" />
        <rect x="140" y="6.5" width="4" height="4.5" />
        <rect x="147" y="6.5" width="4" height="4.5" opacity=".4" />
        <rect x="154" y="6.5" width="4" height="4.5" />
        <rect x="161" y="6.5" width="4" height="4.5" />
        <rect x="168" y="6.5" width="4" height="4.5" />
        <rect x="176" y="6.5" width="7" height="4.5" opacity=".8" />
      </g>
      <circle cx="186.5" cy="12.5" r="1.1" fill="rgba(255,240,210,.95)" />
      <circle cx="1.5" cy="12.5" r=".9" fill="rgba(227,123,96,.9)" />
    </svg>
  );
}
