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
 *
 * ── UI 丙-3（契約 G2）──
 *   - `PopMenuItem.danger`：破壞性項目（刪除…）赭字 `--danger`；hover／鍵盤聚焦底 `--danger-bg`、字仍赭（不轉作用中色）。
 *     規範 §2.4：一層、≤7 項、破壞性項目放最後（通常再加 `cut` 虛線隔開）——順序由呼叫端排，元件不重排。
 *   - `overline` 吃 `string | {zh, latin}`：物件＝PageHeader 同一種畫法（粉彩只畫拉丁斜體、銀河「中 — LATIN」）；
 *     字串＝照字面（別線舊呼叫端不用改）。新寫的呼叫端一律給物件。
 *
 * ── 回饋乙（右鍵選單、編排群組）──
 *   - `at`：照座標開（右鍵＝游標位置，左上角對齊游標、clamp 進視窗）；有 `at` 就不看 anchor 定位。
 *   - `PopMenuItem.group`：同一個 group 的連續項目收成一列可展開的「{group} ▾」（跟手機票卡 sheet 的「編排 ▾」同一種結構），
 *     點開才列出來；頂層照規範 §2.4 維持 ≤7 項。群組列沿用第一個成員的 `cut`。
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { formatChord, hotkeyById } from "../shell/hotkeys";
import { OverlineText, type Overline } from "./PageHeader";
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
  /** 破壞性項目（刪除…）：赭字；放在最後 */
  danger?: boolean;
  /** 收進可展開群組的名字（例「編排」）：同名的連續項目畫成一列「編排 ▾」，點開才列出 */
  group?: string;
  /** 項目下面一句淡字用途（丁 D-主-249：「＋ 新增 ▾」三種各寫一句，例「一件要做的事，可拆成車廂與車票」） */
  hint?: string;
  onSelect: () => void;
}

export interface PopMenuProps {
  anchor: HTMLElement | null;
  /** 眉標（.techo-overline）：物件 `{zh:"這張車票", latin:"Ticket"}`（新寫法）；字串照字面（舊呼叫端，例「新增 — NEW」） */
  overline: Overline;
  /** 讀屏用名稱 */
  label: string;
  items: PopMenuItem[];
  onClose: () => void;
  /** Esc 收卡後焦點交給誰（預設 anchor） */
  returnFocus?: () => HTMLElement | null;
  /** 照座標開（右鍵選單）：viewport px */
  at?: { x: number; y: number };
}

/** 鍵帽字樣：registry 第一組 chord（Windows「Alt+↑」、Mac「⌥+↑」） */
export function hotkeyCaps(id: string): string {
  const hk = hotkeyById(id);
  return hk ? formatChord(hk.chords[0]).join("+") : "";
}

type MenuRow = { kind: "item"; item: PopMenuItem } | { kind: "group"; name: string; cut: boolean; items: PopMenuItem[] };

/** 同 group 的連續項目收成一列（呼叫端照順序排；不連續的同名會變成兩組） */
export function rowsOf(items: readonly PopMenuItem[]): MenuRow[] {
  const out: MenuRow[] = [];
  for (const it of items) {
    const last = out[out.length - 1];
    if (it.group && last?.kind === "group" && last.name === it.group) last.items.push(it);
    else if (it.group) out.push({ kind: "group", name: it.group, cut: !!it.cut, items: [it] });
    else out.push({ kind: "item", item: it });
  }
  return out;
}

export function PopMenu({ anchor, overline, label, items, onClose, returnFocus, at }: PopMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(() => new Set());

  /* 定位：anchor 下方、右緣對齊 anchor 右緣（觸發鈕都在列或標題列的右側），clamp 進視窗 */
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { offsetWidth: w, offsetHeight: h } = el;
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = document.documentElement.clientHeight || window.innerHeight;
    const M = 12;
    if (at) {
      const top = at.y + h > vh - M ? Math.max(M, at.y - h) : at.y;
      const left = at.x + w > vw - M ? Math.max(M, at.x - w) : at.x;
      setPos({ top: Math.round(top), left: Math.round(left) });
      return;
    }
    if (!anchor) {
      setPos({ top: Math.round(vh * 0.24), left: Math.round((vw - w) / 2) });
      return;
    }
    const r = anchor.getBoundingClientRect();
    let top = r.bottom + 6;
    if (top + h > vh - M) top = Math.max(M, r.top - h - 6);
    const left = Math.max(M, Math.min(r.right - w, vw - w - M));
    setPos({ top: Math.round(top), left: Math.round(left) });
  }, [anchor, at?.x, at?.y, openGroups]);

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

  const itemRow = (it: PopMenuItem, top: boolean) => {
    const caps = it.hotkeyId ? hotkeyCaps(it.hotkeyId) : "";
    return (
      // 停用項的說明掛在 li：disabled 的 <button> 收不到滑鼠事件，title 掛它身上滑過不會浮
      <li key={it.key} role="none" className={top && it.cut ? "cut" : undefined} title={it.disabled ? it.why : undefined}>
        <button
          type="button"
          role="menuitem"
          data-menu-item
          disabled={it.disabled}
          className={(it.danger ? "ns-popmenu-item is-danger" : "ns-popmenu-item") + (it.hint ? " has-hint" : "")}
          onClick={() => {
            close(false);
            it.onSelect();
          }}
        >
          {it.hint ? (
            <span className="ns-popmenu-two">
              <span>{it.label}</span>
              <small className="hint">{it.hint}</small>
            </span>
          ) : (
            <span>{it.label}</span>
          )}
          {caps && <kbd className="caps">{caps}</kbd>}
        </button>
      </li>
    );
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
      <p className="techo-overline ns-popmenu-head">
        <OverlineText value={overline} />
      </p>
      <ul className="ns-popmenu-list" role="none">
        {rowsOf(items).map((row) => {
          if (row.kind === "item") return itemRow(row.item, true);
          const open = openGroups.has(row.name);
          return (
            <li key={`g:${row.name}`} role="none" className={row.cut ? "cut" : undefined}>
              <button
                type="button"
                role="menuitem"
                data-menu-item
                aria-expanded={open}
                className="ns-popmenu-item ns-popmenu-group"
                onClick={() =>
                  setOpenGroups((cur) => {
                    const n = new Set(cur);
                    if (open) n.delete(row.name);
                    else n.add(row.name);
                    return n;
                  })
                }
              >
                <span>{row.name}</span>
                <span className="caret" aria-hidden="true">{open ? "▴" : "▾"}</span>
              </button>
              {open && (
                <ul className="ns-popmenu-sub" role="group" aria-label={row.name}>
                  {row.items.map((it) => itemRow(it, false))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </div>,
    document.body,
  );
}
