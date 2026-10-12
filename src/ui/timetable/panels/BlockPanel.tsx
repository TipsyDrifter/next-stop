/**
 * BlockPanel——補記（sheet.kind "fill"）／改一塊（"edit"）面板（車次①a 契約 §5.4；丙席；＝原型 `shared.js` openBlockSheet，
 * 拿掉綁車票與備註）。
 * 副標「HH:MM – HH:MM　・　Xh」；蓋到既有紀錄時赭字 W1；分類格 compact；
 * 「発車」stepper −5／HH:MM／+5＋「接上一塊」；「到着」stepper −5／HH:MM／+5＋「接下一塊」
 * （補記：上下界＝那段空白的兩端；改：上一塊尾／下一塊頭；到着不得晚於現在）；
 * 改的時候多「刪除」「切開」兩顆次鈕；主鈕「補上」／「改好了」。
 */
import { useState } from "react";
import { MIN, fmtClock, fmtDur, msOf } from "../../../domain/timetable";
import { TT_TEXT, useTimetableStore } from "../../../store/timetableStore";
import { useUiStore } from "../../../store/uiStore";
import { CategoryGrid } from "../parts/CategoryGrid";
import { Actions, Opt, Row, Stepper, Sub, clamp, useBlock, useCoverWarn, useNowOnce, type PanelProps } from "./controls";

export function BlockPanel({ onDone }: PanelProps) {
  const now = useNowOnce();
  const sheet = useTimetableStore((s) => s.sheet);
  const mode: "fill" | "edit" = sheet?.kind === "edit" ? "edit" : "fill";
  const blockId = sheet?.kind === "edit" ? sheet.blockId : "";
  const block = useBlock(blockId);
  const dayBlocks = useTimetableStore((s) => s.dayBlocks);
  const fill = useTimetableStore((s) => s.fill);
  const editBlock = useTimetableStore((s) => s.editBlock);
  const deleteBlock = useTimetableStore((s) => s.deleteBlock);
  const openSheet = useTimetableStore((s) => s.openSheet);

  // 初值：補記＝那段空白的兩端；改＝這一塊的起訖
  const init = (() => {
    if (sheet?.kind === "fill") return { start: sheet.start, end: Math.min(sheet.end, now), cat: null as string | null };
    if (block) return { start: msOf(block.started_at), end: block.ended_at ? msOf(block.ended_at) : now, cat: block.category_id };
    return { start: now - MIN, end: now, cat: null as string | null };
  })();
  const [start, setStart] = useState(init.start);
  const [end, setEnd] = useState(init.end);
  const [cat, setCat] = useState<string | null>(init.cat);

  // 「接上一塊／接下一塊」的目標：補記＝空白的兩端；改＝上一塊尾／下一塊頭（看的那一天裡、不含自己）
  let prevEnd: number | null = null;
  let nextStart: number | null = null;
  if (sheet?.kind === "fill") {
    prevEnd = sheet.start;
    nextStart = Math.min(sheet.end, now);
  } else if (block) {
    for (const b of dayBlocks) {
      if (b.id === block.id || b.ended_at === null) continue;
      const e = msOf(b.ended_at);
      const s0 = msOf(b.started_at);
      if (e <= init.start && (prevEnd === null || e > prevEnd)) prevEnd = e;
      if (s0 >= init.end && (nextStart === null || s0 < nextStart)) nextStart = s0;
    }
    for (const b of dayBlocks) {
      // 運行中的下一班（例：改的是剛到站的那一塊、接著又發車）
      if (b.id === block.id || b.ended_at !== null) continue;
      const s0 = msOf(b.started_at);
      if (s0 >= init.end && (nextStart === null || s0 < nextStart)) nextStart = s0;
    }
  }

  const exceptId = mode === "edit" && block ? block.id : null;
  const changed = start !== init.start || end !== init.end;
  const warn = useCoverWarn(start, end, exceptId, mode === "fill" ? changed || start < init.start || end > init.end : changed);

  if (mode === "edit" && !block) {
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

  const setStartClamped = (v: number): void => setStart(clamp(v, 0, end - MIN));
  const setEndClamped = (v: number): void => setEnd(clamp(v, start + MIN, now));

  const submit = (): void => {
    if (!cat) {
      useUiStore.getState().showToast({ message: TT_TEXT.pickCategory });
      return;
    }
    onDone();
    if (mode === "fill") void fill(cat, start, end);
    else if (block) void editBlock(block.id, cat, start, end);
  };

  return (
    <div className="ns-tt-panel ns-tt-panel-block">
      <Sub num>
        {fmtClock(start)} – {fmtClock(end)}　・　{fmtDur(end - start)}
      </Sub>
      {warn && <Sub warn>{warn}</Sub>}
      <CategoryGrid selected={cat} onPick={setCat} compact />
      <Row k="発車">
        <Stepper value={start} steps={[-5, 5]} lo={0} hi={end - MIN} onChange={setStartClamped} label="発車時刻" />
        <Opt solid on={prevEnd !== null && start === prevEnd} onClick={() => prevEnd !== null && setStartClamped(prevEnd)}>
          接上一塊
        </Opt>
      </Row>
      <Row k="到着">
        <Stepper value={end} steps={[-5, 5]} lo={start + MIN} hi={now} onChange={setEndClamped} label="到着時刻" />
        <Opt solid on={nextStart !== null && end === nextStart} onClick={() => nextStart !== null && setEndClamped(nextStart)}>
          接下一塊
        </Opt>
      </Row>
      <Actions>
        {mode === "edit" && block && (
          <>
            <button
              type="button"
              className="ns-btn btn-ghost is-aux"
              onClick={() => {
                onDone();
                void deleteBlock(block.id);
              }}
            >
              刪除
            </button>
            <button type="button" className="ns-btn btn-ghost is-aux" onClick={() => openSheet({ kind: "split", blockId: block.id })}>
              切開
            </button>
          </>
        )}
        <button type="button" className="ns-btn btn-ghost" onClick={onDone}>
          取消
        </button>
        <button type="button" className="ns-btn btn-seal" onClick={submit}>
          {mode === "fill" ? "補上" : "改好了"}
        </button>
      </Actions>
    </div>
  );
}
