/**
 * 週方針的回顧（戊 D-主-258、260；原型場景 a-review）。
 * 每句済了沒（還能補蓋）＋掛的路線這週：蓋了幾枚章、時刻表記了多久、售票口花了多少（沒有就是 —）。沒有分數、連續天數、進度條。
 * 頁腳「帶到下週（N 句）」＝開下一週的寫方針、沒済的 N 句已經帶進草稿（D-主-261）。
 * 桌機＝帶子換成表格（`ReviewBoard`）；手機＝底部面板裡的清單（`ReviewList`）。
 */
import { useEffect } from "react";
import { addDays } from "../../lib/date";
import { moneyText } from "../../domain/ticket";
import { aimNumeral, aimsOfWeek, reviewMinutesText, weekRangeText, weekRelText, type WeekAimRow } from "../../domain/weekAims";
import type { ReviewResult } from "../../data/weekAimRepository";
import { uncarried, useWeekAimStore } from "../../store/weekAimStore";
import { IconClose } from "../common/icons";
import { AimStamp, PlanLine, RouteTag, type AimPlace } from "./parts";

const EMPTY: WeekAimRow[] = [];

/** 回顧要的：那週的方針、下一週（帶過去看重複）、數字 */
export function useReviewData(weekOn: string) {
  const next = addDays(weekOn, 7);
  const aims = useWeekAimStore((s) => s.weeks[weekOn]) ?? EMPTY;
  const nextAims = useWeekAimStore((s) => s.weeks[next]) ?? EMPTY;
  const planned = useWeekAimStore((s) => s.planned[weekOn]);
  const result = useWeekAimStore((s) => (s.review?.weekOn === weekOn ? s.review.result : null));
  useEffect(() => {
    // 下一週＝帶過去的地方（載下一週會順便重載這一週）
    void useWeekAimStore.getState().loadWeek(next);
  }, [next]);
  const toCarry = uncarried(aims, aimsOfWeek(nextAims, next));
  return { aims, next, planned, result, toCarry };
}

function Num({ v, unit }: { v: string | null; unit?: string }) {
  if (v === null) return <span className="none">—</span>;
  return (
    <>
      <b>{v}</b>
      {unit}
    </>
  );
}

export function reviewCells(result: ReviewResult | null, nodeId: string | null) {
  const s = nodeId && result ? result.stats[nodeId] : undefined;
  const stamps = s && s.stamps > 0 ? String(s.stamps) : null;
  const time = s ? reviewMinutesText(s.minutes) : null;
  const money = s && s.spendMinor && result?.money ? moneyText(s.spendMinor, result.money.decimals) : null;
  return { stamps, time, money, loading: result === null };
}

