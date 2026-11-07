/**
 * MoodStage.tsx — 今日視圖的動態氛圍層（⑪）。只掛在今日頁（桌機 TodayView、手機 MobileToday），切走就整個卸載。
 *
 * 視覺真相＝prototypes/m3-mood-b-motion.html：
 *   .mood-layer  紙頁內容之下的天空：候鳥、雁行、流星、晨昏底色——從留白透出來，不壓字
 *   .mood-ground 底部地平線帶，不隨內容捲動；列車只在這條帶上跑，內容捲到底也不會被車票切碎
 * 排程在 moodDirector（純邏輯）；「藏起來就停」在 motionSleep。
 * 技術鐵則照舊：只動 transform／opacity、pointer-events:none、減少動態全關；天上沒東西時沒有 DOM。
 */
import { useEffect, useRef, useState, type AnimationEvent, type CSSProperties } from "react";
import { MoodDirector, duskTintAt, type DuskTint, type MoodEvent, type SkyKind } from "./moodDirector";
import { useMotionSleep } from "./motionSleep";
import { useMoodStore } from "./moodStore";
import { usePrefersReducedMotion } from "./useAmbience";
import type { CssVars } from "./starfield";

const rnd = (a: number, b: number) => a + Math.random() * (b - a);

interface SkyThing {
  id: number;
  kind: "birds" | "flock" | "meteor";
  style?: CssVars;
  birds?: { key: number; style: CssVars; width: number }[];
}

/** 主題決定場景：粉彩的天空有星，候鳥與流星輪流；商店的亮色主題是白晝紙頁，只有候鳥；夜色只有流星（原型的月白也是） */
function readScene(): { dark: boolean; skyKinds: readonly SkyKind[] } {
  const el = document.documentElement;
  const dark = el.getAttribute("data-theme") === "dark";
  if (dark) return { dark, skyKinds: METEOR_ONLY };
  return { dark, skyKinds: el.hasAttribute("data-skin") ? BIRDS_ONLY : BOTH };
}
const METEOR_ONLY: readonly SkyKind[] = ["meteor"];
const BIRDS_ONLY: readonly SkyKind[] = ["birds"];
const BOTH: readonly SkyKind[] = ["birds", "meteor"];

function useScene() {
  const [scene, setScene] = useState(readScene);
  useEffect(() => {
    const ob = new MutationObserver(() => setScene(readScene()));
    ob.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-skin"] });
    return () => ob.disconnect();
  }, []);
  return scene;
}

