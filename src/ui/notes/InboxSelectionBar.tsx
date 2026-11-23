/**
 * InboxSelectionBar——旅客筆記「收件匣」雙端多選與底部選取列（操作 9 跨頁對齊 · D-FB-4）。
 *
 * 桌機：Ctrl／⌘＋點加選、Shift＋點範圍選、右鍵「選取」、Ctrl＋A 全選、Shift＋↑↓ 擴選、Esc／空白處取消；
 *       底部浮出 `.ns-selbar`：「已選 N 則」｜［排今天］［挑乘車日］［掛路線…］［#荷札］［刪除 N 則］｜［× 取消］。
 * 手機：長按原地放開（或頂列「選取」）進多選、點卡片勾選／取消、返回鍵退出多選；
 *       tab bar 之上 `.m-selbar-dock`：「已選 N 則」｜［乘車日］［掛路線］［荷札］［刪除］｜［取消］。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import { keysOfEntity, suggest } from "../../domain/tags";
import { addDays, todayKey } from "../../lib/date";
import { useNotesStore, type InboxRef } from "../../store/notesStore";
import { useTagStore } from "../../store/tagStore";
import { useUiStore } from "../../store/uiStore";
import { AttachPicker } from "../common/AttachPicker";
import { DatePicker } from "../common/DatePicker";
import { MSheet } from "../common/MSheet";
import { MobileAttachPicker } from "../common/MobileAttachPicker";
import { MobileDatePicker } from "../common/MobileDatePicker";
import "../common/moveTo.css";
import { OverlineText } from "../common/PageHeader";
import "../common/selection/selection.css";
import { useBackLayer } from "../mobile/backStack";
import "../mobile/mobile-select.css";
import { nextMonday, usePopDismiss } from "./notesBits";
import "./notes.css";
import type { AttachKind } from "./useAttachOptions";

interface InboxSelectState {
  ids: string[];
  anchor: string | null;
  mobileMode: boolean;
  toggle(id: string, order: readonly string[], seedCursor?: string | null): void;
  range(id: string, order: readonly string[], fallbackAnchor?: string | null): void;
  extendTo(id: string, order: readonly string[], fromCursor?: string | null): void;
  start(id: string): void;
  setAll(ids: readonly string[]): void;
  setMobileMode(on: boolean): void;
  prune(visible: readonly string[]): void;
  clear(): void;
}

function inOrder(ids: Iterable<string>, order: readonly string[]): string[] {
  const want = new Set(ids);
  const out = order.filter((id) => want.has(id));
  for (const id of want) if (!out.includes(id)) out.push(id);
  return out;
}

export const useInboxSelectStore = create<InboxSelectState>((set, get) => ({
  ids: [],
  anchor: null,
  mobileMode: false,

  toggle(id, order, seedCursor) {
    let cur = get().ids;
    if (!cur.length && seedCursor && seedCursor !== id && order.includes(seedCursor)) {
      cur = [seedCursor];
    }
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : inOrder([...cur, id], order);
    set({
      ids: next,
      anchor: next.length ? id : null,
      mobileMode: get().mobileMode && next.length > 0 ? true : next.length > 0 ? get().mobileMode : false,
    });
  },

  range(id, order, fallbackAnchor) {
    const cur = get().ids;
    const aRaw = get().anchor ?? fallbackAnchor ?? null;
    const a = aRaw && order.includes(aRaw) ? aRaw : null;
    if (!a) {
      set({ ids: [id], anchor: id });
      return;
    }
    const i = order.indexOf(a);
    const j = order.indexOf(id);
    if (j < 0) return;
    const span = order.slice(Math.min(i, j), Math.max(i, j) + 1);
    set({ ids: inOrder([...cur, ...span], order), anchor: a });
  },

  extendTo(id, order, fromCursor) {
    const aRaw = get().anchor ?? fromCursor ?? id;
    const a = aRaw && order.includes(aRaw) ? aRaw : id;
    const i = order.indexOf(a);
    const j = order.indexOf(id);
    if (i < 0 || j < 0) return;
    const next = order.slice(Math.min(i, j), Math.max(i, j) + 1);
    set({ ids: next, anchor: next.length ? a : null });
  },

  start(id) {
    set({ ids: [id], anchor: id, mobileMode: true });
  },

  setAll(ids) {
    const next = [...ids];
    set({ ids: next, anchor: next[0] ?? null });
  },

  setMobileMode(on) {
    if (!on) set({ ids: [], anchor: null, mobileMode: false });
    else set({ mobileMode: true });
  },

  prune(visible) {
    const cur = get().ids;
    if (!cur.length) return;
    const vis = new Set(visible);
    const keep = cur.filter((id) => vis.has(id));
    if (keep.length === cur.length) return;
    set({
      ids: keep,
      anchor: keep.includes(get().anchor ?? "") ? get().anchor : (keep[0] ?? null),
      mobileMode: keep.length ? get().mobileMode : false,
    });
  },

  clear() {
    if (!get().ids.length && !get().mobileMode) return;
    set({ ids: [], anchor: null, mobileMode: false });
  },
}));

/** 清單換了自動剔除不在畫面上的項目；離開收件匣時清空 */
export function usePruneInboxSelection(visibleIds: readonly string[]): void {
  const key = visibleIds.join("|");
  const ref = useRef(visibleIds);
  ref.current = visibleIds;
  useEffect(() => {
    useInboxSelectStore.getState().prune(ref.current);
  }, [key]);
  useEffect(() => () => useInboxSelectStore.getState().clear(), []);
}

