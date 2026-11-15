/**
 * 車窓・理想手札與「車窓の問い」狀態層（第六本第四梯 v1.30；D-主-560～564）。
 *
 * 兩殼共用同一份 Store：今日頁頂部方針區（心之所向常駐題詞＋理想手札抽屜預覽）與獨立扉頁視圖皆訂閱本 Store。
 * 同步拉到 `ideal_cards`／`ideal_reflections` 或本機資料整批更換時，由 `syncStore.refreshAfterPull` 呼叫 `reload()`。
 */
import { create } from "zustand";
import { idealRepo } from "../data/idealRepository";
import { noteRepo } from "../data/noteRepo";
import {
  customPromptKey,
  formatReflectionDiaryBody,
  pickDailyPrompt,
  resolvePinnedMotto,
  type CreateIdealCardInput,
  type IdealCardRow,
  type IdealReflectionRow,
  type IdealTheme,
  type UpdateIdealCardPatch,
  type WindowPromptCategory,
  type WindowPromptSpec,
} from "../domain/idealTecho";
import { useNotesStore } from "./notesStore";
import { useTagStore } from "./tagStore";
import { useUiStore } from "./uiStore";

const SYNC_DIARY_PREF_KEY = "ns.ideal.syncDiary";

function readSyncDiaryPref(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const raw = window.localStorage.getItem(SYNC_DIARY_PREF_KEY);
    return raw === null ? true : raw === "1";
  } catch {
    return true;
  }
}

function writeSyncDiaryPref(on: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SYNC_DIARY_PREF_KEY, on ? "1" : "0");
  } catch {
    // 隱私瀏覽或儲存滿時靜默略過
  }
}

