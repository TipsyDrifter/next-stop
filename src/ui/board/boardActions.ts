/**
 * 看板換欄（⑫；契約 §1）——兩殼、單條路線與跨路線共用。一張與一批走同一條路：
 *
 *   讀最新的兩格（快照）→ 照 domain/boardMove 的計畫逐張寫 repository → 全部寫完才 refresh 一次 → 一則 toast 附「復原」。
 *   復原＝從最新的兩格走回快照（換欄之後按過検印、同步進來都算得對），不開完成卡。
 *   寫不進去的那幾張：還原回去、算「沒改」，在 toast 第二行說（同 batchActions.finish）；一張都沒改＝只吐理由、不給復原。
 *
 * 不經 nodeStore 的單張動作（同 batchActions）：它們每寫一張就整頁 refresh、失敗還吞掉。
 * `nodeFlows.completeNodeFlow` 只認目前開著那條路線的樹，這裡不走它；規則照它：運休中先取消運休、済在定期券上就是蓋目前班次、
 * 列車與車廂蓋済開完成卡、同一張還在寫就不理（whileSettling）。
 * 有子項的列車與車廂（只有「誤點」條件會列出來，domain/taskFilter）：蓋済先問「連同未完成子項」，走 changeStatusFlow。
 */
import { nodeRepo } from "../../data";
import { isTaskKind, type NodeRow } from "../../domain";
import { STATUS_COLUMN_LABEL, type BoardStatus } from "../../domain/board";
import { planCardMove, readCardStates, restoreCardStates, runCardSteps, type CardDay, type CardState, type CardStep } from "../../domain/boardMove";
import type { SlotAnchor } from "../../domain/nodeOrder";
import type { TaskRow } from "../../domain/taskFilter";
import { todayKey } from "../../lib/date";
import { APPEND, moveWithUndo } from "../../store/batchActions";
import { isSettling, useNodeStore, whileSettling } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";
import { changeStatusFlow, openKidsOf } from "../outline/nodeFlows";

const ns = () => useNodeStore.getState();
const ui = () => useUiStore.getState();
const today = (): CardDay => ({ dateKey: todayKey(ui().dayStartHour), dayStartHour: ui().dayStartHour });
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const SORRY = "沒有改成功——請再試一次";

interface Written<S> {
  /** 真的動了的那幾張的快照（復原用） */
  moved: Map<string, S>;
  failed: string[];
}

/** 一批寫入：讀快照 → 逐張寫（回 false＝這張本來就是這樣）→ refresh 一次。同一張還在寫就跳過 */
async function writeCards<S>(
  ids: readonly string[],
  read: (ids: readonly string[]) => Promise<ReadonlyMap<string, S>>,
  write: (id: string, was: S) => Promise<boolean>,
): Promise<Written<S>> {
  const free = ids.filter((id) => !isSettling(id));
  return whileSettling(free, async () => {
    const out: Written<S> = { moved: new Map(), failed: [] };
    try {
      const before = await read(free);
      for (const [id, was] of before) {
        try {
          if (await write(id, was)) out.moved.set(id, was);
        } catch (e) {
          out.failed.push(msg(e));
        }
      }
    } catch (e) {
      out.failed.push(msg(e));
    }
    await ns().refresh();
    return out;
  });
}

/** 收尾：一則 toast（第二行講沒改的，附復原）；一張都沒動＝只有失敗才出聲 */
function report(w: Written<unknown>, message: (count: number) => string, undo: () => Promise<void>): void {
  if (!w.moved.size) {
    if (w.failed.length) ui().showToast({ message: w.failed[0] || SORRY }, 4000);
    return;
  }
  ui().showToast({
    message: message(w.moved.size),
    sub: w.failed.length ? `${w.failed.length} 張沒改：${w.failed[0]}` : undefined,
    actionLabel: "復原",
    onAction: () => void undo(),
  });
}

/** 章撤了卡就不成立（D-主-73） */
function retractCard(ids: Iterable<string>): void {
  const open = ui().completeCardFor;
  if (open && [...ids].includes(open)) ui().setCompleteCardFor(null);
}

/** 一張照計畫寫；寫到一半失敗就走回快照（單發票的完成與現況是兩步，不留半套），理由往外丟 */
async function writeSteps(id: string, was: CardState, steps: readonly CardStep[]): Promise<boolean> {
  if (!steps.length) return false;
  try {
    await runCardSteps(nodeRepo, id, steps, today());
    return true;
  } catch (e) {
    await restoreCardStates(nodeRepo, new Map([[id, was]]), today()).catch(() => undefined);
    throw e;
  }
}

