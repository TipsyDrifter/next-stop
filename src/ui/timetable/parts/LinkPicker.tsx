/**
 * LinkPicker——「連到…」選擇器（車次② 契約 §5.5、〈開工決定〉✎二-7；乙席；長相＝原型 `v-f.js` pickBody／pickDefault／linkChip、
 * `v-f.css` .vf-pick／.vf-pk／.vf-rk／.vf-lk）。三個面板（發車、改一塊／補記、運行列的 LinkPanel）共用同一個選擇器，反應一致：
 * 選了就 `onPick`，選擇器本身不寫入。
 *
 *   div.ns-tt-link-pick
 *   ├（有 onBack）div.ns-tt-link-head：‹＋「連到…」——面板裡的子頁（原型 drawPanel 的 pick 模式）
 *   ├（有連結）p.ns-tt-link-now「現在：」＋LinkChip
 *   ├ label.ns-tt-link-search > input（搜尋全部任務；IME 組字中不搜）
 *   ├ 沒打字：「今日車票」（0-10 同一份，含已交代的、標「済」）＋「只連路線」（nodeStore.routes）
 *   │ 打了字：`nodeStore.searchNodes(q)` 只留 LINKABLE_KINDS、未刪除，最多 20 列（種類字・所屬路線）
 *   └ div.ns-tt-link-foot：有連結 ⇒「取消連結」；沒有 ⇒ 淡字
 *
 * 另外匯出面板與發車台共用的小件：
 *   - `LinkRow`：面板裡「連到」那一列（收起＝目前選的＋›，點了展開子頁）
 *   - `LinkChip`：連結的顯示（路線圓牌＋名稱＋種類字；沒連／已刪除各有樣子）
 *   - `RouteRoundel`：路線色圓牌（代碼或圓點；沒路線＝虛線「臨」）
 *   - `useLastCategories`／`useLastCategory`：「上次的分類」（〈原型拍板〉4 的主鈕、今日車票的小字）
 *
 * 「上次的分類」走 store 的 `lastCategoryFor`（直接轉 repository 那份；跟真的發車 `departFromTask` 同一個語義，
 * 路線段含已刪除節點的塊）。只連路線＝`lastCategoryFor(null, routeId)`（只查路線段）。讀失敗 ⇒ 那格當作「不知道」，
 * 不畫小字、不出主鈕。
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { TodayRow } from "../../../data";
import { KIND_LABEL, type NodeKind, type NodeRow } from "../../../domain/node";
import type { BlockLink } from "../../../domain/timetable";
import { LINKABLE_KINDS, linkDeletedText, LINK_MISSING_TEXT, type LinkInfo } from "../../../domain/timetableLink";
import { useNodeStore } from "../../../store/nodeStore";
import { TT_TEXT, useTimetableStore } from "../../../store/timetableStore";
import { roundelStyle } from "../../common/roundel";
import { useTodayTicketRows } from "./TodayTickets";

/**
 * 已交代的標記（判法同 `settledRow`：定期券看這一班的結局、其餘看 status）——選擇器列出已交代的票時標字：
 * 済＝蓋済、運休＝這一班停駛；沒交代＝null
 */
function settledMark(r: TodayRow): "済" | "運休" | null {
  if (r.occurrence) return r.occurrence.status === "done" ? "済" : "運休";
  return r.status === "done" ? "済" : null;
}

/* ───────── 路線 ───────── */

/** nodeStore.routes → id 對照（路線色、代碼、名稱） */
export function useRouteById(): Record<string, NodeRow> {
  const routes = useNodeStore((s) => s.routes);
  return useMemo(() => {
    const m: Record<string, NodeRow> = {};
    for (const r of routes) m[r.id] = r;
    return m;
  }, [routes]);
}

