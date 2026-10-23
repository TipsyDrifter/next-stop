/**
 * NotesTags——旅客筆記「荷札」子畫面的主欄（桌機；旅客筆記車次③契約 §5.2；原型 app.js deskTagsPage／tagHeadHtml／dialogHtml）。
 *
 *   `section.ns-notes-tagmain` ＞ `.ns-notes-sheetwrap` ＞ `article.ns-notes-page`
 *     back ⇒「‹ 回到剛才 <label>」（0-16）
 *     notice ⇒ 通車提示條（D-筆-43；× ＝ dismissNotice，只出現一次）
 *     沒選荷札 ⇒ 總覽：overline「TAGS · 荷札」、h1「荷札」、lede「N 個荷札。…」＋ 牌雲（真荷札，依直接掛的數量多到少）
 *     選了 ⇒ 頁頭大牌（父層段可點＝看父層；虛資料夾退淡）＋「掛著 N 處・含子荷札」＋ ⋯（改名／併入…／刪除；虛資料夾也有）
 *            改名中 ⇒ 改名列（`input.techo-input`、即時影響一行、確定／取消）；清單 `TagList`
 *   併入…＝⋯ 旁的浮層：`#` 輸入框＋建議清單（排除自己與子孫、含虛資料夾、不給建立）；選了 ⇒ `mergeInto`，要確認就開核心確認框。
 *   刪除＝`removePlan` → 從內文挑一個真的寫過的例子（`deleteExample`）→ 核心 `askConfirm`（danger、主鈕「刪除」）→ `confirmRemove`。
 *   改名撞名／併入＝`commitRename` 回 "confirm" ⇒ 核心 `askConfirm`（`mergeConfirmText(pendingPlan)`，主鈕「併入」）→ `confirmRename`。
 *
 * 鍵盤（契約 §5.6；表在 NotesView、動作經 `apiRef`）：↑↓ 清單列、Enter 開列、Delete 刪目前荷札、F2 改名、M 併入、
 *   Esc＝併入浮層／⋯ 選單開著→收、改名中→取消、有「回到剛才」→回去；Backspace＝有「回到剛才」就回去。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MutableRefObject } from "react";
import { tagRepo } from "../../data/tagRepo";
import {
  backfillNotice,
  deleteConfirmText,
  deleteExample,
  isUnder,
  mergeConfirmText,
  planRename,
  renameImpact,
} from "../../domain/tags";
import { useTagStore } from "../../store/tagStore";
import { useUiStore } from "../../store/uiStore";
import { IconDots, IconLeft, IconTag, IconX, Kbd, usePopDismiss } from "./notesBits";
import { TagChip, TagChipLarge } from "./tags/TagChip";
import { TagList, type TagListApi } from "./tags/TagList";
import { TagSuggestRows, moveAct, suggestCount } from "./tags/TagSuggest";
import "./notes-tags.css";

export interface NotesTagsApi {
  move(delta: 1 | -1): void;
  open(): void;
  del(): void;
  rename(): void;
  merge(): void;
  /** Esc：處理了回 true */
  escape(): boolean;
  /** 有沒有浮層／選單開著（開著時頁面鍵盤表只留 Esc） */
  popOpen(): boolean;
}

/** 浮層收起後焦點回頁根（鍵盤表掛在頁根；焦點掉到 body 會斷線） */
function focusPage(): void {
  const root = document.querySelector<HTMLElement>(".page.ns-notes");
  const a = document.activeElement;
  if (root && (!a || a === document.body || !root.contains(a))) root.focus({ preventScroll: true });
}

/* ───────── 確認框（核心 askConfirm） ───────── */

function askMerge(): void {
  const plan = useTagStore.getState().pendingPlan;
  if (!plan || !plan.ok) return;
  const t = mergeConfirmText(plan);
  useUiStore.getState().askConfirm({
    title: t.title,
    body: t.body,
    confirmLabel: "併入",
    onConfirm: () => void useTagStore.getState().confirmRename(),
  });
}

