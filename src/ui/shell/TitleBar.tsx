/**
 * TitleBar——桌機專屬品牌工具列（方案 A：無縫雙區沉浸式）。
 *
 * 結構設計：
 * - 左側書封頂端（`<CoverTopBar />`，嵌於 `Sidebar.tsx` 頂部 34px）：
 *   與深靛書封絨布完全一體成形（零水平接縫），放置 `[◧ 收合書封]` 與 `[←] [→]` 歷史返回／前進鈕。
 * - 右側天空工具列（`<TitleBar />`，嵌於桌機主欄頂部 34px）：
 *   - 當左側書封收合時，左端自動浮現 `[◧ 展開書封] [←] [→] ｜ 私鐵手帳` 迷你刊名膠囊。
 *   - 中央為純淨的天空拖曳區（`data-tauri-drag-region`，搜尋留在側欄）。
 *   - 右端常駐專屬功能：
 *     1. 「時刻表・運行中班次」迷你行先表示器（計時中顯示即時秒數、分類／任務名與一鍵 `■ 到着`；未發車時可點開常用分類快速 `▶ 発車`）
 *     2. `[✎ 記一句]` 快速靈感捕捉（`notesStore.openCapture()`）
 *     3. `[📌 桌面置頂小窗]` 開關（`pinSetVisible`／`pinStatus`）
 *     4. `[🌙/☀ 主題秒切]` 粉彩星空／銀河鐵道一鍵切換
 *     5. 最右端視窗控制鍵（`—` 最小化、`□` 最大化／還原、`✕` 隱藏至系統匣）
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useUiStore } from "../../store/uiStore";
import { useNavHistoryStore } from "../../store/navHistoryStore";
import { useTimetableStore } from "../../store/timetableStore";
import { useNotesStore } from "../../store/notesStore";
import { colorSlot, durOf, fmtHMS, leafCategories, toSpan } from "../../domain/timetable";
import { linkLabelOf } from "../../domain/timetableLink";
import { noticeTiles } from "../../domain/timetableNotice";
import { useNow } from "../timetable/useNow";
import { PopMenu, type PopMenuItem } from "../common/PopMenu";
import { isTauri } from "../notes/capture-window/shell";
import { onPinVisibility, pinSetVisible, pinStatus } from "../external/externalBridge";
import { capsOfHotkey } from "./hotkeys";
import { useHotkeyRevision } from "./useHotkeyRevision";

/** 判斷點擊目標是否為互動元件（按鈕、選單等），避免搶走點擊事件 */
function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest("button, a, input, select, textarea, [role='button'], [data-no-drag]"));
}

/** 拖曳空白區移動視窗（搭配 HTML data-tauri-drag-region 雙重保障） */
function handleDragMouseDown(e: MouseEvent<HTMLElement>) {
  if (e.button !== 0 || isInteractiveTarget(e.target)) return;
  if (e.detail >= 2) return; // 雙擊交給 onDoubleClick 處理最大化
  if (!isTauri()) return;
  void getCurrentWindow().startDragging().catch(() => undefined);
}

/** 雙擊空白區切換最大化／還原 */
function handleDragDoubleClick(e: MouseEvent<HTMLElement>) {
  if (isInteractiveTarget(e.target)) return;
  if (!isTauri()) return;
  void getCurrentWindow().toggleMaximize().catch(() => undefined);
}

/* ───────── 圖示（13–14px 細線幾何，對齊書封與手帳語彙） ───────── */

function IconSidebarToggle({ collapsed }: { collapsed: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="2.5" width="12" height="11" rx="2" />
      <path d="M6.2 2.5v11" />
      {collapsed ? (
        <path d="M9.2 6.3 11 8l-1.8 1.7" />
      ) : (
        <path d="M4.2 5.5v5" strokeWidth="1.8" />
      )}
    </svg>
  );
}

function IconNavBack() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10.2 3.5 5.5 8l4.7 4.5" />
    </svg>
  );
}

function IconNavForward() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5.8 3.5 10.5 8l-4.7 4.5" />
    </svg>
  );
}

function IconQuickNote() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11.5 2.5a1.6 1.6 0 0 1 2.3 2.3L6.3 12.3 3 13l.7-3.3Z" />
      <path d="m10.2 3.8 2 2" />
    </svg>
  );
}

function IconPinWindow() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2.2" y="2.8" width="11.6" height="10.4" rx="1.8" />
      <rect x="7.5" y="4.8" width="4.5" height="3.6" rx="0.8" fill="currentColor" fillOpacity="0.22" />
    </svg>
  );
}

function IconThemeMoon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M13.2 9.6A5.5 5.5 0 0 1 6.4 2.8a5.5 5.5 0 1 0 6.8 6.8Z" />
    </svg>
  );
}

