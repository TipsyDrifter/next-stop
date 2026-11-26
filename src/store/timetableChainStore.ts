/**
 * timetableChainStore——時刻表行為鏈（計時模板）的狀態調度層。
 *
 * - 透過 `useTimetableStore.getState()` 驅動發車（`depart`）與到站（`arrive`），不修改 `timetableStore.ts`。
 * - 當前進行中的行為鏈（`active`）輕量同步至 `localStorage`，重開視窗若原班次仍在跑即自動恢復進度，
 *   若原班次已被停止或切換至其他時間塊則自動清空。
 */
import { create } from "zustand";
import { leafCategories } from "../domain/timetable";
import {
  normalizeChainStep,
  resolveStepTitle,
  type ActiveChainState,
  type TimeChainRow,
  type TimeChainStep,
} from "../domain/timetableChain";
import {
  timetableChainRepo,
  type CreateTimeChainInput,
  type UpdateTimeChainPatch,
} from "../data/timetableChainRepo";
import { timetableRepo } from "../data/timetableRepository";
import type { LineReloadContext } from "../lines/types";
import { useTimetableStore } from "./timetableStore";
import { useUiStore } from "./uiStore";

const ACTIVE_STORAGE_KEY = "nextstop:active-time-chain";

function readStoredActive(): ActiveChainState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(ACTIVE_STORAGE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (!obj || typeof obj !== "object") return null;
    const chainId = typeof obj.chainId === "string" ? obj.chainId : "";
    const chainName = typeof obj.chainName === "string" ? obj.chainName : "";
    const stepIndex = typeof obj.stepIndex === "number" && Number.isInteger(obj.stepIndex) ? obj.stepIndex : -1;
    const runningBlockId = typeof obj.runningBlockId === "string" ? obj.runningBlockId : null;
    const rawSteps = Array.isArray(obj.steps) ? obj.steps : [];
    const steps: TimeChainStep[] = [];
    for (const s of rawSteps) {
      const norm = normalizeChainStep(s);
      if (norm) steps.push(norm);
    }
    if (!chainId || !chainName || steps.length === 0 || stepIndex < 0 || stepIndex >= steps.length) {
      return null;
    }
    return { chainId, chainName, steps, stepIndex, runningBlockId };
  } catch {
    return null;
  }
}

function writeStoredActive(active: ActiveChainState | null): void {
  if (typeof window === "undefined") return;
  try {
    if (!active) window.localStorage.removeItem(ACTIVE_STORAGE_KEY);
    else window.localStorage.setItem(ACTIVE_STORAGE_KEY, JSON.stringify(active));
  } catch {
    // 隱私瀏覽或空間滿時忽略持久化錯誤
  }
}

function showToast(message: string, opts?: { sub?: string; actionLabel?: string; onAction?: () => void }): void {
  useUiStore.getState().showToast({ message, ...opts });
}

function showError(e: unknown): void {
  showToast(e instanceof RangeError ? e.message : "操作失敗——請再試一次");
}

function resolveCategoryForStep(step: TimeChainStep): {
  categoryId: string;
  categoryName: string;
  fallbackUsed: boolean;
} | null {
  const { categories, catById } = useTimetableStore.getState();
  const leaves = leafCategories(categories);
  if (leaves.length === 0) return null;

  const exact = catById[step.categoryId];
  if (exact && exact.deleted_at === null && exact.archived_at === null && exact.parent_id !== null) {
    return { categoryId: exact.id, categoryName: exact.name, fallbackUsed: false };
  }
  const first = leaves[0];
  return { categoryId: first.id, categoryName: first.name, fallbackUsed: true };
}

/**
 * 發車後將步驟附帶的備註與地點寫入剛啟動的時間塊（不重覆跳 toast）。
 */
async function applyStepBlockMetadata(blockId: string, step: TimeChainStep, categoryName: string): Promise<void> {
  const explicitNote = step.note?.trim();
  const label = step.label?.trim();
  const noteToWrite = explicitNote || (label && label !== categoryName ? label : "");
  const locationToWrite = step.location?.trim() || "";
  if (!noteToWrite && !locationToWrite) return;

  const running = useTimetableStore.getState().running;
  if (!running || running.id !== blockId) return;

  try {
    await timetableRepo.editRunning(blockId, {
      categoryId: running.category_id,
      startIso: running.started_at,
      ...(noteToWrite ? { note: noteToWrite } : {}),
      ...(locationToWrite ? { location: locationToWrite } : {}),
    });
    await useTimetableStore.getState().refresh();
  } catch (e) {
    console.warn("[timetableChainStore] 寫入行為鏈步驟備註／地點失敗", e);
  }
}

