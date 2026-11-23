/**
 * NotesInbox——收件匣（桌機；車次①契約 §5.1；D-筆-17／18；原型 app.js deskInbox／inboxItemHtml）。
 *
 * 一張清單裡兩種東西，依時刻新的在上：
 *   ・未整理的筆記＝紙片（.ns-notes-slip：上緣撕孔、前兩行內文、右上受付章）
 *   ・沒日期、沒 parent、沒路線標籤的臨時車票＝臨時券（沿 .ticket>.stub/.body/.stamp-zone；標題用黑體不加 .hw——原型施工決定 6）
 * 選中（鍵盤 ↑↓ 或點一下；己-2 起滑鼠停留不再選中）那一則滑出去處列；按鈕上的鍵帽字查 registry。
 * 己-2 A6（D-主-415）：車票的去處列留排今天／排明天／挑日期＋⋯（掛進列車…、掛上路線…、刪除，鍵帽照列）；筆記的四顆不動。
 * 「排某天／掛進列車／掛上路線」各開一個小浮層：挑日期＝錨定 DatePicker（掛 body）、掛到哪＝float 的 AttachPicker（UI 丙-6 K2）。
 * 頁首＝共用 PageHeader 頁名式（UI 丙-6 H1：眉標 {收件匣, Inbox}、待整理 N 則、「＋ 記一句」；清單空時藏「＋」，入口只留空狀態那顆）。
 * 車次②：筆記的去處列多一顆「記成日記」（D；契約 §5.2），歸屬日＝筆記寫下那天。
 *
 * 狀態與動作都由 NotesView 給（選取、離場動畫、小浮層開關都要跟鍵盤表共用）。
 */
import { useEffect, useMemo, useRef, useState, type MouseEvent, type RefObject } from "react";
import type { NodeRow } from "../../domain";
import type { NoteListItem } from "../../data/noteRepository";
import type { InboxKind, InboxRef } from "../../store/notesStore";
import { useUiStore } from "../../store/uiStore";
import { useNotesStore } from "../../store/notesStore";
import { serialOf, useNodeStore } from "../../store/nodeStore";
import { addDays, todayKey } from "../../lib/date";
import { lineCount } from "../../domain/notes";
import { UketsukeSeal } from "./UketsukeSeal";
import { AttachPicker } from "../common/AttachPicker";
import { rowContextMenu } from "../common/contextMenu";
import { DatePicker } from "../common/DatePicker";
import { EmptyState } from "../common/EmptyState";
import { IconDots, IconEdit } from "../common/icons";
import { PageHeader } from "../common/PageHeader";
import { PopMenu } from "../common/PopMenu";
import { runOnBlankClick } from "../common/selection/desktopSelection";
import { InboxSelectionBar, useInboxSelectStore, usePruneInboxSelection } from "./InboxSelectionBar";
import { Kbd, capsOf, dayOf, fmtShort, fmtTime, nextMonday } from "./notesBits";
import { NotesFilterBar } from "./NotesFilterBar";

