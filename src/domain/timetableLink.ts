/**
 * 時刻表線・任務連動的純函式（車次② 契約 §3.2、§4.3；甲席 Stage 0-②）。
 *
 * 鐵則：只准 `import … from "./timetable.ts"`（含副檔名）——`scripts/tests/timetable-link.test.ts` 以 node 直接載入。
 * 只用可剝除語法；lib 目標 ES2020；時間一律毫秒；不改輸入。
 *
 * 內容：
 *   1. `linkOfRow`（node_id 優先）  2. `taskEstimateOf`  3. `linkLabelOf`  4. `runLabel`  5. `clipLabel`
 *   6. `doneKeyOf`  7. `watchStep`（蓋済偵測的狀態機）  8. 合計（`unionMs`／`linkedTotals`／`focusMs`／`monthStartKey`）
 */
import { msOf, type BlockLink, type TimeBlockRow } from "./timetable.ts";

/** 能連的節點種類（〈開工決定〉✎二-1）；不連支線、路線（路線用 route_id）、車站、幹線 */
export const LINKABLE_KINDS: readonly string[] = ["ticket", "train", "car"];

/** store.linkInfo 的一格（節點與路線共用；② 契約 0-16） */
export interface LinkInfo {
  id: string;
  /** "ticket"｜"train"｜"car"｜"route"｜其他（純字串，避免 import node.ts） */
  kind: string;
  /** 種類的中文名（車票／列車／車廂／路線），「（原X已刪除）」用；由 store 用 KIND_LABEL 填 */
  kindLabel: string;
  name: string;
  /** 節點所屬路線（node.route_id；路線本身＝自己的 id） */
  routeId: string | null;
  /** 節點的預計時間（分；null＝沒填） */
  estimateMin: number | null;
  /** 路線代碼（路線那一格才有） */
  code: string | null;
  deleted: boolean;
  /** getNode 回 null */
  missing: boolean;
}

/** 連到的東西被刪掉時的顯示（② 契約 0-15、§5.13 `LINK_DELETED`／`LINK_MISSING`；store 的 TT_TEXT 轉出這兩個） */
export const linkDeletedText = (kindLabel: string): string => `（原${kindLabel}已刪除）`;
export const LINK_MISSING_TEXT = "（原任務已刪除）";

type LinkCols = { node_id: string | null; route_id: string | null };

/* ───────── 1. 列 → 連結 ───────── */

/** ② 契約 0-2：node_id 優先；兩欄都有值（兩台同時改連結的過渡態）時 route_id 忽略 */
export function linkOfRow(r: LinkCols): BlockLink {
  if (r.node_id !== null) return { nodeId: r.node_id, routeId: null };
  if (r.route_id !== null) return { nodeId: null, routeId: r.route_id };
  return { nodeId: null, routeId: null };
}

/* ───────── 2. 任務的預計時間 ───────── */

/** ② 契約 0-7：連節點、info 在、沒刪、沒 missing、estimateMin > 0 ⇒ 那個值；其餘 null */
export function taskEstimateOf(r: LinkCols, links: Record<string, LinkInfo>): number | null {
  const l = linkOfRow(r);
  if (l.nodeId === null) return null;
  const info = links[l.nodeId];
  if (!info || info.deleted || info.missing) return null;
  const v = info.estimateMin;
  return v !== null && v > 0 ? v : null;
}

/* ───────── 3. 顯示用的連結文字 ───────── */

/**
 * ② 契約 0-15：
 *   連節點：info 還沒載（undefined）⇒ null；missing ⇒「（原任務已刪除）」；deleted ⇒「（原{kindLabel}已刪除）」；否則 name
 *   只連路線：info 還沒載 ⇒ null；deleted 或 missing ⇒「（原路線已刪除）」；否則 name
 *   沒連 ⇒ null
 */
