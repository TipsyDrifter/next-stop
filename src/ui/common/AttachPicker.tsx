/**
 * AttachPicker——「掛到哪」階層挑選器（桌機；車次①契約 §5.2、0-3 乙案、D-筆-6／26）。
 *
 * 兩檔深度：
 *   depth="route"：只有第一層路線（收件匣「掛上路線」）。
 *   depth="node" ：第一層路線，點進一條路線後列它的支線／列車／車廂（縮排）。
 *                  可不可以「只掛路線本身」由 kinds 決定：沒給 kinds＝路線、支線、列車、車廂都可選
 *                  （預覽框、筆記內容欄）；給了 kinds（收件匣「掛進列車」＝["train","car"]）＝路線本身不可選，
 *                  樹裡不在 kinds 的種類灰字當群組頭。
 * 頂部搜尋框過濾名稱（D-筆-6「用搜尋挑節點」）：第一層濾路線代碼與名稱；depth="node" 時第一層有字另把**所有路線**的
 * 可選節點一起比對列出（跨路線直接挑，與手機 MobileAttachPicker 同；整合席補）；點進路線後濾該路線的節點名。
 * 鍵盤：搜尋框裡 ↑↓ 移動、Enter 選、Esc 收起（自理並 stopPropagation，不讓頁面／預覽框的 Esc 一次關兩層）。
 *
 * 資料來自 useAttachOptions（與手機共用，畫面各寫）；挑到的節點名記進 notesBits 的快取給欄位鈕顯示。
 *
 * 磨光⑤ B1「移動到…」借用本元件（主線代改）：給 `excludeId` ＝搬遷模式——樹裡藏掉自己與整個子樹、
 * 只留挑得到的種類與它們的群組頭；`currentNote`（「目前位置」）讓目前所在的父節點標出來、不可選；
 * `routeSelectable` 讓「給了 kinds 但路線本身也能挑」（搬列車＝路線或支線）。三個都不給＝原本的行為。
 *
 * ── UI 丙-2 搬家（契約 §1 #18；2026-10-22）──
 * 用途：「掛到哪」階層挑選器（桌機），旅客筆記收件匣、筆記內容欄、變待辦預覽、側板「移動到…」共用。
 * 規範：視覺規範 §2.4（錨定 popover：挑路線／節點）、§2.10（選中 .cur／鍵盤游標 .kb＝--sel-bg）。
 * ARIA：根 role=dialog＋aria-label＝小標；清單 role=listbox，可選列 role=option＋aria-selected；「目前位置」列 aria-disabled＋disabled。
 * 鍵盤：見上（搜尋框 ↑↓／Enter／Esc／空字 Backspace 退回第一層）；Esc stopPropagation，不連關外層。
 * 樣式：本元件專屬規則（輸入框寬、清單列、腳列、目前位置）在 common/attachpicker.css（src/index.css 集中 @import）；
 *   浮層殼 .ns-notes-pop／小標 .ns-notes-poplabel／清除鈕 .ns-notes-chip 與旅客筆記的 DatePop 等共用，仍在 notes/notes.css。
 *   原路徑 notes/AttachPicker.tsx 只剩 re-export（呼叫端 import 不動，丙-3～6 再改）。
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { NodeRow } from "../../domain";
import type { AttachTarget } from "../../domain/notes";
import { excludeSubtree, pruneToSelectable } from "../../domain/moveTo";
import { useAttachOptions, type AttachKind, type AttachOption } from "../notes/useAttachOptions";
import { Roundel, rememberNodeName, usePopDismiss } from "../notes/notesBits";

export interface AttachPickerProps {
  depth: "route" | "node";
  kinds?: AttachKind[];
  value: AttachTarget;
  onPick(t: AttachTarget): void;
  onClear?(): void;
  /** 清除鈕的字（筆記內容欄＝「摘掉」） */
  clearLabel?: string;
  onClose(): void;
  /** 浮層上方的小標（如「掛進哪一班列車或車廂」） */
  label: string;
  /** true＝浮在內容上（position:absolute）；false＝接在去處列下方的內嵌版 */
  float?: boolean;
  /** 搬遷模式（磨光⑤ B1）：不列這個節點與它的整個子樹，樹只留挑得到的列與其群組頭 */
  excludeId?: string;
  /** 路線本身能不能選；省略＝沒給 kinds 才能選（原本的規則） */
  routeSelectable?: boolean;
  /** 有給＝`value` 那一列標這個字（「目前位置」）、不可選 */
  currentNote?: string;
}

