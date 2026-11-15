/**
 * 行路對照（今年 · 本月 · 本週）——嵌於《車窓・理想手札》扉頁的三尺度方針橫向並排區。
 *
 * 定位：
 *   - 今日頁頂部方針維持輕巧單層切換，避免擠壓每日車票；
 *   - 翻開《理想手札》時，在「終點站的風景（無期限）」正下方以三欄橫向並排攤開「今年 ──› 本月 ──› 本週」，
 *     一眼對照三個時間尺度的方向是否彼此呼應（手機版採橫向滑動並排小卡，不拉長頁面高度）。
 *   - 省略「已排 N 張・済 M／排成車票」等執行細節小字，僅保留句子、路線圓牌跳轉、検印蓋済與一站式編輯入口。
 */
import { useEffect, useRef } from "react";
import {
  aimNumeral,
  currentKeyOf,
  doneCount,
  periodNavText,
  periodShortLabel,
  type ReviewPeriod,
  type WeekAimRow,
} from "../../domain/weekAims";
import { useNodeStore } from "../../store/nodeStore";
import { useWeekAimStore } from "../../store/weekAimStore";
import { IconChevron } from "../common/icons";
import { useLocalFlag } from "../common/useLocalFlag";
import { WeekAimsEditorHost } from "../weekAims/WeekAimsEditor";
import { AimStamp, RouteTag, useAimPlaceOf } from "../weekAims/parts";
import { useAimToday } from "../weekAims/useWeekAims";
import "../weekAims/weekAims.css";

const EMPTY: WeekAimRow[] = [];
const SCALES: readonly ReviewPeriod[] = ["year", "month", "week"];

export interface IdealAimsMatrixProps {
  shell: "desktop" | "mobile";
}

export function IdealAimsMatrix({ shell }: IdealAimsMatrixProps) {
  const { today, weekStart } = useAimToday();
  const flagKey = shell === "mobile" ? "ideal_aims_open_mobile" : "ideal_aims_open";
  const [open, setOpen] = useLocalFlag(flagKey, true);

  const yearKey = currentKeyOf("year", today, weekStart);
  const monthKey = currentKeyOf("month", today, weekStart);
  const weekKey = currentKeyOf("week", today, weekStart);

  const yearAims = useWeekAimStore((s) => s.weeks[yearKey]) ?? EMPTY;
  const monthAims = useWeekAimStore((s) => s.weeks[monthKey]) ?? EMPTY;
  const weekAims = useWeekAimStore((s) => s.weeks[weekKey]) ?? EMPTY;
  const placeOf = useAimPlaceOf();

  useEffect(() => {
    const st = useWeekAimStore.getState();
    void st.loadSettings();
    void st.loadWeek(yearKey);
    void st.loadWeek(monthKey);
    void st.loadWeek(weekKey);
  }, [yearKey, monthKey, weekKey]);

  const routes = useNodeStore((s) => s.routes);
  const firstRoutes = useRef(true);
  useEffect(() => {
    if (firstRoutes.current) {
      firstRoutes.current = false;
      return;
    }
    const t = window.setTimeout(() => void useWeekAimStore.getState().refreshAimNodes(), 250);
    return () => window.clearTimeout(t);
  }, [routes]);

  const openEditor = (key: string) => {
    useWeekAimStore.getState().openEditor(key);
  };

  const columns: { period: ReviewPeriod; key: string; aims: WeekAimRow[] }[] = SCALES.map((p) => ({
    period: p,
    key: p === "year" ? yearKey : p === "month" ? monthKey : weekKey,
    aims: p === "year" ? yearAims : p === "month" ? monthAims : weekAims,
  }));

  return (
    <section className="ns-ideal-sec ns-ideal-aims-sec" aria-label="行路對照">
      <div className="ns-ideal-aims-headbar">
        <div className="ns-ideal-sec-head">
          <h2 className="ns-ideal-sec-title">行路對照</h2>
          <span className="ns-ideal-sec-note">
            今年 ──› 本月 ──› 本週 · 橫向對照日常步伐與終點站的風景
          </span>
        </div>

        <div className="ns-ideal-aims-actions">
          <button
            type="button"
            className="ns-btn btn-ghost"
            onClick={() => openEditor(weekKey)}
          >
            ✎ 一站式改方針
          </button>
          <button
            type="button"
            className="ns-btn btn-text ns-ideal-aims-foldbtn"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            <span>{open ? "收合" : "展開"}</span>
            <span className={`ns-ideal-aims-chev${open ? " is-open" : ""}`} aria-hidden>
              <IconChevron size={12} />
            </span>
          </button>
        </div>
      </div>

      {open && (
        <div className="ns-ideal-aims-grid">
          {columns.map(({ period, key, aims }) => {
            const label = periodShortLabel(key, today, weekStart);
            const range = periodNavText(key);
            const { done, total } = doneCount(aims);
            return (
              <article key={period} className="techo-card ns-ideal-aim-col">
                <header className="ns-ideal-aim-col-head">
                  <div className="ns-ideal-aim-col-titlewrap">
                    <span className="ns-ideal-aim-col-scale">{label}</span>
                    <span className="ns-ideal-aim-col-range">{range}</span>
                  </div>
                  <div className="ns-ideal-aim-col-meta">
                    {total > 0 && (
                      <span className="ns-ideal-aim-col-count">
                        済 {done}/{total}
                      </span>
                    )}
                    <button
                      type="button"
                      className="ns-ideal-aim-col-edit"
                      onClick={() => openEditor(key)}
                      title={`編輯${label}方針`}
                    >
                      {total > 0 ? "改" : "＋ 寫"}
                    </button>
                  </div>
                </header>

                {aims.length === 0 ? (
                  <div className="ns-ideal-aim-empty">
                    <span>還沒寫{label}的方針</span>
                    <button
                      type="button"
                      className="ns-btn btn-text"
                      onClick={() => openEditor(key)}
                    >
                      ＋ 寫{label}方針
                    </button>
                  </div>
                ) : (
                  <ol className="ns-ideal-aim-list">
                    {aims.map((aim, idx) => {
                      const place = placeOf(aim.node_id);
                      const isDone = aim.done_at !== null;
                      return (
                        <li
                          key={aim.id}
                          className={`ns-ideal-aim-row${isDone ? " is-done" : ""}`}
                        >
                          <span className="ns-ideal-aim-num" aria-hidden>
                            {aimNumeral(idx)}
                          </span>
                          <div className="ns-ideal-aim-main">
                            <span className="ns-ideal-aim-text">{aim.text}</span>
                            {place && <RouteTag place={place} shell={shell} />}
                          </div>
                          <AimStamp aim={aim} />
                        </li>
                      );
                    })}
                  </ol>
                )}
              </article>
            );
          })}
        </div>
      )}

      <WeekAimsEditorHost today={today} weekStart={weekStart} />
    </section>
  );
}
