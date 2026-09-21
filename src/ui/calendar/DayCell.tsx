/**
 * DayCell——日曆的「一格」（M3 ⑤ WP2）。月視圖與週視圖**共用同一個元件**，差別只有排列與 `truncate`
 * （D-⑤-1 甲：週＝月格元件換排列，禁止另畫）。
 *
 * 視覺真相＝prototypes/m3-ext-calendar.html :524-575（`.cell／.ch／.dnum／.cnt／.items／.it／.dot／
 * .more／.sime`）＋ :1001-1020（cellHTML）。DOM 與 class 逐字，只換資料與事件：
 *
 *   <div class="cell in [today]" data-day tabindex role="button" aria-label>
 *     <div class="ch"><span class="dnum">12</span><span class="cnt">3 班</span></div>
 *     <div class="items">
 *       <div class="it [done|skipped|late]"><i class="dot" style="background:路線色"></i>票名</div>
 *       …前 2 筆（月）／全部（週）…
 *       <div class="more">＋2</div>          ← 只有月視圖會出現
 *     </div>
 *     <span class="sime [alt]">〆<span class="n">2</span></span>   ← 締切層（格角赭色）
 *   </div>
 *
 * 區間外（`inRange=false`）＝原型的 `.cell.out`：**只畫日數**，不可聚焦、不出計數與〆（:1027-1028）。
 *
 * 刻意的三件事：
 *   - 路線色點取 `routes[].color`（`--route-preset-N` 或自訂 #hex），無路線＝`--route-none`；
 *     原型的 `.r-e1／.r-j` 假 class 不搬（雷區 9）。
 *   - 運休班次（`occurrence_status==="skipped"`）＝**淡化不刪除線**（技術自決；④ 評審「運休只淡紙不淡字」
 *     的同構）；已済＝`.done` 淡＋刪除線；漏班＝`.late` 赭（D-⑤-3 甲：每個漏班日都赭）。
 *   - 〆 只是標記，明細在 hover 的 tip（WP5）與浮層締切段（WP3）；點〆＝開當日清單（冒泡到格，:1145-1147）。
 */
import type { NodeRow } from "../../domain";
import type { DateCount, DueEntry, ScheduleEntry } from "../../data";

export interface DayCellProps {
  /** YYYY-MM-DD */
  day: string;
  /** 落在目前區間內（月視圖＝本月、週視圖＝本週）；false＝原型的 `.out` 格 */
  inRange: boolean;
  isToday: boolean;
  entries: ScheduleEntry[];
  dues: DueEntry[];
  /** entries／dues 提到的節點表（票名與路線由此查） */
  nodes: Record<string, NodeRow>;
  routes: NodeRow[];
  /** 鍵盤焦點的落點（roving tabindex）——原型沒有「選中格」的視覺，只影響 tabIndex 與 focus ring */
  selected: boolean;
  /** 月視圖 true＝前 2 筆＋「＋N」；週視圖 false＝全列（D-⑤-1 甲） */
  truncate: boolean;
  /** `countByDate` 算出來的這格計數；沒給就退回 `entries.length`（兩者同值） */
  count?: DateCount;
  onOpen(anchor: HTMLElement | null): void;
  /** 滑過／離開格角〆（WP5 的 tip）；離開時傳 null */
  onTip(anchor: HTMLElement | null): void;
}

const cx = (...parts: Array<string | false | undefined>) => parts.filter(Boolean).join(" ");

/** 這一列在格內要用哪一種筆調：済＞運休＞漏班（三者互斥，順序即優先權） */
function toneOf(e: ScheduleEntry): string | undefined {
  if (e.is_done) return "done";
  if (e.occurrence_status === "skipped") return "skipped";
  if (e.is_late) return "late";
  return undefined;
}

export function DayCell({
  day,
  inRange,
  isToday,
  entries,
  dues,
  nodes,
  routes,
  selected,
  truncate,
  count,
  onOpen,
  onTip,
}: DayCellProps) {
  const dnum = Number(day.slice(8, 10));

  if (!inRange) {
    return (
      <div className="cell out" aria-hidden>
        <div className="ch">
          <span className="dnum">{dnum}</span>
        </div>
      </div>
    );
  }

  const total = count?.total ?? entries.length;
  const shown = truncate ? entries.slice(0, 2) : entries;
  const rest = entries.length - shown.length;
  const month = Number(day.slice(5, 7));
  const label =
    `${month}月${dnum}日` +
    (isToday ? "（今天）" : "") +
    (total ? `，${total} 班` : "") +
    (dues.length ? `，締切 ${dues.length} 件` : "");

  return (
    <div
      className={cx("cell", "in", isToday && "today")}
      data-day={day}
      tabIndex={selected ? 0 : -1}
      role="button"
      aria-label={label}
      onClick={(e) => onOpen(e.currentTarget)}
    >
      <div className="ch">
        <span className="dnum">{dnum}</span>
        {total > 0 && <span className="cnt">{total} 班</span>}
      </div>

      {shown.length > 0 && (
        <div className="items">
          {shown.map((e) => {
            const node = nodes[e.node_id];
            const route = node?.route_id ? routes.find((r) => r.id === node.route_id) : undefined;
            return (
              <div key={`${e.date}-${e.node_id}`} className={cx("it", toneOf(e))} title={node?.name}>
                <i className="dot" style={{ background: route?.color ?? "var(--route-none)" }} />
                {node?.name ?? ""}
              </div>
            );
          })}
          {rest > 0 && <div className="more">＋{rest}</div>}
        </div>
      )}

      {dues.length > 0 && (
        <span
          // 相鄰錯開：偶數日 -8.5°（原型 :1016-1018）
          className={cx("sime", dnum % 2 === 0 && "alt")}
          aria-hidden
          title={`締切 ${dues.length} 件`}
          onMouseEnter={(e) => onTip(e.currentTarget)}
          onMouseLeave={() => onTip(null)}
        >
          〆
          {dues.length > 1 && <span className="n">{dues.length}</span>}
        </span>
      )}
    </div>
  );
}
