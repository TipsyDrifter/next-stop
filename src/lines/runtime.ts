/**
 * 三線的執行期掛點查詢（並行地基・修正席；評審發現 2）。**本檔不 import 任何元件**——各線 mount 檔一律不經過這裡。
 *
 * 為什麼拆出來：`syncStore.ts`（同步後重載）與 `useGlobalHotkeys.ts`（全域快捷鍵）在 App.tsx 的 import 清單裡
 * 排在 Sidebar／Outline／Today 等核心元件之前。它們若直接 import `./mounts`，某條線一旦在 `<line>.mount.tsx`
 * 填了元件，該元件整棵 import 樹（含它用到的核心共用元件的 CSS）就會比核心元件更早被求值，
 * 核心 CSS 的注入順序跟著變（`src/index.css` 檔頭的「注入順序」鐵律），也會形成 store → 線的元件 → store 的循環。
 *
 * 做法：`./mounts` 在自己被求值時呼叫 `installLineMounts(LINE_MOUNTS)` 把掛點表交進來；
 * store 與 hook 只 import 本檔（型別＋純資料），在**執行期**才查表。
 * `./mounts` 由 App 層靜態 import（`pageViews.tsx`、App.tsx 的 `lineOverlays`），所以 App 模組求值完時一定已裝好，
 * 早於任何一次同步（App 的 effect 才 boot）與任何一次按鍵（hook 的 effect 才掛 listener）。
 * 沒裝（例如 probe 只載入 store）＝三線都當作沒填，與三線零筆登記的地基現況相同。
 *
 * 書封側欄工具（`lineSidebarTools()`，旅客筆記車次① 0-1 甲）也放這裡、不放 `./mounts`：`Sidebar.tsx` 在 App 的
 * import 清單裡排在 `pageViews.tsx` 之前，若 import `./mounts`，線的元件樹（含其 CSS）會被提早到 Sidebar 那一格求值。
 * 本函式只回傳表裡的元件參照、自己不 import 任何元件，元件樹仍由 `./mounts` 在原本的位置帶進來。
 */
import { LINE_MANIFESTS } from "./index.ts";
import type { ComponentType } from "react";
import type { NodeRow } from "../domain";
import type {
  CaptureTargetSpec,
  LineId,
  LineMount,
  LineReloadContext,
  NodeFieldSpec,
  QuickJumpProviderSpec,
  TicketSheetItemSpec,
  TodayRowActionSpec,
} from "./types";

type NodeDeleteHintFn = NonNullable<LineMount["nodeDeleteHints"]>;
type TodayStatsComp = NonNullable<LineMount["todayStats"]>;

let installed: Readonly<Record<LineId, LineMount>> | null = null;

/** 只給 `./mounts` 呼叫 */
export function installLineMounts(mounts: Readonly<Record<LineId, LineMount>>): void {
  installed = mounts;
}

/** 有填 `reload` 的線（三線固定順序 notes → timetable → ticket；地基階段恆為空陣列） */
export function lineReloads(): { id: LineId; reload: (ctx: LineReloadContext) => Promise<void> }[] {
  const out: { id: LineId; reload: (ctx: LineReloadContext) => Promise<void> }[] = [];
  if (!installed) return out;
  for (const m of LINE_MANIFESTS) {
    const reload = installed[m.id].reload;
    if (reload) out.push({ id: m.id, reload });
  }
  return out;
}

/**
 * 同步 pull 套用完之後要通知的線（接縫 #54），比照 `lineNodeFields(shell)`：三線固定順序；
 * 桌機看 `page.status`、手機看 `mobile.status`，`open` 且有填才算。沒裝＝空陣列。
 */
export function lineAfterPulls(shell: "desktop" | "mobile"): { id: LineId; afterPull: () => void }[] {
  const out: { id: LineId; afterPull: () => void }[] = [];
  if (!installed) return out;
  for (const m of LINE_MANIFESTS) {
    const status = shell === "desktop" ? m.page.status : m.mobile.status;
    const afterPull = installed[m.id].afterPull;
    if (status === "open" && afterPull) out.push({ id: m.id, afterPull });
  }
  return out;
}

/** 某一筆全域快捷鍵（hotkey id）是不是哪條已通車的線登記的；是就回處理函式，否則 null */
export function lineGlobalHotkeyHandler(hotkeyId: string): (() => void) | null {
  if (!installed) return null;
  for (const m of LINE_MANIFESTS) {
    if (m.page.status !== "open") continue;
    const fn = installed[m.id].globalHotkeyHandlers?.[hotkeyId];
    if (fn) return fn;
  }
  return null;
}

/**
 * 書封側欄的工具（三線固定順序 notes → timetable → ticket），比照 `lineOverlays("desktop")`：
 * 只看 `page.status`；`open` 且有填 `sidebarTool` 才算。地基階段恆為空陣列。
 */
export function lineSidebarTools(): { id: LineId; Tool: ComponentType }[] {
  const out: { id: LineId; Tool: ComponentType }[] = [];
  if (!installed) return out;
  for (const m of LINE_MANIFESTS) {
    const Tool = installed[m.id].sidebarTool;
    if (m.page.status === "open" && Tool) out.push({ id: m.id, Tool });
  }
  return out;
}

