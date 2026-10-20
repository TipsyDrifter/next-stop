/**
 * gridModel——方眼兩殼共用的資料整理與小工具（⑤ 契約 0-3、0-4、§5.2、§5.3；乙席）。
 *
 * - 一天的資料只讀 `timetableStore`（dayKey／dayBlocks／running…，與軸、④ 日程共用）；格子大小與選區讀 `timetableGridStore`。
 *   幾何全部走 `domain/timetableGrid.ts` 的純函式（不另寫一份）。
 * - 「現在」＝`useNow(60_000)`（同週視圖）；拖曳與點分類的當下另外用 `Date.now()` 夾。
 * - 讀數的「會蓋掉幾塊」走 store 的 `previewCover`（契約 0-5；不另寫）；`rev` 也算進依賴——選區開著時同步進來，赭字跟著更新（沙盒 S2）。
 */
import { useEffect, useMemo, useState } from "react";
import { create } from "zustand";
import { MIN, fmtClock, msOf, segmentsOfDay, toSpan, type AxisItem } from "../../../domain/timetable";
import {
  cellRange,
  clampSel,
  gridWindow,
  paintModeOf,
  rowRuns,
  snapEdges,
  type CellMin,
  type GridWindow,
  type Range,
  type RowHours,
  type RowRun,
} from "../../../domain/timetableGrid";
import { TT_TEXT, blockMarker, useTimetableStore, type TimetableShell } from "../../../store/timetableStore";
import { useTimetableGridStore, type GridSel } from "../../../store/timetableGridStore";
import { useUiStore } from "../../../store/uiStore";
import { dayWindow } from "../../../lib/date";
import type { TimeBlockRow, TimeCategoryRow } from "../../../domain/timetable";
import { useNow } from "../useNow";

export const HOUR = 60 * MIN;
export const pad2 = (n: number): string => (n < 10 ? "0" + n : String(n));
export const pct = (x: number): string => (Math.max(0, Math.min(1, x)) * 100).toFixed(3) + "%";

export interface GridDay {
  shell: TimetableShell;
  isDesk: boolean;
  dayKey: string;
  todayKey: string;
  isToday: boolean;
  now: number;
  /** 窗（毫秒） */
  w: Range;
  gw: GridWindow;
  cellMin: CellMin;
  cellMs: number;
  /** 一列幾格 */
  cpr: number;
  items: AxisItem[];
  runs: RowRun[];
  /** 待確認的塊（每列叫 blockMarker；方眼不載統計 store 的 pendingIds） */
  pending: Set<string>;
  /** blockId → 開始（ms；head 段的起點時刻用） */
  startOf: Record<string, number>;
  running: TimeBlockRow | null;
  catById: Record<string, TimeCategoryRow>;
  dayBlocks: TimeBlockRow[];
}

export function useGridDay(shell: TimetableShell, rowHours: RowHours): GridDay {
  const dayKey = useTimetableStore((s) => s.dayKey);
  const todayKey = useTimetableStore((s) => s.todayKey);
  const dayBlocks = useTimetableStore((s) => s.dayBlocks);
  const running = useTimetableStore((s) => s.running);
  const catById = useTimetableStore((s) => s.catById);
  const longRunMaxMin = useTimetableStore((s) => s.longRunMaxMin);
  const linkInfo = useTimetableStore((s) => s.linkInfo);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const cellMin = useTimetableGridStore((s) => s.cellMin);
  const now = useNow(60_000);

  const w = useMemo(() => {
    const dw = dayWindow(dayKey, dayStartHour);
    return { start: msOf(dw.start), end: msOf(dw.end) };
  }, [dayKey, dayStartHour]);
  const gw = useMemo(() => gridWindow(w, rowHours), [w, rowHours]);
  const spans = useMemo(() => dayBlocks.map(toSpan), [dayBlocks]);
  const items = useMemo(() => segmentsOfDay(spans, w, now), [spans, w, now]);
  const runs = useMemo(() => rowRuns(items, gw, now), [items, gw, now]);
  const pending = useMemo(() => {
    const s = new Set<string>();
    for (const b of dayBlocks) {
      const m = blockMarker(b, catById, longRunMaxMin, now, linkInfo);
      if (m.kind !== "none" && m.pending) s.add(b.id);
    }
    return s;
  }, [dayBlocks, catById, longRunMaxMin, now, linkInfo]);
  const startOf = useMemo(() => {
    const o: Record<string, number> = {};
    for (const b of dayBlocks) o[b.id] = msOf(b.started_at);
    return o;
  }, [dayBlocks]);

  // 整包 memo：GridSheet 是 memo 元件、拿 day 當 prop——拖曳時 GridView 每一步都重畫，day 不變色帶那層就不重畫（沙盒 F1）
  return useMemo(() => {
    const cellMs = cellMin * MIN;
    return {
      shell,
      isDesk: shell === "desktop",
      dayKey,
      todayKey,
      isToday: dayKey === todayKey,
      now,
      w,
      gw,
      cellMin,
      cellMs,
      cpr: Math.max(1, Math.round(gw.rowMs / cellMs)),
      items,
      runs,
      pending,
      startOf,
      running,
      catById,
      dayBlocks,
    };
  }, [shell, dayKey, todayKey, now, w, gw, cellMin, items, runs, pending, startOf, running, catById, dayBlocks]);
}

