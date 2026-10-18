/**
 * taskWatch——蓋済偵測的接線（車次② 契約 0-8、0-16、§3.9；甲席）。
 *
 * 規則全在純函式 `watchStep`（`src/domain/timetableLink.ts`）；本檔只負責把事件餵進去：
 *   - nodeStore 的 `tree`／`today`／`calendar`／`currentOccurrences` 任一換了物件 ⇒ 去抖 300ms `refreshLinks()`（0-16）＋ observe
 *   - timetableStore 的 `running` 換了 ⇒ observe（換班要重設基準）
 *   - syncStore 的 `working`：false→true 記下起點的 `fail_streak`／`last_error`；true→false 餵 `settled`
 *     （這一趟收到過 pulled、或以錯誤收尾 ⇒ dirty ⇒ 抑制並自己重載一次 nodeStore，0-8 的兩個破口）
 *   - `notePulled(changed)`（timetableStore.reload 開頭叫）：含 nodes／occurrences ⇒ 餵 `pulled`
 *   - `watchStep` 回 prompt ⇒ toast「『X』蓋済了，計時還在跑」＋「到着」（10 秒）
 *
 * 參考計數（React StrictMode 開發模式會「掛→清→掛」，`main.tsx:15`）：每次 start 計數 +1、從 0 變 1 才真的訂閱；
 * 回傳的 stop 只生效一次、計數 -1，降到 0 才真的退訂；退訂後再 start 重新訂閱（基準重抓，`prompted` 保留以免同一個蓋済再提示）。
 *
 * 只用 nodeStore 的公開狀態、公開動作 `refresh()` 與 `syncStore.working`／`status`；不改核心任何檔，也不碰核心的完成路徑。
 */
import { useNodeStore } from "../../store/nodeStore";
import { useSyncStore } from "../../store/syncStore";
import { useUiStore } from "../../store/uiStore";
import { TT_TEXT, useTimetableStore } from "../../store/timetableStore";
import { parseRule } from "../../domain/repeat";
import { WATCH_INIT, doneKeyOf, linkLabelOf, watchStep, type WatchEvent, type WatchState } from "../../domain/timetableLink";
import type { NodeRow } from "../../domain/node";

const REFRESH_LINKS_DEBOUNCE_MS = 300;
const PROMPT_TTL_MS = 10_000;

let refs = 0;
let unsubs: (() => void)[] = [];
let state: WatchState = WATCH_INIT;
let linksTimer: ReturnType<typeof setTimeout> | null = null;

/* 這一趟 working 的起點（settled 時判 dirty 用） */
let startStreak = 0;
let startErr: string | null = null;
let sawPulled = false;
/* 這一趟 working 中途看過錯誤（JS 層 catch 先寫的 last_error、或橋接不通的 bridgeError）。
 * runCycle 失敗時先把 JS 的訊息寫進 status.last_error，接著 refreshStatusInner 用 Rust 的狀態蓋回去；
 * Rust 沒 record_error 的失敗（進主流程前就丟錯、IPC 失敗）收尾時就看不出來——所以途中看到就記下（②沙盒 F1）。 */
let sawError = false;

/* 抑制模式的重載 */
let reloading = false;
let reloadAgain = false;

/** 節點在 nodeStore 切片裡的那一列（tree → today → calendar.nodes）；都找不到＝undefined（不知道） */
function nodeRowOf(id: string): NodeRow | undefined {
  const ns = useNodeStore.getState();
  return ns.tree.byId[id] ?? ns.today.byId[id] ?? ns.calendar.nodes[id];
}

function doneKeyFor(nodeId: string): string | null | undefined {
  const row = nodeRowOf(nodeId);
  const isRepeat = row ? parseRule(row.repeat_rule) !== null : false;
  return doneKeyOf(row, useNodeStore.getState().currentOccurrences[nodeId], isRepeat);
}

function feed(e: WatchEvent): void {
  const out = watchStep(state, e);
  state = out.state;
  if (out.prompt !== null) showPrompt(out.prompt);
  if (e.kind === "settled" && e.dirty) startSuppressReload();
}

function observe(): void {
  const r = useTimetableStore.getState().running;
  const nodeId = r ? r.node_id : null; // node_id 優先（linkOfRow 同義）
  const key = r && nodeId ? `${r.id}|${nodeId}` : null;
  feed({ kind: "observe", key, doneKey: nodeId ? doneKeyFor(nodeId) : null, working: useSyncStore.getState().working });
}

