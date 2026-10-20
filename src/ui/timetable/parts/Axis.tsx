/**
 * Axis——運行圖（車次①a 契約 §5.1；乙席）。＝原型 `axisMount`（v-a.js:40-120）。兩殼共用 DOM。
 * section.ns-tt-axis[.is-self|.is-page]：
 *   div.ns-tt-axis-nav（‹、「M 月 D 日（週X）」、「今天」、›；看今天時 › disabled）
 *   ＋ DaySummary ＋ div.ns-tt-sec「運行圖」＋「HH:00 起算」
 *   ＋ 每項一列 div.ns-tt-seg[.is-gap]（.ns-tt-seg-time 開始時刻／.ns-tt-seg-rail 線與站點／.ns-tt-seg-body）
 *       block ⇒ button.ns-tt-blk[.is-live][.is-long][.is-zero]（Badge sm＋名稱＋sub chips＋右側時長）
 *       gap   ⇒ button.ns-tt-hole「未記錄 Xm　補上 ›」（過去某天整天空白 ⇒「這一天沒有紀錄」＋「補上 ›」）
 *   ＋ 看今天時最後一列 div.ns-tt-nowline（時刻＋菱形＋「NOW」）。列高 `axisRowHeight`。
 * 捲動黏底：原本在底部 40px 內就維持黏底（＝原型 v-a.js:89-93）；`scroller="self"`＝本節自己捲、`"page"`＝最近的捲動祖先。
 *
 * 點擊語義（契約 §5.1）：gap ⇒ fill；已結束的塊（含零長度）⇒ 長時間運行未確認時 longRun，否則 edit；
 * 運行中的塊 ⇒ 長時間運行未確認時 longRun，否則 toast 13。
 *
 * 車次①b（①b①c 契約 §5.5）：「待確認」與 chip 一律看 `blockMarker`（門檻＝預估 → 分類預設 → 保險上限）。
 * chip：零長度「時刻待確認」；誤點「誤點 +X」（待確認加「・待確認」）；長時間運行（待確認加「・待確認」）；
 * none 不畫（F3：選了留白／其實在做別的、被切到門檻以下的塊不再掛記號）。運行中那一班有預估、還沒超過 ⇒「預估 1h」（＝原型）。
 * 合併預覽時（BlockPanel 的二次確認開著）那兩塊 `.is-mhl` 描金邊（D-時-33）。
 *
 * 車次②（② 契約 §5.9；乙席；長相＝原型 `v-f.js` axisHtml `.vf-bn`）：每一塊的分類名後接 span.ns-tt-link-bn「・任務名」
 * （`linkLabelOf`；只連路線＝路線名；刪掉＝「（原車票已刪除）」斜體淡字 `.is-gone`）；長的 CSS 省略號。
 * 已結束的塊點了照舊開改一塊面板（裡面有「連到」那一列）；門檻（blockMarker）多一層任務的預計時間。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, type CSSProperties } from "react";
import {
  axisRowHeight,
  colorSlot,
  fmtClock,
  fmtDur,
  msOf,
  segmentsOfDay,
  toSpan,
  type AxisItem,
  type TimeBlockRow,
} from "../../../domain/timetable";
import { linkLabelOf, linkOfRow } from "../../../domain/timetableLink";
import { TT_TEXT, blockMarker, useTimetableStore } from "../../../store/timetableStore";
import { useUiStore } from "../../../store/uiStore";
import { addDays, dayWindow } from "../../../lib/date";
import { CategoryBadge } from "../CategoryBadge";
import { useMergeMarks } from "../panels/controls";
import { DaySummary } from "./DaySummary";
import { useNow } from "../useNow";

export interface AxisProps {
  scroller: "self" | "page";
}

const WEEK_ZH = ["週日", "週一", "週二", "週三", "週四", "週五", "週六"];
const STICK_PX = 40;

/** YYYY-MM-DD → 「M 月 D 日（週X）」（本地日期運算，不經 Date.parse） */
function dayLabel(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return `${m} 月 ${d} 日（${WEEK_ZH[date.getDay()]}）`;
}

const pad2 = (n: number): string => (n < 10 ? "0" + n : String(n));

/** 最近的捲動祖先（overflow-y auto／scroll） */
function scrollParentOf(el: HTMLElement | null): HTMLElement | null {
  let cur = el?.parentElement ?? null;
  while (cur) {
    const oy = getComputedStyle(cur).overflowY;
    if (oy === "auto" || oy === "scroll") return cur;
    cur = cur.parentElement;
  }
  return null;
}

