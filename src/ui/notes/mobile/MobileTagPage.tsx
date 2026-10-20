/**
 * MobileTagPage——手機荷札的清單整頁（`tagStore.selectedKey` 非 null 時取代第四段；旅客筆記車次③契約 §5.5、7.2-2／3）。
 *
 * 由上而下：「‹ 荷札」（＝select(null)）＋有 back 時「‹ 回到剛才 <label>」→ 通車提示條
 *   → 頁頭：大牌（父層段可點＝看父層；虛資料夾 .virtual）＋右上 ⋯（44px）＋「掛著 N 處・含子荷札」
 *   → 改名中：就地輸入框（`/` 可搬層級）＋即時影響一行＋「確定」「取消」大鈕（上下排、確定在上）
 *   → 清單（D-筆-38、契約 0-20）：車票・列車車廂／筆記／日記（別線＝「別處」），已完成收在「已完成 N」（預設收合），空段不畫。
 * ⋯ ＝底部 sheet：改名／併入…／刪除／取消；併入＝搜尋挑選 sheet；要確認的（併入既有名稱、子孫撞名、刪除）＝確認 sheet。
 * 流程與文案同桌機（D-筆-41）：store 的 commitRename／mergeInto／removePlan／confirmRemove；文案出自 domain/tags。
 *
 * 點一列：
 *   車票・列車車廂 ⇒ 核心的 `jumpToNodeMobile`（磨光① A7，契約 §2.3、§9.4）：
 *     臨時票有執行日 → 今日 tab 捲到那張票、閃一下（排在未來＝toast，同 QuickJump）；
 *     臨時票沒日期、沒路線、未済 → 收件匣（選中那張；核心 `revealInbox`，MobileNotes 接手——與手機搜尋同一條）；
 *     其他有路線的 → 路線圖進那條路線、展開到它。
 *   筆記 ⇒ 清掉路線篩選與搜尋 → 筆記段 → 整頁（`onOpenNote`）；收件匣裡的筆記 → 收件匣段並選中。
 *   日記 ⇒ `openDiaryAt(entry_date)`＋選中那篇。
 * Android 返回鍵（磨光①）：清單頁＝子頁（有「回到剛才」就回去，否則同「‹ 荷札」）；各 sheet＝同「取消」。
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { nodeRepo } from "../../../data";
import { tagRepo } from "../../../data/tagRepo";
import type { TaggedItem } from "../../../data/tagRepository";
import {
  deleteConfirmText,
  deleteExample,
  groupTaggedItems,
  mergeConfirmText,
  planRename,
  renameImpact,
  segsOf,
  snippetAround,
  tagDisplayParts,
  type DeletePlan,
  type GroupedTaggedItem,
} from "../../../domain/tags";
import { dayKeyOf } from "../../../lib/date";
import { fmtShortDay, noteTitle, weekdayZh } from "../../../domain/notes";
import { KIND_LABEL, type NodeKind } from "../../../domain";
import { useTagStore } from "../../../store/tagStore";
import type { TagEntityRow } from "../../../lines/types";
import { useOtherSections } from "../tags/otherEntities";
import { useNotesStore } from "../../../store/notesStore";
import { useNodeStore } from "../../../store/nodeStore";
import { useUiStore } from "../../../store/uiStore";
import { RouteDot } from "./MobileAttachPicker";
import { IconLeft } from "./mobileDiaryBits";
import { IconCaretRight, IconDots, MTagLoading, MobileTagNotice, TagName, retryTagIndex, useTagIndexFailed } from "./mobileTagBits";
import { MobileTagActionSheet, MobileTagConfirmSheet, MobileTagMergeSheet } from "./MobileTagSheet";
import { useBackLayer } from "../../mobile/backStack";
import { jumpToNodeMobile } from "../../mobile/routeMapReveal";

type Sheet = null | "menu" | "merge" | { kind: "delete"; plan: Extract<DeletePlan, { ok: true }>; title: string; body: string };

export function MobileTagPage({ onOpenNote }: { onOpenNote(id: string): void }) {
  const key = useTagStore((s) => s.selectedKey);
  const index = useTagStore((s) => s.index);
  const back = useTagStore((s) => s.back);
  const renaming = useTagStore((s) => s.renaming);
  const pendingPlan = useTagStore((s) => s.pendingPlan);
  const select = useTagStore((s) => s.select);
  // 清單頁一畫出來就重載索引（同桌機 NotesTags：別的 tab 刪了東西再回來，數量要對上）
  useEffect(() => {
    void useTagStore.getState().loadIndex();
  }, []);
  const goBack = useTagStore((s) => s.goBack);
  const nameOf = useTagStore((s) => s.nameOf);
  const startRename = useTagStore((s) => s.startRename);
  const removePlan = useTagStore((s) => s.removePlan);
  const confirmRemove = useTagStore((s) => s.confirmRemove);
  const mergeInto = useTagStore((s) => s.mergeInto);
  const confirmRename = useTagStore((s) => s.confirmRename);
  const cancelPending = useTagStore((s) => s.cancelPending);

  const [items, setItems] = useState<TaggedItem[] | null>(null);
  const [doneOpen, setDoneOpen] = useState(false);
  const [sheet, setSheet] = useState<Sheet>(null);
  const seq = useRef(0);
  const indexFailed = useTagIndexFailed();
  /** 清單查失敗（磨光③ 2-12：給重試，不再假裝「還沒有東西掛著」）；listTry＝按一次重試 +1 */
  const [listFailed, setListFailed] = useState(false);
  const [listTry, setListTry] = useState(0);

  const node = key && index ? (index.byKey[key] ?? null) : null;

  // 清單：換荷札、或 index 換了（掛摘、改名、同步）、或按了重試就重查
  useEffect(() => {
    if (!key) return;
    const my = ++seq.current;
    setListFailed(false);
    tagRepo
      .listUnder(key)
      .then((rows) => {
        if (my === seq.current) setItems(rows);
      })
      .catch((e) => {
        console.warn("MobileTagPage.listUnder 失敗", e);
        if (my === seq.current) {
          setItems(null);
          setListFailed(true);
        }
      });
  }, [key, index, listTry]);
  // 換荷札：摺疊收回、sheet 收掉、捲回頂
  useEffect(() => {
    setDoneOpen(false);
    setSheet(null);
    setItems(null);
    document.querySelector<HTMLElement>(".m-page.ns-notes-m")?.scrollTo({ top: 0 });
  }, [key]);

  const groups = useMemo(() => (items && key ? groupTaggedItems(items, key, nameOf) : null), [items, key, nameOf]);

  // 磨光① 返回層（契約 §1.5）：清單頁＝子頁，返回＝有「回到剛才」就回去（可跨 tab）、否則同「‹ 荷札」；
  //   ⋯／併入／刪除確認（本地 sheet）與併入確認（store 的 pendingPlan）各自一層 sheet＝同「取消」。改名是行內，不登記
  useBackLayer(
    "notes.tagPage",
    key !== null,
    () => {
      const st = useTagStore.getState();
      if (st.back) st.goBack();
      else st.select(null);
    },
    "page",
  );
  useBackLayer("notes.tagPage.sheet", sheet !== null, () => setSheet(null));
  useBackLayer("notes.tagPage.pending", !!pendingPlan?.ok, () => useTagStore.getState().cancelPending());

  if (!key) return null;

  const openMenu = () => setSheet("menu");
  const askDelete = () => {
    const plan = removePlan(key);
    if (!plan || !plan.ok) {
      setSheet(null);
      return;
    }
    const bodies = (items ?? []).flatMap((it) => (it.kind === "note" ? [it.note.body] : []));
    const t = deleteConfirmText(plan, deleteExample(bodies, plan));
    setSheet({ kind: "delete", plan, title: t.title, body: t.body });
  };

  const hasKids = !!node && node.children.length > 0;
  const confirmText = pendingPlan && pendingPlan.ok ? mergeConfirmText(pendingPlan) : null;

  return (
    <div className="ns-notes-mtagpage">
      <div className="ns-notes-mback">
        <button type="button" className="b" onClick={() => select(null)}>
          <IconLeft />
          荷札
        </button>
        {back && (
          <button type="button" className="b ns-notes-mbackto" onClick={goBack}>
            <IconLeft size={14} />
            回到剛才<span className="lbl">{back.label}</span>
          </button>
        )}
      </div>

      <MobileTagNotice />

      {!node ? (
        index ? (
          <p className="ns-notes-mtagempty">這個荷札已經不在了（被改名、併入或刪除）</p>
        ) : (
          <MTagLoading className="ns-notes-mtagempty" failed={indexFailed} onRetry={retryTagIndex} />
        )
      ) : (
        <>
          <header className="ns-notes-mtagview">
            {renaming && renaming.key === key ? (
              <RenameBox tagKey={key} />
            ) : (
              <div className="ns-notes-mtagtitle">
                <BigTag tagKey={key} name={node.name} virtual={!node.real} onParent={(k) => select(k)} />
                <button
                  type="button"
                  className="ns-notes-mdots"
                  aria-label="荷札動作（改名、併入、刪除）"
                  aria-haspopup="dialog"
                  onClick={openMenu}
                >
                  <IconDots />
                </button>
              </div>
            )}
            <p className="ns-notes-mtagcount">
              {!node.real && <span className="virt">虛資料夾</span>}
              掛著 <b>{node.total}</b> 處{hasKids && "・含子荷札"}
            </p>
          </header>

          {!groups ? (
            <MTagLoading className="ns-notes-mtagempty" failed={listFailed} onRetry={() => setListTry((n) => n + 1)} />
          ) : !items?.length ? (
            <p className="ns-notes-mtagempty">還沒有東西掛著這個荷札</p>
          ) : (
            <div className="ns-notes-mtaglist">
              {(groups.nodes.open.length > 0 || groups.nodes.done.length > 0) && (
                <section className="ns-notes-mtaggroup">
                  <h4>
                    車票・列車車廂<span className="n">{groups.nodes.open.length + groups.nodes.done.length}</span>
                    <span className="rule" />
                  </h4>
                  <ul>
                    {groups.nodes.open.map((it) => (
                      <ItemRow key={it.id} it={it} tagKey={key} onOpenNote={onOpenNote} />
                    ))}
                  </ul>
                  {groups.nodes.done.length > 0 && (
                    <>
                      <button
                        type="button"
                        className="ns-notes-mdonefold"
                        aria-expanded={doneOpen}
                        onClick={() => setDoneOpen((v) => !v)}
                      >
                        <IconCaretRight size={11} />
                        已完成 <span className="n">{groups.nodes.done.length}</span>
                      </button>
                      {doneOpen && (
                        <ul className="is-done">
                          {groups.nodes.done.map((it) => (
                            <ItemRow key={it.id} it={it} tagKey={key} onOpenNote={onOpenNote} />
                          ))}
                        </ul>
                      )}
                    </>
                  )}
                </section>
              )}
              <Group title="筆記" rows={groups.notes} tagKey={key} onOpenNote={onOpenNote} />
              <Group title="日記" rows={groups.diaries} tagKey={key} onOpenNote={onOpenNote} />
              <OtherGroups rows={groups.other} tagKey={key} onOpenNote={onOpenNote} />
            </div>
          )}
        </>
      )}

      {sheet === "menu" && node && (
        <MobileTagActionSheet
          title={`#${node.name}`}
          onClose={() => setSheet(null)}
          items={[
            {
              label: "改名",
              onClick: () => {
                setSheet(null);
                startRename(key);
              },
            },
            { label: "併入…", onClick: () => setSheet("merge") },
            { label: "刪除", danger: true, onClick: askDelete },
          ]}
        />
      )}
      {sheet === "merge" && (
        <MobileTagMergeSheet
          fromKey={key}
          onClose={() => setSheet(null)}
          onPick={(target) => {
            setSheet(null);
            void mergeInto(key, target);
          }}
        />
      )}
      {sheet && typeof sheet === "object" && sheet.kind === "delete" && (
        <MobileTagConfirmSheet
          title={sheet.title}
          body={sheet.body}
          primary="刪除"
          danger
          onCancel={() => setSheet(null)}
          onConfirm={() => {
            const plan = sheet.plan;
            setSheet(null);
            void confirmRemove(plan);
          }}
        />
      )}
      {confirmText && (
        <MobileTagConfirmSheet
          title={confirmText.title}
          body={confirmText.body}
          primary="併入"
          onCancel={cancelPending}
          onConfirm={() => void confirmRename()}
        />
      )}
    </div>
  );
}

