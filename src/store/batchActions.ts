/**
 * batchActions——多選後一次改一批票（回饋乙 D-主-152；契約 §4）。桌機選取列與手機選取列共用這一份。
 *
 * 每個動作：逐張寫（沿用單張的同一支 repository 函式＝同一組守門與規則）→ 全部寫完才 refresh 一次 →
 *   一則 toast「已改 N 張」附「復原」（照原值逐張寫回）。做不到的那幾張（例：定期券不能直接改執行日）跳過、在 toast 第二行說。
 * 不經 nodeStore 的單張動作：它們每寫一張就整頁 refresh 一次，一批 20 張會閃 20 次。
 */
import { nodeRepo } from "../data";
import { tagRepo } from "../data/tagRepo";
import type { NodeRow, Priority } from "../domain/node";
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
 * 改執行日（null＝清掉）；定期券由 repository 擋下（一句指路），算在「沒改」。
 * `single`＝只改一張時 toast 的字（拖到日期：「已改到 11/3（二）」）；多張照舊「已改期 N 張」。
 */
export async function batchSetDate(ids: readonly string[], date: string | null, single?: string): Promise<void> {
  const before = await rows(ids);
  const o = await eachOf(ids, (id) => nodeRepo.reschedule(id, date, dateKey()).then(() => undefined));
  await finish(date ? "改期" : "清掉執行日", o, async () => {
    for (const id of o.done) await nodeRepo.reschedule(id, before.get(id)?.scheduled_on ?? null, dateKey()).catch(() => undefined);
  }, single);
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

/** 蓋済：有未完成子項的先問一次（一起完成＝連子項蓋），反悔逐張撤 */
export async function batchComplete(ids: readonly string[]): Promise<void> {
  const before = await rows(ids);
  const todo = ids.filter((id) => before.get(id)?.status !== "done");
  const kids = ns().tree;
  const open = todo.filter((id) => (kids.childrenOf[id] ?? []).some((c) => kids.byId[c]?.status !== "done"));
  const run = async (cascade: boolean) => {
    const o = await eachOf(todo, (id) =>
      nodeRepo.setCompleted(id, true, { cascade: cascade && open.includes(id), dateKey: dateKey(), dayStartHour: dayStart() }).then(() => undefined),
    );
    await finish("蓋済", o, async () => {
      for (const id of o.done) await nodeRepo.setCompleted(id, false, { dateKey: dateKey(), dayStartHour: dayStart() }).catch(() => undefined);
    });
  };
  if (!todo.length) {
    ui().showToast({ message: "選到的都已經蓋過済了" }, 3000);
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

/** 運休（只對定期券；其他的跳過） */
export async function batchSkip(ids: readonly string[]): Promise<void> {
  const before = await rows(ids);
  const o = await eachOf(ids, async (id) => {
    if (!before.get(id)?.repeat_rule) throw new Error("只有定期券能運休");
    await nodeRepo.skipOccurrence(id, true, dateKey(), dayStart());
  });
  await finish("運休", o, async () => {
    for (const id of o.done) await nodeRepo.skipOccurrence(id, false, dateKey(), dayStart()).catch(() => undefined);
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
  const undo = await snapshotPlaces(ids);
  const r = await ns().moveToAnchor([...ids], parentId, anchor);
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
  return moveWithUndo(ids, parentId, APPEND, placeName ? `已把 ${ids.length} 張移到「${placeName}」` : `已移動 ${ids.length} 張`);
}
