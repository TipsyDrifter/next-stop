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
 *   full    今日視圖（M3 ③）：全量星點＋流星＋列車
 *   reduced 路線圖／日曆：減量星點、呼吸放慢 6–12s，無流星無列車  ← ② 先裝這一檔（預設值）
 *   none    工具頁（設定等）：只留漸層與大氣，靜態
 *
 * 技術鐵則：動畫只動 transform／opacity；prefers-reduced-motion 強制關；
 *          分頁隱藏暫停（is-paused → animation-play-state:paused）並清掉天象排程。
 *
 * 掛載（整合席 App.tsx；本席不動 App.tsx）：
 *   <SkyLayer />                       路線圖／日曆等頁（預設 reduced，跟著 data-theme 換場景）
 *   <SkyLayer density="full" train={false} />  今日視圖（M3 ③：流星開、列車不開——D-③-1 甲）
 *   <SkyLayer density="none" />        工具頁
 *   ⚠ 天空是 position:fixed; z-index:0 的底層——同層的兄弟節點（書封側欄、主欄、側板）
 *     必須自帶 position:relative 與 z-index ≥ 1，否則會被天空蓋住（原型 .cover z-index:2／
 *     .page,.sheet z-index:1 就是為此）。詳見 styles/ambience.css 檔頭。
 */
import { useMemo } from "react";
import { buildStarfield } from "./starfield";
import type { SkyDensity, SkyVariant } from "./starfield";
import { usePageHidden, usePrefersReducedMotion, useSkyVariant } from "./useAmbience";
import { Meteor } from "./Meteor";
import { TrainSilhouette } from "./TrainSilhouette";
// 樣式（styles/ambience.css）由 src/index.css 集中 import——見該檔檔頭的注入順序說明

/** 粉彩場景的七顆光斑（遠處燈火在霧裡失焦）——位置與大小在 ambience.css，逐字取自原型 */
const BOKEH = ["b1", "b2", "b3", "b4", "b5", "b6", "b7"] as const;

export interface SkyLayerProps {
  /** 星點密度檔位；預設 'reduced'（路線圖檔位） */
  density?: SkyDensity;
  /** 場景；預設 'auto'＝跟著 <html data-theme> 走。傳固定值可強制單一場景（截圖／原型比對用） */
  variant?: SkyVariant | "auto";
  /**
   * 地平線帶＋列車剪影要不要掛（只在 density='full' 有意義）；預設 true。
   * M3 ③ 傳 false——拍板 D-③-1 甲（決策記錄〈③ 今日視圖實施計畫拍板〉2）：
   * ③ 只開流星，列車與地面帶題一併留給「動態氛圍層」那一期（決策 10 的字面邊界）。
   */
  train?: boolean;
  /** 額外 class（給整合席微調層級用；一般不需要） */
  className?: string;
}

export function SkyLayer({ density = "reduced", variant = "auto", train = true, className }: SkyLayerProps) {
  const scene = useSkyVariant(variant);
  const reduced = usePrefersReducedMotion();
  const hidden = usePageHidden();

  // 星圖只在場景／密度變動時重算；seeded＝每次算出來都是同一片天
  const field = useMemo(() => buildStarfield(scene, density), [scene, density]);

  const full = density === "full";
  const skyClass = ["sky-layer", `sky--${scene}`, hidden ? "is-paused" : "", className ?? ""]
    .filter(Boolean)
    .join(" ");

  return (
    <>
      <div className={skyClass} aria-hidden="true">
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

        {/* 事件動態：只有今日視圖檔位才掛（決策 10 的動態邊界） */}
        {full && <Meteor variant={scene} enabled={!reduced} paused={hidden} />}
      </div>

      {/* 地平線帶＋列車：同樣只在今日視圖檔位，且要 train 明確開（③ 關，見 props） */}
      {full && train && <TrainSilhouette variant={scene} enabled={!reduced} paused={hidden} />}
    </>
  );
}
