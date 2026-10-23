/**
 * Gallery——共用元件樣本頁（dev／mock 專用；UI 丙-2 契約 §0、§1「樣本頁」；視覺規範 §2，各組標自己的節號）。
 *
 * 用途：丙-2 只「建」元件、不套頁面，畫面上看不到它們——這一頁照 prototypes/ui-brand/index.html 第 05 章的順序，
 *   每件元件各畫一組（預設／hover 說明／focus／disabled／選中），每組標 class 名與規範節號，給 T8 截圖（ui-shots）與主席抽查。
 *   假資料、不接資料 store（只讀 uiStore 的 dayStartHour、按鈕叫 showToast 回饋）；點來點去只改本頁的 local state。
 * 開法：`?mock=1&gallery=1`（`DEV_FLAGS.gallery`：只在 mock／vite DEV 生效，正式打包恆 false）。
 *   App（桌機殼）把主欄的頁換成它、MobileShell（手機殼）把頁面換成它——同一支元件，兩殼靠 [data-shell] 自動換 token
 *   （手機殼 375 寬可看）。兩邊都用 React.lazy 掛：沒帶 gallery 的畫面一個 byte 都不多載。
 *   主題：`&theme=pastel|galaxy`（uiStore 既有覆寫），或頁頭「主題」分段鈕（只翻 <html data-theme>，不寫 settings）。
 *   桌機另有「殼：手機 375」：整頁內容掛 data-shell="mobile"，在桌機上直接看手機欄 token（不用縮視窗）。
 * 根：桌機＝`.page`（主欄唯一的捲動容器）；手機＝`.m-page`（手機殼唯一的捲動容器）。
 *
 * ARIA：每節一個 <section aria-labelledby>（標題是既有的 .sec h3）；目錄是一排 chip 按鈕（scrollIntoView，不改網址 hash）。
 *   樣本裡的 ARIA 都是元件自己的；靜態示範的 focus（gallery.css 的 .ns-gal-focus*）只畫框、不搶焦點。
 * 鍵盤：本頁不攔任何鍵；Tab 依序走過每個樣本，元件自己的鍵盤行為照常（Tabs／Segmented ←→、DateChip 開挑選器、
 *   ClockInput ↑↓…）。會開浮層的樣本（DialogShell、PopMenu、DateChip、手機殼「實際開一次」的 MSheet／MFullPage）是真的開，Esc 關。
 * 不畫：§2.6 列表與卡（車票 4 套 DOM 收 1 套在丙-3）、§2.9 其他印章（規格書 §6，本班沒動）；搬家來的
 *   AttachPicker／EntityTagField／DeferPopover／InlineInput／fields 要真資料、長相沒變，在原頁面看。
 * 樣式：`./gallery.css`（只有樣本頁的架子；元件長相全吃元件自己的 css）。
 */
