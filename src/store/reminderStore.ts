/**
 * reminderStore——提醒的設定與「最近的提醒」（⑨ 契約 §2）。兩個本機鍵，不進同步白名單：開關與時刻各台各記。
 * 排程本身不在這裡（`ui/reminders/reminderRuntime.ts`）；這裡只管畫面要讀寫的東西，改設定後由 runtime 訂閱重算。
 * `reminderAllowed`：同步告警與備份失敗送通知前問一句（橫幅不受影響）。
 */
import { create } from "zustand";
import { settingsRepo } from "../data";
import {
  DEFAULT_REMINDER_SETTINGS,
  KEY_REMINDERS,
  KEY_REMINDER_RECENT,
  parseRecent,
  parseReminderSettings,
  type ReminderRecent,
  type ReminderSettings,
} from "../domain/reminders";

interface ReminderState {
  loaded: boolean;
  settings: ReminderSettings;
  recent: ReminderRecent[];
  /** 精準鬧鐘（Android）；false＝提醒可能晚幾分鐘。桌機恆 true */
  exactAlarm: boolean;
  load(): Promise<void>;
  update(patch: Partial<ReminderSettings>): Promise<void>;
  setRecent(recent: ReminderRecent[]): void;
  /** 本機資料被整批換掉：最近的提醒可能清了，重讀 */
  reloadRecent(): Promise<void>;
  setExactAlarm(v: boolean): void;
}

let loading: Promise<void> | null = null;

export const useReminderStore = create<ReminderState>((set, get) => ({
  loaded: false,
  settings: { ...DEFAULT_REMINDER_SETTINGS },
  recent: [],
  exactAlarm: true,

  load() {
    if (get().loaded) return Promise.resolve();
    if (!loading) {
      loading = (async () => {
        try {
          const [raw, recentRaw] = await Promise.all([settingsRepo.get(KEY_REMINDERS), settingsRepo.get(KEY_REMINDER_RECENT)]);
          set({ settings: parseReminderSettings(raw), recent: parseRecent(recentRaw), loaded: true });
        } catch (e) {
          // 讀不到就照預設跑，下一次開 App 再讀；寫入時才會蓋掉
          console.warn("[reminders] 讀設定失敗：", e instanceof Error ? e.message : String(e));
          set({ loaded: true });
        } finally {
          loading = null;
        }
      })();
    }
    return loading;
  },

  async update(patch) {
    const next = { ...get().settings, ...patch };
    set({ settings: next });
    try {
      await settingsRepo.set(KEY_REMINDERS, JSON.stringify(next));
    } catch (e) {
      console.warn("[reminders] 寫設定失敗：", e instanceof Error ? e.message : String(e));
    }
  },

  setRecent: (recent) => set({ recent }),
  async reloadRecent() {
    set({ recent: parseRecent(await settingsRepo.get(KEY_REMINDER_RECENT).catch(() => null)) });
  },
  setExactAlarm: (exactAlarm) => set({ exactAlarm }),
}));

/** 同步告警／備份失敗要不要送 OS 通知（讀不到設定＝照預設開，這兩種寧可多響） */
export async function reminderAllowed(kind: "sync" | "backup"): Promise<boolean> {
  const st = useReminderStore.getState();
  await st.load();
  return useReminderStore.getState().settings[kind];
}
