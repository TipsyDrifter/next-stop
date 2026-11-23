/**
 * InlineTicketEditor——既有車票／列車的原地行內編輯器（TICKET-1B 需求三）。
 *
 * 雙擊項目列（或點擊列上的時間／締切／優先級徽章）即可原地展開：
 *   - 上排：QuickField（支援標題修改＋快速語法如「明天 14:00 30分 〆週五 !高 #荷札」）＋儲存／取消提示
 *   - 下排：QuickChips（［掛到］［乘車日］［幾點］［締切］［＝同乘車日］［優先］［#荷札］）＋QuickPickers 原地挑選器
 *   - Enter 儲存並關閉、Ctrl+Enter 儲存並可接續下一筆、Esc 取消、點去別處自動儲存並關閉
 * 不必打開右側詳情抽屜即可完成日常編輯。
 *
 * v1.31 D-1.31-5：補上建票列有、這裡獨缺的「掛到」膠囊——初值＝目前所在（路線／支線／列車／車廂；臨時車票＝路線標籤或無路線），
 *   挑選器是改掛專用的 ReattachPicker（能挑的種類照側板「移動到…」那把尺、藏掉自己與子樹、目前位置不可點；車票多一個「無路線」）。
 *   跟其他膠囊同一個節奏：挑了先亮在膠囊上，按 Enter／點外面存檔時才真的搬（toast 附「復原」），Esc 取消就不搬。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import { tagRepo } from "../../../data/tagRepo";
import type { NodeRow } from "../../../domain";
import { moveTargetRule } from "../../../domain/moveTo";
import type { AttachTarget } from "../../../domain/notes";
import { useNodeStore } from "../../../store/nodeStore";
import { useSelectionStore } from "../../../store/selectionStore";
import { useTagStore } from "../../../store/tagStore";
import type { AttachKind } from "../../notes/useAttachOptions";
import type { CommitVia } from "../InlineInput";
import { QuickChips, QuickField } from "./QuickAddParts";
import { QuickPickers } from "./QuickAddPickers";
import { NO_DEST, type QuickChipKey, type QuickDest } from "./quickAddModel";
import { ReattachPicker, canReattach, currentDestOf, guessDestOf, reattachTo, sameDest } from "./reattach";
import { useQuickAdd } from "./useQuickAdd";
import "./quickadd.css";

export interface InlineTicketEditorProps {
  node: NodeRow;
  /** 點擊某顆徽章直接進來時，自動展開對應挑選器 */
  initialPicker?: Exclude<QuickChipKey, "dest"> | null;
  /** 儲存或取消後收起行內編輯 */
  onClose(): void;
  /** Ctrl+Enter 儲存後（例如大綱列連續新增下一列） */
  onCommitNext?(): void;
  /** 緊湊版（如 DayRow） */
  compact?: boolean;
}

