/**
 * noticePending——把通知上按的換車／到着（Kotlin 的待處理佇列）套進資料庫（①b①c 契約 §3.9、§5.10.8；丙席）。
 *
 * 一趟（`drainPending`）：
 *   1. 冷啟動／回前景先等同步一趟（≤5 秒，`waitForTimetableSyncSettle`；§3.9：縮小「別台同時換車」的時序窗）；plugin 事件不等。
 *   2. `ttTakePending()`（只讀不清，契約 0-6）→ `sortPending`（at 遞增；不合法的排最後、歸 invalid）。
 *   3. 逐筆套：
 *      - depart：新塊 id＝`noticeBlockId(action.id)`（uuid v5，確定性）；`blockExists` ⇒ duplicate（套過了）；
 *        分類不在（或已刪、或是頂層組）⇒ dropped unknownCategory（封存的照樣套：`noticeDepartCategoryOk`）；否則 `departPending(…, untilNext: PENDING_DEPART_UNTIL_NEXT)`，
 *        回 null ⇒ dropped covered（那段時間另一台已經記了別的）。
 *      - arrive：`arrivePending(at)`；`[]` ⇒ dropped noRunning。到着的冪等靠規則本身（第二次已經沒有開始早於 at 的運行中）。
 *      單筆丟錯（DB 錯）⇒ 該筆**不 ack**、停止這一趟（下次再試；前面套過的照樣 ack）。
 *   4. `ttAckPending(套過的全部 id)`（含 dropped、duplicate、invalid）。
 *   5. `launch`：點提醒回來（ask）⇒ 切到時刻表 tab＋`autoAsk("foreground", true)`；點通知本體（open）⇒ 切到時刻表 tab。
 *   6. toast：只吐被丟掉的（同一趟同一種原因只算一次；toast 只有一格，好幾種原因併成一則）；套上的不吐（契約 0-17）。
 *      排在切 tab 之後：換 tab 會收 toast（UI 丙-1，視覺規範 §2.8）。
 *   7. 這一趟有取到東西（動作或 launch）⇒ `syncRunningNotice({force})`＋`syncLongRunReminder({force})`：
 *      Kotlin 在佇列沒清空時不讓 JS 蓋掉樂觀更新的 running／提醒，ack 完這一次 force 才把真正的狀態送回去。
 *      什麼都沒取到 ⇒ 不重送（呼叫端 Agent 回前景／冷啟動自己會同步一次）。
 * 寫入一律包在 store 的 `timetableWrite(fn)`（＝serial＋成功後 refresh；契約 0-12），本模組不自己開 serial。
 * 同一時間只跑一趟；跑的時候又被觸發 ⇒ 跑完補一趟（補的那趟不再等同步）。
 */
import { timetableRepo } from "../../data/timetableRepository";
import { isoOf } from "../../domain/timetable";
import {
  PENDING_DEPART_UNTIL_NEXT,
  TT_NOTICE_TEXT,
  noticeDepartCategoryOk,
  pendingIsValid,
  sortPending,
  type PendingAction,
  type PendingOutcome,
} from "../../domain/timetableNotice";
import { timetableWrite, useTimetableStore, waitForTimetableSyncSettle } from "../../store/timetableStore";
import { useUiStore } from "../../store/uiStore";
import { syncLongRunReminder, syncRunningNotice } from "./notice";
import { noticeBlockId, noticeLog, ttAckPending, ttTakePending } from "./ttNoticeBridge";

/** 誰觸發這一趟：冷啟動（mount）／回前景／plugin 事件（App 活著、主人在通知上按） */
export type DrainReason = "launch" | "foreground" | "event";

/** 冷啟動／回前景時先等同步的上限（契約 §3.9） */
const SETTLE_MS = 5_000;

type DropReason = Extract<PendingOutcome, { kind: "dropped" }>["reason"];

