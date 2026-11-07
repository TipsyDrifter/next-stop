/**
 * 候車室手機的兩張底部面板（壬 D-主-514、D-主-519、D-主-520；手機席；照售票口 MobileWishSheet 的模式）。
 *
 * MobileWaitroomSheet——改一件等車的事（MobileWaitroom 點列開）：
 *   欄位：名稱・種類（番線 chip 橫捲）・預估（種類動作＝記一筆才有；主幣別，空＝沒估）・備註・分類（記一筆才有；支出分類橫捲，「不選」在最前）・荷札・順序。
 *   名稱、種類、預估、備註、分類是草稿：按「存」送一次 store.updateWish；下滑／暗幕／返回鍵＝放掉。
 *   荷札是實體模式（立刻寫；點選器 entity 模式 `ticket:wish`，toast＋復原是 tagStore 的）。
 *   順序的上移／下移是拖曳的替代入口（在籤篩過的清單裡跟鄰居換位，按一下就寫）。
 *   底列：「刪除」（toast＋復原）・實現鈕（字＝草稿種類的動作：先存草稿再走實現）・「存」。
 *   返回層："core.waitroom.sheet"（MobileWaitroom 登記）。
 *
 * RealizeSheet——開票／開路線／寫日記／記時間（D-主-515、520：點了直接開、預填願望名；欄位在 realizeFields）。
 *   底列「取消」・送出鈕。返回層："core.waitroom.realize"（MobileWaitroom 登記）。
 */
import { useMemo, useState } from "react";
import { useTicketStore } from "../../store/ticketStore";
import { useTagStore } from "../../store/tagStore";
import { MSheet } from "../common/MSheet";
import { MAIN_CURRENCY, UNCAT_EXPENSE_ID, WISH_ACTION_LABEL, categoryForest, categoryLabel, flattenForest, type WishRow } from "../../domain/ticket";
import type { WishAction } from "../../domain/ticketAids";
import { amountInputText } from "../../domain/ticketPlan";
import { TK_TAG_WISH } from "../../domain/ticketTags";
import { TagAddButton, TkTag } from "../ticket/mobile/MobileEntryParts";
import { useImeGuard } from "../ticket/dialogs/dialogBits";
import { REALIZE_TEXT, useKinds, useRealizeDraft } from "./waitroomParts";
import { RealizeFields } from "./realizeFields";

