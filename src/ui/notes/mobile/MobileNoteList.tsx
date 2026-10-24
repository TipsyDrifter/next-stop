/**
 * MobileNoteList——旅客筆記手機分頁的「筆記」段（車次①契約 §5.3；D-筆-1／6／23；原型 app.js mobNotesTab 的 notes 分支）。
 *
 * 由上而下：搜尋框＋「新筆記」→ 橫向捲動的路線票根（全部／無路線／每條路線）→ 列表（舒適密度：
 *   標題一行粗、摘要兩行淡、小字「M/D・●路線名 › 節點名」；月份分隔）。點一則＝整頁打開（由 MobileNotes 切畫面）。
 *
 * 篩選與搜尋都進 store 的 notesQuery（`setNotesQuery` 設完就 loadNotes；查詢在資料層做 LIKE）：
 *   搜尋框去抖 150ms 再叫（契約 §3.6）；注音組字中不送（compositionend 才算數），免得每打一個注音符號查一次。
 * 關鍵字在標題與摘要裡以 <mark> 標出（前端純標示，不影響查詢）。
 * 分頁（契約 §5.1，與桌機 NotesList 同形）：列表尾端放一個哨兵，捲到距底 80px 內且 store 說還有（notesHasMore）
 *   ⇒ loadMoreNotes 接下一頁。捲動容器是外層 `.m-page`（不是本元件），所以用 IntersectionObserver（root＝最近的 .m-page）
 *   而不是 onScroll；筆數一變就重掛觀察器，載完一頁哨兵仍在視野內（頁很短）時會再接一頁。
 *
 * UI 丙-6（契約 §1 N7、E15）：空狀態換共用 EmptyState——
 *   一則都沒有（沒搜尋、沒篩選）＝first＋次鈕「＋ 新筆記」，上方那顆「新筆記」同時藏起來（同一動作同頁一個入口）；
 *   搜尋沒結果＝nores＋「清除搜尋」；路線／節點篩選下沒有＝nores（不畫放大鏡）＋「清除篩選」，這兩種上方「新筆記」照留。
 *   進頁那一趟還沒載完（`ready` false）不畫空狀態。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNodeStore } from "../../../store/nodeStore";
import { useUiStore } from "../../../store/uiStore";
import { useNotesStore } from "../../../store/notesStore";
import { dayKeyOf } from "../../../lib/date";
import { excerpt, fmtMonthHeader, monthKey, noteTitle } from "../../../domain/notes";
import type { NodeRow } from "../../../domain";
import type { NoteListItem } from "../../../data/noteRepository";
import { RouteRoundel } from "../../common/MobileAttachPicker";
import { EmptyState } from "../../common/EmptyState";
import { shortDay } from "./dayKeys";

/** 把 text 裡的 q（不分大小寫）包成 <mark> */
function highlight(text: string, q: string): ReactNode {
  const k = q.trim();
  if (!k) return text;
  const low = text.toLowerCase();
  const kl = k.toLowerCase();
  const out: ReactNode[] = [];
  let i = 0;
  let j: number;
  let key = 0;
  while ((j = low.indexOf(kl, i)) >= 0) {
    if (j > i) out.push(text.slice(i, j));
    out.push(<mark key={key++}>{text.slice(j, j + k.length)}</mark>);
    i = j + k.length;
  }
  if (i < text.length) out.push(text.slice(i));
  return out;
}

export interface MobileNoteListProps {
  /** 進頁那一趟筆記載完了（MobileNotes 給）；之前不畫空狀態 */
  ready: boolean;
  onOpen(id: string): void;
  onNew(): void;
}

