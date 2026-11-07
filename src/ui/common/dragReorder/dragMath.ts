/**
 * dragMath——共用拖曳元件的純算術（回饋乙 D-主-151～153）。React 與 DOM 在 useDragReorder.ts。
 * 不 import React／store：node test 直接載入（scripts/tests/drag-reorder-math.test.ts）。
 *
 * 座標系：`slots` 是拖起那一刻、清單裡「沒有被拖走」的每一列在畫面上的位置（同一個參考系即可，元件用 viewport px
 * 再補捲動位移）。「縫」g＝0..n：第 g 個縫在 rest[g-1] 與 rest[g] 之間（0＝最上、n＝最下）。
 * 一層清單只看縫；樹（攤平＋縮排）再用左右位移挑「落在第幾層」，`treePlace` 換算成「父節點＋上下兄弟」。
 */

export interface Slot {
  top: number;
  height: number;
}

/** 指標 y 落在哪個縫：數有幾列的中線在它上面 */
export function gapAt(slots: readonly Slot[], y: number): number {
  let g = 0;
  for (const s of slots) if (s.top + s.height / 2 < y) g++;
  return g;
}

/** 第 g 個縫的落點線 y：兩列之間取中點；頭尾貼著第一列頂／最後一列底 */
export function gapY(slots: readonly Slot[], g: number): number {
  if (slots.length === 0) return 0;
  if (g <= 0) return slots[0].top;
  if (g >= slots.length) {
    const s = slots[slots.length - 1];
    return s.top + s.height;
  }
  const a = slots[g - 1];
  const b = slots[g];
  return (a.top + a.height + b.top) / 2;
}

/** 落點：放在誰後面、誰前面（拿掉被拖的列之後的鄰居 id；null＝頭／尾）。寫入前呼叫端對最新清單換算 */
export interface Anchor {
  after: string | null;
  before: string | null;
}

/**
 * 多欄、欄內能排序：放回原位沒有動嗎。要拖的那批在這一欄是連著的、而且落點的上下鄰居就是拖起前的鄰居才算；
 * 不連續的一批放在第一張旁邊會把中間那幾張接起來，是真的有動。
 */
export function isColumnGapNoop(inCol: readonly string[], ids: readonly string[], a: Anchor): boolean {
  const first = inCol.indexOf(ids[0]);
  const last = inCol.indexOf(ids[ids.length - 1]);
  if (first < 0 || last < 0 || last - first + 1 !== ids.length) return false;
  return a.after === (inCol[first - 1] ?? null) && a.before === (inCol[last + 1] ?? null);
}

/** 一層清單的縫 → 鄰居錨 */
export function anchorOfGap(rest: readonly { id: string }[], g: number): Anchor {
  return { after: g > 0 ? (rest[g - 1]?.id ?? null) : null, before: rest[g]?.id ?? null };
}

/**
 * 錨換回**最新**清單（拿掉自己之後）的 index：先認上鄰居（插它後面），不在了認下鄰居（插它前面）；
 * 放在頭／尾而那一側的鄰居不在了＝照樣頭／尾；兩個鄰居都不在＝null（呼叫端放棄、退回原位）。
 */
