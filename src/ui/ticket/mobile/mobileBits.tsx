/**
 * 售票口手機頁的共用小件（車次①契約 §5.3；丙席）。MobileTicketOffice／MobileEntryForm／MobileAccountPage／MobileSheetHost 共用，
 * 拆成獨立檔只為了避開元件之間的循環 import；不給桌機用（桌機的小件在 parts/，乙席）。
 *
 * - 圖示：同原型 app.js 的 16 viewBox／1.3 筆觸／圓頭（管理鈕＝滑桿，D-票-24）
 * - `MSheet`：底部面板（沿 mobile.css 的 `.m-sheet-veil`／`.m-sheet` 骨架），portal 到 body——從 `.m-page`（z-index 1 的
 *   疊放脈絡）裡開的面板不搬出去，再高的 z-index 也蓋不過 tab bar（同 MobileDatePicker 檔頭的理由）
 * - `nextDraft`：舊票編輯的本地草稿規則，與 store 的 `setDraft` 逐條同義（新票直接用 store 的）
 * - `useImeGuard`：IME 守門（本體在 dialogs/dialogBits.ts，這裡轉出）
 */
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
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

/** 管理（滑桿；D-票-24） */
export const IconSliders = ({ size = 18 }: { size?: number }) => (
  <Svg size={size}>
    <path d="M2.4 3.4h6.4M11.6 3.4h2" />
    <circle cx="10.2" cy="3.4" r="1.4" />
    <path d="M2.4 8h1.6M6.8 8h6.8" />
    <circle cx="5.4" cy="8" r="1.4" />
    <path d="M2.4 12.6h7.6M12.8 12.6h.8" />
    <circle cx="11.4" cy="12.6" r="1.4" />
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

/* ───────── 底部面板 ───────── */

/**
 * 底部面板。`over`＝疊在全螢幕表單（z 46）之上的那一層（z 47）；一般的（管理、對話框本體）走 mobile.css 的 45。
 * 暗幕點哪都關（`dismissable` 為 false 時不關——匯入寫入中）；「取消／完成」那一格由呼叫端放在 children 裡。
 */
export function MSheet({
  title,
  onClose,
  children,
  over = false,
  dismissable = true,
  className,
}: {
  title: string;
  onClose(): void;
  children: ReactNode;
  over?: boolean;
  dismissable?: boolean;
  className?: string;
}) {
  return createPortal(
    <div
      className={"m-sheet-veil techo-veil ns-tk-mveil" + (over ? " is-over" : "")}
      role="presentation"
      onClick={() => {
        if (dismissable) onClose();
      }}
    >
      <div
        className={"m-sheet ns-card ns-tk-msheet" + (className ? " " + className : "")}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ns-tk-msheet-grip" aria-hidden />
        <p className="m-sheet-title">{title}</p>
        <div className="ns-tk-msheet-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

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