function resolveRefs(
  ids: readonly string[],
  inboxNotes: readonly { id: string }[],
  inboxTickets: readonly { id: string }[],
): InboxRef[] {
  const noteSet = new Set(inboxNotes.map((n) => n.id));
  const ticketSet = new Set(inboxTickets.map((t) => t.id));
  const out: InboxRef[] = [];
  for (const id of ids) {
    if (ticketSet.has(id)) out.push({ kind: "ticket", id });
    else if (noteSet.has(id)) out.push({ kind: "note", id });
  }
  return out;
}

type DeskPop = "date" | "attach" | "tag" | null;

export function InboxSelectionBar({ visibleIds }: { visibleIds: readonly string[] }) {
  const ids = useInboxSelectStore((s) => s.ids);
  const clear = useInboxSelectStore((s) => s.clear);
  const setAll = useInboxSelectStore((s) => s.setAll);
  const inboxNotes = useNotesStore((s) => s.inboxNotes);
  const inboxTickets = useNotesStore((s) => s.inboxTickets);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const tagIndex = useTagStore((s) => s.index);
  const [pop, setPop] = useState<DeskPop>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const probe = useRef<HTMLSpanElement>(null);
  const dateBtnRef = useRef<HTMLButtonElement | null>(null);

  useLayoutEffect(() => {
    setHost(probe.current?.closest("main") ?? document.body);
  }, []);

  const refs = useMemo(() => resolveRefs(ids, inboxNotes, inboxTickets), [ids, inboxNotes, inboxTickets]);
  const count = refs.length;
  const open = count > 0;
  useEffect(() => {
    if (!open) {
      setPop(null);
      return;
    }
    document.documentElement.setAttribute("data-selbar", "desktop");
    return () => document.documentElement.removeAttribute("data-selbar");
  }, [open]);

  if (!open) return <span ref={probe} hidden />;

  const today = todayKey(dayStartHour);
  const ticketCount = refs.filter((r) => r.kind === "ticket").length;
  const hasNotes = refs.some((r) => r.kind === "note");
  const attachKinds: AttachKind[] = hasNotes ? ["branch", "train", "car"] : ["branch", "train", "car", "ticket"];
  const closePop = () => setPop(null);
  const togglePop = (p: Exclude<DeskPop, null>) => setPop((cur) => (cur === p ? null : p));

  const onBarKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || e.nativeEvent.isComposing) return;
    e.preventDefault();
    e.stopPropagation();
    if (pop) closePop();
    else clear();
  };

  const bar = (
    <div className="ns-selbar techo-card" role="toolbar" aria-label="收件匣選取列" onKeyDown={onBarKey}>
      <span className="cnt" aria-live="polite">
        已選 <b>{count}</b> 則
      </span>
      {visibleIds.length > count && (
        <button
          type="button"
          className="ns-btn ns-btn--sm btn-text"
          title="全選目前清單（Ctrl+A）"
          onClick={() => setAll(visibleIds)}
        >
          全選
        </button>
      )}
      <span className="sep" aria-hidden />
      <button
        type="button"
        className="ns-btn ns-btn--sm btn-ghost"
        disabled={ticketCount === 0}
        title={ticketCount === 0 ? "只有臨時車票能排乘車日" : `將 ${ticketCount} 張臨時車票排進今天`}
        onClick={() => {
          const snap = [...refs];
          clear();
          void useNotesStore.getState().batchScheduleInbox(snap, today);
        }}
      >
        排今天
      </button>
      <button
        type="button"
        ref={dateBtnRef}
        className="ns-btn ns-btn--sm btn-ghost"
        aria-haspopup="dialog"
        aria-expanded={pop === "date"}
        data-pop-toggle
        disabled={ticketCount === 0}
        title={ticketCount === 0 ? "只有臨時車票能排乘車日" : `替 ${ticketCount} 張臨時車票挑乘車日`}
        onClick={() => togglePop("date")}
      >
        挑乘車日
      </button>
      <button
        type="button"
        className="ns-btn ns-btn--sm btn-ghost"
        aria-haspopup="dialog"
        aria-expanded={pop === "attach"}
        data-pop-toggle
        title="掛上路線或放入支線／列車／車廂"
        onClick={() => togglePop("attach")}
      >
        掛路線…
      </button>
      <button
        type="button"
        className="ns-btn ns-btn--sm btn-ghost"
        aria-haspopup="dialog"
        aria-expanded={pop === "tag"}
        data-pop-toggle
        title="批量掛上或摘下 #荷札"
        onClick={() => togglePop("tag")}
      >
        #荷札
      </button>
      <button
        type="button"
        className="ns-btn ns-btn--sm btn-ghost ns-btn-danger"
        title="刪除選取的項目（可復原）"
        onClick={() => {
          const snap = [...refs];
          clear();
          void useNotesStore.getState().batchDeleteInbox(snap);
        }}
      >
        刪除 {count} 則
      </button>
      <span className="sep" aria-hidden />
      <button type="button" className="ns-btn ns-btn--sm btn-text x" title="取消選取（Esc）" onClick={clear}>
        × 取消
      </button>

      {pop === "date" && ticketCount > 0 && (
        <DatePicker
          anchor={dateBtnRef.current}
          label={`排 ${ticketCount} 張車票的乘車日`}
          min={today}
          today={today}
          quick={[
            { label: "今天", day: today },
            { label: "明天", day: addDays(today, 1) },
            { label: "後天", day: addDays(today, 2) },
            { label: "下週一", day: nextMonday(today, addDays) },
          ]}
          onPick={(d) => {
            const snap = [...refs];
            closePop();
            clear();
            void useNotesStore.getState().batchScheduleInbox(snap, d);
          }}
          onClose={closePop}
        />
      )}
      {pop === "attach" && (
        <div className="ns-moveto ns-selbar-pop is-move">
          <AttachPicker
            float
            depth="node"
            kinds={attachKinds}
            routeSelectable
            value={{ routeId: null, nodeId: null, nodeKind: null }}
            label={`掛到哪條路線或節點（${count} 則）`}
            onPick={(t) => {
              const snap = [...refs];
              closePop();
              clear();
              void useNotesStore.getState().batchAttachInboxToTarget(snap, t);
            }}
            onClose={closePop}
          />
        </div>
      )}
      {pop === "tag" && <InboxTagPop refs={refs} onClose={closePop} hasIndex={!!tagIndex} />}
    </div>
  );

  return (
    <>
      <span ref={probe} hidden />
      {host && createPortal(<div className="ns-selbar-dock">{bar}</div>, host)}
    </>
  );
}

