/**
 * CaptureButton——書封的「記一句」捕捉鈕（車次①契約 0-1、§2.2；D-筆-16「側欄另有捕捉鈕」）。
 *
 * 整合席在 mount 填 `sidebarTool: CaptureButton`（無 props 呼叫），插進書封工具列、排在「搜尋」左邊。
 * UI 丙-6 N9（§5 P7）：長相跟隔壁的「搜尋」（.gnav-search）同一副——書封淡字、淡框、hover 換底、焦點燙金 1px；
 *   兩顆等寬、鍵位都收進 title（不再是金框特製款，規範 §2.3「特製 CTA 退役」）。樣式在 notes.css〈書封捕捉鈕〉。
 *   頁內那一款（variant="page"）退役：收件匣、筆記的空狀態改用共用 EmptyState 的鈕，筆記頁的入口只剩「＋ 新筆記」（N6）。
 * 鍵位顯示查 registry（`notes.capture`），不手抄。
 */
import { useNotesStore } from "../../store/notesStore";
import { IconPen, capsOf } from "./notesBits";
import "./notes.css";

export function CaptureButton() {
  return (
    <button
      type="button"
      className="ns-notes-capbtn"
      onClick={() => useNotesStore.getState().openCapture()}
      title={`記一句（${capsOf("notes.capture")}）`}
    >
      <IconPen size={13} />
      記一句
    </button>
  );
}
