/**
 * 時刻表⑤「方眼」的純函式（⑤ 契約 0-4、0-5、§3.1；〈原型定案〉2、3、4、8 改過的版本；甲席）。
 *
 * - 只准 import `./timetable.ts`（純度牙齒，§4-11）；全部純函式、不讀時鐘——`now` 一律由呼叫端給。
 * - 時間一律毫秒。窗＝`dayWindow(dayKey, h)` 換成毫秒後，用 `gridWindow(窗, rowHours)` 包成 `GridWindow`。
 * - 列長 `rowMs`＝`rowHours`（桌機 1、手機自動 1 或 2，〈原型定案〉4）小時；格長＝`cellMin` 分，格從窗頭起連續編號（跨列不重來）。
 * - 「塊」的輸入是 `segmentsOfDay(spans, 窗, now)` 的 `AxisItem[]`（塊已切進窗、夾到 now；只有 ≥ 1 分的空白才是 gap）。
 */
import {
  MIN,
  currentRunning,
  planDepart,
  planFill,
  planRestart,
  type AxisItem,
  type CoverSummary,
  type Span,
  type WritePlan,
} from "./timetable.ts";

const HOUR = 60 * MIN;
const clampN = (x: number, a: number, b: number): number => Math.max(a, Math.min(b, x));

/* ───────── 格子大小（D-時-93） ───────── */

export type CellMin = 5 | 10 | 15 | 30;
export const CELL_OPTIONS: readonly CellMin[] = [5, 10, 15, 30];
export const DEFAULT_CELL_MIN: CellMin = 10;

/** 本機鍵的值 → 格子大小；不認得（null、空字串、別的數字）⇒ DEFAULT_CELL_MIN */
export function parseCellMin(raw: string | null): CellMin {
  if (raw === null) return DEFAULT_CELL_MIN;
  const n = Number(raw.trim());
  return (CELL_OPTIONS as readonly number[]).includes(n) ? (n as CellMin) : DEFAULT_CELL_MIN;
}

/* ───────── 窗與列（〈原型定案〉4） ───────── */

/**
 * 一張方眼紙的窗。`rows`＝窗長 / `rowMs` 向上取整（一列 1 小時＝24、2 小時＝12；DST 日長不是 24h 時最後一列照 `end` 夾）。
 * 契約 §3.1 只列 `start/end/rows`；多帶 `rowMs`（列長，毫秒）——`rowRuns` 的簽名沒有列長參數，列長要跟著窗走。
 */
export interface GridWindow {
  start: number;
  end: number;
  rows: number;
  rowMs: number;
}

export type RowHours = 1 | 2;
/** 手機「自動」的門檻：一列 1 小時算出來的列高不到這麼多 px ⇒ 改一列 2 小時 */
export const MIN_ROW_PX = 16;

/** 窗（毫秒）＋一列幾小時 ⇒ GridWindow */
export function gridWindow(w: { start: number; end: number }, rowHours: RowHours = 1): GridWindow {
  const rowMs = rowHours * HOUR;
  return { start: w.start, end: w.end, rows: Math.max(1, Math.ceil((w.end - w.start) / rowMs)), rowMs };
}

/**
 * 〈原型定案〉4：桌機永遠一列 1 小時；手機 `availPx`（格子區能給 24 列的總高度，px）÷ 24 不到 16px ⇒ 一列 2 小時。
 */
export function rowHoursFor(availPx: number, shell: "desktop" | "mobile"): RowHours {
  if (shell === "desktop") return 1;
  return availPx / 24 < MIN_ROW_PX ? 2 : 1;
}

/* ───────── 色帶（D-時-94、105；〈原型定案〉2、3） ───────── */

/** 一塊在一列的一段。x0／x1＝0–1 的**列內**比例（14:07 在 14:00 那一列＝7/60） */
export interface RowRun {
  row: number;
  x0: number;
  x1: number;
  blockId: string;
  categoryId: string;
  /** 這一塊在這一天開頭的那一列（從前一天續過來的沒有 head） */
  head: boolean;
  /** 左邊接著上一列（或前一天）：左側不畫圓角 */
  contPrev: boolean;
  /** 右邊接到下一列（或隔天）：右側不畫圓角 */
  contNext: boolean;
  running: boolean;
  /** 整塊不到 1 分（碎塊；UI 最少畫 2px） */
  tiny: boolean;
}

/**
 * `segmentsOfDay` 的 block 項切成「每列一段」，依 items 的順序、同一塊的段由上而下。gap 項略過。
 * 運行中的塊在 items 裡已經畫到 now；零長度塊（`zero`）在它那一列出一段 x0＝x1。
 */
