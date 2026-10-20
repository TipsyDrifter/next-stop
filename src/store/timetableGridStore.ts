/**
 * timetableGridStore——時刻表⑤「方眼」的純 UI 狀態（⑤ 契約 0-3、§3.3；甲席）。
 *
 * - 資料不在這裡：天＝`timetableStore.dayKey`、塊＝`timetableStore.dayBlocks`（與軸、日程共用）；寫入走 `timetableStore.paint`。
 * - `cellMin` 存本機鍵 `timetable_grid_min`（手機 `_mobile`，兩殼各記；D-時-91），不同步、不進 manifest。
 *   讀寫照 `timetableStatsStore` 的期間記法：`load(shell)` 只讀一次（壞值靜默用預設）、`setCellMin` 寫 `settingsRepo`、失敗吞掉。
 *   shell 由呼叫端給（`timetableShell()` 在 `init` 之前會拿到 "desktop"，程式地圖 §一）。
 * - `sel`：放開後的選區（已 `clampSel`＋`snapEdges`）；`liveTail`＝尾格含現在——點分類的那一刻才重算 end（契約 0-4）。
 *   換日（`dayKey` 變）清掉；`rev` 變（寫入、同步、換日界線）而選區已不合理（頭到了現在之後、超出那一天的窗）也清掉。
 */
import { create } from "zustand";
import { settingsRepo } from "../data";
import { dayWindow } from "../lib/date";
import { msOf } from "../domain/timetable";
import { DEFAULT_CELL_MIN, parseCellMin, type CellMin } from "../domain/timetableGrid";
import { useTimetableStore, type TimetableShell } from "./timetableStore";
import { useUiStore } from "./uiStore";

export const KEY_GRID_MIN = "timetable_grid_min"; // 本地；手機加 `_mobile`

/** 放開後的選區（毫秒） */
export interface GridSel {
  start: number;
  end: number;
  /** 尾格含現在：點分類那一刻 end 重算成 Date.now()、重做 paintModeOf */
  liveTail: boolean;
}

export interface GridState {
  cellMin: CellMin;
  /** 本機鍵讀過了（讀之前用預設 10 分） */
  loaded: boolean;
  sel: GridSel | null;
  /** 拖曳中（讀數浮起來、塗色列先不出） */
  dragging: boolean;
  /** 塗色寫入在飛（塗色列整列 busy） */
  busy: boolean;
  /** 讀 `timetable_grid_min`（手機 `_mobile`）；同一個 shell 只讀一次 */
  load(shell: TimetableShell): Promise<void>;
  /** 寫本機鍵；換大小時清掉 sel */
  setCellMin(shell: TimetableShell, m: CellMin): void;
  setSel(r: GridSel | null): void;
  setDragging(b: boolean): void;
  setBusy(b: boolean): void;
}

const storageKey = (shell: TimetableShell): string => (shell === "mobile" ? `${KEY_GRID_MIN}_mobile` : KEY_GRID_MIN);

/** 已讀過哪一個 shell 的鍵（null＝還沒讀） */
let loadedShell: TimetableShell | null = null;
/** 讀的途中使用者先改了大小 ⇒ 讀回來的舊值不蓋掉它 */
let changedWhileLoading = false;

export const useTimetableGridStore = create<GridState>((set, get) => ({
  cellMin: DEFAULT_CELL_MIN,
  loaded: false,
  sel: null,
  dragging: false,
  busy: false,

  async load(shell) {
    if (loadedShell === shell) return;
    loadedShell = shell;
    changedWhileLoading = false;
    let m: CellMin = DEFAULT_CELL_MIN;
    try {
      m = parseCellMin(await settingsRepo.get(storageKey(shell)));
    } catch {
      /* 本機鍵讀不到就用預設（10 分） */
    }
    if (changedWhileLoading) set({ loaded: true });
    else set({ cellMin: m, loaded: true });
  },

  setCellMin(shell, m) {
    changedWhileLoading = true;
    if (m === get().cellMin) return;
    set({ cellMin: m, sel: null });
    void settingsRepo.set(storageKey(shell), String(m)).catch(() => undefined);
  },

  setSel(r) {
    set({ sel: r });
  },

  setDragging(b) {
    set({ dragging: b });
  },

  setBusy(b) {
    set({ busy: b });
  },
}));

/* ───────── 模組層訂閱：換日清選區、rev 變重新校驗（契約 §3.3、§5.2） ───────── */

useTimetableStore.subscribe((s, p) => {
  const g = useTimetableGridStore.getState();
  if (!g.sel) return;
  if (s.dayKey !== p.dayKey) {
    g.setSel(null);
    return;
  }
  if (s.rev === p.rev) return;
  const w = dayWindow(s.dayKey, useUiStore.getState().dayStartHour);
  const ws = msOf(w.start);
  const we = msOf(w.end);
  if (g.sel.start < ws || g.sel.end > we || g.sel.start >= Date.now()) g.setSel(null);
});
