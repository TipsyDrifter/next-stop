/**
 * MobileSaveTemplateSheet——手機「這一筆」底部「存成常用…」的取名面板（D-票-68；手機席；原型 5-mobile-存成常用）。
 * 宿主＝MobileSheetHost（`dialog.kind === "saveTemplate"`）。管帳「常用票種」那張用兩殼共用的 dialogs/TemplateManager（同帳戶順序、分類管理）。
 *
 * 名稱一欄＋一行「點一下就帶入：支出 129 · 現金 · 食物 › 午餐 · 備註「…」」，黏底「取消｜存」（桌機是大票底部的小浮層，手機改底部面板）。
 * 字與名稱預設跟桌機同一份（dialogs/templateText 的 `entryWhat`／`defaultTemplateName`：備註第一段 →「麥當勞」，沒備註用分類名）。
 * 存的是**已存好的那一筆**（表單裡還沒按「存」的改動不算）；存好 store 自己關這張、toast「已存成常用「X」」。
 */
import { useState } from "react";
import { useTicketStore } from "../../../store/ticketStore";
import { useNodeStore } from "../../../store/nodeStore";
import { useTagStore } from "../../../store/tagStore";
import { MSheet } from "../../common/MSheet";
import { TK_TAG_ENTRY, tagNamesOf } from "../../../domain/ticketTags";
import { defaultTemplateName, entryWhat } from "../dialogs/templateText";
import { useImeGuard } from "./mobileBits";

/* ═══════════ 這一筆 → 存成常用… ═══════════ */

export function MobileSaveTemplateSheet({ entryId, backKind, onClose }: { entryId: string; backKind: "sheet" | "dialog"; onClose(): void }) {
  const entry = useTicketStore((s) => s.entries.find((e) => e.id === entryId) ?? (s.results ? s.results.find((e) => e.id === entryId) : undefined) ?? null);
  const accounts = useTicketStore((s) => s.accounts);
  const accById = useTicketStore((s) => s.accById);
  const catById = useTicketStore((s) => s.catById);
  const curByCode = useTicketStore((s) => s.curByCode);
  const saveTemplateFromEntry = useTicketStore((s) => s.saveTemplateFromEntry);
  const routes = useNodeStore((s) => s.routes);
  const tagIndex = useTagStore((s) => s.index);
  const [name, setName] = useState(() => (entry ? defaultTemplateName(entry, catById) : ""));
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

  /* 「點一下就帶入：…」（帶的是已存好的那一筆，荷札也一起） */
  const what = entry ? `點一下就帶入：${entryWhat(entry, { accounts, accById, catById, curByCode, routes }, tagNamesOf(tagIndex, TK_TAG_ENTRY, entry.id))}` : "";

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