function shellNow(): "desktop" | "mobile" {
  return typeof document !== "undefined" && document.documentElement.getAttribute("data-shell") === "mobile"
    ? "mobile"
    : "desktop";
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function toast(message: string, undo?: () => void): void {
  useUiStore.getState().showToast(undo ? { message, actionLabel: "復原", onAction: undo } : { message });
}

async function reloadNotesIfNeeded(): Promise<void> {
  try {
    await useNotesStore.getState().reload({
      changed: ["notes", "tags", "taggings"],
      wiped: false,
      shell: shellNow(),
    });
  } catch {
    // 筆記線尚未掛載或讀取異常時不阻斷理想手札流程
  }
}

export type ActivePromptOverride =
  | { mode: "custom"; question: string }
  | { mode: "reanswer"; promptKey: string; category: WindowPromptCategory; question: string };

export type CardDialogState =
  | { mode: "create"; defaultTheme: IdealTheme }
  | { mode: "edit"; card: IdealCardRow };

interface IdealStoreState {
  cards: IdealCardRow[];
  reflections: IdealReflectionRow[];
  loaded: boolean;
  loading: boolean;

  /** 今日「換一題」偏移（跨日自動歸零） */
  shuffleDay: string;
  shuffleOffset: number;
  /** 自訂題目或「再答一次」指定題目 */
  promptOverride: ActivePromptOverride | null;
  /** 勾選「同時記進今日《旅客筆記・日記》」偏好 */
  syncDiaryPref: boolean;
  /** 扉頁風景卡主題篩選 */
  themeFilter: "all" | IdealTheme;
  /** 新增／編輯風景卡對話框狀態 */
  cardDialog: CardDialogState | null;

  ensureLoaded(): Promise<void>;
  reload(): Promise<void>;

  shufflePrompt(dayKey: string): void;
  startCustomPrompt(initialQuestion?: string): void;
  setCustomPromptQuestion(question: string): void;
  startReanswer(target: { promptKey: string; category: WindowPromptCategory; question: string }): void;
  clearPromptOverride(): void;

  setSyncDiaryPref(on: boolean): void;
  setThemeFilter(filter: "all" | IdealTheme): void;

  openCreateCard(defaultTheme?: IdealTheme): void;
  openEditCard(card: IdealCardRow): void;
  closeCardDialog(): void;

  saveCard(input: CreateIdealCardInput, editId?: string): Promise<IdealCardRow | null>;
  updateCardPatch(id: string, patch: UpdateIdealCardPatch): Promise<boolean>;
  deleteCard(id: string): Promise<void>;
  restoreCard(id: string): Promise<void>;

  togglePin(target: { kind: "card" | "reflection"; id: string }): Promise<void>;

  submitReflection(input: {
    promptKey: string;
    category: WindowPromptCategory;
    question: string;
    answer: string;
    answeredOn: string;
    syncDiary: boolean;
    pinned?: boolean;
  }): Promise<IdealReflectionRow | null>;
  updateReflection(
    id: string,
    patch: { question?: string; answer?: string; syncDiary?: boolean },
  ): Promise<boolean>;
  deleteReflection(id: string): Promise<void>;
  restoreReflection(id: string): Promise<void>;
}

let inflightLoad: Promise<void> | null = null;

/** 計算今日目前顯示在車窗盒的題目（含「換一題」偏移與「再答一次」覆寫） */
export function resolveCurrentWindowPrompt(
  dayKey: string,
  shuffleDay: string,
  shuffleOffset: number,
  override: ActivePromptOverride | null,
): {
  promptKey: string;
  category: WindowPromptCategory;
  question: string;
  isCustomEditing: boolean;
  isReanswer: boolean;
} {
  if (override?.mode === "custom") {
    const q = override.question;
    return {
      promptKey: q.trim() ? customPromptKey(q) : "custom:",
      category: "custom",
      question: q,
      isCustomEditing: true,
      isReanswer: false,
    };
  }
  if (override?.mode === "reanswer") {
    return {
      promptKey: override.promptKey,
      category: override.category,
      question: override.question,
      isCustomEditing: false,
      isReanswer: true,
    };
  }
  const offset = shuffleDay === dayKey ? shuffleOffset : 0;
  const spec: WindowPromptSpec = pickDailyPrompt(dayKey, offset);
  return {
    promptKey: spec.key,
    category: spec.category,
    question: spec.question,
    isCustomEditing: false,
    isReanswer: false,
  };
}

export const useIdealStore = create<IdealStoreState>((set, get) => ({
  cards: [],
  reflections: [],
  loaded: false,
  loading: false,

  shuffleDay: "",
  shuffleOffset: 0,
  promptOverride: null,
  syncDiaryPref: readSyncDiaryPref(),
  themeFilter: "all",
  cardDialog: null,

  async ensureLoaded() {
    if (get().loaded) return;
    if (inflightLoad) return inflightLoad;
    set({ loading: true });
    inflightLoad = (async () => {
      try {
        const [cards, reflections] = await Promise.all([
          idealRepo.listCards(),
          idealRepo.listReflections(),
        ]);
        set({ cards, reflections, loaded: true, loading: false });
      } catch (e) {
        console.warn("[ideal] 載入理想手札失敗：", errMsg(e));
        set({ loading: false });
      } finally {
        inflightLoad = null;
      }
    })();
    return inflightLoad;
  },

  async reload() {
    try {
      const [cards, reflections] = await Promise.all([
        idealRepo.listCards(),
        idealRepo.listReflections(),
      ]);
      set({ cards, reflections, loaded: true });
    } catch (e) {
      console.warn("[ideal] 重載理想手札失敗：", errMsg(e));
    }
  },

  shufflePrompt(dayKey) {
    const cur = get();
    const base = cur.shuffleDay === dayKey ? cur.shuffleOffset : 0;
    set({
      shuffleDay: dayKey,
      shuffleOffset: base + 1,
      promptOverride: null,
    });
  },

  startCustomPrompt(initialQuestion = "") {
    set({ promptOverride: { mode: "custom", question: initialQuestion } });
  },

  setCustomPromptQuestion(question) {
    set({ promptOverride: { mode: "custom", question } });
  },

  startReanswer(target) {
    set({
      promptOverride: {
        mode: "reanswer",
        promptKey: target.promptKey,
        category: target.category,
        question: target.question,
      },
    });
  },

  clearPromptOverride() {
    set({ promptOverride: null });
  },

  setSyncDiaryPref(on) {
    writeSyncDiaryPref(on);
    set({ syncDiaryPref: on });
  },

  setThemeFilter(filter) {
    set({ themeFilter: filter });
  },

  openCreateCard(defaultTheme) {
    const cur = get().themeFilter;
    const fallback: IdealTheme = defaultTheme ?? (cur === "all" ? "person" : cur);
    set({ cardDialog: { mode: "create", defaultTheme: fallback } });
  },

  openEditCard(card) {
    set({ cardDialog: { mode: "edit", card } });
  },

  closeCardDialog() {
    set({ cardDialog: null });
  },

  async saveCard(input, editId) {
    try {
      let saved: IdealCardRow;
      if (editId) {
        saved = await idealRepo.updateCard(editId, {
          theme: input.theme,
          title: input.title,
          body: input.body ?? "",
          motto: input.motto ?? "",
          artPreset: input.artPreset,
          photoData: input.photoData ?? null,
          pinned: input.pinned,
        });
      } else {
        saved = await idealRepo.createCard(input);
      }
      await get().reload();
      toast(editId ? "已更新風景卡" : "已收進理想手札");
      return saved;
    } catch (e) {
      toast(errMsg(e));
      return null;
    }
  },

  async updateCardPatch(id, patch) {
    try {
      await idealRepo.updateCard(id, patch);
      await get().reload();
      return true;
    } catch (e) {
      toast(errMsg(e));
      return false;
    }
  },

  async deleteCard(id) {
    try {
      await idealRepo.deleteCard(id);
      await get().reload();
      toast("已移除風景卡", () => {
        void get().restoreCard(id);
      });
    } catch (e) {
      toast(errMsg(e));
    }
  },

  async restoreCard(id) {
    try {
      await idealRepo.restoreCard(id);
      await get().reload();
      toast("已復原風景卡");
    } catch (e) {
      toast(errMsg(e));
    }
  },

  async togglePin(target) {
    try {
      const cur = resolvePinnedMotto(get().cards, get().reflections);
      const isSame = cur !== null && cur.kind === target.kind && cur.id === target.id;
      await idealRepo.setPinned(isSame ? null : target);
      await get().reload();
      toast(isSame ? "已從今日頂端收起題詞" : "已釘選為今日頂端的「心之所向」");
    } catch (e) {
      toast(errMsg(e));
    }
  },

  async submitReflection(input) {
    const question = input.question.trim();
    const answer = input.answer.trim();
    if (!question) {
      toast("請先寫下想問自己的題目");
      return null;
    }
    if (!answer) {
      toast("寫下一兩句當下的想法再收進手札吧");
      return null;
    }

    let diaryNoteId: string | null = null;
    if (input.syncDiary) {
      const body = formatReflectionDiaryBody(question, answer);
      try {
        const created = await noteRepo.create({
          kind: "diary",
          body,
          title: "",
          inbox: false,
          entryDate: input.answeredOn,
        });
        diaryNoteId = created.id;
        try {
          await useTagStore.getState().syncNoteTags(created.id, body);
        } catch (tagErr) {
          console.warn("[ideal] 車窓の問い荷札同步失敗：", errMsg(tagErr));
        }
        await reloadNotesIfNeeded();
      } catch (noteErr) {
        console.warn("[ideal] 同步寫入日記失敗：", errMsg(noteErr));
      }
    }

    try {
      const row = await idealRepo.createReflection({
        promptKey: input.promptKey,
        category: input.category,
        question,
        answer,
        answeredOn: input.answeredOn,
        diaryNoteId,
        pinned: input.pinned,
      });
      set({ promptOverride: null });
      await get().reload();
      toast(diaryNoteId ? "已收進理想手札，並記進今日日記" : "已收進理想手札");
      return row;
    } catch (e) {
      toast(errMsg(e));
      return null;
    }
  },

  async updateReflection(id, patch) {
    try {
      const existing = await idealRepo.getReflection(id);
      if (!existing) {
        toast("找不到這則車窗問答");
        return false;
      }
      const nextQuestion = (patch.question ?? existing.question).trim();
      const nextAnswer = (patch.answer ?? existing.answer).trim();
      if (!nextQuestion) {
        toast("題目不能留白");
        return false;
      }
      if (!nextAnswer) {
        toast("回答內容不能留白");
        return false;
      }

      let nextDiaryNoteId = existing.diary_note_id;
      const body = formatReflectionDiaryBody(nextQuestion, nextAnswer);

      if (nextDiaryNoteId) {
        const aliveDiary = await noteRepo.getNote(nextDiaryNoteId).catch(() => null);
        if (aliveDiary) {
          try {
            await noteRepo.update(nextDiaryNoteId, { body });
            await useTagStore.getState().syncNoteTags(nextDiaryNoteId, body).catch(() => undefined);
            await reloadNotesIfNeeded();
          } catch (e) {
            console.warn("[ideal] 原地更新日記失敗：", errMsg(e));
          }
        } else if (patch.syncDiary) {
          nextDiaryNoteId = null;
        }
      }

      if (!nextDiaryNoteId && patch.syncDiary) {
        try {
          const created = await noteRepo.create({
            kind: "diary",
            body,
            title: "",
            inbox: false,
            entryDate: existing.answered_on,
          });
          nextDiaryNoteId = created.id;
          await useTagStore.getState().syncNoteTags(created.id, body).catch(() => undefined);
          await reloadNotesIfNeeded();
        } catch (e) {
          console.warn("[ideal] 補記進日記失敗：", errMsg(e));
        }
      }

      await idealRepo.updateReflection(id, {
        question: patch.question !== undefined ? nextQuestion : undefined,
        answer: patch.answer !== undefined ? nextAnswer : undefined,
        diaryNoteId: nextDiaryNoteId !== existing.diary_note_id ? nextDiaryNoteId : undefined,
      });
      await get().reload();
      toast("已更新這則車窗問答");
      return true;
    } catch (e) {
      toast(errMsg(e));
      return false;
    }
  },

  async deleteReflection(id) {
    try {
      await idealRepo.deleteReflection(id);
      await get().reload();
      toast("已移除這則車窗問答", () => {
        void get().restoreReflection(id);
      });
    } catch (e) {
      toast(errMsg(e));
    }
  },

  async restoreReflection(id) {
    try {
      await idealRepo.restoreReflection(id);
      await get().reload();
      toast("已復原這則車窗問答");
    } catch (e) {
      toast(errMsg(e));
    }
  },
}));
