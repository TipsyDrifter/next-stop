/**
 * MobileBoardColumns——手機看板的欄區（⑫；契約 §4；視覺真相 prototypes/看板與篩選-⑫.html 03、x03b）。路線看板與篩選清單的看板版面共用。
 *
 * 一次一欄（欄寬 86%、露出下一欄），橫向 scroll-snap；上方一排 chip（欄名＋張數）點了跳欄、目前欄選中，**不當落點**。
 * 拖曳：長按 400ms 浮起（共用 useDragReorder 的 `columns.flip`）；tab bar 的位置升起一排大落點（`BoardDock`，外部落點 data-drop-target），
 *   拖上去放開＝換欄，放回原位或取消＝收回。貼邊停一下翻欄、放在看得到的隔壁欄上也算。卡沒有滑動手勢（會跟換欄打架）。
 * 欄內 `overscroll-behavior` 只管 y 軸：管到 x 軸手指在欄裡橫滑就傳不到欄區，換欄會卡死（原型踩過）。
 * 看到哪一欄是螢幕偏好（契約 §5）：這次開著 App 期間照 `memoryKey` 記在模組變數，換回來不跳；重開 App 從第一欄開始。
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { NodeRow } from "../../../domain";
import type { BoardCard } from "../../../domain/board";
import { useDragReorder, type DropPlace, type Verdict } from "../../common/dragReorder";
import { StationMark } from "../../weekAims/parts";
import type { BoardColumnModel } from "../../board/useRouteBoard";
import "../../board/board.css";
import "./mobile-board.css";

/** 底部落點的 type（useDragReorder 的外部落點） */
export const DOCK_TYPE = "board-col";

/** 動畫收起要多久才拿掉落點（同 --dur） */
const DOCK_OUT_MS = 180;

const lastColumn = new Map<string, string>();

export interface MobileBoardColumnsProps {
  columns: readonly BoardColumnModel[];
  /** 拖曳清單（含依列車的小標假列） */
  items: readonly { id: string }[];
  /** 依列車：欄內能排序（畫靛線）、計數寫 d/N 済 */
  train?: boolean;
  /** 記住看到哪一欄用的鍵（路線＋聚焦＋分欄）；換了就回到記得的那一欄 */
  memoryKey: string;
  renderCard(card: BoardCard<NodeRow>, column: BoardColumnModel): ReactNode;
  /** 欄頂的東西（済欄的「済 N・隱藏」） */
  renderColTop?(column: BoardColumnModel): ReactNode;
  /** 空欄的字（能放＝拖到這裡；唯讀＝沒有車票） */
  emptyText: string;
  /** 點收起來的済欄 */
  onOpenDone?(): void;
  /** chip 列尾巴（依列車、依車站的「済 N・顯示」） */
  chipsEnd?: ReactNode;
  /** chip 列與欄區之間一段說明（依車站沒有車站的指路） */
  note?: ReactNode;
  /** 跳到某一欄（建好車票後）；seq 換＝跳 */
  jumpTo?: { key: string; seq: number };
  /** 跳到這張卡所在的欄並捲到它（跳轉落點）；換了才動 */
  revealId?: string | null;
  /** 目前看到哪一欄（新增列跟著它） */
  onColumn?(key: string): void;
  canDrag?(id: string): Verdict;
  onRefuse?(id: string, why: string): void;
  dragIds?(id: string): readonly string[];
  resolve(ids: readonly string[], place: DropPlace): Verdict;
  onDrop(ids: readonly string[], place: DropPlace): void;
  onPressRelease?(id: string): void;
}

