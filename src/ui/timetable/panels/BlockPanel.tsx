/**
 * BlockPanel——補記（sheet.kind "fill"）／改一塊（"edit"）面板（車次①a 契約 §5.4；丙席；＝原型 `shared.js` openBlockSheet，
 * 拿掉綁車票與備註）。
 * 副標「HH:MM – HH:MM　・　Xh」；蓋到既有紀錄時赭字 W1；分類格 compact；
 * 「発車」stepper −5／HH:MM／+5＋「接上一塊」；「到着」stepper −5／HH:MM／+5＋「接下一塊」
 * （補記：上下界＝那段空白的兩端；改：上一塊尾／下一塊頭；到着不得晚於現在）；
 * 改的時候多「刪除」「切開」兩顆次鈕；主鈕「補上」／「改好了」。
 *
 * 車次①b（①b①c 契約 §5.2；乙席；長相＝原型 `v-e.js` 情境 4 editBody、D-時-33）：
 * - 貼齊：目標是 null（看的那一天裡沒有上一塊／下一塊）時「接上一塊／接下一塊」不畫（①a 照畫、按了沒反應）。
 *   跨日的貼齊不補（只找看的那一天）——改用「與上一塊合併」，它查 DB、帶 bound。
 * - 合併（只在改一塊）：div.ns-tt-merge 一列「與上一塊合併／與下一塊合併」；掛上時各問一次 store.previewMerge，
 *   null ⇒ 那顆 disabled。按下其中一顆 ⇒ 面板收成「副標＋合併列＋確認框」（分類格、時刻、底部鈕先收起；手機不用捲就
 *   看得到確認鈕），確認框 div.ns-tt-merge-confirm：B2 預覽一行＋說明＋「算了」「確認合併」；軸上那兩塊描金邊
 *   （setMergeMarks）。主鈕「改好了」在確認框開著時不在畫面上（互斥）。
 *   bound：上＝看的那天的起點；下＝min(那天的終點, 現在)。
 */
import { useEffect, useState } from "react";
import { MIN, fmtClock, fmtDur, msOf, type MergePreview } from "../../../domain/timetable";
import { TT_TEXT, useTimetableStore } from "../../../store/timetableStore";
import { useUiStore } from "../../../store/uiStore";
import { dayWindow } from "../../../lib/date";
import { CategoryGrid } from "../parts/CategoryGrid";
import {
  Actions,
  Expand,
  Opt,
  Row,
  Stepper,
  Sub,
  clamp,
  setMergeMarks,
  useBlock,
  useCoverWarn,
  useNowOnce,
  type PanelProps,
} from "./controls";

