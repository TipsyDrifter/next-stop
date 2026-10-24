/**
 * SearchBar——售票口「頁首下一列」左端的搜尋框（②契約 §5.1、§5.4、0-14、0-15；UI 丙-5 A3 搬家）。
 *
 * UI 丙-5 A3：平常頁首只有一顆放大鏡（PageHeader 的 search 格）；點了（或按 /）才開搜尋，本框畫在
 * 頁首下一列 `.ns-tk-subbar` 的左端、後面接 FilterChips。原本框右邊的漏斗鈕退役——搜尋開著時條件 chip 一直都在，不用再開一次。
 *
 *   label.ns-tk-search      放大鏡・input（placeholder「搜尋備註、分類、帳戶、金額…」）・有字 ⇒ × 清除；沒字 ⇒ kbd「/」
 *
 * - 打字去抖 150ms 再 `setFilterText`（store 直接查）；`Enter`＝立即查；IME 組字中不送（compositionend 再送）。
 * - `Esc`（輸入欄自理，不登記）：有字 ⇒ 清字；沒字 ⇒ 關搜尋（`closeSearch`）、焦點回清單。
 * - 聚焦就開搜尋（`openSearch`，月曆／統計會先切回清單——原型同）。
 * - `/`（useTicketKeyboard）與頁首放大鏡聚焦的是 `.ns-tk-subbar .ns-tk-search input`（`focusTicketSearch`）。
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTicketStore } from "../../../store/ticketStore";
import { IconClose, IconSearch } from "../../common/icons";

export const SEARCH_PLACEHOLDER = "搜尋備註、分類、帳戶、金額…";
const DEBOUNCE_MS = 150;

/** 聚焦搜尋框（搜尋剛打開時框要等下一輪 commit 才畫得出來：setTimeout，不用 rAF——視窗在背景時 rAF 不跑） */
export function focusTicketSearch(root: ParentNode | null = document): void {
  setTimeout(() => {
    const input = root?.querySelector<HTMLInputElement>(".ns-tk-subbar .ns-tk-search input");
    input?.focus();
    input?.select();
  });
}

export function SearchBar() {
  const filter = useTicketStore((s) => s.filter);
  const store = useTicketStore.getState;

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
    <label className="ns-tk-search">
      <IconSearch size={14} />
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
          <IconClose size={12} />
        </button>
      ) : (
        <kbd className="ns-tk-kbd">/</kbd>
      )}
    </label>
  );
}
