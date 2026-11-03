/**
 * WishPage——售票口桌機「願望」分頁的本體（售票口④ D-票-69；桌機席）。原型 prototypes/售票口④-src/questions.js 題六
 * （截圖 6a-desktop、6-合計-有、6-買了-desktop）。頁首（大標「願望清單」、那行「想買 N 件・合計約 X」）在 TicketLedger。
 *
 *   div.ns-tk-wish（放在 .ns-tk-book 那張霧面紙裡）
 *   ├─ .ns-tk-wishadd       頂端一列直接加：「想買什麼…」「大概多少」「＋ 加入」（Enter 也是加入；名稱空著不能加）
 *   ├─ ul.ns-tk-wishlist    想買（position 順序）：把手・名稱＋備註・「約 7,800」・「買了」（列上不顯示荷札：D-票-74 全 App 規矩，同手機）
 *   │     點列（或聚焦後 Enter）＝在列下攤開改：名稱、預估、備註、分類、荷札（荷札＝實體模式，立刻寫）；刪除（toast 可復原）
 *   │     拖曳排序（共用 dragReorder；放開對最新清單換算 indexOfAnchor → moveWishTo）；鍵盤 Alt+↑↓ 同義
 *   │     右鍵＝跟列上動作同一份（買了、修改、上移、下移、刪除；共用 rowContextMenu）
 *   └─ .ns-tk-bought        「已買 N 件 ›」摺起；攤開一行一件：名稱・「11/2 花了 4,280」（實際那筆的主幣別金額）；點名稱跳到那一筆
 * 「買了」＝store.buyWish（開記一筆預填）；記一筆那張大票撕線下一行寫「從願望清單帶入…」（TicketPanel）。
 * 願望的分類只有支出（買東西）。只讀 store、只叫 store 的動作。
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { useTicketStore } from "../../../store/ticketStore";
import { useTagStore } from "../../../store/tagStore";
import { MAIN_CURRENCY, moneyText, type WishRow } from "../../../domain/ticket";
import { shortDay } from "../../../domain/ticketView";
import { TK_TAG_WISH } from "../../../domain/ticketTags";
import { indexOfAnchor, useDragReorder } from "../../common/dragReorder";
import { rowContextMenu, type ContextMenuSpec } from "../../common/contextMenu";
import { CommitInput } from "../../common/fields";
import { EntityTagField } from "../../common/EntityTagField";
import { useImeGuard } from "../dialogs/dialogBits";
import { TkIcon } from "../TicketLedger";
import { CategoryCombo } from "../TicketPanel";
import "../ticket-4.css";

/** 主幣別的小數位（願望金額一律主幣別） */
function useMainDec(): number {
  return useTicketStore((s) => s.curByCode[MAIN_CURRENCY]?.decimals ?? 2);
}

/** 荷札 index 沒載就載一次（編輯區的荷札欄要它） */
function useTagIndex() {
  const index = useTagStore((s) => s.index);
  useEffect(() => {
    const st = useTagStore.getState();
    if (!st.index && !st.loading) void st.loadIndex();
  }, []);
  return index;
}

/**
 * 頁首那行（D-票-69）：「想買 3 件 ・ 合計約 18,300」。字同 AIDS_TEXT.wishHead，但數字加粗、間隔照頁首其他統計行（「支出 X ・ 收入 Y」），
 * 所以這裡自己組；有沒估價的補「（N 件沒估）」，全都沒估就不寫合計
 */
export function WishHeadStats() {
  const wish = useTicketStore((s) => s.wish);
  const dec = useMainDec();
  const priced = wish.want.length - wish.unpriced;
  return (
    <>
      想買 <b>{wish.want.length}</b> 件
      {priced > 0 && (
        <>
          {" "}・ 合計約 <b>{moneyText(wish.wantTotal, dec, { whole: true })}</b>
        </>
      )}
      {wish.unpriced > 0 && priced > 0 && <span className="ns-tk-wishunpriced">（{wish.unpriced} 件沒估）</span>}
    </>
  );
}

