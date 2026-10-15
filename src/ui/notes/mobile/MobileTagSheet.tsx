/**
 * MobileTagSheet——手機荷札頁的三種底部 sheet（旅客筆記車次③契約 §5.5；D-筆-41：流程與文案同桌機，確認走底部 sheet）。
 *
 *   `MobileTagActionSheet`  頁首 ⋯：標題「#名稱」＋「改名」「併入…」「刪除」（danger）＋「取消」
 *   `MobileTagConfirmSheet` 確認：拉柄、h3、說明、**主鈕在上**（「併入」／「刪除」danger）、下「取消」
 *   `MobileTagMergeSheet`   併入挑選：「把 #○○ 併入…」＋搜尋（不用打 #）＋建議列（排除自己與子孫、列虛資料夾、不給建立）
 *
 * 都以 portal 掛到 body（理由同 MobileDatePicker 檔頭：從 `.m-page` 的疊放脈絡裡開，fixed 暗幕蓋不過 tab bar）；
 * 暗幕＝`.ns-notes-mveil.is-top`（z 48，Toast 50 在上：做完的「復原」按得到）、面板＝`.ns-notes-msheet`（捕捉面板同一張紙）。
 * 點暗幕＝取消。文案全在 domain/tags（`mergeConfirmText`／`deleteConfirmText`）——這裡只畫。
 */
import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { isUnder } from "../../../domain/tags";
import { useTagStore } from "../../../store/tagStore";
import { IconSearch } from "./mobileDiaryBits";
import { TagGlyph, TagName } from "./mobileTagBits";

function Veil({ onClose, children }: { onClose(): void; children: ReactNode }) {
  return createPortal(
    <div
      className="ns-notes-mveil is-top"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

/* ═══ ⋯ 動作 ═══ */

export interface TagActionItem {
  label: string;
  danger?: boolean;
  onClick(): void;
}

export function MobileTagActionSheet({ title, items, onClose }: { title: string; items: TagActionItem[]; onClose(): void }) {
  return (
    <Veil onClose={onClose}>
      <div className="ns-notes-msheet ns-notes-mtagsheet" role="dialog" aria-modal="true" aria-label={title}>
        <p className="ttl">{title}</p>
        {items.map((it) => (
          <button key={it.label} type="button" className={"item" + (it.danger ? " danger" : "")} onClick={it.onClick}>
            {it.label}
          </button>
        ))}
        <button type="button" className="item cancel" onClick={onClose}>
          取消
        </button>
      </div>
    </Veil>
  );
}

/* ═══ 確認 ═══ */

export interface MobileTagConfirmSheetProps {
  title: string;
  body: string;
  /** 主鈕字（「併入」／「刪除」） */
  primary: string;
  danger?: boolean;
  onConfirm(): void;
  onCancel(): void;
}

export function MobileTagConfirmSheet({ title, body, primary, danger, onConfirm, onCancel }: MobileTagConfirmSheetProps) {
  const busy = useRef(false);
  return (
    <Veil onClose={onCancel}>
      <div className="ns-notes-msheet ns-notes-mconfirm" role="alertdialog" aria-modal="true" aria-label={title}>
        <div className="ns-notes-grip" aria-hidden />
        <h3>{title}</h3>
        <p>{body}</p>
        <div className="btns">
          <button
            type="button"
            className={"ns-notes-mbtn primary" + (danger ? " danger" : "")}
            onClick={() => {
              if (busy.current) return;
              busy.current = true;
              onConfirm();
            }}
          >
            {primary}
          </button>
          <button type="button" className="ns-notes-mbtn" onClick={onCancel}>
            取消
          </button>
        </div>
      </div>
    </Veil>
  );
}

/* ═══ 併入挑選 ═══ */

export function MobileTagMergeSheet({ fromKey, onPick, onClose }: { fromKey: string; onPick(targetKey: string): void; onClose(): void }) {
  const index = useTagStore((s) => s.index);
  const suggest = useTagStore((s) => s.suggest);
  const nameOf = useTagStore((s) => s.nameOf);
  const [q, setQ] = useState("");
  const composing = useRef(false);
  const exclude = useMemo(() => (index ? Object.keys(index.byKey).filter((k) => isUnder(k, fromKey)) : [fromKey]), [index, fromKey]);
  const res = useMemo(() => suggest(q, { exclude, includeVirtual: true, limit: 10 }), [suggest, q, exclude]);

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter" || e.nativeEvent.isComposing || e.keyCode === 229 || composing.current) return;
    e.preventDefault();
    if (res.items[0]) onPick(res.items[0].key);
  };

  return (
    <Veil onClose={onClose}>
      <div className="ns-notes-msheet ns-notes-mtagsheet is-merge" role="dialog" aria-modal="true" aria-label="併入">
        <div className="ns-notes-grip" aria-hidden />
        <p className="ns-notes-mmergelabel">把 #{nameOf(fromKey)} 併入…</p>
        <label className="ns-notes-mpksearch">
          <IconSearch />
          <input
            className="ns-notes-minput"
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            placeholder="挑一個既有的荷札"
            aria-label="挑一個既有的荷札"
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="done"
          />
        </label>
        <div className="ns-notes-mmergelist">
          {res.browse && <p className="ns-notes-mpkhint head">#{nameOf(res.browse)} 底下</p>}
          {res.items.map((it) => (
            <button key={it.key} type="button" className={"ns-notes-mpkrow" + (it.real ? "" : " virtual")} onClick={() => onPick(it.key)}>
              <TagGlyph real={it.real} />
              <span className="nm">
                <TagName name={it.name} hl={it.hl} />
              </span>
              <span className="n">{it.real ? `${it.count} 處` : "虛資料夾"}</span>
            </button>
          ))}
          {!res.items.length && <p className="ns-notes-mpkhint">{res.browse && res.hint ? res.hint : "沒有對到的荷札"}</p>}
        </div>
        <button type="button" className="ns-notes-mbtn wide" onClick={onClose}>
          取消
        </button>
      </div>
    </Veil>
  );
}
