/**
 * DaySummary——軸頂端的本日合計（車次①a 契約 §5.1；乙席）。＝原型 v-a.js:49-61（day 卡＋編成條＋本週各頂層合計）。
 * section.ns-tt-day：
 *   div.ns-tt-day-top（「本日已記錄」大字＋右側「未記錄 Xh」赭字或「沒有空白」；看今天且剛過日界線一小時內多一顆「昨日 ›」）
 *   div.ns-tt-consist（編成條：每項一個 i，flex: 時長；gap 為 .is-gap 赭斜紋）
 *   div.ns-tt-day-cats（今日各分類合計，依時長遞減，最多 8 個、其餘併「其他」）
 *   div.ns-tt-day-week（三個頂層組＋右側「本週」）
 * 讀的是 store 的 `dayBlocks`（Axis 把 `store.dayKey` 傳進來，兩者對應同一天）；本週讀 `weekBlocks`。
 */
import { useMemo, type CSSProperties } from "react";
import {
  MIN,
  colorSlot,
  fmtDur,
  gapTotal,
  groupedCategories,
  msOf,
  recordedTotal,
  segmentsOfDay,
  toSpan,
  totalsByCategory,
  totalsByGroup,
  weekStartKey,
} from "../../../domain/timetable";
import { useTimetableStore, yesterdayKey } from "../../../store/timetableStore";
import { useUiStore } from "../../../store/uiStore";
import { dayWindow } from "../../../lib/date";
import { CategoryBadge } from "../CategoryBadge";
import { useNow } from "../useNow";

export interface DaySummaryProps {
  dayKey: string;
}

const MAX_CATS = 8;

export function DaySummary({ dayKey }: DaySummaryProps) {
  const dayBlocks = useTimetableStore((s) => s.dayBlocks);
  const weekBlocks = useTimetableStore((s) => s.weekBlocks);
  const todayKey = useTimetableStore((s) => s.todayKey);
  const categories = useTimetableStore((s) => s.categories);
  const catById = useTimetableStore((s) => s.catById);
  const setDayKey = useTimetableStore((s) => s.setDayKey);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const now = useNow(1000);

  const w = useMemo(() => {
    const dw = dayWindow(dayKey, dayStartHour);
    return { start: msOf(dw.start), end: msOf(dw.end) };
  }, [dayKey, dayStartHour]);

  const spans = useMemo(() => dayBlocks.map(toSpan), [dayBlocks]);
  const items = useMemo(() => segmentsOfDay(spans, w, now), [spans, w, now]);
  const recorded = recordedTotal(items);
  const gap = gapTotal(items);

  /** 今日各分類合計（遞減；超過 8 個併「其他」） */
  const catRows = useMemo(() => {
    const totals = totalsByCategory(spans, w, now);
    const rows = Object.keys(totals)
      .map((id) => ({ id, ms: totals[id] }))
      .filter((r) => r.ms > 0)
      .sort((a, b) => b.ms - a.ms || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (rows.length <= MAX_CATS) return { rows, other: 0 };
    const head = rows.slice(0, MAX_CATS);
    const other = rows.slice(MAX_CATS).reduce((s, r) => s + r.ms, 0);
    return { rows: head, other };
  }, [spans, w, now]);

  /** 本週（週一的日界線起到今天為止）各頂層組合計 */
  const weekRows = useMemo(() => {
    const ws = dayWindow(weekStartKey(todayKey), dayStartHour);
    const te = dayWindow(todayKey, dayStartHour);
    const totals = totalsByCategory(weekBlocks.map(toSpan), { start: msOf(ws.start), end: msOf(te.end) }, now);
    const byGroup = totalsByGroup(totals, categories);
    return groupedCategories(categories).map(({ group }) => ({ id: group.id, name: group.name, ms: byGroup[group.id] ?? 0 }));
  }, [weekBlocks, todayKey, dayStartHour, categories, now]);

  const isToday = dayKey === todayKey;
  const showYesterday = isToday && now - w.start < 60 * MIN;

  return (
    <section className="ns-tt-day" aria-label="本日合計">
      <div className="ns-tt-day-top">
        <div>
          <div className="ns-tt-day-lbl">本日已記錄</div>
          <div className="ns-tt-day-big ns-tt-num">{fmtDur(recorded)}</div>
        </div>
        <div className="ns-tt-day-right">
          {gap >= MIN ? (
            <div className="ns-tt-day-gap">
              未記錄 <span className="ns-tt-num">{fmtDur(gap)}</span>
            </div>
          ) : (
            <div className="ns-tt-day-lbl">沒有空白</div>
          )}
          {showYesterday && (
            <button type="button" className="ns-tt-yday" onClick={() => void setDayKey(yesterdayKey(dayKey))}>
              昨日 ›
            </button>
          )}
        </div>
      </div>

      <div className="ns-tt-consist" aria-hidden="true">
        {items.map((it, i) => {
          const d = Math.max(0, (it.to - it.from) / MIN);
          if (it.kind === "gap") return <i key={"g" + i} className="is-gap" style={{ flex: d }} />;
          if (it.zero) return null;
          const cat = catById[it.span.categoryId];
          const style = { flex: d, "--c": `var(--ns-tt-cat-${colorSlot(cat?.color_idx ?? 8)})` } as CSSProperties;
          return <i key={it.span.id + ":" + it.from} style={style} />;
        })}
      </div>

      {catRows.rows.length > 0 && (
        <div className="ns-tt-day-cats">
          {catRows.rows.map((r) => (
            <span
              className="ns-tt-day-cat"
              key={r.id}
              title={catById[r.id]?.name ?? "？"}
              aria-label={`${catById[r.id]?.name ?? "？"} ${fmtDur(r.ms)}`}
            >
              <CategoryBadge cat={catById[r.id] ?? null} size="sm" />
              <span className="ns-tt-num" aria-hidden="true">
                {fmtDur(r.ms)}
              </span>
            </span>
          ))}
          {catRows.other > 0 && (
            <span className="ns-tt-day-cat is-other">
              <span className="ns-tt-day-lbl">其他</span>
              <span className="ns-tt-num">{fmtDur(catRows.other)}</span>
            </span>
          )}
        </div>
      )}

      <div className="ns-tt-day-week">
        {weekRows.map((g) => (
          <span key={g.id}>
            <span className="ns-tt-day-lbl">{g.name}</span> <span className="ns-tt-num">{fmtDur(g.ms)}</span>
          </span>
        ))}
        <span className="ns-tt-day-lbl is-end">本週</span>
      </div>
    </section>
  );
}