function InboxTagPop({ refs, onClose, hasIndex }: { refs: readonly InboxRef[]; onClose: () => void; hasIndex: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  usePopDismiss(ref, onClose);
  useEffect(() => {
    void useTagStore.getState().loadIndex();
    input.current?.focus();
  }, []);
  const ts = useTagStore.getState();
  const common = hasIndex
    ? refs
        .map((r) => new Set(ts.keysOf(r.kind === "ticket" ? "node" : "note", r.id)))
        .reduce<Set<string> | null>((acc, s) => (acc ? new Set([...acc].filter((k) => s.has(k))) : s), null) ?? new Set<string>()
    : new Set<string>();
  const sug = hasIndex && q.trim() ? ts.suggest(q, { limit: 5 }) : null;
  const attach = (name: string) => {
    const clean = name.trim().replace(/^#/, "");
    if (!clean) return;
    const snap = [...refs];
    onClose();
    void useNotesStore.getState().batchAttachInboxTag(snap, clean);
  };
  return (
    <div ref={ref} className="ns-selbar-pop is-tag techo-card" role="dialog" aria-label={`替 ${refs.length} 則掛荷札`}>
      <p className="techo-overline">
        <OverlineText value={{ zh: "荷札", latin: "Tags" }} />
      </p>
      {common.size > 0 && (
        <div className="row">
          {[...common].map((k) => (
            <button
              key={k}
              type="button"
              className="ns-selbar-tag"
              title={`從這 ${refs.length} 則摘下 #${ts.nameOf(k)}`}
              onClick={() => {
                const snap = [...refs];
                onClose();
                void useNotesStore.getState().batchDetachInboxTag(snap, k);
              }}
            >
              #{ts.nameOf(k)} <span aria-hidden>×</span>
            </button>
          ))}
        </div>
      )}
      <input
        ref={input}
        className="techo-input"
        type="text"
        placeholder="荷札名稱，Enter 掛上"
        aria-label="要掛上的荷札名稱"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === "Enter") {
            e.preventDefault();
            attach(q);
          }
        }}
      />
      {sug && (sug.items.length > 0 || sug.create) && (
        <div className="row">
          {sug.items.map((it) => (
            <button key={it.key} type="button" className="ns-selbar-tag is-add" onClick={() => attach(it.name)}>
              #{it.name}
            </button>
          ))}
          {sug.create && (
            <button type="button" className="ns-selbar-tag is-add" onClick={() => attach(sug.create!.name)}>
              ＋ 新荷札 #{sug.create.name}
            </button>
          )}
        </div>
      )}
      <p className="hint">{common.size ? "點上面的荷札＝從這幾則一起摘下。" : "掛上的荷札，這幾則都會有。"}</p>
    </div>
  );
}