import { Fragment, useEffect, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { addDays, todayKey } from "../../lib/date";
import { useUiStore } from "../../store/uiStore";
import { useShell } from "../mobile/useShell";
import { renderTabIcon } from "../mobile/tabs";
import { DateSeal, SealDone } from "../stamps";
import { PageHeader } from "../common/PageHeader";
import { Tabs, TabsSelect, type TabItem } from "../common/Tabs";
import { Segmented } from "../common/Segmented";
import { DateNav } from "../common/DateNav";
import { DateChip, dateChipText } from "../common/DateChip";
import { ClockInput, type ClockVariant } from "../common/ClockInput";
import { ColorPicker } from "../common/ColorPicker";
import { DayCell } from "../common/DayCell";
import { ManagerList, ManagerRow, SwatchDot, type PopMenuItem } from "../common/ManagerRow";
import { EmptyState } from "../common/EmptyState";
import { ErrorBar } from "../common/ErrorBar";
import { DialogShell, type DialogSize } from "../common/DialogShell";
import { MSheet, MSheetItem } from "../common/MSheet";
import { MFullPage } from "../common/MFullPage";
import { PopMenu, hotkeyCaps } from "../common/PopMenu";
import {
  IconAlert,
  IconBack,
  IconCalendar,
  IconChevron,
  IconClose,
  IconDots,
  IconDown,
  IconEdit,
  IconFirst,
  IconFlag,
  IconGear,
  IconLast,
  IconPlus,
  IconSearch,
  IconUp,
  TAB_ICONS,
  type TabIconKey,
} from "../common/icons";
import "./gallery.css";

/* ───────────── 小工具 ───────────── */

const noop = () => {};
/** 樣本鈕的回饋：出一則 toast（4 秒），證明點得到 */
const say = (message: string) => useUiStore.getState().showToast({ message });

/** "2026-10-22" ＋ 時分（＋幾天）→ 毫秒（ClockInput 的值） */
function at(dayKey: string, h: number, m: number, plusDays = 0): number {
  const [y, mo, d] = dayKey.split("-").map(Number);
  return new Date(y, mo - 1, d + plusDays, h, m).getTime();
}
function dateOf(dayKey: string): Date {
  const [y, mo, d] = dayKey.split("-").map(Number);
  return new Date(y, mo - 1, d);
}
type ThemeKey = "pastel" | "galaxy";
function readTheme(): ThemeKey {
  if (typeof document === "undefined") return "pastel";
  return document.documentElement.getAttribute("data-theme") === "dark" ? "galaxy" : "pastel";
}

/* ───────────── 架子 ───────────── */

const SECTIONS = [
  { id: "gal-header", title: "頁首" },
  { id: "gal-tabs", title: "分頁籤與分段鈕" },
  { id: "gal-btn", title: "按鈕" },
  { id: "gal-box", title: "容器" },
  { id: "gal-form", title: "表單控件" },
  { id: "gal-empty", title: "空狀態" },
  { id: "gal-tip", title: "提示" },
  { id: "gal-stamp", title: "運行中徽" },
  { id: "gal-state", title: "選中・聚焦" },
  { id: "gal-icon", title: "圖示" },
] as const;

function Sec({ id, title, note, children }: { id: string; title: string; note: string; children: ReactNode }) {
  return (
    <section id={id} className="ns-gal-sec" aria-labelledby={`${id}-t`}>
      <div className="sec">
        <h3 id={`${id}-t`}>{title}</h3>
        <span className="rule" />
        <span className="note">{note}</span>
      </div>
      {children}
    </section>
  );
}

/** 一組樣本＝舞台（渲染出來的元件）＋規格行（ui-brand 的 .bk-comp） */
function Comp({ children, spec, col }: { children: ReactNode; spec?: readonly (readonly [string, ReactNode])[]; col?: boolean }) {
  return (
    <div className="ns-gal-comp">
      <div className={"ns-gal-stage" + (col ? " is-col" : "")}>{children}</div>
      {spec && (
        <dl className="ns-gal-spec">
          {spec.map(([dt, dd]) => (
            <Fragment key={dt}>
              <dt>{dt}</dt>
              <dd>{dd}</dd>
            </Fragment>
          ))}
        </dl>
      )}
    </div>
  );
}

/** 一格：圖說（狀態・說明・class 名）在上，元件在下 */
function Cell({
  state,
  note,
  cls,
  wide,
  span,
  shell,
  children,
}: {
  state: string;
  note?: ReactNode;
  cls?: string;
  wide?: boolean;
  /** 在 .ns-gal-grid 裡占滿一整列 */
  span?: boolean;
  /** 只這一格換手機欄 token（data-shell="mobile"） */
  shell?: "mobile";
  children: ReactNode;
}) {
  return (
    <div className={"ns-gal-cell" + (wide ? " is-wide" : "") + (span ? " is-span" : "")} data-shell={shell}>
      <span className="ns-gal-cap">
        <b>{state}</b>
        {note != null && <>　{note}</>}
        {cls && (
          <>
            　<code>{cls}</code>
          </>
        )}
      </span>
      {children}
    </div>
  );
}

/** 手機框：掛 data-shell="mobile"（token 換手機欄），寬 375（窄螢幕撐滿）；h 給了才定高（sheet／全螢幕頁要） */
function Phone({ cap, h, children }: { cap: ReactNode; h?: number; children: ReactNode }) {
  const style = h ? ({ "--gal-h": `${h}px` } as CSSProperties) : undefined;
  return (
    <div className="ns-gal-phone-cell">
      <div className="ns-gal-phone" data-shell="mobile" style={style}>
        {children}
      </div>
      <span className="ns-gal-cap">{cap}</span>
    </div>
  );
}

/** 手機框裡墊在 sheet 後面的假內容（看得出暗幕蓋住的是頁面） */
function FakeRows({ rows }: { rows: readonly string[] }) {
  return (
    <div className="ns-gal-phone-body" aria-hidden="true">
      {rows.map((r) => (
        <div key={r} className="ns-gal-fakerow">
          {r}
        </div>
      ))}
    </div>
  );
}

/**
 * 手機頂帶的樣子（MobileTopBand 的靜態複本）：頁名＋拉丁小字｜（今日）日付印 46｜搜尋｜齒輪。
 * 真元件綁 store、開搜尋面板，樣式又只在手機 media 內（桌機「手機 375」預覽吃不到），所以樣本只畫長相、整條 aria-hidden；
 * 書封色與燙金線借 .ns-mfull-bar（同一條書封語彙），版面照 mobile.css 的 .m-band。
 */
function BandLook({ title, latin, seal }: { title: string; latin: string; seal?: Date }) {
  return (
    <div className="ns-mfull-bar ns-gal-band" aria-hidden="true">
      <span className="ns-gal-band-name">
        <span className="t">{title}</span>
        <span className="l">{latin}</span>
      </span>
      <span className="ns-gal-band-end">
        {seal && <DateSeal date={seal} size={46} />}
        <span className="ns-gal-band-btn">
          <IconSearch size={20} />
        </span>
        <span className="ns-gal-band-btn">
          <IconGear size={20} />
        </span>
      </span>
    </div>
  );
}

/** 快速跳轉的鍵帽字（registry 產：Windows「Ctrl+P」、Mac「⌘+P」；顯示端不手抄鍵位，見 probe:golden） */
const QJ_CAPS = hotkeyCaps("global.quickjump");

const FAKE_TICKETS = ["E1　審 Next Stop 風格原型", "J　背 N5 單字・な行 10 個", "L2　跑步 5K", "臨　預約牙醫回診", "J　讀文法書 §3 做筆記"];

/* ───────────── §2.1 頁首 ───────────── */

type SchedView = "month" | "week" | "time" | "stream";
const SCHED_TABS: readonly TabItem<SchedView>[] = [
  { key: "month", label: "月", hotkeyTitle: "按月看" },
  { key: "week", label: "週", hotkeyTitle: "按週看" },
  { key: "time", label: "時段" },
  { key: "stream", label: "串流" },
];
type TkView = "list" | "cal" | "stats";
const TK_TABS: readonly TabItem<TkView>[] = [
  { key: "list", label: "清單" },
  { key: "cal", label: "月曆" },
  { key: "stats", label: "統計" },
];
type TtView = "rain" | "axis" | "week" | "stats" | "sched" | "grid";
const TT_TABS: readonly TabItem<TtView>[] = [
  { key: "rain", label: "雨欄", hotkeyTitle: "雨欄（1）" },
  { key: "axis", label: "時間軸", hotkeyTitle: "只看時間軸（2）" },
  { key: "week", label: "週" },
  { key: "stats", label: "統計" },
  { key: "sched", label: "日程" },
  { key: "grid", label: "方眼" },
];

function HeaderSection({ today, phone }: { today: string; phone: boolean }) {
  const [sv, setSv] = useState<SchedView>("month");
  const [tkOff, setTkOff] = useState(0);
  const [tk, setTk] = useState<TkView>("list");
  const [tt, setTt] = useState<TtView>("rain");
  const [tt2, setTt2] = useState<TtView>("rain");
  const [mt, setMt] = useState<TtView>("rain");
  const [mt2, setMt2] = useState<"today" | "sched">("today");
  const d = dateOf(today);
  const month = `${d.getMonth() + 1}月`;
  const year = `${d.getFullYear()}年`;
  const monthLatin = d.toLocaleString("en-US", { month: "long" });
  const seal = <DateSeal date={d} size={92} title={`日付印 ${today}`} />;
  const tkD = new Date(d.getFullYear(), d.getMonth() + tkOff, 1);

  // 手機殼的頁首＝頂帶＋頂帶下一列的分頁籤列（兩殼共用這一組框；手機 375 只畫它、不畫 PageHeader）
  const phones = (
    <div className="ns-gal-phones">
      <Phone cap="今日：頂帶（頁名＋日付印＋搜尋＋齒輪）＋今日｜行程表（2 段撐滿）">
        <BandLook title="今日" latin="TODAY" seal={d} />
        <div className="ns-tabrow">
          <Tabs
            items={[
              { key: "today", label: "今日" },
              { key: "sched", label: "行程表" },
            ]}
            value={mt2}
            onChange={setMt2}
            aria-label="今日或行程表"
          />
        </div>
        <FakeRows rows={FAKE_TICKETS.slice(0, 2)} />
      </Phone>
      <Phone cap="時刻表：6 段 scroll 橫捲、末段露半格＋「管理」">
        <BandLook title="時刻表" latin="TIMETABLE" />
        <div className="ns-tabrow">
          <Tabs items={TT_TABS} value={mt} onChange={setMt} scroll aria-label="時刻表檢視" />
          <span className="mgr">
            <button type="button" className="ns-btn btn-text ns-btn--sm" onClick={() => say("樣本：管理")}>
              管理
            </button>
          </span>
        </div>
        <FakeRows rows={FAKE_TICKETS.slice(2, 4)} />
      </Phone>
    </div>
  );
  const phoneSpec = [
    ["手機", <>手機殼不用 PageHeader（§2.0）：頁首＝頂帶 <code>MobileTopBand</code>（頁名＋拉丁小字、今日頁蓋日付印、右上搜尋＋<b>齒輪</b>）＋頂帶下一列的 <code>tabsRow</code>／<code>manage</code> 插槽＝<code>.ns-tabrow</code>（整列玻璃、≤4 段一列；超過橫捲、末段露半格；末端「管理」文字鈕）。框裡的頂帶是靜態複本，真的看手機殼頁頂。</>],
  ] as const;

  if (phone) {
    return (
      <Sec id="gal-header" title="頁首" note="§2.1 PageHeader · 手機殼改頂帶">
        <Comp spec={phoneSpec}>
          <Cell
            wide
            state="手機 375：不畫 PageHeader"
            note="手機殼用 MobileTopBand＋分頁籤列；PageHeader 的兩種變體與窄版切回「桌機殼」看"
            cls="header.m-band ＋ .ns-tabrow"
          >
            {phones}
          </Cell>
        </Comp>
      </Sec>
    );
  }

  return (
    <Sec id="gal-header" title="頁首" note="§2.1 PageHeader · 一種骨架兩種變體">
      <Comp
        col
        spec={[
          ["規格", <>① 眉標（粉彩只畫拉丁斜體、銀河畫「中 — LATIN」）② 大標（身分式 <code>--fs-date</code>、頁名式 <code>--fs-display</code>）③ 補述 <code>aside</code>／統計 <code>stats</code> ④ 日付印 92 ⑤ 工具列<b>固定順序［分頁籤］［＋ 新增］［搜尋］［齒輪＋管理］</b>，沒給的格不畫 ⑥ 底線＋雙細線。</>],
          ["狀態", <><code>compact</code> 省略＝自動：主欄 &lt;704 或在手機殼就收——分頁籤改下拉、新增與搜尋收成圖示鈕（帶 title）、<b>管理永遠帶字</b>、日付印縮 76。hover：次鈕框轉 <code>--accent</code>、圖示鈕換 <code>--hover-bg</code>。</>],
          ["鍵盤", <>本身不攔鍵；工具列照 DOM 順序 Tab，分頁籤是一個 Tab stop（籤內 ←→）。</>],
        ]}
      >
        <Cell wide state="A 身分式" note="行程表：日期大標＋日付印；沒有線內管理＝第四格空著" cls="header.ns-pagehead.ns-pagehead--identity">
          <div className="ns-gal-scrollx">
            <PageHeader
              variant="identity"
              overline={{ zh: "行程表", latin: "Schedule" }}
              title={month}
              aside={
                <>
                  {year} <span className="ns-pagehead-latin">{monthLatin}</span>
                </>
              }
              stats={
                <>
                  本月 <b>38</b> 張 ・ 已到着 <b>21</b>
                </>
              }
              stamp={seal}
              tabs={{ items: SCHED_TABS, value: sv, onChange: setSv }}
              add={{ label: "車票", onClick: () => say("樣本：＋ 車票") }}
              search={{ onOpen: () => say("樣本：搜尋"), title: `搜尋（${QJ_CAPS}）` }}
            />
          </div>
        </Cell>
        <Cell wide state="A 身分式" note="售票口：月份大標＝DateNav（‹ 10月 › ＋今天）、無印、工具列四格齊" cls=".ns-toolbar ＋ h1 > .ns-datenav">
          <div className="ns-gal-scrollx">
            <PageHeader
              variant="identity"
              overline={{ zh: "售票口", latin: "Ticket Office" }}
              title={
                <DateNav
                  unit="month"
                  label="翻月份"
                  title={`${tkD.getMonth() + 1}月`}
                  onPrev={() => setTkOff((n) => n - 1)}
                  onNext={() => setTkOff((n) => n + 1)}
                  onToday={() => setTkOff(0)}
                  isToday={tkOff === 0}
                />
              }
              aside={`${tkD.getFullYear()}年`}
              stats={
                <>
                  本月支出 <b>¥18,420</b> ・ 收入 <b>¥52,000</b>
                </>
              }
              tabs={{ items: TK_TABS, value: tk, onChange: setTk }}
              add={{ label: "記一筆", onClick: () => say("樣本：＋ 記一筆") }}
              search={{ onOpen: () => say("樣本：搜尋") }}
              manage={{ label: "管帳", onClick: () => say("樣本：管帳") }}
            />
          </div>
        </Cell>
        <Cell wide state="B 頁名式" note="時刻表：大標是頁名" cls=".ns-pagehead--name">
          <div className="ns-gal-scrollx">
            <PageHeader
              variant="name"
              overline={{ zh: "時刻表", latin: "Timetable" }}
              title="時刻表"
              aside={dateChipText(today)}
              tabs={{ items: TT_TABS, value: tt, onChange: setTt }}
              add={{ label: "補記", onClick: () => say("樣本：＋ 補記") }}
              search={{ onOpen: () => say("樣本：搜尋"), title: `搜尋（${QJ_CAPS}）` }}
              manage={{ label: "分類與設定", onClick: () => say("樣本：分類與設定") }}
            />
          </div>
        </Cell>
        <Cell wide state="A 身分式" note="路線圖：路線名＋印；「＋ 路線 ▾」開選單（add.haspopup）" cls="aria-haspopup=menu">
          <div className="ns-gal-scrollx">
            <PageHeader
              variant="identity"
              overline={{ zh: "路線圖", latin: "Route Map" }}
              title="日文"
              aside={<span className="ns-pagehead-latin">J Line</span>}
              stamp={seal}
              add={{ label: "路線", haspopup: true, onClick: () => say("樣本：＋ 路線 ▾") }}
              search={{ onOpen: () => say("樣本：搜尋") }}
            />
          </div>
        </Cell>
        <Cell wide state="窄版（compact）" note="主欄 <704：籤→下拉、新增與搜尋→圖示鈕、管理帶字、印縮 76" cls=".ns-pagehead.is-compact">
          <div className="ns-gal-scrollx">
            <div className="ns-gal-narrow">
              <PageHeader
                compact
                variant="name"
                overline={{ zh: "時刻表", latin: "Timetable" }}
                title="時刻表"
                tabs={{ items: TT_TABS, value: tt2, onChange: setTt2 }}
                add={{ label: "補記", onClick: () => say("樣本：＋ 補記") }}
                search={{ onOpen: () => say("樣本：搜尋") }}
                manage={{ label: "分類與設定", onClick: () => say("樣本：分類與設定") }}
              />
              <PageHeader
                compact
                variant="identity"
                overline={{ zh: "今日", latin: "Today" }}
                title={dateChipText(today)}
                stamp={seal}
                add={{ label: "臨時車票", onClick: () => say("樣本：＋ 臨時車票") }}
                search={{ onOpen: () => say("樣本：搜尋") }}
              />
            </div>
          </div>
        </Cell>
      </Comp>
      <Comp spec={phoneSpec}>{phones}</Comp>
    </Sec>
  );
}

/* ───────────── §2.2 分頁籤與分段鈕 ───────────── */

type Settings4 = "general" | "sync" | "keys" | "about";
type Money = "out" | "in" | "move";
type Len = "15" | "30" | "60" | "90" | "120";
const LEN_OPTS = [
  { value: "15" as const, label: "15" },
  { value: "30" as const, label: "30" },
  { value: "60" as const, label: "60" },
  { value: "90" as const, label: "1h30" },
  { value: "120" as const, label: "120 分" },
];

function TabsSection() {
  const [a, setA] = useState<TtView>("rain");
  const [b, setB] = useState<Settings4>("general");
  const [c, setC] = useState<Settings4>("sync");
  const [sel, setSel] = useState<TtView>("axis");
  const [m, setM] = useState<Money>("out");
  const [m2, setM2] = useState<Money>("out");
  const [m3, setM3] = useState<Money>("in");
  const [len, setLen] = useState<Len | null>("90");
  const [custom, setCustom] = useState(false);
  const settings: TabItem<Settings4>[] = [
    { key: "general", label: "一般" },
    { key: "sync", label: "同步" },
    { key: "keys", label: "快捷鍵" },
    { key: "about", label: "關於" },
  ];
  const settingsDis: TabItem<Settings4>[] = settings.map((t) => (t.key === "keys" ? { ...t, disabled: true, why: "手機版沒有快捷鍵" } : t));
  const money = [
    { value: "out" as const, label: "支出" },
    { value: "in" as const, label: "收入" },
    { value: "move" as const, label: "轉帳" },
  ];
  const moneyDis = money.map((o) => (o.value === "move" ? { ...o, disabled: true, title: "要先有兩個帳戶才能轉帳" } : o));

  return (
    <Sec id="gal-tabs" title="分頁籤與分段鈕" note="§2.2 Tabs・Segmented · 兩件事">
      <Comp
        spec={[
          ["長相", <>襯線 700、<code>--fs-tab</code>、字距 .22em、段間虛線；選中＝<code>--sel-line</code> 底線滑塊（會滑）＋<code>--sel-fg</code> 字；高 <code>--ctl-tab</code>（桌機 36／手機 44）。桌機在工具列裡不加底；手機獨立一列整列玻璃。</>],
          ["hover", <>未選中籤字轉 <code>--color-ink-soft</code>＋淡 <code>--accent</code> 底（滑過看）。</>],
          ["鍵盤", <><code>role=tablist</code>＋<code>aria-selected</code>；一個 Tab stop，←→ 換籤（循環、跳過禁用、自動啟用），Home／End。</>],
        ]}
      >
        <Cell state="預設・選中" note="點得動，底線會滑" cls=".ns-tabs[role=tablist] > [role=tab].is-on">
          <Tabs items={TT_TABS.slice(0, 4)} value={a} onChange={setA} size="md" aria-label="樣本：時刻表檢視" />
        </Cell>
        <Cell state="focus" note="Tab 進來落在選中籤（靜態示範）" cls=":focus-visible → --focus-ring">
          <Tabs items={settings} value={b} onChange={setB} size="md" aria-label="樣本：設定分頁" className="ns-gal-focus-sel" />
        </Cell>
        <Cell state="disabled" note="--disabled＋not-allowed＋title 寫為什麼" cls="[role=tab]:disabled">
          <Tabs items={settingsDis} value={c} onChange={setC} size="md" aria-label="樣本：有禁用籤" />
        </Cell>
        <Cell state="窄版下拉" note="主欄 <704 時 PageHeader 換它" cls="TabsSelect .ns-select-wrap > .techo-input.ns-tabs-select">
          <TabsSelect items={TT_TABS} value={sel} onChange={setSel} aria-label="樣本：切換檢視" />
        </Cell>
      </Comp>
      <Comp
        spec={[
          ["長相", <>相連方格、1px <code>--color-dash</code> 框、<code>--radius-ctl</code>、黑體 <code>--fs-ui</code> 500；選中＝<code>--sel-bg</code> 底＋<code>--sel-fg</code> 字；高 <code>--ctl-seg</code>（32／手機 44）、緊湊 <code>--ctl-h-sm</code>（24／36）。手機撐滿一列平分。</>],
          ["hover", <>未選中段字轉 <code>--color-ink</code>。</>],
          ["鍵盤", <><code>role=radiogroup</code>＋<code>aria-checked</code>；Tab stop＝選中段；←→↑↓ 換選項、Home／End；value 可為 null（旁邊的「自訂…」chip 選中時）。</>],
        ]}
      >
        <Cell state="預設・選中" cls=".ns-seg[role=radiogroup] > [role=radio].is-on">
          <Segmented options={money} value={m} onChange={setM} aria-label="樣本：類型" />
        </Cell>
        <Cell state="focus" note="靜態示範" cls=":focus-visible → --focus-ring">
          <Segmented options={money} value={m2} onChange={setM2} aria-label="樣本：類型（聚焦）" className="ns-gal-focus-sel" />
        </Cell>
        <Cell state="disabled" note="title 寫為什麼" cls="[role=radio]:disabled">
          <Segmented options={moneyDis} value={m3} onChange={setM3} aria-label="樣本：類型（有禁用）" />
        </Cell>
        <Cell state="緊湊＋自訂 chip" note="長度組：選了「自訂…」分段鈕就沒有選中（value=null）" cls=".ns-seg.ns-seg--sm ＋ .chip.ns-chip">
          <div className="ns-gal-row">
            <Segmented
              compact
              options={LEN_OPTS}
              value={custom ? null : len}
              onChange={(v) => {
                setLen(v);
                setCustom(false);
              }}
              aria-label="樣本：長度"
            />
            <button type="button" className="chip ns-chip" aria-pressed={custom} onClick={() => setCustom((x) => !x)}>
              自訂…
            </button>
          </div>
        </Cell>
      </Comp>
    </Sec>
  );
}

/* ───────────── §2.3 按鈕 ───────────── */

function BtnRow({ level, cls, children, note }: { level: string; cls: string; children: ReactNode; note: ReactNode }) {
  return (
    <div className="ns-gal-btnrow">
      <span className="lv">{level}</span>
      {children}
      <span className="note">
        <code>{cls}</code>　{note}
      </span>
    </div>
  );
}
function St({ cap, children }: { cap: string; children: ReactNode }) {
  return (
    <span className="st">
      <span className="ns-gal-cap">{cap}</span>
      <span className="ns-gal-row">{children}</span>
    </span>
  );
}

function ButtonSection() {
  return (
    <Sec id="gal-btn" title="按鈕" note="§2.3 .ns-btn・.ns-iconbtn · 13 個基底收成 1">
      <Comp
        col
        spec={[
          ["規格", <>高 <code>--ctl-h</code>（32／手機 44）、緊湊 <code>--ctl-h-sm</code>（24／36）；內距 5px 14px；<code>--radius-ctl</code>；<code>--fs-ui</code> 500、字距 .12em。hover 欄是靜態示範（<code>.is-hover</code> 套同一組 :hover 宣告，滑過預設那顆看真的）；focus＝<code>--focus-ring</code>；disabled＝<code>--disabled</code> .3＋not-allowed＋不響應 hover＋<code>title</code> 寫為什麼（滑過停用鈕看得到）。</>],
          ["數量", <><b>一個面板、區段、sheet 只有一顆主鈕；即時存的表單沒有主鈕</b>。順序：取消在左、主鈕在右。文案動詞開頭 2～4 字。</>],
        ]}
      >
        <BtnRow level="主鈕" cls=".ns-btn.btn-seal" note="hover：抬一階陰影＋上移 1px（實心墨上 brightness 看不出來）">
          <St cap="預設">
            <button type="button" className="ns-btn btn-seal" onClick={() => say("樣本：建立")}>
              建立
            </button>
          </St>
          <St cap="hover">
            <button type="button" className="ns-btn btn-seal is-hover" tabIndex={-1}>
              建立
            </button>
          </St>
          <St cap="focus">
            <button type="button" className="ns-btn btn-seal ns-gal-focus" tabIndex={-1}>
              建立
            </button>
          </St>
          <St cap="disabled">
            <button type="button" className="ns-btn btn-seal" disabled title="還沒填名稱">
              建立
            </button>
          </St>
        </BtnRow>
        <BtnRow level="主鈕・書封上" cls=".ns-btn.btn-seal.on-cover" note="反白實心；焦點框照書封慣例用燙金 1px。底借全螢幕頁頂列 .ns-mfull-bar">
          <St cap="預設">
            <span className="ns-mfull-bar ns-gal-oncover">
              <button type="button" className="ns-btn btn-seal on-cover" onClick={() => say("樣本：存檔")}>
                存檔
              </button>
            </span>
          </St>
          <St cap="hover">
            <span className="ns-mfull-bar ns-gal-oncover">
              <button type="button" className="ns-btn btn-seal on-cover is-hover" tabIndex={-1}>
                存檔
              </button>
            </span>
          </St>
          <St cap="disabled">
            <span className="ns-mfull-bar ns-gal-oncover">
              <button type="button" className="ns-btn btn-seal on-cover" disabled title="還沒改任何欄位">
                存檔
              </button>
            </span>
          </St>
        </BtnRow>
        <BtnRow level="次鈕" cls=".ns-btn.btn-ghost" note="hover：框轉 --accent、字轉 --color-ink。取消、次要動作、頁首工具鈕、空狀態第一步">
          <St cap="預設">
            <button type="button" className="ns-btn btn-ghost" onClick={() => say("樣本：取消")}>
              取消
            </button>
          </St>
          <St cap="hover">
            <button type="button" className="ns-btn btn-ghost is-hover" tabIndex={-1}>
              取消
            </button>
          </St>
          <St cap="focus">
            <button type="button" className="ns-btn btn-ghost ns-gal-focus" tabIndex={-1}>
              取消
            </button>
          </St>
          <St cap="disabled">
            <button type="button" className="ns-btn btn-ghost" disabled title="已經是最早的一天">
              取消
            </button>
          </St>
        </BtnRow>
        <BtnRow level="文字鈕" cls=".ns-btn.btn-text" note="hover：底線。toast「復原」、空狀態第二行動、「新增…」「管理…」">
          <St cap="預設">
            <button type="button" className="ns-btn btn-text" onClick={() => say("樣本：復原")}>
              復原
            </button>
          </St>
          <St cap="hover">
            <button type="button" className="ns-btn btn-text is-hover" tabIndex={-1}>
              復原
            </button>
          </St>
          <St cap="focus">
            <button type="button" className="ns-btn btn-text ns-gal-focus" tabIndex={-1}>
              復原
            </button>
          </St>
          <St cap="disabled">
            <button type="button" className="ns-btn btn-text" disabled title="已經復原過了">
              復原
            </button>
          </St>
        </BtnRow>
        <BtnRow level="危險鈕" cls=".ns-btn.btn-ghost.ns-btn-danger" note="hover：框實、底 --danger-bg。刪除、封存、清空；永遠不實心">
          <St cap="預設">
            <button type="button" className="ns-btn btn-ghost ns-btn-danger" onClick={() => say("樣本：刪除")}>
              刪除
            </button>
          </St>
          <St cap="hover">
            <button type="button" className="ns-btn btn-ghost ns-btn-danger is-hover" tabIndex={-1}>
              刪除
            </button>
          </St>
          <St cap="focus">
            <button type="button" className="ns-btn btn-ghost ns-btn-danger ns-gal-focus" tabIndex={-1}>
              刪除
            </button>
          </St>
          <St cap="disabled">
            <button type="button" className="ns-btn btn-ghost ns-btn-danger" disabled title="路線上還有運行中的車票">
              刪除
            </button>
          </St>
        </BtnRow>
        <BtnRow level="圖示鈕" cls=".ns-iconbtn" note="28（手機 44）、無框；hover --hover-bg。一定有 aria-label＋title。第二顆＝常駐淡態 --dim（會轉實）">
          <St cap="預設・淡態">
            <button type="button" className="ns-iconbtn" aria-label="更多動作" title="更多動作" onClick={() => say("樣本：⋯")}>
              <IconDots />
            </button>
            <button type="button" className="ns-iconbtn ns-gal-dim" aria-label="更多動作" title="更多動作（常駐淡態）">
              <IconDots />
            </button>
          </St>
          <St cap="hover">
            <button type="button" className="ns-iconbtn is-hover" tabIndex={-1} aria-label="更多動作" title="更多動作">
              <IconDots />
            </button>
          </St>
          <St cap="focus">
            <button type="button" className="ns-iconbtn ns-gal-focus" tabIndex={-1} aria-label="關閉" title="關閉">
              <IconClose />
            </button>
          </St>
          <St cap="disabled">
            <button type="button" className="ns-iconbtn" disabled aria-label="上移" title="已經在最上面">
              <IconUp />
            </button>
          </St>
        </BtnRow>
      </Comp>
      <Comp>
        <Cell state="桌機 32／24" cls=".ns-btn--sm">
          <div className="ns-gal-row">
            <button type="button" className="ns-btn btn-seal">
              建立
            </button>
            <button type="button" className="ns-btn btn-seal ns-btn--sm">
              建立
            </button>
          </div>
        </Cell>
        <Cell state="手機 44／36" note="只這一格掛 data-shell=mobile" shell="mobile">
          <div className="ns-gal-row">
            <button type="button" className="ns-btn btn-seal">
              建立
            </button>
            <button type="button" className="ns-btn btn-seal ns-btn--sm">
              建立
            </button>
          </div>
        </Cell>
        <Cell state="淡態 .42 vs 禁用 .3" note="淡態會 hover 轉實；禁用不響應">
          <div className="ns-gal-row ns-gal-pairs">
            <span className="ns-gal-pair">
              <button type="button" className="ns-iconbtn ns-gal-dim" aria-label="更多動作" title="常駐淡態：滑過轉實">
                <IconDots />
              </button>
              <span className="ns-gal-cap">--dim</span>
            </span>
            <span className="ns-gal-pair">
              <button type="button" className="ns-iconbtn" disabled aria-label="更多動作" title="禁用：還沒発車">
                <IconDots />
              </button>
              <span className="ns-gal-cap">--disabled</span>
            </span>
            <span className="ns-gal-pair">
              <button type="button" className="ns-btn btn-ghost ns-btn--sm ns-gal-dim ns-gal-ibtn" title="常駐淡態：滑過轉實">
                <IconPlus />
                路線
              </button>
              <span className="ns-gal-cap">--dim</span>
            </span>
            <span className="ns-gal-pair">
              <button type="button" className="ns-btn btn-ghost ns-btn--sm ns-gal-ibtn" disabled title="禁用：還沒有幹線">
                <IconPlus />
                路線
              </button>
              <span className="ns-gal-cap">--disabled</span>
            </span>
          </div>
        </Cell>
        <Cell state="loading" note="字換「…中」＋aria-busy">
          <button type="button" className="ns-btn btn-seal" aria-busy="true">
            存檔中…
          </button>
        </Cell>
        <Cell state="順序" note="取消在左、主鈕在右">
          <div className="ns-gal-row">
            <button type="button" className="ns-btn btn-ghost">
              取消
            </button>
            <button type="button" className="ns-btn btn-seal">
              建立
            </button>
          </div>
        </Cell>
        <Cell state="線內管理" note="齒輪＋字">
          <button type="button" className="ns-btn btn-ghost ns-gal-ibtn">
            <IconGear />
            管帳
          </button>
        </Cell>
      </Comp>
    </Sec>
  );
}

/* ───────────── §2.4 容器 ───────────── */

type DlgKind = DialogSize | "ticket" | "live";

function RouteFields({ color, setColor }: { color: string | null; setColor: (c: string) => void }) {
  return (
    <>
      <label className="ns-gal-field">
        <span className="techo-label">名稱</span>
        <input className="techo-input" defaultValue="日文" />
      </label>
      <div className="ns-gal-field">
        <span className="techo-label">顏色 ・ 路線盤</span>
        <ColorPicker palette="route" value={color} onChange={setColor} custom />
      </div>
      <label className="ns-gal-field">
        <span className="techo-label">所屬幹線</span>
        <span className="ns-select-wrap">
          <select className="techo-input" defaultValue="learn">
            <option value="learn">學習</option>
            <option value="hobby">興趣</option>
            <option value="work">工作</option>
          </select>
        </span>
      </label>
    </>
  );
}

function BoxSection({ today, mobile }: { today: string; mobile: boolean }) {
  const [dlg, setDlg] = useState<DlgKind | null>(null);
  const [color, setColor] = useState<string | null>("var(--route-preset-2)");
  const [menuAt, setMenuAt] = useState<HTMLElement | null>(null);
  const [live, setLive] = useState<"sheet" | "list" | "full" | null>(null);
  const [due, setDue] = useState<string | null>(today);
  const [len, setLen] = useState<Len | null>("60");
  const close = () => setDlg(null);
  const foot = (main: string) => (
    <>
      <button type="button" className="ns-btn btn-ghost" onClick={close}>
        取消
      </button>
      <button type="button" className="ns-btn btn-seal" onClick={close}>
        {main}
      </button>
    </>
  );
  const menu: PopMenuItem[] = [
    { key: "go", label: "▶ 発車", onSelect: () => say("樣本：発車") },
    { key: "defer", label: "推遲到…", onSelect: () => say("樣本：推遲到…") },
    { key: "move", label: "移動到…", onSelect: () => say("樣本：移動到…") },
    { key: "stop", label: "途中下車", disabled: true, why: "還沒発車，不能途中下車", onSelect: noop },
    { key: "del", label: "刪除", cut: true, onSelect: () => say("樣本：刪除") },
  ];
  const sheetBody = (
    <>
      <label className="ns-gal-field">
        <span className="techo-label">名稱</span>
        <input className="techo-input" defaultValue="審 Next Stop 風格原型" />
      </label>
      <div className="ns-gal-field">
        <span className="techo-label">執行日</span>
        <DateChip date={due} onPick={setDue} quick="forward" label="執行日" today={today} />
      </div>
      <div className="ns-gal-field">
        <span className="techo-label">預計</span>
        <Segmented options={LEN_OPTS.slice(0, 4)} value={len} onChange={setLen} aria-label="預計" />
      </div>
    </>
  );
  const sheetFoot = (onDone: () => void) => (
    <>
      <button type="button" className="ns-btn btn-ghost" onClick={onDone}>
        取消
      </button>
      <button type="button" className="ns-btn btn-seal" onClick={onDone}>
        改好了
      </button>
    </>
  );
  const listItems = (onDone: () => void) => (
    <>
      <MSheetItem onClick={onDone}>▶ 発車</MSheetItem>
      <MSheetItem onClick={onDone}>推遲到…</MSheetItem>
      <MSheetItem onClick={onDone}>移動到…</MSheetItem>
      <MSheetItem onClick={onDone} disabled title="還沒発車，不能途中下車">
        途中下車
      </MSheetItem>
      <MSheetItem onClick={onDone} danger>
        刪除
      </MSheetItem>
    </>
  );
  const fullBody = (
    <>
      <label className="ns-gal-field">
        <span className="techo-label">名稱</span>
        <input className="techo-input" defaultValue="日文" />
      </label>
      <label className="ns-gal-field">
        <span className="techo-label">代碼</span>
        <input className="techo-input" defaultValue="J" />
      </label>
      <div className="ns-gal-field">
        <span className="techo-label">顏色</span>
        <ColorPicker palette="route" value={color} onChange={setColor} custom />
      </div>
    </>
  );

  return (
    <Sec id="gal-box" title="容器" note="§2.4 DialogShell・PopMenu・MSheet・MFullPage">
      <Comp
        spec={[
          ["規格", <><b>DialogShell</b>：<code>.techo-card</code>；標題列＝眉標（可省）＋<code>--fs-title</code> 襯線標題＋×；撕線；本文自己捲；<code>foot</code> 黏底按鈕列（取消左、主鈕右；即時存的不給）。寬 <code>size</code> S 380／M 520／L 620；<code>skin="ticket"</code>＝捕捉框票皮（票形 600、去處票根）。</>],
          ["鍵盤", <>開啟焦點落卡、Esc 關、點暗幕關、關閉還焦點。PopMenu：↑↓、Enter、Esc 回錨點；破壞性項目最後、虛線分隔。</>],
        ]}
      >
        <Cell state="置中對話框（點了真的開）" cls=".techo-card.ns-dialog.is-s|.is-m|.is-l ＋ .ns-dialog-foot">
          <div className="ns-gal-row">
            <button type="button" className="ns-btn btn-ghost" onClick={() => setDlg("S")}>
              S 380
            </button>
            <button type="button" className="ns-btn btn-ghost" onClick={() => setDlg("M")}>
              M 520
            </button>
            <button type="button" className="ns-btn btn-ghost" onClick={() => setDlg("L")}>
              L 620
            </button>
            <button type="button" className="ns-btn btn-ghost" onClick={() => setDlg("live")}>
              即時存（無 foot）
            </button>
            <button type="button" className="ns-btn btn-ghost" onClick={() => setDlg("ticket")}>
              票皮 ticket
            </button>
          </div>
        </Cell>
        <Cell state="選單" note="列尾 ⋯ 開 PopMenu（第四項 disabled、刪除在虛線後）" cls=".techo-card.ns-popmenu">
          <div className="ns-gal-row">
            <span className="ns-gal-hint">審 Next Stop 風格原型</span>
            <button
              type="button"
              className="ns-iconbtn"
              aria-label="更多動作"
              title="更多動作"
              aria-haspopup="menu"
              aria-expanded={menuAt !== null}
              onClick={(e: MouseEvent<HTMLButtonElement>) => {
                const el = e.currentTarget;
                setMenuAt((cur) => (cur ? null : el));
              }}
            >
              <IconDots />
            </button>
          </div>
        </Cell>
      </Comp>
      <Comp
        spec={[
          ["MSheet", <>上緣 <code>--radius-sheet</code>、拉柄 36×4、襯線標題（無 ×）、本文可捲、<code>foot</code> 黏底（取消左框線、主鈕右實心墨）；<code>height</code> auto ≤60%／half／full 90%；下滑、點暗幕、返回鍵、Esc 都能關。<code>list</code>＝動作清單型（52 列、刪除赭字在最後、殼自己補「取消」）。</>],
          ["MFullPage", <>頂列書封色（深面不消失）：左「取消／‹ 返回」、中標題、右主鈕 <code>.btn-seal.on-cover</code>；即時存的頁省略右鈕。</>],
          ["樣本", <>框裡是 <code>inline</code> 版（不 portal、不登記返回層、不搶焦點）。{mobile ? "下面的鈕在手機殼裡真的開一次。" : "手機殼的樣本頁另有「實際開一次」。"}</>],
        ]}
      >
        <div className="ns-gal-phones">
          <Phone cap="表單型 sheet：拉柄、襯線標題、按鈕列黏底（auto ≤60%）" h={640}>
            <FakeRows rows={FAKE_TICKETS} />
            <MSheet inline title="改一張車票" onClose={noop} foot={sheetFoot(noop)}>
              {sheetBody}
            </MSheet>
          </Phone>
          <Phone cap="動作清單型 sheet（票卡 ⋯）：52 列、刪除赭字、最後一列取消" h={640}>
            <FakeRows rows={FAKE_TICKETS} />
            <MSheet inline list title="審 Next Stop 風格原型" onClose={noop}>
              {listItems(noop)}
            </MSheet>
          </Phone>
          <Phone cap="全螢幕頁：書封色頂列（左取消、中標題、右主鈕）" h={480}>
            <MFullPage inline title="新增路線" left={{ label: "取消", onClick: noop }} right={{ label: "建立", onClick: noop }}>
              {fullBody}
            </MFullPage>
          </Phone>
          <Phone cap="全螢幕頁・即時存：‹ 返回、沒有主鈕" h={300}>
            <MFullPage inline title="日文" left={{ label: "返回", back: true, onClick: noop }}>
              <label className="ns-gal-field">
                <span className="techo-label">名稱</span>
                <input className="techo-input" defaultValue="日文" />
              </label>
            </MFullPage>
          </Phone>
        </div>
        {mobile && (
          <Cell wide state="實際開一次" note="手機殼：portal 到 body、登記返回層">
            <div className="ns-gal-row">
              <button type="button" className="ns-btn btn-ghost" onClick={() => setLive("sheet")}>
                表單 sheet
              </button>
              <button type="button" className="ns-btn btn-ghost" onClick={() => setLive("list")}>
                動作清單
              </button>
              <button type="button" className="ns-btn btn-ghost" onClick={() => setLive("full")}>
                全螢幕頁
              </button>
            </div>
          </Cell>
        )}
      </Comp>

      {dlg === "S" && (
        <DialogShell title="改路線名稱" overline="路線 — Route" size="S" onClose={close} foot={foot("改好了")}>
          <label className="ns-gal-field">
            <span className="techo-label">名稱</span>
            <input className="techo-input" defaultValue="日文" autoFocus />
          </label>
        </DialogShell>
      )}
      {dlg === "M" && (
        <DialogShell title="建立路線" overline="路線 — Route" size="M" onClose={close} foot={foot("建立")}>
          <div className="ns-gal-grid">
            <RouteFields color={color} setColor={setColor} />
          </div>
        </DialogShell>
      )}
      {dlg === "L" && (
        <DialogShell title="變成待辦" overline="收件匣 — Inbox" size="L" onClose={close} foot={foot("變成待辦")}>
          <div className="ns-gal-grid">{sheetBody}</div>
        </DialogShell>
      )}
      {dlg === "live" && (
        <DialogShell title="分類與設定" overline="時刻表 — Timetable" size="M" onClose={close}>
          <p className="ns-gal-hint">即時存的面板沒有按鈕列，關閉只有 ×（§2.3）。</p>
          <ManagerDemo />
        </DialogShell>
      )}
      {dlg === "ticket" && (
        <DialogShell
          title="記一句"
          overline="記一句 — Capture"
          skin="ticket"
          onClose={close}
          stub={
            <>
              <span className="techo-label">去處</span>
              <span>收件匣</span>
            </>
          }
        >
          <input className="techo-input" defaultValue="週五前把規範書頁面對齊 v2" aria-label="記一句" autoFocus />
          <p className="ns-gal-hint">Enter 存進收件匣 ・ 再按一次 Esc 放棄</p>
        </DialogShell>
      )}
      {menuAt && <PopMenu anchor={menuAt} overline="這張車票 — Ticket" label="車票動作" items={menu} onClose={() => setMenuAt(null)} />}
      {live === "sheet" && (
        <MSheet title="改一張車票" onClose={() => setLive(null)} foot={sheetFoot(() => setLive(null))}>
          {sheetBody}
        </MSheet>
      )}
      {live === "list" && (
        <MSheet list title="審 Next Stop 風格原型" onClose={() => setLive(null)}>
          {listItems(() => setLive(null))}
        </MSheet>
      )}
      {live === "full" && (
        <MFullPage title="新增路線" left={{ label: "取消", onClick: () => setLive(null) }} right={{ label: "建立", onClick: () => setLive(null) }}>
          {fullBody}
        </MFullPage>
      )}
    </Sec>
  );
}

/* ───────────── §2.5 表單控件 ───────────── */

function DateChipDemo(props: {
  init: string | null;
  today: string;
  quick?: "forward" | "backward";
  flag?: "late" | "backfill";
  clearable?: boolean;
  disabled?: boolean;
  allowPast?: boolean;
  label?: string;
}) {
  const { init, ...rest } = props;
  const [date, setDate] = useState<string | null>(init);
  return <DateChip {...rest} date={date} onPick={setDate} />;
}

function ClockDemo({
  variant,
  init,
  lo,
  hi,
  refDay,
  relative,
  label,
}: {
  variant: ClockVariant;
  init: number;
  lo: number;
  hi: number;
  refDay: string;
  relative?: boolean;
  label: string;
}) {
  const [v, setV] = useState(init);
  return <ClockInput variant={variant} value={v} lo={lo} hi={hi} onChange={setV} label={label} refDay={refDay} relative={relative} />;
}

interface DemoCat {
  id: string;
  name: string;
  color: number;
  archived?: boolean;
}
const DEMO_CATS: readonly DemoCat[] = [
  { id: "a", name: "上課", color: 1 },
  { id: "b", name: "吃飯", color: 4 },
  { id: "c", name: "運動", color: 3 },
  { id: "z", name: "舊社團", color: 8, archived: true },
];

/** ManagerRow 的清單（樣本）：改名、上下移、⋯ 封存／刪除都只改 local state */
function ManagerDemo() {
  const [cats, setCats] = useState<DemoCat[]>(() => [...DEMO_CATS]);
  const active = cats.filter((c) => !c.archived);
  const archived = cats.filter((c) => c.archived);
  const patch = (id: string, p: Partial<DemoCat>) => setCats((cs) => cs.map((c) => (c.id === id ? { ...c, ...p } : c)));
  const move = (id: string, dir: -1 | 1) =>
    setCats((cs) => {
      const act = cs.filter((c) => !c.archived);
      const i = act.findIndex((c) => c.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= act.length) return cs;
      [act[i], act[j]] = [act[j], act[i]];
      return [...act, ...cs.filter((c) => c.archived)];
    });
  const menuOf = (c: DemoCat): PopMenuItem[] => [
    { key: "arch", label: c.archived ? "取消封存" : "封存", onSelect: () => patch(c.id, { archived: !c.archived }) },
    { key: "del", label: "刪除", cut: true, onSelect: () => setCats((cs) => cs.filter((x) => x.id !== c.id)) },
  ];
  const row = (c: DemoCat, i: number, n: number) => (
    <ManagerRow
      key={c.id}
      name={c.name}
      onRename={(next) => patch(c.id, { name: next })}
      swatch={<SwatchDot color={`var(--cat-${c.color})`} />}
      onUp={c.archived || i === 0 ? undefined : () => move(c.id, -1)}
      onDown={c.archived || i === n - 1 ? undefined : () => move(c.id, 1)}
      menu={menuOf(c)}
      archived={c.archived}
    />
  );
  return (
    <>
      <ManagerList label="分類">
        {active.map((c, i) => row(c, i, active.length))}
        {archived.map((c, i) => row(c, i, archived.length))}
      </ManagerList>
      <div className="ns-gal-row">
        <button type="button" className="ns-btn btn-text ns-gal-ibtn" onClick={() => say("樣本：新增分類")}>
          <IconPlus />
          新增分類
        </button>
        <button type="button" className="ns-btn btn-text" onClick={() => setCats([...DEMO_CATS])}>
          重設樣本
        </button>
      </div>
    </>
  );
}

function FormSection({ today }: { today: string }) {
  const [navDay, setNavDay] = useState(today);
  const [diary, setDiary] = useState(today);
  const [ym, setYm] = useState(() => {
    const d = dateOf(today);
    return { y: d.getFullYear(), m: d.getMonth() + 1 };
  });
  const td = dateOf(today);
  const shiftMonth = (n: number) =>
    setYm(({ y, m }) => {
      const t = new Date(y, m - 1 + n, 1);
      return { y: t.getFullYear(), m: t.getMonth() + 1 };
    });
  const [len, setLen] = useState<Len | null>("90");
  const [custom, setCustom] = useState(false);
  const week = Array.from({ length: 7 }, (_, i) => addDays(today, i - 3));
  const marks = [0, 1, 2, 1, 3, 0, 1];
  const [picked, setPicked] = useState(addDays(today, -1));
  const [route, setRoute] = useState<string | null>("var(--route-preset-1)");
  const [cat, setCat] = useState<number | string | null>(4);
  const [pressed, setPressed] = useState<Record<string, boolean>>({ 本務: true, 休閒: true });
  const lo = at(today, 0, 0);
  const hi = at(today, 6, 0, 1);

  return (
    <Sec id="gal-form" title="表單控件" note="§2.5 DateNav・DateChip・ClockInput・ColorPicker・DayCell・ManagerRow">
      <Comp
        spec={[
          ["輸入框", <><code>.techo-input</code> 底線式、聚焦底線 <code>--accent</code>（不是金）、placeholder <code>--color-ink-faint</code>；小標 <code>.techo-label</code> 在上；行內錯誤一行 <code>--fs-sm</code> 赭字；大號＝<code>.ns-qj-input</code>（{QJ_CAPS}、標題欄，16px）。（基底沒有高度 token，樣本欄補 <code>--ctl-input</code>。）</>],
        ]}
      >
        <div className="ns-gal-grid">
          <Cell state="預設" cls=".techo-input">
            <label className="ns-gal-field">
              <span className="techo-label">名稱</span>
              <input className="techo-input" placeholder="例：日文" />
            </label>
          </Cell>
          <Cell state="focus" note="靜態示範">
            <label className="ns-gal-field">
              <span className="techo-label">名稱</span>
              <input className="techo-input ns-gal-focus" defaultValue="日文" tabIndex={-1} />
            </label>
          </Cell>
          <Cell state="錯誤" cls="aria-invalid">
            <label className="ns-gal-field">
              <span className="techo-label">幾點</span>
              <input className="techo-input" defaultValue="25:70" aria-invalid="true" />
              <span className="ns-gal-hint is-err">看不懂「25:70」——寫成 23:30 或 2330</span>
            </label>
          </Cell>
          <Cell state="大號" note={`${QJ_CAPS}、標題欄 16px（--fs-h3）`} cls=".techo-input.ns-qj-input" span>
            <label className="ns-gal-field">
              <span className="techo-label">搜尋</span>
              <input className="techo-input ns-qj-input font-display" placeholder="搜尋車票、路線、筆記、帳目…" />
            </label>
          </Cell>
          <Cell state="下拉" note="≤7 個固定選項" cls=".ns-select-wrap">
            <label className="ns-gal-field">
              <span className="techo-label">幣別</span>
              <span className="ns-select-wrap">
                <select className="techo-input" defaultValue="TWD">
                  <option value="TWD">新台幣 TWD</option>
                  <option value="JPY">日圓 JPY</option>
                </select>
              </span>
            </label>
          </Cell>
        </div>
      </Comp>

      <Comp
        spec={[
          ["DateChip", <>挑一天的觸發器：框 chip「10/22（四）」或「無日期」；桌機開 <code>DatePicker</code> 錨定浮層、手機開 <code>MobileDatePicker</code> sheet。快選往後＝今天／明天／後天／下週一，往前＝今天／昨天／前天（同日亮起、範圍外 disabled）。<code>late</code> 赭字赭框；<code>backfill</code> 換旗子＋title「補記」；<code>clearable</code> 有值時一顆淡態 ×。</>],
          ["hover", <>框轉 <code>--accent</code>、字轉 <code>--color-ink</code>；開著＝<code>.is-open</code> 同樣子。</>],
          ["鍵盤", <><code>aria-haspopup=dialog</code>＋<code>aria-expanded</code>；Enter／Space 開；浮層裡方向鍵移日、PageUp／PageDown 換月、Esc 收、焦點還給 chip。</>],
        ]}
      >
        <Cell state="有值＋快選（往後）" cls="button.ns-datechip ＋ .ns-datechip-quick > .chip.ns-chip">
          <DateChipDemo init={today} today={today} quick="forward" label="執行日" />
        </Cell>
        <Cell state="無日期" note="clearable" cls=".ns-datechip.is-empty">
          <DateChipDemo init={null} today={today} clearable label="締切" />
        </Cell>
        <Cell state="過期" note="flag=late、可清除" cls=".ns-datechip.is-late ＋ .ns-datechip-clear">
          <DateChipDemo init={addDays(today, -8)} today={today} flag="late" clearable label="締切" />
        </Cell>
        <Cell state="補記" note="flag=backfill、快選往前（可挑過去）" cls="IconFlag">
          <DateChipDemo init={addDays(today, -1)} today={today} flag="backfill" quick="backward" label="補記日" />
        </Cell>
        <Cell state="focus" note="靜態示範">
          <div className="ns-gal-focus-chip">
            <DateChipDemo init={today} today={today} label="執行日" />
          </div>
        </Cell>
        <Cell state="disabled" cls=".ns-datechip:disabled">
          <DateChipDemo init={today} today={today} disabled label="執行日" />
        </Cell>
      </Comp>

      <Comp
        spec={[
          ["DateNav", <><code>‹ 標題 ›</code>＋「今天」chip；要換年的加 <code>« »</code>（兩殼都有）；箭頭 <code>.ns-iconbtn</code>（28／手機 44），aria-label＋title 依 <code>unit</code>（前一天／上一週／上個月；上一年）。「今天」是一般 chip、<b>一律可按</b>（已在今天＝原地不動，title 寫「已經在今天」）；<code>nextDisabled</code> 例：日記不能翻到未來。</>],
          ["鍵盤", <><code>role=group</code>；標題 <code>aria-live=polite</code>（翻了會念新日期）；全是原生 button，不攔方向鍵。</>],
        ]}
      >
        <Cell state="日（預設）" note="「今天」一般 chip，隨時可按＝回今天" cls="div.ns-datenav[role=group]">
          <DateNav
            title={dateChipText(navDay)}
            onPrev={() => setNavDay((d) => addDays(d, -1))}
            onNext={() => setNavDay((d) => addDays(d, 1))}
            onToday={() => setNavDay(today)}
            isToday={navDay === today}
          />
        </Cell>
        <Cell state="月＋換年" note="« »＝onPrevYear／onNextYear" cls="IconFirst／IconLast">
          <DateNav
            unit="month"
            title={`${ym.y}年${ym.m}月`}
            onPrev={() => shiftMonth(-1)}
            onNext={() => shiftMonth(1)}
            onPrevYear={() => shiftMonth(-12)}
            onNextYear={() => shiftMonth(12)}
            onToday={() => setYm({ y: td.getFullYear(), m: td.getMonth() + 1 })}
            isToday={ym.y === td.getFullYear() && ym.m === td.getMonth() + 1}
          />
        </Cell>
        <Cell state="disabled" note="日記：不能翻到未來（nextDisabled）">
          <DateNav
            title={dateChipText(diary)}
            onPrev={() => setDiary((d) => addDays(d, -1))}
            onNext={() => setDiary((d) => addDays(d, 1))}
            onToday={() => setDiary(today)}
            isToday={diary === today}
            nextDisabled={diary >= today}
          />
        </Cell>
      </Comp>

      <Comp
        spec={[
          ["ClockInput", <>可打字（2330／23:30／25:00）、±1h ±15 ±5 ±1、下方寫這個值的日期（跨天赭字）；<code>variant</code>：full＝四組微調、compact 與 mobile＝只留 ±15；<code>relative</code>＝現在／5 分前／10 分前；mobile 上方常用時刻 chip（09:00／13:00／18:00／21:00）。打錯：還原、抖一下、說明行寫錯在哪。</>],
          ["鍵盤", <>Enter 確定、Esc 有草稿先還原、↑↓ ±1 分；微調鈕 <code>role=group</code>、長按加速；chip 是 <code>aria-pressed</code>。</>],
        ]}
      >
        <Cell state="full＋relative" note="桌機用；手機寬放不下四組微調（橫捲）" cls="span.ns-clock.is-full">
          <div className="ns-gal-scrollx">
            <ClockDemo variant="full" init={at(today, 23, 30)} lo={lo} hi={hi} refDay={today} relative label="開始" />
          </div>
        </Cell>
        <Cell state="compact" note="跨到隔天＝赭字「＝隔天 10/23（五）」" cls=".ns-clock.is-compact .ns-clock-date.is-other">
          <ClockDemo variant="compact" init={at(today, 1, 0, 1)} lo={lo} hi={hi} refDay={today} label="結束" />
        </Cell>
        <Cell state="mobile" note="只這一格掛 data-shell=mobile" cls=".ns-clock.is-mobile" shell="mobile">
          <ClockDemo variant="mobile" init={at(today, 13, 0)} lo={lo} hi={hi} refDay={today} label="幾點" />
        </Cell>
        <Cell state="長度" note="分段鈕＋「自訂…」chip；單位「分」，≥60 顯示 1h30" cls=".ns-seg--sm">
          <div className="ns-gal-row">
            <Segmented
              compact
              options={LEN_OPTS}
              value={custom ? null : len}
              onChange={(v) => {
                setLen(v);
                setCustom(false);
              }}
              aria-label="長度"
            />
            <button type="button" className="chip ns-chip" aria-pressed={custom} onClick={() => setCustom((x) => !x)}>
              自訂…
            </button>
          </div>
        </Cell>
      </Comp>

      <Comp
        spec={[
          ["DayCell", <>行程表月格、時刻表週欄、售票口月曆共用；格寬由容器決定（7 欄平分撐滿）：今天＝赭字＋數字左側赭菱形、有事＝墨點（最多 3）、選中＝<code>--sel-bg</code>、區間外＝淡字不可聚焦；<code>onAdd</code>＝右上常駐淡態「＋」（取代 hover 才出現）。格窄於 65px（手機一週 7 格）：「＋」挪右下、墨點改接在日數下方。</>],
          ["鍵盤", <>點擊面是蓋滿整格的 button：<code>aria-label</code>「10月22日（今天），有 3 件」、選中 <code>aria-pressed</code>、今天 <code>aria-current=date</code>；方向鍵移格由外層格線做。</>],
        ]}
      >
        <Cell wide state="一週" note="點格＝選中；第一格＝區間外；今天那格有「＋」" cls=".ns-daycells > .ns-daycell.is-today|.is-on|.is-out">
          <div className="ns-daycells">
            {week.map((d, i) => (
              <DayCell
                key={d}
                date={d}
                today={d === today}
                marks={marks[i]}
                selected={d === picked}
                out={i === 0}
                onClick={(day) => setPicked(day)}
                onAdd={d === today ? () => say("樣本：在這天新增車票") : undefined}
                addLabel="在這天新增車票"
              />
            ))}
          </div>
        </Cell>
      </Comp>

      <Comp
        spec={[
          ["ColorPicker", <>依場景載入一盤、兩盤共存：路線盤 4 格（藍鼠／梅紫／松葉／利休鼠，存 <code>var(--route-preset-N)</code>）、分類盤 8 格（只標「第 N 色」，存 <code>color_idx</code>）；「自訂…」＝色塊預覽＋原生色盤，<b>沒有色碼文字框</b>；選中外環 <code>--sel-line</code>。hover：色票放大 1.08。</>],
          ["鍵盤", <><code>role=radiogroup</code>；一個 Tab stop，←→↑↓ 換格並選取、Home／End；「自訂…」另一個 Tab 停點。</>],
        ]}
      >
        <Cell state="路線盤＋自訂" cls=".ns-colorpick > .ns-sw.is-on ＋ .ns-sw-custom">
          <ColorPicker palette="route" value={route} onChange={setRoute} custom />
        </Cell>
        <Cell state="分類盤＋自訂" cls="--cat-1..8">
          <ColorPicker palette="category" value={cat} onChange={setCat} custom />
        </Cell>
        <Cell state="disabled" cls=".ns-sw:disabled">
          <ColorPicker palette="route" value="var(--route-preset-3)" onChange={noop} disabled />
        </Cell>
      </Comp>

      <Comp
        spec={[
          ["選項 chip", <>多選、篩選、快選用（單選一組改 Segmented）；選中＝<code>--sel-bg</code>＋<code>--sel-fg</code>；篩選 chip 在頁首下一列。</>],
          ["ManagerRow", <>名稱（行內改名，失焦或 Enter 就存）｜色票｜↑ ↓（到邊界禁用）｜⋯（封存、刪除）；<b>自動存、沒有「完成」、關閉只有 ×</b>；封存的列淡墨、不排序。鍵盤：Alt+↑／↓ 上下移、Esc 有改動先還原。</>],
        ]}
      >
        <Cell state="選項 chip" note="點了切換；最後一顆 disabled" cls=".chip.ns-chip[aria-pressed]">
          <div className="ns-gal-row">
            {["本務", "生活", "休閒", "移動"].map((k) => (
              <button
                key={k}
                type="button"
                className="chip ns-chip"
                aria-pressed={!!pressed[k]}
                onClick={() => setPressed((p) => ({ ...p, [k]: !p[k] }))}
              >
                {k}
              </button>
            ))}
            <button type="button" className="chip ns-chip" disabled title="這個月還沒有睡眠紀錄">
              睡眠
            </button>
          </div>
        </Cell>
        <Cell wide state="ManagerRow" note="第一列 ↑、最後一列 ↓ 禁用；最後一列已封存" cls="ul.ns-mgr > li.ns-mgr-row">
          <div className="techo-card ns-gal-card">
            <div className="ns-gal-card-head">
              <h4 className="ns-gal-card-title">分類與設定</h4>
              <button type="button" className="ns-iconbtn" aria-label="關閉" title="關閉" onClick={() => say("樣本：關閉")}>
                <IconClose />
              </button>
            </div>
            <ManagerDemo />
          </div>
        </Cell>
      </Comp>
    </Sec>
  );
}

/* ───────────── §2.7 空狀態 ───────────── */

function EmptySection() {
  return (
    <Sec id="gal-empty" title="空狀態" note="§2.7 EmptyState · 三種語氣＋區段級">
      <Comp
        spec={[
          ["規格", <>置中；印章輪廓（可省）＋標題（襯線 <code>--fs-h3</code>）＋一句說明＋<b>一顆次鈕</b>（第一步）＋可省文字鈕。空狀態出現時同頁上方的「＋ 新增」要隱藏（呼叫端管）。資料未到 200ms 內不畫。</>],
          ["ARIA", <><code>nores</code> 外框 <code>role=status</code>（換成「找不到」時念出來）；印章 <code>aria-hidden</code>。</>],
        ]}
      >
        <div className="ns-gal-empties">
          <Cell state="第一次空" note="教第一步" cls=".ns-empty.is-first">
            <EmptyState
              tone="first"
              stamp={
                <span className="stamp">
                  <span className="hint">検印</span>
                </span>
              }
              title="今天還沒有列車"
              desc="寫下第一張車票，按 Enter 就発券。"
              action={{ label: "発券", icon: <IconPlus />, onClick: () => say("樣本：発券") }}
              secondary={{ label: "從路線圖挑一張", onClick: () => say("樣本：從路線圖挑一張") }}
            />
          </Cell>
          <Cell state="全部完成" note="慶祝、不給鈕" cls=".ns-empty.is-done">
            <EmptyState tone="done" stamp={<SealDone />} title="今天的列車都到站了" desc="辛苦了，明天見。" />
          </Cell>
          <Cell state="搜尋無結果" note="中性＋換個字" cls=".ns-empty.is-nores[role=status]">
            <EmptyState tone="nores" title="找不到「牛奶」" desc="換個字，或搜尋全部頁面。" secondary={{ label: "清除搜尋", onClick: () => say("樣本：清除搜尋") }} />
          </Cell>
        </div>
        <Cell wide state="區段級（inline）" note="卡內一行＋文字鈕" cls=".ns-empty-row">
          <div className="techo-card ns-gal-card">
            <div className="sec ns-gal-cardsec">
              <h3>時數目標</h3>
              <span className="rule" />
            </div>
            <EmptyState inline tone="first" title="還沒有目標。" action={{ label: "新增目標", icon: <IconPlus />, onClick: () => say("樣本：新增目標") }} />
          </div>
        </Cell>
      </Comp>
    </Sec>
  );
}

/* ───────────── §2.8 提示 ───────────── */

function TipSection() {
  const [closed, setClosed] = useState(false);
  return (
    <Sec id="gal-tip" title="提示" note="§2.8 ErrorBar・toast">
      <Comp
        col
        spec={[
          ["錯誤列", <>該頁載入或儲存失敗：內容區頂一行、紙材質、赭字 <code>--late</code>＋「重試」小號次鈕（給 <code>onRetry</code> 才有）＋×（給 <code>onClose</code> 才有）；不加 ⚠。<code>role=alert</code>，不搶焦點。</>],
          ["toast", <>一次一則、最多一個動作（文字鈕「復原」）、底部置中（手機在 tab bar 之上）；壽命 6 秒（無動作 4 秒）、切頁即收。影響整個 App 的狀態用橫幅（SyncBanner，本班沒改）。</>],
        ]}
      >
        <Cell wide state="重試＋關閉" cls=".ns-errrow[role=alert]">
          {closed ? (
            <button type="button" className="ns-btn btn-text" onClick={() => setClosed(false)}>
              再顯示一次
            </button>
          ) : (
            <ErrorBar message="帳簿沒有載入成功。" onRetry={() => say("樣本：重試")} onClose={() => setClosed(true)} />
          )}
        </Cell>
        <Cell wide state="只有重試">
          <ErrorBar message="這張車票沒有存起來，網路或磁碟出了點問題。" onRetry={() => say("樣本：重試")} />
        </Cell>
        <Cell wide state="只有訊息">
          <ErrorBar message="時刻表沒有載入成功。" />
        </Cell>
        <Cell state="toast" note="點了在底部出一則" cls=".techo-card（Toast）">
          <div className="ns-gal-row">
            <button
              type="button"
              className="ns-btn btn-ghost"
              onClick={() =>
                useUiStore.getState().showToast({ message: "已推到明天", actionLabel: "復原", onAction: () => say("樣本：已復原") })
              }
            >
              有動作（6 秒）
            </button>
            <button type="button" className="ns-btn btn-ghost" onClick={() => say("已存進收件匣")}>
              無動作（4 秒）
            </button>
          </div>
        </Cell>
      </Comp>
    </Sec>
  );
}

/* ───────────── §2.9 運行中徽（MobileTabBar #17） ───────────── */

function StampSection() {
  return (
    <Sec id="gal-stamp" title="運行中徽" note="§2.9・§2.0 MobileTabBar · 赭膠囊＋字">
      <Comp
        spec={[
          ["規格", <>時刻表運行中的小牌落在 tab 圖示右上：淡赭底 <code>--danger-bg</code>（底下墊紙色）＋赭框＋赭字＋<code>--radius-pill</code>，前面一顆赭點——不再跟圓印同形。資料與彈出／淡出動畫仍是時刻表的 NavBadge。</>],
          ["樣本", <>靜態 DOM（<code>span.m-tab-live &gt; .ns-tt-navbadge.is-mobile &gt; .ns-tt-badge.is-sm</code>），底借 <code>.ns-mfull-bar</code> 的書封色；真的要看手機殼底部 tab bar（時刻表運行中時）。</>],
        ]}
      >
        <Cell state="手機 tab bar 一格" cls="span.m-tab-live（display: contents）" shell="mobile">
          <div className="ns-mfull-bar ns-gal-tabbar">
            <span className="ns-gal-tabcell">
              {renderTabIcon(TAB_ICONS.timetable, 22)}
              <span className="m-tab-live">
                <span className="ns-tt-navbadge is-mobile">
                  <span className="ns-tt-badge is-sm">課</span>
                </span>
              </span>
              <span>時刻表</span>
            </span>
            <span className="ns-gal-tabcell">
              {renderTabIcon(TAB_ICONS.ticket, 22)}
              <span>售票口</span>
            </span>
          </div>
        </Cell>
      </Comp>
    </Sec>
  );
}

/* ───────────── §2.10 選中・聚焦 ───────────── */

function StateSection() {
  const [t, setT] = useState<"week" | "month">("week");
  const [s, setS] = useState<Money>("out");
  return (
    <Sec id="gal-state" title="選中・聚焦" note="§2.10 三種狀態一種畫法">
      <Comp
        spec={[
          ["選中", <>底 <code>--sel-bg</code>／字 <code>--sel-fg</code>／外框或底線 <code>--sel-line</code>（依元件固定一種）；class 一律 <code>.is-on</code>＋對應 ARIA。</>],
          ["聚焦", <><code>--focus-ring</code>（粉彩靛、銀河金）；書封上例外用燙金。hover＝<code>--hover-bg</code> 或抬一階，擇一。「現在」赭線在丙-3 各頁套。</>],
        ]}
      >
        <Cell state="選中" cls=".is-on">
          <Tabs
            items={[
              { key: "week", label: "週" },
              { key: "month", label: "月" },
            ]}
            value={t}
            onChange={setT}
            size="md"
            aria-label="樣本：週或月"
          />
          <Segmented
            compact
            options={[
              { value: "out", label: "支出" },
              { value: "in", label: "收入" },
            ]}
            value={s}
            onChange={(v) => setS(v)}
            aria-label="樣本：支出或收入"
          />
          <div className="ns-gal-row">
            <button type="button" className="chip ns-chip is-on">
              本務
            </button>
            <ColorPicker palette="category" value={2} onChange={noop} label="樣本：分類色" />
          </div>
        </Cell>
        <Cell state="聚焦" note="靜態示範" cls="--focus-ring">
          <div className="ns-gal-row">
            <button type="button" className="ns-btn btn-ghost ns-gal-focus" tabIndex={-1}>
              取消
            </button>
            <button type="button" className="ns-iconbtn ns-gal-focus" tabIndex={-1} aria-label="關閉" title="關閉">
              <IconClose />
            </button>
          </div>
          <input className="techo-input ns-gal-focus" defaultValue="日文" aria-label="樣本：聚焦的輸入框" tabIndex={-1} />
        </Cell>
        <Cell state="hover" note="靜態示範：圖示鈕 --hover-bg、次鈕框轉 --accent" cls=".is-hover">
          <div className="ns-gal-row">
            <button type="button" className="ns-iconbtn is-hover" tabIndex={-1} aria-label="更多動作" title="更多動作">
              <IconDots />
            </button>
            <button type="button" className="ns-btn btn-ghost is-hover" tabIndex={-1}>
              取消
            </button>
          </div>
        </Cell>
      </Comp>
    </Sec>
  );
}

/* ───────────── §1.7 圖示 ───────────── */

const ICONS: readonly { name: string; say: string; el: ReactNode }[] = [
  { name: "IconSearch", say: "搜尋", el: <IconSearch /> },
  { name: "IconGear", say: "設定／管理", el: <IconGear /> },
  { name: "IconDots", say: "更多動作（⋯）", el: <IconDots /> },
  { name: "IconClose", say: "關閉", el: <IconClose /> },
  { name: "IconPlus", say: "新增", el: <IconPlus /> },
  { name: "IconBack", say: "返回 ‹", el: <IconBack /> },
  { name: "IconChevron", say: "往後 › ／展開", el: <IconChevron /> },
  { name: "IconChevron open", say: "展開中 ▾", el: <IconChevron open /> },
  { name: "IconEdit", say: "編輯", el: <IconEdit /> },
  { name: "IconUp", say: "上移", el: <IconUp /> },
  { name: "IconDown", say: "下移", el: <IconDown /> },
  { name: "IconFirst", say: "上一年 «", el: <IconFirst /> },
  { name: "IconLast", say: "下一年 »", el: <IconLast /> },
  { name: "IconCalendar", say: "日期 chip", el: <IconCalendar /> },
  { name: "IconFlag", say: "補記旗", el: <IconFlag /> },
  { name: "IconAlert", say: "橫幅", el: <IconAlert /> },
];
const TAB_ICON_NAMES: readonly [TabIconKey, string][] = [
  ["today", "今日"],
  ["routemap", "路線圖"],
  ["notes", "旅客筆記"],
  ["timetable", "時刻表"],
  ["ticket", "售票口"],
  ["more", "更多"],
];

function IconSection() {
  return (
    <Sec id="gal-icon" title="圖示" note="§1.7 icons.tsx · 16 格、1.3px、currentColor、aria-hidden">
      <Comp
        spec={[
          ["規格", <>語意固定、同一個意思不畫第二份；圖示一律 <code>aria-hidden</code>，名字由外面那顆按鈕給（<code>aria-label</code>＋<code>title</code>）。手機殼圖示鈕裡放大到 20。</>],
        ]}
      >
        <div className="ns-gal-icons">
          {ICONS.map((ic) => (
            <span key={ic.name} className="ns-gal-icon">
              <span className="box">{ic.el}</span>
              <span>
                <code>{ic.name}</code>
                {ic.say}
              </span>
            </span>
          ))}
        </div>
        <Cell wide state="手機 tab 形狀" note="TAB_ICONS（mobile/tabs.ts 改引用這一份）" cls="TAB_ICONS">
          <div className="ns-gal-icons">
            {TAB_ICON_NAMES.map(([k, label]) => (
              <span key={k} className="ns-gal-icon">
                <span className="box">{renderTabIcon(TAB_ICONS[k], 20)}</span>
                <span>
                  <code>{k}</code>
                  {label}
                </span>
              </span>
            ))}
          </div>
        </Cell>
      </Comp>
    </Sec>
  );
}

/* ───────────── 頁 ───────────── */

export function Gallery() {
  const mobile = useShell() === "mobile";
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const today = todayKey(dayStartHour);
  const [theme, setTheme] = useState<ThemeKey>(readTheme);
  const [frame, setFrame] = useState<"shell" | "phone">("shell");

  // 主題：只翻 <html data-theme>（不寫 settings）；別人改了（uiStore 開機套設定、?theme=）就跟著顯示，離開時還原
  useEffect(() => {
    const root = document.documentElement;
    const before = root.getAttribute("data-theme");
    const mo = new MutationObserver(() => setTheme(readTheme()));
    mo.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      mo.disconnect();
      if (before) root.setAttribute("data-theme", before);
    };
  }, []);
  const pickTheme = (t: ThemeKey) => {
    document.documentElement.setAttribute("data-theme", t === "galaxy" ? "dark" : "light");
    setTheme(t);
  };
  const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ block: "start" });

  const body = (
    <>
      <header className="ns-gal-head">
        <div>
          <p className="techo-overline">Components</p>
          <h2 className="ns-gal-title">元件樣本</h2>
          <p className="ns-gal-lede">
            UI 丙-2 共用元件庫（視覺規範 §2；長相對照 <code>prototypes/ui-brand</code> 第 05 章）。每組標狀態、class 名與節號；
            focus 與 hover 欄是靜態示範（滑過預設那顆看真的）。假資料，點了只改這一頁。開法 <code>?mock=1&amp;gallery=1</code>。
          </p>
        </div>
        <div className="ns-gal-tools">
          <Segmented
            compact
            options={[
              { value: "pastel" as const, label: "粉彩星空" },
              { value: "galaxy" as const, label: "銀河鐵道" },
            ]}
            value={theme}
            onChange={pickTheme}
            aria-label="主題"
          />
          {!mobile && (
            <Segmented
              compact
              options={[
                { value: "shell" as const, label: "桌機殼" },
                { value: "phone" as const, label: "手機 375" },
              ]}
              value={frame}
              onChange={setFrame}
              aria-label="預覽的殼"
            />
          )}
        </div>
      </header>
      <nav className="ns-gal-toc" aria-label="樣本目錄">
        {SECTIONS.map((s) => (
          <button key={s.id} type="button" className="chip ns-chip" onClick={() => jump(s.id)}>
            {s.title}
          </button>
        ))}
      </nav>
      <HeaderSection today={today} phone={mobile || frame === "phone"} />
      <TabsSection />
      <ButtonSection />
      <BoxSection today={today} mobile={mobile} />
      <FormSection today={today} />
      <EmptySection />
      <TipSection />
      <StampSection />
      <StateSection />
      <IconSection />
    </>
  );

  return (
    <div className={(mobile ? "m-page" : "page") + " ns-gal"}>
      <div className="ns-gal-sheet">
        {frame === "phone" && !mobile ? (
          <div className="ns-gal-forced" data-shell="mobile">
            {body}
          </div>
        ) : (
          body
        )}
      </div>
    </div>
  );
}

export default Gallery;
