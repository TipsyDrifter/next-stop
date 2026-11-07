/**
 * useDragReorder——全 App 共用的拖曳排序與歸屬（回饋乙 D-主-151～153；契約 docs/research/2026-11-01-回饋乙-契約.md §2）。
 * 一套 API、桌機滑鼠＋手機長按；算術在 dragMath.ts（有單測）。
 *
 * 怎麼接（呼叫端只做三件事）：
 *   1. 清單容器給 `root`（callback ref 拿元素），每一列的元素帶 `data-drag-id={id}`（列裡的按鈕、輸入框上按下不會起拖）。
 *   2. `items` 給畫面上的順序（樹再帶 depth）；能不能拖 `canDrag`、能不能放 `resolve`（回 true 或一句理由）。
 *   3. `onDrop(ids, place)` 自己寫入：`place.kind === "slot"` 交「父節點＋放在誰後面／誰前面」（鄰居錨，寫入前對最新清單用
 *      `indexOfAnchor` 換算——拖曳中清單被同步重載也不會落錯格）；`"target"` 交外部落點（畫面上任何帶 `data-drop-target` 的元素，
 *      例：側欄路線、日期）。
 *
 * 手感：
 *   - 滑鼠：按下後移動超過 4px 才開始拖（不吃單擊、雙擊）；Ctrl／⌘／Shift＋按下留給多選，不起拖。
 *   - 觸控：按住 400ms 浮起；手指一動＝拖曳，原地放開＝`onPressRelease`（D-主-152：長按＝選起來）；浮起前移動 8px 內算捲動。
 *     有 `swipe` 時橫向滑＝滑動手勢（右滑／左滑各一個動作，滑過卡寬 35% 放開才算）。
 *   - 浮起＝一張跟著指標走的影子卡（原列退成淡態留在原位）；落點＝靛色虛線，樹會跟著縮排；放不下＝赭色線＋一句理由。
 *   - 拖到捲動區上下緣自動捲；樹拖到摺起來的列上停 600ms 自動展開；Esc 取消。
 *
 * 實作取捨：
 *   - pointer events，不用原生 HTML5 拖放：原生拖放在手機 WebView 不觸發，而且列的 mousedown 一被擋就發不出 dragstart（useTodayDnd 踩過）。
 *   - 拖曳中的一切直接寫 DOM（影子卡、落點線），不經 React state——每個 pointermove 重畫整張清單太重。
 *   - 影子卡＝列的複製品放進 body，外面包一串跟原列祖先同 class 的 `display: contents` 殼：
 *     各模組的樣式選擇器（`.ns-today .ticket-list > li`…）照樣套得上，又不會被捲動容器的 overflow 裁掉（拖到側欄看得到）。
 *   - 放開後原列先維持淡態，等清單換成新順序（`items` 變了）才清；1.2 秒內沒換＝寫入失敗（store 已吐 toast），照樣清。
 *   - touchmove 監聽一直掛著、非 passive：Chrome 在 touchstart 那一刻決定這串觸控能不能被擋，浮起後才掛就來不及。
 *   - 影子卡與滑開的卡一律不透明（原型 prototypes/回饋乙-拖曳多選右鍵.html 實測）：display:contents 殼畫不出祖先的底色
 *     （書封上的列拖出來字就看不見），手機票紙又是半透明（透出底下的字和滑動底色）——找到列裡第一個有底色的元素，
 *     把「離它最近的不透明祖先底色」墊在它自己的底色下面，看起來跟原位一樣、但不透光。
 *   - 指標碰到外部落點時影子卡往游標縮小（0.3 倍）：不然影子卡永遠蓋住游標底下那個目標，虛線框看不見。
 *   - 落點顏色讀清單容器上的 `--dr-accent`（沒設＝--accent）：書封是深底，靛色看不見，書封改燙金（同書封聚焦框慣例）。
 *   - 清單自己的列同時是外部落點時（側欄路線列）：在自己清單裡拖不算外部落點，照縫排序。
 *   - 多欄（`columns`，⑫ 看板）：一個 root 管整片欄區，欄帶 `data-drag-col`；指標在哪一欄就算哪一欄的縫，落點多帶 `col`。
 *     欄各自會捲、欄區也會橫捲，所以每次定位都重量（一片看板幾百張，量一次的成本比算捲動位移的出錯便宜）；拖曳中關掉 scroll-snap，放手才吸附。
 *   - 手機一次一欄（`columns.flip`）：貼邊「停一下」才翻一欄，不連續捲——拇指本來就常在螢幕邊上，連續捲會跟著手指亂跑。
 *     換欄的主要路是底部一排落點（外部落點、呼叫端畫）：`onDragStart`／`onDragEnd` 告訴呼叫端何時升起、收回；
 *     落點帶 `data-drop-ghost="above"`＝影子卡縮小退到它上方（手指和落點的字才看得到）；落點列帶 `data-drop-rail`＝手指停在兩端會自己橫捲。
 */
import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import {
  COL_FLIP_EDGE_PX,
  COL_FLIP_MS,
  COL_VSCROLL_MS,
  HOVER_EXPAND_MS,
  LIFT_DELAY_MS,
  MOUSE_SLOP_PX,
  SWIPE_COMMIT_RATIO,
  TOUCH_SLOP_PX,
  anchorOfGap,
  isColumnGapNoop,
  depthAt,
  depthRange,
  edgeScrollStep,
  gapAt,
  gapY,
  isSwipe,
  nearestValidDepth,
  treePlace,
  type Slot,
  type TreePlace,
  type TreeRow,
} from "./dragMath";
import "./drag-reorder.css";

/** 放開的位置：清單裡的縫（樹＝父節點＋上下兄弟；一層清單 parent 恆 null、depth 0），或外部落點 */
export type DropPlace = ({ kind: "slot"; col?: string } & TreePlace) | { kind: "target"; type: string; target: string };

