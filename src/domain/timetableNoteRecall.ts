/**
 * timetableNoteRecall——時間塊備註的候選（時刻表⑦ D-時-163；A 席）：`timetableRepo.listBlockNotes()` 的列 → `RecallInput` 的 items。
 *
 * - 來源一列＝（備註, 分類）寫過幾塊、最近一塊的開始時刻。同一句（`recallKey` 相同）寫在好幾個分類 ⇒ 併成一個候選：次數相加、
 *   字取最近那次的寫法、最近取最大。
 * - 同分類優先（契約 §5「同分類寫過的排前面」）：這一句在 `catId` 寫過 ⇒ `boost` 1（`rankRecall` 比對位置之前先比）。
 *   `catId` null（補記還沒選分類）⇒ 都不加權。
 */
import { recallKey, type RecallItem } from "./recall.ts";

export interface BlockNoteUse {
  note: string;
  category_id: string;
  count: number;
  /** 最近一塊的 started_at（ISO；字串比大小＝比時間） */
  last: string;
}

export function blockNoteItems(rows: readonly BlockNoteUse[], catId: string | null): RecallItem[] {
  const by = new Map<string, { text: string; count: number; last: string; boost: number }>();
  for (const r of rows) {
    const text = r.note.trim();
    if (!text) continue;
    const k = recallKey(text);
    const same = catId !== null && r.category_id === catId ? 1 : 0;
    const cur = by.get(k);
    if (!cur) {
      by.set(k, { text, count: r.count, last: r.last, boost: same });
      continue;
    }
    cur.count += r.count;
    if (r.last > cur.last) {
      cur.last = r.last;
      cur.text = text;
    }
    cur.boost = Math.max(cur.boost, same);
  }
  return [...by.values()];
}
