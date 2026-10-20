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
 * 以 portal 掛到 body（理由同 MobileDatePick 檔頭：從 `.m-page` 裡開的面板會被 tab bar 壓住）。
 *
 * 也 export 路線小圓牌 `RouteRoundel`／路線色點 `RouteDot`，手機各元件共用（契約 §2.3 沒有另開 util 檔的位子）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { NodeRow } from "../../../domain";
import type { AttachTarget } from "../../../domain/notes";
import { roundelStyle } from "../../common/roundel";
import { useAttachOptions, type AttachKind, type AttachOption } from "../useAttachOptions";
import { useBackLayer, type BackKind } from "../../mobile/backStack";

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
  backKind?: BackKind;
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
}: MobileAttachPickerProps) {
  const { routes, loadTree } = useAttachOptions();
  const [routeId, setRouteId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [tree, setTree] = useState<AttachOption[] | null>(null);
  const [treeErr, setTreeErr] = useState(false);
  const [all, setAll] = useState<Map<string, AttachOption[]> | null>(null);
  const kindsKey = kinds ? kinds.join(",") : "";
  const listRef = useRef<HTMLDivElement>(null);

  const route = routeId ? (routes.find((r) => r.id === routeId) ?? null) : null;
  const q = query.trim().toLowerCase();

  const backToRoutes = () => {
    setRouteId(null);
    setQuery("");
  };
  // 磨光① 返回層：登記在挑選器自己身上（「‹ 路線」那一層只有這裡知道；呼叫端都是「開著才掛」，所以一直 active）。
  //   返回＝在第二層 ⇒ 同「‹ 路線」；在第一層 ⇒ 同「取消」
  useBackLayer("notes.attachPicker", true, () => (route ? backToRoutes() : onClose()), backKind);

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

  const crossHits = useMemo<CrossHit[]>(() => {
    if (depth !== "node" || routeId || !q || !all) return [];
    const out: CrossHit[] = [];
    for (const r of routes) {
      for (const opt of all.get(r.id) ?? []) {
        if (opt.selectable && opt.name.toLowerCase().includes(q)) out.push({ route: r, opt });
      }
    }
    return out;
  }, [depth, routeId, q, all, routes]);

  const treeHits = useMemo(() => {
    if (!tree) return null;
    if (!q) return tree;
    // 有字時只留命中的可選節點（群組頭的縮排脈絡沒了也無妨：右側寫種類）
    return tree.filter((o) => o.name.toLowerCase().includes(q));
  }, [tree, q]);

  const pickRoute = (r: NodeRow) => onPick({ routeId: r.id, nodeId: null, nodeKind: "route" }, { route: r.name, node: null });
  const pickNode = (r: NodeRow, o: AttachOption) =>
    onPick({ routeId: r.id, nodeId: o.id, nodeKind: o.kind }, { route: r.name, node: o.name });

  const isOnRoute = (r: NodeRow) => !!value && value.routeId === r.id && !value.nodeId;
  const isOnNode = (o: AttachOption) => !!value && value.nodeId === o.id;

  return createPortal(
    <div className="ns-notes-mveil is-top" role="presentation" onClick={onClose}>
      <div
        className={"ns-notes-mpick" + (depth === "node" ? " is-tall" : "")}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ns-notes-grip" aria-hidden />
        <div className="ns-notes-mpick-head">
          {route ? (
            <button
              type="button"
              className="ns-notes-mpick-back"
              onClick={backToRoutes}
            >
              ‹ 路線
            </button>
          ) : null}
          <p className="ns-notes-mpick-title">{route ? route.name : title}</p>
        </div>
        <div className="ns-notes-mpick-search">
          <input
            className="ns-notes-minput"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={
              route ? "搜尋這條路線的支線、列車、車廂…" : depth === "node" ? "搜尋路線、列車、車廂…" : "搜尋路線…"
            }
            aria-label="搜尋"
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="search"
          />
        </div>

        <div className="ns-notes-mpick-list" ref={listRef}>
          {!route ? (
            <ul className="ns-notes-mnodes">
              {routeHits.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    className={"ns-notes-mnode" + (isOnRoute(r) ? " on" : "")}
                    onClick={() => (depth === "route" ? pickRoute(r) : setRouteId(r.id))}
                  >
                    <RouteRoundel route={r} className="ns-notes-mroundel" />
                    <span className="nm">{r.name}</span>
                    {depth === "node" ? (
                      <span className="chev" aria-hidden>
                        ›
                      </span>
                    ) : (
                      <span className="path">路線</span>
                    )}
                  </button>
                </li>
              ))}
              {crossHits.map(({ route: r, opt }) => (
                <li key={opt.id}>
                  <button
                    type="button"
                    className={"ns-notes-mnode" + (isOnNode(opt) ? " on" : "")}
                    onClick={() => pickNode(r, opt)}
                  >
                    <span className="kind" style={{ color: r.color ?? "var(--route-none)" }} aria-hidden>
                      {KIND_GLYPH[opt.kind]}
                    </span>
                    <span className="nm">{opt.name}</span>
                    <span className="path">{r.name}</span>
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
                    className={"ns-notes-mnode is-whole" + (isOnRoute(route) ? " on" : "")}
                    onClick={() => pickRoute(route)}
                  >
                    <RouteRoundel route={route} className="ns-notes-mroundel" />
                    <span className="nm">整條路線</span>
                    <span className="path">只掛路線</span>
                  </button>
                </li>
              )}
              {treeErr ? (
                <li className="empty">讀不到這條路線的列車，請再試一次</li>
              ) : treeHits === null ? (
                <li className="empty">載入中…</li>
              ) : treeHits.length === 0 ? (
                <li className="empty">{q ? "找不到符合的列車或車廂" : "這條路線底下還沒有支線或列車"}</li>
              ) : (
                treeHits.map((o) =>
                  o.selectable ? (
                    <li key={o.id}>
                      <button
                        type="button"
                        className={"ns-notes-mnode" + (isOnNode(o) ? " on" : "")}
                        style={{ paddingLeft: `calc(var(--m-gutter) + ${q ? 0 : o.depth * 16}px)` }}
                        onClick={() => pickNode(route, o)}
                      >
                        <span className="kind" style={{ color: route.color ?? "var(--route-none)" }} aria-hidden>
                          {KIND_GLYPH[o.kind]}
                        </span>
                        <span className="nm">{o.name}</span>
                        <span className="path">{KIND_NAME[o.kind]}</span>
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

        <div className="ns-notes-mpick-foot">
          {onClear && (
            <button type="button" className="ns-notes-mbtn" onClick={onClear}>
              {clearLabel}
            </button>
          )}
          <button type="button" className="ns-notes-mbtn" onClick={onClose}>
            取消
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
