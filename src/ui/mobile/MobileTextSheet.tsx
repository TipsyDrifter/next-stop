/**
 * MobileTextSheet——⋯ sheet 的一行輸入子面板（磨光① 加工單 §2.4、§9.5）：「改名…」「記一句…」共用。
 *
 * 接法同「選日期…」「幾點…」：⋯ sheet 收起、改畫這一張；關掉（×／取消／暗幕／返回鍵）＝整個流程結束。
 *   返回層由 ⋯ sheet 的主人登記（同一層），本元件不另外登記。
 * DOM 沿兩子頁共用的 `.m-sheet-veil.techo-veil > .m-sheet.techo-card[role=dialog]`（UI 丙-1 前是退役的暖棕小卡）；輸入沿今日頁建票列那條底線輸入。
 * 空白不給送（送出鈕 disabled、Enter 不動）。送出後由呼叫端關面板（成功與否的收據也在呼叫端）。
 * IME 守門照建票列三道（isComposing／229／composition 旗標）；Esc＝關（外接鍵盤）。
 */
import { useRef, useState, type KeyboardEvent } from "react";
import "./mobile-polish.css";

export interface MobileTextSheetProps {
  /** 面板標題（例「改名」「記一句」） */
  title: string;
  /** 票名（標題列「改名　·　票名」） */
  name: string;
  /** 預填（改名＝原票名；記一句＝空） */
  initial: string;
  placeholder?: string;
  /** 送出鈕的字（例「改好了」「記下」） */
  submitLabel: string;
  /** 輸入框的無障礙名稱 */
  inputLabel: string;
  /** 已去頭尾空白、非空 */
  onSubmit(text: string): void;
  onClose(): void;
}

export function MobileTextSheet({
  title,
  name,
  initial,
  placeholder,
  submitLabel,
  inputLabel,
  onSubmit,
  onClose,
}: MobileTextSheetProps) {
  const [text, setText] = useState(initial);
  const composing = useRef(false);
  const empty = !text.trim();

  const submit = () => {
    if (empty) return;
    onSubmit(text.trim());
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229 || composing.current) return;
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className="m-sheet-veil techo-veil" role="presentation" onClick={onClose}>
      <div
        className="m-sheet techo-card m-txs"
        role="dialog"
        aria-modal="true"
        aria-label={`${title}——${name}`}
        onClick={(e) => e.stopPropagation()}
      >
        <p className="m-sheet-title">
          {title}　·　{name}
        </p>
        <div className="m-txs-row">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            // 聚焦時把游標放到字尾（改名多半是改尾巴幾個字）
            onFocus={(e) => {
              const n = e.currentTarget.value.length;
              e.currentTarget.setSelectionRange(n, n);
            }}
            autoFocus
            placeholder={placeholder}
            aria-label={inputLabel}
            enterKeyHint="done"
            spellCheck={false}
            autoComplete="off"
            className="m-nt-input m-txs-input"
          />
          <button type="button" onClick={submit} disabled={empty} className="m-nt-go ns-btn btn-seal">
            {submitLabel}
          </button>
        </div>
        <button type="button" onClick={onClose} className="m-sheet-item is-cancel ns-btn">
          取消
        </button>
      </div>
    </div>
  );
}
