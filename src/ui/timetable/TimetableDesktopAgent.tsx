/**
 * TimetableDesktopAgent——桌機全域代理（①a 補充契約 §3：系統匣顯示運行中；mount 的 `desktopOverlay`）。
 * 回 `null`、只有 effect，App 每頁常駐掛一份（`lineOverlays("desktop")`）：
 *   - mount：`store.init("desktop")`（冪等；與 TimetableView 共用同一個 init promise）→ `syncRunningNotice()`（不 force，見下方註解）。
 *     App 一開就知道有沒有運行中——不必先進時刻表頁，系統匣就寫「目前沒有列車在跑」或「創作・14:35 発」。
 *   - 訂閱 store：`ready`／`running`／`categories`／`noticeEnabled` 變化 ⇒ 重送（notice.ts 內部去重）。
 *     別台換車：同步拉到 → `reload` → `refresh` → `running` 換了 ⇒ 這裡跟著換 tooltip。
 * 為什麼要有它：手機有 TimetableMobileAgent，桌機原本沒有全域代理（原契約 §6.1 不填 desktopOverlay），
 * 而 TimetableView 只在時刻表頁掛著——沒有它，系統匣只有進過時刻表頁才會動。
 * 不做「回來時主動問」：那是 useTimetableForeground 的事（頁面層），這支只管系統匣。
 */
import { useEffect } from "react";
import { useTimetableStore } from "../../store/timetableStore";
import { syncRunningNotice } from "./notice";

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
        if (alive) void syncRunningNotice();
      })
      .catch(() => undefined); // 載入失敗已寫進 store.error；頁面會顯示

    const unsub = useTimetableStore.subscribe((s, prev) => {
      // `ready` 也要看：整批換掉（reload wiped）時 refresh 在 ready=false 期間就換了 running（那時 notice 會略過），
      // 等 ready 回 true 才補送，否則系統匣停在換掉之前的那班
      if (s.ready !== prev.ready || s.running !== prev.running || s.categories !== prev.categories || s.noticeEnabled !== prev.noticeEnabled) {
        void syncRunningNotice();
      }
    });

    return () => {
      alive = false;
      unsub();
    };
  }, []);

  return null;
}
