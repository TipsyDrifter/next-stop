/**
 * DialogShell——置中小 dialog 的共用殼（2.3 路線 dialog／4.0 設定共用）：書封色暗幕（.techo-veil）＋浮層紙卡（.techo-card）
 * ＋標題列（overline 小標＋襯線大標＋×）＋撕線分隔（.ns-tear）；Esc／點暗幕關閉。
 * 視覺全借原型票面語彙（UI 丙-1：材質走 .techo-card 的語意層 token、字在 overlay.css 的 .ns-dialog、襯線標題）；沒有任何預設灰。
 * 保證 Esc 可關、點暗幕可關、進場淡入（@starting-style）；Tab 不出卡（UI 丙-3，見下方 useTabTrap）。
 * 焦點（磨光⑤ #100）：紙卡 tabIndex=-1，三條規則——
 *   ① 開啟：焦點不在卡內就移到卡本身（子元件 autoFocus／自己的開場聚焦優先：子的 effect 先跑，這裡看到已在卡內就不搶）。
 *      落在卡上而不是第一顆鈕：第一顆是標題列的「×」，焦點在那裡按 Enter／Space 會直接關窗（OffPageSheetHost 檔頭同理）。
 *   ② 開著：焦點掉到 body（被點的鈕重畫／卸載、點到卡外不可聚焦處）⇒ 拉回卡上。之前掉 body 時，頁面的 window 後援
 *      （時刻表 Enter＝到着）會把鍵吃走。兩條偵測：focusout 的 relatedTarget 為空、或卡內 DOM 有增刪（Chromium 移除聚焦元素
 *      不一定發 focusout），下一拍 activeElement 是 body 才拉。視窗整個失焦時 activeElement 仍是原元素，不會誤拉。
 *   ③ 關閉：焦點還給開之前的元素——還在畫面上、而且焦點此刻落空（body）才還，不搶關窗動作自己安排的去處。
 *      例外：滑鼠點開的按鈕（開窗那一刻不是 :focus-visible）不還，維持原本「掉 body、由頁面接手」——時刻表刻意不讓焦點
 *      留在鈕上（RunDock 檔頭：留著的話面板關掉後 Enter 會再按到它，而不是到着）。
 *   API 不變；五個 host（設定、`?`、路線對話框、時刻表面板、售票口對話框）自己的開場聚焦照舊有效。
 * 高度由殼統一管（M3 ⑥ 修正席）：紙卡 `.ns-dialog` 自己吃 `max-height: calc(100% - 24px)`（% 算的是
 * 暗幕扣掉 topClass 之後的內容高），撐不下時由 `.ns-dialog-body` 內捲——分頁不必去猜標題列與頁腳的高度。
 *
 * ── UI 丙-2 擴充（契約 §1 #13；視覺規範 §2.4「置中對話框」；活樣本 prototypes/ui-brand §2.4 容器）──
 * 用途：一個明確的小任務（建路線、補記、改塊、分類管理、設定、記一句）。只要一個決定改用 ConfirmDialog；手機改用 MSheet／MFullPage。
 * 三個新 prop，都是選填、預設值＝丙-1 現況（既有 5 個 host：設定、`?`、路線對話框、時刻表面板、售票口對話框——零變）：
 *   - `size`：寬度三檔 S 380（確認框）／M 520（表單、時刻表面板）／L 620（變待辦、設定）。給了 size 就以它為準；
 *     沒給才看 `width`（deprecated，丙-3～6 各 host 改 size 後刪）；兩個都沒給＝380（＝S，＝現況預設）。
 *     寬度是版面常數，寫在本檔 `DIALOG_WIDTH`（行內 style，同現況），css 不寫 px 字面值；卡另掛 `.is-s|.is-m|.is-l` 當鉤子。
 *   - `skin`：`paper` 紙卡（預設，`.techo-card`）／`ticket` 票皮（捕捉框：票形 600、去處票根、受付章——10-12 定稿保留）。
 *     殼統一（焦點三規則、Esc、暗幕、標題列），皮只換材質與排版：票皮的材質畫在 `::before`（同 `.ticket` 打孔 mask），
 *     左側 `stub`（去處票根，host 給內容）＋右側主欄（標題列、本文、foot）；`stub` 只在票皮生效，沒給就不打孔。
 *   - `foot`：黏底按鈕列（`.ns-dialog-foot`；取消在左、主鈕在右，host 照這個順序給）。它排在內捲的本文之外，
 *     本文怎麼捲按鈕列都在卡底——不必 position: sticky。即時存的面板不給（§2.3：即時存的表單沒有主鈕）。
 * ARIA：`role="dialog"`＋`aria-modal`＋`aria-labelledby`→標題。鍵盤：Esc 關（IME 組字中不攔）、開啟焦點落卡、關閉還焦點（磨光⑤ 第 100 號的三規則）。
 * Esc（UI 丙-7 T5，對齊 MSheet）：掛在 window，**別人已 preventDefault 就不關**——卡裡的子元件（輸入欄還原草稿、荷札建議收清單、
 *   小浮層收起）自己吃掉的 Esc 不會連殼一起關，不必再 stopPropagation。疊了兩張殼（理論上 useGlobalHotkeys 會擋）只有最上面那張吃，
 *   底下那張不搶也不 preventDefault（`escStack`：掛上的順序；監聽一次登記在掛上時，onClose 換了走 ref，順序不會亂）。
 *
 * ── UI 丙-3（契約 §0／G2）──
 *   - `overline` 吃 `string | {zh, latin}`：物件＝PageHeader 同一種畫法（粉彩只畫拉丁斜體、銀河「中 — LATIN」，`<OverlineText>`）；
 *     字串＝照字面（售票口、時刻表的舊呼叫端不用改）。新寫的呼叫端一律給物件。
 *   - Tab 不出卡（規範 §2.4）：焦點在卡內循環——最後一個可聚焦元素按 Tab 回第一個、第一個（或卡本身）按 Shift+Tab 到最後一個；
 *     卡內沒有可聚焦元素就停在卡上。中間的 Tab 交給瀏覽器（DOM 順序，roving tabindex＝-1 的籤自然跳過）。
 *     只管 DOM 上在卡裡的焦點：portal 出去的浮層（PopMenu、日期小卡…）自己管鍵盤；疊在上面的另一個 dialog 由它自己的殼管。
 */
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { OverlineText, type Overline } from "./PageHeader";
import "./overlay.css";

