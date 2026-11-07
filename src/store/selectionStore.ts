/**
 * selectionStore——多選（回饋乙 D-主-152；契約 docs/research/2026-11-01-回饋乙-契約.md §4）。
 *
 * 跟 `uiStore.selectedId`（單選、鍵盤游標、側板跟著它）分開：多選是「一批要一起改的票」，單選照舊當游標。
 *   - scope＝哪一頁的清單（路線圖、今日、行程表）；換頁、換路線由頁面清掉，不跨頁殘留。
 *   - ids 照畫面順序存（範圍選、一起拖都要順序）；anchor＝Shift 範圍選的起點。
 *   - 桌機：Ctrl／⌘＋點＝加選或取消、Shift＋點＝範圍選、⋯「選取」＝進多選並勾這張。
 *   - 手機：長按原地放開＝進多選並勾這張（useDragReorder 的 onPressRelease）；多選中點卡片＝加選或取消。
 * 唯讀的卡不能進多選（⑫ 車庫裡的路線；契約 §1）：頁面用 `setSelectable` 登記判準，所有進多選的路（Ctrl／Shift＋點、Ctrl＋A、⋯「選取」、手機長按、全選）都過這一關，
 *   不用每個入口各判一次；登記了判準，`visibleIn`（全選的範圍）也跟著濾。
 * 純狀態，不碰資料層；批量動作在 batchActions.ts。
 */
import { create } from "zustand";

export type SelectionScope = "outline" | "today" | "schedule" | "board";

interface SelectionState {
  scope: SelectionScope | null;
  ids: string[];
  anchor: string | null;
  /** 加選或取消一張（Ctrl＋點、手機多選中點卡片） */
  toggle(scope: SelectionScope, id: string, order: readonly string[]): void;
  /** 從 anchor 選到 id（Shift＋點）；沒有 anchor＝只選這張 */
  range(scope: SelectionScope, id: string, order: readonly string[]): void;
  /**
   * 鍵盤擴選（桌機 Shift＋↑↓）：選取換成「anchor 到 id」這一段（不是加上去——往回按要縮得回來）；anchor 不變。
   * 沒有 anchor（還沒進多選）＝從 `from`（游標那一列）起算。
   */
  extendTo(scope: SelectionScope, id: string, order: readonly string[], from: string | null): void;
  /** 進多選、只勾這張（⋯「選取」、手機長按） */
  start(scope: SelectionScope, id: string): void;
  /** 整份換掉（Ctrl＋A、復原後還原選取） */
  set(scope: SelectionScope, ids: readonly string[]): void;
  /** 清單換了：拿掉已經不在畫面上的（完成被藏、刪掉、同步拉走） */
  prune(scope: SelectionScope, visible: readonly string[]): void;
  clear(): void;
}

/** 照畫面順序排、去重 */
function inOrder(ids: Iterable<string>, order: readonly string[]): string[] {
  const want = new Set(ids);
  const out = order.filter((id) => want.has(id));
  // 不在 order 裡的（理論上不會）接在後面，免得默默丟掉
  for (const id of want) if (!out.includes(id)) out.push(id);
  return out;
}

/** 各頁最新的畫面順序（`prune` 順手記下；選取列的「全選」用，不是要畫的狀態，不進 store） */
const visibleByScope: Partial<Record<SelectionScope, readonly string[]>> = {};

/** 各頁「這張能不能選」的判準；沒登記＝都能選 */
const selectableByScope: Partial<Record<SelectionScope, (id: string) => boolean>> = {};
const pickable = (scope: SelectionScope, id: string) => selectableByScope[scope]?.(id) ?? true;

/** 登記這一頁的判準（null＝拿掉）；已經選著的、現在不能選的，下一次 prune 拿掉 */
export function setSelectable(scope: SelectionScope, fn: ((id: string) => boolean) | null): void {
  if (fn) selectableByScope[scope] = fn;
  else delete selectableByScope[scope];
}