export function rowRuns(items: readonly AxisItem[], w: GridWindow, now: number): RowRun[] {
  const out: RowRun[] = [];
  const L = w.rowMs;
  for (const it of items) {
    if (it.kind !== "block") continue;
    const s = clampN(it.from, w.start, w.end);
    const e = clampN(it.to, s, w.end);
    if (s >= w.end || (e <= w.start && !it.zero)) continue;
    const r0 = Math.min(w.rows - 1, Math.floor((s - w.start) / L));
    const r1 = Math.min(w.rows - 1, Math.max(r0, Math.ceil((e - w.start) / L) - 1));
    const whole = (it.span.end ?? now) - it.span.start;
    for (let r = r0; r <= r1; r++) {
      const rs = w.start + r * L;
      out.push({
        row: r,
        x0: clampN((s - rs) / L, 0, 1),
        x1: clampN((e - rs) / L, 0, 1),
        blockId: it.span.id,
        categoryId: it.span.categoryId,
        head: r === r0 && !it.contFromPrev,
        contPrev: r > r0 || it.contFromPrev,
        contNext: r < r1 || it.contToNext,
        running: it.running,
        tiny: whole < MIN,
      });
    }
  }
  return out;
}

/* ───────── 格與選區（0-4） ───────── */

export interface Range {
  start: number;
  end: number;
}

export function cellCount(w: GridWindow, cellMin: CellMin): number {
  return Math.max(1, Math.ceil((w.end - w.start) / (cellMin * MIN)));
}

/** t 落在第幾格（夾在 [0, cellCount − 1]） */
export function cellIndexAt(w: GridWindow, cellMin: CellMin, t: number): number {
  return clampN(Math.floor((t - w.start) / (cellMin * MIN)), 0, cellCount(w, cellMin) - 1);
}

/** 兩格（不論先後）⇒ 從小的那格開頭到大的那格結尾（尾夾在窗尾） */
export function cellRange(w: GridWindow, cellMin: CellMin, i: number, j: number): Range {
  const a = Math.min(i, j);
  const b = Math.max(i, j);
  const c = cellMin * MIN;
  return { start: w.start + a * c, end: Math.min(w.end, w.start + (b + 1) * c) };
}

/** 尾夾到 now、頭尾夾在窗內；夾完不到 1 分 ⇒ null（整段在未來也是 null） */
export function clampSel(r: Range, w: GridWindow, now: number): Range | null {
  const start = Math.max(r.start, w.start);
  const end = Math.min(r.end, w.end, now);
  return end - start < MIN ? null : { start, end };
}

/** [a, b) 裡被塊佔掉的段（合併、由早到晚；零長度塊不佔） */
function occupied(a: number, b: number, items: readonly AxisItem[]): [number, number][] {
  const iv: [number, number][] = [];
  for (const it of items) {
    if (it.kind !== "block" || it.zero) continue;
    const s = Math.max(a, it.from);
    const e = Math.min(b, it.to);
    if (e > s) iv.push([s, e]);
  }
  iv.sort((p, q) => p[0] - q[0]);
  const out: [number, number][] = [];
  for (const p of iv) {
    const last = out[out.length - 1];
    if (last && p[0] <= last[1]) last[1] = Math.max(last[1], p[1]);
    else out.push([p[0], p[1]]);
  }
  return out;
}

/** [a, b) 裡 ≥ 1 分的空白（〈原型定案〉8：同一分鐘連換留下的秒數縫不算） */
function blanksIn(a: number, b: number, items: readonly AxisItem[]): [number, number][] {
  const out: [number, number][] = [];
  let cur = a;
  for (const [s, e] of occupied(a, b, items)) {
    if (s - cur >= MIN) out.push([cur, s]);
    cur = Math.max(cur, e);
  }
  if (b - cur >= MIN) out.push([cur, b]);
  return out;
}

/**
 * D-時-97：頭（尾）格裡同時有塊和 ≥ 1 分的空白 ⇒ 頭縮到頭格內第一段空白的開始（尾縮到尾格內最後一段空白的結束）；
 * 整格被塊佔滿（選區從一塊中間開始、跨過整格）＝照蓋、不縮。縮完不到 1 分 ⇒ 回原 range。
 * 前提：`r` 是 `cellRange` → `clampSel` 的結果（`r.start` 落在格邊界上；`r.end` 可能被夾到 now）——頭格＝`[r.start, r.start + cellMs)`，
 * 尾格＝從 `r.start` 起算、含 `r.end − 1` 的那一格（契約簽名沒有窗，格邊界以 `r.start` 為準）。
 */
