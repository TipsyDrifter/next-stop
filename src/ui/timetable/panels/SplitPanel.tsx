/**
 * SplitPanel——切開這一塊面板・多切點（①b①c 契約 §5.1；乙席；長相＝原型 `v-e.js` 情境 3 splitBody）。
 *
 *   div.ns-tt-panel.ns-tt-panel-split
 *   ├ Sub.is-num「HH:MM – HH:MM　{分類}・{fmtDur}」（運行中：尾端寫「現在」、加「（運行中）」）
 *   ├ div.ns-tt-cutbar（時間條：各段上色、白色切點；點一下＝在那裡加一刀、拖切點＝移動，取整到分）
 *   ├ div.ns-tt-cutscale（兩端時刻＋提示）
 *   ├ div.ns-tt-cutlist
 *   │   每段：div.ns-tt-seg-row[data-i]（button.ns-tt-seg-cat 圓牌▾＋button.ns-tt-seg-txt 名稱與起訖＋span.ns-tt-seg-tag）
 *   │         點了在那一段底下展開分類格（Expand＋CategoryGrid compact），選了收起
 *   │   段與段之間：div.ns-tt-cut-row（✂「切在」Stepper（磨光⑥ 起五處同一排、可打字）＋button.ns-tt-cut-del ✕；只剩一刀時 disabled）
 *   ├ div.ns-tt-cut-tools：「＋ 加切點」（addCut：最長那段的中點）、「對半」（defaultCuts n=1、分類重設成原分類）
 *   ├ Sub.is-warn（驗證不過）B14「每段至少 1 分」
 *   └ Actions：「取消」｜btn-seal「切成 N 段」→ onDone()；store.splitMulti(...)
 *
 * 預設：一刀在中點（＝①a）、兩段都是原分類（〈開工決定〉二-1）。不到 2 分＝①a 原樣「切不開」。
 * 「現在」用 useNowOnce（面板生命週期內固定；運行中那一班的最後一段上限＝它，送出後最後一段仍運行中）。
 */
import { useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { MIN, addCut, colorSlot, defaultCuts, fmtClock, fmtDur, msOf } from "../../../domain/timetable";
import { TT_TEXT, useTimetableStore } from "../../../store/timetableStore";
import { CategoryBadge } from "../CategoryBadge";
import { CategoryGrid } from "../parts/CategoryGrid";
import { Actions, Expand, Stepper, Sub, clamp, clockDraftsOk, useBlock, useNowOnce, type PanelProps } from "./controls";

/** 拖曳時抓得到切點的距離（px） */
const GRAB_PX = 18;

export function SplitPanel({ onDone }: PanelProps) {
  const now = useNowOnce();
  const sheet = useTimetableStore((s) => s.sheet);
  const blockId = sheet?.kind === "split" ? sheet.blockId : "";
  const block = useBlock(blockId);
  const catById = useTimetableStore((s) => s.catById);
  const splitMulti = useTimetableStore((s) => s.splitMulti);

  const live = block !== null && block.ended_at === null;
  const start = block ? msOf(block.started_at) : now;
  const end = block ? (block.ended_at ? msOf(block.ended_at) : now) : now;
  const orig = block?.category_id ?? "";
  const [cuts, setCuts] = useState<number[]>(() => defaultCuts(start, end, 1));
  // 每段的分類；null＝主人沒換過、跟著這一塊**現在**的分類（面板開著時別台改了分類，送出時才不會把它蓋回舊的；沙盒 S1）
  const [picked, setPicked] = useState<(string | null)[]>(() => [null, null]);
  const cats = picked.map((c) => c ?? orig);
  const [open, setOpen] = useState<number | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

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
  const tooShort = end - start < 2 * MIN || cuts.length === 0;
  const span = Math.max(1, end - start);
  const pts = [start, ...cuts, end];
  const n = cuts.length + 1;
  let valid = !tooShort && cats.length === n && cats.every((c) => c !== "");
  for (let i = 0; valid && i + 1 < pts.length; i++) if (pts[i + 1] - pts[i] < MIN) valid = false;
  const endLabel = live ? "現在" : fmtClock(end);
  const pct = (ms: number): number => ((ms - start) / span) * 100;

  /** 第 i 刀的合法範圍：前一刀（或開頭）＋1 分 ～ 後一刀（或尾端）−1 分 */
  const loOf = (i: number): number => (i === 0 ? start : cuts[i - 1]) + MIN;
  const hiOf = (i: number): number => (i === cuts.length - 1 ? end : cuts[i + 1]) - MIN;
  const setCut = (i: number, v: number): void => {
    const next = cuts.slice();
    next[i] = clamp(Math.round(v / MIN) * MIN, loOf(i), hiOf(i));
    setCuts(next);
  };
  /** 在第 i 刀之前插一刀 at（段 i 一分為二，新段沿用段 i 的分類） */
  const insertCut = (i: number, at: number): void => {
    const nc = cuts.slice();
    nc.splice(i, 0, at);
    const ns = picked.slice();
    ns.splice(i + 1, 0, picked[i]);
    setCuts(nc);
    setPicked(ns);
    if (open !== null && open > i) setOpen(open + 1);
  };
  const addCutAt = (ms: number): boolean => {
    const m = Math.round(ms / MIN) * MIN;
    for (let i = 0; i + 1 < pts.length; i++) {
      if (m > pts[i] && m < pts[i + 1]) {
        if (m - pts[i] < MIN || pts[i + 1] - m < MIN) return false;
        insertCut(i, m);
        return true;
      }
    }
    return false;
  };
  const delCut = (i: number): void => {
    if (cuts.length <= 1) return;
    const nc = cuts.slice();
    nc.splice(i, 1);
    const ns = picked.slice();
    ns.splice(i + 1, 1); // 段 i 與 i+1 併成一段，留段 i 的分類
    setCuts(nc);
    setPicked(ns);
    setOpen(null);
  };
  const onAddCut = (): void => {
    const next = addCut(cuts, start, end);
    if (next.length === cuts.length) return; // 最長那段也不到 2 分
    let i = 0;
    while (i < cuts.length && next[i] === cuts[i]) i++;
    insertCut(i, next[i]);
  };
  const onHalf = (): void => {
    setCuts(defaultCuts(start, end, 1));
    setPicked([null, null]);
    setOpen(null);
  };

  /* 時間條：點一下＝加一刀；按在切點附近（GRAB_PX）＝拖那一刀 */
  const msAt = (clientX: number): number => {
    const r = barRef.current?.getBoundingClientRect();
    if (!r || r.width <= 0) return start;
    return start + ((clientX - r.left) / r.width) * span;
  };
  const onBarDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const r = barRef.current?.getBoundingClientRect();
    if (!r) return;
    e.preventDefault();
    let best = -1;
    let bestPx = Infinity;
    cuts.forEach((c, i) => {
      const d = Math.abs(r.left + (pct(c) / 100) * r.width - e.clientX);
      if (d < bestPx) {
        bestPx = d;
        best = i;
      }
    });
    if (best >= 0 && bestPx <= GRAB_PX) {
      setDrag(best);
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* 合成事件沒有真的指標：不抓也能拖 */
      }
    }
  };
  const onBarMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (drag !== null) setCut(drag, msAt(e.clientX));
  };
  const onBarUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (drag !== null) {
      setDrag(null);
      return;
    }
    if (e.type === "pointerup") addCutAt(msAt(e.clientX));
  };

  const submit = (e: ReactMouseEvent<HTMLButtonElement>): void => {
    if (!valid || !clockDraftsOk(e.currentTarget)) return;
    onDone();
    void splitMulti(block.id, cuts, cats);
  };

  return (
    <div className="ns-tt-panel ns-tt-panel-split">
      <Sub num>
        {fmtClock(start)} – {endLabel}　{name1}・{fmtDur(end - start)}
        {live && "（運行中）"}
      </Sub>
      {tooShort ? (
        <Sub warn>不到兩分鐘，無法切分</Sub>
      ) : (
        <>
          <div
            ref={barRef}
            className={"ns-tt-cutbar" + (drag !== null ? " is-dragging" : "")}
            onPointerDown={onBarDown}
            onPointerMove={onBarMove}
            onPointerUp={onBarUp}
            onPointerCancel={onBarUp}
            role="presentation"
          >
            {pts.slice(0, -1).map((p, i) => {
              const c = catById[cats[i]] ?? null;
              const w = pct(pts[i + 1]) - pct(p);
              const style = { left: pct(p) + "%", width: w + "%", "--c": `var(--ns-tt-cat-${colorSlot(c?.color_idx ?? 8)})` } as CSSProperties;
              return (
                <span key={"s" + i} className={"ns-tt-cutseg" + (open === i ? " is-open" : "")} style={style} aria-hidden="true">
                  {w > 9 ? (c?.glyph ?? Array.from(c?.name ?? "・")[0]) : ""}
                </span>
              );
            })}
            {cuts.map((c, i) => (
              <span key={"h" + i} className={"ns-tt-cuth" + (drag === i ? " is-drag" : "")} style={{ left: pct(c) + "%" }} aria-hidden="true">
                <em className="ns-tt-num">{fmtClock(c)}</em>
              </span>
            ))}
          </div>
          <div className="ns-tt-cutscale ns-tt-num">
            <span>{fmtClock(start)}</span>
            <span className="ns-tt-cutscale-hint">拖曳切點，或點時間條新增切點</span>
            <span>{endLabel}</span>
          </div>

          <div className="ns-tt-cutlist">
            {pts.slice(0, -1).map((p, i) => {
              const last = i === n - 1;
              const c = catById[cats[i]] ?? null;
              const isOpen = open === i;
              const toggle = (): void => setOpen(isOpen ? null : i);
              return (
                <div key={"r" + i} className="ns-tt-seg-block">
                  <div className={"ns-tt-seg-row" + (isOpen ? " is-open" : "")} data-i={i}>
                    <button type="button" className="ns-tt-seg-cat" aria-expanded={isOpen} aria-label={`換第 ${i + 1} 段的分類`} onClick={toggle}>
                      <CategoryBadge cat={c} size="sm" />
                      <i aria-hidden="true">▾</i>
                    </button>
                    <button type="button" className="ns-tt-seg-txt" onClick={toggle}>
                      <b>{c?.name ?? "？"}</b>
                      <span className="ns-tt-seg-span ns-tt-num">
                        {fmtClock(p)} – {last && live ? "現在" : fmtClock(pts[i + 1])}　{fmtDur(pts[i + 1] - p)}
                      </span>
                    </button>
                    <span className="ns-tt-seg-tag">{last && live ? "繼續運行" : `第 ${i + 1} 段`}</span>
                  </div>
                  {isOpen && (
                    <Expand className="ns-tt-seg-grid">
                      <CategoryGrid
                        selected={cats[i]}
                        onPick={(id) => {
                          const ns = picked.slice();
                          ns[i] = id;
                          setPicked(ns);
                          setOpen(null);
                        }}
                        compact
                      />
                    </Expand>
                  )}
                  {!last && (
                    <div className="ns-tt-cut-row">
                      <span className="ns-tt-cut-ic" aria-hidden="true">
                        ✂
                      </span>
                      <span className="ns-tt-row-k">切在</span>
                      <Stepper value={cuts[i]} lo={loOf(i)} hi={hiOf(i)} onChange={(v) => setCut(i, v)} label={`切點 ${i + 1}`} />
                      <button
                        type="button"
                        className="ns-tt-cut-del"
                        disabled={cuts.length <= 1}
                        aria-label={`移除切點 ${i + 1}`}
                        onClick={() => delCut(i)}
                      >
                        ✕
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="ns-tt-cut-tools">
            <button type="button" className="ns-tt-opt is-solid" onClick={onAddCut}>
              ＋ 加切點
            </button>
            <button type="button" className="ns-tt-opt is-solid" onClick={onHalf}>
              對半
            </button>
          </div>
          {!valid && <Sub warn>{TT_TEXT.cutTooShort}</Sub>}
        </>
      )}
      <Actions>
        <button type="button" className="ns-btn btn-ghost" onClick={onDone}>
          取消
        </button>
        <button type="button" className="ns-btn btn-seal" disabled={!valid} onClick={submit}>
          {tooShort ? "切開" : `切成 ${n} 段`}
        </button>
      </Actions>
    </div>
  );
}
