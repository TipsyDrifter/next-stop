/**
 * boardStore——路線圖的看板與篩選清單（第五本第三梯 ⑫；契約 docs/research/2026-11-06-⑫看板與篩選-契約.md）。兩殼共用。
 *
 * 放三種東西：
 *   - 螢幕偏好（看哪個分頁、依什麼分欄、排序與版面）：本機 settings、不同步（D-1.1-3）。
 *   - 這次的條件 `filter` 與它是不是某一條常用篩選 `activeSavedId`：只在記憶體，關 App 就清（同完整搜尋 D-主-118）。
 *   - 常用篩選 `saved`：settings 一格 JSON（`saved_filters`）。
 * 資料（`tasks`、`holders`）是 repository 的原始結果，篩選排序由元件用 domain/taskFilter 算；
 * 資料變動時元件看 nodeStore 的切片換了就叫 `refresh()`（同 searchStore：一次寫入換好幾片切片，併成一趟；內容沒變的列留原物件，清單不重畫）。
 * 常用篩選的寫入照順序排隊，有寫入還沒完成時重查不覆蓋 `saved`；寫失敗吐 toast、從庫裡讀回來。
 */
import { create } from "zustand";
import { nodeRepo, settingsRepo, type TaskHolderRow } from "../data";
import { parseBoardGroup, type BoardGroup } from "../domain/board";
import {
  DEFAULT_TASK_FILTER,
  followTagRenames,
  isDefaultTaskFilter,
  parseFilterLayout,
  parseSavedFilters,
  parseTaskSort,
  serializeSavedFilters,
  type FilterLayout,
  type SavedFilter,
  type TaskFilter,
  type TaskRow,
  type TaskSort,
} from "../domain/taskFilter";
import { tagRepo } from "../data/tagRepo";
import { useSelectionStore } from "./selectionStore";
import { useUiStore } from "./uiStore";

export const KEY_SAVED_FILTERS = "saved_filters";
const KEY_ROUTE_LAYOUT = "route_layout";
const KEY_BOARD_GROUP = "board_group";
const KEY_OVERVIEW_TAB = "route_overview_tab";
const KEY_FILTER_SORT = "task_filter_sort";
const KEY_FILTER_LAYOUT = "task_filter_layout";

export type RouteLayout = "outline" | "board";
export type OverviewTab = "routes" | "filter";

interface BoardStore {
  /** 本機偏好讀回來了沒（第一次畫大綱或看板要等它，不然會閃一下） */
  ready: boolean;
  routeLayout: RouteLayout;
  boardGroup: BoardGroup;
  overviewTab: OverviewTab;
  filter: TaskFilter;
  activeSavedId: string | null;
  sort: TaskSort;
  layout: FilterLayout;
  saved: SavedFilter[];
  tasks: TaskRow[];
  holders: TaskHolderRow[];
  /** 第一次查還沒回來（之後的重查不再亮，清單不必為它重畫） */
  loading: boolean;
  /** 跳轉要看板捲到哪一張（boardReveal）；看板捲完收掉 */
  cardReveal: { id: string; seq: number } | null;

  ensureLoaded(): Promise<void>;
  /** 切大綱｜看板（記住）；兩邊的多選不跨 */
  setRouteLayout(v: RouteLayout): void;
  /** 這次切回大綱，不寫記憶（跳轉落點不是看得到的卡） */
  showOutlineOnce(): void;
  requestCardReveal(id: string): void;
  consumeCardReveal(): void;
  setBoardGroup(v: BoardGroup): void;
  setOverviewTab(v: OverviewTab): void;
  setSort(v: TaskSort): void;
  setLayout(v: FilterLayout): void;
  /** 改條件：跟目前那條常用篩選不一樣了就不再算套用著 */
  setFilter(patch: Partial<TaskFilter>): void;
  clearFilter(): void;
  /** 套用常用篩選；不在路線圖的篩選分頁就切過去由呼叫端決定 */
  applySaved(id: string): void;
  /** 從別處帶條件進來（路線一覽的「誤點 N」） */
  openFiltered(filter: TaskFilter): void;
  /** 以下幾支回「存進去了沒」；失敗已經吐過 toast */
  saveAs(name: string): Promise<boolean>;
  renameSaved(id: string, name: string): Promise<boolean>;
  /** 把目前的條件與版面寫回這一條 */
  updateSaved(id: string): Promise<boolean>;
  /** 刪除，toast 附復原 */
  removeSaved(id: string): Promise<void>;
  reorderSaved(ids: readonly string[]): Promise<boolean>;
  /** 只讀常用篩選（書封：本機還沒存過也要看得到另一台存的） */
  reloadSaved(): Promise<void>;
  /** 重查任務（併成一趟）；另一台改了常用篩選也在這裡讀進來（同步拉取一定會換 nodeStore 的切片） */
  refresh(): void;
}

const sameFilter = (a: TaskFilter, b: TaskFilter): boolean => JSON.stringify(a) === JSON.stringify(b);