export function MobileBoardColumns({
  columns,
  items,
  train,
  memoryKey,
  renderCard,
  renderColTop,
  emptyText,
  onOpenDone,
  chipsEnd,
  note,
  jumpTo,
  revealId,
  onColumn,
  canDrag,
  onRefuse,
  dragIds,
  resolve,
  onDrop,
  onPressRelease,
}: MobileBoardColumnsProps) {
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const chipsRef = useRef<HTMLDivElement>(null);
  const [cur, setCur] = useState(() => {
    const at = columns.findIndex((c) => c.key === lastColumn.get(memoryKey));
    return at < 0 ? 0 : at;
  });
  const [dock, setDock] = useState<{ from: string | null; leaving: boolean } | null>(null);
  const dockTimer = useRef(0);
  const colKeys = columns.map((c) => c.key).join("|");

  const colsOf = (el: HTMLElement) => Array.from(el.querySelectorAll<HTMLElement>("[data-drag-col]"));
  /** 這一欄貼齊左緣時欄區要捲到哪 */
  const leftOf = (el: HTMLElement, col: HTMLElement) =>
    el.scrollLeft + col.getBoundingClientRect().left - el.getBoundingClientRect().left - (parseFloat(getComputedStyle(el).paddingLeft) || 0);

  const jump = (i: number, smooth = true) => {
    if (!root) return;
    const col = colsOf(root)[i];
    if (col) root.scrollTo({ left: leftOf(root, col), behavior: smooth ? "smooth" : "auto" });
  };

  // 進來、換分欄：回到記得的那一欄（沒記得＝第一欄），不播捲動
  useLayoutEffect(() => {
    if (!root) return;
    const at = columns.findIndex((c) => c.key === lastColumn.get(memoryKey));
    const i = at < 0 ? 0 : at;
    setCur(i);
    jump(i, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, memoryKey]);

  const jumpSeq = useRef(jumpTo?.seq ?? 0);
  useEffect(() => {
    if (!jumpTo || jumpTo.seq === jumpSeq.current) return;
    jumpSeq.current = jumpTo.seq;
    const i = columns.findIndex((c) => c.key === jumpTo.key);
    if (i >= 0) jump(i);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpTo]);

  useEffect(() => {
    if (!root || !revealId) return;
    const i = columns.findIndex((c) => c.rows.some((r) => r.type === "card" && r.card.node.id === revealId));
    if (i < 0) return;
    jump(i, false);
    root.querySelector(`[data-node-id="${CSS.escape(revealId)}"]`)?.scrollIntoView({ block: "center", inline: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealId, root]);

  // 手指或捲動換了欄：chip 跟著
  useEffect(() => {
    if (!root) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const cols = colsOf(root);
      if (!cols.length) return;
      let best = 0;
      let dist = Infinity;
      cols.forEach((c, i) => {
        const d = Math.abs(leftOf(root, c) - root.scrollLeft);
        if (d < dist) {
          dist = d;
          best = i;
        }
      });
      setCur(best);
    };
    const onScroll = () => {
      raf ||= requestAnimationFrame(measure);
    };
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      root.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
    };
  }, [root]);

  const curKey = columns[Math.min(cur, columns.length - 1)]?.key ?? "";
  useEffect(() => {
    if (!curKey) return;
    lastColumn.set(memoryKey, curKey);
    onColumn?.(curKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curKey, memoryKey]);

  // 選中的 chip 捲進看得到的地方
  useEffect(() => {
    const row = chipsRef.current;
    const on = row?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!row || !on) return;
    const left = on.offsetLeft - row.offsetLeft - 16;
    if (left < row.scrollLeft || on.offsetLeft - row.offsetLeft + on.offsetWidth > row.scrollLeft + row.clientWidth - 16) row.scrollTo({ left, behavior: "smooth" });
  }, [curKey, colKeys]);

  useEffect(() => () => window.clearTimeout(dockTimer.current), []);

  useDragReorder({
    root,
    items,
    columns: { lines: !!train, flip: true },
    canDrag,
    onRefuse,
    dragIds,
    resolve,
    onDrop,
    onPressRelease,
    onDragStart: (ids) => {
      window.clearTimeout(dockTimer.current);
      // 整批都在同一欄才有「在這欄」；跨欄的一批每一欄都能放
      const fromOf = (id: string) => columns.find((c) => c.rows.some((r) => r.type === "card" && r.card.node.id === id))?.key ?? null;
      const from = fromOf(ids[0]);
      setDock({ from: ids.every((id) => fromOf(id) === from) ? from : null, leaving: false });
    },
    onDragEnd: () => {
      setDock((d) => (d ? { ...d, leaving: true } : d));
      dockTimer.current = window.setTimeout(() => setDock(null), DOCK_OUT_MS);
    },
  });

  const countText = (c: BoardColumnModel) => (train ? `${c.done}/${c.total}` : String(c.total));

  return (
    <div className="m-bd" data-no-fab>
      <div ref={chipsRef} className="m-bd-chips" role="group" aria-label="跳到哪一欄">
        {columns.map((c, i) => (
          <button
            key={c.key}
            type="button"
            className={"m-bd-chip" + (c.status === "done" ? " is-seal" : "")}
            aria-pressed={i === cur}
            onClick={() => {
              // 収起來的済欄：點 chip 等於打開（不然跳過去也只看到窄條）
              if (c.shut) onOpenDone?.();
              requestAnimationFrame(() => jump(i));
            }}
          >
            {c.title}
            <b>{countText(c)}</b>
          </button>
        ))}
        {chipsEnd && <span className="m-bd-chips-end">{chipsEnd}</span>}
      </div>
      {note}
      <div ref={setRoot} className="m-bd-cols">
        {columns.map((c) =>
          c.shut ? (
            <section key={c.key} className="m-bd-col is-shut" data-drag-col={c.key} aria-label={`${c.title}（已收起）`}>
              <button type="button" className="m-bd-shut" title="顯示已完成" onClick={onOpenDone}>
                <span className="s">{c.title}</span>
                <span className="n">{c.total}</span>
                <span className="act">顯示</span>
              </button>
            </section>
          ) : (
            <section key={c.key} className={"m-bd-col" + (c.arrived ? " is-arrived" : "")} data-drag-col={c.key} aria-label={c.title}>
              <div className="m-bd-colscroll">
                {(c.note || c.pre || c.arrived || c.next) && (
                  <header className="m-bd-colhead">
                    {c.next && <StationMark size={12} />}
                    {c.pre && <span className="pre">{c.pre}</span>}
                    {c.arrived && (
                      <span className="arrived" aria-label="已到站">
                        着
                      </span>
                    )}
                    {c.note && <span className={"note" + (c.next ? " is-next" : "")}>{c.note}</span>}
                  </header>
                )}
                {renderColTop?.(c)}
                <ul className="m-bd-list">
                  {c.rows.map((r) =>
                    r.type === "card" ? (
                      renderCard(r.card, c)
                    ) : (
                      // 假列：拖曳的縫要分得出小標上下（useRouteBoard 檔頭）；按在小標上不起拖
                      <li key={r.id} className="m-bd-sub" data-drag-id={r.id} data-no-drag="">
                        {r.label}
                      </li>
                    ),
                  )}
                  {!c.rows.length && !c.foot && <li className="m-bd-empty">{emptyText}</li>}
                </ul>
                {c.foot && <p className="m-bd-colfoot">{c.foot}</p>}
              </div>
            </section>
          ),
        )}
      </div>
      {dock && <BoardDock columns={columns} from={dock.from} leaving={dock.leaving} countText={countText} />}
    </div>
  );
}

/**
 * 底部落點：蓋在 tab bar 的位置（書封材質）。目前欄淡掉寫「在這欄」、不是落點（放上去＝沒動）。
 * 畫到 body：落點要在 useDragReorder 的 root 外面才算外部落點；手機殼的選擇器掛在 <html data-shell> 上照樣命中。
 */
function BoardDock({ columns, from, leaving, countText }: { columns: readonly BoardColumnModel[]; from: string | null; leaving: boolean; countText(c: BoardColumnModel): string }) {
  return createPortal(
    <div className={"m-bd-dock" + (leaving ? " is-leaving" : "")} role="group" aria-label="換到哪一欄" data-drop-rail="">
      {columns.map((c) => {
        const here = c.key === from;
        return (
          <div
            key={c.key}
            className={"m-bd-dockcell" + (here ? " is-here" : "") + (c.status === "done" ? " is-seal" : "")}
            {...(here || leaving ? {} : { "data-drop-target": c.key, "data-drop-type": DOCK_TYPE, "data-drop-ghost": "above" })}
          >
            <b>{c.title}</b>
            <small>{here ? "在這欄" : countText(c)}</small>
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
