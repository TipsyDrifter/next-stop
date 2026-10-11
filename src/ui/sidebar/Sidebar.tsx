/**
 * Sidebar——書封側欄：prototypes/m1-c-techo.html 的 <aside class="cover"> 逐字移植成 React（樣式見 sidebar.css）。
 * 結構照原型：.brand（h1 私鐵手帳／.latin Next Stop／.foil-rule）→ nav.gnav（全域導航兩欄，見下）
 * → .lines（h2「我的路線 MY LINES」一枚總標＋每條幹線一段：.trunk「幹線・○○」＋ .line-item 路線
 *   〔.roundel 路線色＋代碼／無代碼圓點〕＋ .station-note 車站注記「◎ 下一站・N月」）
 * → .cover-foot（.foot-set 設定 ＋ .cover-moon 月亮〔粉彩限定〕＋ foil-rule ＋ .theme-name「銀河鐵道」〔銀河限定〕）。
 *   M3 ② 收口：夜行寝台的車窓（.carriage-window）與「旅の手帖／夜行寝台・年份」腳註隨主題換裝一併退場，
 *   書封腳改照 m3-ext-routemap.html 定稿——粉彩的光源是掛在書封腳的月亮，銀河的月亮在天上（SkyLayer）。
 *
 * M3 ② gnav 兩欄（Q3 拍板 2026-08-28；視覺真相＝prototypes/m3-ext-routemap.html，樣式見 styles/gnav.css）：
 *   第一欄 .gnav-row＝已通車三頁（今日／路線圖／日曆）＋ .gnav-kbd「CTRL 1 · 2 · 3　? 指引」註記
 *     （⑦ D-⑦-3 甲：「? 指引」是可點片段 .gnav-kbd-guide → toggleHotkeyGuide，滑鼠使用者的 ? 疊層入口）；
 *     ⑤ 起三枚全通車 → 依 uiStore.page 掛 .active＋aria-current（點了 setPage），三枚同一套樣式。
 *   第二欄 .gnav-closed＝未通車三枚 .gnav-off（旅客筆記／時刻表／售票口），灰階不可點、hover／focus 浮出
 *     .tip-closed tooltip「頁名＋次期開業予定」；通車時該枚升入第一欄。
 *   .gnav-search＝D5 搜尋鈕（開 QuickJump，鍵盤走 Ctrl+P）；設定入口 .foot-set 常駐 cover-foot（Q7 全域三件）。
 *   搜尋鈕外包一層 div.gnav-tools（側欄工具插槽，旅客筆記車次① 0-1 甲）：通車的線在 mount 填的 `sidebarTool`
 *   依 `lineSidebarTools()` 順序渲染在搜尋鈕左側；地基不寫 `.gnav-tools` 的 CSS，三線零登記＝只多一層 div、視覺相同。
 *
 * 並行地基（契約 2026-09-29 §6.2 C-8～C-11；增補 2026-10-05 增補一取代 C-11）：兩欄都改由頁面登記表（ui/shell/pages.ts）畫。
 *   - 上排＝`corePages()`（核心三頁，固定順序）；鍵帽註記＝`openPages()` 的數字串（通車的線自動多一個數字）。
 *   - 下排＝`linePages()`（三條功能線，固定順序旅客筆記／時刻表／售票口，不論通車與否）。主人拍板維持現在的排法：
 *     **哪條線通車，就把它那一枚的反灰復原，位置不搬到上排**（上面「通車時該枚升入第一欄」的舊說法作廢）。
 *     planned ＝與地基之前逐字相同的 `GnavOff`；open ＝一顆可按的 `button.gnav-line`（屬性比照上排、圖示 15px）。
 *     `.gnav-line` 地基不寫 CSS（鐵則：CSS 一律不動）——第一條通車的線在自己的 CSS 補上樣式。
 *     「次期開業予定」群組名只要還有任何一枚 planned 就照舊；三線全通車才拿掉（容器與按鈕仍在）。
 *   - 六枚頁面圖示搬到 `gnavIcons.tsx`（`GNAV_ICONS[id](size)`，形狀逐字）。
 *
 * 原型沒有的控件：✎ 編輯 hover 才現身；＋路線／＋幹線借 .line-add 小字。
 * 邏輯：openRoute＋setZoom(null)＋select(null)、openRouteDialog、setQuickJumpOpen、setSettingsOpen；
 * ③ 追加——點路線＝「切到路線圖頁並開該路線」（頁務件隨頁，規格書 §3；草案 §3 WP0）。
 */