/** 對話框寬度三檔（視覺規範 §2.4；9 種收 3） */
export type DialogSize = "S" | "M" | "L";

/** 寬度檔位（px）：S＝確認框、M＝表單與時刻表面板、L＝變待辦與設定 */
const DIALOG_WIDTH: Record<DialogSize, number> = { S: 380, M: 520, L: 620 };
/** 票皮（捕捉框）的寬：票形 600（10-12 定稿，原型 `.ns-dialog.is-ticket`） */
const TICKET_WIDTH = 600;

interface DialogShellProps {
  title: string;
  /** 標題上方的眉標：物件 `{zh:"設定", latin:"Settings"}`（新寫法）；字串照字面（舊呼叫端）；省略則不顯示 */
  overline?: Overline;
  onClose: () => void;
  children: ReactNode;
  /** 寬度三檔（S 380／M 520／L 620）；給了就蓋過 `width` */
  size?: DialogSize;
  /**
   * 卡片寬（px）。
   * @deprecated 改用 `size`（S／M／L）；丙-3～6 各 host 換完後刪。
   */
  width?: number;
  /** 置頂距離，預設 18vh */
  topClass?: string;
  /** 皮：`paper` 紙卡（預設）／`ticket` 票皮（捕捉框） */
  skin?: "paper" | "ticket";
  /** 票皮左側的去處票根（`.ns-dialog-stub` 內的內容）；只在 `skin="ticket"` 生效 */
  stub?: ReactNode;
  /** 黏底按鈕列（取消在左、主鈕在右）；即時存的面板不給 */
  foot?: ReactNode;
}

/**
 * 開窗那一刻的焦點、關窗時要不要還（#100 規則③）：body／沒有＝不還；滑鼠點開的按鈕（不是 :focus-visible）＝不還，
 * 照舊掉 body 由頁面接手；其餘（鍵盤停在鈕上、頁面容器、列、輸入框）＝還。
 */
function openerToRestore(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  const a = document.activeElement;
  if (!(a instanceof HTMLElement) || a === document.body) return null;
  if (a.tagName === "BUTTON") {
    try {
      if (!a.matches(":focus-visible")) return null;
    } catch {
      return null; // 不認得 :focus-visible 的引擎：保守當滑鼠點的
    }
  }
  return a;
}

