/**
 * CaptureButton——「記一句」捕捉鈕（車次①契約 0-1、§2.2；D-筆-16「側欄另有捕捉鈕」）。
 *
 * 兩種長相：
 *   variant="cover"（預設）：書封側欄工具列那一顆（整合席在 mount 填 `sidebarTool: CaptureButton`，無 props 呼叫）。
 *     根元素 `button.ns-notes-capbtn.ns-btn.btn-ghost`；書封上的版位與配色 `.cover .ns-notes-capbtn` 在 notes.css（原型 styles.css:266-283）。
 *   variant="page"：頁內空狀態用的次鈕（`.ns-notes-btn.ns-btn.btn-ghost`；空狀態第一步＝次鈕，視覺規範 §2.3）。
 * 鍵位顯示查 registry（`notes.capture`），不手抄。
 */
import type { CaptureStub } from "../../domain/notes";
import { useNotesStore } from "../../store/notesStore";
import { hotkeyById, formatChord } from "../shell/hotkeys";
import { IconPen, capsOf } from "./notesBits";
import "./notes.css";

export interface CaptureButtonProps {
  variant?: "cover" | "page";
  /** 開框時預選的票根（頁內「還沒有筆記」那一顆預選「筆記」） */
  stub?: CaptureStub;
}

export function CaptureButton({ variant = "cover", stub }: CaptureButtonProps) {
  const open = () => useNotesStore.getState().openCapture(stub);
  const title = `記一句（${capsOf("notes.capture")}）`;
  if (variant === "page") {
    return (
      <button type="button" className="ns-notes-btn ns-btn btn-ghost" onClick={open} title={title}>
        <IconPen size={13} />
        記一句
      </button>
    );
  }
  const hk = hotkeyById("notes.capture");
  const kbd = hk ? formatChord(hk.chords[0]).join(" ").toUpperCase() : "";
  return (
    <button type="button" className="ns-notes-capbtn ns-btn btn-ghost" onClick={open} title={title}>
      <IconPen size={13} />
      記一句
      {kbd && <span className="kbd">{kbd}</span>}
    </button>
  );
}
