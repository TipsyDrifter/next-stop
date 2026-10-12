/**
 * SplitPanel——切開這一塊面板（車次①a 契約 §5.4；丙席；＝原型 `shared.js` openSplitSheet）。
 * 副標「HH:MM – HH:MM　{分類}」；「切在」stepper −30／−5／HH:MM／+5／+30（預設中點，夾在開頭+1 分與尾端−1 分之間）；
 * 「前段 Xh・{分類}　｜　後段 Xh・{分類}」；「後段是什麼」＋分類格 compact（預設＝原分類）；「取消」「切開」。
 * 運行中的塊切開後後段仍運行中（repository 的 planSplit）。
 */
import { useState } from "react";
import { MIN, fmtClock, fmtDur, msOf } from "../../../domain/timetable";
import { useTimetableStore } from "../../../store/timetableStore";
import { CategoryGrid } from "../parts/CategoryGrid";
import { Actions, Row, Stepper, Sub, clamp, useBlock, useNowOnce, type PanelProps } from "./controls";

export function SplitPanel({ onDone }: PanelProps) {
  const now = useNowOnce();
  const sheet = useTimetableStore((s) => s.sheet);
  const blockId = sheet?.kind === "split" ? sheet.blockId : "";
  const block = useBlock(blockId);
  const catById = useTimetableStore((s) => s.catById);
  const split = useTimetableStore((s) => s.split);

  const start = block ? msOf(block.started_at) : now;
  const end = block ? (block.ended_at ? msOf(block.ended_at) : now) : now;
  const lo = start + MIN;
  const hi = Math.max(lo, end - MIN);
  const [at, setAt] = useState<number>(() => clamp(Math.round((start + end) / 2 / MIN) * MIN, lo, hi));
  const [cat2, setCat2] = useState<string>(block?.category_id ?? "");

  if (!block) {
    return (
      <div className="ns-tt-panel">
        <Sub>這一塊已經不在了</Sub>
        <Actions>
          <button type="button" className="ns-btn btn-ghost" onClick={onDone}>
            關閉
          </button>
        </Actions>
      </div>
    );
  }

  const name1 = catById[block.category_id]?.name ?? "？";
  const name2 = catById[cat2]?.name ?? "？";
  const tooShort = end - start < 2 * MIN;

  return (
    <div className="ns-tt-panel ns-tt-panel-split">
      <Sub num>
        {fmtClock(start)} – {fmtClock(end)}　{name1}
        {block.ended_at === null && "（運行中）"}
      </Sub>
      {tooShort ? (
        <Sub warn>這一塊不到兩分鐘，切不開</Sub>
      ) : (
        <>
          <Row k="切在">
            <Stepper value={at} steps={[-30, -5, 5, 30]} lo={lo} hi={hi} onChange={setAt} label="切點" />
          </Row>
          <Sub>
            前段 {fmtDur(at - start)}・{name1}　｜　後段 {fmtDur(end - at)}・{name2}
          </Sub>
          <Sub>後段是什麼</Sub>
          <CategoryGrid selected={cat2} onPick={setCat2} compact />
        </>
      )}
      <Actions>
        <button type="button" className="ns-btn btn-ghost" onClick={onDone}>
          取消
        </button>
        <button
          type="button"
          className="ns-btn btn-seal"
          disabled={tooShort || !cat2}
          onClick={() => {
            onDone();
            void split(block.id, at, cat2);
          }}
        >
          切開
        </button>
      </Actions>
    </div>
  );
}