async function askDelete(key: string): Promise<void> {
  const st = useTagStore.getState();
  const plan = st.removePlan(key);
  if (!plan || !plan.ok) return;
  let bodies: string[] = [];
  try {
    const items = await tagRepo.listUnder(key, "note");
    bodies = items.flatMap((it) => (it.kind === "note" ? [it.note.body] : []));
  } catch (e) {
    console.warn("NotesTags：讀內文例子失敗", e);
  }
  const t = deleteConfirmText(plan, deleteExample(bodies, plan));
  useUiStore.getState().askConfirm({
    title: t.title,
    body: t.body,
    confirmLabel: "刪除",
    danger: true,
    onConfirm: () => void useTagStore.getState().confirmRemove(plan),
  });
}

/* ───────── 改名列 ───────── */

function RenameRow({ tagKey }: { tagKey: string }) {
  const draft = useTagStore((s) => s.renaming?.draft ?? "");
  const index = useTagStore((s) => s.index);
  const inRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inRef.current?.focus({ preventScroll: true });
    inRef.current?.select();
  }, []);

  const plan = useMemo(() => (index ? planRename(index, tagKey, draft) : null), [index, tagKey, draft]);
  let impact: { text: string; cls: string; warn?: string } = { text: "", cls: "" };
  if (plan) {
    if (!plan.ok) impact = { text: plan.reason, cls: "err" };
    else if (plan.same) impact = { text: plan.nameOnly ? "只改大小寫，已標記的東西不受影響" : "名稱沒有變", cls: "" };
    else
      impact = {
        text: renameImpact(plan),
        cls: "",
        warn: plan.rootConflict
          ? `已經有 #${plan.rootConflict.name} 了——按確定可選擇是否合併`
          : plan.conflicts.length
            ? `底下有 ${plan.conflicts.length} 個荷札名稱重複——按確定可選擇是否合併`
            : undefined,
      };
  }

  const commit = async () => {
    const r = await useTagStore.getState().commitRename();
    if (r === "confirm") askMerge();
    else if (r === "done") setTimeout(focusPage, 0);
  };
  const cancel = () => {
    useTagStore.getState().cancelRename();
    setTimeout(focusPage, 0);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter") {
      e.preventDefault();
      void commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cancel();
    }
  };

  return (
    <div className="ns-notes-renamerow">
      <span className="ns-notes-taginput lg">
        <i aria-hidden>#</i>
        <input
          ref={inRef}
          className="techo-input"
          value={draft}
          aria-label="荷札的新名稱"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => useTagStore.getState().setRenameDraft(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </span>
      <p className={`ns-notes-impact${impact.cls ? ` ${impact.cls}` : ""}`} aria-live="polite">
        {impact.text}
        {impact.warn && (
          <>
            <br />
            <span className="warn">{impact.warn}</span>
          </>
        )}
      </p>
      <div className="ns-notes-renbtns">
        {/* 取消在左、主鈕在右（視覺規範 §2.3；UI 丙-1 起從「主鈕在左」換過來，同日記草稿列） */}
        <button type="button" className="ns-notes-btn ns-btn btn-ghost" onClick={cancel}>
          取消
        </button>
        <button type="button" className="ns-notes-btn ns-btn btn-seal" disabled={!plan || !plan.ok} onClick={() => void commit()}>
          確定
        </button>
        <span className="hint">用 / 可以分上下層</span>
      </div>
    </div>
  );
}

/* ───────── 併入挑選浮層 ───────── */

