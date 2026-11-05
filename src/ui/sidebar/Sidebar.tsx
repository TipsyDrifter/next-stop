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
 *   第一欄 .gnav-row＝已通車三頁（今日／路線圖／日曆）＋ .gnav-kbd「CTRL 1 · 2 · 3」註記
 *     （「? 說明」滑鼠入口：⑦ D-⑦-3 甲起是這一行的可點片段，UI 丙-3 C7 搬到書封腳成文字鈕 .foot-guide）；
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
 * 原型沒有的控件：✎ 編輯、＋路線／＋幹線（借 .line-add 小字）——UI 丙-3 C6 起都是常駐淡態（--dim，hover／聚焦轉實；規範 §3.1-1）。
 * UI 丙-3：幹線 ✎＝RouteDialog「編輯幹線」（改名、刪除）；路線 ✎＝切到該路線並開詳情側板（路線的編輯只在側板，C1）；
 *   清單可捲時顯示細捲軸（配書封深色，C6）；「? 說明」搬到書封腳、跟「設定」並排成兩顆文字鈕（C7）。
 * 邏輯：openRoute＋setZoom(null)＋select(null)、openRouteDialog、setQuickJumpOpen、setSettingsOpen；
 * ③ 追加——點路線＝「切到路線圖頁並開該路線」（頁務件隨頁，規格書 §3；草案 §3 WP0）。
 *
 * ── 回饋乙（契約 §3 側欄、§5 側欄列 ⋯、§0 ☎3②）──
 *   - 幹線、路線可拖（共用 useDragReorder 的 tree 模式：幹線第 0 層、路線第 1 層）：幹線只排在幹線之間、路線只能放在幹線底下；
 *     路線拖到另一條幹線底下＝換幹線。寫入＝moveToAnchor 一批，toast 附「復原」（batchActions.moveWithUndo）。
 *   - 每列補 ⋯（常駐淡態 --dim，規範法則 05）：路線＝詳情…／上移／下移／移到幹線 ▾（幹線 ≥2 條才有）；
 *     幹線＝編輯…／上移／下移／新增路線。原本的 ✎ 併進「詳情…／編輯…」。右鍵＝同一份（contextMenu.tsx）。
 *     ⋯ 放最右；甲班的「未完成數字」小標放在 ⋯ 左邊（.line-row 裡、⋯ 之前）。
 *   - 路線列是外部落點（data-drop-target）：從大綱拖列車、支線、臨時票過來＝移到那條路線最上層的最後（大綱那邊判種類、寫入）。
 *   - 路線名從 <button> 改成 role=button 的 div：共用拖曳元件不從按鈕上起拖（列裡的按鈕要能照常點），整列就是拖的把手。
 *   - 書封是深底，落點色改燙金（sidebar.css `.cover { --dr-accent }`）。
 */