/** 桌機：帶子換成回顧表 */
export function ReviewBoard({
  weekOn,
  today,
  weekStart,
  placeOf,
}: {
  weekOn: string;
  today: string;
  weekStart: 0 | 1;
  placeOf(id: string | null): AimPlace | null;
}) {
  const d = useReviewData(weekOn);
  const rel = weekRelText(weekOn, today, weekStart);
  const nextRel = weekRelText(d.next, today, weekStart);
  const close = () => void useWeekAimStore.getState().closeReview();
  return (
    <section className="wa is-review" aria-label={`${rel}回顧`}>
      <div className="wa-board">
        <div className="wa-head">
          <h3 className="wa-ttl">{rel === "這週" ? "本週" : rel}回顧</h3>
          <span className="wa-latin">Weekly review</span>
          <span className="wa-dt">{weekRangeText(weekOn)}</span>
          <span className="wa-rule" />
          <button type="button" className="ns-iconbtn" aria-label="收起回顧" title="收起回顧（回到本週方針）" onClick={close}>
            <IconClose />
          </button>
        </div>
        {d.aims.length === 0 ? (
          <p className="wa-sub" style={{ padding: "10px 0 6px" }}>
            {rel}沒有寫方針。
          </p>
        ) : (
          <table className="wa-rv">
            <thead>
              <tr className="grp">
                <th />
                <th />
                <th colSpan={3} className="grp">
                  <span className="techo-label">掛的路線這週</span>
                </th>
                <th />
              </tr>
              <tr>
                <th />
                <th style={{ textAlign: "left", paddingLeft: 10 }}>
                  <span className="techo-label">方針</span>
                </th>
                <th>
                  <span className="techo-label">蓋章</span>
                </th>
                <th>
                  <span className="techo-label">時刻表</span>
                </th>
                <th>
                  <span className="techo-label">售票口</span>
                </th>
                <th />
              </tr>
            </thead>
            <tbody>
              {d.aims.map((a, i) => {
                const place = placeOf(a.node_id);
                const c = reviewCells(d.result, a.node_id);
                return (
                  <tr key={a.id}>
                    <td className="c-num">
                      <span className="wa-num">{aimNumeral(i)}</span>
                    </td>
                    <td className="c-main">
                      <p className="wa-text">
                        <span className="t">{a.text}</span>
                        {place ? <RouteTag place={place} shell="desktop" /> : <span className="wa-sub">沒掛路線</span>}
                      </p>
                      <PlanLine aim={a} count={a.node_id ? d.planned?.[a.node_id] : undefined} />
                    </td>
                    <td className="c-n">{place ? <Num v={c.loading ? "…" : c.stamps} unit=" 枚" /> : null}</td>
                    <td className="c-n">{place ? <Num v={c.loading ? "…" : c.time} /> : null}</td>
                    <td className="c-n">{place ? c.money ? <span className="money">{c.money}</span> : <span className="none">—</span> : null}</td>
                    <td className="c-st">
                      <AimStamp aim={a} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {d.toCarry.length > 0 && (
          <div className="wa-rv-foot">
            <span className="sp" />
            <button
              type="button"
              className="ns-btn btn-ghost"
              aria-haspopup="dialog"
              onClick={() => useWeekAimStore.getState().openEditor(d.next, d.toCarry)}
            >
              帶到{nextRel}（{d.toCarry.length} 句）
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

/** 手機：底部面板裡的回顧清單（每句一列，數字一行小字） */
export function ReviewList({
  weekOn,
  today,
  weekStart,
  placeOf,
  onCarry,
}: {
  weekOn: string;
  today: string;
  weekStart: 0 | 1;
  placeOf(id: string | null): AimPlace | null;
  onCarry(next: string, toCarry: readonly WeekAimRow[]): void;
}) {
  const d = useReviewData(weekOn);
  const nextRel = weekRelText(d.next, today, weekStart);
  return (
    <>
      {d.aims.length === 0 && <p className="wa-ms-empty">{weekRelText(weekOn, today, weekStart)}沒有寫方針。</p>}
      {d.aims.map((a, i) => {
        const place = placeOf(a.node_id);
        const c = reviewCells(d.result, a.node_id);
        return (
          <div key={a.id} className={"wa-mrow" + (a.done_at ? " is-done" : "")}>
            <span className="wa-num">{aimNumeral(i)}</span>
            <div>
              <p className="wa-text">
                <span className="t">{a.text}</span>
                {place && <RouteTag place={place} shell="mobile" />}
              </p>
              {place ? (
                <p className="wa-mnums">
                  蓋章 <b>{c.loading ? "…" : (c.stamps ?? "—")}</b>・時刻表 <b>{c.loading ? "…" : (c.time ?? "—")}</b>・售票口{" "}
                  <b>{c.money ?? "—"}</b>
                </p>
              ) : (
                <p className="wa-sub">沒掛路線</p>
              )}
            </div>
            <AimStamp aim={a} />
          </div>
        );
      })}
      {d.toCarry.length > 0 && (
        <div className="wa-ms-links">
          <button type="button" className="ns-btn btn-ghost ns-btn--sm" onClick={() => onCarry(d.next, d.toCarry)}>
            帶到{nextRel}（{d.toCarry.length} 句）
          </button>
        </div>
      )}
    </>
  );
}
