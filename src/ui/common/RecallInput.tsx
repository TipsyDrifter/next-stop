/**
 * RecallInput——會記得以前寫過什麼的文字欄（售票口④；備註記憶的共用元件，時刻表⑦ 的時間塊備註也接）。
 *
 * 用途：打一兩個字，欄位下面列出以前寫過、對得到的字，點一下（或鍵盤）就填好——像分類一樣選，不用整句重打。
 * 呼叫端只給「候選來源」（`items`；`domain/recall` 的 `tallyRecall` 可以幫忙數次數），比對、排序、鍵盤、手機點選都在這裡。
 *
 * Props 重點：
 *   - `value`／`onChange`：受控文字（呼叫端照舊管草稿或「離開才存」）。
 *   - `items`：候選；`null`＝還沒載（不出清單）。`onNeedItems`＝第一次聚焦時叫一次，讓呼叫端懶載。
 *   - `onPick(item)`：選了某一個（值已經經 onChange 換成 item.text）；要「選了就存」的呼叫端在這裡存。
 *   - `multiline`＋`rows`：textarea（Enter 照舊換行／交給呼叫端）；不給＝單行 input。
 *   - `onKeyDown`／`onFocus`／`onBlur`：本元件沒處理的鍵與事件照樣交給呼叫端（例：Enter 存檔、Esc 還原）。
 *   - `shell`：不給就看 `<html data-shell>`。手機＝清單在欄位正下方推開（不浮層，鍵盤不會蓋住）、一列 44px 好點。
 *   - `countText(n)`：列右側淡字（預設「N 次」；item.sub 優先）。`limit`（預設 6）、`minChars`（預設 1）。
 *
 * 規範：視覺規範 §2.5（表單控件；本元件不畫輸入框外觀，`className` 由呼叫端給，長相跟原本的欄位一樣）；
 *   清單＝紙卡 `.techo-card`（同 PopMenu）、列 hover／選中＝`--color-paper-used`＋左側 `--accent` 細線（同荷札建議）、對到的字加粗。
 * ARIA：欄位 role=combobox＋aria-autocomplete=list＋aria-expanded＋aria-controls＋aria-activedescendant；清單 role=listbox、列 role=option。
 * 鍵盤（清單開著才攔，IME 組字中一律不攔）：
 *   ↓／↑ 選列（從沒選開始）・Enter＝選中那列（沒選列就照舊交給呼叫端，例如存檔）・Tab＝補完（選中那列，沒選就第一列）・
 *   Esc＝收起清單（不漏給外層；再按一次才是呼叫端的 Esc）。清單收著時所有鍵照舊交給呼叫端。打字會重新打開。
 * 列一律 `onMouseDown` preventDefault：點列不搶欄位的焦點（不會先 blur 把「離開才存」的值存掉）。
 * 樣式：`./recall.css`。
 */
import { useEffect, useId, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type Ref } from "react";
import { rankRecall, type RecallHit, type RecallItem } from "../../domain/recall";
import "./recall.css";

export interface RecallInputProps<T extends RecallItem = RecallItem> {
  value: string;
  onChange(next: string): void;
  items: readonly T[] | null;
  onNeedItems?(): void;
  onPick?(item: T): void;
  multiline?: boolean;
  rows?: number;
  ariaLabel: string;
  placeholder?: string;
  className?: string;
  /** 外層 span 的額外 class（例：撐滿寬度） */
  wrapClassName?: string;
  limit?: number;
  minChars?: number;
  countText?(n: number): string;
  shell?: "desktop" | "mobile";
  autoFocus?: boolean;
  disabled?: boolean;
  inputRef?: Ref<HTMLInputElement & HTMLTextAreaElement>;
  onKeyDown?(e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>): void;
  onFocus?(e: FocusEvent<HTMLInputElement | HTMLTextAreaElement>): void;
  onBlur?(e: FocusEvent<HTMLInputElement | HTMLTextAreaElement>): void;
}

const defaultCount = (n: number): string => `${n} 次`;

function shellNow(): "desktop" | "mobile" {
  return typeof document !== "undefined" && document.documentElement.getAttribute("data-shell") === "mobile" ? "mobile" : "desktop";
}