export function WishPage() {
  const wish = useTicketStore((s) => s.wish);
  const draftWishId = useTicketStore((s) => (s.panel.kind === "new" ? (s.draft?.wishId ?? null) : null));
  const moveWishTo = useTicketStore((s) => s.moveWishTo);
  useTagIndex();
  const dec = useMainDec();
  const [openId, setOpenId] = useState<string | null>(null);
  const [boughtOpen, setBoughtOpen] = useState(false);
  const [listEl, setListEl] = useState<HTMLUListElement | null>(null);

  // 攤開的那一個被刪掉／買了（不在想買裡了）⇒ 收起
  useEffect(() => {
    if (openId && !wish.want.some((w) => w.id === openId)) setOpenId(null);
  }, [wish.want, openId]);

  const wantIds = useMemo(() => wish.want.map((w) => w.id), [wish.want]);
  useDragReorder({
    root: listEl,
    items: wantIds.map((id) => ({ id })),
    canDrag: (id) => (id === openId ? "先收起編輯再拖" : true),
    onDrop: (ids, place) => {
      if (place.kind !== "slot") return;
      const latest = useTicketStore.getState().wish.want.map((w) => w.id);
      const at = indexOfAnchor(latest, ids[0], place);
      if (at === null) return;
      void moveWishTo(ids[0], at);
    },
  });

  return (
    <div className="ns-tk-wish">
      <WishAdd />
      {wish.want.length === 0 && <p className="ns-tk-wishempty">{wish.bought.length ? "想買的都買了" : "還沒有想買的東西"}</p>}
      {wish.want.length > 0 && (
        <ul ref={setListEl} className="ns-tk-wishlist" aria-label="想買">
          {wish.want.map((w, i) => (
            <WishItem
              key={w.id}
              w={w}
              dec={dec}
              on={draftWishId === w.id}
              open={openId === w.id}
              first={i === 0}
              last={i === wish.want.length - 1}
              index={i}
              onToggle={(open) => setOpenId(open ? w.id : null)}
            />
          ))}
        </ul>
      )}
      {wish.bought.length > 0 && (
        <div className="ns-tk-bought">
          <button type="button" aria-expanded={boughtOpen} onClick={() => setBoughtOpen(!boughtOpen)}>
            已買 {wish.bought.length} 件
            <TkIcon name={boughtOpen ? "caret" : "right"} size={12} />
            <span className="r">花了 {moneyText(wish.spent, dec)}</span>
          </button>
          {boughtOpen && (
            <ul aria-label="已買">
              {wish.bought.map(({ wish: bw, entry }) => (
                <li key={bw.id}>
                  <span aria-hidden />
                  <button
                    type="button"
                    className="nm"
                    title="看這一筆帳"
                    onClick={() => void useTicketStore.getState().jumpToEntry(entry.id)}
                  >
                    {bw.name}
                  </button>
                  <span className="d">
                    {shortDay(entry.occurred_on)} 花了 <b>{moneyText(entry.main_minor, dec)}</b>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/* ───────── 頂端「想買什麼…／大概多少／＋ 加入」 ───────── */

function WishAdd() {
  const createWish = useTicketStore((s) => s.createWish);
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
      const row = await createWish({ name: name.trim(), amountText: amt });
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
    <div className="ns-tk-wishadd" onCompositionStart={ime.onCompositionStart} onCompositionEnd={ime.onCompositionEnd}>
      <input
        ref={nameRef}
        placeholder="想買什麼…"
        aria-label="想買什麼"
        autoComplete="off"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={ime.onKeyDown}
      />
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
      <button type="button" className="ns-btn ns-btn--sm btn-ghost" disabled={busy || !name.trim()} onClick={() => void add()}>
        <TkIcon name="plus" size={12} />
        加入
      </button>
    </div>
  );
}

/* ───────── 一列願望 ───────── */

/** 右鍵選單與列上動作同一份 */
function wishMenu(w: WishRow, index: number, count: number, toggle: (open: boolean) => void, open: boolean): ContextMenuSpec {
  const s = useTicketStore.getState();
  return {
    overline: { zh: "願望", latin: "Wish" },
    label: w.name,
    items: [
      { key: "buy", label: "買了", onSelect: () => void s.buyWish(w.id) },
      { key: "edit", label: open ? "收起" : "修改…", onSelect: () => toggle(!open) },
      { key: "up", label: "上移", disabled: index === 0, why: "已經在最上面", cut: true, onSelect: () => void s.moveWishTo(w.id, index - 1) },
      { key: "down", label: "下移", disabled: index === count - 1, why: "已經在最下面", onSelect: () => void s.moveWishTo(w.id, index + 1) },
      { key: "delete", label: "刪除", danger: true, cut: true, onSelect: () => void s.deleteWish(w.id) },
    ],
  };
}

function WishItem(props: {
  w: WishRow;
  dec: number;
  /** 正在記一筆的就是它（「買了」開的） */
  on: boolean;
  open: boolean;
  first: boolean;
  last: boolean;
  index: number;
  onToggle(open: boolean): void;
}) {
  const { w, dec, on, open, first, last, index, onToggle } = props;
  const count = useTicketStore((s) => s.wish.want.length);
  const rowRef = useRef<HTMLLIElement>(null);
  const s = useTicketStore.getState;

  const onClick = (e: MouseEvent<HTMLLIElement>) => {
    const t = e.target as HTMLElement;
    if (t.closest("button, input, textarea, select, a, .ns-tk-wishedit")) return;
    onToggle(!open);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLLIElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const onRow = e.target === rowRef.current;
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown") && onRow) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "ArrowUp" && !first) void s().moveWishTo(w.id, index - 1);
      if (e.key === "ArrowDown" && !last) void s().moveWishTo(w.id, index + 1);
      // 列換了位置焦點還在它身上（同一個 key，React 只搬節點）
      return;
    }
    if (e.key === "Enter" && onRow) {
      e.preventDefault();
      e.stopPropagation();
      onToggle(!open);
      return;
    }
    if (e.key === "Delete" && onRow) {
      e.preventDefault();
      e.stopPropagation();
      void s().deleteWish(w.id);
      return;
    }
    if (e.key === "Escape" && open && !e.defaultPrevented) {
      // 編輯區裡的輸入框有改動時自己吃掉 Esc（還原）；沒改動才收起，不讓頁面的 Esc 把分頁切回清單
      e.preventDefault();
      e.stopPropagation();
      onToggle(false);
      rowRef.current?.focus({ preventScroll: true });
    }
  };

  return (
    <li
      ref={rowRef}
      data-drag-id={w.id}
      tabIndex={0}
      className={"ns-tk-wishrow" + (on ? " is-on" : "") + (open ? " is-open" : "")}
      onClick={onClick}
      onKeyDown={onKeyDown}
      onContextMenu={rowContextMenu(() => wishMenu(w, index, count, onToggle, open))}
    >
      <span className="grip" title="拖曳排序（Alt+↑↓）" aria-hidden>
        <TkIcon name="grip" size={14} />
      </span>
      <span className="main">
        <span className="nm">{w.name}</span>
        {w.note && (
          <span className="sub">
            <span className="nt">{w.note}</span>
          </span>
        )}
      </span>
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
      <button type="button" className="ns-btn ns-btn--sm btn-ghost buy" aria-label={`買了「${w.name}」：記一筆`} onClick={() => void s().buyWish(w.id)}>
        買了
      </button>
      {open && <WishEditor w={w} dec={dec} onClose={() => onToggle(false)} />}
    </li>
  );
}

/* ───────── 列下攤開的編輯區（即時存：離開欄位或 Enter 就送） ───────── */

function WishEditor({ w, dec, onClose }: { w: WishRow; dec: number; onClose(): void }) {
  const s = useTicketStore.getState;
  const ref = useRef<HTMLDivElement>(null);
  // 攤開時焦點落在名稱欄（鍵盤 Enter 打開的也能直接改）
  useEffect(() => {
    ref.current?.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
  }, []);
  return (
    <div ref={ref} className="ns-tk-wishedit" role="group" aria-label={`修改「${w.name}」`}>
      <div className="ns-tk-fields is-wish">
        <div className="field">
          <span className="lbl">名稱</span>
          <div>
            <CommitInput className="ns-tk-textin" value={w.name} ariaLabel="名稱" required onCommit={(name) => void s().updateWish(w.id, { name })} />
          </div>
        </div>
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
        <div className="field">
          <span className="lbl">備註</span>
          <div>
            <CommitInput className="ns-tk-textin" value={w.note} ariaLabel="備註" placeholder="備註" onCommit={(note) => void s().updateWish(w.id, { note })} />
          </div>
        </div>
        <div className="field">
          <span className="lbl">分類</span>
          <div>
            <CategoryCombo kind="expense" categoryId={w.category_id} onPick={(id) => void s().updateWish(w.id, { categoryId: id })} />
          </div>
        </div>
        <div className="field is-tags">
          <span className="lbl">荷札</span>
          <div>
            <EntityTagField entityType={TK_TAG_WISH} entityId={w.id} />
          </div>
        </div>
      </div>
      <div className="ns-tk-wishedit-foot">
        <button type="button" className="ns-btn ns-btn--sm btn-ghost ns-btn-danger ns-tk-btn" onClick={() => void s().deleteWish(w.id)}>
          刪除
        </button>
        <button type="button" className="ns-btn ns-btn--sm btn-text ns-tk-btn" onClick={onClose}>
          收起
        </button>
      </div>
    </div>
  );
}
