/**
 * lostFoundStore——失物招領的畫面狀態（第五本第二梯 ⑦；契約 `docs/research/2026-11-04-主線-失物招領-契約.md` §2.5、§3.2、§3.5）。
 *
 * 兩塊，兩殼共用一份：
 *   最近刪除：`items`＋搜尋與分類、`pickUp`（撿回一刀）。
 *   從雲端備份撿回：`rescue`（現在在「挑一份」還是「看一份」）、`snapshot`／`diff`、`pickUpFromSnapshot`、`revert`／`undoRevert`。
 *
 * 撿回的三種分支都在這裡（畫面只負責把列交進來）：
 *   時間塊先 `previewCover`，會蓋到別塊就先問；回 `needsParent` 就問要不要連上層；回 `placedAsLoose` 由 toast 講放到臨時車票。
 * 寫入成功走 `refreshAfterPull`，跟同步拉到東西、外部助理寫入同一條重載（畫面、印章、告示都跟上）。
 * 快照畫面開著時，每次撿回與每次重載後都重算差異（`mergeSnapshotDiff`）：清單跟現況一致，已撿回、已改回的打勾留著（對抗審查問題 2）。
 * 「打開」要用的跳轉在 UI 層（`ui/settings/lostFoundOpen.ts`，會 import 頁面元件），由呼叫端帶進來：本檔只管要不要掛這個動作。
 */
import { create } from "zustand";
import { lostFoundRepo } from "../data/lostFoundRepo";
import type { RevertReceipt, LostRestoreResult } from "../data/lostFoundRepository";
import type { SnapshotEntry } from "../data/syncRepository";
import {
  LOST_NO_BACKFILL,
  RESCUE_TABLES,
  lostAlreadyHereToast,
  lostParentConfirm,
  lostRestoredToast,
  lostSubline,
  mergeSnapshotDiff,
  type ChangedItem,
  type CloudSnapshot,
  type LostCategory,
  type LostItem,
  type LostParentInfo,
  type SnapshotDiff,
  type SnapshotItem,
} from "../domain/lostFound";
import type { CoverSummary } from "../domain/timetable";
import { onAfterPull, refreshAfterPull, useSyncStore } from "./syncStore";
import { TT_TEXT } from "./timetableStore";
import { useUiStore } from "./uiStore";

/** 分類 chip：全部＋四類 */
export type LostCat = "all" | LostCategory;

export type RescueView = { view: "pick" } | { view: "snap"; entry: SnapshotEntry; fromPick: boolean };

/** 帶「打開」動作的辦法（UI 層給；這種東西跳不到就回 null） */
export type LostOpener = (item: Pick<LostItem, "kind" | "table" | "id">) => (() => void) | null;

/** 列名太長時 toast 只留前面（toast 兩行就省略，但「」要收得起來） */
const TOAST_TITLE_MAX = 16;
function shortTitle(title: string): string {
  const chars = [...title];
  return chars.length > TOAST_TITLE_MAX ? `${chars.slice(0, TOAST_TITLE_MAX - 2).join("")}…` : title;
}

function messageOf(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : "發生了一點問題，再試一次。";
}

/** 比對用的搜尋：種類、名稱、補充字（列上看得到的字都算） */
export function lostMatches(item: Pick<LostItem, "kind" | "kindLabel" | "title" | "detail" | "childCount" | "category">, q: string, cat: LostCat): boolean {
  if (cat !== "all" && item.category !== cat) return false;
  const t = q.trim().toLowerCase();
  if (!t) return true;
  return `${item.kindLabel} ${item.title} ${lostSubline(item) ?? ""}`.toLowerCase().includes(t);
}

export function changedMatches(item: ChangedItem, q: string, cat: LostCat): boolean {
  if (cat !== "all" && item.category !== cat) return false;
  const t = q.trim().toLowerCase();
  if (!t) return true;
  return `${item.kindLabel} ${item.title}`.toLowerCase().includes(t);
}

