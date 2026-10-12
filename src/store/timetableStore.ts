/**
 * timetableStore——時刻表線的畫面狀態與流程（車次①a 契約 §3.7、§3.8；甲席 Stage 0）。
 *
 * **UI 只讀 store、只叫 store 的動作，不直接碰 repository**（契約 §2.6-3）。
 *
 * - serial 佇列：每個寫入與 `reconcile` 都排進 `chain`，保證不交錯（repository 每支都先讀現況再算）。
 * - 時間：store 動作收毫秒，轉 ISO 給 repo；`now = Date.now()` 在動作開頭取一次。
 * - 錯誤：寫入失敗 toast（RangeError 吐它的 message；其他吐「存檔失敗——請再試一次」），不寫 `error`；
 *   `error` 只給 `init`／`refresh` 載入失敗（nodeStore 的教訓）。
 * - 設定三把 key：`timetable_long_run_max_min`（同步）、`timetable_view`／`timetable_notice`（本地）。
 * - toast 全文（契約 §5.10）集中在 `TT_TEXT`；固定文案（§5.11）給 UI 用的也放這裡。
 */
import { create } from "zustand";
import { timetableRepo } from "../data/timetableRepository";
import { settingsRepo, MOCK_MODE } from "../data";
import { useUiStore } from "./uiStore";
import { useSyncStore } from "./syncStore";
import { addDays, dayWindow, todayKey } from "../lib/date";
import type { LineReloadContext } from "../lines/types";
import {
  MIN,
  currentRunning,
  fmtClock,
  fmtDur,
  isLongRun,
  isoOf,
  longRunThreshold,
  msOf,
  toSpan,
  weekStartKey,
  type CoverSummary,
  type LongRunChoice,
  type TimeBlockRow,
  type TimeCategoryRow,
} from "../domain/timetable";

export const KEY_LONG_RUN_MAX = "timetable_long_run_max_min"; // 同步（manifest syncSettingsKeys）
export const KEY_VIEW = "timetable_view"; // 本地
export const KEY_NOTICE = "timetable_notice"; // 本地："0"＝關；沒有列＝開
export const LONG_RUN_MAX_DEFAULT = 840; // 14 小時；0＝關

export type TimetableView = "board" | "axis" | "split"; // 手機 board|axis；桌機 split|axis（契約 0-6）
export type TimetableShell = "desktop" | "mobile";

export type TimetableSheet =
  | { kind: "depart" }
  | { kind: "longRun"; blockId: string; then: "depart" | "arrive" | { tile: string } | null }
  | { kind: "restart"; blockId: string }
  | { kind: "fill"; start: number; end: number }
  | { kind: "edit"; blockId: string }
  | { kind: "split"; blockId: string }
  | { kind: "categories" };

/** toast 全文（契約 §5.10）與固定文案（§5.11）——顯示端不手抄 */
export const TT_TEXT = {
  depart: (cat: string, at: number) => `発車・${cat}　${fmtClock(at)}`,
  departAction: "改 10 分前",
  arrive: (cat: string, dur: number) => `到着・${cat}　${fmtDur(dur)}`,
  undo: "撤回",
  longRunGap: (cat: string, at: number) => `到着・${cat}　${fmtClock(at)}；之後留白`,
  longRunCat: (cat: string, at: number) => `${fmtClock(at)} 起改成「${cat}」`,
  fill: (cat: string, dur: number) => `補上・${cat}　${fmtDur(dur)}`,
  edit: (cat: string, start: number, end: number) => `改好了・${cat}　${fmtClock(start)}–${fmtClock(end)}`,
  deleted: "已刪除這一塊",
  split: (at: number) => `切開・${fmtClock(at)}`,
  restart: (at: number) => `出發時間改成 ${fmtClock(at)}`,
  alreadyRunning: "這一班已經在跑了",
  runningHint: "運行中的這一班：在運行列換車、到着或改出發時間",
  undoArriveFailed: "已經有下一班了，到站撤回不了",
  saveFailed: "存檔失敗——請再試一次",
  pickCategory: "選一個分類",
  categoryCreated: (name: string) => `已新增分類「${name}」`,
  categoryRenamed: (name: string) => `已改名為「${name}」`,
  /** W1：蓋到既有紀錄時的赭字；為 0 的部分省略；全 0 回空字串 */
  cover: (s: CoverSummary) => {
    const parts: string[] = [];
    if (s.removed) parts.push(`蓋掉 ${s.removed} 塊`);
    if (s.shortened) parts.push(`切短 ${s.shortened} 塊`);
    if (s.splitCount) parts.push(`切開 ${s.splitCount} 塊`);
    return parts.length ? `會${parts.join("、")}` : "";
  },
} as const;

