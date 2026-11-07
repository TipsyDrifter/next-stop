/**
 * 候車室頁（桌機；壬 D-主-511～520；視覺＝prototypes/壬-候車室-對照.html 3A、題4A）。
 * 願望清單升級成全 App 核心頁：還沒決定要做、不想忘的事先在這裡等車，實現了就轉成對應模組的記錄。
 * 互動照售票口願望清單（WishPage）的手感搬過來；資料在 tk_wishes＋wr_kinds（D-主-516、519，邏輯歸主線），只叫 ticketStore 的動作。
 *
 *   section.page.ns-waitroom > .sheet（清單型 848 置中）
 *     ├─ PageHeader 頁名式：眉標 候車室／Waiting Room、大標「候車室」、stats「等車 N 件 ・ 想買合計約 X」、管理鈕「管番線」（KindManagerDialog）
 *     └─ .ns-wr-paper（霧面紙）
 *         ├─ .ns-wr-chips  種類籤「全部｜番線…」帶件數（單選、預設全部）
 *         ├─ .ns-wr-add    種類▾＋「想記什麼…」＋「大概多少」（種類動作＝記一筆才有）＋「＋ 加入」（Enter 也是；IME 組字中不送）
 *         ├─ .ns-wr-platform  篩到某個種類時「N番線・種類名」（D-主-518；「全部」不分段）
 *         ├─ ul.ns-wr-list 等候中（position 順序）：把手・種類小章・名稱＋備註・「約 X」（記一筆）・實現鈕（字＝動作，D-主-520）
 *         │     列上不顯示荷札（全 App 規矩）。點列（或聚焦後 Enter）＝列下攤開改：名稱、種類、預估（記一筆）、備註、分類（記一筆）、荷札
 *         │     實現鈕：記一筆＝回售票口開記一筆預填；開票／開路線／寫日記／記時間＝列下攤開小表單（取代編輯區的位置）
 *         │     拖曳排序（共用 dragReorder；只在「全部」籤下——篩選時順序不連續，把手淡掉、拖了說一句）；Alt+↑↓＝跟篩過清單的鄰居換位
 *         │     右鍵＝跟列上同一份動作（實現、修改、上移、下移、刪除）；Delete＝刪除（toast 可復原）
 *         └─ .ns-wr-done   「實現了 N 件 ›」摺起；攤開每列：済章・名稱（點了跳到那筆記錄）・「11/2 記了一筆 4,280」「開了路線」…
 * 進頁：bootWaitroom（warm＋refresh：別處刪了開出的記錄，這裡回到等候）。
 */
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { useTicketStore } from "../../store/ticketStore";
import { useTagStore } from "../../store/tagStore";
import { WISH_ACTION_LABEL, moneyText, type WishRow } from "../../domain/ticket";
import type { WishAction } from "../../domain/ticketAids";
import { TK_TAG_WISH } from "../../domain/ticketTags";
import { indexOfAnchor, useDragReorder } from "../common/dragReorder";
import { rowContextMenu, type ContextMenuSpec } from "../common/contextMenu";
import { CommitInput } from "../common/fields";
import { EntityTagField } from "../common/EntityTagField";
import { IconChevron, IconPlus } from "../common/icons";
import { PageHeader } from "../common/PageHeader";
import { useImeGuard } from "../ticket/dialogs/dialogBits";
import { CategoryCombo } from "../ticket/TicketPanel";
import { bootWaitroom, buyFromWaitroom, gotoRealized } from "./waitroomActs";
import {
  KindChips,
  KindMark,
  PlatformLabel,
  REALIZE_TEXT,
  RealizedNote,
  WaitroomStats,
  realizedAria,
  realizedTitle,
  useDefaultKindId,
  useKinds,
  useMainDec,
  useRealizeDraft,
  useShown,
  type WaitFilter,
} from "./waitroomParts";
import { RealizeFields } from "./realizeFields";
import { KindManagerDialog } from "./KindManager";
import "./waitroom.css";

