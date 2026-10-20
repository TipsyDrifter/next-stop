/**
 * SearchBar——售票口頁首右側的搜尋框＋漏斗鈕（②契約 §5.1、§5.4、0-14、0-15；乙席）。長相照原型 `searchBar()`：
 *
 *   div.ns-tk-searchwrap[.is-open]
 *   ├─ label.ns-tk-search      放大鏡・input（placeholder「搜尋備註、分類、帳戶、金額…」）・有字 ⇒ × 清除；沒字 ⇒ kbd「/」
 *   └─ button.ns-tk-filterbtn  漏斗（aria-pressed＝篩選列開著；有結構條件 ⇒ 右上小點）
 *
 * - 打字去抖 150ms 再 `setFilterText`（store 直接查）；`Enter`＝立即查；IME 組字中不送（compositionend 再送）。
 * - `Esc`（輸入欄自理，不登記）：有字 ⇒ 清字；沒字 ⇒ 關搜尋（`closeSearch`）、焦點回清單。
 * - 聚焦就開篩選列（`openSearch`，月曆／統計會先切回清單——原型同）。
 * - 漏斗：篩選列開著而且沒有任何條件 ⇒ 關；否則開。
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTicketStore } from "../../../store/ticketStore";
import { isFilterActive } from "../../../domain/ticketView";

export const SEARCH_PLACEHOLDER = "搜尋備註、分類、帳戶、金額…";
const DEBOUNCE_MS = 150;

const SearchIcon = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" aria-hidden="true">
    <circle cx="7" cy="7" r="4.6" />
    <path d="M10.6 10.6 14 14" />
  </svg>
);
const XIcon = () => (
  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" aria-hidden="true">
    <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
  </svg>
);
const FunnelIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2.5 3.5h11l-4.3 5v4.2l-2.4 1.1V8.5z" />
  </svg>
);

export function SearchBar() {
  const filter = useTicketStore((s) => s.filter);
  const searchOpen = useTicketStore((s) => s.searchOpen);
  const store = useTicketStore.getState;
  const structural = isFilterActive({ ...filter, text: "" });

  // 本地字（去抖期間的字）；store 的字被別人改了（closeSearch、下鑽、清除）就跟上
  const [text, setText] = useState(filter.text);
  const sent = useRef(filter.text);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (filter.text !== sent.current) {
      sent.current = filter.text;
      setText(filter.text);
    }
  }, [filter.text]);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const send = (v: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (v === sent.current && useTicketStore.getState().filter.text === v) return;
    sent.current = v;
    void store().setFilterText(v);
  };
  const schedule = (v: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => send(v), DEBOUNCE_MS);
  };

  const focusList = () => {
    const root = document.querySelector<HTMLElement>(".page.ns-tk");
    (root?.querySelector<HTMLElement>(".ns-tk-list") ?? root)?.focus({ preventScroll: true });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter") {
      e.preventDefault();
      send(e.currentTarget.value);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (text) {
        setText("");
        send("");
      } else {
        if (timer.current) clearTimeout(timer.current);
        store().closeSearch();
        focusList();
      }
    }
  };

  return (
    <div className={"ns-tk-searchwrap" + (searchOpen ? " is-open" : "")}>
      <label className="ns-tk-search">
        <SearchIcon />
        <input
          type="text"
          inputMode="search"
          placeholder={SEARCH_PLACEHOLDER}
          aria-label="搜尋帳目"
          spellCheck={false}
          autoComplete="off"
          value={text}
          onFocus={() => {
            if (!useTicketStore.getState().searchOpen) store().openSearch();
          }}
          onChange={(e) => {
            setText(e.target.value);
            if ((e.nativeEvent as InputEvent).isComposing) return; // 組字中只記字，compositionend 再查
            schedule(e.target.value);
          }}
          onCompositionEnd={(e) => schedule(e.currentTarget.value)}
          onKeyDown={onKeyDown}
        />
        {text ? (
          <button
            type="button"
            className="clr"
            aria-label="清除搜尋"
            title="清除"
            onMouseDown={(e) => e.preventDefault() /* 焦點留在框裡 */}
            onClick={() => {
              setText("");
              send("");
            }}
          >
            <XIcon />
          </button>
        ) : (
          <kbd className="ns-tk-kbd">/</kbd>
        )}
      </label>
      <button
        type="button"
        className="ns-tk-filterbtn"
        aria-pressed={searchOpen}
        aria-label="篩選"
        title="篩選（期間、帳戶、分類、類型、路線）"
        onClick={() => {
          const s = useTicketStore.getState();
          if (s.searchOpen && !isFilterActive(s.filter)) s.closeSearch();
          else s.openSearch();
        }}
      >
        <FunnelIcon />
        {structural && <i className="dot" aria-hidden />}
      </button>
    </div>
  );
}