/**
 * 焦點三條規則（磨光⑤ 第 100 號，見檔頭）抽成鉤子：DialogShell 自己用，丙-2 的 MSheet／MFullPage 也用同一套（一個殼一種焦點行為）。
 * `cardRef` 指向帶 `tabIndex={-1}` 的容器；開窗前的焦點在第一次 render 記下（commit 之後子元件的 autoFocus 已經把焦點搬進來，
 * effect 裡再讀就晚了）。抽出前後 hook 呼叫順序與依賴不變（useState → useEffect[opener]），既有 host 行為零變。
 * `enabled=false`：整支不動（dev 樣本頁把 MSheet／MFullPage 畫在框裡當靜態樣本時，不搶頁面焦點）。
 */
export function useDialogFocus(cardRef: RefObject<HTMLElement | null>, enabled = true): void {
  const [opener] = useState(() => openerToRestore());

  useEffect(() => {
    const card = cardRef.current;
    if (!card || !enabled) return;
    // ① 開啟
    if (!card.contains(document.activeElement)) card.focus({ preventScroll: true });
    // ② 開著：掉到 body 就拉回卡上（下一拍再看，讓重畫後的子元件先有機會自己聚焦）
    let t: ReturnType<typeof setTimeout> | undefined;
    const pullBackSoon = (): void => {
      clearTimeout(t);
      t = setTimeout(() => {
        if (!card.isConnected) return;
        const a = document.activeElement;
        if (a === null || a === document.body) card.focus({ preventScroll: true });
      }, 0);
    };
    const onFocusOut = (e: FocusEvent): void => {
      if (e.relatedTarget === null) pullBackSoon();
    };
    card.addEventListener("focusout", onFocusOut);
    const mo = new MutationObserver(() => {
      const a = document.activeElement;
      if (a === null || a === document.body) pullBackSoon();
    });
    mo.observe(card, { childList: true, subtree: true });
    return () => {
      clearTimeout(t);
      mo.disconnect();
      card.removeEventListener("focusout", onFocusOut);
      // ③ 關閉：卡已卸載，焦點若在卡內此刻已落到 body；落空才還（host 自己把焦點送去別處就不搶）
      const a = document.activeElement;
      if (opener && opener.isConnected && (a === null || a === document.body)) opener.focus({ preventScroll: true });
    };
    // 只在開窗那一刻設定（opener 在同一個 dialog 生命週期內不變；cardRef 是穩定的 ref 物件；DialogShell 恆為 enabled）
  }, [opener, cardRef, enabled]);
}

/** 卡內可以 Tab 到的元素（DOM 順序）：可見、沒停用、tabIndex ≥ 0；同名 radio 只算一個 Tab stop（勾選的那顆，沒勾就第一顆） */
const TABBABLE =
  'a[href], area[href], button, input:not([type="hidden"]), select, textarea, iframe, summary, [tabindex], [contenteditable=""], [contenteditable="true"]';

function tabbables(card: HTMLElement): HTMLElement[] {
  const seenRadio = new Set<string>();
  const all = Array.from(card.querySelectorAll<HTMLElement>(TABBABLE)).filter((el) => {
    if (el.tabIndex < 0) return false;
    if ((el as HTMLButtonElement).disabled) return false;
    if (el.closest("[inert]")) return false;
    if (el.getClientRects().length === 0) return false; // display:none／沒畫出來
    return true;
  });
  return all.filter((el) => {
    if (!(el instanceof HTMLInputElement) || el.type !== "radio" || !el.name) return true;
    const key = el.name;
    if (seenRadio.has(key)) return false;
    const group = all.filter((o) => o instanceof HTMLInputElement && o.type === "radio" && o.name === key) as HTMLInputElement[];
    const pick = group.find((o) => o.checked) ?? group[0];
    if (pick !== el) return false;
    seenRadio.add(key);
    return true;
  });
}

/**
 * Tab 不出卡（規範 §2.4；UI 丙-3）：掛在帶 tabIndex=-1 的卡上（原生 keydown，只收 DOM 上在卡裡的事件——
 * React portal 出去的子浮層冒上來的事件不經過這裡）。邊界才接手、中間交給瀏覽器；別人已 preventDefault 的不管；
 * 事件來自卡裡另一個 dialog（巢狀）時交給那個 dialog 自己的殼。
 */
