/**
 * TemplateManager——管帳「常用票種…」對話框本體（售票口④ D-票-68；桌機席）。props `{ onDone(): void }`；標題由宿主給。
 *
 * 一張 ManagerList（同分類管理、時刻表分類的列）：每列＝名稱（行內改名，失焦／Enter 送）・淡字「支出 120 · 學生證」・↑↓・⋯；
 * 拖曳排序（共用 dragReorder：放開對最新清單換算 indexOfAnchor → moveTemplateTo）；↑↓ 與 Alt+↑↓ 照留（ManagerRow 內建）。
 * ⋯／右鍵＝`templateMenu`：帶入記一筆、刪除（toast 可復原）。記一筆最上面那排小卡的右鍵用同一支（多一項「改名、排序…」開這裡）。
 * 即時存 ⇒ 沒有「完成」鈕（同分類管理）。沒有常用票種時一行說明去哪裡存。
 * 新增只從帳目詳情「存成常用…」（整筆照抄最省事）；這裡不另做一張空白表單。
 */
import { useState } from "react";
import { isTicketAmountMasked, useTicketStore } from "../../../store/ticketStore";
import { useNodeStore } from "../../../store/nodeStore";
import {
  UNCAT_EXPENSE_ID,
  UNCAT_INCOME_ID,
  categoryLabel,
  mainCurrencyOf,
  maskedMoneyText,
  moneyText,
  type TemplateRow,
} from "../../../domain/ticket";
import { ManagerList, ManagerRow, type PopMenuItem } from "../../common/ManagerRow";
import { indexOfAnchor, useDragReorder } from "../../common/dragReorder";
import { acctLabel } from "../TicketLedger";
import { templateWhat, type WhatCtx } from "./templateText";
import "../ticket-4.css";
import "../ticket-v138.css";

const KIND_WORD: Record<TemplateRow["kind"], string> = { expense: "支出", income: "收入", transfer: "轉帳" };
const isUncat = (id: string | null): boolean => id === UNCAT_INCOME_ID || id === UNCAT_EXPENSE_ID;

function TemplateDetail({ t, ctx, masked }: { t: TemplateRow; ctx: WhatCtx; masked: boolean }) {
  const mainCode = mainCurrencyOf(Object.values(ctx.curByCode));
  const acc = t.account_id ? ctx.accById[t.account_id] : undefined;
  const toAcc = t.kind === "transfer" && t.to_account_id ? ctx.accById[t.to_account_id] : undefined;
  const cur = t.currency ?? acc?.currency ?? mainCode;
  const dec = ctx.curByCode[cur]?.decimals ?? 2;
  const amountText =
    t.amount_minor === null
      ? "未固定（帶入時填寫）"
      : `${KIND_WORD[t.kind]} ${masked ? maskedMoneyText(cur, { withSymbol: false }) : moneyText(Math.abs(t.amount_minor), dec)}${cur !== mainCode ? ` ${cur}` : ""}`;

  const feeCurCode = acc?.currency ?? cur;
  const feeDec = ctx.curByCode[feeCurCode]?.decimals ?? dec;
  const feeText =
    t.fee_minor !== null && t.fee_minor > 0
      ? `${masked ? maskedMoneyText(feeCurCode, { withSymbol: false }) : moneyText(t.fee_minor, feeDec)}${feeCurCode !== mainCode ? ` ${feeCurCode}` : ""}`
      : null;

  const accountText =
    acc && acc.deleted_at === null
      ? toAcc && toAcc.deleted_at === null
        ? `${acctLabel(acc, ctx.accounts)} → ${acctLabel(toAcc, ctx.accounts)}`
        : acctLabel(acc, ctx.accounts)
      : null;

  const cat = t.kind !== "transfer" && t.category_id && !isUncat(t.category_id) ? ctx.catById[t.category_id] : undefined;
  const catText = cat ? categoryLabel(cat, ctx.catById) : null;
  const route = t.route_id ? ctx.routes.find((r) => r.id === t.route_id && r.deleted_at === null) : undefined;
  const itemText = (t.item ?? "").trim();
  const noteText = t.note.trim();

  const applyNow = () => {
    const s = useTicketStore.getState();
    s.closeDialog();
    void s.applyTemplate(t.id);
  };

  return (
    <div className="tk-v38-tpl-detail">
      <dl className="tk-v38-tpl-grid">
        <div className="tk-v38-tpl-item">
          <dt>類型金額</dt>
          <dd className={t.amount_minor === null ? "is-empty" : "is-num"}>{amountText}</dd>
        </div>
        <div className="tk-v38-tpl-item">
          <dt>手續費</dt>
          <dd className={feeText ? "is-num" : "is-empty"}>{feeText ?? "無"}</dd>
        </div>
        {accountText && (
          <div className="tk-v38-tpl-item">
            <dt>帳戶</dt>
            <dd title={accountText}>{accountText}</dd>
          </div>
        )}
        {catText && (
          <div className="tk-v38-tpl-item">
            <dt>分類</dt>
            <dd title={catText}>{catText}</dd>
          </div>
        )}
        <div className="tk-v38-tpl-item">
          <dt>品項／來源</dt>
          <dd className={itemText ? undefined : "is-empty"} title={itemText || undefined}>
            {itemText || "（未填）"}
          </dd>
        </div>
        <div className="tk-v38-tpl-item">
          <dt>隨筆備註</dt>
          <dd className={noteText ? undefined : "is-empty"} title={noteText || undefined}>
            {noteText || "（未填）"}
          </dd>
        </div>
        {route && (
          <div className="tk-v38-tpl-item is-wide">
            <dt>路線</dt>
            <dd title={route.name}>{route.name}</dd>
          </div>
        )}
      </dl>
      <div className="tk-v38-tpl-foot">
        <span>帶入後可調整金額、品項、隨筆或手續費</span>
        <button type="button" className="ns-btn ns-btn--sm btn-ghost" onClick={applyNow}>
          帶入記一筆
        </button>
      </div>
    </div>
  );
}

