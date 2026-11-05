/**
 * 週方針的 store（戊；契約 §3）。帶子、行程表週檢視、手機一行與面板、寫方針框、回顧共用這一份。
 *
 * - `weeks`：載過的期間（期間鍵 → 那一期活著的方針，照順序）；`planned`：期間鍵 → 掛的節點 → 已排 N 張・済 M。
 *   名字留舊的：方針擴充（辛 D-主-371）起週、月、年、車站都放在這裡，鍵的編解碼在 `domain/weekAims.ts`；
 *   `editor.weekOn`、`review.weekOn` 同樣裝期間鍵。
 * - 車站的已排與回顧：沒掛的句子看這條路線（§2），所以 `planned[S…]`、回顧的 stats 一定帶這條路線的 id（有句子時）。
 * - 收合（D-主-259）與「看過哪一期的回顧」（D-主-260、373）是本地設定鍵，各期間各一支（settings 表、不在同步白名單＝各台自己記）。
 * - 同步拉到 `week_aims` ⇒ `syncStore.refreshAfterPull` 叫 `reloadAll()`；節點有變（蓋章、建票）⇒ 帶子自己叫 `refreshPlanned()`。
 * - 寫入失敗一律 toast `e.message`（repository 的 RangeError 是人話）。
 */
import { create } from "zustand";
import type { NodeRow } from "../domain";
import { nodeRepo, settingsRepo } from "../data";
import { weekAimRepo, type AimNodeRef, type ReviewResult } from "../data/weekAimRepository";
import {
  KEY_AIMS_FOLD,
  KEY_AIMS_REVIEW_SEEN,
  adjacentKey,
  aimConflictNotice,
  aimsOfKey,
  carryAimId,
  carryCandidates,
  foldValue,
  keyRowBounds,
  periodOfKey,
  periodRangeOf,
  planSaveWeek,
  stationIdOfKey,
  stationWindow,
  weekEndOf,
  type AimDraft,
  type AimPeriod,
  type DayRange,
  type PlanCount,
  type ReviewPeriod,
  type WeekAimRow,
} from "../domain/weekAims";
import { compareSiblings } from "../domain/nodeOrder";
import { todayKey } from "../lib/date";
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
 * 車站：沒掛的句子看這條路線（§2），有句子就多帶那條路線。
 */
async function refsOf(aims: readonly WeekAimRow[], key: string): Promise<AimNodeRef[]> {
  const routes = useNodeStore.getState().routes;
  const out: AimNodeRef[] = [];
  const seen = new Set<string>();
  const found: Record<string, NodeRow> = {};
  const ids: (string | null)[] = aims.map((a) => a.node_id);
  if (aims.length) ids.push(stationOfKey(key)?.parent_id ?? null);
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const r = routes.find((x) => x.id === id);
    if (r) {
      out.push({ id: r.id, kind: "route" });
      continue;
    }
    const n = await nodeRepo.getNode(id).catch(() => null);
    if (n && n.deleted_at === null) {
      out.push({ id: n.id, kind: n.kind });
      found[n.id] = n;
    }
  }
  if (Object.keys(found).length) useWeekAimStore.getState().rememberAimNodes(Object.values(found));
  return out;
}

/** 車站鍵 → 側欄那份車站列；不是車站鍵或這站不在了＝null */
function stationOfKey(key: string): NodeRow | null {
  const id = stationIdOfKey(key);
  return id === null ? null : (useNodeStore.getState().stations.find((s) => s.id === id) ?? null);
}

/** 一期的範圍（§2）：週、月、年照鍵算；車站走 stationWindow，這站不在了＝null */
export function aimRangeOf(key: string): DayRange | null {
  if (periodOfKey(key) !== "station") return periodRangeOf(key);
  const st = stationOfKey(key);
  if (!st) return null;
  const siblings = useNodeStore
    .getState()
    .stations.filter((s) => s.parent_id === st.parent_id)
    .sort(compareSiblings);
  return stationWindow(st, siblings);
}

export interface EditorState {
  /** 期間鍵（欄名沿用） */
  weekOn: string;
  /** 打開時先帶進草稿的（回顧頁腳「帶到下週（N 句）」） */
  preCarry: readonly WeekAimRow[];
}

