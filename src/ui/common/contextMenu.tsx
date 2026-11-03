/**
 * 桌機右鍵選單（回饋乙；契約 docs/research/2026-11-01-回饋乙-契約.md §5；使用者 11-01 心得〈功能〉全 App 8）。
 *
 * 規則：
 *   - 列上按右鍵＝開「該列 ⋯ 的同一份選單」，跳在游標位置：列元件在自己的元素上掛 `onContextMenu={rowContextMenu(() => menu)}`，
 *     menu 直接用該列 ⋯ 的那支函式（大綱 menuFor、今日 menuFor、行程表 scheduleRowMenu、ManagerRow 的 items…），不重抄。
 *   - 輸入框、可編輯區：照舊用系統選單（剪下／複製／貼上要用到）。
 *   - 其他地方：不再跳 WebView 的預設選單（「重新載入」「檢查」那些開發框架的項目）；有選取文字時給「複製」。
 *   - 手機殼不掛（沒有右鍵；長按另有用途）。
 * 樣式＝PopMenu（.techo-card、眉標、虛線分隔、赭字刪除），只是改成照座標開（PopMenu `at`）。
 */
import { useEffect, type MouseEvent as ReactMouseEvent } from "react";
import { create } from "zustand";
import { isMobileShell } from "../../lib/shell";
import { PopMenu, type PopMenuItem } from "./PopMenu";
import type { Overline } from "./PageHeader";

export interface ContextMenuSpec {
  overline: Overline;
  label: string;
  items: PopMenuItem[];
  /** 開選單前要做的事（例：先選中這一列，讓「只對選中列」的動作對到它） */
  before?: () => void;
}

interface OpenMenu extends ContextMenuSpec {
  at: { x: number; y: number };
  /** 每次開都換一個，讓 PopMenu 重掛（焦點落第一項、群組收合） */
  seq: number;
}

const useContextMenuStore = create<{ open: OpenMenu | null; seq: number }>(() => ({ open: null, seq: 0 }));

function close() {
  useContextMenuStore.setState({ open: null });
}

/** 在游標位置開一份選單（呼叫端已 preventDefault） */
export function openContextMenu(at: { x: number; y: number }, spec: ContextMenuSpec): void {
  if (!spec.items.length) return;
  spec.before?.();
  const seq = useContextMenuStore.getState().seq + 1;
  useContextMenuStore.setState({ open: { ...spec, at, seq }, seq });
}

/** 輸入框、可編輯區：保留系統選單 */
function isEditable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el?.closest) return false;
  return !!el.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']");
}

/**
 * 列元件用：`<li onContextMenu={rowContextMenu(() => ({ overline, label, items }))}>`。
 * 在輸入框（行內改名）裡按右鍵不攔，照舊系統選單；手機殼不攔。回 null＝這一列這時沒有選單。
 */
export function rowContextMenu(get: () => ContextMenuSpec | null) {
  return (e: ReactMouseEvent) => {
    if (isMobileShell() || isEditable(e.target)) return;
    const spec = get();
    if (!spec) return;
    e.preventDefault();
    e.stopPropagation();
    openContextMenu({ x: e.clientX, y: e.clientY }, spec);
  };
}

/**
 * 掛在桌機殼一次（App.tsx）：畫目前開著的右鍵選單；攔下沒有人處理的右鍵（不跳 WebView 預設選單）。
 */
export function ContextMenuHost() {
  const open = useContextMenuStore((s) => s.open);

  useEffect(() => {
    const onContext = (e: MouseEvent) => {
      if (e.defaultPrevented || isMobileShell() || isEditable(e.target)) return;
      e.preventDefault();
      const text = window.getSelection()?.toString() ?? "";
      if (!text.trim()) return;
      openContextMenu(
        { x: e.clientX, y: e.clientY },
        {
          overline: { zh: "選取的文字", latin: "Text" },
          label: "選取的文字",
          items: [{ key: "copy", label: "複製", onSelect: () => void navigator.clipboard?.writeText(text) }],
        },
      );
    };
    // 冒泡階段：列元件的 onContextMenu（React 委派在 root）先跑、會 preventDefault
    document.addEventListener("contextmenu", onContext);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    // 捲動時選單（fixed）會跟列脫鉤：收掉。選單自己不捲，所以 capture 抓得到的捲動都來自底下的頁面
    const onScroll = (e: Event) => {
      if (!(e.target as HTMLElement | null)?.closest?.(".ns-popmenu")) close();
    };
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("contextmenu", onContext);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, []);

  if (!open) return null;
  return (
    <PopMenu
      key={open.seq}
      anchor={null}
      at={open.at}
      overline={open.overline}
      label={open.label}
      items={open.items}
      onClose={close}
      returnFocus={() => null}
    />
  );
}
