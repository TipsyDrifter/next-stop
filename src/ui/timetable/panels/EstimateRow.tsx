/**
 * EstimateRow——「預估」一列（v1.32 2A-2；発車／換車面板與「改這一班」共用）。
 *   Row k="預估"：統一改用全站共用的「時 × 分雙排時長挑選器」`DurationPicker`（點兩下秒組時長＋智慧輸入框）＋ extra（発車面板的「收起／不預估」）。
 *   傳入 `liveCommit` 確保打字當下即同步更新父面板草稿，按 Esc 還原開啟焦點前的值並攔截冒泡（不讓外層面板跟著關）。
 */
import type { ReactNode } from "react";
import { CLOCK_SPAN_MAX_MIN } from "../../../domain/clockSpan";
import { MIN, fmtClock } from "../../../domain/timetable";
import { ClockInput } from "../../common/ClockInput";
import { DurationPicker } from "../../common/DurationPicker";
import { arrivalMsFromEst, estMinFromArrivalMs } from "../../common/timespan/TimeSpanDurationFields";
import { Row } from "./controls";

export function EstimateRow({
  value,
  onChange,
  extra,
  startMs,
  refDay,
}: {
  value: number | null;
  onChange(next: number | null): void;
  extra?: ReactNode;
  /** 操作 10（D-FB-3）：傳入出發時刻毫秒時，同步提供「預計到着時刻」ClockInput 與預估時長雙向互推 */
  startMs?: number;
  refDay?: string;
}) {
  return (
    <>
      <Row k="預估" top>
        <DurationPicker value={value} onChange={onChange} liveCommit extra={extra} showClear={!extra} ariaLabel="預估" />
      </Row>
      {startMs !== undefined && (
        <Row k="預計到着" time={value !== null}>
          {value !== null ? (
            <ClockInput
              variant="compact"
              value={arrivalMsFromEst(startMs, value)}
              lo={startMs + MIN}
              hi={startMs + CLOCK_SPAN_MAX_MIN * MIN}
              onChange={(arrMs) => onChange(estMinFromArrivalMs(startMs, arrMs))}
              label="預計到着時刻"
              refDay={refDay}
            />
          ) : (
            <button
              type="button"
              className="ns-tt-opt is-solid"
              data-tt-drop-draft=""
              onClick={() => onChange(60)}
            >
              ＋ 設預計到着（預設 {fmtClock(startMs + 60 * MIN)}）
            </button>
          )}
        </Row>
      )}
    </>
  );
}