/**
 * 書封頁務件（接縫 #50），比照 `lineSidebarTools()`：當前頁 `page` 是某條線、該線 `page.status === "open"`
 * 且有填 `sidebarAux` 才回元件；否則 null（書封照舊畫「我的路線」）。地基階段恆為 null。
 */
export function lineSidebarAux(page: string): ComponentType | null {
  if (!installed) return null;
  for (const m of LINE_MANIFESTS) {
    if (m.id !== page || m.page.status !== "open") continue;
    return installed[m.id].sidebarAux ?? null;
  }
  return null;
}

type NavShell = "desktop" | "mobile";
/**
 * 導航上的線標記（接縫 #58）：桌機看 `page.status`、手機看 `mobile.status`，`open` 且有填 `navBadge` 或 `navHint` 才回；
 * 否則 null（按鈕與 tab 照舊，DOM 與沒有插槽時逐字相同）。`hint` 只在桌機回（手機沒有 tooltip）。沒裝＝null。
 */
export function lineNavBadge(
  id: LineId,
  shell: NavShell,
): { Badge: ComponentType<{ shell: NavShell }> | null; hint: (() => string | null) | null } | null {
  if (!installed) return null;
  const m = LINE_MANIFESTS.find((x) => x.id === id);
  if (!m) return null;
  const status = shell === "desktop" ? m.page.status : m.mobile.status;
  if (status !== "open") return null;
  const Badge = installed[id].navBadge ?? null;
  const hint = shell === "desktop" ? installed[id].navHint ?? null : null;
  return Badge || hint ? { Badge, hint } : null;
}

type DayMarksFn = (from: string, to: string) => Promise<readonly string[]>;
/** 日曆格內記號的提供者（旅客筆記車次② 0-2 乙），比照 `lineSidebarTools()`：只看 `page.status`；`open` 且有填才算。地基階段恆為空陣列。 */
export function lineCalendarMarks(): { id: LineId; marks: DayMarksFn }[] {
  const out: { id: LineId; marks: DayMarksFn }[] = [];
  if (!installed) return out;
  for (const m of LINE_MANIFESTS) {
    const marks = installed[m.id].calendarDayMarks;
    if (m.page.status === "open" && marks) out.push({ id: m.id, marks });
  }
  return out;
}

/**
 * 捕捉框的別線票根（旅客筆記車次② D-筆-36），比照 `lineSidebarTools()`：三線固定順序 notes → timetable → ticket、
 * 各線內照登記順序；桌機看 `page.status`、手機看 `mobile.status`，`open` 且有填才算。沒裝＝空陣列。
 */
export function lineCaptureTargets(shell: "desktop" | "mobile"): CaptureTargetSpec[] {
  const out: CaptureTargetSpec[] = [];
  if (!installed) return out;
  for (const m of LINE_MANIFESTS) {
    const status = shell === "desktop" ? m.page.status : m.mobile.status;
    const specs = installed[m.id].captureTargets;
    if (status === "open" && specs) out.push(...specs);
  }
  return out;
}

/**
 * 節點詳情欄位列（接縫 #56），比照 `lineCaptureTargets(shell)`：三線固定順序、各線內照登記順序；
 * 桌機看 `page.status`、手機看 `mobile.status`，`open` 且有填才算。呼叫端再依 `kinds` 過濾。沒裝＝空陣列。
 */
export function lineNodeFields(shell: "desktop" | "mobile"): NodeFieldSpec[] {
  const out: NodeFieldSpec[] = [];
  if (!installed) return out;
  for (const m of LINE_MANIFESTS) {
    const status = shell === "desktop" ? m.page.status : m.mobile.status;
    const specs = installed[m.id].nodeFields;
    if (status === "open" && specs) out.push(...specs);
  }
  return out;
}

/**
 * 今日列的附加動作／標記（接縫 #66），比照 `lineNodeFields(shell)`：三線固定順序、各線內照登記順序；
 * 桌機看 `page.status`、手機看 `mobile.status`，`open` 且有填才算。沒裝＝空陣列。
 */
export function lineTodayRowActions(shell: "desktop" | "mobile"): TodayRowActionSpec[] {
  const out: TodayRowActionSpec[] = [];
  if (!installed) return out;
  for (const m of LINE_MANIFESTS) {
    const status = shell === "desktop" ? m.page.status : m.mobile.status;
    const specs = installed[m.id].todayRowActions;
    if (status === "open" && specs) out.push(...specs);
  }
  return out;
}

/**
 * 今日頁鍵盤的線處理函式（接縫 #66），比照 `lineGlobalHotkeyHandler(id)`：只看 `page.status`（今日頁鍵盤只在桌機）；
 * 某條已通車的線在 `todayRowActions[].hotkeys` 登記了這個 hotkey id 就回處理函式，否則 null。沒裝＝null。
 */
