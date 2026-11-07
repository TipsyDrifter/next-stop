/**
 * moodDirector.ts — 動態氛圍層的排程（純邏輯，不碰 DOM；⑪）
 *
 * 視覺與節奏真相＝prototypes/m3-mood-b-motion.html：
 *   列車 60–120s 一班；天象 候鳥 40–80s、流星 30–60s；不做暖場例外。
 *   一次一班列車，前一班還在跑就排隊；全済高潮（長列車）出發 420ms 後才放雁行／流星群。
 *   只有跟排程有關的設定（模式、元件、減少動態）真的變了才重排倒數；切主題、切強度都不碰。
 * 藏起來就停：setAwake(false) 把所有計時器收掉、記下剩餘秒數，醒來照剩餘秒數接著算；
 * 睡著時手上沒有任何計時器（對應原型 pauseTimers／resumeTimers）。
 */

export type MoodMode = "ambient" | "ritual" | "off";
export type SkyKind = "birds" | "meteor";

export interface MoodParts {
  train: boolean;
  birds: boolean;
  meteor: boolean;
  dusk: boolean;
}

export interface MoodConfig {
  mode: MoodMode;
  parts: MoodParts;
  /** 這個主題的天空有哪幾種天象（粉彩＝候鳥與流星輪流、白晝紙頁＝只有候鳥、夜空＝只有流星） */
  skyKinds: readonly SkyKind[];
  /** 系統「減少動態」：什麼都不排 */
  reduced: boolean;
}

export type MoodEvent =
  | { kind: "train"; long: boolean }
  | { kind: "birds"; count: number }
  | { kind: "flock" }
  | { kind: "meteor" };

export interface MoodClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  random(): number;
}

export const browserClock: MoodClock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (id) => window.clearTimeout(id as number),
  random: () => Math.random(),
};

const SHOWER_AT = [0, 350, 620, 1100, 1500, 2200];
/** 醒來時至少再等這麼久，不會一醒就同時放好幾樣 */
const RESUME_MIN_MS = 200;

interface Timer {
  fn: () => void;
  due: number;
  id: unknown;
  /** 睡著時才有值：醒來還要等多久 */
  remaining: number | null;
}

export class MoodDirector {
  private timers = new Map<string, Timer>();
  private awake = true;
  private cfg: MoodConfig | null = null;
  private schedKey: string | null = null;
  private trainRunning = false;
  private trainPending: boolean | null = null;
  private emit: (e: MoodEvent) => void;
  private clock: MoodClock;

  constructor(emit: (e: MoodEvent) => void, clock: MoodClock = browserClock) {
    this.emit = emit;
    this.clock = clock;
  }

  configure(cfg: MoodConfig): void {
    this.cfg = cfg;
    const { mode, parts, reduced } = cfg;
    const key = [mode, parts.train, parts.birds, parts.meteor, reduced].join("|");
    if (key === this.schedKey) return;
    this.schedKey = key;
    this.clearAll();
    this.trainPending = null;
    this.trainRunning = false;
    this.scheduleTrain();
    this.scheduleSky();
  }

  setAwake(awake: boolean): void {
    if (awake === this.awake) return;
    this.awake = awake;
    if (awake) {
      for (const [name, t] of [...this.timers]) this.later(name, t.remaining ?? RESUME_MIN_MS, t.fn);
      return;
    }
    const now = this.clock.now();
    for (const t of this.timers.values()) {
      this.clock.clearTimeout(t.id);
      t.id = null;
      t.remaining = Math.max(RESUME_MIN_MS, t.due - now);
    }
  }

  /** 蓋了一枚済：儀式模式才回應（環境循環照自己的節奏走，原型同款） */
  stamped(all: boolean): void {
    const cfg = this.cfg;
    if (!cfg || cfg.mode !== "ritual" || cfg.reduced || !this.awake) return;
    this.requestTrain(all);
    // 列車關著時高潮仍要放
    if (all && !cfg.parts.train) this.later("shower-start", 420, () => this.shower());
  }

  /** 叫一班列車；前一班還在跑就排隊，排隊中升格成長列車的不會被降回去 */
  requestTrain(long: boolean): void {
    if (this.trainRunning) {
      this.trainPending = long || this.trainPending === true;
      return;
    }
    this.runTrain(long);
  }

  /** 列車跑完（或被收走）才放下一班 */
  trainEnded(): void {
    this.trainRunning = false;
    if (this.trainPending !== null) {
      const long = this.trainPending;
      this.trainPending = null;
      this.runTrain(long);
    }
  }