export function snapEdges(r: Range, items: readonly AxisItem[], cellMs: number): Range {
  let start = r.start;
  let end = r.end;
  const headEnd = Math.min(r.end, r.start + cellMs);
  if (occupied(r.start, headEnd, items).length) {
    const bl = blanksIn(r.start, headEnd, items);
    if (bl.length) start = bl[0][0];
  }
  const tailStart = r.start + Math.max(0, Math.floor((r.end - 1 - r.start) / cellMs)) * cellMs;
  if (occupied(tailStart, r.end, items).length) {
    const bl = blanksIn(tailStart, r.end, items);
    if (bl.length) end = bl[bl.length - 1][1];
  }
  if (end - start < MIN) return { start: r.start, end: r.end };
  return { start, end };
}

/** D-時-99：有運行中的班、而且選區尾在 now 的 30 秒內 ⇒ "live"（從選區頭換車、繼續跑）；其餘 "fill" */
export function paintModeOf(r: Range, hasRunning: boolean, now: number): "fill" | "live" {
  return hasRunning && r.end >= now - 30_000 ? "live" : "fill";
}

/* ───────── 寫入的 plan（0-5） ───────── */

/**
 * fill 模式＝`planFill`，再把新塊（inserts 的最後一筆，`planFill` 保證）的 ack 改成 true（〈原型定案〉5／D-時-107：
 * 使用者親手指定了起訖＝確認過）。inherit 切出來的段照抄原塊的 ack，不動；`planFill` 本身不改。
 */
export function planPaintFill(
  spans: readonly Span[],
  input: { categoryId: string; start: number; end: number; now: number },
): WritePlan {
  const plan = planFill(spans, input);
  const last = plan.inserts.length - 1;
  plan.inserts[last] = { ...plan.inserts[last], ack: true };
  return plan;
}

/**
 * live 模式（運行中那班 R、開始 r、選區頭 a＝`min(at, now)`、分類 C）：
 * - C ＝ R 的分類：a < r ⇒ `planRestart`（R 保留 id、連結、預估，提早出發）；a ≥ r ⇒ null（本來就是，不用寫）。
 * - C ≠ R 的分類：`planDepart(at = a)`（a > r ⇒ R 結束於 a；a ≤ r ⇒ R 整班被收掉）。
 * - 沒有運行中的班 ⇒ D-時-99「補到現在為止（已結束的一塊）」：`planPaintFill(a, now)`（新塊 ack＝true）。
 *   會走到這裡＝store 還以為有班在跑、資料庫裡已經到站（另一台剛按到站、同步寫進來了、store 還沒 refresh）；
 *   不能從選區頭發一班新車，那等於把另一台剛結束的運行中又復活成另一班。
 * 刻意不走 `tapCategory` 的兩道關（契約 0-5）。
 */
export function planPaintLive(
  spans: readonly Span[],
  input: { categoryId: string; at: number; now: number },
): WritePlan | null {
  const a = Math.min(input.at, input.now);
  const R = currentRunning(spans);
  if (!R) return planPaintFill(spans, { categoryId: input.categoryId, start: a, end: input.now, now: input.now });
  if (R.categoryId === input.categoryId) {
    if (a < R.start) return planRestart(spans, { id: R.id, at: a, now: input.now });
    return null;
  }
  return planDepart(spans, { categoryId: input.categoryId, at: a, now: input.now });
}

/* ───────── 塗完之後的 toast（store.paint 用；沙盒 F2、F3） ───────── */

/**
 * 這次塗色是哪一種（決定 toast 主訊息、副標、給不給撤回）：
 * - `same`：live 同分類、選區頭不早於它＝什麼都沒寫（repository 回空快照）；
 * - `restart`：live 同分類、選區頭比它早＝運行中那班提早出發——回來的主角是**既有的那一列**（不在這次新增的列裡）。
 *   用「主角是不是新增的」判斷、不用 store 寫之前看到的 running：store 的 running 可能還沒跟上另一台剛換的車（施工〈未解〉3）；
 * - `fillToNow`：live 但資料庫裡已經沒有運行中的班 ⇒ repository 補到現在（回來的那塊已結束）；
 * - `live`：live 換車；`fill`：補上。
 */
export type PaintKind = "same" | "restart" | "fillToNow" | "live" | "fill";

