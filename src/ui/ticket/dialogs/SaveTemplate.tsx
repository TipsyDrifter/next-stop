/**
 * SaveTemplate——「存成常用…」（售票口④ D-票-68；桌機席）。原型 5-desktop-存成常用：
 *   帳目詳情底部「存成常用…」→ 大票底部浮起一張小卡 `.ns-tk-pop.ns-tk-savemark`：
 *   小標「存成常用」・名稱欄（預設＝備註第一段字）・一行淡字「點一下就帶入：支出 129 · 現金 · …」・取消／存。
 * 存＝store.saveTemplateFromEntry（整筆照抄＋荷札；toast「已存成常用「X」」）；之後記一筆最上面那排小卡就有它。
 *
 * 匯出三個：`SaveTemplateForm`（本體）、`SaveTemplatePop`（大票底部的小浮層，桌機一般走這條）、
 *   `SaveTemplateDialog`（store.dialog＝saveTemplate 時 DesktopDialogHost 包的本體；別處用 openDialog 開的也接得住）。
 * 鍵盤：名稱欄 Enter＝存（組字中不算）、Esc＝取消（不漏給大票，免得連側板一起收）；浮層裡任何地方按 Esc 都收。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTicketStore } from "../../../store/ticketStore";
import { useNodeStore } from "../../../store/nodeStore";
import { useTagStore } from "../../../store/tagStore";
import type { EntryRow } from "../../../domain/ticket";
import { TK_TAG_ENTRY, tagNamesOf } from "../../../domain/ticketTags";
import { defaultTemplateName, entryWhat } from "./templateText";
import { useImeGuard } from "./dialogBits";
import "../ticket-4.css";

export function SaveTemplateForm({ entry, onDone, autoFocus = true }: { entry: EntryRow; onDone(): void; autoFocus?: boolean }) {
  const accounts = useTicketStore((s) => s.accounts);
  const accById = useTicketStore((s) => s.accById);
  const catById = useTicketStore((s) => s.catById);
  const curByCode = useTicketStore((s) => s.curByCode);
  const routes = useNodeStore((s) => s.routes);
  const index = useTagStore((s) => s.index);
  const [name, setName] = useState(() => defaultTemplateName(entry, catById));
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!autoFocus) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [autoFocus]);

  const save = async () => {
    if (busy || !name.trim()) return;
    setBusy(true);
    try {
      const row = await useTicketStore.getState().saveTemplateFromEntry(entry.id, name.trim());
      if (row) onDone();
    } finally {
      setBusy(false);
    }
  };
  const ime = useImeGuard((e) => {
    e.preventDefault();
    e.stopPropagation();
    void save();
  });
  const what = entryWhat(entry, { accounts, accById, catById, curByCode, routes }, tagNamesOf(index, TK_TAG_ENTRY, entry.id));

  return (
    <div className="ns-tk-savemark-body" onCompositionStart={ime.onCompositionStart} onCompositionEnd={ime.onCompositionEnd}>
      <label>
        名稱
        <input
          ref={inputRef}
          className="ns-tk-textin"
          value={name}
          maxLength={40}
          autoComplete="off"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && !(e.nativeEvent.isComposing || e.keyCode === 229)) {
              e.preventDefault();
              e.stopPropagation();
              onDone();
              return;
            }
            ime.onKeyDown(e);
          }}
        />
      </label>
      <p className="what">點一下就帶入：{what}</p>
      <div className="btns">
        <button type="button" className="ns-btn ns-btn--sm btn-ghost" onClick={onDone}>
          取消
        </button>
        <button type="button" className="ns-btn ns-btn--sm btn-seal" disabled={busy || !name.trim()} onClick={() => void save()}>
          存
        </button>
      </div>
    </div>
  );
}

/** 大票底部的小浮層：點外面（開關鈕除外）＝取消 */
export function SaveTemplatePop({ entry, onClose }: { entry: EntryRow; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target;
      if (!(t instanceof Node) || ref.current?.contains(t)) return;
      if (t instanceof Element && t.closest("[data-pop-toggle]")) return;
      close.current();
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, []);
  return (
    <div
      ref={ref}
      className="ns-tk-pop ns-tk-savemark"
      role="dialog"
      aria-label="存成常用"
      onKeyDown={(e) => {
        // 焦點在「取消／存」上按 Esc 也收（名稱欄自己接；頁根鍵盤表對 .ns-tk-pop 讓路，不接就什麼都不發生）
        if (e.key !== "Escape" || e.defaultPrevented) return;
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
    >
      <div className="hd">存成常用</div>
      <SaveTemplateForm entry={entry} onDone={onClose} />
    </div>
  );
}

/** dialog kind「saveTemplate」的本體（標題由宿主給）；那筆帳已經不在 ⇒ 一行說明 */
export function SaveTemplateDialog({ onDone }: { onDone(): void }): ReactNode {
  const dialog = useTicketStore((s) => s.dialog);
  const entryId = dialog?.kind === "saveTemplate" ? dialog.entryId : null;
  const entry = useTicketStore((s) => (entryId ? (s.entries.find((e) => e.id === entryId) ?? s.results?.find((e) => e.id === entryId)) : undefined));
  if (!entry || entry.kind === "adjust") {
    return <p className="ns-tk-dhint">{entry ? "精算不能存成常用票種" : "這一筆已經不在了"}</p>;
  }
  return (
    <div className="ns-tk-dialog ns-tk-savemark is-dialog">
      <SaveTemplateForm entry={entry} onDone={onDone} />
    </div>
  );
}