/** 格邊界（從窗頭起算）：往下取／往上取 */
export function floorCell(gw: GridWindow, cellMs: number, t: number): number {
  return gw.start + Math.floor((t - gw.start) / cellMs) * cellMs;
}
export function ceilCell(gw: GridWindow, cellMs: number, t: number): number {
  return Math.min(gw.end, gw.start + Math.ceil((t - gw.start) / cellMs) * cellMs);
}

/**
 * 兩格 ⇒ 選區（契約 0-4；〈原型定案〉1、8）：cellRange → clampSel → snapEdges；`liveTail`＝拖到的尾格含現在。
 * liveTail 時 end 先記放開那一刻的 now（點分類時才重算）；尾不貼齊（尾就是現在）。
 */
export function selOf(
  day: Pick<GridDay, "gw" | "cellMin" | "cellMs" | "items">,
  anchor: number,
  cur: number,
  now: number,
): GridSel | null {
  const raw = cellRange(day.gw, day.cellMin, anchor, cur);
  const c = clampSel(raw, day.gw, now);
  if (!c) return null;
  const s = snapEdges(c, day.items, day.cellMs);
  const liveTail = raw.end > now;
  return { start: s.start, end: liveTail ? c.end : s.end, liveTail };
}

/** 選區畫在格子上的兩層：虛線＝拖到的格子（還原成格邊界）；實心金＝真正會寫的那段（live 畫到 now） */
export interface SelOverlay {
  raw: Range;
  solid: Range;
  live: boolean;
}
export function overlayOf(day: Pick<GridDay, "gw" | "cellMs">, sel: GridSel, live: boolean, now: number): SelOverlay {
  const end = sel.liveTail ? Math.max(sel.end, now) : sel.end;
  return {
    raw: { start: floorCell(day.gw, day.cellMs, sel.start), end: ceilCell(day.gw, day.cellMs, sel.liveTail ? Math.max(end, now) : sel.end) },
    solid: { start: sel.start, end: live ? Math.max(end, now) : end },
    live,
  };
}

/**
 * 選取層的小 store（沙盒 F1）：GridView 每次重畫把這一刻的 overlay（拖曳中＝預覽；放開後＝sel）放進來，
 * 每一列的 `RowSel` 只訂自己那一列切出來的字串（`rowSelKey`）——拖一步只有選區碰到的那幾列重畫，色帶那層（GridSheet）不動。
 */
export const useSelOverlayStore = create<{ ov: SelOverlay | null }>(() => ({ ov: null }));

/** 一列 [rs, re) 裡選區的兩段（虛線、實心金），編成字串給 selector 比較；這一列沒有選區＝"" */
export function rowSelKey(ov: SelOverlay | null, rs: number, re: number): string {
  if (!ov) return "";
  const L = re - rs;
  const piece = (a: number, b: number): string => {
    const s = Math.max(a, rs);
    const e = Math.min(b, re);
    return e > s ? pct((s - rs) / L) + "," + pct((e - s) / L) : "";
  };
  const raw = piece(ov.raw.start, ov.raw.end);
  const solid = piece(ov.solid.start, ov.solid.end);
  return raw || solid ? raw + "|" + solid + "|" + (ov.live ? "1" : "") : "";
}

/** 選區此刻的模式（點分類的那一刻再算一次；這裡給畫面用） */
export function modeOf(sel: GridSel, hasRunning: boolean, now: number): "fill" | "live" {
  return paintModeOf({ start: sel.start, end: sel.liveTail ? now : sel.end }, hasRunning, now);
}

/** 貼齊說明「貼齊空白：頭 14:00→14:07、尾 15:00→14:52」；沒貼齊＝null（〈原型定案〉1） */
export function snapNoteOf(day: Pick<GridDay, "gw" | "cellMs">, sel: GridSel): string | null {
  const parts: string[] = [];
  const cs = floorCell(day.gw, day.cellMs, sel.start);
  if (cs !== sel.start) parts.push(TT_TEXT.gridSnapHead(fmtClock(cs), fmtClock(sel.start)));
  if (!sel.liveTail) {
    const ce = ceilCell(day.gw, day.cellMs, sel.end);
    if (ce !== sel.end) parts.push(TT_TEXT.gridSnapTail(fmtClock(ce), fmtClock(sel.end)));
  }
  return parts.length ? TT_TEXT.gridSnap(parts) : null;
}

/**
 * 讀數的赭字（`TT_TEXT.cover`；沒蓋到＝""）。live：end＝null，運行中那班**一律**當 exceptId——它的結局另在塗色列的
 * `pb-same` 那一行講（同分類＝提早出發／本來就是；別的分類＝在選區頭到站／整班收掉；沙盒 F2）。〈原型定案〉7：換車本身不算。
 * store 的 toast 副標照同一個口徑扣掉運行中那班（`paintCoverSubOf`）。range 為 null ⇒ 不問。
 */
export function useCoverText(range: Range | null, live: boolean, running: TimeBlockRow | null): string {
  const previewCover = useTimetableStore((s) => s.previewCover);
  const rev = useTimetableStore((s) => s.rev);
  const [text, setText] = useState("");
  const start = range?.start ?? null;
  const end = range === null ? null : live ? null : range.end;
  const exceptId = live && running ? running.id : null;
  useEffect(() => {
    if (start === null) {
      setText("");
      return;
    }
    let alive = true;
    previewCover(start, end, exceptId)
      .then((sum) => {
        if (alive) setText(TT_TEXT.cover(sum));
      })
      .catch(() => {
        if (alive) setText("");
      });
    return () => {
      alive = false;
    };
  }, [previewCover, start, end, exceptId, rev]);
  return text;
}