export interface TimetableStore {
  ready: boolean;
  loading: boolean;
  /** 只給「載入失敗」用（寫入失敗一律 toast，不釘紅字） */
  error: string | null;
  categories: TimeCategoryRow[];
  catById: Record<string, TimeCategoryRow>;
  /** 畫面上的「運行中那一班」＝currentRunning(listRunning)；同步後暫時兩筆時取開始較晚者（整理會收掉另一筆） */
  running: TimeBlockRow | null;
  /** 軸在看哪一個日界線日 */
  dayKey: string;
  dayBlocks: TimeBlockRow[];
  /** 今天（發車台合計、本週合計的「今天」那段）；dayKey＝今天時與 dayBlocks 相同 */
  todayKey: string;
  todayBlocks: TimeBlockRow[];
  /** 本週（週一的日界線起）到現在 */
  weekBlocks: TimeBlockRow[];
  longRunMaxMin: number;
  view: TimetableView;
  noticeEnabled: boolean;
  sheet: TimetableSheet | null;
  /** 「其實到幾點」被略過的那一班（契約 0-10）；回前景／換車／到站時清掉 */
  dismissedLongRunId: string | null;
  /** 回前景時不在時刻表頁 ⇒ 記下，進頁才問 */
  pendingAsk: boolean;

  /* 載入 */
  /** 冪等；第一次：讀設定 → 起手分類（§3.7.1）→ reconcile 一次 → refresh */
  init(shell: TimetableShell): Promise<void>;
  /** 重讀分類＋運行中＋三段時間塊（today 依 uiStore.dayStartHour 重算） */
  refresh(): Promise<void>;
  setDayKey(key: string): Promise<void>;
  /** mount 檔指到這裡（§3.8） */
  reload(ctx: LineReloadContext): Promise<void>;

  /* 視圖與設定 */
  setView(v: TimetableView): void; // 寫 KEY_VIEW（本地）
  toggleView(shell: TimetableShell): void; // V 鍵與頂端切換鈕
  setLongRunMax(min: number): Promise<void>; // settingsRepo.set(KEY_LONG_RUN_MAX)（會同步）
  setNoticeEnabled(on: boolean): Promise<void>;

  /* 流程（UI 只叫這些） */
  /** N／換車／発車：運行中那班長時間運行 ⇒ sheet=longRun(then:"depart")；否則 sheet=depart */
  requestDepart(): void;
  /** Enter／到着：沒有運行中 ⇒ 不動；長時間運行 ⇒ longRun(then:"arrive")；否則 arrive() */
  requestArrive(): void;
  /** 發車台點分類：同分類正在跑 ⇒ toast 12；長時間運行 ⇒ longRun(then:{tile})；否則 depart(categoryId, now) */
  tapCategory(categoryId: string): void;
  /** 契約 0-10 的規則 */
  autoAsk(where: "foreground" | "enter", onPage: boolean): void;
  openSheet(s: TimetableSheet): void;
  /** 關的是 longRun ⇒ dismissedLongRunId = 該 id（＝略過） */
  closeSheet(): void;

  /* 寫入（面板確認時叫；成功 ⇒ refresh＋toast；失敗 ⇒ toast 15；全部經 serial 佇列） */
  depart(categoryId: string, at: number): Promise<void>;
  arrive(at?: number): Promise<void>;
  restart(blockId: string, at: number): Promise<void>;
  fill(categoryId: string, start: number, end: number): Promise<void>;
  editBlock(blockId: string, categoryId: string, start: number, end: number): Promise<void>;
  split(blockId: string, at: number, categoryId2: string): Promise<void>;
  resolveLongRun(blockId: string, end: number, choice: LongRunChoice, categoryId2?: string): Promise<void>;
  deleteBlock(blockId: string): Promise<void>;
  previewCover(start: number, end: number | null, exceptId: string | null): Promise<CoverSummary>;