/** 路線圓牌：亮盤深字（顏色換算走核心的 roundelStyle）；沒代碼＝圓點；沒路線（臨時車票）＝虛線「臨」 */
export function RouteRoundel({ route, gone = false }: { route: NodeRow | null; gone?: boolean }) {
  if (gone) {
    return (
      <span className="ns-tt-roundel is-temp" aria-hidden="true">
        －
      </span>
    );
  }
  if (!route) {
    return (
      <span className="ns-tt-roundel is-temp" aria-hidden="true">
        臨
      </span>
    );
  }
  const disc = roundelStyle(route.color);
  if (!route.code) {
    return (
      <span className="ns-tt-roundel" aria-hidden="true">
        <i className="ns-tt-roundel-dot" style={{ background: disc.background }} />
      </span>
    );
  }
  return (
    <span className="ns-tt-roundel" style={disc as CSSProperties} aria-hidden="true">
      {route.code}
    </span>
  );
}

/* ───────── 連結的顯示 ───────── */

/** 選擇器裡挑過的節點（搜尋結果不在 linkInfo、也不一定在今日切片）：面板的「連到」列要畫得出名字 */
interface KnownNode {
  name: string;
  kind: string;
  routeId: string | null;
}
const known = new Map<string, KnownNode>();
function remember(n: { id: string; name: string; kind: string; route_id: string | null }): void {
  known.set(n.id, { name: n.name, kind: n.kind, routeId: n.route_id });
}

export interface LinkDesc {
  /** 沒連 */
  none: boolean;
  /** 只連路線 */
  routeOnly: boolean;
  /** 名稱；刪掉／找不到時是「（原X已刪除）」 */
  label: string;
  /** 種類字（車票／列車／車廂；只連路線＝「只連路線」） */
  kindLabel: string;
  /** 圓牌用的路線 id（節點所屬路線；只連路線＝那條路線） */
  routeId: string | null;
  gone: boolean;
}

/**
 * 連結 → 顯示（0-15 的規則，資料來源多一層：linkInfo → 選過的 → 今日切片 → 開著的路線樹）。
 * linkInfo 有那一格就以它為準（含刪除狀態）；其餘來源只有活的節點。
 */
function describe(
  link: BlockLink | null,
  linkInfo: Record<string, LinkInfo>,
  routeById: Record<string, NodeRow>,
  todayById: Record<string, TodayRow>,
  treeById: Record<string, NodeRow>,
): LinkDesc {
  if (!link || (link.nodeId === null && link.routeId === null)) {
    return { none: true, routeOnly: false, label: "", kindLabel: "", routeId: null, gone: false };
  }
  if (link.nodeId !== null) {
    const id = link.nodeId;
    const info = linkInfo[id];
    if (info) {
      if (info.missing) return { none: false, routeOnly: false, label: LINK_MISSING_TEXT, kindLabel: "", routeId: null, gone: true };
      if (info.deleted)
        return { none: false, routeOnly: false, label: linkDeletedText(info.kindLabel), kindLabel: "", routeId: null, gone: true };
      return { none: false, routeOnly: false, label: info.name, kindLabel: info.kindLabel, routeId: info.routeId, gone: false };
    }
    const n: KnownNode | undefined =
      known.get(id) ??
      (todayById[id] ? { name: todayById[id].name, kind: todayById[id].kind, routeId: todayById[id].route_id } : undefined) ??
      (treeById[id] ? { name: treeById[id].name, kind: treeById[id].kind, routeId: treeById[id].route_id } : undefined);
    if (n) return { none: false, routeOnly: false, label: n.name, kindLabel: KIND_LABEL[n.kind as NodeKind] ?? "", routeId: n.routeId, gone: false };
    return { none: false, routeOnly: false, label: "…", kindLabel: "", routeId: null, gone: false };
  }
  const rid = link.routeId as string;
  const r = routeById[rid];
  const info = linkInfo[rid];
  if (info && (info.deleted || info.missing))
    return { none: false, routeOnly: true, label: linkDeletedText("路線"), kindLabel: TT_TEXT.LINK_ROUTE_ONLY, routeId: null, gone: true };
  return { none: false, routeOnly: true, label: r?.name ?? info?.name ?? "…", kindLabel: TT_TEXT.LINK_ROUTE_ONLY, routeId: rid, gone: false };
}

