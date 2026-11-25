/**
 * TicketManagePanel——售票口「管帳」多分頁統合管理面板（v1.32 2B-1a；結構對齊時刻表 CategoryManagerPanel）。
 *
 * 頂部掛共用 `<Tabs>`（分類｜帳戶｜預算｜定期｜常用票種｜幣別）：
 *   - 桌機包在 `DialogShell size="L"`，`<Tabs size="md" />`；
 *   - 手機包在 `MSheet height="full"`，`<Tabs scroll />`。
 * 當前分籤直接讀寫 `ticketStore.dialog`（`{ kind: "manage", tab }`），
 * 讓 `navHistoryStore` 自動記錄視窗內切籤歷史（Alt+←／滑鼠側鍵可逐籤退回再收起視窗）。
 */
import { useEffect, useId, useRef } from "react";
import {
  TICKET_MANAGE_TABS,
  isTicketManageTab,
  useTicketStore,
  type TicketDialog,
  type TicketManageTab,
} from "../../../store/ticketStore";
import { Tabs } from "../../common/Tabs";
import { IconChevron } from "../../common/icons";
import { CategoryManager } from "./CategoryManager";
import { AccountOrder } from "./AccountOrder";
import { CurrencyTable } from "./CurrencyTable";
import { TemplateManager } from "./TemplateManager";
import { BudgetEditor } from "../plan/BudgetEditor";
import { RepeatManager } from "../plan/RepeatManager";
import { MobileBudgetSheet } from "../mobile/plan/MobileBudgetSheet";
import { MobileRepeatSheet } from "../mobile/plan/MobileRepeatSheet";
import "../ticket-v138.css";

function tabOfDialog(dialog: TicketDialog | null): TicketManageTab {
  if (!dialog) return "categories";
  if (dialog.kind === "manage") return dialog.tab ?? "categories";
  if (isTicketManageTab(dialog.kind)) return dialog.kind;
  return "categories";
}

export interface TicketManagePanelProps {
  shell: "desktop" | "mobile";
  onDone(): void;
}

export function TicketManagePanel({ shell, onDone }: TicketManagePanelProps) {
  const tab = useTicketStore((s) => tabOfDialog(s.dialog));
  const openDialog = useTicketStore((s) => s.openDialog);
  const tabsId = useId();
  const panelId = (k: TicketManageTab): string => `${tabsId}-panel-${k}`;
  const tabsRef = useRef<HTMLDivElement>(null);

  // 開窗時焦點落在目前的選中籤（等 DialogShell／MSheet 先完成初始焦點配置）
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      tabsRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(id);
  }, []);

  const current = TICKET_MANAGE_TABS.find((t) => t.key === tab) ?? TICKET_MANAGE_TABS[0];

  return (
    <div className="ns-tk-mgr">
      <div ref={tabsRef} className="ns-tk-mgr-tabs">
        <Tabs
          items={TICKET_MANAGE_TABS}
          value={tab}
          onChange={(next) => openDialog({ kind: "manage", tab: next })}
          size={shell === "desktop" ? "md" : undefined}
          scroll={shell === "mobile"}
          aria-label="管帳分頁"
          getPanelId={panelId}
        />
      </div>
      <button
        type="button"
        className="tk-v38-mgr-split"
        onClick={() => openDialog({ kind: "legacySplit" })}
      >
        <span className="tk-v38-mgr-split-txt">
          <b>舊帳隨筆分流小幫手</b>
          <small>整理升級前的長句舊帳，讓品項補完更乾淨</small>
        </span>
        <span className="tk-v38-mgr-split-go" aria-hidden="true">
          前往整理
          <IconChevron size={13} />
        </span>
      </button>
      <div role="tabpanel" id={panelId(tab)} aria-label={current.label} className="ns-tk-mgr-tabpanel">
        {tab === "categories" && <CategoryManager onDone={onDone} />}
        {tab === "accountOrder" && <AccountOrder onDone={onDone} />}
        {tab === "budgets" && (shell === "mobile" ? <MobileBudgetSheet onDone={onDone} /> : <BudgetEditor onDone={onDone} />)}
        {tab === "repeats" && (shell === "mobile" ? <MobileRepeatSheet onDone={onDone} /> : <RepeatManager onDone={onDone} />)}
        {tab === "templates" && <TemplateManager onDone={onDone} />}
        {tab === "currencies" && <CurrencyTable onDone={onDone} />}
      </div>
    </div>
  );
}
