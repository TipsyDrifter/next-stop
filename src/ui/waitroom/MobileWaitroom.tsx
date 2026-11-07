/**
 * 候車室頁（手機；壬 D-主-511～520；原型 prototypes/壬-候車室-對照.html 手機段）。
 * 照車庫前例：不上 tab bar，從「更多」頁「站內」一段進來（D-主-512），頂帶左邊「‹」回進來前那一格（MobileShell）。
 * 手感照售票口手機願望清單（MobileWishList）搬過來；資料在 tk_wishes＋wr_kinds（D-主-516、519）。
 *
 *   div.m-page.ns-waitroom-m
 *     ├ 頁首一行「等車 N 件 ・ 想買合計約 X」＋右邊「管番線」（KindManagerSheet）
 *     └ 一張紙卡
 *         ├ 種類籤「全部｜番線…」橫捲（帶件數；單選）
 *         ├ 頂端一列直接加：種類▾・「想記什麼…」・「大概多少」（種類動作＝記一筆才有）・「＋ 加入」（Enter＝加入）
 *         ├ 篩到某個種類時「N番線・種類名」（D-主-518）
 *         ├ 等候清單：抓手・種類小章・名稱／備註／「約 X」・實現鈕（字＝動作）。列上不顯示荷札
 *         │    點列＝底部面板改（MobileWaitroomSheet：名稱、種類、預估、備註、分類、荷札、順序；底列刪除・實現・存）
 *         │    長按 400ms 浮起拖曳排序（共用 dragReorder；只在「全部」籤下，篩選時拖了說一句）
 *         │    「記一筆」＝回售票口開記一筆預填；其他動作＝再開一層底部面板（RealizeSheet），預填願望名
 *         └ 「實現了 N 件 ›　其中買的花了 X」摺起；攤開每列點了跳到那筆記錄
 * 返回層：改的面板 "core.waitroom.sheet"、實現的面板 "core.waitroom.realize"、管番線 "core.waitroom.kinds"
 * （本檔登記，面板 MSheet 給同一個 backId 合併成一層）。
 */
import { useEffect, useRef, useState } from "react";
import { useTicketStore } from "../../store/ticketStore";
import { useTagStore } from "../../store/tagStore";
import { useBackLayer } from "../mobile/backStack";
import { indexOfAnchor, useDragReorder } from "../common/dragReorder";
import { IconGear, IconPlus } from "../common/icons";
import { WISH_ACTION_LABEL, moneyText, type WishRow } from "../../domain/ticket";
import { useImeGuard } from "../ticket/dialogs/dialogBits";
import { bootWaitroom, buyFromWaitroom, gotoRealized } from "./waitroomActs";
import {
  KindChips,
  KindMark,
  PlatformLabel,
  RealizedNote,
  WaitroomStats,
  realizedAria,
  useDefaultKindId,
  useKinds,
  useMainDec,
  useShown,
  type WaitFilter,
} from "./waitroomParts";
import { MobileWaitroomSheet, RealizeSheet } from "./MobileWaitroomSheet";
import { KindManagerSheet } from "./KindManager";
import "./waitroom.css";

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

