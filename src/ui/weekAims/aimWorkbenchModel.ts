/**
 * 行路企劃書工作台模型（D-FB-6：討論 4 方針一鍵掛路線 ＋ 畫面 1 展開式三欄同屏對照工作台）。
 *
 * 純邏輯層（零 React／DOM 相依，供桌機三欄工作台、車站雙欄對話框、手機全螢幕多籤面板與單元測試共用）：
 *   1. `resolveInitialWorkbenchKeys`：由任一入口期間鍵（週／月／年）推導三欄初始期間鍵與聚焦欄。
 *   2. `WorkbenchLedger`：以期間鍵索引多期草稿與基準快照（`{ drafts, base }`），同場翻閱 `‹ 期 ›` 或切換尺度分頁絕不遺失未存草稿，底欄一次存檔依「年 → 月 → 週 → 車站」順序寫入所有有異動的期間。
 *   3. `carryDraftAcrossColumns`／`carryRowIntoLedger`：支援將上層（今年 → 本月、本月 → 本週、或年／月 → 車站）已存或剛打字尚未存檔的方針一鍵引流至目標期間（未存新句自動賦予穩定 UUID，直接銜接 `planSaveWeek` 的 `creates.id` 與 `carryAimId` 決定性雜湊）。
 *   4. `pickTargetOfRoute`：討論 4 方針統一掛路線（`depth="route"`），舊資料庫若仍有掛支線的歷史方針，開啟路線選單時自動對齊高亮其所屬母路線，引流時亦收斂至路線 ID。
 */
import type { AttachTarget } from "../../domain/notes";
import {
  MAX_AIMS,
  carryAimId,
  currentKeyOf,
  normalizeAimText,
  periodOfKey,
  periodShortLabel,
  upperKeyOf,
  weekOnOf,
  type AimDraft,
  type AimPeriod,
  type ReviewPeriod,
  type WeekAimRow,
} from "../../domain/weekAims";

export interface WorkbenchKeys {
  yearKey: string;
  monthKey: string;
  weekKey: string;
  focusScale: ReviewPeriod;
}

export interface LedgerEntry {
  drafts: AimDraft[];
  base: AimDraft[];
}

export type WorkbenchLedger = Record<string, LedgerEntry>;

/**
 * 由開啟編輯器時的期間鍵（週／月／年）推導三欄工作台的初始期間鍵與預設聚焦欄：
 *   - 從「週」開啟（如今日頁本週、行程表下週）：右欄鎖定該週，中欄對齊其所屬月，左欄對齊其所屬年。
 *   - 從「月」開啟（如運行報告某月）：中欄鎖定該月，左欄對齊該年；若該月即本月則右欄取本週，否則取週首落於該月內的第一週（7 號所在週必落在 1～7 號）。
 *   - 從「年」開啟（如車庫年鑑某年）：左欄鎖定該年；若即今年則中／右欄取本月／本週，否則取該年 1 月與第一週。
 */
export function resolveInitialWorkbenchKeys(initialKey: string, today: string, weekStart: 0 | 1): WorkbenchKeys {
  const kind = periodOfKey(initialKey);
  const curYear = currentKeyOf("year", today, weekStart);
  const curMonth = currentKeyOf("month", today, weekStart);
  const curWeek = currentKeyOf("week", today, weekStart);

  if (kind === "year") {
    if (initialKey === curYear) {
      return { yearKey: initialKey, monthKey: curMonth, weekKey: curWeek, focusScale: "year" };
    }
    const y = initialKey.slice(1, 5);
    const monthKey = `M${y}-01`;
    const weekKey = weekOnOf(`${y}-01-07`, weekStart);
    return { yearKey: initialKey, monthKey, weekKey, focusScale: "year" };
  }

  if (kind === "month") {
    const yearKey = upperKeyOf(initialKey, today) ?? curYear;
    const weekKey =
      initialKey === curMonth ? curWeek : weekOnOf(`${initialKey.slice(1, 8)}-07`, weekStart);
    return { yearKey, monthKey: initialKey, weekKey, focusScale: "month" };
  }

  // 預設（含 week 與理論上非 station fallback）
  const weekKey = kind === "week" ? initialKey : curWeek;
  const monthKey = upperKeyOf(weekKey, today) ?? curMonth;
  const yearKey = upperKeyOf(monthKey, today) ?? curYear;
  return { yearKey, monthKey, weekKey, focusScale: "week" };
}

