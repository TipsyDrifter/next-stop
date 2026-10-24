/**
 * tagStore——荷札的狀態與動作（zustand；桌機與手機共用；旅客筆記車次③契約 §3.6）。
 *
 * Stage 0 定稿、之後只加不改：乙（桌機）丙（手機）只讀 store、呼叫動作。
 * 寫入一律：repo → loadIndex → toast（帶「復原」＝`tagRepo.undo(receipt)`）；失敗 toast 15。
 * 改名／刪除會改寫內文 ⇒ 先 `notesFlush`、退出正在編輯的那一則，做完重載筆記清單與日記（契約 0-14）。
 *
 * 契約外的增補（只加）：
 *   - `pendingPlan`／`cancelPending()`：改名撞名或併入時要確認的計畫（UI 用 `mergeConfirmText(pendingPlan)` 開確認框，
 *     確認＝`confirmRename()`、取消＝`cancelPending()`）；`mergeInto` 遇到要確認的也放這裡。
 *   - `nameOf(key)`：index 裡的顯示名（沒有＝key）。
 *   - 磨光③：`TagPickerState.title`（insert 模式標題，2-8）；`loadError`（載入失敗給重試，2-12）；
 *     `ensureBackfill` 補到 0 個不跳提示（2-14）。
 *   - UI 丙-6（☎-1）：`createTag(rawName)`＝荷札頁「＋ 新荷札」（桌機頁首小浮層、手機 MSheet 表單共用）。
 */
import { create } from "zustand";
import { tagRepo } from "../data/tagRepo";
import { settingsRepo } from "../data";
import { isEmptyReceipt, type AttachResult, type CreateTagResult, type TagEntityType, type TagReceipt } from "../data/tagRepository";
import {
  TAGS_BACKFILL_KEY,
  buildIndex,
  isUnder,
  keysOfEntity,
  parentOf,
  planDelete,
  planRename,
  setTagsToast,
  suggest as suggestPure,
  type DeletePlan,
  type RenamePlan,
  type SuggestOptions,
  type TagIndex,
  type TagSuggestResult,
} from "../domain/tags";
import type { LineReloadContext } from "../lines/types";
import { lineTagEntityTables } from "../lines/runtime";
import { notesFlush } from "../ui/notes/notesFlush";
import { useUiStore } from "./uiStore";
import { useNotesStore } from "./notesStore";

export interface TagBackRef {
  label: string;
  restore(): void;
}
export interface TagPickerState {
  mode: "entity" | "insert";
  /** entity 模式：要掛的實體；insert 模式：null */
  entityType: TagEntityType | null;
  entityId: string | null;
  name: string;
  /** insert 模式：選好的名稱交回（丙席把 `#name ` 插在游標處） */
  onInsert: ((names: string[]) => void) | null;
  /** 增補（磨光③ 2-8）：insert 模式的標題；沒給＝「插入荷札」（時刻表塊面板給「荷札・娛樂 23:20」） */
  title?: string;
}

export interface TagStore {
  /** buildIndex(source)；null＝還沒載 */
  index: TagIndex | null;
  loading: boolean;
  /** 增補（磨光③ 2-12）：最近一次 loadIndex 失敗的訊息；成功就清。`!index && loadError` ⇒ UI 給「荷札沒載入　重試」（重試＝loadIndex） */
  loadError: string | null;
  /** 荷札子畫面目前看的 key（null＝總覽） */
  selectedKey: string | null;
  /** 樹的展開狀態（桌機書封樹／手機樹共用一份：兩殼永不同時渲染） */
  openKeys: Record<string, 1>;
  treeFilter: string;
  /** 「‹ 回到剛才」（0-16） */
  back: TagBackRef | null;
  renaming: { key: string; draft: string } | null;
  /** D-筆-43 通車提示；null＝不顯示 */
  notice: { tags: number; places: number } | null;
  backfilling: boolean;
  /** 手機點選器（NotesMobileOverlay 畫） */
  picker: TagPickerState | null;
  /** 手機點選器「最近用過」（裝置本地；最多 6） */
  recent: string[];
  /** 增補：等確認的改名／併入計畫（rootConflict 或 conflicts 非空） */
  pendingPlan: RenamePlan | null;

