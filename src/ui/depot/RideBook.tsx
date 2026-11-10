/**
 * 乘車記錄簿（車庫與回顧 D-主-218；原型 `bookBody`）——內容兩殼共用，殼由呼叫端給：
 *   桌機＝車庫頁內換成記錄簿畫面（頁首用 PageHeader 身分式：路線名大標、開業 → 到站、幹線；終點章放日付印位）；
 *   手機＝MFullPage 子頁（標題列在 MFullPage；這裡畫原型的 bk-head：圓牌＋路線名＋運行中膠囊，右上一枚終點章）。
 * 內容：四格事實（済章／時刻表／花費／筆記，點了跳該模組看這條路線）→ 經過的車站 → 沿線的駅スタンプ → 相關筆記（最近 5 則）
 *   → 底部動作（已到站＝次鈕「回到運行」＋文字鈕「在路線圖打開」；還在跑＝次鈕「在路線圖打開」）。
 * 守則：運行中路線只列已到着的站（不列下一站——路線圖的「下一站＋金弧」管預告）。
 * 方針擴充（辛 §3 #8）：每站底下列出當時的方針（只讀，済的有小章）；沒寫不佔位。
 */
import { useEffect, useMemo, useState } from "react";
import { bookStations, digestLine } from "../../domain/depotView";
import { fmtMD, fmtZhMD } from "../../domain/depot";
import { dayKeyOf } from "../../lib/date";
import { useDepotStore } from "../../store/depotStore";
import { useNodeStore } from "../../store/nodeStore";
import { EmptyState } from "../common/EmptyState";
import { PageHeader } from "../common/PageHeader";
import { jumpDiary, jumpNote } from "../notes/quickJumpNotes";
import { requestDepart } from "../panel/arrivalFlows";
import { requestDeleteRoute } from "../panel/routeFlows";
import { BookStationAims, useStationAimLists } from "../weekAims/StationCard";
import { StampImpression } from "./StampImpression";
import { bookJump, loadBookFacts, openRouteOnMap, type BookFacts } from "./bookLinks";
import { RouteBadge, RunPill, openedOf, rcStyle, useDayStartHour } from "./depotParts";
import "./depot.css";

export interface RideBookProps {
  routeId: string;
  shell: "desktop" | "mobile";
  /** 找不到路線時的「回車庫」 */
  onBack: () => void;
}

/** 時數：10 小時以上取整數，以下留一位小數 */
function hoursText(ms: number): string {
  const h = ms / 3_600_000;
  if (h >= 10) return String(Math.round(h));
  const t = h.toFixed(1);
  return t.endsWith(".0") ? t.slice(0, -2) : t;
}

