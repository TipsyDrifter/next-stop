/**
 * 年鑑（車庫與回顧 D-主-219；原型 `yearTab`／`agoCard`）。
 *   - 最上「那年今日」：往年同月同日有日記或筆記才出現（沒有＝整段不出現）；「打開」＝到旅客筆記打開那天的日記／那則筆記。
 *   - 願望實現（壬 候車室 D-主-517）：那年今日也認「實現的願望」（日記 › 筆記 › 願望）；按月多一個「實現 N 件」；點了到候車室。
 *   - 下面按月列（新的在上；有済、日記、到站或章的月份才列）：済章數、日記篇數、駅スタンプ數（只寫發生過的量，0 不寫）、
 *     到站的路線（點了開記錄簿）與幹線、當月的章、一句代表筆記。
 * 資料是 `buildYearbook`（domain/depotView.ts）的事，這裡只畫。
 * 最頂上是今年方針（方針擴充 辛 D-主-378）：桌機告示、手機一行，‹ 年 › 只換告示那一年，底下按月清單照舊；空狀態時也在。
 */
import { useMemo, useState } from "react";
import { buildYearbook } from "../../domain/depotView";
import { fmtMD } from "../../domain/depot";
import { todayKey } from "../../lib/date";
import { useUiStore } from "../../store/uiStore";
import type { MobileTabKey } from "../mobile/tabs";
import type { PageId } from "../shell/pages";
import { yearKeyOf, type AimPeriod } from "../../domain/weekAims";
import { useAimLanding } from "../search/aimLanding";
import { AimsBand } from "../weekAims/AimsBand";
import { MobileAimsLine } from "../weekAims/MobileAimsLine";
import { useShell } from "../mobile/useShell";
import { useDepotStore } from "../../store/depotStore";
import { useNodeStore } from "../../store/nodeStore";
import { EmptyState } from "../common/EmptyState";
import { jumpDiary, jumpNote } from "../notes/quickJumpNotes";
import { StampImpression } from "./StampImpression";
import { RouteBadge, rcStyle, useDayStartHour, useStampCtx } from "./depotParts";
import "./depot.css";

const LANDS_ON: readonly AimPeriod[] = ["year"];
const WD = ["日", "一", "二", "三", "四", "五", "六"];
const ZH_N = ["", "一", "兩", "三", "四", "五", "六", "七", "八", "九", "十"];

function agoWhen(day: string, years: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const wd = WD[new Date(y, m - 1, d).getDay()];
  return `${ZH_N[years] ?? years}年前・${y}年${m}月${d}日（${wd}）`;
}

/** 到候車室頁（桌機換頁、手機換 tab）。TODO(壬 整合)：候車室的 PageId／MobileTabKey 進 pages.ts／tabs.ts 之後拿掉 `as string as` */
function gotoWaitroom(shell: "desktop" | "mobile"): void {
  const ui = useUiStore.getState();
  if (shell === "mobile") ui.setMobileTab("waitroom" as string as MobileTabKey);
  else ui.setPage("waitroom" as string as PageId);
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
  const shell = useShell();
  const today = todayKey(h);
  // 完整搜尋點了別年的方針（辛 D-主-382）：告示落在那一年；離開這頁就回今年（同 ‹ 年 › 只活在這次，D-主-378）
  const [landed, setLanded] = useState<string | null>(null);
  useAimLanding(LANDS_ON, setLanded);
  const yb = useMemo(
    () =>
      data
        ? buildYearbook({ today, stamps, sealDays: data.sealDays, notes: data.notes, wishes: data.wishes, routes, lines })
        : { ago: null, months: [] },
    [today, stamps, data, routes, lines],
  );
  if (!data) return null;
  const thisMonth = today.slice(0, 7);
  const yearKey = landed ?? yearKeyOf(today);
  const aims = shell === "mobile" ? <MobileAimsLine aimKey={yearKey} navigable onBackToCurrent={() => setLanded(null)} /> : <AimsBand aimKey={yearKey} navigable />;

  if (!yb.ago && !yb.months.length) {
    return (
      <>
        {aims}
        <EmptyState
          tone="first"
          title="年鑑還是空的"
          desc="済了票、寫了日記、路線到站，這裡就會按月記下來。"
          className="ns-depot-empty"
        />
      </>
    );
  }

  const ago = yb.ago;
  return (
    <>
      {aims}
      {ago && (
        <section className="ns-depot-ago ns-depot-paper" aria-label="那年今日">
          <div className="ns-depot-ago-h">
            <span className="k">那年今日</span>
            <span className="d">{agoWhen(ago.day, ago.years)}</span>
          </div>
          <p className="ns-depot-ago-q">{ago.text}</p>
          <div className="ns-depot-ago-f">
            {ago.kind === "wish" ? (
              <>
                <span className="ns-depot-tag">願望{ago.wishKind ? "・" + ago.wishKind : ""}</span>
                <span className="ns-depot-ago-done">實現了</span>
                <button type="button" className="ns-btn btn-text" onClick={() => gotoWaitroom(shell)}>
                  到候車室
                </button>
              </>
            ) : (
              <>
                <span className="ns-depot-tag">{ago.kind === "diary" ? "日記" : "筆記"}</span>
                <button
                  type="button"
                  className="ns-btn btn-text"
                  onClick={() => void (ago.kind === "diary" ? jumpDiary(ago.id, ago.day) : jumpNote(ago.id))}
                >
                  {ago.kind === "diary" ? "打開日記" : "打開筆記"}
                </button>
              </>
            )}
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
                {(M.seals > 0 || M.diaries > 0 || M.wishes > 0 || M.stamps.length > 0) && (
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
                    {M.wishes > 0 && (
                      <button type="button" className="ns-depot-yb-wish" onClick={() => gotoWaitroom(shell)}>
                        實現<b>{M.wishes}</b>件
                      </button>
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
