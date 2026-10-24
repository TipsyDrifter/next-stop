/**
 * syncMergeLabels——同步頁「最近兩台撞到的」每一列叫什麼（主線車次③；契約 §3.5）。
 *
 * 只解名字、**不組跳轉**：核心 nodes 回 `{ label, cols, node }`，「點了跳過去」由 UI 層的 `MergeNotices.tsx`
 * 用 `jumpToNode` 自己組（§0-1 第 9 條）。本檔**不得 import 任何 `.tsx`**——跳轉元件帶 overlay.css／nodeStore／uiStore，
 * store 層一碰它就把元件樹提早到核心元件之前求值、改到 CSS 注入序並形成 store→元件→store 循環（`lines/runtime.ts` 檔頭鐵則）。
 *
 * 三線的表走插槽 `LineMount.syncRowLabel`（`lineSyncRowLabel(tbl, shell)`；未通車／沒填 ⇒ "fallback"＝印泛稱）。
 */
import { nodeRepo, syncRepo } from "../data";
import { MOCK_FIRST_TICKET, type MergeCellNow, type MergeNotice } from "../data/syncRepository";
import { CONFLICT_COL_LABEL, KIND_LABEL, type NodeRow } from "../domain";
import { clipLabel, mergeObjectKey } from "../domain/syncMerge";
import type { SyncRowLabel } from "../lines/types";
import { lineSyncRowLabel } from "../lines/runtime";
import { todayKey } from "../lib/date";
import { useUiStore } from "./uiStore";

/** 解出來的一列：`open` 由三線插槽給；核心 nodes 不給 open、改給 `node`，由 MergeNotices（UI 層）自己組 jumpToNode */
export interface ResolvedMergeLabel extends SyncRowLabel {
  node?: NodeRow;
  /** 泛稱（「一筆乘務記錄」「一個班次」「一項設定」）：清單列照印，但 toast 不拿它當名字（包進「」會變成像是某張票的名字） */
  generic?: boolean;
}

/** 核心三表（主線自己解名字、欄名用 nodes 系的 `CONFLICT_COL_LABEL`） */
const CORE_TABLES = new Set(["nodes", "work_logs", "occurrences"]);

/** 核心 settings 表（目前只有 `day_start_hour`）：Rust 對每張表都記通知，KeyValue 也算，所以主線自己解名字 */
const SETTINGS_COL_LABEL: Readonly<Record<string, string>> = { value: "設定" };
const SETTINGS_LABEL: Readonly<Record<string, string>> = { day_start_hour: "一天從幾點開始" };

/**
 * 欄名表：核心三表＝`CONFLICT_COL_LABEL`（nodes 系專用）；三線表＝undefined（插槽沒給就印欄名原文，§0-1 第 16 條）。
 * 給 UI 在列解不到（泛稱／找不到了）時仍把核心欄名印成中文用。
 */
export function coreCols(tbl: string): Readonly<Record<string, string>> | undefined {
  if (tbl === "settings") return SETTINGS_COL_LABEL;
  return CORE_TABLES.has(tbl) ? CONFLICT_COL_LABEL : undefined;
}

function nodeLabel(node: NodeRow, max: number): string {
  return clipLabel(`${KIND_LABEL[node.kind] ?? "車票"}「${node.name}」`, max);
}

async function findNode(rowId: string): Promise<NodeRow | null> {
  if (rowId === MOCK_FIRST_TICKET) {
    // mock 示範通知拿不到真 id（記憶體種子的票 id 是 uuid()）——改拿今日頁第一張車票（§0-1 第 15 條；真 Rust 不會產生這個 id）
    const dayStartHour = useUiStore.getState().dayStartHour;
    const rows = await nodeRepo.listToday(todayKey(dayStartHour), dayStartHour);
    return rows.find((r) => r.kind === "ticket") ?? null;
  }
  const node = await nodeRepo.getNode(rowId);
  // 型別沒宣告 deleted_at，但 SQLite 的 `SELECT *` 會帶回來——已刪＝「現在找不到了」
  if (!node || (node as NodeRow & { deleted_at?: string | null }).deleted_at) return null;
  return node;
}

/**
 * 解一列的名字：核心表自己來，三線走插槽；都沒有 ⇒ "fallback"。**永不 throw**。
 *   物件 ⇒ 用它；null ⇒ 「{名詞}（現在找不到了）」；"fallback" ⇒ `fallbackLabel(n)`。
 */
