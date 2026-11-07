/**
 * 走行圖的資料與版面（第五本第三梯 ③-2；D-主-551～558；視覺真相 `prototypes/車庫走行圖.html`）——純函式，零 IO。
 *
 * 資料只有兩層（幹線→路線），不是任意的圖，所以版面是固定公式、不必做圖佈局：
 *   - 寬版 `layoutNet`：左緣本線從「私鐵手帳」往下，幹線橫跑，路線從幹線上下斜著分出去再平行跑。
 *     同一側越早分出去的離幹線越遠、水平段都從同一個 x 開始，斜段彼此平行，永遠不會交叉。
 *   - 窄版 `layoutTree`（手機、窄視窗）：幹線直立，路線往右分出去橫跑，一列 46 高。不橫捲、不捏放。
 *
 * 依幹線收合（D-主-559）：收起來的幹線只留一段線和「N 條路線」，版面照常往下排。
 *
 * 守則（不遊戲化，D-主-553）：線長跟任何數字都無關，只拿路線 id 打散版面（書背等厚的同一條）；
 * 只畫已到着的車站（沒蓋的章不存在）；這裡連済章數都拿不到，要比大小也沒得比。
 */
import type { NodeRow } from "./node";

type LineIn = Pick<NodeRow, "id" | "name" | "arrived_on">;
type RouteIn = Pick<NodeRow, "id" | "line_id" | "name" | "code" | "color" | "arrived_on">;
type StationIn = Pick<NodeRow, "id" | "route_id" | "name" | "arrived_on">;

export interface MapStation {
  id: string;
  name: string;
  day: string;
}

export interface MapRoute {
  id: string;
  name: string;
  code: string | null;
  color: string | null;
  arrived_on: string | null;
  /** 到站日那天到着的最後一站：併進終點雙圈，不另外畫白點 */
  termName: string | null;
  /** 已到着的車站（舊→新），不含併進終點的那一站 */
  stations: MapStation[];
}

export interface MapTrunk {
  /** 幹線 id；底下的路線找不到幹線時併成的最後一組＝null */
  id: string | null;
  name: string;
  arrived_on: string | null;
  routes: MapRoute[];
}

/** 路線找不到幹線時（一台刪幹線、另一台同時開路線）併成的一組：路線不能憑空從圖上消失 */
export const NO_LINE_NAME = "其他路線";

/** 把幹線、路線、車站收成走行圖要畫的樣子；順序照傳入的（側欄序） */
export function buildRouteMap(lines: readonly LineIn[], routes: readonly RouteIn[], stations: readonly StationIn[]): MapTrunk[] {
  const byRoute = new Map<string, StationIn[]>();
  for (const s of stations) {
    if (s.arrived_on === null || s.route_id === null) continue;
    (byRoute.get(s.route_id) ?? byRoute.set(s.route_id, []).get(s.route_id)!).push(s);
  }
  const toRoute = (r: RouteIn): MapRoute => {
    const own = (byRoute.get(r.id) ?? []).slice().sort((a, b) => (a.arrived_on! < b.arrived_on! ? -1 : a.arrived_on! > b.arrived_on! ? 1 : 0));
    const last = own[own.length - 1];
    const merged = r.arrived_on !== null && last !== undefined && last.arrived_on === r.arrived_on;
    return {
      id: r.id,
      name: r.name,
      code: r.code,
      color: r.color,
      arrived_on: r.arrived_on,
      termName: merged ? last.name : null,
      stations: (merged ? own.slice(0, -1) : own).map((s) => ({ id: s.id, name: s.name, day: s.arrived_on! })),
    };
  };
  const known = new Set(lines.map((l) => l.id));
  const out: MapTrunk[] = lines.map((l) => ({
    id: l.id,
    name: l.name,
    arrived_on: l.arrived_on,
    routes: routes.filter((r) => r.line_id === l.id).map(toRoute),
  }));
  const orphans = routes.filter((r) => r.line_id === null || !known.has(r.line_id));
  if (orphans.length) out.push({ id: null, name: NO_LINE_NAME, arrived_on: null, routes: orphans.map(toRoute) });
  return out;
}

