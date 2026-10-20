/**
 * MobileTagToolbar——手機筆記／日記整頁編輯中，貼在 `.m-page` 底的一條工具列（旅客筆記車次③契約 §5.5、7.2-6）。
 * 同檔另有 `MobileTagSuggest`：游標處打 `#` 時的建議清單（工具列上方；捕捉面板也用它，貼在打字框下）。
 *
 * 工具列：第一顆「#」（44px）＝開點選器的插入模式（`tagStore.openPicker({ mode:"insert", onInsert })`），
 *   選好的荷札插在**按下時的游標處**；最右「完成」＝離開編輯（手機沒有 Esc，與點外面同一條路）。
 *   `position: sticky; bottom: 0`，只在編輯中出現——不是頁面常駐的底部列，不宣告 `--m-page-dock-h`（契約 0-23）。
 * 建議：`useCaretTag` 認到游標處的 `#…`（組字中不算）⇒ `tagStore.suggest(q, { limit: 4 })` 的列＋「建立 #○○」＋提示；
 *   點一列＝把 `#q` 換成 `#名稱 `、游標放到空白後；「收起」＝這一個 # 不再自己跳出來。
 * 所有按鈕在 mousedown 時 preventDefault：不搶打字框的焦點（搶了＝失焦＝離開編輯，工具列跟著消失）。
 */
import { useEffect, useMemo, type MutableRefObject } from "react";
import { useTagStore } from "../../../store/tagStore";
import { IconPlus } from "./mobileDiaryBits";
import { IconXs, TagGlyph, TagName, keepFocus, replaceAtCaret, useCaretTag } from "./mobileTagBits";

/* ═══ 游標處的建議清單 ═══ */

export interface MobileTagSuggestProps {
  /** `#` 之後到游標的字 */
  q: string;
  /** 選了一個名稱（含「建立 #○○」） */
  onPick(name: string): void;
  onDismiss(): void;
}

export function MobileTagSuggest({ q, onPick, onDismiss }: MobileTagSuggestProps) {
  const index = useTagStore((s) => s.index);
  const suggest = useTagStore((s) => s.suggest);
  const nameOf = useTagStore((s) => s.nameOf);
  // index 還沒載（例：沒進過荷札段就在筆記裡打 #）：載一次
  useEffect(() => {
    if (!useTagStore.getState().index && !useTagStore.getState().loading) void useTagStore.getState().loadIndex();
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const res = useMemo(() => suggest(q, { limit: 4 }), [suggest, q, index]);
  const empty = !res.items.length && !res.create && !res.hint;
  return (
    <div className="ns-notes-msug" role="listbox" aria-label="荷札建議">
      {res.browse && res.items.length > 0 && <p className="ns-notes-msughead">#{nameOf(res.browse)} 底下</p>}
      {res.items.map((it) => (
        <button
          key={it.key}
          type="button"
          role="option"
          aria-selected={false}
          className={"ns-notes-msugrow" + (it.real ? "" : " virtual")}
          onMouseDown={keepFocus}
          onClick={() => onPick(it.name)}
        >
          <TagGlyph real={it.real} />
          <span className="nm">
            <TagName name={it.name} hl={it.hl} />
          </span>
          <span className="n">{it.real ? `${it.count} 處` : "上層分類"}</span>
        </button>
      ))}
      {res.create && (
        <button type="button" role="option" aria-selected={false} className="ns-notes-msugrow create" onMouseDown={keepFocus} onClick={() => onPick(res.create!.name)}>
          <IconPlus />
          <span className="nm">
            建立 <b>#{res.create.name}</b>
          </span>
        </button>
      )}
      {res.hint && <p className="ns-notes-msughint">{res.hint}</p>}
      {empty && <p className="ns-notes-msughint">找不到符合的荷札</p>}
      <button type="button" className="ns-notes-msugclose" onMouseDown={keepFocus} onClick={onDismiss} aria-label="收起荷札建議">
        <IconXs size={10} />
        收起
      </button>
    </div>
  );
}

/* ═══ 工具列 ═══ */

export interface MobileTagToolbarProps {
  taRef: MutableRefObject<HTMLTextAreaElement | null>;
  /** 打字框目前的字（與 taRef 的 value 同步） */
  value: string;
  /** 游標處建議選了一個：新的全文與游標位置（呼叫端 setBody＋排存檔＋把游標放回去） */
  onReplace(next: { text: string; caret: number }): void;
  /** 點選器插入模式完成：names 可能是空的（沒勾就完成）；caret＝按「#」那一刻的游標 */
  onInsertTags(names: string[], caret: number | null): void;
}

export function MobileTagToolbar({ taRef, value, onReplace, onInsertTags }: MobileTagToolbarProps) {
  const openPicker = useTagStore((s) => s.openPicker);
  const { at, dismiss } = useCaretTag(taRef, true);

  const openInsert = () => {
    const ta = taRef.current;
    const caret = ta && document.activeElement === ta ? ta.selectionStart : null;
    openPicker({ mode: "insert", entityType: null, entityId: null, name: "", onInsert: (names) => onInsertTags(names, caret) });
  };

  return (
    <div className="ns-notes-mtagbar">
      {at && (
        <MobileTagSuggest
          q={at.q}
          onPick={(name) => onReplace(replaceAtCaret(value, at.start, at.caret, name))}
          onDismiss={dismiss}
        />
      )}
      <div className="ns-notes-mtagbar-in" role="toolbar" aria-label="編輯工具列">
        <button type="button" className="hash" onMouseDown={keepFocus} onClick={openInsert} aria-label="插入荷札">
          #
        </button>
        <span className="lab">荷札</span>
        <button type="button" className="done" onClick={() => taRef.current?.blur()}>
          完成
        </button>
      </div>
    </div>
  );
}
