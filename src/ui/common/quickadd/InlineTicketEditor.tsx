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
import type { AttachTarget } from "../../../domain/notes";
import { useNodeStore } from "../../../store/nodeStore";
import { useTagStore } from "../../../store/tagStore";
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
      scheduledOn: node.scheduled_on,
      scheduledTime: node.scheduled_time,
      estimateMin: node.estimate_min,
      dueOn: node.due_on,
      priority: node.priority,
      tags: initialTags,
      noDateLabel: false,
    }),
    [movable, hereDest, node.scheduled_on, node.scheduled_time, node.estimate_min, node.due_on, node.priority, initialTags],
  );

  const api = useQuickAdd({
    defaults,
    positional: { kind: node.kind },
    initialText: node.name,
    initialSyncDue: Boolean(node.due_on && node.scheduled_on && node.due_on === node.scheduled_on),
    here: { kind: "none" },
  });

  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState<{ key: QuickChipKey; anchor: HTMLElement } | null>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const savingRef = useRef(false);

  const refocus = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

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
      const name = v.name.trim() || n.name;
      await useNodeStore.getState().updateNode(n.id, {
        name,
        scheduled_on: v.scheduledOn,
        scheduled_time: v.scheduledTime,
        estimate_min: v.estimateMin,
        due_on: v.dueOn,
        priority: v.priority ?? undefined,
      });
      if (v.on.has("tags")) {
        await tagRepo.setTags("node", n.id, v.tags);
        await useTagStore.getState().loadIndex();
      }
      // 掛到（v1.31）：膠囊改過、而且真的換了地方才搬（moveNodeTo 自己出 toast＋復原）；routeId null＝摘掉路線變臨時車票
      if (canMove && v.on.has("dest") && !sameDest(v.dest, here)) {
        await reattachTo(n, v.dest.routeId ? { routeId: v.dest.routeId, nodeId: v.dest.nodeId } : null);
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
          placeholder="車票名稱…"
          ariaLabel="行內編輯：名稱與快速語法"
          onKeyDown={onKeyDown}
        />
        <div className="ns-qa-inline-acts">
          <button
            type="button"
            className="ns-btn btn-seal ns-qa-inline-save"
            title="Enter 儲存 · Esc 取消"
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => void saveAndClose(e.ctrlKey || e.metaKey ? "ctrl-enter" : "enter")}
          >
            儲存
          </button>
          <button
            type="button"
            className="ns-btn btn-ghost ns-qa-inline-cancel"
            title="Esc 取消"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onClose()}
          >
            取消
          </button>
        </div>
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
      />
      <QuickPickers
        api={api}
        open={open && open.key !== "dest" ? open.key : null}
        anchor={open?.anchor ?? null}
        onClose={() => setOpen(null)}
        refocus={refocus}
      />
      {/* 掛到（v1.31）：改掛專用挑選器，只回報挑了什麼——存檔時才搬 */}
      {open?.key === "dest" && movable && (
        <ReattachPicker
          node={node}
          anchor={open.anchor}
          onPick={(t: AttachTarget | null) => {
            api.setDest(t ? (t as QuickDest) : NO_DEST);
            window.setTimeout(refocus, 0);
          }}
          onClose={() => {
            setOpen(null);
            // 沒挑就收（Esc、點外面）：焦點掉到 body 才拉回輸入框（同 QuickPickers 的 dismiss）
            window.setTimeout(() => {
              const a = document.activeElement;
              if (!a || a === document.body) refocus();
            }, 0);
          }}
        />
      )}
    </div>
  );
}

function isInside(el: Element, root: HTMLElement | null): boolean {
  return !!root?.contains(el) || !!el.closest(".ns-qa-pop, .ns-popmenu");
}