function showPrompt(key: string): void {
  const nodeId = key.slice(key.indexOf("|") + 1);
  const tt = useTimetableStore.getState();
  // 名字：nodeStore 那一列最新（linkInfo 的重讀有去抖）；沒有才用 linkInfo
  const label = nodeRowOf(nodeId)?.name ?? (tt.running ? linkLabelOf(tt.running, tt.linkInfo) : null) ?? "";
  useUiStore.getState().showToast(
    {
      message: TT_TEXT.DONE_STILL_RUNNING(label),
      actionLabel: TT_TEXT.ARRIVE_ACTION,
      onAction: () => useTimetableStore.getState().requestArrive(),
    },
    PROMPT_TTL_MS,
  );
}

/**
 * 抑制模式（0-8）：自己重載一次 nodeStore，重載完才退出（refresh 失敗也要退出）。重載期間又收到 dirty 的收尾
 * ⇒ 這一次跑完再補一次（上一次可能在新資料寫進 DB 之前就讀完了）。
 */
function startSuppressReload(): void {
  if (reloading) {
    reloadAgain = true;
    return;
  }
  reloading = true;
  const run = (): void => {
    reloadAgain = false;
    void Promise.resolve()
      .then(() => useNodeStore.getState().refresh())
      .catch(() => undefined)
      .finally(() => {
        if (reloadAgain && refs > 0) {
          run();
          return;
        }
        reloading = false;
        feed({ kind: "unsuppress" });
      });
  };
  run();
}

function scheduleRefreshLinks(): void {
  if (linksTimer !== null) clearTimeout(linksTimer);
  linksTimer = setTimeout(() => {
    linksTimer = null;
    void useTimetableStore.getState().refreshLinks();
  }, REFRESH_LINKS_DEBOUNCE_MS);
}

function markWorkingStart(): void {
  const st = useSyncStore.getState().status;
  startStreak = st?.fail_streak ?? 0;
  startErr = st?.last_error ?? null;
  sawPulled = false;
  sawError = false;
}

function subscribe(): void {
  // 重新訂閱：基準重抓（prompted 保留）；正在一趟 working 中途才掛上 ⇒ 起點就從現在算
  state = { ...WATCH_INIT, prompted: state.prompted };
  if (useSyncStore.getState().working) markWorkingStart();

  unsubs.push(
    useNodeStore.subscribe((s, p) => {
      if (s.tree === p.tree && s.today === p.today && s.calendar === p.calendar && s.currentOccurrences === p.currentOccurrences) return;
      scheduleRefreshLinks();
      observe();
    }),
    useTimetableStore.subscribe((s, p) => {
      if (s.running !== p.running) observe();
    }),
    useSyncStore.subscribe((s, p) => {
      if (s.working === p.working) {
        if (s.working && (s.bridgeError !== null || (s.status?.last_error ?? null) !== startErr)) sawError = true;
        return;
      }
      if (s.working) {
        markWorkingStart();
        return;
      }
      const st = s.status;
      const dirty = sawPulled || sawError || s.bridgeError !== null || (st?.fail_streak ?? 0) > startStreak || (st?.last_error ?? null) !== startErr;
      sawPulled = false;
      sawError = false;
      feed({ kind: "settled", dirty });
    }),
  );
  observe();
}

function unsubscribe(): void {
  for (const u of unsubs) u();
  unsubs = [];
  if (linksTimer !== null) {
    clearTimeout(linksTimer);
    linksTimer = null;
  }
}

/** 兩個代理各自在 effect 裡叫一次；回 stop（只生效一次） */
export function startTaskWatch(): () => void {
  refs += 1;
  if (refs === 1) subscribe();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    refs -= 1;
    if (refs === 0) unsubscribe();
  };
}

/** timetableStore.reload 開頭呼叫（② 契約 §3.8、0-8）：這一趟拉到 nodes／occurrences ⇒ 餵 pulled */
export function notePulled(changed: readonly string[]): void {
  if (refs === 0) return;
  if (!changed.includes("nodes") && !changed.includes("occurrences")) return;
  sawPulled = true;
  feed({ kind: "pulled" });
}