/* ═══ 頁頭大牌：父層段可點（＝看父層） ═══ */

function BigTag({ tagKey, name, virtual, onParent }: { tagKey: string; name: string; virtual: boolean; onParent(key: string): void }) {
  const { parents, last } = tagDisplayParts(name);
  const keys = segsOf(tagKey);
  return (
    <span className={"ns-notes-mtag lg" + (virtual ? " virtual" : "")}>
      <span className="ns-notes-mtag-nm">
        {parents.map((p, i) => (
          <span key={i} className="seg">
            {i > 0 && <i className="sl">/</i>}
            <button type="button" className="pa" onClick={() => onParent(keys.slice(0, i + 1).join("/"))} aria-label={`看父層 #${parents.slice(0, i + 1).join("/")}`}>
              {p}
            </button>
          </span>
        ))}
        <span className="seg">
          {parents.length > 0 && <i className="sl">/</i>}
          <span className="la">{last}</span>
        </span>
      </span>
    </span>
  );
}

/* ═══ 改名列 ═══ */

function RenameBox({ tagKey }: { tagKey: string }) {
  const index = useTagStore((s) => s.index);
  const renaming = useTagStore((s) => s.renaming);
  const setRenameDraft = useTagStore((s) => s.setRenameDraft);
  const commitRename = useTagStore((s) => s.commitRename);
  const cancelRename = useTagStore((s) => s.cancelRename);
  const composing = useRef(false);
  const draft = renaming?.draft ?? "";
  const plan = useMemo(() => (index ? planRename(index, tagKey, draft) : null), [index, tagKey, draft]);

  let preview: { text: string; err?: boolean; warn?: string } = { text: "" };
  if (plan) {
    if (!plan.ok) preview = { text: plan.reason, err: true };
    else if (plan.same) preview = { text: plan.nameOnly ? "只改寫法（大小寫），掛著的東西不動" : "名稱沒有變" };
    else {
      preview = { text: renameImpact(plan) };
      if (plan.rootConflict) preview.warn = `#${plan.rootConflict.name} 已經存在——按確定會先問要不要併入`;
      else if (plan.conflicts.length) preview.warn = `底下有 ${plan.conflicts.length} 個和既有的同名——按確定會先問要不要併入`;
    }
  }

  const commit = () => void commitRename();
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229 || composing.current) return;
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelRename();
    }
  };

  return (
    <div className="ns-notes-mrename">
      <label className="ns-notes-mrenamein">
        <i aria-hidden>#</i>
        <input
          value={draft}
          onChange={(e) => setRenameDraft(e.target.value)}
          onKeyDown={onKey}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          aria-label="新名稱（打 / 可以搬層級）"
          autoFocus
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="done"
        />
      </label>
      <p className={"ns-notes-mimpact" + (preview.err ? " is-err" : "")} aria-live="polite">
        {preview.text}
        {preview.warn && (
          <>
            <br />
            <span className="warn">{preview.warn}</span>
          </>
        )}
      </p>
      <div className="btns">
        <button type="button" className="ns-notes-mbtn primary" onClick={commit} disabled={!plan || !plan.ok}>
          確定
        </button>
        <button type="button" className="ns-notes-mbtn" onClick={cancelRename}>
          取消
        </button>
      </div>
    </div>
  );
}