import { useCallback, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { NodeRow } from "../../domain";
import { compareSiblings } from "../../domain/nodeOrder";
import { useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";
import { roundelStyle } from "../common/roundel";
// 書封註記用的修飾鍵字面值與 title 裡的鍵位：M3 ⑦ 起一律由快捷鍵 registry 提供（原本是這裡的本地常數）
import { MOD_KBD, formatChord, hotkeyById, hotkeyOverrides } from "../shell/hotkeys";
import { useHotkeyRevision } from "../shell/useHotkeyRevision";
// v1.1.1 WP8：同步狀態點（未啟用時整顆不渲染——桌機沒開同步就與 v1.1.0 逐像素相同）
import { SyncDot } from "../common/SyncDot";
// 頁面登記表與 gnav 圖示（並行地基・契約 §6）
import { corePages, linePages, openPages, reviewPages } from "../shell/pages";
import { requestArrive } from "../panel/arrivalFlows";
import { GNAV_ICONS, svgProps } from "./gnavIcons";
// 側欄工具插槽（通車的線的 mount `sidebarTool`）與頁務件插槽（`sidebarAux`，接縫 #50）：查 `lines/runtime`、不 import `lines/mounts`——
// 本元件在 App 的 import 清單裡排在 pageViews 之前，import mounts 會把線的元件樹與 CSS 提早求值（理由見 runtime.ts 檔頭）
import { lineNavBadge, lineSidebarAux, lineSidebarTools } from "../../lines/runtime";
// 核心頁的頁務件（丁 D-主-235）：表由 pageViews.tsx 裝進來，這裡只在執行期查
import { MY_LINES_PAGES, pageSidebarAux } from "../shell/pageAux";
import type { LineId } from "../../lines/types";
import "./sidebar.css";
import { IconDots } from "../common/icons";
import { PopMenu, type PopMenuItem } from "../common/PopMenu";
import { rowContextMenu } from "../common/contextMenu";
import { useDragReorder, type DropPlace } from "../common/dragReorder";
import { APPEND, moveWithUndo } from "../../store/batchActions";
import { NavCount, todayCountHint, useTodayCount } from "../common/NavCount";
// gnav 樣式（styles/gnav.css）由 src/index.css 集中 import——見該檔檔頭的注入順序說明

/**
 * title 屬性裡的鍵位（句子形態「Ctrl+1」「?・Ctrl+/」）：查 registry 排鍵帽字，顯示端不手抄——
 * registry 若改鍵（例如備援鍵換掉），這裡自動跟。多組鍵位用「・」並排。
 */
const capsOf = (id: string): string =>
  hotkeyById(id)!.chords.map((c) => formatChord(c).join("+")).join("・");

/**
 * 鍵帽註記的數字：從 1 起連號且超過六個 ⇒「1 – 7」（七個數字用「·」串會超過書封寬；② 運行報告 D-主-182，照原型「CTRL 1 – 8」）；
 * 其餘照舊「1 · 2 · 3」（六頁時與改前逐字相同）。
 */
function kbdDigits(digits: readonly string[]): string {
  const run = digits.every((d, i) => d === String(i + 1));
  return run && digits.length > 6 ? `1 – ${digits.length}` : digits.join(" · ");
}

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
          <stop offset="0" stopColor="#fff2d8" stopOpacity=".34" />{/* 字面值：書封月亮光暈（美術色，原型 .cover-moon 逐字） */}
          <stop offset=".55" stopColor="#fff2d8" stopOpacity=".08" />{/* 字面值：書封月亮光暈（美術色） */}
          <stop offset="1" stopColor="#fff2d8" stopOpacity="0" />{/* 字面值：書封月亮光暈（美術色） */}
        </radialGradient>
      </defs>
      <circle cx="96" cy="40" r="40" fill="url(#coverMoonGlow)" />
      <circle cx="96" cy="40" r="13" fill="#f3e8cf" />{/* 字面值：書封月亮本體（美術色） */}
      <circle cx="102" cy="35" r="12.2" fill="var(--color-book)" />
      <circle cx="52" cy="24" r="1.3" fill="#fff" opacity=".75" />{/* 字面值：書封星點（美術色） */}
      <circle cx="40" cy="52" r="1" fill="#fff" opacity=".55" />{/* 字面值：書封星點（美術色） */}
      <circle cx="68" cy="62" r="1.1" fill="#fff" opacity=".6" />{/* 字面值：書封星點（美術色） */}
      <circle cx="126" cy="66" r=".9" fill="#fff" opacity=".5" />{/* 字面值：書封星點（美術色） */}
    </svg>
  );
}

/** 列右邊常駐淡態的 ⋯（規範法則 05）＋小選單；右鍵開同一份 */
function SideMore({ label, overline, items }: { label: string; overline: { zh: string; latin: string }; items: () => PopMenuItem[] }) {
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState<PopMenuItem[] | null>(null);
  const close = useCallback(() => setOpen(null), []);
  return (
    <>
      <button
        ref={btn}
        type="button"
        className="line-more"
        aria-haspopup="menu"
        aria-expanded={open !== null}
        aria-label={label}
        title="更多動作"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((cur) => (cur ? null : items()));
        }}
      >
        <IconDots size={14} />
      </button>
      {open && <PopMenu anchor={btn.current} overline={overline} label={label} items={open} onClose={close} />}
    </>
  );
}

/** 同一條幹線底下（或幹線之間）上移／下移：放到鄰居的另一邊（一筆寫入） */
function shift(id: string, parentId: string | null, sibs: readonly string[], delta: -1 | 1) {
  const i = sibs.indexOf(id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= sibs.length) return;
  const anchor = delta < 0 ? { after: sibs[j - 1] ?? null, before: sibs[j] } : { after: sibs[j], before: sibs[j + 1] ?? null };
  void useNodeStore
    .getState()
    .moveToAnchor([id], parentId, anchor)
    .then((r) => {
      if (!r.ok) useUiStore.getState().showToast({ message: r.reason ?? "沒有搬成功——請再試一次" }, 3600);
    });
}

