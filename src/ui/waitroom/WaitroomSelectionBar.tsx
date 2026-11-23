/**
 * WaitroomSelectionBar——候車室雙端多選與底部選取列（操作 9 跨頁對齊 · D-FB-4）。
 *
 * 桌機：Ctrl／⌘＋點加選、Shift＋點範圍選、右鍵「選取」、Ctrl＋A 全選、Esc／空白處取消；
 *       底部浮出 `.ns-selbar`：「已選 N 件」｜［換番線 ▾］［#荷札］［刪除 N 件］｜［× 取消］。
 * 手機：長按原地放開（或頂列「選取」）進多選、點列勾選／取消、返回鍵退出多選；
 *       tab bar 之上 `.m-selbar-dock`：「已選 N 件」｜［番線］［荷札］［刪除］｜［取消］。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import { keysOfEntity, suggest } from "../../domain/tags";
import { TK_TAG_WISH } from "../../domain/ticketTags";
import { useTagStore } from "../../store/tagStore";
import { MSheet, MSheetItem } from "../common/MSheet";
import { OverlineText } from "../common/PageHeader";
import { PopMenu } from "../common/PopMenu";
import "../common/selection/selection.css";
import { useBackLayer } from "../mobile/backStack";
import "../mobile/mobile-select.css";
import { usePopDismiss } from "../notes/notesBits";
import "../notes/notes.css";
import {
  batchAttachWishTag,
  batchDeleteWishes,
  batchDetachWishTag,
  batchSetWishKind,
} from "./waitroomActs";
import { platformNo, useKinds } from "./waitroomParts";

interface WaitroomSelectState {
  ids: string[];
  anchor: string | null;
  mobileMode: boolean;
  toggle(id: string, order: readonly string[]): void;
  range(id: string, order: readonly string[], fallbackAnchor?: string | null): void;
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

export const useWaitroomSelectStore = create<WaitroomSelectState>((set, get) => ({
  ids: [],
  anchor: null,
  mobileMode: false,

  toggle(id, order) {
    const cur = get().ids;
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

/** 清單換了自動剔除不在畫面上的項目；離開候車室時清空 */
export function usePruneWaitroomSelection(visibleIds: readonly string[]): void {
  const key = visibleIds.join("|");
  const ref = useRef(visibleIds);
  ref.current = visibleIds;
  useEffect(() => {
    useWaitroomSelectStore.getState().prune(ref.current);
  }, [key]);
  useEffect(() => () => useWaitroomSelectStore.getState().clear(), []);
}

type DeskPop = "kind" | "tag" | null;

export function WaitroomSelectionBar({ visibleIds }: { visibleIds: readonly string[] }) {
  const ids = useWaitroomSelectStore((s) => s.ids);
  const clear = useWaitroomSelectStore((s) => s.clear);
  const setAll = useWaitroomSelectStore((s) => s.setAll);
  const { kinds } = useKinds();
  const tagIndex = useTagStore((s) => s.index);
  const [pop, setPop] = useState<DeskPop>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const probe = useRef<HTMLSpanElement>(null);
  const kindBtnRef = useRef<HTMLButtonElement | null>(null);

  useLayoutEffect(() => {
    setHost(probe.current?.closest("main") ?? document.body);
  }, []);

  const count = ids.length;
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
    <div className="ns-selbar techo-card" role="toolbar" aria-label="候車室選取列" onKeyDown={onBarKey}>
      <span className="cnt" aria-live="polite">
        已選 <b>{count}</b> 件
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
        ref={kindBtnRef}
        className="ns-btn ns-btn--sm btn-ghost"
        aria-haspopup="menu"
        aria-expanded={pop === "kind"}
        disabled={kinds.length === 0}
        title="換到另一條番線（種類）"
        onClick={() => togglePop("kind")}
      >
        換番線 ▾
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
          const snap = [...ids];
          clear();
          void batchDeleteWishes(snap);
        }}
      >
        刪除 {count} 件
      </button>
      <span className="sep" aria-hidden />
      <button type="button" className="ns-btn ns-btn--sm btn-text x" title="取消選取（Esc）" onClick={clear}>
        × 取消
      </button>

      {pop === "kind" && (
        <PopMenu
          anchor={kindBtnRef.current}
          overline={{ zh: `已選 ${count} 件`, latin: "Platform" }}
          label={`把 ${count} 件換到哪一條番線`}
          items={kinds.map((k) => ({
            key: k.id,
            label: `${platformNo(kinds, k.id)}番線・${k.name}`,
            onSelect: () => {
              closePop();
              void batchSetWishKind(ids, k.id);
            },
          }))}
          onClose={closePop}
        />
      )}
      {pop === "tag" && <WishTagPop ids={ids} onClose={closePop} hasIndex={!!tagIndex} />}
    </div>
  );

  return (
    <>
      <span ref={probe} hidden />
      {host && createPortal(<div className="ns-selbar-dock">{bar}</div>, host)}
    </>
  );
}

