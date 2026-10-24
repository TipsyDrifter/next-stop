/**
 * CalendarCell——行程表月格／週格的「一格」（UI 丙-3 D4；取代舊的 calendar/DayCell.tsx）。
 *
 * 外殼一律是共用 `common/DayCell`（視覺規範 §2.5「日曆格」：今天＝赭字＋赭菱形、選中＝--sel-bg、右上常駐淡態「＋」）；
 * 行程表自己的內容放進 children（`.ns-daycell-body`）：
 *
 *   div.ns-daycell.cal-cell[.is-today|.is-on|.is-out][data-day]
 *     button.ns-daycell-hit（蓋滿整格的點擊面＝鍵盤落點與浮層錨；aria-label「10月12日（今天），3 班，締切 1 件」）
 *     span.ns-daycell-num（日數；週視圖在數字前補星期字，week.css）
 *     button.ns-daycell-add「＋」（今天與未來才有：過去的日子不能建票，P10；不在 Tab 序裡，見 useAddOutOfTabOrder）
 *     div.ns-daycell-body
 *       span.cal-corner（右上、「＋」左邊）：三線記號 i.mark.mark-<line>…＋格角〆 span.sime（hover 出 DueTip）
 *       div.items > div.it[.done|.skipped|.late] > i.dot（路線色）＋票名 …／div.more「＋N 張」（只有月格截斷）
 *
 * 區間外（上／下個月）只畫日數：不可點、不可聚焦、沒有「＋」與清單（原型 `.cell.out` 的口徑不變）。
 * 選中（`.is-on`）＝當日浮層開著的那一天（原型 ui-c3 的 `.is-pop`）；鍵盤落點另由 `tabIndex` 管（roving：只有落點格 0）。
 *
 * 刻意的三件事（沿舊 DayCell）：
 *   - 路線色點取 `routes[].color`（`--route-preset-N` 或自訂 #hex），無路線＝`--route-none`。
 *   - 運休＝淡化不刪除線；已済＝淡＋刪除線；漏班＝赭（三者互斥，順序即優先權）。
 *   - 〆 只是標記，明細在 hover 的 tip（DueTip）與浮層締切段；點〆＝點格（〆 不吃 click，落到點擊面）。
 */
import { useLayoutEffect, type RefObject } from "react";
import type { NodeRow } from "../../domain";
import type { DateCount, DueEntry, ScheduleEntry } from "../../data";
import { DayCell } from "../common/DayCell";
import { useCalendar } from "./useCalendarController";

export interface CalendarCellProps {
  /** YYYY-MM-DD */
  day: string;
  /** 落在目前區間內（月視圖＝本月、週視圖＝本週） */
  inRange: boolean;
  isToday: boolean;
  /** 今天以前（不畫「＋」：過去的日子不能建票） */
  isPast: boolean;
  entries: ScheduleEntry[];
  dues: DueEntry[];
  nodes: Record<string, NodeRow>;
  routes: NodeRow[];
  /** 鍵盤落點（roving tabIndex） */
  focusable: boolean;
  /** 當日浮層開著的那一天（--sel-bg） */
  open: boolean;
  /** 月視圖 true＝前 3 筆＋「＋N 張」；週視圖 false＝全列 */
  truncate: boolean;
  count?: DateCount;
  onOpen(anchor: HTMLElement): void;
  onAdd(): void;
  /** 滑過／離開格角〆（DueTip）；離開時傳 null */
  onTip(anchor: HTMLElement | null): void;
}

