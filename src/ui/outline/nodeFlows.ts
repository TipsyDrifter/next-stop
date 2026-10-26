/**
 * nodeFlows——路線樹上一個節點的「蓋済／運休」流程（手機殼班 D-主-71；從 useOutlineController 的 completeNode／suspendNode 抽出）。
 *
 * 桌機大綱（Space／點検印／U）與手機路線圖（列上検印鈕、⋯ sheet 的運休）走同一支：守門、確認框文案、完成卡觸發一字不差。
 * 口徑（M3 ④）：活著的定期券看 `currentOccurrences`（済／運休蓋在班次上、nodes.status 一路是 todo），其餘看 nodes.status。
 * 樹一律讀 `nodeStore.tree`（桌機大綱與手機路線圖畫的都是 store 目前開著的那條路線）。
 *
 * 後半四支是**詳情面板**的流程——桌機側板（panel/TaskFields、RepeatRuleEditor.TeikiStampRow）與手機詳情頁（mobile/detail）共用同一支
 *   （手機殼班 D-主-82：同一個意思只有一個定義）；判準（現況可選格、検印怎麼畫）在 panel/panelRules。
 *   兩件事留給呼叫端、流程本身不管（桌機側板原本就沒有，收斂時一個字不改）：
 *   - **連點守門**（nodeStore.isSettling）：手機詳情頁在呼叫前先問；桌機側板沒問。
 *   - **完成卡**：手機詳情頁撤済（現況從已完成改走、定期券取消本班済）帶 `retractCard` 收卡；桌機側板不帶＝照舊。
 *   未完成子孫數兩殼都用 `openKidsOf`（第三輪 D-主-83：桌機原本數路線樹、不在樹裡＝0，從今日開的列車改已完成會不問就完成）。
 */
