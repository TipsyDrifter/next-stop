/**
 * NotesInbox——收件匣（桌機；車次①契約 §5.1；D-筆-17／18；原型 app.js deskInbox／inboxItemHtml）。
 *
 * 一張清單裡兩種東西，依時刻新的在上：
 *   ・未整理的筆記＝紙片（.ns-notes-slip：上緣撕孔、前兩行內文、右上受付章）
 *   ・沒日期、沒 parent、沒路線標籤的臨時車票＝臨時券（沿 .ticket>.stub/.body/.stamp-zone；標題用黑體不加 .hw——原型施工決定 6）
 * 選中（鍵盤 ↑↓ 或滑鼠停留）那一則滑出去處列；按鈕上的鍵帽字查 registry。
 * 「排某天／掛進列車／掛上路線」各開一個內嵌小浮層（DatePop／AttachPicker）。
 * 車次②：筆記的去處列多一顆「記成日記」（D；契約 §5.2），歸屬日＝筆記寫下那天。
 *
 * 狀態與動作都由 NotesView 給（選取、離場動畫、小浮層開關都要跟鍵盤表共用）。
 */
import { useEffect, type RefObject } from "react";
import type { NodeRow } from "../../domain";
import type { NoteListItem } from "../../data/noteRepository";
import type { InboxRef } from "../../store/notesStore";
import { useUiStore } from "../../store/uiStore";
import { useNotesStore } from "../../store/notesStore";
import { addDays, todayKey } from "../../lib/date";
import { lineCount } from "../../domain/notes";
import { UketsukeSeal } from "./UketsukeSeal";
import { AttachPicker } from "./AttachPicker";
import { DatePop } from "./DatePop";
import { Kbd, dayOf, fmtShort, fmtTime, nextMonday } from "./notesBits";

export type InboxItem =
  | { kind: "note"; id: string; at: string; note: NoteListItem }
  | { kind: "ticket"; id: string; at: string; ticket: NodeRow };

/** 收件匣的兩種東西合成一張清單：筆記依 noted_at、車票依 created_at，新的在上 */
export function inboxItemsOf(notes: readonly NoteListItem[], tickets: readonly NodeRow[]): InboxItem[] {
  const a: InboxItem[] = notes.map((n) => ({ kind: "note", id: n.id, at: n.noted_at, note: n }));
  const b: InboxItem[] = tickets.map((t) => ({ kind: "ticket", id: t.id, at: t.created_at, ticket: t }));
  return [...a, ...b].sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0));
}

export const refOf = (it: InboxItem): InboxRef => ({ kind: it.kind, id: it.id });

export type InboxOp = "todo" | "keep" | "diary" | "del" | "today" | "tomorrow" | "someday" | "attach" | "route";
export type InboxPopKind = "someday" | "attach" | "route";

export interface NotesInboxProps {
  items: InboxItem[];
  selectedId: string | null;
  leavingId: string | null;
  /** 目前開著的小浮層（只會掛在選中的那一張車票上） */
  pop: { id: string; kind: InboxPopKind } | null;
  listRef: RefObject<HTMLUListElement | null>;
  onSelect(it: InboxItem): void;
  onOp(it: InboxItem, op: InboxOp): void;
  onClosePop(): void;
  onPickDay(it: InboxItem, day: string): void;
  onPickNode(it: InboxItem, nodeId: string): void;
  onPickRoute(it: InboxItem, routeId: string): void;
}

