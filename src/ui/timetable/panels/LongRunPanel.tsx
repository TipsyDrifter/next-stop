/**
 * LongRunPanel——「其實到幾點」面板（車次①a 契約 §5.4、§5.5；丙席；＝原型 `shared.js` openOverdueSheet）。
 * 副標「平常大約 {門檻}。其實到幾點？」（門檻來自全域時：「已經超過 {門檻} 的保險上限。其實到幾點？」）；
 * 「到着」stepper（磨光⑥ 起五處同一排：−1h −15 −5 −1｜可打字的框｜+1 +5 +15 +1h；夾 [開始+1 分, 上限−1 分]，預設 `longRunDefaultEnd`）；
 * 「之後」三 chips：「沒記到，留白」「其實在做別的…」「還在{分類}，別問了」（已結束的塊第三項改「沒錯，就是這麼久」）；
 * 選「其實在做別的」時展開分類格；底部說明 L1–L3；主鈕「就這樣」（keep 時「知道了」）。
 *
 * 確認走 `store.resolveLongRun`——它成功後自己收 sheet、依 `then` 接續；**不**先叫 onDone（那會被當成「略過」）。
 * 標題由 host 給：「{分類}已經跑了 {fmtDur}」（前置 live dot）。
 *
 * 車次①b（①b①c 契約 §5.5）：門檻改成 `thresholdOf(這一班的預估, 分類, 保險上限)`；門檻來自預估時副標改寫
 * 「預估 {門檻}，已經誤點 {超過}。其實到幾點？」、「別問了」的說明改成留『誤點』記號。
 *
 * 車次②（② 契約 §4.2-6 #9、§5.11；乙席）：門檻多一層任務的預計時間（`taskEstimateOf(block, linkInfo)`，預估之後、分類之前）；
 * 來源是 task ⇒ 副標「『{任務}』預計 {門檻}，已經誤點 {超過}。其實到幾點？」（estimate 那條的姊妹句），「別問了」一樣留『誤點』。
 */
import { useState, type MouseEvent } from "react";
import { MIN, durOf, fmtClock, fmtDur, blockThresholdOf, longRunDefaultEnd, msOf, toSpan, type LongRunChoice } from "../../../domain/timetable";
import { linkLabelOf, taskEstimateOf } from "../../../domain/timetableLink";
import { TT_TEXT, useTimetableStore } from "../../../store/timetableStore";
import { CategoryGrid } from "../parts/CategoryGrid";
import { Actions, Opt, Opts, Row, Stepper, Sub, clamp, clockDraftsOk, useBlock, useNowOnce, usePanelRefDay, type PanelProps } from "./controls";

export function LongRunPanel({ onDone }: PanelProps) {
  const now = useNowOnce();
  const sheet = useTimetableStore((s) => s.sheet);
  const blockId = sheet?.kind === "longRun" ? sheet.blockId : "";
  const block = useBlock(blockId);
  const catById = useTimetableStore((s) => s.catById);
  const longRunMaxMin = useTimetableStore((s) => s.longRunMaxMin);
  const resolveLongRun = useTimetableStore((s) => s.resolveLongRun);
  const linkInfo = useTimetableStore((s) => s.linkInfo);

  const cat = block ? (catById[block.category_id] ?? null) : null;
  const span = block ? toSpan(block) : null;
  const th = block ? blockThresholdOf(block.ended_at !== null, block.estimate_min, cat, longRunMaxMin, taskEstimateOf(block, linkInfo)) : null;
  const threshold = th?.min ?? null;
  const ended = block !== null && block.ended_at !== null;
  const cap = block ? (block.ended_at !== null ? msOf(block.ended_at) : now) : now;
  const lo = span ? span.start + MIN : 0;
  const hi = Math.max(lo, cap - MIN);

  const [end, setEnd] = useState<number>(() =>
    span ? clamp(threshold !== null ? longRunDefaultEnd(span, threshold, now) : Math.round((span.start + cap) / 2 / MIN) * MIN, lo, hi) : 0,
  );
  const [after, setAfter] = useState<LongRunChoice>("gap");
  const [cat2, setCat2] = useState<string | null>(null);
  // 磨光⑤ 甲′：到着框下的日期跟這一班開始那天比（跑過夜的那班，到着在隔天＝赭）
  const refDay = usePanelRefDay(span ? span.start : now);

  if (!block || !span) {
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

  const name = cat?.name ?? "？";
  const untilText = ended ? fmtClock(cap) : "現在";
  const sp = ended ? " " : ""; // 時刻前後留空格、「現在」不留
  const note =
    after === "gap"
      ? `${fmtClock(end)} 到${sp}${untilText}${sp}會留白，之後隨時能補記。`
      : after === "cat"
        ? `${fmtClock(end)} 到${sp}${untilText}算成新選的分類。`
        : th?.source === "estimate" || th?.source === "task"
          ? "這一班照跑；軸上會留一個『誤點』的記號。"
          : "這一班照跑；軸上會留一個『長時間運行』的記號。";

  const confirm = (e: MouseEvent<HTMLButtonElement>): void => {
    if (!clockDraftsOk(e.currentTarget)) return;
    void resolveLongRun(block.id, end, after, after === "cat" ? (cat2 ?? undefined) : undefined);
  };

  return (
    <div className="ns-tt-panel ns-tt-panel-longrun">
      <Sub>
        {th === null
          ? "其實到幾點？"
          : th.source === "estimate"
            ? `預估 ${fmtDur(th.min * MIN)}，已經誤點 ${fmtDur(Math.max(0, durOf(span, now) - th.min * MIN))}。其實到幾點？`
            : th.source === "task"
              ? TT_TEXT.LONG_RUN_TASK(
                  linkLabelOf(block, linkInfo) ?? "任務",
                  fmtDur(th.min * MIN),
                  fmtDur(Math.max(0, durOf(span, now) - th.min * MIN)),
                )
              : th.source === "category"
              ? `平常大約 ${fmtDur(th.min * MIN)}。其實到幾點？`
              : `已經連續跑超過 ${fmtDur(th.min * MIN)} 了。其實到幾點？`}
        <span className="ns-tt-panel-sub-aside">（已跑 {fmtDur(durOf(span, now))}）</span>
      </Sub>
      <Row k="到着" time>
        <Stepper value={end} lo={lo} hi={hi} onChange={setEnd} label="到着時刻" refDay={refDay} />
      </Row>
      <Row k="之後" top>
        <Opts>
          <Opt on={after === "gap"} onClick={() => setAfter("gap")}>
            沒記到，留白
          </Opt>
          <Opt on={after === "cat"} onClick={() => setAfter("cat")}>
            其實在做別的…
          </Opt>
          <Opt on={after === "keep"} onClick={() => setAfter("keep")}>
            {ended ? "沒錯，就是這麼久" : `還在${name}，繼續跑`}
          </Opt>
        </Opts>
      </Row>
      {after === "cat" && <CategoryGrid selected={cat2} onPick={setCat2} compact />}
      <Sub>{note}</Sub>
      <Actions>
        <button type="button" className="ns-btn btn-seal" onClick={confirm}>
          {after === "keep" ? "知道了" : "就這樣"}
        </button>
      </Actions>
    </div>
  );
}