/** 一個常用票種的動作（⋯、右鍵）；inManager＝已經在這個對話框裡（不給「改名、排序…」，帶入時先關對話框） */
export function templateMenu(t: TemplateRow, inManager = false): PopMenuItem[] {
  const s = useTicketStore.getState();
  const items: PopMenuItem[] = [
    {
      key: "use",
      label: "帶入記一筆",
      onSelect: () => {
        if (inManager) s.closeDialog();
        void s.applyTemplate(t.id);
      },
    },
  ];
  if (!inManager) items.push({ key: "manage", label: "改名、排序…", onSelect: () => s.openDialog({ kind: "templates" }) });
  items.push({ key: "delete", label: "刪除", danger: true, cut: true, onSelect: () => void s.deleteTemplate(t.id) });
  return items;
}

export function TemplateManager(_props: { onDone(): void }) {
  const templates = useTicketStore((s) => s.templates);
  const accounts = useTicketStore((s) => s.accounts);
  const accById = useTicketStore((s) => s.accById);
  const catById = useTicketStore((s) => s.catById);
  const curByCode = useTicketStore((s) => s.curByCode);
  const masked = useTicketStore(isTicketAmountMasked);
  const renameTemplate = useTicketStore((s) => s.renameTemplate);
  const moveTemplateTo = useTicketStore((s) => s.moveTemplateTo);
  const routes = useNodeStore((s) => s.routes);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const ctx: WhatCtx = { accounts, accById, catById, curByCode, routes };

  useDragReorder({
    root,
    items: templates.map((t) => ({ id: t.id })),
    onDrop: (ids, place) => {
      if (place.kind !== "slot") return;
      const latest = useTicketStore.getState().templates.map((t) => t.id);
      const at = indexOfAnchor(latest, ids[0], place);
      if (at === null) return;
      void moveTemplateTo(ids[0], at);
    },
  });

  return (
    <div ref={setRoot} className="ns-tk-dialog ns-tk-dtpl">
      {templates.length === 0 ? (
        <p className="ns-tk-dhint">還沒有常用票種——在一筆帳的詳情按「存成常用…」就會出現在這裡。</p>
      ) : (
        <>
          <ManagerList label="常用票種" className="ns-tk-dtpllist">
            {templates.map((t, i) => (
              <ManagerRow
                key={t.id}
                dragId={t.id}
                dataId={t.id}
                name={t.name}
                onRename={(next) => renameTemplate(t.id, next)}
                note={templateWhat(t, ctx, [], true, masked)}
                detail={<TemplateDetail t={t} ctx={ctx} masked={masked} />}
                onUp={i > 0 ? () => void moveTemplateTo(t.id, i - 1) : undefined}
                onDown={i < templates.length - 1 ? () => void moveTemplateTo(t.id, i + 1) : undefined}
                menu={templateMenu(t, true)}
              />
            ))}
          </ManagerList>
          <p className="ns-tk-dhint">記一筆時排在最上面，照這裡的順序；展開齒輪可檢視品項、隨筆與手續費。</p>
        </>
      )}
    </div>
  );
}
