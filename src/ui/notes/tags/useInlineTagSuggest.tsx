/**
 * useInlineTagSuggest——textarea 游標處打 `#` 出荷札建議（桌機；旅客筆記車次③契約 §5.3；原型 app.js caretXY／updateBodySug／bodyInsertTag）。
 *
 * 用法（筆記內文、日記內文與草稿、捕捉框共用）：
 *   const sug = useInlineTagSuggest(taRef, (next) => { setBody(next); queue({ body: next }); });
 *   <textarea ref={taRef} {...sug.bind} onBlur={…sug.close()…}
 *             onKeyDown={(e) => { if (sug.onKeyDown(e)) return; …原本的鍵… }} />
 *   {sug.popup}
 *
 * - 每次游標／選取變動（`bind`＝onSelect＋onKeyUp＋onClick；onSelect 單獨不夠：視窗沒有焦點時 React 收不到 select）跑 `tagAtCaret(text, caret)`：非 null（它自己排除程式碼、網址、`#` 前不是行首／空白／全形標點）
 *   且沒有反白 ⇒ 畫建議清單；選了 ⇒ 把 `#q` 換成 `#name `、游標放到空白後。
 * - 位置：鏡像 div 量游標座標（原型 caretXY），清單貼在 `#` 那一格的下一行；量不到（textarea 不在畫面上）就不畫。
 *   清單以 portal 掛到 body、`position: fixed`——捕捉框的票面有遮罩（mask-image），畫在裡面會被裁掉；
 *   捲動時重量一次。快到視窗底就翻到游標上方。
 * - 鍵（先判 IME）：清單開著時 ↑↓ 選、Enter／Tab 補完、Esc **只收建議**（不離開編輯、不漏給外層）；回傳 true＝吃掉了。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { tagAtCaret, type TagSuggestResult } from "../../../domain/tags";
import { useTagStore } from "../../../store/tagStore";
import { TagSuggestRows, moveAct, suggestCount, suggestPick } from "./TagSuggest";
import "../notes-tags.css";

const POP_W = 320;
const POP_MAX_H = 280;

interface SugState {
  start: number;
  q: string;
  act: number;
  res: TagSuggestResult;
  left: number;
  top: number;
  /** true＝翻到游標上方（top 是清單底邊） */
  above: boolean;
}

const MIRROR_PROPS = [
  "fontFamily", "fontSize", "fontWeight", "fontStyle", "lineHeight", "letterSpacing", "wordSpacing", "textTransform",
  "paddingTop", "paddingLeft", "paddingRight", "paddingBottom", "borderTopWidth", "borderLeftWidth", "borderRightWidth",
  "boxSizing", "textIndent", "fontFeatureSettings", "tabSize",
] as const;

/** 游標（字元位置 pos）在 textarea 內容裡的座標（相對 textarea 左上角、未扣捲動）＋行高 */
function caretXY(ta: HTMLTextAreaElement, pos: number): { x: number; y: number; lh: number } {
  const cs = getComputedStyle(ta);
  const div = document.createElement("div");
  for (const k of MIRROR_PROPS) (div.style as unknown as Record<string, string>)[k] = cs[k];
  Object.assign(div.style, {
    position: "absolute", visibility: "hidden", whiteSpace: "pre-wrap", overflowWrap: "break-word",
    width: `${ta.offsetWidth}px`, top: "0", left: "-9999px",
  });
  div.textContent = ta.value.slice(0, pos);
  const sp = document.createElement("span");
  sp.textContent = ta.value.slice(pos) || ".";
  div.appendChild(sp);
  document.body.appendChild(div);
  const lhRaw = parseFloat(cs.lineHeight);
  const r = { x: sp.offsetLeft, y: sp.offsetTop, lh: Number.isFinite(lhRaw) ? lhRaw : parseFloat(cs.fontSize) * 1.6 };
  div.remove();
  return r;
}

export interface InlineTagSuggest {
  /** 游標／選取變了（textarea 的 onSelect）；也可在 onChange 之後叫 */
  update(): void;
  /** 收起（textarea blur 時叫） */
  close(): void;
  /** textarea 的 keydown 先交給它；回 true＝建議清單吃掉了這顆鍵 */
  onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): boolean;
  open: boolean;
  popup: ReactNode;
  /** 掛到 textarea 上的三個事件（都只叫 update） */
  bind: { onSelect(): void; onKeyUp(): void; onClick(): void };
}

