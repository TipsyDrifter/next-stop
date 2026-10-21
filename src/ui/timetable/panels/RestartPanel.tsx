/**
 * RestartPanel——改出發時間面板（車次①a 契約 §5.4；丙席；＝原型 `shared.js` openRestartSheet）。
 * 副標「往前挪會把前一塊切短，中間不留重疊」；「発車」stepper（磨光⑥ 起五處同一排、可打字）＋「已跑 Xh」（桌機換到下一行）；
 * 會蓋掉時赭字 W1；「取消」「改好了」。只對運行中那一班（store.restart 之外的塊 repository 會丟 RangeError）。
 *
 * 磨光⑤ §8（D-主-65、66）：
 * - 乙′「改好了」不再用 disabled 表達「沒改」：打了字還沒離開框時，值要等失焦才提交，鈕看起來反灰、點下去卻照樣生效
 *   （使用者 10-21）。現在一律可按：按下先 clockDraftsOk（剛打錯的框擋下）、再把框裡的草稿提交（flush；打錯＝不送），
 *   值跟原本一樣 ⇒ 等同關閉。
 * - 甲′ 框下寫日期（參考日＝這一班開始那天）：往前調到前一晚看得到前一天的日期（赭）。
 */
import { useRef, useState } from "react";
import { MIN, fmtDur, msOf } from "../../../domain/timetable";
import { useTimetableStore } from "../../../store/timetableStore";
import { Actions, Row, Stepper, Sub, clamp, clockDraftsOk, useBlock, useCoverWarn, useNowOnce, usePanelRefDay, type PanelProps } from "./controls";
import type { ClockInputHandle } from "./ClockInput";

export function RestartPanel({ onDone }: PanelProps) {
  const now = useNowOnce();
  const sheet = useTimetableStore((s) => s.sheet);
  const blockId = sheet?.kind === "restart" ? sheet.blockId : "";
  const block = useBlock(blockId);
  const restart = useTimetableStore((s) => s.restart);

  const start = block ? msOf(block.started_at) : now;
  // 上限＝現在−1 分；剛発車不到一分鐘時以實際開始為上限（否則初值被夾成比開始更早、沒動就按「改好了」會默默往前挪）
  const hi = Math.max(start, now - MIN);
  const lo = Math.min(start, hi) - 24 * 60 * MIN; // 往前最多一天（再早就該用補記）
  const [at, setAt] = useState<number>(() => clamp(start, lo, hi));
  const warn = useCoverWarn(at, null, blockId || null, block !== null && at < start);
  const refDay = usePanelRefDay(start);
  const clock = useRef<ClockInputHandle | null>(null);

  // 面板開著時這一班到站了（別台換車／到着、系統匣換車，同步拉到）⇒ 已經不是運行中那一班，不再給改（沙盒 S9）
  if (!block || block.ended_at !== null) {
    return (
      <div className="ns-tt-panel">
        <Sub>找不到這一班</Sub>
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
      <Sub>往前調會自動縮短前一段，不會重疊</Sub>
      <Row k="発車" time>
        <Stepper value={at} lo={lo} hi={hi} onChange={setAt} label="出發時刻" refDay={refDay} handleRef={clock} />
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
          // 磨光⑤ 自測：桌機面板往下長——打了字直接按「改好了」時，mousedown 先讓框失焦提交草稿、上面冒出「會切短／蓋掉 N 塊」那行，
          // 鈕被擠下去一行，mouseup 落在鈕外、這一下 click 被吃掉（手機面板往上長沒事）。按下時不搶焦點，草稿交給下面的 flush 提交。
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            if (!clockDraftsOk(e.currentTarget)) return;
            // 失焦時合法的草稿已套用；點按不給焦點的引擎（框沒失焦）在這裡補提交。打錯 ⇒ flush 已還原＋抖＋說明，不送
            const v = clock.current ? clock.current.flush() : at;
            if (v === null) return;
            onDone();
            if (v !== start) void restart(block.id, v);
          }}
        >
          改好了
        </button>
      </Actions>
    </div>
  );
}
