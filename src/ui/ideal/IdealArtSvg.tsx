/**
 * 車窓・理想手札——12 幅內建低彩度鐵道與車窗線畫 SVG（第六本第四梯 v1.30；決定 1-B）。
 *
 * 嚴格遵守《視覺規範》：零裸色碼，全部透過 `currentColor`、`var(--accent)`、`var(--color-ink-soft)` 與透明度疊加，
 * 在粉彩星空、銀河鐵道與四套商店主題下都能自然融入紙面溫度。
 */
import type { IdealArtPresetId } from "../../domain/idealTecho";

interface IdealArtSvgProps {
  preset: IdealArtPresetId;
  className?: string;
}

export function IdealArtSvg({ preset, className }: IdealArtSvgProps) {
  return (
    <svg
      className={className ? `ns-ideal-art-svg ${className}` : "ns-ideal-art-svg"}
      viewBox="0 0 240 96"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      {/* 車窗外框微光底紋 */}
      <rect
        x="6"
        y="6"
        width="228"
        height="84"
        rx="6"
        stroke="currentColor"
        strokeOpacity="0.16"
        strokeWidth="1"
      />
      {renderPresetScene(preset)}
    </svg>
  );
}

function renderPresetScene(preset: IdealArtPresetId) {
  switch (preset) {
    case "sea-station":
      return (
        <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
          {/* 遠海水平線與夕陽 */}
          <circle cx="182" cy="34" r="14" fill="var(--accent)" fillOpacity="0.14" strokeOpacity="0.35" strokeWidth="1.1" />
          <path d="M12 58 H228" strokeOpacity="0.32" strokeWidth="1.1" />
          <path d="M24 64 H92 M128 64 H208 M46 70 H148" strokeOpacity="0.2" strokeWidth="1" />
          {/* 海邊小站木造雨棚與站牌 */}
          <path d="M28 58 V34 M86 58 V34 M20 34 L94 30" strokeOpacity="0.58" strokeWidth="1.3" />
          <rect x="46" y="40" width="22" height="10" rx="1.5" stroke="var(--accent)" strokeOpacity="0.65" strokeWidth="1.1" />
          <path d="M57 50 V58" strokeOpacity="0.45" strokeWidth="1.1" />
          {/* 鐵軌與平交道桿 */}
          <path d="M12 78 H228 M12 83 H228" strokeOpacity="0.42" strokeWidth="1.1" />
          <path d="M142 58 V78 M136 46 L168 38" stroke="var(--accent)" strokeOpacity="0.55" strokeWidth="1.2" />
        </g>
      );

    case "night-desk":
      return (
        <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
          {/* 窗格與星月 */}
          <rect x="132" y="14" width="84" height="44" rx="2" strokeOpacity="0.32" strokeWidth="1.1" />
          <path d="M174 14 V58 M132 36 H216" strokeOpacity="0.2" strokeWidth="1" />
          <path d="M196 22 A7 7 0 1 1 189 31 A5.5 5.5 0 1 0 196 22 Z" fill="var(--accent)" fillOpacity="0.22" strokeOpacity="0.45" strokeWidth="1" />
          <circle cx="150" cy="24" r="1.2" fill="currentColor" fillOpacity="0.45" stroke="none" />
          <circle cx="161" cy="30" r="1" fill="currentColor" fillOpacity="0.35" stroke="none" />
          {/* 桌面、檯燈光暈、手札與熱茶 */}
          <path d="M16 74 H224" strokeOpacity="0.45" strokeWidth="1.2" />
          <path d="M44 74 V42 Q44 26 62 28 L68 34" strokeOpacity="0.62" strokeWidth="1.3" />
          <path d="M62 34 L42 74 H88 Z" fill="var(--accent)" fillOpacity="0.1" stroke="none" />
          <rect x="66" y="64" width="38" height="10" rx="1.5" strokeOpacity="0.52" strokeWidth="1.1" />
          <path d="M85 64 V74" strokeOpacity="0.35" strokeWidth="1" />
          <rect x="116" y="61" width="14" height="13" rx="2" stroke="var(--accent)" strokeOpacity="0.6" strokeWidth="1.1" />
          <path d="M130 64 C134 64 134 70 130 70" stroke="var(--accent)" strokeOpacity="0.6" strokeWidth="1.1" />
          <path d="M120 56 Q122 52 120 49 M125 57 Q127 53 125 50" strokeOpacity="0.32" strokeWidth="1" />
        </g>
      );

    case "starry-window":
      return (
        <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
          {/* 車廂圓角觀景窗 */}
          <rect x="44" y="14" width="152" height="62" rx="10" fill="var(--accent)" fillOpacity="0.07" strokeOpacity="0.5" strokeWidth="1.3" />
          <path d="M44 58 Q88 44 128 54 T196 48" strokeOpacity="0.35" strokeWidth="1.1" />
          {/* 星群連線 */}
          <path d="M74 34 L94 26 L116 32 L134 23 L158 31" stroke="var(--accent)" strokeOpacity="0.45" strokeWidth="1" strokeDasharray="2 3" />
          {[
            [74, 34],
            [94, 26],
            [116, 32],
            [134, 23],
            [158, 31],
            [174, 25],
          ].map(([cx, cy], idx) => (
            <circle key={idx} cx={cx} cy={cy} r={idx % 2 === 0 ? 2 : 1.4} fill="var(--accent)" fillOpacity="0.68" stroke="none" />
          ))}
          <path d="M26 82 H214" strokeOpacity="0.25" strokeWidth="1" />
        </g>
      );

    case "morning-cafe":
      return (
        <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
          {/* 斜照晨光窗影 */}
          <path d="M36 12 L94 84 H134 L76 12 Z" fill="var(--accent)" fillOpacity="0.08" stroke="none" />
          <path d="M24 72 H216" strokeOpacity="0.4" strokeWidth="1.2" />
          {/* 手沖壺與瓷杯 */}
          <path d="M72 72 L78 46 H98 L104 72 Z" strokeOpacity="0.55" strokeWidth="1.2" />
          <path d="M101 52 Q118 50 124 38" strokeOpacity="0.55" strokeWidth="1.2" />
          <path d="M75 50 Q64 52 68 64 L74 66" strokeOpacity="0.45" strokeWidth="1.1" />
          <ellipse cx="152" cy="64" rx="16" ry="8" stroke="var(--accent)" strokeOpacity="0.62" strokeWidth="1.2" />
          <path d="M132 72 H172" strokeOpacity="0.45" strokeWidth="1.1" />
          <path d="M148 50 Q150 43 147 38 M156 51 Q158 44 155 39" stroke="var(--accent)" strokeOpacity="0.45" strokeWidth="1" />
        </g>
      );

    case "river-tram":
      return (
        <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
          {/* 河岸拱橋與水波 */}
          <path d="M14 64 H226" strokeOpacity="0.42" strokeWidth="1.2" />
          <path d="M26 64 Q60 50 94 64 Q128 50 162 64 Q194 50 220 64" strokeOpacity="0.28" strokeWidth="1.1" />
          <path d="M36 74 H112 M140 74 H206 M62 80 H176" stroke="var(--accent)" strokeOpacity="0.32" strokeWidth="1" />
          {/* 單節路面電車與集電弓 */}
          <rect x="78" y="34" width="84" height="24" rx="5" fill="var(--accent)" fillOpacity="0.1" strokeOpacity="0.6" strokeWidth="1.3" />
          <rect x="88" y="40" width="16" height="10" rx="1.5" strokeOpacity="0.45" strokeWidth="1" />
          <rect x="112" y="40" width="16" height="10" rx="1.5" strokeOpacity="0.45" strokeWidth="1" />
          <rect x="136" y="40" width="16" height="10" rx="1.5" strokeOpacity="0.45" strokeWidth="1" />
          <path d="M112 34 L120 24 L128 34 M18 24 H222" strokeOpacity="0.32" strokeWidth="1" />
          <circle cx="96" cy="61" r="2.5" strokeOpacity="0.55" strokeWidth="1.1" />
          <circle cx="144" cy="61" r="2.5" strokeOpacity="0.55" strokeWidth="1.1" />
        </g>
      );

    case "mountain-bridge":
      return (
        <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
          {/* 層疊遠山 */}
          <path d="M12 72 L64 26 L108 58 L162 20 L228 72" strokeOpacity="0.32" strokeWidth="1.2" />
          <path d="M12 72 L42 46 L82 68" strokeOpacity="0.2" strokeWidth="1" />
          {/* 山谷鋼桁鐵橋與小列車 */}
          <path d="M24 56 H216 M24 64 H216" strokeOpacity="0.55" strokeWidth="1.2" />
          <path d="M48 64 V84 M96 64 V84 M144 64 V84 M192 64 V84" strokeOpacity="0.38" strokeWidth="1.1" />
          <rect x="86" y="46" width="56" height="10" rx="2" fill="var(--accent)" fillOpacity="0.18" stroke="var(--accent)" strokeOpacity="0.65" strokeWidth="1.1" />
        </g>
      );

    case "quiet-library":
      return (
        <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
          {/* 木質書架與錯落書背 */}
          <path d="M28 38 H212 M28 74 H212" strokeOpacity="0.48" strokeWidth="1.2" />
          <rect x="42" y="16" width="12" height="22" rx="1" strokeOpacity="0.48" strokeWidth="1.1" />
          <rect x="56" y="19" width="10" height="19" rx="1" fill="var(--accent)" fillOpacity="0.14" stroke="var(--accent)" strokeOpacity="0.55" strokeWidth="1.1" />
          <rect x="68" y="14" width="14" height="24" rx="1" strokeOpacity="0.48" strokeWidth="1.1" />
          <path d="M88 38 L98 16 L108 20 L98 38 Z" strokeOpacity="0.48" strokeWidth="1.1" />
          {/* 下層手札與小盆栽 */}
          <rect x="52" y="50" width="44" height="24" rx="2" strokeOpacity="0.45" strokeWidth="1.1" />
          <path d="M74 50 V74" strokeOpacity="0.3" strokeWidth="1" />
          <path d="M158 74 L162 58 H182 L186 74 Z" stroke="var(--accent)" strokeOpacity="0.6" strokeWidth="1.1" />
          <path d="M172 58 Q162 46 168 42 Q174 48 172 58 Q182 45 186 48 Q180 55 172 58" fill="var(--accent)" fillOpacity="0.15" stroke="var(--accent)" strokeOpacity="0.55" strokeWidth="1.1" />
        </g>
      );

    case "sunrise-platform":
      return (
        <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
          {/* 破曉天際弧線與光芒 */}
          <path d="M20 66 Q120 36 220 66" stroke="var(--accent)" strokeOpacity="0.48" strokeWidth="1.2" />
          <circle cx="120" cy="50" r="18" fill="var(--accent)" fillOpacity="0.12" stroke="none" />
          {/* 月台透視線與長椅、時鐘 */}
          <path d="M16 80 L96 54 M224 80 L144 54" strokeOpacity="0.45" strokeWidth="1.2" />
          <circle cx="64" cy="34" r="9" strokeOpacity="0.55" strokeWidth="1.2" />
          <path d="M64 34 V29 M64 34 L68 36 M64 43 V72" strokeOpacity="0.5" strokeWidth="1.1" />
          <path d="M156 68 H190 M160 68 V76 M186 68 V76" strokeOpacity="0.48" strokeWidth="1.2" />
        </g>
      );

    case "autumn-maple":
      return (
        <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
          {/* 彎道支線鐵軌 */}
          <path d="M26 82 Q96 68 198 28 M46 84 Q112 72 212 34" strokeOpacity="0.45" strokeWidth="1.2" />
          {/* 楓枝與飄落葉片 */}
          <path d="M18 22 Q68 28 106 18 M54 24 Q72 38 88 36" strokeOpacity="0.5" strokeWidth="1.2" />
          {[
            [68, 22],
            [92, 28],
            [114, 22],
            [138, 42],
            [162, 54],
          ].map(([cx, cy], i) => (
            <circle key={i} cx={cx} cy={cy} r={i < 3 ? 4.5 : 3} fill="var(--accent)" fillOpacity="0.2" stroke="var(--accent)" strokeOpacity="0.55" strokeWidth="1" />
          ))}
        </g>
      );

    case "rainy-window":
      return (
        <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
          {/* 微雨斜絲與玻璃水珠 */}
          <path d="M48 16 L34 44 M86 14 L68 50 M136 18 L120 52 M184 16 L168 48 M208 32 L194 60" strokeOpacity="0.24" strokeWidth="1" />
          {[
            [62, 56, 2.2],
            [96, 40, 1.8],
            [112, 64, 2.6],
            [154, 46, 2],
            [178, 66, 1.6],
          ].map(([cx, cy, r], i) => (
            <circle key={i} cx={cx} cy={cy} r={r} fill="var(--accent)" fillOpacity="0.25" stroke="var(--accent)" strokeOpacity="0.55" strokeWidth="1" />
          ))}
          {/* 遠處街燈柔暈 */}
          <circle cx="84" cy="68" r="10" fill="var(--accent)" fillOpacity="0.1" stroke="none" />
          <circle cx="148" cy="64" r="12" fill="var(--accent)" fillOpacity="0.08" stroke="none" />
          <path d="M20 78 H220" strokeOpacity="0.35" strokeWidth="1.1" />
        </g>
      );

    case "harbor-ferry":
      return (
        <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
          {/* 港灣薄霧與燈塔 */}
          <path d="M14 62 H226" strokeOpacity="0.38" strokeWidth="1.1" />
          <path d="M36 62 L40 32 H46 L50 62 Z" strokeOpacity="0.55" strokeWidth="1.2" />
          <path d="M46 35 L98 26 L98 44 Z" fill="var(--accent)" fillOpacity="0.12" stroke="none" />
          {/* 渡輪剪影 */}
          <path d="M126 62 L134 70 H188 L198 62 Z" fill="var(--accent)" fillOpacity="0.16" stroke="var(--accent)" strokeOpacity="0.6" strokeWidth="1.2" />
          <rect x="142" y="52" width="34" height="10" rx="1.5" strokeOpacity="0.5" strokeWidth="1.1" />
          <path d="M156 52 V45 H162 V52" strokeOpacity="0.5" strokeWidth="1.1" />
          <path d="M48 74 H116 M136 76 H204" strokeOpacity="0.22" strokeWidth="1" />
        </g>
      );

    case "meadow-train":
      return (
        <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
          {/* 起伏原野與雲朵 */}
          <path d="M12 68 Q72 48 134 62 T228 56" strokeOpacity="0.38" strokeWidth="1.2" />
          <path d="M52 28 Q58 20 68 24 Q76 18 86 25 Q94 26 90 32 H50 Q46 28 52 28 Z" strokeOpacity="0.28" strokeWidth="1" />
          {/* 原野單節小火車 */}
          <rect x="96" y="46" width="52" height="16" rx="3" fill="var(--accent)" fillOpacity="0.15" stroke="var(--accent)" strokeOpacity="0.65" strokeWidth="1.2" />
          <rect x="104" y="50" width="10" height="6" rx="1" strokeOpacity="0.45" strokeWidth="1" />
          <rect x="118" y="50" width="10" height="6" rx="1" strokeOpacity="0.45" strokeWidth="1" />
          <rect x="132" y="50" width="10" height="6" rx="1" strokeOpacity="0.45" strokeWidth="1" />
          <path d="M16 76 H224" strokeOpacity="0.25" strokeWidth="1" />
        </g>
      );
  }
}
