/**
 * mobileTagBits——手機荷札的小件（旅客筆記車次③契約 §5.0／§5.5；丙席）。
 *
 * 這裡放手機各處共用、又小到不值得單獨一檔的東西：
 *   - `MTag`：手機荷札牌（`.ns-notes-mtag`；一般／`sm` 行內小牌／`lg` 頁頭大牌；觸控 × 常駐）
 *   - `TagGlyph`：真荷札＝實線牌、虛資料夾＝虛線空心牌
 *   - 文字插入：`replaceAtCaret`（游標處建議選了一個）、`insertTagsAt`（點選器插入模式）
 *   - `useCaretTag`：打字框游標處正在打的 `#…`（組字中不算；IME 護欄，契約 §1-8）
 *   - `MobileTagNotice`：通車提示條（D-筆-43）
 * 名稱怎麼解析、怎麼排建議都在 `domain/tags.ts`；這裡只畫、只接線（契約 §1-9）。
 * 牌子上不印 `#`（§1-7）；名稱照 `tagDisplayParts` 拆成「父層淡、末段正常、分隔 /」。
 */
import { useEffect, useRef, useState, type MouseEvent, type MutableRefObject } from "react";
import { backfillNotice, tagAtCaret, tagDisplayParts } from "../../../domain/tags";
import { useTagStore } from "../../../store/tagStore";

/* ═══ 圖示（16×16 線稿；與 mobileDiaryBits 同寫法） ═══ */

/** 荷札小圖示：真的＝實線牌＋打孔；虛資料夾＝虛線空心 */
export function TagGlyph({ real, size = 14 }: { real: boolean; size?: number }) {
  return (
    <span className={"ns-notes-mtglyph" + (real ? "" : " hollow")} aria-hidden>
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2">
        <path d="M5.5 3.5h7.5v9H5.5L2.5 10V6z" strokeDasharray={real ? undefined : "2 1.6"} />
        {real && <circle cx="5.4" cy="8" r="1.1" />}
      </svg>
    </span>
  );
}

export function IconCheck({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M3.5 8.5l3 3 6-7" />
    </svg>
  );
}

export function IconCaretRight({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
      <path d="M6 3.5L10.5 8 6 12.5" />
    </svg>
  );
}

export function IconDots({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <circle cx="3.5" cy="8" r="1.2" />
      <circle cx="8" cy="8" r="1.2" />
      <circle cx="12.5" cy="8" r="1.2" />
    </svg>
  );
}

