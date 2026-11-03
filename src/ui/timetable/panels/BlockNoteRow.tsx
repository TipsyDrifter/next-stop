/**
 * BlockNoteRow——補記／改一塊／改這一班（BlockPanel）荷札之後的「備註」列（時刻表⑦ 契約 §5、D-時-163；原型題 5；A 席）。
 *
 * - 單行 `RecallInput`（售票口④ 共用元件）：打一兩個字，下面列出以前寫過的塊備註（N 次）；面板目前選的分類寫過的排前面
 *   （`blockNoteItems` 給 boost）。候選第一次聚焦才讀（`timetableRepo.listBlockNotes()`），讀失敗＝沒有候選、照樣能打字。
 * - 受控：值與「沒動過就跟著遠端」的草稿由 BlockPanel 管（noteDraft null＝跟著這一塊目前的備註）。
 * - 鍵盤：候選開著時 ↓↑ 選、Enter 選中那列、Tab 補完、Esc 收起（元件自己攔）；沒選列時 Enter 只吞掉（不送出面板、
 *   時刻表的 Enter＝到着本來就不收輸入框裡的鍵），手機順便收鍵盤。
 */
import { useMemo, useState, type KeyboardEvent } from "react";
import { timetableRepo, type BlockNoteTally } from "../../../data/timetableRepository";
import { blockNoteItems } from "../../../domain/timetableNoteRecall";
import { RecallInput } from "../../common/RecallInput";
import "../blockNote.css";

export const BLOCK_NOTE_TEXT = {
  row: "備註",
  placeholder: "一句話（可不填）",
};

export function BlockNoteRow({
  value,
  onChange,
  catId,
  shell,
}: {
  value: string;
  onChange(next: string): void;
  /** 面板目前選的分類（同分類寫過的排前面；補記還沒選＝null） */
  catId: string | null;
  shell: "desktop" | "mobile";
}) {
  const [rows, setRows] = useState<BlockNoteTally[] | null>(null);
  const items = useMemo(() => (rows ? blockNoteItems(rows, catId) : null), [rows, catId]);
  const load = (): void => {
    void timetableRepo
      .listBlockNotes()
      .then(setRows)
      .catch((e: unknown) => {
        console.warn("時刻表：讀不到寫過的備註（候選先不出）", e);
        setRows([]);
      });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
    if (e.key !== "Enter" || e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    if (shell === "mobile") e.currentTarget.blur();
  };
  return (
    <div className="ns-tt-row is-top ns-tt-noterow">
      <span className="ns-tt-row-k">{BLOCK_NOTE_TEXT.row}</span>
      <span className="ns-tt-row-v">
        <RecallInput
          value={value}
          onChange={onChange}
          items={items}
          onNeedItems={load}
          ariaLabel={BLOCK_NOTE_TEXT.row}
          placeholder={BLOCK_NOTE_TEXT.placeholder}
          className="ns-tt-note-in"
          shell={shell}
          onKeyDown={onKeyDown}
        />
      </span>
    </div>
  );
}
