/**
 * FullSearchView——桌機完整搜尋頁（完整搜尋班；契約 docs/research/2026-10-25-主線-完整搜尋班-契約.md；
 * 視覺真相＝prototypes/主線-完整搜尋.html ①）。
 *
 * 主欄的一頁、不進 gnav（D-主-110；pages.ts 的 AUX_PAGES）。入口：Ctrl+Shift+F、Ctrl+P 底部「在完整搜尋看全部」（openFullSearch）。
 *   頁首固定（眉標＋大號底線搜尋框＋篩選列＋統計行）、清單自己捲、底下一行鍵盤提示。
 *   點一列＝選中＋開右側詳情側板（清單不動，側板裡照常改、蓋済；改完 nodeStore 重載 ⇒ 結果重查）；
 *   Enter／雙擊＝`jumpToNode`（Ctrl+P 的跳轉，邊界規則只有那一份）。
 *   ↑↓ 在搜尋框裡也能移（同 Ctrl+P）；移動時側板開著就跟著換。Esc＝清掉搜尋字。
 * 列數不設上限（D-主-115）：一次畫 RESULT_PAGE 列，哨兵進視窗就接下一批；鍵盤移到最後一列也接。
 * 狀態留在 searchStore（D-主-118）：離開再回來，字、篩選、選中列、捲動位置都在。
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { useSearchStore } from "../../store/searchStore";
import { useUiStore } from "../../store/uiStore";
import { useNodeStore } from "../../store/nodeStore";
import { OverlineText } from "../common/PageHeader";
import { PopMenu, type PopMenuItem } from "../common/PopMenu";
import { jumpToNode } from "../common/QuickJump";
import { formatChord, hotkeyById } from "../shell/hotkeys";
import { FullSearchField, FullSearchFilters, FullSearchRow, FullSearchStats, ListTail, routeFilterText } from "./FullSearchParts";
import { useFullSearchResults, type FullSearchRowModel } from "./useFullSearchResults";

const OPEN_CAPS = formatChord(hotkeyById("global.fullsearch")!.chords[0]).join("+");

export function FullSearchView() {
  const query = useSearchStore((s) => s.query);
  const hitsTerm = useSearchStore((s) => s.hitsTerm);
  const pending = useSearchStore((s) => s.pending);
  const shown = useSearchStore((s) => s.shown);
  const activeId = useSearchStore((s) => s.activeId);
  const focusTick = useSearchStore((s) => s.focusTick);
  const filter = useSearchStore((s) => s.filter);
  const routes = useNodeStore((s) => s.routes);
  const { setQuery, setActive, showMore, setFilter } = useSearchStore.getState();
  const { rows, total, filtered, routeOptions } = useFullSearchResults();

  const sectionRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [routeAnchor, setRouteAnchor] = useState<HTMLButtonElement | null>(null);
  const listId = useId();

  const term = hitsTerm;
  const visible = rows.slice(0, shown);
  const activeIndex = activeId ? rows.findIndex((r) => r.hit.node.id === activeId) : -1;
  const typing = query.trim() !== hitsTerm || pending;

  // 從入口進來（含已在這頁再按 Ctrl+Shift+F）＝游標進搜尋框、全選
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusTick]);

  // 回到這頁還原捲動位置；離開時記下來
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = useSearchStore.getState().scrollTop;
    return () => useSearchStore.getState().setScrollTop(el.scrollTop);
  }, []);

  // 換字、換篩選＝畫面歸零：DOM 的捲動也拉回頂（store 的 scrollTop 只在掛載時還原；反方評審 #1）
  const viewTick = useSearchStore((s) => s.viewTick);
  const mountedTick = useRef(viewTick);
  useEffect(() => {
    if (viewTick === mountedTick.current) return;
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [viewTick]);

  // 捲到底接下一批（同售票口帳目、筆記清單：IntersectionObserver 哨兵）
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && showMore(), {
      root: scrollRef.current,
      rootMargin: "400px 0px",
    });
    io.observe(el);
    return () => io.disconnect();
  }, [shown, rows.length, showMore]);

  // 選中列捲進視窗
  useEffect(() => {
    if (activeId) document.getElementById(`${listId}-${activeId}`)?.scrollIntoView({ block: "nearest" });
  }, [activeId, listId]);

  const pick = (r: FullSearchRowModel) => {
    const ui = useUiStore.getState();
    setActive(r.hit.node.id);
    ui.select(r.hit.node.id);
    const opening = !ui.panelOpen;
    ui.setPanelOpen(true);
    // 側板剛掛上會把焦點拉進去（SidePanelFrame）；點清單的人下一步多半是 ↑↓ 繼續看，焦點留在清單（反方評審 #3）。
    // 要進側板改東西：點進去或 Tab 就到
    if (opening) setTimeout(() => sectionRef.current?.focus({ preventScroll: true }), 0);
    else sectionRef.current?.focus({ preventScroll: true });
  };

  const go = (r: FullSearchRowModel) => {
    setActive(r.hit.node.id);
    void jumpToNode(r.hit.node);
  };

  const move = (delta: number) => {
    if (!rows.length) return;
    const from = activeIndex < 0 ? (delta > 0 ? -1 : rows.length) : activeIndex;
    const next = Math.max(0, Math.min(rows.length - 1, from + delta));
    if (next >= shown) showMore();
    const id = rows[next].hit.node.id;
    setActive(id);
    const ui = useUiStore.getState();
    if (ui.panelOpen) ui.select(id); // 側板開著就跟著換；沒開不硬開（點一下或 Ctrl+. 才開）
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return; // 組合鍵交給全域表
    const inInput = e.target === inputRef.current;
    // 搜尋框以外的輸入欄（目前沒有）、按鈕上的 Enter 不攔
    if (!inInput && e.target instanceof HTMLElement && ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(e.target.tagName)) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      move(e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "Enter") {
      const r = activeIndex >= 0 ? rows[activeIndex] : inInput ? rows[0] : undefined;
      if (!r || typing) return;
      e.preventDefault();
      go(r);
    } else if (e.key === "Escape" && query) {
      e.preventDefault();
      setQuery("");
      inputRef.current?.focus();
    }
  };

  const routeItems: PopMenuItem[] = [
    { key: "all", label: "全部路線", onSelect: () => setFilter({ route: "all" }) },
    { key: "temp", label: "臨時車票", onSelect: () => setFilter({ route: "temp" }) },
    ...routeOptions.map((r, i) => ({
      key: r.id,
      label: `${r.name}（${r.count}）`,
      cut: i === 0,
      onSelect: () => setFilter({ route: { routeId: r.id } }),
    })),
  ];

  return (
    <section ref={sectionRef} tabIndex={-1} className="page ns-fs" aria-label="完整搜尋" onKeyDown={onKeyDown}>
      <div className="ns-fs-head">
        <h1 className="sr-only">完整搜尋</h1>
        <p className="techo-overline">
          <OverlineText value={{ zh: "搜尋", latin: "Search" }} />
        </p>
        <FullSearchField inputRef={inputRef} hint={OPEN_CAPS} />
        <FullSearchFilters
          routeText={routeFilterText(filter.route, routeOptions, (id) => routes.find((r) => r.id === id)?.name)}
          routeOpen={!!routeAnchor}
          onRoute={(el) => setRouteAnchor((a) => (a ? null : el))}
        />
        {hitsTerm && (
          <FullSearchStats count={rows.length} total={total} filtered={filtered} pending={typing && !rows.length} showOrder />
        )}
      </div>

      <div
        ref={scrollRef}
        className="ns-fs-scroll techo-scroll"
        onScroll={(e) => useSearchStore.getState().setScrollTop(e.currentTarget.scrollTop)}
      >
        {!hitsTerm ? (
          !query.trim() && (
            <p className="ns-fs-hint">
              名稱、概要、乘務記錄都會找，結果不限筆數。點一列在右邊看詳情，Enter 或雙擊跳過去。
            </p>
          )
        ) : rows.length === 0 ? (
          !typing && (
            <p className="ns-fs-hint">
              {total > 0 ? `「${term}」共 ${total} 件，都被篩選擋下了。` : `名稱、概要、乘務記錄裡都找不到「${term}」。`}
            </p>
          )
        ) : (
          <>
            <ul id={listId} role="listbox" aria-label="搜尋結果" className={`ns-fs-list${typing ? " is-stale" : ""}`}>
              {visible.map((r) => {
                const id = r.hit.node.id;
                return (
                  <FullSearchRow
                    key={id}
                    id={`${listId}-${id}`}
                    row={r}
                    term={term}
                    active={id === activeId}
                    onPick={() => pick(r)}
                    onGo={() => go(r)}
                  />
                );
              })}
            </ul>
            <ListTail more={visible.length < rows.length} total={rows.length} sentinelRef={sentinelRef} />
          </>
        )}
      </div>

      <div className="ns-fs-foot techo-foot">
        <span>↑↓ 移動</span>
        <span>ENTER 前往</span>
        <span>ESC 清除</span>
      </div>

      {routeAnchor && (
        <PopMenu
          anchor={routeAnchor}
          overline={{ zh: "依路線篩選", latin: "Route" }}
          label="依路線篩選"
          items={routeItems}
          onClose={() => setRouteAnchor(null)}
        />
      )}
    </section>
  );
}
