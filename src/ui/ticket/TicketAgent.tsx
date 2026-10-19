/**
 * TicketAgent——售票口線的全域代理（車次①契約 §3.8.4；甲席）。回 null、零 DOM。
 *
 * 掛在 mount 的 `desktopOverlay` 與 `mobileOverlay`（兩殼永不同時渲染 ⇒ 只會有一個實例、一組計時器）：
 *   - App 一啟動就 `warm()`：起手三列、帳戶名（捕捉框的落點「售票口 · 現金」才寫得出來）
 *   - 掛沙盒除錯入口 `window.__nsTicket.importFromPath(path)`（0-34）：＝對話框選完之後的同一條路，
 *     CDP 進不了原生選檔對話框，沙盒席以它帶複本路徑。權限與對話框相同（Rust command 本來就收任意路徑）。
 *   - 第③階段（③契約 0-6、§3.9）：定期帳的實體化排程。觸發點：
 *       (a) 啟動（warm 之後；**先拉後記**：有加入同步 ⇒ 等第一趟拉完（`last_sync_at` 變）或 30 秒逾時才跑，沒加入就直接跑）
 *       (b) 同步拉完（mount 的 `afterPull`，整合席填）
 *       (c) 跨過日界線：每 60 秒看一次（只在畫面可見時）＋回到前景那一下（useOnResume），比 `todayKey(dayStartHour)` 和上次的「今天」
 *     `window.__nsTicket.materializeNow()`＝手動跑一次（沙盒與 mock 走查「跨日」用）。
 *     只讀核心 store 的同步狀態（C-4），不改它。失敗只 console.warn、不 toast（store 的 materialize 處理）。
 */
import { useEffect, useRef } from "react";
import { useTicketStore } from "../../store/ticketStore";
import { useUiStore } from "../../store/uiStore";
import { useSyncStore } from "../../store/syncStore";
import { todayKey } from "../../lib/date";
import { useOnResume } from "./resume";

declare global {
  interface Window {
    __nsTicket?: { importFromPath(p: string): Promise<void>; materializeNow(): Promise<void> };
  }
}

/** 先拉後記的逾時（0-6-2） */
const FIRST_PULL_TIMEOUT_MS = 30_000;
/** 跨日檢查的間隔（照 syncStore 的寫法） */
const DAY_TICK_MS = 60_000;

const store = () => useTicketStore.getState();
const currentDay = () => todayKey(useUiStore.getState().dayStartHour);

/**
 * 啟動那一次（只跑一次）：加入同步 ⇒ 等 last_sync_at 變或逾時；否則立刻。
 * syncStore 的 status 初值是 null、booting true（要等 boot() 叫 Rust 才有值）：booting 期間**還不知道**有沒有加入同步，
 * 先等 booting 變 false 再判斷（修正-資料，評審 R18）——warm() 比 boot() 先完成時，加入同步的機器不會跳過先拉後記。
 * 逾時 30 秒從一開始就計（等 boot 與等第一趟拉完共用同一個）。
 */
function scheduleStartup(): () => void {
  let done = false;
  let timer: number | null = null;
  let unsub: (() => void) | null = null;
  const stopWatching = () => {
    if (unsub) unsub();
    unsub = null;
  };
  const run = () => {
    if (done) return;
    done = true;
    if (timer !== null) window.clearTimeout(timer);
    stopWatching();
    void store().materialize("startup");
  };
  /** boot 已回來：沒加入同步 ⇒ 立刻；加入了 ⇒ 等 last_sync_at 變 */
  const decide = () => {
    if (done) return;
    const status = useSyncStore.getState().status;
    if (!status?.configured) {
      run();
      return;
    }
    const first = status.last_sync_at;
    unsub = useSyncStore.subscribe((s) => {
      const at = s.status?.last_sync_at ?? null;
      if (at !== null && at !== first) run();
    });
  };
  timer = window.setTimeout(run, FIRST_PULL_TIMEOUT_MS);
  if (useSyncStore.getState().booting) {
    unsub = useSyncStore.subscribe((s) => {
      if (s.booting) return;
      stopWatching();
      decide();
    });
  } else decide();
  return () => {
    done = true;
    if (timer !== null) window.clearTimeout(timer);
    stopWatching();
  };
}

export function TicketAgent() {
  const lastDay = useRef(currentDay());
  const tick = () => {
    if (document.visibilityState !== "visible") return;
    const d = currentDay();
    if (d === lastDay.current) return;
    lastDay.current = d;
    void store().materialize("day");
  };
  useOnResume(tick);

  useEffect(() => {
    let cancelStartup: (() => void) | null = null;
    let alive = true;
    // warm 失敗（例：Stage 0 的 SQLite 骨架）不讓它變成未處理的 rejection；進頁時 init 會再試、失敗寫進 error
    void store()
      .warm()
      .then(() => {
        if (alive) cancelStartup = scheduleStartup();
      })
      .catch((e) => console.warn("[ticket] warm 失敗", e));
    window.__nsTicket = {
      importFromPath: (p: string) => {
        store().openDialog({ kind: "import" });
        return store().importFromPath(p);
      },
      materializeNow: () => store().materialize("manual"),
    };
    const timer = window.setInterval(tick, DAY_TICK_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
      if (cancelStartup) cancelStartup();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}