export function RecallInput<T extends RecallItem = RecallItem>(props: RecallInputProps<T>) {
  const { value, onChange, items, onNeedItems, onPick, multiline, rows = 1, limit = 6, minChars = 1 } = props;
  const countText = props.countText ?? defaultCount;
  const shell = props.shell ?? shellNow();
  const listId = useId();
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [act, setAct] = useState(-1);
  const asked = useRef(false);

  const hits = useMemo<RecallHit<T>[]>(() => (items ? rankRecall(items, value, { limit, minChars }) : []), [items, value, limit, minChars]);
  const open = focused && !dismissed && !props.disabled && hits.length > 0;

  // 候選換了（打字、來源載好）⇒ 選中列歸零，免得 Enter 選到別的
  useEffect(() => setAct(-1), [hits]);

  const pick = (h: RecallHit<T>) => {
    onChange(h.item.text);
    setDismissed(true);
    setAct(-1);
    onPick?.(h.item);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (open && !(e.nativeEvent.isComposing || e.keyCode === 229)) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const n = hits.length;
        setAct((a) => (e.key === "ArrowDown" ? (a + 1) % n : a <= 0 ? n - 1 : a - 1));
        return;
      }
      if (e.key === "Enter" && act >= 0 && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        pick(hits[act]);
        return;
      }
      if (e.key === "Tab" && !e.shiftKey) {
        e.preventDefault();
        pick(hits[act >= 0 ? act : 0]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setDismissed(true);
        setAct(-1);
        return;
      }
    }
    props.onKeyDown?.(e);
  };

  const common = {
    role: "combobox",
    "aria-label": props.ariaLabel,
    "aria-autocomplete": "list" as const,
    "aria-expanded": open,
    "aria-controls": listId,
    "aria-activedescendant": open && act >= 0 ? `${listId}-${act}` : undefined,
    className: props.className,
    placeholder: props.placeholder,
    value,
    autoFocus: props.autoFocus,
    disabled: props.disabled,
    autoComplete: "off",
    onChange: (e: { target: { value: string } }) => {
      setDismissed(false);
      onChange(e.target.value);
    },
    onKeyDown,
    onFocus: (e: FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setFocused(true);
      if (!asked.current) {
        asked.current = true;
        onNeedItems?.();
      }
      props.onFocus?.(e);
    },
    onBlur: (e: FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setFocused(false);
      setDismissed(false);
      setAct(-1);
      props.onBlur?.(e);
    },
  };

  return (
    <span className={`ns-recall${shell === "mobile" ? " is-mobile" : ""}${props.wrapClassName ? ` ${props.wrapClassName}` : ""}`}>
      {multiline ? <textarea {...common} rows={rows} ref={props.inputRef} /> : <input {...common} type="text" ref={props.inputRef} />}
      {open && (
        <div className="ns-recall-list techo-card" role="listbox" id={listId} aria-label={`${props.ariaLabel}・以前寫過的`}>
          {hits.map((h, i) => {
            const n = h.item.count ?? 1;
            const sub = h.item.sub ?? (n > 1 ? countText(n) : null);
            return (
              <button
                key={h.item.text}
                type="button"
                role="option"
                id={`${listId}-${i}`}
                aria-selected={i === act}
                tabIndex={-1}
                className={`ns-recall-row${i === act ? " on" : ""}`}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={shell === "desktop" ? () => setAct(i) : undefined}
                onClick={() => pick(h)}
              >
                <span className="t">{marked(h)}</span>
                {sub && <span className="n">{sub}</span>}
              </button>
            );
          })}
          {shell === "desktop" && <div className="ns-recall-hint">↓ 選・Tab 補完・Esc 收起</div>}
        </div>
      )}
    </span>
  );
}

/** 對到的那段加粗（標不出來＝整段照印） */
function marked(h: RecallHit) {
  const t = h.item.text;
  if (h.at < 0 || h.len <= 0) return t;
  return (
    <>
      {t.slice(0, h.at)}
      <b>{t.slice(h.at, h.at + h.len)}</b>
      {t.slice(h.at + h.len)}
    </>
  );
}
