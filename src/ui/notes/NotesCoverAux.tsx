/**
 * NotesCoverAux——旅客筆記頁的書封頁務件（桌機；旅客筆記車次③契約 0-17、§5.1、D-筆-40／45；原型 app.js auxInner、styles.css:96-152）。
 *
 * 填進地基插槽 `LineMount.sidebarAux`（接縫 #50）：旅客筆記頁時，書封的「我的路線」整段換成本元件；其他頁照舊。
 * 原本主欄最左的 196px 頁務件欄（NotesSide）拿掉，主欄吃回寬度。
 *
 *   `div.lines.ns-notes-aux`（借書封 `.lines` 讓 h2 吃到 sidebar.css 的總標樣式；自己捲、捲軸隱形）
 *   （子畫面切換固定在上、下面那一塊 `.ns-notes-auxbody` 自己捲：樹捲到選中列時，切換鈕不會跟著捲走）
 *   ├ h2「旅客筆記 NOTES」
 *   ├ `button.line-item.ns-notes-auxitem` ×4：收件匣 N／筆記 N／日記 N／荷札 N（現在所在＝`.active` 金菱形）
 *   │   N 的口徑同車次①②：收件匣＝未整理數；筆記＝筆記的家的總數（notesTotal，車次④起；與篩選無關）；
 *   │   日記＝那個月的篇數（Σ diaryMarks；0 不顯示）；荷札＝真荷札數（虛資料夾不算）
 *   ├ 筆記子畫面 ⇒ 路線篩選：h2.sub「路線 ROUTES」＋「全部」「無路線」＋每條路線（書封 23px roundel）
 *   ├ 日記子畫面 ⇒ 近 12 週方格（SideWeeks）
 *   └ 荷札子畫面 ⇒ 荷札樹（TagTree）
 * 車次④：「筆記 N」改讀 `notesTotal`（countNotes；不再受分頁上限 200 影響，0-16）；側板「還有 N 則」帶來的節點篩選
 *   （`notesQuery.underNode`，P5）在路線群組最上面多一列「› 節點名」＋×（× ＝清掉、回到全部）；此時「全部」與路線列都不亮。
 * 換子畫面／篩選／換日一律先 `await notesFlush.fn?.()`（書封拿不到 NotesView 的 ref；0-17 的模組級橋）。
 * 粉彩書封腳的月亮：本線 notes-tags.css 以 `.cover:has(.ns-notes-aux) .cover-moon { display: none }` 收起（零集中檔）。
 */
import type { ReactNode } from "react";
import { useNotesStore, type NotesSection } from "../../store/notesStore";
import { useNodeStore } from "../../store/nodeStore";
import { useTagStore } from "../../store/tagStore";
import { IconX, Roundel } from "./notesBits";
import { notesFlush } from "./notesFlush";
import { SideWeeks } from "./SideWeeks";
import { TagTree } from "./tags/TagTree";
import "./notes-tags.css";
import "./notes-md.css";

async function goSection(s: NotesSection): Promise<void> {
  await notesFlush.fn?.();
  useNotesStore.getState().setSection(s);
}

async function goFilter(routeId: string | "none" | undefined): Promise<void> {
  await notesFlush.fn?.();
  const st = useNotesStore.getState();
  await st.setNotesQuery({ ...st.notesQuery, routeId, underNode: undefined });
}

export function NotesCoverAux() {
  const section = useNotesStore((s) => s.section);
  const inboxCount = useNotesStore((s) => s.inboxNotes.length + s.inboxTickets.length);
  const notesTotal = useNotesStore((s) => s.notesTotal);
  const q = useNotesStore((s) => s.notesQuery);
  const diaryCount = useNotesStore((s) => Object.values(s.diaryMarks).reduce((a, b) => a + b, 0));
  const routes = useNodeStore((s) => s.routes);
  const tagCount = useTagStore((s) => (s.index ? Object.values(s.index.byKey).filter((x) => x.real).length : null));

  const notesCount = notesTotal;

  const item = (s: NotesSection, label: string, n: number | null, title?: string) => (
    <button
      key={s}
      type="button"
      className={`line-item ns-notes-auxitem${section === s ? " active" : ""}`}
      aria-pressed={section === s}
      title={title}
      onClick={() => void goSection(s)}
    >
      <span className="line-name">{label}</span>
      {n !== null && <span className="n">{n}</span>}
    </button>
  );

  const filterBtn = (key: string, value: string | "none" | undefined, label: string, mark: ReactNode) => {
    const on = !q.underNode && (q.routeId ?? undefined) === value;
    return (
      <button
        key={key}
        type="button"
        className={`line-item ns-notes-auxroute${on ? " active" : ""}`}
        aria-pressed={on}
        onClick={() => void goFilter(value)}
      >
        {mark}
        <span className="line-name">{label}</span>
      </button>
    );
  };

  return (
    <div className="lines ns-notes-aux" aria-label="旅客筆記頁務件">
      <h2>旅客筆記 NOTES</h2>
      <nav className="ns-notes-auxnav" aria-label="旅客筆記子畫面">
        {item("inbox", "收件匣", inboxCount)}
        {item("notes", "筆記", notesCount)}
        {item("diary", "日記", diaryCount > 0 ? diaryCount : null, diaryCount > 0 ? `這個月寫了 ${diaryCount} 篇` : undefined)}
        {item("tags", "荷札", tagCount)}
      </nav>

      <div className="ns-notes-auxbody">
        {section === "notes" && (
          <div className="ns-notes-auxroutes" role="group" aria-label="依路線篩選">
            <h2 className="sub">路線 ROUTES</h2>
            {q.underNode && (
              <div className="line-item ns-notes-auxroute active ns-notes-auxunder" title={`只看掛在「${q.underNode.label}」與它底下的筆記`}>
                <span aria-hidden className="roundel ns-notes-rdblank" />
                <span className="line-name">› {q.underNode.label}</span>
                <button
                  type="button"
                  className="x"
                  aria-label={`清除「${q.underNode.label}」篩選`}
                  title="清除這個篩選"
                  onClick={() => void goFilter(undefined)}
                >
                  <IconX size={11} />
                </button>
              </div>
            )}
            {filterBtn("$all", undefined, "全部", <span aria-hidden className="roundel ns-notes-rdblank" />)}
            {filterBtn("$none", "none", "無路線", <Roundel route={null} />)}
            {routes.map((r) => filterBtn(r.id, r.id, r.name, <Roundel route={r} />))}
          </div>
        )}

        {section === "diary" && <SideWeeks />}

        {section === "tags" && (
          <>
            <h2 className="sub">荷札 TAGS</h2>
            <TagTree />
          </>
        )}
      </div>
    </div>
  );
}
