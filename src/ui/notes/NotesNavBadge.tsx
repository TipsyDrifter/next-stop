/**
 * NotesNavBadge——旅客筆記導航格右上的數字小標＝收件匣待整理數（回饋甲 D-主-130；插槽 `LineMount.navBadge`，接縫 #58）。
 * 長相同今日格的小標（common/NavCount，墨色膠囊；0 不畫）。桌機 tooltip 尾巴走 `notesNavHint()`（`navHint`，純函式不訂閱）。
 *
 * 數字＝收件匣的筆記＋車票（＝書封頁務件 NotesCoverAux「收件匣」那個數，同一組查詢 listInbox／listInboxTickets）。
 * 為什麼自己數、不直接讀 notesStore：收件匣清單只在進旅客筆記頁時才載；而收件匣的車票是從今日／行程表建出來的（沒日期、
 * 沒路線），建票走 nodeStore、不會通知 notesStore。所以兩邊有動靜就重數一次：
 *   notesStore 的收件匣／筆記清單換了（整理、記一句、同步重載）、nodeStore 的側欄重載了（每次 refresh 與同步拉回都會）。
 */
import { useEffect, useRef, useState } from "react";
import { noteRepo } from "../../data/noteRepo";
import { useNodeStore } from "../../store/nodeStore";
import { useNotesStore } from "../../store/notesStore";
import { NavCount } from "../common/NavCount";

/** 最近一次數到的值（navHint 是純函式、不訂閱，讀這個） */
let lastCount = 0;

export function NotesNavBadge({ shell }: { shell: "desktop" | "mobile" }) {
  const inboxNotes = useNotesStore((s) => s.inboxNotes);
  const inboxTickets = useNotesStore((s) => s.inboxTickets);
  const notes = useNotesStore((s) => s.notes);
  const routes = useNodeStore((s) => s.routes);
  const [n, setN] = useState(lastCount);
  const gen = useRef(0);
  useEffect(() => {
    const g = ++gen.current;
    void Promise.all([noteRepo.listInbox(), noteRepo.listInboxTickets()])
      .then(([a, b]) => {
        if (g !== gen.current) return; // 比較晚發的那一趟才算數
        lastCount = a.length + b.length;
        setN(lastCount);
      })
      .catch((e) => console.warn("NotesNavBadge 收件匣計數失敗", e));
  }, [inboxNotes, inboxTickets, notes, routes]);
  return <NavCount n={n} label={`收件匣 ${n} 件待整理`} shell={shell} />;
}

/** 桌機書封 tooltip 的尾巴：「收件匣 N 件待整理」；0 ⇒ null（原 title） */
export function notesNavHint(): string | null {
  return lastCount > 0 ? `收件匣 ${lastCount} 件待整理` : null;
}
