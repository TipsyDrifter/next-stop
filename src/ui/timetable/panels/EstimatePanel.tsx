/**
 * EstimatePanel——「這一班的預估」面板（①b①c 契約 §5.4；乙席；sheet `{ kind: "estimate", blockId }`；
 * 長相＝原型 `v-e.js` 情境 5 estBody）。從運行列的「預估 1h」／「＋預估」／（已確認過的）「誤點 +X」打開。
 *
 *   div.ns-tt-panel.ns-tt-panel-est
 *   ├ Sub「{分類}・HH:MM 発　已跑 {fmtDur}」＋（誤點時）「，誤點 +X」／（沒有預估時）「；沒預估時用{分類的預設長度｜保險上限} X」
 *   ├ Row k="預估"：30 分｜1h｜1h30｜2h｜3h（目前值 is-on；目前值不在清單時多一顆 is-on 的「{fmtDur}」；再點一次＝不選）
 *   ├ Sub（選了值時）「超過預估會在運行列與軸上標『誤點』，回來時問一聲」
 *   └ Actions：「清掉預估」（目前沒有預估時不畫）｜「取消」｜btn-seal「好」
 *
 * 確認 ⇒ onDone()；store.setEstimate(id, v)（值沒變＝只關）。運行中那班已不在（到站了、被別台換掉）⇒「這一班已經不在了」。
 *
 * 車次②（② 契約 §4.2-6 #8、§5.11；乙席）：沒預估時的 fallback 多一層任務的預計時間——
 * `thresholdOf(null, 分類, 保險上限, taskEstimateOf(block, linkInfo))`；來源是 task ⇒ 副標尾「；沒預估時用任務的預計時間 X」。
 */
import { useState } from "react";
import { MIN, durOf, fmtClock, fmtDur, msOf, thresholdOf, toSpan } from "../../../domain/timetable";
import { taskEstimateOf } from "../../../domain/timetableLink";
import { TT_TEXT, blockMarker, useTimetableStore } from "../../../store/timetableStore";
import { useNow } from "../useNow";
import { Actions, ESTIMATE_OPTIONS, Opt, Opts, Row, Sub, type PanelProps } from "./controls";

export function EstimatePanel({ onDone }: PanelProps) {
  const now = useNow(1000);
  const sheet = useTimetableStore((s) => s.sheet);
  const running = useTimetableStore((s) => s.running);
  const catById = useTimetableStore((s) => s.catById);
  const longRunMaxMin = useTimetableStore((s) => s.longRunMaxMin);
  const linkInfo = useTimetableStore((s) => s.linkInfo);
  const setEstimate = useTimetableStore((s) => s.setEstimate);
  const blockId = sheet?.kind === "estimate" ? sheet.blockId : "";
  const block = running && running.id === blockId ? running : null;
  const cur = block?.estimate_min ?? null;
  const [v, setV] = useState<number | null>(cur);

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

  const cat = catById[block.category_id] ?? null;
  const marker = blockMarker(block, catById, longRunMaxMin, now, linkInfo);
  const fallback = thresholdOf(null, cat, longRunMaxMin, taskEstimateOf(block, linkInfo));
  const opts = ESTIMATE_OPTIONS.some(([m]) => m === cur) || cur === null ? ESTIMATE_OPTIONS : [...ESTIMATE_OPTIONS, [cur, fmtDur(cur * MIN)] as const];

  const confirm = (): void => {
    onDone();
    if (v !== cur) void setEstimate(block.id, v);
  };

  return (
    <div className="ns-tt-panel ns-tt-panel-est">
      <Sub>
        {cat?.name ?? "？"}・<span className="ns-tt-num">{fmtClock(msOf(block.started_at))}</span> 発　已跑{" "}
        <span className="ns-tt-num">{fmtDur(durOf(toSpan(block), now))}</span>
        {marker.kind === "late" ? (
          <span className="ns-tt-est-late">，{TT_TEXT.late(marker.overMs)}</span>
        ) : cur === null && fallback ? (
          fallback.source === "task" ? (
            TT_TEXT.EST_FALLBACK_TASK(fmtDur(fallback.min * MIN))
          ) : (
            `；沒預估時用${fallback.source === "category" ? "分類的預設長度" : "保險上限"} ${fmtDur(fallback.min * MIN)}`
          )
        ) : null}
      </Sub>
      <Row k="預估" top>
        <Opts>
          {opts.map(([m, t]) => (
            <Opt key={m} on={v === m} onClick={() => setV(v === m ? null : m)}>
              {t}
            </Opt>
          ))}
        </Opts>
      </Row>
      {v !== null && <Sub>超過預估會在運行列與軸上標『誤點』，回來時問一聲</Sub>}
      <Actions>
        {cur !== null && (
          <button
            type="button"
            className="ns-btn btn-ghost is-aux"
            onClick={() => {
              onDone();
              void setEstimate(block.id, null);
            }}
          >
            清掉預估
          </button>
        )}
        <button type="button" className="ns-btn btn-ghost" onClick={onDone}>
          取消
        </button>
        <button type="button" className="ns-btn btn-seal" onClick={confirm}>
          好
        </button>
      </Actions>
    </div>
  );
}
