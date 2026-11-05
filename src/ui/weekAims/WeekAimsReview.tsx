/**
 * 方針的回顧（戊 D-主-258、260；方針擴充 辛 §7；原型場景 a-review）。吃任何期間鍵。
 * 每句済了沒（還能補蓋）＋這段期間在掛的地方：蓋了幾枚章、時刻表記了多久、售票口花了多少（沒有就是 —）。沒有分數、連續天數、進度條。
 * 車站沒掛的句子數字看這條路線（§2）。
 * 頁腳「帶到下週／下個月／明年／下一站（N 句）」＝開下一期的寫方針、沒済的 N 句已經帶進草稿（D-主-261）；車站後面沒有還沒到的站＝鈕灰掉並說明。
 * 桌機＝告示換成表格（`ReviewBoard`）；手機＝底部面板裡的清單（`ReviewList`）。
 */
import { useEffect } from "react";
import { moneyText } from "../../domain/ticket";
import {
  adjacentKey,
  aimNumeral,
  aimsOfKey,
  nextStationOf,
  periodOfKey,
  periodTitle,
  reviewLatin,
  reviewMinutesText,
  reviewTitle,
  stationHeadText,
  stationIdOfKey,
  stationKeyOf,
  type WeekAimRow,
} from "../../domain/weekAims";
import { compareSiblings } from "../../domain/nodeOrder";
import type { ReviewResult } from "../../data/weekAimRepository";
import { useNodeStore } from "../../store/nodeStore";
import { uncarried, useWeekAimStore } from "../../store/weekAimStore";
import { IconClose } from "../common/icons";
import { AimStamp, PlanLine, RouteTag, type AimPlace } from "./parts";

const EMPTY: WeekAimRow[] = [];

/** 回顧要的：那一期的方針、下一期（帶過去看重複；車站後面沒有還沒到的站＝null）、數字；車站鍵另外給這站與路線 */
export function useReviewData(aimKey: string) {
  const stationId = stationIdOfKey(aimKey);
  const stations = useNodeStore((s) => s.stations);
  const station = stationId ? (stations.find((x) => x.id === stationId) ?? null) : null;
  let next: string | null;
  if (periodOfKey(aimKey) !== "station") next = adjacentKey(aimKey, 1);
  else {
    const siblings = station ? stations.filter((x) => x.parent_id === station.parent_id).sort(compareSiblings) : [];
    const n = station ? nextStationOf(station, siblings) : null;
    next = n ? stationKeyOf(n.id) : null;
  }
  const aims = useWeekAimStore((s) => s.weeks[aimKey]) ?? EMPTY;
  const nextAims = useWeekAimStore((s) => (next ? s.weeks[next] : undefined)) ?? EMPTY;
  const planned = useWeekAimStore((s) => s.planned[aimKey]);
  const result = useWeekAimStore((s) => (s.review?.weekOn === aimKey ? s.review.result : null));
  useEffect(() => {
    // 下一期＝帶過去的地方（週、月、年載下一期會順便重載這一期；車站只載自己）
    if (next) void useWeekAimStore.getState().loadWeek(next);
  }, [next]);
  const toCarry = uncarried(aims, next ? aimsOfKey(nextAims, next) : EMPTY);
  return { aims, next, planned, result, toCarry, station, stationRouteId: station?.parent_id ?? null };
}

/** 帶過去的那一期怎麼稱呼：下週／這週／下個月／明年…；車站一律「下一站」 */
function nextRelOf(aimKey: string, next: string | null, today: string, weekStart: 0 | 1): string {
  if (periodOfKey(aimKey) === "station" || next === null) return "下一站";
  return periodTitle(next, today, weekStart).rel;
}

export const NO_NEXT_HINT = "這是最後一站，沒有下一站可以帶";

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