/** 撿回可能動到的表：列車帶日誌與班次、帳帶帳戶與分類…… 手動的偶發動作，整組重載一次沒關係 */
const reloadAll = (): Promise<void> =>
  refreshAfterPull({ changed_tables: [...RESCUE_TABLES] }).catch((e) => console.warn("[lost-found] 重載失敗：", e));

const reloadCompared = (): Promise<void> =>
  refreshAfterPull({ changed_tables: ["notes", "nodes", "tags", "taggings"] }).catch((e) => console.warn("[lost-found] 重載失敗：", e));

/** 列滑出的時間（ms；同 .lf-row 的 --dur） */
const LEAVE_MS = 180;
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface LostFoundState {
  /* 最近刪除 */
  /** null＝還沒讀到（畫面留白，不閃空狀態） */
  items: LostItem[] | null;
  listError: string | null;
  q: string;
  cat: LostCat;
  /** 正在撿回的列 key（那一顆鈕停用） */
  pending: string | null;
  /** 正在滑出的列 */
  leaving: string | null;

  /* 從雲端備份撿回 */
  rescue: RescueView | null;
  snapshot: CloudSnapshot | null;
  diff: SnapshotDiff | null;
  snapError: string | null;
  snapQ: string;
  snapCat: LostCat;
  /** 已撿回的列 key（留在畫面上打勾） */
  picked: Readonly<Record<string, true>>;
  /** 已改回的列 key → 收據（復原用） */
  reverted: Readonly<Record<string, RevertReceipt>>;
  /** 內容不同展開哪一列 */
  openDiff: string | null;

  load(): Promise<void>;
  setQ(q: string): void;
  setCat(cat: LostCat): void;
  pickUp(item: LostItem, opener: LostOpener): Promise<void>;

  /** 開「先挑一份」（最近刪除底部的「更早的？」；快照畫面的「換一份」） */
  openPick(): void;
  /** 開一份快照（`fromPick`＝從挑一份進來，返回要回去） */
  openSnapshot(entry: SnapshotEntry, fromPick: boolean): void;
  /** 再讀一次目前這份（讀失敗的重試） */
  retrySnapshot(): void;
  /** 手機左上「返回」：看一份 → 挑一份（從那裡來的話）→ 關 */
  backRescue(): void;
  closeRescue(): void;
  /** 快照畫面開著就重算差異（同步拉到東西、外部助理寫入之後） */
  refreshDiffNow(): void;
  setSnapQ(q: string): void;
  setSnapCat(cat: LostCat): void;
  toggleDiff(key: string): void;
  pickUpFromSnapshot(item: SnapshotItem, opener: LostOpener): Promise<void>;
  revert(item: ChangedItem): Promise<void>;
}

/** 過期的快照回應丟掉（換一份、關畫面之後才回來的） */
let snapReq = 0;