function IconThemeSun() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="8" cy="8" r="2.8" />
      <path d="M8 2v1.6M8 12.4V14M2 8h1.6M12.4 8H14M3.8 3.8l1.1 1.1M11.1 11.1l1.1 1.1M12.2 3.8l-1.1 1.1M4.9 11.1 3.8 12.2" />
    </svg>
  );
}

/* ───────── 左側書封頂端控制列（嵌於 Sidebar.tsx 頂部） ───────── */

export function CoverTopBar() {
  useHotkeyRevision();
  const toggleSidebar = useUiStore((s) => s.toggleSidebarCollapsed);
  const canBack = useNavHistoryStore((s) => s.index > 0);
  const canForward = useNavHistoryStore((s) => s.index < s.entries.length - 1);
  const goBack = useNavHistoryStore((s) => s.goBack);
  const goForward = useNavHistoryStore((s) => s.goForward);

  const sidebarCap = capsOfHotkey("global.sidebar.toggle");
  const prevCap = capsOfHotkey("global.history.prev");
  const nextCap = capsOfHotkey("global.history.next");

  return (
    <div
      className="ns-cover-topbar"
      data-tauri-drag-region
      onMouseDown={handleDragMouseDown}
      onDoubleClick={handleDragDoubleClick}
    >
      <button
        type="button"
        className="ns-tb-btn ns-tb-btn--cover"
        onClick={toggleSidebar}
        aria-label="收合左側書封"
        title={`收合左側書封${sidebarCap ? `（${sidebarCap}）` : ""}`}
      >
        <IconSidebarToggle collapsed={false} />
      </button>
      <button
        type="button"
        className="ns-tb-btn ns-tb-btn--cover"
        onClick={() => void goBack()}
        disabled={!canBack}
        aria-label="返回上一頁"
        title={`返回上一頁${prevCap ? `（${prevCap}）` : ""}`}
      >
        <IconNavBack />
      </button>
      <button
        type="button"
        className="ns-tb-btn ns-tb-btn--cover"
        onClick={() => void goForward()}
        disabled={!canForward}
        aria-label="前往下一頁"
        title={`前往下一頁${nextCap ? `（${nextCap}）` : ""}`}
      >
        <IconNavForward />
      </button>
    </div>
  );
}

/* ───────── 時刻表・運行中班次 迷你行先表示器 ───────── */

const DEPART_OVERLINE = { zh: "快速発車", latin: "Quick Depart" };

function TitleBarTimerPill() {
  const ready = useTimetableStore((s) => s.ready);
  const running = useTimetableStore((s) => s.running);
  const catById = useTimetableStore((s) => s.catById);
  const categories = useTimetableStore((s) => s.categories);
  const recentIds = useTimetableStore((s) => s.recentCategoryIds);
  const noticePins = useTimetableStore((s) => s.noticePins);
  const linkInfo = useTimetableStore((s) => s.linkInfo);
  const now = useNow(running ? 1000 : 60_000);

  const btnRef = useRef<HTMLButtonElement>(null);
  const [menuItems, setMenuItems] = useState<PopMenuItem[] | null>(null);
  const closeMenu = useCallback(() => setMenuItems(null), []);

  const quickCats = useMemo(() => {
    const tiles = noticeTiles(categories, recentIds, noticePins, null, 6);
    if (tiles.length > 0) return tiles;
    return leafCategories(categories).slice(0, 6);
  }, [categories, recentIds, noticePins]);

  if (!ready) return null;

  if (running) {
    const cat = catById[running.category_id] ?? null;
    const catName = cat?.name ?? "運行中";
    const taskName = linkLabelOf(running, linkInfo);
    const label = taskName ? `${catName} · ${taskName}` : catName;
    const elapsed = fmtHMS(durOf(toSpan(running), now));
    const slot = colorSlot(cat ? cat.color_idx : 1);

    const onJumpToRunning = () => {
      useUiStore.getState().setPage("timetable");
      useTimetableStore.getState().openSheet({ kind: "edit", blockId: running.id });
    };

    const onArrive = (e: MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      void useTimetableStore.getState().arrive();
    };

    return (
      <div className="ns-tb-timer is-running" title={`正在運行：${label}（點擊前往時刻表）`}>
        <button
          type="button"
          className="ns-tb-timer-main"
          onClick={onJumpToRunning}
          aria-label={`運行中：${label}，已計時 ${elapsed}`}
        >
          <span
            className="ns-tb-timer-dot"
            style={{ backgroundColor: `var(--cat-${slot})` }}
            aria-hidden="true"
          />
          <span className="ns-tb-timer-clock">{elapsed}</span>
          <span className="ns-tb-timer-label">{label}</span>
        </button>
        <button
          type="button"
          className="ns-tb-timer-act is-arrive"
          onClick={onArrive}
          title="本班到着（結束計時）"
          aria-label="本班到着"
        >
          ■ 到着
        </button>
      </div>
    );
  }

  const openQuickDepart = () => {
    const items: PopMenuItem[] = quickCats.map((c) => ({
      key: `dep:${c.id}`,
      label: `${c.glyph ? `${c.glyph} · ` : ""}${c.name}`,
      onSelect: () => {
        void useTimetableStore.getState().depart(c.id, Date.now());
      },
    }));
    items.push({
      key: "goto-tt",
      label: "前往時刻表…",
      cut: items.length > 0,
      onSelect: () => {
        useUiStore.getState().setPage("timetable");
      },
    });
    setMenuItems((cur) => (cur ? null : items));
  };

  return (
    <>
      <div className="ns-tb-timer is-idle">
        <button
          ref={btnRef}
          type="button"
          className="ns-tb-timer-main"
          aria-haspopup="menu"
          aria-expanded={menuItems !== null}
          onClick={openQuickDepart}
          title="目前未發車——點擊選擇常用分類快速發車"
        >
          <span className="ns-tb-timer-dot is-idle" aria-hidden="true" />
          <span className="ns-tb-timer-label">未發車</span>
          <span className="ns-tb-timer-act is-depart">▶ 発車</span>
        </button>
      </div>
      {menuItems && (
        <PopMenu
          anchor={btnRef.current}
          overline={DEPART_OVERLINE}
          label="快速発車"
          items={menuItems}
          onClose={closeMenu}
        />
      )}
    </>
  );
}

