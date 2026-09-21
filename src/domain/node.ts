/**
 * 🚃 Node（節點）——彈性樹的唯一實體
 *
 * 幹線／路線／支線／列車／車廂／車票／車站全部是 node，用 kind 分身分：
 *   line → route → (branch→)* → train → (car→)* → ticket；station 掛在 route 下
 * 規則見 docs/產品規格書.md §5；允許的父子關係以 allowedChildKinds 為準（repository 建立／搬移時強制）。
 */
import type { SyncFields } from "./sync";

export type NodeKind = "line" | "route" | "branch" | "train" | "car" | "ticket" | "station";
export type NodeStatus = "todo" | "doing" | "done" | "paused";
export type Priority = "low" | "mid" | "high";
export type Mood = "green" | "yellow" | "red";
/**
 * 乘務記錄的系統事件（M3 ③ D-③-5 乙）：発券＝建票、入鋏＝首次進 doing、済＝完成。
 * WorkLog.event 為 null ＝主人手記（原件 .act 欄留白）。事件列 body 一律空字串。
 */
/**
 * v1.1.2：`conflict`＝同步衝突（欄位級 LWW 的敗方值；D-1.1-5「輸家寫進該節點乘務記錄」）。
 * 由 Rust apply 直寫 work_logs（不進 outbox、各台自己記）；body＝JSON（見 syncRepository 的 ConflictBody）。
 * 只有這一種事件的 body 非空。
 */
export type WorkLogEvent = "issued" | "punched" | "done" | "conflict";

export const WORK_LOG_EVENT_LABEL: Record<WorkLogEvent, string> = {
  issued: "発券",
  punched: "入鋏",
  done: "済",
  /** v1.1.2 同步衝突（欄位級 LWW 的敗方入乘務記錄）；一行文案由 WorkLogList 依 body JSON 組 */
  conflict: "競合",
};

export interface NodeRow extends SyncFields {
  id: string;
  kind: NodeKind;
  parent_id: string | null;
  line_id: string | null;
  route_id: string | null;
  name: string;
  description: string | null;
  position: number;
  color: string | null;
  code: string | null;
  status: NodeStatus;
  scheduled_on: string | null;
  due_on: string | null;
  priority: Priority;
  estimate_min: number | null;
  progress: number | null;
  time_spent_min: number | null;
  mood: Mood | null;
  repeat_rule: string | null;
  completed_at: string | null;
  expected_on: string | null;
  arrived_on: string | null;
  /** 今日視圖的手動序（M3 ③）；NULL＝還沒進過今日，首次聚合時 lazy 指派 max+1 */
  today_position: number | null;
  /** 繰越來源＝被推遲前的執行日 YYYY-MM-DD（M3 ③）；NULL＝沒被推遲過 */
  carried_from: string | null;
}

export interface WorkLog extends SyncFields {
  id: string;
  node_id: string;
  body: string;
  logged_at: string;
  /** 系統事件；NULL＝主人手記 */
  event: WorkLogEvent | null;
}

export const KIND_LABEL: Record<NodeKind, string> = {
  line: "幹線",
  route: "路線",
  branch: "支線",
  train: "列車",
  car: "車廂",
  ticket: "車票",
  station: "車站",
};

/** 某種父節點底下允許出現的子節點種類（parent=null ＝ 根層：幹線；臨時車票）。 */
export function allowedChildKinds(parent: NodeKind | null): NodeKind[] {
  switch (parent) {
    case null:
      return ["line", "ticket"];
    case "line":
      return ["route"];
    case "route":
      return ["branch", "train", "station"];
    case "branch":
      return ["branch", "train"];
    case "train":
    case "car":
      return ["car", "ticket"];
    case "ticket":
    case "station":
      return [];
  }
}

/** Tab 降層時的類型推導（D 定案：路線／支線下→列車；列車／車廂下→車廂）。 */
export function defaultChildKind(parent: NodeKind): NodeKind | null {
  switch (parent) {
    case "line":
      return "route";
    case "route":
    case "branch":
      return "train";
    case "train":
    case "car":
      return "car";
    default:
      return null;
  }
}

