/**
 * MobileTextSheet——⋯ sheet 的一行輸入子面板（磨光① 加工單 §2.4、§9.5）：「改名…」「記乘務記錄…」共用。
 *
 * 接法同「選日期…」「幾點…」：⋯ sheet 收起、改畫這一張；關掉（取消／暗幕／下滑／返回鍵／Esc）＝整個流程結束。
 *   返回層：⋯ sheet 的主人登記整個流程那一層，這裡把同一個 `backId` 傳給 MSheet ⇒ refcount 合併成一層（返回鍵按一次就關）。
 * UI 丙-3（契約 §1 F6；視覺規範 §2.4「手機底部 sheet」）：殼換共用 `MSheet`（拉柄、襯線標題「改名・票名」、按鈕列黏底：
 *   取消左框線、送出右實心墨）。輸入沿今日頁建票列那條底線輸入（.m-nt-input）。
 * 空白不給送（送出鈕 disabled、Enter 不動）。送出後由呼叫端關面板（成功與否的收據也在呼叫端）。
 * IME 守門照建票列三道（isComposing／229／composition 旗標）；Esc＝關由 MSheet 接（外接鍵盤；組字中不攔）。
 */
import { useRef, useState, type KeyboardEvent } from "react";
import { MSheet } from "../common/MSheet";
import "./mobile-polish.css";

export interface MobileTextSheetProps {
  /** 面板標題（例「改名」「記乘務記錄」） */
  title: string;
  /** 票名（標題列「改名・票名」） */
  name: string;
  /** 預填（改名＝原票名；記乘務記錄＝空） */
  initial: string;
  placeholder?: string;
  /** 送出鈕的字（例「改好了」「記下」） */
  submitLabel: string;
  /** 輸入框的無障礙名稱 */
  inputLabel: string;
  /** 返回層 id（⋯ sheet 的主人登記的那一層；同 id 合併） */
  backId?: string;
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
  backId,
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
    }
  };

  return (
    <MSheet
      title={`${title}・${name}`}
      backId={backId}
      onClose={onClose}
      foot={
        <>
          <button type="button" className="ns-btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button type="button" className="ns-btn btn-seal" onClick={submit} disabled={empty}>
            {submitLabel}
          </button>
        </>
      }
    >
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
    </MSheet>
  );
}