export function paintKindOf(input: {
  mode: "fill" | "live";
  /** repository 回來的主角是不是這次新增的列（撤回快照的 inserted 裡有它） */
  blockInserted: boolean;
  /** 主角已結束（ended_at 不是 null） */
  blockEnded: boolean;
  /** 撤回快照有沒有東西（沒有＝什麼都沒寫） */
  wrote: boolean;
}): PaintKind {
  if (!input.wrote) return "same";
  if (input.mode === "fill") return "fill";
  if (!input.blockInserted) return "restart";
  if (input.blockEnded) return "fillToNow";
  return "live";
}

/**
 * 給不給「撤回」（沙盒 F3＝契約 §9-3 的降級）：`restart` 不給——撤回得把運行中那班的 `started_at` 寫回去，
 * 那一格的戳記變成最新；另一台同時離線切開那班時，逐欄 LWW 會拼出零長度塊、撤回救回的塊又被整理刪掉，兩台都沒有提示。
 * 跟 RestartPanel 改出發時間沒有撤回一致。`same` 沒寫、沒東西可撤。其餘照舊。
 */
export function paintUndoable(kind: PaintKind): boolean {
  return kind === "fill" || kind === "fillToNow" || kind === "live";
}

/**
 * toast 副標要講的蓋掉數（跟塗色列的讀數同一個口徑；沙盒 F2）：讀數在 live 時一律把運行中那班當 exceptId，
 * 它的結局另一行講。`live` 換車時 summary 會把它算進去——選區頭晚於它的開始＝它到站（算進切短）、
 * 不晚於＝整班收掉（算進蓋掉）——這裡扣回來。`restart` 的 summary 本來就不算它（repository 用 exceptId）。
 */
export function paintCoverOf(kind: PaintKind, sum: CoverSummary, runningStart: number | null, at: number): CoverSummary {
  if (kind !== "live" || runningStart === null) return sum;
  if (runningStart < at) return sum.shortened > 0 ? { ...sum, shortened: sum.shortened - 1 } : sum;
  return sum.removed > 0 ? { ...sum, removed: sum.removed - 1 } : sum;
}

/* ───────── 點一格（0-4、D-時-95） ───────── */

type BlockItem = Extract<AxisItem, { kind: "block" }>;
type GapItem = Extract<AxisItem, { kind: "gap" }>;

/**
 * 點一格：格內有塊 ⇒ 與這一格重疊最多的那塊（同分取較晚開始的）；碎塊（整塊不到 1 分）與零長度塊只有在格內沒有別的塊時才點得到。
 * 格內沒有塊 ⇒ 與這一格重疊最多的 gap 項（整段空白）；都沒有（未來、或不到 1 分的縫）⇒ null。
 * `cell` 由呼叫端給（未來的部分可以先夾到 now；items 本來就只到 now）。
 */
export function pickCellBlock(items: readonly AxisItem[], cell: Range): BlockItem | GapItem | null {
  const inCell: { it: BlockItem; ov: number; tiny: boolean }[] = [];
  for (const it of items) {
    if (it.kind !== "block") continue;
    const ov = Math.max(0, Math.min(cell.end, it.to) - Math.max(cell.start, it.from));
    const hit = ov > 0 || (it.zero && it.from >= cell.start && it.from < cell.end);
    if (!hit) continue;
    const whole = (it.span.end ?? it.to) - it.span.start;
    inCell.push({ it, ov, tiny: it.zero || whole < MIN });
  }
  const pool = inCell.some((x) => !x.tiny) ? inCell.filter((x) => !x.tiny) : inCell;
  let best: { it: BlockItem; ov: number } | null = null;
  for (const x of pool) {
    if (!best || x.ov > best.ov || (x.ov === best.ov && x.it.span.start > best.it.span.start)) best = x;
  }
  if (best) return best.it;
  let gap: GapItem | null = null;
  let gapOv = 0;
  for (const it of items) {
    if (it.kind !== "gap") continue;
    const ov = Math.min(cell.end, it.to) - Math.max(cell.start, it.from);
    if (ov > gapOv) {
      gap = it;
      gapOv = ov;
    }
  }
  return gap;
}

/* ───────── 撤回的快照（0-5；repository 的 paint／undoPaint 用） ───────── */

/** 撤回時寫回的三欄（守門比的是 `updated_at`，不是這三欄；〈原型定案〉6） */
export interface PaintCells {
  started_at: string;
  ended_at: string | null;
  deleted_at: string | null;
}

/**
 * 一次塗色的撤回快照：
 * - `inserted`：這次新增的列（含 inherit 切出來的後段）與寫完讀回的 `updated_at`；
 * - `touched`：這次 patch／delete 而且 `updated_at` 真的變了的列——寫之前的三欄＋寫完讀回的 `updated_at`。
 */
