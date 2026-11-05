/**
 * LostFoundList——「最近刪除」的內容（第五本第二梯 ⑦；契約 §2.5；原型 `prototypes/失物招領.html` A）。
 * 兩殼同一份：桌機放設定第六籤（SettingsPanel），手機放更多的子頁（MobileLostFound）；`mobile` 只換小字的 class，排法差在 lostFound.css。
 * 依刪除日期分段、新的在上；頂上搜尋＋分類 chip，捲動時黏住；每列常駐「撿回」（次鈕；朱不用，§0 法則：朱只蓋済）。
 * 列、頭、捲動小工具也給快照畫面（SnapshotRescue）用。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import {
  LOST_CATEGORY_LABEL,
  LOST_EMPTY,
  LOST_INTRO,
  LOST_MORE,
  lostChildLabel,
  lostDaySection,
  lostDaysAgo,
  type LostCategory,
  type LostItem,
} from "../../domain/lostFound";
import { lostMatches, useLostFoundStore, type LostCat } from "../../store/lostFoundStore";
import { useSyncStore } from "../../store/syncStore";
import { EmptyState } from "../common/EmptyState";
import { IconSearch } from "../common/icons";
import { lostOpener } from "./lostFoundOpen";
import "./lostFound.css";

const CATS: { key: LostCat; label: string }[] = [
  { key: "all", label: "全部" },
  ...(Object.keys(LOST_CATEGORY_LABEL) as LostCategory[]).map((key) => ({ key, label: LOST_CATEGORY_LABEL[key] })),
];

/** 標出搜尋字（第一處） */
export function Hl({ text, q }: { text: string; q: string }) {
  const t = q.trim();
  if (!t) return <>{text}</>;
  const i = text.toLowerCase().indexOf(t.toLowerCase());
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + t.length)}</mark>
      {text.slice(i + t.length)}
    </>
  );
}

/** 列的補充字：時段走拉丁數字、金額走襯線數字（§0 法則 04：襯線給金額），其他照內文 */
export function LostSub({ item, q }: { item: Pick<LostItem, "kind" | "childCount" | "detail">; q: string }) {
  const parts: ReactNode[] = [];
  if (item.detail) {
    if (item.kind === "time_block") {
      parts.push(
        <span key="d" className="lf-time">
          <Hl text={item.detail} q={q} />
        </span>,
      );
    } else if (item.kind.startsWith("tk_")) {
      item.detail.split("・").forEach((p, i) => {
        parts.push(
          /\d/.test(p) ? (
            <span key={i} className="lf-amt">
              <Hl text={p} q={q} />
            </span>
          ) : (
            <Hl key={i} text={p} q={q} />
          ),
        );
      });
    } else {
      parts.push(<Hl key="d" text={item.detail} q={q} />);
    }
  }
  const child = lostChildLabel(item);
  if (child) parts.push(<Hl key="c" text={child} q={q} />);
  return (
    <div className="lf-sub">
      {parts.map((p, i) => (
        <span key={i}>
          {i > 0 && "・"}
          {p}
        </span>
      ))}
    </div>
  );
}

const isNoteKind = (kind: string): boolean => kind === "note" || kind === "diary";

/** 列尾的「多久前」：今天講幾小時前（同一段裡才分得出先後），之前講幾天前 */
function agoText(iso: string, nowMs: number): string {
  const days = lostDaysAgo(iso, nowMs);
  if (days !== "今天") return days;
  const min = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 60_000));
  if (min < 1) return "剛剛";
  if (min < 60) return `${min} 分鐘前`;
  return `${Math.floor(min / 60)} 小時前`;
}

interface LostRowProps {
  item: Pick<LostItem, "key" | "kind" | "kindLabel" | "title" | "detail" | "childCount">;
  q: string;
  ago?: string;
  /** 已撿回：不再有鈕，列留著打勾 */
  done?: boolean;
  busy?: boolean;
  leaving?: boolean;
  onPick: () => void;
}

export function IconCheck() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 8.5 6.6 12 13 4.5" />
    </svg>
  );
}

