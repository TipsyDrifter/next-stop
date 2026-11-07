/**
 * BoardCard——看板的一張小票（⑫；視覺真相 prototypes/看板與篩選-⑫.html 的 .bc）。兩殼共用結構，CSS 分開（桌機 board.css；手機自己的檔接 `.ns-bc`）。
 *
 * 票面：票名（優先點）・路徑小字（跨路線時前面多路線圓牌）・定期券字樣・日期 chip・延着；右邊撕線外一欄 ⋯ 與小検印。
 * 日期 chip 只顯示：改期走 ⋯（卡上的字要讓位給拖曳，整張都是把手）。
 * 定期券口徑同大綱（OutlineRow 檔頭）：済蓋在目前班次，済了之後 scheduled_on 是引擎推出來的下一班，所以済欄的卡寫「下一班 M/D」；
 *   誤點看目前班次（domain/taskFilter.isTaskLate，大綱與今日同一把尺）。運休中＝章的位置換成墨色「休」，蓋済前要先取消（同大綱）。
 *
 * 列（li）帶 data-drag-id 給 useDragReorder；⋯ 與検印是按鈕，共用拖曳元件不從按鈕上起拖。滑鼠的選取與開側板由 `onPress` 交給呼叫端（桌機用）；手機給 `onOpen`（點卡）、`onMore`（⋯ 開底部面板）、`leading`（多選的勾選圈）。
 */
import { useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { parseRule, type NodeRow } from "../../domain";
import { isTaskDone, isTaskLate, isTaskSettled, type OccurrenceLike } from "../../domain/taskFilter";
import { IconDots } from "../common/icons";
import { PopMenu, type PopMenuItem } from "../common/PopMenu";
import { PriorityMark } from "../common/PriorityMark";
import { roundelStyle } from "../common/roundel";
import { rowContextMenu } from "../common/contextMenu";
import { STATUS_COLUMN_LABEL, cardStatus } from "../../domain/board";
import { useUiStore } from "../../store/uiStore";
import { cardOverline } from "./boardMenu";

const md = (iso: string) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;

export interface CardMeta {
  /** 執行日 chip；null＝不畫 */
  run: { text: string; late: boolean } | null;
  due: { text: string; late: boolean } | null;
  /** 済了的定期券：下一班 M/D */
  next: string | null;
  late: boolean;
  skipped: boolean;
  done: boolean;
  teiki: boolean;
}

/** 卡與手機票卡共用的字：今天、M/D、〆 */
export function cardMeta(node: NodeRow, occ: OccurrenceLike | undefined, today: string): CardMeta {
  const done = isTaskDone(node, occ);
  const settled = isTaskSettled(node, occ);
  const teiki = parseRule(node.repeat_rule) !== null;
  const skipped = occ?.status === "skipped";
  const late = isTaskLate(node, occ, today);
  const label = (d: string) => (d === today ? "今天" : md(d));
  // 還沒交代的講這一班（定期券看目前班次）；交代完的定期券 scheduled_on 已是下一班，退役的（沒有班次）不講；済了的單發票不再寫日子（原型）
  const rail = settled ? null : (occ?.due_on ?? node.scheduled_on);
  const next = teiki && occ && settled && node.scheduled_on ? `下一班 ${md(node.scheduled_on)}` : null;
  return {
    run: rail ? { text: label(rail), late } : null,
    due: node.due_on ? { text: `〆${label(node.due_on)}`, late: !settled && node.due_on < today } : null,
    next,
    late,
    skipped,
    done,
    teiki,
  };
}

export interface BoardCardProps {
  node: NodeRow;
  today: string;
  occurrence: OccurrenceLike | undefined;
  /** 路徑小字；空＝不畫 */
  path?: string | null;
  /** 跨路線：路線圓牌（null＝臨時車票的虛線圈）；省略＝不畫 */
  route?: Pick<NodeRow, "name" | "code" | "color"> | null;
  /** 欄不是狀態的時候，進行中、途中下車要寫出來 */
  showStatus?: boolean;
  selected?: boolean;
  picked?: boolean;
  fresh?: boolean;
  /** 検印停用的理由（車庫裡的路線） */
  stampWhy?: string;
  onStamp(node: NodeRow): void;
  menu(): PopMenuItem[];
  /** 桌機：mousedown（多選、選中、等放手開側板） */
  onPress?(node: NodeRow, e: MouseEvent<HTMLElement>): void;
  /** 手機：點卡 */
  onOpen?(node: NodeRow): void;
  /** 手機：⋯ 開底部面板（給了就不開 PopMenu） */
  onMore?(node: NodeRow): void;
  /** 手機多選中：票面左邊的勾選圈 */
  leading?: ReactNode;
  /** ⋯ 關掉後焦點回哪（桌機回看板容器） */
  returnFocus?(): void;
}

export function BoardCard({ node, today, occurrence, path, route, showStatus, selected, picked, fresh, stampWhy, onStamp, menu, onPress, onOpen, onMore, leading, returnFocus }: BoardCardProps) {
  const m = cardMeta(node, occurrence, today);
  const status = cardStatus(node, occurrence);
  const label = m.skipped ? "取消本班運休" : m.done ? "取消完成" : "蓋章完成";
  const btn = useRef<HTMLButtonElement>(null);
  const [items, setItems] = useState<PopMenuItem[] | null>(null);
  const rd: CSSProperties | undefined = route ? roundelStyle(route.color) : undefined;
  return (
    <li
      className={"ns-bc-li" + (fresh ? " fresh" : "")}
      data-drag-id={node.id}
      data-node-id={node.id}
      onMouseDown={onPress ? (e) => onPress(node, e) : undefined}
      onContextMenu={rowContextMenu(() => ({ overline: cardOverline(node), label: `「${node.name}」的動作`, items: menu(), before: () => useUiStore.getState().select(node.id) }))}
    >
      <article
        className={"ns-bc" + (m.done ? " done" : "") + (m.skipped ? " is-skipped" : "") + (selected ? " selected" : "") + (picked ? " is-picked" : "")}
        aria-label={node.name}
        onClick={onOpen ? () => onOpen(node) : undefined}
      >
        {leading}
        <div className="ns-bc-body">
          <p className="ns-bc-title">
            <PriorityMark priority={node.priority} />
            {node.name}
          </p>
          <div className="ns-bc-meta">
            {(route !== undefined || path) && (
              <span className="ns-bc-path">
                {route !== undefined &&
                  (route ? (
                    <i className="rd" style={rd} aria-hidden>
                      {route.code ?? ""}
                    </i>
                  ) : (
                    <i className="rd is-blank" aria-hidden />
                  ))}
                {route !== undefined && <span className="tx is-route">{route ? route.name : "臨時車票"}</span>}
                {path && <span className="tx">{route !== undefined ? `› ${path}` : path}</span>}
              </span>
            )}
            {m.teiki && <span className="ns-bc-teiki">定期券</span>}
            {showStatus && (status === "doing" || status === "paused") && <span className="chip is-st">{STATUS_COLUMN_LABEL[status]}</span>}
            {m.skipped && <span className="chip is-st">本班運休</span>}
            {m.next && <span className="chip next">{m.next}</span>}
            {m.run && <span className={"chip" + (m.run.late ? " late" : "")}>{m.run.text}</span>}
            {m.due && <span className={"chip" + (m.due.late ? " late" : "")}>{m.due.text}</span>}
            {m.late && <span className="ns-bc-late">延着</span>}
          </div>
        </div>
        <div className="ns-bc-zone">
          <button
            ref={btn}
            type="button"
            tabIndex={-1}
            className="ns-bc-more"
            aria-haspopup="menu"
            aria-expanded={items !== null}
            aria-label={`「${node.name}」的更多動作`}
            title="更多動作"
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.stopPropagation();
              if (onMore) onMore(node);
              else setItems((cur) => (cur ? null : menu()));
            }}
          >
            <IconDots size={14} />
          </button>
          <span title={stampWhy} className="ns-bc-stampwrap">
            <button
              type="button"
              tabIndex={-1}
              className="ns-bc-stamp"
              disabled={!!stampWhy}
              aria-label={label}
              aria-pressed={m.done}
              title={stampWhy ? undefined : label}
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.stopPropagation();
                onStamp(node);
              }}
            >
              <span className="seal" aria-hidden>
                済
              </span>
              {m.skipped && (
                <span className="off" aria-hidden>
                  休
                </span>
              )}
            </button>
          </span>
        </div>
      </article>
      {/* PopMenu 畫到 body，但 React 事件照元件樹冒泡：不截住的話點選單項目會冒到列上（選中、起拖） */}
      {items && (
        <span className="ns-bc-menuhost" onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
          <PopMenu
            anchor={btn.current}
            overline={cardOverline(node)}
            label={`「${node.name}」的動作`}
            items={items}
            onClose={() => setItems(null)}
            returnFocus={
              returnFocus
                ? () => {
                    returnFocus();
                    return null;
                  }
                : undefined
            }
          />
        </span>
      )}
    </li>
  );
}
