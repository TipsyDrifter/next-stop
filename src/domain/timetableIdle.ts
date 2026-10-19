/**
 * 「時刻表現在閒了嗎」的等待邏輯（沙盒回報 F3、③ 契約 §9-2；純函式，`scripts/tests/timetable-idle.test.ts` 以 node 直接載入）。
 *
 * 為什麼要等：同步清單（`MergeNotices`）在 `syncStore.refreshStatusInner` 拿到新 status 的那一刻就開始解名字，
 * 但整理（`timetableStore.reload` → `serial(reconcile)`）要等到同一趟 `runCycle` 裡 `refreshAfterPull` 才跑——
 * 順序是 `setState({ status })`（syncStore.ts:872 前的 `refreshStatusInner`）→ node.refresh() → `lineReloads()` → reconcile，
 * 而這一整串都包在 `working: true`（syncStore.ts:866 → :904）之內。名字解析若在整理之前讀列，
 * 被整理刪掉的那塊就讀成「還活著」，不帶「後來又被整理掉」那句，而且之後不會重解。
 * 所以：解 time_blocks 的列之前，先等「同步這一趟收完」＋「serial 佇列清空」。
 *
 * 這裡不碰 store：呼叫端把 `working` 的讀取／訂閱與 serial 鏈的尾巴注入進來（`timetableStore.whenTimetableIdle`）。
 */

export interface IdleProbe {
  /** 同步一趟正在跑（＝`useSyncStore.getState().working`） */
  syncWorking(): boolean;
  /** 訂閱「同步 working 有變」；回傳取消訂閱 */
  onSyncChange(cb: () => void): () => void;
  /** 目前 serial 佇列的尾巴（永不 reject）；排進新的之後會換一個 promise */
  chainTail(): Promise<unknown>;
}

/** 等到 `syncWorking()` 變 false（逾時就放行——別的長動作也會把 working 拉高，不能讓清單一直空著） */
function waitSyncCycle(p: IdleProbe, timeoutMs: number): Promise<void> {
  if (!p.syncWorking()) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    let unsub: () => void = () => undefined;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsub();
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    unsub = p.onSyncChange(() => {
      if (!p.syncWorking()) finish();
    });
    // 訂閱之前就收完的（極端時序）：補看一次
    if (!p.syncWorking()) finish();
  });
}

/** 等 serial 佇列：每等完一段，看尾巴有沒有換（等的時候又有人排進來）；最多追 `maxHops` 段，避免被持續寫入拖住 */
async function waitChain(p: IdleProbe, maxHops: number): Promise<void> {
  for (let i = 0; i < maxHops; i++) {
    const tail = p.chainTail();
    await tail;
    if (tail === p.chainTail()) return;
  }
}

/**
 * 先等同步一趟收完（它的 reload／reconcile 都包在裡面），再等佇列。
 * 同步沒在跑、佇列是空的 ⇒ 只花幾個 microtask。
 */
export async function waitTimetableIdle(p: IdleProbe, opts?: { syncTimeoutMs?: number; maxHops?: number }): Promise<void> {
  await waitSyncCycle(p, opts?.syncTimeoutMs ?? 6000);
  await waitChain(p, opts?.maxHops ?? 4);
}