export function useTabTrap(cardRef: RefObject<HTMLElement | null>, enabled = true): void {
  useEffect(() => {
    const card = cardRef.current;
    if (!card || !enabled) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Tab" || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && t !== card && t.closest('[role="dialog"], [role="alertdialog"]') !== card) return; // 巢狀 dialog
      const list = tabbables(card);
      const active = document.activeElement as HTMLElement | null;
      if (list.length === 0) {
        e.preventDefault();
        card.focus({ preventScroll: true });
        return;
      }
      const first = list[0];
      const last = list[list.length - 1];
      const onCard = active === card || !active || !card.contains(active);
      if (e.shiftKey) {
        if (onCard || active === first) {
          e.preventDefault();
          last.focus();
        }
      } else if (onCard && active !== card) {
        e.preventDefault();
        first.focus();
      } else if (active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    card.addEventListener("keydown", onKey);
    return () => card.removeEventListener("keydown", onKey);
  }, [cardRef, enabled]);
}

/** 掛著的 DialogShell，依掛上順序（最後一個＝最上面那張）；Esc 只給它 */
const escStack: symbol[] = [];

export function DialogShell({
  title,
  overline,
  onClose,
  children,
  size,
  width,
  topClass = "pt-[18vh]",
  skin = "paper",
  stub,
  foot,
}: DialogShellProps) {
  const ticket = skin === "ticket";
  // size 優先；沒給才看 deprecated 的 width；都沒給＝現況預設 380（＝S）。票皮另有自己的 600。
  const cardWidth = size ? DIALOG_WIDTH[size] : width ?? (ticket ? TICKET_WIDTH : DIALOG_WIDTH.S);
  const hasStub = ticket && stub != null;
  const titleId = useId();
  const cardRef = useRef<HTMLDivElement>(null);

  /* 磨光⑤ 第 100 號：焦點三條規則（見檔頭）；UI 丙-2 抽成上方的 useDialogFocus，行為不變 */
  useDialogFocus(cardRef);
  /* UI 丙-3：Tab 不出卡（規範 §2.4） */
  useTabTrap(cardRef);

  /* Esc（UI 丙-7 T5）：看 defaultPrevented、只有最上面那張殼吃（見檔頭） */
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const me = Symbol("dialog");
    escStack.push(me);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing || e.keyCode === 229 || e.defaultPrevented) return;
      if (escStack[escStack.length - 1] !== me) return;
      e.preventDefault();
      onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      const i = escStack.indexOf(me);
      if (i >= 0) escStack.splice(i, 1);
    };
  }, []);

  // 標題列與本文的 DOM 兩種皮共用（紙卡＝丙-1 現況逐字，只多一個 .ns-dialog-head 鉤子）；票皮的排版差在 overlay.css 的 .is-ticket
  const head = (
    <div className="ns-dialog-head ns-tear flex items-start justify-between gap-3 px-6 pt-5 pb-3.5">
      <div className="min-w-0">
        {overline && (
          <p className="techo-overline mb-1.5">
            <OverlineText value={overline} />
          </p>
        )}
        <h2 id={titleId} className="techo-title text-[19px] truncate">
          {title}
        </h2>
      </div>
      <button type="button" onClick={onClose} aria-label="關閉" className="ns-close -mr-2 -mt-1 shrink-0">
        ×
      </button>
    </div>
  );
  const body = <div className="ns-dialog-body px-6 pt-4 pb-5">{children}</div>;
  const footRow = foot != null ? <div className="ns-dialog-foot">{foot}</div> : null;
  const sizeClass = size ? ` is-${size.toLowerCase()}` : "";

  return (
    <div
      className={`techo-veil fixed inset-0 z-40 flex items-start justify-center ${topClass}`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={
          (ticket ? "ns-dialog is-ticket" + (hasStub ? " has-stub" : "") : "techo-card ns-dialog") +
          sizeClass +
          " max-w-[92vw] transition duration-150 ease-out starting:opacity-0 starting:translate-y-1"
        }
        // 卡本身只是焦點的落腳處（#100），不畫聚焦框——框留給卡裡真正能操作的東西
        style={{ width: cardWidth, outline: "none" }}
      >
        {ticket ? (
          <>
            {hasStub && <div className="ns-dialog-stub">{stub}</div>}
            <div className="ns-dialog-main">
              {head}
              {body}
              {footRow}
            </div>
          </>
        ) : (
          <>
            {head}
            {body}
            {footRow}
          </>
        )}
      </div>
    </div>
  );
}
