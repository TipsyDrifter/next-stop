/**
 * ReportHistorySections——運行報告的「溫柔回顧提示」、「路線實績排行卡」與「已完成車票歷史明細流」（v1.33 3A-2 ＋ 3A-3 G6）。
 *
 *   - `GentleReviewBanner`：月底回顧／年底回顧／車站預計到站前提醒（支援「前往回顧 ›」與「本期已知悉」不重複打擾）
 *   - `RouteRankSection`：統計區間內各路線的「蓋済車票數 · 投入時數 · 相關支出」排行（支援切換排序基準、路線圓牌與色票橫條）
 *   - `CompletedHistorySection`：全站已完成車票歷史總表——依營業日倒序分組（含一般車票與定期券各回班次），支援即時關鍵字過濾與點擊定位
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { NodeRow } from "../../domain";
import {
  filterCompletedGroups,
  formatReportMoney,
  sortRouteRanks,
  type OperationReport,
  type RouteRankSort,
} from "../../domain/report";
import { fmtDur } from "../../domain/timetable";
import { useReminderStore } from "../../store/reminderStore";
import { useReportStore } from "../../store/reportStore";
import { useTagStore } from "../../store/tagStore";
import { IconChevron, IconClose, IconSearch } from "../common/icons";
import { Segmented, type SegmentedOption } from "../common/Segmented";
import { openReminderTarget } from "../reminders/openReminderTarget";
import { useActiveGentleReviews } from "../reminders/ReminderSettingsBody";
import { SealDone } from "../stamps";
import { RouteBadge } from "./ReportParts";
import { goNode, goRoute, type ReportShellKind } from "./reportJumps";

const WEEK_ZH = "日一二三四五六";
const HISTORY_PAGE_SIZE = 60;

function fmtDayTitle(day: string): { md: string; wd: string } {
  const [y, m, d] = day.split("-").map(Number);
  return {
    md: `${m}/${d}`,
    wd: WEEK_ZH[new Date(y, m - 1, d).getDay()],
  };
}

/* ═══════════ 3A-3 G6：溫柔回顧提醒橫幅 ═══════════ */