export const useLostFoundStore = create<LostFoundState>((set, get) => {
  /** 「會蓋到別塊」要先問；沒蓋到直接做 */
  const withCoverCheck = (item: { table: string; id: string; title: string }, cover: CoverSummary | null, go: () => void) => {
    const warn = cover ? TT_TEXT.cover(cover) : "";
    if (!warn) {
      go();
      return;
    }
    useUiStore.getState().askConfirm({
      title: `撿回「${shortTitle(item.title)}」`,
      body: `這段時間後來記了別的，撿回${warn}。`,
      confirmLabel: "撿回",
      onConfirm: go,
    });
  };

  const askParent = (title: string, parent: LostParentInfo, go: () => void) => {
    useUiStore.getState().askConfirm({
      title: `撿回「${shortTitle(title)}」`,
      body: lostParentConfirm(parent.name),
      confirmLabel: "一起撿回",
      onConfirm: go,
    });
  };

  const toastFor = (item: Pick<LostItem, "title" | "kind" | "table" | "id">, res: LostRestoreResult, parent: LostParentInfo | null, opener: LostOpener) => {
    const title = shortTitle(item.title);
    const message = res.alreadyHere
      ? lostAlreadyHereToast(title, res.filled ?? 0)
      : parent
        ? `已撿回「${title}」和它的上層`
        : lostRestoredToast(title, res);
    const open = opener(item);
    const sub = res.cover ? TT_TEXT.paintCoverSub(res.cover, false) : res.noBackfill ? LOST_NO_BACKFILL : "";
    useUiStore.getState().showToast({
      message,
      ...(sub ? { sub } : {}),
      ...(open ? { actionLabel: "打開", onAction: open } : {}),
    });
  };

  const fail = (e: unknown) => useUiStore.getState().showToast({ message: `撿回失敗：${messageOf(e)}` });

  /** 一次撿回（最近刪除）：先寫 → 問過要不要帶上層 → 列滑出 → 重載 → toast */
  const restoreOne = async (item: LostItem, opener: LostOpener, withParent: boolean, parent: LostParentInfo | null): Promise<void> => {
    set({ pending: item.key });
    try {
      const res = await lostFoundRepo.restore(item, withParent ? { withParent: true } : undefined);
      if (res.needsParent) {
        const need = res.needsParent;
        set({ pending: null });
        askParent(item.title, need, () => void restoreOne(item, opener, true, need));
        return;
      }
      set({ leaving: item.key });
      await wait(LEAVE_MS);
      await get().load();
      set({ pending: null, leaving: null });
      await reloadAll();
      toastFor(item, res, parent, opener);
    } catch (e) {
      set({ pending: null, leaving: null });
      fail(e);
    }
  };

  /** 重算差異、接回打勾。sweep＝這一次撿回順手帶回的列也打勾 */
  const refreshDiff = async (opts?: { sweep?: boolean }): Promise<void> => {
    const snapshot = get().snapshot;
    if (!snapshot) return;
    const id = snapReq;
    const next = await lostFoundRepo.diffSnapshot(snapshot);
    if (id !== snapReq) return;
    const s = get();
    set(mergeSnapshotDiff(s.diff, next, s.picked, s.reverted, opts));
  };

  /** 一次撿回（快照）：列打勾、留在畫面上可繼續撿 */
  const rescueOne = async (item: SnapshotItem, opener: LostOpener, withParent: boolean, parent: LostParentInfo | null): Promise<void> => {
    const snapshot = get().snapshot;
    if (!snapshot) return;
    set({ pending: item.key });
    try {
      const res = await lostFoundRepo.rescue(snapshot, item, withParent ? { withParent: true } : undefined);
      if (res.needsParent) {
        const need = res.needsParent;
        set({ pending: null });
        askParent(item.title, need, () => void rescueOne(item, opener, true, need));
        return;
      }
      // 這一筆撿回的同種列（子樹裡也列在清單上的）一起打勾；連上層時上層那一列也是。
      // 「已經在了」：目標沒寫，不打勾（重算後它自己會從清單消失），只有補回的子節點算撿回
      const done: Record<string, true> = { ...get().picked };
      for (const id of item.ids) done[`${item.table}:${id}`] = true;
      if (parent) done[`${item.table}:${parent.id}`] = true;
      if (res.alreadyHere) delete done[item.key];
      else done[item.key] = true;
      set({ picked: done });
      await refreshDiff({ sweep: !res.alreadyHere }).catch((e) => console.warn("[lost-found] 重算差異失敗：", e));
      set({ pending: null });
      await reloadAll();
      toastFor(item, res, parent, opener);
    } catch (e) {
      set({ pending: null });
      fail(e);
    }
  };

  const readSnap = (entry: SnapshotEntry) => {
    const id = ++snapReq;
    set({ snapshot: null, diff: null, snapError: null, snapQ: "", snapCat: "all", picked: {}, reverted: {}, openDiff: null, pending: null });
    void (async () => {
      try {
        const snapshot = await lostFoundRepo.readSnapshot(entry.key);
        const diff = await lostFoundRepo.diffSnapshot(snapshot);
        if (id === snapReq) set({ snapshot, diff });
      } catch (e) {
        if (id === snapReq) set({ snapError: messageOf(e) });
      }
    })();
  };

  return {
    items: null,
    listError: null,
    q: "",
    cat: "all",
    pending: null,
    leaving: null,
    rescue: null,
    snapshot: null,
    diff: null,
    snapError: null,
    snapQ: "",
    snapCat: "all",
    picked: {},
    reverted: {},
    openDiff: null,

    async load() {
      try {
        set({ items: await lostFoundRepo.list(Date.now()), listError: null });
      } catch (e) {
        set({ listError: messageOf(e) });
      }
    },
    setQ: (q) => set({ q }),
    setCat: (cat) => set({ cat }),

    async pickUp(item, opener) {
      if (get().pending) return;
      set({ pending: item.key });
      try {
        const cover = item.table === "time_blocks" ? await lostFoundRepo.previewCover(item) : null;
        set({ pending: null });
        withCoverCheck(item, cover, () => void restoreOne(item, opener, false, null));
      } catch (e) {
        set({ pending: null });
        fail(e);
      }
    },

    openPick() {
      snapReq++;
      set({ rescue: { view: "pick" }, snapshot: null, diff: null, snapError: null });
      void useSyncStore.getState().refreshCloudSnapshots();
    },
    openSnapshot(entry, fromPick) {
      set({ rescue: { view: "snap", entry, fromPick } });
      readSnap(entry);
    },
    retrySnapshot() {
      const r = get().rescue;
      if (r?.view === "snap") readSnap(r.entry);
    },
    backRescue() {
      const r = get().rescue;
      if (r?.view === "snap" && r.fromPick) get().openPick();
      else get().closeRescue();
    },
    closeRescue() {
      if (!get().rescue) return;
      snapReq++;
      set({ rescue: null, snapshot: null, diff: null, snapError: null, picked: {}, reverted: {}, openDiff: null, pending: null });
      // 撿回過的東西不再算「最近刪除」
      void get().load();
    },
    refreshDiffNow() {
      // 撿回進行中由那一支自己算（它要順手打勾）
      if (!get().snapshot || get().pending) return;
      void refreshDiff().catch((e) => console.warn("[lost-found] 重算差異失敗：", e));
    },
    setSnapQ: (snapQ) => set({ snapQ }),
    setSnapCat: (snapCat) => set({ snapCat }),
    toggleDiff: (key) => set({ openDiff: get().openDiff === key ? null : key }),

    async pickUpFromSnapshot(item, opener) {
      const snapshot = get().snapshot;
      if (!snapshot || get().pending) return;
      set({ pending: item.key });
      try {
        const cover = item.table === "time_blocks" ? await lostFoundRepo.previewCover(item, snapshot) : null;
        set({ pending: null });
        withCoverCheck(item, cover, () => void rescueOne(item, opener, false, null));
      } catch (e) {
        set({ pending: null });
        fail(e);
      }
    },

    async revert(item) {
      if (get().pending) return;
      set({ pending: item.key });
      try {
        const receipt = await lostFoundRepo.revertToSnapshot(item);
        set({ pending: null, openDiff: null, reverted: { ...get().reverted, [item.key]: receipt } });
        await reloadCompared();
        useUiStore.getState().showToast({
          message: "已改回",
          actionLabel: "復原",
          onAction: () => {
            void (async () => {
              try {
                await lostFoundRepo.undoRevert(receipt);
                const { [item.key]: _gone, ...rest } = get().reverted;
                set({ reverted: rest, openDiff: item.key });
                await reloadCompared();
              } catch (e) {
                useUiStore.getState().showToast({ message: `復原失敗：${messageOf(e)}` });
              }
            })();
          },
        });
      } catch (e) {
        set({ pending: null });
        useUiStore.getState().showToast({ message: `改回失敗：${messageOf(e)}` });
      }
    },
  };
});

onAfterPull(() => useLostFoundStore.getState().refreshDiffNow());