  loadIndex(): Promise<void>;
  /** 0-10 守門；完成後 loadIndex；notice 依 seen */
  ensureBackfill(): Promise<void>;
  /** seen:1 */
  dismissNotice(): Promise<void>;
  /** 進荷札子畫面並選好（四個入口都走這裡）：await notesFlush → 桌機 setPage("notes")／手機 setMobileTab("notes") → setSection("tags") → selectedKey=key、展開祖先、back=back */
  openTagPage(key: string | null, back?: TagBackRef): Promise<void>;
  /** back.restore() 後清空 */
  goBack(): void;
  /** 樹裡點一個（清掉 back 與改名） */
  select(key: string | null): void;
  toggleOpen(key: string): void;
  setTreeFilter(q: string): void;
  /** 純函式包一層（讀 index）；預設不列虛資料夾、limit 8 */
  suggest(q: string, opts?: { exclude?: readonly string[]; includeVirtual?: boolean; limit?: number }): TagSuggestResult;
  /** 增補：index 裡的顯示名（沒有＝key） */
  nameOf(key: string): string;
  /** 增補：某實體目前掛的 keys（讀 index，不另查；側板與點選器用） */
  keysOf(entityType: TagEntityType, entityId: string): string[];

  /* 寫入（每支：repo → loadIndex → toast＋復原） */
  /**
   * UI 丙-6（☎-1）：單純建一個荷札（掛 0 處）→ loadIndex → 選中它（同 `select`：收起改名、清「回到剛才」、展開祖先）。
   * 新建（含復活）toast「已建立 #X」＋復原（復原後 loadIndex 自己把選取退回總覽）；本來就有 toast「已經有 #X 了」（只選中、不寫）。
   * 名稱不合法或寫入失敗 ⇒ toast 原因、回 null（UI 先用 normalizeName 擋，這裡是最後一道）。
   */
  createTag(rawName: string): Promise<CreateTagResult | null>;
  /** 失敗 toast 回 null；新建的才 toast 23；已存在的掛上不跳 */
  attach(entityType: TagEntityType, entityId: string, rawName: string): Promise<AttachResult | null>;
  /** toast 24＋復原 */
  detach(entityType: TagEntityType, entityId: string, key: string): Promise<void>;
  /** 手機點選器完成；toast 25＋復原；沒變動不 toast */
  setTags(entityType: TagEntityType, entityId: string, rawNames: readonly string[]): Promise<void>;
  /** 0-13 的呼叫點用；不 toast；只在 added/removed 非空時 loadIndex */
  syncNoteTags(noteId: string, body: string): Promise<void>;
  startRename(key: string): void;
  setRenameDraft(s: string): void;
  cancelRename(): void;
  /** planRename(index, key, draft)：不合法 ⇒ 不動（UI 顯示 reason）；rootConflict 或 conflicts 非空 ⇒ pendingPlan、回 "confirm"；否則直接做 */
  commitRename(): Promise<"done" | "confirm" | "invalid">;
  /** 做 pendingPlan：toast 26／27＋復原；改名後 selectedKey 換成新 key */
  confirmRename(): Promise<void>;
  /** 增補：關掉確認框（pendingPlan=null；改名列保持開著） */
  cancelPending(): void;
  /** 併入…：target 由建議清單挑（排除自己與子孫）；＝planRename(key, targetName)。要確認 ⇒ pendingPlan；虛資料夾搬家等不必確認 ⇒ 直接做 */
  mergeInto(key: string, targetKey: string): Promise<void>;
  /** 刪除：planDelete；桌機 askConfirm／手機確認 sheet 由 UI 開（文案 `deleteConfirmText`） */
  removePlan(key: string): DeletePlan | null;
  /** toast 28＋復原；selectedKey 退到父層或 null */
  confirmRemove(plan: DeletePlan): Promise<void>;
  openPicker(p: Omit<TagPickerState, "onInsert"> & { onInsert?: TagPickerState["onInsert"] }): void;
  closePicker(): void;
  /** changed ∋ tags|taggings|notes|nodes ⇒ loadIndex；wiped ⇒ 清 selectedKey/back/renaming/picker/pendingPlan */
  reload(ctx: LineReloadContext): Promise<void>;
}

