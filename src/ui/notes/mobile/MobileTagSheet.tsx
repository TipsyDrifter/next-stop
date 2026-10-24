/**
 * MobileTagSheet——手機荷札的底部 sheet（旅客筆記車次③契約 §5.5；D-筆-41：流程與文案同桌機）。
 *
 *   `MobileTagActionSheet`  頁首 ⋯：標題「#名稱」＋「改名」「合併…」「刪除」（danger、最後）＋殼補的「取消」
 *   `MobileTagMergeSheet`   併入挑選：「把 #○○ 併入…」＋搜尋（不用打 #）＋建議列（排除自己與子孫、列虛資料夾、不給建立）
 *   `MobileTagCreateSheet`  新荷札（UI 丙-6 T2 手機入口）：`#` 輸入框＋即時檢查一行＋取消／建立
 *
 * UI 丙-6（視覺規範 §2.4）：
 *   - S4／S6：殼換共用 `MSheet`。⋯＝動作清單型（`list`＋`MSheetItem`，跟票卡 ⋯ 同一種）；併入＝動作清單型 `half`
 *     （每個候選是一列 MSheetItem，↑↓ 走得到；取消由殼補在最後，跟 ⋯ 一致）。返回層由殼登記：呼叫端給同一個
 *     `backId`（"notes.tagPage.sheet"），MobileTagPage 原本那條 useBackLayer 刪掉。
 *   - S5：刪除／併入的確認不再是底部 sheet，改核心 `askConfirm`（置中 ConfirmDialog，取消在左；跟桌機同一支）——
 *     呼叫在 MobileTagPage，所以原本的 `MobileTagConfirmSheet` 退役。
 * 文案全在 domain/tags（`mergeConfirmText`／`deleteConfirmText`）——這裡只畫。
 */
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { isUnder, normalizeName } from "../../../domain/tags";
import { useTagStore } from "../../../store/tagStore";
import { MSheet, MSheetItem } from "../../common/MSheet";
import { IconSearch } from "./mobileDiaryBits";
import { TagGlyph, TagName } from "./mobileTagBits";

/** 三支 sheet 共用的返回層 id（MobileTagPage 的本地 sheet 狀態；同時只開一支） */
export const TAG_PAGE_SHEET_ID = "notes.tagPage.sheet";

/* ═══ ⋯ 動作 ═══ */

export interface TagActionItem {
  label: string;
  danger?: boolean;
  onClick(): void;
}

export function MobileTagActionSheet({ title, items, onClose }: { title: string; items: TagActionItem[]; onClose(): void }) {
  // 破壞性項目一律排在最後（§2.4），呼叫端的順序之外再保險一次
  const sorted = [...items.filter((it) => !it.danger), ...items.filter((it) => it.danger)];
  return (
    <MSheet list title={title} backId={TAG_PAGE_SHEET_ID} onClose={onClose}>
      {sorted.map((it) => (
        <MSheetItem key={it.label} danger={it.danger} onClick={it.onClick}>
          {it.label}
        </MSheetItem>
      ))}
    </MSheet>
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
    <MSheet list height="half" title={`把 #${nameOf(fromKey)} 併入…`} backId={TAG_PAGE_SHEET_ID} className="ns-notes-mmergesheet" onClose={onClose}>
      <label className="ns-notes-mpksearch ns-notes-mmergesearch">
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
          placeholder="挑一個現有的荷札"
          aria-label="挑一個現有的荷札"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="done"
        />
      </label>
      {res.browse && <p className="ns-notes-mpkhint head">#{nameOf(res.browse)} 底下</p>}
      {res.items.map((it) => (
        <MSheetItem key={it.key} onClick={() => onPick(it.key)}>
          <TagGlyph real={it.real} />
          <span className={"ns-notes-mmergenm" + (it.real ? "" : " virtual")}>
            <TagName name={it.name} hl={it.hl} />
          </span>
          <span className="ns-notes-mmergen">{it.real ? `${it.count} 處` : "上層分類"}</span>
        </MSheetItem>
      ))}
      {/* 挑選器內的「沒有結果」提示列（E20 豁免：不是頁或區段空狀態，不換 EmptyState） */}
      {!res.items.length && <p className="ns-notes-mpkhint">{res.browse && res.hint ? res.hint : "找不到符合的荷札"}</p>}
    </MSheet>
  );
}

/* ═══ 新荷札（UI 丙-6 T2 手機入口） ═══ */

/**
 * 打名字 → `tagStore.createTag(rawName)`（W3 席加的資料層：normalizeName→ensureTag→commit；建好選中＋toast「已建立 #X」＋復原，
 * 已存在就選中＋toast「已經有 #X 了」）。這裡只負責輸入與即時檢查：不合法＝寫原因、建立鈕停用；已存在＝先講一聲（按了直接打開它）。
 * 選中新荷札 ⇒ MobileNotes 換成它的清單頁（掛 0 處＝空狀態）。返回層＝殼自己登記（沒有呼叫端那一層要合併）。
 */
export function MobileTagCreateSheet({ onClose }: { onClose(): void }) {
  const index = useTagStore((s) => s.index);
  const createTag = useTagStore((s) => s.createTag);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const composing = useRef(false);

  const n = normalizeName(draft);
  const exists = n.ok && !!index?.byKey[n.key]?.real;
  let hint: { text: string; err?: boolean } | null = null;
  if (draft.trim() && !n.ok) hint = { text: n.reason, err: true };
  else if (n.ok && exists) hint = { text: `已經有 #${n.name} 了，按「建立」會直接打開它` };
  else if (n.ok && n.name.includes("/")) hint = { text: `會建在 #${n.name.slice(0, n.name.lastIndexOf("/"))} 底下` };

  const submit = async () => {
    if (busy || !n.ok) return;
    setBusy(true);
    try {
      // 失敗（store 已出失敗 toast、回 null）就留著表單，字還在、可以再按一次
      if (await createTag(draft)) onClose();
    } finally {
      setBusy(false);
    }
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter" || e.nativeEvent.isComposing || e.keyCode === 229 || composing.current) return;
    e.preventDefault();
    void submit();
  };

  return (
    <MSheet
      title="新荷札"
      className="ns-notes-mcreatesheet"
      onClose={onClose}
      foot={
        <>
          <button type="button" className="ns-notes-mbtn ns-btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button type="button" className="ns-notes-mbtn ns-btn btn-seal" onClick={() => void submit()} disabled={!n.ok || busy}>
            建立
          </button>
        </>
      }
    >
      <label className="ns-notes-mrenamein">
        <i aria-hidden>#</i>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          placeholder="名稱（用 / 可以分上下層）"
          aria-label="新荷札的名稱（用 / 可以分上下層）"
          aria-invalid={hint?.err || undefined}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="done"
        />
      </label>
      <p className={"ns-notes-mimpact" + (hint?.err ? " is-err" : "")} aria-live="polite">
        {hint?.text ?? " "}
      </p>
    </MSheet>
  );
}