export function linkLabelOf(r: LinkCols, links: Record<string, LinkInfo>): string | null {
  const l = linkOfRow(r);
  if (l.nodeId !== null) {
    const info = links[l.nodeId];
    if (!info) return null;
    if (info.missing) return LINK_MISSING_TEXT;
    if (info.deleted) return linkDeletedText(info.kindLabel);
    return info.name;
  }
  if (l.routeId !== null) {
    const info = links[l.routeId];
    if (!info) return null;
    if (info.deleted || info.missing) return linkDeletedText("路線");
    return info.name;
  }
  return null;
}

/* ───────── 4. 「分類・任務」 ───────── */

export function runLabel(catName: string, label: string | null): string {
  return label === null ? catName : `${catName}・${label}`;
}

/* ───────── 5. 截字 ───────── */

/** 通知、系統匣、navHint 用（② 契約 0-13）：Array.from 算字，> n ⇒ 前 n-1 字＋「…」 */
export function clipLabel(s: string, n = 16): string {
  const chars = Array.from(s);
  if (chars.length <= n) return s;
  return chars.slice(0, Math.max(0, n - 1)).join("") + "…";
}

/* ───────── 6. 蓋済的鍵 ───────── */

/**
 * ② 契約 0-8：定期券＝occurrence 是 done ⇒ `r:${due_on}`（只看 occurrence，不看 row.status）；一般＝status done ⇒ "n"；
 * 沒蓋済（含定期券運休 skipped、系列退休）⇒ null；row 是 undefined（切片裡找不到）⇒ undefined（＝不知道）
 */
export function doneKeyOf(
  row: { status: string; repeat_rule: string | null } | undefined,
  occ: { status: string; due_on: string } | undefined,
  isRepeat: boolean,
): string | null | undefined {
  if (row === undefined) return undefined;
  if (isRepeat) return occ && occ.status === "done" ? `r:${occ.due_on}` : null;
  return row.status === "done" ? "n" : null;
}

/* ───────── 7. 蓋済偵測的狀態機 ───────── */

export interface WatchState {
  /** `${blockId}|${nodeId}`；運行中那班沒連節點＝null */
  key: string | null;
  /** 上一次看到的 doneKey */
  base: string | null | undefined;
  /** working 期間看到、還沒判 */
  pending: boolean;
  /** 這一趟 working 裡收到 pulled */
  pulled: boolean;
  /** 已提示過的 `${key}#${doneKey}` */
  prompted: string | null;
  /** 抑制模式（② 契約 0-8 的兩個破口）：看到轉變只更新 base */
  suppress: boolean;
}

export const WATCH_INIT: WatchState = {
  key: null,
  base: undefined,
  pending: false,
  pulled: false,
  prompted: null,
  suppress: false,
};

export type WatchEvent =
  | { kind: "observe"; key: string | null; doneKey: string | null | undefined; working: boolean }
  | { kind: "pulled" }
  | { kind: "settled"; dirty: boolean }
  | { kind: "unsuppress" };

/** 回新狀態與要不要提示（prompt＝要提示的那個 key；null＝不提示）；規則見 ② 契約 §4.3-7 */
export function watchStep(s: WatchState, e: WatchEvent): { state: WatchState; prompt: string | null } {
  switch (e.kind) {
    case "observe": {
      if (e.key !== s.key) {
        return {
          state: { key: e.key, base: e.doneKey, pending: false, pulled: false, prompted: s.prompted, suppress: s.suppress },
          prompt: null,
        };
      }
      // doneKey undefined（切片暫時沒有這個節點）不算變化：base 不動
      const base = e.doneKey === undefined ? s.base : e.doneKey;
      const pending = e.doneKey === null ? false : s.pending; // 取消済 ⇒ 待判作廢
      if (s.suppress || e.key === null) {
        return { state: { ...s, base, pending }, prompt: null };
      }
      const turned = s.base === null && typeof e.doneKey === "string";
      if (turned) {
        const tag = `${e.key}#${e.doneKey}`;
        if (tag !== s.prompted) {
          if (!e.working) return { state: { ...s, base, pending, prompted: tag }, prompt: e.key };
          return { state: { ...s, base, pending: true }, prompt: null };
        }
      }
      return { state: { ...s, base, pending }, prompt: null };
    }
    case "pulled":
      return { state: s.pending ? { ...s, pulled: true } : s, prompt: null };
    case "settled": {
      const fire = s.pending && !s.pulled && s.key !== null;
      const next: WatchState = {
        ...s,
        pending: false,
        pulled: false,
        suppress: e.dirty ? true : s.suppress,
        prompted: fire ? `${s.key}#${s.base}` : s.prompted,
      };
      return { state: next, prompt: fire ? s.key : null };
    }
    case "unsuppress":
      return { state: { ...s, suppress: false }, prompt: null };
    default:
      return { state: s, prompt: null };
  }
}