/** 拖曳把手（六點；16 viewBox，同手機願望清單） */
const IconGrip = () => (
  <svg width={14} height={14} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <circle cx="6" cy="4" r="1.1" />
    <circle cx="10" cy="4" r="1.1" />
    <circle cx="6" cy="8" r="1.1" />
    <circle cx="10" cy="8" r="1.1" />
    <circle cx="6" cy="12" r="1.1" />
    <circle cx="10" cy="12" r="1.1" />
  </svg>
);

const DRAG_ONLY_ALL = "回到「全部」再拖";

/** 列下攤開的是哪一種：編輯區、或實現的小表單 */
type Open = { id: string; mode: "edit" | "realize" } | null;

export function WaitroomView() {
  const wish = useTicketStore((s) => s.wish);
  const draftWishId = useTicketStore((s) => (s.panel.kind === "new" ? (s.draft?.wishId ?? null) : null));
  const dec = useMainDec();
  const [filter, setFilter] = useState<WaitFilter>("all");
  const { kindById } = useKinds();
  const { shown, move } = useShown(filter);
  const [open, setOpen] = useState<Open>(null);
  const [doneOpen, setDoneOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [listEl, setListEl] = useState<HTMLUListElement | null>(null);

  useEffect(() => {
    void bootWaitroom();
    const ts = useTagStore.getState();
    if (!ts.index && !ts.loading) void ts.loadIndex();
  }, []);

  // 篩的那個種類被刪了（管番線、同步）⇒ 回全部
  useEffect(() => {
    if (filter !== "all" && !kindById[filter]) setFilter("all");
  }, [filter, kindById]);

  // 攤開的那一個不在畫面上了（刪了、實現了、改了種類被籤篩掉）⇒ 收起
  useEffect(() => {
    if (open && !shown.some((w) => w.id === open.id)) setOpen(null);
  }, [shown, open]);

  const filtered = filter !== "all";
  useDragReorder({
    root: listEl,
    items: shown.map((w) => ({ id: w.id })),
    canDrag: (id) => (filtered ? DRAG_ONLY_ALL : open?.id === id ? "先收起再拖" : true),
    onDrop: (ids, place) => {
      if (place.kind !== "slot") return;
      const latest = useTicketStore.getState().wish.want.map((w) => w.id);
      const at = indexOfAnchor(latest, ids[0], place);
      if (at === null) return;
      void useTicketStore.getState().moveWishTo(ids[0], at);
    },
  });

  const n = wish.want.length;
  const empty = shown.length > 0 ? null : filtered ? "這條番線還沒有等車的事" : n === 0 && wish.bought.length > 0 ? "等車的事都實現了" : null;

  return (
    <section className="page ns-waitroom" tabIndex={-1} aria-label="候車室">
      <div className="sheet">
        <PageHeader
          variant="name"
          overline={{ zh: "候車室", latin: "Waiting Room" }}
          title="候車室"
          stats={<WaitroomStats />}
          manage={{ label: "管番線", onClick: () => setManageOpen(true), title: "番線的名稱、順序與實現動作", haspopup: "dialog", expanded: manageOpen }}
        />
        <div className="ns-wr-paper">
          <KindChips value={filter} onChange={setFilter} />
          <WaitAdd filter={filter} />
          <PlatformLabel filter={filter} />
          {empty && <p className="ns-wr-empty">{empty}</p>}
          {shown.length > 0 && (
            <ul ref={setListEl} className="ns-wr-list" aria-label="等車">
              {shown.map((w, i) => (
                <WaitItem
                  key={w.id}
                  w={w}
                  dec={dec}
                  on={draftWishId === w.id}
                  open={open?.id === w.id ? open.mode : null}
                  first={i === 0}
                  last={i === shown.length - 1}
                  filtered={filtered}
                  onOpen={(mode) => setOpen(mode ? { id: w.id, mode } : null)}
                  onMove={(dir) => move(w.id, dir)}
                />
              ))}
            </ul>
          )}
          {wish.bought.length > 0 && (
            <div className="ns-wr-done">
              <button type="button" className="tog" aria-expanded={doneOpen} onClick={() => setDoneOpen(!doneOpen)}>
                實現了 {wish.bought.length} 件
                <IconChevron size={12} open={doneOpen} />
                {wish.spent > 0 && <span className="r">其中買的花了 {moneyText(wish.spent, dec)}</span>}
              </button>
              {doneOpen && (
                <ul aria-label="實現了">
                  {wish.bought.map((r) => (
                    <li key={r.wish.id}>
                      <span className="ns-wr-sumi" aria-hidden>
                        済
                      </span>
                      <button type="button" className="nm" title={realizedTitle(r)} aria-label={realizedAria(r)} onClick={() => void gotoRealized(r)}>
                        {r.wish.name}
                      </button>
                      <span className="d">
                        <RealizedNote r={r} dec={dec} />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>
      {manageOpen && <KindManagerDialog onClose={() => setManageOpen(false)} />}
    </section>
  );
}

/* ───────── 頂端「種類▾／想記什麼…／大概多少／＋ 加入」 ───────── */

function WaitAdd({ filter }: { filter: WaitFilter }) {
  const createWish = useTicketStore((s) => s.createWish);
  const { kinds, kindById } = useKinds();
  const preferred = useDefaultKindId(filter);
  // 種類預設跟著籤；換籤就跟著換
  const [kindId, setKindId] = useState<string | null>(preferred);
  useEffect(() => setKindId(preferred), [preferred]);
  const kind = kindId ? kindById[kindId] : undefined;
  const entry = kind?.action === "entry";
  const [name, setName] = useState("");
  const [amt, setAmt] = useState("");
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const add = async () => {
    if (busy || !name.trim()) {
      nameRef.current?.focus();
      return;
    }
    setBusy(true);
    try {
      const row = await createWish({ name: name.trim(), amountText: entry ? amt : "", kindId: kindId ?? undefined });
      if (row) {
        setName("");
        setAmt("");
        nameRef.current?.focus();
      }
    } finally {
      setBusy(false);
    }
  };
  const ime = useImeGuard((e) => {
    e.preventDefault();
    void add();
  });
  return (
    <div className={"ns-wr-add" + (entry ? " has-amt" : "")} onCompositionStart={ime.onCompositionStart} onCompositionEnd={ime.onCompositionEnd}>
      <span className="ns-select-wrap kind">
        <select className="techo-input" aria-label="種類" value={kindId ?? ""} onChange={(e) => setKindId(e.target.value)}>
          {kinds.map((k) => (
            <option key={k.id} value={k.id}>
              {k.name}
            </option>
          ))}
        </select>
      </span>
      <input
        ref={nameRef}
        className="nm"
        placeholder="想記什麼…"
        aria-label="想記什麼"
        autoComplete="off"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={ime.onKeyDown}
      />
      {entry && (
        <input
          className="amt"
          placeholder="大概多少"
          aria-label="預估金額"
          inputMode="decimal"
          autoComplete="off"
          value={amt}
          onChange={(e) => setAmt(e.target.value)}
          onKeyDown={ime.onKeyDown}
        />
      )}
      <button type="button" className="ns-btn ns-btn--sm btn-ghost" disabled={busy || !name.trim()} onClick={() => void add()}>
        <IconPlus size={12} />
        加入
      </button>
    </div>
  );
}

/* ───────── 一列 ───────── */

/** 右鍵選單與列上動作同一份 */
function waitMenu(
  w: WishRow,
  action: WishAction,
  props: { first: boolean; last: boolean; open: "edit" | "realize" | null; onOpen(mode: "edit" | "realize" | null): void; onMove(dir: -1 | 1): void },
): ContextMenuSpec {
  return {
    overline: { zh: "候車室", latin: "Waiting Room" },
    label: w.name,
    items: [
      {
        key: "act",
        label: WISH_ACTION_LABEL[action] + (action === "entry" ? "" : "…"),
        onSelect: () => (action === "entry" ? buyFromWaitroom(w.id) : props.onOpen("realize")),
      },
      { key: "edit", label: props.open === "edit" ? "收起" : "修改…", onSelect: () => props.onOpen(props.open === "edit" ? null : "edit") },
      { key: "up", label: "上移", disabled: props.first, why: "已經在最上面", cut: true, onSelect: () => props.onMove(-1) },
      { key: "down", label: "下移", disabled: props.last, why: "已經在最下面", onSelect: () => props.onMove(1) },
      { key: "delete", label: "刪除", danger: true, cut: true, onSelect: () => void useTicketStore.getState().deleteWish(w.id) },
    ],
  };
}

function WaitItem(props: {
  w: WishRow;
  dec: number;
  /** 正在記一筆的就是它（「記一筆」開的） */
  on: boolean;
  open: "edit" | "realize" | null;
  first: boolean;
  last: boolean;
  filtered: boolean;
  onOpen(mode: "edit" | "realize" | null): void;
  onMove(dir: -1 | 1): void;
}) {
  const { w, dec, on, open, first, last, filtered, onOpen, onMove } = props;
  const rowRef = useRef<HTMLLIElement>(null);
  const { kindById, actionOf } = useKinds();
  const action = actionOf(w);
  const label = WISH_ACTION_LABEL[action];

  const onClick = (e: MouseEvent<HTMLLIElement>) => {
    const t = e.target as HTMLElement;
    if (t.closest("button, input, textarea, select, a, .ns-wr-edit, .ns-wr-realize")) return;
    onOpen(open ? null : "edit");
  };
  const onKeyDown = (e: KeyboardEvent<HTMLLIElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const onRow = e.target === rowRef.current;
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown") && onRow) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "ArrowUp" && !first) onMove(-1);
      if (e.key === "ArrowDown" && !last) onMove(1);
      return;
    }
    if (e.key === "Enter" && onRow) {
      e.preventDefault();
      e.stopPropagation();
      onOpen(open ? null : "edit");
      return;
    }
    if (e.key === "Delete" && onRow) {
      e.preventDefault();
      e.stopPropagation();
      void useTicketStore.getState().deleteWish(w.id);
      return;
    }
    if (e.key === "Escape" && open && !e.defaultPrevented) {
      // 編輯區的輸入框有改動時自己吃掉 Esc（還原）；沒改動才收起
      e.preventDefault();
      e.stopPropagation();
      onOpen(null);
      rowRef.current?.focus({ preventScroll: true });
    }
  };
  const act = () => (action === "entry" ? buyFromWaitroom(w.id) : onOpen(open === "realize" ? null : "realize"));

  return (
    <li
      ref={rowRef}
      data-drag-id={w.id}
      tabIndex={0}
      className={"ns-wr-row" + (on ? " is-on" : "") + (open ? " is-open" : "")}
      onClick={onClick}
      onKeyDown={onKeyDown}
      onContextMenu={rowContextMenu(() => waitMenu(w, action, { first, last, open, onOpen, onMove }))}
    >
      <span className={"grip" + (filtered ? " is-off" : "")} title={filtered ? DRAG_ONLY_ALL : "拖曳排序（Alt+↑↓）"} aria-hidden>
        <IconGrip />
      </span>
      <KindMark kind={kindById[w.kind_id]} />
      <span className="main">
        <span className="nm">{w.name}</span>
        {w.note && <span className="sub">{w.note}</span>}
      </span>
      <span className="amt">
        {action === "entry" &&
          (w.amount_minor !== null ? (
            <>
              <small>約</small>
              {moneyText(w.amount_minor, dec, { whole: true })}
            </>
          ) : (
            <small className="none">沒估</small>
          ))}
      </span>
      <button
        type="button"
        className={"ns-btn ns-btn--sm btn-ghost act" + (open === "realize" ? " is-on" : "")}
        aria-expanded={action === "entry" ? undefined : open === "realize"}
        aria-label={`${label}：「${w.name}」`}
        onClick={act}
      >
        {label}
      </button>
      {open === "edit" && <WaitEditor w={w} dec={dec} onClose={() => onOpen(null)} />}
      {open === "realize" && action !== "entry" && <RealizePanel w={w} action={action} onClose={() => onOpen(null)} />}
    </li>
  );
}

/* ───────── 列下攤開的編輯區（即時存：離開欄位或 Enter 就送） ───────── */

function WaitEditor({ w, dec, onClose }: { w: WishRow; dec: number; onClose(): void }) {
  const s = useTicketStore.getState;
  const ref = useRef<HTMLDivElement>(null);
  const { kinds, kindById, actionOf } = useKinds();
  // 攤開時焦點落在名稱欄（鍵盤 Enter 打開的也能直接改）
  useEffect(() => {
    ref.current?.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
  }, []);
  const entry = actionOf(w) === "entry";
  return (
    <div ref={ref} className="ns-wr-edit" role="group" aria-label={`修改「${w.name}」`}>
      <div className="ns-tk-fields ns-wr-fields">
        <div className="field">
          <span className="lbl">名稱</span>
          <div>
            <CommitInput className="ns-tk-textin" value={w.name} ariaLabel="名稱" required onCommit={(name) => void s().updateWish(w.id, { name })} />
          </div>
        </div>
        <div className="field">
          <span className="lbl">種類</span>
          <div>
            <span className="ns-select-wrap">
              <select className="techo-input" aria-label="種類" value={w.kind_id} onChange={(e) => void s().updateWish(w.id, { kindId: e.target.value })}>
                {!kindById[w.kind_id] && (
                  <option value={w.kind_id} disabled>
                    （沒有種類）
                  </option>
                )}
                {kinds.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.name}
                  </option>
                ))}
              </select>
            </span>
          </div>
        </div>
        {entry && (
          <div className="field">
            <span className="lbl">預估</span>
            <div>
              <CommitInput
                className="ns-tk-textin"
                value={w.amount_minor !== null ? moneyText(w.amount_minor, dec) : ""}
                ariaLabel="預估金額"
                placeholder="大概多少（可以空著）"
                onCommit={(amountText) => void s().updateWish(w.id, { amountText })}
              />
            </div>
          </div>
        )}
        <div className="field">
          <span className="lbl">備註</span>
          <div>
            <CommitInput className="ns-tk-textin" value={w.note} ariaLabel="備註" placeholder="備註" onCommit={(note) => void s().updateWish(w.id, { note })} />
          </div>
        </div>
        {entry && (
          <div className="field">
            <span className="lbl">分類</span>
            <div>
              {/* 「管理分類」在售票口才開得了，這裡不給（manage=false） */}
              <CategoryCombo kind="expense" categoryId={w.category_id} manage={false} onPick={(id) => void s().updateWish(w.id, { categoryId: id })} />
            </div>
          </div>
        )}
        <div className="field is-tags">
          <span className="lbl">荷札</span>
          <div>
            <EntityTagField entityType={TK_TAG_WISH} entityId={w.id} />
          </div>
        </div>
      </div>
      <div className="ns-wr-foot">
        <button type="button" className="ns-btn ns-btn--sm btn-ghost ns-btn-danger" onClick={() => void s().deleteWish(w.id)}>
          刪除
        </button>
        <button type="button" className="ns-btn ns-btn--sm btn-text" onClick={onClose}>
          收起
        </button>
      </div>
    </div>
  );
}

/* ───────── 實現的小表單（D-主-515、520：點了直接開、預填願望名） ───────── */

function RealizePanel({ w, action, onClose }: { w: WishRow; action: Exclude<WishAction, "entry">; onClose(): void }) {
  const d = useRealizeDraft(w, action, onClose);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current?.querySelector<HTMLInputElement | HTMLTextAreaElement>("input, textarea");
    el?.focus({ preventScroll: true });
    el?.select();
  }, []);
  const ime = useImeGuard((e) => {
    e.preventDefault();
    void d.submit();
  });
  const t = REALIZE_TEXT[action];
  return (
    <div ref={ref} className="ns-wr-realize" role="group" aria-label={`${t.title}：「${w.name}」`}>
      <div className="ns-tk-fields ns-wr-fields">
        <RealizeFields d={d} shell="desktop" ime={ime} />
      </div>
      <div className="ns-wr-foot">
        <button type="button" className="ns-btn ns-btn--sm btn-text" onClick={onClose}>
          取消
        </button>
        <button type="button" className="ns-btn ns-btn--sm btn-seal" disabled={!d.can} onClick={() => void d.submit()}>
          {t.submit}
        </button>
      </div>
    </div>
  );
}