export function indexOfAnchor(latest: readonly string[], ids: readonly string[] | string, a: Anchor): number | null {
  const moving = new Set(typeof ids === "string" ? [ids] : ids);
  const rest = latest.filter((x) => !moving.has(x));
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

/** 樹的一列：攤平後的顯示序＋層級（0＝最上層） */
export interface TreeRow {
  id: string;
  depth: number;
}

/**
 * 第 g 個縫能落在哪幾層：最深＝上一列的下一層（成為它的子項），最淺＝下一列那一層（不能把下一列「切」離它的父節點）。
 * 頭一個縫只能是第 0 層。
 */
export function depthRange(rest: readonly TreeRow[], g: number): { min: number; max: number } {
  const prev = g > 0 ? rest[g - 1] : undefined;
  const next = rest[g];
  const max = prev ? prev.depth + 1 : 0;
  const min = next ? Math.min(next.depth, max) : 0;
  return { min, max };
}

/** 左右位移換成層級：拖起那列原本的層＋位移／縮排寬，夾在縫的範圍裡 */
export function depthAt(range: { min: number; max: number }, startDepth: number, dx: number, indent: number): number {
  const want = startDepth + Math.round(dx / Math.max(1, indent));
  return Math.max(range.min, Math.min(range.max, want));
}

/** 樹的落點：新父節點（null＝最上層）＋在新父節點底下放在哪兩個兄弟之間 */
export interface TreePlace {
  depth: number;
  parent: string | null;
  after: string | null;
  before: string | null;
}

/**
 * 縫 g、層 d → 父節點與上下兄弟。往上找第一列層級 < d 的＝父節點（因為往下每列最多深一層，找到的一定是 d-1）；
 * 途中遇到的第一列層級 == d 的＝上一個兄弟；rest[g] 層級 == d 才是下一個兄弟。
 */
export function treePlace(rest: readonly TreeRow[], g: number, d: number): TreePlace {
  let parent: string | null = null;
  let after: string | null = null;
  for (let i = g - 1; i >= 0; i--) {
    const r = rest[i];
    if (r.depth < d) {
      parent = r.id;
      break;
    }
    if (r.depth === d && after === null) after = r.id;
  }
  const next = rest[g];
  const before = next && next.depth === d ? next.id : null;
  return { depth: d, parent, after, before };
}

/** 從偏好的層往兩側找第一個「能放」的層（同距離先試淺一層）；都不行回 null */
export function nearestValidDepth(
  range: { min: number; max: number },
  want: number,
  ok: (d: number) => boolean,
): number | null {
  for (let k = 0; k <= range.max - range.min; k++) {
    for (const d of k === 0 ? [want] : [want - k, want + k]) {
      if (d >= range.min && d <= range.max && ok(d)) return d;
    }
  }
  return null;
}

/** 拖到捲動區上下緣時自動捲：回這一格要捲幾 px（負＝往上）。edge＝感應帶高、max＝最快每格幾 px */
export function edgeScrollStep(y: number, top: number, bottom: number, edge = 56, max = 12): number {
  if (y < top + edge) return -Math.ceil(max * Math.min(1, (top + edge - y) / edge));
  if (y > bottom - edge) return Math.ceil(max * Math.min(1, (y - (bottom - edge)) / edge));
  return 0;
}

/** 長按多久才浮起（ms；手機殼班原型 Q4） */
export const LIFT_DELAY_MS = 400;
/** 浮起前手指移動超過這個距離＝當成捲動（px） */
export const TOUCH_SLOP_PX = 8;
/** 滑鼠按下後移動超過這個距離才開始拖（px）——不吃單擊、雙擊 */
export const MOUSE_SLOP_PX = 4;
/** 滑動手勢：橫向超過這個距離、而且明顯比縱向大，才當成滑動（px） */
export const SWIPE_START_PX = 12;
/** 滑動手勢：滑過卡寬的這個比例放開才算數 */
export const SWIPE_COMMIT_RATIO = 0.35;
/** 拖到摺起來的列上停多久自動展開（ms） */
export const HOVER_EXPAND_MS = 600;
/** 手機一次一欄的看板：手指貼著欄區左右緣多近算貼邊（px）、停多久翻一欄（ms） */
export const COL_FLIP_EDGE_PX = 24;
export const COL_FLIP_MS = 500;
/** 同上：貼著欄的上下緣停多久才開始捲（ms） */
export const COL_VSCROLL_MS = 300;

/** 滑動手勢是否成立：橫向夠遠、而且比縱向大 1.5 倍以上 */
export function isSwipe(dx: number, dy: number): boolean {
  return Math.abs(dx) >= SWIPE_START_PX && Math.abs(dx) > Math.abs(dy) * 1.5;
}