const KIND_GLYPH: Record<AttachKind, string> = { branch: "支", train: "列", car: "廂" };

type Row =
  | { key: string; type: "back" }
  | { key: string; type: "route"; route: NodeRow; pick: boolean }
  | { key: string; type: "self"; route: NodeRow }
  | { key: string; type: "node"; route: NodeRow; opt: AttachOption; cross?: boolean };

export function AttachPicker({
  depth,
  kinds,
  value,
  onPick,
  onClear,
  clearLabel = "清除",
  onClose,
  label,
  float = false,
  excludeId,
  routeSelectable,
  currentNote,
}: AttachPickerProps) {
  const { routes, loadTree } = useAttachOptions();
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [expanded, setExpanded] = useState<string | null>(
    depth === "node" && value.routeId && routes.some((r) => r.id === value.routeId) ? value.routeId : null,
  );
  const [tree, setTree] = useState<AttachOption[] | null>(null);
  /** 第一層跨路線搜尋用：第一次打字才把所有路線的樹載進來（路線數通常個位數） */
  const [all, setAll] = useState<Map<string, AttachOption[]> | null>(null);
  const [kb, setKb] = useState(0);
  const kindsKey = kinds?.join(",") ?? "";

  usePopDismiss(rootRef, onClose);

  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
    rootRef.current?.scrollIntoView({ block: "nearest" }); // 收件匣末端那一張開浮層時，浮層別落在視野外
  }, []);

  useEffect(() => {
    if (!expanded) {
      setTree(null);
      return;
    }
    let alive = true;
    setTree(null);
    loadTree(expanded, kindsKey ? (kindsKey.split(",") as AttachKind[]) : undefined)
      .then((opts) => {
        if (!alive) return;
        for (const o of opts) rememberNodeName(o.id, o.name);
        setTree(opts);
      })
      .catch((e: unknown) => {
        console.warn("AttachPicker：載入路線樹失敗", e);
        if (alive) setTree([]);
      });
    return () => {
      alive = false;
    };
  }, [expanded, kindsKey, loadTree]);

  const k = q.trim().toLowerCase();

  useEffect(() => {
    if (depth !== "node" || expanded || !k || all) return;
    let alive = true;
    const ks = kindsKey ? (kindsKey.split(",") as AttachKind[]) : undefined;
    Promise.all(routes.map((r) => loadTree(r.id, ks).then((opts) => [r.id, opts] as const)))
      .then((pairs) => {
        if (!alive) return;
        for (const [, opts] of pairs) for (const o of opts) rememberNodeName(o.id, o.name);
        setAll(new Map(pairs));
      })
      .catch((e: unknown) => console.warn("AttachPicker：跨路線搜尋載入失敗", e));
    return () => {
      alive = false;
    };
  }, [depth, expanded, k, all, routes, kindsKey, loadTree]);

  // 給了 kinds（例：只能掛列車／車廂）⇒ 路線本身預設不可選；搬遷模式另由 routeSelectable 指定（搬列車＝路線或支線）
  const routeAllowed = routeSelectable ?? !kinds;
  const expandedRoute = expanded ? (routes.find((r) => r.id === expanded) ?? null) : null;
  /** 搬遷模式（磨光⑤ B1）：藏掉自己與子樹、只留挑得到的列與其群組頭；其他用處原樣 */
  const moving = excludeId !== undefined;
  const shownTree = useMemo(
    () => (tree && moving ? pruneToSelectable(excludeSubtree(tree, excludeId)) : tree),
    [tree, moving, excludeId],
  );

  const rows: Row[] = useMemo(() => {
    if (!expandedRoute) {
      const out: Row[] = routes
        .filter((r) => !k || `${r.code ?? ""} ${r.name}`.toLowerCase().includes(k))
        .map((r) => ({ key: r.id, type: "route" as const, route: r, pick: depth === "route" }));
      if (depth === "node" && k && all) {
        for (const r of routes) {
          for (const opt of moving ? excludeSubtree(all.get(r.id) ?? [], excludeId) : (all.get(r.id) ?? [])) {
            if (opt.selectable && opt.name.toLowerCase().includes(k)) {
              out.push({ key: `x:${opt.id}`, type: "node", route: r, opt, cross: true });
            }
          }
        }
      }
      return out;
    }
    const out: Row[] = [{ key: "$back", type: "back" }];
    if (routeAllowed && (!k || `${expandedRoute.code ?? ""} ${expandedRoute.name}`.toLowerCase().includes(k))) {
      out.push({ key: "$self", type: "self", route: expandedRoute });
    }
    for (const opt of shownTree ?? []) {
      if (k && !opt.name.toLowerCase().includes(k)) continue;
      if (k && !opt.selectable) continue; // 搜尋時只列可選的，群組頭留給沒搜尋時的樹狀瀏覽
      out.push({ key: opt.id, type: "node", route: expandedRoute, opt });
    }
    return out;
  }, [expandedRoute, routes, k, depth, routeAllowed, shownTree, all, moving, excludeId]);

  const isCur = (r: Row): boolean => {
    if (r.type === "self") return !value.nodeId && value.routeId === r.route.id;
    if (r.type === "route") return depth === "route" && value.routeId === r.route.id;
    if (r.type === "node") return value.nodeId === r.opt.id;
    return false;
  };
  /** 「目前位置」那一列（磨光⑤ B1）：標出來、不可選、鍵盤游標跳過 */
  const isLocked = (r: Row): boolean => !!currentNote && value.nodeKind !== null && isCur(r);

  /** 可以按的列（鍵盤 ↑↓ 只在這些列之間走） */
  const actionable = rows.filter((r) => (r.type !== "node" || r.opt.selectable) && !isLocked(r));
  const kbRow = actionable[Math.min(kb, actionable.length - 1)] ?? null;

  // 點進一條路線後，鍵盤游標預設落在第一個可選的（跳過「‹ 所有路線」那一列）
  useEffect(() => {
    setKb(expanded ? 1 : 0);
  }, [k, expanded]);

  const activate = (r: Row) => {
    if (isLocked(r)) return;
    switch (r.type) {
      case "back":
        setExpanded(null);
        setQ("");
        inputRef.current?.focus({ preventScroll: true });
        return;
      case "route":
        if (r.pick) onPick({ routeId: r.route.id, nodeId: null, nodeKind: "route" });
        else {
          setExpanded(r.route.id);
          setQ("");
          inputRef.current?.focus({ preventScroll: true });
        }
        return;
      case "self":
        onPick({ routeId: r.route.id, nodeId: null, nodeKind: "route" });
        return;
      case "node":
        if (!r.opt.selectable) return;
        rememberNodeName(r.opt.id, r.opt.name);
        onPick({ routeId: r.route.id, nodeId: r.opt.id, nodeKind: r.opt.kind });
        return;
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      if (!actionable.length) return;
      setKb((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + actionable.length) % actionable.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      if (kbRow) activate(kbRow);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === "Backspace" && !q && expanded && depth === "node") {
      e.preventDefault();
      setExpanded(null);
    }
  };

  const placeholder = expandedRoute
    ? `在「${expandedRoute.name}」裡搜尋…`
    : depth === "route" || moving
      ? "搜尋路線…"
      : "搜尋路線…（點進去挑列車、車廂）";

  return (
    <div
      ref={rootRef}
      className={`ns-notes-pop${float ? " float" : ""}`}
      role="dialog"
      aria-label={label}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="ns-notes-poplabel">{label}</div>
      <input
        ref={inputRef}
        className="techo-input ns-notes-input"
        value={q}
        placeholder={placeholder}
        aria-label={placeholder}
        autoComplete="off"
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <ul className="ns-notes-nodelist" role="listbox" aria-label={label}>
        {rows.map((r) => (
          <PickerRow
            key={r.key}
            row={r}
            kb={kbRow?.key === r.key}
            cur={isCur(r)}
            locked={isLocked(r) ? currentNote : undefined}
            selfNote={moving ? "路線底下" : undefined}
            onPick={activate}
          />
        ))}
        {!expandedRoute && rows.length === 0 && (
          <li className="empty">
            {!routes.length ? "還沒有路線" : depth === "node" ? "找不到符合的路線、列車或車廂" : "找不到符合的路線"}
          </li>
        )}
        {expandedRoute && tree === null && <li className="empty">載入中…</li>}
        {expandedRoute && tree !== null && !moving && !rows.some((r) => r.type === "node" && r.opt.selectable) && (
          <li className="empty">
            {k ? "找不到符合的支線、列車或車廂" : kinds ? "這條路線還沒有列車或車廂" : "這條路線還沒有支線、列車或車廂"}
          </li>
        )}
        {/* 搬遷模式：只在整條路線一個能挑的都沒有時才說（列車搬到路線本身那一列還在，就不多一句） */}
        {expandedRoute && tree !== null && moving && !rows.some((r) => r.type !== "back" && !isLocked(r) && (r.type !== "node" || r.opt.selectable)) && (
          <li className="empty">{k ? "找不到符合的地方" : "這條路線沒有可以放的地方"}</li>
        )}
      </ul>
      {onClear && (value.routeId || value.nodeId) && (
        <div className="ns-notes-popfoot">
          <button type="button" className="ns-notes-chip" onClick={onClear}>
            {clearLabel}
          </button>
        </div>
      )}
    </div>
  );
}

