/**
 * batchActions——多選後一次改一批票（回饋乙 D-主-152；契約 §4）。桌機選取列與手機選取列共用這一份。
 *
 * 每個動作：逐張寫（沿用單張的同一支 repository 函式＝同一組守門與規則）→ 全部寫完才 refresh 一次 →
 *   一則 toast「已改 N 張」附「復原」（照原值逐張寫回）。做不到的那幾張（例：定期券不能直接改乘車日）跳過、在 toast 第二行說。
 * 不經 nodeStore 的單張動作：它們每寫一張就整頁 refresh 一次，一批 20 張會閃 20 次。
 */
import { nodeRepo } from "../data";
import { tagRepo } from "../data/tagRepo";
import { canHaveChildren, parseRule, type NodeRow, type Priority, type RepeatRule } from "../domain";
import { dedupeSubtreeRoots } from "../domain/moveTo";
import { cardSettled, planCardMove, readCardStates, restoreCardStates, runCardSteps } from "../domain/boardMove";
import type { SlotAnchor } from "../domain/nodeOrder";
import { todayKey } from "../lib/date";
import { useNodeStore } from "./nodeStore";
import { useTagStore } from "./tagStore";
import { useUiStore } from "./uiStore";
import { useSelectionStore } from "./selectionStore";

const ui = () => useUiStore.getState();
const ns = () => useNodeStore.getState();
const dateKey = () => todayKey(ui().dayStartHour);
const dayStart = () => ui().dayStartHour;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface Outcome {
  done: string[];
  skipped: { id: string; why: string }[];
}

async function eachOf(ids: readonly string[], fn: (id: string) => Promise<void>): Promise<Outcome> {
  const out: Outcome = { done: [], skipped: [] };
  for (const id of ids) {
    try {
      await fn(id);
      out.done.push(id);
    } catch (e) {
      out.skipped.push({ id, why: msg(e) });
    }
  }
  return out;
}

/** 收尾：refresh 一次、吐 toast（有復原就附）、選取照舊留著（還可以接著改別的） */
async function finish(verb: string, o: Outcome, undo?: () => Promise<void>, message?: string) {
  await ns().refresh();
  if (!o.done.length) {
    ui().showToast({ message: o.skipped[0]?.why ?? "這些票都沒辦法這樣改" }, 4000);
    return;
  }
  const sub = o.skipped.length ? `${o.skipped.length} 張沒改：${o.skipped[0].why}` : undefined;
  ui().showToast({
    message: message && o.done.length === 1 && !o.skipped.length ? message : `已${verb} ${o.done.length} 張`,
    sub,
    ...(undo
      ? {
          actionLabel: "復原",
          onAction: () =>
            void (async () => {
              await undo();
              await ns().refresh();
              await useTagStore.getState().loadIndex();
            })(),
        }
      : {}),
  });
}

async function rows(ids: readonly string[]): Promise<Map<string, NodeRow>> {
  const m = new Map<string, NodeRow>();
  for (const id of ids) {
    const n = await nodeRepo.getNode(id);
    if (n) m.set(id, n);
  }
  return m;
}

/**
 * 改乘車日（null＝清掉）；定期券由 repository 擋下（一句指路），算在「沒改」。
 * 若原本 `due_on === scheduled_on`（同乘車日），改乘車日時自動同步推進 `due_on`。
 * `single`＝只改一張時 toast 的字（拖到日期：「已改到 11/3（二）」）；多張照舊「已改期 N 張」。
 */