export function NotesInbox(p: NotesInboxProps) {
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const today = todayKey(dayStartHour);
  const n = p.items.length;

  // 選取換了就把那一則捲進視野（鍵盤 ↑↓、從 Ctrl+P 跳來）
  useEffect(() => {
    if (!p.selectedId) return;
    const el = p.listRef.current?.querySelector<HTMLElement>(`[data-iid="${CSS.escape(p.selectedId)}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [p.selectedId, p.listRef]);

  return (
    <main className="ns-notes-inbox ns-notes-col techo-scroll" aria-label="收件匣">
      <div className="ns-notes-sheet">
        <header className="ns-notes-head">
          <p className="techo-overline ns-notes-overline">收件匣 — INBOX</p>
          <h1 className="techo-title">收件匣</h1>
          <p className="ns-notes-lede">
            還沒整理的東西。一個動作送走。
            {n > 0 && (
              <span style={{ marginLeft: 12 }}>
                待整理 <b>{n}</b> 則
              </span>
            )}
          </p>
        </header>

        {n > 0 ? (
          <>
            <ul
              ref={p.listRef}
              className="ns-notes-ilist"
              role="listbox"
              aria-label="收件匣"
              tabIndex={0}
              aria-activedescendant={p.selectedId ? `ns-notes-i-${p.selectedId}` : undefined}
            >
              {p.items.map((it) => (
                <InboxRow key={it.id} it={it} today={today} dayStartHour={dayStartHour} {...p} />
              ))}
            </ul>
            <p className="ns-notes-foothint">↑↓ 選一則・按鍵直接送走・滑鼠停在一則上也會展開</p>
          </>
        ) : (
          <div className="ns-notes-empty">
            <UketsukeSeal day={today} size={88} />
            <p>沒有待整理的東西</p>
          </div>
        )}
      </div>
    </main>
  );
}

function InboxRow({
  it,
  today,
  dayStartHour,
  selectedId,
  leavingId,
  pop,
  onSelect,
  onOp,
  onClosePop,
  onPickDay,
  onPickNode,
  onPickRoute,
}: NotesInboxProps & { it: InboxItem; today: string; dayStartHour: number }) {
  const sel = selectedId === it.id;
  const fresh = useNotesStore((s) => s.freshNoteId === it.id); // 剛從捕捉框存進來的那一則：受付章蓋下去的動畫
  const cls = `ns-notes-iitem${sel ? " is-sel" : ""}${leavingId === it.id ? " is-leaving" : ""}`;
  const day = dayOf(it.at, dayStartHour);
  const myPop = pop && pop.id === it.id ? pop.kind : null;

  const act = (op: InboxOp, label: string, keyId: string | null, quiet = false, popKind?: InboxPopKind) => (
    <button
      key={op}
      type="button"
      className={`ns-notes-act${quiet ? " quiet" : ""}`}
      onClick={() => onOp(it, op)}
      {...(popKind ? { "data-pop-toggle": "", "aria-expanded": myPop === popKind } : {})}
    >
      {label}
      {keyId && <Kbd id={keyId} />}
    </button>
  );

  const dest = (
    <div className="ns-notes-dest" inert={!sel}>
      <div>
        <div className="ns-notes-destrow">
          {it.kind === "note" ? (
            <>
              {act("todo", "變待辦", "notes.inbox.todo")}
              {act("keep", "留作筆記", "notes.inbox.keep")}
              {act("diary", "記成日記", "notes.inbox.diary")}
              {act("del", "刪除", "notes.delete", true)}
            </>
          ) : (
            <>
              {act("today", "排今天", "notes.inbox.todo")}
              {act("tomorrow", "排明天", "notes.inbox.tomorrow")}
              {act("someday", "排某天", null, false, "someday")}
              {act("attach", "掛進列車", "notes.inbox.attach", false, "attach")}
              {act("route", "掛上路線", "notes.inbox.route", false, "route")}
              {act("del", "刪除", "notes.delete", true)}
            </>
          )}
        </div>
        {myPop === "someday" && (
          <DatePop
            label="排到哪一天"
            min={today}
            quick={[
              { label: "明天", day: addDays(today, 1) },
              { label: "後天", day: addDays(today, 2) },
              { label: "下週一", day: nextMonday(today, addDays) },
            ]}
            onPick={(d) => onPickDay(it, d)}
            onClose={onClosePop}
          />
        )}
        {myPop === "attach" && (
          <AttachPicker
            depth="node"
            kinds={["train", "car"]}
            label="掛進哪一班列車或車廂"
            value={{ routeId: null, nodeId: null, nodeKind: null }}
            onPick={(t) => t.nodeId && onPickNode(it, t.nodeId)}
            onClose={onClosePop}
          />
        )}
        {myPop === "route" && (
          <AttachPicker
            depth="route"
            label="掛上哪一條路線"
            value={{ routeId: null, nodeId: null, nodeKind: null }}
            onPick={(t) => t.routeId && onPickRoute(it, t.routeId)}
            onClose={onClosePop}
          />
        )}
      </div>
    </div>
  );

  const hover = () => {
    if (!sel && !pop) onSelect(it);
  };

  if (it.kind === "note") {
    const lines = lineCount(it.note.body);
    return (
      <li
        id={`ns-notes-i-${it.id}`}
        className={cls}
        data-iid={it.id}
        role="option"
        aria-selected={sel}
        onMouseEnter={hover}
      >
        <div className="ns-notes-slip">
          <div className="ns-notes-slip-in">
            <div className="ns-notes-slip-body" onClick={() => onSelect(it)}>
              <UketsukeSeal day={day} fresh={fresh} />
              <p className="ns-notes-slip-text">{it.note.body.trim() || it.note.title || "（空白）"}</p>
              <div className="meta">
                <span className="ns-notes-kindlabel">未整理的筆記</span>
                <span className="sep">・</span>
                <span>
                  {fmtShort(day)} {fmtTime(it.at)}
                </span>
                {lines > 1 && (
                  <>
                    <span className="sep">・</span>
                    <span>{lines} 行</span>
                  </>
                )}
              </div>
            </div>
            {dest}
          </div>
        </div>
      </li>
    );
  }

  const t = it.ticket;
  const serial = `No.${day.slice(5).replace("-", "")}-${t.id.slice(0, 2).toUpperCase()}`;
  return (
    <li
      id={`ns-notes-i-${it.id}`}
      className={cls}
      data-iid={it.id}
      role="option"
      aria-selected={sel}
      onMouseEnter={hover}
    >
      <article className="ticket ns-notes-iticket">
        <div className="ns-notes-trow" onClick={() => onSelect(it)}>
          <div className="stub" style={{ color: "var(--route-none)" }}>
            <span aria-hidden className="badge dashed">
              臨
            </span>
            <span className="line-name">無路線</span>
            <span className="serial">{serial}</span>
          </div>
          <div className="body">
            <span className="fare-class" aria-hidden>
              臨時券
            </span>
            <p className="title">{t.name}</p>
            <div className="meta">
              <span>臨時車票</span>
              <span className="sep">・</span>
              <span>沒有日期</span>
              <span className="sep">・</span>
              <span>{fmtShort(day)} 起票</span>
            </div>
          </div>
          <div className="stamp-zone">
            <UketsukeSeal day={day} />
          </div>
        </div>
        {dest}
      </article>
    </li>
  );
}
