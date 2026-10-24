/**
 * 售票口手機頁的共用小件（車次①契約 §5.3；丙席）。MobileTicketOffice／MobileEntryForm／MobileAccountPage／MobileSheetHost 共用，
 * 拆成獨立檔只為了避開元件之間的循環 import；不給桌機用（桌機的小件在 parts/，乙席）。
 *
 * - 圖示：同原型 app.js 的 16 viewBox／1.3 筆觸／圓頭
 * - UI 丙-5 H4：舊的底部面板 `MSheet`（`.m-sheet-veil`／`.m-sheet.ns-tk-msheet` 骨架）退役——售票口手機的 sheet 一律用共用
 *   `common/MSheet`（拉柄、襯線標題、返回層自登記）。合計帶的滑桿「管理」鈕（D-票-24）同班退役，IconSliders 跟著刪。
 * - `nextDraft`：舊票編輯的本地草稿規則，與 store 的 `setDraft` 逐條同義（新票直接用 store 的）
 * - `useImeGuard`：IME 守門（本體在 dialogs/dialogBits.ts，這裡轉出）
 */
import type { ReactNode } from "react";
import { ACCOUNT_GROUPS, type AccountRow, type CategoryRow, type EntryDraft } from "../../../domain/ticket";

/* ───────── 圖示 ───────── */

function Svg({ size, children }: { size: number; children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** 篩選（漏斗；UI 丙-5 H2：分頁籤列下一列的「篩選」chip。同 prototypes/ui-c5 的 i-filter） */
export const IconFilter = ({ size = 14 }: { size?: number }) => (
  <Svg size={size}>
    <path d="M2.6 3.4h10.8L9.2 8.4v4.4l-2.4-1.2V8.4z" />
  </Svg>
);
export const IconPlus = ({ size = 13 }: { size?: number }) => (
  <Svg size={size}>
    <path d="M8 3.2v9.6M3.2 8h9.6" />
  </Svg>
);
export const IconLeft = ({ size = 16 }: { size?: number }) => (
  <Svg size={size}>
    <path d="M10 3.5 5.5 8l4.5 4.5" />
  </Svg>
);
export const IconRight = ({ size = 16 }: { size?: number }) => (
  <Svg size={size}>
    <path d="M6 3.5 10.5 8 6 12.5" />
  </Svg>
);
export const IconCaret = ({ size = 12 }: { size?: number }) => (
  <Svg size={size}>
    <path d="M4 6l4 4 4-4" />
  </Svg>
);

/* ───────── 草稿規則（舊票編輯用；與 ticketStore.setDraft 同義） ───────── */

export function nextDraft(
  prev: EntryDraft,
  patch: Partial<EntryDraft>,
  accById: Readonly<Record<string, AccountRow>>,
  catById: Readonly<Record<string, CategoryRow>>,
): EntryDraft {
  const d: EntryDraft = { ...prev, ...patch };
  const acc = d.accountId ? accById[d.accountId] : undefined;
  if (d.kind === "transfer") {
    d.categoryId = null;
    if (acc) d.currency = acc.currency;
  } else {
    d.toAccountId = null;
    d.toAmountText = null;
    if (patch.accountId !== undefined && patch.currency === undefined && acc) d.currency = acc.currency;
    const cat = d.categoryId ? catById[d.categoryId] : undefined;
    if (cat && cat.kind !== d.kind) d.categoryId = null;
  }
  if (patch.currency !== undefined && patch.currency !== prev.currency) d.mainOverrideText = patch.mainOverrideText ?? null;
  return d;
}

/* IME 守門：本體在 dialogs/dialogBits.ts（兩殼共用的對話框本體也要用），這裡轉出 */
export { useImeGuard } from "../dialogs/dialogBits";

/* ───────── 雜項 ───────── */

/** 帳戶群組名（不認得的 group_key 當「其他」） */
export function groupLabelOf(groupKey: string): string {
  return (ACCOUNT_GROUPS.find((g) => g.key === groupKey) ?? ACCOUNT_GROUPS[ACCOUNT_GROUPS.length - 1]).label;
}

/** "10/8 週四" → ["10/8", "週四"] */
export function splitDayLabel(label: string): [string, string] {
  const i = label.indexOf(" ");
  return i < 0 ? [label, ""] : [label.slice(0, i), label.slice(i + 1)];
}