export function InlineTicketEditor({
  node,
  initialPicker = null,
  onClose,
  onCommitNext,
  compact = false,
}: InlineTicketEditorProps) {
  const [initialTags, setInitialTags] = useState<readonly string[]>([]);
  useEffect(() => {
    let alive = true;
    tagRepo
      .listTagsOf("node", node.id)
      .then((rows) => {
        if (alive) setInitialTags(rows.map((r) => r.name));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [node.id]);

  /** 「掛到」的初值＝目前所在（先同步粗估、再問父節點種類換成準的；v1.31 D-1.31-5） */
  const movable = canReattach(node.kind);
  const [hereDest, setHereDest] = useState<AttachTarget>(() => guessDestOf(node));
  useEffect(() => {
    if (!movable) return;
    let alive = true;
    void currentDestOf(node).then((d) => {
      if (alive) setHereDest(d);
    });
    return () => {
      alive = false;
    };
    // 只看這個節點與它的位置
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [movable, node.id, node.parent_id, node.route_id]);

  const defaults = useMemo(
    () => ({
      dest: movable ? (hereDest as QuickDest) : NO_DEST,
      stationId: node.station_id,
      scheduledOn: node.scheduled_on,
      scheduledEnd: node.scheduled_end,
      scheduledTime: node.scheduled_time,
      estimateMin: node.estimate_min,
      dueOn: node.due_on,
      priority: node.priority,
      tags: initialTags,
      noDateLabel: false,
    }),
    [
      movable,
      hereDest,
      node.station_id,
      node.scheduled_on,
      node.scheduled_end,
      node.scheduled_time,
      node.estimate_min,
      node.due_on,
      node.priority,
      initialTags,
    ],
  );

  const moveRule = useMemo(() => moveTargetRule(node.kind), [node.kind]);
  const wasPlaceholder = Boolean(node.is_placeholder);

  const api = useQuickAdd({
    defaults,
    inlineEdit: {
      kind: node.kind,
      allowDest: movable,
      excludeId: node.id,
      allowedDestKinds: moveRule?.depth === "node" ? (moveRule.kinds as AttachKind[]) : undefined,
      routeSelectable: moveRule ? (moveRule.routeSelectable ?? moveRule.depth === "route") : false,
    },
    initialText: wasPlaceholder ? "" : node.name,
    initialSyncDue: Boolean(
      node.due_on &&
        node.scheduled_on &&
        (node.due_on === (node.scheduled_end ?? node.scheduled_on) || node.due_on === node.scheduled_on),
    ),
    here: { kind: "none" },
  });

  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState<{ key: QuickChipKey; anchor: HTMLElement } | null>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const savingRef = useRef(false);
  const outsidePressAtRef = useRef(0);

  const refocus = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  // 操作 3（互斥）：開啟雙擊行內編輯時，自動退出多選
  useEffect(() => {
    if (useSelectionStore.getState().ids.length) useSelectionStore.getState().clear();
  }, []);

  // 記錄子浮層開啟期間最後一次指標按下是否落在整個行內編輯框＋浮層之外
  useEffect(() => {
    if (!open) {
      outsidePressAtRef.current = 0;
      return;
    }
    const onDown = (e: PointerEvent | MouseEvent) => {
      const t = e.target;
      outsidePressAtRef.current = t instanceof Element && !isInside(t, rootRef.current) ? Date.now() : 0;
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("mousedown", onDown, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("mousedown", onDown, true);
    };
  }, [open]);

  useEffect(() => {
    const el = inputRef.current;
    if (el) {
      el.focus({ preventScroll: true });
      el.select();
    }
    if (initialPicker && rootRef.current) {
      const chipEl = rootRef.current.querySelector<HTMLElement>(`[data-chip="${initialPicker}"]`);
      if (chipEl) setOpen({ key: initialPicker, anchor: chipEl });
    }
  }, [initialPicker]);

  const live = useRef({ api, node, onClose, onCommitNext, hereDest, movable });
  live.current = { api, node, onClose, onCommitNext, hereDest, movable };

  const saveAndClose = async (via: CommitVia) => {
    if (savingRef.current) return;
    savingRef.current = true;
    try {
      const { api: a, node: n, onClose: close, onCommitNext: next, hereDest: here, movable: canMove } = live.current;
      const v = a.values;
      const typedName = v.name.trim();
      const name = typedName || n.name;
      const promotePlaceholder = Boolean(n.is_placeholder) && Boolean(typedName);
      // 掛到（v1.31）：膠囊改過、而且真的換了地方才搬（moveNodeTo 自己出 toast＋復原）；先搬再寫欄位，避免換路線時洗掉剛選的新車站
      const needMove = canMove && v.on.has("dest") && !sameDest(v.dest, here);
      const moved = needMove ? await reattachTo(n, v.dest.routeId ? { routeId: v.dest.routeId, nodeId: v.dest.nodeId } : null) : true;
      await useNodeStore.getState().updateNode(n.id, {
        name,
        ...(promotePlaceholder ? { is_placeholder: null } : {}),
        station_id: needMove && !moved ? n.station_id : v.stationId,
        scheduled_on: v.scheduledOn,
        scheduled_end: v.scheduledEnd,
        scheduled_time: v.scheduledTime,
        estimate_min: v.estimateMin,
        due_on: v.dueOn,
        priority: v.priority ?? undefined,
      });
      if (v.on.has("tags")) {
        await tagRepo.setTags("node", n.id, v.tags);
        await useTagStore.getState().loadIndex();
      }
      close();
      if (via === "ctrl-enter") next?.();
    } finally {
      savingRef.current = false;
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.nativeEvent.isComposing || e.keyCode === 229 || api.composing) return;
    if (api.isSubmitKey(e)) {
      e.preventDefault();
      void saveAndClose(e.ctrlKey || e.metaKey ? "ctrl-enter" : "enter");
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  const onBlur = (e: FocusEvent<HTMLElement>) => {
    const to = e.relatedTarget;
    if (to instanceof Element && isInside(to, rootRef.current)) return;
    setTimeout(() => {
      const root = rootRef.current;
      if (!root?.isConnected) return;
      if (!document.hasFocus()) return;
      if (openRef.current) return;
      const a = document.activeElement;
      if (a instanceof Element && isInside(a, root)) return;
      void saveAndClose("blur");
    }, 60);
  };

  const handlePickerDismiss = () => {
    const clickedOutside = Date.now() - outsidePressAtRef.current < 400;
    outsidePressAtRef.current = 0;
    openRef.current = null;
    setOpen(null);
    if (clickedOutside) {
      window.setTimeout(() => {
        const root = rootRef.current;
        if (!root?.isConnected || !document.hasFocus() || openRef.current) return;
        const a = document.activeElement;
        if (a instanceof Element && isInside(a, root)) return;
        void saveAndClose("blur");
      }, 60);
      return;
    }
    window.setTimeout(() => {
      const a = document.activeElement;
      if (!a || a === document.body) refocus();
    }, 0);
  };

  return (
    <div
      ref={rootRef}
      className={`ns-qa-inline${compact ? " is-compact" : ""}`}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      onBlur={onBlur}
    >
      <div className="ns-qa-inline-top">
        <QuickField
          api={api}
          inputRef={inputRef}
          placeholder={
            wasPlaceholder
              ? `填入具體內容（目前預留：${node.name}）…`
              : compact
                ? "車票名稱…（@ # 本週 =）"
                : "車票名稱…（可打 @路線 #荷札 14:00-15:30 10/2~10/4 =）"
          }
          ariaLabel="行內編輯：名稱與快速語法"
          onKeyDown={onKeyDown}
        />
      </div>
      <QuickChips
        api={api}
        hideDest={!movable}
        hideRouteKind
        destTitle="改掛到別的路線、支線或列車（存檔時才搬）"
        noDateLabel={false}
        open={open?.key ?? null}
        keepFocus
        onOpen={(key, anchor) => setOpen((cur) => (cur?.key === key ? null : { key, anchor }))}
        trailing={
          <span
            className="ns-qa-inline-hint"
            aria-hidden
            title="Enter 儲存 · Ctrl+Enter 儲存並換下一筆 · 點外面自動儲存 · Esc 取消"
          >
            {compact ? "Esc 取消" : "Enter 儲存 · Esc 取消"}
          </span>
        }
      />
      <QuickPickers
        api={api}
        open={open && open.key !== "dest" ? open.key : null}
        anchor={open?.anchor ?? null}
        onClose={() => setOpen(null)}
        onDismiss={handlePickerDismiss}
        refocus={refocus}
      />
      {/* 掛到（v1.31）：改掛專用挑選器，只回報挑了什麼——存檔時才搬 */}
      {open?.key === "dest" && movable && (
        <ReattachPicker
          node={node}
          anchor={open.anchor}
          onPick={(t: AttachTarget | null) => {
            outsidePressAtRef.current = 0;
            openRef.current = null;
            setOpen(null);
            api.setDest(t ? (t as QuickDest) : NO_DEST);
            window.setTimeout(refocus, 0);
          }}
          onClose={handlePickerDismiss}
        />
      )}
    </div>
  );
}

function isInside(el: Element, root: HTMLElement | null): boolean {
  return !!root?.contains(el) || !!el.closest(".ns-qa-pop, .ns-popmenu");
}
