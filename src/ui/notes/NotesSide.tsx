/**
 * NotesSide——旅客筆記頁的頁務件欄（桌機；車次①契約 §5.1）。
 *
 * 注意：這是**主欄最左一欄**，不是書封 `Sidebar.tsx`（書封的「我的路線」在本頁照舊由 Sidebar 畫）。
 * 「頁」材質（紙面墨色），不是第二塊深色面——原型把它畫在書封裡（styles.css:286-312），搬到主欄後顏色改走紙面 token。
 *
 *   ・子畫面切換：「收件匣 N」（未整理數＝筆記＋車票）「筆記 N」（筆記總數）——button、aria-pressed
 *   ・section==="notes" 時：路線篩選「全部」「無路線」＋每條路線（roundel 走 roundelStyle，與 Sidebar 同法）
 *   ・車次②：第三顆「日記 N」（N＝月曆那個月的篇數＝Σ diaryMarks；沒資料不顯示，契約 §5.7）；
 *     section==="diary" 時下方畫頁務件月曆（SideCalendar）
 *
 * 「筆記 N」的 N：store 的 notes 是套了篩選／搜尋的結果，總數只在「沒有任何篩選」時算得出來；
 * 有篩選時沿用最後一次無篩選載入的數字（不另開查詢、不改 store）。
 */
import { useRef, type ReactNode } from "react";
import { useNotesStore, type NotesSection } from "../../store/notesStore";
import { useNodeStore } from "../../store/nodeStore";
import { Roundel } from "./notesBits";
import { SideCalendar } from "./SideCalendar";

export interface NotesSideProps {
  /** 換子畫面前先把內容欄沒存的字存掉（NotesView 給） */
  onSection(s: NotesSection): void;
  onFilter(routeId: string | "none" | undefined): void;
  /** 月曆點某一天（NotesView 先存正在打的字再換日） */
  onPickDay(day: string): void;
}

export function NotesSide({ onSection, onFilter, onPickDay }: NotesSideProps) {
  const section = useNotesStore((s) => s.section);
  const inboxCount = useNotesStore((s) => s.inboxNotes.length + s.inboxTickets.length);
  const notes = useNotesStore((s) => s.notes);
  const q = useNotesStore((s) => s.notesQuery);
  const routes = useNodeStore((s) => s.routes);
  const diaryCount = useNotesStore((s) => Object.values(s.diaryMarks).reduce((a, b) => a + b, 0));

  const unfiltered = !q.routeId && !(q.query ?? "").trim();
  const totalRef = useRef<number | null>(null);
  if (unfiltered) totalRef.current = notes.length;
  const notesCount = totalRef.current;

  const filterBtn = (key: string, value: string | "none" | undefined, label: string, mark: ReactNode) => {
    const on = (q.routeId ?? undefined) === value;
    return (
      <button key={key} type="button" className="ns-notes-sideitem" aria-pressed={on} onClick={() => onFilter(value)}>
        <span className="mk" />
        {mark}
        <span className="nm">{label}</span>
      </button>
    );
  };

  return (
    <aside className="ns-notes-side ns-notes-col techo-scroll" aria-label="旅客筆記">
      <h2>旅客筆記 NOTES</h2>
      <button
        type="button"
        className="ns-notes-sideitem"
        aria-pressed={section === "inbox"}
        onClick={() => onSection("inbox")}
      >
        <span className="mk" />
        <span className="nm">收件匣</span>
        <span className="n">{inboxCount}</span>
      </button>
      <button
        type="button"
        className="ns-notes-sideitem"
        aria-pressed={section === "notes"}
        onClick={() => onSection("notes")}
      >
        <span className="mk" />
        <span className="nm">筆記</span>
        {notesCount !== null && <span className="n">{notesCount}</span>}
      </button>
      <button
        type="button"
        className="ns-notes-sideitem"
        aria-pressed={section === "diary"}
        title={diaryCount > 0 ? `月曆這個月寫了 ${diaryCount} 篇` : undefined}
        onClick={() => onSection("diary")}
      >
        <span className="mk" />
        <span className="nm">日記</span>
        {diaryCount > 0 && <span className="n">{diaryCount}</span>}
      </button>

      {section === "notes" && (
        <div className="ns-notes-routes" role="group" aria-label="依路線篩選">
          <h2 className="sub">路線 ROUTES</h2>
          {filterBtn("$all", undefined, "全部", <span aria-hidden className="roundel ns-notes-rd" style={{ visibility: "hidden" }} />)}
          {filterBtn("$none", "none", "無路線", <Roundel route={null} />)}
          {routes.map((r) => filterBtn(r.id, r.id, r.name, <Roundel route={r} />))}
        </div>
      )}

      {section === "diary" && (
        <div className="ns-notes-calwrap" role="group" aria-label="日記月曆">
          <h2 className="sub">月曆 CALENDAR</h2>
          <SideCalendar onPickDay={onPickDay} />
        </div>
      )}
    </aside>
  );
}
