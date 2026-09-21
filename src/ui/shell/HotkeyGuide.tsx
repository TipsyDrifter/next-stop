/**
 * HotkeyGuide——「?」快捷鍵情境卡（M3 ⑦ WP2；D-⑦-1 甲）。讀 uiStore.hotkeyGuideOpen。
 *
 * 它回答的是「手放在鍵盤上、想不起那顆鍵」這一個問題，所以只有兩段：
 *   ① 當前頁的導航模式鍵（今日視圖／路線圖大綱／日曆格層，`pageScope(page)` 切片）
 *   ② 撕線之後的「全域」段（在哪一頁、輸入框裡都能按的 Ctrl 組合鍵）
 * 七組全表放設定「快捷鍵」籤（WP3）；兩邊吃同一份 registry（`hotkeys.ts`）經 `hotkeyRows.ts` 的切片，
 * 這裡不手抄任何鍵位、不手抄任何標籤——文案改在 registry 改，這張卡自動跟。
 *
 * 開關：`?`（導航模式限定）／`Ctrl+/`（IME 備援）都在 useGlobalHotkeys 走 `toggleHotkeyGuide`；
 *   關閉＝Esc（DialogShell 自帶）、點暗幕、再按一次 `?`、× 鈕。
 *   「開啟設定」鈕＝先收這張卡再 `openSettings("hotkeys")`——互斥在 store 已做（openSettings 會順手收疊層），
 *   這裡仍明確先關，讓意圖讀得出來、不倚賴 store 的副作用。
 * 焦點：開場把焦點放進卡（tabIndex -1 的本文容器，不是某顆鈕——不畫多餘的焦點環），
 *   今日／大綱／日曆三張按鍵表都是容器層的 React onKeyDown，焦點離開它們，↑↓ Space 就不會穿過暗幕動到底下的列；
 *   關閉時焦點還給開卡前的元素，`?`→看→Esc→接著按，鍵盤流不中斷。
 * 視覺：DialogShell 票面紙卡（480）＋鍵帽 `.ns-kbd`／`.ns-kbd-seq`（overlay.css，契約席）＋ `.techo-label`／`.ns-note`／`.ns-tear`；
 *   hotkeyGuide.css 只放排版，顏色一律 token。
 */
import { useEffect, useRef } from "react";
import { useUiStore, type PageId } from "../../store/uiStore";
import { DialogShell } from "../common/DialogShell";
import { formatChord } from "./hotkeys";
import { pageScope, rowPaths, rowsFor, sceneOf, type HotkeyRow } from "./hotkeyRows";
import "../common/overlay.css";
import "./hotkeyGuide.css";

/** 卡的大標：講「這一頁」的話，不用 registry 的組名（那是設定籤的分組名，帶括號說明） */
function pageTitle(page: PageId): string {
  switch (page) {
    case "today":
      return "今日視圖的快捷鍵";
    case "routemap":
      return "路線圖的快捷鍵";
    case "calendar":
      return "日曆的快捷鍵";
  }
}

export function HotkeyGuide() {
  const open = useUiStore((s) => s.hotkeyGuideOpen);
  if (!open) return null;
  return <HotkeyGuideCard />;
}

function HotkeyGuideCard() {
  const page = useUiStore((s) => s.page);
  const setOpen = useUiStore((s) => s.setHotkeyGuideOpen);
  const openSettings = useUiStore((s) => s.openSettings);
  const bodyRef = useRef<HTMLDivElement>(null);

  const close = () => setOpen(false);
  const toSettings = () => {
    close();
    openSettings("hotkeys");
  };

  // 開場焦點進卡、關閉還回去（見檔頭「焦點」）
  useEffect(() => {
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    bodyRef.current?.focus({ preventScroll: true });
    return () => {
      if (prev && prev.isConnected) prev.focus({ preventScroll: true });
    };
  }, []);

  const scope = pageScope(page);
  const here = sceneOf(scope);
  const global = sceneOf("global");

  return (
    <DialogShell
      title={pageTitle(page)}
      overline="快捷鍵 — SHORTCUTS"
      onClose={close}
      width={480}
      topClass="pt-[6vh]" /* 比設定卡貼頂一級：1280×800 多出 32px，路線圖 21 列才不捲 */
    >
      <div ref={bodyRef} tabIndex={-1} className="ns-hkg outline-none">
        <section className="ns-hkg-section" aria-label={here.title}>
          <p className="ns-note ns-hkg-scene">{here.note}</p>
          <HotkeyList rows={rowsFor(scope)} />
        </section>

        <section className="ns-hkg-section ns-hkg-section--tear" aria-label={global.title}>
          <div className="ns-hkg-head">
            <span className="techo-label">{global.title}</span>
            <span className="ns-note">{global.note}</span>
          </div>
          <HotkeyList rows={rowsFor("global")} />
        </section>

        <div className="ns-hkg-foot">
          <span className="ns-note">完整說明與其他頁面：設定 → 快捷鍵</span>
          <button type="button" onClick={toSettings} className="btn-ghost ns-btn ns-btn--sm shrink-0">
            開啟設定
          </button>
        </div>
      </div>
    </DialogShell>
  );
}

function HotkeyList({ rows }: { rows: HotkeyRow[] }) {
  return (
    <ul className="ns-hkg-list">
      {rows.map((row) => (
        <li key={row.id} className="ns-hkg-row">
          <span className="ns-hkg-label">
            {row.label}
            {row.note && <span className="ns-note ns-hkg-rownote">{row.note}</span>}
          </span>
          <span className="ns-hkg-keys">
            {rowPaths(row).map((chord, i) => (
              <span key={i} className="ns-hkg-path">
                {i > 0 && (
                  <span className="ns-hkg-or" aria-hidden="true">
                    ／
                  </span>
                )}
                <Keycaps caps={formatChord(chord)} />
              </span>
            ))}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** 一條路徑的鍵帽橫排：Ctrl ＋ Enter（契約席的 .ns-kbd-seq／.ns-kbd／.ns-kbd-plus） */
function Keycaps({ caps }: { caps: string[] }) {
  return (
    <span className="ns-kbd-seq">
      {caps.map((cap, i) => (
        <span key={i} className="contents">
          {i > 0 && (
            <span className="ns-kbd-plus" aria-hidden="true">
              +
            </span>
          )}
          <kbd className="ns-kbd">{cap}</kbd>
        </span>
      ))}
    </span>
  );
}