/* ───────── 內部輔助 ───────── */

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e ?? "");
}
function toast(text: string, undo?: () => Promise<void>): void {
  useUiStore.getState().showToast(undo ? { message: text, actionLabel: "復原", onAction: () => void undo() } : { message: text });
}
/** toast 29＝車次② toast 15 的寫法 */
function failToast(e: unknown): void {
  console.warn("tagStore 寫入失敗", e);
  toast(message(e).trim() || "存檔失敗——請再試一次");
}
function safeUndo(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    try {
      await fn();
    } catch (e) {
      failToast(e);
    }
  };
}
/** 目前是不是手機殼（useShell 把 data-shell 同步到 <html>） */
function isMobileShell(): boolean {
  return typeof document !== "undefined" && document.documentElement.getAttribute("data-shell") === "mobile";
}
/** 祖先全部展開（不含自己） */
function withAncestors(open: Record<string, 1>, key: string): Record<string, 1> {
  const next = { ...open };
  for (let p = parentOf(key); p !== null; p = parentOf(p)) next[p] = 1;
  return next;
}
/** 內文被改寫之後：筆記清單、收件匣、日記（含記號）重載 */
async function reloadNoteViews(): Promise<void> {
  const n = useNotesStore.getState();
  await Promise.all([n.loadInbox(), n.loadNotes(), n.loadDiary(), n.loadMarks()]);
}
/** 批次改寫內文之前：存完正在打的字、退出編輯（契約 0-14） */
async function beforeBodyRewrite(): Promise<void> {
  await notesFlush.fn?.();
  const n = useNotesStore.getState();
  if (n.editing) n.setEditing(false);
  if (n.diaryEditingId) n.setDiaryEditing(null);
}

/** loadIndex 的序號：途中又被叫一次＝以後到的那一趟為準 */
let loadSeq = 0;
/** ensureBackfill 不可重入 */
let backfillRun: Promise<void> | null = null;

interface BackfillRecord {
  done: string;
  tags: number;
  places: number;
  seen: 0 | 1;
}
function parseRecord(raw: string | null): BackfillRecord | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<BackfillRecord>;
    return { done: String(v.done ?? ""), tags: Number(v.tags ?? 0), places: Number(v.places ?? 0), seen: v.seen === 1 ? 1 : 0 };
  } catch {
    return null;
  }
}

const EMPTY_SUGGEST: TagSuggestResult = { items: [], create: null, hint: null, browse: null };

