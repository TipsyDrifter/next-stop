/**
 * moodStore.ts — 今日氛圍與水鏡鎌倉時光天象設定（⑪ ＋ v1.34 4B）。
 * 螢幕偏好，一台一份、不進同步白名單（D-1.1-3）；
 * 讀不到、寫不進去都吞掉：照預設跑，只是下次不記得。
 * 預設＝循環＋儀式＋淡；水鏡鎌倉預設＝跟隨真實時間（24h 流轉）＋自然天象。
 *
 * 跨模組對接契約（4A × 4B）：
 *   `kamakuraTime` 同步寫入 `localStorage["ns-kamakura-time"]` 並派發 `ns-kamakura-time-change` 事件，
 *   讓 `index.html` 開頁同步腳本與 `uiStore.refreshThemeByClock()` 即刻對齊駐足時段，零閃白／零互搶。
 */
import { create } from "zustand";
import { settingsRepo } from "../../data";
import type { MoodMode, MoodParts } from "./moodDirector";
import {
  parseKamakuraTime,
  parseKamakuraWeather,
  type KamakuraTimeMode,
  type KamakuraWeatherMode,
} from "./kamakuraPalette";

export type MoodLevel = "lite" | "mid";

const KEY_MODE = "mood_mode";
const KEY_LEVEL = "mood_level";
const KEY_PARTS = "mood_parts";
const KEY_KAMAKURA_TIME = "mood_kamakura_time";
const KEY_KAMAKURA_WEATHER = "mood_kamakura_weather";

export const KAMAKURA_TIME_STORAGE_KEY = "ns-kamakura-time";
export const KAMAKURA_TIME_EVENT = "ns-kamakura-time-change";

export const DEFAULT_PARTS: MoodParts = { train: true, birds: true, meteor: true, dusk: true };

function parseMode(raw: string | null): MoodMode {
  return raw === "both" || raw === "ambient" || raw === "ritual" || raw === "off" ? raw : "both";
}

function parseParts(raw: string | null): MoodParts {
  if (!raw) return DEFAULT_PARTS;
  try {
    const v = JSON.parse(raw) as Partial<MoodParts>;
    return {
      train: v.train !== false,
      birds: v.birds !== false,
      meteor: v.meteor !== false,
      dusk: v.dusk !== false,
    };
  } catch {
    return DEFAULT_PARTS;
  }
}

function readCachedKamakuraTime(): KamakuraTimeMode {
  if (typeof window === "undefined" || typeof localStorage === "undefined") return "auto";
  try {
    return parseKamakuraTime(localStorage.getItem(KAMAKURA_TIME_STORAGE_KEY));
  } catch {
    return "auto";
  }
}

function syncKamakuraTimeCache(kamakuraTime: KamakuraTimeMode): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(KAMAKURA_TIME_STORAGE_KEY, kamakuraTime);
  } catch {
    /* 私密模式或儲存受限時略過 */
  }
  window.dispatchEvent(new CustomEvent(KAMAKURA_TIME_EVENT, { detail: kamakuraTime }));
}

interface MoodState {
  mode: MoodMode;
  level: MoodLevel;
  parts: MoodParts;
  kamakuraTime: KamakuraTimeMode;
  kamakuraWeather: KamakuraWeatherMode;
  stampSeq: number;
  ritualSeq: number;
  ritualAllDone: boolean;
  setMode(mode: MoodMode): void;
  setLevel(level: MoodLevel): void;
  setPart(part: keyof MoodParts, on: boolean): void;
  setKamakuraTime(time: KamakuraTimeMode): void;
  setKamakuraWeather(weather: KamakuraWeatherMode): void;
  notifyStamped(): void;
  emitRitual(allDone: boolean): void;
}

function save(key: string, value: string): void {
  void settingsRepo.set(key, value).catch(() => undefined);
}

export const useMoodStore = create<MoodState>((set, get) => ({
  mode: "both",
  level: "lite",
  parts: DEFAULT_PARTS,
  kamakuraTime: readCachedKamakuraTime(),
  kamakuraWeather: "auto",
  stampSeq: 0,
  ritualSeq: 0,
  ritualAllDone: false,
  setMode(mode) {
    set({ mode });
    save(KEY_MODE, mode);
  },
  setLevel(level) {
    set({ level });
    save(KEY_LEVEL, level);
  },
  setPart(part, on) {
    const parts = { ...get().parts, [part]: on };
    set({ parts });
    save(KEY_PARTS, JSON.stringify(parts));
  },
  setKamakuraTime(kamakuraTime) {
    set({ kamakuraTime });
    save(KEY_KAMAKURA_TIME, kamakuraTime);
    syncKamakuraTimeCache(kamakuraTime);
  },
  setKamakuraWeather(kamakuraWeather) {
    set({ kamakuraWeather });
    save(KEY_KAMAKURA_WEATHER, kamakuraWeather);
  },
  notifyStamped() {
    set((s) => ({ stampSeq: s.stampSeq + 1 }));
  },
  emitRitual(allDone) {
    set((s) => ({ ritualSeq: s.ritualSeq + 1, ritualAllDone: allDone }));
  },
}));

void Promise.all([
  settingsRepo.get(KEY_MODE),
  settingsRepo.get(KEY_LEVEL),
  settingsRepo.get(KEY_PARTS),
  settingsRepo.get(KEY_KAMAKURA_TIME),
  settingsRepo.get(KEY_KAMAKURA_WEATHER),
])
  .then(([mode, level, parts, kmTime, kmWeather]) => {
    const resolvedTime = kmTime !== null ? parseKamakuraTime(kmTime) : readCachedKamakuraTime();
    const prevTime = useMoodStore.getState().kamakuraTime;
    useMoodStore.setState({
      mode: parseMode(mode),
      level: level === "mid" ? "mid" : "lite",
      parts: parseParts(parts),
      kamakuraTime: resolvedTime,
      kamakuraWeather: parseKamakuraWeather(kmWeather),
    });
    if (resolvedTime !== prevTime || kmTime !== null) {
      syncKamakuraTimeCache(resolvedTime);
    }
  })
  .catch(() => undefined);