export interface PaintUndo {
  inserted: { id: string; updated_at: string }[];
  touched: { id: string; before: PaintCells; afterUpdatedAt: string }[];
}

/** 撤回快照要看的一列（`TimeBlockRow` 的子集） */
export interface PaintRow extends PaintCells {
  updated_at: string;
}

const CELL_KEYS = ["started_at", "ended_at", "deleted_at"] as const;
const cellsOf = (r: PaintRow): PaintCells => ({ started_at: r.started_at, ended_at: r.ended_at, deleted_at: r.deleted_at });
const cellsDiffer = (a: PaintCells, b: PaintCells): boolean => CELL_KEYS.some((k) => a[k] !== b[k]);

/**
 * 寫完之後組撤回快照（0-5；sqlite 與 memory 共用，不各寫一份）：
 * - `before`＝寫之前的列（plan 的 patch／delete 對象一定在裡面）；`after`＝寫完讀回來的列；`insertedIds`＝`applyPlan` 回的 id。
 * - `touched`＝plan 的 patch／delete 對象裡**真的被寫了**的列：讀回的 `updated_at` 變了（sqlite 對值相同的 patch 整筆跳過、
 *   `updated_at` 不動 ⇒ 不記）。保險：三欄變了也算（同一毫秒內連寫兩次時 `updated_at` 可能剛好一樣）。
 * - `inserted`＝新增的列（含 inherit 切出來的後段）與讀回的 `updated_at`。
 */
export function buildPaintUndo(
  plan: WritePlan,
  before: Readonly<Record<string, PaintRow | undefined>>,
  after: Readonly<Record<string, PaintRow | null | undefined>>,
  insertedIds: readonly string[],
): PaintUndo {
  const ins = new Set(insertedIds);
  const ids: string[] = [];
  for (const id of [...plan.patches.map((p) => p.id), ...plan.deletes]) if (!ids.includes(id) && !ins.has(id)) ids.push(id);
  const touched: PaintUndo["touched"] = [];
  for (const id of ids) {
    const b = before[id];
    const a = after[id];
    if (!b || !a) continue;
    if (a.updated_at === b.updated_at && !cellsDiffer(a, b)) continue;
    touched.push({ id, before: cellsOf(b), afterUpdatedAt: a.updated_at });
  }
  const inserted: PaintUndo["inserted"] = [];
  for (const id of insertedIds) {
    const a = after[id];
    if (a && !inserted.some((x) => x.id === id)) inserted.push({ id, updated_at: a.updated_at });
  }
  return { inserted, touched };
}

/** 撤回要寫的一筆：`delete`＝軟刪除這次新增的列；`set`＝把這幾欄寫回塗之前（只帶真的不同的欄） */
export type UndoPaintWrite = { id: string; op: "delete" } | { id: string; op: "set"; cols: Partial<PaintCells> };

/**
 * 撤回的守門與寫入計畫（0-5、〈原型定案〉6）。`current`＝每個 `inserted`／`touched` id 的現況（**含已刪除的列**）。
 * - 守門比 `updated_at`：`inserted` 要在、未刪、`updated_at` 等於記下的值；`touched` 要在、`updated_at` 等於 `afterUpdatedAt`。
 *   任何一列不符（另一台改過、整理動過）⇒ null（整批不寫）。
 * - 符合 ⇒ `inserted` 軟刪除；`touched` 只寫跟 `before` 不同的欄（逐欄 LWW）；三欄都一樣的列不寫。
 * 不跑 `planCover`：撤回不是「最新寫入」，是把那一刻還原（契約 0-5）。
 */
export function planUndoPaint(
  undo: PaintUndo,
  current: Readonly<Record<string, PaintRow | null | undefined>>,
): UndoPaintWrite[] | null {
  for (const x of undo.inserted) {
    const c = current[x.id];
    if (!c || c.deleted_at !== null || c.updated_at !== x.updated_at) return null;
  }
  for (const x of undo.touched) {
    const c = current[x.id];
    if (!c || c.updated_at !== x.afterUpdatedAt) return null;
  }
  const out: UndoPaintWrite[] = undo.inserted.map((x) => ({ id: x.id, op: "delete" as const }));
  for (const x of undo.touched) {
    const c = current[x.id]!;
    const cols: Partial<PaintCells> = {};
    for (const k of CELL_KEYS) if (c[k] !== x.before[k]) (cols as Record<string, string | null>)[k] = x.before[k];
    if (Object.keys(cols).length) out.push({ id: x.id, op: "set", cols });
  }
  return out;
}
