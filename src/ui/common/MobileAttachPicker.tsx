/**
 * MobileAttachPicker——手機的「掛到哪」挑選器（車次①契約 §5.2 AttachPicker 的手機版；0-3 乙案、0-6）。
 *
 * 資料與桌機共用 `useAttachOptions`（路線＝nodeStore.routes；往下＝loadTree 攤平的支線／列車／車廂），畫面各寫。
 * 底部面板兩層：
 *   第一層＝路線清單（roundel＋名；頂部搜尋框過濾，D-筆-6「用搜尋挑」）。
 *     depth="route"：點路線即選定。
 *     depth="node"：點路線進第二層；搜尋框有字時另外把**所有路線**的節點一起比對列出（跨路線直接挑）。
 *   第二層＝該路線的樹（縮排；`kinds` 之外的種類灰字當群組頭、不可點），首列「整條路線」（routeSelectable 時）。
 *   Android 返回鍵（磨光①）：第二層＝「‹ 路線」、第一層＝「取消」；本元件自己登記，呼叫端不用再登記。
 *
 * 三個用處（呼叫端決定參數）：
 *   - 收件匣車票「掛進列車」：depth="node"、kinds=["train","car"]、routeSelectable=false
 *   - 收件匣車票「掛上路線」：depth="route"
 *   - 變待辦預覽／筆記整頁「掛在哪」：depth="node"、全部種類、routeSelectable（筆記另有「摘掉」）
 *
 * 殼＝共用 `MSheet`（UI 丙-7 T5；它自己 portal 到 body，從 `.m-page` 裡開也不會被 tab bar 壓住）。
 *
 * 第四個用處（磨光⑤ B1「移動到…」，主線代改）：票卡 ⋯ 的搬遷。給 `excludeId` ＝搬遷模式——樹裡藏掉自己與整個子樹、
 * 只留挑得到的列與其群組頭；`currentNote`（「目前位置」）讓目前所在的父節點標出來、不可點。兩個都不給＝原本的行為。
 * 手機殼班（契約 §一F）：搬遷模式一打開就進 `value.routeId` 那條路線的第二層（同桌機側板挑選器），「‹ 路線」照樣退回第一層。
 *   第二輪：返回鍵在「一打開就在」的那層＝關掉（使用者只開了一層；同桌機 Esc），自己點進去的第二層照舊退回路線清單。
 *
 * 也 export 路線小圓牌 `RouteRoundel`／路線色點 `RouteDot`，手機各元件共用（契約 §2.3 沒有另開 util 檔的位子）。
 *
 * ── UI 丙-2 搬家（契約 §1 #18；2026-10-22）──
 * 用途：「掛到哪」挑選器（手機底部面板），收件匣、筆記整頁、變待辦預覽、票卡 ⋯「移動到…」共用；另 export RouteRoundel／RouteDot。
 * 規範：視覺規範 §2.4（手機底部 sheet）、§2.10（選中 .on）。
 * ── UI 丙-7 T5：殼換共用 MSheet ──
 *   拉柄＋襯線標題（第一層＝呼叫端給的 title、第二層＝路線名）＋本文（搜尋列固定、清單自己捲）＋黏底 foot（取消｜摘掉）。
 *   高度：depth="node" 給 full（90%：進路線看樹時不跳高；舊面板是固定 78%）、depth="route" 給 auto（跟內容、≤60%）。
 *   「‹ 路線」從舊的標題列搬到搜尋列左邊（殼的標題列是拖曳把手，不放鈕）。
 *   拖把手下滑／點暗幕／Esc＝取消（殼的四條路）；Android 返回鍵＝第二層回「‹ 路線」、第一層＝取消——
 *   本元件用 useBackLayer "notes.attachPicker" 登記，MSheet 用同一個 backId＋backKind 合併成一層；子元件 MSheet 的 effect
 *   先跑、本元件後登記，refcount 合併後「最後登記的 onBack」＝本元件這支（第二層先退一層）。
 * ARIA：殼的 role=dialog＋aria-modal＋aria-labelledby→標題；「目前位置」那格 disabled。
 * 樣式：舊的 .ns-notes-mveil／.ns-notes-mpick* 面板（notes-mobile.css §十）刪掉；清單列 .ns-notes-mnode* 與本文排版
 *   .ns-mattach* 搬到 common/attachpicker.css（src/index.css 集中 @import）。搜尋框借 notes-mobile.css 的 .ns-notes-minput。
 *   原路徑 notes/mobile/MobileAttachPicker.tsx 的 re-export 殼也在丙-7 T5 刪掉（呼叫端都改 import 本檔）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { NodeRow } from "../../domain";
import type { AttachTarget } from "../../domain/notes";
import { excludeSubtree, pruneToSelectable } from "../../domain/moveTo";
import { roundelStyle } from "./roundel";
import { useAttachOptions, type AttachKind, type AttachOption } from "../notes/useAttachOptions";
import { useBackLayer } from "../mobile/backStack";
import { MSheet } from "./MSheet";

/* ───────── 共用小件 ───────── */