type Dir = "prev" | "next";

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
  const catById = useTimetableStore((s) => s.catById);
  const dayKey = useTimetableStore((s) => s.dayKey);
  const previewMerge = useTimetableStore((s) => s.previewMerge);
  const mergeBlock = useTimetableStore((s) => s.mergeBlock);
  const dayStartHour = useUiStore((s) => s.dayStartHour);

  // 合併：兩側的預演（undefined＝還在問）；ask＝二次確認開著的那一側
  const dw = dayWindow(dayKey, dayStartHour);
  const boundOf = (d: Dir): number => (d === "prev" ? msOf(dw.start) : Math.min(msOf(dw.end), now));
  const [previews, setPreviews] = useState<{ prev?: MergePreview | null; next?: MergePreview | null }>({});
  const [ask, setAsk] = useState<Dir | null>(null);
  const mergeId = mode === "edit" && block && block.ended_at !== null ? block.id : null;
  const mergeSig = block ? `${block.started_at}|${block.ended_at}|${block.category_id}` : "";
  useEffect(() => {
    if (!mergeId) return;
    let alive = true;
    const ask1 = (d: Dir): Promise<MergePreview | null> => previewMerge(mergeId, d, boundOf(d)).catch(() => null);
    void Promise.all([ask1("prev"), ask1("next")]).then(([prev, next]) => {
      if (alive) setPreviews({ prev, next });
    });
    return () => {
      alive = false;
    };
    // boundOf 隨 dayKey／dayStartHour 變（now 是面板掛上時固定的值）；mergeSig＝這一塊被別台改了就重問
  }, [mergeId, mergeSig, dayKey, dayStartHour, previewMerge]);
  const askPreview = ask ? (previews[ask] ?? null) : null;
  // 軸上描金邊：這一塊＋合併後留下的那一塊
  useEffect(() => {
    if (ask && askPreview && block) setMergeMarks(askPreview.keepId === block.id ? [block.id] : [block.id, askPreview.keepId]);
    else setMergeMarks([]);
  }, [ask, askPreview, block]);
  useEffect(() => () => setMergeMarks([]), []);

  // 初值：補記＝那段空白的兩端；改＝這一塊的起訖
  const init = (() => {
    if (sheet?.kind === "fill") return { start: sheet.start, end: Math.min(sheet.end, now), cat: null as string | null };
    if (block) return { start: msOf(block.started_at), end: block.ended_at ? msOf(block.ended_at) : now, cat: block.category_id };
    return { start: now - MIN, end: now, cat: null as string | null };
  })();
  const [start, setStart] = useState(init.start);
  const [end, setEnd] = useState(init.end);
  const [cat, setCat] = useState<string | null>(init.cat);
  // 面板開著時別台改了這一塊（同步拉到 ⇒ block 換新）：主人還沒動過的欄位跟著換成新的值，動過的照留（沙盒 S9）。
  // 不跟的話，「改好了」會把面板上的舊起訖／舊分類整份寫回去，蓋掉別台的修改。
  const [base, setBase] = useState(init);
  if (mode === "edit" && block && (init.start !== base.start || init.end !== base.end || init.cat !== base.cat)) {
    setBase(init);
    if (start === base.start) setStart(init.start);
    if (end === base.end) setEnd(init.end);
    if (cat === base.cat) setCat(init.cat);
  }

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

  const catName = (id: string): string => catById[id]?.name ?? "？";
  const snapPrev = prevEnd;
  const snapNext = nextStart;

  /* 合併列（改一塊才有；運行中的塊不會開這個面板，repository 仍會擋） */
  const mergeRow =
    mergeId && block ? (
      <div className="ns-tt-merge">
        <Row k="合併" top>
          <span className="ns-tt-opts">
            {(["prev", "next"] as const).map((d) => {
              const p = previews[d];
              return (
                <button
                  key={d}
                  type="button"
                  className={"ns-tt-opt is-solid" + (ask === d ? " is-on" : "")}
                  aria-pressed={ask === d}
                  disabled={!p}
                  onClick={() => setAsk(ask === d ? null : d)}
                >
                  {d === "prev" ? "與上一塊合併" : "與下一塊合併"}
                </button>
              );
            })}
          </span>
        </Row>
        {ask && askPreview && (
          <Expand className="ns-tt-merge-confirm">
            <p className="ns-tt-merge-preview">
              {TT_TEXT.mergePreview(catName(askPreview.categoryId), askPreview.start, askPreview.end, askPreview.gapMs)}
            </p>
            <p className="ns-tt-merge-note">
              {askPreview.keepId === block.id
                ? `鄰居是未記錄：這一塊延伸蓋住那段空白（同「${ask === "prev" ? "接上一塊" : "接下一塊"}」）。`
                : `這一塊（${catName(block.category_id)} ${fmtClock(init.start)}–${fmtClock(init.end)}）會刪掉，時間併進「${catName(askPreview.categoryId)}」。`}
            </p>
            <div className="ns-tt-merge-btns">
              <button type="button" className="ns-btn btn-ghost ns-btn--sm" onClick={() => setAsk(null)}>
                算了
              </button>
              <button
                type="button"
                className="ns-btn btn-seal ns-btn--sm"
                onClick={() => {
                  const d = ask;
                  onDone();
                  void mergeBlock(block.id, d, boundOf(d));
                }}
              >
                確認合併
              </button>
            </div>
          </Expand>
        )}
      </div>
    ) : null;

  // 二次確認：面板收成「副標＋合併列＋確認框」（D-時-33）
  if (ask && askPreview && block) {
    return (
      <div className="ns-tt-panel ns-tt-panel-block is-merging">
        <Sub num>
          {catName(block.category_id)}　{fmtClock(init.start)} – {fmtClock(init.end)}　・　{fmtDur(init.end - init.start)}
        </Sub>
        {mergeRow}
      </div>
    );
  }

  return (
    <div className="ns-tt-panel ns-tt-panel-block">
      <Sub num>
        {fmtClock(start)} – {fmtClock(end)}　・　{fmtDur(end - start)}
      </Sub>
      {warn && <Sub warn>{warn}</Sub>}
      <CategoryGrid selected={cat} onPick={setCat} compact />
      <Row k="発車">
        <Stepper value={start} steps={[-5, 5]} lo={0} hi={end - MIN} onChange={setStartClamped} label="発車時刻" />
        {snapPrev !== null && (
          <Opt solid on={start === snapPrev} onClick={() => setStartClamped(snapPrev)}>
            接上一塊
          </Opt>
        )}
      </Row>
      <Row k="到着">
        <Stepper value={end} steps={[-5, 5]} lo={start + MIN} hi={now} onChange={setEndClamped} label="到着時刻" />
        {snapNext !== null && (
          <Opt solid on={end === snapNext} onClick={() => setEndClamped(snapNext)}>
            接下一塊
          </Opt>
        )}
      </Row>
      {mergeRow}
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
