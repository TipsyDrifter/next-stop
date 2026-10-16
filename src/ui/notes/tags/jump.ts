/**
 * 荷札清單點一列＝跳過去（桌機；旅客筆記車次③契約 0-7、§5.2）。
 *
 *   車票／列車／車廂 ⇒ `nodeRepo.getNode(id)` 取最新列 → 核心 `QuickJump.tsx` 的 `jumpToNode(row)`（邊界規則只有那一份：
 *     樹內節點→開路線展開祖先選中；臨時票有執行日→今日頁；無日期無路線未済→收件匣；掛路線無日期→該路線大綱頂層）。
 *     不吐「已跳到」toast（主人已看到畫面換了）。
 *   筆記 ⇒ flush → 筆記子畫面（有篩選先清）→ 選中；在收件匣裡的那則 ⇒ 收件匣選中
 *   日記 ⇒ flush → 那天 → 選中那篇
 */
import { jumpToNode } from "../../common/QuickJump";
import { nodeRepo } from "../../../data";
import { useNotesStore } from "../../../store/notesStore";
import { notesFlush } from "../notesFlush";

export async function goNode(id: string): Promise<void> {
  await notesFlush.fn?.();
  const row = await nodeRepo.getNode(id);
  if (!row) return;
  await jumpToNode(row);
}

export async function goNote(id: string): Promise<void> {
  await notesFlush.fn?.();
  const st = useNotesStore.getState();
  if (st.inboxNotes.some((n) => n.id === id)) {
    st.setSection("inbox");
    st.selectInbox({ kind: "note", id });
    return;
  }
  const q = st.notesQuery;
  // 車次④ P5：節點篩選（underNode）也要清，否則要跳的那則可能不在清單裡
  if (q.routeId || q.underNode || (q.query ?? "").trim())
    await st.setNotesQuery({ ...q, routeId: undefined, underNode: undefined, query: "" });
  else if (!st.notes.length) await st.loadNotes();
  // 分頁：還沒載到那一則就往下載（最多 20 頁）
  for (let i = 0; i < 20; i++) {
    const s = useNotesStore.getState();
    if (s.notes.some((n) => n.id === id) || !s.notesHasMore) break;
    await s.loadMoreNotes();
  }
  const s = useNotesStore.getState();
  if (!s.notes.some((n) => n.id === id)) {
    await s.loadInbox();
    if (useNotesStore.getState().inboxNotes.some((n) => n.id === id)) {
      s.setSection("inbox");
      s.selectInbox({ kind: "note", id });
    }
    return;
  }
  s.setSection("notes");
  s.selectNote(id);
}

export async function goDiary(id: string, day: string): Promise<void> {
  await notesFlush.fn?.();
  const st = useNotesStore.getState();
  st.openDiaryAt(day);
  st.selectDiaryEntry(id);
}