const DROP_TEXT: Partial<Record<DropReason, string>> = {
  noRunning: TT_NOTICE_TEXT.droppedArrive,
  unknownCategory: TT_NOTICE_TEXT.droppedDepartCategory,
  covered: TT_NOTICE_TEXT.droppedDepartCovered,
};

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 套一筆（丟錯＝DB 錯，呼叫端不 ack、停這一趟） */
async function applyOne(a: PendingAction): Promise<PendingOutcome> {
  if (!pendingIsValid(a)) return { kind: "dropped", reason: "invalid" };
  const atIso = isoOf(a.at);
  if (a.kind === "depart") {
    const fixedId = await noticeBlockId(a.id);
    if (await timetableWrite(() => timetableRepo.blockExists(fixedId))) return { kind: "duplicate" };
    const cat = a.categoryId !== null ? useTimetableStore.getState().catById[a.categoryId] : undefined;
    if (!noticeDepartCategoryOk(cat)) return { kind: "dropped", reason: "unknownCategory" };
    const row = await timetableWrite(() =>
      timetableRepo.departPending(cat.id, atIso, { fixedId, untilNext: PENDING_DEPART_UNTIL_NEXT }),
    );
    return row ? { kind: "departed", blockId: row.id } : { kind: "dropped", reason: "covered" };
  }
  const rows = await timetableWrite(() => timetableRepo.arrivePending(atIso));
  return rows.length ? { kind: "arrived", blockIds: rows.map((r) => r.id) } : { kind: "dropped", reason: "noRunning" };
}

async function drainOnce(reason: DrainReason): Promise<void> {
  const st = useTimetableStore.getState();
  if (!st.ready) {
    // Agent 一律先 init 再叫；保險起見這裡也等一次（init 冪等）。載入失敗 ⇒ 這一趟放棄（佇列留著，下次再套）
    try {
      await st.init("mobile");
    } catch {
      return;
    }
  }
  if (reason !== "event") await waitForTimetableSyncSettle(SETTLE_MS);

  const { actions, launch } = await ttTakePending();
  if (!actions.length && !launch) return;

  const acked: string[] = [];
  const dropped = new Set<DropReason>();
  const outcomes: string[] = [];
  for (const a of sortPending(actions)) {
    let out: PendingOutcome;
    try {
      out = await applyOne(a);
    } catch (e) {
      console.warn(`[tt:notice] 套用通知上的動作失敗（${a.kind} ${a.id}），這一趟先停：`, errText(e));
      break;
    }
    acked.push(a.id);
    outcomes.push(out.kind === "dropped" ? `dropped:${out.reason}` : out.kind);
    if (out.kind === "dropped") dropped.add(out.reason);
  }
  if (outcomes.length) noticeLog("take", `套用 ${outcomes.length}/${actions.length} 筆（${reason}）：${outcomes.join("、")}`);

  try {
    await ttAckPending(acked);
  } catch (e) {
    // ack 失敗：下一趟會再取到同一批——depart 有確定性 id（duplicate）、arrive 規則冪等，重套無害
    console.warn("[tt:notice] 確認佇列失敗（下次重套，冪等）：", errText(e));
  }

  // toast 只有一格（後一則蓋前一則）⇒ 同一趟好幾種原因併成一則，依 noRunning → unknownCategory → covered
  const ui = useUiStore.getState();
  const msgs: string[] = [];
  for (const r of ["noRunning", "unknownCategory", "covered"] as const) {
    const msg = DROP_TEXT[r];
    if (dropped.has(r) && msg) msgs.push(msg);
  }

  if (launch && (launch.ask !== null || launch.open)) {
    ui.setMobileTab("timetable");
    if (launch.ask !== null) useTimetableStore.getState().autoAsk("foreground", true);
  }

  // 先切 tab 再吐：setMobileTab 換 tab 會收 toast（視覺規範 §2.8），反過來從別的 tab 被帶進來時這則會當場被收掉
  if (msgs.length) ui.showToast({ message: msgs.join("；") });

  await syncRunningNotice({ force: true });
  await syncLongRunReminder({ force: true });
}

let draining: Promise<void> | null = null;
let again = false;

/**
 * 套用通知上的待處理動作（§3.9 的三個時機：`launch`＝冷啟動、`foreground`＝回前景、`event`＝plugin 事件）。
 * 正在跑時再被叫 ⇒ 回同一個 Promise，跑完補一趟（以 `event` 跑：不再等同步）。不丟錯。
 */
export function drainPending(reason: DrainReason): Promise<void> {
  if (draining) {
    again = true;
    return draining;
  }
  draining = (async () => {
    try {
      let r: DrainReason = reason;
      for (;;) {
        again = false;
        try {
          await drainOnce(r);
        } catch (e) {
          console.warn("[tt:notice] 套用待處理動作失敗：", errText(e));
        }
        if (!again) break;
        r = "event";
      }
    } finally {
      draining = null;
    }
  })();
  return draining;
}
