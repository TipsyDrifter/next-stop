/**
 * MobileWeekAims——手機的週方針（戊 D-主-262；原型場景 a-m／a-m2）。
 *
 * 一行「本週方針 日期 ── 済 d/n ›」，點開底部面板：每句蓋済、排成車票，底下「改方針」「回顧這週 ›」。
 *   - 今日分頁頂端（`<MobileWeekAims />`）：看今天那週。新的一週、上週有方針又還沒看過回顧 ⇒ 一行字換成「回顧上週 ›」，
 *     點開面板就是上週回顧（☎2：不自動彈面板，免得擋住今日清單）。
 *   - 行程表週條下方（`<MobileWeekAims day={那天} />`）：看週條那一週。
 * 沒寫方針＝一行「本週方針 ── 寫方針 ›」，點了直接開寫方針。
 * 面板三種內容：清單／排成車票（某一句）／回顧（某一週）。返回鍵與下滑＝關面板（MSheet 自己登記）。
 */
import { useState } from "react";
import { addDays } from "../../lib/date";
import { aimNumeral, isLastDayOfWeek, weekRangeText, weekRelText, type WeekAimRow } from "../../domain/weekAims";
import { useWeekAimStore } from "../../store/weekAimStore";
import { MSheet } from "../common/MSheet";
import { IconChevron } from "../common/icons";
import { useWeekAims } from "./useWeekAims";
import { AimStamp, PlanLine, RouteTag } from "./parts";
import { PlanTicketForm, usePlanForm } from "./PlanTicketPop";
import { ReviewList } from "./WeekAimsReview";
import { WeekAimsEditorHost } from "./WeekAimsEditor";
import "./weekAims.css";

type Pane = { kind: "list" } | { kind: "plan"; aim: WeekAimRow } | { kind: "review"; weekOn: string };

export function MobileWeekAims({ day }: { day?: string | null }) {
  const v = useWeekAims(day, !day);
  const [pane, setPane] = useState<Pane | null>(null);
  if (v.loading) return null;

  const rel = weekRelText(v.weekOn, v.today, v.weekStart);
  const title = rel === "這週" ? "本週方針" : `${rel}的方針`;
  const empty = v.aims.length === 0;
  const lastDay = v.weekOn === v.curWeek && isLastDayOfWeek(v.today, v.weekStart);
  const st = useWeekAimStore.getState;

  const openReview = (weekOn: string) => {
    setPane({ kind: "review", weekOn });
    void st().openReview(weekOn);
  };
  const close = () => {
    if (pane?.kind === "review") void st().closeReview();
    setPane(null);
  };
  const tap = () => {
    if (v.pendingReview) openReview(v.pendingReview);
    else if (empty) st().openEditor(v.weekOn);
    else setPane({ kind: "list" });
  };

  const cue = v.pendingReview ? (
    <span className="wa-cue">回顧上週</span>
  ) : empty ? (
    <span className="wa-cue">寫方針</span>
  ) : (
    <span className="wa-count">
      済 <b>{v.count.done}</b>/{v.count.total}
    </span>
  );

  return (
    <>
      <section className="wa" aria-label={title}>
        <div className="wa-board">
          <button type="button" className="wa-mline" aria-haspopup="dialog" onClick={tap}>
            <span className="wa-ttl">{title}</span>
            <span className="wa-dt">{weekRangeText(v.weekOn)}</span>
            <span className="wa-rule" />
            {cue}
            <IconChevron />
          </button>
        </div>
      </section>

      {pane?.kind === "list" && (
        <MSheet
          title={title}
          className="wa-ms"
          onClose={close}
          height="auto"
          ariaLabel={title}
        >
          <p className="wa-ms-sub">
            {weekRangeText(v.weekOn)}　済 <b>{v.count.done}</b>/{v.count.total}
          </p>
          {v.aims.map((a, i) => {
            const place = v.placeOf(a.node_id);
            return (
              <div key={a.id} className={"wa-mrow" + (a.done_at ? " is-done" : "")}>
                <span className="wa-num">{aimNumeral(i)}</span>
                <div>
                  <p className="wa-text">
                    <span className="t">{a.text}</span>
                    {place && <RouteTag place={place} shell="mobile" onGo={close} />}
                  </p>
                  <PlanLine aim={a} count={a.node_id ? v.planned?.[a.node_id] : undefined} />
                  {a.done_at === null && (
                    <div className="act">
                      <button type="button" className="ns-btn btn-ghost ns-btn--sm" onClick={() => setPane({ kind: "plan", aim: a })}>
                        排成車票
                      </button>
                    </div>
                  )}
                </div>
                <AimStamp aim={a} />
              </div>
            );
          })}
          <div className="wa-ms-links">
            <button
              type="button"
              className="ns-btn btn-ghost ns-btn--sm"
              onClick={() => {
                setPane(null);
                st().openEditor(v.weekOn);
              }}
            >
              改方針
            </button>
            {(lastDay || v.weekOn < v.curWeek) && (
              <button type="button" className="ns-btn btn-text ns-btn--sm" onClick={() => openReview(v.weekOn)}>
                回顧{rel === "這週" ? "這週" : ""} ›
              </button>
            )}
            {v.weekOn === v.curWeek && !lastDay && (
              <button type="button" className="ns-btn btn-text ns-btn--sm" onClick={() => openReview(addDays(v.weekOn, -7))}>
                回顧上週 ›
              </button>
            )}
          </div>
        </MSheet>
      )}

      {pane?.kind === "plan" && <PlanSheet aim={pane.aim} weekOn={v.weekOn} today={v.today} onClose={() => setPane({ kind: "list" })} />}

      {pane?.kind === "review" && (
        <MSheet
          title={`${weekRelText(pane.weekOn, v.today, v.weekStart) === "這週" ? "本週" : weekRelText(pane.weekOn, v.today, v.weekStart)}回顧`}
          className="wa-ms"
          onClose={close}
          height="half"
        >
          <p className="wa-ms-sub">{weekRangeText(pane.weekOn)}</p>
          <ReviewList
            weekOn={pane.weekOn}
            today={v.today}
            weekStart={v.weekStart}
            placeOf={v.placeOf}
            onCarry={(next, toCarry) => {
              void st().closeReview();
              setPane(null);
              st().openEditor(next, toCarry);
            }}
          />
        </MSheet>
      )}

      <WeekAimsEditorHost today={v.today} weekStart={v.weekStart} />
    </>
  );
}

function PlanSheet({ aim, weekOn, today, onClose }: { aim: WeekAimRow; weekOn: string; today: string; onClose(): void }) {
  const f = usePlanForm(aim, weekOn, today);
  return (
    <MSheet
      title="排成車票"
      className="wa-ms"
      onClose={onClose}
      height="auto"
      backKind="dialog"
      foot={
        <>
          <button type="button" className="ns-btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="ns-btn btn-seal"
            disabled={f.busy || !f.name.trim()}
            onClick={() => void f.submit().then((ok) => ok && onClose())}
          >
            発券
          </button>
        </>
      }
    >
      <PlanTicketForm f={f} today={today} />
    </MSheet>
  );
}