export function IconXs({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

/* ═══ 名稱 ═══ */

/** 「難度 / 高」：父層各段 `.pa`、分隔 `i.sl`、末段 `.la`；hl＝要加粗的字元範圍（對 name 的位置） */
export function TagName({ name, hl }: { name: string; hl?: [number, number] | null }) {
  const { parents, last } = tagDisplayParts(name);
  const segs = [...parents, last];
  let off = 0;
  return (
    <>
      {segs.map((s, i) => {
        const a = off;
        off += s.length + 1;
        const isLast = i === segs.length - 1;
        return (
          <span key={i} className="seg">
            {i > 0 && <i className="sl">/</i>}
            <span className={isLast ? "la" : "pa"}>{hl ? boldRange(s, a, hl) : s}</span>
          </span>
        );
      })}
    </>
  );
}
/** 一段字裡落在 hl（整個名稱的座標）內的那幾個字加粗 */
function boldRange(s: string, at: number, hl: [number, number]) {
  const a = Math.max(0, hl[0] - at);
  const b = Math.min(s.length, hl[1] - at);
  if (b <= 0 || a >= s.length || a >= b) return s;
  return (
    <>
      {s.slice(0, a)}
      <b>{s.slice(a, b)}</b>
      {s.slice(b)}
    </>
  );
}

/* ═══ 牌子 ═══ */

export interface MTagProps {
  /** 顯示名（全路徑，例「難度/高」） */
  name: string;
  /** 點牌子（通常＝看清單）；不給＝不可點 */
  onOpen?(): void;
  /** 摘下（× 常駐，觸控沒有 hover） */
  onRemove?(): void;
  virtual?: boolean;
  /** 讀屏用的動作說明（預設「看 #名稱 的清單」） */
  openLabel?: string;
}

/** 一般荷札牌：`span.ns-notes-mtag` > `button.ns-notes-mtag-nm` ＋ 可選 `button.ns-notes-mtag-x` */
export function MTag({ name, onOpen, onRemove, virtual, openLabel }: MTagProps) {
  return (
    <span className={"ns-notes-mtag" + (virtual ? " virtual" : "")}>
      {onOpen ? (
        <button type="button" className="ns-notes-mtag-nm" onClick={onOpen} aria-label={openLabel ?? `看 #${name} 的清單`}>
          <TagName name={name} />
        </button>
      ) : (
        <span className="ns-notes-mtag-nm">
          <TagName name={name} />
        </span>
      )}
      {onRemove && (
        <button type="button" className="ns-notes-mtag-x" onClick={onRemove} aria-label={`拿掉 #${name}`}>
          <IconXs />
        </button>
      )}
    </span>
  );
}

/** 行內小牌（閱讀態內文）：整個牌子是一顆按鈕；照原文寫法顯示（`#ai/工具` 就顯示 ai / 工具） */
export function MTagInline({ raw, onOpen }: { raw: string; onOpen(e: MouseEvent): void }) {
  return (
    <button
      type="button"
      className="ns-notes-mtag sm"
      onClick={onOpen}
      onKeyDown={(e) => e.stopPropagation()}
      title={`#${raw}`}
      aria-label={`看 #${raw} 的清單`}
    >
      <span className="ns-notes-mtag-nm">
        <TagName name={raw} />
      </span>
    </button>
  );
}

/* ═══ 文字插入（UI 接線；解析規則在 domain/tags） ═══ */

/** 游標處建議選了一個：把 `#q`（start..caret）換成 `#name `，游標放到空白後 */
export function replaceAtCaret(text: string, start: number, caret: number, name: string): { text: string; caret: number } {
  const ins = "#" + name + " ";
  const post = text.slice(caret).replace(/^[ \t]/, "");
  return { text: text.slice(0, start) + ins + post, caret: start + ins.length };
}

/** 點選器插入模式：在 pos 插入 `#a #b `（前面不是空白就先補一格；=原型 pickerDone） */
export function insertTagsAt(text: string, pos: number | null, names: readonly string[]): { text: string; caret: number } {
  const p = pos == null ? text.length : Math.max(0, Math.min(pos, text.length));
  if (!names.length) return { text, caret: p };
  const pre = text.slice(0, p);
  const post = text.slice(p);
  const lead = pre && !/\s$/.test(pre) ? " " : "";
  const ins = names.map((n) => "#" + n).join(" ");
  const head = pre + lead + ins + " ";
  return { text: head + post.replace(/^ /, ""), caret: head.length };
}

/* ═══ 游標處正在打的 #… ═══ */

export interface CaretTag {
  /** `#` 的位置 */
  start: number;
  /** `#` 之後到游標的字 */
  q: string;
  /** 游標位置 */
  caret: number;
}

/**
 * 打字框游標處正在打的荷札（`tagAtCaret`；程式碼與網址裡不出，它自己判）。
 * 組字中（注音選字還沒送出）一律不算——送出（compositionend）後才重算（契約 §1-8、7.2-8）。
 * 監聽 input／selectionchange／compositionend；打字框不在焦點上＝null。
 */
export function useCaretTag(
  taRef: MutableRefObject<HTMLTextAreaElement | null>,
  enabled: boolean,
): { at: CaretTag | null; dismiss(): void } {
  const [at, setAt] = useState<CaretTag | null>(null);
  const composing = useRef(false);
  /** 主人按「收起」之後，同一個 # 位置不再自己跳出來（游標離開那個 # 再回來才算新的一次） */
  const dismissedAt = useRef<number | null>(null);

  useEffect(() => {
    const ta = taRef.current;
    if (!enabled || !ta) {
      setAt(null);
      return;
    }
    const compute = () => {
      if (composing.current || document.activeElement !== ta) {
        if (document.activeElement !== ta) setAt(null);
        return;
      }
      const s = ta.selectionStart;
      if (s !== ta.selectionEnd) {
        setAt(null);
        return;
      }
      const r = tagAtCaret(ta.value, s);
      if (!r) {
        dismissedAt.current = null;
        setAt(null);
        return;
      }
      if (dismissedAt.current === r.start) {
        setAt(null);
        return;
      }
      setAt((cur) => (cur && cur.start === r.start && cur.q === r.q && cur.caret === s ? cur : { start: r.start, q: r.q, caret: s }));
    };
    const onCompStart = () => {
      composing.current = true;
    };
    const onCompEnd = () => {
      composing.current = false;
      // compositionend 之後 value 才是送出的字；下一拍再算
      window.setTimeout(compute, 0);
    };
    const onSel = () => {
      if (document.activeElement === ta) compute();
    };
    const onBlur = () => setAt(null);
    ta.addEventListener("input", compute);
    ta.addEventListener("click", compute);
    ta.addEventListener("keyup", compute);
    ta.addEventListener("focus", compute);
    ta.addEventListener("blur", onBlur);
    ta.addEventListener("compositionstart", onCompStart);
    ta.addEventListener("compositionend", onCompEnd);
    document.addEventListener("selectionchange", onSel);
    compute();
    return () => {
      ta.removeEventListener("input", compute);
      ta.removeEventListener("click", compute);
      ta.removeEventListener("keyup", compute);
      ta.removeEventListener("focus", compute);
      ta.removeEventListener("blur", onBlur);
      ta.removeEventListener("compositionstart", onCompStart);
      ta.removeEventListener("compositionend", onCompEnd);
      document.removeEventListener("selectionchange", onSel);
    };
  }, [taRef, enabled]);

  return {
    at,
    dismiss: () => {
      if (at) dismissedAt.current = at.start;
      setAt(null);
    },
  };
}

/* ═══ 通車提示條（D-筆-43；第四段頂與清單頁頂） ═══ */

export function MobileTagNotice() {
  const notice = useTagStore((s) => s.notice);
  const dismissNotice = useTagStore((s) => s.dismissNotice);
  if (!notice) return null;
  return (
    <div className="ns-notes-mnotice" role="status">
      <TagGlyph real />
      <span className="t">{backfillNotice(notice.tags, notice.places)}</span>
      <button type="button" className="x" aria-label="關掉提示" onClick={() => void dismissNotice()}>
        <IconXs size={12} />
      </button>
    </div>
  );
}

/** 按鈕按下時不搶走打字框的焦點（mousedown 的預設動作＝換焦點；觸控的相容 mousedown 也吃這一條） */
export const keepFocus = (e: { preventDefault(): void }) => e.preventDefault();
