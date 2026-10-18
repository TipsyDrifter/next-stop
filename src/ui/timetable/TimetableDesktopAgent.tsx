/**
 * TimetableDesktopAgent——桌機全域代理（①a 補充契約 §3：系統匣顯示運行中；mount 的 `desktopOverlay`）。
 * App 每頁常駐掛一份（`lineOverlays("desktop")`）。車次② 起不再是零 DOM：回 `<OffPageSheetHost shell="desktop" />`
 * （不在時刻表頁時畫時刻表的面板，② 契約 0-9、§5.3；在時刻表頁時它回 null）。其餘照舊只有 effect：
 *   - mount：`store.init("desktop")`（冪等；與 TimetableView 共用同一個 init promise）→ `syncRunningNotice()`（不 force，見下方註解）。
 *     App 一開就知道有沒有運行中——不必先進時刻表頁，系統匣就寫「目前沒有列車在跑」或「創作・14:35 発」。
 *   - 訂閱 store：`ready`／`running`／`categories`／`noticeEnabled` 變化 ⇒ 重送（notice.ts 內部去重）。
 *     別台換車：同步拉到 → `reload` → `refresh` → `running` 換了 ⇒ 這裡跟著換 tooltip。
 * 為什麼要有它：手機有 TimetableMobileAgent，桌機原本沒有全域代理（原契約 §6.1 不填 desktopOverlay），
 * 而 TimetableView 只在時刻表頁掛著——沒有它，系統匣只有進過時刻表頁才會動。
 * 不做「回來時主動問」：那是 useTimetableForeground 的事（頁面層），這支只管系統匣。
 *
 * ①c（①b①c 契約 §5.11、§5.14；丁席）加三件：
 *   - 系統匣選單（`noticeDesktop.syncTray` 自己讀 store 建 `TrayMenuSpec`）：訂閱多看常用格開關、釘選、最近用過。
 *   - 每分鐘 `syncRunningNotice()`：tooltip 與選單第一列帶經過時間（取整到分；沒變就被去重擋掉）。
 *   - `listen("tt-tray")`：Rust 把選單點擊翻成 `TrayAction`（"tt:arrive"／"tt:depart:<分類 id>"）⇒ `handleTrayAction`。
 *   - 跑太久提醒：`syncLongRunReminder()`（notice.ts 路由；桌機＝desktopReminder）在 mount 與 running／分類／
 *     保險上限／提醒開關變化時重算。
 *   `?mock=1` 沒有 Rust：`window.__ttTrayMock = { menu(), click(menuId) }` 照 Rust 的 id 規則模擬點選單。
 *
 * 車次②（② 契約 §5.3；乙席，本檔整個歸乙）：
 *   - 掛 `startTaskWatch()`（蓋済偵測；參考計數，StrictMode 的掛→清→掛不會退掉共用訂閱）。
 *   - 通知組與提醒組的觸發都多看「運行中那班的任務名與任務預計時間」（`taskSig`，比算出來的值、不比 linkInfo 物件）：
 *     運行中改了連到任務的預計時間、或 linkInfo 第一次讀失敗之後被 refreshLinks 補上，系統匣與提醒都會重送／重排。
 */
import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { MOCK_MODE } from "../../data";
import { linkLabelOf, taskEstimateOf } from "../../domain/timetableLink";
import type { TrayAction, TrayMenuSpec } from "../../domain/timetableTray";
import { useTimetableStore, type TimetableStore } from "../../store/timetableStore";
import { OffPageSheetHost } from "./OffPageSheetHost";
import { startTaskWatch } from "./taskWatch";
import { syncLongRunReminder, syncRunningNotice } from "./notice";
import { handleTrayAction, lastTrayState } from "./noticeDesktop";
import { stopDesktopReminder } from "./desktopReminder";

/**
 * ②：運行中那班的任務名＋任務預計時間（比算出來的值：linkInfo 每次 refresh 都換物件，比物件會每次重送）。
 * 手機代理也用同一支。
 */
export function taskSig(st: Pick<TimetableStore, "running" | "linkInfo">): string {
  return st.running ? `${linkLabelOf(st.running, st.linkInfo) ?? ""}|${taskEstimateOf(st.running, st.linkInfo) ?? ""}` : "";
}

