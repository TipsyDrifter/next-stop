/**
 * 時刻表線③・`&tt=stats` 示範資料的產生器（純函式；甲席，評審 #2 從 memoryTimetableRepository 抽出來才測得到）。
 *
 * 鐵則同 timetableStats.ts：只准 import `./timetable.ts` 與 `../lib/date.ts`，相對路徑帶 `.ts`，只用可剝除語法
 * （牙齒：`scripts/tests/timetable-stats.test.ts`）。
 *
 * 規則（契約 0-12、評審 #2）：最近 10 週、每天 6–9 筆首尾相接；**每一塊長度夾在分類 default_min × 0.9 以下**
 * （否則門檻 = default_min，塊一長就全成「待確認」，統計頁的待確認清單爆量）；多出來的時間給睡覺（上限 default × 0.9）、
 * 再給幾塊休息，還剩的就留白（未記錄）。故意跑太久的只有 3 塊（待確認）、碎塊 5 塊、另有一塊確認過的長時間運行。
 */
import { MIN, STARTER_CATEGORIES, msOf } from "./timetable.ts";
import { addDays, dayWindow, todayKey } from "../lib/date.ts";

/** 示範時間塊：key＝起手分類 key；start／end 毫秒（end null＝運行中） */
export interface DemoBlock {
  key: string;
  start: number;
  end: number | null;
  ack?: boolean;
  nodeId?: string | null;
  routeId?: string | null;
}

/** mulberry32：固定種子的亂數（同一天開兩次長一樣） */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashKey(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h;
}

/** 一天的分類池：key＝起手分類 key；w＝抽中的權重；min＝典型長度（分）。睡覺固定放最後一塊，不在池裡 */
const STATS_POOL: { key: string; w: number; min: number }[] = [
  { key: "play", w: 14, min: 110 },
  { key: "meal", w: 12, min: 40 },
  { key: "create", w: 11, min: 100 },
  { key: "class", w: 9, min: 120 },
  { key: "study", w: 8, min: 70 },
  { key: "rest", w: 7, min: 30 },
  { key: "hobby", w: 6, min: 50 },
  { key: "move", w: 6, min: 35 },
  { key: "wash", w: 5, min: 30 },
  { key: "chore", w: 3, min: 40 },
  { key: "sport", w: 3, min: 50 },
  { key: "social", w: 2, min: 90 },
  { key: "shop", w: 2, min: 40 },
  { key: "work", w: 2, min: 100 },
];
const STATS_LINKABLE = new Set(["class", "create", "study", "hobby", "work"]);

/** 起手分類 key → 該分類預設長度的 90%（分鐘，取整）；塊的長度上限 */
const CAP_MIN: Record<string, number> = {};
for (const c of STARTER_CATEGORIES) if (c.defaultMin !== null) CAP_MIN[c.key] = Math.floor(c.defaultMin * 0.9);
const capOf = (key: string): number => CAP_MIN[key] ?? 60;

/** 把 [s, e) 從 list 裡挖掉（跨過的切短／切開、整個被蓋的刪掉） */
function carve(list: DemoBlock[], s: number, e: number): void {
  const out: DemoBlock[] = [];
  for (const b of list) {
    const bEnd = b.end ?? Number.MAX_SAFE_INTEGER;
    if (bEnd <= s || b.start >= e) {
      out.push(b);
      continue;
    }
    if (b.start < s) out.push({ ...b, end: s });
    if (bEnd > e) out.push({ ...b, start: e });
  }
  list.length = 0;
  list.push(...out);
}

/** 碎塊（<60 秒）以外的最短長度：運行中那班若剛開始不到這麼久就不畫（否則會多一塊碎塊，數字隨開啟時刻飄） */
const MIN_RUNNING_MS = 2 * MIN;