export function GentleReviewBanner({ shell }: { shell: ReportShellKind }) {
  const prompts = useActiveGentleReviews();
  const acknowledgePrompt = useReminderStore((s) => s.acknowledgePrompt);

  if (prompts.length === 0) return null;

  return (
    <div className="ns-rp-reviews" role="region" aria-label="回顧提醒">
      {prompts.map((p) => (
        <div key={p.key} className="ns-rp-review-card">
          <div className="ns-rp-review-txt">
            <span className="ns-rp-review-title">{p.title}</span>
            <span className="ns-rp-review-sub">{p.body}</span>
          </div>
          <div className="ns-rp-review-acts">
            <button
              type="button"
              className="ns-btn btn-text ns-btn--sm"
              onClick={() => void acknowledgePrompt(p.key)}
            >
              本期已知悉
            </button>
            <button
              type="button"
              className="ns-btn btn-ghost ns-btn--sm"
              onClick={() => void openReminderTarget(p.target, shell)}
            >
              前往回顧 ›
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ═══════════ 3A-2：路線實績排行卡 ═══════════ */

export function RouteRankSection({
  r,
  shell,
  masked = false,
}: {
  r: OperationReport;
  shell: ReportShellKind;
  masked?: boolean;
}) {
  const rankSort = useReportStore((s) => s.rankSort);
  const setRankSort = useReportStore((s) => s.setRankSort);

  const sortOptions = useMemo<SegmentedOption<RouteRankSort>[]>(() => {
    const opts: SegmentedOption<RouteRankSort>[] = [{ value: "seals", label: "車票済" }];
    if (r.time !== null) opts.push({ value: "time", label: "投入時數" });
    if (r.money !== null) opts.push({ value: "money", label: "相關支出" });
    return opts;
  }, [r.time, r.money]);

  const effectiveSort: RouteRankSort = sortOptions.some((o) => o.value === rankSort) ? rankSort : "seals";
  const sorted = useMemo(() => sortRouteRanks(r.routeRanks, effectiveSort), [r.routeRanks, effectiveSort]);

  const maxVal = useMemo(() => {
    let m = 0;
    for (const row of sorted) {
      const v =
        effectiveSort === "time"
          ? row.timeMs ?? 0
          : effectiveSort === "money"
            ? row.spent ?? 0
            : row.seals;
      if (v > m) m = v;
    }
    return m;
  }, [sorted, effectiveSort]);

  const dec = r.money?.decimals ?? 0;

  return (
    <section className="ns-rp-block" aria-label="路線實績排行">
      <div className="sec ns-rp-sec">
        <h3>路線實績排行</h3>
        <span className="ns-rp-sec-sub">{r.range.label}</span>
        <span className="rule" />
        {sortOptions.length > 1 && (
          <Segmented
            options={sortOptions}
            value={effectiveSort}
            onChange={setRankSort}
            compact
            aria-label="路線排行排序基準"
            className="ns-rp-rank-seg"
          />
        )}
      </div>

      <div className="ns-rp-ranks">
        {sorted.length === 0 ? (
          <p className="ns-rp-empty">這段期間尚無各路線的運行紀錄</p>
        ) : (
          <ul className="ns-rp-rank-list">
            {sorted.map((row, idx) => {
              const val =
                effectiveSort === "time"
                  ? row.timeMs ?? 0
                  : effectiveSort === "money"
                    ? row.spent ?? 0
                    : row.seals;
              const hideMoneyBar = effectiveSort === "money" && masked;
              const ratio = !hideMoneyBar && maxVal > 0 ? Math.max(0, Math.min(1, val / maxVal)) : 0;
              const barColor = row.color ?? "var(--stamp-ink)";

              const inner = (
                <>
                  <span className="rk-idx">{idx + 1}</span>
                  <RouteBadge
                    route={row.routeId ? { name: row.name, code: row.code, color: row.color } : null}
                    temp={row.routeId === null}
                  />
                  <span className="rk-main">
                    <span className="rk-head">
                      <span className="rk-nm">{row.name}</span>
                      {row.inDepot && <span className="rk-depot">車庫</span>}
                    </span>
                    <span className="rk-bar" aria-hidden="true">
                      <i
                        style={
                          {
                            "--w": ratio.toFixed(3),
                            "--rk-c": barColor,
                          } as CSSProperties
                        }
                      />
                    </span>
                  </span>
                  <span className="rk-metrics">
                    <span className={"rk-m" + (effectiveSort === "seals" ? " is-active" : "")}>
                      <b className="num">{row.seals}</b>
                      <small>済</small>
                    </span>
                    {row.timeMs !== null && (
                      <span className={"rk-m" + (effectiveSort === "time" ? " is-active" : "")}>
                        <b className="num">{fmtDur(row.timeMs)}</b>
                      </span>
                    )}
                    {row.spent !== null && (
                      <span className={"rk-m" + (effectiveSort === "money" ? " is-active" : "")}>
                        <b className="amt">{formatReportMoney(row.spent, dec, masked)}</b>
                      </span>
                    )}
                  </span>
                </>
              );

              return (
                <li key={row.routeId ?? "__temp"}>
                  {row.routeId ? (
                    <button
                      type="button"
                      className="ns-rp-rank-row is-link"
                      onClick={() => void goRoute(row.routeId!, shell)}
                    >
                      {inner}
                    </button>
                  ) : (
                    <div className="ns-rp-rank-row">{inner}</div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

/* ═══════════ 3A-2：已完成車票歷史明細流 ═══════════ */

export function CompletedHistorySection({
  r,
  shell,
  routes,
  onOpenDay,
}: {
  r: OperationReport;
  shell: ReportShellKind;
  routes: Readonly<Record<string, NodeRow>>;
  onOpenDay?: (day: string) => void;
}) {
  const historyQuery = useReportStore((s) => s.historyQuery);
  const setHistoryQuery = useReportStore((s) => s.setHistoryQuery);
  const tagIndex = useTagStore((s) => s.index);

  const [limit, setLimit] = useState(HISTORY_PAGE_SIZE);
  const composingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setLimit(HISTORY_PAGE_SIZE);
  }, [r.range.from, r.range.to, historyQuery]);

  const tagDisplayName = useMemo(
    () => (key: string) => tagIndex?.byKey[key]?.name ?? key,
    [tagIndex],
  );

  const filtered = useMemo(
    () => filterCompletedGroups(r.completedGroups, historyQuery, routes, tagDisplayName),
    [r.completedGroups, historyQuery, routes, tagDisplayName],
  );

  // 依頁數上限截取顯示群組，避免長區間上百筆一次掛載過重
  const pagedGroups = useMemo(() => {
    let rem = limit;
    const out: typeof filtered.groups = [];
    for (const g of filtered.groups) {
      if (rem <= 0) break;
      if (g.items.length <= rem) {
        out.push(g);
        rem -= g.items.length;
      } else {
        out.push({ ...g, items: g.items.slice(0, rem) });
        rem = 0;
      }
    }
    return out;
  }, [filtered.groups, limit]);

  const shownCount = useMemo(
    () => pagedGroups.reduce((acc, g) => acc + g.items.length, 0),
    [pagedGroups],
  );
  const remaining = Math.max(0, filtered.total - shownCount);

  return (
    <section className="ns-rp-block" aria-label="已完成車票歷史明細">
      <div className="sec ns-rp-sec ns-rp-hist-sec">
        <h3>已完成車票明細</h3>
        <span className="ns-rp-sec-sub">
          {r.range.label} · 共 <b>{filtered.total}</b> 張済
        </span>
        <span className="rule" />
        <div className="ns-rp-hist-search">
          <IconSearch size={14} />
          <input
            ref={inputRef}
            type="search"
            className="techo-input"
            placeholder="篩選車票名、路線或 #荷札…"
            aria-label="篩選已完成車票"
            defaultValue={historyQuery}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={(e) => {
              composingRef.current = false;
              setHistoryQuery(e.currentTarget.value);
            }}
            onChange={(e) => {
              if (!composingRef.current) setHistoryQuery(e.currentTarget.value);
            }}
          />
          {historyQuery && (
            <button
              type="button"
              className="ns-rp-hist-clear"
              aria-label="清除關鍵字"
              title="清除關鍵字"
              onClick={() => {
                setHistoryQuery("");
                if (inputRef.current) inputRef.current.value = "";
              }}
            >
              <IconClose size={12} />
            </button>
          )}
        </div>
      </div>

      <div className="ns-rp-hist">
        {filtered.total === 0 ? (
          <p className="ns-rp-empty">
            {historyQuery.trim()
              ? `找不到符合「${historyQuery.trim()}」的蓋済車票`
              : "這段期間還沒有蓋上「済」的車票紀錄"}
          </p>
        ) : (
          <>
            {pagedGroups.map((g) => {
              const { md, wd } = fmtDayTitle(g.day);
              return (
                <div key={g.day} className="ns-rp-hist-day">
                  <button
                    type="button"
                    className="ns-rp-hist-dhead is-btn"
                    onClick={() => onOpenDay?.(g.day)}
                    aria-label={`開啟 ${md}（週${wd}）一日運行專頁`}
                  >
                    <span className="d">
                      <b>{md}</b>
                      <small>（週{wd}）</small>
                    </span>
                    {g.isToday && <span className="today">今天</span>}
                    <span className="cnt">
                      {g.items.length} 張済
                      <SealDone small className="ns-rp-hist-seal" />
                      <IconChevron size={11} className="ns-rp-hist-go" />
                    </span>
                  </button>
                  <ul className="ns-rp-hist-list">
                    {g.items.map((it) => {
                      const route = it.routeId ? routes[it.routeId] ?? null : null;
                      return (
                        <li key={`${it.id}-${it.at}`}>
                          <button
                            type="button"
                            className="ns-rp-hist-item"
                            onClick={() => void goNode(it.nodeId, shell)}
                          >
                            <RouteBadge route={route} temp={!route} />
                            <span className="nm">{it.name}</span>
                            {it.dueOn && (
                              <span className="occ" title={`定期券班次 ${it.dueOn}`}>
                                定期 {Number(it.dueOn.slice(5, 7))}/{Number(it.dueOn.slice(8, 10))}
                              </span>
                            )}
                            {it.tagKeys.length > 0 && (
                              <span className="tags">
                                {it.tagKeys.slice(0, 2).map((tk) => (
                                  <span key={tk} className="tag">
                                    #{tagDisplayName(tk)}
                                  </span>
                                ))}
                                {it.tagKeys.length > 2 && <span className="tag">+{it.tagKeys.length - 2}</span>}
                              </span>
                            )}
                            <span className="clk">{it.clock}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}

            {remaining > 0 && (
              <div className="ns-rp-hist-more">
                <button
                  type="button"
                  className="chip ns-chip"
                  onClick={() => setLimit((n) => n + HISTORY_PAGE_SIZE)}
                >
                  顯示更多（剩餘 {remaining} 張）
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