/* ───────── 右側天空工具列（嵌於 App.tsx 主欄頂部） ───────── */

function readResolvedDark(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.getAttribute("data-theme") === "dark";
}

export function TitleBar() {
  useHotkeyRevision();
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useUiStore((s) => s.toggleSidebarCollapsed);
  const setSidebarCollapsed = useUiStore((s) => s.setSidebarCollapsed);
  const themePref = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);

  const canBack = useNavHistoryStore((s) => s.index > 0);
  const canForward = useNavHistoryStore((s) => s.index < s.entries.length - 1);
  const goBack = useNavHistoryStore((s) => s.goBack);
  const goForward = useNavHistoryStore((s) => s.goForward);

  const [isDark, setIsDark] = useState<boolean>(readResolvedDark);
  const [pinVisible, setPinVisible] = useState<boolean>(false);
  const [maximized, setMaximized] = useState<boolean>(false);

  // 同步 <html data-theme> 實際亮暗狀態
  useEffect(() => {
    setIsDark(readResolvedDark());
    const mo = new MutationObserver(() => setIsDark(readResolvedDark()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, [themePref]);

  // 同步桌面置頂小窗狀態
  useEffect(() => {
    let alive = true;
    void pinStatus()
      .then((s) => {
        if (alive) setPinVisible(s.visible);
      })
      .catch(() => undefined);
    let unlisten: (() => void) | undefined;
    void onPinVisibility((s) => {
      if (alive) setPinVisible(s.visible);
    }).then((fn) => {
      if (alive) unlisten = fn;
      else fn();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  // 同步視窗最大化狀態
  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    const win = getCurrentWindow();
    const syncMax = () => {
      void win
        .isMaximized()
        .then((m) => {
          if (alive) setMaximized(m);
        })
        .catch(() => undefined);
    };
    syncMax();
    let unlisten: (() => void) | undefined;
    void win
      .onResized(() => syncMax())
      .then((fn) => {
        if (alive) unlisten = fn;
        else fn();
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  const sidebarCap = capsOfHotkey("global.sidebar.toggle");
  const prevCap = capsOfHotkey("global.history.prev");
  const nextCap = capsOfHotkey("global.history.next");
  const captureCap = capsOfHotkey("notes.capture");

  const onTogglePin = () => {
    const next = !pinVisible;
    setPinVisible(next);
    void pinSetVisible(next)
      .then((s) => setPinVisible(s.visible))
      .catch(() => setPinVisible(!next));
  };

  const onToggleTheme = () => {
    void setTheme(isDark ? "pastel" : "galaxy");
  };

  const onMinimize = () => {
    if (!isTauri()) return;
    void getCurrentWindow().minimize().catch(() => undefined);
  };

  const onToggleMaximize = () => {
    if (!isTauri()) return;
    void getCurrentWindow()
      .toggleMaximize()
      .then(() => getCurrentWindow().isMaximized())
      .then((m) => setMaximized(m))
      .catch(() => undefined);
  };

  const onClose = () => {
    if (!isTauri()) return;
    void getCurrentWindow().close().catch(() => undefined);
  };

  return (
    <header
      className="ns-titlebar"
      aria-label="視窗工具列"
      data-tauri-drag-region
      onMouseDown={handleDragMouseDown}
      onDoubleClick={handleDragDoubleClick}
    >
      {/* 左側：當書封收合時，展開鈕、返回／前進鈕與迷你品牌名自動平滑接手 */}
      <div className="ns-titlebar-left" data-tauri-drag-region>
        {sidebarCollapsed && (
          <>
            <button
              type="button"
              className="ns-tb-btn"
              onClick={toggleSidebar}
              aria-label="展開左側書封"
              title={`展開左側書封${sidebarCap ? `（${sidebarCap}）` : ""}`}
            >
              <IconSidebarToggle collapsed={true} />
            </button>
            <button
              type="button"
              className="ns-tb-btn"
              onClick={() => void goBack()}
              disabled={!canBack}
              aria-label="返回上一頁"
              title={`返回上一頁${prevCap ? `（${prevCap}）` : ""}`}
            >
              <IconNavBack />
            </button>
            <button
              type="button"
              className="ns-tb-btn"
              onClick={() => void goForward()}
              disabled={!canForward}
              aria-label="前往下一頁"
              title={`前往下一頁${nextCap ? `（${nextCap}）` : ""}`}
            >
              <IconNavForward />
            </button>
            <span className="ns-tb-sep" aria-hidden="true" />
            <button
              type="button"
              className="ns-tb-brand-mini"
              onClick={() => setSidebarCollapsed(false)}
              title={`展開書封側欄${sidebarCap ? `（${sidebarCap}）` : ""}`}
            >
              私鐵手帳
            </button>
          </>
        )}
      </div>

      {/* 中央：純淨天空拖曳區 */}
      <div className="ns-titlebar-spacer" data-tauri-drag-region />

      {/* 右側：時刻表行先表示器 ＋ 專屬快捷工具三件套 ＋ 視窗控制鍵 */}
      <div className="ns-titlebar-right">
        <TitleBarTimerPill />

        <span className="ns-tb-sep" aria-hidden="true" />

        <button
          type="button"
          className="ns-tb-btn"
          onClick={() => useNotesStore.getState().openCapture()}
          aria-label="記一句靈感捕捉"
          title={`記一句${captureCap ? `（${captureCap}）` : ""}`}
        >
          <IconQuickNote />
        </button>

        <button
          type="button"
          className={`ns-tb-btn${pinVisible ? " is-active" : ""}`}
          onClick={onTogglePin}
          aria-pressed={pinVisible}
          aria-label="桌面置頂小窗開關"
          title={pinVisible ? "收起桌面置頂小窗" : "開啟桌面置頂小窗"}
        >
          <IconPinWindow />
        </button>

        <button
          type="button"
          className="ns-tb-btn"
          onClick={onToggleTheme}
          aria-label={isDark ? "切換為粉彩星空（淺色主題）" : "切換為銀河鐵道（深色主題）"}
          title={isDark ? "切換主題：粉彩星空（淺色）" : "切換主題：銀河鐵道（深色）"}
        >
          {isDark ? <IconThemeSun /> : <IconThemeMoon />}
        </button>

        <div className="ns-win-controls" role="group" aria-label="視窗控制">
          <button
            type="button"
            className="ns-win-btn"
            onClick={onMinimize}
            aria-label="最小化視窗"
            title="最小化"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
              <path d="M1.5 5h7" />
            </svg>
          </button>
          <button
            type="button"
            className="ns-win-btn"
            onClick={onToggleMaximize}
            aria-label={maximized ? "向下還原視窗" : "最大化視窗"}
            title={maximized ? "向下還原" : "最大化"}
          >
            {maximized ? (
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.15" aria-hidden="true">
                <rect x="1.8" y="3.2" width="5" height="5" rx="0.6" />
                <path d="M3.2 3.2V2.2c0-.3.3-.6.6-.6h4c.3 0 .6.3.6.6v4c0 .3-.3.6-.6.6H6.8" />
              </svg>
            ) : (
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
                <rect x="2" y="2" width="6" height="6" rx="0.6" />
              </svg>
            )}
          </button>
          <button
            type="button"
            className="ns-win-btn is-close"
            onClick={onClose}
            aria-label="關閉視窗（縮小至系統匣）"
            title="關閉（縮小至系統匣）"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" aria-hidden="true">
              <path d="m2.2 2.2 5.6 5.6M7.8 2.2 2.2 7.8" />
            </svg>
          </button>
        </div>
      </div>
    </header>
  );
}
