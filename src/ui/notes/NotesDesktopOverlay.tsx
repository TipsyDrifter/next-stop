/**
 * NotesDesktopOverlay——桌機全域浮層的掛載殼（車次①契約 §5.2；mount 的 desktopOverlay，App 每頁常駐掛一份）。
 *
 * 捕捉框（CaptureOverlay）與變待辦預覽（TodoPreviewDialog）互斥：preview 優先（store 也保證兩者不同時存在）。
 * 兩者皆 null 時回 null——唯一例外是 toast「已放進收件匣」那一刻：Toast 元件不能插元件，
 * 所以同時在畫面右下短暫蓋一枚 mini fresh 受付章（契約 §5.8 第 1 條；車次② D-筆-31 放大成 42px），1.6 秒後收掉。
 * 本元件不判 shell：`lineOverlays("desktop")` 只在桌機樹掛（App.tsx）。
 * 階段⑤：捕捉小窗（CaptureWindowApp）也掛這一份；小窗裡 toast 觸發的章不閃（小窗的受付章由 CaptureWindowApp 在存檔那一刻自己蓋，D-筆-61），
 *   主視窗這一側的接線（小窗存檔後重讀、熱鍵失敗提示、預設開機自啟）由 `useCaptureShellBridge` 做（它在小窗裡不做事）。
 */
import { useEffect, useState } from "react";
import { useNotesStore } from "../../store/notesStore";
import { useUiStore } from "../../store/uiStore";
import { todayKey } from "../../lib/date";
import { CaptureOverlay } from "./CaptureOverlay";
import { TodoPreviewDialog } from "./TodoPreviewDialog";
import { UketsukeSeal } from "./UketsukeSeal";
import { isCaptureWindow } from "./capture-window/shell";
import { useCaptureShellBridge } from "./capture-window/useCaptureShellBridge";
import "./notes.css";

/** 與 notesStore 的 toast 1 同一句（domain/notes.ts captureToast） */
const INBOX_TOAST = "已放進收件匣";
/** 這個 JS context 是不是捕捉小窗（啟動後不會變） */
const IN_CAPTURE_WINDOW = isCaptureWindow();

export function NotesDesktopOverlay() {
  const hasCapture = useNotesStore((s) => s.capture !== null);
  const hasPreview = useNotesStore((s) => s.preview !== null);
  const toast = useUiStore((s) => s.toast);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const [flash, setFlash] = useState(0);
  useCaptureShellBridge();

  useEffect(() => {
    if (toast?.message === INBOX_TOAST && !IN_CAPTURE_WINDOW) setFlash(Date.now());
  }, [toast]);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(0), 1600);
    return () => clearTimeout(t);
  }, [flash]);

  const seal = flash ? (
    <div key={flash} className="ns-notes-sealflash" aria-hidden>
      <UketsukeSeal day={todayKey(dayStartHour)} size={42} fresh />
    </div>
  ) : null;

  if (!hasCapture && !hasPreview && !seal) return null;
  return (
    <>
      {hasPreview ? <TodoPreviewDialog /> : hasCapture ? <CaptureOverlay /> : null}
      {seal}
    </>
  );
}
