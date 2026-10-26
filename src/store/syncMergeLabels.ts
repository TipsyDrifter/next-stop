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
import { tagRepo } from "../data/tagRepo";
import { followRename } from "../data/tagRepository";
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
 * 線的 `syncRowLabel` 插槽回這一顆（同一個物件，比的是參照）＝「這張表我沒有自己的叫法，照泛稱印」。
 * 為什麼要它：插槽是「一條線一支函式」，填了就接走那條線**所有**表；只想替其中一張講人話（例：售票口的定期帳）時，
 * 其餘的表回 null 會變成「（現在找不到了）」，回這顆才維持泛稱。插槽型別只認 `SyncRowLabel | null`，所以用哨兵物件不另開型別。
 */
export const SYNC_LABEL_FALLBACK: SyncRowLabel = Object.freeze({ label: "" });

/**
 * 荷札的名字（同步引擎班 #97：旅客筆記線的插槽沒填，句子只能說「1 枚荷札」）。旅客筆記線日後填了插槽就以插槽為準、這裡不再走。
 * 已刪的照樣給名字（改名殘影、刪改相撞的那一枚多半是已刪的，「現在已經不在了」由 `gone` 判、不靠這裡回 null）；
 * 表裡根本沒有那一列才回 null。名字用 `#名` 的寫法——跟荷札頁、改名 toast 同一個樣子。
 */
async function tagLabel(rowId: string): Promise<ResolvedMergeLabel | null> {
  const t = await tagRepo.getTagRow(rowId);
  if (!t) return null;
  const out: ResolvedMergeLabel = { label: `#${t.name}`, cols: TAG_COL_LABEL };
  // 改名殘影（已整理、殼收掉了）：清單那一列補一句去了哪（toast 不講，由荷札的整理那句講；`renameResidueKeys`）
  if (t.renamed_to && t.deleted_at !== null) {
    const toId = await followRename(t.id, (id) => tagRepo.getTagRow(id));
    const to = toId ? await tagRepo.getTagRow(toId) : null;
    if (to) out.note = `已改名為「#${to.name}」，掛在上面的東西跟過去了`;
  }
  return out;
}
const TAG_COL_LABEL: Readonly<Record<string, string>> = { name: "名稱", name_key: "名稱", renamed_to: "改名去向" };

/** 逐班時刻覆寫的欄名（label 已帶「M/D 那班」，欄名只剩「時刻」就通順：「『票名 10/19 那班』的時刻兩台都改過」） */
const NTO_COL_LABEL: Readonly<Record<string, string>> = { hhmm: "時刻", due_on: "班次日", node_id: "所屬車票" };

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
    // 逐班時刻覆寫（D-主-120）：講出「哪張票哪一班」——票已不在就退泛稱（而不是「找不到了」：覆寫的主人是票）
    if (n.tbl === "node_time_overrides") {
      const ref = await nodeRepo.getTimeOverrideRef(n.row_id);
      const node = ref ? await findNode(ref.nodeId) : null;
      if (!ref || !node) return { label: "一筆班次時刻", cols: NTO_COL_LABEL, generic: true };
      const md = `${+ref.dueOn.slice(5, 7)}/${+ref.dueOn.slice(8, 10)}`;
      // 名字短截、日期與「那班」必留（沙盒 F-1／F-7：clipLabel 只截「」裡的名，整串要自己管）——
      // 「車票「名6字…」」4+7＋「12/31 那班」8 ＝ 最長 19，toast 的 20 字上限切不到尾巴
      return { label: `${nodeLabel(node, 6)}${md} 那班`, cols: NTO_COL_LABEL, node };
    }
    // 乘務記錄與班次不查列、不可點（它們的主人是那張票；細節在該票的乘務記錄）
    if (n.tbl === "work_logs") return { label: "一筆時間記錄", cols: CONFLICT_COL_LABEL, generic: true };
    if (n.tbl === "occurrences") return { label: "一個班次", cols: CONFLICT_COL_LABEL, generic: true };
    if (n.tbl === "settings") {
      const known = Object.prototype.hasOwnProperty.call(SETTINGS_LABEL, n.row_id);
      return { label: known ? SETTINGS_LABEL[n.row_id] : "一項設定", cols: SETTINGS_COL_LABEL, generic: !known };
    }
    const fn = lineSyncRowLabel(n.tbl, shell);
    if (!fn) return n.tbl === "tags" ? tagLabel(n.row_id) : "fallback";
    // 一條線丟錯（同步丟或 reject）都當作 null（契約 §3.3）
    const r = await Promise.resolve()
      .then(() => fn(n.tbl, n.row_id, shell))
      .catch(() => null);
    return r === SYNC_LABEL_FALLBACK ? "fallback" : r;
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
): Promise<{ label: string; cols?: Readonly<Record<string, string>>; fmt?: SyncRowLabel["fmt"] } | null> {
  if (list.length === 0 || new Set(list.map(mergeObjectKey)).size !== 1) return null;
  const r = await resolveMergeLabel(list[0], shell);
  // 泛稱不當名字：句子改用「1 筆乘務記錄」的句型（`mergeToastText` 的 singleLabel=null 那條）
  if (!r || r === "fallback" || r.generic) return null;
  // 班次時刻的 label 尾端是「M/D 那班」——截 12 字會把日期切成「10/2…」讀成別天（沙盒 F-1），放寬到 20
  const max = list[0].tbl === "node_time_overrides" ? 20 : 12;
  // fmt 一起帶（#96）：集合欄（目標的分類）的 toast 要靠它把兩邊的差講成名字
  return { label: clipLabel(r.label, max), cols: r.cols ?? coreCols(list[0].tbl), ...(r.fmt ? { fmt: r.fmt } : {}) };
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

/**
 * 改名殘影（#97／D-主-121）：荷札的刪改相撞，那一枚其實是「改名刪舊」，而且拉取後的整理已經把掛載轉到新名、殼收掉了
 * （＝有改名去向、現在是刪的）。回這些通知的 `mergeObjectKey`——toast 不再說「你刪掉的荷札回來了」（明明是改名），
 * 改名那句由整理自己出（`tagStore` 的 followRenames）。去向的終點真的被刪了、殼留著的不算（照舊句：它真的回來了）。
 * 查不到就當不是（照舊句）；永不 throw。
 */
export async function renameResidueKeys(list: readonly MergeNotice[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const n of list) {
    if (n.tbl !== "tags" || n.kind === "overwritten") continue;
    try {
      const t = await tagRepo.getTagRow(n.row_id);
      if (t && t.renamed_to && t.deleted_at !== null) out.add(mergeObjectKey(n));
    } catch {
      /* 查不到＝照舊句 */
    }
  }
  return out;
}

/** toast 用：清單恰好一筆時解它的 label（截 12 字）；多筆或解不到 ⇒ null */
export async function resolveToastLabel(list: readonly MergeNotice[], shell: "desktop" | "mobile"): Promise<string | null> {
  return (await resolveToastParts(list, shell))?.label ?? null;
}
