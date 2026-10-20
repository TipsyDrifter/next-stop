/**
 * DayRow——當日清單浮層裡的**一列**（M3 ⑤ WP3）。班次列（`.prow`）與締切列（`.prow` ＋ `.sime-g`）
 * 兩種，DOM／class 逐字移植 prototypes/m3-ext-calendar.html :1064-1096（popHTML 的兩段）。
 *
 * 本檔只負責「畫一列＋把點擊往上丟」，什麼能按、按了做什麼一律由 DayPopover 決定——
 * 可操作邊界（D-⑤-2 ⚡修訂）是資料規則不是視覺規則，集中在一處才不會兩邊各判一次：
 *
 *   単發票      ｜済（setCompleted）＋推遲鈕（DeferPopover 一般版）
 *   定期券・目前｜済只在這一列能按（而且要等這一班到了；理由見 canStampRow）；推遲鈕換成 rep 圖示
 *              （點它＝小卡定期券版：本班運休／編輯規則）
 *   定期券・未來｜済**空欄不可點**（hover 講明要到哪一天）；運休可按——rep 圖示同樣是按鈕（小卡＝
 *              提前請假／取消），已運休的那一列運休章上點一下也能取消，鍵盤 U 同義（D-⑤-2 修訂三入口）
 *   定期券・歷史｜唯讀（章還在，點不動）——歷史不可改，D-⑤-3
 *
 * 三處與原型不同、但都是「原型沒畫過就不自創」的最小處置：
 *   - rep 圖示在目前／未來班次列是**按鈕**（原型是純圖示）：定期券沒有推遲鈕，小卡要有入口才叫得出來
 *     （拍板 D-⑤-2 修訂點名「浮層鈕、小卡定期券版」＝滑鼠也要走得到提前請假，不能只剩鍵盤 U）。
 *   - 運休章＝既有的 `SealSuspended` 角印壓在検印欄上（`--ns-zoom: .8`，刻意出格換可讀），
 *     不另畫一枚小號角印（印章家族單一原件）。
 *   - 列可聚焦（roving tabIndex）＝浮層鍵盤流的落點；選中沒有底色，只有 `:focus-visible` 的環
 *     （同 DayCell 的處置：原型沒有「選中列」這個視覺）。
 */
import type { KeyboardEvent, MouseEvent } from "react";
import type { NodeRow } from "../../domain";
import { parseRule } from "../../domain";
import type { DueEntry, ScheduleEntry } from "../../data";
import { isTimeOverridden } from "../../domain/scheduledTime";
import { clockMinutes, isClockPast, nextDayNote } from "../../lib/date";
import { useUiStore } from "../../store/uiStore";
import { roundelStyle } from "../common/roundel";
import { hotkeyCaps } from "../common/PopMenu";
import { SealSuspended } from "../stamps";
// 時刻字（.tm）的樣式在 schedule.css（串流 .ns-sch 與當日清單浮層 .ns-daypop 兩個前綴都寫在那裡）
import "../schedule/schedule.css";

const cx = (...parts: Array<string | false | undefined>) => parts.filter(Boolean).join(" ");

/** 一列在浮層裡的身分（由 DayPopover 算好；欄位語義見檔頭的四種列） */
export interface DayRowModel {
  /** React key／選取用的穩定鍵：一天一張票只會有一列 */
  key: string;
  entry: ScheduleEntry;
  node: NodeRow | undefined;
  route: NodeRow | undefined;
  /** 定期券（規則 parse 得出來；legacy 自由文字算單發票，與 listSchedule 同一把尺） */
  isRepeat: boolean;
  /** 目前班次（單發票恆 true）＝ `entry.date` 落在 `scheduled_on` 或 `currentOccurrences[id].due_on` */
  isCurrent: boolean;
  /** 未來班次（定期券，`entry.date > today`）：提前請假可以，蓋済不行 */
  isFuture: boolean;
  /** 歷史班次（定期券，今天以前且不是目前班次）：唯讀 */
  isHistory: boolean;
  /** 這一班還沒到（`entry.date > today`）——済要等到那一天才蓋得下去，見 `canStampRow` */
  ahead: boolean;
  done: boolean;
  skipped: boolean;
  late: boolean;
  /** 臨時車票（無父節點的車票）＝粉彩版手寫體（承 C2「補充券」由來） */
  rin: boolean;
}