export function LostRow({ item, q, ago, done, busy, leaving, onPick }: LostRowProps) {
  return (
    <li className={"lf-row" + (done ? " is-picked" : "") + (leaving ? " is-out" : "")} data-flip={item.key}>
      <span className="lf-kind">{item.kindLabel}</span>
      <div className={"lf-name" + (isNoteKind(item.kind) ? " is-note" : "")} title={item.title}>
        <Hl text={item.title} q={q} />
      </div>
      <LostSub item={item} q={q} />
      {ago && <span className="lf-ago">{ago}</span>}
      {done ? (
        <span className="lf-done">
          <IconCheck />
          已撿回
        </span>
      ) : (
        <button type="button" className="ns-btn ns-btn--sm btn-ghost lf-go" aria-label={`撿回 ${item.title}`} disabled={busy} onClick={onPick}>
          撿回
        </button>
      )}
    </li>
  );
}

/** 找外面那層捲動容器（對話框內文、手機頁、全螢幕頁） */
export function scrollParent(el: Element | null): HTMLElement | null {
  return el?.closest<HTMLElement>(".ns-dialog-body, .m-page, .ns-mfull-body") ?? null;
}

/** 頭黏住之後才鋪紙（.is-stuck） */
function useStuck(ref: RefObject<HTMLElement | null>): boolean {
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const head = ref.current;
    const sc = scrollParent(head);
    if (!head || !sc) return;
    const on = () => setStuck(sc.scrollTop > 0 && head.getBoundingClientRect().top <= sc.getBoundingClientRect().top + 0.5);
    sc.addEventListener("scroll", on, { passive: true });
    on();
    return () => sc.removeEventListener("scroll", on);
  }, [ref]);
  return stuck;
}

interface LostHeadProps {
  q: string;
  cat: LostCat;
  onQ: (q: string) => void;
  onCat: (cat: LostCat) => void;
}