export function useInlineTagSuggest(
  taRef: RefObject<HTMLTextAreaElement | null>,
  setText: (next: string) => void,
): InlineTagSuggest {
  const [sug, setSug] = useState<SugState | null>(null);
  const index = useTagStore((s) => s.index);
  const pendingCaret = useRef<number | null>(null);

  const update = useCallback(() => {
    const ta = taRef.current;
    if (!ta || ta.selectionStart !== ta.selectionEnd || document.activeElement !== ta) {
      setSug(null);
      return;
    }
    const hit = tagAtCaret(ta.value, ta.selectionStart);
    if (!hit) {
      setSug(null);
      return;
    }
    const st = useTagStore.getState();
    if (!st.index) void st.loadIndex();
    const res = st.suggest(hit.q, { limit: 7 });
    const rect = ta.getBoundingClientRect();
    if (!rect.width) {
      setSug(null);
      return;
    }
    const c = caretXY(ta, hit.start);
    const x = rect.left + c.x - ta.scrollLeft;
    const lineTop = rect.top + c.y - ta.scrollTop;
    const below = lineTop + c.lh + 4;
    const above = below + POP_MAX_H > window.innerHeight - 8 && lineTop - POP_MAX_H > 8;
    const left = Math.max(8, Math.min(x - 6, window.innerWidth - POP_W - 8));
    setSug((prev) => ({
      start: hit.start,
      q: hit.q,
      act: prev && prev.start === hit.start && prev.q === hit.q ? prev.act : 0,
      res,
      left,
      top: above ? lineTop - 4 : below,
      above,
    }));
  }, [taRef]);

  const close = useCallback(() => setSug(null), []);

  // 荷札清單變了（剛掛上新的、同步進來）⇒ 重算
  useEffect(() => {
    if (sug) update();
    // 只看 index：其餘依賴變了不必重算
  }, [index]);

  // 捲動（頁面或 textarea 本身）⇒ 位置重量
  useEffect(() => {
    if (!sug) return;
    const onScroll = () => update();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [sug !== null, update]);

  // 插入後把游標放回去（value 由呼叫端的 state 管，要等它 render 完）
  useLayoutEffect(() => {
    const pos = pendingCaret.current;
    const ta = taRef.current;
    if (pos === null || !ta) return;
    pendingCaret.current = null;
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(pos, pos);
  });

  const insert = useCallback(
    (name: string | null) => {
      const ta = taRef.current;
      if (!ta || !sug || !name) return;
      const caret = ta.selectionStart;
      const ins = `#${name} `;
      const next = ta.value.slice(0, sug.start) + ins + ta.value.slice(caret).replace(/^ /, "");
      pendingCaret.current = sug.start + ins.length;
      setSug(null);
      setText(next);
    },
    [sug, setText, taRef],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!sug) return false;
      if (e.nativeEvent.isComposing || e.keyCode === 229) return false;
      const n = suggestCount(sug.res);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (!n) return false;
        e.preventDefault();
        setSug({ ...sug, act: moveAct(sug.act, e.key === "ArrowDown" ? 1 : -1, n) });
        return true;
      }
      if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && n) {
        e.preventDefault();
        e.stopPropagation();
        insert(suggestPick(sug.res, Math.min(sug.act, n - 1)));
        return true;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setSug(null);
        return true;
      }
      return false;
    },
    [sug, insert],
  );

  const nameOf = (k: string) => useTagStore.getState().nameOf(k);
  const popup =
    sug && typeof document !== "undefined"
      ? createPortal(
          <div
            className={`ns-notes-sug body${sug.above ? " above" : ""}`}
            role="listbox"
            aria-label="荷札建議"
            style={sug.above ? { left: sug.left, bottom: window.innerHeight - sug.top } : { left: sug.left, top: sug.top }}
          >
            <TagSuggestRows
              res={sug.res}
              act={Math.min(sug.act, Math.max(0, suggestCount(sug.res) - 1))}
              onPick={(i) => insert(suggestPick(sug.res, i))}
              onHover={(i) => setSug((s) => (s ? { ...s, act: i } : s))}
              nameOf={nameOf}
            />
          </div>,
          document.body,
        )
      : null;

  const bind = useMemo(() => ({ onSelect: update, onKeyUp: update, onClick: update }), [update]);
  return { update, close, onKeyDown, open: !!sug, popup, bind };
}