const remember = (key: string, value: string) => void settingsRepo.set(key, value).catch(() => undefined);

/** 本機改常用篩選的版本號：查詢開始之後變了，那一趟讀到的就是舊的 */
let savedRev = 0;
let pendingWrites = 0;
let writeChain: Promise<unknown> = Promise.resolve();

/** 照順序寫（兩次改名不會先後顛倒）；失敗吐 toast、從庫裡讀回真相 */
async function writeSaved(list: readonly SavedFilter[]): Promise<boolean> {
  pendingWrites++;
  const job = writeChain.then(() => settingsRepo.set(KEY_SAVED_FILTERS, serializeSavedFilters(list)));
  writeChain = job.catch(() => undefined);
  try {
    await job;
    pendingWrites--;
    return true;
  } catch (e) {
    pendingWrites--;
    console.warn("常用篩選寫入失敗", e);
    useUiStore.getState().showToast({ message: "常用篩選沒有存成功——請再試一次" }, 4000);
    void useBoardStore.getState().reloadSaved();
    return false;
  }
}

let loadOnce: Promise<void> | null = null;
/** 重查的代數：慢的舊查詢不能蓋掉新的 */
let refreshSeq = 0;
/** 併成一趟（同 searchStore）：一次資料變動 nodeStore 會分好幾次換切片 */
const REFRESH_COALESCE_MS = 60;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let tasksLoaded = false;
let revealSeq = 0;

/** 內容沒變的列留原物件，整份都沒變留原陣列：下游的 useMemo、React.memo 才不會白算 */
function keepSameRows<T extends { id: string }>(prev: readonly T[], next: readonly T[]): T[] {
  const byId = new Map(prev.map((r) => [r.id, r]));
  let same = prev.length === next.length;
  const out = next.map((r, i) => {
    const p = byId.get(r.id);
    const kept = p && JSON.stringify(p) === JSON.stringify(r) ? p : r;
    if (kept !== prev[i]) same = false;
    return kept;
  });
  return same ? (prev as T[]) : out;
}

/** 換大綱｜看板：選到的是這一頁的列，換過去就不算了 */
function dropLayoutSelection(): void {
  const s = useSelectionStore.getState();
  if (s.scope === "outline" || s.scope === "board") s.clear();
}