/**
 * 把一筆 ScheduleEntry 攤成一列的身分（唯一一處判斷，DayPopover 的鍵盤動作也吃這份）。
 *
 * @param occDue `currentOccurrences[node_id]?.due_on`＝store 認定「這一列現在正在講的那一班」
 *               （`listCurrentOccurrences`→`pickTodayOccurrence`）；沒有結局時為 null
 * @param today  日界線今天——「歷史／未來」以它為界（不是以 `scheduled_on` 為界，理由見下）
 */
export function dayRowModel(
  entry: ScheduleEntry,
  node: NodeRow | undefined,
  route: NodeRow | undefined,
  occDue: string | null,
  today: string,
): DayRowModel {
  const isRepeat = entry.kind === "repeat" || (node ? parseRule(node.repeat_rule) !== null : false);
  // 定期券的「目前班次」有**兩個**日子，正好對上 store 的兩條路徑——兩個都算「這一班」，
  // UI 能按的與 store 收得下的才會一致（不會出現讓按卻被擋下、或該反悔卻鎖住）：
  //   ① 蓋済 `setCompleted(id,true)` 蓋在 `node.scheduled_on`（引擎推到的下一班）
  //   ② 撤章／撤運休 `setCompleted(id,false)`／`skipOccurrence(id,false)` 撤在
  //      `pickTodayOccurrence` 認的那一班＝`currentOccurrences[id].due_on`（nodeRepository.ts:348-384）
  // 交代完的那一班會被引擎推走（今天蓋済後 scheduled_on 已指向下一班），只看 ① 的話今天這一列
  // 會當場變「歷史」鎖住、反悔無路——② 就是補這個洞的（與大綱 OutlineRow.tsx:249 同一把尺）。
  const sched = node?.scheduled_on ?? null;
  const isCurrent =
    !isRepeat || (sched !== null && entry.date === sched) || (occDue !== null && entry.date === occDue);
  // 歷史／未來以**今天**為界，不以 `scheduled_on` 為界：本班運休之後引擎把 scheduled_on 推到下一班，
  // 被運休的那一天就會落在 `scheduled_on` 之前——真機那筆「9/13 運休、scheduled_on 9/14」照舊寫法
  // 會被判成「歷史班次唯讀」而鎖住，明天的班次卻叫歷史、請假還撤不掉（真機 DB 複本抓到）。
  const isFuture = isRepeat && !isCurrent && entry.date > today;
  return {
    key: `${entry.date}-${entry.node_id}`,
    entry,
    node,
    route,
    isRepeat,
    isCurrent,
    isFuture,
    isHistory: isRepeat && !isCurrent && !isFuture, // 含退役定期券（沒有目前班次）＝整條唯讀
    ahead: entry.date > today,
    done: entry.is_done,
    skipped: entry.occurrence_status === "skipped",
    late: entry.is_late,
    rin: node?.kind === "ticket" && !node.parent_id,
  };
}

/**
 * 検印欄能不能動（唯一一處；`DayRow` 的鈕與 `DayPopover` 的 Space 都吃這支，鍵盤不會繞過視覺上的鎖）。
 * 三條，**撤章比蓋章寬**——蓋下去的每一章都要有路撤回來：
 *   運休中｜目前或未來班次都能撤（提前請假反悔）；歷史唯讀（D-⑤-3）
 *   已済　｜只有目前班次能撤（store 的 `setCompleted(false)` 撤的就是那一班）
 *   空欄　｜目前班次；**定期券**還要等這一班到了才蓋得下去（`!ahead`）
 *
 * 最後那條 `!ahead` 是實證修的：引擎的「目前班次」在今天交代完之後會指向**明天**，不擋的話可以
 * 提前把明天的章蓋下去——而 `pickTodayOccurrence` 之後認的仍是今天那一班，蓋完就撤不回來
 * （會撤到今天的章）。等到那一天再蓋，済 才是可逆的；漏班的補済不受影響（班次日在過去）。
 * **只擋定期券**：單發票提早做完就蓋，章落在票本身（status）、撤得回來，沒有這個問題。
 */