/* ═══ 清單 ═══ */

function Group({ title, rows, tagKey, onOpenNote }: { title: string; rows: GroupedTaggedItem[]; tagKey: string; onOpenNote(id: string): void }) {
  if (!rows.length) return null;
  return (
    <section className="ns-notes-mtaggroup">
      <h4>
        {title}
        <span className="n">{rows.length}</span>
        <span className="rule" />
      </h4>
      <ul>
        {rows.map((it) => (
          <ItemRow key={it.kind + it.id} it={it} tagKey={tagKey} onOpenNote={onOpenNote} />
        ))}
      </ul>
    </section>
  );
}

function ItemRow({ it, tagKey, onOpenNote, desc }: { it: GroupedTaggedItem; tagKey: string; onOpenNote(id: string): void; desc?: TagEntityRow | null }) {
  const routes = useNodeStore((s) => s.routes);
  const dayStartHour = useUiStore((s) => s.dayStartHour);

  if (it.kind === "node") {
    const n = it.node;
    const route = n.route_id ? (routes.find((r) => r.id === n.route_id) ?? null) : null;
    const done = n.status === "done";
    return (
      <li>
        <button type="button" className={"ns-notes-mtagitem node" + (done ? " done" : "")} onClick={() => void goNode(it.id)}>
          <span className="main">
            <span className="l1">
              <RouteDot route={route} />
              <span className="nm">{n.name}</span>
              {n.kind !== "ticket" && <span className="kd">{KIND_LABEL[n.kind as NodeKind] ?? n.kind}</span>}
            </span>
            {it.rel && <span className="rel"><TagName name={it.rel} /></span>}
          </span>
          {n.scheduled_on && <span className="dt">{fmtShortDay(n.scheduled_on)}</span>}
          {done && (
            <span className="ns-notes-msumi" aria-label="済">
              済
            </span>
          )}
        </button>
      </li>
    );
  }
  if (it.kind === "note") {
    const nt = it.note;
    const sn = snippetAround(nt.body, it.matched, 12);
    const snip = (
      <span className="sn">
        {sn.pre} {sn.tag && <b>{sn.tag}</b>} {sn.post}
      </span>
    );
    if (nt.kind === "diary") {
      const day = nt.entry_date ?? dayKeyOf(nt.noted_at, dayStartHour);
      return (
        <li>
          <button type="button" className="ns-notes-mtagitem diary" onClick={() => goDiary(it.id, day)}>
            <span className="bd">
              <span className="dd">{fmtShortDay(day)}</span>
              <span className="wk">（{weekdayZh(day)}）</span>
            </span>
            <span className="main">
              {it.rel && <span className="rel"><TagName name={it.rel} /></span>}
              {snip}
            </span>
          </button>
        </li>
      );
    }
    return (
      <li>
        <button type="button" className="ns-notes-mtagitem note" onClick={() => void goNote(it.id, onOpenNote)}>
          <span className="main">
            <span className="l1">
              <span className="nm">{noteTitle(nt)}</span>
            </span>
            {it.rel && <span className="rel"><TagName name={it.rel} /></span>}
            {snip}
          </span>
          <span className="dt">{fmtShortDay(dayKeyOf(nt.noted_at, dayStartHour))}</span>
        </button>
      </li>
    );
  }
  // 別線的實體：有登記 describe（時刻表⑥ 0-6）＝那條線給的字、有 open 就能點；沒登記＝本線不認得，畫成不可點的一列
  void tagKey;
  if (desc?.open) {
    const open = desc.open;
    return (
      <li>
        <button type="button" className="ns-notes-mtagitem other" onClick={() => open()}>
          <span className="main">
            <span className="nm">{desc.label}</span>
            {it.rel && <span className="rel"><TagName name={it.rel} /></span>}
            {desc.sub && <span className="sn">{desc.sub}</span>}
          </span>
        </button>
      </li>
    );
  }
  return (
    <li>
      <div className="ns-notes-mtagitem other">
        <span className="main">
          <span className="nm">{desc ? desc.label : it.entityType}</span>
          {it.rel && <span className="rel"><TagName name={it.rel} /></span>}
          {desc?.sub && <span className="sn">{desc.sub}</span>}
        </span>
      </div>
    </li>
  );
}