/* ───────── 手機收件匣底部選取列 ───────── */

const MOBILE_INBOX_SHEET = "notes.inbox.selectSheet";
type MobileSheet = "date" | "attach" | "tags" | null;

function IconCal() {
  return (
    <svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2.4" y="3.4" width="11.2" height="10" rx="1" />
      <path d="M2.4 6.6h11.2M5.4 2v2.6M10.6 2v2.6" />
    </svg>
  );
}
function IconMove() {
  return (
    <svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2.5 5.5V3.4c0-.5.4-.9.9-.9h3l1.4 1.6h4.8c.5 0 .9.4.9.9v1.5" />
      <path d="M2.5 7.5v5.1c0 .5.4.9.9.9h9.2c.5 0 .9-.4.9-.9V8.4" />
      <path d="M6 10.4h4.6M9 8.8l1.6 1.6L9 12" />
    </svg>
  );
}
function IconHash() {
  return (
    <svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6.2 2.5 4.8 13.5M11.2 2.5 9.8 13.5M2.8 6h10.6M2.4 10h10.6" />
    </svg>
  );
}
function IconTrash() {
  return (
    <svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 4.5h10M6 4.5V3.2c0-.4.3-.7.7-.7h2.6c.4 0 .7.3.7.7v1.3M4.3 4.5l.6 8.2c0 .5.4.8.9.8h4.4c.5 0 .9-.3.9-.8l.6-8.2" />
    </svg>
  );
}

