/**
 * TagSuggest——荷札建議清單（桌機；旅客筆記車次③契約 §5.0；原型 app.js sugRows／sugPick、styles.css:319-347）。
 *
 * 資料一律是 `tagStore.suggest` 回的 `TagSuggestResult`；本檔只畫列與算「第 i 列是哪個名稱」，位置與鍵盤由呼叫端
 * （側板輸入框 `TagField`、內文游標 `useInlineTagSuggest`、併入挑選 `NotesTags`）各自處理。
 *
 *   列 `button.ns-notes-sugrow[.on][.virtual]`：牌形小圖示＋完整路徑（父層淡、對到的那段加粗）＋右側「N 處」／「虛資料夾」
 *   `create` ⇒ 最後一列「建立 #○○」（`noCreate` 時不畫，例：併入只能挑既有的）
 *   `hint` ⇒ 淡字一行；沒列也不能建 ⇒「沒有對到的荷札」；`browse` ⇒ 標頭「#父 底下」
 * 列一律 `onMouseDown` preventDefault：點列不搶輸入框／textarea 的焦點（否則 blur 會先把建議或編輯收掉）。
 */
import type { TagSuggestResult } from "../../../domain/tags";
import { IconPlus } from "../notesBits";
import { TagGlyph, TagName } from "./TagChip";

/** 可選的列數（建議＋「建立」） */
export function suggestCount(res: TagSuggestResult, noCreate = false): number {
  return res.items.length + (res.create && !noCreate ? 1 : 0);
}
/** 第 i 列對應的名稱（建議＝那個荷札的全名；「建立」＝新名稱）；超出＝null */
export function suggestPick(res: TagSuggestResult, i: number, noCreate = false): string | null {
  if (i < res.items.length) return res.items[i].name;
  if (res.create && !noCreate && i === res.items.length) return res.create.name;
  return null;
}
/** ↑↓ 移動選中列（循環） */
export function moveAct(act: number, delta: 1 | -1, n: number): number {
  return n ? (act + delta + n) % n : 0;
}

export interface TagSuggestRowsProps {
  res: TagSuggestResult;
  act: number;
  onPick(i: number): void;
  onHover?(i: number): void;
  noCreate?: boolean;
  /** browse 父 key 的顯示名 */
  nameOf(key: string): string;
}

export function TagSuggestRows({ res, act, onPick, onHover, noCreate = false, nameOf }: TagSuggestRowsProps) {
  const canCreate = !!res.create && !noCreate;
  return (
    <>
      {res.browse && <p className="ns-notes-sughead">#{nameOf(res.browse)} 底下</p>}
      {res.items.map((it, i) => (
        <button
          key={it.key}
          type="button"
          role="option"
          aria-selected={i === act}
          className={`ns-notes-sugrow${i === act ? " on" : ""}${it.real ? "" : " virtual"}`}
          onMouseDown={(e) => e.preventDefault()}
          onMouseEnter={() => onHover?.(i)}
          onClick={() => onPick(i)}
        >
          <TagGlyph real={it.real} />
          <span className="nm">
            <TagName name={it.name} hl={it.hl} />
          </span>
          <span className="n">{it.real ? `${it.count} 處` : "虛資料夾"}</span>
        </button>
      ))}
      {canCreate && res.create && (
        <button
          type="button"
          role="option"
          aria-selected={act === res.items.length}
          className={`ns-notes-sugrow create${act === res.items.length ? " on" : ""}`}
          onMouseDown={(e) => e.preventDefault()}
          onMouseEnter={() => onHover?.(res.items.length)}
          onClick={() => onPick(res.items.length)}
        >
          <IconPlus size={12} />
          <span className="nm">
            建立 <b>#{res.create.name}</b>
          </span>
        </button>
      )}
      {res.hint ? (
        <p className="ns-notes-sughint">{res.hint}</p>
      ) : !res.items.length && !canCreate ? (
        <p className="ns-notes-sughint">沒有對到的荷札</p>
      ) : null}
    </>
  );
}
