/**
 * 售票口對話框本體的共用小件（車次①契約 §2.3；丙席）。兩殼共用（桌機 DialogShell／手機 MobileSheetHost 都包這三個本體），
 * 手機頁的元件也從 mobile/mobileBits 轉用同一支 IME 守門。
 */
import { useRef, type CompositionEvent, type KeyboardEvent } from "react";

/**
 * 回傳要掛在輸入欄（或其祖先，composition 事件會冒泡）上的三支 handler：Enter 且不在組字中才呼叫 `onEnter`。
 * 照 MobileToday.tsx:184-186——Android 部分 IME 送出的 keydown 既不帶 isComposing 也不是 229，所以另加旗標。
 */
export function useImeGuard(onEnter: (e: KeyboardEvent<HTMLElement>) => void) {
  const composing = useRef(false);
  return {
    onKeyDown(e: KeyboardEvent<HTMLElement>) {
      if (e.key !== "Enter") return;
      if (e.nativeEvent.isComposing || e.keyCode === 229 || composing.current) {
        // 組字中的 Enter 是「選字」，不能讓它冒成表單送出
        if ((e.target as HTMLElement).tagName !== "TEXTAREA") e.preventDefault();
        return;
      }
      onEnter(e);
    },
    onCompositionStart(_e: CompositionEvent<HTMLElement>) {
      composing.current = true;
    },
    onCompositionEnd(_e: CompositionEvent<HTMLElement>) {
      composing.current = false;
    },
  };
}