export function canHaveChildren(kind: NodeKind): boolean {
  return kind !== "ticket" && kind !== "station";
}

/** 列車／車廂＝「任務」：擁有完整欄位集、完成時出完成卡。 */
export function isTaskKind(kind: NodeKind): boolean {
  return kind === "train" || kind === "car";
}

/* ═══════════════════════════════════════════════════════════════════════
   v1.1.2 同步衝突的一行文案（WP10b）
   ═══════════════════════════════════════════════════════════════════════

   為什麼寫在 domain 而不是元件裡：同一句話要在桌機側板（WorkLogList）與手機路線圖的唯讀詳情
   （MobileRouteMap.RowDetail）各印一次；文案規則放元件就會分岔成兩份真相。
   拍板依據：D-1.1-5「欄位級 LWW＋HLC，敗方寫進該節點乘務記錄」＋
             《2026-09-19-v1.1.2-雙向同步契約.md》§3.4（body 的 JSON 形狀）／§9.2（文案）。
   body 由 Rust `apply_object` 直寫（不進 outbox、各台自己記），所以這裡只負責**讀**。 */

/** `work_logs.body` 在 `event='conflict'` 時的 JSON（契約 §3.4；`mine`／`theirs` 用 JSON 原型別） */
export interface ConflictBody {
  col: string;
  mine: unknown;
  theirs: unknown;
  their_device: string;
  /**
   * v1.1.2 評審 S3：留下來的是誰的值。缺欄（v1.1.2 初版寫的日誌）一律當 `"theirs"`＝本機讓位。
   * `"mine"` 的情境：這台的那一版比較新、而且**還沒推出去**——對方判不出併發，只有這台能記。
   */
  winner?: "mine" | "theirs";
  hlc: string;
  mine_hlc: string;
  tbl: string;
  row_id: string;
}

/** 欄名中文化（契約 §9.2）——主人看到的是票面語彙，不是資料庫欄名 */
export const CONFLICT_COL_LABEL: Record<string, string> = {
  name: "票名",
  description: "說明",
  status: "狀態",
  scheduled_on: "日期",
  due_on: "截止",
  priority: "優先",
  mood: "心情",
  position: "順序",
  today_position: "今日順序",
  parent_id: "掛在",
  repeat_rule: "定期券",
  completed_at: "完成時刻",
  deleted_at: "刪除",
  body: "內文",
  value: "設定",
};

/** 值 → 一段短字：null／空白＝「（空）」；太長截到 40 字（一列塞得下，細節看另一台） */
function fmtConflictValue(v: unknown): string {
  if (v === null || v === undefined) return "（空）";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  const t = s.trim();
  if (!t) return "（空）";
  return t.length > 40 ? `${t.slice(0, 40)}…` : t;
}

/**
 * 衝突日誌 → 一行人話。解析失敗就原字串照印（寧可醜也不要空白列；body 是別台寫的，不能假設格式）。
 * 刪除欄有兩個方向，語氣不同：對方刪了但我改過＝保留；我刪了但對方改過＝已復活。
 */
export function describeConflict(body: string): string {
  let b: ConflictBody;
  try {
    b = JSON.parse(body) as ConflictBody;
  } catch {
    return body;
  }
  if (!b || typeof b.col !== "string") return body;
  const empty = (v: unknown) => v === null || v === undefined || v === "";
  if (b.col === "deleted_at") {
    if (!empty(b.theirs) && empty(b.mine)) return "另一台刪了這張票，但這台改過——保留這張票";
    if (empty(b.theirs) && !empty(b.mine)) return "這台刪過這張票，另一台改過——已復活";
  }
  const label = CONFLICT_COL_LABEL[b.col] ?? b.col;
  // 方向兩種（評審 S3）：預設是這台讓位；`winner === "mine"` 是對方讓給這台（敗方值同樣留在這一行）
  if (b.winner === "mine") {
    return `${label}：另一台改的「${fmtConflictValue(b.theirs)}」讓給這台的「${fmtConflictValue(b.mine)}」`;
  }
  return `${label}：這台改的「${fmtConflictValue(b.mine)}」讓給另一台的「${fmtConflictValue(b.theirs)}」`;
}