/** 桌機：告示換成回顧表 */
export function ReviewBoard({
  aimKey,
  today,
  weekStart,
  placeOf,
}: {
  aimKey: string;
  today: string;
  weekStart: 0 | 1;
  placeOf(id: string | null): AimPlace | null;
}) {
  const d = useReviewData(aimKey);
  const head = periodTitle(aimKey, today, weekStart);
  const title = reviewTitle(aimKey, today, weekStart);
  const close = () => void useWeekAimStore.getState().closeReview();
  const closeTitle = periodOfKey(aimKey) === "week" ? "收起回顧（回到本週方針）" : "收起回顧";
  const rangeText = periodOfKey(aimKey) === "station" ? stationHeadText(d.station) : head.range;
  return (
    <section className="wa is-review" aria-label={title}>
      <div className="wa-board">
        <div className="wa-head">
          <h3 className="wa-ttl">{title}</h3>
          <span className="wa-latin">{reviewLatin(aimKey)}</span>
          <span className="wa-dt">{rangeText}</span>
          <span className="wa-rule" />
          <button type="button" className="ns-iconbtn" aria-label="收起回顧" title={closeTitle} onClick={close}>
            <IconClose />
          </button>
        </div>
        {d.aims.length === 0 ? (
          <p className="wa-sub" style={{ padding: "10px 0 6px" }}>
            {head.rel}沒有寫方針。
          </p>
        ) : (
          <table className="wa-rv">
            <thead>
              <tr className="grp">
                <th />
                <th />
                <th colSpan={3} className="grp">
                  <span className="techo-label">這段期間</span>
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
                // 車站沒掛的句子：數字看這條路線，標示不重複畫路線（D-主-372）
                const viaRoute = a.node_id === null && d.stationRouteId !== null;
                const hasNums = place !== null || viaRoute;
                const nodeId = a.node_id ?? d.stationRouteId;
                const c = reviewCells(d.result, nodeId);
                return (
                  <tr key={a.id}>
                    <td className="c-num">
                      <span className="wa-num">{aimNumeral(i)}</span>
                    </td>
                    <td className="c-main">
                      <p className="wa-text">
                        <span className="t">{a.text}</span>
                        {place ? <RouteTag place={place} shell="desktop" /> : !viaRoute && <span className="wa-sub">沒掛</span>}
                      </p>
                      <PlanLine aim={a} count={nodeId ? d.planned?.[nodeId] : undefined} />
                    </td>
                    <td className="c-n">{hasNums ? <Num v={c.loading ? "…" : c.stamps} unit=" 枚" /> : null}</td>
                    <td className="c-n">{hasNums ? <Num v={c.loading ? "…" : c.time} /> : null}</td>
                    <td className="c-n">{hasNums ? c.money ? <span className="money">{c.money}</span> : <span className="none">—</span> : null}</td>
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
            {d.next === null && <span className="hint">{NO_NEXT_HINT}</span>}
            <span className="sp" />
            <button
              type="button"
              className="ns-btn btn-ghost"
              aria-haspopup="dialog"
              disabled={d.next === null}
              onClick={() => {
                if (d.next) useWeekAimStore.getState().openEditor(d.next, d.toCarry);
              }}
            >
              帶到{nextRelOf(aimKey, d.next, today, weekStart)}（{d.toCarry.length} 句）
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

/** 手機底部面板、車站小卡裡的回顧清單（每句一列，數字一行小字） */
export function ReviewList({
  aimKey,
  today,
  weekStart,
  placeOf,
  onCarry,
  shell = "mobile",
  onGo,
}: {
  aimKey: string;
  today: string;
  weekStart: 0 | 1;
  placeOf(id: string | null): AimPlace | null;
  onCarry(next: string, toCarry: readonly WeekAimRow[]): void;
  /** 車站小卡桌機也用這份清單（路線標跳的地方隨殼） */
  shell?: "desktop" | "mobile";
  /** 點路線標之前（小卡收起來） */
  onGo?: () => void;
}) {
  const d = useReviewData(aimKey);
  return (
    <>
      {d.aims.length === 0 && <p className="wa-ms-empty">{periodTitle(aimKey, today, weekStart).rel}沒有寫方針。</p>}
      {d.aims.map((a, i) => {
        const place = placeOf(a.node_id);
        const viaRoute = a.node_id === null && d.stationRouteId !== null;
        const c = reviewCells(d.result, a.node_id ?? d.stationRouteId);
        return (
          <div key={a.id} className={"wa-mrow" + (a.done_at ? " is-done" : "")}>
            <span className="wa-num">{aimNumeral(i)}</span>
            <div>
              <p className="wa-text">
                <span className="t">{a.text}</span>
                {place && <RouteTag place={place} shell={shell} onGo={onGo} />}
              </p>
              {place || viaRoute ? (
                <p className="wa-mnums">
                  蓋章 <b>{c.loading ? "…" : (c.stamps ?? "—")}</b>・時刻表 <b>{c.loading ? "…" : (c.time ?? "—")}</b>・售票口{" "}
                  <b>{c.money ?? "—"}</b>
                </p>
              ) : (
                <p className="wa-sub">沒掛</p>
              )}
            </div>
            <AimStamp aim={a} />
          </div>
        );
      })}
      {d.toCarry.length > 0 && (
        <div className="wa-ms-links">
          <button
            type="button"
            className="ns-btn btn-ghost ns-btn--sm"
            disabled={d.next === null}
            onClick={() => {
              if (d.next) onCarry(d.next, d.toCarry);
            }}
          >
            帶到{nextRelOf(aimKey, d.next, today, weekStart)}（{d.toCarry.length} 句）
          </button>
          {d.next === null && <span className="wa-sub">{NO_NEXT_HINT}</span>}
        </div>
      )}
    </>
  );
}