/** 啟動／切站進行中鎖定旗標，防止中途被 running 訂閱誤清 */
let transitioning = false;
let loadInFlight: Promise<void> | null = null;

export interface TimetableChainStore {
  chains: TimeChainRow[];
  loaded: boolean;
  loading: boolean;
  active: ActiveChainState | null;
  /** 從發車台等入口直接要求「分類與設定」打開行為鏈分頁（無須修改 timetableStore.ts） */
  pendingOpenManager: boolean;

  loadChains(): Promise<void>;
  reloadChains(): Promise<void>;
  reload(ctx: LineReloadContext): Promise<void>;

  createChain(input: CreateTimeChainInput): Promise<TimeChainRow | null>;
  updateChain(id: string, patch: UpdateTimeChainPatch): Promise<TimeChainRow | null>;
  archiveChain(id: string): Promise<boolean>;
  restoreChain(id: string): Promise<boolean>;
  deleteChain(id: string): Promise<boolean>;
  reorderChains(orderedIds: readonly string[]): Promise<void>;

  startChain(chainId: string): Promise<boolean>;
  advanceChainStep(): Promise<void>;
  exitChain(): void;

  /** 依當前 `useTimetableStore.running` 核對並同步 `active` 狀態 */
  reconcileActive(): void;
  /** 打開「分類與設定」並切至「行為鏈」分頁 */
  openChainsManager(): void;
  consumePendingOpenManager(): boolean;
}

