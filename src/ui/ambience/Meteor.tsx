/**
 * Meteor.tsx — 流星（事件動態，只在今日視圖＝density='full' 啟用）
 *
 * 視覺真相＝m3-mood-c2-pastel.html `.meteor` 段（粉彩）／m3-mood-c1-galaxy.html `.meteor-wrap` 段（銀河）。
 * 兩件原型結構相同（外層定角度、內層沿自身 x 軸滑過），故 markup 共用一份、差異全在 ambience.css。
 * 邊界（決策 10＋移植規格 §2）：路線圖／日曆等頁**不出現流星**——由 SkyLayer 依 density 決定掛不掛。
 *
 * 節奏（原型逐字）：
 *   粉彩 每 35–60s 一顆，落點 x 28–72%／y 5–26%，飛行 1.0–1.3s，角度固定 24deg，
 *        放行的同時就排下一顆（C2 做法）
 *   銀河 首發 5s、之後 90–180s 一顆，落點 x 8–66%／y 4–30%，飛行 1.15s，角度 20–30deg，
 *        跑完才排下一顆（C1 做法）
 * 天上沒東西時不掛 DOM；飛完即卸載（下一顆＝全新元素，動畫必從頭跑）。
 */
import { useFlightScheduler, rand } from "./useAmbience";
import type { CssVars, SkyVariant } from "./starfield";

export interface MeteorProps {
  variant: SkyVariant;
  /** false＝不排程（非今日視圖／系統開了減少動態） */
  enabled: boolean;
  /** 分頁隱藏 */
  paused: boolean;
}

export function Meteor({ variant, enabled, paused }: MeteorProps) {
  const pastel = variant === "pastel";

  const { flight, onFlightEnd } = useFlightScheduler({
    enabled,
    paused,
    chainOnEnd: !pastel,
    firstDelay: () => (pastel ? rand(35000, 60000) : 5000),
    nextDelay: () => (pastel ? rand(35000, 60000) : rand(90000, 180000)),
    makeStyle: (): CssVars => {
      if (pastel) {
        return {
          left: `${rand(28, 72).toFixed(1)}%`,
          top: `${rand(5, 26).toFixed(1)}%`,
          "--dur": `${rand(1.0, 1.3).toFixed(2)}s`,
        };
      }
      return {
        left: `${rand(8, 66).toFixed(1)}%`,
        top: `${rand(4, 30).toFixed(1)}%`,
        "--ang": `${rand(20, 30).toFixed(1)}deg`,
      };
    },
  });

  if (!flight) return null;

  return (
    <div key={flight.id} className="sky-meteor-wrap" style={flight.style}>
      <i className="sky-meteor" onAnimationEnd={onFlightEnd} />
    </div>
  );
}