export function MobileInboxSelectionBar({ visibleIds }: { visibleIds: readonly string[] }) {
  const ids = useInboxSelectStore((s) => s.ids);
  const mobileMode = useInboxSelectStore((s) => s.mobileMode);
  const clear = useInboxSelectStore((s) => s.clear);
  const setAll = useInboxSelectStore((s) => s.setAll);
  const inboxNotes = useNotesStore((s) => s.inboxNotes);
  const inboxTickets = useNotesStore((s) => s.inboxTickets);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const [sheet, setSheet] = useState<MobileSheet>(null);
  const close = () => setSheet(null);

  const refs = useMemo(() => resolveRefs(ids, inboxNotes, inboxTickets), [ids, inboxNotes, inboxTickets]);
  const count = refs.length;
  const selecting = mobileMode || count > 0;
  const ticketCount = refs.filter((r) => r.kind === "ticket").length;
  const hasNotes = refs.some((r) => r.kind === "note");
  const attachKinds: readonly AttachKind[] = hasNotes ? ["branch", "train", "car"] : ["branch", "train", "car", "ticket"];

  useBackLayer("notes.inbox.select", selecting, clear, "page");
  useBackLayer(MOBILE_INBOX_SHEET, count > 0 && sheet !== null && sheet !== "attach", close);

  useEffect(() => {
    if (!count) setSheet(null);
  }, [count]);

  if (!selecting) return null;

  const today = todayKey(dayStartHour);
  const explain = (why: string) => () => useUiStore.getState().showToast({ message: why }, 3200);

  return (
    <>
      <div className="m-selbar-dock">
        <div className="m-selbar techo-card" role="toolbar" aria-label="收件匣選取列">
          <span className="m-selbar-cnt" aria-live="polite">
            {count > 0 ? (
              <>
                已選<b>{count}</b>則
              </>
            ) : (
              "點卡片勾選"
            )}
          </span>
          {visibleIds.length > count && count === 0 && (
            <button type="button" className="ns-btn ns-btn--sm btn-text" onClick={() => setAll(visibleIds)}>
              全選
            </button>
          )}
          <button
            type="button"
            className={"m-selbar-ib" + (!count || ticketCount === 0 ? " is-off" : "")}
            aria-label="排乘車日"
            title="乘車日"
            onClick={
              !count
                ? undefined
                : ticketCount === 0
                  ? explain("只有臨時車票能排乘車日")
                  : () => setSheet("date")
            }
          >
            <IconCal />
            乘車日
          </button>
          <button
            type="button"
            className={"m-selbar-ib" + (!count ? " is-off" : "")}
            disabled={!count}
            aria-label="掛路線"
            title="掛路線"
            onClick={() => count > 0 && setSheet("attach")}
          >
            <IconMove />
            掛路線
          </button>
          <button
            type="button"
            className={"m-selbar-ib" + (!count ? " is-off" : "")}
            disabled={!count}
            aria-label="掛荷札"
            title="荷札"
            onClick={() => count > 0 && setSheet("tags")}
          >
            <IconHash />
            荷札
          </button>
          <button
            type="button"
            className={"m-selbar-ib ns-btn-danger" + (!count ? " is-off" : "")}
            disabled={!count}
            aria-label={`刪除 ${count} 則`}
            title="刪除"
            onClick={() => {
              if (!count) return;
              const snap = [...refs];
              clear();
              void useNotesStore.getState().batchDeleteInbox(snap);
            }}
          >
            <IconTrash />
            刪除
          </button>
          <button type="button" className="m-selbar-x" onClick={clear}>
            取消
          </button>
        </div>
      </div>

      {sheet === "date" && ticketCount > 0 && (
        <MobileDatePicker
          title={`排乘車日・${ticketCount} 張`}
          value={null}
          min={today}
          today={today}
          quick={[
            { label: "今天", day: today },
            { label: "明天", day: addDays(today, 1) },
            { label: "後天", day: addDays(today, 2) },
            { label: "下週一", day: nextMonday(today, addDays) },
          ]}
          onPick={(d) => {
            const snap = [...refs];
            close();
            clear();
            void useNotesStore.getState().batchScheduleInbox(snap, d);
          }}
          onClose={close}
          backId={MOBILE_INBOX_SHEET}
        />
      )}

      {sheet === "attach" && count > 0 && (
        <MobileAttachPicker
          title={`掛到哪條路線或節點・${count} 則`}
          depth="node"
          kinds={attachKinds}
          routeSelectable
          value={null}
          onPick={(t) => {
            const snap = [...refs];
            close();
            clear();
            void useNotesStore.getState().batchAttachInboxToTarget(snap, t);
          }}
          onClose={close}
        />
      )}

      {sheet === "tags" && count > 0 && <MobileInboxTagSheet refs={refs} onClose={close} />}
    </>
  );
}