export function lineTodayHotkey(hotkeyId: string): ((nodeId: string) => void) | null {
  if (!installed) return null;
  for (const m of LINE_MANIFESTS) {
    if (m.page.status !== "open") continue;
    for (const spec of installed[m.id].todayRowActions ?? []) {
      const fn = spec.hotkeys?.[hotkeyId];
      if (fn) return fn;
    }
  }
  return null;
}

/**
 * 今日統計列的附加段（接縫 #66），比照 `lineNodeFields(shell)`：三線固定順序；
 * 桌機看 `page.status`、手機看 `mobile.status`，`open` 且有填才算。沒裝＝空陣列。
 */
export function lineTodayStats(shell: "desktop" | "mobile"): TodayStatsComp[] {
  const out: TodayStatsComp[] = [];
  if (!installed) return out;
  for (const m of LINE_MANIFESTS) {
    const status = shell === "desktop" ? m.page.status : m.mobile.status;
    const S = installed[m.id].todayStats;
    if (status === "open" && S) out.push(S);
  }
  return out;
}

/** 手機票卡 ⋯ sheet 的附加項（接縫 #56 後半），比照 `lineNodeFields("mobile")`：三線固定順序、只看 `mobile.status`；`open` 且有填才算。沒裝＝空陣列。 */
export function lineTicketSheetItems(): TicketSheetItemSpec[] {
  const out: TicketSheetItemSpec[] = [];
  if (!installed) return out;
  for (const m of LINE_MANIFESTS) {
    const specs = installed[m.id].ticketSheetItems;
    if (m.mobile.status === "open" && specs) out.push(...specs);
  }
  return out;
}

/**
 * 手機路線圖第一層每條路線列尾的小字（接縫 #63），比照 `lineTicketSheetItems()`：三線固定順序、只看 `mobile.status`；
 * `open` 且有填才算。沒裝＝空陣列。
 */
export function lineRouteListAsides(): ComponentType<{ route: NodeRow }>[] {
  const out: ComponentType<{ route: NodeRow }>[] = [];
  if (!installed) return out;
  for (const m of LINE_MANIFESTS) {
    const aside = installed[m.id].routeListAside;
    if (m.mobile.status === "open" && aside) out.push(aside);
  }
  return out;
}

/**
 * 刪除確認框的附加句提供者（接縫 #62），比照 `lineQuickJumpProviders()`：三線固定順序、只看 `page.status`；`open` 且有填才算。
 * 沒裝＝空陣列。呼叫端不直接用——一律走 `./deleteHints` 的 `collectDeleteHints`。
 */
export function lineNodeDeleteHints(): NodeDeleteHintFn[] {
  const out: NodeDeleteHintFn[] = [];
  if (!installed) return out;
  for (const m of LINE_MANIFESTS) {
    const fn = installed[m.id].nodeDeleteHints;
    if (m.page.status === "open" && fn) out.push(fn);
  }
  return out;
}

/** 日曆當日清單浮層底部的一段（接縫 #62），比照 `lineCalendarMarks()`：三線固定順序、只看 `page.status`；`open` 且有填才算。沒裝＝空陣列。 */
export function lineCalendarDayAux(): { id: LineId; Aux: ComponentType<{ day: string; close(): void }> }[] {
  const out: { id: LineId; Aux: ComponentType<{ day: string; close(): void }> }[] = [];
  if (!installed) return out;
  for (const m of LINE_MANIFESTS) {
    const Aux = installed[m.id].calendarDayAux;
    if (m.page.status === "open" && Aux) out.push({ id: m.id, Aux });
  }
  return out;
}

/**
 * 擁有 `tbl` 的那條線的 `syncRowLabel`（接縫 #50；主線車次③）：manifest `syncTables` 含它、桌機看 `page.status`／手機看 `mobile.status` 為 `open`、
 * 且有填才回；否則 null（清單列印泛稱）。沒裝＝null。
 */
export function lineSyncRowLabel(tbl: string, shell: "desktop" | "mobile"): LineMount["syncRowLabel"] | null {
  if (!installed) return null;
  for (const m of LINE_MANIFESTS) {
    if (!m.syncTables.includes(tbl)) continue;
    const status = shell === "desktop" ? m.page.status : m.mobile.status;
    const fn = installed[m.id].syncRowLabel;
    if (status === "open" && fn) return fn;
  }
  return null;
}

/** Ctrl+P 的結果提供者（接縫 #56），比照 `lineSidebarTools()`：三線固定順序、只看 `page.status`；`open` 且有填才算。沒裝＝空陣列。 */
export function lineQuickJumpProviders(): QuickJumpProviderSpec[] {
  const out: QuickJumpProviderSpec[] = [];
  if (!installed) return out;
  for (const m of LINE_MANIFESTS) {
    const spec = installed[m.id].quickJump;
    if (m.page.status !== "open" || !spec) continue;
    // 單值（舊寫法）與陣列都收，統一攤平成陣列
    if (Array.isArray(spec)) out.push(...spec);
    else out.push(spec as QuickJumpProviderSpec);
  }
  return out;
}