/** 資料庫列轉編輯草稿 */
export function draftsOfAims(aims: readonly WeekAimRow[]): AimDraft[] {
  return aims.map((a) => ({
    id: a.id,
    text: a.text,
    nodeId: a.node_id,
    carriedFrom: a.carried_from,
  }));
}

/** 比對兩份草稿是否實質相同（忽略空白列與首尾多餘空白，對齊 `planSaveWeek` 存檔語意） */
export function sameAimDrafts(a: readonly AimDraft[], b: readonly AimDraft[]): boolean {
  const norm = (list: readonly AimDraft[]) =>
    JSON.stringify(
      list
        .filter((x) => normalizeAimText(x.text) !== "")
        .map((x) => [x.id, normalizeAimText(x.text), x.nodeId, x.carriedFrom]),
    );
  return norm(a) === norm(b);
}

/** 單一期間草稿是否有未存變更 */
export function isPeriodDirty(entry: LedgerEntry | undefined): boolean {
  return entry !== undefined && !sameAimDrafts(entry.drafts, entry.base);
}

const PERIOD_SAVE_ORDER: Record<AimPeriod, number> = {
  year: 0,
  month: 1,
  week: 2,
  station: 3,
};

/** 列出帳本中所有有未存變更的期間鍵，依「年 → 月 → 週 → 車站」排序，確保上層新句先落庫再存下層引流句 */
export function dirtyPeriodKeys(ledger: WorkbenchLedger): string[] {
  return Object.keys(ledger)
    .filter((k) => isPeriodDirty(ledger[k]))
    .sort((a, b) => {
      const oa = PERIOD_SAVE_ORDER[periodOfKey(a)];
      const ob = PERIOD_SAVE_ORDER[periodOfKey(b)];
      return oa !== ob ? oa - ob : a.localeCompare(b);
    });
}

/** 計算草稿中有效非空句數 */
export function nonEmptyAimCount(drafts: readonly AimDraft[]): number {
  let n = 0;
  for (const d of drafts) {
    if (normalizeAimText(d.text) !== "") n++;
  }
  return n;
}

/** 討論 4：將方針關聯的路線 ID 轉為 `depth="route"` 挑選器的目標值（歷史支線亦透過呼叫端傳入其母路線 ID 對齊高亮） */
export function pickTargetOfRoute(routeId: string | null): AttachTarget {
  if (!routeId) return { routeId: null, nodeId: null, nodeKind: null };
  return { routeId, nodeId: null, nodeKind: "route" };
}

/** 跨尺度引流按鈕短標（如「本月」「12月」「本週」「下週」） */
export function flowTargetShort(targetKey: string, today: string, weekStart: 0 | 1): string {
  if (periodOfKey(targetKey) === "station") return "本站";
  return periodShortLabel(targetKey, today, weekStart);
}

export type CarryAcrossStatus = "carried" | "already_carried" | "target_full" | "empty_source" | "missing_entry";

export interface CarryAcrossResult {
  status: CarryAcrossStatus;
  ledger: WorkbenchLedger;
  carriedDraft?: AimDraft;
}

/**
 * 跨欄一鍵引流（今年 → 本月、本月 → 本週）：
 *   - 支援「剛在左／中欄打字、尚未存檔」的新方針：自動為來源草稿補上穩定 UUID（`planSaveWeek` 原生支援 `creates` 帶預設 `id`），
 *     並以 `carryAimId(srcId, targetKey)` 產生決定性目標 ID 與 `carriedFrom = srcId`。
 *   - 若來源掛的是歷史支線，可透過 `resolveRouteId` 收斂為母路線 ID，落實討論 4 路線級對焦。
 */
