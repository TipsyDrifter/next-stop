/**
 * DepartPanel——発車／換車面板（車次①a 契約 §5.4；丙席；＝原型 `shared.js` openDepartSheet，拿掉「綁車票」）。
 * 副標（運行中：「『X』會在出發時間自動到站，中間不留空白」／停車中：「點分類就開始計時」）；
 * 「出發」chips：現在／5 分前／10 分前／20 分前／停車中且上一塊尾 < 現在時加「接上一塊 HH:MM」；右側「＝ HH:MM」；
 * 選的時間會蓋掉紀錄時多一行赭字（W1）；分類格 compact，點了即 `store.depart(cat, at)`。
 * 標題由 host 給（運行中：「換車——接下來做什麼？」／停車中：「発車——接下來做什麼？」）。
 *
 * 「現在」以**點下分類那一刻**為準（契約 §5.4；原型 openDepartSheet 每次 draw() 重算 now）：面板開著停幾分鐘再點，
 * 「現在」仍是現在，store.depart 的「出發＝現在 ⇒ 帶『改 10 分前』」判定才對。畫面上的「＝ HH:MM」與 W1 預演用
 * 分鐘級的 now（每秒跟著跳、但一分鐘才換一次值，避免每秒重問 previewCover）。
 *
 * 車次①b（①b①c 契約 §5.3；乙席；長相＝原型 `v-e.js` 情境 5 departBody）：「出發」那一列之後放「預估」，預設收起：
 *   收起＝button.ns-tt-opt.ns-tt-est-open「＋預估」＋一行小字；
 *   展開＝Row k="預估"：30 分｜1h｜1h30｜2h｜3h（單選、再點一次＝取消）＋「收起」（選了之後叫「不預估」，按了清掉並收起）。
 * 選了預估時「＝ HH:MM」後面多「預計 HH:MM 到着」。點分類＝`depart(id, at, estimateMin)`；收起／沒選＝null；面板關掉不記住。
 */
import { useState } from "react";
import { MIN, fmtClock, msOf } from "../../../domain/timetable";
import { TT_TEXT, useTimetableStore } from "../../../store/timetableStore";
import { useUiStore } from "../../../store/uiStore";
import { CategoryGrid } from "../parts/CategoryGrid";
import { useNow } from "../useNow";
import { ESTIMATE_OPTIONS, Expand, Opt, Opts, Row, Sub, useCoverWarn, type PanelProps } from "./controls";

export type { PanelProps } from "./controls";

type Back = 0 | 5 | 10 | 20 | "prev";
const BACKS: readonly [Exclude<Back, "prev">, string][] = [
  [0, "現在"],
  [5, "5 分前"],
  [10, "10 分前"],
  [20, "20 分前"],
];

export function DepartPanel({ onDone }: PanelProps) {
  const tick = useNow(1000);
  const now = Math.floor(tick / MIN) * MIN; // 分鐘級：顯示與 W1 預演用
  const running = useTimetableStore((s) => s.running);
  const catById = useTimetableStore((s) => s.catById);
  const todayBlocks = useTimetableStore((s) => s.todayBlocks);
  const depart = useTimetableStore((s) => s.depart);
  const [back, setBack] = useState<Back>(0);
  const [estOpen, setEstOpen] = useState(false);
  const [est, setEst] = useState<number | null>(null);

  // 上一塊的尾巴（停車中的「接上一塊」）：今天已結束的塊裡結束最晚的那一塊
  let prevEnd: number | null = null;
  if (!running) {
    for (const b of todayBlocks) {
      if (b.ended_at === null) continue;
      const e = msOf(b.ended_at);
      if (e < tick && (prevEnd === null || e > prevEnd)) prevEnd = e;
    }
  }
  const effectiveBack: Back = back === "prev" && prevEnd === null ? 0 : back;
  const atOf = (base: number): number => (effectiveBack === "prev" ? (prevEnd as number) : base - effectiveBack * MIN);
  const at = atOf(now);
  // 運行中那班「在出發時間自動到站」是預期行為（副標已說），不算 W1 的「切短」；出發早於它的開始時它會被收掉，仍要算
  const runningStart = running ? msOf(running.started_at) : null;
  const exceptId = running && runningStart !== null && at >= runningStart ? running.id : null;
  const warn = useCoverWarn(at, null, exceptId, at < tick - MIN / 2);

  const pick = (id: string): void => {
    if (running && running.category_id === id) {
      useUiStore.getState().showToast({ message: TT_TEXT.alreadyRunning });
      return;
    }
    const atNow = atOf(Date.now()); // 以點下的這一刻為準
    onDone();
    void depart(id, atNow, estOpen ? est : null);
  };
  const estOn = estOpen && est !== null;

  return (
    <div className="ns-tt-panel ns-tt-panel-depart">
      <Sub>{running ? `「${catById[running.category_id]?.name ?? "？"}」會在出發時間自動到站，中間不留空白` : "點分類就開始計時"}</Sub>
      <Row k="出發" top>
        <Opts>
          {BACKS.map(([v, t]) => (
            <Opt key={v} on={effectiveBack === v} onClick={() => setBack(v)}>
              {t}
            </Opt>
          ))}
          {prevEnd !== null && (
            <Opt on={effectiveBack === "prev"} onClick={() => setBack("prev")}>
              接上一塊 {fmtClock(prevEnd)}
            </Opt>
          )}
          <span className="ns-tt-opt is-solid is-num is-static" aria-live="polite">
            ＝ {fmtClock(at)}
            {estOn && <span className="ns-tt-est-eta">　預計 {fmtClock(at + (est as number) * MIN)} 到着</span>}
          </span>
        </Opts>
      </Row>
      {estOpen ? (
        <Expand className="ns-tt-est-wrap">
          <Row k="預估" top>
            <Opts>
              {ESTIMATE_OPTIONS.map(([v, t]) => (
                <Opt key={v} on={est === v} onClick={() => setEst(est === v ? null : v)}>
                  {t}
                </Opt>
              ))}
              <button
                type="button"
                className="ns-tt-opt is-link"
                onClick={() => {
                  setEst(null);
                  setEstOpen(false);
                }}
              >
                {est !== null ? "不預估" : "收起"}
              </button>
            </Opts>
          </Row>
        </Expand>
      ) : (
        <div className="ns-tt-row is-fold">
          <span className="ns-tt-row-k" />
          <span className="ns-tt-row-v">
            <button type="button" className="ns-tt-opt ns-tt-est-open" onClick={() => setEstOpen(true)}>
              ＋預估
            </button>
            <span className="ns-tt-est-hint">想給這一班一個長度再點；超過了會提醒</span>
          </span>
        </div>
      )}
      {warn && <Sub warn>{warn}</Sub>}
      <CategoryGrid selected={null} onPick={pick} compact runningId={running?.category_id ?? null} />
    </div>
  );
}
