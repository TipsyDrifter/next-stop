/**
 * Select——自訂手帳紙卡下拉選單（取代原生 <select> 的系統白底選單）。
 *
 * 支援兩種餵選項方式：
 * 1. `options?: readonly SelectOption[]`
 * 2. 原生 `<option>`／`<optgroup>` children（方便既有呼叫端無痛替換）
 *
 * 浮層走 `createPortal(..., document.body)` 掛 `.techo-card.ns-select-pop`，
 * 字色固定吃 `var(--color-ink)`，在粉彩星空、銀河鐵道與四款商店主題下皆清晰可讀。
 */
import {
  Children,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { placeBelow, useOutsideDismiss } from "./anchorPop";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
  title?: string;
  group?: string;
}

export interface SelectProps {
  id?: string;
  value?: string | number;
  defaultValue?: string | number;
  onChange?: (value: string) => void;
  options?: readonly SelectOption[];
  children?: ReactNode;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
  title?: string;
  /** 疊在自訂外觀上的透明觸發鈕（例如 RoutinesTab 的分類圓牌＋名稱） */
  overlay?: boolean;
}

function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

function parseChildren(children: ReactNode, group?: string): SelectOption[] {
  const out: SelectOption[] = [];
  for (const child of Children.toArray(children)) {
    if (!isValidElement(child)) continue;
    const el = child as ReactElement<{
      value?: string | number;
      disabled?: boolean;
      title?: string;
      label?: string;
      children?: ReactNode;
    }>;
    if (el.type === "optgroup") {
      out.push(...parseChildren(el.props.children, el.props.label ?? ""));
    } else if (el.type === "option") {
      const label = textOf(el.props.children);
      const val = el.props.value !== undefined ? String(el.props.value) : label;
      out.push({
        value: val,
        label,
        disabled: Boolean(el.props.disabled),
        title: el.props.title,
        group,
      });
    } else if (el.props?.children) {
      out.push(...parseChildren(el.props.children, group));
    }
  }
  return out;
}

