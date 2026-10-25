/**
 * searchStore——完整搜尋（完整搜尋班；契約 docs/research/2026-10-25-主線-完整搜尋班-契約.md）的狀態，兩殼共用一份。
 *
 * 只放「問了什麼、回來什麼」：字、篩選、repository 的原始命中（未排序未篩）、已畫列數、選中列、捲動位置。
 * 排序與篩選要看「済」（定期券看目前班次＝nodeStore.currentOccurrences），由元件用 domain/fullSearch 的純函式算。
 * D-主-118：狀態留到 App 關閉（不寫設定、不同步）；再開時 `refresh()` 重查一次。
 * 資料變動（mutation 重載、同步拉進來）：元件看 nodeStore 的切片換了就叫 `refresh()`，選中列與捲動位置不動。
 */
import { create } from "zustand";
import { nodeRepo } from "../data";
import {
  DEFAULT_FILTER,
  RESULT_PAGE,
  type FullSearchFilter,
  type FullSearchHit,
} from "../domain/fullSearch";

/** 打字後多久才查（同 Ctrl+P） */
const DEBOUNCE_MS = 150;

interface SearchStore {
  query: string;
  filter: FullSearchFilter;
  /** repository 回的命中（未排序、未篩選） */
  hits: FullSearchHit[];
  /** `hits` 是哪個字查出來的（trim 後）；跟 query 不同＝還在等新結果 */
  hitsTerm: string;
  pending: boolean;
  /** 已畫幾列（D-主-115：一次 300，捲到底接下一批） */
  shown: number;
  /** 選中的節點 id（鍵盤游標、桌機也是側板顯示的那張） */
  activeId: string | null;
  /** 清單捲動位置（離開再回來還原） */
  scrollTop: number;
  /** 每次從入口進來 +1：頁面看到它變了就把游標放進搜尋框（已在這頁時再按 Ctrl+Shift+F 也一樣） */
  focusTick: number;
  /** 畫面歸零一次 +1（換字、換篩選）：清單看到它變了就把捲動拉回頂（store 的 scrollTop 只在掛載時還原） */
  viewTick: number;

  setQuery(query: string): void;
  /** 從入口帶字進來（Ctrl+P 的 Ctrl+Enter、手機「看全部結果」）：立刻查、不等 debounce */
  openWith(query: string): void;
  setFilter(patch: Partial<FullSearchFilter>): void;
  resetFilter(): void;
  /** 用目前的字重查（資料變了、再開頁） */
  refresh(): void;
  showMore(): void;
  setActive(id: string | null): void;
  setScrollTop(top: number): void;
  requestFocus(): void;
}

let timer: ReturnType<typeof setTimeout> | null = null;
let req = 0;
/** 還在路上的那一趟查的是哪個字（沒有＝null） */
let inflight: string | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
/** 資料變動的重查併成一趟的等待 */
const REFRESH_COALESCE_MS = 60;

export const useSearchStore = create<SearchStore>((set, get) => {
  /** 畫面歸零：已畫列數回第一批、捲回頂（viewTick 讓清單把 DOM 的捲動也拉回去） */
  const resetView = () => ({ shown: RESULT_PAGE, scrollTop: 0, viewTick: get().viewTick + 1 });

  /** 查 `term`；過期的回應丟掉。`keepView`＝重查同一個字（資料變了）：不收回已畫列數、不動選中與捲動 */
  const run = (term: string, keepView: boolean) => {
    if (timer) clearTimeout(timer);
    timer = null;
    const id = ++req;
    if (!term) {
      inflight = null;
      set({ hits: [], hitsTerm: "", pending: false, activeId: null, ...resetView() });
      return;
    }
    inflight = term;
    set({ pending: true });
    void nodeRepo
      .searchFull(term)
      .catch(() => [] as FullSearchHit[])
      .then((hits) => {
        if (id !== req) return;
        inflight = null;
        set(keepView ? { hits, hitsTerm: term, pending: false } : { hits, hitsTerm: term, pending: false, activeId: null, ...resetView() });
      });
  };

  return {
    query: "",
    filter: DEFAULT_FILTER,
    hits: [],
    hitsTerm: "",
    pending: false,
    shown: RESULT_PAGE,
    activeId: null,
    scrollTop: 0,
    focusTick: 0,
    viewTick: 0,

    setQuery(query) {
      set({ query });
      const term = query.trim();
      if (timer) clearTimeout(timer);
      timer = null;
      if (term === get().hitsTerm) {
        // 打回手上這份結果的字（例如多打一個字又刪掉）：作廢還在路上、查別的字的那一趟，結果照舊。
        // 路上那趟查的就是這個字（資料變了的重查）就讓它回來，不然會停在舊資料（反方評審 #6）
        if (inflight !== term) {
          ++req;
          inflight = null;
          set({ pending: false });
        }
        return;
      }
      if (!term) {
        run("", false);
        return;
      }
      set({ pending: true });
      timer = setTimeout(() => run(term, false), DEBOUNCE_MS);
    },

    openWith(query) {
      const term = query.trim();
      set({ query: term });
      run(term, term === get().hitsTerm);
    },

    setFilter(patch) {
      set({ filter: { ...get().filter, ...patch }, ...resetView() });
    },

    resetFilter() {
      set({ filter: DEFAULT_FILTER, ...resetView() });
    },

    refresh() {
      // 一次資料變動 nodeStore 會分好幾次換切片（同步拉一次 4～5 次，沙盒 O2）：併成一趟，晚一點點再查。
      // 打字中（去抖還沒到）碰上：用最後打的字查，順便收掉那個計時器；字變了就不留舊的選中與捲動
      if (refreshTimer) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        const term = get().query.trim();
        run(term, term === get().hitsTerm);
      }, REFRESH_COALESCE_MS);
    },

    showMore() {
      set({ shown: get().shown + RESULT_PAGE });
    },

    setActive(activeId) {
      set({ activeId });
    },

    setScrollTop(scrollTop) {
      set({ scrollTop });
    },

    requestFocus() {
      set({ focusTick: get().focusTick + 1 });
    },
  };
});