export async function carryDraftAcrossColumns(params: {
  ledger: WorkbenchLedger;
  sourceKey: string;
  sourceIndex: number;
  targetKey: string;
  resolveRouteId?: (nodeId: string | null) => string | null;
  makeUuid?: () => string;
}): Promise<CarryAcrossResult> {
  const {
    ledger,
    sourceKey,
    sourceIndex,
    targetKey,
    resolveRouteId,
    makeUuid = () => crypto.randomUUID(),
  } = params;

  const srcEntry = ledger[sourceKey];
  const dstEntry = ledger[targetKey];
  if (!srcEntry || !dstEntry) return { status: "missing_entry", ledger };

  const rawSrc = srcEntry.drafts[sourceIndex];
  if (!rawSrc) return { status: "empty_source", ledger };
  const cleanText = normalizeAimText(rawSrc.text);
  if (!cleanText) return { status: "empty_source", ledger };

  const srcId = rawSrc.id ?? makeUuid();
  const nextLedger: WorkbenchLedger = { ...ledger };

  if (rawSrc.id === null) {
    const nextSrcDrafts = [...srcEntry.drafts];
    nextSrcDrafts[sourceIndex] = { ...rawSrc, id: srcId };
    nextLedger[sourceKey] = { ...srcEntry, drafts: nextSrcDrafts };
  }

  const trimmedDst = dstEntry.drafts.filter((x) => normalizeAimText(x.text) !== "" || x.id !== null);
  if (trimmedDst.some((x) => x.carriedFrom === srcId)) {
    return { status: "already_carried", ledger: nextLedger };
  }
  if (nonEmptyAimCount(trimmedDst) >= MAX_AIMS) {
    return { status: "target_full", ledger: nextLedger };
  }

  const carriedId = await carryAimId(srcId, targetKey);
  const nodeId = resolveRouteId ? resolveRouteId(rawSrc.nodeId) : rawSrc.nodeId;
  const carriedDraft: AimDraft = {
    id: carriedId,
    text: cleanText,
    nodeId,
    carriedFrom: srcId,
  };

  nextLedger[targetKey] = {
    ...dstEntry,
    drafts: [...trimmedDst, carriedDraft],
  };

  return { status: "carried", ledger: nextLedger, carriedDraft };
}

/**
 * 將已落庫的方針列（如「上一期沒済的」、車站右側「今年／本月方針」參照、手機版上層參照）一鍵帶入目標期間草稿。
 */
export async function carryRowIntoLedger(params: {
  ledger: WorkbenchLedger;
  srcRow: Pick<WeekAimRow, "id" | "text" | "node_id">;
  targetKey: string;
  resolveRouteId?: (nodeId: string | null) => string | null;
}): Promise<CarryAcrossResult> {
  const { ledger, srcRow, targetKey, resolveRouteId } = params;
  const dstEntry = ledger[targetKey];
  if (!dstEntry) return { status: "missing_entry", ledger };

  const cleanText = normalizeAimText(srcRow.text);
  if (!cleanText) return { status: "empty_source", ledger };

  const trimmedDst = dstEntry.drafts.filter((x) => normalizeAimText(x.text) !== "" || x.id !== null);
  if (trimmedDst.some((x) => x.carriedFrom === srcRow.id)) {
    return { status: "already_carried", ledger };
  }
  if (nonEmptyAimCount(trimmedDst) >= MAX_AIMS) {
    return { status: "target_full", ledger };
  }

  const carriedId = await carryAimId(srcRow.id, targetKey);
  const nodeId = resolveRouteId ? resolveRouteId(srcRow.node_id) : srcRow.node_id;
  const carriedDraft: AimDraft = {
    id: carriedId,
    text: cleanText,
    nodeId,
    carriedFrom: srcRow.id,
  };

  return {
    status: "carried",
    ledger: {
      ...ledger,
      [targetKey]: {
        ...dstEntry,
        drafts: [...trimmedDst, carriedDraft],
      },
    },
    carriedDraft,
  };
}