const LINE_OV = { zh: "這條幹線", latin: "Line" };
const ROUTE_OV = { zh: "這條路線", latin: "Route" };

export function Sidebar() {
  useHotkeyRevision();
  // 車庫與回顧 D-主-206 #1：書封只列還在跑的幹線與路線；收進車庫的在清單最底「車庫 N 條」進去看
  const lines = useNodeStore((s) => s.liveLines);
  const routes = useNodeStore((s) => s.liveRoutes);
  const depotCount = useNodeStore((s) => s.routes.length - s.liveRoutes.length);
  const stations = useNodeStore((s) => s.stations);
  const routeId = useNodeStore((s) => s.routeId);
  const openRoute = useNodeStore((s) => s.openRoute);

  const page = useUiStore((s) => s.page);
  const overview = useUiStore((s) => s.routeOverview);
  // 丁 D-主-234：頁務件＝這一頁的目錄或篩選。線的頁走 mount、核心頁走 pageAux；都沒有時只有任務三頁畫「我的路線」
  const Aux = lineSidebarAux(page) ?? pageSidebarAux(page);
  const showMyLines = !Aux && MY_LINES_PAGES.has(page);
  const setPage = useUiStore((s) => s.setPage);
  const setZoom = useUiStore((s) => s.setZoom);
  const select = useUiStore((s) => s.select);
  const setQuickJumpOpen = useUiStore((s) => s.setQuickJumpOpen);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const openRouteDialog = useUiStore((s) => s.openRouteDialog);
  const toggleHotkeyGuide = useUiStore((s) => s.toggleHotkeyGuide);
  const setPanelOpen = useUiStore((s) => s.setPanelOpen);
  // 回饋甲 D-主-130：數字小標（今日格的未交代張數、路線列尾的未完成數）
  const todayCount = useTodayCount();
  const todayHint = todayCountHint(todayCount);
  const routeOpenCounts = useNodeStore((s) => s.routeOpenCounts);

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
      const next = byRoute[rid].sort(compareSiblings)[0];
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

  /** 路線「詳情…」（原本的 ✎）：切到該路線並打開側板——DetailPanel 在沒有選中節點時畫目前路線的 RoutePanel */
  const editRoute = (id: string) => {
    onOpenRoute(id);
    setPanelOpen(true);
  };

  /* ───────── 回饋乙：⋯ 選單（右鍵同一份） ───────── */
  const lineIds = lines.map((l) => l.id);
  const lineMenu = (line: NodeRow): PopMenuItem[] => {
    const i = lineIds.indexOf(line.id);
    return [
      { key: "edit", label: "編輯…", onSelect: () => openRouteDialog({ lineId: null, editId: line.id }) },
      { key: "up", label: "上移", cut: true, disabled: i <= 0, why: "已經在最上面", onSelect: () => shift(line.id, null, lineIds, -1) },
      { key: "down", label: "下移", disabled: i >= lineIds.length - 1, why: "已經在最下面", onSelect: () => shift(line.id, null, lineIds, 1) },
      { key: "add", label: "新增路線", cut: true, onSelect: () => openRouteDialog({ lineId: line.id, editId: null }) },
      // 車庫與回顧 D-主-207：幹線到站＝底下還在跑的路線一起收進車庫
      { key: "arrive", label: "到站・收進車庫", cut: true, onSelect: () => void requestArrive(line.id) },
    ];
  };
  const routeMenu = (route: NodeRow): PopMenuItem[] => {
    const sibs = routes.filter((r) => r.line_id === route.line_id).map((r) => r.id);
    const i = sibs.indexOf(route.id);
    const others = lines.filter((l) => l.id !== route.line_id);
    return [
      { key: "detail", label: "詳情…", onSelect: () => editRoute(route.id) },
      { key: "up", label: "上移", cut: true, disabled: i <= 0, why: "已經在這條幹線的最上面", onSelect: () => shift(route.id, route.line_id, sibs, -1) },
      { key: "down", label: "下移", disabled: i >= sibs.length - 1, why: "已經在這條幹線的最下面", onSelect: () => shift(route.id, route.line_id, sibs, 1) },
      // 移到幹線 ▾：幹線 ≥2 條才有（收成可展開群組，頂層不超過 7 項）
      ...others.map(
        (l, k): PopMenuItem => ({
          key: `line:${l.id}`,
          label: `「${l.name}」`,
          group: "移到幹線",
          cut: k === 0,
          onSelect: () => void moveWithUndo([route.id], l.id, APPEND, `「${route.name}」已換到「${l.name}」幹線`),
        }),
      ),
      // 車庫與回顧 D-主-207
      { key: "arrive", label: "到站・收進車庫", cut: true, onSelect: () => void requestArrive(route.id) },
    ];
  };

  /* ───────── 回饋乙：拖曳（tree：幹線 0 層、路線 1 層） ───────── */
  const [listEl, setListEl] = useState<HTMLDivElement | null>(null);
  const dragItems = lines.flatMap((l) => [
    { id: l.id, depth: 0 },
    ...routes.filter((r) => r.line_id === l.id).map((r) => ({ id: r.id, depth: 1 })),
  ]);
  const kindOf = (id: string) => (lineIds.includes(id) ? "line" : "route");
  useDragReorder({
    root: listEl,
    items: dragItems,
    tree: {
      // 左右位移不太需要（層級由種類決定，resolve 會挑能放的那一層）；12px＝路線那層的落點線往右縮一點
      indent: 12,
      carried: (ids) => ids.flatMap((id) => routes.filter((r) => r.line_id === id).map((r) => r.id)),
    },
    resolve: (ids, place: DropPlace) => {
      if (place.kind !== "slot") return "這裡放不下";
      if (kindOf(ids[0]) === "line") return place.depth === 0 ? true : "幹線只能排在幹線之間";
      return place.depth === 1 && place.parent ? true : "路線要放在某條幹線底下";
    },
    onDrop: (ids, place) => {
      if (place.kind !== "slot") return;
      const id = ids[0];
      const anchor = { after: place.after, before: place.before };
      if (kindOf(id) === "line") {
        void moveWithUndo(ids, null, anchor, "已移動");
        return;
      }
      if (!place.parent) return;
      const route = routes.find((r) => r.id === id);
      const to = lines.find((l) => l.id === place.parent);
      const changed = route && to && route.line_id !== to.id;
      void moveWithUndo(ids, place.parent, anchor, changed ? `「${route.name}」已換到「${to.name}」幹線` : "已移動");
    },
  });
  const onItemKey = (e: KeyboardEvent<HTMLDivElement>, id: string) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onOpenRoute(id);
    }
  };

  return (
    <aside className="cover" aria-label="路線清單側欄">
      <div className="brand">
        <h1>私鐵手帳</h1>
        <span className="latin">Next Stop</span>
        <div className="foil-rule" />
      </div>

      <nav className="gnav" aria-label="主選單">
        {/* 第一欄：核心三頁（今日／路線圖／日曆）。⑤ 起三枚都真的換頁（active＋aria-current 同一套） */}
        <div className="gnav-row">
          {corePages().map((p) => {
            // 回饋甲 D-主-130：「今日」右上數字小標＝今天還沒交代的張數（有誤點未交代轉赭）；title 補同一句話
            const hint = p.id === "today" ? todayHint : null;
            return (
              <button
                key={p.id}
                type="button"
                className={`gnav-item${page === p.id ? " active" : ""}`}
                aria-current={page === p.id ? "page" : undefined}
                title={`${p.label}（${capsOf(p.navHotkeyId)}）${hint ? `・${hint}` : ""}`}
                // 丁 D-主-239：「路線圖」＝路線一覽（最上層）；書封點路線才直進大綱
                onClick={() => (p.id === "routemap" ? useUiStore.getState().openRouteMap() : setPage(p.id))}
              >
                {GNAV_ICONS[p.id](17)}
                {p.label}
                {hint && <NavCount n={todayCount.left} late={todayCount.late > 0} label={hint} shell="desktop" />}
              </button>
            );
          })}
        </div>
        {/* 第二欄：三條功能線（Q3 拍板 2026-08-28；增補一：位置固定，通車只把那一枚的反灰復原）——
            未通車＝灰階小圖示、hover「次期開業予定」；通車＝可按的 .gnav-line，長相同第一欄大圖示（gnav.css；旅客筆記 D-筆-35） */}
        <div
          className="gnav-closed"
          {...(anyPlanned ? { role: "group", "aria-label": "次期開業予定（未通車）" } : {})}
        >
          {linePages().map((p) => {
            if (p.status === "planned") {
              return (
                <GnavOff key={p.id} name={p.label}>
                  {GNAV_ICONS[p.id](15)}
                </GnavOff>
              );
            }
            const base = `${p.label}（${capsOf(p.navHotkeyId)}）`;
            // 導航上的線標記（接縫 #58）：沒通車或沒填＝null ⇒ 按鈕與沒有插槽時逐字相同
            const nb = lineNavBadge(p.id as LineId, "desktop"); // linePages() 只回三條功能線
            const hint = nb?.hint ?? null;
            // hint 是純函式：滑過／聚焦當下才算，title 改成「原 title・hint」；React 下一次 render 會蓋回 base（無害）
            const showHint = hint
              ? (e: { currentTarget: HTMLButtonElement }) => {
                  const h = hint();
                  e.currentTarget.title = h ? `${base}・${h}` : base;
                }
              : undefined;
            return (
              <button
                key={p.id}
                type="button"
                className={`gnav-line${page === p.id ? " active" : ""}`}
                aria-current={page === p.id ? "page" : undefined}
                title={base}
                onClick={() => setPage(p.id)}
                onMouseEnter={showHint}
                onFocus={showHint}
              >
                {GNAV_ICONS[p.id](17)}
                {p.label}
                {nb?.Badge && <nb.Badge shell="desktop" />}
              </button>
            );
          })}
        </div>
        {/* 第三排「回顧」（② 運行報告 D-主-182；③ 車庫接在同一排）：群組名一行（虛線夾字）＋同一個三欄格線、長相同第一排 */}
        {reviewPages().length > 0 && (
          <>
            <p className="gnav-group" aria-hidden="true">
              回顧
            </p>
            <div className="gnav-row" role="group" aria-label="回顧">
              {reviewPages().map((p) => (
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
          </>
        )}

        {/* 鍵盤註記（數字鍵管兩排全部，所以放在兩排下面；10-20 磨光②）＋同步狀態點。
            UI 丙-3 C7：「? 說明」從這一行搬到書封腳、跟「設定」並排成兩顆文字鈕（規範 §2.0；原本是 span，Tab 不到） */}
        <p className="gnav-kbd">
          {/* 前導空白併進數字那一段：維持「MOD_KBD｜ 1 · 2 · 3」兩個文字節點，與重構前同切法（三節點會差次像素） */}
          {/* ⑧：換頁鍵改過就不是連號了，這行不再成立：藏起來（每格的 title 照樣寫實際的鍵） */}
          {!openPages().some((p) => hotkeyOverrides().has(p.navHotkeyId)) && (
            <span className="gnav-kbd-note">{MOD_KBD}{` ${kbdDigits(openPages().map((p) => p.navDigit))}`}</span>
          )}
          <SyncDot className="gnav-sync-dot" />
        </p>

        {/* 側欄工具列：通車的線的 sidebarTool（搜尋鈕左側）＋ D5 頂部搜尋鈕（滑鼠入口；鍵盤走 Ctrl+P） */}
        <div className="gnav-tools">
          {lineSidebarTools().map(({ id, Tool }) => (
            <Tool key={id} />
          ))}
          {/* 完整搜尋頁不進 gnav（D-主-110）：在那頁時這顆鈕亮著當「現在在這裡」；按下去照舊開 Ctrl+P */}
          <button
            type="button"
            className={`gnav-search${page === "search" ? " active" : ""}`}
            aria-current={page === "search" ? "page" : undefined}
            onClick={() => setQuickJumpOpen(true)}
            title={`搜尋・跳轉（${capsOf("global.quickjump")}）`}
          >
            <IconSearch />
            搜尋
            <span className="kbd">{capsOf("global.quickjump").toUpperCase().replace(/\+/g, " ")}</span>
          </button>
        </div>
      </nav>

      {/* 頁務件插槽（接縫 #50；丁 D-主-234／235）：線的 sidebarAux 或核心頁登記的頁務件 → 整段換成它；
          任務三頁（今日、路線圖、行程表）畫我的路線；其他頁只留一塊空白撐住書封腳 */}
      {Aux ? (
        <Aux />
      ) : !showMyLines ? (
        <div className="lines-scroll" />
      ) : (
        <div className="lines-scroll">
          {/* 我的路線（件一 .lines）：h2 一枚總標＋每條幹線一段 .trunk「幹線・○○」＋路線列＋車站注記 */}
          <div className="lines" ref={setListEl}>
            <h2>我的路線 MY LINES</h2>
            {lines.map((line) => {
              const lineRoutes = routes.filter((r) => r.line_id === line.id);
              return (
                <section key={line.id} aria-label={`幹線 ${line.name}`}>
                  <div
                    className="line-row line-row--trunk"
                    data-drag-id={line.id}
                    onContextMenu={rowContextMenu(() => ({ overline: LINE_OV, label: `幹線「${line.name}」的動作`, items: lineMenu(line) }))}
                  >
                    <div className="trunk">幹線・{line.name}</div>
                    <SideMore label={`幹線「${line.name}」的動作`} overline={LINE_OV} items={() => lineMenu(line)} />
                  </div>
                  {lineRoutes.map((route) => {
                    // 路線圖頁在看路線一覽時沒有「目前這條」（丁 D-主-239）
                    const current = route.id === routeId && !(page === "routemap" && overview);
                    const note = stationNote[route.id];
                    const open = routeOpenCounts[route.id] ?? 0;
                    const openText = open > 0 ? `・未完成 ${open} 項` : "";
                    return (
                      <div key={route.id}>
                        <div
                          className="line-row"
                          data-drag-id={route.id}
                          data-drop-target={route.id}
                          data-drop-type="route"
                          onContextMenu={rowContextMenu(() => ({ overline: ROUTE_OV, label: `路線「${route.name}」的動作`, items: routeMenu(route) }))}
                        >
                          <div
                            role="button"
                            tabIndex={0}
                            className={`line-item${current ? " active" : ""}`}
                            onClick={() => onOpenRoute(route.id)}
                            onKeyDown={(e) => onItemKey(e, route.id)}
                            aria-current={current ? "page" : undefined}
                            title={(note ? `${route.name}・下一站 ${note}` : route.name) + openText}
                            aria-label={open > 0 ? `${route.name}，未完成 ${open} 項` : undefined}
                          >
                            <RouteRoundel route={route} />
                            <span className="line-name">{route.name}</span>
                          </div>
                          {/* 回饋甲 D-主-130：未完成的末端項目數（淡色數字、不寫字；0 不畫），在 ⋯ 左邊；點穿到路線列 */}
                          {open > 0 && (
                            <span className="ns-routecount line-count" aria-hidden="true">
                              {open}
                            </span>
                          )}
                          {/* ⋯：詳情…（原本的 ✎＝這條路線的詳情側板，UI 丙-3 C1／C6）、上移／下移、移到幹線 ▾ */}
                          <SideMore label={`路線「${route.name}」的動作`} overline={ROUTE_OV} items={() => routeMenu(route)} />
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
            {/* 車庫與回顧 D-主-208：收進車庫的路線從這裡進（沒有就不畫） */}
            {depotCount > 0 && (
              <button type="button" className="line-depot" onClick={() => setPage("depot")} title="到站的路線收在車庫">
                {GNAV_ICONS.depot(13)}
                <span className="ld-t">車庫</span>
                <span className="ld-n">{depotCount} 條 ›</span>
              </button>
            )}
            <button
              type="button"
              className={`line-add${lines.length ? " line-add--line" : ""}`}
              onClick={() => openRouteDialog({ lineId: null, editId: null })}
            >
              ＋ 幹線
            </button>
          </div>
        </div>
      )}

      <div className="cover-foot">
        {/* 書封底兩顆文字鈕並排（規範 §2.0）：設定（全域設定）＋「? 說明」（快捷鍵指引；鍵盤也可按 ?／Ctrl+/）。
            「? 說明」用 mousedown 不搶焦點：滑鼠點開指引時焦點留在原處，關掉指引後鍵盤流不斷（同搬家前） */}
        <div className="foot-btns">
          <button type="button" className="foot-set" onClick={() => setSettingsOpen(true)} title={`設定（${capsOf("global.settings")}）`}>
            <IconGear />
            設定
          </button>
          <button
            type="button"
            className="foot-set foot-guide"
            title={`快捷鍵（${capsOf("global.guide")}）`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={toggleHotkeyGuide}
          >
            <span aria-hidden className="q">?</span>
            說明
          </button>
        </div>
        <CoverMoon />
        <div className="foil-rule" />
        <p className="theme-name">銀河鐵道</p>
      </div>
    </aside>
  );
}