/** 到站日：今年的寫 M.D，別年的帶年份（用超過一年後才分得出是哪一年） */
export function fmtMapDay(day: string, today: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return day.slice(0, 4) === today.slice(0, 4) ? `${m}.${d}` : `${y}.${m}.${d}`;
}

/** 字寬估算（漢字 1em，拉丁與數字 .58em，加字距）；只用來決定要不要截斷，不用精準 */
export function textWidth(s: string, fontSize: number, letterSpacing = 0): number {
  let w = 0;
  for (const ch of s) w += (ch.codePointAt(0)! > 0x2e7f ? 1 : 0.58) + letterSpacing;
  return w * fontSize;
}

/** 放不下就截斷加「…」（完整名字在 title 與記錄簿） */
export function fitText(s: string, maxWidth: number, fontSize: number, letterSpacing = 0): string {
  if (textWidth(s, fontSize, letterSpacing) <= maxWidth) return s;
  const chars = [...s];
  while (chars.length > 1 && textWidth(chars.join("") + "…", fontSize, letterSpacing) > maxWidth) chars.pop();
  return chars.join("") + "…";
}

/** 穩定的小雜湊：線尾的長短只拿來打散版面 */
function spread(id: string, buckets: number): number {
  let h = 7;
  for (const ch of id) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return h % buckets;
}

export interface Pt {
  x: number;
  y: number;
}

export interface LaidStation extends MapStation, Pt {
  /** 站名畫得下才有字；畫不下靠 title 與記錄簿 */
  label: string | null;
}

export interface LaidRoute {
  route: MapRoute;
  running: boolean;
  /** 細實線：從幹線分岔到徽 */
  fork: string;
  junction: Pt;
  /** 徽的圓心＝水平段起點 */
  badge: Pt;
  /** 水平段終點 */
  end: Pt;
  label: string;
  labelAt: Pt;
  stations: LaidStation[];
  /** 比畫得下的多，沒畫出來的（舊的先省） */
  hiddenStations: number;
  /** 已到站才有 */
  term: { at: Pt; date: string; dateAt: Pt; name: string | null } | null;
}

/** 收合用的鍵（找不到幹線的那一組也能收） */
export const trunkKey = (t: Pick<MapTrunk, "id">): string => t.id ?? "none";

const NO_FOLD: ReadonlySet<string> = new Set();
/** 名牌裡收合箭頭佔的寬度 */
const CARET_ROOM = 14;

export interface LaidTrunk {
  trunk: MapTrunk;
  label: string;
  plate: Pt & { w: number };
  /** 有路線才收得起來；沒路線的幹線名牌只是名牌 */
  foldable: boolean;
  folded: boolean;
  /** 名牌文字的水平中心（有箭頭時往左讓） */
  labelX: number;
  /** 收合箭頭的中心 */
  caret: Pt | null;
  /** 收起來時寫「N 條路線」 */
  count: { text: string; at: Pt } | null;
  /** 實線段 */
  solid: string;
  /** 還在跑的尾巴（虛線）；已到站＝null */
  tail: string | null;
  /** 已到站才有 */
  term: { at: Pt; date: string; dateAt: Pt } | null;
  /** 接到本線的那一段（寬版是幹線自己的頭，只留接點；窄版是一小段斜線） */
  feeder: string | null;
  junction: Pt;
  routes: LaidRoute[];
}

export interface MapLayout {
  mode: "net" | "tree";
  width: number;
  height: number;
  hub: Pt;
  /** 本線 */
  spine: string;
  trunks: LaidTrunk[];
}

const DOT_MIN_STEP = 13;
const NET_GAP = 40;
const NET_PLATE = 112;
const NET_X0 = 20;
const NET_FORK_MAX = 0.42;
const TREE_ROW = 46;
const TREE_X0 = 12;
const TREE_TRUNK_X = 32;
const TREE_FORK = 18;

/** 水平段上的車站平均排開（跟日期無關）；太多放不下就留最近的 */
function placeStations(r: MapRoute, x1: number, x2: number, y: number, withLabels: boolean, fs: number) {
  const span = x2 - x1;
  const fit = Math.max(0, Math.floor(span / DOT_MIN_STEP) - 1);
  const shown = r.stations.slice(Math.max(0, r.stations.length - fit));
  const step = span / (shown.length + 1);
  const stations: LaidStation[] = shown.map((s, i) => {
    const room = step - 6;
    const label = withLabels && textWidth(s.name, fs, 0.04) <= room ? s.name : null;
    return { ...s, x: +(x1 + step * (i + 1)).toFixed(1), y, label };
  });
  return { stations, hiddenStations: r.stations.length - shown.length };
}

