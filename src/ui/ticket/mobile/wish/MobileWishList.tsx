/**
 * MobileWishList——售票口手機的「願望」分頁（D-票-69；手機席；原型 6a-mobile、6-買了-mobile）。
 * MobileTicketOffice 在 `view === "wish"` 時畫它（分頁籤列第四格「願望」，跟清單／月曆／統計同一層、不登記返回層）。
 *
 * 由上而下：
 *   頁首一行「想買 N 件・合計約 X」（沒估價的不算進合計，有的話補「（N 件沒估）」；全部沒估只寫件數）
 *   → 一張紙卡：頂端一列直接加（「想買什麼…」「大概多少」「＋ 加入」；Enter＝加入，加完焦點留在名稱欄）
 *     → 想買清單（position 順序）：每列＝抓手・名稱／備註・「約 7,800」・「買了」。**列上不顯示荷札**（全 App 規矩）
 *        點列＝底部面板改（MobileWishSheet：名稱、金額、備註、分類、荷札、刪除）；長按 400ms 浮起拖曳排序（共用 dragReorder，
 *        寫入＝store.moveWishTo「搬到第 k 個」；放開位置用鄰居錨換算，同步中途重載也不會落錯格）
 *        「買了」＝store.buyWish：開記一筆、金額／備註＝名稱／分類／荷札預填，存了這一項移到已買
 *     → 「已買 N 件 ›　花了 X」摺起來；攤開每列「名稱　11/3 花了 7,800」，點了跳到那一筆帳
 * 刪除在面板裡（toast＋復原，store.deleteWish）。拖曳的替代入口＝面板裡的「上移／下移」（觸控也點得到、讀屏也找得到）。
 * 返回層：改願望的面板＝本檔 useBackLayer("ticket.wish.sheet")，面板 MSheet 給同一個 backId 合併成一層。
 * 樣式在 ticket-4-mobile.css（`.ns-tk-mw-*`；桌機的願望頁是 `.ns-tk-wish*`，兩殼不共用 class）。
 */
import { useEffect, useRef, useState } from "react";
import { TK_TEXT, useTicketStore } from "../../../../store/ticketStore";
import { useBackLayer } from "../../../mobile/backStack";
import { useDragReorder, indexOfAnchor } from "../../../common/dragReorder";
import { MAIN_CURRENCY, moneyText, type WishRow } from "../../../../domain/ticket";
import { shortDay } from "../../../../domain/ticketView";
import { IconPlus, useImeGuard } from "../mobileBits";
import { useViewSwipe } from "../MobileViewBar";
import { MobileWishSheet } from "./MobileWishSheet";

/** 拖曳抓手（六點；16 viewBox） */
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

