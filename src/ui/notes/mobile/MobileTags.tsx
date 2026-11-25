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
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import type { TagPreviewItem } from "../../../data/tagRepository";
import { buildLuggageCards, fmtPreviewDate, useTagStore, type LuggageCardData } from "../../../store/tagStore";
import { IconSearch, IconX } from "./mobileDiaryBits";
import { MTagLoading, MobileTagNotice, retryTagIndex, useTagIndexFailed } from "./mobileTagBits";
import { MobileTagCreateSheet } from "./MobileTagSheet";
import { EmptyState } from "../../common/EmptyState";
import { IconPlus } from "../../common/icons";

const MAX_SHOWN_CHILDREN = 5;

function MobileLuggageCard({
  card,
  previews,
  onSelect,
}: {
  card: LuggageCardData;
  previews: readonly TagPreviewItem[];
  onSelect(key: string): void;
}) {
  const { root, children, modules } = card;
  const shownChildren = children.slice(0, MAX_SHOWN_CHILDREN);
  const extraCount = children.length - shownChildren.length;

  const onCardKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect(root.key);
    }
  };

  return (
    <article
      className={`ns-notes-mluggage-card${root.real ? "" : " is-virtual"}`}
      role="button"
      tabIndex={0}
      aria-label={`查看荷札 #${root.name}，共 ${root.total} 處掛載`}
      onClick={() => onSelect(root.key)}
      onKeyDown={onCardKeyDown}
    >
      <div className="ns-notes-mluggage-ear" aria-hidden="true">
        <span className="ns-notes-mluggage-eyelet" />
      </div>

      <div className="ns-notes-mluggage-body">
        <div className="ns-notes-mluggage-head">
          <h3 className="ns-notes-mluggage-name">
            <span className="hash" aria-hidden="true">#</span>
            <span className="txt">{root.name}</span>
            {!root.real && <span className="virt">分類</span>}
          </h3>
          <span className="ns-notes-mluggage-count" aria-label={`共 ${root.total} 處`}>
            {root.total}
          </span>
        </div>

        {shownChildren.length > 0 && (
          <div className="ns-notes-mluggage-children" role="group" aria-label={`#${root.name} 的子荷札`}>
            {shownChildren.map((c) => (
              <button
                key={c.key}
                type="button"
                className="ns-notes-mluggage-child"
                onClick={(e) => {
                  e.stopPropagation();
                  onSelect(c.key);
                }}
              >
                <span className="sl" aria-hidden="true">/</span>
                <span className="nm">{c.rel}</span>
              </button>
            ))}
            {extraCount > 0 && (
              <span className="ns-notes-mluggage-more" aria-label={`另有 ${extraCount} 個子荷札`}>
                +{extraCount}
              </span>
            )}
          </div>
        )}

        {modules.length > 0 && (
          <p className="ns-notes-mluggage-modules">
            {modules.map((m, i) => (
              <span key={m.label} className="moditem">
                {i > 0 && <span className="sep" aria-hidden="true">·</span>}
                {m.label} <b>{m.count}</b>
              </span>
            ))}
          </p>
        )}

        <div className="ns-notes-mluggage-previews">
          {previews.length > 0 ? (
            <ul className="ns-notes-mluggage-plist">
              {previews.slice(0, 2).map((p) => {
                const md = fmtPreviewDate(p.date);
                return (
                  <li key={`${p.entityType}:${p.entityId}`} className="ns-notes-mluggage-prow">
                    <span className="ns-notes-mluggage-pmod">{p.moduleLabel}</span>
                    <span className="ns-notes-mluggage-ptitle">{p.title}</span>
                    {md && <span className="ns-notes-mluggage-pdate">{md}</span>}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="ns-notes-mluggage-empty">尚無掛載紀錄</p>
          )}
        </div>
      </div>
    </article>
  );
}

export function MobileTags() {
  const index = useTagStore((s) => s.index);
  const rootPreviews = useTagStore((s) => s.rootPreviews);
  const treeFilter = useTagStore((s) => s.treeFilter);
  const backfilling = useTagStore((s) => s.backfilling);
  const setTreeFilter = useTagStore((s) => s.setTreeFilter);
  const select = useTagStore((s) => s.select);
  const failed = useTagIndexFailed();
  const [creating, setCreating] = useState(false);
  // 荷札頁一畫出來就重載索引（同桌機 NotesTags：別頁刪了東西再回來，數量與最近預覽要對上）
  useEffect(() => {
    void useTagStore.getState().loadIndex();
  }, []);

  const cards = useMemo(() => (index ? buildLuggageCards(index, treeFilter) : []), [index, treeFilter]);
  const total = useMemo(() => (index ? Object.values(index.byKey).filter((x) => x.real).length : 0), [index]);
  const rootCount = index?.roots.length ?? 0;
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
            placeholder="篩選母荷札或子荷札"
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

      {index && !backfilling && total > 0 && (
        <p className="ns-notes-mluggage-summary" aria-live="polite">
          {filtering ? (
            <>
              找到 <b>{cards.length}</b> / 共 <b>{rootCount}</b> 組荷札
            </>
          ) : (
            <>
              共 <b>{rootCount}</b> 組荷札
            </>
          )}
        </p>
      )}

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
      ) : cards.length === 0 ? (
        <EmptyState
          tone="nores"
          title={`找不到「${treeFilter.trim()}」`}
          desc="換個母荷札或子荷札關鍵字試試。"
          secondary={{ label: "清除篩選", onClick: () => setTreeFilter("") }}
          className="ns-notes-mtagnone"
        />
      ) : (
        <div className="ns-notes-mluggage-grid" role="list" aria-label="荷札索引卡牆">
          {cards.map((card) => (
            <MobileLuggageCard
              key={card.root.key}
              card={card}
              previews={rootPreviews[card.root.key] ?? []}
              onSelect={select}
            />
          ))}
        </div>
      )}

      {creating && <MobileTagCreateSheet onClose={() => setCreating(false)} />}
    </div>
  );
}
