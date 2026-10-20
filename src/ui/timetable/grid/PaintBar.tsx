/**
 * PaintBar——方眼的塗色列（⑤ 契約 §5.3、D-時-96、98、99；〈原型定案〉1、7、9；乙席）。
 * 長相＝原型 prototypes/時刻表-src/v-i.js paintBarHtml（.vi-pb）→ 正式版 `.ns-tt-grid-pb`（timetable.css §M）。
 *
 *   div.ns-tt-grid-pb[.is-desk|.is-phone][.is-live][.is-busy]
 *   ├ (手機) i.ns-tt-grid-grip
 *   ├ div.ns-tt-grid-pb-read   ReadLine（「14:00–15:30・1h30m」／live「14:00 起換成・繼續跑」＋赭字「會蓋掉 2 塊」）＋貼齊說明
 *   ├ (桌機) p.ns-tt-grid-pb-hint  點一個分類就直接寫…
 *   ├ (live) p.ns-tt-grid-pb-same  點「創作」＝這一班提早到 14:30 出發／＝本來就是，不會寫
 *   │                               ＋ small.ns-tt-grid-pb-other 別的分類＝這一班整班收掉／在 14:30 到站（讀數不算運行中那班；沙盒 F2）
 *   ├ div.ns-tt-grid-pb-cats   CategoryGrid compact（runningId＝運行中那班的分類）；點一格就寫
 *   └ div.ns-tt-grid-pb-act    「更多…」（live 不給，換成一行說明）＋「取消」（桌機帶 Esc 鍵帽）
 *
 * 點分類的那一刻才重算 end（`liveTail` ⇒ Date.now()）與模式（paintModeOf；契約 0-4）；寫入在飛時整列 busy（timetableGridStore.busy），
 * 寫完才清選區。「更多…」＝openSheet({ kind: "fill", start, end })＋清選區（補記面板一開就預演蓋掉幾塊，BlockPanel 那一行）。
 */
import { memo, useMemo } from "react";
import { fmtClock, fmtDur, msOf } from "../../../domain/timetable";
import { gridWindow, paintModeOf } from "../../../domain/timetableGrid";
import { TT_TEXT, useTimetableStore, type TimetableShell } from "../../../store/timetableStore";
import { useTimetableGridStore, type GridSel } from "../../../store/timetableGridStore";
import { useUiStore } from "../../../store/uiStore";
import { dayWindow } from "../../../lib/date";
import { CategoryGrid } from "../parts/CategoryGrid";
import { CategoryBadge } from "../CategoryBadge";
import { useNow } from "../useNow";
import { modeOf, snapNoteOf, useCoverText } from "./gridModel";

/** 讀數一行（拖的當下浮起來的那份與塗色列共用）：時刻抬成拉丁粗字、長度金字、赭字接在後面 */
export function ReadLine({ start, end, live, cover }: { start: number; end: number; live: boolean; cover: string }) {
  if (live) {
    const a = fmtClock(start);
    const s = TT_TEXT.gridLive(a);
    const i = s.indexOf(a);
    return (
      <>
        <span className="ns-tt-grid-rdm">
          {s.slice(0, i)}
          <b className="ns-tt-num">{a}</b>
          {s.slice(i + a.length)}
        </span>
        {cover && <em className="ns-tt-grid-cover">{cover}</em>}
      </>
    );
  }
  const s = TT_TEXT.gridRead(fmtClock(start), fmtClock(end), fmtDur(end - start));
  const k = s.lastIndexOf("・");
  return (
    <>
      <span className="ns-tt-grid-rdm">
        <b className="ns-tt-num">{k >= 0 ? s.slice(0, k) : s}</b>
        {k >= 0 && <span className="ns-tt-grid-rd ns-tt-num">{s.slice(k)}</span>}
      </span>
      {cover && <em className="ns-tt-grid-cover">{cover}</em>}
    </>
  );
}

export interface PaintBarProps {
  shell: TimetableShell;
  sel: GridSel;
}