export function MobileWaitroomSheet({
  wish: w,
  index,
  count,
  onMove,
  onAct,
  onClose,
}: {
  wish: WishRow;
  /** 在籤篩過的清單裡排第幾（-1＝不在，例：剛改了種類） */
  index: number;
  count: number;
  onMove(dir: -1 | 1): void;
  /** 實現（帶草稿的種類：存完才叫，種類可能剛換過） */
  onAct(kindId: string): void;
  onClose(): void;
}) {
  const categories = useTicketStore((s) => s.categories);
  const catById = useTicketStore((s) => s.catById);
  const curByCode = useTicketStore((s) => s.curByCode);
  const updateWish = useTicketStore((s) => s.updateWish);
  const deleteWish = useTicketStore((s) => s.deleteWish);
  const tagIndex = useTagStore((s) => s.index);
  const { kinds, kindById } = useKinds();
  const mainDec = curByCode[MAIN_CURRENCY]?.decimals ?? 2;

  const [name, setName] = useState(w.name);
  const [kindId, setKindId] = useState(w.kind_id);
  const [amt, setAmt] = useState(w.amount_minor === null ? "" : amountInputText(w.amount_minor, mainDec));
  const [note, setNote] = useState(w.note);
  const [catId, setCatId] = useState<string | null>(w.category_id);
  const [busy, setBusy] = useState(false);
  const action: WishAction = kindById[kindId]?.action ?? "ticket";
  const entry = action === "entry";

  // index 是依賴：掛摘之後 keysOf 才會換
  const tagKeys = useMemo(() => (tagIndex ? useTagStore.getState().keysOf(TK_TAG_WISH, w.id) : []), [tagIndex, w.id]);
  /* 支出分類攤平成一排（同售票口願望面板：每顆寫最後兩段；未分類不列＝「不選」） */
  const cats = useMemo(
    () =>
      flattenForest(categoryForest(categories, "expense", { includeArchived: false }))
        .filter((n) => n.cat.id !== UNCAT_EXPENSE_ID)
        .map((n) => ({ id: n.cat.id, label: categoryLabel(n.cat, catById, { short: true }) })),
    [categories, catById],
  );

  /** 有改才送（實現鈕也走這裡：先存再實現） */
  const persist = async (): Promise<boolean> => {
    const v = name.trim();
    if (v === "") return false;
    const amtNow = w.amount_minor === null ? "" : amountInputText(w.amount_minor, mainDec);
    const changed = v !== w.name || kindId !== w.kind_id || note !== w.note || (entry && (amt.trim() !== amtNow || catId !== w.category_id));
    if (changed) await updateWish(w.id, entry ? { name: v, kindId, amountText: amt.trim(), note, categoryId: catId } : { name: v, kindId, note });
    return true;
  };
  const save = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (await persist()) onClose();
    } finally {
      setBusy(false);
    }
  };
  const act = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (await persist()) onAct(kindId);
    } finally {
      setBusy(false);
    }
  };

  return (
    <MSheet
      title="等車的事"
      onClose={onClose}
      backId="core.waitroom.sheet"
      className="ns-wr-msheet"
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
          <button type="button" className="ns-btn btn-ghost" disabled={busy || name.trim() === ""} onClick={() => void act()}>
            {WISH_ACTION_LABEL[action]}
          </button>
          <button type="button" className="ns-btn btn-seal" disabled={busy || name.trim() === ""} onClick={() => void save()}>
            存
          </button>
        </>
      }
    >
      <label className="ns-wr-mf">
        <span className="lbl">名稱</span>
        <input className="ns-wr-min" value={name} placeholder="想記什麼" autoComplete="off" onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="ns-wr-mf">
        <span className="lbl">種類</span>
        <div className="ns-wr-mchips" role="group" aria-label="種類">
          {kinds.map((k) => (
            <button key={k.id} type="button" className={"chip ns-chip" + (kindId === k.id ? " is-on" : "")} aria-pressed={kindId === k.id} onClick={() => setKindId(k.id)}>
              {k.name}
            </button>
          ))}
        </div>
      </div>
      {entry && (
        <label className="ns-wr-mf">
          <span className="lbl">預估</span>
          <input className="ns-wr-min is-amt" value={amt} placeholder="大概多少" inputMode="decimal" autoComplete="off" onChange={(e) => setAmt(e.target.value)} />
        </label>
      )}
      <label className="ns-wr-mf">
        <span className="lbl">備註</span>
        <input className="ns-wr-min" value={note} placeholder="備註" autoComplete="off" onChange={(e) => setNote(e.target.value)} />
      </label>
      {entry && (
        <div className="ns-wr-mf">
          <span className="lbl">分類</span>
          <div className="ns-wr-mchips" role="group" aria-label="分類">
            <button type="button" className={"chip ns-chip" + (catId === null ? " is-on" : "")} aria-pressed={catId === null} onClick={() => setCatId(null)}>
              不選
            </button>
            {cats.map((c) => (
              <button key={c.id} type="button" className={"chip ns-chip" + (catId === c.id ? " is-on" : "")} aria-pressed={catId === c.id} onClick={() => setCatId(c.id)}>
                {c.label}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="ns-wr-mf is-tags">
        <span className="lbl">荷札</span>
        <div className="tags" role="group" aria-label="荷札">
          {tagKeys.length === 0 && <span className="none">沒有掛</span>}
          {tagKeys.map((k) => (
            <TkTag key={k} name={useTagStore.getState().nameOf(k)} onRemove={() => void useTagStore.getState().detach(TK_TAG_WISH, w.id, k)} />
          ))}
          <TagAddButton onClick={() => useTagStore.getState().openPicker({ mode: "entity", entityType: TK_TAG_WISH, entityId: w.id, name: w.name })} />
        </div>
      </div>
      <div className="ns-wr-mf">
        <span className="lbl">順序</span>
        <div className="btns">
          <button type="button" className="ns-btn btn-ghost" disabled={index <= 0} onClick={() => onMove(-1)}>
            上移
          </button>
          <button type="button" className="ns-btn btn-ghost" disabled={index < 0 || index >= count - 1} onClick={() => onMove(1)}>
            下移
          </button>
        </div>
      </div>
    </MSheet>
  );
}

export function RealizeSheet({ wish: w, action, onClose }: { wish: WishRow; action: Exclude<WishAction, "entry">; onClose(): void }) {
  const d = useRealizeDraft(w, action, onClose);
  const t = REALIZE_TEXT[action];
  const ime = useImeGuard((e) => {
    e.preventDefault();
    void d.submit();
  });
  return (
    <MSheet
      title={t.title}
      onClose={onClose}
      backId="core.waitroom.realize"
      className="ns-wr-msheet"
      foot={
        <>
          <button type="button" className="ns-btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button type="button" className="ns-btn btn-seal" disabled={!d.can} onClick={() => void d.submit()}>
            {t.submit}
          </button>
        </>
      }
    >
      <RealizeFields d={d} shell="mobile" ime={ime} />
    </MSheet>
  );
}
