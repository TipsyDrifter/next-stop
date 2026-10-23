/**
 * MobileNoteInbox——旅客筆記手機分頁的「收件匣」段（車次①契約 §5.3；D-筆-17；原型 app.js inboxItemHtml 的 mob 分支）。
 *
 * 卡片兩種、同桌機語彙但單欄：
 *   未整理的筆記＝紙片（上緣一排撕孔）＋右上受付章；
 *   沒日期、沒路線的臨時車票＝臨時券（虛線「臨」票根、標題排印不手寫——與 MobileTicket 同一條理由）＋受付章。
 * 受付章印內日期＝進收件匣那天（筆記 noted_at、車票 created_at 的本地日，依日界線換算）。
 *
 * 點一則＝選中並展開去處列（再點一次收起）；去處按鈕 ≥44px、三欄可兩排：
 *   筆記：變待辦（開全螢幕預覽）／留作筆記／記成日記（車次②：歸屬日＝筆記寫下那天）／刪除
 *   車票：排今天／排明天／排某天（日期面板）／掛進列車（挑選器：只列車與車廂可選）／掛上路線（挑選器：只路線）／刪除
 * 寫入與 toast（含「復原」）都在 notesStore 的動作裡（契約 §3.6／§5.8）；本元件只轉呼叫。
 * 受付章 42px（D-筆-31，車次②；原 26px 太小讀不出日期）。「排某天」用共用的手機日期面板（D-筆-30）。
 */
import { useState } from "react";
import { useUiStore } from "../../../store/uiStore";
import { useNotesStore, type InboxRef } from "../../../store/notesStore";
import { useTagStore } from "../../../store/tagStore";
import { addDays, dayKeyOf, todayKey } from "../../../lib/date";
import { lineCount } from "../../../domain/notes";
import type { NodeRow } from "../../../domain";
import type { NoteListItem } from "../../../data/noteRepository";
import { UketsukeSeal } from "../UketsukeSeal";
import { MobileAttachPicker } from "./MobileAttachPicker";
import { MobileDatePicker } from "../../common/MobileDatePicker";
import { nextMonday, shortDay } from "./MobileDatePick";
import { useBackLayer } from "../../mobile/backStack";

type Item = { kind: "note"; id: string; at: string; note: NoteListItem } | { kind: "ticket"; id: string; at: string; ticket: NodeRow };

/** 本地時刻 HH:MM */
function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

type Pop = { id: string; kind: "someday" | "attach" | "route" } | null;

export function MobileNoteInbox() {
  const inboxNotes = useNotesStore((s) => s.inboxNotes);
  const inboxTickets = useNotesStore((s) => s.inboxTickets);
  const selected = useNotesStore((s) => s.inboxSelected);
  const selectInbox = useNotesStore((s) => s.selectInbox);
  const openCapture = useNotesStore((s) => s.openCapture);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const [pop, setPop] = useState<Pop>(null);
  // 磨光① 返回層：「排某天」面板＝同「取消」；兩個掛到哪的挑選器自己登記（MobileAttachPicker）
  useBackLayer("notes.inbox.someday", pop?.kind === "someday", () => setPop(null));

  const items: Item[] = [
    ...inboxNotes.map((n): Item => ({ kind: "note", id: n.id, at: n.noted_at, note: n })),
    ...inboxTickets.map((t): Item => ({ kind: "ticket", id: t.id, at: t.created_at, ticket: t })),
  ].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

  const isSel = (it: Item) => !!selected && selected.kind === it.kind && selected.id === it.id;
  const toggle = (it: Item) => {
    const ref: InboxRef = { kind: it.kind, id: it.id };
    selectInbox(isSel(it) ? null : ref);
    setPop(null);
  };

  return (
    <>
      <p className="ns-notes-mlede">點一則，選擇要收到哪裡。</p>
      {items.length === 0 ? (
        <div className="ns-notes-mempty">
          <UketsukeSeal day={todayKey(dayStartHour)} size={88} />
          {/* 教第一步（磨光③ 2-15；照 MobileNoteList「還沒有筆記」的前例） */}
          <p>
            沒有待整理的東西
            <small>隨手記一句，會先放進這裡</small>
          </p>
          <button type="button" className="ns-notes-mbtn ns-btn btn-ghost" onClick={() => openCapture()}>
            記一句
          </button>
        </div>
      ) : (
        <ul className="ns-notes-milist">
          {items.map((it) =>
            it.kind === "note" ? (
              <NoteCard
                key={it.id}
                n={it.note}
                day={dayKeyOf(it.at, dayStartHour)}
                sel={isSel(it)}
                onToggle={() => toggle(it)}
              />
            ) : (
              <TicketCard
                key={it.id}
                t={it.ticket}
                day={dayKeyOf(it.at, dayStartHour)}
                sel={isSel(it)}
                onToggle={() => toggle(it)}
                onPop={(kind) => setPop({ id: it.id, kind })}
              />
            ),
          )}
        </ul>
      )}
      {pop && <TicketPop pop={pop} onClose={() => setPop(null)} />}
    </>
  );
}

/* ───────── 筆記紙片 ───────── */

