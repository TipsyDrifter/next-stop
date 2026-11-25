/**
 * MobileSaveTemplateSheet——手機「這一筆」底部「存成常用…」的取名面板（D-票-68；手機席；原型 5-mobile-存成常用）。
 * 宿主＝MobileSheetHost（`dialog.kind === "saveTemplate"`）。管帳「常用票種」那張用兩殼共用的 dialogs/TemplateManager（同帳戶順序、分類管理）。
 *
 * 名稱一欄＋一行「點一下就帶入：支出 129 · 現金 · 食物 › 午餐 · 備註「…」」，黏底「取消｜存」（桌機是大票底部的小浮層，手機改底部面板）。
 * 字與名稱預設跟桌機同一份（dialogs/templateText 的 `entryWhat`／`defaultTemplateName`：備註第一段 →「麥當勞」，沒備註用分類名）。
 * 存的是**已存好的那一筆**（表單裡還沒按「存」的改動不算）；存好 store 自己關這張、toast「已存成常用「X」」。
 */
import { useState } from "react";
import { isTicketAmountMasked, useTicketStore } from "../../../store/ticketStore";
import { useNodeStore } from "../../../store/nodeStore";
import { useTagStore } from "../../../store/tagStore";
import { MSheet } from "../../common/MSheet";
import {
  UNCAT_EXPENSE_ID,
  UNCAT_INCOME_ID,
  categoryLabel,
  currencySymbol,
  mainCurrencyOf,
  maskedMoneyText,
  moneyText,
  type EntryRow,
} from "../../../domain/ticket";
import { TK_TAG_ENTRY, tagNamesOf } from "../../../domain/ticketTags";
import { defaultTemplateName } from "../dialogs/templateText";
import { acctLabel } from "../TicketLedger";
import { useImeGuard } from "./mobileBits";

const KIND_WORD: Record<"expense" | "income" | "transfer", string> = { expense: "支出", income: "收入", transfer: "轉帳" };
const isUncat = (id: string | null): boolean => id === UNCAT_INCOME_ID || id === UNCAT_EXPENSE_ID;

/* ═══════════ 這一筆 → 存成常用… ═══════════ */

export function MobileSaveTemplateSheet({ entryId, backKind, onClose }: { entryId: string; backKind: "sheet" | "dialog"; onClose(): void }) {
  const entry = useTicketStore((s) => s.entries.find((e) => e.id === entryId) ?? (s.results ? s.results.find((e) => e.id === entryId) : undefined) ?? null);
  const accounts = useTicketStore((s) => s.accounts);
  const accById = useTicketStore((s) => s.accById);
  const catById = useTicketStore((s) => s.catById);
  const curByCode = useTicketStore((s) => s.curByCode);
  const masked = useTicketStore(isTicketAmountMasked);
  const saveTemplateFromEntry = useTicketStore((s) => s.saveTemplateFromEntry);
  const routes = useNodeStore((s) => s.routes);
  const tagIndex = useTagStore((s) => s.index);
  const [name, setName] = useState(() => {
    if (!entry) return "";
    const firstItem = (entry.item ?? "").trim().split(/\s+/)[0] ?? "";
    return firstItem ? firstItem.slice(0, 16) : defaultTemplateName(entry, catById);
  });
  const [busy, setBusy] = useState(false);
  const v = name.trim();
  const save = async () => {
    if (busy || v === "") return;
    setBusy(true);
    try {
      await saveTemplateFromEntry(entryId, v); // 成功 store 自己關這張；失敗 toast、留著讓主人改
    } finally {
      setBusy(false);
    }
  };
  const ime = useImeGuard((e) => {
    e.preventDefault();
    void save();
  });

  /* 「點一下就帶入：…」（包含品項／隨筆與手續費，並尊重金額隱私遮罩） */
  const what = entry ? `點一下就帶入：${buildTemplatePreview(entry, { accounts, accById, catById, curByCode, routes, tags: tagNamesOf(tagIndex, TK_TAG_ENTRY, entry.id), masked })}` : "";

  return (
    <MSheet
      title="存成常用"
      onClose={onClose}
      backId="ticket.dialog"
      backKind={backKind}
      className="ns-tk-msh is-dialog is-saveTemplate"
      foot={
        <>
          <button type="button" className="ns-btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button type="button" className="ns-btn btn-seal" disabled={busy || v === "" || !entry} onClick={() => void save()}>
            存
          </button>
        </>
      }
    >
      <div className="ns-tk-m4-savetpl">
        <label className="ns-tk-mf-field">
          <span className="lbl">名稱</span>
          <input
            className="ns-tk-mw-in"
            value={name}
            placeholder="小卡上的名字"
            aria-label="名稱"
            autoFocus
            autoComplete="off"
            enterKeyHint="done"
            onChange={(e) => setName(e.target.value)}
            {...ime}
          />
        </label>
        {what && <p className="ns-tk-mre-from">{what}</p>}
      </div>
    </MSheet>
  );
}

function buildTemplatePreview(
  e: EntryRow,
  ctx: {
    accounts: ReturnType<typeof useTicketStore.getState>["accounts"];
    accById: ReturnType<typeof useTicketStore.getState>["accById"];
    catById: ReturnType<typeof useTicketStore.getState>["catById"];
    curByCode: ReturnType<typeof useTicketStore.getState>["curByCode"];
    routes: ReturnType<typeof useNodeStore.getState>["routes"];
    tags: readonly string[];
    masked: boolean;
  },
): string {
  const parts: string[] = [];
  const kind = e.kind === "adjust" ? "expense" : e.kind;
  const mainCode = mainCurrencyOf(Object.values(ctx.curByCode));
  const acc = ctx.accById[e.account_id];
  const cur = e.currency ?? acc?.currency ?? mainCode;
  const dec = ctx.curByCode[cur]?.decimals ?? 2;
  const amtStr = ctx.masked ? maskedMoneyText(cur, { withSymbol: false }) : moneyText(Math.abs(e.amount_minor), dec);
  parts.push(`${KIND_WORD[kind]} ${amtStr}${!ctx.masked && cur !== mainCode ? ` ${cur}` : ""}`);
  if (e.fee_minor && e.fee_minor > 0) {
    const feeCur = acc?.currency ?? cur;
    const feeDec = ctx.curByCode[feeCur]?.decimals ?? 2;
    const feeStr = ctx.masked ? maskedMoneyText(feeCur) : `${currencySymbol(feeCur)} ${moneyText(e.fee_minor, feeDec)}`;
    parts.push(`含手續費 ${feeStr}`);
  }
  if (acc && acc.deleted_at === null) {
    const to = kind === "transfer" && e.to_account_id ? ctx.accById[e.to_account_id] : undefined;
    parts.push(to ? `${acctLabel(acc, ctx.accounts)} → ${acctLabel(to, ctx.accounts)}` : acctLabel(acc, ctx.accounts));
  }
  const cat = e.category_id && !isUncat(e.category_id) ? ctx.catById[e.category_id] : undefined;
  if (cat && kind !== "transfer") parts.push(categoryLabel(cat, ctx.catById));
  if ((e.item ?? "").trim()) parts.push(`品項「${e.item.trim()}」`);
  if (e.note.trim()) parts.push(`隨筆「${e.note.trim()}」`);
  const route = e.route_id ? ctx.routes.find((r) => r.id === e.route_id && r.deleted_at === null) : undefined;
  if (route) parts.push(`路線 ${route.name}`);
  if (ctx.tags.length) parts.push(ctx.tags.map((t) => `#${t}`).join(" "));
  return parts.join(" · ");
}
