/**
 * RestartPanel——改出發時間面板（車次①a 契約 §5.4；丙席；＝原型 `shared.js` openRestartSheet）。
 * 副標「往前挪會把前一塊切短，中間不留重疊」；「発車」stepper −30／−5／HH:MM／+5／+30＋右側「已跑 Xh」；
 * 會蓋掉時赭字 W1；「取消」「改好了」。只對運行中那一班（store.restart 之外的塊 repository 會丟 RangeError）。
 */
import { useState } from "react";
import { MIN, fmtDur, msOf } from "../../../domain/timetable";
import { useTimetableStore } from "../../../store/timetableStore";
import { Actions, Row, Stepper, Sub, clamp, useBlock, useCoverWarn, useNowOnce, type PanelProps } from "./controls";

export function RestartPanel({ onDone }: PanelProps) {
  const now = useNowOnce();
  const sheet = useTimetableStore((s) => s.sheet);
  const blockId = sheet?.kind === "restart" ? sheet.blockId : "";
  const block = useBlock(blockId);
  const restart = useTimetableStore((s) => s.restart);

  const start = block ? msOf(block.started_at) : now;
  // 上限＝現在−1 分；剛発車不到一分鐘時以實際開始為上限（否則初值被夾成比開始更早、「改好了」沒禁用就會默默往前挪）
  const hi = Math.max(start, now - MIN);
  const lo = Math.min(start, hi) - 24 * 60 * MIN; // 往前最多一天（再早就該用補記）
  const [at, setAt] = useState<number>(() => clamp(start, lo, hi));
  const warn = useCoverWarn(at, null, blockId || null, block !== null && at < start);

  if (!block) {
    return (
      <div className="ns-tt-panel">
        <Sub>這一班已經不在了</Sub>
        <Actions>
          <button type="button" className="ns-btn btn-ghost" onClick={onDone}>
            關閉
          </button>
        </Actions>
      </div>
    );
  }

  return (
    <div className="ns-tt-panel ns-tt-panel-restart">
      <Sub>往前挪會把前一塊切短，中間不留重疊</Sub>
      <Row k="発車">
        <Stepper value={at} steps={[-30, -5, 5, 30]} lo={lo} hi={hi} onChange={setAt} label="出發時刻" />
        <span className="ns-tt-opt is-solid is-num is-static">已跑 {fmtDur(now - at)}</span>
      </Row>
      {warn && <Sub warn>{warn}</Sub>}
      <Actions>
        <button type="button" className="ns-btn btn-ghost" onClick={onDone}>
          取消
        </button>
        <button
          type="button"
          className="ns-btn btn-seal"
          disabled={at === start}
          onClick={() => {
            onDone();
            void restart(block.id, at);
          }}
        >
          改好了
        </button>
      </Actions>
    </div>
  );
}
