/**
 * DiarySearchList——日記頁內搜尋的跨日結果列（桌機；車次②契約 §5.1；§7.1-9）。
 *
 * 一列＝日期「10/5」（補記的加「（補記）」）＋標題或第一行＋一行摘要，關鍵字高亮；
 * 點一則（或焦點在列上按 Enter）＝跳到那天並選中那篇（notesStore.openDiaryHit，由 NotesDiary 包 flushThen）。
 * ↑↓ 在列之間移焦點（列是 button；頁面鍵盤表對 button 上的 ↑↓ 會改走這裡——本元件先攔）。
 * 沒有結果：「找不到『{q}』」。
 */
import type { KeyboardEvent, RefObject } from "react";
import type { NoteListItem } from "../../data/noteRepository";
import { isBackfilled, toDiaryHit } from "../../domain/notes";
import { dayOf, fmtShort, highlight } from "./notesBits";

export interface DiarySearchListProps {
  query: string;
  hits: NoteListItem[];
  dayStartHour: number;
  listRef: RefObject<HTMLUListElement | null>;
  onOpen(id: string, day: string): void;
  /** 第一列再往上：回搜尋框 */
  onExitTop(): void;
}

export function DiarySearchList({ query, hits, dayStartHour, listRef, onOpen, onExitTop }: DiarySearchListProps) {
  const q = query.trim();
  if (!hits.length) {
    return (
      <div className="ns-notes-dhits empty" role="status">
        <p>找不到『{q}』</p>
      </div>
    );
  }

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const btns = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>(".ns-notes-dhit > button") ?? []);
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "ArrowUp" && i === 0) return onExitTop();
    btns[Math.max(0, Math.min(btns.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))]?.focus();
  };

  return (
    <>
      <p className="ns-notes-dhitcount">
        {hits.length} 篇日記提到『{q}』
      </p>
      <ul ref={listRef} className="ns-notes-dhits" aria-label="日記搜尋結果" onKeyDown={onKeyDown}>
        {hits.map((n) => {
          const h = toDiaryHit(n, 90);
          const back = isBackfilled(h.day, dayOf(n.noted_at, dayStartHour));
          return (
            <li key={n.id} className="ns-notes-dhit">
              <button type="button" onClick={() => onOpen(n.id, h.day)}>
                <span className="d">
                  {h.day ? fmtShort(h.day) : ""}
                  {back && <span className="bf">（補記）</span>}
                  <span className="y">{h.day.slice(0, 4)}</span>
                </span>
                <span className="t">{highlight(h.title, q)}</span>
                {h.excerpt && <span className="x">{highlight(h.excerpt, q)}</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}
