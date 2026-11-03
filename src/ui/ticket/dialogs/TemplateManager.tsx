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
import { useTicketStore } from "../../../store/ticketStore";
import { useNodeStore } from "../../../store/nodeStore";
import type { TemplateRow } from "../../../domain/ticket";
import { ManagerList, ManagerRow, type PopMenuItem } from "../../common/ManagerRow";
import { indexOfAnchor, useDragReorder } from "../../common/dragReorder";
import { templateWhat } from "./templateText";
import "../ticket-4.css";

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
  const renameTemplate = useTicketStore((s) => s.renameTemplate);
  const moveTemplateTo = useTicketStore((s) => s.moveTemplateTo);
  const routes = useNodeStore((s) => s.routes);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const ctx = { accounts, accById, catById, curByCode, routes };

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
                note={templateWhat(t, ctx, [], true)}
                onUp={i > 0 ? () => void moveTemplateTo(t.id, i - 1) : undefined}
                onDown={i < templates.length - 1 ? () => void moveTemplateTo(t.id, i + 1) : undefined}
                menu={templateMenu(t, true)}
              />
            ))}
          </ManagerList>
          <p className="ns-tk-dhint">記一筆時排在最上面，照這裡的順序。</p>
        </>
      )}
    </div>
  );
}