function minuteNow(): number {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

const NO_TINT: DuskTint = { dawn: 0, dusk: 0, night: 0 };
/** 一步很小，看不出在變；不用 CSS 長轉場，平常就不佔任何一格畫面 */
const TINT_TICK_MS = 5 * 60_000;

function useDuskTint(enabled: boolean, asleep: boolean): DuskTint {
  const [tint, setTint] = useState(() => (enabled ? duskTintAt(minuteNow()) : NO_TINT));
  useEffect(() => {
    if (!enabled) {
      setTint(NO_TINT);
      return;
    }
    if (asleep) return; // 睡著不算；醒來當場補到現在的時間
    const tick = () => setTint(duskTintAt(minuteNow()));
    tick();
    const t = window.setInterval(tick, TINT_TICK_MS);
    return () => window.clearInterval(t);
  }, [enabled, asleep]);
  return tint;
}

/** 候鳥剪影：滑翔中的雁——細長後掠的翼、小小的身軀、向前伸的頸與頭（頭朝左＝飛行方向）；路徑逐字取自原型 */
const BIRD_PATH =
  "M0.6 2.8C5.5 0.9 10.5 2.2 15 4C16.5 4.5 19 4.5 20.6 4C25.5 2 30.5 0.7 35.4 2.4C30.8 2.4 26.6 4.2 23.2 6.1C22.3 6.8 21.5 7.6 20.3 8.2C18.9 8.8 17.2 8.8 16 8.2C14.6 7.4 13.2 6.5 11.8 5.8C11.2 5.5 10.7 5.3 10.2 5.2C10.9 4.8 11.9 4.55 13 4.5C9 3.9 4.6 3.2 0.6 2.8Z";

function BirdSvg({ width }: { width: number }) {
  return (
    <svg width={width.toFixed(0)} height={((width * 13) / 36).toFixed(1)} viewBox="0 0 36 13" aria-hidden="true">
      <path d={BIRD_PATH} fill="var(--color-ink)" />
    </svg>
  );
}

function makeBirds(id: number, count: number, skyW: number): SkyThing[] {
  return Array.from({ length: count }, (_, i) => {
    const w = rnd(24, 34);
    return {
      id: id * 10 + i,
      kind: "birds" as const,
      birds: [{ key: 0, width: w, style: {} }],
      style: {
        top: `${rnd(16, 90).toFixed(0)}px`,
        opacity: rnd(0.2, 0.35).toFixed(2),
        "--run": `${(skyW + w + 80).toFixed(0)}px`,
        "--fdur": `${rnd(7, 12).toFixed(1)}s`,
        "--fdelay": `${(i * rnd(0.5, 1.4)).toFixed(2)}s`,
        "--sag": `${rnd(6, 16).toFixed(0)}px`,
        "--drift": `${rnd(-4, 6).toFixed(0)}px`,
        "--wdur": `${rnd(2.6, 4.2).toFixed(1)}s`,
        "--wdelay": `${(-rnd(0, 3)).toFixed(1)}s`,
      } as CssVars,
    };
  });
}

/** 全済的高潮（亮）：7–9 隻雁行編隊，領頭在左前、兩翼向右後展開 */
function makeFlock(id: number, skyW: number): SkyThing {
  const n = 7 + Math.floor(Math.random() * 3);
  return {
    id: id * 10,
    kind: "flock",
    style: {
      top: `${rnd(88, 128).toFixed(0)}px`,
      "--run": `${(skyW + 360).toFixed(0)}px`,
      "--fdur": `${rnd(9, 11).toFixed(1)}s`,
      "--sag": `${rnd(10, 16).toFixed(0)}px`,
      "--drift": `${rnd(-2, 6).toFixed(0)}px`,
    } as CssVars,
    birds: Array.from({ length: n }, (_, i) => {
      const arm = i === 0 ? 0 : i % 2 ? -1 : 1;
      const rank = Math.ceil(i / 2);
      return {
        key: i,
        width: 30 - rank * 1.2 + rnd(0, 2),
        style: {
          left: `${(rank * 30 + rnd(-4, 4)).toFixed(0)}px`,
          top: `${(arm * rank * 11 + rnd(-3, 3)).toFixed(0)}px`,
          opacity: rnd(0.26, 0.34).toFixed(2),
          "--wdur": `${rnd(2.4, 3.8).toFixed(1)}s`,
          "--wdelay": `${(-rnd(0, 3)).toFixed(1)}s`,
          "--bdur": `${rnd(2.8, 4.4).toFixed(1)}s`,
          "--bdelay": `${(-rnd(0, 3)).toFixed(1)}s`,
        } as CssVars,
      };
    }),
  };
}

function makeMeteor(id: number, baseDur: number): SkyThing {
  return {
    id: id * 10,
    kind: "meteor",
    // 上方 30%、右側 60%：避開日期文字
    style: {
      left: `${rnd(36, 86).toFixed(1)}%`,
      top: `${rnd(6, 28).toFixed(1)}%`,
      width: `${rnd(120, 200).toFixed(0)}px`,
      "--dur": `${(baseDur * rnd(0.85, 1.15)).toFixed(2)}s`,
    } as CssVars,
  };
}

export interface MoodStageProps {
  /** 今天蓋了幾枚（儀式模式用；變多才算蓋章，第一次拿到值不算） */
  done: number;
  allDone: boolean;
  /** 換日時重新起算，新的一天第一次載入不算蓋章 */
  dateKey: string;
  loaded: boolean;
}

export function MoodStage({ done, allDone, dateKey, loaded }: MoodStageProps) {
  const mode = useMoodStore((s) => s.mode);
  const level = useMoodStore((s) => s.level);
  const parts = useMoodStore((s) => s.parts);
  const reduced = usePrefersReducedMotion();
  const asleep = useMotionSleep() !== null;
  const scene = useScene();
  const on = mode !== "off" && !reduced;

  const layerRef = useRef<HTMLDivElement>(null);
  const groundRef = useRef<HTMLDivElement>(null);
  const seq = useRef(0);
  const levelRef = useRef(level);
  levelRef.current = level;

  const [train, setTrain] = useState<{ id: number; long: boolean; run: string } | null>(null);
  const [sky, setSky] = useState<SkyThing[]>([]);

  const directorRef = useRef<MoodDirector | null>(null);
  if (!directorRef.current) {
    directorRef.current = new MoodDirector((e: MoodEvent) => {
      seq.current += 1;
      const id = seq.current;
      const skyW = layerRef.current?.clientWidth ?? 1000;
      if (e.kind === "train") {
        const groundW = groundRef.current?.clientWidth ?? 1000;
        setTrain({ id, long: e.long, run: `${groundW + (e.long ? 236 : 156) + 8}px` });
      } else if (e.kind === "birds") {
        setSky((s) => [...s, ...makeBirds(id, e.count, skyW)]);
      } else if (e.kind === "flock") {
        setSky((s) => [...s, makeFlock(id, skyW)]);
      } else {
        setSky((s) => [...s, makeMeteor(id, levelRef.current === "mid" ? 1 : 1.35)]);
      }
    });
  }
  const director = directorRef.current;

  // StrictMode 會空跑一輪掛載與卸載：destroy 之後要能重新 configure，schedKey 也歸零了
  useEffect(() => {
    director.configure({ mode, parts, skyKinds: scene.skyKinds, reduced });
  }, [director, mode, parts, scene.skyKinds, reduced]);
  useEffect(() => () => director.destroy(), [director]);
  useEffect(() => {
    director.setAwake(!asleep);
  }, [director, asleep]);

  // 模式關掉或元件關掉：天上的收走，不留看不見的殘骸
  useEffect(() => {
    if (!on || !parts.train) setTrain(null);
  }, [on, parts.train]);
  useEffect(() => {
    if (!on) setSky([]);
  }, [on]);

  // 儀式：済變多才算蓋章（第一次載入、換日、復原都不算）
  const lastDone = useRef<{ day: string; done: number } | null>(null);
  useEffect(() => {
    if (!loaded) return;
    const prev = lastDone.current;
    lastDone.current = { day: dateKey, done };
    if (prev && prev.day === dateKey && done > prev.done) director.stamped(allDone);
  }, [director, loaded, dateKey, done, allDone]);

  // 開發時給量測腳本與預覽用（scripts/verify/measure-motion.mjs）
  if (import.meta.env.DEV) Object.assign(window, { __mood: director, __moodStore: useMoodStore });

  const tint = useDuskTint(on && mode === "ambient" && parts.dusk, asleep);
  const tintScale = level === "mid" ? 1 : 0.7;

  const gone = (id: number) => (e: AnimationEvent<HTMLElement>) => {
    if (e.target === e.currentTarget) setSky((s) => s.filter((t) => t.id !== id));
  };
  const trainDone = (e: AnimationEvent<HTMLElement>) => {
    if (e.target !== e.currentTarget) return;
    setTrain(null);
    director.trainEnded();
  };

  if (!on) return null;

  const sceneClass = scene.dark ? "is-dark" : "is-light";
  return (
    <>
      <div ref={layerRef} className={`mood-layer ${sceneClass}`} data-level={level} aria-hidden="true">
        {tint.dawn > 0 && <i className="mood-tint mood-tint--dawn" style={{ opacity: tint.dawn * tintScale }} />}
        {tint.dusk > 0 && <i className="mood-tint mood-tint--dusk" style={{ opacity: tint.dusk * tintScale }} />}
        {tint.night > 0 && <i className="mood-tint mood-tint--night" style={{ opacity: tint.night * tintScale }} />}
        {sky.map((t) =>
          t.kind === "meteor" ? (
            <i key={t.id} className="mood-meteor" style={t.style} onAnimationEnd={gone(t.id)} />
          ) : t.kind === "birds" ? (
            <i key={t.id} className="mood-bird" style={t.style} onAnimationEnd={gone(t.id)}>
              <span className="mood-bob">
                <BirdSvg width={t.birds![0].width} />
              </span>
            </i>
          ) : (
            <i key={t.id} className="mood-flock" style={t.style} onAnimationEnd={gone(t.id)}>
              <span className="mood-bob">
                {t.birds!.map((b) => (
                  <span key={b.key} className="mood-fbird" style={b.style as CSSProperties}>
                    <BirdSvg width={b.width} />
                  </span>
                ))}
              </span>
            </i>
          ),
        )}
      </div>
      {parts.train && (
        <div ref={groundRef} className={`mood-ground ${sceneClass}`} data-level={level} aria-hidden="true">
          <i className="mood-horizon" />
          {train && (
            <div
              key={train.id}
              className="mood-train"
              style={{ "--run": train.run } as CssVars}
              onAnimationEnd={trainDone}
            >
              {train.long ? <TrainLong /> : <TrainShort />}
            </div>
          )}
        </div>
      )}
    </>
  );
}

/** 列車剪影形狀取自原型 #car-head／#car-mid；顏色走 --mood-train-*（亮＝淡墨車體、暗＝幾乎沒入夜色只剩燈窗） */
function CarWindows({ x }: { x: readonly (readonly [number, number])[] }) {
  return (
    <>
      <g fill="var(--mood-train-win)" opacity="var(--mood-train-halo)">
        {x.map(([cx, w]) => (
          <rect key={cx} x={cx - 1} y="8" width={w + 2} height={w < 3 ? 10.5 : 7.8} rx="1.6" />
        ))}
      </g>
      <g fill="var(--mood-train-win)">
        {x.map(([cx, w]) => (
          <rect key={cx} x={cx} y="9" width={w} height={w < 3 ? 8.5 : 5.8} rx=".7" />
        ))}
      </g>
    </>
  );
}

const HEAD_WIN = [[6.4, 5.4], [15, 7.6], [25, 7.6], [35, 7.6], [45.5, 2.6], [49.2, 2.6], [55, 7.6], [65, 7.6]] as const;
const MID_WIN = [[5, 7.6], [15, 7.6], [25, 7.6], [35, 7.6], [45.5, 2.6], [49.2, 2.6], [55, 7.6], [65, 7.6]] as const;

function Bogies() {
  return (
    <g fill="var(--mood-train-body)">
      <rect x="8" y="21" width="13" height="2" rx=".6" />
      <circle cx="11" cy="23.2" r="2" />
      <circle cx="18" cy="23.2" r="2" />
      <rect x="55" y="21" width="13" height="2" rx=".6" />
      <circle cx="58" cy="23.2" r="2" />
      <circle cx="65" cy="23.2" r="2" />
    </g>
  );
}

function CarHead() {
  return (
    <>
      <path d="M27 7 L33.5 2.4 H41.2" fill="none" stroke="var(--mood-train-body)" strokeWidth="1" strokeLinecap="round" />
      <rect x="38.6" y="1.5" width="6" height="1.3" rx=".6" fill="var(--mood-train-body)" />
      <path d="M3 21.5 V12.5 C3 8.6 5.2 6.2 9 6.2 H73.2 C74.2 6.2 74.8 6.8 74.8 7.8 V21.5 Z" fill="var(--mood-train-body)" />
      <rect x="4.2" y="16.6" width="2.2" height="1.5" rx=".4" fill="var(--mood-train-win)" />
      <CarWindows x={HEAD_WIN} />
      <Bogies />
    </>
  );
}

function CarMid() {
  return (
    <>
      <path d="M1.2 21.5 V7.8 C1.2 6.8 1.8 6.2 2.8 6.2 H73.2 C74.2 6.2 74.8 6.8 74.8 7.8 V21.5 Z" fill="var(--mood-train-body)" />
      <CarWindows x={MID_WIN} />
      <Bogies />
    </>
  );
}

const coupler = (x: number) => <rect x={x} y="14.5" width="6.4" height="1.6" fill="var(--mood-train-body)" />;

function TrainShort() {
  return (
    <svg width="156" height="26" viewBox="0 0 156 26" aria-hidden="true">
      <CarHead />
      {coupler(74.8)}
      <g transform="translate(156 0) scale(-1 1)">
        <CarHead />
      </g>
    </svg>
  );
}

function TrainLong() {
  return (
    <svg width="236" height="26" viewBox="0 0 236 26" aria-hidden="true">
      <CarHead />
      {coupler(74.8)}
      <g transform="translate(80 0)">
        <CarMid />
      </g>
      {coupler(154.8)}
      <g transform="translate(236 0) scale(-1 1)">
        <CarHead />
      </g>
    </svg>
  );
}