/**
 * 格線裡的「＋」一律退出 Tab 序（roving tabindex：整張格線只有落點格一個 Tab stop）。
 * 共用 DayCell 的「＋」是原生 button、預設 tabIndex 0，沒給呼叫端改 tabIndex 的口——不處理的話，
 * 從落點格按 Tab 會依序經過本月每個今天／未來的「＋」（月初多達三十幾站）才離開格線。
 * 鍵盤路徑另有：Enter 開當日浮層，浮層底端就是「＋ 車票」草稿列，所以「＋」只留給滑鼠／觸控。
 * 做法：格線容器每次 render 後把 `.ns-daycell-add` 的 tabIndex 設 −1（React 不管這個屬性，不會被蓋回去）。
 * ⚠ 暫行：等 common/DayCell 開 `addTabIndex` 之類的 prop 後改由 CalendarCell 傳 −1、刪掉本 hook。
 */
export function useAddOutOfTabOrder(ref: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    ref.current?.querySelectorAll<HTMLElement>(".ns-daycell-add").forEach((b) => {
      if (b.tabIndex !== -1) b.tabIndex = -1;
    });
  });
}

/** 月格截斷：前 3 筆（原型 ui-c3 的月格 100px 放得下三列；舊版 2 筆＋「＋N」） */
const MONTH_SHOWN = 3;

const cx = (...parts: Array<string | false | undefined>) => parts.filter(Boolean).join(" ");

/** 這一列在格內要用哪一種筆調：済＞運休＞漏班（三者互斥，順序即優先權） */
function toneOf(e: ScheduleEntry): string | undefined {
  if (e.is_done) return "done";
  if (e.occurrence_status === "skipped") return "skipped";
  if (e.is_late) return "late";
  return undefined;
}

export function CalendarCell({
  day,
  inRange,
  isToday,
  isPast,
  entries,
  dues,
  nodes,
  routes,
  focusable,
  open,
  truncate,
  count,
  onOpen,
  onAdd,
  onTip,
}: CalendarCellProps) {
  // 三線格內記號（0-2 乙插槽）：直接取控制器 context；三線零登記＝undefined
  const marks = useCalendar().marks[day];

  if (!inRange) return <DayCell date={day} out className="cal-cell" />;

  const total = count?.total ?? entries.length;
  const shown = truncate ? entries.slice(0, MONTH_SHOWN) : entries;
  const rest = entries.length - shown.length;
  const dnum = Number(day.slice(8, 10));
  const label =
    `${Number(day.slice(5, 7))}月${dnum}日` +
    (isToday ? "（今天）" : "") +
    (total ? `，${total} 班` : "") +
    (dues.length ? `，締切 ${dues.length} 件` : "");

  return (
    <DayCell
      date={day}
      today={isToday}
      selected={open}
      className="cal-cell"
      ariaLabel={label}
      tabIndex={focusable ? 0 : -1}
      onClick={(_d, anchor) => onOpen(anchor)}
      onAdd={isPast ? undefined : () => onAdd()}
      addLabel="在這天新增車票"
    >
      {(marks?.length || dues.length > 0) && (
        <span className="cal-corner" aria-hidden>
          {marks?.map((id) => <i key={id} className={`mark mark-${id}`} />)}
          {dues.length > 0 && (
            <span
              // 相鄰錯開：偶數日 -8.5°（原型 :1016-1018）
              className={cx("sime", dnum % 2 === 0 && "alt")}
              title={`締切 ${dues.length} 件`}
              onMouseEnter={(e) => onTip(e.currentTarget)}
              onMouseLeave={() => onTip(null)}
            >
              〆{dues.length > 1 && <span className="n">{dues.length}</span>}
            </span>
          )}
        </span>
      )}
      {shown.length > 0 && (
        <div className="items" aria-hidden>
          {shown.map((e) => {
            const node = nodes[e.node_id];
            const route = node?.route_id ? routes.find((r) => r.id === node.route_id) : undefined;
            return (
              <div key={`${e.date}-${e.node_id}`} className={cx("it", toneOf(e))} title={node?.name}>
                <i className="dot" style={{ background: route?.color ?? "var(--route-none)" }} />
                <span className="nm">{node?.name ?? ""}</span>
              </div>
            );
          })}
          {rest > 0 && <div className="more">＋{rest} 張</div>}
        </div>
      )}
    </DayCell>
  );
}
