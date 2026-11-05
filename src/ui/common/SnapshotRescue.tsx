/**
 * SnapshotRescue——從雲端備份撿回（第五本第二梯 ⑦；契約 §3.2、§3.5；原型 `prototypes/失物招領.html` B）。桌機 DialogShell L、手機 MFullPage。
 *
 * 兩個畫面（狀態在 lostFoundStore.rescue）：
 *   挑一份：預設只列 30 天前的備份（近期備份撿得回的幾乎都還在最近刪除裡）；「重新開始」之後是例外，所以留一個「也看最近 30 天的」展開。
 *   看一份：讀取中 → 算差異 → 「現在沒有」＋「內容不同」兩段。撿回後列打勾留在畫面上；內容不同點開並排比對，「改回」＋toast「復原」。
 *
 * 桌機不疊兩層暗幕：SettingsPanel 看到 `rescue` 就把設定整張換成這一張（同位置、同寬，只有一層暗幕），× 回設定、停在原籤。
 * 手機由 MobileMore 掛：全螢幕頁蓋在原本的子頁上，返回一層一層退。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { LOST_FOUND_DAYS, type ChangedItem, type SnapshotItem } from "../../domain/lostFound";
import type { SnapshotEntry } from "../../data/syncRepository";
import { changedMatches, lostMatches, useLostFoundStore } from "../../store/lostFoundStore";
import { fmtSyncStamp, useSyncStore } from "../../store/syncStore";
import { lostOpener } from "../settings/lostFoundOpen";
import { Hl, IconCheck, LostHead, LostNoMatch, LostRow, scrollParent, useFlip } from "../settings/LostFoundList";
import "../settings/lostFound.css";
import { fmtBytes, snapshotKindLabel, snapshotWho } from "./CloudSnapshots";
import { DialogShell } from "./DialogShell";
import { EmptyState } from "./EmptyState";
import { IconChevron } from "./icons";
import { MFullPage } from "./MFullPage";

export const RESCUE_TEXT = {
  pickTitle: "從雲端備份找",
  snapTitle: (at: string) => `${fmtSyncStamp(at)} 的備份`,
  pickIntro: "東西還在的那天，挑那天或更早的備份。",
  showRecent: (n: number) => `也看最近 ${LOST_FOUND_DAYS} 天的（${n} 份）`,
  hideRecent: `只看 ${LOST_FOUND_DAYS} 天前的`,
  noOld: `還沒有 ${LOST_FOUND_DAYS} 天前的備份。`,
  noneAtAll: "雲端還沒有備份。",
  loading: "讀取中…",
  swap: "換一份",
  revertNote: "現在這份會換成備份那時的。",
  same: "這份備份跟現在一樣",
  sameDesc: "沒有現在不見的，內容也都相同。",
} as const;

const charCount = (s: string | null): number => [...(s ?? "")].length;

/** 內容不同的補充：筆記講字數差（內容被清空一眼看得出來），車票講哪幾欄改過 */
function changedSub(item: ChangedItem): string {
  if (item.kind !== "ticket") {
    const f = item.fields[0];
    return `備份那時 ${charCount(f?.snapshot ?? null)} 字，現在 ${charCount(f?.current ?? null)} 字`;
  }
  return `${item.fields.map((f) => f.label).join("和")}改過`;
}

