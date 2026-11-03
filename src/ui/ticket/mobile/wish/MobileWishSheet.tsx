/**
 * MobileWishSheet——改一個願望的底部面板（D-票-69；手機席）。MobileWishList 點列開。
 *
 * 欄位：名稱・大概多少（主幣別，空＝沒估）・備註・分類（選填；支出分類一顆一顆橫捲，「不選」在最前）・荷札・順序（上移／下移）。
 * 名稱、預估、備註、分類是草稿：按「存」送一次 store.updateWish；下滑／暗幕／返回鍵＝放掉。
 * 荷札跟帳目詳情一樣是**實體模式**（立刻寫）：× 摘下、「掛荷札」開旅客筆記的點選器 entity 模式（`ticket:wish`），toast＋復原是 tagStore 的。
 * 順序的上移／下移是拖曳的替代入口（按一下就寫，store.moveWishTo）。底列：「刪除」（toast＋復原）・「存」。
 * 返回層：呼叫端（MobileWishList）登記 "ticket.wish.sheet"，本面板 MSheet 給同一個 backId 合併成一層。
 */
import { useEffect, useMemo, useState } from "react";
import { useTicketStore } from "../../../../store/ticketStore";
import { useTagStore } from "../../../../store/tagStore";
import { MSheet } from "../../../common/MSheet";
import { MAIN_CURRENCY, UNCAT_EXPENSE_ID, categoryForest, categoryLabel, flattenForest, type WishRow } from "../../../../domain/ticket";
import { amountInputText } from "../../../../domain/ticketPlan";
import { TK_TAG_WISH } from "../../../../domain/ticketTags";
import { TagAddButton, TkTag } from "../MobileEntryParts";

export function MobileWishSheet({ wish: w, index, count, onClose }: { wish: WishRow; index: number; count: number; onClose(): void }) {
  const categories = useTicketStore((s) => s.categories);
  const curByCode = useTicketStore((s) => s.curByCode);
  const updateWish = useTicketStore((s) => s.updateWish);
  const deleteWish = useTicketStore((s) => s.deleteWish);
  const moveWishTo = useTicketStore((s) => s.moveWishTo);
  const tagIndex = useTagStore((s) => s.index);
  const mainDec = curByCode[MAIN_CURRENCY]?.decimals ?? 2;

  const [name, setName] = useState(w.name);
  const [amt, setAmt] = useState(w.amount_minor === null ? "" : amountInputText(w.amount_minor, mainDec));
  const [note, setNote] = useState(w.note);
  const [catId, setCatId] = useState<string | null>(w.category_id);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const ts = useTagStore.getState();
    if (!ts.index && !ts.loading) void ts.loadIndex();
  }, []);
  // index 是依賴：掛摘之後 keysOf 才會換
  const tagKeys = useMemo(() => (tagIndex ? useTagStore.getState().keysOf(TK_TAG_WISH, w.id) : []), [tagIndex, w.id]);

  /* 支出分類攤平成一排：照樹的順序，每顆寫最後兩段（「外食 › 午餐」；售票口④ 第二輪 D-票-78 多層時同帳簿列）；未分類不列（＝「不選」） */
  const catById = useTicketStore((s) => s.catById);
  const cats = useMemo(
    () =>
      flattenForest(categoryForest(categories, "expense", { includeArchived: false }))
        .filter((n) => n.cat.id !== UNCAT_EXPENSE_ID)
        .map((n) => ({ id: n.cat.id, label: categoryLabel(n.cat, catById, { short: true }) })),
    [categories, catById],
  );

  const save = async () => {
    const v = name.trim();
    if (busy || v === "") return;
    setBusy(true);
    try {
      await updateWish(w.id, { name: v, amountText: amt.trim(), note, categoryId: catId });
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <MSheet
      title="願望"
      onClose={onClose}
      backId="ticket.wish.sheet"
      className="ns-tk-mw-sheet"
      foot={
        <>
          <button
            type="button"
            className="ns-btn btn-ghost ns-btn-danger"
            onClick={() => {
              onClose();
              void deleteWish(w.id);
            }}
          >
            刪除
          </button>
          <button type="button" className="ns-btn btn-seal" disabled={busy || name.trim() === ""} onClick={() => void save()}>
            存
          </button>
        </>
      }
    >
      <label className="ns-tk-mf-field">
        <span className="lbl">名稱</span>
        <input className="ns-tk-mw-in" value={name} placeholder="想買什麼" autoComplete="off" onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="ns-tk-mf-field">
        <span className="lbl">預估</span>
        <input className="ns-tk-mw-in is-amt" value={amt} placeholder="大概多少" inputMode="decimal" autoComplete="off" onChange={(e) => setAmt(e.target.value)} />
      </label>
      <label className="ns-tk-mf-field">
        <span className="lbl">備註</span>
        <input className="ns-tk-mw-in" value={note} placeholder="備註" autoComplete="off" onChange={(e) => setNote(e.target.value)} />
      </label>
      <div className="ns-tk-mf-field">
        <span className="lbl">分類</span>
        <div className="ns-tk-mf-accts in-field" role="group" aria-label="分類">
          <button type="button" className={"ns-tk-mchip" + (catId === null ? " on" : "")} aria-pressed={catId === null} onClick={() => setCatId(null)}>
            不選
          </button>
          {cats.map((c) => (
            <button key={c.id} type="button" className={"ns-tk-mchip" + (catId === c.id ? " on" : "")} aria-pressed={catId === c.id} onClick={() => setCatId(c.id)}>
              {c.label}
            </button>
          ))}
        </div>
      </div>
      <div className="ns-tk-mf-field ns-tk-m4-tagrow">
        <span className="lbl">荷札</span>
        <div className="tags" role="group" aria-label="荷札">
          {tagKeys.length === 0 && <span className="none">沒有掛</span>}
          {tagKeys.map((k) => (
            <TkTag key={k} name={useTagStore.getState().nameOf(k)} onRemove={() => void useTagStore.getState().detach(TK_TAG_WISH, w.id, k)} />
          ))}
          <TagAddButton onClick={() => useTagStore.getState().openPicker({ mode: "entity", entityType: TK_TAG_WISH, entityId: w.id, name: w.name })} />
        </div>
      </div>
      <div className="ns-tk-mf-field ns-tk-mw-order">
        <span className="lbl">順序</span>
        <div className="btns">
          <button type="button" className="ns-btn btn-ghost" disabled={index <= 0} onClick={() => void moveWishTo(w.id, index - 1)}>
            上移
          </button>
          <button type="button" className="ns-btn btn-ghost" disabled={index < 0 || index >= count - 1} onClick={() => void moveWishTo(w.id, index + 1)}>
            下移
          </button>
        </div>
      </div>
    </MSheet>
  );
}