function WishTagPop({ ids, onClose, hasIndex }: { ids: readonly string[]; onClose: () => void; hasIndex: boolean }) {
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
    ? ids
        .map((id) => new Set(ts.keysOf(TK_TAG_WISH, id)))
        .reduce<Set<string> | null>((acc, s) => (acc ? new Set([...acc].filter((k) => s.has(k))) : s), null) ?? new Set<string>()
    : new Set<string>();
  const sug = hasIndex && q.trim() ? ts.suggest(q, { limit: 5 }) : null;
  const attach = (name: string) => {
    const clean = name.trim().replace(/^#/, "");
    if (!clean) return;
    onClose();
    void batchAttachWishTag(ids, clean);
  };
  return (
    <div ref={ref} className="ns-selbar-pop is-tag techo-card" role="dialog" aria-label={`替 ${ids.length} 件掛荷札`}>
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
              title={`從這 ${ids.length} 件摘下 #${ts.nameOf(k)}`}
              onClick={() => {
                onClose();
                void batchDetachWishTag(ids, k);
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
      <p className="hint">{common.size ? "點上面的荷札＝從這幾件一起摘下。" : "掛上的荷札，這幾件都會有。"}</p>
    </div>
  );
}

/* ───────── 手機候車室底部選取列 ───────── */

const MOBILE_SHEET_LAYER = "core.waitroom.selectSheet";
type MobileSheet = "kind" | "tags" | null;

function IconSwap() {
  return (
    <svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 5.5h9.5M9.8 3l2.7 2.5-2.7 2.5" />
      <path d="M13 10.5H3.5M6.2 8l-2.7 2.5L6.2 13" />
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

export function MobileWaitroomSelectionBar({ visibleIds }: { visibleIds: readonly string[] }) {
  const ids = useWaitroomSelectStore((s) => s.ids);
  const mobileMode = useWaitroomSelectStore((s) => s.mobileMode);
  const clear = useWaitroomSelectStore((s) => s.clear);
  const setAll = useWaitroomSelectStore((s) => s.setAll);
  const { kinds } = useKinds();
  const [sheet, setSheet] = useState<MobileSheet>(null);
  const close = () => setSheet(null);
  const selecting = mobileMode || ids.length > 0;
  const count = ids.length;

  useBackLayer("core.waitroom.select", selecting, clear, "page");
  useBackLayer(MOBILE_SHEET_LAYER, count > 0 && sheet !== null, close);

  useEffect(() => {
    if (!count) setSheet(null);
  }, [count]);

  if (!selecting) return null;

  return (
    <>
      <div className="m-selbar-dock">
        <div className="m-selbar techo-card" role="toolbar" aria-label="候車室選取列">
          <span className="m-selbar-cnt" aria-live="polite">
            {count > 0 ? (
              <>
                已選<b>{count}</b>件
              </>
            ) : (
              "點項目勾選"
            )}
          </span>
          {visibleIds.length > count && (
            <button
              type="button"
              className="ns-btn ns-btn--sm btn-text"
              onClick={() => setAll(visibleIds)}
            >
              全選
            </button>
          )}
          <button
            type="button"
            className={"m-selbar-ib" + (!count || !kinds.length ? " is-off" : "")}
            disabled={!count || !kinds.length}
            aria-label="換番線"
            title="換番線"
            onClick={() => count > 0 && setSheet("kind")}
          >
            <IconSwap />
            番線
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
            aria-label={`刪除 ${count} 件`}
            title="刪除"
            onClick={() => {
              if (!count) return;
              const snap = [...ids];
              clear();
              void batchDeleteWishes(snap);
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

      {sheet === "kind" && count > 0 && (
        <MSheet list title="換番線" overline={`已選 ${count} 件`} backId={MOBILE_SHEET_LAYER} onClose={close}>
          {kinds.map((k) => (
            <MSheetItem
              key={k.id}
              onClick={() => {
                const snap = [...ids];
                close();
                void batchSetWishKind(snap, k.id);
              }}
            >
              {platformNo(kinds, k.id)}番線・{k.name}
            </MSheetItem>
          ))}
        </MSheet>
      )}

      {sheet === "tags" && count > 0 && <MobileWishTagSheet ids={ids} onClose={close} />}
    </>
  );
}

function MobileWishTagSheet({ ids, onClose }: { ids: readonly string[]; onClose(): void }) {
  const index = useTagStore((s) => s.index);
  const [q, setQ] = useState("");
  const composing = useRef(false);
  useEffect(() => {
    if (!useTagStore.getState().index) void useTagStore.getState().loadIndex();
  }, []);
  const attached = useMemo(() => {
    if (!index) return [];
    const keys = new Set<string>();
    for (const id of ids) for (const k of keysOfEntity(index, TK_TAG_WISH, id)) keys.add(k);
    return [...keys].map((k) => ({ key: k, name: index.byKey[k]?.name ?? k })).sort((a, b) => (a.name < b.name ? -1 : 1));
  }, [index, ids]);
  const items = index ? suggest(index, q, { limit: 10 }).items : [];
  const attach = (name: string) => {
    const n = name.trim().replace(/^#/, "");
    if (!n) return;
    const snap = [...ids];
    onClose();
    void batchAttachWishTag(snap, n);
  };
  return (
    <MSheet
      title="荷札"
      overline={`已選 ${ids.length} 件`}
      backId={MOBILE_SHEET_LAYER}
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
                  const snap = [...ids];
                  onClose();
                  void batchDetachWishTag(snap, t.key);
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