export function Select({
  id,
  value,
  defaultValue,
  onChange,
  options,
  children,
  disabled = false,
  className,
  "aria-label": ariaLabel,
  title,
  overlay = false,
}: SelectProps) {
  const listId = useId();
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const items = useMemo<readonly SelectOption[]>(
    () => (options ? options : parseChildren(children)),
    [options, children],
  );

  const [innerVal, setInnerVal] = useState<string>(() =>
    defaultValue !== undefined ? String(defaultValue) : (items[0]?.value ?? ""),
  );
  const curVal = value !== undefined ? String(value) : innerVal;

  const selected = useMemo(
    () => items.find((it) => it.value === curVal) ?? items[0],
    [items, curVal],
  );

  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState<number>(-1);
  const [pos, setPos] = useState<{ top: number; left: number; minWidth: number } | null>(null);

  const close = useCallback(() => {
    setOpen(false);
  }, []);

  useOutsideDismiss(popRef, close, btnRef.current);

  const place = useCallback(() => {
    const btn = btnRef.current;
    const pop = popRef.current;
    if (!btn || !pop) return;
    const anchorEl = (btn.closest(".ns-select-wrap, .ns-tt-rtmgr-cat") as HTMLElement | null) ?? btn;
    const rect = anchorEl.getBoundingClientRect();
    const at = placeBelow(anchorEl, pop);
    const minWidth = Math.max(Math.round(rect.width), 96);
    setPos((prev) => (at ? { ...at, minWidth } : prev ?? { top: rect.bottom + 4, left: rect.left, minWidth }));
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    place();
  }, [open, place, items.length]);

  useEffect(() => {
    if (!open) return;
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const idx = items.findIndex((it) => it.value === curVal && !it.disabled);
    const fallback = items.findIndex((it) => !it.disabled);
    setActiveIdx(idx >= 0 ? idx : fallback);
  }, [open, items, curVal]);

  useEffect(() => {
    if (!open || activeIdx < 0) return;
    const pop = popRef.current;
    if (!pop) return;
    const optEl = pop.querySelector<HTMLElement>(`[data-opt-idx="${activeIdx}"]`);
    optEl?.scrollIntoView({ block: "nearest" });
  }, [open, activeIdx]);

  const pick = useCallback(
    (nextVal: string, viaMouse: boolean) => {
      if (value === undefined) setInnerVal(nextVal);
      onChange?.(nextVal);
      setOpen(false);
      const btn = btnRef.current;
      if (!btn) return;
      if (viaMouse && btn.closest(".ns-tt-pagehead")) {
        btn.blur();
      } else {
        btn.focus({ preventScroll: true });
      }
    },
    [value, onChange],
  );

  useEffect(() => {
    if (!open) return;
    const moveActive = (delta: number) => {
      const enabledIndices = items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0);
      if (enabledIndices.length === 0) return;
      const curPos = enabledIndices.indexOf(activeIdx);
      const nextPos =
        curPos < 0
          ? delta > 0
            ? 0
            : enabledIndices.length - 1
          : (curPos + delta + enabledIndices.length) % enabledIndices.length;
      setActiveIdx(enabledIndices[nextPos]);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        btnRef.current?.focus({ preventScroll: true });
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        moveActive(1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        moveActive(-1);
      } else if (e.key === "Home") {
        e.preventDefault();
        e.stopPropagation();
        const first = items.findIndex((it) => !it.disabled);
        if (first >= 0) setActiveIdx(first);
      } else if (e.key === "End") {
        e.preventDefault();
        e.stopPropagation();
        for (let i = items.length - 1; i >= 0; i--) {
          if (!items[i].disabled) {
            setActiveIdx(i);
            break;
          }
        }
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        const target = items[activeIdx];
        if (target && !target.disabled) pick(target.value, false);
      } else if (e.key === "Tab") {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, items, activeIdx, pick]);

  const onBtnClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (disabled) return;
    setOpen((o) => !o);
  };

  const onBtnKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled || open) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      setOpen(true);
    }
  };

  const cls = [
    "ns-select-btn",
    overlay ? "is-overlay" : "",
    open ? "is-open" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  let lastGroup: string | undefined;

  return (
    <>
      <button
        ref={btnRef}
        id={id}
        type="button"
        disabled={disabled}
        className={cls}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        title={title ?? selected?.title}
        data-ns-select=""
        onClick={onBtnClick}
        onKeyDown={onBtnKeyDown}
      >
        {overlay ? (
          <span className="sr-only">{selected?.label ?? ""}</span>
        ) : (
          <span className="ns-select-label">{selected?.label ?? ""}</span>
        )}
      </button>
      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={popRef}
            id={listId}
            role="listbox"
            aria-label={ariaLabel}
            className="techo-card ns-select-pop techo-scroll"
            style={{
              top: pos?.top ?? 0,
              left: pos?.left ?? 0,
              minWidth: pos?.minWidth ?? 96,
              visibility: pos ? undefined : "hidden",
            }}
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {items.map((opt, idx) => {
              const showGroup = opt.group !== undefined && opt.group !== lastGroup;
              lastGroup = opt.group;
              const isSel = opt.value === curVal;
              const isAct = idx === activeIdx;
              return (
                <div key={`${opt.group ?? ""}:${opt.value}:${idx}`} role="presentation">
                  {showGroup && (
                    <div className="ns-select-group" role="presentation">
                      {opt.group}
                    </div>
                  )}
                  <button
                    type="button"
                    role="option"
                    aria-selected={isSel}
                    disabled={opt.disabled}
                    title={opt.title}
                    data-opt-idx={idx}
                    className={
                      "ns-select-opt" +
                      (isSel ? " is-selected" : "") +
                      (isAct ? " is-active" : "") +
                      (opt.group ? " is-grouped" : "")
                    }
                    onMouseEnter={() => {
                      if (!opt.disabled) setActiveIdx(idx);
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!opt.disabled) pick(opt.value, true);
                    }}
                  >
                    <span className="ns-select-opt-label">{opt.label}</span>
                  </button>
                </div>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}