export const useSelectionStore = create<SelectionState>((set, get) => ({
  scope: null,
  ids: [],
  anchor: null,

  toggle(scope, id, order) {
    const cur = get().scope === scope ? get().ids : [];
    if (!cur.includes(id) && !pickable(scope, id)) return;
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : inOrder([...cur, id], order);
    set({ scope: next.length ? scope : null, ids: next, anchor: next.length ? id : null });
  },

  range(scope, id, order) {
    const { anchor, ids } = get();
    const a = get().scope === scope && anchor && order.includes(anchor) ? anchor : null;
    if (!a) {
      if (pickable(scope, id)) set({ scope, ids: [id], anchor: id });
      return;
    }
    const i = order.indexOf(a);
    const j = order.indexOf(id);
    const span = order.slice(Math.min(i, j), Math.max(i, j) + 1).filter((x) => pickable(scope, x));
    // 範圍選＝原本的加上這一段（Finder／檔案總管的 Ctrl+Shift 行為；單純 Shift 在只有一張時結果相同）
    set({ scope, ids: inOrder([...(get().scope === scope ? ids : []), ...span], order), anchor: a });
  },

  extendTo(scope, id, order, from) {
    const s = get();
    const a = s.scope === scope && s.anchor && order.includes(s.anchor) ? s.anchor : from && order.includes(from) ? from : id;
    const i = order.indexOf(a);
    const j = order.indexOf(id);
    if (j < 0) return;
    const ids = order.slice(Math.min(i, j), Math.max(i, j) + 1).filter((x) => pickable(scope, x));
    set({ scope: ids.length ? scope : null, ids, anchor: ids.length ? a : null });
  },

  start(scope, id) {
    if (pickable(scope, id)) set({ scope, ids: [id], anchor: id });
  },

  set(scope, ids) {
    const keep = ids.filter((x) => pickable(scope, x));
    set({ scope: keep.length ? scope : null, ids: keep, anchor: keep[0] ?? null });
  },

  prune(scope, visible) {
    visibleByScope[scope] = visible;
    if (get().scope !== scope) return;
    const keep = get().ids.filter((id) => visible.includes(id) && pickable(scope, id));
    if (keep.length === get().ids.length) return;
    set({ ids: keep, scope: keep.length ? scope : null, anchor: keep.includes(get().anchor ?? "") ? get().anchor : (keep[0] ?? null) });
  },

  clear() {
    if (get().scope === null && !get().ids.length) return;
    set({ scope: null, ids: [], anchor: null });
  },
}));

/** 這一頁畫面上看得到的（全選的範圍；頁面沒登記過＝空） */
export function visibleIn(scope: SelectionScope): readonly string[] {
  const v = visibleByScope[scope] ?? [];
  return selectableByScope[scope] ? v.filter((id) => pickable(scope, id)) : v;
}

/** 這一頁目前的多選（別頁的不算） */
export function selectedIn(scope: SelectionScope): string[] {
  const s = useSelectionStore.getState();
  return s.scope === scope ? s.ids : [];
}

/**
 * 列的點擊交給多選：Ctrl／⌘＋點、Shift＋點、或「已經在多選中」（手機點卡片、桌機多選中純點）時處理並回 true；
 * 回 false＝不是多選的點，照列原本的單擊行為。
 */
export function selectionClick(
  scope: SelectionScope,
  id: string,
  order: readonly string[],
  mod: { ctrl: boolean; shift: boolean },
  opts: { touchMode?: boolean } = {},
): boolean {
  const s = useSelectionStore.getState();
  const active = s.scope === scope && s.ids.length > 0;
  if (mod.shift) {
    s.range(scope, id, order);
    return true;
  }
  if (mod.ctrl || (opts.touchMode && active)) {
    s.toggle(scope, id, order);
    return true;
  }
  return false;
}
