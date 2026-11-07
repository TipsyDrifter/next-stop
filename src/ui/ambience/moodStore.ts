/**
 * moodStore.ts — 今日氛圍的設定（⑪）。螢幕偏好，一台一份、不進同步白名單（D-1.1-3）；
 * 讀不到、寫不進去都吞掉：照預設跑，只是下次不記得。
 * 預設＝環境循環＋淡（使用者 2026-08-24 實機拍板）。
 */
import { create } from "zustand";
import { settingsRepo } from "../../data";
import type { MoodMode, MoodParts } from "./moodDirector";

export type MoodLevel = "lite" | "mid";

const KEY_MODE = "mood_mode";
const KEY_LEVEL = "mood_level";
const KEY_PARTS = "mood_parts";

export const DEFAULT_PARTS: MoodParts = { train: true, birds: true, meteor: true, dusk: true };

function parseMode(raw: string | null): MoodMode {
  return raw === "ritual" || raw === "off" ? raw : "ambient";
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

interface MoodState {
  mode: MoodMode;
  level: MoodLevel;
  parts: MoodParts;
  setMode(mode: MoodMode): void;
  setLevel(level: MoodLevel): void;
  setPart(part: keyof MoodParts, on: boolean): void;
}

function save(key: string, value: string): void {
  void settingsRepo.set(key, value).catch(() => undefined);
}

export const useMoodStore = create<MoodState>((set, get) => ({
  mode: "ambient",
  level: "lite",
  parts: DEFAULT_PARTS,
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
}));

void Promise.all([settingsRepo.get(KEY_MODE), settingsRepo.get(KEY_LEVEL), settingsRepo.get(KEY_PARTS)])
  .then(([mode, level, parts]) => {
    useMoodStore.setState({ mode: parseMode(mode), level: level === "mid" ? "mid" : "lite", parts: parseParts(parts) });
  })
  .catch(() => undefined);