import { KIND_LABEL, canHaveChildren, isTaskKind, parseRule, type NodeKind, type NodeRow, type NodeStatus } from "../../domain";
import { REPEAT_ONLY_MSG, type CurrentOccurrence } from "../../data";
import { isSettling, openDescendantCount, useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";
import { kidCountOf, teikiState } from "../panel/panelRules";

const ns = () => useNodeStore.getState();
const ui = () => useUiStore.getState();
const toast = (message?: string) => {
  if (message) ui().showToast({ message }, 3600);
};

/**
 * 本班運休／取消運休——與今日視圖的 `U` 同一條路（nodeStore.skipOccurrence，不帶 dueOn＝目前那一班）。
 * **只有定期券能運休**，其餘吐 REPEAT_ONLY_MSG。skip 省略＝切換（運休中→取消、否則→運休）。
 */
export async function suspendNodeFlow(id: string, skip?: boolean): Promise<void> {
  const n = ns().tree.byId[id];
  if (!n || isSettling(id)) return;
  if (!parseRule(n.repeat_rule)) {
    toast(REPEAT_ONLY_MSG);
    return;
  }
  const next = skip ?? ns().currentOccurrences[id]?.status !== "skipped";
  const r = await ns().skipOccurrence(id, next);
  if (!r.ok) toast(r.reason);
}

/**
 * F1 完成流（D2／D4）：運休中＝取消運休；已済＝取消済；未済＝蓋済（有未完成子孫先問「連同 N 個…」）；
 * 蓋下去的若是列車／車廂（isTaskKind）⇒ 開完成卡（uiStore.completeCardFor，兩殼同一個槽）。
 *
 * `onFresh(id)`：真的要蓋下去的那一刻叫（呼叫端播印章動畫）；回傳的函式在寫入完成後叫（清動畫旗標的計時器從那時起算）。
 * `retractCard`：取消済時把那張的完成卡一起收起（手機路線圖給；同手機今日／行程表，D-主-73「章撤了卡就不成立」）。
 *   桌機大綱不給＝行為照舊（scheduleActions 也只在手機殼收卡）。
 * 同一節點上一下還在寫（nodeStore.isSettling）＝整支不理：畫面是舊的，照它判會再蓋一次（定期券＝蓋到下一班）。
 */
export async function completeNodeFlow(
  id: string,
  onFresh?: (id: string) => (() => void) | void,
  opts?: { retractCard?: boolean },
): Promise<void> {
  if (isSettling(id)) return;
  const t = ns().tree;
  const n = t.byId[id];
  if (!n) return;
  // 定期券：済蓋在「目前班次」上（repository 已分支），反悔＝撤這一班；nodes.status 一路是 todo。
  const occ: CurrentOccurrence | undefined = ns().currentOccurrences[id];
  // 運休中的班次：點在運休章上（或 Space）＝**取消運休**（A 原型 :60-62／:1061 的検印輪替最後一步），
  // 要蓋済就再來一次。直接蓋會蓋到引擎已推走的「下一班」頭上，故先撤運休再說。
  if (occ?.status === "skipped") {
    await suspendNodeFlow(id, false);
    return;
  }
  if (occ ? occ.status === "done" : n.status === "done") {
    if (opts?.retractCard) retractCardOf(id);
    await ns().setCompleted(id, false);
    return;
  }
  const finish = async (cascade: boolean) => {
    const after = onFresh?.(id);
    await ns().setCompleted(id, true, cascade ? true : undefined);
    if (after) after();
    if (isTaskKind(n.kind)) ui().setCompleteCardFor(id);
  };
  const open = canHaveChildren(n.kind) ? openDescendantCount(t, id) : 0;
  if (open > 0) {
    ui().askConfirm({
      title: `連同 ${open} 個未完成子項一起完成？`,
      body: `「${n.name}」底下還有 ${open} 個未完成的子項，會一併蓋上済章。`,
      confirmLabel: "一起完成",
      onConfirm: () => void finish(true),
    });
    return;
  }
  await finish(false);
}

/**
 * 未完成子孫數（詳情面板改已完成要不要先問；兩殼同一支，D-主-83）：路線樹有這張＝樹裡算到底；
 * 不在樹裡（從今日／行程表點開、路線圖開著別條線）＝今日切片只有直屬數，有子項就回 null（數不清＝一律先問）——判準在 panelRules.kidCountOf。
 */
export function openKidsOf(node: Pick<NodeRow, "id" | "kind">): number | null {
  const s = ns();
  const inTree = s.tree.byId[node.id] !== undefined;
  return kidCountOf(node.kind, inTree ? openDescendantCount(s.tree, node.id) : null, s.today.byId[node.id]);
}

/**
 * 詳情面板「現況」改值：改成已完成＝setCompleted（`open`＝未完成子孫數：>0 先問「連同 N 個…」；null＝數不清，也先問）；
 * 從已完成改走＝先取消済、再寫新狀態；其餘直接 updateNode。面板內改 done 不開完成卡（心情／乘務記錄就在同一面板）。
 * `retractCard`：從已完成改走時把那張的完成卡一起收起（手機詳情頁給；同 completeNodeFlow，D-主-73「章撤了卡就不成立」）。
 */
export function changeStatusFlow(
  node: NodeRow,
  next: NodeStatus,
  open: number | null,
  opts?: { retractCard?: boolean },
): void {
  if (next === node.status) return;
  if (next === "done") {
    if (open === null || open > 0) {
      ui().askConfirm({
        // 數不清（不在已載入的路線樹）：不報數字，照樣先問——寧可多問一次，也不要不問就留一串沒完成的子項在底下
        title: open === null ? "底下的子項也一起完成？" : `連同 ${open} 個未完成子項一起完成？`,
        body:
          open === null
            ? `「${node.name}」底下還沒完成的子項會一併蓋上済章；跟著一起完成的車票，不會自動產生下一張。`
            : "跟著一起完成的車票，不會自動產生下一張。",
        confirmLabel: "一起完成",
        onConfirm: () => void ns().setCompleted(node.id, true, true),
      });
    } else {
      void ns().setCompleted(node.id, true);
    }
    return;
  }
  if (node.status === "done") {
    if (opts?.retractCard) retractCardOf(node.id);
    void (async () => {
      await ns().setCompleted(node.id, false);
      if (next !== "todo") await ns().updateNode(node.id, { status: next });
    })();
    return;
  }
  void ns().updateNode(node.id, { status: next });
}

/**
 * 詳情面板的検印（車票＝済章、定期券＝本班済）：運休中＝取消運休（要蓋済再按一次）；否則済⇄未済切換。
 * `occ`＝這張的目前班次（定期券才有；單發票／退役的看 nodes.status）。
 * 回傳：true＝蓋下去（呼叫端播章動畫）、false＝取消済、null＝這一下沒碰済章（運休中→取消運休；呼叫端動畫旗標不動）。
 * `retractCard`：取消済時把那張的完成卡一起收起（手機詳情頁給，同 changeStatusFlow）。
 */
export function panelStampFlow(
  node: NodeRow,
  occ: CurrentOccurrence | undefined,
  opts?: { retractCard?: boolean },
): boolean | null {
  const { teiki } = teikiState(node);
  if (teiki && occ?.status === "skipped") {
    panelSuspendFlow(node.id, false);
    return null;
  }
  const done = teiki ? occ?.status === "done" : node.status === "done";
  if (done && opts?.retractCard) retractCardOf(node.id);
  void ns().setCompleted(node.id, !done);
  return !done;
}

/** 收起這張的完成卡（槽裡是別張就不動） */
function retractCardOf(id: string): void {
  if (ui().completeCardFor === id) ui().setCompleteCardFor(null);
}

/** 本班運休⇄取消 */
export function panelSuspendFlow(id: string, skip: boolean): void {
  void ns()
    .skipOccurrence(id, skip)
    .then((r) => {
      if (!r.ok) ui().showToast({ message: r.reason ?? "無法運休" }, 4000);
    });
}

/** 轉種類（列車→支線、支線→列車；車廂不給，setKind 也會擋） */
export async function convertKindFlow(node: NodeRow, kind: NodeKind): Promise<void> {
  const r = await ns().setKind(node.id, kind);
  if (!r.ok) ui().showToast({ message: r.reason ?? `無法轉為${KIND_LABEL[kind]}` }, 4000);
}