  fireSky(): void {
    const kinds = this.activeKinds();
    if (!kinds.length) return;
    const kind = kinds[Math.floor(this.clock.random() * kinds.length)];
    if (kind === "meteor") this.emit({ kind: "meteor" });
    else this.emit({ kind: "birds", count: this.clock.random() < 0.5 ? 2 : 3 });
  }

  shower(): void {
    const kinds = this.activeKinds();
    if (kinds.includes("birds")) {
      this.emit({ kind: "flock" });
    } else if (kinds.includes("meteor")) {
      SHOWER_AT.forEach((d, i) => this.later(`shower${i}`, d, () => this.emit({ kind: "meteor" })));
    }
  }

  destroy(): void {
    this.clearAll();
    this.schedKey = null;
    this.cfg = null;
  }

  /** 手上有幾個正在倒數的計時器（睡著時要是 0） */
  get armedTimers(): number {
    let n = 0;
    for (const t of this.timers.values()) if (t.id !== null) n += 1;
    return n;
  }

  private activeKinds(): SkyKind[] {
    const cfg = this.cfg;
    if (!cfg || cfg.mode === "off" || cfg.reduced) return [];
    return cfg.skyKinds.filter((k) => (k === "birds" ? cfg.parts.birds : cfg.parts.meteor));
  }

  private runTrain(long: boolean): void {
    const cfg = this.cfg;
    if (!cfg || cfg.mode === "off" || cfg.reduced || !cfg.parts.train) return;
    this.trainRunning = true;
    this.emit({ kind: "train", long });
    if (long) this.later("shower-start", 420, () => this.shower());
  }

  private span(minMs: number, maxMs: number): number {
    return minMs + this.clock.random() * (maxMs - minMs);
  }

  private scheduleTrain(): void {
    const cfg = this.cfg;
    if (!cfg || cfg.mode !== "ambient" || cfg.reduced || !cfg.parts.train) return;
    this.later("train", this.span(60_000, 120_000), () => {
      this.requestTrain(false);
      this.scheduleTrain();
    });
  }

  /** 間隔在排程當下依主題取；切主題不重排倒數，下一輪自然換成新主題的節奏 */
  private scheduleSky(): void {
    const cfg = this.cfg;
    if (!cfg || cfg.mode !== "ambient" || cfg.reduced) return;
    if (!cfg.parts.birds && !cfg.parts.meteor) return;
    const ms = cfg.skyKinds.includes("birds") ? this.span(40_000, 80_000) : this.span(30_000, 60_000);
    this.later("sky", ms, () => {
      this.fireSky();
      this.scheduleSky();
    });
  }

  private later(name: string, ms: number, fn: () => void): void {
    const old = this.timers.get(name);
    if (old && old.id !== null) this.clock.clearTimeout(old.id);
    const t: Timer = { fn, due: this.clock.now() + ms, id: null, remaining: null };
    if (this.awake) {
      t.id = this.clock.setTimeout(() => {
        this.timers.delete(name);
        fn();
      }, ms);
    } else {
      t.remaining = ms;
    }
    this.timers.set(name, t);
  }

  private clearAll(): void {
    for (const t of this.timers.values()) if (t.id !== null) this.clock.clearTimeout(t.id);
    this.timers.clear();
  }
}

/** 晨昏三層各自的濃度（0–1）；白天都是 0，畫面就是主題本來的樣子 */
export interface DuskTint {
  dawn: number;
  dusk: number;
  night: number;
}

/** 梯形：start 起淡入、peakFrom–peakTo 滿、end 淡完（單位＝一天的第幾分鐘） */
function ramp(m: number, start: number, peakFrom: number, peakTo: number, end: number): number {
  if (m <= start || m >= end) return 0;
  if (m < peakFrom) return (m - start) / (peakFrom - start);
  if (m > peakTo) return (end - m) / (end - peakTo);
  return 1;
}

/** 依當地時間算晨昏：清晨 5–8 點、傍晚 16:30–19:30、入夜到清晨 */
export function duskTintAt(minuteOfDay: number): DuskTint {
  const m = ((minuteOfDay % 1440) + 1440) % 1440;
  const dawn = ramp(m, 300, 390, 420, 480);
  const dusk = ramp(m, 990, 1080, 1110, 1170);
  // 夜色跨午夜：19:00 起淡入、22:00 滿，到 04:00 開始退、06:00 退完
  const night = m >= 1140 ? Math.min(1, (m - 1140) / 180) : m < 240 ? 1 : m < 360 ? (360 - m) / 120 : 0;
  return { dawn, dusk, night };
}
