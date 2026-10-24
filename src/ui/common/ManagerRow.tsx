/**
 * ManagerRow——管理清單的一列（UI 丙-2 U3；視覺規範 §2.5「分類管理列」、§2.3 圖示鈕、§1.8 禁用、§0 法則 05）。
 *
 * 用途：時刻表「分類與設定」、售票口「分類管理／帳戶排序」這類**即時存**的管理清單——一列一個東西，
 *   就地改名、上下排序、其餘動作（封存、刪除…）收進 ⋯。兩線共用一種列（丙-4／丙-5 套用）。
 * 什麼時候不用：要挑一個（分類選擇器 CategoryGrid／CategoryCombo）；要看全部欄位（詳情側板）；一般資料列（車票、帳本列）。
 * 解剖（樣本 prototypes/ui-brand/index.html「ManagerRow」節 .ns-mgr）：
 *   ［名稱：行內改名的底線輸入］［色票／emoji 22 寬］［↑］［↓］［⋯ 常駐淡態］；列間 1px 虛線。
 *   清單外框用 <ManagerList>（<ul class="ns-mgr">）；色票可用 <SwatchDot color="var(--cat-1)" />。
 * 層級：**自動存、沒有「完成」鈕、關閉只有 ×**（§6 行為改變）——改名失焦或 Enter 就送，排序按一下就送。
 * 狀態：
 *   改名——空白或沒變不送（空白退回原名）；onRename 回 false（或 Promise resolve false／reject）＝沒改成，輸入框退回原名；
 *     外部改了名（同步、另一個殼）輸入框跟著換。不給 onRename＝這列不能改名（純文字，例「未分類」）。
 *   ↑↓——不給 onUp／onDown＝在邊界：禁用（--disabled .3＋not-allowed），滑過說「已經在最上面／最下面」。
 *   ⋯——常駐淡態 --dim，列 hover／列內有焦點／選單開著時轉實；手機常駐實。menu 空陣列＝不畫 ⋯（留同寬空格對齊）。
 *   archived——名稱淡墨、色票淡、↑↓ 的位置換成「已封存」小字（封存的東西不排序）；⋯ 照常（取消封存、刪除放裡面）。
 * 桌機↔手機：同一支；圖示鈕 28→44、字級走 token（[data-shell="mobile"] 整組換）。⋯ 桌機開 PopMenu、手機開 MSheet 動作清單（丙-5，見下）。
 * ARIA：名稱輸入 aria-label「名稱：X」；↑↓ aria-label「上移：X／下移：X」＋title（含 Alt 快捷）；
 *   ⋯ aria-label「更多動作：X」、aria-haspopup="menu"、aria-expanded、title＝選單項目串起來（例「封存、刪除」）。
 *   色票 aria-hidden（名稱已經說了是誰）。
 * 鍵盤（名稱輸入框裡）：Enter 送出（焦點留著）；Esc 有改動時退回原名並吃掉這一下（不關對話框），沒改動照常往上冒（關對話框）；
 *   Alt+↑／Alt+↓ 上移／下移；組字中（IME）的 Enter／Esc 不動作。⋯ 開的 PopMenu：↑↓ 移動、Enter 執行、Esc 收回並把焦點還給 ⋯。
 *
 * ── UI 丙-4 §0（契約 §0 ManagerRow 那列、B2）──
 *   - `detail`：列下的展開區（時刻表分類的預設長度、預設荷札、圓牌字、色、搬到分組……一列放不下的設定）。
 *     開關收在 ⋯ 的第一項「更多設定…」（開著時換成「收起設定」）——不另加列尾 ▸：列尾已經有 ↑↓⋯ 三顆圖示鈕，
 *     再加一顆 28 寬的鈕手機會擠掉名稱；而且 B2 定案的 ⋯ 內容就是「更多設定…、封存」。有 detail 時 menu 空陣列也畫 ⋯。
 *     展開＝`<li>` 換行（flex-wrap），展開區佔滿第二行、跟名稱左緣對齊；沒有 detail 的列 DOM 與樣式跟以前一模一樣。
 *     從選單打開 ⇒ 焦點落展開區第一個可操作的東西；從選單收起 ⇒ 焦點回 ⋯（PopMenu 點項目時不還焦點，這裡補）。
 *     開關預設自己管；要從外面開（例：荷札頁點分類 → 定位並展開）給 `detailOpen`＋`onDetailOpenChange`（受控）。
 *     展開區是 `role="group"`、aria-label「X 的更多設定」；⋯ 的 aria-controls 指向它（開著時）。
 *   - `className`：加在 `<li>` 上（呼叫端自己的狀態，例：定位閃爍 is-flash）。
 *   - `dataId`：畫成 `<li data-id>`，給「點分類 → 捲到這一列並閃一下」用 querySelector 找列。
 *
 * ── UI 丙-5（契約 §0 ManagerRow 那列、E1）──
 *   - `depth`：0（預設）｜1＝子列（售票口兩層分類的子分類）：`<li>` 加 `is-sub`，名稱（與展開區）左縮一格，
 *     ↑↓⋯ 照樣靠右、整欄對齊。子列還是同一個 <ul> 裡的 <li>（呼叫端照順序排：主分類後面接它的子分類）。
 *   - 手機 ⋯（useShell()==="mobile"）改開共用 MSheet 動作清單：標題＝這一列的名字、每項一列 MSheetItem（danger 赭字、
 *     cut 虛線、disabled 帶 why），最後一列「取消」由 MSheet 自補；點一項＝先收 sheet 再做。返回層由 MSheet 自己登記
 *     （backId＝這一列的選單層 id、kind "dialog"：疊在「分類與設定」sheet／全螢幕頁之上），丙-4 那行 useBackLayer 拿掉。
 *     桌機照舊 PopMenu。detail／className／dataId 的行為不變（「更多設定…」在手機 sheet 裡也是第一項）。
 */
