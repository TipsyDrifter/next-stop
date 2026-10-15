/**
 * 模組級 flush 橋（旅客筆記車次③契約 0-17）。
 *
 * 書封頁務件（`NotesCoverAux`）與 `tagStore.openTagPage`／改名／刪除拿不到 `NotesView` 的 flushRef，
 * 換子畫面、換日、批次改寫內文之前一律 `await notesFlush.fn?.()`，把正在打字的內文先存完。
 * `NotesView` 在設 flushRef 的同一個 effect 把 flush 放進來、卸載時清成 null（手機殼沒有 NotesView ⇒ 恆 null）。
 */
export const notesFlush = { fn: null as (() => Promise<void>) | null };