function MobileInboxTagSheet({ refs, onClose }: { refs: readonly InboxRef[]; onClose(): void }) {
  const index = useTagStore((s) => s.index);
  const [q, setQ] = useState("");
  const composing = useRef(false);
  useEffect(() => {
    if (!useTagStore.getState().index) void useTagStore.getState().loadIndex();
  }, []);
  const attached = useMemo(() => {
    if (!index) return [];
    const keys = new Set<string>();
    for (const r of refs) {
      for (const k of keysOfEntity(index, r.kind === "ticket" ? "node" : "note", r.id)) keys.add(k);
    }
    return [...keys].map((k) => ({ key: k, name: index.byKey[k]?.name ?? k })).sort((a, b) => (a.name < b.name ? -1 : 1));
  }, [index, refs]);
  const items = index ? suggest(index, q, { limit: 10 }).items : [];
  const attach = (name: string) => {
    const n = name.trim().replace(/^#/, "");
    if (!n) return;
    const snap = [...refs];
    onClose();
    void useNotesStore.getState().batchAttachInboxTag(snap, n);
  };
  return (
    <MSheet
      title="荷札"
      overline={`已選 ${refs.length} 則`}
      backId={MOBILE_INBOX_SHEET}
      onClose={onClose}
      foot={
        <>
          <button type="button" className="ns-btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button type="button" className="ns-btn btn-seal" disabled={!q.trim()} onClick={() => attach(q)}>
            掛上
          </button>
        </>
      }
    >
      <div className="m-seltag-row">
        <input
          className="m-nt-input m-txs-input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229 || composing.current) return;
            if (e.key === "Enter") {
              e.preventDefault();
              attach(q);
            }
          }}
          placeholder="荷札名稱（沒有就新建）"
          aria-label="要掛上的荷札名稱"
          enterKeyHint="done"
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      <p className="m-seltag-h">{q.trim() ? "符合的荷札" : "常用"}</p>
      {items.length ? (
        <div className="m-seltag-chips">
          {items.map((it) => (
            <button key={it.key} type="button" className="m-seltag-chip" onClick={() => attach(it.name)}>
              #{it.name}
            </button>
          ))}
        </div>
      ) : (
        <p className="m-seltag-empty">{index ? "還沒有荷札——打字後按「掛上」新建一個" : "荷札載入中…"}</p>
      )}
      {attached.length > 0 && (
        <>
          <p className="m-seltag-h">已掛的（點一下從選到的項目拿掉）</p>
          <div className="m-seltag-chips">
            {attached.map((t) => (
              <button
                key={t.key}
                type="button"
                className="m-seltag-chip is-rm"
                aria-label={`拿掉荷札 ${t.name}`}
                onClick={() => {
                  const snap = [...refs];
                  onClose();
                  void useNotesStore.getState().batchDetachInboxTag(snap, t.key);
                }}
              >
                #{t.name} <span aria-hidden>×</span>
              </button>
            ))}
          </div>
        </>
      )}
    </MSheet>
  );
}
