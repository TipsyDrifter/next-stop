/**
 * 週方針的 store（戊；契約 §3）。帶子、行程表週檢視、手機一行與面板、寫方針框、回顧共用這一份。
 *
 * - `weeks`：載過的週（週首 → 那週活著的方針，照順序）；`planned`：週首 → 掛的節點 → 已排 N 張・済 M。
 * - 收合（D-主-259）與「看過哪週的回顧」（D-主-260）是本地設定鍵（settings 表、不在同步白名單＝各台自己記）。
 * - 同步拉到 `week_aims` ⇒ `syncStore.refreshAfterPull` 叫 `reloadAll()`；節點有變（蓋章、建票）⇒ 帶子自己叫 `refreshPlanned()`。
 * - 寫入失敗一律 toast `e.message`（repository 的 RangeError 是人話）。
 */
import { create } from "zustand";
import type { NodeRow } from "../domain";
import { nodeRepo, settingsRepo } from "../data";
import { weekAimRepo, type AimNodeRef, type ReviewResult } from "../data/weekAimRepository";
import {
  KEY_WEEK_AIMS_FOLD,
  KEY_WEEK_AIMS_REVIEW_SEEN,
  aimsOfWeek,
  carryAimId,
  carryCandidates,
  foldValue,
  planSaveWeek,
  weekEndOf,
  type AimDraft,
  type PlanCount,
  type WeekAimRow,
} from "../domain/weekAims";
import { addDays, todayKey } from "../lib/date";
import { useNodeStore } from "./nodeStore";
import { useUiStore } from "./uiStore";

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function toast(msg: string, extra?: { actionLabel: string; onAction: () => void }): void {
  useUiStore.getState().showToast({ message: msg, ...extra });
}

/**
 * 掛的節點的種類：路線從側欄就有；其他（支線，D-主-281）問 repository，
 * 讀到的列順手記進 store 的 `aimNodes`（畫面要支線名與它所屬的路線）。
 */
async function refsOf(aims: readonly WeekAimRow[]): Promise<AimNodeRef[]> {
  const routes = useNodeStore.getState().routes;
  const out: AimNodeRef[] = [];
  const seen = new Set<string>();
  const found: Record<string, NodeRow> = {};
  for (const a of aims) {
    if (!a.node_id || seen.has(a.node_id)) continue;
    seen.add(a.node_id);
    const r = routes.find((x) => x.id === a.node_id);
    if (r) {
      out.push({ id: r.id, kind: "route" });
      continue;
    }
    const n = await nodeRepo.getNode(a.node_id).catch(() => null);
    if (n && n.deleted_at === null) {
      out.push({ id: n.id, kind: n.kind });
      found[n.id] = n;
    }
  }
  if (Object.keys(found).length) useWeekAimStore.getState().rememberAimNodes(Object.values(found));
  return out;
}

export interface EditorState {
  weekOn: string;
  /** 打開時先帶進草稿的（回顧頁腳「帶到下週（N 句）」） */
  preCarry: readonly WeekAimRow[];
}

export interface ReviewState {
  weekOn: string;
  /** null＝還在算 */
  result: ReviewResult | null;
}

export interface PlanTicketInput {
  name: string;
  parentId: string | null;
  routeTagId: string | null;
  day: string;
}

interface WeekAimStore {
  weeks: Record<string, WeekAimRow[]>;
  planned: Record<string, Record<string, PlanCount>>;
  /** 本地鍵 `week_aims_fold` 的原值（null＝沒記） */
  foldRaw: string | null;
  /** 本地鍵 `week_aims_review_seen`（看過回顧的那週週首） */
  reviewSeen: string | null;
  settingsLoaded: boolean;
  review: ReviewState | null;
  editor: EditorState | null;
  /** 方針掛的非路線節點（支線）：id → 節點列；路線本身看 nodeStore.routes（D-主-281） */
  aimNodes: Record<string, NodeRow>;