export function RideBook({ routeId, shell, onBack }: RideBookProps) {
  const h = useDayStartHour();
  const routes = useNodeStore((s) => s.routes);
  const lines = useNodeStore((s) => s.lines);
  const stations = useNodeStore((s) => s.stations);
  const data = useDepotStore((s) => s.data);
  const stamps = useDepotStore((s) => s.stamps);
  const [facts, setFacts] = useState<BookFacts | null>(null);

  useEffect(() => {
    let alive = true;
    setFacts(null);
    void loadBookFacts(routeId).then((f) => {
      if (alive) setFacts(f);
    });
    return () => {
      alive = false;
    };
  }, [routeId]);

  const route = routes.find((r) => r.id === routeId) ?? null;
  const own = useMemo(() => stations.filter((s) => s.route_id === routeId), [stations, routeId]);
  const ownIds = useMemo(() => new Set(own.map((s) => s.id)), [own]);
  const aimsOf = useStationAimLists(own.map((s) => s.id));

  if (!route) {
    return (
      <div className="ns-depot-book">
        <EmptyState tone="first" stamp={null} title="找不到這條路線" desc="它可能已經刪除了。" action={{ label: "回車庫", onClick: onBack }} />
      </div>
    );
  }

  const live = route.arrived_on === null;
  const opened = openedOf(route, data, h);
  const line = route.line_id ? (lines.find((l) => l.id === route.line_id) ?? null) : null;
  const stops = bookStations(route, opened, own);
  const termStamp = live ? null : (stamps.find((s) => s.kind === "route" && s.subject_id === route.id) ?? null);
  const stationStamps = stamps.filter((s) => s.kind === "station" && s.subject_id !== null && ownIds.has(s.subject_id));
  const seals = data ? (data.routeSeals[route.id] ?? 0) : null;
  const span = `${fmtZhMD(opened)} 開業${live ? "" : ` → ${fmtZhMD(route.arrived_on)} 到站`}`;
  const lineBit = line && (
    <>
      <span className="k">幹線</span>
      {line.name}
      {line.arrived_on && <time dateTime={line.arrived_on}>{fmtMD(line.arrived_on)} 到站</time>}
    </>
  );
  const term = termStamp && (
    <StampImpression stamp={termStamp} size={92} routeCode={route.code} routeName={route.name} openedOn={opened} />
  );
  const jump = (k: Parameters<typeof bookJump>[0]) => bookJump(k, route.id, shell);
  const pending = facts === null;

  return (
    <div className="ns-depot-book" aria-busy={pending || undefined}>
      {shell === "desktop" ? (
        <PageHeader
          variant="identity"
          overline={{ zh: "乘車記錄簿", latin: "Ride Book" }}
          title={
            <>
              <RouteBadge route={route} />
              {route.name}
            </>
          }
          aside={live ? <RunPill /> : undefined}
          stats={
            <>
              {span}
              {lineBit && <span className="ns-depot-statline">・{lineBit}</span>}
            </>
          }
          stamp={term || undefined}
        />
      ) : (
        <div className={"ns-depot-bk-head" + (termStamp ? "" : " is-run")}>
          <div className="ns-depot-bk-title">
            <RouteBadge route={route} />
            <h2>{route.name}</h2>
            {live && <RunPill />}
          </div>
          <p className="ns-depot-bk-span">{span}</p>
          {lineBit && <p className="ns-depot-bk-trunk">{lineBit}</p>}
          {term && <div className="ns-depot-bk-term">{term}</div>}
        </div>
      )}

      <div className="ns-depot-facts">
        <button type="button" className="ns-depot-fact" onClick={() => jump("seals")} title="在路線圖打開這條路線">
          <span className="k">済章</span>
          <span className={"v" + (seals === null ? " is-pending" : "")}>
            {seals ?? "—"}
            <small>枚</small>
          </span>
        </button>
        <button type="button" className="ns-depot-fact" onClick={() => jump("time")} title="到時刻表看統計">
          <span className="k">時刻表</span>
          <span className={"v l" + (facts?.hoursMs == null ? " is-pending" : "")}>
            {facts?.hoursMs != null ? hoursText(facts.hoursMs) : "—"}
            <small>小時</small>
          </span>
        </button>
        <button type="button" className="ns-depot-fact" onClick={() => jump("spend")} title="到售票口看這條路線的帳">
          <span className="k">花費</span>
          <span className={"v" + (facts?.spend == null ? " is-pending" : "")}>
            {facts?.spend ?? "—"}
            <small>元</small>
          </span>
        </button>
        <button type="button" className="ns-depot-fact" onClick={() => jump("notes")} title="到旅客筆記看這條路線的筆記">
          <span className="k">筆記</span>
          <span className={"v" + (pending ? " is-pending" : "")}>
            {facts ? facts.noteCount : "—"}
            <small>則</small>
          </span>
        </button>
      </div>

      <div className="sec is-sm">
        <h3>經過的車站</h3>
        <span className="rule" />
      </div>
      <ol className={"ns-depot-stl" + (live ? " is-run" : "")} style={rcStyle(route)}>
        {stops.map((st, i) => (
          <li key={st.stationId ?? `${st.kind}-${i}`} className={st.kind === "station" ? undefined : `is-${st.kind}`}>
            <span className="nm">{st.name}</span>
            {st.kind === "term" && <span className="ns-depot-tag">終點</span>}
            {st.day && <time dateTime={st.day}>{fmtMD(st.day)}</time>}
            {st.stationId && <BookStationAims aims={aimsOf(st.stationId)} />}
          </li>
        ))}
      </ol>

      {stationStamps.length > 0 && (
        <>
          <div className="sec is-sm">
            <h3>沿線的駅スタンプ</h3>
            <span className="rule" />
          </div>
          <div className="ns-depot-bk-stamps">
            {stationStamps.map((s, i) => (
              <div key={s.id} className="ns-depot-acell">
                <StampImpression stamp={s} size={56} index={i} routeCode={route.code} routeName={route.name} />
                <span className="dt">{fmtMD(s.stamped_on)}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {facts && facts.noteCount > 0 && (
        <>
          <div className="sec is-sm">
            <h3>相關筆記</h3>
            <span className="rule" />
            <span className="note">{facts.noteCount} 則</span>
          </div>
          <ul className="ns-depot-bk-notes">
            {facts.notes.map((n) => {
              const day = n.kind === "diary" && n.entry_date ? n.entry_date : dayKeyOf(n.noted_at, h);
              return (
                <li key={n.id}>
                  <button
                    type="button"
                    className="ns-depot-bk-note"
                    onClick={() => void (n.kind === "diary" ? jumpDiary(n.id, day) : jumpNote(n.id))}
                  >
                    <time dateTime={day}>{fmtMD(day)}</time>
                    <span>{digestLine(n.title, n.body) || "（空白）"}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <button type="button" className="ns-btn btn-text ns-depot-bk-more" onClick={() => jump("notes")}>
            看全部筆記
          </button>
        </>
      )}

      <div className="ns-depot-bk-foot">
        {live ? (
          <button type="button" className="ns-btn btn-ghost" onClick={() => openRouteOnMap(route.id, shell)}>
            在路線圖打開
          </button>
        ) : (
          <>
            <button type="button" className="ns-btn btn-ghost" onClick={() => void requestDepart(route.id)}>
              回到運行
            </button>
            <button type="button" className="ns-btn btn-text" onClick={() => openRouteOnMap(route.id, shell)}>
              在路線圖打開
            </button>
            <button
              type="button"
              className="ns-btn btn-text is-danger"
              onClick={() => void requestDeleteRoute(route, { onConfirmed: onBack })}
            >
              刪除路線
            </button>
          </>
        )}
      </div>
    </div>
  );
}