export interface ReviewState {
  /** 期間鍵（欄名沿用） */
  weekOn: string;
  /** null＝還在算 */
  result: ReviewResult | null;
  /** 車站小卡自己畫這張回顧（告示不跟著換成回顧表，免得同一張回顧畫兩份） */
  inCard?: boolean;
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
  /** 各期間收合本地鍵的原值（null＝沒記；週＝`week_aims_fold`） */
  foldRaw: Record<AimPeriod, string | null>;
  /** 各期間看過回顧到哪一期（週首／M…／Y…；週＝`week_aims_review_seen`） */
  reviewSeen: Record<ReviewPeriod, string | null>;
  settingsLoaded: boolean;
  review: ReviewState | null;
  editor: EditorState | null;
  /** 方針掛的非路線節點（支線）：id → 節點列；路線本身看 nodeStore.routes（D-主-281） */
  aimNodes: Record<string, NodeRow>;
  /** 今日告示切到哪一期（D-主-377）：換頁再回來還在、關 App 回本週，所以放記憶體、不寫設定 */
  todayPick: ReviewPeriod;
  setTodayPick(period: ReviewPeriod): void;

  loadSettings(): Promise<void>;
  /** 記下掛的支線（載週時、寫方針框挑到時）；畫面靠它顯示支線名 */
  rememberAimNodes(nodes: readonly NodeRow[]): void;
  /** 記著的支線重讀一次（全集 #15：改名即時更新；刪掉的拿掉，標籤跟著消失，§3 #16） */
  refreshAimNodes(): Promise<void>;
  /** 載一期＋已排：週、月、年連上一期一起載（回顧與「上週沒済的」要用）；車站只載自己 */
  loadWeek(key: string): Promise<void>;
  /** 整批載、不算已排（路線一覽用） */
  loadKeys(keys: readonly string[]): Promise<void>;
  refreshPlanned(key?: string): Promise<void>;
  /** 同步拉到 week_aims、或資料被整批換掉：載過的期間全部重載（照期間分別讀，含 M／Y／S 鍵） */
  reloadAll(): Promise<void>;
  setFolded(key: string, folded: boolean): Promise<void>;
  toggleDone(aim: WeekAimRow): Promise<void>;
  openEditor(key: string, preCarry?: readonly WeekAimRow[]): void;
  closeEditor(): void;
  /** 寫方針框存檔；`base`＝框打開當下的列（框開著時別處動了這一期才分得出來，見 planSaveWeek）。成功回 true（框由呼叫端關） */
  saveWeek(key: string, drafts: readonly AimDraft[], base?: readonly AimDraft[]): Promise<boolean>;
  /** 「帶到這一期」的草稿列（決定性 id） */
  carryDraft(src: WeekAimRow, targetKey: string): Promise<AimDraft>;
  openReview(key: string, opts?: { inCard?: boolean }): Promise<void>;
  /** ⑨ 提醒點開：手機的回顧面板是元件自己的狀態，留一個請求讓它收；桌機看 `review` 就夠 */
  reviewRequest: string | null;
  requestReview(key: string | null): void;
  /** 關回顧＝看過（本地記） */
  closeReview(): Promise<void>;
  /** 排成車票：建票、重算已排；成功回 true */
  planTicket(aim: WeekAimRow, input: PlanTicketInput): Promise<boolean>;
}

/** 這一期與上一期都載（回顧上週、「上週沒済的」都要上一期的列）；車站沒有上一期，只載自己 */
async function fetchPeriod(key: string): Promise<Record<string, WeekAimRow[]>> {
  if (periodOfKey(key) === "station") return { [key]: aimsOfKey(await weekAimRepo.listKeys([key]), key) };
  const prev = adjacentKey(key, -1);
  const rows = await weekAimRepo.listRange(prev, keyRowBounds(key).to);
  return { [prev]: aimsOfKey(rows, prev), [key]: aimsOfKey(rows, key) };
}

/** 一批期間鍵照期間分別讀：週走區間（D-主-251），月、年、站走等於鍵 */
async function fetchKeys(keys: readonly string[]): Promise<Record<string, WeekAimRow[]>> {
  const isWeek = (k: string) => periodOfKey(k) === "week";
  const wk = keys.filter(isWeek);
  const [weekRows, otherRows] = await Promise.all([
    wk.length ? weekAimRepo.listRange(wk.reduce((a, b) => (a < b ? a : b)), weekEndOf(wk.reduce((a, b) => (a > b ? a : b)))) : [],
    weekAimRepo.listKeys(keys.filter((k) => !isWeek(k))),
  ]);
  const out: Record<string, WeekAimRow[]> = {};
  for (const k of keys) out[k] = aimsOfKey(isWeek(k) ? weekRows : otherRows, k);
  return out;
}