import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { PopMenu, type PopMenuItem } from "./PopMenu";
import { MSheet, MSheetItem } from "./MSheet";
import { useShell } from "../mobile/useShell";
import { IconDots, IconDown, IconUp } from "./icons";
import "./listbits.css";

export type { PopMenuItem } from "./PopMenu";

type RenameResult = void | boolean;

export interface ManagerRowProps {
  name: string;
  /** 改名（已 trim、非空、跟原名不同才呼叫）。回 false／resolve false／reject ＝沒改成。不給＝不能改名 */
  onRename?: (next: string) => RenameResult | Promise<RenameResult>;
  /** 色票或 emoji（22 寬格、置中） */
  swatch?: ReactNode;
  /** 上移；不給＝已在最上面（禁用） */
  onUp?: () => void;
  /** 下移；不給＝已在最下面（禁用） */
  onDown?: () => void;
  /** ⋯ 裡的動作（封存、刪除…；破壞性項目放最後，§2.4 PopMenu） */
  menu: PopMenuItem[];
  archived?: boolean;
  /** 列下展開區（UI 丙-4）：給了 ⇒ ⋯ 第一項「更多設定…」開關它 */
  detail?: ReactNode;
  /** 受控：展開區開著沒（省略＝元件自己管，預設收著） */
  detailOpen?: boolean;
  /** 展開區開關時通知（受控時由呼叫端改 detailOpen） */
  onDetailOpenChange?: (open: boolean) => void;
  /** 加在 <li> 上的 class */
  className?: string;
  /** 畫成 <li data-id>（定位閃爍用） */
  dataId?: string;
  /** 層級（UI 丙-5）：1＝子列，名稱左縮一格 */
  depth?: 0 | 1;
}

/** 管理清單的外框（<ul class="ns-mgr">）；ManagerRow 是 <li>，一定要放在它（或任何 <ul>／<ol>）裡 */
export function ManagerList({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <ul className={"ns-mgr" + (className ? " " + className : "")} aria-label={label}>
      {children}
    </ul>
  );
}