function NoteCard({ n, day, sel, onToggle }: { n: NoteListItem; day: string; sel: boolean; onToggle(): void }) {
  const keepNote = useNotesStore((s) => s.keepNote);
  const deleteNote = useNotesStore((s) => s.deleteNote);
  const openPreviewFromNote = useNotesStore((s) => s.openPreviewFromNote);
  const noteToDiary = useNotesStore((s) => s.noteToDiary);
  const lines = lineCount(n.body);
  const text = n.body.trim() ? n.body : (n.title ?? "");
  return (
    <li className={"ns-notes-mitem" + (sel ? " is-sel" : "")}>
      <div className="ns-notes-mslip">
        <button type="button" className="ns-notes-mslip-body" aria-expanded={sel} onClick={onToggle}>
          <UketsukeSeal day={day} size={42} />
          <span className="ns-notes-mslip-text">{text}</span>
          <span className="ns-notes-mmeta">
            <span className="ns-notes-mkind">未整理的筆記</span>
            <span className="sep">・</span>
            <span>
              {shortDay(day)} {hhmm(n.noted_at)}
            </span>
            {lines > 1 && (
              <>
                <span className="sep">・</span>
                <span>{lines} 行</span>
              </>
            )}
          </span>
        </button>
        {sel && (
          <div className="ns-notes-mdest is-four" role="group" aria-label="去處">
            <button type="button" className="ns-notes-mact" onClick={() => openPreviewFromNote(n.id)}>
              變待辦
            </button>
            <button type="button" className="ns-notes-mact" onClick={() => void keepNote(n.id)}>
              留作筆記
            </button>
            <button type="button" className="ns-notes-mact" onClick={() => void noteToDiary(n.id)}>
              記成日記
            </button>
            <button type="button" className="ns-notes-mact quiet ns-btn-danger" onClick={() => void deleteNote(n.id)}>
              刪除
            </button>
          </div>
        )}
      </div>
    </li>
  );
}

/* ───────── 臨時券 ───────── */

function TicketCard({
  t,
  day,
  sel,
  onToggle,
  onPop,
}: {
  t: NodeRow;
  day: string;
  sel: boolean;
  onToggle(): void;
  onPop(kind: "someday" | "attach" | "route"): void;
}) {
  const scheduleTicket = useNotesStore((s) => s.scheduleTicket);
  const deleteTicket = useNotesStore((s) => s.deleteTicket);
  const openPicker = useTagStore((s) => s.openPicker);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const today = todayKey(dayStartHour);
  return (
    <li className={"ns-notes-mitem" + (sel ? " is-sel" : "")}>
      <article className="ns-notes-mtk">
        <button type="button" className="ns-notes-mtk-face" aria-expanded={sel} onClick={onToggle}>
          <span className="ns-notes-mtk-stub" aria-hidden>
            <span className="badge">臨</span>
          </span>
          <span className="ns-notes-mtk-body">
            <span className="fare">臨時券</span>
            <span className="ns-notes-mtk-title">{t.name}</span>
            <span className="ns-notes-mmeta">
              <span>沒有日期</span>
              <span className="sep">・</span>
              <span>{shortDay(day)}變車票</span>
            </span>
          </span>
          <span className="ns-notes-mtk-stamp">
            <UketsukeSeal day={day} size={42} />
          </span>
        </button>
        {sel && (
          <div className="ns-notes-mdest" role="group" aria-label="去處">
            <button type="button" className="ns-notes-mact" onClick={() => void scheduleTicket(t.id, today)}>
              排今天
            </button>
            <button type="button" className="ns-notes-mact" onClick={() => void scheduleTicket(t.id, addDays(today, 1))}>
              排明天
            </button>
            <button type="button" className="ns-notes-mact" onClick={() => onPop("someday")}>
              挑日期</button>
            <button type="button" className="ns-notes-mact" onClick={() => onPop("attach")}>
              掛進列車
            </button>
            <button type="button" className="ns-notes-mact" onClick={() => onPop("route")}>
              掛上路線
            </button>
            {/* 掛荷札（D-筆-48）：手機上沒日期沒路線的臨時票唯一的入口——與桌機側板的荷札欄對等 */}
            <button
              type="button"
              className="ns-notes-mact"
              onClick={() => openPicker({ mode: "entity", entityType: "node", entityId: t.id, name: t.name })}
            >
              荷札…
            </button>
            <button type="button" className="ns-notes-mact quiet ns-btn-danger" onClick={() => void deleteTicket(t.id)}>
              刪除
            </button>
          </div>
        )}
      </article>
    </li>
  );
}

/* ───────── 車票的三個小面板（排某天／掛進列車／掛上路線） ───────── */

function TicketPop({ pop, onClose }: { pop: NonNullable<Pop>; onClose(): void }) {
  const scheduleTicket = useNotesStore((s) => s.scheduleTicket);
  const attachTicket = useNotesStore((s) => s.attachTicket);
  const tagTicket = useNotesStore((s) => s.tagTicket);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const today = todayKey(dayStartHour);

  if (pop.kind === "someday") {
    return (
      <MobileDatePicker
        title="排到哪一天"
        value={null}
        min={today}
        quick={[
          { label: "明天", day: addDays(today, 1) },
          { label: "後天", day: addDays(today, 2) },
          { label: "下週一", day: nextMonday(today) },
        ]}
        onPick={(d) => {
          onClose();
          void scheduleTicket(pop.id, d);
        }}
        onClose={onClose}
      />
    );
  }
  if (pop.kind === "attach") {
    return (
      <MobileAttachPicker
        title="掛進哪班列車或車廂"
        depth="node"
        kinds={["train", "car"]}
        routeSelectable={false}
        onPick={(t) => {
          onClose();
          if (t.nodeId) void attachTicket(pop.id, t.nodeId);
        }}
        onClose={onClose}
      />
    );
  }
  return (
    <MobileAttachPicker
      title="掛上哪條路線"
      depth="route"
      onPick={(t) => {
        onClose();
        if (t.routeId) void tagTicket(pop.id, t.routeId);
      }}
      onClose={onClose}
    />
  );
}
