/**
 * 年鑑（車庫與回顧 D-主-219；原型 `yearTab`／`agoCard`）。
 *   - 最上「那年今日」：往年同月同日有日記或筆記才出現（沒有＝整段不出現）；「打開」＝到旅客筆記打開那天的日記／那則筆記。
 *   - 下面按月列（新的在上；有済、日記、到站或章的月份才列）：済章數、日記篇數、駅スタンプ數（只寫發生過的量，0 不寫）、
 *     到站的路線（點了開記錄簿）與幹線、當月的章、一句代表筆記。
 * 資料是 `buildYearbook`（domain/depotView.ts）的事，這裡只畫。
 */
import { useMemo } from "react";
import { buildYearbook } from "../../domain/depotView";
import { fmtMD } from "../../domain/depot";
import { todayKey } from "../../lib/date";
import { useDepotStore } from "../../store/depotStore";
import { useNodeStore } from "../../store/nodeStore";
import { EmptyState } from "../common/EmptyState";
import { jumpDiary, jumpNote } from "../notes/quickJumpNotes";
import { StampImpression } from "./StampImpression";
import { RouteBadge, rcStyle, useDayStartHour, useStampCtx } from "./depotParts";
import "./depot.css";

const WD = ["日", "一", "二", "三", "四", "五", "六"];
const ZH_N = ["", "一", "兩", "三", "四", "五", "六", "七", "八", "九", "十"];

function agoWhen(day: string, years: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const wd = WD[new Date(y, m - 1, d).getDay()];
  return `${ZH_N[years] ?? years}年前・${y}年${m}月${d}日（${wd}）`;
}

export interface YearbookProps {
  onOpen: (routeId: string) => void;
}

export function Yearbook({ onOpen }: YearbookProps) {
  const h = useDayStartHour();
  const stamps = useDepotStore((s) => s.stamps);
  const data = useDepotStore((s) => s.data);
  const routes = useNodeStore((s) => s.routes);
  const lines = useNodeStore((s) => s.lines);
  const ctx = useStampCtx();
  const today = todayKey(h);
  const yb = useMemo(
    () =>
      data
        ? buildYearbook({ today, stamps, sealDays: data.sealDays, notes: data.notes, routes, lines })
        : { ago: null, months: [] },
    [today, stamps, data, routes, lines],
  );
  if (!data) return null;
  const thisMonth = today.slice(0, 7);

  if (!yb.ago && !yb.months.length) {
    return (
      <EmptyState
        tone="first"
        title="年鑑還是空的"
        desc="済了票、寫了日記、路線到站，這裡就會按月記下來。"
        className="ns-depot-empty"
      />
    );
  }

  const ago = yb.ago;
  return (
    <>
      {ago && (
        <section className="ns-depot-ago ns-depot-paper" aria-label="那年今日">
          <div className="ns-depot-ago-h">
            <span className="k">那年今日</span>
            <span className="d">{agoWhen(ago.day, ago.years)}</span>
          </div>
          <p className="ns-depot-ago-q">{ago.text}</p>
          <div className="ns-depot-ago-f">
            <span className="ns-depot-tag">{ago.kind === "diary" ? "日記" : "筆記"}</span>
            <button
              type="button"
              className="ns-btn btn-text"
              onClick={() => void (ago.kind === "diary" ? jumpDiary(ago.id, ago.day) : jumpNote(ago.id))}
            >
              {ago.kind === "diary" ? "打開日記" : "打開筆記"}
            </button>
          </div>
        </section>
      )}
      <div className="ns-depot-yblist">
        {yb.months.map((M) => {
          const [y, m] = M.month.split("-").map(Number);
          return (
            <section key={M.month} className="ns-depot-yb" aria-label={`${y}年${m}月`}>
              <div className="ns-depot-yb-m">
                <b>{m}月</b>
                {M.month === thisMonth ? <span className="now">這個月</span> : <span>{y}</span>}
              </div>
              <div className="ns-depot-yb-c">
                {(M.seals > 0 || M.diaries > 0 || M.stamps.length > 0) && (
                  <p className="ns-depot-yb-facts">
                    {M.seals > 0 && (
                      <span>
                        済章<b>{M.seals}</b>枚
                      </span>
                    )}
                    {M.diaries > 0 && (
                      <span>
                        日記<b>{M.diaries}</b>篇
                      </span>
                    )}
                    {M.stamps.length > 0 && (
                      <span>
                        駅スタンプ<b>{M.stamps.length}</b>枚
                      </span>
                    )}
                  </p>
                )}
                {(M.routes.length > 0 || M.lines.length > 0) && (
                  <div className="ns-depot-yb-arr">
                    <span className="k">到站</span>
                    {M.routes.map((r) => (
                      <button key={r.id} type="button" className="ns-depot-chip" style={rcStyle(r)} onClick={() => onOpen(r.id)}>
                        <RouteBadge route={r} small />
                        {r.name}
                        <time dateTime={r.arrived_on ?? undefined}>{fmtMD(r.arrived_on)}</time>
                      </button>
                    ))}
                    {M.lines.map((l) => (
                      <span key={l.id} className="ns-depot-chip is-trunk">
                        <span className="tk">幹線</span>
                        {l.name}
                        <time dateTime={l.arrived_on ?? undefined}>{fmtMD(l.arrived_on)}</time>
                      </span>
                    ))}
                  </div>
                )}
                {M.stamps.length > 0 && (
                  <div className="ns-depot-yb-st">
                    {M.stamps.map((s, i) => {
                      const c = ctx(s);
                      const rid = c.routeId;
                      return (
                        <StampImpression
                          key={s.id}
                          stamp={s}
                          size={46}
                          index={i}
                          routeCode={c.routeCode}
                          routeName={c.routeName}
                          openedOn={c.openedOn}
                          onOpen={rid ? () => onOpen(rid) : undefined}
                        />
                      );
                    })}
                  </div>
                )}
                {M.quote && (
                  <blockquote className="ns-depot-yb-q">
                    「{M.quote.text}」
                    <cite>
                      {fmtMD(M.quote.day)} 的{M.quote.kind === "diary" ? "日記" : "筆記"}
                    </cite>
                  </blockquote>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}