function PickBody({ mobile }: { mobile: boolean }) {
  const list = useSyncStore((s) => s.cloudSnapshots);
  const cloudError = useSyncStore((s) => s.cloudError);
  const refresh = useSyncStore((s) => s.refreshCloudSnapshots);
  const deviceId = useSyncStore((s) => s.status?.device_id);
  const openSnapshot = useLostFoundStore((s) => s.openSnapshot);
  const [showRecent, setShowRecent] = useState(false);
  const noteCls = mobile ? "m2-note" : "ns-note";

  if (cloudError && !list) {
    return (
      <div className={`${noteCls} lf-state is-warn`} role="alert">
        {cloudError}
        <div className="lf-state-acts">
          <button type="button" className="ns-btn ns-btn--sm btn-text" onClick={() => void refresh()}>
            重試
          </button>
        </div>
      </div>
    );
  }
  if (!list) return <p className={`${noteCls} lf-state`}>{RESCUE_TEXT.loading}</p>;
  if (list.length === 0) return <p className={`${noteCls} lf-state`}>{RESCUE_TEXT.noneAtAll}</p>;

  const cutoff = Date.now() - LOST_FOUND_DAYS * 86_400_000;
  const old = list.filter((e) => Date.parse(e.at) < cutoff);
  const recentCount = list.length - old.length;
  const shown: SnapshotEntry[] = showRecent ? list : old;

  return (
    <>
      <p className={`${noteCls} lf-intro`}>{RESCUE_TEXT.pickIntro}</p>
      {recentCount > 0 && (
        <div className="lf-pick-toggle">
          <button type="button" className="ns-btn btn-text" aria-expanded={showRecent} onClick={() => setShowRecent((v) => !v)}>
            {showRecent ? RESCUE_TEXT.hideRecent : RESCUE_TEXT.showRecent(recentCount)}
          </button>
        </div>
      )}
      {shown.length === 0 ? (
        <p className={`${noteCls} lf-state`}>{RESCUE_TEXT.noOld}</p>
      ) : (
        <ul className="lf-pick">
          {shown.map((e) => (
            <li key={e.key}>
              <span className="t">{fmtSyncStamp(e.at)}</span>
              <span className="w" title={`${snapshotWho(e, deviceId)}・${snapshotKindLabel(e.kind)}・${fmtBytes(e.size)}`}>
                {snapshotWho(e, deviceId)}・{snapshotKindLabel(e.kind)}・{fmtBytes(e.size)}
              </span>
              <button type="button" className="ns-btn ns-btn--sm btn-ghost" onClick={() => openSnapshot(e, true)}>
                打開
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function DiffField({ label, value }: { label?: string; value: string | null }) {
  return (
    <div className="lf-diff-f">
      {label && <span className="lf-diff-l">{label}</span>}
      <span className={"lf-diff-v" + (value ? "" : " is-empty")}>{value || "（空的）"}</span>
    </div>
  );
}

function ChangedRow({ item, q, mobile }: { item: ChangedItem; q: string; mobile: boolean }) {
  const open = useLostFoundStore((s) => s.openDiff === item.key);
  const done = useLostFoundStore((s) => !!s.reverted[item.key]);
  const busy = useLostFoundStore((s) => s.pending === item.key);
  const toggle = useLostFoundStore((s) => s.toggleDiff);
  const revert = useLostFoundStore((s) => s.revert);
  const note = item.kind !== "ticket";
  const panelId = `lfDiff-${item.id}`;
  const nameCls = "lf-name" + (note ? " is-note" : "");

  if (done) {
    return (
      <li className="lf-item" data-flip={item.key}>
        <div className="lf-row is-picked">
          <span className="lf-kind">{item.kindLabel}</span>
          <div className={nameCls}>
            <Hl text={item.title} q={q} />
          </div>
          <div className="lf-sub" />
          <span className="lf-done">
            <IconCheck />
            已改回
          </span>
        </div>
      </li>
    );
  }
  return (
    <li className={"lf-item" + (open ? " is-open" : "")} data-flip={item.key}>
      <button type="button" className="lf-row lf-toggle" aria-expanded={open} aria-controls={panelId} onClick={() => toggle(item.key)}>
        <span className="lf-kind">{item.kindLabel}</span>
        <span className={nameCls}>
          <Hl text={item.title} q={q} />
        </span>
        <span className="lf-sub">{changedSub(item)}</span>
        <span className="lf-chev">
          <IconChevron size={14} open={open} />
        </span>
      </button>
      {open && (
        <div className="lf-diff" id={panelId}>
          <div className="lf-diff-cols" style={{ "--n": item.fields.length } as React.CSSProperties} tabIndex={mobile ? undefined : 0}>
            <div className="lf-diff-col">
              <div className="lf-diff-h">備份那時</div>
              {item.fields.map((f) => (
                <DiffField key={f.col} label={note ? undefined : f.label} value={f.snapshot} />
              ))}
            </div>
            <div className="lf-diff-col">
              <div className="lf-diff-h">現在</div>
              {item.fields.map((f) => (
                <DiffField key={f.col} label={note ? undefined : f.label} value={f.current} />
              ))}
            </div>
          </div>
          <div className="lf-diff-foot">
            <p className={mobile ? "m2-note" : "ns-note"}>{RESCUE_TEXT.revertNote}</p>
            <button type="button" className="ns-btn ns-btn--sm btn-ghost" disabled={busy} onClick={() => void revert(item)}>
              改回
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

function SnapBody({ mobile }: { mobile: boolean }) {
  const diff = useLostFoundStore((s) => s.diff);
  const snapError = useLostFoundStore((s) => s.snapError);
  const q = useLostFoundStore((s) => s.snapQ);
  const cat = useLostFoundStore((s) => s.snapCat);
  const picked = useLostFoundStore((s) => s.picked);
  const pending = useLostFoundStore((s) => s.pending);
  const openDiff = useLostFoundStore((s) => s.openDiff);
  const setQ = useLostFoundStore((s) => s.setSnapQ);
  const setCat = useLostFoundStore((s) => s.setSnapCat);
  const openPick = useLostFoundStore((s) => s.openPick);
  const retry = useLostFoundStore((s) => s.retrySnapshot);
  const pickUp = useLostFoundStore((s) => s.pickUpFromSnapshot);
  const opener = useMemo(() => lostOpener(mobile), [mobile]);
  const noteCls = mobile ? "m2-note" : "ns-note";

  const missing: SnapshotItem[] = useMemo(() => (diff?.missing ?? []).filter((it) => lostMatches(it, q, cat)), [diff, q, cat]);
  const changed: ChangedItem[] = useMemo(() => (diff?.changed ?? []).filter((it) => changedMatches(it, q, cat)), [diff, q, cat]);

  const listRef = useRef<HTMLDivElement>(null);
  const diffSecRef = useRef<HTMLDivElement>(null);
  const headWrapRef = useRef<HTMLDivElement>(null);
  useFlip(listRef, [...missing.map((i) => i.key), ...changed.map((i) => i.key), openDiff ?? ""].join("|"));

  const jumpToDiff = () => {
    const sec = diffSecRef.current;
    const sc = scrollParent(sec);
    if (!sec || !sc) return;
    const head = headWrapRef.current?.querySelector<HTMLElement>(".lf-head");
    const top = sc.scrollTop + sec.getBoundingClientRect().top - sc.getBoundingClientRect().top - (head?.offsetHeight ?? 0) - 4;
    sc.scrollTo({ top, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  };

  if (snapError) {
    return (
      <div className={`${noteCls} lf-state is-warn`} role="alert">
        {snapError}
        <div className="lf-state-acts">
          <button type="button" className="ns-btn ns-btn--sm btn-text" onClick={retry}>
            重試
          </button>
          <button type="button" className="ns-btn ns-btn--sm btn-text" onClick={openPick}>
            {RESCUE_TEXT.swap}
          </button>
        </div>
      </div>
    );
  }
  if (!diff) return <p className={`${noteCls} lf-state`}>{RESCUE_TEXT.loading}</p>;
  if (diff.missing.length === 0 && diff.changed.length === 0) {
    return <EmptyState tone="first" stamp={null} title={RESCUE_TEXT.same} desc={RESCUE_TEXT.sameDesc} action={{ label: RESCUE_TEXT.swap, onClick: openPick }} />;
  }

  return (
    <div ref={headWrapRef}>
      <div className="lf-snaphead">
        <p className={`${noteCls} lf-lead`}>
          現在沒有的 {diff.missing.length} 件、
          {diff.changed.length > 0 ? (
            <button type="button" className="lf-jump" onClick={jumpToDiff}>
              內容不同的 {diff.changed.length} 件
            </button>
          ) : (
            "內容不同的 0 件"
          )}
        </p>
        <button type="button" className="ns-btn btn-text" onClick={openPick}>
          {RESCUE_TEXT.swap}
        </button>
      </div>
      <LostHead q={q} cat={cat} onQ={setQ} onCat={setCat} />
      <div ref={listRef} className="lf-list">
        {missing.length === 0 && changed.length === 0 ? (
          <LostNoMatch q={q} onClearQ={() => setQ("")} onAllCat={() => setCat("all")} />
        ) : (
          <>
            {missing.length > 0 && (
              <>
                <div className="sec">
                  <h3>現在沒有</h3>
                  <span className="rule" />
                </div>
                <ul className="lf-rows">
                  {missing.map((it) => (
                    <LostRow key={it.key} item={it} q={q} done={!!picked[it.key]} busy={pending === it.key} onPick={() => void pickUp(it, opener)} />
                  ))}
                </ul>
              </>
            )}
            {changed.length > 0 && (
              <>
                <div ref={diffSecRef} className="sec">
                  <h3>內容不同</h3>
                  <span className="rule" />
                </div>
                <ul className="lf-rows">
                  {changed.map((it) => (
                    <ChangedRow key={it.key} item={it} q={q} mobile={mobile} />
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export function SnapshotRescue({ mobile = false }: { mobile?: boolean }) {
  const rescue = useLostFoundStore((s) => s.rescue);
  const back = useLostFoundStore((s) => s.backRescue);
  const close = useLostFoundStore((s) => s.closeRescue);
  const bodyRef = useRef<HTMLDivElement>(null);
  const viewKey = rescue?.view === "snap" ? rescue.entry.key : rescue?.view ?? "";

  // 換畫面（挑一份 ↔ 看一份）捲回頂
  useEffect(() => {
    const sc = scrollParent(bodyRef.current);
    if (sc) sc.scrollTop = 0;
  }, [viewKey]);

  if (!rescue) return null;
  const title = rescue.view === "snap" ? RESCUE_TEXT.snapTitle(rescue.entry.at) : RESCUE_TEXT.pickTitle;
  const body = <div ref={bodyRef}>{rescue.view === "snap" ? <SnapBody mobile={mobile} /> : <PickBody mobile={mobile} />}</div>;

  if (mobile) {
    return (
      <MFullPage title={title} left={{ label: "返回", back: true, onClick: back }} backId="core.more-rescue">
        {body}
      </MFullPage>
    );
  }
  return (
    <DialogShell title={title} overline={{ zh: "失物招領", latin: "Lost & Found" }} size="L" onClose={close} topClass="pt-[10vh]">
      {body}
    </DialogShell>
  );
}