import { useMemo, type ReactNode } from "react";
import type { NodeRow } from "../../domain";
import { useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";
import { roundelStyle } from "../common/roundel";
// 書封註記用的修飾鍵字面值與 title 裡的鍵位：M3 ⑦ 起一律由快捷鍵 registry 提供（原本是這裡的本地常數）
import { MOD_KBD, formatChord, hotkeyById } from "../shell/hotkeys";
// v1.1.1 WP8：同步狀態點（未啟用時整顆不渲染——桌機沒開同步就與 v1.1.0 逐像素相同）
import { SyncDot } from "../common/SyncDot";
// 頁面登記表與 gnav 圖示（並行地基・契約 §6）
import { corePages, linePages, openPages } from "../shell/pages";
import { GNAV_ICONS, svgProps } from "./gnavIcons";
// 側欄工具插槽（通車的線的 mount `sidebarTool`）：查 `lines/runtime`、不 import `lines/mounts`——
// 本元件在 App 的 import 清單裡排在 pageViews 之前，import mounts 會把線的元件樹與 CSS 提早求值（理由見 runtime.ts 檔頭）
import { lineSidebarTools } from "../../lines/runtime";
import "./sidebar.css";
// gnav 樣式（styles/gnav.css）由 src/index.css 集中 import——見該檔檔頭的注入順序說明

/**
 * title 屬性裡的鍵位（句子形態「Ctrl+1」「?・Ctrl+/」）：查 registry 排鍵帽字，顯示端不手抄——
 * registry 若改鍵（例如備援鍵換掉），這裡自動跟。多組鍵位用「・」並排。
 */
const capsOf = (id: string): string =>
  hotkeyById(id)!.chords.map((c) => formatChord(c).join("+")).join("・");

/**
 * 路線 roundel：路線色圓底＋代碼；無代碼時只留圓點（仍佔 roundel 的位，對齊不跳）。
 * 圓底走淺色階（原型的「亮盤深字」；換算與理由見 ui/common/roundel.ts）。
 */
function RouteRoundel({ route }: { route: NodeRow }) {
  const disc = roundelStyle(route.color);
  if (route.code) {
    return (
      <span aria-hidden className="roundel" style={disc}>
        {route.code}
      </span>
    );
  }
  return (
    <span aria-hidden className="roundel">
      <i className="dot" style={{ background: disc.background }} />
    </span>
  );
}

/* ── 搜尋／齒輪圖示（原型 1.3px 細線幾何，逐字；13px）。六枚頁面圖示在 gnavIcons.tsx ── */
function IconSearch() {
  return (
    <svg {...svgProps(13)}>
      <circle cx="7" cy="7" r="4.6" />
      <path d="M10.6 10.6 14 14" />
    </svg>
  );
}
function IconGear() {
  return (
    <svg {...svgProps(13)}>
      <circle cx="8" cy="8" r="2.3" />
      <path d="M8 1.8v1.7M8 12.5v1.7M1.8 8h1.7M12.5 8h1.7M3.6 3.6l1.2 1.2M11.2 11.2l1.2 1.2M3.6 12.4l1.2-1.2M11.2 4.8l1.2-1.2" />
    </svg>
  );
}

/** 車站注記的雙圈駅記號（件一 .station-note 內的 10×10 inline SVG，逐字） */
function IconStationMark() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" aria-hidden>
      <circle cx="5" cy="5" r="4" strokeWidth="1" />
      <circle cx="5" cy="5" r="1.6" strokeWidth="1" />
    </svg>
  );
}

/** 未通車佔位一枚：灰階圖示＋hover／focus 浮出「頁名／次期開業予定」（第二欄；Q3 拍板） */
function GnavOff({ name, children }: { name: string; children: ReactNode }) {
  return (
    <span className="gnav-off" tabIndex={0} aria-label={`${name}——次期開業予定`}>
      {children}
      <span className="tip-closed" aria-hidden="true">
        <span className="tn">{name}</span>
        <span className="ts">次期開業予定</span>
      </span>
    </span>
  );
}

/**
 * 書封腳的月亮（m3-ext-routemap.html 的 .cover-moon 逐字）——粉彩星空頁面那片霧的光源。
 * 銀河鐵道的月亮在天上（SkyLayer 的 .sky-moon），故暗色由 CSS 隱藏本枚。
 */
