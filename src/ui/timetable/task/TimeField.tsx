/**
 * TimeField——桌機任務側板／路線側板的「時間」列內容（車次② 契約 §5.6、§5.7、0-6、0-12；丙）。
 * 標籤「時間」由 `LineRows`（`FieldRow`）畫；這裡只畫值。長相照原型 `prototypes/時刻表-src/v-f.js` timeBlock／routeTimeBlock。
 *
 *   button.ns-tt-time-val[aria-expanded]
 *     ├ b.ns-tt-time-total（合計；0＝「—」）｜路線：span.ns-tt-time-route（ROUTE_TIME「本月 3h・累計 41h20m」）
 *     ├ span.ns-tt-live-dot（有運行中那班在範圍裡）
 *     ├ span.ns-tt-time-caret「▾」
 *     └ span.ns-tt-time-tip（滑過浮出：TIME_HOVER「自己 1h／底下 2h20m」；展開時不出）
 *   div.ns-tt-time-det[.is-open] > div > div.ns-tt-time-in（grid-rows 0fr→1fr 展開）
 *     ├ div.ns-tt-time-row「自己 N」＋小字「時間塊 X」（列車、車廂多「＋手填 [NumberField] 分」）
 *     └ div.ns-tt-time-row「底下 M」
 *
 * - 手填（期初值）只有列車、車廂能改（〈原型拍板〉3：車票不給手填；支線、路線本來就沒有「花費」欄）；
 *   改＝`nodeStore.updateNode(node.id, { time_spent_min })`（核心 store 的公開動作）。不能改的節點手填有值照樣算、照樣列出。
 * - 路線：顯示本月／累計；滑過＝累計的自己（只連路線的塊＋路線自己的手填）／底下。
 */
import { useId, useState } from "react";
import type { NodeRow } from "../../../domain/node";
import { MIN } from "../../../domain/timetable";
import { useNodeStore } from "../../../store/nodeStore";
import { TT_TEXT } from "../../../store/timetableStore";
import { useUiStore } from "../../../store/uiStore";
import { NumberField } from "../../panel/fields";
import { fmtTaskDur } from "./taskState";
import { useLinkedTime, type LinkedTime } from "./useLinkedTime";
import "../timetable.css";

/** 手填可以改的種類（〈原型拍板〉3） */
export const MANUAL_KINDS: readonly string[] = ["train", "car"];

/** 改手填（兩殼共用）：被核心擋下 ⇒ toast 它的一句話 */
export async function commitManual(nodeId: string, v: number | null): Promise<void> {
  const r = await useNodeStore.getState().updateNode(nodeId, { time_spent_min: v });
  if (!r.ok && r.reason) useUiStore.getState().showToast({ message: r.reason });
}

/** 展開後的兩行（兩殼共用）：自己＝時間塊＋手填、底下 */
export function TimeDetail({ node, t }: { node: NodeRow; t: LinkedTime }) {
  const editable = MANUAL_KINDS.includes(node.kind);
  const manualMs = (t.manualMin ?? 0) * MIN;
  const blocksMs = Math.max(0, t.selfMs - manualMs);
  return (
    <div className="ns-tt-time-in">
      <div className="ns-tt-time-row">
        <span className="ns-tt-time-k">自己</span>
        <b className="ns-tt-num">{fmtTaskDur(t.selfMs)}</b>
        <span className="ns-tt-time-f">
          {TT_TEXT.TIME_BLOCKS(fmtTaskDur(blocksMs))}
          {editable ? (
            <>
              ＋{TT_TEXT.TIME_MANUAL}
              <span className="ns-tt-time-man">
                <NumberField
                  value={t.manualMin}
                  onCommit={(v) => void commitManual(node.id, v)}
                  ariaLabel={`${TT_TEXT.TIME_MANUAL}（分）`}
                  unit="分"
                  step={5}
                  placeholder="0"
                />
              </span>
            </>
          ) : (
            manualMs > 0 && `＋${TT_TEXT.TIME_MANUAL} ${fmtTaskDur(manualMs)}`
          )}
        </span>
      </div>
      <div className="ns-tt-time-row">
        <span className="ns-tt-time-k">底下</span>
        <b className="ns-tt-num">{fmtTaskDur(t.belowMs)}</b>
      </div>
    </div>
  );
}

export function TimeField({ node }: { node: NodeRow }) {
  const t = useLinkedTime(node);
  const [open, setOpen] = useState(false);
  const uid = useId();
  const isRoute = node.kind === "route";
  const hover = TT_TEXT.TIME_HOVER(fmtTaskDur(t.selfMs), fmtTaskDur(t.belowMs));
  const value = isRoute
    ? TT_TEXT.ROUTE_TIME(fmtTaskDur(t.monthMs ?? 0), fmtTaskDur(t.totalMs))
    : fmtTaskDur(t.totalMs);

  return (
    <div className="ns-tt-time">
      <button
        type="button"
        className={"ns-tt-time-val" + (open ? " is-open" : "")}
        aria-expanded={open}
        aria-controls={`${uid}-det`}
        aria-label={`${TT_TEXT.TIME_LABEL} ${t.ready ? value : "…"}；${hover}`}
        onClick={() => setOpen((o) => !o)}
      >
        {isRoute ? (
          <span className="ns-tt-time-route ns-tt-num">{t.ready ? value : "…"}</span>
        ) : (
          <b className="ns-tt-time-total ns-tt-num">{t.ready ? value : "…"}</b>
        )}
        {t.running && <span className="ns-tt-live-dot" aria-hidden="true" />}
        <span className="ns-tt-time-caret" aria-hidden="true">
          ▾
        </span>
        {t.ready && (
          <span className="ns-tt-time-tip" aria-hidden="true">
            {hover}
          </span>
        )}
      </button>
      {/* 收起時照樣掛著（grid-rows 才有得轉）；CSS 收起時 visibility:hidden ⇒ 手填輸入框不進 Tab 順序 */}
      <div className={"ns-tt-time-det" + (open ? " is-open" : "")} id={`${uid}-det`} inert={!open}>
        <div>
          <TimeDetail node={node} t={t} />
        </div>
      </div>
    </div>
  );
}