export async function batchSetDate(ids: readonly string[], date: string | null, single?: string): Promise<void> {
  const before = await rows(ids);
  const dk = dateKey();
  const opts = { dateKey: dk, dayStartHour: dayStart() };
  const o = await eachOf(ids, async (id) => {
    const b = before.get(id);
    await nodeRepo.reschedule(id, date, dk);
    if (date !== null && b?.scheduled_on && b.due_on === b.scheduled_on) {
      await nodeRepo.update(id, { due_on: date }, opts);
    }
  });
  await finish(date ? "改期" : "清掉乘車日", o, async () => {
    for (const id of o.done) {
      const b = before.get(id);
      if (!b) continue;
      // 繰越章與今日手排位置一起放回去（F-2，同 showRescheduleToast）；reschedule 只管日期
      await nodeRepo.reschedule(id, b.scheduled_on, dk).catch(() => undefined);
      await nodeRepo.update(
        id,
        {
          carried_from: b.carried_from,
          today_position: b.today_position,
          ...(date !== null && b.scheduled_on && b.due_on === b.scheduled_on ? { due_on: b.due_on } : {}),
        },
        opts,
      ).catch(() => undefined);
    }
  }, single);
}

/**
 * 批量設定／清除締切日，或開啟 `＝同乘車日`（`"sync"`＝把每張的 `due_on` 設為該票目前的 `scheduled_on`）。
 */
export async function batchSetDue(ids: readonly string[], dueOn: string | null | "sync"): Promise<void> {
  const before = await rows(ids);
  const opts = { dateKey: dateKey(), dayStartHour: dayStart() };
  const o = await eachOf(ids, async (id) => {
    const b = before.get(id);
    if (!b) throw new Error("找不到項目");
    if (dueOn === "sync") {
      if (!b.scheduled_on) throw new Error("尚未設定乘車日");
      await nodeRepo.update(id, { due_on: b.scheduled_on }, opts);
    } else {
      await nodeRepo.update(id, { due_on: dueOn }, opts);
    }
  });
  const verb = dueOn === "sync" ? "設締切同乘車日" : dueOn ? "設締切" : "清掉締切";
  await finish(verb, o, async () => {
    for (const id of o.done) {
      const b = before.get(id);
      if (b) await nodeRepo.update(id, { due_on: b.due_on }, opts).catch(() => undefined);
    }
  });
}

/**
 * 批量設定／清除開始時刻與預計時長（只改 patch 裡有傳入的欄位）。
 */
export async function batchSetTimeSpan(
  ids: readonly string[],
  patch: { scheduledTime?: string | null; estimateMin?: number | null },
): Promise<void> {
  const hasTime = "scheduledTime" in patch;
  const hasEst = "estimateMin" in patch;
  if (!hasTime && !hasEst) return;
  const before = await rows(ids);
  const opts = { dateKey: dateKey(), dayStartHour: dayStart() };
  const nodePatch: Parameters<typeof nodeRepo.update>[1] = {
    ...(hasTime ? { scheduled_time: patch.scheduledTime ?? null } : {}),
    ...(hasEst ? { estimate_min: patch.estimateMin ?? null } : {}),
  };
  const o = await eachOf(ids, (id) => nodeRepo.update(id, nodePatch, opts));
  const clearing = (!hasTime || patch.scheduledTime == null) && (!hasEst || patch.estimateMin == null);
  await finish(clearing ? "清掉時間" : "設時間", o, async () => {
    for (const id of o.done) {
      const b = before.get(id);
      if (!b) continue;
      await nodeRepo
        .update(
          id,
          {
            ...(hasTime ? { scheduled_time: b.scheduled_time } : {}),
            ...(hasEst ? { estimate_min: b.estimate_min } : {}),
          },
          opts,
        )
        .catch(() => undefined);
    }
  });
}

/**
 * 批量改推進狀態與結案印記（未開始／進行中／蓋済／取消蓋済／途中下車／解除途中下車）。
 * 與看板共用 `readCardStates` / `planCardMove` / `restoreCardStates`，定期券與單發票統一對齊。
 */
export type BatchStatusSealTarget = "todo" | "doing" | "done" | "uncomplete" | "paused" | "unpause";