export function Axis({ scroller }: AxisProps) {
  const dayKey = useTimetableStore((s) => s.dayKey);
  const todayKey = useTimetableStore((s) => s.todayKey);
  const dayBlocks = useTimetableStore((s) => s.dayBlocks);
  const catById = useTimetableStore((s) => s.catById);
  const longRunMaxMin = useTimetableStore((s) => s.longRunMaxMin);
  const linkInfo = useTimetableStore((s) => s.linkInfo);
  const setDayKey = useTimetableStore((s) => s.setDayKey);
  const openSheet = useTimetableStore((s) => s.openSheet);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const now = useNow(1000);
  const mergeMarks = useMergeMarks();

  const isToday = dayKey === todayKey;
  const w = useMemo(() => {
    const dw = dayWindow(dayKey, dayStartHour);
    return { start: msOf(dw.start), end: msOf(dw.end) };
  }, [dayKey, dayStartHour]);
  const rowsById = useMemo(() => {
    const m: Record<string, TimeBlockRow> = {};
    for (const r of dayBlocks) m[r.id] = r;
    return m;
  }, [dayBlocks]);
  const items = useMemo(() => segmentsOfDay(dayBlocks.map(toSpan), w, now), [dayBlocks, w, now]);
  /** 過去某天、整天一個 gap ⇒「這一天沒有紀錄」 */
  const emptyPastDay = !isToday && items.length === 1 && items[0].kind === "gap" && dayBlocks.length === 0;

  /* ── 捲動黏底 ── */
  const ref = useRef<HTMLElement>(null);
  const stick = useRef(true);
  const scrollerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const el = scroller === "self" ? ref.current : scrollParentOf(ref.current);
    scrollerRef.current = el;
    if (!el) return;
    const onScroll = (): void => {
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [scroller]);
  // 換天：看今天 ⇒ 重新黏底；看過去 ⇒ 回頂端
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    stick.current = isToday;
    if (el && !isToday) el.scrollTop = 0;
  }, [dayKey, isToday]);
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  /* ── 點擊 ── */
  const onBlock = (it: Extract<AxisItem, { kind: "block" }>): void => {
    const row = rowsById[it.span.id];
    const m = row ? blockMarker(row, catById, longRunMaxMin, now, linkInfo) : null;
    const long = !!m && m.kind !== "none" && m.pending;
    if (long) {
      openSheet({ kind: "longRun", blockId: it.span.id, then: null });
      return;
    }
    if (it.running) {
      useUiStore.getState().showToast({ message: TT_TEXT.runningHint });
      return;
    }
    openSheet({ kind: "edit", blockId: it.span.id });
  };

  return (
    <section ref={ref} className={"ns-tt-axis is-" + scroller} aria-label="運行圖">
      <div className="ns-tt-axis-nav">
        <button type="button" className="ns-tt-axis-arrow" aria-label="前一天" onClick={() => void setDayKey(addDays(dayKey, -1))}>
          ‹
        </button>
        <span className="ns-tt-axis-date">{dayLabel(dayKey)}</span>
        <button type="button" className="ns-tt-axis-today" disabled={isToday} onClick={() => void setDayKey(todayKey)}>
          今天
        </button>
        <button type="button" className="ns-tt-axis-arrow" aria-label="後一天" disabled={isToday} onClick={() => void setDayKey(addDays(dayKey, 1))}>
          ›
        </button>
      </div>

      <DaySummary dayKey={dayKey} />

      <div className="ns-tt-sec">
        <h3>運行圖</h3>
        <span className="ns-tt-sec-rule" />
        <span className="ns-tt-sec-note">{pad2(dayStartHour)}:00 起算</span>
      </div>

      {items.map((it, i) => {
        const dur = Math.max(0, it.to - it.from);
        if (it.kind === "gap") {
          const h = Math.max(52, axisRowHeight(dur) - 10);
          return (
            <div className="ns-tt-seg is-gap" key={"g" + i} style={{ minHeight: h }}>
              <div className="ns-tt-seg-time ns-tt-num">{fmtClock(it.from)}</div>
              <div className="ns-tt-seg-rail" />
              <div className="ns-tt-seg-body">
                <button type="button" className="ns-tt-hole" onClick={() => openSheet({ kind: "fill", start: it.from, end: it.to })}>
                  {emptyPastDay ? (
                    <span>這天沒有紀錄</span>
                  ) : (
                    <span>
                      未記錄 <span className="ns-tt-num">{fmtDur(dur)}</span>
                    </span>
                  )}
                  <span className="ns-tt-hole-go">補記 ›</span>
                </button>
              </div>
            </div>
          );
        }
        const row = rowsById[it.span.id];
        const cat = catById[it.span.categoryId] ?? null;
        const m = row ? blockMarker(row, catById, longRunMaxMin, now, linkInfo) : ({ kind: "none" } as const);
        const long = m.kind !== "none" && m.pending;
        const est = it.running && row ? row.estimate_min : null;
        const label = row ? linkLabelOf(row, linkInfo) : null;
        const lk = row ? linkOfRow(row) : null;
        const lkInfo = lk ? linkInfo[lk.nodeId ?? lk.routeId ?? ""] : undefined;
        const gone = !!lkInfo && (lkInfo.deleted || lkInfo.missing);
        const style = { "--c": `var(--ns-tt-cat-${colorSlot(cat?.color_idx ?? 8)})`, minHeight: axisRowHeight(dur) } as CSSProperties;
        const cls =
          "ns-tt-blk" +
          (it.running ? " is-live" : "") +
          (long ? " is-long" : "") +
          (it.zero ? " is-zero" : "") +
          (mergeMarks.includes(it.span.id) ? " is-mhl" : "");
        return (
          <div className="ns-tt-seg" key={it.span.id + ":" + it.from} style={style}>
            <div className="ns-tt-seg-time ns-tt-num">{fmtClock(it.from)}</div>
            <div className="ns-tt-seg-rail" />
            <div className="ns-tt-seg-body">
              <button type="button" className={cls} onClick={() => onBlock(it)}>
                <CategoryBadge cat={cat} size="sm" />
                <span className="ns-tt-blk-main">
                  <span className={"ns-tt-blk-name" + (label !== null ? " ns-tt-link-has" : "")}>
                    {label === null ? (
                      (cat?.name ?? "？")
                    ) : (
                      <>
                        <span className="ns-tt-link-bn-cat">{cat?.name ?? "？"}</span>
                        <span className={"ns-tt-link-bn" + (gone ? " is-gone" : "")}>・{label}</span>
                      </>
                    )}
                  </span>
                  <span className="ns-tt-blk-sub">
                    {it.running && (
                      <>
                        <span className="ns-tt-live-dot" aria-hidden="true" />
                        <span>運行中</span>
                      </>
                    )}
                    {it.contFromPrev && <span className="ns-tt-chip">續・{fmtClock(it.span.start)} 発</span>}
                    {/* 跨日界線往後一天延伸（沙盒回報 D2，調度裁定兩天都標「續」）：已結束的寫真實到着時刻；
                        運行中的沒有結束時刻，只標「續 ›」 */}
                    {it.contToNext && (
                      <span className="ns-tt-chip">{it.span.end === null ? "續 ›" : `續・${fmtClock(it.span.end)} 着`}</span>
                    )}
                    {it.zero ? (
                      <span className="ns-tt-chip is-late">時刻待確認</span>
                    ) : m.kind === "late" ? (
                      <span className="ns-tt-chip is-late">{m.pending ? TT_TEXT.latePending(m.overMs) : TT_TEXT.late(m.overMs)}</span>
                    ) : m.kind === "long" ? (
                      <span className={"ns-tt-chip" + (m.pending ? " is-late" : "")}>{m.pending ? "長時間運行・待確認" : "長時間運行"}</span>
                    ) : est !== null ? (
                      <span className="ns-tt-chip is-solid">{TT_TEXT.estimateChip(est)}</span>
                    ) : null}
                  </span>
                </span>
                <span className="ns-tt-blk-dur ns-tt-num">{fmtDur(dur)}</span>
              </button>
            </div>
          </div>
        );
      })}

      {isToday && (
        <div className="ns-tt-nowline" aria-hidden="true">
          <span className="ns-tt-nowline-t ns-tt-num">{fmtClock(now)}</span>
          <span className="ns-tt-nowline-d" />
          <span className="ns-tt-nowline-r">
            <span>NOW</span>
          </span>
        </div>
      )}
    </section>
  );
}
