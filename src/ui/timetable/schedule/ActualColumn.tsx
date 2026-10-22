/**
 * ActualColumn——日程的「實績」欄（④ 契約 §5.3、§5.4；D-時-85；乙席）。
 * 長相＝原型 v-h.js blockHtml（.vh-blk；＝③ 週視圖的塊放大）→ 正式版 `button.ns-tt-sched-blk`（timetable.css §L）。
 *
 * - 資料：`timetableStore.dayBlocks` → `segmentsOfDay(…, 日界線窗, now)`（只畫塊，空白不做補記：日程不是補記的地方）。
 * - 照分類色；運行中長到現在線；沒連到排定車票的照畫不淡化。連到車票的左邊一道淺線、名稱＝車票名（桌機加「・分類」）。
 * - 滑過（桌機）＝點亮它對應的預定卡（D-時-84）；點塊照軸（parts/Axis.tsx:125-138）的語義：
 *   長時間運行待確認 ⇒ longRun 面板、運行中 ⇒ toast「運行中的這一班…」、其餘 ⇒ 改一塊（edit）。
 */
import { useMemo, type CSSProperties } from "react";
import { colorSlot, fmtClock, fmtDur, segmentsOfDay, toSpan, type AxisItem, type TimeBlockRow } from "../../../domain/timetable";
import { linkLabelOf } from "../../../domain/timetableLink";
import { TT_TEXT, blockMarker, useTimetableStore } from "../../../store/timetableStore";
import { useTimetableScheduleStore } from "../../../store/timetableScheduleStore";
import { pct } from "./scheduleModel";
import type { SchedulePage } from "./useSchedulePage";

type BlockItem = Extract<AxisItem, { kind: "block" }>;

export function ActualColumn({ page, hourPx }: { page: SchedulePage; hourPx: number }) {
  const dayBlocks = useTimetableStore((s) => s.dayBlocks);
  const ttDay = useTimetableStore((s) => s.dayKey);
  const catById = useTimetableStore((s) => s.catById);
  const linkInfo = useTimetableStore((s) => s.linkInfo);
  const setHover = useTimetableScheduleStore((s) => s.setHover);
  const { win, now, activeBlocks, nodes, shell } = page;
  const desk = shell === "desktop";
  // 實績跟預定要是同一天：時刻表的那一天還沒換過來（refresh 在跑）時先不畫，免得閃一下別天的塊
  const rows = ttDay === page.date ? dayBlocks : [];
  const rowsById = useMemo(() => {
    const m: Record<string, TimeBlockRow> = {};
    for (const r of rows) m[r.id] = r;
    return m;
  }, [rows]);
  const segs = useMemo(
    () => segmentsOfDay(rows.map(toSpan), win, now).filter((x): x is BlockItem => x.kind === "block"),
    [rows, win, now],
  );
  const D = win.end - win.start;

  const onBlock = (it: BlockItem): void => {
    const s = useTimetableStore.getState();
    const row = rowsById[it.span.id];
    const m = row ? blockMarker(row, s.catById, s.longRunMaxMin, Date.now(), s.linkInfo) : null;
    if (m && m.kind !== "none" && m.pending) {
      s.openSheet({ kind: "longRun", blockId: it.span.id, then: null });
      return;
    }
    // 磨光⑦（D-時-152）：運行中那班也開同一個編輯面板（改分類、出發時間、連結、荷札）
    s.openSheet({ kind: "edit", blockId: it.span.id });
  };

  return (
    <>
      {segs.map((it) => {
        const row = rowsById[it.span.id];
        const cat = catById[it.span.categoryId];
        const catName = cat?.name ?? "？";
        const nodeName = row?.node_id ? (nodes[row.node_id]?.name ?? null) : null;
        const label = nodeName ?? (row ? linkLabelOf(row, linkInfo) : null);
        const linked = label !== null;
        const to = it.running ? Math.min(now, win.end) : it.to;
        const hpx = ((to - it.from) / 3_600_000) * hourPx;
        const whole = (it.span.end ?? now) - it.span.start;
        const tip = `${catName}${linked ? "・" + label : ""}　${fmtClock(it.span.start)}–${it.span.end === null ? TT_TEXT.weekUi.running : fmtClock(it.span.end)}（${fmtDur(whole)}）`;
        const style = {
          "--c": `var(--ns-tt-cat-${colorSlot(cat?.color_idx ?? 8)})`,
          top: pct((it.from - win.start) / D),
          height: pct((to - it.from) / D),
        } as CSSProperties;
        const cls =
          "ns-tt-sched-blk" +
          (it.running ? " is-live" : "") +
          (linked ? " is-linked" : "") +
          (hpx < 13 ? " is-thin" : "") +
          (activeBlocks.has(it.span.id) ? " is-on" : "");
        return (
          <button
            type="button"
            key={it.span.id + ":" + it.from}
            className={cls}
            style={style}
            title={tip}
            aria-label={tip}
            onPointerEnter={(e) => {
              if (e.pointerType === "mouse") setHover({ kind: "block", id: it.span.id });
            }}
            onPointerLeave={(e) => {
              if (e.pointerType === "mouse") setHover(null);
            }}
            onClick={(e) => {
              e.stopPropagation();
              onBlock(it);
            }}
          >
            {hpx >= 13 && (
              <span className="ns-tt-sched-bn">
                {linked ? label : catName}
                {linked && desk && <i>・{catName}</i>}
              </span>
            )}
            {hpx >= 28 && (
              <small className="ns-tt-num">
                {fmtClock(it.span.start)}
                {it.running ? ` 起・${TT_TEXT.weekUi.running}` : `–${fmtClock(it.span.end ?? to)}`}
              </small>
            )}
          </button>
        );
      })}
    </>
  );
}