function CoverMoon() {
  return (
    <svg className="cover-moon" width="152" height="84" viewBox="0 0 152 84" aria-hidden>
      <defs>
        <radialGradient id="coverMoonGlow" cx="50%" cy="50%" r="50%">
          <stop offset="0" stopColor="#fff2d8" stopOpacity=".34" />
          <stop offset=".55" stopColor="#fff2d8" stopOpacity=".08" />
          <stop offset="1" stopColor="#fff2d8" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="96" cy="40" r="40" fill="url(#coverMoonGlow)" />
      <circle cx="96" cy="40" r="13" fill="#f3e8cf" />
      <circle cx="102" cy="35" r="12.2" fill="var(--color-book)" />
      <circle cx="52" cy="24" r="1.3" fill="#fff" opacity=".75" />
      <circle cx="40" cy="52" r="1" fill="#fff" opacity=".55" />
      <circle cx="68" cy="62" r="1.1" fill="#fff" opacity=".6" />
      <circle cx="126" cy="66" r=".9" fill="#fff" opacity=".5" />
    </svg>
  );
}

export function Sidebar() {
  const lines = useNodeStore((s) => s.lines);
  const routes = useNodeStore((s) => s.routes);
  const stations = useNodeStore((s) => s.stations);
  const routeId = useNodeStore((s) => s.routeId);
  const openRoute = useNodeStore((s) => s.openRoute);

  const page = useUiStore((s) => s.page);
  const setPage = useUiStore((s) => s.setPage);
  const setZoom = useUiStore((s) => s.setZoom);
  const select = useUiStore((s) => s.select);
  const setQuickJumpOpen = useUiStore((s) => s.setQuickJumpOpen);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const openRouteDialog = useUiStore((s) => s.openRouteDialog);
  const toggleHotkeyGuide = useUiStore((s) => s.toggleHotkeyGuide);

  /**
   * 車站注記（件一 .station-note「◎ 考過 N5・12月」）＝每條路線的下一站：
   * 尚未到站者依 position 取第一枚，有預定日就補「N月」。全數到站／沒有車站＝不畫這一列。
   */
  const stationNote = useMemo(() => {
    const map: Record<string, string> = {};
    const byRoute: Record<string, NodeRow[]> = {};
    for (const s of stations) {
      if (!s.parent_id || s.arrived_on) continue;
      (byRoute[s.parent_id] ??= []).push(s);
    }
    for (const rid in byRoute) {
      const next = byRoute[rid].sort((a, b) => a.position - b.position)[0];
      if (!next) continue;
      const month = next.expected_on?.split("-")[1];
      map[rid] = month ? `${next.name}・${Number(month)}月` : next.name;
    }
    return map;
  }, [stations]);

  // 下排還有任何一枚未通車 ⇒ 「次期開業予定」群組名照舊（增補一）
  const anyPlanned = linePages().some((p) => p.status === "planned");

  const onOpenRoute = (id: string) => {
    setPage("routemap");
    void openRoute(id);
    setZoom(null);
    select(null);
  };

  return (
    <aside className="cover" aria-label="路線網絡側欄">
      <div className="brand">
        <h1>私鐵手帳</h1>
        <span className="latin">Next Stop</span>
        <div className="foil-rule" />
      </div>

      <nav className="gnav" aria-label="全域導航">
        {/* 第一欄：核心三頁（今日／路線圖／日曆）。⑤ 起三枚都真的換頁（active＋aria-current 同一套） */}
        <div className="gnav-row">
          {corePages().map((p) => (
            <button
              key={p.id}
              type="button"
              className={`gnav-item${page === p.id ? " active" : ""}`}
              aria-current={page === p.id ? "page" : undefined}
              title={`${p.label}（${capsOf(p.navHotkeyId)}）`}
              onClick={() => setPage(p.id)}
            >
              {GNAV_ICONS[p.id](17)}
              {p.label}
            </button>
          ))}
        </div>
        {/* 鍵盤註記＋ ⑦「? 指引」滑鼠入口（D-⑦-3 甲）：同一行同字級；註記與入口各包一個 span（讀屏有邊界、
            淡度只落在註記）；純滑鼠入口所以不掛 role=button（掛了又不能 Enter／Space 對讀屏是「按不下去的鈕」），
            mousedown 不搶焦點，點了只切 hotkeyGuideOpen（互斥由 uiStore 保證）；鍵盤走 ?（導航模式）／Ctrl+/（IME 備援） */}
        <p className="gnav-kbd">
          {/* 前導空白併進數字那一段：維持「MOD_KBD｜ 1 · 2 · 3」兩個文字節點，與重構前同切法（三節點會差次像素） */}
          <span className="gnav-kbd-note">{MOD_KBD}{` ${openPages().map((p) => p.navDigit).join(" · ")}`}</span>{" "}
          <span
            className="gnav-kbd-guide"
            title={`快捷鍵指引（${capsOf("global.guide")}）`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={toggleHotkeyGuide}
          >
            ? 指引
          </span>
          <SyncDot className="gnav-sync-dot" />
        </p>

        {/* 第二欄：三條功能線（Q3 拍板 2026-08-28；增補一：位置固定，通車只把那一枚的反灰復原）——
            未通車＝灰階小圖示、hover「次期開業予定」；通車＝可按的 .gnav-line，長相同第一欄大圖示（gnav.css；旅客筆記 D-筆-35） */}
        <div
          className="gnav-closed"
          {...(anyPlanned ? { role: "group", "aria-label": "次期開業予定（未通車）" } : {})}
        >
          {linePages().map((p) =>
            p.status === "planned" ? (
              <GnavOff key={p.id} name={p.label}>
                {GNAV_ICONS[p.id](15)}
              </GnavOff>
            ) : (
              <button
                key={p.id}
                type="button"
                className={`gnav-line${page === p.id ? " active" : ""}`}
                aria-current={page === p.id ? "page" : undefined}
                title={`${p.label}（${capsOf(p.navHotkeyId)}）`}
                onClick={() => setPage(p.id)}
              >
                {GNAV_ICONS[p.id](17)}
                {p.label}
              </button>
            ),
          )}
        </div>

        {/* 側欄工具列：通車的線的 sidebarTool（搜尋鈕左側）＋ D5 頂部搜尋鈕（滑鼠入口；鍵盤走 Ctrl+P） */}
        <div className="gnav-tools">
          {lineSidebarTools().map(({ id, Tool }) => (
            <Tool key={id} />
          ))}
          <button type="button" className="gnav-search" onClick={() => setQuickJumpOpen(true)} title={`搜尋・跳轉（${capsOf("global.quickjump")}）`}>
            <IconSearch />
            搜尋
            <span className="kbd">{MOD_KBD} P</span>
          </button>
        </div>
      </nav>

      {/* 我的路線（件一 .lines）：h2 一枚總標＋每條幹線一段 .trunk「幹線・○○」＋路線列＋車站注記 */}
      <div className="lines-scroll">
        <div className="lines">
          <h2>我的路線 MY LINES</h2>
          {lines.map((line) => {
            const lineRoutes = routes.filter((r) => r.line_id === line.id);
            return (
              <section key={line.id} aria-label={`幹線 ${line.name}`}>
                <div className="line-row line-row--trunk">
                  <div className="trunk">幹線・{line.name}</div>
                  <button
                    type="button"
                    className="line-edit"
                    onClick={() => openRouteDialog({ lineId: null, editId: line.id })}
                    aria-label={`編輯幹線 ${line.name}`}
                  >
                    ✎
                  </button>
                </div>
                {lineRoutes.map((route) => {
                  const current = route.id === routeId;
                  const note = stationNote[route.id];
                  return (
                    <div key={route.id}>
                      <div className="line-row">
                        <button
                          type="button"
                          className={`line-item${current ? " active" : ""}`}
                          onClick={() => onOpenRoute(route.id)}
                          aria-current={current ? "page" : undefined}
                          title={note ? `${route.name}・下一站 ${note}` : route.name}
                        >
                          <RouteRoundel route={route} />
                          <span className="line-name">{route.name}</span>
                        </button>
                        <button
                          type="button"
                          className="line-edit"
                          onClick={() => openRouteDialog({ lineId: route.line_id, editId: route.id })}
                          aria-label={`編輯路線 ${route.name}`}
                        >
                          ✎
                        </button>
                      </div>
                      {note && (
                        <p className="station-note" aria-label={`下一站 ${note}`}>
                          <IconStationMark />
                          {note}
                        </p>
                      )}
                    </div>
                  );
                })}
                <button type="button" className="line-add" onClick={() => openRouteDialog({ lineId: line.id, editId: null })}>
                  ＋ 路線
                </button>
              </section>
            );
          })}
          <button
            type="button"
            className={`line-add${lines.length ? " line-add--line" : ""}`}
            onClick={() => openRouteDialog({ lineId: null, editId: null })}
          >
            ＋ 幹線
          </button>
        </div>
      </div>

      <div className="cover-foot">
        <button type="button" className="foot-set" onClick={() => setSettingsOpen(true)} title={`設定（${capsOf("global.settings")}）`}>
          <IconGear />
          設定
        </button>
        <CoverMoon />
        <div className="foil-rule" />
        <p className="theme-name">銀河鐵道</p>
      </div>
    </aside>
  );
}