export const useBoardStore = create<BoardStore>((set, get) => ({
  ready: false,
  routeLayout: "outline",
  boardGroup: "status",
  overviewTab: "routes",
  filter: DEFAULT_TASK_FILTER,
  activeSavedId: null,
  sort: "smart",
  layout: "list",
  saved: [],
  tasks: [],
  holders: [],
  loading: false,
  cardReveal: null,

  ensureLoaded() {
    loadOnce ??= (async () => {
      const rev = savedRev;
      const [routeLayout, boardGroup, overviewTab, sort, layout, saved] = await Promise.all(
        [KEY_ROUTE_LAYOUT, KEY_BOARD_GROUP, KEY_OVERVIEW_TAB, KEY_FILTER_SORT, KEY_FILTER_LAYOUT, KEY_SAVED_FILTERS].map((k) =>
          settingsRepo.get(k).catch(() => null),
        ),
      );
      set({
        ready: true,
        routeLayout: routeLayout === "board" ? "board" : "outline",
        boardGroup: parseBoardGroup(boardGroup),
        overviewTab: overviewTab === "filter" ? "filter" : "routes",
        sort: parseTaskSort(sort),
        layout: parseFilterLayout(layout),
        // 讀回來之前本機已經改了常用篩選（App 剛開就存）：讀到的是舊的，不蓋
        ...(rev === savedRev && pendingWrites === 0 ? { saved: parseSavedFilters(saved) } : {}),
      });
    })();
    return loadOnce;
  },

  setRouteLayout(routeLayout) {
    if (routeLayout !== get().routeLayout) dropLayoutSelection();
    set({ routeLayout });
    remember(KEY_ROUTE_LAYOUT, routeLayout);
  },
  showOutlineOnce() {
    if (get().routeLayout === "outline") return;
    dropLayoutSelection();
    set({ routeLayout: "outline" });
  },
  requestCardReveal(id) {
    set({ cardReveal: { id, seq: ++revealSeq } });
  },
  consumeCardReveal() {
    if (get().cardReveal) set({ cardReveal: null });
  },
  setBoardGroup(boardGroup) {
    set({ boardGroup });
    remember(KEY_BOARD_GROUP, boardGroup);
  },
  setOverviewTab(overviewTab) {
    set({ overviewTab });
    remember(KEY_OVERVIEW_TAB, overviewTab);
  },
  setSort(sort) {
    set({ sort });
    remember(KEY_FILTER_SORT, sort);
  },
  setLayout(layout) {
    set({ layout });
    remember(KEY_FILTER_LAYOUT, layout);
  },

  setFilter(patch) {
    const filter = { ...get().filter, ...patch };
    const active = get().saved.find((s) => s.id === get().activeSavedId);
    set({ filter, activeSavedId: active && sameFilter(active.filter, filter) ? active.id : null });
  },
  clearFilter() {
    set({ filter: DEFAULT_TASK_FILTER, activeSavedId: null });
  },
  applySaved(id) {
    const s = get().saved.find((x) => x.id === id);
    if (!s) return;
    set({ filter: s.filter, activeSavedId: id, layout: s.layout });
    remember(KEY_FILTER_LAYOUT, s.layout);
  },
  openFiltered(filter) {
    // 「誤點 N」要對得上數：有子項的列車只在清單版面出現，這次固定清單（不寫記憶）
    set({ filter, activeSavedId: null, overviewTab: "filter", layout: "list" });
    remember(KEY_OVERVIEW_TAB, "filter");
  },

  async saveAs(name) {
    const item: SavedFilter = { id: crypto.randomUUID(), name: name.trim(), filter: get().filter, layout: get().layout };
    const saved = [...get().saved, item];
    savedRev++;
    set({ saved, activeSavedId: item.id });
    return writeSaved(saved);
  },
  async renameSaved(id, name) {
    const saved = get().saved.map((s) => (s.id === id ? { ...s, name: name.trim() } : s));
    savedRev++;
    set({ saved });
    return writeSaved(saved);
  },
  async updateSaved(id) {
    const { filter, layout } = get();
    const saved = get().saved.map((s) => (s.id === id ? { ...s, filter, layout } : s));
    savedRev++;
    set({ saved, activeSavedId: id });
    return writeSaved(saved);
  },
  async removeSaved(id) {
    const before = get().saved;
    const gone = before.find((s) => s.id === id);
    if (!gone) return;
    const saved = before.filter((s) => s.id !== id);
    savedRev++;
    set({ saved, activeSavedId: get().activeSavedId === id ? null : get().activeSavedId });
    if (!(await writeSaved(saved))) return;
    useUiStore.getState().showToast({
      message: `已刪除「${gone.name}」`,
      actionLabel: "復原",
      onAction: () => {
        // 復原那一刻另一台可能也改過：放回原位、其他照現況；已經回來了（按兩下、另一台復原）就不再放一次
        const cur = get().saved;
        if (cur.some((s) => s.id === id)) return;
        const at = Math.min(before.findIndex((s) => s.id === id), cur.length);
        const next = [...cur.slice(0, at), gone, ...cur.slice(at)];
        savedRev++;
        set({ saved: next });
        void writeSaved(next);
      },
    });
  },
  async reorderSaved(ids) {
    const byId = new Map(get().saved.map((s) => [s.id, s]));
    const picked = ids.flatMap((id) => byId.get(id) ?? []);
    const rest = get().saved.filter((s) => !ids.includes(s.id));
    const saved = [...picked, ...rest];
    savedRev++;
    set({ saved });
    return writeSaved(saved);
  },

  async reloadSaved() {
    const rev = savedRev;
    let raw: string | null;
    try {
      raw = await settingsRepo.get(KEY_SAVED_FILTERS);
    } catch {
      return;
    }
    if (rev !== savedRev || pendingWrites > 0) return;
    const saved = parseSavedFilters(raw);
    if (serializeSavedFilters(saved) !== serializeSavedFilters(get().saved)) set({ saved });
  },

  refresh() {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void runRefresh();
    }, REFRESH_COALESCE_MS);
  },
}));

async function runRefresh(): Promise<void> {
  const { getState: get, setState: set } = useBoardStore;
  const seq = ++refreshSeq;
  if (!tasksLoaded) set({ loading: true });
  const revAtStart = savedRev;
  try {
    const [tasks, holders, savedRaw, renames] = await Promise.all([
      nodeRepo.listTasks(),
      nodeRepo.listTaskHolders(),
      settingsRepo.get(KEY_SAVED_FILTERS),
      tagRepo.listRenames().catch(() => []),
    ]);
    if (seq !== refreshSeq) return;
    tasksLoaded = true;
    // 查詢途中本機改了常用篩選、或還有寫入沒完成：讀到的是舊的，這一趟不覆蓋
    const stale = pendingWrites > 0 || savedRev !== revAtStart;
    const next = (stale ? get().saved : parseSavedFilters(savedRaw)).map((s) => ({ ...s, filter: followTagRenames(s.filter, renames) }));
    const saved = serializeSavedFilters(next) === serializeSavedFilters(get().saved) ? get().saved : next;
    const active = get().activeSavedId;
    set({
      tasks: keepSameRows(get().tasks, tasks),
      holders: keepSameRows(get().holders, holders),
      loading: false,
      saved,
      filter: followTagRenames(get().filter, renames),
      activeSavedId: active && saved.some((s) => s.id === active) ? active : null,
    });
  } catch (e) {
    if (seq !== refreshSeq) return;
    set({ loading: false });
    console.warn("boardStore.refresh 失敗", e);
  }
}

/** 條件是不是預設（「存成常用…」與「清除」的亮暗） */
export function hasFilterConditions(f: TaskFilter): boolean {
  return !isDefaultTaskFilter(f);
}