/** memo：拖曳時 GridView 每一步重畫，塗色列（sel 沒變）不跟著重畫（沙盒 F1） */
export const PaintBar = memo(function PaintBar({ shell, sel }: PaintBarProps) {
  const isDesk = shell === "desktop";
  const running = useTimetableStore((s) => s.running);
  const catById = useTimetableStore((s) => s.catById);
  const dayKey = useTimetableStore((s) => s.dayKey);
  const paint = useTimetableStore((s) => s.paint);
  const openSheet = useTimetableStore((s) => s.openSheet);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const cellMin = useTimetableGridStore((s) => s.cellMin);
  const busy = useTimetableGridStore((s) => s.busy);
  const now = useNow(15_000);

  const geo = useMemo(() => {
    const dw = dayWindow(dayKey, dayStartHour);
    return { gw: gridWindow({ start: msOf(dw.start), end: msOf(dw.end) }), cellMs: cellMin * 60_000 };
  }, [dayKey, dayStartHour, cellMin]);

  const live = modeOf(sel, running !== null, now) === "live";
  const end = sel.liveTail ? Math.max(sel.end, now) : sel.end;
  const cover = useCoverText(sel, live, running);
  const snap = snapNoteOf(geo, sel);
  const runCat = running ? (catById[running.category_id] ?? null) : null;

  const onPick = (categoryId: string): void => {
    const g = useTimetableGridStore.getState();
    if (g.busy || !g.sel) return;
    const cur = g.sel;
    // 點分類的那一刻才重算（契約 0-4）：尾格含現在 ⇒ end＝現在；模式依這一刻的運行中重做
    const t = Date.now();
    const e = cur.liveTail ? t : cur.end;
    const mode = paintModeOf({ start: cur.start, end: e }, useTimetableStore.getState().running !== null, t);
    g.setBusy(true);
    void paint(categoryId, cur.start, e, mode).finally(() => {
      const st = useTimetableGridStore.getState();
      st.setSel(null);
      st.setBusy(false);
    });
  };
  const onMore = (): void => {
    const g = useTimetableGridStore.getState();
    if (!g.sel) return;
    const e = g.sel.liveTail ? Date.now() : g.sel.end;
    openSheet({ kind: "fill", start: g.sel.start, end: e });
    g.setSel(null);
  };
  const onCancel = (): void => useTimetableGridStore.getState().setSel(null);

  return (
    <div
      className={"ns-tt-grid-pb" + (isDesk ? " is-desk" : " is-phone") + (live ? " is-live" : "") + (busy ? " is-busy" : "")}
      aria-busy={busy || undefined}
    >
      {!isDesk && <i className="ns-tt-grid-grip" aria-hidden="true" />}
      <div className="ns-tt-grid-pb-read" aria-live="polite">
        <ReadLine start={sel.start} end={end} live={live} cover={cover} />
        {snap && <small className="ns-tt-grid-snap">{snap}</small>}
      </div>
      {isDesk && <p className="ns-tt-grid-pb-hint">{TT_TEXT.gridPaintHint(live)}</p>}
      {live && running && (
        <p className="ns-tt-grid-pb-same">
          <CategoryBadge cat={runCat} size="sm" />
          <span>
            {sel.start < msOf(running.started_at)
              ? TT_TEXT.gridLiveRestart(runCat?.name ?? "？", fmtClock(sel.start))
              : TT_TEXT.gridLiveSame(runCat?.name ?? "？")}
            {/* 沙盒 F2：讀數的「會蓋掉」不算運行中那班，點別的分類時它的結局在這裡講 */}
            <small className="ns-tt-grid-pb-other">
              {TT_TEXT.gridLiveOther(sel.start <= msOf(running.started_at), fmtClock(sel.start))}
            </small>
          </span>
        </p>
      )}
      <div className="ns-tt-grid-pb-cats">
        <CategoryGrid selected={null} onPick={onPick} compact runningId={running?.category_id ?? null} />
      </div>
      <div className="ns-tt-grid-pb-act">
        {live ? (
          <span className="ns-tt-grid-pb-note">{TT_TEXT.gridLiveNoMore}</span>
        ) : (
          <button type="button" className="ns-btn btn-ghost" onClick={onMore} disabled={busy}>
            {TT_TEXT.gridMore}
          </button>
        )}
        <button type="button" className="ns-btn btn-ghost ns-tt-grid-pb-cancel" onClick={onCancel} disabled={busy}>
          {TT_TEXT.gridCancel}
          {isDesk && (
            <kbd className="ns-tt-kbd" aria-hidden="true">
              Esc
            </kbd>
          )}
        </button>
      </div>
    </div>
  );
});
