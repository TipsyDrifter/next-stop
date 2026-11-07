/**
 * 看板換欄的寫入計畫（⑫；契約 docs/research/2026-11-06-⑫看板與篩選-契約.md §1）：快照 → 寫 → 復原，只有這一條路。
 * 看板拖曳、卡 ⋯、検印（ui/board/boardActions）與選取列蓋済（store/batchActions）共用。
 *
 * 一張卡的「狀態」有兩格：`nodes.status`，以及結局（定期券＝目前班次的済或運休；單發票與退役的定期券＝status 是不是 done）。
 * 這裡把「現在的兩格」與「要變成的兩格」比一比，排出要寫哪幾步；寫之前不假設現況，復原也一樣——
 * 換欄之後使用者可能又按了検印、另一台可能同步進來，復原永遠從**最新**的兩格走回快照。
 *
 * 定期券的兩條規矩（§1）：
 *   - 蓋済時 status 順手回 todo：下一班從未開始算，隔天不會自己回到進行中。
 *   - 取消済只撤班次、不動 status，所以從済欄拖到別欄要多寫一步 status。
 * 寫入的規則（守門、班次推算、事件）都在 repository，這裡只排順序；repository 由呼叫端注入，node 測得到。
 * 純函式＋注入，不碰 store／DOM／Tauri；import 一律帶 `.ts`。
 */
import type { BoardStatus } from "./board.ts";
import type { NodeKind, NodeRow, NodeStatus } from "./node.ts";
import { parseRule } from "./repeat.ts";
import type { OccurrenceLike } from "./taskFilter.ts";

export interface CardState {
  kind: NodeKind;
  status: NodeStatus;
  /** 活著的定期券：結局蓋在班次上。退役的與單發票看 status */
  teiki: boolean;
  /** 目前班次的結局；沒有＝這一班還沒交代 */
  run: OccurrenceLike | null;
}

export type CardStep =
  | { op: "complete" }
  | { op: "uncomplete" }
  | { op: "skip"; due_on?: string }
  | { op: "unskip"; due_on: string }
  | { op: "status"; status: NodeStatus };

type Outcome = "done" | "skipped" | null;

function outcomeOf(s: Pick<CardState, "status" | "run">): Outcome {
  if (s.run) return s.run.status === "done" ? "done" : "skipped";
  return s.status === "done" ? "done" : null;
}

/** 有結局了沒（済或本班運休）：選取列蓋済看這格，不能照 nodes.status——定期券一路是 todo，會蓋到下一班頭上 */
export function cardSettled(s: Pick<CardState, "status" | "run">): boolean {
  return outcomeOf(s) !== null;
}

/** 從現在的兩格走到目標的兩格。結局先、status 後：結局寫不進去時 status 不會先變 */
function planTo(cur: CardState, goal: { status: NodeStatus; outcome: Outcome; due_on?: string }): CardStep[] {
  const from = outcomeOf(cur);
  const sameOutcome = from === goal.outcome && (goal.due_on === undefined || cur.run?.due_on === goal.due_on);
  const steps: CardStep[] = [];
  let status = cur.status;
  if (!sameOutcome) {
    if (from === "done") steps.push({ op: "uncomplete" });
    if (from === "skipped") steps.push({ op: "unskip", due_on: cur.run!.due_on });
    if (goal.outcome === "done") steps.push({ op: "complete" });
    if (goal.outcome === "skipped") steps.push({ op: "skip", due_on: goal.due_on });
    // 單發票的済寫在 status 上：setCompleted 會順手改掉它
    if (!cur.teiki) {
      if (goal.outcome === "done") status = "done";
      else if (from === "done") status = "todo";
    }
  }
  if (goal.status !== "done" && status !== goal.status) steps.push({ op: "status", status: goal.status });
  return steps;
}

/** 換到某一欄；放回原欄又沒有運休要取消＝空（呼叫端當沒動） */
export function planCardMove(cur: CardState, to: BoardStatus): CardStep[] {
  if (to === "done") return planTo(cur, { status: cur.teiki ? "todo" : "done", outcome: "done" });
  return planTo(cur, { status: to, outcome: null });
}

/** 復原：從最新的兩格走回快照 */
export function planCardRestore(cur: CardState, was: CardState): CardStep[] {
  return planTo(cur, { status: was.status, outcome: outcomeOf(was), due_on: was.run?.due_on });
}

/** 寫入要的 repository 那幾支（NodeRepository 的子集） */
export interface CardWriter {
  getNode(id: string): Promise<NodeRow | null>;
  listCurrentOccurrences(dateKey: string, dayStartHour?: number): Promise<Record<string, OccurrenceLike | undefined>>;
  setCompleted(id: string, done: boolean, opts?: { cascade?: boolean; dateKey?: string; dayStartHour?: number }): Promise<unknown>;
  skipOccurrence(id: string, skip: boolean, dateKey: string, dayStartHour?: number, dueOn?: string | null): Promise<void>;
  update(id: string, patch: { status: NodeStatus }, opts?: { dateKey?: string; dayStartHour?: number }): Promise<void>;
}

/** 這一天的尺（日界線跟畫面同一把） */
export interface CardDay {
  dateKey: string;
  dayStartHour: number;
}

/** 讀最新的兩格（不看切片：切片可能還沒重載完）；查不到的不列 */
export async function readCardStates(repo: CardWriter, ids: readonly string[], day: CardDay): Promise<Map<string, CardState>> {
  const out = new Map<string, CardState>();
  if (!ids.length) return out;
  const occ = await repo.listCurrentOccurrences(day.dateKey, day.dayStartHour);
  for (const id of ids) {
    const n = await repo.getNode(id);
    if (!n || n.deleted_at !== null) continue;
    const o = occ[id];
    out.set(id, {
      kind: n.kind,
      status: n.status,
      teiki: parseRule(n.repeat_rule) !== null && n.status !== "done",
      run: o ? { status: o.status, due_on: o.due_on } : null,
    });
  }
  return out;
}

export async function runCardSteps(repo: CardWriter, id: string, steps: readonly CardStep[], day: CardDay, opts?: { cascade?: boolean }): Promise<void> {
  for (const s of steps) {
    switch (s.op) {
      case "complete":
        await repo.setCompleted(id, true, { cascade: opts?.cascade, dateKey: day.dateKey, dayStartHour: day.dayStartHour });
        break;
      case "uncomplete":
        await repo.setCompleted(id, false, { dateKey: day.dateKey, dayStartHour: day.dayStartHour });
        break;
      case "skip":
        await repo.skipOccurrence(id, true, day.dateKey, day.dayStartHour, s.due_on);
        break;
      case "unskip":
        await repo.skipOccurrence(id, false, day.dateKey, day.dayStartHour, s.due_on);
        break;
      case "status":
        await repo.update(id, { status: s.status }, { dateKey: day.dateKey, dayStartHour: day.dayStartHour });
        break;
    }
  }
}

/** 走回快照（只碰 `snapshot` 裡有的）。回寫不回去的那幾張的理由 */
export async function restoreCardStates(repo: CardWriter, snapshot: ReadonlyMap<string, CardState>, day: CardDay): Promise<string[]> {
  const latest = await readCardStates(repo, [...snapshot.keys()], day);
  const failed: string[] = [];
  for (const [id, was] of snapshot) {
    const cur = latest.get(id);
    if (!cur) continue; // 已經刪了：沒有東西要還原
    try {
      await runCardSteps(repo, id, planCardRestore(cur, was), day);
    } catch (e) {
      failed.push(e instanceof Error ? e.message : String(e));
    }
  }
  return failed;
}
