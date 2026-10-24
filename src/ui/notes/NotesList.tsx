/**
 * NotesList——筆記列表欄（桌機；車次①契約 §5.1；D-筆-23 舒適密度、不做密度切換）。
 *
 * UI 丙-6 K4：整欄是一張**區塊卡**（紙材、--radius-card、--shadow-card、不全高；清單在卡內捲），浮在天上、不貼左邊。
 *   「＋ 新筆記」搬到頁首（NotesView 的 PageHeader；H2／N6），卡頂只留搜尋框（工具列不放放大鏡，免同頁兩個搜尋）。
 *   頂：搜尋框（去抖 150ms 再 setNotesQuery）
 *   列：月份分隔「2026 年 9 月」＋每則＝.t 標題一行（沒標題用內文第一行）／.x 兩行摘要／.m「M/D・●路線名（› 節點名）」
 *       選中 .is-active（作用中色左邊線）。清單本身是鍵盤焦點容器（listbox，tabIndex=0）；列是 option 不是 button，
 *       這樣 Enter 才會走到頁面按鍵表的「進編輯」而不是被按鈕吃掉。
 *   空（共用 EmptyState；進頁那一趟沒回來前不畫）：無筆記 first「還沒有筆記」＋「新筆記」（此時頁首的「＋」藏起來）／
 *       篩選無結果 nores「這條路線還沒有筆記」＋「清除篩選」／搜尋無結果 nores「找不到「{q}」」＋「清除搜尋」
 *   分頁：預設 200 則（repository 的 limit）；捲到底且 notesHasMore ⇒ store.loadMoreNotes 接下一頁。
 */
import { useEffect, useRef, useState, type ReactNode, type RefObject, type UIEvent } from "react";
import type { NodeRow } from "../../domain";
import type { NoteListItem } from "../../data/noteRepository";
import { useNotesStore } from "../../store/notesStore";
import { useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";
import { excerpt, fmtMonthHeader, monthKey, noteTitle } from "../../domain/notes";
import { EmptyState } from "../common/EmptyState";
import { IconPlus } from "../common/icons";
import { IconSearch, Roundel, dayOf, fmtShort, highlight } from "./notesBits";

export interface NotesListProps {
  listRef: RefObject<HTMLUListElement | null>;
  searchRef: RefObject<HTMLInputElement | null>;
  /** 進頁那一趟載入回來了沒：沒回來前清單空著也不畫空狀態 */
  ready: boolean;
  onSelect(id: string): void;
  /** 空狀態「新筆記」（＝頁首「＋ 新筆記」同一支） */
  onNew(): void;
  /** 篩選無結果的「清除篩選」（NotesView 先存正在打的字再清） */
  onClearFilter(): void;
}

export function NotesList({ listRef, searchRef, ready, onSelect, onNew, onClearFilter }: NotesListProps) {
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

  const clearSearch = () => {
    setText("");
    searchRef.current?.focus(); // 空狀態連同這顆鈕一起消失：焦點留在搜尋框，鍵盤表接得上
  };

  let empty: ReactNode = null;
  if (!notes.length && ready) {
    if (query)
      empty = <EmptyState tone="nores" title={`找不到「${query}」`} secondary={{ label: "清除搜尋", onClick: clearSearch }} />;
    else if (q.underNode || q.routeId)
      empty = (
        <EmptyState
          tone="nores"
          stamp={null}
          title={q.underNode ? "這裡還沒有筆記" : "這條路線還沒有筆記"}
          secondary={{ label: "清除篩選", onClick: onClearFilter }}
        />
      );
    else empty = <EmptyState tone="first" title="還沒有筆記" action={{ label: "新筆記", icon: <IconPlus />, onClick: onNew }} />;
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
      </div>
      <div className="ns-notes-listscroll techo-scroll" onScroll={onScroll}>
        {empty ? (
          <div className="ns-notes-listempty">{empty}</div>
        ) : !notes.length ? null : (
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
