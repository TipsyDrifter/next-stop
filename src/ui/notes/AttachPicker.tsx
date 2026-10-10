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
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { NodeRow } from "../../domain";
import type { AttachTarget } from "../../domain/notes";
import { useAttachOptions, type AttachKind, type AttachOption } from "./useAttachOptions";
import { Roundel, rememberNodeName, usePopDismiss } from "./notesBits";

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

  const routeAllowed = !kinds; // 給了 kinds（例：只能掛列車／車廂）⇒ 路線本身不可選
  const expandedRoute = expanded ? (routes.find((r) => r.id === expanded) ?? null) : null;

  const rows: Row[] = useMemo(() => {
    if (!expandedRoute) {
      const out: Row[] = routes
        .filter((r) => !k || `${r.code ?? ""} ${r.name}`.toLowerCase().includes(k))
        .map((r) => ({ key: r.id, type: "route" as const, route: r, pick: depth === "route" }));
      if (depth === "node" && k && all) {
        for (const r of routes) {
          for (const opt of all.get(r.id) ?? []) {
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
    for (const opt of tree ?? []) {
      if (k && !opt.name.toLowerCase().includes(k)) continue;
      if (k && !opt.selectable) continue; // 搜尋時只列可選的，群組頭留給沒搜尋時的樹狀瀏覽
      out.push({ key: opt.id, type: "node", route: expandedRoute, opt });
    }
    return out;
  }, [expandedRoute, routes, k, depth, routeAllowed, tree, all]);

  /** 可以按的列（鍵盤 ↑↓ 只在這些列之間走） */
  const actionable = rows.filter((r) => r.type !== "node" || r.opt.selectable);
  const kbRow = actionable[Math.min(kb, actionable.length - 1)] ?? null;

  // 點進一條路線後，鍵盤游標預設落在第一個可選的（跳過「‹ 所有路線」那一列）
  useEffect(() => {
    setKb(expanded ? 1 : 0);
  }, [k, expanded]);

  const activate = (r: Row) => {
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

  const isCur = (r: Row): boolean => {
    if (r.type === "self") return !value.nodeId && value.routeId === r.route.id;
    if (r.type === "route") return depth === "route" && value.routeId === r.route.id;
    if (r.type === "node") return value.nodeId === r.opt.id;
    return false;
  };

  const placeholder = expandedRoute
    ? `在「${expandedRoute.name}」裡搜尋…`
    : depth === "route"
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
          <PickerRow key={r.key} row={r} kb={kbRow?.key === r.key} cur={isCur(r)} onPick={activate} />
        ))}
        {!expandedRoute && rows.length === 0 && (
          <li className="empty">
            {!routes.length ? "還沒有路線" : depth === "node" ? "找不到符合的路線、列車或車廂" : "找不到符合的路線"}
          </li>
        )}
        {expandedRoute && tree === null && <li className="empty">載入中…</li>}
        {expandedRoute && tree !== null && !rows.some((r) => r.type === "node" && r.opt.selectable) && (
          <li className="empty">
            {k ? "找不到符合的支線、列車或車廂" : kinds ? "這條路線還沒有列車或車廂" : "這條路線還沒有支線、列車或車廂"}
          </li>
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

function PickerRow({ row, kb, cur, onPick }: { row: Row; kb: boolean; cur: boolean; onPick(r: Row): void }) {
  const cls = [kb ? "kb" : "", cur ? "cur" : ""].filter(Boolean).join(" ");
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
            <span className="path">只掛路線</span>
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
