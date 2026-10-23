/**
 * ColorPicker——挑顏色（視覺規範 §2.5「顏色」、§1.1「兩盤共存、不硬併」；丙-2 契約 §1 第 7 件）。
 * 依場景載入一盤：路線盤 `route`（4 格，DB 存 `var(--route-preset-N)` 字串）或分類盤 `category`（8 格，DB 存 `color_idx` 1–8）；
 * 兩盤的值不對應，硬併會改到使用者既有的顏色，所以分開。「自訂…」＝色塊預覽＋原生 `<input type="color">`；**沒有色碼文字框**。
 * 取代 RouteDialog 的色碼文字框與 RoutePanel 的無字「＋」（丙-3～6 套用）。
 * 長相＝prototypes/ui-brand「ColorPicker」；樣式在 `./datefield.css` 的 `.ns-colorpick`／`.ns-sw`／`.ns-sw-custom`。
 *
 *   div.ns-colorpick[role=radiogroup]
 *     button.ns-sw[role=radio][aria-checked]（style --c＝var(--route-preset-N)｜var(--cat-N)）×4｜×8
 *     label.ns-sw-custom（custom 才有）> span.pv（--pv＝自訂色）＋「自訂…」＋ input[type=color]（透明蓋滿整顆）
 *
 * 色名表（§1.1）：路線＝藍鼠／梅紫／松葉／利休鼠（銀河同名，值不同名不改；RouteDialog 的「洗朱」改梅紫）；分類沒有色名，只有「第 N 色」。
 * 選中＝外環 `--sel-line`（2px `--accent`，粉彩靛、銀河金；§2.10）；自訂色在用時「自訂…」那顆外框亮起。
 * 自訂：打開原生色盤時從「目前的顏色」起（預設色讀計算後的值，不寫死色碼）；拖動時只換預覽，關掉色盤（change）才 onChange。
 *
 * ARIA 與鍵盤：
 * - 外層 `role="radiogroup"`＋`aria-label`（預設「路線色」／「分類色」）；每格 `role="radio"`＋`aria-checked`＋`aria-label`／`title`＝色名。
 * - roving tabindex：Tab 只停一格（選中的那格，沒選中＝第一格）；←↑／→↓ 換到前／後一格並選取（循環）、Home／End 第一／最後；
 *   處理過的鍵 preventDefault＋stopPropagation（不漏給頁面的鍵盤表）；Space／Enter＝原生按鈕點選。
 * - 「自訂…」是另一個 Tab 停點（原生 color input，`aria-label`「自訂顏色」）；Enter／Space 開原生色盤。
 */
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";

/** 路線盤色名（§1.1；RoutePanel.tsx 同表） */
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
  /** 顯示「自訂…」（預設 false） */
  custom?: boolean;
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
  const { palette, value, custom = false, disabled = false, className } = props;
  const label = props.label ?? (palette === "route" ? "路線色" : "分類色");
  const swatches = swatchesOf(palette);
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const colorRef = useRef<HTMLInputElement>(null);

  const customOn = typeof value === "string" && HEX_RE.test(value);
  /** 自訂色的預覽（拖動原生色盤時即時換；值換掉就跟著值走） */
  const [draft, setDraft] = useState<string | null>(customOn ? (value as string) : null);
  useEffect(() => {
    setDraft(typeof value === "string" && HEX_RE.test(value) ? value : null);
  }, [value]);

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
    const start = draft ?? (sel ? resolveHex(rootRef.current, sel.css) : null) ?? resolveHex(rootRef.current, swatches[0].css);
    if (start && el.value !== start) el.value = start;
  };

  const checkedIdx = swatches.findIndex((s) => isChecked(palette, value, s));
  const tabIdx = checkedIdx >= 0 ? checkedIdx : 0;

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
          className={"ns-sw-custom" + (customOn ? " is-on" : "") + (draft ? "" : " is-blank")}
          style={draft ? ({ "--pv": draft } as CSSProperties) : undefined}
          title="自訂顏色"
        >
          <span className="pv" aria-hidden />
          自訂…
          <input
            ref={colorRef}
            type="color"
            aria-label={customOn ? "自訂顏色（使用中）" : "自訂顏色"}
            disabled={disabled}
            onPointerDown={prime}
            onFocus={prime}
            onChange={(e) => setDraft(e.target.value.toLowerCase())}
          />
        </label>
      )}
    </div>
  );
}