export function canStampRow(row: DayRowModel): boolean {
  if (row.skipped) return row.isCurrent || row.isFuture;
  if (row.done) return row.isCurrent;
  return row.isCurrent && !(row.isRepeat && row.ahead);
}

/** 路線圓牌上的字：代碼→路線名首字→「臨」（無路線；同 DueTip.tsx 的慣例） */
export function badgeOf(route: NodeRow | undefined): string {
  return route?.code ?? (route ? route.name.slice(0, 1) : "臨");
}

/** M/D（「執行 9/14」與 hover 提示共用） */
export function mmdd(key: string): string {
  return `${Number(key.slice(5, 7))}/${Number(key.slice(8, 10))}`;
}

export interface DayRowProps {
  row: DayRowModel;
  /** 鍵盤落點（roving tabIndex） */
  selected: boolean;
  /** 剛蓋下去：播 stampIn */
  fresh: boolean;
  onFreshEnd(): void;
  onSelect(): void;
  /** 検印欄：済／取消済／取消運休（哪一種由 DayPopover 依列的身分決定） */
  onStamp(): void;
  /** 推遲鈕（單發票）／rep 圖示（定期券目前班次）——都是開 DeferPopover，錨＝被點的那顆 */
  onDefer(anchor: HTMLElement): void;
  /**
   * 現在（useMinuteTick；主線②）：時刻已過、沒入鋏也沒蓋済 ⇒ 時刻字轉赭。
   * 選填——當日清單浮層（DayPopover，不准碰）不傳，就只印時刻、不判已過。
   */
  now?: number;
}

/**
 * 票面上的時刻（主線② D-主-12；原型 `:930-940` timeHTML 的 A 寫法）：
 *   span.tm[.past] ＝ span.hm「14:00」＋ span.hz「発」／「発・90 分」＋（跨日）span.nx「隔天 01:00」＋（覆寫）span.once「本班」
 * 今日頁（TodayRow）、串流列與當日清單列（DayRow）共用這一份 DOM；字級由各自的 CSS 前綴給（schedule.css）。
 */
export function TicketTime({
  time,
  estimateMin,
  overridden,
  past,
  outOfAxis = false,
}: {
  time: string;
  estimateMin: number | null | undefined;
  overridden: boolean;
  past: boolean;
  /** 改日界線之後落到時段軸之外的時刻（03:30 遇上日界線 06）；時段視圖標「軸外」，列表也補一個同字的小註 */
  outOfAxis?: boolean;
}) {
  const nx = nextDayNote(time);
  return (
    <span className={past ? "tm past" : "tm"} title={past ? "已過發車時刻、還沒入鋏也沒蓋済" : "預定時刻"}>
      <span className="hm">{time}</span>
      <span className="hz">{estimateMin && estimateMin > 0 ? `発・${estimateMin} 分` : "発"}</span>
      {nx && <span className="nx">{nx}</span>}
      {outOfAxis && (
        <span className="oob" title="這個時刻落在日界線之外，時段視圖放不進軸，改放「未定時」帶">
          軸外
        </span>
      )}
      {overridden && (
        <span className="once" title="只改了這一班的時刻">
          本班
        </span>
      )}
    </span>
  );
}

