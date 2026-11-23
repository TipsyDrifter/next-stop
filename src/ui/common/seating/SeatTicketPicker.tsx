/**
 * SeatTicketPicker——第四梯 4C（D-FB-7）Mode B「待辦車票入座頂替」共用流程與雙端挑選器。
 *
 * 支援：
 *   - 桌機 `DesktopSeatPicker`（錨定 `.techo-card` 浮層：搜尋＋期間自由券／今日／收件匣／路線待辦清單，↑↓／Enter／Esc 鍵盤閉環）
 *   - 手機 `MobileSeatSheet`（`MSheet` 底部面板，完整遵守 `backId`／`backKind` 返回層契約）
 *   - `seatTicketFlow`／`releaseSeatedFlow`（統一呼叫 `nodeStore` 並附可反悔「復原」Toast）
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import type { NodeRow } from "../../../domain";
import { formatDateRangeBadge, isRangeTicket } from "../../../domain/dateRange";
import { nodeRepo } from "../../../data";
import { useNodeStore } from "../../../store/nodeStore";
import { useUiStore } from "../../../store/uiStore";
import { placeBelow, useOutsideDismiss } from "../anchorPop";
import { MSheet, MSheetItem } from "../MSheet";
import { RouteRoundel } from "../MobileAttachPicker";
import { lengthText } from "../quickadd/quickAddModel";
import {
  canActAsSeatSlot,
  canBeSeatedCandidate,
  formatRunOriginText,
  formatSeatBadgeText,
} from "./seatRules";
import "./flexible-seating.css";

export { canActAsSeatSlot, canBeSeatedCandidate, formatRunOriginText, formatSeatBadgeText };

/** 配對待辦入座（附「復原」Toast） */
export async function seatTicketFlow(
  slotNodeId: string,
  dueOn: string,
  ticketId: string,
  slotLabel?: string,
): Promise<boolean> {
  const r = await useNodeStore.getState().seatTicketIntoSlot(slotNodeId, dueOn, ticketId);
  if (!r.ok) return false;
  useUiStore.getState().showToast({
    message: `已入座「${slotLabel ?? "預留席"}」`,
    actionLabel: "復原",
    onAction: () => void useNodeStore.getState().releaseSeatedSlot(slotNodeId, dueOn),
  });
  return true;
}

/** 釋出預留席（附「復原」Toast） */
export async function releaseSeatedFlow(
  slotNodeId: string,
  dueOn: string,
  ticketId?: string,
): Promise<boolean> {
  const r = await useNodeStore.getState().releaseSeatedSlot(slotNodeId, dueOn);
  if (!r.ok) return false;
  useUiStore.getState().showToast({
    message: "已釋出預留席",
    ...(ticketId
      ? {
          actionLabel: "復原",
          onAction: () => void useNodeStore.getState().seatTicketIntoSlot(slotNodeId, dueOn, ticketId),
        }
      : {}),
  });
  return true;
}

interface CandidateItem {
  node: NodeRow;
  route: NodeRow | undefined;
  hint: string;
}

function useSeatCandidates(slotId: string, query: string): CandidateItem[] {
  const todayRows = useNodeStore((s) => s.today.rows);
  const rangeTickets = useNodeStore((s) => s.rangeTickets);
  const treeById = useNodeStore((s) => s.tree.byId);
  const routes = useNodeStore((s) => s.routes);
  const runOverrides = useNodeStore((s) => s.runOverrides);
  const [extraNodes, setExtraNodes] = useState<NodeRow[]>([]);

  useEffect(() => {
    let alive = true;
    const q = query.trim();
    const run = async () => {
      if (q) {
        const hits = await nodeRepo.search(q, 40).catch(() => [] as NodeRow[]);
        if (alive) setExtraNodes(hits);
        return;
      }
      const inbox = await nodeRepo.listInboxTickets().catch(() => [] as NodeRow[]);
      if (alive) setExtraNodes(inbox);
    };
    void run();
    return () => {
      alive = false;
    };
  }, [query]);

  return useMemo(() => {
    const seatedSet = new Set<string>();
    for (const o of runOverrides) {
      if (!o.deleted_at && o.seated_node_id) seatedSet.add(o.seated_node_id);
    }
    const seen = new Set<string>();
    const out: CandidateItem[] = [];
    const qLower = query.trim().toLowerCase();

    const push = (n: NodeRow, defaultHint: string) => {
      if (seen.has(n.id)) return;
      if (!canBeSeatedCandidate(n, slotId, seatedSet)) return;
      const route = n.route_id ? routes.find((r) => r.id === n.route_id) : undefined;
      if (qLower) {
        const matchName = n.name.toLowerCase().includes(qLower);
        const matchRoute = route?.name.toLowerCase().includes(qLower) ?? false;
        if (!matchName && !matchRoute) return;
      }
      seen.add(n.id);
      let hint = defaultHint;
      if (isRangeTicket(n) && n.scheduled_on) {
        hint = `期間 ${formatDateRangeBadge(n.scheduled_on, n.scheduled_end)}`;
      } else if (n.estimate_min && n.estimate_min > 0) {
        hint = `${defaultHint ? `${defaultHint} · ` : ""}${lengthText(n.estimate_min)}`;
      }
      out.push({ node: n, route, hint });
    };

    for (const r of rangeTickets) push(r, "期間自由券");
    for (const r of todayRows) {
      if (!r.seated_into) push(r, r.bucket === "today" ? "今日" : "誤點");
    }
    for (const n of extraNodes) push(n, n.scheduled_on ? n.scheduled_on.slice(5).replace("-", "/") : "收件匣");
    for (const n of Object.values(treeById)) push(n, "目前路線");

    return out.slice(0, 40);
  }, [slotId, query, rangeTickets, todayRows, extraNodes, treeById, routes, runOverrides]);
}

