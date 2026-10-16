/**
 * leaveSync——離開編輯時對齊 store（桌機筆記／日記、手機筆記／日記共用）。
 * 純規則在 domain/notes.ts 的 `resolveLeaveText`；這裡只負責從 store 找那一則的現值。
 * 呼叫要在存檔鏈 flush 完成之後；回傳 remote＝true 表示別台後寫贏了，呼叫端要把本地 title／body 換成回傳值。
 */
import { useNotesStore } from "../../store/notesStore";
import { resolveLeaveText } from "../../domain/notes";

type Local = { title: string; body: string };

export function resolveLeaveNote(id: string, local: Local, hasUnsent: boolean) {
  const s = useNotesStore.getState();
  const stored = s.notes.find((n) => n.id === id) ?? s.inboxNotes.find((n) => n.id === id);
  return resolveLeaveText(local, stored, hasUnsent);
}

export function resolveLeaveDiary(id: string, local: Local, hasUnsent: boolean) {
  const stored = useNotesStore.getState().diaryEntries.find((n) => n.id === id);
  return resolveLeaveText(local, stored, hasUnsent);
}