export function DayRow({ row, selected, fresh, onFreshEnd, onSelect, onStamp, onDefer, now }: DayRowProps) {
  const name = row.node?.name ?? "";
  const disc = roundelStyle(row.route?.color);
  const serif = !row.route;
  // 時刻（主線②）：赭＝已過、沒入鋏、沒結局。入鋏是節點層的狀態，定期券只算目前那一班（同 TimeGrid 的口徑）
  const time = row.entry.time;
  const settled = row.done || row.skipped;
  const doing = row.node?.status === "doing" && (!row.isRepeat || row.node.scheduled_on === row.entry.date);
  const past = time !== null && now !== undefined && !settled && !doing && isClockPast(row.entry.date, time, now);

  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const tMin = time !== null ? clockMinutes(time) : null;
  const outOfAxis = tMin !== null && (tMin < dayStartHour * 60 || tMin >= dayStartHour * 60 + 1440);

  const canStamp = canStampRow(row);
  const stampTitle = row.skipped
    ? canStamp
      ? "本班運休中——再點一次取消（或按 U）"
      : "歷史班次唯讀——運休只能對目前或未來的班次"
    : row.done
      ? row.isCurrent
        ? "取消済章"
        : "歷史班次唯讀"
      : canStamp
        ? "蓋章：完成（Space）"
        : row.isRepeat && (row.ahead || row.isFuture)
          ? `這班要到 ${mmdd(row.entry.date)} 才能蓋——済只蓋目前班次`
          : "歷史班次唯讀——只能交代目前班次";

  const stampInner = (
    <>
      <span className="seal-s" aria-hidden onAnimationEnd={fresh ? onFreshEnd : undefined}>
        済
      </span>
      {row.skipped && (
        <span className="susp-slot" aria-hidden>
          <SealSuspended title="運休（本班停駛）" />
        </span>
      )}
    </>
  );

  return (
    <div
      className={cx(
        "prow",
        row.done && "done",
        row.skipped && "skipped",
        row.late && "late",
        row.rin && "rin",
        fresh && "fresh",
      )}
      data-row-key={row.key}
      tabIndex={selected ? 0 : -1}
      role="group"
      aria-label={name}
      onMouseDown={onSelect}
    >
      <span className={cx("roundel-s", serif && "serif")} aria-hidden style={disc}>
        {badgeOf(row.route)}
      </span>
      {time !== null && (
        <TicketTime
          time={time}
          estimateMin={row.node?.estimate_min}
          overridden={row.node ? isTimeOverridden(row.node, row.entry.date) : false}
          past={past}
          outOfAxis={outOfAxis}
        />
      )}
      <span className="t" title={name}>
        {name}
      </span>
      <DetailButton nodeId={row.node?.id} />

      {row.isRepeat ? (
        // 定期券：原型的 rep 圖示（:1075）。目前**與未來**班次那一列點得動＝叫出小卡定期券版
        // （本班運休／取消運休＋編輯規則）——未來那顆就是拍板點名的「滑鼠提前請假」入口。
        row.isCurrent || row.isFuture ? (
          <button
            type="button"
            tabIndex={-1}
            className="rep rep-btn"
            title={
              row.isFuture
                ? `定期券：${mmdd(row.entry.date)} 這班運休（提前請假）／編輯重複規則`
                : "定期券：本班運休／編輯重複規則"
            }
            aria-label="定期券選項"
            onClick={(e: MouseEvent<HTMLButtonElement>) => {
              e.stopPropagation();
              onDefer(e.currentTarget);
            }}
          >
            <RepIcon />
          </button>
        ) : (
          <span className="rep" aria-label="重複班次" role="img" title="定期券的班次（由規則排定）">
            <RepIcon />
          </span>
        )
      ) : (
        <button
          type="button"
          tabIndex={-1}
          className="defer"
          title="推遲：執行日往後一天、過期票直接駛往明天（T／Shift+T 排今天／明天）"
          onClick={(e: MouseEvent<HTMLButtonElement>) => {
            e.stopPropagation();
            onDefer(e.currentTarget);
          }}
        >
          推遲
        </button>
      )}

      {canStamp ? (
        <button
          type="button"
          tabIndex={-1}
          className="stamp-s"
          aria-pressed={row.done}
          aria-label={row.skipped ? "取消本班運休" : row.done ? "取消完成" : "蓋章完成"}
          title={stampTitle}
          onClick={(e: MouseEvent<HTMLButtonElement>) => {
            e.stopPropagation();
            onStamp();
          }}
          onKeyDown={(e: KeyboardEvent<HTMLButtonElement>) => {
            // 焦點在鈕上時 Space／Enter 由鈕自己啟動，別再冒泡給浮層鍵盤表蓋第二次
            if (e.key === " " || e.key === "Enter") e.stopPropagation();
          }}
        >
          {stampInner}
        </button>
      ) : (
        // 不可點的空欄（未來／歷史班次）：保留検印圈的形，hover 講明為什麼按不得
        <span className="stamp-s locked" role="img" aria-disabled aria-label={stampTitle} title={stampTitle}>
          {stampInner}
        </span>
      )}
    </div>
  );
}

