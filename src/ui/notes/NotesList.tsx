/**
 * NotesList——筆記列表欄（桌機；車次①契約 §5.1；D-筆-23 舒適密度、不做密度切換）。
 *
 *   頂：搜尋框（去抖 150ms 再 setNotesQuery）＋「新筆記」
 *   列：月份分隔「2026 年 9 月」＋每則＝.t 標題一行（沒標題用內文第一行）／.x 兩行摘要／.m「M/D・●路線名（› 節點名）」
 *       選中 .is-active（燙金左邊線）。清單本身是鍵盤焦點容器（listbox，tabIndex=0）；列是 option 不是 button，
 *       這樣 Enter 才會走到頁面按鍵表的「進編輯」而不是被按鈕吃掉。
 *   空：無筆記「還沒有筆記」＋記一句／篩選無結果「這條路線還沒有筆記」／搜尋無結果「找不到『{q}』」
 *   分頁：預設 200 則（repository 的 limit）；捲到底且 notesHasMore ⇒ store.loadMoreNotes 接下一頁。
 */
import { useEffect, useRef, useState, type ReactNode, type RefObject, type UIEvent } from "react";
import type { NodeRow } from "../../domain";
import type { NoteListItem } from "../../data/noteRepository";
import { useNotesStore } from "../../store/notesStore";
import { useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";
import { excerpt, fmtMonthHeader, monthKey, noteTitle } from "../../domain/notes";
import { CaptureButton } from "./CaptureButton";
import { IconPlus, IconSearch, Roundel, dayOf, fmtShort, highlight } from "./notesBits";

export interface NotesListProps {
  listRef: RefObject<HTMLUListElement | null>;
  searchRef: RefObject<HTMLInputElement | null>;
  onSelect(id: string): void;
  onNew(): void;
}

export function NotesList({ listRef, searchRef, onSelect, onNew }: NotesListProps) {
  const notes = useNotesStore((s) => s.notes);
  const q = useNotesStore((s) => s.notesQuery);
  const selectedId = useNotesStore((s) => s.selectedNoteId);
  const routes = useNodeStore((s) => s.routes);
  const dayStartHour = useUiStore((s) => s.dayStartHour);

  const [text, setText] = useState(q.query ?? "");
  // 搜尋去抖 150ms（契約 §3.6 setNotesQuery 註解）
  useEffect(() => {
    const t = setTimeout(() => {
      const cur = useNotesStore.getState().notesQuery;
      const v = text.trim();
      if ((cur.query ?? "") === v) return;
      void useNotesStore.getState().setNotesQuery({ ...cur, query: v || undefined });
    }, 150);
    return () => clearTimeout(t);
  }, [text]);

  // 選取換了就捲進視野
  useEffect(() => {
    if (!selectedId) return;
    listRef.current?.querySelector<HTMLElement>(`[data-nid="${CSS.escape(selectedId)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selectedId, listRef]);

  // 捲到底再載下一頁（store.loadMoreNotes：同一個 notesQuery、offset＝目前筆數，接在尾端）
  const hasMore = useNotesStore((s) => s.notesHasMore);
  const loadingMore = useRef(false);
  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (loadingMore.current || !hasMore) return;
    if (el.scrollTop + el.clientHeight < el.scrollHeight - 80) return;
    loadingMore.current = true;
    void useNotesStore
      .getState()
      .loadMoreNotes()
      .finally(() => {
        loadingMore.current = false;
      });
  };

  const routeById = new Map(routes.map((r) => [r.id, r]));
  const query = (q.query ?? "").trim();

  const rows: ReactNode[] = [];
  let lastMonth = "";
  for (const n of notes) {
    const day = dayOf(n.noted_at, dayStartHour);
    const mk = monthKey(day);
    if (mk !== lastMonth) {
      rows.push(
        <li key={`$m${mk}`} className="ns-notes-month" role="presentation">
          {fmtMonthHeader(mk)}
        </li>,
      );
      lastMonth = mk;
    }
    rows.push(
      <NoteRowItem
        key={n.id}
        n={n}
        day={day}
        active={n.id === selectedId}
        query={query}
        route={n.route_id ? (routeById.get(n.route_id) ?? null) : null}
        onSelect={onSelect}
      />,
    );
  }

  let empty: ReactNode = null;
  if (!notes.length) {
    if (query) empty = <p>找不到『{query}』</p>;
    else if (q.underNode) empty = <p>這裡還沒有筆記</p>;
    else if (q.routeId) empty = <p>這條路線還沒有筆記</p>;
    else
      empty = (
        <>
          <p>還沒有筆記</p>
          <CaptureButton variant="page" stub="note" />
        </>
      );
  }

  return (
    <section className="ns-notes-listcol" aria-label="筆記列表">
      <div className="ns-notes-listtop">
        <label className="ns-notes-searchwrap">
          <IconSearch size={12} />
          <input
            ref={searchRef}
            className="techo-input ns-notes-search"
            placeholder="搜尋筆記"
            aria-label="搜尋筆記"
            autoComplete="off"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                if (text) setText("");
                else listRef.current?.focus({ preventScroll: true });
              } else if (e.key === "ArrowDown" || e.key === "Enter") {
                // 從搜尋框往下＝回到清單（第一則）
                e.preventDefault();
                const first = useNotesStore.getState().notes[0];
                if (first) onSelect(first.id);
                listRef.current?.focus({ preventScroll: true });
              }
            }}
          />
        </label>
        <button type="button" className="ns-notes-newbtn ns-btn btn-ghost" onClick={onNew}>
          <IconPlus size={11} />
          新筆記
        </button>
      </div>
      <div className="ns-notes-listscroll techo-scroll" onScroll={onScroll}>
        {empty ? (
          <div className="ns-notes-listempty">{empty}</div>
        ) : (
          <ul
            ref={listRef}
            className="ns-notes-list"
            role="listbox"
            aria-label="筆記"
            tabIndex={0}
            aria-activedescendant={selectedId ? `ns-notes-n-${selectedId}` : undefined}
          >
            {rows}
          </ul>
        )}
        {!empty && hasMore && <p className="ns-notes-more">往下滑載入更多…</p>}
      </div>
    </section>
  );
}

function NoteRowItem({
  n,
  day,
  active,
  query,
  route,
  onSelect,
}: {
  n: NoteListItem;
  day: string;
  active: boolean;
  query: string;
  route: NodeRow | null;
  onSelect(id: string): void;
}) {
  const title = noteTitle(n);
  const ex = excerpt(n, 90);
  let where: ReactNode;
  if (n.node_missing) where = <span className="w">原本掛的地方已刪除</span>;
  else if (!n.node_id) where = <span className="w">無路線</span>;
  else
    where = (
      <>
        <Roundel route={route} xs />
        <span className="w">
          {route?.name ?? n.node_name ?? ""}
          {n.node_kind && n.node_kind !== "route" && n.node_name ? ` › ${n.node_name}` : ""}
        </span>
      </>
    );
  return (
    <li
      id={`ns-notes-n-${n.id}`}
      data-nid={n.id}
      className={`ns-notes-row${active ? " is-active" : ""}`}
      role="option"
      aria-selected={active}
      onClick={() => onSelect(n.id)}
    >
      <span className="in">
        <span className={`t${title === "（空白）" ? " blank" : ""}`}>{highlight(title, query)}</span>
        {ex && <span className="x">{highlight(ex, query)}</span>}
        <span className="m">
          <span>{fmtShort(day)}</span>
          <span>・</span>
          {where}
        </span>
      </span>
    </li>
  );
}