export interface DesktopSeatPickerProps {
  slotId: string;
  slotName: string;
  dueOn: string;
  anchor: HTMLElement | null;
  onClose(): void;
}

export function DesktopSeatPicker({ slotId, slotName, dueOn, anchor, onClose }: DesktopSeatPickerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useOutsideDismiss(rootRef, onClose, anchor);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const items = useSeatCandidates(slotId, query);

  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const place = useCallback(() => {
    const el = rootRef.current;
    if (!el) return;
    if (!anchor) {
      const vw = document.documentElement.clientWidth || window.innerWidth;
      const vh = document.documentElement.clientHeight || window.innerHeight;
      setPos({ top: Math.round(vh * 0.22), left: Math.round((vw - el.offsetWidth) / 2) });
      return;
    }
    setPos(placeBelow(anchor, el) ?? { top: 16, left: 16 });
  }, [anchor]);
  useLayoutEffect(place, [place, items.length]);

  useEffect(() => {
    if (!pos) return;
    inputRef.current?.focus({ preventScroll: true });
  }, [pos]);

  useEffect(() => {
    setCursor(0);
  }, [query]);

  const pick = (ticketId: string) => {
    onClose();
    void seatTicketFlow(slotId, dueOn, ticketId, slotName);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "ArrowDown" && items.length > 0) {
      e.preventDefault();
      setCursor((c) => (c + 1) % items.length);
    } else if (e.key === "ArrowUp" && items.length > 0) {
      e.preventDefault();
      setCursor((c) => (c - 1 + items.length) % items.length);
    } else if (e.key === "Enter" && items[cursor]) {
      e.preventDefault();
      pick(items[cursor].node.id);
    }
  };

  const card = (
    <div
      ref={rootRef}
      role="dialog"
      aria-label={`配對待辦入座「${slotName}」`}
      className="ns-seat-pop ns-qa-pop techo-card"
      style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? "visible" : "hidden" }}
      onKeyDown={onKeyDown}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <p className="techo-overline ns-seat-pop-head">待辦入座 — SEAT INTO「{slotName}」</p>
      <input
        ref={inputRef}
        type="text"
        className="ns-seat-pop-search"
        placeholder="搜尋車票名稱或路線…"
        aria-label="搜尋待入座車票"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {items.length === 0 ? (
        <p className="ns-seat-pop-empty">沒有符合的可入座車票</p>
      ) : (
        <ul className="ns-seat-pop-list" role="listbox" aria-label="可入座車票清單">
          {items.map((it, i) => (
            <li key={it.node.id}>
              <button
                type="button"
                role="option"
                aria-selected={i === cursor}
                className="ns-seat-pop-item"
                style={i === cursor ? { background: "var(--sel-bg)", color: "var(--sel-fg)" } : undefined}
                onMouseEnter={() => setCursor(i)}
                onClick={() => pick(it.node.id)}
              >
                {it.route ? <RouteRoundel route={it.route} /> : <span className="ns-ph-tag">臨</span>}
                <span className="nm">{it.node.name}</span>
                {it.hint && <span className="sub">{it.hint}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="techo-foot ns-seat-pop-foot">↑↓ 選擇 · Enter 入座 · Esc 關閉</div>
    </div>
  );

  return createPortal(card, document.body);
}

export interface MobileSeatSheetProps {
  slotId: string;
  slotName: string;
  dueOn: string;
  backId: string;
  backKind?: "sheet" | "dialog";
  onClose(): void;
}

export function MobileSeatSheet({
  slotId,
  slotName,
  dueOn,
  backId,
  backKind = "sheet",
  onClose,
}: MobileSeatSheetProps) {
  const [query, setQuery] = useState("");
  const items = useSeatCandidates(slotId, query);

  return (
    <MSheet list title="配對待辦入座" overline={`${slotName} · ${dueOn.slice(5).replace("-", "/")}`} backId={backId} backKind={backKind} onClose={onClose}>
      <div className="ns-seat-msearch-wrap">
        <input
          type="text"
          className="ns-seat-msearch"
          placeholder="搜尋待辦車票…"
          aria-label="搜尋待入座車票"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {items.length === 0 ? (
        <p className="ns-seat-pop-empty">沒有符合的可入座車票</p>
      ) : (
        items.map((it) => (
          <MSheetItem
            key={it.node.id}
            onClick={() => {
              onClose();
              void seatTicketFlow(slotId, dueOn, it.node.id, slotName);
            }}
          >
            <span>{it.node.name}</span>
            <span className="m-tks-aside">
              {it.route ? `${it.route.name}${it.hint ? ` · ${it.hint}` : ""}` : it.hint}
            </span>
          </MSheetItem>
        ))
      )}
    </MSheet>
  );
}