export async function batchSetStatusAndSeal(ids: readonly string[], target: BatchStatusSealTarget): Promise<void> {
  if (target === "done") {
    await batchComplete(ids);
    return;
  }
  const day = () => ({ dateKey: dateKey(), dayStartHour: dayStart() });
  const before = await readCardStates(nodeRepo, ids, day());

  if (target === "uncomplete") {
    const todo = ids.filter((id) => {
      const s = before.get(id);
      return s && (s.teiki ? s.run?.status === "done" : s.status === "done");
    });
    if (!todo.length) {
      ui().showToast({ message: "選到的項目尚未蓋済" }, 3000);
      return;
    }
    const o = await eachOf(todo, (id) => runCardSteps(nodeRepo, id, [{ op: "uncomplete" }], day()));
    await finish("取消蓋済", o, async () => {
      await restoreCardStates(nodeRepo, new Map(o.done.map((id) => [id, before.get(id)!])), day());
    });
    return;
  }

  if (target === "unpause") {
    const pausedIds = ids.filter((id) => before.get(id)?.status === "paused");
    if (!pausedIds.length) {
      ui().showToast({ message: "選到的項目沒有途中下車" }, 3000);
      return;
    }
    const o = await eachOf(pausedIds, (id) => runCardSteps(nodeRepo, id, planCardMove(before.get(id)!, "todo"), day()));
    await finish("解除途中下車", o, async () => {
      await restoreCardStates(nodeRepo, new Map(o.done.map((id) => [id, before.get(id)!])), day());
    });
    return;
  }

  const nextStatus = target; // "todo" | "doing" | "paused"
  const toChange = ids.filter((id) => {
    const s = before.get(id);
    return s && planCardMove(s, nextStatus).length > 0;
  });
  if (!toChange.length) {
    const label = nextStatus === "todo" ? "未開始" : nextStatus === "doing" ? "進行中" : "途中下車";
    ui().showToast({ message: `選到的都已經是${label}了` }, 3000);
    return;
  }
  const o = await eachOf(toChange, (id) => runCardSteps(nodeRepo, id, planCardMove(before.get(id)!, nextStatus), day()));
  const verb = nextStatus === "todo" ? "改為未開始" : nextStatus === "doing" ? "改為進行中" : "標為途中下車";
  await finish(verb, o, async () => {
    await restoreCardStates(nodeRepo, new Map(o.done.map((id) => [id, before.get(id)!])), day());
  });
}

/** 批量指派／清除車站（大綱、今日、看板、篩選、行程表共用） */
export async function batchSetStation(ids: readonly string[], stationId: string | null): Promise<void> {
  const station = stationId ? await nodeRepo.getNode(stationId) : null;
  if (stationId && (!station || station.deleted_at !== null || station.kind !== "station")) {
    ui().showToast({ message: "找不到這個車站" }, 4000);
    return;
  }
  const before = await rows(ids);
  const opts = { dateKey: dateKey(), dayStartHour: dayStart() };
  const o = await eachOf(ids, async (id) => {
    const b = before.get(id);
    if (!b) throw new Error("找不到項目");
    if (b.kind !== "branch" && b.kind !== "train" && b.kind !== "car" && b.kind !== "ticket") {
      throw new Error("這個項目不能指派車站");
    }
    if (station && b.route_id !== station.parent_id) {
      throw new Error("只能指派同一條路線的車站");
    }
    await nodeRepo.update(id, { station_id: stationId }, opts);
  });
  await finish(stationId ? "指派車站" : "清掉車站", o, async () => {
    for (const id of o.done) {
      const b = before.get(id);
      if (b) await nodeRepo.update(id, { station_id: b.station_id }, opts).catch(() => undefined);
    }
  });
}

