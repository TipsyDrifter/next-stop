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
import type { CaptureTargetSpec, LineId, LineMount, LineReloadContext, NodeFieldSpec, QuickJumpProviderSpec, TicketSheetItemSpec } from "./types";

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

/** Ctrl+P 的結果提供者（接縫 #56），比照 `lineSidebarTools()`：三線固定順序、只看 `page.status`；`open` 且有填才算。沒裝＝空陣列。 */
export function lineQuickJumpProviders(): QuickJumpProviderSpec[] {
  const out: QuickJumpProviderSpec[] = [];
  if (!installed) return out;
  for (const m of LINE_MANIFESTS) {
    const spec = installed[m.id].quickJump;
    if (m.page.status === "open" && spec) out.push(spec);
  }
  return out;
}