/** 能放回 true；不能放回一句理由（顯示在指標旁、放手退回） */
export type Verdict = true | string;

export interface SwipeAction {
  /** 滑開後底下露出的字（例：「蓋済」「明天」） */
  label: string;
  /** 底色語氣：seal＝朱（蓋済）、late＝赭（推遲類）、ink＝墨 */
  tone?: "seal" | "late" | "ink";
  /** 這一列能不能用這個動作；不能＝滑不開 */
  enabled?(id: string): boolean;
  run(id: string): void;
}

export interface DragReorderOpts {
  /** 清單容器（callback ref 拿到的元素）；列是它底下帶 `data-drag-id` 的元素 */
  root: HTMLElement | null;
  /** 畫面上的順序（樹帶 depth；一層清單省略）——只放看得到的列 */
  items: readonly (TreeRow | { id: string; depth?: number })[];
  /** 自動捲的捲動容器；省略＝往上找第一個會捲的祖先 */
  scrollRef?: RefObject<HTMLElement | null>;
  /** 能不能拖：true 或一句理由（拖了會被擋下、`onRefuse` 給 toast；觸控長按仍可 `onPressRelease`） */
  canDrag?(id: string): Verdict;
  onRefuse?(id: string, why: string): void;
  /** 這一列被拖起時一起走的列（多選）：照畫面順序；省略＝只有自己 */
  dragIds?(id: string): readonly string[];
  /** 樹模式：縮排寬（px）、拖起時一起走的子孫（畫面上看得到的）、摺疊判斷與展開 */
  tree?: {
    indent: number;
    carried?(ids: readonly string[]): readonly string[];
    collapsed?(id: string): boolean;
    expand?(id: string): void;
  };
  /** false＝這份清單沒有縫可放（推導順序的清單，例：行程表），只能拖到外部落點 */
  slots?: boolean;
  /**
   * 多欄（⑫ 看板）：`root` 底下每一欄帶 `data-drag-col={key}`，落點多帶 `col`。
   * `lines: false`＝只換欄、欄內沒有順序可放：不畫落點線，改在欄上標 `data-drop-over`。
   * `flip: true`＝一次一欄的手機看板：貼邊停一下翻一欄，不連續橫捲。
   * 跟 `tree` 不併用。
   */
  columns?: { lines: boolean; flip?: boolean };
  /** 能不能放在這裡；省略＝都能放 */
  resolve?(ids: readonly string[], place: DropPlace): Verdict;
  onDrop(ids: readonly string[], place: DropPlace): void;
  /** 浮起了（呼叫端升起外部落點）；`grab`＝抓住的那一列 */
  onDragStart?(ids: readonly string[], grab: string): void;
  /** 拖曳結束（放開、取消都算），在 onDrop／onPressRelease 之前 */
  onDragEnd?(): void;
  /** 觸控長按後原地放開（沒拖）＝選起來（D-主-152） */
  onPressRelease?(id: string): void;
  /** 觸控滑動手勢（D-主-153 ④）：右滑、左滑 */
  swipe?: { right?: SwipeAction; left?: SwipeAction };
  disabled?: boolean;
}

const ITEM_SEL = "[data-drag-id]";
const INTERACTIVE_SEL = "button, a, input, textarea, select, [contenteditable='true'], [data-no-drag]";
const SETTLE_TIMEOUT_MS = 1200;

interface Press {
  pointerId: number;
  touch: boolean;
  id: string;
  el: HTMLElement;
  x0: number;
  y0: number;
  timer: number;
  /** 觸控長按已到時（影子卡已浮起，還沒動） */
  lifted: boolean;
  refused: boolean;
}

interface Drag {
  pointerId: number;
  touch: boolean;
  ids: string[];
  /** 抓住的那一列 */
  grab: string;
  els: HTMLElement[];
  carriedEls: HTMLElement[];
  rest: TreeRow[];
  slots: (Slot & { left: number })[];
  /** 第 0 層的左緣（樹的落點線往右縮 depth×indent） */
  baseLeft: number;
  startDepth: number;
  x0: number;
  y0: number;
  lastX: number;
  lastY: number;
  scroll0: number;
  moved: boolean;
  place: DropPlace | null;
  ok: boolean;
  overTarget: HTMLElement | null;
  /** 多欄：現在標著 data-drop-over 的欄 */
  overCol: HTMLElement | null;
  hover: { id: string; since: number } | null;
  /** 一次一欄：貼在哪一邊（-1 左、1 右、0 沒有）、從什麼時候開始 */
  flipDir: number;
  flipSince: number;
  /** 一次一欄：手指貼著欄的上下緣從什麼時候開始（0＝沒有） */
  vSince: number;
  ghost: HTMLElement;
  raf: number;
}

interface Swipe {
  pointerId: number;
  id: string;
  el: HTMLElement;
  x0: number;
  dx: number;
  width: number;
  under: HTMLElement;
  parentPos: string | null;
  /** 滑動時墊的不透明底色：彈回後拿掉 */
  restore: () => void;
}

function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === "auto" || oy === "scroll") && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