/** 批量設定重複規則，或 `null` 改回乘車券（附完整復原） */
export async function batchSetRepeat(ids: readonly string[], rule: RepeatRule | null): Promise<void> {
  const before = await rows(ids);
  const dk = dateKey();
  const dsh = dayStart();
  const o = await eachOf(ids, (id) => nodeRepo.setRepeatRule(id, rule, dk, dsh));
  await finish(rule ? "設成定期券" : "改回乘車券", o, async () => {
    for (const id of o.done) {
      const b = before.get(id);
      if (!b) continue;
      const prevRule = parseRule(b.repeat_rule);
      await nodeRepo.setRepeatRule(id, prevRule, dk, dsh).catch(() => undefined);
      if (!prevRule) {
        await nodeRepo.reschedule(id, b.scheduled_on, dk).catch(() => undefined);
        await nodeRepo
          .update(id, { carried_from: b.carried_from, today_position: b.today_position }, { dateKey: dk, dayStartHour: dsh })
          .catch(() => undefined);
      }
    }
  });
}

export async function batchSetPriority(ids: readonly string[], priority: Priority): Promise<void> {
  const before = await rows(ids);
  const opts = { dateKey: dateKey(), dayStartHour: dayStart() };
  const o = await eachOf(ids, (id) => nodeRepo.update(id, { priority }, opts));
  await finish("改優先級", o, async () => {
    for (const id of o.done) {
      const p = before.get(id)?.priority;
      if (p) await nodeRepo.update(id, { priority: p }, opts).catch(() => undefined);
    }
  });
}

/** 掛荷札（名字；沒有就建）。已經掛著的那幾張不算「改」 */
export async function batchAttachTag(ids: readonly string[], rawName: string): Promise<void> {
  const receipts: Parameters<typeof tagRepo.undo>[0][] = [];
  const o = await eachOf(ids, async (id) => {
    const r = await tagRepo.attach("node", id, rawName);
    if (r.already) throw new Error(`已經掛著 #${r.name}`);
    receipts.push(r.receipt);
  });
  await useTagStore.getState().loadIndex();
  await finish("掛上荷札", o, async () => {
    for (const r of receipts.reverse()) await tagRepo.undo(r).catch(() => undefined);
  });
}

export async function batchDetachTag(ids: readonly string[], key: string): Promise<void> {
  const receipts: Parameters<typeof tagRepo.undo>[0][] = [];
  const o = await eachOf(ids, async (id) => {
    receipts.push(await tagRepo.detach("node", id, key));
  });
  await useTagStore.getState().loadIndex();
  await finish("摘下荷札", o, async () => {
    for (const r of receipts.reverse()) await tagRepo.undo(r).catch(() => undefined);
  });
}

/** 底下還有沒蓋済的子項嗎：在開著的路線樹裡就看樹；不在（今日、行程表、跨路線的篩選）問 repository */
async function hasOpenKids(id: string, kind: NodeRow["kind"]): Promise<boolean> {
  const t = ns().tree;
  if (t.byId[id]) return (t.childrenOf[id] ?? []).some((c) => t.byId[c]?.status !== "done");
  if (!canHaveChildren(kind)) return false;
  const under = (await nodeRepo.listSubtreeIds(id)).filter((x) => x !== id);
  const kids = await rows(under);
  return under.some((x) => kids.has(x) && kids.get(x)?.status !== "done" && kids.get(x)?.deleted_at === null);
}

/**
 * 蓋済：有未完成子項的先問一次（一起完成＝連子項蓋），反悔照快照走回去（domain/boardMove，同看板換欄）。
 * 已經有結局的不算（定期券看目前班次：nodes.status 一路是 todo，照它判會蓋到下一班頭上）。
 */
