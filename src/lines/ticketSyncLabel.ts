/**
 * ticketSyncLabel——同步頁「最近兩台撞到的」清單列：售票口的定期帳（tk_repeats）叫什麼、欄名、值怎麼印（同步引擎班順手）。
 *
 * 為什麼只做定期帳：它的 `skipped_days`（刪掉的班次日集合）是整欄一格，兩台各刪一班會互蓋，提示原本印成
 * 「一筆資料（a1b2）的 skipped_days」——欄名、列名都不是人話。售票口其餘的表照舊印泛稱（`ticket.mount.tsx` 回
 * `SYNC_LABEL_FALLBACK`）。
 *
 * **純函式**：只准 import 型別（`scripts/tests/sync-engine-labels.test.ts` 以 node 直接載入）；查列、查名字由呼叫端注入。
 */
import type { RepeatRow } from "../domain/ticket.ts";
import type { SyncRowLabel } from "./types.ts";

/** 呼叫端注入的查名字（查不到回 null） */
export interface TicketLabelLookup {
  accountName(id: string): string | null;
  categoryName(id: string): string | null;
}

/** 定期帳的欄名（白名單全集裡主人看得到、改得到的那些；匯入記帳欄不列＝印原文） */
export const REPEAT_COLS: Readonly<Record<string, string>> = {
  kind: "種類",
  account_id: "帳戶",
  to_account_id: "轉入帳戶",
  category_id: "分類",
  amount_minor: "金額",
  currency: "幣別",
  note: "備註",
  route_id: "路線",
  rule: "重複規則",
  hhmm: "記帳時刻",
  next_on: "下一班",
  paused_at: "暫停",
  skipped_days: "刪掉的班次",
  position: "排序",
};

const KIND_WORD: Readonly<Record<string, string>> = { income: "收入", expense: "支出", transfer: "轉帳" };

/** 'YYYY-MM-DD' → 'M/D'；形狀不對 ⇒ null */
function md(key: unknown): string | null {
  if (typeof key !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
  const [, m, d] = key.split("-").map(Number);
  return `${m}/${d}`;
}

/** 班次日集合（JSON 陣列）→「10/19、10/20、10/21 等 5 天」；空＝「（沒有）」；解不開 ⇒ null */
export function skippedDaysText(v: unknown, max = 3): string | null {
  if (typeof v !== "string") return null;
  let arr: unknown;
  try {
    arr = JSON.parse(v);
  } catch {
    return null;
  }
  if (!Array.isArray(arr)) return null;
  const days = arr.map(md).filter((x): x is string => x !== null);
  if (!days.length) return "（沒有）";
  return days.slice(0, max).join("、") + (days.length > max ? ` 等 ${days.length} 天` : "");
}

/** 列名：備註＞分類＞帳戶（定期帳沒有名字欄，主人在清單上認它就是靠這幾個） */
export function repeatLabel(row: Pick<RepeatRow, "note" | "category_id" | "account_id">, look: TicketLabelLookup): string {
  const name =
    row.note.trim() ||
    (row.category_id ? look.categoryName(row.category_id) : null) ||
    look.accountName(row.account_id) ||
    "沒有名字";
  return `定期帳「${name}」`;
}

export function repeatSyncLabel(row: RepeatRow, look: TicketLabelLookup): SyncRowLabel {
  return {
    label: repeatLabel(row, look),
    cols: REPEAT_COLS,
    fmt: (col, v) => {
      switch (col) {
        case "skipped_days":
          return skippedDaysText(v);
        case "kind":
          return typeof v === "string" && Object.prototype.hasOwnProperty.call(KIND_WORD, v) ? KIND_WORD[v] : null;
        case "account_id":
        case "to_account_id":
          if (v === null || v === undefined) return "（沒有）";
          return typeof v === "string" ? (look.accountName(v) ?? "已刪除的帳戶") : null;
        case "category_id":
          if (v === null || v === undefined) return "未分類";
          return typeof v === "string" ? (look.categoryName(v) ?? "已刪除的分類") : null;
        case "next_on":
          return v === null || v === undefined ? "沒有下一班" : md(v);
        case "paused_at":
          return v === null || v === undefined ? "進行中" : "暫停";
        default:
          return null;
      }
    },
  };
}