/** 搜尋＋分類 chip（兩個畫面同一組） */
export function LostHead({ q, cat, onQ, onCat }: LostHeadProps) {
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const stuck = useStuck(ref);
  return (
    <div ref={ref} className={"lf-head" + (stuck ? " is-stuck" : "")}>
      <label className="lf-search">
        <IconSearch size={14} />
        <input
          ref={inputRef}
          type="search"
          placeholder="搜尋名稱"
          aria-label="搜尋"
          autoComplete="off"
          value={q}
          onChange={(e) => onQ(e.target.value)}
          onKeyDown={(e) => {
            // 有字時 Esc 先清字，不連對話框一起關（殼看 defaultPrevented）
            if (e.key === "Escape" && q && !e.nativeEvent.isComposing) {
              e.preventDefault();
              onQ("");
            }
          }}
        />
        {q && (
          <button
            type="button"
            className="ns-close ns-close--sm"
            aria-label="清除搜尋"
            title="清除搜尋"
            onClick={() => {
              onQ("");
              inputRef.current?.focus();
            }}
          >
            ×
          </button>
        )}
      </label>
      <div className="lf-chips" role="group" aria-label="分類">
        {CATS.map((c) => (
          <button key={c.key} type="button" className="chip ns-chip" aria-pressed={cat === c.key} onClick={() => onCat(c.key)}>
            {c.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** 篩完沒東西：有字＝找不到；只有分類＝這一類沒有 */
export function LostNoMatch({ q, onClearQ, onAllCat }: { q: string; onClearQ: () => void; onAllCat: () => void }) {
  const t = q.trim();
  return t ? (
    <EmptyState tone="nores" title={`找不到「${t}」`} desc="換個字試試看。" secondary={{ label: "清除搜尋", onClick: onClearQ }} />
  ) : (
    <EmptyState tone="first" stamp={null} title="這一類沒有東西" secondary={{ label: "看全部", onClick: onAllCat }} />
  );
}

/** 列換位置時滑過去（FLIP；`[data-flip]` 當身分，signature 變了才算） */
export function useFlip(ref: RefObject<HTMLElement | null>, signature: string): void {
  const tops = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const base = root.getBoundingClientRect().top;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const next = new Map<string, number>();
    root.querySelectorAll<HTMLElement>("[data-flip]").forEach((n) => {
      const key = n.dataset.flip as string;
      const top = n.getBoundingClientRect().top - base;
      next.set(key, top);
      const was = tops.current.get(key);
      if (was === undefined || still || Math.abs(was - top) < 1) return;
      n.animate([{ transform: `translateY(${was - top}px)` }, { transform: "none" }], { duration: 260, easing: "cubic-bezier(.2,.8,.2,1)" });
    });
    tops.current = next;
  }, [ref, signature]);
}

export function LostFoundList({ mobile = false }: { mobile?: boolean }) {
  const items = useLostFoundStore((s) => s.items);
  const listError = useLostFoundStore((s) => s.listError);
  const q = useLostFoundStore((s) => s.q);
  const cat = useLostFoundStore((s) => s.cat);
  const pending = useLostFoundStore((s) => s.pending);
  const leaving = useLostFoundStore((s) => s.leaving);
  const load = useLostFoundStore((s) => s.load);
  const setQ = useLostFoundStore((s) => s.setQ);
  const setCat = useLostFoundStore((s) => s.setCat);
  const pickUp = useLostFoundStore((s) => s.pickUp);
  const openPick = useLostFoundStore((s) => s.openPick);
  const joined = useSyncStore((s) => !!s.status?.configured);
  const lastSync = useSyncStore((s) => s.status?.last_sync_at ?? null);
  const refreshStatus = useSyncStore((s) => s.refreshStatus);
  const opener = useMemo(() => lostOpener(mobile), [mobile]);
  const noteCls = mobile ? "m2-note" : "ns-note";

  // 進頁讀一次；同步拉到東西（另一台也撿回或又刪了）跟著換
  useEffect(() => {
    void load();
  }, [load, lastSync]);
  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const now = Date.now();
  const shown = useMemo(() => (items ?? []).filter((it) => lostMatches(it, q, cat)), [items, q, cat]);
  const sections = useMemo(() => {
    const out: { label: string; rows: LostItem[] }[] = [];
    for (const it of shown) {
      const label = lostDaySection(it.deletedAt, now);
      const last = out[out.length - 1];
      if (last?.label === label) last.rows.push(it);
      else out.push({ label, rows: [it] });
    }
    return out;
    // now 只用來定「今天／昨天」：跟著清單重算就夠
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown]);

  const listRef = useRef<HTMLDivElement>(null);
  useFlip(listRef, shown.map((i) => i.key).join("|"));

  const intro = <p className={`${noteCls} lf-intro`}>{LOST_INTRO}</p>;

  if (listError && !items) {
    return (
      <>
        {intro}
        <div className={`${noteCls} lf-state is-warn`} role="alert">
          {listError}
          <div className="lf-state-acts">
            <button type="button" className="ns-btn ns-btn--sm btn-text" onClick={() => void load()}>
              重試
            </button>
          </div>
        </div>
      </>
    );
  }
  if (!items) return intro; // 資料未到不畫空狀態（§1.8）
  if (items.length === 0) {
    return (
      <>
        {intro}
        <EmptyState tone="first" stamp={null} title={LOST_EMPTY} action={joined ? { label: "從雲端備份找", onClick: openPick } : undefined} />
      </>
    );
  }

  return (
    <>
      {intro}
      <LostHead q={q} cat={cat} onQ={setQ} onCat={setCat} />
      <div ref={listRef} className="lf-list">
        {shown.length === 0 ? (
          <LostNoMatch q={q} onClearQ={() => setQ("")} onAllCat={() => setCat("all")} />
        ) : (
          sections.map((sec) => (
            <div key={sec.label} className="lf-section">
              <div className="sec">
                <h3>{sec.label}</h3>
                <span className="rule" />
              </div>
              <ul className="lf-rows">
                {sec.rows.map((it) => (
                  <LostRow
                    key={it.key}
                    item={it}
                    q={q}
                    ago={agoText(it.deletedAt, now)}
                    busy={pending === it.key}
                    leaving={leaving === it.key}
                    onPick={() => void pickUp(it, opener)}
                  />
                ))}
              </ul>
            </div>
          ))
        )}
      </div>
      {joined && (
        <div className="lf-more">
          <button type="button" className="ns-btn btn-text" onClick={openPick}>
            {LOST_MORE} ›
          </button>
        </div>
      )}
    </>
  );
}