export async function batchComplete(ids: readonly string[]): Promise<void> {
  const day = () => ({ dateKey: dateKey(), dayStartHour: dayStart() });
  const before = await readCardStates(nodeRepo, ids, day());
  const todo = ids.filter((id) => {
    const s = before.get(id);
    return s && !cardSettled(s);
  });
  const open: string[] = [];
  for (const id of todo) if (await hasOpenKids(id, before.get(id)!.kind)) open.push(id);
  const run = async (cascade: boolean) => {
    const o = await eachOf(todo, (id) => runCardSteps(nodeRepo, id, planCardMove(before.get(id)!, "done"), day(), { cascade: cascade && open.includes(id) }));
    await finish("蓋済", o, async () => {
      await restoreCardStates(nodeRepo, new Map(o.done.map((id) => [id, before.get(id)!])), day());
    });
  };
  if (!todo.length) {
    ui().showToast({ message: "選到的都已經有結局了" }, 3000);
    return;
  }
  if (open.length) {
    ui().askConfirm({
      title: `其中 ${open.length} 張還有未完成的子項，一起完成？`,
      body: "那幾張底下未完成的子項會一併蓋上済章。",
      confirmLabel: "一起完成",
      onConfirm: () => void run(true),
    });
    return;
  }
  await run(false);
}

/** 運休／取消運休（只對定期券；其他的跳過） */
export async function batchSkip(ids: readonly string[], skip = true): Promise<void> {
  const dk = dateKey();
  const dsh = dayStart();
  const before = await rows(ids);
  if (skip) {
    const o = await eachOf(ids, async (id) => {
      if (!parseRule(before.get(id)?.repeat_rule)) throw new Error("只有定期券能運休");
      await nodeRepo.skipOccurrence(id, true, dk, dsh);
    });
    await finish("運休", o, async () => {
      for (const id of o.done) await nodeRepo.skipOccurrence(id, false, dk, dsh).catch(() => undefined);
    });
    return;
  }
  const occs = await nodeRepo.listCurrentOccurrences(dk, dsh);
  const skippedDue = new Map<string, string>();
  const o = await eachOf(ids, async (id) => {
    if (!parseRule(before.get(id)?.repeat_rule)) throw new Error("只有定期券能取消運休");
    const occ = occs[id];
    if (!occ || occ.status !== "skipped") throw new Error("這張定期券目前沒有運休");
    skippedDue.set(id, occ.due_on);
    await nodeRepo.skipOccurrence(id, false, dk, dsh, occ.due_on);
  });
  await finish("取消運休", o, async () => {
    for (const id of o.done) {
      const due = skippedDue.get(id);
      await nodeRepo.skipOccurrence(id, true, dk, dsh, due).catch(() => undefined);
    }
  });
}

/** 刪除：先確認（不可逆的感覺強，雖然有復原）；刪完清掉選取 */
export function batchDelete(ids: readonly string[]): void {
  ui().askConfirm({
    title: `刪除 ${ids.length} 張？`,
    body: "底下的子項會一起刪除；刪完幾秒內可以按「復原」。",
    confirmLabel: "刪除",
    danger: true,
    onConfirm: () =>
      void (async () => {
        const removed: string[] = [];
        const o = await eachOf(ids, async (id) => {
          removed.push(...(await nodeRepo.softDelete(id)));
        });
        useSelectionStore.getState().clear();
        await finish("刪除", o, async () => {
          if (removed.length) await nodeRepo.restore(removed);
        });
      })(),
  });
}

/* ───────── 搬移（拖曳、選取列「移動到…」、拖到側欄路線）：一批寫入＋記原位的復原 ───────── */

/**
 * 「放在最後」的落點錨：after 指向一個不存在的鄰居、before 開放 ⇒ slotFromAnchor 的「鄰居不在＝放最後」
 * （domain/nodeSortKey.ts；after 為 null 才是最上面）。
 */
export const APPEND: SlotAnchor = { after: "\u0000end", before: null };

/**
 * 記下 ids 搬走前的位置，回「搬回去」的函式（一次復原）。
 * 原位＝原父節點（根層車票＝它的路線標籤，moveToAnchor 的慣例；同 common/moveTo.ts）＋原本那份清單裡的上下鄰居（不記整數 position，#119）。
 * 同一份清單裡相鄰的幾張收成一段、用段外的鄰居當錨一次放回；段與段照原清單順序放（先放的會變成後放那段的錨，不會落錯格）。
 */