/** 路線圓牌（亮盤深字；顏色換算走 roundelStyle，與 Sidebar／MobileRouteMap 同法） */
export function RouteRoundel({ route, className }: { route: Pick<NodeRow, "code" | "name" | "color">; className?: string }) {
  return (
    <span aria-hidden className={"roundel" + (className ? " " + className : "")} style={roundelStyle(route.color)}>
      {route.code ?? route.name.slice(0, 1)}
    </span>
  );
}

/** 路線色點（7px；捕捉框落點與票根用） */
export function RouteDot({ route }: { route: Pick<NodeRow, "color"> | null | undefined }) {
  return (
    <span
      aria-hidden
      className={"ns-notes-mdot" + (route ? "" : " none")}
      style={route ? { background: route.color ?? "var(--route-none)" } : undefined}
    />
  );
}

const KIND_GLYPH: Record<AttachKind, string> = { branch: "支", train: "列", car: "廂" };
const KIND_NAME: Record<AttachKind, string> = { branch: "支線", train: "列車", car: "車廂" };

export interface AttachPickNames {
  route: string;
  /** 掛整條路線時 null */
  node: string | null;
}

export interface MobileAttachPickerProps {
  title: string;
  depth: "route" | "node";
  /** depth="node" 時可選的節點種類；省略＝支線／列車／車廂都可 */
  kinds?: readonly AttachKind[];
  /** depth="node" 時能不能直接選路線本身（預設 true） */
  routeSelectable?: boolean;
  /** 目前的值（標示用） */
  value?: AttachTarget | null;
  onPick(t: AttachTarget, names: AttachPickNames): void;
  /** 有給才出現「摘掉／不掛」那一格 */
  onClear?: () => void;
  clearLabel?: string;
  onClose(): void;
  /**
   * 返回層的種類（預設 "sheet"）。堆疊先比種類再比先後（dialog＞full＞sheet＞page），
   * 從全螢幕面板裡開的（變待辦預覽）要傳 "dialog"（疊在 full 上的子面板一律 dialog，契約 §9.1），不然返回會先關掉底下的全螢幕面板。
   */
  backKind?: "sheet" | "dialog";
  /** 搬遷模式（磨光⑤ B1）：不列這個節點與它的整個子樹，樹只留挑得到的列與其群組頭 */
  excludeId?: string;
  /** 有給＝`value` 那一格標這個字（「目前位置」）、不可點 */
  currentNote?: string;
}

interface CrossHit {
  route: NodeRow;
  opt: AttachOption;
}