const isClear = (c: string) => c === "transparent" || /rgba\([^)]*,\s*0\)$/.test(c);
const isOpaque = (c: string) => !isClear(c) && !/rgba\(/.test(c);

interface Paper {
  el: HTMLElement;
  path: number[];
  /** 紙畫在 ::before 上（大綱的 .ticket）：墊底只鋪不透明底色，紙色由偽元素自己疊上 */
  pseudo: boolean;
}

/** 列裡第一個有底色的元素（自己或往下兩層，廣度優先；元素本身或它的 ::before）＋它在列裡的子元素路徑 */
function paperOf(el: HTMLElement): Paper | null {
  const queue: { el: HTMLElement; path: number[] }[] = [{ el, path: [] }];
  while (queue.length) {
    const cur = queue.shift()!;
    if (!isClear(getComputedStyle(cur.el).backgroundColor)) return { ...cur, pseudo: false };
    if (!isClear(getComputedStyle(cur.el, "::before").backgroundColor)) return { ...cur, pseudo: true };
    if (cur.path.length < 2) Array.from(cur.el.children).forEach((c, i) => queue.push({ el: c as HTMLElement, path: [...cur.path, i] }));
  }
  return null;
}

/** 離 el 最近的不透明祖先底色（都沒有＝body 的） */
function opaqueBehind(el: HTMLElement): string {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const c = getComputedStyle(p).backgroundColor;
    if (isOpaque(c)) return c;
  }
  return getComputedStyle(document.body).backgroundColor;
}

/** 讓 el 不透明：自己的底色疊在後面那層不透明底色上（看起來一樣、不透光）；回還原函式 */
export function makeOpaque(target: HTMLElement, sample: HTMLElement = target, pseudo = false): () => void {
  const own = getComputedStyle(sample, pseudo ? "::before" : null).backgroundColor;
  if (isOpaque(own)) return () => undefined;
  const base = opaqueBehind(sample);
  const prev = { image: target.style.backgroundImage, color: target.style.backgroundColor };
  if (!pseudo && !isClear(own)) target.style.backgroundImage = `linear-gradient(${own}, ${own})`;
  target.style.backgroundColor = base;
  return () => {
    target.style.backgroundImage = prev.image;
    target.style.backgroundColor = prev.color;
  };
}

/** 影子卡：列的複製品，外面包一串跟原列祖先同 class／屬性的 `display: contents` 殼（理由見檔頭） */
function buildGhost(src: HTMLElement, count: number, grab: { x: number; y: number }): HTMLElement {
  const r = src.getBoundingClientRect();
  const chain: HTMLElement[] = [];
  for (let p = src.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) chain.push(p);
  let outer: HTMLElement | null = null;
  let inner: HTMLElement | null = null;
  for (let i = chain.length - 1; i >= 0; i--) {
    const a = chain[i];
    const w = document.createElement(a.tagName);
    for (const at of Array.from(a.attributes)) {
      if (at.name === "id" || at.name === "style" || at.name.startsWith("aria-") || at.name === "role") continue;
      w.setAttribute(at.name, at.value);
    }
    w.style.display = "contents";
    if (inner) inner.appendChild(w);
    else outer = w;
    inner = w;
  }
  const clone = src.cloneNode(true) as HTMLElement;
  clone.removeAttribute("data-drag-id");
  clone.removeAttribute("id");
  clone.classList.add("dr-ghost");
  clone.setAttribute("aria-hidden", "true");
  Object.assign(clone.style, {
    position: "fixed",
    left: `${r.left}px`,
    top: `${r.top}px`,
    width: `${r.width}px`,
    margin: "0",
    zIndex: "1000",
    pointerEvents: "none",
    transformOrigin: `${grab.x - r.left}px ${grab.y - r.top}px`,
  });
  // 不透明：原列裡有底色的那層，在複製品對應的元素上墊底
  const paper = paperOf(src);
  if (paper) {
    let t: HTMLElement | undefined = clone;
    for (const i of paper.path) t = t?.children[i] as HTMLElement | undefined;
    if (t) makeOpaque(t, paper.el, paper.pseudo);
  } else {
    clone.style.backgroundColor = opaqueBehind(src);
  }
  if (count > 1) {
    const b = document.createElement("span");
    b.className = "dr-ghost-count";
    b.textContent = String(count);
    clone.appendChild(b);
  }
  const host = document.createElement("div");
  host.className = "dr-ghost-host";
  host.setAttribute("aria-hidden", "true");
  if (outer && inner) {
    inner.appendChild(clone);
    host.appendChild(outer);
  } else host.appendChild(clone);
  document.body.appendChild(host);
  return host;
}

function overlay(cls: string): HTMLElement {
  const el = document.createElement("div");
  el.className = cls;
  el.setAttribute("aria-hidden", "true");
  document.body.appendChild(el);
  return el;
}