export const useWeekAimStore = create<WeekAimStore>((set, get) => ({
  weeks: {},
  planned: {},
  foldRaw: { week: null, month: null, year: null, station: null },
  reviewSeen: { week: null, month: null, year: null },
  settingsLoaded: false,
  review: null,
  reviewRequest: null,
  requestReview(weekOn) {
    set({ reviewRequest: weekOn });
    if (weekOn) void get().openReview(weekOn);
  },
  editor: null,
  aimNodes: {},
  todayPick: "week",

  setTodayPick(period) {
    set({ todayPick: period });
  },

  rememberAimNodes(nodes) {
    const cur = get().aimNodes;
    const same = (a: NodeRow | undefined, b: NodeRow) => !!a && a.updated_at === b.updated_at && a.name === b.name && a.route_id === b.route_id;
    if (nodes.every((n) => same(cur[n.id], n))) return;
    const next = { ...cur };
    for (const n of nodes) next[n.id] = n;
    set({ aimNodes: next });
  },

  async refreshAimNodes() {
    const ids = Object.keys(get().aimNodes);
    if (!ids.length) return;
    const rows = await Promise.all(ids.map((id) => nodeRepo.getNode(id).catch(() => undefined)));
    const gone = ids.filter((_, i) => rows[i] === null || (rows[i] && rows[i].deleted_at !== null));
    get().rememberAimNodes(rows.filter((n): n is NodeRow => !!n && n.deleted_at === null));
    if (gone.length) {
      const next = { ...get().aimNodes };
      for (const id of gone) delete next[id];
      set({ aimNodes: next });
    }
  },

  async loadSettings() {
    if (get().settingsLoaded) return;
    try {
      const [fw, fm, fy, fs, sw, sm, sy] = await Promise.all([
        settingsRepo.get(KEY_AIMS_FOLD.week),
        settingsRepo.get(KEY_AIMS_FOLD.month),
        settingsRepo.get(KEY_AIMS_FOLD.year),
        settingsRepo.get(KEY_AIMS_FOLD.station),
        settingsRepo.get(KEY_AIMS_REVIEW_SEEN.week),
        settingsRepo.get(KEY_AIMS_REVIEW_SEEN.month),
        settingsRepo.get(KEY_AIMS_REVIEW_SEEN.year),
      ]);
      set({
        foldRaw: { week: fw, month: fm, year: fy, station: fs },
        reviewSeen: { week: sw, month: sm, year: sy },
        settingsLoaded: true,
      });
    } catch {
      set({ settingsLoaded: true });
    }
  },

  async loadWeek(key) {
    try {
      const fresh = await fetchPeriod(key);
      set((s) => ({ weeks: { ...s.weeks, ...fresh } }));
      await get().refreshPlanned(key);
    } catch (e) {
      console.warn("[next-stop] 週方針載入失敗：", message(e));
    }
  },

  async loadKeys(keys) {
    if (!keys.length) return;
    try {
      const fresh = await fetchKeys(keys);
      set((s) => ({ weeks: { ...s.weeks, ...fresh } }));
    } catch (e) {
      console.warn("[next-stop] 週方針載入失敗：", message(e));
    }
  },

  async refreshPlanned(key) {
    const keys = key ? [key] : Object.keys(get().weeks);
    for (const w of keys) {
      const aims = get().weeks[w] ?? [];
      const refs = await refsOf(aims, w);
      const range = aimRangeOf(w);
      if (!refs.length || !range) {
        set((s) => ({ planned: { ...s.planned, [w]: {} } }));
        continue;
      }
      try {
        const counts = await weekAimRepo.plannedCounts(refs, range.from, range.to);
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
      // 合併、不整包換：等待期間別的畫面載好的鍵不能丟（丟了那張告示卡在 loading、回顧排隊停擺）。`loaded` 每個鍵都有值（刪光＝空陣列），不會殘留舊句子
      const fresh = await fetchKeys(loaded);
      set((s) => ({ weeks: { ...s.weeks, ...fresh } }));
      await get().refreshPlanned();
      const rv = get().review;
      if (rv) await get().openReview(rv.weekOn);
    } catch (e) {
      console.warn("[next-stop] 週方針重載失敗：", message(e));
    }
  },

  async setFolded(key, folded) {
    const raw = foldValue(key, folded);
    const period = periodOfKey(key);
    set((s) => ({ foldRaw: { ...s.foldRaw, [period]: raw } }));
    await settingsRepo.set(KEY_AIMS_FOLD[period], raw).catch(() => undefined);
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

  openEditor(key, preCarry = []) {
    set({ editor: { weekOn: key, preCarry } });
    void get().loadWeek(key);
  },
  closeEditor() {
    set({ editor: null });
  },

  async saveWeek(key, drafts, base) {
    try {
      // 現況一律重讀（不用畫面上的快取），再跟框打開當下的 base 比：別處刪掉的不復活、別處新寫的不被刪（planSaveWeek）
      const bounds = keyRowBounds(key);
      const cur = aimsOfKey(await weekAimRepo.listRange(bounds.from, bounds.to), key);
      const plan = planSaveWeek(cur, drafts, key, base);
      await weekAimRepo.saveWeek(key, plan);
      await get().loadWeek(key);
      const notice = aimConflictNotice(plan);
      // 存檔時刪掉的句子給一次反悔（失物招領 §5-2）；同時撞到別處的改動就接在同一則，免得兩則互蓋。沒刪句也沒撞到＝不出 toast（看得到結果）
      if (plan.deletes.length) {
        const deleted = `已刪除 ${plan.deletes.length} 句`;
        toast(notice ? `${deleted}；${notice}` : deleted, {
          actionLabel: "復原",
          onAction: () => {
            void (async () => {
              try {
                for (const id of plan.deletes) await weekAimRepo.restoreAim(id);
              } catch (e) {
                toast(message(e));
              }
              await get().loadWeek(key);
            })();
          },
        });
      } else if (notice) {
        useUiStore.getState().showToast({ message: notice }, 6_000);
      }
      return true;
    } catch (e) {
      toast(message(e));
      return false;
    }
  },

  async carryDraft(src, targetKey) {
    return { id: await carryAimId(src.id, targetKey), text: src.text, nodeId: src.node_id, carriedFrom: src.id };
  },

  async openReview(key, opts) {
    const prev = get().review;
    const same = prev !== null && prev.weekOn === key;
    const inCard = opts?.inCard ?? (same && prev.inCard === true);
    set({ review: { weekOn: key, result: same ? prev.result : null, inCard } });
    if (!get().weeks[key]) await get().loadWeek(key);
    else void get().refreshPlanned(key); // 上一期是跟著這一期載的，它的「已排」還沒算
    try {
      const refs = await refsOf(get().weeks[key] ?? [], key);
      const range = aimRangeOf(key);
      const result = range ? await weekAimRepo.reviewStats(refs, range, useUiStore.getState().dayStartHour) : { stats: {}, money: null };
      if (get().review?.weekOn === key) set({ review: { weekOn: key, result, inCard } });
    } catch (e) {
      console.warn("[next-stop] 週方針回顧數字失敗：", message(e));
      if (get().review?.weekOn === key) set({ review: { weekOn: key, result: { stats: {}, money: null }, inCard } });
    }
  },

  async closeReview() {
    const rv = get().review;
    if (!rv) return;
    const period = periodOfKey(rv.weekOn);
    const seen = period === "station" ? null : get().reviewSeen[period];
    // 車站的回顧不排隊，不用記（D-主-374）；回頭看更早的不倒退
    if (period === "station" || (seen !== null && seen >= rv.weekOn)) {
      set({ review: null });
      return;
    }
    // 同一次 set：今日告示看到回顧關了就接下一張（AimsBand），不能先看到「關了但還沒看過」把同一張又打開
    set((s) => ({ review: null, reviewSeen: { ...s.reviewSeen, [period]: rv.weekOn } }));
    await settingsRepo.set(KEY_AIMS_REVIEW_SEEN[period], rv.weekOn).catch(() => undefined);
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

/** 某句在 store 裡屬於哪個載過的期間（週的 week_on 是寫的當下的週首；改過週起始日時兩者可能不同） */
function aimsWeekOf(weeks: Record<string, WeekAimRow[]>, aim: WeekAimRow): string | null {
  for (const [w, list] of Object.entries(weeks)) if (list.some((a) => a.id === aim.id)) return w;
  return null;
}

/** 今天（依日界線） */
export function aimsToday(): string {
  return todayKey(useUiStore.getState().dayStartHour);
}

/** 這一期沒済、還沒帶到 target 的（回顧頁腳「帶到下週（N 句）」） */
export function uncarried(src: readonly WeekAimRow[], target: readonly WeekAimRow[]): WeekAimRow[] {
  const carried = new Set(target.map((a) => a.carried_from).filter(Boolean));
  return carryCandidates(src).filter((a) => !carried.has(a.id));
}