  /* 分類 */
  createCategory(input: { parentId: string | null; name: string; colorIdx: number; defaultMin: number | null }): Promise<void>;
  updateCategory(id: string, patch: { name?: string; colorIdx?: number; defaultMin?: number | null }): Promise<void>;
  moveCategory(id: string, delta: 1 | -1): Promise<void>;
}

/* ───────── 模組層狀態 ───────── */

/** serial 佇列：寫入與 reconcile 不交錯 */
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

let initPromise: Promise<void> | null = null;
let initShell: TimetableShell = "desktop";
let enteredOnce = false;
/** `reload({wiped:true})` 觸發的重 init：這一趟剛拉完（而且是在 syncStore 那趟 `working:true` 裡被 await 的），
 *  起手分類的閘門沒有東西可等 ⇒ 跳過，不然必定等滿 10 秒才種分類、頁面 loading 10 秒 */
let skipSettleGateOnce = false;

const toast = (message: string, actionLabel?: string, onAction?: () => void): void =>
  useUiStore.getState().showToast(actionLabel ? { message, actionLabel, onAction } : { message });

function failToast(e: unknown): void {
  toast(e instanceof RangeError ? e.message : TT_TEXT.saveFailed);
}

function normalizeView(raw: string | null, shell: TimetableShell): TimetableView {
  if (shell === "mobile") return raw === "axis" ? "axis" : "board";
  return raw === "axis" ? "axis" : "split";
}

function parseLongRunMax(raw: string | null): number {
  if (raw === null || raw === "") return LONG_RUN_MAX_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : LONG_RUN_MAX_DEFAULT;
}

/**
 * 起手分類的閘門（契約 §3.7.1、0-3 的緩解）：已加入同步、開著、在線 ⇒ 先等一趟拉下來（最多 ms），
 * 讓別台已種、已改過名的起手分類先到，這台才不會用預設值蓋掉它。
 */
function waitForSyncSettle(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const s0 = useSyncStore.getState();
    const lastAt0 = s0.status?.last_sync_at ?? null;
    let sawWorking = s0.working;
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsub();
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const unsub = useSyncStore.subscribe((s) => {
      // boot 回來了、但這台沒加入或開關關著 ⇒ 不必等
      if (s.status && !(s.status.joined && s.status.enabled)) finish();
      if (s.status && (s.status.last_sync_at ?? null) !== lastAt0) finish();
      if (s.working) sawWorking = true;
      else if (sawWorking) finish();
    });
  });
}