function MergePick({ tagKey, onClose }: { tagKey: string; onClose(): void }) {
  const index = useTagStore((s) => s.index);
  const [q, setQ] = useState("");
  const [act, setAct] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const inRef = useRef<HTMLInputElement>(null);
  usePopDismiss(boxRef, onClose);
  useEffect(() => inRef.current?.focus({ preventScroll: true }), []);

  const exclude = useMemo(() => (index ? Object.keys(index.byKey).filter((k) => isUnder(k, tagKey)) : []), [index, tagKey]);
  const res = useMemo(
    () => useTagStore.getState().suggest(q, { exclude, includeVirtual: true, limit: 8 }),
    // index 變了要重算
    [q, exclude, index],
  );
  const n = suggestCount(res, true);
  const cur = Math.min(act, Math.max(0, n - 1));

  const pick = async (i: number) => {
    const it = res.items[i];
    if (!it) return;
    onClose();
    await useTagStore.getState().mergeInto(tagKey, it.key);
    if (useTagStore.getState().pendingPlan) askMerge();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setAct(moveAct(cur, e.key === "ArrowDown" ? 1 : -1, n));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (n) void pick(cur);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  const nameOf = (k: string) => useTagStore.getState().nameOf(k);
  return (
    <div ref={boxRef} className="ns-notes-mergepick" role="dialog" aria-label={`把 #${nameOf(tagKey)} 併入…`}>
      <p className="ns-notes-poplabel">把 #{nameOf(tagKey)} 併入…</p>
      <span className="ns-notes-taginput">
        <i aria-hidden>#</i>
        <input
          ref={inRef}
          value={q}
          placeholder="挑一個現有的荷札"
          aria-label="併入哪個荷札"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            setQ(e.target.value);
            setAct(0);
          }}
          onKeyDown={onKeyDown}
        />
      </span>
      <div className="ns-notes-sug static" role="listbox">
        <TagSuggestRows res={res} act={cur} noCreate onPick={(i) => void pick(i)} onHover={setAct} nameOf={nameOf} />
      </div>
    </div>
  );
}

/* ───────── 主欄 ───────── */