/** 別線實體的幾段（時刻表⑥ 0-6；沒有任何線登記＝一段「別處」，跟插槽之前的 `<Group title="別處">` 畫得一樣） */
function OtherGroups({ rows, tagKey, onOpenNote }: { rows: GroupedTaggedItem[]; tagKey: string; onOpenNote(id: string): void }) {
  const sections = useOtherSections(rows, "mobile");
  return (
    <>
      {sections.map((sec) =>
        sec.rows.length ? (
          <section key={sec.title} className="ns-notes-mtaggroup">
            <h4>
              {sec.title}
              <span className="n">{sec.rows.length}</span>
              <span className="rule" />
            </h4>
            <ul>
              {sec.rows.map(({ it, row }) => (
                <ItemRow key={it.kind + it.id} it={it} tagKey={tagKey} onOpenNote={onOpenNote} desc={row} />
              ))}
            </ul>
          </section>
        ) : null,
      )}
    </>
  );
}

/* ═══ 點一列：跳過去 ═══ */

/**
 * 車票・列車車廂：走核心的手機跳轉 `jumpToNodeMobile`（磨光① A7：今日頁捲到那張票、路線圖展開到它；邊界同桌機 jumpToNode）。
 * 沒日期、沒路線的臨時券＝核心的收件匣請求（`revealInbox`）：MobileNotes 換到收件匣段、選中、捲到它。
 */
async function goNode(id: string): Promise<void> {
  const node = await nodeRepo.getNode(id).catch(() => null);
  if (!node) {
    useUiStore.getState().showToast({ message: "找不到這張票（可能已經刪除）" });
    return;
  }
  await jumpToNodeMobile(node);
}

/** 筆記：清掉篩選與搜尋（不然列表裡可能沒有它）→ 筆記段整頁；收件匣裡的筆記 → 收件匣段選中 */
async function goNote(id: string, onOpenNote: (id: string) => void): Promise<void> {
  const ns = useNotesStore.getState();
  const q = ns.notesQuery;
  if (q.routeId || (q.query ?? "").trim()) await ns.setNotesQuery({});
  const st = useNotesStore.getState();
  if (!st.notes.some((n) => n.id === id) && st.inboxNotes.some((n) => n.id === id)) {
    st.setSection("inbox");
    st.selectInbox({ kind: "note", id });
    return;
  }
  st.setSection("notes");
  onOpenNote(id);
}

function goDiary(id: string, day: string): void {
  const ns = useNotesStore.getState();
  ns.openDiaryAt(day);
  ns.selectDiaryEntry(id);
}
