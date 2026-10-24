/**
 * ColorPicker——挑顏色（視覺規範 §2.5「顏色」、§1.1「兩盤共存、不硬併」；丙-2 契約 §1 第 7 件）。
 * 依場景載入一盤：路線盤 `route`（4 格，DB 存 `var(--route-preset-N)` 字串）或分類盤 `category`（8 格，DB 存 `color_idx` 1–8）；
 * 兩盤的值不對應，硬併會改到使用者既有的顏色，所以分開。自訂入口＝跟預設色同大小的虛線小圓、中間一個「＋」，
 * 點了開原生 `<input type="color">`；**沒有色碼文字框**。選了自訂色之後那顆圓填成自訂色、「＋」消失。
 * （丙-3 曾換成「自訂…」虛線框 chip、色名搬到下方；使用者 10-24 要退回丙-3 以前側板那顆圓「＋」，彈窗與側板都用它。）
 * `showName`：色名寫在色列最右邊（預設色＝色名，自訂色＝色碼）；路線側板與新增路線彈窗都開，排法一樣。
 * 長相＝丙-3 以前 RoutePanel 的 `.roundel.custom`；樣式在 `./datefield.css` 的 `.ns-colorpick`／`.ns-sw`／`.ns-sw-custom`／`.ns-colorpick-name`。
 *
 *   div.ns-colorpick[role=radiogroup]
 *     button.ns-sw[role=radio][aria-checked]（style --c＝var(--route-preset-N)｜var(--cat-N)）×4｜×8
 *     label.ns-sw-custom（custom 才有；--pv＝自訂色）> 「＋」（沒自訂色才有）＋ input[type=color]（透明蓋滿整顆）
 *     span.ns-colorpick-name（showName 才有）
 *
 * 色名表（§1.1）：路線＝藍鼠／梅紫／松葉／利休鼠（銀河同名，值不同名不改；RouteDialog 的「洗朱」改梅紫）；分類沒有色名，只有「第 N 色」。
 * 選中＝外環 `--sel-line`（2px `--accent`，粉彩靛、銀河金；§2.10）；自訂色在用時那顆圓同樣亮外環。
 * 自訂：打開原生色盤時從「目前的顏色」起（預設色讀計算後的值，不寫死色碼）；拖動時只換預覽，關掉色盤（change）才 onChange。
 * 自訂圓的長相（填色／「＋」）跟著「值」走，拖動預覽只在跟開啟時的顏色不同時疊上去——
 * 取消色盤（Chromium 按 Esc 會退回開啟時的顏色並發 input）或失焦時預覽清掉，不會卡在「填了色、實際沒存」。
 *
 * ARIA 與鍵盤：
 * - 外層 `role="radiogroup"`＋`aria-label`（預設「路線色」／「分類色」）；每格 `role="radio"`＋`aria-checked`＋`aria-label`／`title`＝色名。
 * - roving tabindex：Tab 只停一格（選中的那格，沒選中＝第一格）；←↑／→↓ 換到前／後一格並選取（循環）、Home／End 第一／最後；
 *   處理過的鍵 preventDefault＋stopPropagation（不漏給頁面的鍵盤表）；Space／Enter＝原生按鈕點選。
 * - 自訂圓「＋」是另一個 Tab 停點（原生 color input，`aria-label`「自訂顏色」）；Enter／Space 開原生色盤。
 */
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";

/** 路線盤色名（§1.1；格子的 aria-label／title 與 showName 的字都用這張表） */
export const ROUTE_COLOR_NAMES: readonly string[] = ["藍鼠", "梅紫", "松葉", "利休鼠"];
/** 分類盤格數（`--cat-1..8`） */
export const CATEGORY_COLOR_COUNT = 8;

/** 路線預設色存進 DB 的字串（跟著主題換夜間色） */
export function routePresetColor(n: number): string {
  return `var(--route-preset-${n})`;
}

/** 自訂色：六位或三位十六進位色碼 */
const HEX_RE = /^#(?:[0-9a-f]{6}|[0-9a-f]{3})$/i;

interface CommonProps {
  /** 顯示自訂入口（虛線圓「＋」；預設 false） */
  custom?: boolean;
  /** 色列右邊寫色名（預設色＝色名、自訂色＝色碼；預設 false） */
  showName?: boolean;
  /** radiogroup 的 aria-label（預設 路線色／分類色） */
  label?: string;
  disabled?: boolean;
  className?: string;
}
export type ColorPickerProps =
  | (CommonProps & {
      palette: "route";
      /** `var(--route-preset-N)`，或自訂的十六進位色碼；null＝沒選 */
      value: string | null;
      onChange(next: string): void;
    })
  | (CommonProps & {
      palette: "category";
      /** `color_idx` 1–8（數字或數字字串），或自訂的十六進位色碼；null＝沒選 */
      value: number | string | null;
      /** 預設格回 `color_idx`（數字）；自訂回十六進位色碼字串 */
      onChange(next: number | string): void;
    });

interface Swatch {
  css: string;
  name: string;
  out: string | number;
}

function swatchesOf(palette: "route" | "category"): Swatch[] {
  if (palette === "route") {
    return ROUTE_COLOR_NAMES.map((name, i) => ({ css: routePresetColor(i + 1), name, out: routePresetColor(i + 1) }));
  }
  return Array.from({ length: CATEGORY_COLOR_COUNT }, (_, i) => ({ css: `var(--cat-${i + 1})`, name: `第 ${i + 1} 色`, out: i + 1 }));
}