/**
 * 「詳情」小字鈕（10-20 磨光②；daylist.panel 的滑鼠入口）：選中那張票＋開詳情側板——今日列「票種小字」同一條路
 * （select＋setPanelOpen，與 scheduleActions.openPanel 同義）。月曆浮層與串流共用，締切列也有。
 * 浮層自己會在「側板 關→開」那一刻收起（DayPopover 的 panelOpen 監看），這裡不必通知它。
 * 長相＝票種小字那一階的淡字（不加框，免得跟「推遲」兩顆框並排）；列 hover／鍵盤聚焦才現身（CSS），平時不添雜訊。
 */
function DetailButton({ nodeId }: { nodeId: string | undefined }) {
  if (!nodeId) return null;
  return (
    <button
      type="button"
      tabIndex={-1}
      className="detail"
      aria-label="打開詳情側板"
      title={`詳情（${hotkeyCaps("daylist.panel")}）`}
      onClick={(e: MouseEvent<HTMLButtonElement>) => {
        e.stopPropagation();
        const ui = useUiStore.getState();
        ui.select(nodeId);
        ui.setPanelOpen(true);
      }}
    >
      詳情
    </button>
  );
}

/** 重複班次圖示（原型 :1075 的 inline SVG 逐字） */
function RepIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M11.8 7A4.8 4.8 0 1 1 9.6 3" />
      <path d="M9.4 1.2 9.7 3.2 7.7 3.6" />
    </svg>
  );
}

export interface DueRowProps {
  due: DueEntry;
  node: NodeRow | undefined;
  route: NodeRow | undefined;
  selected: boolean;
  onSelect(): void;
}

/** 締切列（原型 :1088-1094）：〆＋圓牌＋標題＋「詳情」＋「執行 M/D」或「未排執行日」。唯讀，只有 `.`／「詳情」開側板 */
export function DueRow({ due, node, route, selected, onSelect }: DueRowProps) {
  const name = node?.name ?? "";
  const exec = node?.scheduled_on ?? null;
  return (
    <div
      className="prow"
      data-row-key={`due-${due.date}-${due.node_id}`}
      tabIndex={selected ? 0 : -1}
      role="group"
      aria-label={`締切：${name}`}
      onMouseDown={onSelect}
    >
      <span className="sime-g" aria-hidden>
        〆
      </span>
      <span className={cx("roundel-s", !route && "serif")} aria-hidden style={roundelStyle(route?.color)}>
        {badgeOf(route)}
      </span>
      <span className="t" title={name}>
        {name}
      </span>
      <DetailButton nodeId={node?.id} />
      {exec ? (
        <span className="due-tag">執行 {mmdd(exec)}</span>
      ) : (
        // 無執行日的票只在締切日浮出來，格內清單沒有它——不講明會以為忘了排（決策 11）
        <span className="noexec">未排執行日</span>
      )}
    </div>
  );
}