  loadSettings(): Promise<void>;
  /** 記下掛的支線（載週時、寫方針框挑到時）；畫面靠它顯示支線名 */
  rememberAimNodes(nodes: readonly NodeRow[]): void;
  /** 載一週（與上一週：回顧與「上週沒済的」要用）＋已排 */
  loadWeek(weekOn: string): Promise<void>;
  refreshPlanned(weekOn?: string): Promise<void>;
  /** 同步拉到 week_aims、或資料被整批換掉：載過的週全部重載 */
  reloadAll(): Promise<void>;
  setFolded(weekOn: string, folded: boolean): Promise<void>;
  toggleDone(aim: WeekAimRow): Promise<void>;
  openEditor(weekOn: string, preCarry?: readonly WeekAimRow[]): void;
  closeEditor(): void;
  /** 寫方針框存檔；成功回 true（框由呼叫端關） */
  saveWeek(weekOn: string, drafts: readonly AimDraft[]): Promise<boolean>;
  /** 「帶到這週」的草稿列（決定性 id） */
  carryDraft(src: WeekAimRow, targetWeekOn: string): Promise<AimDraft>;
  openReview(weekOn: string): Promise<void>;
  /** 關回顧＝看過（本地記） */
  closeReview(): Promise<void>;
  /** 排成車票：建票、重算已排；成功回 true */
  planTicket(aim: WeekAimRow, input: PlanTicketInput): Promise<boolean>;
}

/** 這週與上一週都載（回顧上週、「上週沒済的」都要上一週的列） */
async function fetchWeeks(weekOn: string): Promise<Record<string, WeekAimRow[]>> {
  const prev = addDays(weekOn, -7);
  const rows = await weekAimRepo.listRange(prev, weekEndOf(weekOn));
  return { [prev]: aimsOfWeek(rows, prev), [weekOn]: aimsOfWeek(rows, weekOn) };
}