/** 經過時間每分鐘才變（§5.11）；沒變的那幾次被 syncTray 的去重簽章擋掉 */
const TRAY_TICK_MS = 60_000;

interface TrayMock {
  /** 最後一次送給 Rust 的選單（沒送過＝null） */
  menu(): TrayMenuSpec | null;
  tooltip(): string | null;
  /** 模擬在系統匣選單上點一列（id＝Rust 那邊的選單 id） */
  click(menuId: string): void;
}

/** ＝Rust `tray.rs` 的 `parse_tt_menu_id`（mock 用；真機由 Rust 解析後送 TrayAction） */
function parseMockMenuId(id: string): TrayAction | null {
  if (id === "tt:arrive") return { kind: "arrive" };
  if (id.startsWith("tt:depart:") && id.length > "tt:depart:".length) return { kind: "depart", categoryId: id.slice("tt:depart:".length) };
  return null;
}

export function TimetableDesktopAgent() {
  useEffect(() => {
    let alive = true;
    void useTimetableStore
      .getState()
      .init("desktop")
      .then(() => {
        // 不帶 force（沙盒回報 F4）：init 把 ready 翻成 true 時，下面的訂閱已同步送過一次（lastTraySig 已記下），
        // 這裡再 force 就是同一毫秒的第二筆 tray_set_status。不帶 force 時這一呼叫只在「掛上時 ready 早就是 true、
        // 訂閱沒看到翻轉」（例如殼層切換重掛）才真的送；系統匣不會被使用者滑掉，桌機不需要 force 重貼。
        if (!alive) return;
        void syncRunningNotice();
        void syncLongRunReminder();
      })
      .catch(() => undefined); // 載入失敗已寫進 store.error；頁面會顯示

    const unsub = useTimetableStore.subscribe((s, prev) => {
      // `ready` 也要看：整批換掉（reload wiped）時 refresh 在 ready=false 期間就換了 running（那時 notice 會略過），
      // 等 ready 回 true 才補送，否則系統匣停在換掉之前的那班
      // ②：任務名／任務預計時間變了也算（通知組的系統匣名稱、提醒組的門檻都跟著它）
      const taskChanged = taskSig(s) !== taskSig(prev);
      const base = s.ready !== prev.ready || s.running !== prev.running || s.categories !== prev.categories || taskChanged;
      if (
        base ||
        s.noticeEnabled !== prev.noticeEnabled ||
        s.noticeTilesEnabled !== prev.noticeTilesEnabled ||
        s.noticePins !== prev.noticePins ||
        s.recentCategoryIds !== prev.recentCategoryIds
      ) {
        void syncRunningNotice();
      }
      if (base || s.longRunMaxMin !== prev.longRunMaxMin || s.noticeLongRunEnabled !== prev.noticeLongRunEnabled) {
        void syncLongRunReminder();
      }
    });

    const tick = setInterval(() => void syncRunningNotice(), TRAY_TICK_MS);

    // Rust 選單點擊 → TrayAction（mock 沒有 Rust，不 listen）
    let unlisten: (() => void) | null = null;
    if (!MOCK_MODE) {
      void listen<TrayAction>("tt-tray", (e) => handleTrayAction(e.payload))
        .then((u) => {
          if (alive) unlisten = u;
          else u();
        })
        .catch((e: unknown) => console.warn("[tt:notice] 系統匣事件監聽失敗：", e instanceof Error ? e.message : String(e)));
    } else if (typeof window !== "undefined") {
      const mock: TrayMock = {
        menu: () => lastTrayState()?.menu ?? null,
        tooltip: () => lastTrayState()?.tooltip ?? null,
        click: (menuId) => {
          const a = parseMockMenuId(menuId);
          if (a) handleTrayAction(a);
        },
      };
      (window as unknown as { __ttTrayMock?: TrayMock }).__ttTrayMock = mock;
    }

    return () => {
      alive = false;
      unsub();
      clearInterval(tick);
      if (unlisten) unlisten();
      stopDesktopReminder();
    };
  }, []);

  // ②：蓋済偵測（startTaskWatch 回的就是 cleanup）
  useEffect(() => startTaskWatch(), []);

  return <OffPageSheetHost shell="desktop" />;
}