const readStates = (ids: readonly string[]) => readCardStates(nodeRepo, ids, today());

async function undoStates(snapshot: ReadonlyMap<string, CardState>): Promise<void> {
  // 取消済的那幾張先收完成卡；復原本身不開卡
  retractCard(snapshot.keys());
  const failed = await whileSettling([...snapshot.keys()], async () => {
    const f = await restoreCardStates(nodeRepo, snapshot, today()).catch((e: unknown) => [msg(e)]);
    await ns().refresh();
    return f;
  });
  if (failed.length) ui().showToast({ message: `${failed.length} 張沒復原：${failed[0] || SORRY}` }, 4000);
}

/**
 * 卡上的検印（兩殼、跨路線共用）：運休中＝取消運休、已済＝取消済、其餘蓋済；回有沒有蓋下去（播章動畫）。
 * 同 `completeNodeFlow` 的輪替，但不靠目前開著的那棵樹。不吐成功的 toast（同大綱的章）。
 */
export async function stampCard(node: TaskRow): Promise<boolean> {
  if (isSettling(node.id)) return false;
  if (node.has_kids) {
    changeStatusFlow(node, "done", openKidsOf(node));
    return false;
  }
  let stamped = false;
  const w = await writeCards([node.id], readStates, (id, was) => {
    if (was.run?.status === "skipped") return writeSteps(id, was, [{ op: "unskip", due_on: was.run.due_on }]);
    const settled = was.run?.status === "done" || was.status === "done";
    stamped = !settled;
    return writeSteps(id, was, planCardMove(was, settled ? "todo" : "done"));
  });
  if (w.failed.length) ui().showToast({ message: w.failed[0] || SORRY }, 4000);
  if (!w.moved.size) return false;
  if (stamped) {
    if (isTaskKind(node.kind)) ui().setCompleteCardFor(node.id);
  } else retractCard([node.id]);
  return stamped;
}

/** 卡換到某一欄；toast 附復原 */
export function moveCardToStatus(node: TaskRow, to: BoardStatus): Promise<void> {
  return moveCardsToStatus([node], to);
}

/** 一批卡換欄：一則 toast、一次復原 */
export async function moveCardsToStatus(nodes: readonly TaskRow[], to: BoardStatus): Promise<void> {
  if (nodes.length === 1 && to === "done" && nodes[0].has_kids) {
    changeStatusFlow(nodes[0], "done", openKidsOf(nodes[0]));
    return;
  }
  const w = await writeCards(nodes.map((n) => n.id), readStates, (id, was) => writeSteps(id, was, planCardMove(was, to)));
  if (to !== "done") retractCard(w.moved.keys());
  else if (w.moved.size === 1) {
    const only = nodes.find((n) => w.moved.has(n.id));
    if (only && isTaskKind(only.kind)) ui().setCompleteCardFor(only.id);
  }
  const label = STATUS_COLUMN_LABEL[to];
  report(w, (n) => (n > 1 ? `已把 ${n} 張移到${label}` : `已移到${label}`), () => undoStates(w.moved));
}

const readStations = async (ids: readonly string[]) => {
  const out = new Map<string, string | null>();
  for (const id of ids) {
    const n = await nodeRepo.getNode(id);
    if (n && n.deleted_at === null) out.set(id, n.station_id);
  }
  return out;
};

const writeStation = (id: string, stationId: string | null) => nodeRepo.update(id, { station_id: stationId }, today());

/** 卡換車站（null＝還沒排站）；一批一則 toast、一次復原 */
export async function setCardsStation(nodes: readonly NodeRow[], stationId: string | null, label: string): Promise<void> {
  const w = await writeCards(nodes.map((n) => n.id), readStations, async (id, was) => {
    if (was === stationId) return false;
    await writeStation(id, stationId);
    return true;
  });
  report(
    w,
    (n) => (n > 1 ? `已把 ${n} 張移到${label}` : `已移到${label}`),
    async () => {
      const back = await writeCards([...w.moved.keys()], async () => w.moved, async (id, was) => {
        await writeStation(id, was);
        return true;
      });
      if (back.failed.length) ui().showToast({ message: `${back.failed.length} 張沒復原：${back.failed[0]}` }, 4000);
    },
  );
}

/** 依列車的落點：放到 parentId 底下、鄰居之間（同一支 moveWithUndo＝寫 sort_key、附復原） */
export function moveCardToHolder(ids: readonly string[], parentId: string, anchor: SlotAnchor, name: string): Promise<boolean> {
  return moveWithUndo(ids, parentId, anchor, ids.length > 1 ? `已把 ${ids.length} 張移到「${name}」` : `已移到「${name}」`);
}

export { APPEND };