/** 這一格是不是目前的值（路線比字串；分類比 color_idx，數字字串也算） */
function isChecked(palette: "route" | "category", value: string | number | null, sw: Swatch): boolean {
  if (value === null) return false;
  if (palette === "route") return value === sw.out;
  const n = typeof value === "number" ? value : /^\d+$/.test(value) ? Number(value) : NaN;
  return n === sw.out;
}

/** 把一個 CSS 顏色（多半是 var(--…)）解成十六進位色碼——原生 color input 只吃這種；解不出回 null */
function resolveHex(host: HTMLElement | null, css: string): string | null {
  if (!host) return null;
  const probe = document.createElement("span");
  probe.style.display = "none";
  probe.style.color = css;
  host.appendChild(probe);
  const computed = getComputedStyle(probe).color; // 計算後的三個通道（0–255）
  probe.remove();
  const m = computed.match(/(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)/);
  if (!m) return null;
  return "#" + [m[1], m[2], m[3]].map((v) => Math.min(255, Math.round(Number(v))).toString(16).padStart(2, "0")).join("");
}

export function ColorPicker(props: ColorPickerProps) {
  const { palette, value, custom = false, showName = false, disabled = false, className } = props;
  const label = props.label ?? (palette === "route" ? "路線色" : "分類色");
  const swatches = swatchesOf(palette);
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const colorRef = useRef<HTMLInputElement>(null);

  const customOn = typeof value === "string" && HEX_RE.test(value);
  /** 拖動原生色盤時的預覽色（只在色盤開著時有；值換掉就清掉） */
  const [draft, setDraft] = useState<string | null>(null);
  /** 打開色盤時的起始色——預覽跟它一樣＝沒拖或已取消，不算預覽 */
  const primed = useRef<string | null>(null);
  useEffect(() => {
    setDraft(null);
  }, [value]);
  const preview = draft !== null && draft !== primed.current ? draft : null;
  /** 自訂圓實際顯示的顏色：拖動中的預覽，否則是目前的自訂值（沒有就空、顯示「＋」） */
  const shown = preview ?? (customOn ? (value as string) : null);

  const emit = (out: string | number): void => {
    if (props.palette === "route") props.onChange(String(out));
    else props.onChange(out);
  };

  // 原生 color input：input 事件只換預覽，change（關掉色盤）才寫回——拖動時不要每一格都存一次
  const live = useRef({ emit, value });
  live.current = { emit, value };
  useEffect(() => {
    const el = colorRef.current;
    if (!el) return;
    const onCommit = (): void => {
      const hex = el.value.toLowerCase();
      if (HEX_RE.test(hex) && hex !== live.current.value) live.current.emit(hex);
    };
    el.addEventListener("change", onCommit);
    return () => el.removeEventListener("change", onCommit);
  }, [custom]);

  /** 打開原生色盤前：從目前的顏色起（自訂色＝它；預設格＝那格計算後的值） */
  const prime = (): void => {
    const el = colorRef.current;
    if (!el) return;
    const sel = swatches.find((s) => isChecked(palette, value, s));
    const start = (customOn ? (value as string).toLowerCase() : null) ?? (sel ? resolveHex(rootRef.current, sel.css) : null) ?? resolveHex(rootRef.current, swatches[0].css);
    if (start && el.value !== start) el.value = start;
    primed.current = start ?? el.value.toLowerCase();
    setDraft(null);
  };

  const checkedIdx = swatches.findIndex((s) => isChecked(palette, value, s));
  const tabIdx = checkedIdx >= 0 ? checkedIdx : 0;
  /** 色列右邊的字：預設色＝色名；自訂色＝色碼（拖動原生色盤時跟著預覽走，關掉色盤回到看值） */
  const name = preview ?? (customOn ? (value as string) : checkedIdx >= 0 ? swatches[checkedIdx].name : "");

  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number): void => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const n = swatches.length;
    let j = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") j = (i + 1) % n;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") j = (i - 1 + n) % n;
    else if (e.key === "Home") j = 0;
    else if (e.key === "End") j = n - 1;
    if (j < 0) return;
    e.preventDefault();
    e.stopPropagation();
    btnRefs.current[j]?.focus();
    if (!isChecked(palette, value, swatches[j])) emit(swatches[j].out);
  };

  return (
    <div
      ref={rootRef}
      className={"ns-colorpick" + (className ? " " + className : "")}
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
    >
      {swatches.map((s, i) => {
        const on = i === checkedIdx;
        return (
          <button
            key={s.css}
            ref={(el) => {
              btnRefs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={s.name}
            title={s.name}
            className={"ns-sw" + (on ? " is-on" : "")}
            style={{ "--c": s.css } as CSSProperties}
            tabIndex={i === tabIdx ? 0 : -1}
            disabled={disabled}
            onClick={() => {
              if (!on) emit(s.out);
            }}
            onKeyDown={(e) => onKey(e, i)}
          />
        );
      })}
      {custom && (
        <label
          className={"ns-sw-custom" + (customOn ? " is-on" : "") + (shown ? " is-filled" : "")}
          style={shown ? ({ "--pv": shown } as CSSProperties) : undefined}
          title={customOn ? `自訂顏色 ${shown}` : "自訂顏色"}
        >
          {!shown && <span className="plus" aria-hidden>＋</span>}
          <input
            ref={colorRef}
            type="color"
            aria-label={customOn ? `自訂顏色（使用中 ${shown}）` : "自訂顏色"}
            disabled={disabled}
            onPointerDown={prime}
            onFocus={prime}
            onChange={(e) => setDraft(e.target.value.toLowerCase())}
            onBlur={() => setDraft(null)}
          />
        </label>
      )}
      {showName && name && (
        <span className="ns-colorpick-name" aria-hidden>
          {name}
        </span>
      )}
    </div>
  );
}