export const useWeekAimStore = create<WeekAimStore>((set, get) => ({
  weeks: {},
  planned: {},
  foldRaw: null,
  reviewSeen: null,
  settingsLoaded: false,
  review: null,
  editor: null,
  aimNodes: {},

  rememberAimNodes(nodes) {
    const cur = get().aimNodes;
    const same = (a: NodeRow | undefined, b: NodeRow) => !!a && a.updated_at === b.updated_at && a.name === b.name && a.route_id === b.route_id;
    if (nodes.every((n) => same(cur[n.id], n))) return;
    const next = { ...cur };
    for (const n of nodes) next[n.id] = n;
    set({ aimNodes: next });
  },

  async loadSettings() {
    if (get().settingsLoaded) return;
    try {
      const [fold, seen] = await Promise.all([settingsRepo.get(KEY_WEEK_AIMS_FOLD), settingsRepo.get(KEY_WEEK_AIMS_REVIEW_SEEN)]);
      set({ foldRaw: fold, reviewSeen: seen, settingsLoaded: true });
    } catch {
      set({ settingsLoaded: true });
    }
  },

  async loadWeek(weekOn) {
    try {
      const fresh = await fetchWeeks(weekOn);
      set((s) => ({ weeks: { ...s.weeks, ...fresh } }));
      await get().refreshPlanned(weekOn);
    } catch (e) {
      console.warn("[next-stop] 週方針載入失敗：", message(e));
    }
  },

  async refreshPlanned(weekOn) {
    const weeks = weekOn ? [weekOn] : Object.keys(get().weeks);
    for (const w of weeks) {
      const aims = get().weeks[w] ?? [];
      const refs = await refsOf(aims);
      if (!refs.length) {
        set((s) => ({ planned: { ...s.planned, [w]: {} } }));
        continue;
      }
      try {
        const counts = await weekAimRepo.plannedCounts(refs, w, weekEndOf(w));
        set((s) => ({ planned: { ...s.planned, [w]: counts } }));
      } catch (e) {
        console.warn("[next-stop] 週方針已排數字失敗：", message(e));
      }
    }
  },

  async reloadAll() {
    const loaded = Object.keys(get().weeks);
    if (!loaded.length) return;
    try {
      const from = loaded.reduce((a, b) => (a < b ? a : b));
      const to = weekEndOf(loaded.reduce((a, b) => (a > b ? a : b)));
      const rows = await weekAimRepo.listRange(from, to);
      const weeks: Record<string, WeekAimRow[]> = {};
      for (const w of loaded) weeks[w] = aimsOfWeek(rows, w);
      set({ weeks });
      await get().refreshPlanned();
      const rv = get().review;
      if (rv) await get().openReview(rv.weekOn);
    } catch (e) {
      console.warn("[next-stop] 週方針重載失敗：", message(e));
    }
  },

  async setFolded(weekOn, folded) {
    const raw = foldValue(weekOn, folded);
    set({ foldRaw: raw });
    await settingsRepo.set(KEY_WEEK_AIMS_FOLD, raw).catch(() => undefined);
  },

  async toggleDone(aim) {
    try {
      await weekAimRepo.setDone(aim.id, aim.done_at === null ? new Date().toISOString() : null);
      const w = aimsWeekOf(get().weeks, aim) ?? aim.week_on;
      await get().loadWeek(w);
    } catch (e) {
      toast(message(e));
    }
  },

  openEditor(weekOn, preCarry = []) {
    set({ editor: { weekOn, preCarry } });
    void get().loadWeek(weekOn);
  },
  closeEditor() {
    set({ editor: null });
  },

  async saveWeek(weekOn, drafts) {
    try {
      // 現況一律重讀（不用畫面上的快取）：框開著時另一台同步刪掉的句子，不該被這邊的改字蓋回來
      const cur = aimsOfWeek(await weekAimRepo.listRange(weekOn, weekEndOf(weekOn)), weekOn);
      const plan = planSaveWeek(cur, drafts);
      await weekAimRepo.saveWeek(weekOn, plan);
      await get().loadWeek(weekOn);
      return true;
    } catch (e) {
      toast(message(e));
      return false;
    }
  },

  async carryDraft(src, targetWeekOn) {
    return { id: await carryAimId(src.id, targetWeekOn), text: src.text, nodeId: src.node_id, carriedFrom: src.id };
  },

  async openReview(weekOn) {
    const prev = get().review;
    set({ review: { weekOn, result: prev && prev.weekOn === weekOn ? prev.result : null } });
    if (!get().weeks[weekOn]) await get().loadWeek(weekOn);
    else void get().refreshPlanned(weekOn); // 上一週是跟著這週載的，它的「已排」還沒算
    try {
      const refs = await refsOf(get().weeks[weekOn] ?? []);
      const result = await weekAimRepo.reviewStats(refs, weekOn, useUiStore.getState().dayStartHour);
      if (get().review?.weekOn === weekOn) set({ review: { weekOn, result } });
    } catch (e) {
      console.warn("[next-stop] 週方針回顧數字失敗：", message(e));
      if (get().review?.weekOn === weekOn) set({ review: { weekOn, result: { stats: {}, money: null } } });
    }
  },

  async closeReview() {
    const rv = get().review;
    set({ review: null });
    if (!rv) return;
    const seen = get().reviewSeen;
    if (seen !== null && seen >= rv.weekOn) return;
    set({ reviewSeen: rv.weekOn });
    await settingsRepo.set(KEY_WEEK_AIMS_REVIEW_SEEN, rv.weekOn).catch(() => undefined);
  },

  async planTicket(aim, input) {
    const name = input.name.replace(/\s+/g, " ").trim();
    if (!name) {
      toast("票名不能是空的");
      return false;
    }
    const row = await useNodeStore.getState().createNode({
      kind: "ticket",
      name,
      parentId: input.parentId,
      routeTagId: input.parentId === null ? input.routeTagId : undefined,
      scheduledOn: input.day,
    });
    if (!row) {
      toast(useNodeStore.getState().error ?? "沒有排成功——請再試一次");
      return false;
    }
    await get().refreshPlanned(aimsWeekOf(get().weeks, aim) ?? aim.week_on);
    const md = `${Number(input.day.slice(5, 7))}/${Number(input.day.slice(8, 10))}`;
    toast(`排好了：「${name}」${md}`, {
      actionLabel: "復原",
      onAction: () => {
        void (async () => {
          await useNodeStore.getState().deleteNode(row.id);
          await get().refreshPlanned();
        })();
      },
    });
    return true;
  },
}));

/** 某句在 store 裡屬於哪個載過的週（week_on 是寫的當下的週首；改過週起始日時兩者可能不同） */
function aimsWeekOf(weeks: Record<string, WeekAimRow[]>, aim: WeekAimRow): string | null {
  for (const [w, list] of Object.entries(weeks)) if (list.some((a) => a.id === aim.id)) return w;
  return null;
}

/** 今天（依日界線） */
export function aimsToday(): string {
  return todayKey(useUiStore.getState().dayStartHour);
}

/** 這週沒済、還沒帶到 target 的（回顧頁腳「帶到下週（N 句）」） */
export function uncarried(src: readonly WeekAimRow[], target: readonly WeekAimRow[]): WeekAimRow[] {
  const carried = new Set(target.map((a) => a.carried_from).filter(Boolean));
  return carryCandidates(src).filter((a) => !carried.has(a.id));
}
