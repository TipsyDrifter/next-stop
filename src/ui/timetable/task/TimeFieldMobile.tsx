/**
 * TimeFieldMobile——手機路線圖唯讀詳情的「時間」一列（車次② 契約 §5.6、0-12；丙）。
 * `nodeFields` 插槽的 `Mobile`：自己畫 `dt`／`dd`（照 `MobileRouteMap.tsx` RowDetail 的既有插槽；外觀對齊 `.m2-field`
 * 的 52px 標籤欄，但不借核心 class——同旅客筆記的 `.ns-notes-mdetailrow`）。
 *
 *   dl.ns-tt-time-m > dt「時間」＋dd > button.ns-tt-time-val（合計＋運行中小點＋▾）＋div.ns-tt-time-det（點開：自己／底下）
 *
 * - 列車、車廂點開多一個手填輸入（〈原型拍板〉3：車票沒有；路線圖其他欄唯讀，時間的手填部分例外——原型 mDetailHtml）。
 * - 路線（③ D-時-53、§5.6；丙席）：路線圖抬頭下一行「時間　本月 3h・累計 41h20m」（＝桌機 `TT_TEXT.ROUTE_TIME`）；
 *   點開看自己／底下（同桌機的滑過字，手機沒有滑過 ⇒ 點開）。路線沒有手填欄，展開只列兩行數字。
 */
import { useId, useState } from "react";
import type { NodeRow } from "../../../domain/node";
import { TT_TEXT } from "../../../store/timetableStore";
import { fmtTaskDur } from "./taskState";
import { TimeDetail } from "./TimeField";
import { useLinkedTime } from "./useLinkedTime";
import "../timetable.css";

export function TimeFieldMobile({ node }: { node: NodeRow }) {
  return <TimeFieldMobileRow node={node} />;
}

function TimeFieldMobileRow({ node }: { node: NodeRow }) {
  const t = useLinkedTime(node);
  const [open, setOpen] = useState(false);
  const uid = useId();
  const isRoute = node.kind === "route";
  const total = !t.ready
    ? "…"
    : isRoute
      ? TT_TEXT.ROUTE_TIME(fmtTaskDur(t.monthMs ?? 0), fmtTaskDur(t.totalMs))
      : fmtTaskDur(t.totalMs);
  return (
    <dl className={"ns-tt-time-m" + (isRoute ? " is-route" : "")}>
      <dt>{TT_TEXT.TIME_LABEL}</dt>
      <dd>
        <button
          type="button"
          className={"ns-tt-time-val" + (open ? " is-open" : "")}
          aria-expanded={open}
          aria-controls={`${uid}-det`}
          aria-label={`${TT_TEXT.TIME_LABEL} ${total}；${TT_TEXT.TIME_HOVER(fmtTaskDur(t.selfMs), fmtTaskDur(t.belowMs))}`}
          onClick={() => setOpen((o) => !o)}
        >
          {isRoute ? (
            <span className="ns-tt-time-route ns-tt-num">{total}</span>
          ) : (
            <b className="ns-tt-time-total ns-tt-num">{total}</b>
          )}
          {t.running && <span className="ns-tt-live-dot" aria-hidden="true" />}
          <span className="ns-tt-time-caret" aria-hidden="true">
            ▾
          </span>
        </button>
        <div className={"ns-tt-time-det" + (open ? " is-open" : "")} id={`${uid}-det`} inert={!open}>
          <div>
            <TimeDetail node={node} t={t} />
          </div>
        </div>
      </dd>
    </dl>
  );
}