export const useTagStore = create<TagStore>((set, get) => {
  /** 改名／併入真正落地 */
  async function runRename(plan: RenamePlan): Promise<void> {
    if (!plan.ok) return;
    let receipt: TagReceipt;
    try {
      await beforeBodyRewrite();
      receipt = await tagRepo.rename(plan);
    } catch (e) {
      failToast(e);
      return;
    }
    const sel = get().selectedKey;
    const moved = sel !== null && isUnder(sel, plan.oldKey) ? plan.newKey + sel.slice(plan.oldKey.length) : sel;
    set({ renaming: null, pendingPlan: null, selectedKey: moved, openKeys: moved ? withAncestors(get().openKeys, moved) : get().openKeys });
    await Promise.all([get().loadIndex(), plan.same ? Promise.resolve() : reloadNoteViews()]);
    if (isEmptyReceipt(receipt)) return;
    const text = plan.rootConflict
      ? `#${plan.oldName} 的 ${plan.ownCount} 處已併入 #${plan.rootConflict.name}`
      : `#${plan.oldName} 已改成 #${plan.newName}${plan.childCount ? `（含底下 ${plan.childCount} 個荷札）` : ""}`;
    toast(
      text,
      safeUndo(async () => {
        await beforeBodyRewrite();
        await tagRepo.undo(receipt);
        if (get().selectedKey === moved && moved !== sel) set({ selectedKey: sel });
        await Promise.all([get().loadIndex(), reloadNoteViews()]);
      }),
    );
  }

  return {
    index: null,
    loading: false,
    loadError: null,
    selectedKey: null,
    openKeys: {},
    treeFilter: "",
    back: null,
    renaming: null,
    notice: null,
    backfilling: false,
    picker: null,
    recent: [],
    pendingPlan: null,

    async loadIndex() {
      const seq = ++loadSeq;
      set({ loading: true });
      try {
        const [src, recent] = await Promise.all([tagRepo.loadIndexSource(), tagRepo.recentKeys()]);
        if (seq !== loadSeq) return;
        const index = buildIndex(src);
        const sel = get().selectedKey;
        set({ index, recent, loading: false, loadError: null, ...(sel !== null && !index.byKey[sel] ? { selectedKey: null } : {}) });
      } catch (e) {
        console.warn("tagStore.loadIndex 失敗", e);
        if (seq === loadSeq) set({ loading: false, loadError: message(e).trim() || "荷札沒載入" });
      }
    },

    ensureBackfill() {
      if (backfillRun) return backfillRun;
      backfillRun = (async () => {
        try {
          const rec = parseRecord(await settingsRepo.get(TAGS_BACKFILL_KEY));
          if (rec) {
            // 磨光③ 2-14（D-筆-67）：補到 0 個不跳「找到 0 個荷札」；舊記錄（seen:0、tags:0）順手記成看過
            set({ notice: rec.seen || rec.tags === 0 ? null : { tags: rec.tags, places: rec.places } });
            if (!rec.seen && rec.tags === 0) {
              void settingsRepo.set(TAGS_BACKFILL_KEY, JSON.stringify({ ...rec, seen: 1 })).catch(() => undefined);
            }
            if (!get().index) await get().loadIndex();
            // 自我修復（沙盒 §5-4）：記錄是這台本地的鍵、不跟快照走——還原一份荷札時代以前的快照後，
            // 記錄說「做過了」但 tags 是空的。一個荷札都沒有時就安靜再補一次（id 決定性、冪等；
            // 內文沒有 #荷札 時什麼都不寫）。刪荷札會連內文的字一起刪（D-筆-39），所以不會把刻意刪掉的長回來。
            const idx = get().index;
            if (idx && !Object.values(idx.byKey).some((x) => x.real)) {
              const res = await tagRepo.backfill();
              if (res.tagCount > 0) await get().loadIndex();
            }
            return;
          }
          set({ backfilling: true });
          const res = await tagRepo.backfill();
          // 0 個＝全新空庫：不跳提示、直接記看過（磨光③ 2-14）
          const none = res.tagCount === 0;
          const next: BackfillRecord = { done: new Date().toISOString(), tags: res.tagCount, places: res.placeCount, seen: none ? 1 : 0 };
          await settingsRepo.set(TAGS_BACKFILL_KEY, JSON.stringify(next));
          set({ backfilling: false, notice: none ? null : { tags: res.tagCount, places: res.placeCount } });
          await get().loadIndex();
        } catch (e) {
          console.warn("tagStore.ensureBackfill 失敗", e);
          set({ backfilling: false });
          backfillRun = null; // 失敗可以下次進頁再試
        }
      })();
      return backfillRun;
    },

    async dismissNotice() {
      set({ notice: null });
      try {
        const rec = parseRecord(await settingsRepo.get(TAGS_BACKFILL_KEY));
        const next: BackfillRecord = rec ? { ...rec, seen: 1 } : { done: new Date().toISOString(), tags: 0, places: 0, seen: 1 };
        await settingsRepo.set(TAGS_BACKFILL_KEY, JSON.stringify(next));
      } catch (e) {
        console.warn("tagStore.dismissNotice 失敗", e);
      }
    },

    async openTagPage(key, back) {
      await notesFlush.fn?.();
      const ui = useUiStore.getState();
      if (isMobileShell()) ui.setMobileTab("notes");
      else ui.setPage("notes");
      useNotesStore.getState().setSection("tags");
      set({
        selectedKey: key,
        back: back ?? null,
        renaming: null,
        pendingPlan: null,
        treeFilter: "",
        openKeys: key ? withAncestors(get().openKeys, key) : get().openKeys,
      });
      // 每次進頁都重載：本機刪車票／筆記不會通知 tagStore（真機代驗 10-15：刪票後仍寫「掛著 2 處」）
      await get().loadIndex();
    },

    goBack() {
      const b = get().back;
      set({ back: null });
      b?.restore();
    },

    select(key) {
      set({ selectedKey: key, back: null, renaming: null, pendingPlan: null, ...(key ? { openKeys: withAncestors(get().openKeys, key) } : {}) });
    },

    toggleOpen(key) {
      const open = { ...get().openKeys };
      if (open[key]) delete open[key];
      else open[key] = 1;
      set({ openKeys: open });
    },

    setTreeFilter: (q) => set({ treeFilter: q }),

    suggest(q, opts) {
      const idx = get().index;
      return idx ? suggestPure(idx, q, opts as SuggestOptions | undefined) : EMPTY_SUGGEST;
    },

    nameOf(key) {
      return get().index?.byKey[key]?.name ?? key;
    },

    keysOf(entityType, entityId) {
      const idx = get().index;
      return idx ? keysOfEntity(idx, entityType, entityId) : [];
    },

    async createTag(rawName) {
      let res: CreateTagResult;
      try {
        res = await tagRepo.create(rawName);
      } catch (e) {
        failToast(e);
        return null;
      }
      await get().loadIndex();
      get().select(res.key);
      if (res.created && !isEmptyReceipt(res.receipt)) {
        const receipt = res.receipt;
        toast(
          `已建立 #${res.name}`,
          safeUndo(async () => {
            await tagRepo.undo(receipt);
            await get().loadIndex();
          }),
        );
      } else toast(`已經有 #${res.name} 了`);
      return res;
    },

    async attach(entityType, entityId, rawName) {
      let res: AttachResult;
      try {
        res = await tagRepo.attach(entityType, entityId, rawName);
      } catch (e) {
        failToast(e);
        return null;
      }
      if (!res.already) void tagRepo.pushRecent(res.key).catch(() => undefined);
      await get().loadIndex();
      if (res.created && !res.already) {
        const receipt = res.receipt;
        toast(
          `建立並掛上 #${res.name}`,
          safeUndo(async () => {
            await tagRepo.undo(receipt);
            await get().loadIndex();
          }),
        );
      }
      return res;
    },

    async detach(entityType, entityId, key) {
      const name = get().nameOf(key);
      let receipt: TagReceipt;
      try {
        receipt = await tagRepo.detach(entityType, entityId, key);
      } catch (e) {
        failToast(e);
        return;
      }
      await get().loadIndex();
      if (isEmptyReceipt(receipt)) return;
      toast(
        `摘下 #${name}`,
        safeUndo(async () => {
          await tagRepo.undo(receipt);
          await get().loadIndex();
        }),
      );
    },

    async setTags(entityType, entityId, rawNames) {
      const before = new Set(get().keysOf(entityType, entityId));
      let res: { receipt: TagReceipt; created: string[] };
      try {
        res = await tagRepo.setTags(entityType, entityId, rawNames);
      } catch (e) {
        failToast(e);
        return;
      }
      await get().loadIndex();
      const after = new Set(get().keysOf(entityType, entityId));
      const added = [...after].filter((k) => !before.has(k));
      const removed = [...before].filter((k) => !after.has(k));
      for (const k of added) await tagRepo.pushRecent(k).catch(() => undefined);
      if (added.length) set({ recent: await tagRepo.recentKeys().catch(() => get().recent) });
      const text = setTagsToast(
        added.map((k) => get().nameOf(k)),
        removed.map((k) => get().nameOf(k)),
        res.created.length,
      );
      if (!text || isEmptyReceipt(res.receipt)) return;
      const receipt = res.receipt;
      toast(
        text,
        safeUndo(async () => {
          await tagRepo.undo(receipt);
          await get().loadIndex();
        }),
      );
    },

    async syncNoteTags(noteId, body) {
      try {
        const r = await tagRepo.syncBodyTags(noteId, body);
        if (r.added.length || r.removed.length) await get().loadIndex();
      } catch (e) {
        console.warn("tagStore.syncNoteTags 失敗", e);
      }
    },

    startRename(key) {
      set({ renaming: { key, draft: get().nameOf(key) }, pendingPlan: null });
    },
    setRenameDraft(s) {
      const r = get().renaming;
      if (r) set({ renaming: { ...r, draft: s } });
    },
    cancelRename: () => set({ renaming: null, pendingPlan: null }),

    async commitRename() {
      const r = get().renaming;
      const idx = get().index;
      if (!r || !idx) return "invalid";
      const plan = planRename(idx, r.key, r.draft);
      if (!plan.ok) return "invalid";
      if (plan.same && !plan.nameOnly) {
        set({ renaming: null });
        return "done";
      }
      if (plan.rootConflict || plan.conflicts.length) {
        set({ pendingPlan: plan });
        return "confirm";
      }
      await runRename(plan);
      return "done";
    },

    async confirmRename() {
      const plan = get().pendingPlan;
      if (!plan) return;
      await runRename(plan);
    },

    cancelPending: () => set({ pendingPlan: null }),

    async mergeInto(key, targetKey) {
      const idx = get().index;
      if (!idx) return;
      const plan = planRename(idx, key, get().nameOf(targetKey));
      if (!plan.ok) {
        toast(plan.reason);
        return;
      }
      if (plan.rootConflict || plan.conflicts.length) {
        set({ pendingPlan: plan });
        return;
      }
      await runRename(plan);
    },

    removePlan(key) {
      const idx = get().index;
      if (!idx) return null;
      const p = planDelete(idx, key);
      return p.ok ? p : null;
    },

    async confirmRemove(plan) {
      if (!plan.ok) return;
      let receipt: TagReceipt;
      try {
        await beforeBodyRewrite();
        receipt = await tagRepo.remove(plan);
      } catch (e) {
        failToast(e);
        return;
      }
      const sel = get().selectedKey;
      const fallback = parentOf(plan.key);
      set({ renaming: null, pendingPlan: null });
      await Promise.all([get().loadIndex(), reloadNoteViews()]);
      if (sel !== null && isUnder(sel, plan.key)) {
        const idx = get().index;
        set({ selectedKey: fallback !== null && idx?.byKey[fallback] ? fallback : null });
      }
      if (isEmptyReceipt(receipt)) return;
      toast(
        `已刪除 #${plan.name}${plan.childCount ? ` 和底下 ${plan.childCount} 個荷札` : ""}（內文也一併刪除）`,
        safeUndo(async () => {
          await beforeBodyRewrite();
          await tagRepo.undo(receipt);
          await Promise.all([get().loadIndex(), reloadNoteViews()]);
          if (sel !== null && get().index?.byKey[sel]) set({ selectedKey: sel });
        }),
      );
    },

    openPicker(p) {
      set({ picker: { ...p, onInsert: p.onInsert ?? null } });
      void tagRepo
        .recentKeys()
        .then((recent) => set({ recent }))
        .catch(() => undefined);
      if (!get().index) void get().loadIndex();
    },

    closePicker: () => set({ picker: null }),

    async reload(ctx) {
      if (ctx.wiped) {
        set({ selectedKey: null, back: null, renaming: null, picker: null, pendingPlan: null });
        backfillRun = null;
      }
      // 別線實體的表（時刻表⑥ 0-6 的 tagEntities.tables）也算：實體被刪或復活會改變荷札的計數；沒有任何線填＝原本四張
      const hit = ctx.wiped || ["tags", "taggings", "notes", "nodes", ...lineTagEntityTables()].some((t) => ctx.changed.includes(t));
      // 磨光③ 2-12：上次載入失敗、還沒有 index ⇒ 不論改了哪張表都順便再試一次（同步回來救）
      const retry = !get().index && get().loadError !== null;
      if (!retry && (!hit || (!get().index && !ctx.wiped))) return;
      await get().loadIndex();
    },
  };
});

/* 換頁（桌機）／換 tab（手機）離開旅客筆記＝「回到剛才」失效（契約 0-16） */
useUiStore.subscribe((s, prev) => {
  const leftDesktop = s.page !== prev.page && s.page !== "notes";
  const leftMobile = s.mobileTab !== prev.mobileTab && s.mobileTab !== "notes";
  if ((leftDesktop || leftMobile) && useTagStore.getState().back) useTagStore.setState({ back: null });
});