const INBOX_ENTITY_TYPES = ["note", "node"] as const;

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
  /** 被書封「篩選・種類」藏起來的則數（丁 D-主-237）；0＝沒篩或沒藏 */
  hidden?: number;
  /** 進頁那一趟載入回來了沒：沒回來前清單空著也不畫空狀態（免得開頁先閃「都整理完了」） */
  ready: boolean;
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
  const inboxNotes = useNotesStore((s) => s.inboxNotes);
  const inboxTickets = useNotesStore((s) => s.inboxTickets);
  const inboxKind = useNotesStore((s) => s.inboxKind);
  const inboxSort = useNotesStore((s) => s.inboxSort);
  const inboxTagKeys = useNotesStore((s) => s.inboxTagKeys);
  const today = todayKey(dayStartHour);
  const n = p.items.length;
  const hidden = p.hidden ?? 0;
  const total = n + hidden;
  const clearFilters = () => useNotesStore.getState().clearInboxFilters();

  const visibleIds = useMemo(() => p.items.map((it) => it.id), [p.items]);
  usePruneInboxSelection(visibleIds);
  const pickedIds = useInboxSelectStore((s) => s.ids);
  const pickedSet = useMemo(() => new Set(pickedIds), [pickedIds]);
  const multiActive = pickedIds.length > 0;

  const allowedIds = useMemo(
    () => new Set([...inboxNotes.map((x) => x.id), ...inboxTickets.map((x) => x.id)]),
    [inboxNotes, inboxTickets],
  );

  // 選取換了就把那一則捲進視野（鍵盤 ↑↓、從 Ctrl+P 跳來）
  useEffect(() => {
    if (!p.selectedId) return;
    const el = p.listRef.current?.querySelector<HTMLElement>(`[data-iid="${CSS.escape(p.selectedId)}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [p.selectedId, p.listRef]);

  const capture = () => {
    useInboxSelectStore.getState().clear();
    useNotesStore.getState().openCapture();
  };
  const showFilterBar = total > 0 || inboxKind !== "all" || inboxTagKeys.length > 0;

  const kindChip = (k: InboxKind, label: string) => (
    <button
      key={k}
      type="button"
      className="chip ns-chip"
      aria-pressed={inboxKind === k}
      onClick={() => useNotesStore.getState().setInboxKind(k)}
    >
      {label}
    </button>
  );

  const kindLeading = (
    <span className="ns-notes-ikinds" role="group" aria-label="篩選種類">
      {kindChip("all", "全部")}
      {kindChip("note", "筆記")}
      {kindChip("ticket", "臨時車票")}
    </span>
  );

  return (
    <>
      <PageHeader
        variant="name"
        overline={{ zh: "收件匣", latin: "Inbox" }}
        title="收件匣"
        stats={total > 0 ? <>待整理 <b>{total}</b> 則{hidden > 0 && <>・篩選中顯示 {n} 則</>}</> : undefined}
        add={total > 0 ? { label: "記一句", onClick: capture, title: `記一句（${capsOf("notes.capture")}）` } : undefined}
      />
      <div
        className="ns-notes-body"
        onClick={(e) => {
          if (multiActive) {
            runOnBlankClick(e, ".ns-notes-ilist > li, .ns-notes-fbar, .ns-selbar, .ns-selbar-dock, .ns-popmenu", () =>
              useInboxSelectStore.getState().clear(),
            );
          }
        }}
      >
        <section className="ns-notes-inbox ns-notes-col techo-scroll" aria-label="收件匣">
          <div className="ns-notes-sheet">
            {showFilterBar && (
              <NotesFilterBar
                shell="desktop"
                className="is-inbox"
                leading={kindLeading}
                sort={inboxSort}
                onSortChange={(s) => useNotesStore.getState().setInboxSort(s)}
                sortLabel="收件匣排序"
                selectedTagKeys={inboxTagKeys}
                onToggleTagKey={(k) => useNotesStore.getState().toggleInboxTagKey(k)}
                onClearTagKeys={() => useNotesStore.getState().setInboxTagKeys([])}
                hasExtraFilter={inboxKind !== "all"}
                onClearAll={clearFilters}
                entityTypes={INBOX_ENTITY_TYPES}
                allowedIds={allowedIds}
                backId="notes.inbox.tags"
              />
            )}
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
                    <InboxRow
                      key={it.id}
                      it={it}
                      today={today}
                      dayStartHour={dayStartHour}
                      inboxSort={inboxSort}
                      picked={pickedSet.has(it.id)}
                      multiActive={multiActive}
                      order={visibleIds}
                      {...p}
                    />
                  ))}
                </ul>
                <p className="ns-notes-foothint">
                  {capsOf("notes.move.up")}{capsOf("notes.move.down")}點選或按快捷鍵就能整理・Ctrl／Shift＋點可多選</p>
              </>
            ) : p.ready && (hidden > 0 || inboxKind !== "all" || inboxTagKeys.length > 0) ? (
              // 篩選（種類或 #荷札）無結果：保留上方篩選條並提供一鍵清除
              <EmptyState
                tone="nores"
                stamp={null}
                title={inboxTagKeys.length > 0 ? "沒有符合篩選的待整理項目" : "這一種沒有待整理的"}
                desc={hidden > 0 ? `收件匣還有 ${hidden} 則待整理` : undefined}
                secondary={{ label: "清除篩選", onClick: clearFilters }}
              />
            ) : p.ready ? (
              // 完成語氣＋受付章（丙-6 §5 P6）；這時頁首「＋ 記一句」藏起來，入口只留這一顆（規範 §2.7）
              <EmptyState
                tone="done"
                className="ns-notes-inboxempty"
                stamp={<UketsukeSeal day={today} size={88} />}
                title="都整理完了"
                desc="新記的一句會先放進這裡"
                action={{ label: "記一句", icon: <IconEdit />, onClick: capture }}
              />
            ) : null}
          </div>
        </section>
      </div>
      <InboxSelectionBar visibleIds={visibleIds} />
    </>
  );
}

function InboxRow({
  it,
  today,
  dayStartHour,
  inboxSort,
  picked,
  multiActive,
  order,
  selectedId,
  leavingId,
  pop,
  onSelect,
  onOp,
  onClosePop,
  onPickDay,
  onPickNode,
  onPickRoute,
}: NotesInboxProps & {
  it: InboxItem;
  today: string;
  dayStartHour: number;
  inboxSort: "updated" | "created";
  picked: boolean;
  multiActive: boolean;
  order: readonly string[];
}) {
  const sel = !multiActive && selectedId === it.id;
  const fresh = useNotesStore((s) => s.freshNoteId === it.id); // 剛從捕捉框存進來的那一則：受付章蓋下去的動畫
  const serials = useNodeStore((s) => s.serials); // 收官磨光 A3：臨時券的票號（全站一把尺）
  const cls = `ns-notes-iitem${sel ? " is-sel" : ""}${picked ? " is-picked" : ""}${leavingId === it.id ? " is-leaving" : ""}`;
  const day = dayOf(it.at, dayStartHour);
  const myPop = pop && pop.id === it.id ? pop.kind : null;

  const onRowClick = (e: MouseEvent<HTMLElement>) => {
    if (e.shiftKey) {
      e.preventDefault();
      useInboxSelectStore.getState().range(it.id, order, selectedId);
      onSelect(it);
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      useInboxSelectStore.getState().toggle(it.id, order, selectedId);
      onSelect(it);
      return;
    }
    if (useInboxSelectStore.getState().ids.length > 0) {
      useInboxSelectStore.getState().clear();
    }
    onSelect(it);
  };

  const rowMenu = rowContextMenu(() => ({
    overline: { zh: "收件匣", latin: "Inbox" },
    label: it.kind === "ticket" ? it.ticket.name : (it.note.title?.trim() || "未整理的筆記"),
    items: [
      {
        key: "select",
        label: picked ? "取消選取" : "選取",
        onSelect: () => {
          useInboxSelectStore.getState().toggle(it.id, order);
          onSelect(it);
        },
      },
      ...(it.kind === "ticket"
        ? [
            { key: "today", label: "排今天", cut: true, onSelect: () => onOp(it, "today") },
            { key: "attach", label: "掛進列車…", onSelect: () => onOp(it, "attach") },
            { key: "route", label: "掛上路線…", onSelect: () => onOp(it, "route") },
          ]
        : [
            { key: "todo", label: "變待辦…", cut: true, onSelect: () => onOp(it, "todo") },
            { key: "keep", label: "留作筆記", onSelect: () => onOp(it, "keep") },
            { key: "diary", label: "記成日記", onSelect: () => onOp(it, "diary") },
          ]),
      { key: "del", label: "刪除", danger: true, cut: true, onSelect: () => onOp(it, "del") },
    ],
  }));
  /** 「挑日期」鈕：日期卡錨在它下方（丙-6 K2：挑日期＝錨定 popover，規範 §2.4） */
  const somedayRef = useRef<HTMLButtonElement>(null);
  /** 車票的 ⋯（己-2 A6）：開著與否只活在這一列；換選取就收 */
  const moreRef = useRef<HTMLButtonElement>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  useEffect(() => {
    if (!sel) setMoreOpen(false);
  }, [sel]);

  const act = (op: InboxOp, label: string, keyId: string | null, quiet = false, popKind?: InboxPopKind) => (
    <button
      key={op}
      ref={op === "someday" ? somedayRef : undefined}
      type="button"
      className={`ns-notes-act ns-btn btn-ghost${quiet ? " quiet ns-btn-danger" : ""}`}
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
              {act("someday", "挑日期", null, false, "someday")}
              {/* 己-2 A6（D-主-415）：掛進列車、掛上路線、刪除收進 ⋯（鍵帽照列，快捷鍵照舊直接做） */}
              <button
                ref={moreRef}
                type="button"
                className="ns-iconbtn ns-notes-more"
                aria-label="更多去處"
                title="掛進列車、掛上路線、刪除"
                aria-haspopup="menu"
                aria-expanded={moreOpen || myPop === "attach" || myPop === "route"}
                onClick={() => setMoreOpen((v) => !v)}
              >
                <IconDots />
              </button>
            </>
          )}
        </div>
        {moreOpen && sel && (
          <PopMenu
            anchor={moreRef.current}
            overline={{ zh: "去處", latin: "Route to" }}
            label={`「${it.kind === "ticket" ? it.ticket.name : ""}」的其他去處`}
            items={[
              {
                key: "select",
                label: picked ? "取消選取" : "選取",
                onSelect: () => useInboxSelectStore.getState().toggle(it.id, order),
              },
              { key: "attach", label: "掛進列車…", cut: true, hotkeyId: "notes.inbox.attach", onSelect: () => onOp(it, "attach") },
              { key: "route", label: "掛上路線…", hotkeyId: "notes.inbox.route", onSelect: () => onOp(it, "route") },
              { key: "del", label: "刪除", hotkeyId: "notes.delete", cut: true, danger: true, onSelect: () => onOp(it, "del") },
            ]}
            onClose={() => setMoreOpen(false)}
          />
        )}
        {/* K2：兩種小浮層都浮在清單上面，不再塞進紙片／票裡（卡中卡）——日期卡掛 body、貼著「挑日期」鈕；
            掛到哪＝float（絕對定位在去處列下方；選中那一則 z 抬高，蓋得過下面幾則，notes.css〈收件匣〉） */}
        {myPop === "someday" && (
          <DatePicker
            anchor={somedayRef.current}
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
            float
            depth="node"
            kinds={["train", "car"]}
            label="掛進哪班列車或車廂"
            value={{ routeId: null, nodeId: null, nodeKind: null }}
            onPick={(t) => t.nodeId && onPickNode(it, t.nodeId)}
            onClose={onClosePop}
          />
        )}
        {myPop === "route" && (
          <AttachPicker
            float
            depth="route"
            label="掛上哪條路線"
            value={{ routeId: null, nodeId: null, nodeKind: null }}
            onPick={(t) => t.routeId && onPickRoute(it, t.routeId)}
            onClose={onClosePop}
          />
        )}
      </div>
    </div>
  );

  // 己-2 A6（D-主-415）：滑過不再選中——選中會展開去處列、把下面的列往下推，游標底下換成另一則又接著選它（一路跳）。改成點一下或鍵盤 ↑↓ 才選

  if (it.kind === "note") {
    const lines = lineCount(it.note.body);
    const stampDay = dayOf(it.note.noted_at, dayStartHour);
    return (
      <li
        id={`ns-notes-i-${it.id}`}
        className={cls}
        data-iid={it.id}
        role="option"
        aria-selected={picked || sel}
        onContextMenu={rowMenu}
      >
        <div className="ns-notes-slip">
          <div className="ns-notes-slip-in">
            <div className="ns-notes-slip-body" onClick={onRowClick}>
              <UketsukeSeal day={stampDay} fresh={fresh} />
              <p className="ns-notes-slip-text">{it.note.body.trim() || it.note.title || "（空白）"}</p>
              <div className="meta">
                <span className="ns-notes-kindlabel">未整理的筆記</span>
                <span className="sep">・</span>
                <span>
                  {fmtShort(day)} {fmtTime(it.at)}
                  {inboxSort === "updated" && it.note.updated_at !== it.note.noted_at ? " 修改" : ""}
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
  const stampDay = dayOf(t.created_at, dayStartHour);
  // 收官磨光 A3（體檢 N1）：票號讀全站票號表（formatSerial：No.MMDD-當日發券序），同側板／大綱／今日列一把尺；
  // 原本自拼 `MMDD-<id 前兩碼>`，同一張票同框兩個號。表還沒載到＝先留白（同側板 NameBlock），不編假號
  const serial = serialOf(serials, t.id);
  return (
    <li
      id={`ns-notes-i-${it.id}`}
      className={cls}
      data-iid={it.id}
      role="option"
      aria-selected={picked || sel}
      onContextMenu={rowMenu}
    >
      <article className="ticket ns-notes-iticket">
        <div className="ns-notes-trow" onClick={onRowClick}>
          <div className="stub" style={{ color: "var(--route-none)" }}>
            <span aria-hidden className="badge dashed">
              臨
            </span>
            <span className="line-name">無路線</span>
            <span className="serial">{serial ? `No.${serial}` : ""}</span>
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
              <span>
                {fmtShort(day)} {inboxSort === "updated" && t.updated_at !== t.created_at ? "修改" : "建立"}
              </span>
            </div>
          </div>
          <div className="stamp-zone">
            <UketsukeSeal day={stampDay} />
          </div>
        </div>
        {dest}
      </article>
    </li>
  );
}