export function MobileNoteList({ ready, onOpen, onNew }: MobileNoteListProps) {
  const notes = useNotesStore((s) => s.notes);
  const notesQuery = useNotesStore((s) => s.notesQuery);
  const setNotesQuery = useNotesStore((s) => s.setNotesQuery);
  const routes = useNodeStore((s) => s.routes);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const [q, setQ] = useState(notesQuery.query ?? "");
  const composing = useRef(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  /* 捲到底再載下一頁（store.loadMoreNotes：同一個 notesQuery、offset＝目前筆數，接在尾端） */
  const hasMore = useNotesStore((s) => s.notesHasMore);
  const sentinel = useRef<HTMLParagraphElement>(null);
  const loadingMore = useRef(false);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting) || loadingMore.current) return;
        loadingMore.current = true;
        void useNotesStore
          .getState()
          .loadMoreNotes()
          .finally(() => {
            loadingMore.current = false;
          });
      },
      { root: el.closest(".m-page"), rootMargin: "0px 0px 80px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, notes.length]);

  const pushQuery = (text: string) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const cur = useNotesStore.getState().notesQuery;
      if ((cur.query ?? "") === text.trim()) return;
      void setNotesQuery({ ...cur, query: text.trim() || undefined });
    }, 150);
  };

  const filter = notesQuery.routeId;
  /** 階段④ P5：從路線圖「還有 N 則 →」來的節點篩選（支線／列車／車廂＋底下）；與路線篩選互斥 */
  const underNode = notesQuery.underNode;
  const setFilter = (routeId: string | "none" | undefined) => {
    void setNotesQuery({ ...useNotesStore.getState().notesQuery, routeId, underNode: undefined });
  };

  const activeQ = (notesQuery.query ?? "").trim();
  const routeById = (id: string | null) => (id ? (routes.find((r) => r.id === id) ?? null) : null);

  /* 列表：月份分隔＋列 */
  const rows: ReactNode[] = [];
  let lastMonth = "";
  for (const n of notes) {
    const day = dayKeyOf(n.noted_at, dayStartHour);
    const mk = monthKey(day);
    if (mk !== lastMonth) {
      rows.push(
        <li key={"m-" + mk} className="ns-notes-mmonth">
          {fmtMonthHeader(mk)}
        </li>,
      );
      lastMonth = mk;
    }
    rows.push(<Row key={n.id} n={n} day={day} q={activeQ} route={routeById(n.route_id)} onOpen={onOpen} />);
  }

  const clearSearch = () => {
    window.clearTimeout(timer.current);
    setQ("");
    void setNotesQuery({ ...useNotesStore.getState().notesQuery, query: undefined });
  };
  const plus = (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
      <path d="M8 3v10M3 8h10" />
    </svg>
  );

  /** 一則都沒有、也沒在搜尋或篩選＝第一次空：空狀態給「＋ 新筆記」，上方那顆藏起來 */
  const firstEmpty = ready && notes.length === 0 && !activeQ && !underNode && !filter;
  let empty: ReactNode = null;
  if (ready && notes.length === 0) {
    if (activeQ)
      empty = (
        <EmptyState tone="nores" title={`找不到「${activeQ}」`} secondary={{ label: "清除搜尋", onClick: clearSearch }} />
      );
    else if (underNode || filter)
      empty = (
        <EmptyState
          tone="nores"
          stamp={null}
          title={underNode ? "這裡還沒有筆記" : "這條路線還沒有筆記"}
          secondary={{ label: "清除篩選", onClick: () => setFilter(undefined) }}
        />
      );
    else
      empty = (
        <EmptyState
          tone="first"
          title="還沒有筆記"
          action={{ label: "新筆記", icon: plus, onClick: onNew }}
        />
      );
  }

  return (
    <>
      <div className="ns-notes-mtools">
        <label className="ns-notes-msearch">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
            <circle cx="7" cy="7" r="4.6" />
            <path d="M10.4 10.4l3.4 3.4" />
          </svg>
          <input
            className="ns-notes-minput"
            type="search"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              if (!composing.current) pushQuery(e.target.value);
            }}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={(e) => {
              composing.current = false;
              pushQuery(e.currentTarget.value);
            }}
            placeholder="搜尋筆記"
            aria-label="搜尋筆記"
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="search"
          />
        </label>
        {!firstEmpty && (
          <button type="button" className="ns-notes-mbtn ns-btn btn-ghost" onClick={onNew}>
            {plus}
            新筆記
          </button>
        )}
      </div>

      <div className="ns-notes-mroutes" role="group" aria-label="篩選路線">
        {underNode && (
          <button
            type="button"
            className="ns-notes-mchip on ns-notes-mchipnode"
            aria-label={`取消篩選：${underNode.label}與底下的筆記`}
            onClick={() => setFilter(undefined)}
          >
            <span className="nm">› {underNode.label}</span>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        )}
        <button
          type="button"
          className={"ns-notes-mchip" + (filter === undefined && !underNode ? " on" : "")}
          aria-pressed={filter === undefined && !underNode}
          onClick={() => setFilter(undefined)}
        >
          全部
        </button>
        <button
          type="button"
          className={"ns-notes-mchip" + (filter === "none" ? " on" : "")}
          aria-pressed={filter === "none"}
          onClick={() => setFilter("none")}
        >
          無路線
        </button>
        {routes.map((r) => (
          <button
            key={r.id}
            type="button"
            className={"ns-notes-mchip" + (filter === r.id ? " on" : "")}
            aria-pressed={filter === r.id}
            onClick={() => setFilter(r.id)}
          >
            <RouteRoundel route={r} className="ns-notes-mroundel sm" />
            {r.name}
          </button>
        ))}
      </div>

      {empty ?? (
        <>
          <ul className="ns-notes-mlist">{rows}</ul>
          {hasMore && (
            <p className="ns-notes-mmore" ref={sentinel}>
              往下滑載入更多…</p>
          )}
        </>
      )}
    </>
  );
}

function Row({
  n,
  day,
  q,
  route,
  onOpen,
}: {
  n: NoteListItem;
  day: string;
  q: string;
  route: NodeRow | null;
  onOpen(id: string): void;
}) {
  const ex = excerpt(n, 90);
  const nodeLabel = n.node_kind && n.node_kind !== "route" && n.node_name ? n.node_name : null;
  return (
    <li>
      <button type="button" className="ns-notes-mrow" onClick={() => onOpen(n.id)}>
        <span className="t">{highlight(noteTitle(n), q)}</span>
        {ex && <span className="x">{highlight(ex, q)}</span>}
        <span className="m">
          <span>{shortDay(day)}</span>
          {n.node_missing ? (
            <span>・原本掛的地方已刪除</span>
          ) : route ? (
            <>
              <span>・</span>
              <RouteRoundel route={route} className="ns-notes-mroundel xs" />
              <span>
                {route.name}
                {nodeLabel && ` › ${nodeLabel}`}
              </span>
            </>
          ) : (
            <span>・無路線</span>
          )}
        </span>
      </button>
    </li>
  );
}