export function NotesTags({ apiRef }: { apiRef: MutableRefObject<NotesTagsApi | null> }) {
  const index = useTagStore((s) => s.index);
  const selectedKey = useTagStore((s) => s.selectedKey);
  const back = useTagStore((s) => s.back);
  const notice = useTagStore((s) => s.notice);
  const renaming = useTagStore((s) => s.renaming);
  const loadFailed = useTagStore((s) => s.loadError !== null && !s.loading);
  const [menu, setMenu] = useState(false);
  const [merging, setMerging] = useState(false);
  const listApi = useRef<TagListApi | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const closeMenu = useCallback(() => setMenu(false), []);
  usePopDismiss(menuRef, closeMenu);

  // 荷札頁一畫出來就重載索引：從別頁刪了車票／筆記再回來（頁面本來就停在荷札）也要對上數量（真機代驗 10-15）
  useEffect(() => {
    void useTagStore.getState().loadIndex();
  }, []);

  // 換荷札：收起選單與併入
  useEffect(() => {
    setMenu(false);
    setMerging(false);
  }, [selectedKey]);

  const node = selectedKey && index ? (index.byKey[selectedKey] ?? null) : null;
  const isRenaming = !!(renaming && node && renaming.key === node.key);
  const st = useTagStore.getState;

  const startRename = () => {
    if (!node) return;
    setMenu(false);
    setMerging(false);
    st().startRename(node.key);
  };
  const startMerge = () => {
    if (!node) return;
    setMenu(false);
    st().cancelRename();
    setMerging(true);
  };
  const del = () => {
    if (!node) return;
    setMenu(false);
    void askDelete(node.key);
  };

  apiRef.current = {
    move: (d) => listApi.current?.move(d),
    open: () => listApi.current?.open(),
    del,
    rename: startRename,
    merge: startMerge,
    escape() {
      if (merging) {
        setMerging(false);
        return true;
      }
      if (menu) {
        setMenu(false);
        return true;
      }
      if (st().renaming) {
        st().cancelRename();
        return true;
      }
      if (st().back) {
        st().goBack();
        return true;
      }
      return false;
    },
    popOpen: () => menu || merging,
  };

  const realTags = useMemo(
    () =>
      index
        ? Object.values(index.byKey)
            .filter((x) => x.real)
            .sort((a, b) => b.direct - a.direct || (a.name < b.name ? -1 : 1))
        : [],
    [index],
  );

  return (
    <section className="ns-notes-tagmain ns-notes-col techo-scroll" aria-label="荷札">
      <div className="ns-notes-sheetwrap">
        <article className="ns-notes-page">
          <div className="ns-notes-measure">
            {back && (
              <button type="button" className="ns-notes-backlink" onClick={() => st().goBack()}>
                <IconLeft size={13} />
                回到剛才
                <span>{back.label}</span>
              </button>
            )}
            {notice && (
              <div className="ns-notes-notice" role="status">
                <IconTag size={14} />
                <span>{backfillNotice(notice.tags, notice.places)}</span>
                <button type="button" className="x" aria-label="關掉提示" onClick={() => void st().dismissNotice()}>
                  <IconX size={11} />
                </button>
              </div>
            )}

            {!node ? (
              <>
                <header className="ns-notes-taghead">
                  <p className="techo-overline ns-notes-overline">TAGS · 荷札</p>
                  <h1 className="techo-title">荷札</h1>
                  <p className="ns-notes-lede">
                    <b>{realTags.length}</b> 個荷札。點選左側荷札，查看相關的車票、筆記、日記與時間塊。
                  </p>
                </header>
                {realTags.length > 0 ? (
                  <div className="ns-notes-cloud">
                    {realTags.map((x) => (
                      <TagChip key={x.key} name={x.name} onOpen={() => st().select(x.key)} />
                    ))}
                  </div>
                ) : index ? (
                  <p className="ns-notes-tagempty">
                    還沒有荷札。在筆記或日記打 #名稱，或在車票側板就能掛上。
                    <br />
                    時刻表的分類、時間塊也能掛。
                  </p>
                ) : (
                  loadFailed && (
                    // 磨光③ 2-12：載入失敗不再一片空白
                    <p className="ns-notes-tagempty">
                      荷札沒載入{" "}
                      <button type="button" className="ns-notes-btn ns-btn btn-ghost" onClick={() => void st().loadIndex()}>
                        重試
                      </button>
                    </p>
                  )
                )}
              </>
            ) : (
              <>
                <header className="ns-notes-tagview">
                  <p className="techo-overline ns-notes-overline">TAG · 荷札</p>
                  <div className="ns-notes-tagtitle">
                    {isRenaming ? (
                      <RenameRow tagKey={node.key} />
                    ) : (
                      <TagChipLarge name={node.name} virtual={!node.real} onParent={(k) => st().select(k)} />
                    )}
                    {!isRenaming && (
                      <div className="ns-notes-menuwrap" ref={menuRef}>
                        <button
                          type="button"
                          className="ns-notes-dots"
                          data-pop-toggle=""
                          aria-haspopup="menu"
                          aria-expanded={menu}
                          aria-label="荷札選項"
                          title="改名・併入・刪除"
                          onClick={() => {
                            setMerging(false);
                            setMenu((m) => !m);
                          }}
                        >
                          <IconDots size={16} />
                        </button>
                        {menu && (
                          <div className="ns-notes-menu" role="menu">
                            <button type="button" role="menuitem" onClick={startRename}>
                              改名
                              <Kbd id="notes.tags.rename" />
                            </button>
                            <button type="button" role="menuitem" onClick={startMerge}>
                              併入…
                              <Kbd id="notes.tags.merge" />
                            </button>
                            <button type="button" role="menuitem" className="ns-btn-danger" onClick={del}>
                              刪除
                              <Kbd id="notes.delete" />
                            </button>
                          </div>
                        )}
                        {merging && (
                          <MergePick
                            tagKey={node.key}
                            onClose={() => {
                              setMerging(false);
                              focusPage();
                            }}
                          />
                        )}
                      </div>
                    )}
                  </div>
                  <p className="ns-notes-tagcount">
                    {!node.real && <span className="ns-notes-virt">上層分類</span>}
                    用在 <b>{node.total}</b> 個地方{node.children.length > 0 && "・包含底下的荷札"}
                  </p>
                </header>
                <TagList tagKey={node.key} apiRef={listApi} />
              </>
            )}
          </div>
        </article>
      </div>
    </section>
  );
}