/** 連結的顯示（hook 版：自己讀 store） */
export function useLinkDesc(link: BlockLink | null): LinkDesc {
  const linkInfo = useTimetableStore((s) => s.linkInfo);
  const today = useNodeStore((s) => s.today);
  const tree = useNodeStore((s) => s.tree);
  const routeById = useRouteById();
  return describe(link, linkInfo, routeById, today.byId, tree.byId);
}

/** 連結 chip：路線圓牌＋名稱＋種類字；沒連＝「沒有連到任務・只記分類」；刪掉＝斜體淡字 */
export function LinkChip({ link }: { link: BlockLink | null }) {
  const d = useLinkDesc(link);
  const routeById = useRouteById();
  if (d.none) {
    return (
      <span className="ns-tt-link-chip is-none">
        <span className="ns-tt-link-chip-t">沒有連到任務</span>
        <span className="ns-tt-link-chip-k">只記分類</span>
      </span>
    );
  }
  return (
    <span className={"ns-tt-link-chip" + (d.gone ? " is-gone" : "")}>
      <RouteRoundel route={d.routeId ? (routeById[d.routeId] ?? null) : null} gone={d.gone} />
      <span className="ns-tt-link-chip-t">{d.label}</span>
      {d.kindLabel && <span className="ns-tt-link-chip-k">{d.kindLabel}</span>}
    </span>
  );
}

/** 面板裡「連到」那一列（發車、改一塊、補記）：收起時顯示目前選的＋›，點了 `onOpen`（面板換成選擇器子頁） */
export function LinkRow({ value, onOpen }: { value: BlockLink | null; onOpen(): void }) {
  return (
    <div className="ns-tt-row ns-tt-link-row">
      <span className="ns-tt-row-k">連到</span>
      <span className="ns-tt-row-v">
        <button type="button" className="ns-tt-link-btn" onClick={onOpen} aria-label="連到…（換連結）">
          <LinkChip link={value} />
          <span className="ns-tt-link-chev" aria-hidden="true">
            ›
          </span>
        </button>
      </span>
    </div>
  );
}

/* ───────── 上次的分類 ───────── */

export interface LastCat {
  categoryId: string;
  from: "node" | "route";
}

export interface LastCatTarget {
  nodeId: string | null;
  /** 節點所屬路線（null＝沒掛路線 ⇒ 只查節點那段）；只連路線＝那條路線 */
  routeId: string | null;
}

const keyOf = (t: LastCatTarget): string => `${t.nodeId ?? ""}|${t.routeId ?? ""}`;

/**
 * 一組目標各自的「上次的分類」：key＝`${nodeId}|${routeId}`；值 null＝都沒有（要先選分類）；
 * 沒有那個 key＝還在讀或讀失敗（不知道）。`rev`（每次 refresh +1）變了就重讀。
 * 每個目標一次 `store.lastCategoryFor`（＝repository 那份、跟 departFromTask 同一個語義；SQL 各段 LIMIT 1）。
 */
