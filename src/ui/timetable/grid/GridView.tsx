/**
 * GridView——時刻表的「方眼」視圖，兩殼共用（⑤ 契約 §5.2～§5.4、D-時-90～108；〈原型定案〉1、4、7、9；乙席）。
 * 長相＝原型 prototypes/時刻表-⑤.html（v-i.js deskPage／phonePage）。
 *
 * 桌機 `<GridView shell="desktop" />`：
 *   section.ns-tt-grid.is-desk（flex:1；左方眼、右欄 320px）
 *   ├ div.ns-tt-grid-main   GridNav（DateNav ‹ 10/20（一）今天 › ＋「今天」、拖的時候的讀數、格子大小 5｜10｜15｜30 分）＋ GridSheet
 *   └ aside.ns-tt-grid-side 沒選＝DaySummary＋操作說明與圖例；選了＝PaintBar
 * 手機 `<GridView shell="mobile" />`：
 *   div.ns-tt-grid.is-phone[data-no-fab]（撐滿 .m-page 剩下的高；整頁不捲——§M 用 :has 把 .m-page 改成直欄不捲；
 *     data-no-fab＝收起「記一句」浮鈕：整頁不捲，鈕放哪都蓋一格，磨光③ 2-13）
 *   ├ GridNav（拖的時候讀數蓋在這一列上，手指遮不到；UI 丙-4 D9：DateNav 收緊成一列，「今天」chip 兩殼都有）
 *   ├ GridSheet（24 列跟著高度伸縮；一列 1 小時算出來 < 16px 改一列 2 小時，〈原型定案〉4）
 *   └ div.ns-tt-grid-legend 本日各分類合計（橫捲；選了一段時藏起來、不讓位）
 * 手機的塗色列另外 export `MobileGridDock`：要放在 `.m-page` **外面**（`.m-page` 是 z-index:1 的 stacking context，蓋不過運行列），
 * 由整合席掛在 MobileTimetable 的 Fragment 裡、`.ns-tt-mdock` 後面：`{mobileView === "grid" && <MobileGridDock />}`。
 *
 * - 選區與格子大小在 `timetableGridStore`；這裡在掛上時 `load(shell)`、卸下時清選區。
 * - 點一下（D-時-95）：有顏色＝那一格佔最多的那一塊（pickCellBlock）照軸的點擊語義（待確認⇒其實到幾點、運行中⇒toast、其餘⇒改一塊）；
 *   空白＝補那整段空白（fill 面板）；未來＝toast。選區開著時點格子＝收掉選區（＝原型）。
 * - 鍵：Esc＝取消選區（拖到一半＝取消拖曳）；**不攔 Enter**（Enter＝到着，D-時-104）。←／→／T、6、V 由整合席的鍵表接。
 */
import { memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { MIN, colorSlot, fmtDur, gapTotal, recordedTotal, toSpan, totalsByCategory } from "../../../domain/timetable";
import { CELL_OPTIONS, cellIndexAt, pickCellBlock, rowHoursFor, type RowHours } from "../../../domain/timetableGrid";
import { TT_TEXT, blockMarker, useTimetableStore, type TimetableShell } from "../../../store/timetableStore";
import { useTimetableGridStore, type GridSel } from "../../../store/timetableGridStore";
import { useUiStore } from "../../../store/uiStore";
import { addDays } from "../../../lib/date";
import { DateNav } from "../../common/DateNav";
import { DaySummary } from "../parts/DaySummary";
import { DnTitle } from "../parts/DateNavTitle";
import { SCHED_UI, mdw } from "../schedule/scheduleModel";
import { GridSheet } from "./GridSheet";
import { PaintBar, ReadLine } from "./PaintBar";
import { modeOf, overlayOf, selOf, useCoverText, useGridDay, useSelOverlayStore, type GridDay } from "./gridModel";
import { useGridDrag, type GridDragState } from "./useGridDrag";

/** 方眼列之間的縫（px；＝§M .ns-tt-grid-rows row-gap） */
const ROW_GAP = 2;

const toast = (message: string): void => useUiStore.getState().showToast({ message });

/* ───────── 點一格（D-時-95；照軸 Axis.onBlock 的語義，不換視圖） ───────── */

function tapCell(day: GridDay, ci: number): void {
  const t = Date.now();
  const a = day.gw.start + ci * day.cellMs;
  if (a >= t) {
    toast(TT_TEXT.gridFuture);
    return;
  }
  const hit = pickCellBlock(day.items, { start: a, end: Math.min(a + day.cellMs, day.gw.end, t) });
  const tt = useTimetableStore.getState();
  if (!hit) {
    toast(TT_TEXT.gridNoGap);
    return;
  }
  if (hit.kind === "gap") {
    tt.openSheet({ kind: "fill", start: hit.from, end: hit.to });
    return;
  }
  const row = tt.dayBlocks.find((r) => r.id === hit.span.id);
  const m = row ? blockMarker(row, tt.catById, tt.longRunMaxMin, t, tt.linkInfo) : null;
  if (m && m.kind !== "none" && m.pending) {
    tt.openSheet({ kind: "longRun", blockId: hit.span.id, then: null });
    return;
  }
  // 磨光⑦（D-時-152）：運行中那班也開同一個編輯面板（改分類、出發時間、連結、荷札）
  tt.openSheet({ kind: "edit", blockId: hit.span.id });
}

/* ───────── 頂列 ───────── */

function GridNav({ day, read }: { day: GridDay; read: ReactNode }) {
  const setDayKey = useTimetableStore((s) => s.setDayKey);
  const setCellMin = useTimetableGridStore((s) => s.setCellMin);
  const { dayKey, todayKey, isToday, isDesk } = day;
  // 手機頂列橫向放不下「今天／昨天」小籤（‹ 日期 › ＋今天 chip ＋格子大小，360 寬量過）：日期留星期、小籤只在桌機
  const tag = !isDesk ? null : isToday ? TT_TEXT.schedToday : dayKey === addDays(todayKey, -1) ? SCHED_UI.yesterday : null;
  return (
    <div className="ns-tt-grid-nav">
      {/* UI 丙-4 D9：‹ 日期 › ＋「回到今天」膠囊換共用 DateNav（兩殼都有「今天」chip；手機原本「點日期回今天」的替身退役）。
          動作＝鍵盤 ←／→／T 的同一支 setDayKey；方眼照軸、不記未來 ⇒ 看今天時 › 停用 */}
      <DateNav
        className="ns-tt-dnav"
        title={<DnTitle text={mdw(dayKey)} tag={tag} />}
        onPrev={() => void setDayKey(addDays(dayKey, -1))}
        onNext={() => void setDayKey(addDays(dayKey, 1))}
        nextDisabled={dayKey >= todayKey}
        onToday={() => {
          if (!isToday) void setDayKey(todayKey);
        }}
        isToday={isToday}
      />
      <span className={"ns-tt-grid-read" + (read ? " is-on" : "")} aria-live="polite">
        {read}
      </span>
      <span className="ns-tt-grid-segw">
        <span className="ns-tt-grid-seg" role="group" aria-label={TT_TEXT.gridCellGroup}>
          {CELL_OPTIONS.map((m) => (
            <button
              type="button"
              key={m}
              className={day.cellMin === m ? "is-on" : undefined}
              aria-pressed={day.cellMin === m}
              aria-label={TT_TEXT.gridCell(m)}
              onClick={() => setCellMin(day.shell, m)}
            >
              <span className="ns-tt-num">{m}</span>
            </button>
          ))}
        </span>
        <span className="ns-tt-grid-segu" aria-hidden="true">
          {TT_TEXT.gridCellUnit}
        </span>
      </span>
    </div>
  );
}

/* ───────── 桌機右欄（沒選的時候）：本日合計＋操作說明與圖例 ───────── */

/**
 * 右欄沒選的時候那一份（沙盒 F1）：
 * - memo——拖曳時 GridView 每一步重畫，這裡不跟著重算本日合計；
 * - 掛上的第一輪不畫 DaySummary（`useDeferredValue(true, false)`＝下一輪低優先再畫）：200 塊時它的編成條一項一個節點，
 *   跟方眼擠在同一個 commit 會讓「切到方眼」多 40ms 上下；格子先出來、合計晚一拍補上。之後換日照常同一輪更新。
 */
const DeskSide = memo(function DeskSide({ dayKey }: { dayKey: string }) {
  const ready = useDeferredValue(true, false);
  return (
    <div className="ns-tt-grid-swap">
      {ready && <DaySummary dayKey={dayKey} />}
      <DeskHelp />
    </div>
  );
});

function DeskHelp() {
  const W = TT_TEXT.weekUi;
  return (
    <section className="ns-tt-grid-help">
      <p className="ns-tt-grid-help-t">{TT_TEXT.gridFoot(true)}</p>
      <div className="ns-tt-grid-legendk" aria-hidden="true">
        <span>
          <i className="k-pend" />
          {W.legendPending}
        </span>
        <span>
          <i className="k-live" />
          {W.running}
        </span>
        <span>
          <i className="k-now" />
          {W.legendNow}
        </span>
        <span>
          <i className="k-fut" />
          {TT_TEXT.gridLegendFuture}
        </span>
      </div>
    </section>
  );
}

/* ───────── 手機：格子下一排本日各分類合計（橫捲） ───────── */

function MobileLegend({ day, hidden }: { day: GridDay; hidden: boolean }) {
  const { items, dayBlocks, w, now, catById } = day;
  const rows = useMemo(() => {
    const totals = totalsByCategory(dayBlocks.map(toSpan), w, now);
    return Object.keys(totals)
      .map((id) => ({ id, ms: totals[id] }))
      .filter((r) => r.ms >= MIN)
      .sort((a, b) => b.ms - a.ms || (a.id < b.id ? -1 : 1));
  }, [dayBlocks, w, now]);
  const rec = recordedTotal(items);
  const gap = gapTotal(items);
  return (
    <div className={"ns-tt-grid-legend" + (hidden ? " is-hidden" : "")} aria-hidden={hidden || undefined}>
      <span className="ns-tt-grid-lg is-rec">
        {TT_TEXT.statsRecorded}
        <b className="ns-tt-num">{fmtDur(rec)}</b>
      </span>
      {gap >= MIN && (
        <span className="ns-tt-grid-lg is-gap">
          {TT_TEXT.statsUnrecorded}
          <b className="ns-tt-num">{fmtDur(gap)}</b>
        </span>
      )}
      {rows.map((r) => {
        const cat = catById[r.id] ?? null;
        return (
          <span
            key={r.id}
            className="ns-tt-grid-lg"
            style={{ "--c": `var(--ns-tt-cat-${colorSlot(cat?.color_idx ?? 8)})` } as CSSProperties}
          >
            <i />
            {cat?.name ?? "？"}
            <b className="ns-tt-num">{fmtDur(r.ms)}</b>
          </span>
        );
      })}
    </div>
  );
}

/* ───────── 本體 ───────── */

export interface GridViewProps {
  shell: TimetableShell;
}

export function GridView({ shell }: GridViewProps) {
  const isDesk = shell === "desktop";
  const sel = useTimetableGridStore((s) => s.sel);
  const busy = useTimetableGridStore((s) => s.busy);
  const sheetOpen = useTimetableStore((s) => s.sheet !== null);
  const [rowHours, setRowHours] = useState<RowHours>(1);
  const day = useGridDay(shell, rowHours);
  const rowsRef = useRef<HTMLDivElement>(null);
  const [geo, setGeo] = useState<{ trackPx: number; rowPx: number } | null>(null);
  const [preview, setPreview] = useState<GridSel | null>(null);

  // 格子大小（本機鍵，兩殼各記）；離開方眼時選區不留著
  useEffect(() => {
    void useTimetableGridStore.getState().load(shell);
  }, [shell]);
  useEffect(
    () => () => {
      const g = useTimetableGridStore.getState();
      g.setSel(null);
      g.setDragging(false);
    },
    [],
  );

  // 量格子：軌道寬（色帶放不放字）、列高（太矮縮字）；手機用格子區的總高決定一列 1 或 2 小時（〈原型定案〉4）
  const measure = useCallback((): void => {
    const box = rowsRef.current;
    if (!box) return;
    const tr = box.querySelector<HTMLElement>(".ns-tt-grid-track");
    const h = box.clientHeight;
    setRowHours(rowHoursFor(Math.max(0, h - (24 - 1) * ROW_GAP), shell));
    if (tr) {
      const r = tr.getBoundingClientRect();
      setGeo((g) => (g && Math.abs(g.trackPx - r.width) < 0.5 && Math.abs(g.rowPx - r.height) < 0.5 ? g : { trackPx: r.width, rowPx: r.height }));
    }
  }, [shell]);
  useLayoutEffect(() => {
    measure();
    const box = rowsRef.current;
    if (!box || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(box);
    return () => ro.disconnect();
  }, [measure]);
  useLayoutEffect(() => {
    measure();
  }, [rowHours, day.cellMin, measure]);

  const commit = (d: GridDragState): void => {
    const g = useTimetableGridStore.getState();
    g.setDragging(false);
    setPreview(null);
    const s = selOf(day, d.anchor, d.cur, Date.now());
    if (!s) {
      toast(TT_TEXT.gridFuture);
      return;
    }
    g.setSel(s);
  };
  const { drag, handlers, cancel } = useGridDrag({
    enabled: !busy && !sheetOpen,
    edgeGuard: !isDesk,
    cellsPerRow: day.cpr,
    rowsRef,
    isFutureCell: (ci) => day.gw.start + ci * day.cellMs >= Date.now(),
    nowCell: () => cellIndexAt(day.gw, day.cellMin, Date.now() - 1),
    onTap: (ci) => {
      const g = useTimetableGridStore.getState();
      if (g.sel) {
        g.setSel(null);
        return;
      }
      tapCell(day, ci);
    },
    onDragMove: (d) => {
      useTimetableGridStore.getState().setDragging(true);
      setPreview(selOf(day, d.anchor, d.cur, Date.now()));
    },
    onCommit: commit,
    onAbort: () => {
      useTimetableGridStore.getState().setDragging(false);
      setPreview(null);
    },
    onEdge: () => toast(TT_TEXT.gridEdge),
  });

  // Esc：拖到一半＝取消拖曳；選區開著＝收掉（面板開著時交給面板）。Enter 不攔（＝到着）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape" || e.isComposing) return;
      if (useTimetableStore.getState().sheet !== null) return;
      // 別的對話框開著（捕捉框、設定…）＝交給它：DialogShell 的 Esc 看 defaultPrevented（UI 丙-7 T5），這裡先吃掉它就關不掉
      if (document.querySelector('[aria-modal="true"]')) return;
      const g = useTimetableGridStore.getState();
      if (g.dragging) {
        e.preventDefault();
        cancel();
        return;
      }
      if (g.sel && !g.busy) {
        e.preventDefault();
        g.setSel(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cancel]);

  const hasRunning = day.running !== null;
  const dragSel = drag ? preview : null;
  const dragLive = dragSel ? modeOf(dragSel, hasRunning, day.now) === "live" : false;
  const dragCover = useCoverText(dragSel, dragLive, day.running);
  const selLive = sel ? modeOf(sel, hasRunning, day.now) === "live" : false;
  const overlay = dragSel
    ? overlayOf(day, dragSel, dragLive, day.now)
    : sel && !drag
      ? overlayOf(day, sel, selLive, day.now)
      : null;
  // 選取層（每一列的 RowSel）訂這個小 store；色帶那層（GridSheet）不因拖曳重畫（沙盒 F1）
  useLayoutEffect(() => {
    useSelOverlayStore.setState({ ov: overlay });
  });
  useEffect(() => () => useSelOverlayStore.setState({ ov: null }), []);
  const read = dragSel ? (
    <ReadLine start={dragSel.start} end={dragSel.liveTail ? Math.max(dragSel.end, day.now) : dragSel.end} live={dragLive} cover={dragCover} />
  ) : null;

  const sheet = (
    <GridSheet
      day={day}
      dragging={drag !== null}
      rowsRef={rowsRef}
      handlers={handlers}
      trackPx={geo?.trackPx ?? null}
      rowPx={geo?.rowPx ?? null}
    />
  );

  if (isDesk) {
    return (
      <section className="ns-tt-grid is-desk" aria-label={TT_TEXT.viewGrid}>
        <div className="ns-tt-grid-main">
          <GridNav day={day} read={read} />
          {sheet}
        </div>
        <aside className="ns-tt-grid-side">
          {sel ? (
            <div className="ns-tt-grid-swap" key="pb">
              <PaintBar shell="desktop" sel={sel} />
            </div>
          ) : (
            <DeskSide key="sum" dayKey={day.dayKey} />
          )}
        </aside>
      </section>
    );
  }
  return (
    <div className="ns-tt-grid is-phone" data-no-fab aria-label={TT_TEXT.viewGrid}>
      <GridNav day={day} read={read} />
      {sheet}
      <MobileLegend day={day} hidden={sel !== null} />
    </div>
  );
}

/* ───────── 手機塗色列（.m-page 之外；整合席掛在 .ns-tt-mdock 後面） ───────── */

/** 收起的動畫（＝§M .ns-tt-grid-mbar 的 transition）跑完才拆掉內容 */
const MBAR_CLOSE_MS = 480;

/**
 * 手機的塗色列宿主：`position: fixed` 在 tab bar 之上、從底部彈簧升起，蓋住運行列（〈原型定案〉9）。
 * 量自己的高度寫進 App 根（`[data-shell]`）的 `--ns-tt-grid-mbar-h`，給 Toast 抬高用（§M 的 `.ns-tt-grid-mbar.is-open ~ .techo-card.fixed`）。
 * 必須是 Toast 的前面兄弟節點（MobileTimetable 的 Fragment 本來就是 App 根的直接子節點，同 .ns-tt-mdock）。
 */
export function MobileGridDock() {
  const sel = useTimetableGridStore((s) => s.sel);
  const [shown, setShown] = useState<GridSel | null>(sel);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (sel) {
      setShown(sel);
      return;
    }
    const t = window.setTimeout(() => setShown(null), MBAR_CLOSE_MS);
    return () => window.clearTimeout(t);
  }, [sel]);
  useEffect(() => {
    const el = ref.current;
    const host = el?.closest<HTMLElement>("[data-shell]") ?? null;
    if (!el || !host || typeof ResizeObserver === "undefined") return;
    const put = (): void => host.style.setProperty("--ns-tt-grid-mbar-h", Math.round(el.offsetHeight) + "px");
    put();
    const ro = new ResizeObserver(put);
    ro.observe(el);
    return () => {
      ro.disconnect();
      host.style.removeProperty("--ns-tt-grid-mbar-h");
    };
  }, []);
  const open = sel !== null;
  return (
    <div ref={ref} className={"ns-tt-grid-mbar" + (open ? " is-open" : "")} inert={!open} aria-hidden={!open || undefined}>
      {shown && <PaintBar shell="mobile" sel={sel ?? shown} />}
    </div>
  );
}