export default function MobileWaitroom() {
  const wish = useTicketStore((s) => s.wish);
  const createWish = useTicketStore((s) => s.createWish);
  const dec = useMainDec();
  const { kinds, kindById, actionOf } = useKinds();
  const [filter, setFilter] = useState<WaitFilter>("all");
  const { shown, move } = useShown(filter);
  const filtered = filter !== "all";

  useEffect(() => {
    void bootWaitroom();
    const ts = useTagStore.getState();
    if (!ts.index && !ts.loading) void ts.loadIndex();
  }, []);
  // 篩的那個種類被刪了（管番線、同步）⇒ 回全部
  useEffect(() => {
    if (filter !== "all" && !kindById[filter]) setFilter("all");
  }, [filter, kindById]);

  /* ── 頂端加一列（種類預設跟著籤；全部時＝買） ── */
  const preferred = useDefaultKindId(filter);
  const [kindId, setKindId] = useState<string | null>(preferred);
  useEffect(() => setKindId(preferred), [preferred]);
  const entry = kindId ? kindById[kindId]?.action === "entry" : false;
  const [name, setName] = useState("");
  const [amt, setAmt] = useState("");
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const add = async () => {
    const v = name.trim();
    if (busy) return;
    if (v === "") {
      nameRef.current?.focus();
      return;
    }
    setBusy(true);
    try {
      const row = await createWish({ name: v, amountText: entry ? amt.trim() : "", kindId: kindId ?? undefined });
      if (!row) return; // 失敗 store 已吐 toast；字留著讓主人改
      setName("");
      setAmt("");
      nameRef.current?.focus();
    } finally {
      setBusy(false);
    }
  };
  const ime = useImeGuard((e) => {
    e.preventDefault();
    void add();
  });

  /* ── 改一列的面板、實現的面板、管番線（同時只開一個） ── */
  const [editId, setEditId] = useState<string | null>(null);
  const [realizeId, setRealizeId] = useState<string | null>(null);
  const [manageOpen, setManageOpen] = useState(false);
  const editing = editId ? (wish.want.find((w) => w.id === editId) ?? null) : null;
  const realizing = realizeId ? (wish.want.find((w) => w.id === realizeId) ?? null) : null;
  useBackLayer("core.waitroom.sheet", editing !== null, () => setEditId(null));
  useBackLayer("core.waitroom.realize", realizing !== null, () => setRealizeId(null));
  useBackLayer("core.waitroom.kinds", manageOpen, () => setManageOpen(false));
  // 那一項不在等候裡了（同步刪了、實現了、另一台改了）⇒ 收起
  useEffect(() => {
    if (editId && !editing) setEditId(null);
    if (realizeId && !realizing) setRealizeId(null);
  }, [editId, editing, realizeId, realizing]);

  /** 實現鈕：記一筆＝回售票口；其他＝開實現面板（從改的面板按的，先收改的面板） */
  const act = (w: WishRow) => {
    setEditId(null);
    if (actionOf(w) === "entry") buyFromWaitroom(w.id);
    else setRealizeId(w.id);
  };

  /* ── 長按拖曳（只在「全部」籤下） ── */
  const [listEl, setListEl] = useState<HTMLUListElement | null>(null);
  useDragReorder({
    root: listEl,
    items: shown.map((w) => ({ id: w.id })),
    canDrag: () => (filtered ? "回到「全部」再拖" : true),
    onDrop: (ids, place) => {
      if (place.kind !== "slot") return;
      const latest = useTicketStore.getState().wish.want.map((w) => w.id);
      const at = indexOfAnchor(latest, ids, { after: place.after, before: place.before });
      if (at !== null) void useTicketStore.getState().moveWishTo(ids[0], at);
    },
  });

  const [doneOpen, setDoneOpen] = useState(false);
  const n = wish.want.length;
  const empty = shown.length > 0 ? null : filtered ? "這條番線還沒有等車的事" : n === 0 && wish.bought.length > 0 ? "等車的事都實現了" : null;

  const row = (w: WishRow) => {
    const action = actionOf(w);
    const label = WISH_ACTION_LABEL[action];
    return (
      <li key={w.id} className="ns-wr-mrow" data-drag-id={w.id}>
        <span className={"grip" + (filtered ? " is-off" : "")} aria-hidden>
          <IconGrip />
        </span>
        <KindMark kind={kindById[w.kind_id]} />
        {/* 點列＝改（不用 button：長按要能從這裡起拖；共用拖曳元件在按鈕上按下不起拖） */}
        <div
          className="main"
          role="button"
          tabIndex={0}
          aria-haspopup="dialog"
          aria-label={`改「${w.name}」`}
          onClick={() => setEditId(w.id)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setEditId(w.id);
            }
          }}
        >
          <span className="nm">{w.name}</span>
          {w.note.trim() !== "" && <span className="sub">{w.note}</span>}
          {action === "entry" && (
            <span className="amt">
              {w.amount_minor !== null ? (
                <>
                  <small>約</small>
                  {moneyText(w.amount_minor, dec, { whole: true })}
                </>
              ) : (
                <small className="none">沒估</small>
              )}
            </span>
          )}
        </div>
        <button
          type="button"
          className="ns-btn btn-ghost act"
          aria-haspopup={action === "entry" ? undefined : "dialog"}
          aria-label={`${label}：「${w.name}」`}
          onClick={() => act(w)}
        >
          {label}
        </button>
      </li>
    );
  };

  return (
    <div className="m-page ns-waitroom ns-waitroom-m" aria-label="候車室">
      <div className="ns-wr-mhead">
        <p className="ns-wr-msum">
          <WaitroomStats />
        </p>
        <button type="button" className="ns-wr-mmanage" aria-haspopup="dialog" onClick={() => setManageOpen(true)}>
          <IconGear size={14} />
          管番線
        </button>
      </div>
      <div className="ns-wr-paper ns-wr-mcard">
        <KindChips value={filter} onChange={setFilter} />
        <div className={"ns-wr-madd" + (entry ? " has-amt" : "")}>
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
            value={name}
            placeholder="想記什麼…"
            aria-label="想記什麼"
            autoComplete="off"
            enterKeyHint="done"
            onChange={(e) => setName(e.target.value)}
            {...ime}
          />
          {entry && (
            <input
              className="amt"
              value={amt}
              placeholder="大概多少"
              aria-label="預估金額"
              inputMode="decimal"
              autoComplete="off"
              enterKeyHint="done"
              onChange={(e) => setAmt(e.target.value)}
              {...ime}
            />
          )}
          <button type="button" className="ns-btn btn-ghost add" disabled={busy || name.trim() === ""} onClick={() => void add()}>
            <IconPlus size={12} />
            加入
          </button>
        </div>
        <PlatformLabel filter={filter} />
        {empty && <p className="ns-wr-empty">{empty}</p>}
        {shown.length > 0 && (
          <ul className="ns-wr-mlist" ref={setListEl} aria-label="等車">
            {shown.map(row)}
          </ul>
        )}
        {wish.bought.length > 0 && (
          <div className="ns-wr-done is-m">
            <button type="button" className="tog" aria-expanded={doneOpen} onClick={() => setDoneOpen(!doneOpen)}>
              <span>實現了 {wish.bought.length} 件</span>
              <svg className="chev" width={12} height={12} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M6 3.5l4.5 4.5L6 12.5" />
              </svg>
              {wish.spent > 0 && <span className="r">其中買的花了 {moneyText(wish.spent, dec)}</span>}
            </button>
            {doneOpen && (
              <ul aria-label="實現了">
                {wish.bought.map((r) => (
                  <li key={r.wish.id}>
                    <button type="button" aria-label={realizedAria(r)} onClick={() => void gotoRealized(r)}>
                      <span className="ns-wr-sumi" aria-hidden>
                        済
                      </span>
                      <span className="nm">{r.wish.name}</span>
                      <span className="d">
                        <RealizedNote r={r} dec={dec} />
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
      {editing && (
        <MobileWaitroomSheet
          wish={editing}
          index={shown.indexOf(editing)}
          count={shown.length}
          onMove={(dir) => move(editing.id, dir)}
          onAct={(kindId) => act({ ...editing, kind_id: kindId })}
          onClose={() => setEditId(null)}
        />
      )}
      {realizing &&
        (() => {
          const a = actionOf(realizing);
          return a === "entry" ? null : <RealizeSheet wish={realizing} action={a} onClose={() => setRealizeId(null)} />;
        })()}
      {manageOpen && <KindManagerSheet onClose={() => setManageOpen(false)} />}
    </div>
  );
}