const dateRoom = (day: string, today: string, fs = 10.5): number => textWidth(fmtMapDay(day, today), fs) + 14;

/** 寬版：本線→橫跑的幹線→斜著分出去的路線。`nameFs` 路線名字級 */
export function layoutNet(trunks: readonly MapTrunk[], width: number, today: string, nameFs = 12.5, folds: ReadonlySet<string> = NO_FOLD): MapLayout {
  const xEnd = width - 18;
  const out: LaidTrunk[] = [];
  let y = 54;
  for (const T of trunks) {
    const foldable = T.routes.length > 0;
    const folded = foldable && folds.has(trunkKey(T));
    const shown = folded ? [] : T.routes;
    const up = shown.filter((_, i) => i % 2 === 0);
    const dn = shown.filter((_, i) => i % 2 === 1);
    const k = Math.max(up.length, dn.length);
    // 分岔太多時斜段變陡（仍互相平行）：水平段至少留下寬度的一半多，名字才放得下
    const stepX = k ? Math.min(NET_GAP, ((width * NET_FORK_MAX) - NET_PLATE) / k) : NET_GAP;
    const sx = NET_X0 + NET_PLATE + k * stepX + 8;
    const ty = y + up.length * NET_GAP + (up.length ? 8 : 16);
    const tEnd = T.arrived_on ? xEnd - dateRoom(T.arrived_on, today) : xEnd;
    const tailFrom = tEnd - 34;
    const caretW = foldable ? CARET_ROOM : 0;
    const label = fitText(T.name, NET_PLATE - 26 - caretW, 12.5, 0.14);
    const plateW = Math.min(textWidth(label, 12.5, 0.14) + 18 + caretW, NET_PLATE - 8);
    const plateX = NET_X0 + 12;
    const routes: LaidRoute[] = [];
    const side = (arr: readonly MapRoute[], s: 1 | -1) => {
      arr.forEach((r, i) => {
        const steps = arr.length - i;
        const ly = ty + s * steps * NET_GAP;
        const j = { x: +(sx - steps * stepX).toFixed(1), y: ty };
        const running = r.arrived_on === null;
        const end = {
          x: xEnd - spread(r.id, 4) * 44 - (running ? 0 : dateRoom(r.arrived_on!, today)),
          y: ly,
        };
        const lineFrom = sx + 16;
        const placed = placeStations(r, lineFrom, end.x, ly, true, 10.5);
        routes.push({
          route: r,
          running,
          fork: `M${j.x} ${j.y}L${sx} ${ly}`,
          junction: j,
          badge: { x: sx, y: ly },
          end,
          label: fitText(r.name, end.x - sx - 20, nameFs, 0.08),
          labelAt: { x: sx + 16, y: ly - 8 },
          ...placed,
          term: running
            ? null
            : {
                at: end,
                date: fmtMapDay(r.arrived_on!, today),
                dateAt: { x: end.x + 12, y: ly + 4 },
                name: r.termName,
              },
        });
      });
    };
    side(up, -1);
    side(dn, 1);
    out.push({
      trunk: T,
      label,
      plate: { x: plateX, y: ty - 12, w: plateW },
      foldable,
      folded,
      labelX: plateX + (plateW - caretW) / 2,
      caret: foldable ? { x: plateX + plateW - 11, y: ty } : null,
      count: folded ? { text: `${T.routes.length} 條路線`, at: { x: plateX + plateW + 10, y: ty - 8 } } : null,
      solid: `M${NET_X0} ${ty}H${T.arrived_on ? tEnd : tailFrom}`,
      tail: T.arrived_on ? null : `M${tailFrom} ${ty}H${tEnd}`,
      term: T.arrived_on ? { at: { x: tEnd, y: ty }, date: fmtMapDay(T.arrived_on, today), dateAt: { x: tEnd + 12, y: ty + 4 } } : null,
      feeder: null,
      junction: { x: NET_X0, y: ty },
      routes,
    });
    y = ty + dn.length * NET_GAP + 34;
  }
  const last = out[out.length - 1]?.junction.y ?? 24;
  return { mode: "net", width, height: y - 4, hub: { x: NET_X0, y: 24 }, spine: `M${NET_X0} 24V${last}`, trunks: out };
}