export async function resolveMergeLabel(
  n: MergeNotice,
  shell: "desktop" | "mobile",
): Promise<ResolvedMergeLabel | null | "fallback"> {
  try {
    if (n.tbl === "nodes") {
      const node = await findNode(n.row_id);
      if (!node) return null;
      return { label: nodeLabel(node, 24), cols: CONFLICT_COL_LABEL, node };
    }
    // 乘務記錄與班次不查列、不可點（它們的主人是那張票；細節在該票的乘務記錄）
    if (n.tbl === "work_logs") return { label: "一筆時間記錄", cols: CONFLICT_COL_LABEL, generic: true };
    if (n.tbl === "occurrences") return { label: "一個班次", cols: CONFLICT_COL_LABEL, generic: true };
    if (n.tbl === "settings") {
      const known = Object.prototype.hasOwnProperty.call(SETTINGS_LABEL, n.row_id);
      return { label: known ? SETTINGS_LABEL[n.row_id] : "一項設定", cols: SETTINGS_COL_LABEL, generic: !known };
    }
    const fn = lineSyncRowLabel(n.tbl, shell);
    if (!fn) return "fallback";
    // 一條線丟錯（同步丟或 reject）都當作 null（契約 §3.3）
    return await Promise.resolve()
      .then(() => fn(n.tbl, n.row_id, shell))
      .catch(() => null);
  } catch (e) {
    // 本機 SQL 一時讀不到 ≠ 那筆不在了：印泛稱，不說「找不到了」
    console.warn("[next-stop] 同步清單列名解不出來：", e);
    return "fallback";
  }
}

/**
 * toast 用：`list` 只講一樣東西時（主線④ #82：同一塊兩欄被蓋是兩筆、仍是一樣東西）解它的名字（截 12 字）與欄名表；
 * 多樣、泛稱、找不到 ⇒ null（句子改用「1 則筆記」）。
 * 欄名表給 overwritten 的「『{label}』的{欄}」用（契約 §4.9）——`resolveToastLabel` 只回名字、這支多帶欄名（加的，不改簽名）。
 */
export async function resolveToastParts(
  list: readonly MergeNotice[],
  shell: "desktop" | "mobile",
): Promise<{ label: string; cols?: Readonly<Record<string, string>> } | null> {
  if (list.length === 0 || new Set(list.map(mergeObjectKey)).size !== 1) return null;
  const r = await resolveMergeLabel(list[0], shell);
  // 泛稱不當名字：句子改用「1 筆乘務記錄」的句型（`mergeToastText` 的 singleLabel=null 那條）
  if (!r || r === "fallback" || r.generic) return null;
  return { label: clipLabel(r.label, 12), cols: r.cols ?? coreCols(list[0].tbl) };
}

/** 整理之後的現況（磨光② A4）：刪改相撞的那幾樣哪些不在了＋兩邊都改了的那幾格現在的樣子 */
export interface MergeNow {
  /** `mergeObjectKey` 的集合（revived／kept 現在不在了的） */
  gone: Set<string>;
  /** `mergeCellKey` → 那一格現在的樣子（overwritten 的；查不到的不在 Map 裡） */
  cells: Map<string, MergeCellNow>;
}

/**
 * 清單與 toast 共用（磨光② A4）：一次查齊 `list` 的現況——revived／kept 走 `goneObjects`、overwritten 走 `currentCells`，
 * 兩支並行（本機 SQL、≤20 筆）。兩支都永不 throw ⇒ 這支也不會；查不到的就不在結果裡（＝照舊句）。
 */
export async function resolveMergeNow(list: readonly MergeNotice[]): Promise<MergeNow> {
  const [gone, cells] = await Promise.all([
    syncRepo.goneObjects(list.filter((n) => n.kind !== "overwritten")),
    syncRepo.currentCells(list.filter((n) => n.kind === "overwritten")),
  ]);
  return { gone, cells };
}

/** toast 用：清單恰好一筆時解它的 label（截 12 字）；多筆或解不到 ⇒ null */
export async function resolveToastLabel(list: readonly MergeNotice[], shell: "desktop" | "mobile"): Promise<string | null> {
  return (await resolveToastParts(list, shell))?.label ?? null;
}