export const useTimetableChainStore = create<TimetableChainStore>((set, get) => {
  const setActive = (next: ActiveChainState | null): void => {
    writeStoredActive(next);
    set({ active: next });
  };

  return {
    chains: [],
    loaded: false,
    loading: false,
    active: readStoredActive(),
    pendingOpenManager: false,

    async loadChains() {
      if (get().loaded) {
        get().reconcileActive();
        return;
      }
      if (loadInFlight) return loadInFlight;
      set({ loading: true });
      loadInFlight = timetableChainRepo
        .listChains()
        .then((chains) => {
          set({ chains, loaded: true, loading: false });
          get().reconcileActive();
        })
        .catch((e) => {
          console.warn("[timetableChainStore] 載入行為鏈失敗", e);
          set({ loading: false });
        })
        .finally(() => {
          loadInFlight = null;
        });
      return loadInFlight;
    },

    async reloadChains() {
      set({ loading: true });
      try {
        const chains = await timetableChainRepo.listChains();
        set({ chains, loaded: true, loading: false });
        get().reconcileActive();
      } catch (e) {
        console.warn("[timetableChainStore] 重載行為鏈失敗", e);
        set({ loading: false });
      }
    },

    async reload(ctx) {
      if (ctx.wiped) {
        setActive(null);
        set({ chains: [], loaded: false });
        await get().reloadChains();
        return;
      }
      if (ctx.changed.includes("time_chains")) {
        await get().reloadChains();
      } else {
        get().reconcileActive();
      }
    },

    async createChain(input) {
      try {
        const created = await timetableChainRepo.createChain(input);
        await get().reloadChains();
        showToast(`已建立行為鏈「${created.name}」`);
        return created;
      } catch (e) {
        showError(e);
        return null;
      }
    },

    async updateChain(id, patch) {
      try {
        const updated = await timetableChainRepo.updateChain(id, patch);
        await get().reloadChains();
        // 若正在執行的正是這條行為鏈，同步更新名稱
        const cur = get().active;
        if (cur && cur.chainId === id && cur.chainName !== updated.name) {
          setActive({ ...cur, chainName: updated.name });
        }
        return updated;
      } catch (e) {
        showError(e);
        return null;
      }
    },

    async archiveChain(id) {
      const target = get().chains.find((c) => c.id === id);
      try {
        await timetableChainRepo.archiveChain(id);
        await get().reloadChains();
        showToast(`已封存「${target?.name ?? "行為鏈"}」`, {
          actionLabel: "復原",
          onAction: () => void get().restoreChain(id),
        });
        return true;
      } catch (e) {
        showError(e);
        return false;
      }
    },

    async restoreChain(id) {
      const target = get().chains.find((c) => c.id === id);
      try {
        await timetableChainRepo.restoreChain(id);
        await get().reloadChains();
        if (target) showToast(`已還原「${target.name}」`);
        return true;
      } catch (e) {
        showError(e);
        return false;
      }
    },

    async deleteChain(id) {
      const target = get().chains.find((c) => c.id === id);
      try {
        await timetableChainRepo.deleteChain(id);
        await get().reloadChains();
        showToast(`已刪除「${target?.name ?? "行為鏈"}」`, {
          actionLabel: "復原",
          onAction: () => void get().restoreChain(id),
        });
        return true;
      } catch (e) {
        showError(e);
        return false;
      }
    },

    async reorderChains(orderedIds) {
      try {
        await timetableChainRepo.reorderChains(orderedIds);
        await get().reloadChains();
      } catch (e) {
        showError(e);
      }
    },

    async startChain(chainId) {
      if (transitioning) return false;
      if (!get().loaded) await get().loadChains();
      const chain = get().chains.find((c) => c.id === chainId);
      if (!chain || chain.steps.length === 0) {
        showToast("找不到可發車的行為鏈步驟");
        return false;
      }

      const firstStep = chain.steps[0];
      const resolved = resolveCategoryForStep(firstStep);
      if (!resolved) {
        showToast("尚未建立可用分類，請先到分類與設定新增分類");
        return false;
      }

      transitioning = true;
      try {
        await useTimetableStore.getState().depart(resolved.categoryId, Date.now(), firstStep.estimateMin, null);
        const running = useTimetableStore.getState().running;
        if (!running) {
          return false;
        }

        await applyStepBlockMetadata(running.id, firstStep, resolved.categoryName);

        const nextActive: ActiveChainState = {
          chainId: chain.id,
          chainName: chain.name,
          steps: chain.steps.map((s) => ({ ...s })),
          stepIndex: 0,
          runningBlockId: running.id,
        };
        setActive(nextActive);

        const stepTitle = resolveStepTitle(firstStep, resolved.categoryName);
        showToast(`行為鏈「${chain.name}」発車・1/${chain.steps.length} ${stepTitle}`, {
          sub: resolved.fallbackUsed ? `原分類已封存或刪除，改以「${resolved.categoryName}」発車` : undefined,
        });
        return true;
      } catch (e) {
        showError(e);
        return false;
      } finally {
        transitioning = false;
      }
    },

    async advanceChainStep() {
      if (transitioning) return;
      const cur = get().active;
      if (!cur) return;

      const isLast = cur.stepIndex >= cur.steps.length - 1;
      transitioning = true;
      try {
        if (isLast) {
          await useTimetableStore.getState().arrive();
          setActive(null);
          showToast(`行為鏈「${cur.chainName}」已全部抵達終點！`);
          return;
        }

        const nextIndex = cur.stepIndex + 1;
        const nextStep = cur.steps[nextIndex];
        const resolved = resolveCategoryForStep(nextStep);
        if (!resolved) {
          showToast("找不到可用分類，請先檢查分類設定");
          return;
        }

        // `timetableStore.depart` 底層 `planDepart` 會自動結束當前運行中時間塊並無縫切換至下一班
        await useTimetableStore.getState().depart(resolved.categoryId, Date.now(), nextStep.estimateMin, null);
        const running = useTimetableStore.getState().running;
        if (!running) {
          setActive(null);
          return;
        }

        await applyStepBlockMetadata(running.id, nextStep, resolved.categoryName);

        const updated: ActiveChainState = {
          ...cur,
          stepIndex: nextIndex,
          runningBlockId: running.id,
        };
        setActive(updated);

        const stepTitle = resolveStepTitle(nextStep, resolved.categoryName);
        showToast(`行為鏈「${cur.chainName}」・${nextIndex + 1}/${cur.steps.length} ${stepTitle}`, {
          sub: resolved.fallbackUsed ? `原分類已封存或刪除，改以「${resolved.categoryName}」発車` : undefined,
        });
      } catch (e) {
        showError(e);
      } finally {
        transitioning = false;
      }
    },

    exitChain() {
      if (!get().active) return;
      setActive(null);
      showToast("已脫離行為鏈（目前計時繼續運行）");
    },

    reconcileActive() {
      if (transitioning) return;
      const cur = get().active;
      if (!cur) return;
      const tt = useTimetableStore.getState();
      if (!tt.ready) return;
      if (!tt.running || (cur.runningBlockId !== null && tt.running.id !== cur.runningBlockId)) {
        setActive(null);
      }
    },

    openChainsManager() {
      set({ pendingOpenManager: true });
      useTimetableStore.getState().openSheet({ kind: "categories" });
    },

    consumePendingOpenManager() {
      if (!get().pendingOpenManager) return false;
      set({ pendingOpenManager: false });
      return true;
    },
  };
});

// 訂閱時刻表運行狀態：重開視窗或別處停車／換車時自動同步行為鏈進度
useTimetableStore.subscribe((state, prev) => {
  if (state.ready && !prev.ready) {
    void useTimetableChainStore.getState().loadChains();
  }
  if (state.ready && state.running?.id !== prev.running?.id) {
    useTimetableChainStore.getState().reconcileActive();
  }
});