export function MobileAttachPicker({
  title,
  depth,
  kinds,
  routeSelectable = true,
  value,
  onPick,
  onClear,
  clearLabel = "摘掉",
  onClose,
  backKind = "sheet",
  excludeId,
  currentNote,
}: MobileAttachPickerProps) {
  const { routes, loadTree } = useAttachOptions();
  // 搬遷模式（手機殼班，契約 §一F）：一打開就在目前所在那條路線的第二層，「目前位置」那格看得到（同桌機 AttachPicker 的 expanded 初值）；
  //   其他用處照舊從路線清單開始
  const [routeId, setRouteId] = useState<string | null>(() =>
    excludeId !== undefined && depth === "node" && value?.routeId && routes.some((r) => r.id === value.routeId)
      ? value.routeId
      : null,
  );
  const [query, setQuery] = useState("");
  const [tree, setTree] = useState<AttachOption[] | null>(null);
  const [treeErr, setTreeErr] = useState(false);
  const [all, setAll] = useState<Map<string, AttachOption[]> | null>(null);
  const kindsKey = kinds ? kinds.join(",") : "";
  const listRef = useRef<HTMLDivElement>(null);

  const route = routeId ? (routes.find((r) => r.id === routeId) ?? null) : null;
  const q = query.trim().toLowerCase();

  /**
   * 一打開就在的那條路線（搬遷模式的初值；其他用處 null）：使用者只開了一層，返回鍵在這一層＝關掉挑選器（同桌機 Esc 一律收起），
   * 不跳到一個沒看過的路線清單（手機殼班第二輪，反方評審 parity minor）。一按「‹ 路線」就清掉——之後自己點進去的照舊退回清單。
   * 「‹ 路線」鈕本身照舊退回清單（同桌機的「‹ 所有路線」列）：它是換路線的唯一入口，改成關閉就挑不到別條路線了。
   */
  const [homeRouteId, setHomeRouteId] = useState(routeId);
  const backToRoutes = () => {
    setRouteId(null);
    setQuery("");
    setHomeRouteId(null);
  };
  // 磨光① 返回層：登記在挑選器自己身上（「‹ 路線」那一層只有這裡知道；呼叫端都是「開著才掛」，所以一直 active）。
  //   返回＝在第二層 ⇒ 同「‹ 路線」（一打開就在的那層＝同「取消」）；在第一層 ⇒ 同「取消」
  useBackLayer("notes.attachPicker", true, () => (route && routeId !== homeRouteId ? backToRoutes() : onClose()), backKind);

  // 第二層：進某條路線就載它的樹
  useEffect(() => {
    if (!routeId) return;
    let alive = true;
    setTree(null);
    setTreeErr(false);
    loadTree(routeId, kinds)
      .then((opts) => alive && setTree(opts))
      .catch((e) => {
        console.warn("MobileAttachPicker.loadTree 失敗", e);
        if (alive) setTreeErr(true);
      });
    return () => {
      alive = false;
    };
    // kinds 以字串鍵比對，避免呼叫端每次 render 給新陣列就重載
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeId, kindsKey, loadTree]);

  // 第一層跨路線搜尋：第一次打字才把所有路線的樹載進來（路線數通常個位數）
  useEffect(() => {
    if (depth !== "node" || routeId || !q || all) return;
    let alive = true;
    Promise.all(routes.map((r) => loadTree(r.id, kinds).then((opts) => [r.id, opts] as const)))
      .then((pairs) => alive && setAll(new Map(pairs)))
      .catch((e) => console.warn("MobileAttachPicker 跨路線搜尋載入失敗", e));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depth, routeId, q, all, routes, kindsKey, loadTree]);

  // 換層時捲回頂
  useEffect(() => {
    listRef.current?.scrollTo({ top: 0 });
  }, [routeId]);

  const routeHits = useMemo(
    () => routes.filter((r) => !q || ((r.code ?? "") + " " + r.name).toLowerCase().includes(q)),
    [routes, q],
  );

  /** 搬遷模式（磨光⑤ B1）：藏掉自己與子樹 */
  const moving = excludeId !== undefined;

  const crossHits = useMemo<CrossHit[]>(() => {
    if (depth !== "node" || routeId || !q || !all) return [];
    const out: CrossHit[] = [];
    for (const r of routes) {
      const opts = all.get(r.id) ?? [];
      for (const opt of moving ? excludeSubtree(opts, excludeId) : opts) {
        if (opt.selectable && opt.name.toLowerCase().includes(q)) out.push({ route: r, opt });
      }
    }
    return out;
  }, [depth, routeId, q, all, routes, moving, excludeId]);

  const treeHits = useMemo(() => {
    if (!tree) return null;
    // 搬遷模式另外只留挑得到的列與其群組頭（搬列車時別的列車、車廂全是灰字，留著只是噪音）
    const shown = moving ? pruneToSelectable(excludeSubtree(tree, excludeId)) : tree;
    if (!q) return shown;
    // 有字時只留命中的可選節點（群組頭的縮排脈絡沒了也無妨：右側寫種類）
    return shown.filter((o) => o.name.toLowerCase().includes(q));
  }, [tree, q, moving, excludeId]);

  const pickRoute = (r: NodeRow) => onPick({ routeId: r.id, nodeId: null, nodeKind: "route" }, { route: r.name, node: null });
  const pickNode = (r: NodeRow, o: AttachOption) =>
    onPick({ routeId: r.id, nodeId: o.id, nodeKind: o.kind }, { route: r.name, node: o.name });

  const isOnRoute = (r: NodeRow) => !!value && value.routeId === r.id && !value.nodeId;
  const isOnNode = (o: AttachOption) => !!value && value.nodeId === o.id;
  /** 「目前位置」（磨光⑤ B1）：標出來、不可點。臨時車票的值只帶路線標籤（nodeKind null）＝沒有目前位置 */
  const lockRoute = (r: NodeRow) => !!currentNote && value?.nodeKind === "route" && isOnRoute(r);
  const lockNode = (o: AttachOption) => !!currentNote && isOnNode(o);

  return (
    <MSheet
      title={route ? route.name : title}
      backId="notes.attachPicker"
      backKind={backKind}
      height={depth === "node" ? "full" : "auto"}
      className="ns-mattach"
      onClose={onClose}
      foot={
        <>
          <button type="button" className="ns-btn btn-ghost" onClick={onClose}>
            取消
          </button>
          {onClear && (
            <button type="button" className="ns-btn btn-ghost" onClick={onClear}>
              {clearLabel}
            </button>
          )}
        </>
      }
    >
      <div className="ns-mattach-search">
        {route ? (
          <button type="button" className="ns-mattach-back" onClick={backToRoutes}>
            ‹ 路線
          </button>
        ) : null}
        <input
          className="ns-notes-minput"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={route ? "搜尋這條路線的支線、列車、車廂…" : depth === "node" ? "搜尋路線、列車、車廂…" : "搜尋路線…"}
          aria-label="搜尋"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="search"
        />
      </div>

      <div className="ns-mattach-list" ref={listRef}>
        {!route ? (
          <ul className="ns-notes-mnodes">
            {routeHits.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  className={"ns-notes-mnode" + (isOnRoute(r) ? " on" : "") + (depth === "route" && lockRoute(r) ? " is-locked" : "")}
                  disabled={depth === "route" && lockRoute(r)}
                  onClick={() => (depth === "route" ? pickRoute(r) : setRouteId(r.id))}
                >
                  <RouteRoundel route={r} className="ns-notes-mroundel" />
                  <span className="nm">{r.name}</span>
                  {depth === "node" ? (
                    <span className="chev" aria-hidden>
                      ›
                    </span>
                  ) : (
                    <span className="path">{lockRoute(r) ? currentNote : "路線"}</span>
                  )}
                </button>
              </li>
            ))}
            {crossHits.map(({ route: r, opt }) => (
              <li key={opt.id}>
                <button
                  type="button"
                  className={"ns-notes-mnode" + (isOnNode(opt) ? " on" : "") + (lockNode(opt) ? " is-locked" : "")}
                  disabled={lockNode(opt)}
                  onClick={() => pickNode(r, opt)}
                >
                  <span className="kind" style={{ color: r.color ?? "var(--route-none)" }} aria-hidden>
                    {KIND_GLYPH[opt.kind]}
                  </span>
                  <span className="nm">{opt.name}</span>
                  <span className="path">{lockNode(opt) ? currentNote : r.name}</span>
                </button>
              </li>
            ))}
            {routeHits.length === 0 && crossHits.length === 0 && (
              <li className="empty">{routes.length === 0 ? "還沒有路線" : "找不到符合的路線或列車"}</li>
            )}
          </ul>
        ) : (
          <ul className="ns-notes-mnodes">
            {routeSelectable && !q && (
              <li>
                <button
                  type="button"
                  className={"ns-notes-mnode is-whole" + (isOnRoute(route) ? " on" : "") + (lockRoute(route) ? " is-locked" : "")}
                  disabled={lockRoute(route)}
                  onClick={() => pickRoute(route)}
                >
                  <RouteRoundel route={route} className="ns-notes-mroundel" />
                  <span className="nm">整條路線</span>
                  <span className="path">{lockRoute(route) ? currentNote : moving ? "路線底下" : "只掛路線"}</span>
                </button>
              </li>
            )}
            {treeErr ? (
              <li className="empty">讀不到這條路線的列車，請再試一次</li>
            ) : treeHits === null ? (
              <li className="empty">載入中…</li>
            ) : treeHits.length === 0 ? (
              // 搬遷模式且路線本身能挑（搬列車）：上面那一格就是去處，不多一句
              moving && routeSelectable && !q ? null : (
                <li className="empty">
                  {q ? "找不到符合的列車或車廂" : moving ? "這條路線沒有可以放的地方" : "這條路線還沒有支線或列車"}
                </li>
              )
            ) : (
              treeHits.map((o) =>
                o.selectable ? (
                  <li key={o.id}>
                    <button
                      type="button"
                      className={"ns-notes-mnode" + (isOnNode(o) ? " on" : "") + (lockNode(o) ? " is-locked" : "")}
                      disabled={lockNode(o)}
                      style={{ paddingLeft: `calc(var(--m-gutter) + ${q ? 0 : o.depth * 16}px)` }}
                      onClick={() => pickNode(route, o)}
                    >
                      <span className="kind" style={{ color: route.color ?? "var(--route-none)" }} aria-hidden>
                        {KIND_GLYPH[o.kind]}
                      </span>
                      <span className="nm">{o.name}</span>
                      <span className="path">{lockNode(o) ? currentNote : KIND_NAME[o.kind]}</span>
                    </button>
                  </li>
                ) : (
                  <li
                    key={o.id}
                    className="ns-notes-mnode-group"
                    style={{ paddingLeft: `calc(var(--m-gutter) + ${q ? 0 : o.depth * 16}px)` }}
                  >
                    <span className="kind" aria-hidden>
                      {KIND_GLYPH[o.kind]}
                    </span>
                    <span className="nm">{o.name}</span>
                  </li>
                ),
              )
            )}
          </ul>
        )}
      </div>
    </MSheet>
  );
}