export function useDragReorder(opts: DragReorderOpts): void {
  const { root, disabled } = opts;
  const ref = useRef(opts);
  ref.current = opts;
  /** 放開後等新順序的那一次：清淡態的函式＋逾時 */
  const settle = useRef<{ clear: () => void; timer: number } | null>(null);
  /** 拖曳中清單換了（展開、同步重載）＝重新量位置 */
  const remeasure = useRef<(() => void) | null>(null);

  const itemsKey = opts.items.map((r) => `${r.id}:${r.depth ?? 0}`).join("|");
  useLayoutEffect(() => {
    const s = settle.current;
    if (s) {
      settle.current = null;
      window.clearTimeout(s.timer);
      s.clear();
    }
    remeasure.current?.();
  }, [itemsKey]);

  useEffect(() => {
    if (!root || disabled) return;
    let press: Press | null = null;
    let drag: Drag | null = null;
    let swipe: Swipe | null = null;
    let line: HTMLElement | null = null;
    let why: HTMLElement | null = null;
    let swallowClickUntil = 0;

    const elOf = (id: string) => root.querySelector<HTMLElement>(`${ITEM_SEL}[data-drag-id="${CSS.escape(id)}"]`);
    const scroller = () => ref.current.scrollRef?.current ?? scrollParent(root);
    const verdictDrag = (id: string): Verdict => ref.current.canDrag?.(id) ?? true;

    const endPress = () => {
      if (!press) return;
      window.clearTimeout(press.timer);
      press.el.classList.remove("dr-pressing");
      press = null;
    };

    const nudge = (el: HTMLElement) => {
      el.classList.remove("dr-nudge");
      void el.offsetWidth;
      el.classList.add("dr-nudge");
      window.setTimeout(() => el.classList.remove("dr-nudge"), 360);
    };

    // ───── 量位置 ─────
    /** 回「id → 列」這一輪的表：千張的看板每次 pointermove 都量，不能每筆各查一次 DOM */
    const measure = (d: Drag): Map<string, HTMLElement> => {
      const els = new Map<string, HTMLElement>();
      for (const el of root.querySelectorAll<HTMLElement>(ITEM_SEL)) {
        const id = el.dataset.dragId;
        if (id) els.set(id, el);
      }
      const hidden = new Set([...d.ids, ...(ref.current.tree?.carried?.(d.ids) ?? [])]);
      const rest: TreeRow[] = [];
      const slots: Drag["slots"] = [];
      for (const r of ref.current.items) {
        if (hidden.has(r.id)) continue;
        const el = els.get(r.id);
        if (!el) continue;
        const b = el.getBoundingClientRect();
        rest.push({ id: r.id, depth: r.depth ?? 0 });
        slots.push({ top: b.top, height: b.height, left: b.left });
      }
      const indent = ref.current.tree?.indent ?? 0;
      const rr = root.getBoundingClientRect();
      d.baseLeft = slots.length ? slots[0].left - rest[0].depth * indent : rr.left;
      d.rest = rest;
      d.slots = slots;
      d.scroll0 = scroller()?.scrollTop ?? 0;
      return els;
    };

    // ───── 落點 ─────
    const hideMarks = () => {
      if (line) line.style.opacity = "0";
      if (why) why.style.opacity = "0";
    };
    const setTarget = (d: Drag, el: HTMLElement | null, state: "ok" | "no" | null) => {
      if (d.overTarget && d.overTarget !== el) d.overTarget.removeAttribute("data-drop-over");
      d.overTarget = el;
      if (el && state) el.setAttribute("data-drop-over", state);
    };
    const showWhy = (d: Drag, text: string) => {
      why ??= overlay("dr-why techo-card");
      why.textContent = text;
      why.style.opacity = "1";
      why.style.transform = `translate(${d.lastX + 14}px, ${d.lastY + 18}px)`;
    };

    const setCol = (d: Drag, el: HTMLElement | null, state: "ok" | "no" | null) => {
      if (d.overCol && d.overCol !== el) d.overCol.removeAttribute("data-drop-over");
      d.overCol = el;
      if (el && state) el.setAttribute("data-drop-over", state);
    };

    /** 多欄：指標在哪一欄（在欄與欄的空隙裡＝最近的那一欄）；離開欄區太遠＝null */
    const columnAt = (x: number, y: number, hit: HTMLElement | null): HTMLElement | null => {
      const direct = hit?.closest<HTMLElement>("[data-drag-col]");
      if (direct && root.contains(direct)) return direct;
      const rr = root.getBoundingClientRect();
      if (x < rr.left - 24 || x > rr.right + 24 || y < rr.top - 24 || y > rr.bottom + 24) return null;
      let best: HTMLElement | null = null;
      let bestDist = Infinity;
      for (const c of root.querySelectorAll<HTMLElement>("[data-drag-col]")) {
        const b = c.getBoundingClientRect();
        const dist = x < b.left ? b.left - x : x > b.right ? x - b.right : 0;
        if (dist < bestDist) {
          best = c;
          bestDist = dist;
        }
      }
      return best;
    };

    const locateColumn = (d: Drag, hit: HTMLElement | null, lines: boolean) => {
      const o = ref.current;
      const els = measure(d);
      const colEl = columnAt(d.lastX, d.lastY, hit);
      if (!colEl) {
        d.place = null;
        d.ok = false;
        setCol(d, null, null);
        hideMarks();
        return;
      }
      const col = colEl.dataset.dragCol ?? "";
      const rest: TreeRow[] = [];
      const slots: Drag["slots"] = [];
      d.rest.forEach((r, i) => {
        const el = els.get(r.id);
        if (!el || !colEl.contains(el)) return;
        rest.push(r);
        slots.push(d.slots[i]);
      });
      const g = gapAt(slots, d.lastY);
      const place: DropPlace = { kind: "slot", depth: 0, parent: null, col, ...anchorOfGap(rest, g) };
      const v = o.resolve?.(d.ids, place) ?? true;
      d.place = place;
      d.ok = v === true;
      if (lines) {
        setCol(d, null, null);
        if (!line) line = overlay("dr-line");
        const b = colEl.getBoundingClientRect();
        line.style.opacity = "1";
        line.style.width = `${b.width}px`;
        line.style.transform = `translate(${b.left}px, ${slots.length ? gapY(slots, g) : b.top + 8}px)`;
        line.classList.toggle("is-no", !d.ok);
      } else {
        if (line) line.style.opacity = "0";
        setCol(d, colEl, d.ok ? "ok" : "no");
      }
      if (v === true) {
        if (why) why.style.opacity = "0";
      } else showWhy(d, v);
    };

    /** 一次一欄：貼邊停一下翻一欄（碰著外部落點、手指不在欄區高度內都不算）；翻完等捲動停了再定位 */
    const flipColumn = (d: Drag) => {
      const r = root.getBoundingClientRect();
      const inY = d.lastY > r.top && d.lastY < r.bottom;
      const dir = !inY || d.overTarget ? 0 : d.lastX > r.right - COL_FLIP_EDGE_PX ? 1 : d.lastX < r.left + COL_FLIP_EDGE_PX ? -1 : 0;
      if (dir !== d.flipDir) {
        d.flipDir = dir;
        d.flipSince = performance.now();
        return;
      }
      if (!dir || performance.now() - d.flipSince < COL_FLIP_MS) return;
      const cols = Array.from(root.querySelectorAll<HTMLElement>("[data-drag-col]"));
      const start = r.left + (parseFloat(getComputedStyle(root).paddingLeft) || 0);
      let at = 0;
      cols.forEach((c, i) => {
        if (Math.abs(c.getBoundingClientRect().left - start) < Math.abs(cols[at].getBoundingClientRect().left - start)) at = i;
      });
      const next = cols[at + dir];
      d.flipSince = performance.now() + 300;
      if (!next) return;
      root.scrollTo({ left: root.scrollLeft + next.getBoundingClientRect().left - start, behavior: "smooth" });
      window.setTimeout(() => {
        if (drag === d) locate(d);
      }, 340);
    };

    /** 多欄的自動捲：欄區貼左右緣橫捲（`flip`＝停一下才翻一欄），指標那一欄貼上下緣直捲 */
    const edgeScrollColumns = (d: Drag) => {
      let moved = false;
      if (ref.current.columns?.flip) flipColumn(d);
      else if (root.scrollWidth > root.clientWidth) {
        const r = root.getBoundingClientRect();
        const step = edgeScrollStep(d.lastX, r.left, r.right, 40, 14);
        if (step) {
          const before = root.scrollLeft;
          root.scrollLeft = before + step;
          moved = root.scrollLeft !== before;
        }
      }
      // 欄自己會捲的（手機）：從欄裡第一張卡往上找捲動容器；空欄退回欄的第一個子元素
      const col = columnAt(d.lastX, d.lastY, document.elementFromPoint(d.lastX, d.lastY) as HTMLElement | null);
      const sc = scrollParent((col?.querySelector<HTMLElement>(ITEM_SEL) ?? col?.firstElementChild ?? null) as HTMLElement | null);
      // 碰著外部落點（手機底部那一排）不捲欄
      if (sc && !root.isSameNode(sc) && !d.overTarget) {
        const r = sc.getBoundingClientRect();
        let step = edgeScrollStep(d.lastY, r.top, r.bottom);
        if (ref.current.columns?.flip) {
          // 手機：手指往底部落點去的路上會經過欄底，要停一下才捲、出了欄就不捲（不然欄被帶著跑）
          const inside = d.lastY >= r.top && d.lastY <= r.bottom;
          step = inside ? edgeScrollStep(d.lastY, r.top, r.bottom, 36, 5) : 0;
          if (!step) d.vSince = 0;
          else if (!d.vSince) d.vSince = performance.now();
          if (performance.now() - d.vSince < COL_VSCROLL_MS) step = 0;
        }
        if (step) {
          const before = sc.scrollTop;
          sc.scrollTop = before + step;
          moved = moved || sc.scrollTop !== before;
        }
      }
      if (moved) locate(d);
    };

    const locate = (d: Drag) => {
      const o = ref.current;
      // 外部落點優先（側欄路線、日期列）；影子卡 pointer-events:none，不擋 elementFromPoint
      const hit = document.elementFromPoint(d.lastX, d.lastY) as HTMLElement | null;
      const tgt = hit?.closest<HTMLElement>("[data-drop-target]") ?? null;
      if (tgt && !root.contains(tgt)) {
        const place: DropPlace = { kind: "target", type: tgt.dataset.dropType ?? "", target: tgt.dataset.dropTarget ?? "" };
        const v = o.resolve?.(d.ids, place) ?? true;
        d.place = place;
        d.ok = v === true;
        setTarget(d, tgt, d.ok ? "ok" : "no");
        setCol(d, null, null);
        if (line) line.style.opacity = "0";
        if (v === true) {
          if (why) why.style.opacity = "0";
        } else showWhy(d, v);
        return;
      }
      setTarget(d, null, null);
      if (o.columns) {
        locateColumn(d, hit, o.columns.lines);
        return;
      }
      const rr = root.getBoundingClientRect();
      const inside = d.lastX >= rr.left - 24 && d.lastX <= rr.right + 24 && d.lastY >= rr.top - 24 && d.lastY <= rr.bottom + 24;
      if (o.slots === false || !inside) {
        d.place = null;
        d.ok = false;
        hideMarks();
        return;
      }
      const dy = (scroller()?.scrollTop ?? 0) - d.scroll0;
      const y = d.lastY + dy;
      const g = gapAt(d.slots, y);
      const indent = o.tree?.indent ?? 0;
      let place: DropPlace;
      let v: Verdict = true;
      if (o.tree) {
        const range = depthRange(d.rest, g);
        const want = depthAt(range, d.startDepth, d.lastX - d.x0, indent);
        const at = (dd: number): DropPlace => ({ kind: "slot", ...treePlace(d.rest, g, dd) });
        const best = o.resolve ? nearestValidDepth(range, want, (dd) => o.resolve!(d.ids, at(dd)) === true) : want;
        place = at(best ?? want);
        if (best === null) v = o.resolve?.(d.ids, place) ?? true;
      } else {
        place = { kind: "slot", depth: 0, parent: null, ...anchorOfGap(d.rest, g) };
        v = o.resolve?.(d.ids, place) ?? true;
      }
      // 放回原位（被拖的列上下鄰居沒變）＝不算移動，線照畫但放開不寫
      d.place = place;
      d.ok = v === true;
      if (!line) {
        line = overlay("dr-line");
        const accent = getComputedStyle(root).getPropertyValue("--dr-accent").trim();
        if (accent) line.style.setProperty("--dr-accent", accent);
      }
      const left = d.baseLeft + (place.kind === "slot" ? place.depth : 0) * indent;
      const width = Math.max(40, rr.right - left - 4);
      line.style.opacity = "1";
      line.style.width = `${width}px`;
      line.style.transform = `translate(${left}px, ${gapY(d.slots, g) - dy}px)`;
      line.classList.toggle("is-no", !d.ok);
      if (v === true) {
        if (why) why.style.opacity = "0";
      } else showWhy(d, v);
      // 樹：停在摺起來的列上 → 展開
      const t = o.tree;
      if (t?.collapsed && t.expand) {
        const over = d.slots.findIndex((s) => y >= s.top && y < s.top + s.height);
        const id = over >= 0 ? d.rest[over].id : null;
        if (id && t.collapsed(id)) {
          if (d.hover?.id !== id) d.hover = { id, since: performance.now() };
          else if (performance.now() - d.hover.since > HOVER_EXPAND_MS) {
            d.hover = null;
            t.expand(id);
          }
        } else d.hover = null;
      }
    };

    const paint = (d: Drag) => {
      const g = d.ghost.querySelector<HTMLElement>(".dr-ghost");
      locate(d);
      if (g) {
        const above = d.overTarget?.dataset.dropGhost === "above" ? d.overTarget : null;
        g.classList.toggle("is-above", !!above);
        if (above) {
          // 退到落點上方：抓住的那一點留在手指的 x，影子卡下緣貼著落點上緣再空 10px（縮放的原點＝抓住的那一點，見 buildGhost）
          const S = 0.55;
          const top0 = parseFloat(g.style.top) || 0;
          const below = top0 + g.offsetHeight - d.y0;
          g.style.translate = `${d.lastX - d.x0}px ${above.getBoundingClientRect().top - 10 - S * below - d.y0}px`;
          g.style.scale = String(S);
        } else {
          // 位移與縮放分開寫：位移跟手不吃過場、縮放（碰到外部落點）才有過場
          g.style.translate = `${d.lastX - d.x0}px ${d.lastY - d.y0}px`;
          g.style.scale = d.overTarget ? "0.3" : "1.02";
        }
      }
    };

    /** 落點列（data-drop-rail）太長：手指停在兩端就往那邊捲 */
    const scrollRail = (d: Drag) => {
      const hit = document.elementFromPoint(d.lastX, d.lastY) as HTMLElement | null;
      const rail = hit?.closest<HTMLElement>("[data-drop-rail]");
      if (!rail || rail.scrollWidth <= rail.clientWidth) return;
      const r = rail.getBoundingClientRect();
      const step = edgeScrollStep(d.lastX, r.left, r.right, 44, 4);
      if (!step) return;
      const before = rail.scrollLeft;
      rail.scrollLeft = before + step;
      if (rail.scrollLeft !== before) paint(d);
    };

    const tick = () => {
      if (!drag) return;
      const sc = ref.current.columns ? null : scroller();
      if (ref.current.columns && drag.moved) edgeScrollColumns(drag);
      if (drag.moved) scrollRail(drag);
      if (sc && drag.moved) {
        const r = sc.getBoundingClientRect();
        if (drag.lastX >= r.left && drag.lastX <= r.right) {
          const step = edgeScrollStep(drag.lastY, r.top, r.bottom);
          if (step) {
            const before = sc.scrollTop;
            sc.scrollTop = before + step;
            if (sc.scrollTop !== before) locate(drag);
          }
        }
      }
      if (drag.moved && drag.hover) locate(drag);
      drag.raf = requestAnimationFrame(tick);
    };

    // ───── 起拖、結束 ─────
    const lift = (p: { pointerId: number; touch: boolean; id: string; el: HTMLElement; x0: number; y0: number }) => {
      const o = ref.current;
      const ids = [...(o.dragIds?.(p.id) ?? [p.id])];
      if (!ids.includes(p.id)) ids.unshift(p.id);
      const els = ids.map(elOf).filter((e): e is HTMLElement => !!e);
      const carried = (o.tree?.carried?.(ids) ?? []).map(elOf).filter((e): e is HTMLElement => !!e);
      const startDepth = o.items.find((r) => r.id === p.id)?.depth ?? 0;
      const d: Drag = {
        pointerId: p.pointerId,
        touch: p.touch,
        ids,
        grab: p.id,
        els,
        carriedEls: carried,
        rest: [],
        slots: [],
        baseLeft: 0,
        startDepth,
        x0: p.x0,
        y0: p.y0,
        lastX: p.x0,
        lastY: p.y0,
        scroll0: 0,
        moved: false,
        place: null,
        ok: false,
        overTarget: null,
        overCol: null,
        hover: null,
        flipDir: 0,
        flipSince: 0,
        vSince: 0,
        ghost: buildGhost(p.el, ids.length, { x: p.x0, y: p.y0 }),
        raf: 0,
      };
      measure(d);
      for (const e of els) e.classList.add("dr-source");
      for (const e of carried) e.classList.add("dr-carried");
      root.classList.add("dr-active");
      document.documentElement.classList.add("dr-dragging");
      if (o.columns) root.style.scrollSnapType = "none";
      try {
        root.setPointerCapture(p.pointerId);
      } catch {
        /* 指標已失效：照常用冒泡的事件 */
      }
      remeasure.current = () => {
        if (drag) {
          measure(drag);
          locate(drag);
        }
      };
      drag = d;
      o.onDragStart?.(ids, p.id);
      paint(d);
      d.raf = requestAnimationFrame(tick);
    };

    const teardown = (d: Drag) => {
      cancelAnimationFrame(d.raf);
      remeasure.current = null;
      d.ghost.remove();
      setTarget(d, null, null);
      setCol(d, null, null);
      hideMarks();
      if (ref.current.columns) root.style.scrollSnapType = "";
      root.classList.remove("dr-active");
      document.documentElement.classList.remove("dr-dragging");
      try {
        root.releasePointerCapture(d.pointerId);
      } catch {
        /* 已經放掉了 */
      }
      ref.current.onDragEnd?.();
    };

    const clearSource = (d: Drag) => {
      for (const e of d.els) e.classList.remove("dr-source");
      for (const e of d.carriedEls) e.classList.remove("dr-carried");
    };

    const finishDrag = (commit: boolean) => {
      const d = drag;
      if (!d) return;
      drag = null;
      teardown(d);
      swallowClickUntil = performance.now() + 350;
      if (!d.moved) {
        // 觸控長按原地放開＝選起來
        clearSource(d);
        if (commit && d.touch) ref.current.onPressRelease?.(d.grab);
        return;
      }
      if (!commit || !d.place || !d.ok || isNoop(d)) {
        clearSource(d);
        return;
      }
      if (settle.current) {
        window.clearTimeout(settle.current.timer);
        settle.current.clear();
      }
      settle.current = {
        clear: () => clearSource(d),
        timer: window.setTimeout(() => {
          if (!settle.current) return;
          settle.current = null;
          clearSource(d);
        }, SETTLE_TIMEOUT_MS),
      };
      ref.current.onDrop(d.ids, d.place);
    };

    /** 多欄：還在原欄、上下鄰居沒變 */
    const isColumnNoop = (d: Drag, p: Extract<DropPlace, { kind: "slot" }>): boolean => {
      const colOf = (id: string) => elOf(id)?.closest<HTMLElement>("[data-drag-col]")?.dataset.dragCol;
      if (d.ids.some((id) => colOf(id) !== p.col)) return false;
      // 只換欄的看板（lines:false）欄內沒有順序：還在原欄就是沒動（不然原列要等 1.2 秒逾時才退回淡態）
      if (!ref.current.columns?.lines) return true;
      const inCol = ref.current.items.filter((r) => colOf(r.id) === p.col).map((r) => r.id);
      return isColumnGapNoop(inCol, d.ids, p);
    };

    /** 放回原位（同父、上下鄰居跟拖起前一樣）＝不寫 */
    const isNoop = (d: Drag): boolean => {
      const p = d.place;
      if (!p || p.kind !== "slot") return false;
      if (ref.current.columns) return isColumnNoop(d, p);
      const all = ref.current.items;
      const first = all.findIndex((r) => r.id === d.ids[0]);
      const last = all.findIndex((r) => r.id === d.ids[d.ids.length - 1]);
      if (first < 0 || last < 0 || d.ids.length !== last - first + 1) return false;
      const carried = new Set(ref.current.tree?.carried?.(d.ids) ?? []);
      let j = last + 1;
      while (j < all.length && carried.has(all[j].id)) j++;
      const prevSib = (() => {
        for (let k = first - 1; k >= 0; k--) {
          const r = all[k];
          if ((r.depth ?? 0) < d.startDepth) return null;
          if ((r.depth ?? 0) === d.startDepth) return r.id;
        }
        return null;
      })();
      const nextSib = (() => {
        for (let k = j; k < all.length; k++) {
          const r = all[k];
          if ((r.depth ?? 0) < d.startDepth) return null;
          if ((r.depth ?? 0) === d.startDepth) return r.id;
        }
        return null;
      })();
      return p.depth === d.startDepth && p.after === prevSib && p.before === nextSib;
    };

    // ───── 滑動手勢 ─────
    const startSwipe = (p: Press, dx: number): boolean => {
      const sw = ref.current.swipe;
      const act = dx > 0 ? sw?.right : sw?.left;
      if (!act || (act.enabled && !act.enabled(p.id))) return false;
      const el = p.el;
      const parent = el.parentElement;
      if (!parent) return false;
      const under = document.createElement("div");
      under.className = `dr-swipe-under is-${dx > 0 ? "right" : "left"} tone-${act.tone ?? "ink"}`;
      under.setAttribute("aria-hidden", "true");
      under.textContent = act.label;
      // 先把父節點設成定位脈絡再量 offsetTop／Left（反過來量到的是相對更外層的位置，底色會畫到別處）
      const parentPos = getComputedStyle(parent).position === "static" ? parent.style.position : null;
      if (parentPos !== null) parent.style.position = "relative";
      Object.assign(under.style, {
        top: `${el.offsetTop}px`,
        left: `${el.offsetLeft}px`,
        width: `${el.offsetWidth}px`,
        height: `${el.offsetHeight}px`,
      });
      parent.insertBefore(under, el);
      el.classList.add("dr-swiping");
      const paper = paperOf(el);
      const restore = paper ? makeOpaque(paper.el, paper.el, paper.pseudo) : () => undefined;
      swipe = { pointerId: p.pointerId, id: p.id, el, x0: p.x0, dx: 0, width: el.offsetWidth, under, parentPos, restore };
      return true;
    };
    const finishSwipe = (commit: boolean) => {
      const s = swipe;
      if (!s) return;
      swipe = null;
      swallowClickUntil = performance.now() + 350;
      const done = commit && Math.abs(s.dx) >= s.width * SWIPE_COMMIT_RATIO;
      s.el.classList.remove("dr-swiping");
      s.el.style.transform = "";
      window.setTimeout(() => {
        s.under.remove();
        s.restore();
        if (s.parentPos !== null && s.el.parentElement) s.el.parentElement.style.position = s.parentPos;
      }, 220);
      if (done) {
        const act = s.dx > 0 ? ref.current.swipe?.right : ref.current.swipe?.left;
        act?.run(s.id);
      }
    };

    // ───── 事件 ─────
    const onDown = (e: PointerEvent) => {
      if (press || drag || swipe || !e.isPrimary || e.button !== 0) return;
      const t = e.target as HTMLElement;
      if (t.closest(INTERACTIVE_SEL)) return;
      const el = t.closest<HTMLElement>(ITEM_SEL);
      if (!el || !root.contains(el)) return;
      const touch = e.pointerType !== "mouse";
      if (!touch && (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey)) return; // 多選的點
      const id = el.dataset.dragId!;
      const p: Press = { pointerId: e.pointerId, touch, id, el, x0: e.clientX, y0: e.clientY, timer: 0, lifted: false, refused: false };
      if (touch) {
        el.classList.add("dr-pressing");
        p.timer = window.setTimeout(() => {
          if (press !== p) return;
          el.classList.remove("dr-pressing");
          const v = verdictDrag(id);
          if (v === true) {
            press = null;
            lift(p);
          } else {
            // 拖不動的列：長按照樣能選起來（放開時），手指一動才抖一下說原因
            p.lifted = true;
            p.refused = true;
          }
        }, LIFT_DELAY_MS);
      }
      press = p;
    };

    const onMove = (e: PointerEvent) => {
      if (swipe && e.pointerId === swipe.pointerId) {
        const dx = e.clientX - swipe.x0;
        // 只往一開始那一側滑；另一側夾回 0
        const side = swipe.under.classList.contains("is-right") ? 1 : -1;
        swipe.dx = side > 0 ? Math.max(0, dx) : Math.min(0, dx);
        swipe.el.style.transform = `translateX(${swipe.dx}px)`;
        swipe.under.classList.toggle("is-armed", Math.abs(swipe.dx) >= swipe.width * SWIPE_COMMIT_RATIO);
        return;
      }
      if (press && e.pointerId === press.pointerId) {
        const dx = e.clientX - press.x0;
        const dy = e.clientY - press.y0;
        const dist = Math.hypot(dx, dy);
        if (press.touch) {
          if (press.refused) {
            if (dist > TOUCH_SLOP_PX) {
              nudge(press.el);
              const v = verdictDrag(press.id);
              if (v !== true) ref.current.onRefuse?.(press.id, v);
              endPress();
            }
            return;
          }
          if (!press.lifted && ref.current.swipe) {
            if (isSwipe(dx, dy)) {
              const p = press;
              endPress();
              if (startSwipe(p, dx)) return;
            } else if (dist > TOUCH_SLOP_PX && Math.abs(dx) > Math.abs(dy) * 1.5) {
              // 橫向為主、還沒滿滑動門檻（8～12px 之間）：不當捲動、也不再等長按，繼續看它會不會成為滑動
              //（AVD 實測 F-1：慢滑的第一筆超過 8px 常落在 9～11px，原本直接被當捲動、滑動起不來）
              window.clearTimeout(press.timer);
              press.el.classList.remove("dr-pressing");
              return;
            }
          }
          if (dist > TOUCH_SLOP_PX) endPress(); // 捲動
          return;
        }
        if (dist > MOUSE_SLOP_PX) {
          const p = press;
          endPress();
          const v = verdictDrag(p.id);
          if (v === true) {
            lift(p);
            if (drag) {
              drag.moved = true;
              drag.lastX = e.clientX;
              drag.lastY = e.clientY;
              paint(drag);
            }
          } else {
            nudge(p.el);
            ref.current.onRefuse?.(p.id, v);
          }
        }
        return;
      }
      if (drag && e.pointerId === drag.pointerId) {
        drag.lastX = e.clientX;
        drag.lastY = e.clientY;
        if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) > TOUCH_SLOP_PX) drag.moved = true;
        if (drag.moved) paint(drag);
      }
    };

    const onUp = (e: PointerEvent) => {
      if (swipe && e.pointerId === swipe.pointerId) return finishSwipe(true);
      if (press && e.pointerId === press.pointerId) {
        const p = press;
        endPress();
        if (p.touch && p.lifted) {
          swallowClickUntil = performance.now() + 350;
          ref.current.onPressRelease?.(p.id);
        }
      }
      if (drag && e.pointerId === drag.pointerId) finishDrag(true);
    };

    const onCancel = (e: PointerEvent) => {
      if (swipe && e.pointerId === swipe.pointerId) return finishSwipe(false);
      if (press && e.pointerId === press.pointerId) endPress();
      if (drag && e.pointerId === drag.pointerId) finishDrag(false);
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && drag) {
        e.preventDefault();
        e.stopPropagation();
        finishDrag(false);
      }
    };
    const onBlur = () => {
      endPress();
      finishDrag(false);
      finishSwipe(false);
    };
    // 浮起之後擋捲動（滑動時也擋）；沒浮起時什麼都不做（監聽要一直在，見檔頭）
    const onTouchMove = (e: TouchEvent) => {
      if ((drag || swipe || press?.lifted) && e.cancelable) e.preventDefault();
    };
    // 長按、拖曳中不要跳系統選單
    const onContextMenu = (e: Event) => {
      if (press?.touch || drag || swipe) e.preventDefault();
    };
    const onClick = (e: MouseEvent) => {
      if (performance.now() < swallowClickUntil) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    root.addEventListener("pointerdown", onDown);
    root.addEventListener("pointermove", onMove);
    root.addEventListener("pointerup", onUp);
    root.addEventListener("pointercancel", onCancel);
    root.addEventListener("touchmove", onTouchMove, { passive: false });
    root.addEventListener("contextmenu", onContextMenu);
    root.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
    if (ref.current.swipe) root.classList.add("dr-swipeable");
    return () => {
      endPress();
      finishDrag(false);
      finishSwipe(false);
      line?.remove();
      why?.remove();
      root.classList.remove("dr-swipeable");
      root.removeEventListener("pointerdown", onDown);
      root.removeEventListener("pointermove", onMove);
      root.removeEventListener("pointerup", onUp);
      root.removeEventListener("pointercancel", onCancel);
      root.removeEventListener("touchmove", onTouchMove);
      root.removeEventListener("contextmenu", onContextMenu);
      root.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [root, disabled]);
}
