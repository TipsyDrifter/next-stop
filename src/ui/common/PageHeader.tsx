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
 *   ⑤ 右側工具列 `.ns-toolbar`，**固定順序**［分頁籤 `tabs`］［＋ 新增 `add`］［搜尋 `search`］［管理 `manage`］；
 *      沒給的格不畫（沒有線內管理的頁第四格空著：今日、行程表、路線圖、旅客筆記）。
 *      新增＝次鈕「＋ 名稱」（`add.icon` 可換，例日記「✎ 寫日記」；`add.haspopup` 補 ▾＋aria-haspopup，例「＋ 路線 ▾」）；
 *      搜尋＝圖示鈕（aria-label「搜尋」＋title）；管理＝次鈕「齒輪＋字」（時刻表「分類與設定」、售票口「管帳」）。
 *   ⑥ 底線 `--color-line`＋下方 4px 一道淡細線（手帳雙線）。
 *
 * 狀態：`compact`（主欄 <704）——分頁籤改下拉（`TabsSelect`）、新增與搜尋收成圖示鈕（帶 title）、
 *   **管理鈕永遠帶字**、日付印縮到 76。省略 `compact`＝自動：量 `<main>`（主欄；找不到就量父層）的寬度，
 *   <704 或位在 [data-shell="mobile"] 裡就收；傳 true／false 強制（樣本頁示範窄版用）。
 *
 * ARIA：根是 <header>（頁的 banner 區塊之一）；大標 <h1>；眉標中文段在粉彩 display:none（讀屏也跳過，不重複頁名）；
 *   拉丁段 `lang="en"`。工具列每顆鈕都有可讀名（圖示鈕 aria-label＋title；搜尋給了 `expanded` 就補 aria-expanded）。
 * 鍵盤：本身不攔鍵；工具列照 DOM 順序 Tab（分頁籤是一個 Tab stop，籤內 ←→，見 Tabs）。
 * 樣式不在本檔 import：`pageheader.css` 由 `src/index.css` 集中 @import（techo.css 之後、mobile.css 之前）。
 */
import { useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { IconChevron, IconGear, IconPlus, IconSearch } from "./icons";
import { Tabs, TabsSelect, type TabItem } from "./Tabs";

/** 主欄寬度門檻：<704 收成窄版（§1.3 寬度規則：1280 開側板時主欄＝704 仍是全套） */
export const PAGEHEAD_COMPACT_BELOW = 704;

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
  manage?: { label: string; onClick: ClickHandler; title?: string };
  /** 省略＝自動（主欄 <704 或手機殼）；true／false 強制 */
  compact?: boolean;
  className?: string;
}

/** 自動窄版：量主欄（<main>，找不到就量父層），主欄縮放（側板開關、視窗拖拉）即時跟上 */
function useAutoCompact(forced: boolean | undefined) {
  const ref = useRef<HTMLElement>(null);
  const [auto, setAuto] = useState(false);
  useLayoutEffect(() => {
    if (forced !== undefined) return;
    const el = ref.current;
    if (!el) return;
    const col = el.closest("main") ?? el.parentElement ?? el;
    const measure = () => {
      const mobile = el.closest("[data-shell]")?.getAttribute("data-shell") === "mobile";
      setAuto(mobile || col.getBoundingClientRect().width < PAGEHEAD_COMPACT_BELOW);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(col);
    return () => ro.disconnect();
  }, [forced]);
  return { ref, compact: forced ?? auto };
}

export function PageHeader<K extends string = string>({
  variant,
  overline,
  title,
  aside,
  stats,
  stamp,
  tabs,
  add,
  search,
  manage,
  compact: forcedCompact,
  className,
}: PageHeaderProps<K>) {
  const { ref, compact } = useAutoCompact(forcedCompact);
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
          <span className="ns-pagehead-ovl-zh">
            {overline.zh}
            <span aria-hidden="true"> — </span>
          </span>
          <span lang="en">{overline.latin}</span>
        </p>
        <div className="ns-pagehead-titleline">
          <h1 className="ns-pagehead-title">{title}</h1>
          {aside != null && <span className="ns-pagehead-aside">{aside}</span>}
        </div>
        {stats != null && <p className="ns-pagehead-stats">{stats}</p>}
      </div>

      {stamp != null && <div className="ns-pagehead-stamp">{stamp}</div>}

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
            <button type="button" className="ns-btn btn-ghost" title={manage.title} onClick={manage.onClick}>
              <IconGear />
              <span>{manage.label}</span>
            </button>
          )}
        </div>
      )}
    </header>
  );
}
