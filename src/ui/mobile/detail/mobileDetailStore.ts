/**
 * 手機詳情頁的開關（手機殼班 D-主-69／75）：手機沒有側板，「詳情…」開全螢幕子頁。
 * 任何手機入口（票卡 ⋯、路線圖 ⋯、行程表）都呼叫 `open(nodeId)`；頁面本身在 MobileShell 掛的 `MobileDetailHost`。
 * 不放進 uiStore：只活在手機殼，兩殼共用會讓桌機側板的開關跟著動。
 */
import { create } from "zustand";

interface MobileDetailState {
  /** 正在看的節點；null＝沒開 */
  nodeId: string | null;
  open(nodeId: string): void;
  close(): void;
}

export const useMobileDetailStore = create<MobileDetailState>((set) => ({
  nodeId: null,
  open: (nodeId) => set({ nodeId }),
  close: () => set({ nodeId: null }),
}));