export async function snapshotPlaces(ids: readonly string[]): Promise<() => Promise<void>> {
  const runs: { parent: string | null; ids: string[]; anchor: SlotAnchor }[] = [];
  const groups = new Map<string, { parent: string | null; sibs: string[]; members: Set<string> }>();
  for (const id of ids) {
    const n = await nodeRepo.getNode(id);
    if (!n) continue;
    const parent = n.parent_id ?? (n.kind === "ticket" ? n.route_id : null);
    const key = `${parent ?? "-"}|${n.kind === "station" ? "st" : ""}`;
    let g = groups.get(key);
    if (!g) {
      g = { parent, sibs: await nodeRepo.listSiblingIds(id), members: new Set() };
      groups.set(key, g);
    }
    g.members.add(id);
  }
  for (const g of groups.values()) {
    let cur: string[] = [];
    const flush = (endIdx: number) => {
      if (!cur.length) return;
      const first = g.sibs.indexOf(cur[0]);
      runs.push({ parent: g.parent, ids: cur, anchor: { after: first > 0 ? g.sibs[first - 1] : null, before: g.sibs[endIdx] ?? null } });
      cur = [];
    };
    g.sibs.forEach((sid, i) => {
      if (g.members.has(sid)) cur.push(sid);
      else flush(i);
    });
    flush(g.sibs.length);
  }
  return async () => {
    for (const r of runs) {
      const back = await ns().moveToAnchor(r.ids, r.parent, r.anchor);
      if (!back.ok) ui().showToast({ message: back.reason ?? "復原失敗——請再試一次" }, 4000);
    }
  };
}

async function dedupeNodeIds(ids: readonly string[]): Promise<string[]> {
  if (ids.length <= 1) return ids.slice();
  const parentMap = new Map<string, string | null>();
  for (const id of ids) {
    let cur: string | null = id;
    const seen = new Set<string>();
    while (cur && !seen.has(cur) && !parentMap.has(cur)) {
      seen.add(cur);
      const node = await nodeRepo.getNode(cur);
      const p = node && node.deleted_at === null ? node.parent_id : null;
      parentMap.set(cur, p);
      cur = p;
    }
  }
  return dedupeSubtreeRoots(ids, (id) => parentMap.get(id) ?? null);
}

/**
 * 搬一批（拖曳放下、選取列、拖到側欄路線）：記原位 → moveToAnchor 一批寫入 → toast 附「復原」。
 * 被擋下（種類放不下、搬進自己底下）＝toast 理由、回 false。
 */
export async function moveWithUndo(
  ids: readonly string[],
  parentId: string | null,
  anchor: SlotAnchor,
  message: string,
): Promise<boolean> {
  const roots = await dedupeNodeIds(ids);
  const undo = await snapshotPlaces(roots);
  const r = await ns().moveToAnchor(roots, parentId, anchor);
  if (!r.ok) {
    ui().showToast({ message: r.reason ?? "沒有搬成功——請再試一次" }, 4000);
    return false;
  }
  ui().showToast({ message, actionLabel: "復原", onAction: () => void undo() });
  return true;
}

/**
 * 移動到同一個新父節點（放在最後、保持原本相對順序；一批寫入＝一次同步）。復原＝搬回原父節點、原鄰居之間。
 * 種類能不能放由 nodeStore.moveToAnchor／repository 把關（跟單張「移動到…」同一條規則）；一張放不下＝整批不寫、toast 理由。
 */
export async function batchMoveTo(ids: readonly string[], parentId: string, placeName?: string): Promise<boolean> {
  const roots = await dedupeNodeIds(ids);
  return moveWithUndo(roots, parentId, APPEND, placeName ? `已把 ${roots.length} 張移到「${placeName}」` : `已移動 ${roots.length} 張`);
}