/** 窄版：幹線直立，路線往右分出去橫跑。`nameFs` 路線名字級（手機 14） */
export function layoutTree(trunks: readonly MapTrunk[], width: number, today: string, nameFs = 14, folds: ReadonlySet<string> = NO_FOLD): MapLayout {
  const xEnd = width - 10;
  const tx = TREE_TRUNK_X;
  const out: LaidTrunk[] = [];
  let y = 50;
  for (const T of trunks) {
    const py = y + 12;
    const foldable = T.routes.length > 0;
    const folded = foldable && folds.has(trunkKey(T));
    const shown = folded ? [] : T.routes;
    const n = shown.length;
    // 底下沒畫路線（收起來、或幹線本來就空）：還在跑的只留名牌（線藏在名牌後面）；到站的留一小段接到終點雙圈
    const y1 = n === 0 ? py + (T.arrived_on ? 20 : 6) : py + 12 + n * TREE_ROW - 9;
    const routes: LaidRoute[] = shown.map((r, i) => {
      const ly = py + 12 + (i + 1) * TREE_ROW - 16;
      const running = r.arrived_on === null;
      const sx = tx + 30;
      const end = { x: xEnd - spread(r.id, 3) * 22 - (running ? 0 : dateRoom(r.arrived_on!, today)), y: ly };
      const placed = placeStations(r, sx + 14, end.x, ly, false, 10.5);
      return {
        route: r,
        running,
        fork: `M${tx} ${ly - TREE_FORK}L${tx + TREE_FORK} ${ly}H${sx}`,
        junction: { x: tx, y: ly - TREE_FORK },
        badge: { x: sx, y: ly },
        end,
        label: fitText(r.name, xEnd - sx - 14, nameFs, 0.08),
        labelAt: { x: sx + 14, y: ly - 7 },
        ...placed,
        term: running ? null : { at: end, date: fmtMapDay(r.arrived_on!, today), dateAt: { x: end.x + 10, y: ly + 4 }, name: r.termName },
      };
    });
    const caretW = foldable ? CARET_ROOM : 0;
    const label = fitText(T.name, xEnd - tx - 80 - caretW, 12.5, 0.14);
    const plateW = textWidth(label, 12.5, 0.14) + 18 + caretW;
    const plateX = tx - 8;
    out.push({
      trunk: T,
      label,
      plate: { x: plateX, y: py - 12, w: plateW },
      foldable,
      folded,
      labelX: plateX + (plateW - caretW) / 2,
      caret: foldable ? { x: plateX + plateW - 11, y: py } : null,
      count: folded ? { text: `${T.routes.length} 條路線`, at: { x: plateX + plateW + 8, y: py + 4 } } : null,
      solid: `M${tx} ${py}V${T.arrived_on || n === 0 ? y1 : y1 - 4}`,
      tail: T.arrived_on || n === 0 ? null : `M${tx} ${y1 - 4}V${y1 + 10}`,
      term: T.arrived_on ? { at: { x: tx, y: y1 + 10 }, date: fmtMapDay(T.arrived_on, today), dateAt: { x: tx + 12, y: y1 + 14 } } : null,
      feeder: `M${TREE_X0} ${py - 20}L${tx} ${py}`,
      junction: { x: TREE_X0, y: py - 20 },
      routes,
    });
    y = y1 + 26;
  }
  const last = out[out.length - 1]?.junction.y ?? 20;
  return { mode: "tree", width, height: y + 2, hub: { x: TREE_X0, y: 20 }, spine: `M${TREE_X0} 20V${last}`, trunks: out };
}

/** 比這窄就用直立排法：手機一定落在這裡，桌機視窗拉窄也一樣 */
export const NET_MIN_WIDTH = 560;

export function layoutRouteMap(trunks: readonly MapTrunk[], width: number, today: string, nameFs?: number, folds?: ReadonlySet<string>): MapLayout {
  return width >= NET_MIN_WIDTH ? layoutNet(trunks, width, today, nameFs, folds) : layoutTree(trunks, width, today, nameFs, folds);
}