export function useLastCategories(targets: readonly LastCatTarget[]): Record<string, LastCat | null> {
  const rev = useTimetableStore((s) => s.rev);
  const lastCategoryFor = useTimetableStore((s) => s.lastCategoryFor);
  const sig = targets.map(keyOf).join(",");
  const [out, setOut] = useState<Record<string, LastCat | null>>({});
  useEffect(() => {
    let alive = true;
    const seen = new Set<string>();
    const list = targets.filter((t) => {
      const k = keyOf(t);
      if (seen.has(k) || (t.nodeId === null && t.routeId === null)) return false;
      seen.add(k);
      return true;
    });
    if (list.length === 0) {
      setOut({});
      return;
    }
    void (async () => {
      const res: Record<string, LastCat | null> = {};
      const hits = await Promise.all(list.map((t) => lastCategoryFor(t.nodeId, t.routeId).then((h) => h, () => undefined)));
      list.forEach((t, k) => {
        const h = hits[k];
        if (h === undefined) return; // 讀失敗 ⇒ 不知道
        res[keyOf(t)] = h;
      });
      if (alive) setOut(res);
    })();
    return () => {
      alive = false;
    };
    // targets 以 sig 代表（呼叫端每次 render 可能給新陣列）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, rev, lastCategoryFor]);
  return out;
}

/** 一個連結的「上次的分類」（undefined＝不知道／還在讀；null＝沒有） */
export function useLastCategory(link: BlockLink | null): LastCat | null | undefined {
  const d = useLinkDesc(link);
  const target = useMemo<LastCatTarget[]>(() => {
    if (!link || d.none || d.gone) return [];
    if (link.nodeId !== null) return [{ nodeId: link.nodeId, routeId: d.routeId }];
    return [{ nodeId: null, routeId: link.routeId }];
  }, [link, d.none, d.gone, d.routeId]);
  const res = useLastCategories(target);
  if (target.length === 0) return null;
  return res[keyOf(target[0])];
}

/* ───────── 選擇器本體 ───────── */

const SEARCH_MAX = 20;
const SEARCH_DEBOUNCE_MS = 160;

export interface LinkPickerProps {
  value: BlockLink | null;
  onPick(link: BlockLink | null): void;
  /** 面板裡的子頁才給：頂端畫「‹ 連到…」回上一步（LinkPanel 本身的標題就是「連到…」，不給） */
  onBack?(): void;
}

export function LinkPicker({ value, onPick, onBack }: LinkPickerProps) {
  const rows = useTodayTicketRows(true);
  const routes = useNodeStore((s) => s.routes);
  const routeById = useRouteById();
  const catById = useTimetableStore((s) => s.catById);
  const cur = value && (value.nodeId !== null || value.routeId !== null) ? value : null;

  const [q, setQ] = useState("");
  const [composing, setComposing] = useState(false);
  const [results, setResults] = useState<NodeRow[] | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // 桌機：搜尋框直接拿焦點（打字就搜）；手機不搶（會彈鍵盤蓋住清單）
  useEffect(() => {
    const el = inputRef.current;
    if (el && !el.closest('[data-shell="mobile"]')) el.focus({ preventScroll: true });
  }, []);

  // 搜尋（IME 組字中不搜；去抖）
  const query = q.trim();
  useEffect(() => {
    if (composing) return;
    if (!query) {
      setResults(null);
      return;
    }
    let alive = true;
    const t = setTimeout(() => {
      void useNodeStore
        .getState()
        .searchNodes(query)
        .then((ns) => {
          if (!alive) return;
          setResults(ns.filter((n) => LINKABLE_KINDS.includes(n.kind) && n.deleted_at === null).slice(0, SEARCH_MAX));
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [query, composing]);

  const targets = useMemo(() => rows.map((r) => ({ nodeId: r.id, routeId: r.route_id })), [rows]);
  const mem = useLastCategories(targets);

  const pickNode = (n: { id: string; name: string; kind: string; route_id: string | null }): void => {
    remember(n);
    onPick({ nodeId: n.id, routeId: null });
  };
  const routeName = (rid: string | null): string => (rid ? (routeById[rid]?.name ?? "路線") : "臨時車票");

  return (
    <div className="ns-tt-link-pick">
      {onBack && (
        <div className="ns-tt-link-head">
          <button type="button" className="ns-tt-link-back" onClick={onBack} aria-label="回上一步">
            ‹
          </button>
          <span>{TT_TEXT.LINK_TITLE}</span>
        </div>
      )}
      {cur && (
        <p className="ns-tt-link-now">
          <span className="ns-tt-link-now-k">現在</span>
          <LinkChip link={cur} />
        </p>
      )}
      <label className="ns-tt-link-search">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true">
          <circle cx="7" cy="7" r="4.3" />
          <path d="M10.2 10.2 13.5 13.5" />
        </svg>
        <input
          ref={inputRef}
          type="search"
          value={q}
          placeholder="搜尋全部任務（車票、列車、車廂）"
          autoComplete="off"
          aria-label="搜尋全部任務"
          onChange={(e) => setQ(e.target.value)}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={(e) => {
            setComposing(false);
            setQ((e.target as HTMLInputElement).value);
          }}
          onKeyDown={(e) => {
            // 搜尋框裡的 Enter 不往外冒（發車面板的 Enter＝主鈕）
            if (e.key === "Enter") e.stopPropagation();
          }}
        />
      </label>

      {query ? (
        <div className="ns-tt-link-list">
          {results === null ? null : results.length === 0 ? (
            <p className="ns-tt-link-empty">找不到「{query}」——只搜得到車票、列車、車廂</p>
          ) : (
            results.map((n) => {
              const on = cur?.nodeId === n.id;
              return (
                <button type="button" key={n.id} className={"ns-tt-link-pk" + (on ? " is-on" : "")} onClick={() => pickNode(n)}>
                  <RouteRoundel route={n.route_id ? (routeById[n.route_id] ?? null) : null} />
                  <span className="ns-tt-link-pk-main">
                    <span className="ns-tt-link-pk-t">{n.name}</span>
                    <span className="ns-tt-link-pk-s">
                      {KIND_LABEL[n.kind]}・{routeName(n.route_id)}
                    </span>
                  </span>
                  {on && (
                    <span className="ns-tt-link-pk-on" aria-label="目前的連結">
                      ✓
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>
      ) : (
        <>
          {rows.length > 0 && (
            <>
              <div className="ns-tt-link-sec">{TT_TEXT.TODAY_TICKETS}</div>
              <div className="ns-tt-link-list">
                {rows.map((r) => {
                  const on = cur?.nodeId === r.id;
                  const m = mem[`${r.id}|${r.route_id ?? ""}`];
                  const cat = m ? catById[m.categoryId] : undefined;
                  const mark = settledMark(r);
                  return (
                    <button type="button" key={r.id} className={"ns-tt-link-pk" + (on ? " is-on" : "")} onClick={() => pickNode(r)}>
                      <RouteRoundel route={r.route_id ? (routeById[r.route_id] ?? null) : null} />
                      <span className="ns-tt-link-pk-main">
                        <span className="ns-tt-link-pk-t">
                          {r.name}
                          {mark ? <em className={"ns-tt-link-pk-done" + (mark === "運休" ? " is-skip" : "")}> {mark}</em> : null}
                        </span>
                        <span className="ns-tt-link-pk-s">
                          {routeName(r.route_id)}
                          {cat ? `・上次 ${cat.name}` : ""}
                        </span>
                      </span>
                      {on && (
                        <span className="ns-tt-link-pk-on" aria-label="目前的連結">
                          ✓
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </>
          )}
          {routes.length > 0 && (
            <>
              <div className="ns-tt-link-sec">
                {TT_TEXT.LINK_ROUTE_ONLY}
                <span>沒有特定的車票，但屬於這條路線</span>
              </div>
              <div className="ns-tt-link-routes">
                {routes.map((r) => {
                  const on = cur !== null && cur.nodeId === null && cur.routeId === r.id;
                  return (
                    <button
                      type="button"
                      key={r.id}
                      className={"ns-tt-link-rk" + (on ? " is-on" : "")}
                      aria-pressed={on}
                      onClick={() => onPick({ nodeId: null, routeId: r.id })}
                    >
                      <RouteRoundel route={r} />
                      <span>{r.name}</span>
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </>
      )}

      <div className="ns-tt-link-foot">
        {cur ? (
          <button type="button" className="ns-btn btn-ghost ns-tt-link-clear" onClick={() => onPick(null)}>
            {TT_TEXT.LINK_CLEAR}（只記分類）
          </button>
        ) : (
          <span className="ns-tt-link-dim">現在沒有連到任何任務</span>
        )}
      </div>
    </div>
  );
}
