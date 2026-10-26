/**
 * reorderDrag——手機今日長按拖曳排序的純算術（手機殼班 D-主-74；原型 Q4）。React 與 DOM 在 useLongPressReorder.ts。
 * 不 import React／store：node test 直接載入（scripts/tests/mobile-reorder-drag.test.ts）。
 *
 * 座標：`slots` 是抬起那一刻、手排座標（manualOrderIds）裡每一張卡在畫面上的位置（同一個參考系即可，元件用 viewport px）。
 * 「落點 index」＝拿掉自己之後插進第幾格——跟 `nodeStore.moveToday(id, index)`（reorderIds）同一套；
 * 放開時換成鄰居錨（`anchorAt`），寫入前再對最新座標換回 index（`indexOfAnchor`），理由見 DropAnchor。
 */

/** 長按多久才抬起（ms；原型 Q4） */
export const LIFT_DELAY_MS = 400;
/** 抬起前手指移動超過這個距離＝當成捲動，不抬（px） */
export const MOVE_SLOP_PX = 8;

export interface Slot {
  top: number;
  height: number;
}

/** 抬起那張的中心點 `center` 落在哪一格：數有幾張別的卡的中線在它上面 */
export function dropIndex(slots: readonly Slot[], from: number, center: number): number {
  let to = 0;
  slots.forEach((s, i) => {
    if (i !== from && s.top + s.height / 2 < center) to++;
  });
  return to;
}

/** 第 i 張（不是抬起的那張）要讓位多少：from 與 to 之間的卡往回補一格（amount＝抬起那張的高＋列距） */
export function shiftOf(i: number, from: number, to: number, amount: number): number {
  if (i === from) return 0;
  if (from < to && i > from && i <= to) return -amount;
  if (to < from && i >= to && i < from) return amount;
  return 0;
}

/** 落點虛線框相對抬起那張原位的位移：往下拖＝框底對齊第 to 張的底；往上拖＝框頂對齊第 to 張的頂 */
export function dropOffset(slots: readonly Slot[], from: number, to: number): number {
  if (to === from) return 0;
  const f = slots[from];
  if (to > from) {
    const t = slots[to];
    return t.top + t.height - f.height - f.top;
  }
  return slots[to].top - f.top;
}

/**
 * 落點錨：放開時插在哪兩張之間——拿掉自己之後的上下鄰居 id（null＝頂／底）。
 * 為什麼不直接交 index（第二輪，反方評審 correctness minor；mock 重現過）：index 是抬起那一刻的快照算的，
 *   拖曳中清單若被重載（同步拉下來、別台改了順序、跨日界線），moveToday 拿最新的手排座標套同一個 index 就落錯格。
 *   改交鄰居 id、寫入前對最新座標換算（`indexOfAnchor`）＝「放在 A 的後面」不會因為上面多一張而偏掉。
 */
export interface DropAnchor {
  after: string | null;
  before: string | null;
}

/** `order` 是抬起那一刻的手排座標、`to` 是 dropIndex 的結果 ⇒ 落點的上下鄰居 */
export function anchorAt(order: readonly string[], id: string, to: number): DropAnchor {
  const rest = order.filter((x) => x !== id);
  return { after: to > 0 ? (rest[to - 1] ?? null) : null, before: rest[to] ?? null };
}

/**
 * 錨換回**最新**手排座標裡的 index（moveToday／reorderIds 的座標：拿掉自己之後插第幾格）。
 * 先認上鄰居（插在它後面）、不在了認下鄰居（插在它前面）；放在頂／底而那一側的鄰居不在了＝照樣頂／底；
 * 兩個鄰居都不在了＝null（不知道該放哪：呼叫端放棄、卡片退回原位）。
 */
export function indexOfAnchor(latest: readonly string[], id: string, a: DropAnchor): number | null {
  const rest = latest.filter((x) => x !== id);
  if (a.after !== null) {
    const i = rest.indexOf(a.after);
    if (i >= 0) return i + 1;
  }
  if (a.before !== null) {
    const i = rest.indexOf(a.before);
    if (i >= 0) return i;
  }
  if (a.after === null) return 0;
  if (a.before === null) return rest.length;
  return null;
}

/** 拖到捲動區上下緣時自動捲：回這一格要捲幾 px（負＝往上）。edge＝感應帶高、max＝最快每格幾 px */
export function edgeScrollStep(y: number, top: number, bottom: number, edge = 56, max = 12): number {
  if (y < top + edge) return -Math.ceil(max * Math.min(1, (top + edge - y) / edge));
  if (y > bottom - edge) return Math.ceil(max * Math.min(1, (y - (bottom - edge)) / edge));
  return 0;
}
