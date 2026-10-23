/**
 * InlineInput——大綱行內輸入框（新增草稿／改名共用；視覺＝原型 .title 位置的同款字（class 由父層給 "title"，輸入框本身透明無邊；outline.css .ns-inline-input）。對應 UI Flow 2.0b。
 * 職責：持有輸入文字、IME 護欄、把 Enter／Esc／Tab／blur 轉成語義回呼（onCommit／onCancel／onTab）；不碰 store。
 * 取捨：blur 延一個 rAF 再提交——列 DOM 被搬動（升降層）造成的瞬時失焦不誤提交；整個視窗失焦（切去別的 App）也不提交、保留草稿。
 *
 * ── UI 丙-2 搬家（契約 §1 #18；2026-10-22）──
 * 用途：行內輸入框（大綱新增／改名、今日建票草稿列、乘務記錄行內輸入共用）。
 * 規範：視覺規範 §2.5（輸入框；字由父層 class 給，本身透明無邊）。
 * ARIA：aria-label 由呼叫端給；spellCheck／autoComplete 關。
 * 鍵盤：Enter＝onCommit("enter")、Esc＝onCancel、Tab／Shift+Tab＝onTab（三者都 stopPropagation）；IME 組字中不攔；blur 見上（延一拍判斷）。
 * 樣式：本元件沒有自己的 css（.ns-inline-input 只當掛鉤；長相由父層 .ns-outline .ticket input.title 等給），無 css 可搬。
 *   原路徑 outline/InlineInput.tsx 只剩 re-export（呼叫端 import 不動，丙-3～6 再改）。
 */
import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";

export type CommitVia = "enter" | "blur";

export interface InlineInputProps {
  initial?: string;
  placeholder?: string;
  ariaLabel: string;
  /** 變動時重新聚焦（列在樹中換了位置／深度之後，focus 會被瀏覽器丟掉） */
  focusKey?: string | number;
  className?: string;
  onCommit: (text: string, via: CommitVia) => void;
  onCancel: () => void;
  onTab: (text: string, shift: boolean) => void;
}

export function InlineInput({
  initial = "",
  placeholder,
  ariaLabel,
  focusKey,
  className,
  onCommit,
  onCancel,
  onTab,
}: InlineInputProps) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  // 最新的值與回呼放 ref，rAF 內才不會拿到舊 closure
  const latest = useRef({ onCommit, value });
  latest.current = { onCommit, value };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [focusKey]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      onCommit(value, "enter");
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    } else if (e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      onTab(value, e.shiftKey);
    }
    // 其餘按鍵交給輸入框本身；容器層看到 target 是 input 會略過導航快捷鍵
  };

  const onBlur = (e: FocusEvent<HTMLInputElement>) => {
    const el = ref.current;
    if (!el) return;
    const commit = () => latest.current.onCommit(latest.current.value, "blur");
    // 焦點明確去了別處（點別列→容器、點別的按鈕／輸入框）→ 立刻提交
    if (e.relatedTarget) {
      commit();
      return;
    }
    // relatedTarget 為空＝三種可能：列 DOM 被搬動（稍後會重新聚焦）／整個視窗失焦／點到不可聚焦處——延一拍再判斷
    setTimeout(() => {
      if (!el.isConnected) return; // 已卸載（提交／取消後）→ 不重複提交
      if (document.activeElement === el) return; // 瞬時失焦（搬動後已重新聚焦）
      if (!document.hasFocus()) return; // 整個視窗失焦 → 保留草稿
      commit();
    }, 60);
  };

  return (
    <input
      ref={ref}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
      placeholder={placeholder}
      aria-label={ariaLabel}
      spellCheck={false}
      autoComplete="off"
      className={"ns-inline-input " + (className ?? "")}
    />
  );
}
