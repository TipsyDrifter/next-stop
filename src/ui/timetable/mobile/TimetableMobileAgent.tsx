/**
 * TimetableMobileAgent——手機全域代理（車次①a 契約 §5.3、§5.5、§5.8、§5.9；mount 的 `mobileOverlay`；丙席）。
 * 回 `null`、只有 effect：
 *   - mount：`store.init("mobile")`（輕量：App 一啟動就知道有沒有運行中，供常駐通知與試驗提醒重排）→ 貼通知、排提醒。
 *   - `visibilitychange → visible`：`store.refresh()` → `syncRunningNotice({force})`（回前景一律重貼；不論頁面）
 *     → `syncLongRunReminder({force})` → `store.autoAsk("foreground", 是否在時刻表 tab)`（不在頁上只記下待問，進頁才問；契約 0-10）。
 *   - 訂閱 store：`running`／`categories`／`noticeEnabled`／`longRunMaxMin` 變化 ⇒ 重貼通知、重排提醒（notice.ts 內部去重）。
 */
import { useEffect } from "react";
import { useTimetableStore } from "../../../store/timetableStore";
import { useUiStore } from "../../../store/uiStore";
import { syncLongRunReminder, syncRunningNotice } from "../notice";

export function TimetableMobileAgent() {
  useEffect(() => {
    let alive = true;
    const syncAll = (force: boolean): void => {
      void syncRunningNotice({ force }).then(() => syncLongRunReminder({ force }));
    };

    void useTimetableStore
      .getState()
      .init("mobile")
      .then(() => {
        // 不帶 force（與 TimetableDesktopAgent 同一條，沙盒回報 F4）：init 把 ready 翻成 true 時下面的訂閱已送過一次；
        // 冷啟動時 notice.ts 的去重簽章本來就是 null，第一次一定會貼，這裡再 force 只是同內容的第二次 notify。
        // 「回前景一律重貼」由 visibilitychange 那條負責，不靠這裡。
        if (alive) syncAll(false);
      })
      .catch(() => undefined); // 載入失敗已寫進 store.error；頁面會顯示

    const onVisibility = (): void => {
      if (document.visibilityState !== "visible") return;
      void useTimetableStore
        .getState()
        .refresh()
        .then(() => {
          if (!alive) return;
          syncAll(true);
          useTimetableStore.getState().autoAsk("foreground", useUiStore.getState().mobileTab === "timetable");
        });
    };
    document.addEventListener("visibilitychange", onVisibility);

    const unsub = useTimetableStore.subscribe((s, prev) => {
      // `ready` 也要看：整批換掉（reload wiped）時 refresh 在 ready=false 期間就換了 running（notice 那時會略過），
      // 等 ready 回 true 才補送，否則常駐通知停在換掉之前的那班（與 TimetableDesktopAgent 同一條）
      if (s.ready !== prev.ready || s.running !== prev.running || s.categories !== prev.categories || s.noticeEnabled !== prev.noticeEnabled || s.longRunMaxMin !== prev.longRunMaxMin) {
        syncAll(false);
      }
    });

    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", onVisibility);
      unsub();
    };
  }, []);

  return null;
}