/** 最近 10 週的示範時間塊（依開始時間排好；今天截在 now，跨過 now 的那塊改成運行中） */
export function buildStatsDemo(h: number, now: number, links: { nodeIds: string[]; routeIds: string[] }): DemoBlock[] {
  const today = todayKey(h, new Date(now));
  const list: DemoBlock[] = [];
  const DAYS = 70;
  for (let back = DAYS - 1; back >= 0; back--) {
    const key = addDays(today, -back);
    const rand = rng(hashKey(key));
    const base = msOf(dayWindow(key, h).start);
    const next = msOf(dayWindow(addDays(key, 1), h).start);
    const total = Math.round((next - base) / MIN);
    const n = 6 + Math.floor(rand() * 4); // 6–9 筆
    const picks: { key: string; min: number }[] = [];
    let prev = "";
    while (picks.length < n - 1) {
      const sum = STATS_POOL.reduce((a, p) => a + p.w, 0);
      let r = rand() * sum;
      let hit = STATS_POOL[0];
      for (const p of STATS_POOL) {
        r -= p.w;
        if (r <= 0) {
          hit = p;
          break;
        }
      }
      if (hit.key === prev) continue; // 不連續同一類
      prev = hit.key;
      picks.push({ key: hit.key, min: hit.min * (0.6 + rand() * 0.9) });
    }
    const sleepBase = Math.round(360 + rand() * 120); // 睡 6–8 小時，固定放最後
    const awake = total - sleepBase;
    const sumPick = picks.reduce((a, p) => a + p.min, 0);
    const scale = awake / sumPick; // 想把前 n-1 塊撐滿到睡覺之前（再夾到各分類的 90%）
    const lens = picks.map((p) => Math.min(capOf(p.key), Math.max(5, Math.round(p.min * scale))));
    let leftover = awake - lens.reduce((a, b) => a + b, 0);
    // 餘量：先給睡覺（上限 90%），再給休息（隔一塊插一塊），還剩的留白
    const extraSleep = Math.max(0, Math.min(capOf("sleep") - sleepBase, leftover));
    const sleepLen = sleepBase + extraSleep;
    leftover -= extraSleep;
    const seq: { key: string; min: number }[] = [];
    picks.forEach((p, i) => {
      seq.push({ key: p.key, min: lens[i] });
      if (i % 2 === 1 && leftover >= 5) {
        const m = Math.min(capOf("rest"), leftover);
        seq.push({ key: "rest", min: m });
        leftover -= m;
      }
    });
    let t = base;
    for (const p of seq) {
      list.push({ key: p.key, start: t, end: t + p.min * MIN });
      t += p.min * MIN;
    }
    list.push({ key: "sleep", start: next - sleepLen * MIN, end: next });
  }
  // 約三成連到車票、一成只連路線
  if (links.nodeIds.length || links.routeIds.length) {
    const rand = rng(20261019);
    for (const b of list) {
      if (!STATS_LINKABLE.has(b.key)) continue;
      const r = rand();
      if (r < 0.7 && links.nodeIds.length) b.nodeId = links.nodeIds[Math.floor(rand() * links.nodeIds.length)];
      else if (r < 0.9 && links.routeIds.length) b.routeId = links.routeIds[Math.floor(rand() * links.routeIds.length)];
    }
  }
  const dayBase = (back: number): number => msOf(dayWindow(addDays(today, -back), h).start);
  // 3 塊跑太久沒確認（家務預設 90 分，一塊跑 31 小時、跨兩天）；另 1 塊確認過的長時間（對照）
  const longRuns: DemoBlock[] = [
    { key: "wash", start: dayBase(3) + 130 * MIN, end: dayBase(3) + 130 * MIN + 5 * 60 * MIN },
    { key: "chore", start: dayBase(9) + 600 * MIN, end: dayBase(9) + 600 * MIN + 31 * 60 * MIN },
    { key: "play", start: dayBase(20) + 780 * MIN, end: dayBase(20) + 780 * MIN + 9 * 60 * MIN },
    { key: "sleep", start: dayBase(14) + 100 * MIN, end: dayBase(14) + 100 * MIN + 13 * 60 * MIN, ack: true },
  ];
  // 5 塊碎塊（同一分鐘連換，10–40 秒）；前後各留一整分鐘讓開，被挖開的鄰塊不會剩出第六塊碎塊
  const tinyAt = dayBase(5) + 400 * MIN;
  const tinyLens = [10, 40, 15, 25, 12];
  const tinyKeys = ["create", "study", "rest", "play", "create"];
  let tt = tinyAt;
  const tinies: DemoBlock[] = tinyLens.map((s, i) => {
    const b = { key: tinyKeys[i], start: tt, end: tt + s * 1000 };
    tt += s * 1000;
    return b;
  });
  for (const b of longRuns) carve(list, b.start, b.end as number);
  carve(list, tinyAt, Math.ceil(tt / MIN) * MIN); // 挖到下一個整分鐘，剩下的鄰塊從整分鐘開始
  list.push(...longRuns, ...tinies);
  // 連到「已經不在的任務」：挑三塊上課（統計頁「（已刪除的任務）」那一列）
  const GONE = "dead0000-0000-4000-8000-000000000001";
  let gone = 0;
  for (const b of list) {
    if (gone >= 3) break;
    if (b.key === "class" && !b.nodeId && !b.routeId && b.start > dayBase(30)) {
      b.nodeId = GONE;
      gone++;
    }
  }
  list.sort((a, b) => a.start - b.start);
  // 今天截在 now
  const out: DemoBlock[] = [];
  for (const b of list) {
    if (b.start >= now) break;
    const cross = b.end !== null && b.end > now;
    if (cross) {
      // 運行中那班：剛開始不到 2 分鐘就不畫（免得多一塊碎塊）；不連任務（任務的預計時間會把它變成待確認）
      if (now - b.start >= MIN_RUNNING_MS) out.push({ ...b, end: null, nodeId: null });
      break;
    }
    out.push(b);
  }
  return out;
}
