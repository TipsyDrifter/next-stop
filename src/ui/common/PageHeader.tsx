/**
 * PageHeader——每一頁頂端的身分與工具列，全 App 一種骨架（視覺規範 §2.1；UI 丙-2 共用元件庫 #1）。
 *
 * 用途：桌機六頁＋三線頁面的頁首。不用：對話框、側板、sheet 用各自的標題列（§2.4）；
 *   手機殼不用它——手機頁首＝頂帶（MobileTopBand）＋頂帶下一列的分頁籤列（`tabsRow` 插槽，§2.0）。
 *
 * 解剖（樣式在 `./pageheader.css`，活樣本 prototypes/ui-brand/index.html §2.1「頁首」）：
 *   ① 眉標 `overline: {zh, latin}`——吃既有 `.techo-overline`；**粉彩只畫拉丁斜體**、**銀河畫「中 — LATIN」**
 *      （主題差異全在 CSS：中文段粉彩 display:none、銀河顯示並轉大寫）。文案：拉丁字＝頁名英譯一到兩個詞，不帶年份、不帶「·」。
 *   ② 大標 `title`（<h1>，`--font-display` 700）：`variant="identity"` 身分式＝日期／月份／路線名，`--fs-date`；
 *      `variant="name"` 頁名式＝頁名，`--fs-display`。只有這兩種；工具列位置、底線、字級規則都一樣。
 *   ③ 補述 `aside`（大標右側同一行：週幾、年份、拉丁小字——拉丁段包 `.ns-pagehead-latin`）；
 *      `stats`（大標下一行：本月 N 張、本月支出…；粗體段用 <b>）。
 *   ④ 日付印 `stamp`（今日、路線圖、行程表、日記四頁；呼叫端給 92 的 DateSeal），貼在主欄右側、工具列之左。
 *   ④′ 紀念章 `emblem`（UI 丙-3 契約 §5 P1＝A：今日、路線圖；呼叫端給 92 的 StationStamp），排在日付印之後、工具列之前。
 *      頁首寬 <704（`PAGEHEAD_EMBLEM_BELOW`）時 emblem 不畫，改把 `emblemCompact` 接在 stats 列尾（＝方案 C 的畫法：
 *      28px 小章 `<EmblemMini percent>`＋「下一站 X N%」；前面自動補「・」）。沒給 emblemCompact 就只是藏起來。
 *   ⑤ 右側工具列 `.ns-toolbar`，**固定順序**［分頁籤 `tabs`］［＋ 新增 `add`］［搜尋 `search`］［管理 `manage`］；
 *      沒給的格不畫（沒有線內管理的頁第四格空著：今日、行程表、路線圖、旅客筆記）。
 *      新增＝次鈕「＋ 名稱」（`add.icon` 可換，例日記「✎ 寫日記」；`add.haspopup` 補 ▾＋aria-haspopup，例「＋ 路線 ▾」）；
 *      搜尋＝圖示鈕（aria-label「搜尋」＋title）；管理＝次鈕「齒輪＋字」（時刻表「分類與設定」、售票口「管帳」）。
 *   ⑥ 底線 `--color-line`＋下方 4px 一道淡細線（手帳雙線）。
 *
 * 狀態：`compact`（主欄 <704）——分頁籤改下拉（`TabsSelect`）、新增與搜尋收成圖示鈕（帶 title）、
 *   **管理鈕永遠帶字**、日付印與紀念章縮到 76。省略 `compact`＝自動：量 `<main>`（主欄；找不到就量父層）的寬度，
 *   <704 或位在 [data-shell="mobile"] 裡就收；傳 true／false 強制（樣本頁示範窄版用）。
 *   紀念章的窄退另外量**頁首本身**的寬（<704 退；不受 `compact` 強制影響），數值跟窄版同一條。
 *
 * ARIA：根是 <header>（頁的 banner 區塊之一）；大標 <h1>；眉標中文段在粉彩 display:none（讀屏也跳過，不重複頁名）；
 *   拉丁段 `lang="en"`。眉標的畫法抽成 `<OverlineText>`（PopMenu、DialogShell 的物件眉標也用它，一種畫法）。
 *   工具列每顆鈕都有可讀名（圖示鈕 aria-label＋title；搜尋給了 `expanded` 就補 aria-expanded）。
 *   管理鈕（UI 丙-5）：開選單／對話框的給 `manage.haspopup`（"menu"｜"dialog"）＋`manage.expanded` ⇒ aria-haspopup／aria-expanded
 *   （售票口「管帳」開 PopMenu）；只在給了的時候才畫，時刻表「分類與設定」不給＝跟以前一樣。
 * 鍵盤：本身不攔鍵；工具列照 DOM 順序 Tab（分頁籤是一個 Tab stop，籤內 ←→，見 Tabs）。
 * 樣式不在本檔 import：`pageheader.css` 由 `src/index.css` 集中 @import（techo.css 之後、mobile.css 之前）。
 */
import { useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { IconChevron, IconGear, IconPlus, IconSearch } from "./icons";
import { Tabs, TabsSelect, type TabItem } from "./Tabs";

/** 主欄寬度門檻：<704 收成窄版（§1.3 寬度規則：1280 開側板時主欄＝704 仍是全套） */
export const PAGEHEAD_COMPACT_BELOW = 704;
/**
 * 紀念章窄退門檻（頁首本身的寬）：<704 時 emblem 不畫、改畫 emblemCompact（丙-3 契約 §5 P1）。
 * 跟窄版同一條線（704）：頁首放得下全套就畫章，放不下就退成小章——不會有「章跟印一起縮成一樣大」的中間態（使用者 10-24 定甲案：印 76／章 92，章比印稍大）。
 */
export const PAGEHEAD_EMBLEM_BELOW = 704;

/**
 * 眉標資料：字串＝照字面畫（舊呼叫端，例「時刻表 — TIMETABLE」）；物件＝粉彩只畫拉丁斜體、銀河畫「中 — LATIN」。
 * 新寫的呼叫端一律給物件（視覺規範 §2.1①）；字串只為了不逼別線的舊呼叫端一起改。
 */
export type Overline = string | { zh: string; latin: string };

/**
 * 眉標的內文（不含外層；外層由呼叫端掛 `.techo-overline`）。物件形：中文段 `.ns-ovl-zh`（粉彩 display:none、
 * 讀屏也跳過）＋拉丁段 `.ns-ovl-latin`（`lang="en"`；銀河轉大寫）——樣式在 pageheader.css（index.css 集中載入，全域可用）。
 */
export function OverlineText({ value }: { value: Overline }) {
  if (typeof value === "string") return <>{value}</>;
  return (
    <>
      <span className="ns-ovl-zh">
        {value.zh}
        <span aria-hidden="true"> — </span>
      </span>
      <span className="ns-ovl-latin" lang="en">
        {value.latin}
      </span>
    </>
  );
}

/** 紀念章窄退用的 28px 小章（只留金弧＋點線圈，字太小不畫；+5° 同紀念章）。percent 0–100；裝飾性，讀屏靠旁邊的字 */
export function EmblemMini({ percent }: { percent: number }) {
  const r = 12;
  const c = 2 * Math.PI * r;
  const d = (c * Math.max(0, Math.min(100, percent))) / 100;
  return (
    <svg className="ns-station-stamp ns-pagehead-emblem-mini" width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
      <circle className="ring-base" cx="14" cy="14" r={r} strokeWidth="1.2" opacity=".35" />
      <circle
        className="arc"
        cx="14"
        cy="14"
        r={r}
        fill="none"
        strokeWidth="2.2"
        strokeDasharray={`${d.toFixed(1)} ${(c - d).toFixed(1)}`}
        strokeLinecap="round"
        transform="rotate(-90 14 14)"
      />
      <circle className="dots" cx="14" cy="14" r="7.5" strokeWidth="1" strokeDasharray="1.4 2.2" opacity=".6" />
    </svg>
  );
}

type ClickHandler = (e: MouseEvent<HTMLButtonElement>) => void;

export interface PageHeaderTabs<K extends string = string> {
  items: readonly TabItem<K>[];
  value: K;
  onChange: (key: K) => void;
  /** 讀屏用名稱（預設「切換檢視」） */
  "aria-label"?: string;
  getPanelId?: (key: K) => string;
}

export interface PageHeaderProps<K extends string = string> {
  /** identity＝身分式（日期／月份／路線名，--fs-date）；name＝頁名式（--fs-display） */
  variant: "identity" | "name";
  /** 眉標：粉彩畫 latin、銀河畫「zh — LATIN」 */
  overline: { zh: string; latin: string };
  title: ReactNode;
  /** 大標右側補述（同一行）：週幾、年份、拉丁小字 */
  aside?: ReactNode;
  /** 大標下一行的統計（本月 N 張…；粗體段用 <b>） */
  stats?: ReactNode;
  /** 日付印（DateSeal size 92）；窄版縮到 76 */
  stamp?: ReactNode;
  /** 紀念章（StationStamp size 92；今日、路線圖；日付印給 76）：日付印之後、工具列之前；頁首寬 <704 不畫 */
  emblem?: ReactNode;
  /** 頁首寬 <704 時接在 stats 列尾的紀念章小樣（例 `<><EmblemMini percent={p} />下一站 <b>{name}</b> {p}%</>`） */
  emblemCompact?: ReactNode;
  /** 工具列第一格：分頁籤（窄版自動改下拉） */
  tabs?: PageHeaderTabs<K>;
  /** 工具列第二格：該頁主物件的新增 */
  add?: {
    label: string;
    onClick: ClickHandler;
    /** 換圖示（預設 ＋）；例日記的 ✎ */
    icon?: ReactNode;
    /** 滑過說明（含快捷鍵）；窄版圖示鈕預設用 label */
    title?: string;
    /** 點了開選單（＋ 路線 ▾）：補 ▾ 與 aria-haspopup */
    haspopup?: boolean;
  };
  /** 工具列第三格：搜尋（頁首放大鏡） */
  search?: {
    onOpen: ClickHandler;
    /** 滑過說明（預設「搜尋」；可帶快捷鍵） */
    title?: string;
    /** 搜尋框展開中（售票口：點開才展開輸入框）→ aria-expanded */
    expanded?: boolean;
  };
  /** 工具列第四格：線內管理（齒輪＋字，永遠帶字） */
  manage?: {
    label: string;
    onClick: ClickHandler;
    title?: string;
    /** 點了開選單或對話框（UI 丙-5：售票口「管帳」開 PopMenu）⇒ aria-haspopup */
    haspopup?: "menu" | "dialog";
    /** 開著沒 ⇒ aria-expanded（給了 haspopup 才有意義） */
    expanded?: boolean;
  };
  /** 省略＝自動（主欄 <704 或手機殼）；true／false 強制 */
  compact?: boolean;
  className?: string;
}

/**
 * 自動窄版：量主欄（<main>，找不到就量父層），主欄縮放（側板開關、視窗拖拉）即時跟上。
 * `watchEmblem`：另量頁首本身的寬，給紀念章窄退（<704）用；頁首是區塊元素，寬度不隨內容變，藏／顯紀念章不會回頭改到量測值。
 */
function useAutoCompact(forced: boolean | undefined, watchEmblem: boolean) {
  const ref = useRef<HTMLElement>(null);
  const [auto, setAuto] = useState(false);
  const [emblemNarrow, setEmblemNarrow] = useState(false);
  useLayoutEffect(() => {
    const autoCompact = forced === undefined;
    if (!autoCompact && !watchEmblem) return;
    const el = ref.current;
    if (!el) return;
    const col = el.closest("main") ?? el.parentElement ?? el;
    const measure = () => {
      if (autoCompact) {
        const mobile = el.closest("[data-shell]")?.getAttribute("data-shell") === "mobile";
        setAuto(mobile || col.getBoundingClientRect().width < PAGEHEAD_COMPACT_BELOW);
      }
      if (watchEmblem) setEmblemNarrow(el.getBoundingClientRect().width < PAGEHEAD_EMBLEM_BELOW);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(col);
    if (watchEmblem && col !== el) ro.observe(el);
    return () => ro.disconnect();
  }, [forced, watchEmblem]);
  return { ref, compact: forced ?? auto, emblemNarrow: watchEmblem && emblemNarrow };
}

export function PageHeader<K extends string = string>({
  variant,
  overline,
  title,
  aside,
  stats,
  stamp,
  emblem,
  emblemCompact,
  tabs,
  add,
  search,
  manage,
  compact: forcedCompact,
  className,
}: PageHeaderProps<K>) {
  const { ref, compact, emblemNarrow } = useAutoCompact(forcedCompact, emblem != null);
  // 紀念章窄退：頁首寬 <704 不畫 emblem，emblemCompact（有給的話）接在 stats 列尾
  const showEmblem = emblem != null && !emblemNarrow;
  const tailEmblem = emblem != null && emblemNarrow && emblemCompact != null;
  const hasTools = !!(tabs || add || search || manage);
  const cls = [
    "ns-pagehead",
    `ns-pagehead--${variant}`,
    compact ? "is-compact" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <header ref={ref} className={cls}>
      <div className="ns-pagehead-main">
        <p className="techo-overline ns-pagehead-overline">
          <OverlineText value={overline} />
        </p>
        <div className="ns-pagehead-titleline">
          <h1 className="ns-pagehead-title">{title}</h1>
          {aside != null && <span className="ns-pagehead-aside">{aside}</span>}
        </div>
        {(stats != null || tailEmblem) && (
          <p className="ns-pagehead-stats">
            {stats}
            {tailEmblem && (
              // 「・」與小章包在同一個不換行的盒子：折行時一起掉到下一行，不留「・」在行尾
              <span className="ns-pagehead-emblem-c">
                {stats != null && (
                  <span className="ns-pagehead-sep" aria-hidden="true">
                    ・
                  </span>
                )}
                {emblemCompact}
              </span>
            )}
          </p>
        )}
      </div>

      {stamp != null && <div className="ns-pagehead-stamp">{stamp}</div>}
      {showEmblem && <div className="ns-pagehead-emblem">{emblem}</div>}

      {hasTools && (
        <div className="ns-toolbar">
          {/* ① 分頁籤（窄版改下拉） */}
          {tabs &&
            (compact ? (
              <TabsSelect
                items={tabs.items}
                value={tabs.value}
                onChange={tabs.onChange}
                aria-label={tabs["aria-label"]}
              />
            ) : (
              <Tabs
                items={tabs.items}
                value={tabs.value}
                onChange={tabs.onChange}
                aria-label={tabs["aria-label"]}
                getPanelId={tabs.getPanelId}
                size="md"
              />
            ))}

          {/* ② ＋ 新增（窄版收成圖示鈕，帶 title） */}
          {add &&
            (compact ? (
              <button
                type="button"
                className="ns-iconbtn"
                aria-label={add.label}
                title={add.title ?? add.label}
                aria-haspopup={add.haspopup ? "menu" : undefined}
                onClick={add.onClick}
              >
                {add.icon ?? <IconPlus />}
              </button>
            ) : (
              <button
                type="button"
                className="ns-btn btn-ghost"
                title={add.title}
                aria-haspopup={add.haspopup ? "menu" : undefined}
                onClick={add.onClick}
              >
                {add.icon ?? <IconPlus />}
                <span>{add.label}</span>
                {add.haspopup && <IconChevron open />}
              </button>
            ))}

          {/* ③ 搜尋（兩種寬度都是圖示鈕） */}
          {search && (
            <button
              type="button"
              className="ns-iconbtn"
              aria-label="搜尋"
              title={search.title ?? "搜尋"}
              aria-expanded={search.expanded}
              onClick={search.onOpen}
            >
              <IconSearch />
            </button>
          )}

          {/* ④ 管理：齒輪＋字，窄版也帶字 */}
          {manage && (
            <button
              type="button"
              className="ns-btn btn-ghost"
              title={manage.title}
              aria-haspopup={manage.haspopup}
              aria-expanded={manage.expanded}
              onClick={manage.onClick}
            >
              <IconGear />
              <span>{manage.label}</span>
            </button>
          )}
        </div>
      )}
    </header>
  );
}
