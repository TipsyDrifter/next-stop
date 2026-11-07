/**
 * BoardColumns——桌機看板的欄區（⑫；視覺真相 prototypes/看板與篩選-⑫.html 的 .bx／.bcol）。路線看板與篩選清單的看板版面共用。
 *
 * 欄區就是 useDragReorder 的 root（`columns` 模式）：自己橫捲，欄帶 data-drag-col；側板開著主欄變窄時欄不縮到比最小寬窄，橫捲。
 * 欄撐滿同高：放在欄身空白處也算這一欄。済欄隱藏時收成窄條，一樣是落點，點了等於按「済 N・顯示」。
 * 樣式在 board.css；卡與新增列由呼叫端畫（`renderCard`、`renderAdd`），這裡只管欄的骨架。
 */
import type { CSSProperties, ReactNode } from "react";
import type { BoardCard } from "../../domain/board";
import type { NodeRow } from "../../domain";
import { StationMark } from "../weekAims/parts";
import type { BoardColumnModel } from "./useRouteBoard";
import "./board.css";

export interface BoardColumnsProps {
  columns: readonly BoardColumnModel[];
  rootRef(el: HTMLDivElement | null): void;
  /** 依列車：欄稍寬、計數寫 d/N 済 */
  train?: boolean;
  renderCard(card: BoardCard<NodeRow>, column: BoardColumnModel): ReactNode;
  renderAdd?(column: BoardColumnModel): ReactNode;
  /** 空欄的字（能放＝拖到這裡；唯讀＝沒有車票） */
  emptyText: string;
  /** 點收起來的済欄 */
  onOpenDone?(): void;
  /** 欄區尾巴（依車站沒有車站時的指路） */
  tail?: ReactNode;
  style?: CSSProperties;
}

function ColumnHead({ c, train }: { c: BoardColumnModel; train?: boolean }) {
  return (
    <header className="ns-bd-colhead">
      <div className="ln">
        <h3 className={c.status === "done" ? "is-seal" : undefined} title={c.title}>
          {c.pre && <span className="pre">{c.pre}</span>}
          {c.next && <StationMark size={12} />}
          {c.title}
        </h3>
        {c.arrived && (
          <span className="arrived" aria-label="已到站">
            着
          </span>
        )}
        <span className="rule" aria-hidden />
        {train ? (
          <span className="n">
            {c.done}/{c.total}
            <em>済</em>
          </span>
        ) : (
          <span className="n">{c.total}</span>
        )}
      </div>
      {c.note && <p className={"note" + (c.next ? " is-next" : "")}>{c.note}</p>}
    </header>
  );
}

export function BoardColumns({ columns, rootRef, train, renderCard, renderAdd, emptyText, onOpenDone, tail, style }: BoardColumnsProps) {
  return (
    <div ref={rootRef} className={"ns-bd-cols" + (train ? " is-train" : "")} style={style}>
      {columns.map((c) =>
        c.shut ? (
          <section key={c.key} className="ns-bd-col is-shut" data-drag-col={c.key} aria-label={`${c.title}（已收起）`}>
            <button type="button" tabIndex={-1} className="ns-bd-shut" title="顯示已完成" onMouseDown={(e) => e.preventDefault()} onClick={onOpenDone}>
              <span className="s">{c.title}</span>
              <span className="n">{c.total}</span>
            </button>
          </section>
        ) : (
          <section key={c.key} className={"ns-bd-col" + (c.arrived ? " is-arrived" : "")} data-drag-col={c.key} aria-label={c.title}>
            <ColumnHead c={c} train={train} />
            <ul className="ns-bd-list">
              {c.rows.map((r) =>
                r.type === "card" ? (
                  renderCard(r.card, c)
                ) : (
                  // 假列：拖曳的縫要分得出小標上下（useRouteBoard 檔頭）；按在小標上不起拖
                  <li key={r.id} className="ns-bd-sub" data-drag-id={r.id} data-no-drag="">
                    {r.label}
                  </li>
                ),
              )}
              {!c.rows.length && !c.foot && <li className="ns-bd-empty">{emptyText}</li>}
            </ul>
            {c.foot && <p className="ns-bd-colfoot">{c.foot}</p>}
            {renderAdd?.(c)}
          </section>
        ),
      )}
      {tail}
    </div>
  );
}