export function MobileWishList() {
  const wish = useTicketStore((s) => s.wish);
  const curByCode = useTicketStore((s) => s.curByCode);
  const createWish = useTicketStore((s) => s.createWish);
  const buyWish = useTicketStore((s) => s.buyWish);
  const moveWishTo = useTicketStore((s) => s.moveWishTo);
  const jumpToEntry = useTicketStore((s) => s.jumpToEntry);
  const mainDec = curByCode[MAIN_CURRENCY]?.decimals ?? 2;
  const money = (minor: number) => moneyText(Math.abs(minor), mainDec);
  /** 預估是大概的數：寫整數（「約 7,800」，同桌機願望頁） */
  const about = (minor: number) => moneyText(Math.abs(minor), mainDec, { whole: true });

  /* ── 頂端加一列 ── */
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
      const row = await createWish({ name: v, amountText: amt.trim() });
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

  /* ── 改一列的面板 ── */
  const [editId, setEditId] = useState<string | null>(null);
  const editing = editId ? (wish.want.find((w) => w.id === editId) ?? null) : null;
  useBackLayer("ticket.wish.sheet", editing !== null, () => setEditId(null));
  // 那一項不在想買裡了（同步刪了、買了、另一台改了）⇒ 收起
  useEffect(() => {
    if (editId && !editing) setEditId(null);
  }, [editId, editing]);

  /* ── 長按拖曳（只排「想買」那一組） ── */
  const [listEl, setListEl] = useState<HTMLUListElement | null>(null);
  useDragReorder({
    root: listEl,
    items: wish.want.map((w) => ({ id: w.id })),
    onDrop: (ids, place) => {
      if (place.kind !== "slot") return;
      const latest = useTicketStore.getState().wish.want.map((w) => w.id);
      const at = indexOfAnchor(latest, ids, { after: place.after, before: place.before });
      if (at !== null) void moveWishTo(ids[0], at);
    },
  });

  const [boughtOpen, setBoughtOpen] = useState(false);
  const n = wish.want.length;
  // 左右滑換分頁（同清單／月曆／統計）
  const rootRef = useRef<HTMLDivElement | null>(null);
  useViewSwipe(rootRef);

  const row = (w: WishRow) => (
    <li key={w.id} className="ns-tk-mw-row" data-drag-id={w.id}>
      <span className="grip" aria-hidden>
        <IconGrip />
      </span>
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
        <span className="amt">
          {w.amount_minor !== null ? (
            <>
              <small>約</small>
              {about(w.amount_minor)}
            </>
          ) : (
            <small className="none">沒估</small>
          )}
        </span>
      </div>
      <button type="button" className="ns-btn btn-ghost buy" aria-label={`買了「${w.name}」：記一筆`} onClick={() => void buyWish(w.id)}>
        買了
      </button>
    </li>
  );

  return (
    <div className="ns-tk-mw" ref={rootRef}>
      <p className="ns-tk-mw-sum">
        {/* 全部沒估價只寫件數；有些沒估補「（N 件沒估）」（字同桌機願望頁） */}
        {n === 0
          ? wish.bought.length > 0
            ? "想買的都買了"
            : "還沒有想買的東西"
          : wish.unpriced === n
            ? `想買 ${n} 件`
            : TK_TEXT.wishHead(n, about(wish.wantTotal))}
        {n > 0 && wish.unpriced > 0 && wish.unpriced < n && <span className="un">（{wish.unpriced} 件沒估）</span>}
      </p>
      <div className="ns-tk-mbook ns-tk-mw-card">
        <div className="ns-tk-mw-add">
          <input
            ref={nameRef}
            className="nm"
            value={name}
            placeholder="想買什麼…"
            aria-label="想買什麼"
            autoComplete="off"
            enterKeyHint="done"
            onChange={(e) => setName(e.target.value)}
            {...ime}
          />
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
          <button type="button" className="ns-btn btn-ghost add" disabled={busy || name.trim() === ""} onClick={() => void add()}>
            <IconPlus size={12} />
            加入
          </button>
        </div>
        {n > 0 && (
          <ul className="ns-tk-mw-list" ref={setListEl} aria-label="想買">
            {wish.want.map(row)}
          </ul>
        )}
        {wish.bought.length > 0 && (
          <div className="ns-tk-mw-bought">
            <button type="button" className="tog" aria-expanded={boughtOpen} onClick={() => setBoughtOpen(!boughtOpen)}>
              <span>已買 {wish.bought.length} 件</span>
              <svg className="chev" width={12} height={12} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M6 3.5l4.5 4.5L6 12.5" />
              </svg>
              <span className="r">花了 {money(wish.spent)}</span>
            </button>
            {boughtOpen && (
              <ul>
                {wish.bought.map(({ wish: w, entry }) => (
                  <li key={w.id}>
                    <button type="button" aria-label={`看「${w.name}」那一筆帳`} onClick={() => void jumpToEntry(entry.id)}>
                      <span className="nm">{w.name}</span>
                      <span className="d">
                        {shortDay(entry.occurred_on)} 花了 <b>{money(entry.main_minor)}</b>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
      {editing && <MobileWishSheet wish={editing} index={wish.want.indexOf(editing)} count={n} onClose={() => setEditId(null)} />}
    </div>
  );
}