/** 圓點色票（14px）：color 給 token 字串，例 "var(--cat-3)"、"var(--route-preset-2)" */
export function SwatchDot({ color }: { color: string }) {
  return <span className="ns-mgr-dot" style={{ "--c": color } as CSSProperties} />;
}

const isComposingKey = (e: KeyboardEvent) => e.nativeEvent.isComposing || e.keyCode === 229;

export function ManagerRow({
  name,
  onRename,
  swatch,
  onUp,
  onDown,
  menu,
  archived,
  detail,
  detailOpen,
  onDetailOpenChange,
  className,
  dataId,
  depth = 0,
}: ManagerRowProps) {
  const [text, setText] = useState(name);
  const [seen, setSeen] = useState(name);
  // 已送出、還沒回到 props 的名字：Enter 送出後緊接著失焦，不要再送一次
  const [sent, setSent] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [menuAt, setMenuAt] = useState<HTMLElement | null>(null);

  if (seen !== name) {
    // 外面改了名（同步／另一個殼／自己的改名寫回）⇒ 輸入框跟著換（render 中依 props 調整 state，React 文件的作法）
    setSeen(name);
    setText(name);
    setSent(null);
  }

  const closeMenu = useCallback(() => setMenuAt(null), []);
  const mobile = useShell() === "mobile";
  // 手機 ⋯ 的 MSheet 返回層 id（丙-4 T7 評審 14 的那一層：kind dialog，疊在面板 sheet 之上——
  // 不登記的話返回鍵直接關掉底下整張「分類與設定」）。丙-5 起由 MSheet 自己登記，這裡只給 id。
  const menuLayer = "common.mgrrow." + useId();

  /* ── 展開區（UI 丙-4） ── */
  const hasDetail = detail !== undefined && detail !== null && detail !== false;
  const [openSelf, setOpenSelf] = useState(false);
  const open = hasDetail && (detailOpen ?? openSelf);
  const detailId = useId();
  const detailRef = useRef<HTMLDivElement>(null);
  const dotsRef = useRef<HTMLButtonElement>(null);
  // 由選單開關的那一下才搬焦點（外面受控打開＝定位，不搶焦點）
  const moveFocus = useRef<"detail" | "dots" | null>(null);
  const setOpen = (next: boolean) => {
    if (detailOpen === undefined) setOpenSelf(next);
    onDetailOpenChange?.(next);
  };
  useEffect(() => {
    const want = moveFocus.current;
    if (!want) return;
    moveFocus.current = null;
    if (want === "dots") {
      dotsRef.current?.focus({ preventScroll: true });
      return;
    }
    const box = detailRef.current;
    if (!box) return;
    // 第一個在 Tab 順序裡的東西（roving tabindex 的群組，例 ColorPicker，只有選中那格不是 -1）
    const first = box.querySelector<HTMLElement>(
      ["input", "select", "textarea", "button", "[tabindex]"].map((t) => `${t}:not([disabled]):not([tabindex='-1'])`).join(", "),
    );
    (first ?? box).focus({ preventScroll: true });
  }, [open]);

  const items: PopMenuItem[] = hasDetail
    ? [
        {
          key: "ns-mgr-detail",
          label: open ? "收起設定" : "更多設定…",
          onSelect: () => {
            moveFocus.current = open ? "dots" : "detail";
            setOpen(!open);
          },
        },
        ...menu,
      ]
    : menu;

  const commit = () => {
    if (!onRename) return;
    const v = text.trim();
    if (!v) {
      setText(name);
      return;
    }
    if (v !== text) setText(v);
    if (v === name || v === sent) return;
    setSent(v);
    const before = name;
    const revert = () => {
      setSent(null);
      setText(before);
    };
    try {
      const r = onRename(v);
      if (r === false) revert();
      else if (r instanceof Promise) r.then((ok) => ok === false && revert(), revert);
    } catch {
      revert();
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (composing || isComposingKey(e)) return;
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      (e.key === "ArrowUp" ? onUp : onDown)?.();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
      return;
    }
    if (e.key === "Escape" && text !== name) {
      // 第一下 Esc＝放棄這次改名（不讓它冒到對話框的 Esc 關窗）；沒改動時照常往上冒
      e.preventDefault();
      e.stopPropagation();
      setText(name);
    }
  };

  const toggleMenu = (e: MouseEvent<HTMLButtonElement>) => {
    const btn = e.currentTarget;
    setMenuAt((cur) => (cur ? null : btn));
  };

  return (
    <li
      className={
        "ns-mgr-row" +
        (depth === 1 ? " is-sub" : "") +
        (archived ? " is-archived" : "") +
        (hasDetail ? " has-detail" : "") +
        (open ? " is-open" : "") +
        (className ? " " + className : "")
      }
      data-id={dataId}
    >
      {onRename ? (
        <input
          className="techo-input ns-mgr-name"
          value={text}
          aria-label={`名稱：${name}`}
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="done"
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={onKeyDown}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
        />
      ) : (
        <span className="ns-mgr-text" title={name}>
          {name}
        </span>
      )}

      {swatch !== undefined && swatch !== null && (
        <span className="ns-mgr-swatch" aria-hidden="true">
          {swatch}
        </span>
      )}

      {archived ? (
        <span className="ns-mgr-tag">已封存</span>
      ) : (
        <>
          <MoveButton dir="up" name={name} onMove={onUp} />
          <MoveButton dir="down" name={name} onMove={onDown} />
        </>
      )}

      {items.length > 0 ? (
        <button
          ref={dotsRef}
          type="button"
          className="ns-iconbtn is-dim"
          aria-label={`更多動作：${name}`}
          title={items.map((it) => it.label).join("、")}
          aria-haspopup="menu"
          aria-expanded={menuAt !== null}
          aria-controls={open ? detailId : undefined}
          onClick={toggleMenu}
        >
          <IconDots />
        </button>
      ) : (
        <span className="ns-mgr-gap" aria-hidden="true" />
      )}

      {menuAt &&
        (mobile ? (
          <MSheet list title={name} onClose={closeMenu} backId={menuLayer} backKind="dialog">
            {items.map((it) => (
              <MSheetItem
                key={it.key}
                danger={it.danger}
                cut={it.cut}
                disabled={it.disabled}
                title={it.disabled ? it.why : undefined}
                onClick={() => {
                  closeMenu();
                  it.onSelect();
                }}
              >
                {it.label}
              </MSheetItem>
            ))}
          </MSheet>
        ) : (
          <PopMenu anchor={menuAt} overline={{ zh: name, latin: "Actions" }} label={`${name} 的動作`} items={items} onClose={closeMenu} />
        ))}

      {open && (
        <div ref={detailRef} id={detailId} className="ns-mgr-detail" role="group" aria-label={`${name} 的更多設定`} tabIndex={-1}>
          {detail}
        </div>
      )}
    </li>
  );
}

/**
 * ↑／↓ 圖示鈕。外面固定包一層 .ns-mgr-why：禁用的 <button> 收不到滑鼠、title 不會浮，原因掛在外層；
 * 結構不隨禁用與否改變（不重掛按鈕）。
 */
function MoveButton({ dir, name, onMove }: { dir: "up" | "down"; name: string; onMove?: () => void }) {
  const up = dir === "up";
  const label = up ? "上移" : "下移";
  return (
    <span className="ns-mgr-why" title={onMove ? undefined : up ? "已經在最上面" : "已經在最下面"}>
      <button
        type="button"
        className="ns-iconbtn"
        aria-label={`${label}：${name}`}
        title={onMove ? `${label}（Alt+${up ? "↑" : "↓"}）` : undefined}
        disabled={!onMove}
        onClick={() => onMove?.()}
      >
        {up ? <IconUp /> : <IconDown />}
      </button>
    </span>
  );
}
