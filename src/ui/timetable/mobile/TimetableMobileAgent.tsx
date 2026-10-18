/**
 * TimetableMobileAgent——手機全域代理（車次①a 契約 §5.3、§5.5、§5.8、§5.9；mount 的 `mobileOverlay`；丙席）。
 * 車次② 起不再是零 DOM：回 `<OffPageSheetHost shell="mobile" />`（不在時刻表 tab 時畫時刻表的面板，② 契約 0-9、§5.3；
 * 在時刻表 tab 時它回 null）。其餘照舊只有 effect：
 *   - mount：`store.init("mobile")`（輕量：App 一啟動就知道有沒有運行中，供常駐通知與提醒重排）
 *     → `drainPending("launch")`（套 App 沒開時在通知上按的換車／到着；先等同步 ≤5 秒）→ 貼通知、排提醒。
 *   - `visibilitychange → visible`：`store.refresh()` → `drainPending("foreground")` → `syncRunningNotice({force})`
 *     （回前景一律重貼；不論頁面）→ `syncLongRunReminder({force})`
 *     → `store.autoAsk("foreground", 是否在時刻表 tab)`（不在頁上只記下待問，進頁才問；①a 契約 0-10）。
 *   - plugin 事件 `pending`（App 活著、主人在通知上按）：`ttOnPending(() => drainPending("event"))`，unmount 解除。
 *   - 訂閱 store：`ready`／`running`／`categories`／`noticeEnabled`／`longRunMaxMin`／`noticeLongRunEnabled`／
 *     `noticeTilesEnabled`／`noticePins`／`recentCategoryIds` 變化 ⇒ 重貼通知、重排提醒（notice.ts 內部去重）。
 *   - 不是 Android（桌機視窗拉窄成手機排版）：接 TimetableDesktopAgent 的兩件——`listen("tt-tray")`、每分鐘重送系統匣。
 *   丙席（①b①c 契約 §5.10.8）。
 *
 * 車次②（② 契約 §5.3；乙席，本檔整個歸乙）：掛 `startTaskWatch()`；訂閱的條件群組多一個 `taskChanged`
 * （運行中那班的任務名／任務預計時間，`taskSig` 與桌機代理共用）——通知與提醒在同一個 syncAll，一起重送／重排。
 */
import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { MOCK_MODE } from "../../../data";
import type { TrayAction } from "../../../domain/timetableTray";
import { useTimetableStore } from "../../../store/timetableStore";
import { useUiStore } from "../../../store/uiStore";
import { OffPageSheetHost } from "../OffPageSheetHost";
import { taskSig } from "../TimetableDesktopAgent";
import { startTaskWatch } from "../taskWatch";
import { onAndroid, syncLongRunReminder, syncRunningNotice } from "../notice";
import { handleTrayAction } from "../noticeDesktop";
import { drainPending } from "../noticePending";
import { ttOnPending } from "../ttNoticeBridge";

export function TimetableMobileAgent() {
  useEffect(() => {
    let alive = true;
    const syncAll = (force: boolean): Promise<void> =>
      syncRunningNotice({ force }).then(() => syncLongRunReminder({ force }));

    void useTimetableStore
      .getState()
      .init("mobile")
      .then(async () => {
        if (!alive) return;
        await drainPending("launch");
        // 不帶 force（與 TimetableDesktopAgent 同一條，沙盒回報 F4）：init 把 ready 翻成 true 時下面的訂閱已送過一次；
        // 冷啟動時 notice.ts 的去重簽章本來就是 null，第一次一定會貼，這裡再 force 只是同內容的第二次送。
        // 「回前景一律重貼」由 visibilitychange 那條負責，不靠這裡。
        if (alive) await syncAll(false);
      })
      .catch(() => undefined); // 載入失敗已寫進 store.error；頁面會顯示

    const onVisibility = (): void => {
      if (document.visibilityState !== "visible") return;
      void useTimetableStore
        .getState()
        .refresh()
        .then(async () => {
          if (!alive) return;
          await drainPending("foreground");
          if (!alive) return;
          await syncAll(true);
          useTimetableStore.getState().autoAsk("foreground", useUiStore.getState().mobileTab === "timetable");
        })
        .catch(() => undefined);
    };
    document.addEventListener("visibilitychange", onVisibility);

    // plugin 事件：App 活著時在通知上按了格子／到着 ⇒ 立刻套（不等同步）
    let offPending: (() => void) | null = null;
    void ttOnPending(() => {
      if (alive) void drainPending("event");
    }).then((off) => {
      if (alive) offPending = off;
      else off();
    });

    // 桌機視窗拉窄成手機排版（整合席補）：TimetableDesktopAgent 這時 unmount，系統匣仍由這裡的 syncRunningNotice
    // 經 notice.ts 導到 syncTray；選單點擊（tt-tray）與每分鐘的經過時間也要有人接，否則窄視窗下點系統匣沒反應
    let unlistenTray: (() => void) | null = null;
    let trayTick: ReturnType<typeof setInterval> | null = null;
    if (!onAndroid()) {
      trayTick = setInterval(() => void syncRunningNotice(), 60_000);
      if (!MOCK_MODE) {
        void listen<TrayAction>("tt-tray", (e) => handleTrayAction(e.payload))
          .then((u) => {
            if (alive) unlistenTray = u;
            else u();
          })
          .catch(() => undefined);
      }
    }

    const unsub = useTimetableStore.subscribe((s, prev) => {
      // `ready` 也要看：整批換掉（reload wiped）時 refresh 在 ready=false 期間就換了 running（notice 那時會略過），
      // 等 ready 回 true 才補送，否則常駐通知停在換掉之前的那班（與 TimetableDesktopAgent 同一條）
      if (
        s.ready !== prev.ready ||
        s.running !== prev.running ||
        s.categories !== prev.categories ||
        s.noticeEnabled !== prev.noticeEnabled ||
        s.longRunMaxMin !== prev.longRunMaxMin ||
        s.noticeLongRunEnabled !== prev.noticeLongRunEnabled ||
        s.noticeTilesEnabled !== prev.noticeTilesEnabled ||
        s.noticePins !== prev.noticePins ||
        s.recentCategoryIds !== prev.recentCategoryIds ||
        taskSig(s) !== taskSig(prev)
      ) {
        void syncAll(false);
      }
    });

    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", onVisibility);
      offPending?.();
      if (trayTick) clearInterval(trayTick);
      unlistenTray?.();
      unsub();
    };
  }, []);

  // ②：蓋済偵測（startTaskWatch 回的就是 cleanup）
  useEffect(() => startTaskWatch(), []);

  return <OffPageSheetHost shell="mobile" />;
}