/* ───────── 8. 合計 ───────── */

export interface LinkedSpan {
  id: string;
  start: number;
  end: number | null;
  nodeId: string | null;
  routeId: string | null;
}

/** 列 → 合計用的區間（連結經 linkOfRow） */
export function toLinkedSpan(r: TimeBlockRow): LinkedSpan {
  const l = linkOfRow(r);
  return {
    id: r.id,
    start: msOf(r.started_at),
    end: r.ended_at === null ? null : msOf(r.ended_at),
    nodeId: l.nodeId,
    routeId: l.routeId,
  };
}

/** 區間聯集的長度（負長度當 0、運行中到 now、裁到 window；Plan 技術底線 4：重疊不重複計） */
export function unionMs(
  spans: readonly { start: number; end: number | null }[],
  now: number,
  window?: { start: number; end: number } | null,
): number {
  const iv: [number, number][] = [];
  for (const s of spans) {
    let a = s.start;
    let b = s.end ?? now;
    if (window) {
      a = Math.max(a, window.start);
      b = Math.min(b, window.end);
    }
    if (b > a) iv.push([a, b]);
  }
  if (!iv.length) return 0;
  iv.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let total = 0;
  let curA = iv[0][0];
  let curB = iv[0][1];
  for (let i = 1; i < iv.length; i++) {
    const [a, b] = iv[i];
    if (a <= curB) {
      if (b > curB) curB = b;
    } else {
      total += curB - curA;
      curA = a;
      curB = b;
    }
  }
  return total + (curB - curA);
}

/**
 * self：{ nodeId } ⇒ nodeId 相等的是自己；{ routeId } ⇒ nodeId null 且 routeId 相等的是自己；其餘都算底下
 * （呼叫端已經篩好範圍）。手填不在這裡（呼叫端加）。
 */
export function linkedTotals(
  spans: readonly LinkedSpan[],
  input: { self: { nodeId: string } | { routeId: string }; now: number; window?: { start: number; end: number } | null },
): { selfMs: number; belowMs: number; totalMs: number } {
  const self = input.self;
  const isSelf = (s: LinkedSpan): boolean =>
    "nodeId" in self ? s.nodeId === self.nodeId : s.nodeId === null && s.routeId === self.routeId;
  const mine: LinkedSpan[] = [];
  const below: LinkedSpan[] = [];
  for (const s of spans) (isSelf(s) ? mine : below).push(s);
  return {
    selfMs: unionMs(mine, input.now, input.window),
    belowMs: unionMs(below, input.now, input.window),
    totalMs: unionMs(spans, input.now, input.window),
  };
}

/** 今日「專注」（② 契約 0-14）：有連結（nodeId 或 routeId 非 null）的塊的聯集，裁到 window */
export function focusMs(spans: readonly LinkedSpan[], window: { start: number; end: number }, now: number): number {
  return unionMs(
    spans.filter((s) => s.nodeId !== null || s.routeId !== null),
    now,
    window,
  );
}

/**
 * 本月第一天的日界線日 key：`YYYY-MM-DD` → `YYYY-MM-01`（傳進來的是日界線的今天，凌晨自然還算前一天）。
 * 本檔不能 import `lib/date`，呼叫端再用 `dayWindow(key, dayStartHour).start` 換成毫秒。
 */
export function monthStartKey(todayKey: string): string {
  return todayKey.slice(0, 8) + "01";
}
