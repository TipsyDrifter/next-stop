/**
 * PopMenu——列旁的小選單（10-20 磨光②：今日「＋」分裂鈕的 ▾、大綱每列的 ⋯）。
 * 補「只有快捷鍵才做得到」的功能一個可點的入口（路線圖原則「每個功能都要有可點的入口」）。
 *
 * 長相與鍵盤照今日頁推遲小卡（DeferPopover／defer.css）——不另發明形狀：
 *   紙卡＝.techo-card、眉標＝.techo-overline、項目＝一行文字鈕（左動作、右淡字）、分隔＝--color-dash 虛線。
 *   右側淡字＝這個動作的快捷鍵，字樣由 registry 產（hotkeys.ts 的 formatChord，與指引頁同一份）。
 * 鍵盤：開卡焦點落第一個可用項・↑↓ 在可用項間移動・Enter／Space 由按鈕自己啟動・Tab 卡內循環・
 *   Esc 收卡並把焦點交回 returnFocus（預設＝anchor）。點卡外＝收；點回 anchor 不處理（交給 anchor 自己 toggle）。
 *   卡內按鍵一律不往上冒（視圖的導航表是容器層 onKeyDown，冒上去會對選中列動手；Ctrl／⌘ 組合鍵放行給全域表）。
 * 掛在 document.body（portal）：列會 hover 位移（transform），fixed 定位放在列裡會跟著跑。
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { formatChord, hotkeyById } from "../shell/hotkeys";
import "./popmenu.css";

export interface PopMenuItem {
  key: string;
  label: string;
  /** registry 的快捷鍵 id：右側淡字顯示它的鍵帽（如「Alt+↑」） */
  hotkeyId?: string;
  disabled?: boolean;
  /** disabled 時滑過的說明（為什麼現在不能做） */
  why?: string;
  /** 這一項之前畫一道虛線撕線 */
  cut?: boolean;
  onSelect: () => void;
}

export interface PopMenuProps {
  anchor: HTMLElement | null;
  /** 眉標（.techo-overline），例「新增 — NEW」 */
  overline: string;
  /** 讀屏用名稱 */
  label: string;
  items: PopMenuItem[];
  onClose: () => void;
  /** Esc 收卡後焦點交給誰（預設 anchor） */
  returnFocus?: () => HTMLElement | null;
}

/** 鍵帽字樣：registry 第一組 chord（Windows「Alt+↑」、Mac「⌥+↑」） */
export function hotkeyCaps(id: string): string {
  const hk = hotkeyById(id);
  return hk ? formatChord(hk.chords[0]).join("+") : "";
}

export function PopMenu({ anchor, overline, label, items, onClose, returnFocus }: PopMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  /* 定位：anchor 下方、右緣對齊 anchor 右緣（觸發鈕都在列或標題列的右側），clamp 進視窗 */
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { offsetWidth: w, offsetHeight: h } = el;
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = document.documentElement.clientHeight || window.innerHeight;
    const M = 12;
    if (!anchor) {
      setPos({ top: Math.round(vh * 0.24), left: Math.round((vw - w) / 2) });
      return;
    }
    const r = anchor.getBoundingClientRect();
    let top = r.bottom + 6;
    if (top + h > vh - M) top = Math.max(M, r.top - h - 6);
    const left = Math.max(M, Math.min(r.right - w, vw - w - M));
    setPos({ top: Math.round(top), left: Math.round(left) });
  }, [anchor]);

  /* 落位後才 focus（落位前 visibility:hidden，focus 是 no-op——DeferPopover 同一個坑） */
  const focusedOnce = useRef(false);
  useEffect(() => {
    if (!pos || focusedOnce.current) return;
    focusedOnce.current = true;
    ref.current?.querySelector<HTMLButtonElement>("button[data-menu-item]:not(:disabled)")?.focus();
  }, [pos]);

  /* 點卡外＝收（點回 anchor 交給 anchor 自己 toggle） */
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (ref.current?.contains(t)) return;
      if (anchor?.contains(t)) return;
      onClose();
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [anchor, onClose]);

  const close = (refocus: boolean) => {
    onClose();
    if (refocus) (returnFocus ? returnFocus() : anchor)?.focus({ preventScroll: true });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    // Ctrl／⌘ 組合鍵放行給全域表（換頁、搜尋…）；Ctrl+/ 例外擋下（指引頁不疊在小卡上，同推遲小卡）
    if (e.ctrlKey || e.metaKey) {
      if (e.key === "/") {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      close(true);
      return;
    }
    const enabled = Array.from(
      ref.current?.querySelectorAll<HTMLButtonElement>("button[data-menu-item]") ?? [],
    ).filter((b) => !b.disabled);
    if (!enabled.length) return;
    const i = enabled.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const d = e.key === "ArrowDown" ? 1 : -1;
      const j = i < 0 ? (d > 0 ? 0 : enabled.length - 1) : (i + d + enabled.length) % enabled.length;
      enabled[j]?.focus();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      enabled[e.key === "Home" ? 0 : enabled.length - 1]?.focus();
    } else if (e.key === "Tab") {
      e.preventDefault();
      const j = e.shiftKey ? (i <= 0 ? enabled.length - 1 : i - 1) : i >= enabled.length - 1 ? 0 : i + 1;
      enabled[j]?.focus();
    }
  };

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      onKeyDown={onKeyDown}
      onMouseDown={(e) => e.stopPropagation()}
      className="ns-popmenu techo-card"
      style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? "visible" : "hidden" }}
    >
      <p className="techo-overline ns-popmenu-head">{overline}</p>
      <ul className="ns-popmenu-list" role="none">
        {items.map((it) => {
          const caps = it.hotkeyId ? hotkeyCaps(it.hotkeyId) : "";
          return (
            // 停用項的說明掛在 li：disabled 的 <button> 收不到滑鼠事件，title 掛它身上滑過不會浮
            <li key={it.key} role="none" className={it.cut ? "cut" : undefined} title={it.disabled ? it.why : undefined}>
              <button
                type="button"
                role="menuitem"
                data-menu-item
                disabled={it.disabled}
                className="ns-popmenu-item"
                onClick={() => {
                  close(false);
                  it.onSelect();
                }}
              >
                <span>{it.label}</span>
                {caps && <kbd className="caps">{caps}</kbd>}
              </button>
            </li>
          );
        })}
      </ul>
    </div>,
    document.body,
  );
}