export const useTimetableStore = create<TimetableStore>((set, get) => {
  async function readLongRunMax(): Promise<void> {
    set({ longRunMaxMin: parseLongRunMax(await settingsRepo.get(KEY_LONG_RUN_MAX)) });
  }

  async function firstInit(shell: TimetableShell): Promise<void> {
    set({ loading: true, error: null });
    try {
      const [view, notice] = await Promise.all([settingsRepo.get(KEY_VIEW), settingsRepo.get(KEY_NOTICE)]);
      await readLongRunMax();
      set({ view: normalizeView(view, shell), noticeEnabled: notice !== "0" });

      const skipGate = skipSettleGateOnce;
      skipSettleGateOnce = false;
      if ((await timetableRepo.countCategoriesIncludingDeleted()) === 0) {
        const st = useSyncStore.getState();
        const online = typeof navigator === "undefined" || navigator.onLine !== false;
        if (!skipGate && !MOCK_MODE && online && (st.status === null || (st.status.joined && st.status.enabled))) {
          await waitForSyncSettle(10_000);
        }
        await timetableRepo.ensureStarterCategories();
      }
      await serial(() => timetableRepo.reconcile());
      await get().refresh();
      set({ ready: true });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      throw e;
    } finally {
      set({ loading: false });
    }
  }

  /** 長時間運行的判斷（運行中那班 × 它的分類門檻 × 全域上限） */
  function longRunNow(): TimeBlockRow | null {
    const { running, catById, longRunMaxMin } = get();
    if (!running) return null;
    const th = longRunThreshold(catById[running.category_id] ?? null, longRunMaxMin);
    return isLongRun(toSpan(running), th, Date.now()) ? running : null;
  }

  const catName = (id: string): string => get().catById[id]?.name ?? "？";

  /** 寫入共用殼：serial → refresh → 成功回呼；失敗 toast 15 */
  async function write<T>(fn: () => Promise<T>, after?: (r: T) => void): Promise<void> {
    try {
      const r = await serial(fn);
      await get().refresh();
      after?.(r);
    } catch (e) {
      failToast(e);
    }
  }

  /** longRun 面板確認後依 `then` 接續 */
  function continueAfterLongRun(then: Extract<TimetableSheet, { kind: "longRun" }>["then"]): void {
    if (then === null) return;
    if (then === "depart") {
      setTimeout(() => get().openSheet({ kind: "depart" }), 300);
    } else if (then === "arrive") {
      if (get().running) void get().arrive();
    } else {
      void get().depart(then.tile, Date.now());
    }
  }

  return {
    ready: false,
    loading: false,
    error: null,
    categories: [],
    catById: {},
    running: null,
    dayKey: todayKey(useUiStore.getState().dayStartHour),
    dayBlocks: [],
    todayKey: todayKey(useUiStore.getState().dayStartHour),
    todayBlocks: [],
    weekBlocks: [],
    longRunMaxMin: LONG_RUN_MAX_DEFAULT,
    view: "split",
    noticeEnabled: true,
    sheet: null,
    dismissedLongRunId: null,
    pendingAsk: false,

    /* ───────── 載入 ───────── */

    init(shell) {
      initShell = shell;
      if (!initPromise) {
        initPromise = firstInit(shell).catch((e) => {
          initPromise = null; // 失敗可重試
          throw e;
        });
      }
      return initPromise;
    },

    async refresh() {
      try {
        const dayStartHour = useUiStore.getState().dayStartHour;
        const newToday = todayKey(dayStartHour);
        const prev = get();
        // 主人停在今天就一直是今天（換日跟著換）
        const dayKey = prev.dayKey === prev.todayKey && newToday !== prev.todayKey ? newToday : prev.dayKey;
        const dw = dayWindow(dayKey, dayStartHour);
        const tw = dayWindow(newToday, dayStartHour);
        const ww = dayWindow(weekStartKey(newToday), dayStartHour);
        const [categories, runningRows, dayBlocks, todayBlocks, weekBlocks] = await Promise.all([
          timetableRepo.listCategories(),
          timetableRepo.listRunning(),
          timetableRepo.listBlocks(dw.start, dw.end),
          dayKey === newToday ? null : timetableRepo.listBlocks(tw.start, tw.end),
          timetableRepo.listBlocks(ww.start, tw.end),
        ]);
        const catById: Record<string, TimeCategoryRow> = {};
        for (const c of categories) catById[c.id] = c;
        const cur = currentRunning(runningRows.map(toSpan));
        set({
          categories,
          catById,
          running: cur ? (runningRows.find((r) => r.id === cur.id) ?? null) : null,
          dayKey,
          dayBlocks,
          todayKey: newToday,
          todayBlocks: todayBlocks ?? dayBlocks,
          weekBlocks,
          error: null,
        });
      } catch (e) {
        set({ error: e instanceof Error ? e.message : String(e) });
      }
    },

    async setDayKey(key) {
      set({ dayKey: key });
      await get().refresh();
    },

    async reload(ctx) {
      if (ctx.wiped) set({ sheet: null, dismissedLongRunId: null, pendingAsk: false, ready: false });
      const touched = ctx.wiped || ctx.changed.includes("time_blocks") || ctx.changed.includes("time_categories");
      if (ctx.changed.includes("settings")) await readLongRunMax(); // 全域保險上限可能被別台改了
      if (ctx.wiped) {
        initPromise = null; // 整批換掉：重走 init（表可能是空的 ⇒ 重種起手分類）
        skipSettleGateOnce = true; // 這一趟剛拉完，閘門沒有東西可等
        await get().init(ctx.shell);
        return;
      }
      if (ctx.changed.includes("time_blocks")) await serial(() => timetableRepo.reconcile());
      if (touched || ctx.changed.includes("settings")) await get().refresh();
    },

    /* ───────── 視圖與設定 ───────── */

    setView(v) {
      set({ view: v });
      void settingsRepo.set(KEY_VIEW, v).catch(() => undefined);
    },

    toggleView(shell) {
      const cur = get().view;
      const next: TimetableView = shell === "mobile" ? (cur === "axis" ? "board" : "axis") : cur === "axis" ? "split" : "axis";
      get().setView(next);
    },

    async setLongRunMax(min) {
      const v = Math.max(0, Math.round(min));
      set({ longRunMaxMin: v });
      try {
        await settingsRepo.set(KEY_LONG_RUN_MAX, String(v));
      } catch (e) {
        failToast(e);
      }
    },

    async setNoticeEnabled(on) {
      set({ noticeEnabled: on });
      try {
        await settingsRepo.set(KEY_NOTICE, on ? "1" : "0");
      } catch (e) {
        failToast(e);
      }
    },

    /* ───────── 流程 ───────── */

    requestDepart() {
      set({ dismissedLongRunId: null });
      const lr = longRunNow();
      if (lr) get().openSheet({ kind: "longRun", blockId: lr.id, then: "depart" });
      else get().openSheet({ kind: "depart" });
    },

    requestArrive() {
      set({ dismissedLongRunId: null });
      if (!get().running) return;
      const lr = longRunNow();
      if (lr) get().openSheet({ kind: "longRun", blockId: lr.id, then: "arrive" });
      else void get().arrive();
    },

    tapCategory(categoryId) {
      set({ dismissedLongRunId: null });
      const { running } = get();
      if (running && running.category_id === categoryId) {
        toast(TT_TEXT.alreadyRunning);
        return;
      }
      const lr = longRunNow();
      if (lr) get().openSheet({ kind: "longRun", blockId: lr.id, then: { tile: categoryId } });
      else void get().depart(categoryId, Date.now());
    },

    autoAsk(where, onPage) {
      if (where === "foreground") set({ dismissedLongRunId: null });
      if (where === "enter") {
        const first = !enteredOnce;
        enteredOnce = true;
        if (!first && !get().pendingAsk) return;
      }
      const lr = longRunNow();
      if (!lr || lr.id === get().dismissedLongRunId || get().sheet !== null) {
        if (onPage) set({ pendingAsk: false });
        return;
      }
      if (!onPage) {
        set({ pendingAsk: true });
        return;
      }
      set({ pendingAsk: false });
      get().openSheet({ kind: "longRun", blockId: lr.id, then: null });
    },

    openSheet(s) {
      set({ sheet: s });
    },

    closeSheet() {
      const s = get().sheet;
      set({ sheet: null, dismissedLongRunId: s?.kind === "longRun" ? s.blockId : get().dismissedLongRunId });
    },

    /* ───────── 寫入 ───────── */

    async depart(categoryId, at) {
      const now = Date.now();
      const atMs = Math.min(at, now);
      await write(
        () => timetableRepo.depart(categoryId, isoOf(atMs)),
        ({ block }) => {
          const start = msOf(block.started_at);
          const name = catName(block.category_id);
          if (now - atMs < MIN) {
            // 出發＝現在：帶「改 10 分前」（該班仍運行中才動）
            toast(TT_TEXT.depart(name, start), TT_TEXT.departAction, () => {
              if (get().running?.id === block.id) void get().restart(block.id, start - 10 * MIN);
            });
          } else {
            toast(TT_TEXT.depart(name, start));
          }
        },
      );
    },

    async arrive(at) {
      const now = Date.now();
      await write(
        () => timetableRepo.arrive(at === undefined ? undefined : isoOf(Math.min(at, now))),
        (rows) => {
          const r = rows[0];
          if (!r) return;
          const dur = Math.max(0, msOf(r.ended_at ?? r.started_at) - msOf(r.started_at));
          toast(TT_TEXT.arrive(catName(r.category_id), dur), TT_TEXT.undo, () => {
            void (async () => {
              try {
                const ok = await serial(() => timetableRepo.undoArrive(r.id));
                if (!ok) toast(TT_TEXT.undoArriveFailed);
                await get().refresh();
              } catch (e) {
                failToast(e);
              }
            })();
          });
        },
      );
    },

    async restart(blockId, at) {
      const now = Date.now();
      const atMs = Math.min(at, now - MIN);
      await write(
        () => timetableRepo.restart(blockId, isoOf(atMs)),
        () => toast(TT_TEXT.restart(atMs)),
      );
    },

    async fill(categoryId, start, end) {
      await write(
        () => timetableRepo.fill(categoryId, isoOf(start), isoOf(end)),
        ({ block }) => toast(TT_TEXT.fill(catName(block.category_id), end - start)),
      );
    },

    async editBlock(blockId, categoryId, start, end) {
      await write(
        () => timetableRepo.editBlock(blockId, { categoryId, startIso: isoOf(start), endIso: isoOf(end) }),
        () => toast(TT_TEXT.edit(catName(categoryId), start, end)),
      );
    },

    async split(blockId, at, categoryId2) {
      await write(
        () => timetableRepo.split(blockId, isoOf(at), categoryId2),
        (r) => {
          if (r) toast(TT_TEXT.split(at));
          else toast("切點要在這一塊的開頭與尾端之間");
        },
      );
    },

    async resolveLongRun(blockId, end, choice, categoryId2) {
      const sheet = get().sheet;
      const then = sheet?.kind === "longRun" && sheet.blockId === blockId ? sheet.then : null;
      const block = get().running?.id === blockId ? get().running : (get().dayBlocks.find((b) => b.id === blockId) ?? null);
      if (choice === "cat" && !categoryId2) {
        toast(TT_TEXT.pickCategory);
        return;
      }
      await write(
        () => timetableRepo.resolveLongRun(blockId, isoOf(end), choice, categoryId2),
        () => {
          set({ sheet: null });
          if (choice === "gap" && block) toast(TT_TEXT.longRunGap(catName(block.category_id), end));
          else if (choice === "cat" && categoryId2) toast(TT_TEXT.longRunCat(catName(categoryId2), end));
          continueAfterLongRun(then);
        },
      );
    },

    async deleteBlock(blockId) {
      await write(
        () => timetableRepo.softDelete(blockId),
        () =>
          toast(TT_TEXT.deleted, TT_TEXT.undo, () => {
            void write(() => timetableRepo.restore(blockId));
          }),
      );
    },

    previewCover(start, end, exceptId) {
      return timetableRepo.previewCover(isoOf(start), end === null ? null : isoOf(end), exceptId);
    },

    /* ───────── 分類 ───────── */

    async createCategory(input) {
      await write(
        () => timetableRepo.createCategory(input),
        (row) => toast(TT_TEXT.categoryCreated(row.name)),
      );
    },

    async updateCategory(id, patch) {
      await write(
        () => timetableRepo.updateCategory(id, patch),
        () => {
          if (patch.name !== undefined) toast(TT_TEXT.categoryRenamed(patch.name.trim()));
        },
      );
    },

    async moveCategory(id, delta) {
      const me = get().catById[id];
      if (!me) return;
      const siblings = get()
        .categories.filter((c) => c.parent_id === me.parent_id && c.archived_at === null)
        .map((c) => c.id);
      const i = siblings.indexOf(id);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= siblings.length) return;
      const next = siblings.slice();
      next[i] = siblings[j];
      next[j] = siblings[i];
      await write(() => timetableRepo.reorderCategories(me.parent_id, next));
    },
  };
});

/** 乙丙席共用：某塊是不是「長時間運行・待確認」（門檻＝分類預設長度，退回全域上限） */
export function blockIsLongRun(block: TimeBlockRow, catById: Record<string, TimeCategoryRow>, globalMaxMin: number, now: number): boolean {
  return isLongRun(toSpan(block), longRunThreshold(catById[block.category_id] ?? null, globalMaxMin), now);
}

/** 乙丙席共用：昨天的 dayKey（「昨日 ›」一鍵） */
export function yesterdayKey(dayKey: string): string {
  return addDays(dayKey, -1);
}

/** 目前 init 用的殼（通知／試驗提醒判斷用） */
export function timetableShell(): TimetableShell {
  return initShell;
}
