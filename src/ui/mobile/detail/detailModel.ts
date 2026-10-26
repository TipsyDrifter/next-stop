/**
 * 手機詳情頁的純邏輯（手機殼班 D-主-69／75／78）——不碰 React、store、repository：`scripts/tests/mobile-detail.test.ts` 用 node 直接載入。
 * 跟桌機側板共用的規則（重複規則草稿、票種轉換、現況可選格、検印怎麼畫）不在這裡，在 `panel/panelRules.ts`（D-主-82：只留一處）；
 * 這裡只剩手機才有的：
 *
 * 一、數字步進器的夾值（每月幾日、完成後幾天；桌機是 NumberField，沒有步進）。
 * 二、MobileTimeSheet 要的卡（rule 模式只讀每班時刻、預計、班次日、済／運休／入鋏）。
 * 三、乘務記錄列的排序與時刻字（競合另列，同 MobileRouteMap 唯讀詳情那段）。
 *
 * 只准 `import type`＋帶 .ts 的 domain/repeat（測試用 resolve hook 補 lib/date 的副檔名）。
 */
import type { NodeRow } from "../../../domain";
import type { CurrentOccurrence } from "../../../data/nodeRepository";
import type { TicketCardModel } from "../../schedule/ticketCard";
import { describeRule, parseRule } from "../../../domain/repeat.ts";

/* ───────────── 一、步進器 ───────────── */

/** 數字欄的步進與手打（每月 1–31、完成後 1–365）：非數字＝null（不送），超界夾回 */
export function clampInt(raw: string | number | null, min: number, max: number): number | null {
  const v = typeof raw === "number" ? raw : raw === null ? NaN : Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(v)) return null;
  return Math.min(max, Math.max(min, Math.trunc(v)));
}

/* ───────────── 二、時刻 sheet 的卡 ───────────── */

/**
 * 詳情頁開 MobileTimeSheet（mode="rule"＝單發票的時刻／定期券的每班時刻＋預計）要的卡。
 * 班次日＝`occurrence?.due_on ?? scheduled_on`（桌機 TeikiStampRow 的 railDate 同一把尺）；rule 模式不讀逐班覆寫，time 就給每班值。
 */
export function timeCardOf(node: NodeRow, occ: CurrentOccurrence | undefined): TicketCardModel {
  const rule = parseRule(node.repeat_rule);
  const done = occ ? occ.status === "done" : node.status === "done";
  const suspended = occ?.status === "skipped";
  const railDate = occ?.due_on ?? node.scheduled_on;
  return {
    key: node.id,
    nodeId: node.id,
    name: node.name,
    kind: node.kind,
    routeId: node.route_id,
    serial: null,
    fare: rule ? "定期券" : node.parent_id === null ? "臨時券" : "乘車券",
    ruleText: rule ? describeRule(rule) : null,
    isRepeat: rule !== null,
    scheduledOn: node.scheduled_on,
    railDate,
    dueOn: node.due_on,
    carriedFrom: node.carried_from,
    done,
    suspended,
    paused: node.status === "paused" && !done && !suspended,
    late: null,
    children: null,
    stampable: true,
    stampHint: null,
    readOnly: false,
    time: node.scheduled_time,
    timeOverridden: false,
    ruleTime: node.scheduled_time,
    estimateMin: node.estimate_min,
    doing: node.status === "doing" && (rule === null || railDate === node.scheduled_on),
  };
}

/* ───────────── 三、乘務記錄 ───────────── */

export interface LogLike {
  id: string;
  event: string | null;
  logged_at: string;
}

/** 新到舊（不依賴 repository 回傳順序；同桌機 WorkLogList） */
export function newestFirst<T extends LogLike>(logs: readonly T[]): T[] {
  return [...logs].sort((a, b) => (a.logged_at < b.logged_at ? 1 : a.logged_at > b.logged_at ? -1 : 0));
}

/** 乘務記錄清單（手記＋発券／入鋏／済）與競合列分開：競合在自己那一列講（同 MobileRouteMap 唯讀詳情） */
export function splitLogs<T extends LogLike>(logs: readonly T[] | undefined): { entries: T[]; conflicts: T[]; manual: number } {
  const all = newestFirst(logs ?? []);
  const entries = all.filter((l) => l.event !== "conflict");
  return {
    entries,
    conflicts: all.filter((l) => l.event === "conflict"),
    // 只數主人手寫的那幾則；系統事件不算「記録」（桌機段頭計數同一把尺）
    manual: entries.filter((l) => l.event === null).length,
  };
}

/** UTC ISO → 本地 "M/D HH:mm"（乘務記錄與競合的時刻淡字；壞字串原樣回傳） */
export function fmtLogStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