function PickerRow({
  row,
  kb,
  cur,
  locked,
  selfNote = "只掛路線",
  onPick,
}: {
  row: Row;
  kb: boolean;
  cur: boolean;
  /** 「目前位置」（磨光⑤ B1）：有給＝這列不可選、右側寫這個字 */
  locked?: string;
  /** 「整條路線」那一列右側的字（搬遷模式＝「路線底下」） */
  selfNote?: string;
  onPick(r: Row): void;
}) {
  const cls = [kb ? "kb" : "", cur ? "cur" : ""].filter(Boolean).join(" ");
  if (locked && row.type !== "back") {
    const name = row.type === "node" ? row.opt.name : row.route.name;
    const indent = row.type === "node" ? { paddingLeft: 6 + (row.cross ? 0 : row.opt.depth * 16) } : undefined;
    return (
      <li>
        <button type="button" className="locked" style={indent} role="option" aria-selected={false} aria-disabled disabled>
          {row.type === "node" ? (
            <span className="kind" style={{ color: row.route.color ?? "var(--route-none)" }}>
              {KIND_GLYPH[row.opt.kind]}
            </span>
          ) : (
            <Roundel route={row.route} />
          )}
          <span className="nm">{name}</span>
          <span className="path">{locked}</span>
        </button>
      </li>
    );
  }
  switch (row.type) {
    case "back":
      return (
        <li>
          <button type="button" className={`back ${cls}`} onClick={() => onPick(row)}>
            ‹ 所有路線
          </button>
        </li>
      );
    case "route":
      return (
        <li>
          <button type="button" className={cls} role="option" aria-selected={cur} onClick={() => onPick(row)}>
            <Roundel route={row.route} />
            <span className="nm">{row.route.name}</span>
            {!row.pick && <span className="path">›</span>}
          </button>
        </li>
      );
    case "self":
      return (
        <li>
          <button type="button" className={cls} role="option" aria-selected={cur} onClick={() => onPick(row)}>
            <Roundel route={row.route} />
            <span className="nm">{row.route.name}</span>
            <span className="path">{selfNote}</span>
          </button>
        </li>
      );
    case "node": {
      const { opt, route, cross } = row;
      const glyph = (
        <span className="kind" style={{ color: route.color ?? "var(--route-none)" }}>
          {KIND_GLYPH[opt.kind]}
        </span>
      );
      const indent = { paddingLeft: 6 + (cross ? 0 : opt.depth * 16) };
      if (!opt.selectable) {
        return (
          <li>
            <span className="grp" style={indent}>
              {glyph}
              <span className="nm">{opt.name}</span>
            </span>
          </li>
        );
      }
      return (
        <li>
          <button type="button" className={cls} style={indent} role="option" aria-selected={cur} onClick={() => onPick(row)}>
            {glyph}
            <span className="nm">{opt.name}</span>
            {cross && <span className="path">{route.name}</span>}
          </button>
        </li>
      );
    }
  }
}
