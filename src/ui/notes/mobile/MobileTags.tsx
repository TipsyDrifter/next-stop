/**
 * MobileTags——旅客筆記手機分頁的第四段「荷札」（旅客筆記車次③契約 §5.5、7.2-1；原型 app.js mobNotes 的 tags 分支）。
 *
 * 由上而下：通車提示條（D-筆-43；只出現一次）→ 篩選框（沿筆記段的 `.ns-notes-msearch`；placeholder「篩選荷札」）
 *   → 整頁荷札樹（每列 44px：展開鈕 44×44、名稱鈕、右側數量；虛資料夾空心）→ 圖例「上層分類（沒有直接掛在上面的項目）」。
 * 點名稱＝`select(key)` ⇒ MobileNotes 換成清單整頁（MobileTagPage）；真荷札與虛資料夾都進清單頁（虛的看子孫）。
 * 樹的展開與篩選字存在 tagStore（openKeys／treeFilter；桌機書封樹同一份，兩殼永不同時渲染）。
 * 沒有底部列（契約 0-23：不宣告 `--m-page-dock-h`），捕捉鈕位置照舊。
 *
 * UI 丙-6：
 *   - T2 手機入口：篩選框右邊一顆「＋ 新荷札」（小號次鈕）→ `MobileTagCreateSheet`（MSheet 表單：打名字、即時檢查、取消／建立）
 *     → `tagStore.createTag`（建好選中 ⇒ 換成它的清單頁）。一個荷札都沒有時鈕藏起來，由空狀態的「新荷札」當唯一入口（§2.7）。
 *   - E17：空狀態換共用 `EmptyState`：一個都沒有＝first（＋新荷札）；篩選沒結果＝nores（清除篩選）。
 *     補掛中的那行字是載入態（E21），不換。載入失敗＝`MTagLoading` 的 ErrorBar（E12）。
 */
import { useEffect, useMemo, useState } from "react";
import { flattenTree } from "../../../domain/tags";
import { useTagStore } from "../../../store/tagStore";
import { IconSearch, IconX } from "./mobileDiaryBits";
import { IconCaretRight, MTagLoading, MobileTagNotice, TagGlyph, retryTagIndex, useTagIndexFailed } from "./mobileTagBits";
import { MobileTagCreateSheet } from "./MobileTagSheet";
import { EmptyState } from "../../common/EmptyState";
import { IconPlus } from "../../common/icons";

export function MobileTags() {
  const index = useTagStore((s) => s.index);
  const openKeys = useTagStore((s) => s.openKeys);
  const treeFilter = useTagStore((s) => s.treeFilter);
  const backfilling = useTagStore((s) => s.backfilling);
  const toggleOpen = useTagStore((s) => s.toggleOpen);
  const setTreeFilter = useTagStore((s) => s.setTreeFilter);
  const select = useTagStore((s) => s.select);
  const failed = useTagIndexFailed();
  const [creating, setCreating] = useState(false);
  // 荷札樹一畫出來就重載索引（同桌機 NotesTags：別頁刪了東西再回來，數量要對上）
  useEffect(() => {
    void useTagStore.getState().loadIndex();
  }, []);

  const rows = useMemo(() => (index ? flattenTree(index, openKeys, treeFilter) : []), [index, openKeys, treeFilter]);
  const total = useMemo(() => (index ? Object.values(index.byKey).filter((x) => x.real).length : 0), [index]);
  const filtering = !!treeFilter.trim();
  /** 已載入、而且一個荷札都沒有（空狀態出現時上方的「＋ 新荷札」藏起來） */
  const none = !!index && !backfilling && total === 0;
  const openCreate = () => setCreating(true);

  return (
    <div className="ns-notes-mtags">
      <MobileTagNotice />

      <div className="ns-notes-mtools">
        <label className="ns-notes-msearch">
          <IconSearch />
          <input
            className="ns-notes-minput"
            type="search"
            value={treeFilter}
            onChange={(e) => setTreeFilter(e.target.value)}
            placeholder="篩選荷札"
            aria-label="篩選荷札"
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="search"
          />
          {treeFilter && (
            <button type="button" className="ns-notes-mclear" aria-label="清除篩選" onClick={() => setTreeFilter("")}>
              <IconX />
            </button>
          )}
        </label>
        {!none && (
          <button type="button" className="ns-notes-mbtn ns-btn btn-ghost ns-notes-mnewtag" onClick={openCreate}>
            <IconPlus size={14} />
            新荷札
          </button>
        )}
      </div>

      {backfilling ? (
        <p className="ns-notes-mtagempty">正在把以前內文裡的 #荷札 補掛上…</p>
      ) : !index ? (
        <MTagLoading className="ns-notes-mtagempty" failed={failed} onRetry={retryTagIndex} />
      ) : total === 0 ? (
        <EmptyState
          tone="first"
          title="還沒有荷札"
          desc="在筆記或日記裡打 #名稱，就會掛上。"
          action={{ label: "新荷札", icon: <IconPlus size={14} />, onClick: openCreate }}
          className="ns-notes-mtagnone"
        />
      ) : rows.length === 0 ? (
        <EmptyState
          tone="nores"
          title={`找不到「${treeFilter.trim()}」`}
          desc="換個字試試。"
          secondary={{ label: "清除篩選", onClick: () => setTreeFilter("") }}
          className="ns-notes-mtagnone"
        />
      ) : (
        <ul className="ns-notes-mtree" role="tree" aria-label="荷札">
          {rows.map((r) => {
            const x = r.node;
            return (
              <li
                key={x.key}
                className={"ns-notes-mtreerow" + (x.real ? "" : " virtual")}
                style={{ ["--d" as string]: x.depth - 1 }}
                role="treeitem"
                aria-expanded={r.hasKids ? r.open : undefined}
              >
                {r.hasKids && !filtering ? (
                  <button
                    type="button"
                    className={"cr" + (r.open ? " open" : "")}
                    aria-label={r.open ? `收合 #${x.name}` : `展開 #${x.name}`}
                    onClick={() => toggleOpen(x.key)}
                  >
                    <IconCaretRight />
                  </button>
                ) : (
                  <span className="cr" aria-hidden />
                )}
                <button type="button" className="nm" onClick={() => select(x.key)}>
                  <TagGlyph real={x.real} />
                  <span className="t">{x.seg}</span>
                </button>
                <span className="n" aria-label={`${x.total} 處`}>
                  {x.total}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {index && total > 0 && (
        <p className="ns-notes-mtreelegend">
          <TagGlyph real={false} />
          上層分類（沒有直接掛在上面的項目）
        </p>
      )}

      {creating && <MobileTagCreateSheet onClose={() => setCreating(false)} />}
    </div>
  );
}
