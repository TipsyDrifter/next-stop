/**
 * useQuickSuggest——建票列、雙擊行內編輯與寫方針輸入框共用的 `@路線`／`#荷札` 打字即時補完（第二梯 D-FB-3；操作 4）。
 *
 * 支援：
 *   - 輸入 `@` 即時彈出依「幹線」分組（`幹線・○○`／`其他`）之路線候選清單（模糊比對代碼、路線名與幹線名）
 *   - 建票／改票輸入 `@路線/`（或點路線列右側「子項 ›」）續補該路線下之支線／列車／車廂／車票，選取含空白名稱自動加引號
 *   - 輸入 `#` 即時彈出 `#荷札` 階層補完浮層（複用 `TagSuggestRows`）
 *   - 鍵盤：`↑`／`↓` 切換（自動跳過分組標頭）、`Enter`／`Tab` 選取、`Esc` 只收補完浮層（不關外層建票列或對話框）
 *   - 完整 IME 組字保護（組字期間不搶 `Enter`／`↑↓`／`Esc`）與手機返回層（`useBackLayer`）整合
 */
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { nodeRepo } from "../../../data";
import type { NodeRow } from "../../../domain";
import { excludeSubtrees } from "../../../domain/moveTo";
import { completeTab, type TagSuggestResult } from "../../../domain/tags";
import { useNodeStore } from "../../../store/nodeStore";
import { useTagStore } from "../../../store/tagStore";
import { useBackLayer } from "../../mobile/backStack";
import { useShell } from "../../mobile/useShell";
import { rememberNodeName } from "../../notes/notesBits";
import { TagSuggestRows, moveAct, suggestCount, suggestPick } from "../../notes/tags/TagSuggest";
import { flattenAttachTree, type AttachKind, type AttachOption } from "../../notes/useAttachOptions";
import "../../notes/notes-tags.css";
import {
  buildDestSuggestions,
  detectQuickTrigger,
  formatDestInsertion,
  replaceTriggerRange,
  type DestSuggestResult,
  type QuickTrigger,
} from "./quickSuggestModel";

const KIND_GLYPH: Record<AttachKind, string> = { branch: "支", train: "列", car: "廂", ticket: "票" };
const POP_W = 304;
const POP_MAX_H = 276;

export interface UseQuickSuggestOptions {
  inputRef: RefObject<HTMLInputElement | HTMLTextAreaElement | null>;
  value: string;
  composing?: boolean;
  allowDest?: boolean;
  allowTag?: boolean;
  /** 是否允許 `@路線/` 展開與跨路線搜尋子節點（建票／改票為 true；方針框可傳 true 搭配 allowedDestKinds=["branch"]） */
  allowSubNode?: boolean;
  routeSelectable?: boolean;
  allowedDestKinds?: readonly AttachKind[];
  /** 行內編輯改掛時排除自身與子樹 */
  excludeId?: string;
  onTextChange(next: string): void;
  /**
   * 自訂選取 `@` 候選後的行為（如寫方針輸入框直接掛上路線 chip 並剝離文字內的 `@...`）。
   * 回傳 `true` 代表已自行處理文字更新；未傳或回傳 `false` 則將 `@路線 ` 插入文字。
   */
  onPickDest?(pick: {
    route: NodeRow;
    opt: AttachOption | null;
    cleanedText: string;
    caret: number;
  }): boolean | void;
}

export interface QuickSuggestApi {
  open: boolean;
  popup: ReactNode;
  /** 輸入框 `onKeyDown` 最前面呼叫；回傳 `true` 代表補完選單已攔截並處理該按鍵 */
  onKeyDown(e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>): boolean;
  /** 掛在輸入框上的游標／點擊同步事件 */
  bind: {
    onSelect(): void;
    onKeyUp(): void;
    onClick(): void;
  };
  /** 給未自備 composition state 的輸入框（如方針輸入框）掛載 IME 組字守門 */
  compositionBind: {
    onCompositionStart(): void;
    onCompositionEnd(): void;
  };
  close(): void;
}

interface PopPos {
  left: number;
  top: number;
  above: boolean;
}

function measureCaretX(el: HTMLInputElement | HTMLTextAreaElement, pos: number): number {
  if (typeof document === "undefined") return 0;
  const cs = window.getComputedStyle(el);
  const span = document.createElement("span");
  span.style.position = "fixed";
  span.style.visibility = "hidden";
  span.style.whiteSpace = "pre";
  span.style.font = cs.font;
  span.style.fontFamily = cs.fontFamily;
  span.style.fontSize = cs.fontSize;
  span.style.fontWeight = cs.fontWeight;
  span.style.letterSpacing = cs.letterSpacing;
  span.textContent = el.value.slice(0, pos);
  document.body.appendChild(span);
  const w = span.getBoundingClientRect().width;
  span.remove();
  const padL = parseFloat(cs.paddingLeft) || 0;
  return Math.max(0, padL + w - el.scrollLeft);
}

function computePopPos(el: HTMLInputElement | HTMLTextAreaElement, charPos: number): PopPos | null {
  const rect = el.getBoundingClientRect();
  if (!rect.width && !rect.height) return null;
  const vw = window.visualViewport?.width ?? (document.documentElement.clientWidth || window.innerWidth);
  const vh = window.visualViewport?.height ?? (document.documentElement.clientHeight || window.innerHeight);
  const offsetX = measureCaretX(el, charPos);
  const rawLeft = rect.left + Math.min(offsetX, Math.max(0, rect.width - 24));
  const left = Math.round(Math.max(10, Math.min(rawLeft, vw - POP_W - 10)));
  const below = rect.bottom + 6;
  const spaceBelow = vh - below - 10;
  const spaceAbove = rect.top - 10;
  const above = spaceBelow < Math.min(POP_MAX_H, 190) && spaceAbove > spaceBelow;
  return {
    left,
    top: Math.round(above ? rect.top - 6 : below),
    above,
  };
}

export function useQuickSuggest(opts: UseQuickSuggestOptions): QuickSuggestApi {
  const {
    inputRef,
    value,
    composing = false,
    allowDest = true,
    allowTag = true,
    allowSubNode = true,
    routeSelectable = true,
    allowedDestKinds,
    excludeId,
    onTextChange,
    onPickDest,
  } = opts;

  const mobile = useShell() === "mobile";
  const layerId = "common.quicksug." + useId();
  const lines = useNodeStore((s) => s.liveLines);
  const routes = useNodeStore((s) => s.liveRoutes);
  const tagIndex = useTagStore((s) => s.index);

  const popRef = useRef<HTMLDivElement>(null);
  const composingLocalRef = useRef(false);
  const [composingLocal, setComposingLocal] = useState(false);
  const isComposing = composing || composingLocal || composingLocalRef.current;
  const pendingCaretRef = useRef<number | null>(null);
  const dismissedRef = useRef<{ kind: "dest" | "tag"; start: number; raw: string } | null>(null);

  const [trigger, setTrigger] = useState<QuickTrigger | null>(null);
  const [act, setAct] = useState(0);
  const [pos, setPos] = useState<PopPos | null>(null);
  const [trees, setTrees] = useState<ReadonlyMap<string, readonly AttachOption[]>>(new Map());
  const treesLoadedKeyRef = useRef<string>("");

  const kindsKey = allowedDestKinds?.join(",") ?? "";

  // 當觸發 `@` 且允許子節點時，懶載各路線子樹供 `@路線/` 與跨路線搜尋使用
  useEffect(() => {
    if (!trigger || trigger.kind !== "dest" || !allowSubNode) return;
    const loadKey = `${routes.map((r) => r.id).join(",")}|${kindsKey}|${excludeId ?? ""}`;
    if (treesLoadedKeyRef.current === loadKey) return;
    treesLoadedKeyRef.current = loadKey;
    let alive = true;
    const excl = excludeId ? new Set([excludeId]) : null;
    const ks = kindsKey ? (kindsKey.split(",") as AttachKind[]) : undefined;
    Promise.all(
      routes.map((r) =>
        nodeRepo.listRouteTree(r.id).then((rows) => {
          const flat = flattenAttachTree(r.id, rows, ks);
          for (const o of flat) rememberNodeName(o.id, o.name);
          const filtered = excl ? excludeSubtrees(flat, excl) : flat;
          return [r.id, filtered] as const;
        }),
      ),
    )
      .then((pairs) => {
        if (alive) setTrees(new Map(pairs));
      })
      .catch(() => {
        treesLoadedKeyRef.current = "";
      });
    return () => {
      alive = false;
    };
  }, [trigger, allowSubNode, routes, kindsKey, excludeId]);

  const syncTrigger = useCallback(() => {
    if (isComposing) return;
    const el = inputRef.current;
    if (!el || typeof document === "undefined" || document.activeElement !== el) {
      setTrigger(null);
      return;
    }
    if (el.selectionStart === null || el.selectionStart !== el.selectionEnd) {
      setTrigger(null);
      return;
    }
    const hit = detectQuickTrigger(el.value, el.selectionStart, { allowDest, allowTag });
    if (!hit) {
      dismissedRef.current = null;
      setTrigger(null);
      return;
    }
    const raw = hit.kind === "dest" ? hit.rawQuery : hit.q;
    const d = dismissedRef.current;
    if (d && d.kind === hit.kind && d.start === hit.start && d.raw === raw) {
      setTrigger(null);
      return;
    }
    dismissedRef.current = null;
    if (hit.kind === "tag" && !useTagStore.getState().index) {
      void useTagStore.getState().loadIndex();
    }
    const nextPos = computePopPos(el, hit.start);
    if (!nextPos) {
      setTrigger(null);
      return;
    }
    setPos(nextPos);
    setTrigger((prev) => {
      const prevRaw = prev ? (prev.kind === "dest" ? prev.rawQuery : prev.q) : null;
      if (!prev || prev.kind !== hit.kind || prev.start !== hit.start || prevRaw !== raw) {
        setAct(0);
      }
      return hit;
    });
  }, [isComposing, inputRef, allowDest, allowTag]);

  // value 或組字狀態改變時即時重算觸發狀態
  useEffect(() => {
    if (isComposing) {
      setTrigger(null);
      return;
    }
    syncTrigger();
  }, [value, isComposing, syncTrigger]);

  const destRes: DestSuggestResult<NodeRow> | null = useMemo(() => {
    if (!trigger || trigger.kind !== "dest") return null;
    return buildDestSuggestions({
      rawQuery: trigger.rawQuery,
      routes,
      lines,
      allowSubNode,
      routeSelectable,
      allowedKinds: allowedDestKinds,
      treesByRoute: trees,
    });
  }, [trigger, routes, lines, allowSubNode, routeSelectable, allowedDestKinds, trees]);

  const tagRes: TagSuggestResult | null = useMemo(() => {
    if (!trigger || trigger.kind !== "tag") return null;
    return useTagStore.getState().suggest(trigger.q, { limit: 7 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trigger, tagIndex]);

  const count = useMemo(() => {
    if (!trigger) return 0;
    if (trigger.kind === "dest") return destRes ? destRes.picks.length : 0;
    return tagRes ? suggestCount(tagRes) : 0;
  }, [trigger, destRes, tagRes]);

  const open = Boolean(trigger && pos && (trigger.kind === "dest" ? (destRes?.rows.length ?? 0) > 0 || routes.length > 0 : Boolean(tagRes)));
  const curAct = count > 0 ? Math.min(act, count - 1) : 0;

  const dismissCurrent = useCallback(() => {
    if (trigger) {
      dismissedRef.current = {
        kind: trigger.kind,
        start: trigger.start,
        raw: trigger.kind === "dest" ? trigger.rawQuery : trigger.q,
      };
    }
    setTrigger(null);
  }, [trigger]);

  const close = useCallback(() => {
    setTrigger(null);
  }, []);

  useBackLayer(layerId, mobile && open, dismissCurrent, "dialog");

  // 視窗捲動或縮放時重算浮層座標
  useEffect(() => {
    if (!open) return;
    const relayout = () => {
      const el = inputRef.current;
      if (!el || !trigger) return;
      const next = computePopPos(el, trigger.start);
      if (next) setPos(next);
    };
    window.addEventListener("scroll", relayout, true);
    window.addEventListener("resize", relayout);
    window.visualViewport?.addEventListener("resize", relayout);
    return () => {
      window.removeEventListener("scroll", relayout, true);
      window.removeEventListener("resize", relayout);
      window.visualViewport?.removeEventListener("resize", relayout);
    };
  }, [open, inputRef, trigger]);

  // 點擊浮層與輸入框以外收起補完選單
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target;
      if (!(t instanceof Node)) return;
      if (popRef.current?.contains(t) || inputRef.current?.contains(t)) return;
      dismissCurrent();
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [open, inputRef, dismissCurrent]);

  // 鍵盤切換時讓當前選中列保持在捲動視野內
  useEffect(() => {
    if (!open) return;
    const activeEl = popRef.current?.querySelector<HTMLElement>("[role='option'][aria-selected='true']");
    activeEl?.scrollIntoView({ block: "nearest" });
  }, [open, curAct]);

  // 補完寫回後將游標精準放回插入點後方
  useLayoutEffect(() => {
    const caret = pendingCaretRef.current;
    const el = inputRef.current;
    if (caret === null || !el) return;
    pendingCaretRef.current = null;
    el.focus({ preventScroll: true });
    const clamped = Math.max(0, Math.min(caret, el.value.length));
    el.setSelectionRange(clamped, clamped);
  });

  const liveRef = useRef({ trigger, destRes, tagRes, onTextChange, onPickDest });
  liveRef.current = { trigger, destRes, tagRes, onTextChange, onPickDest };

  const applyReplacement = useCallback(
    (inserted: string, keepOpenAfter = false) => {
      const el = inputRef.current;
      const { trigger: trig, onTextChange: setTxt } = liveRef.current;
      if (!el || !trig) return;
      const { text: next, caret } = replaceTriggerRange(el.value, trig.start, trig.end, inserted);
      pendingCaretRef.current = caret;
      dismissedRef.current = null;
      if (!keepOpenAfter) setTrigger(null);
      setTxt(next);
    },
    [inputRef],
  );

  const pickDestAt = useCallback(
    (idx: number) => {
      const el = inputRef.current;
      const { trigger: trig, destRes: res, onPickDest: customPick } = liveRef.current;
      if (!el || !trig || trig.kind !== "dest" || !res) return;
      const item = res.picks[idx];
      if (!item) return;
      if (item.opt) rememberNodeName(item.opt.id, item.opt.name);
      if (customPick) {
        const stripped = replaceTriggerRange(el.value, trig.start, trig.end, "");
        const handled = customPick({
          route: item.route,
          opt: item.opt,
          cleanedText: stripped.text,
          caret: stripped.caret,
        });
        if (handled) {
          pendingCaretRef.current = stripped.caret;
          dismissedRef.current = null;
          setTrigger(null);
          return;
        }
      }
      applyReplacement(formatDestInsertion(item.route.name, item.opt?.name ?? null, false));
    },
    [inputRef, applyReplacement],
  );

  const drillRoute = useCallback(
    (route: NodeRow) => {
      applyReplacement(formatDestInsertion(route.name, null, true), true);
    },
    [applyReplacement],
  );

  const pickTagAt = useCallback(
    (idx: number, viaTab = false) => {
      const { trigger: trig, tagRes: res } = liveRef.current;
      if (!trig || trig.kind !== "tag" || !res) return;
      if (viaTab && idx < res.items.length && !res.items[idx].real) {
        // 虛擬母分類按 Tab 展開下一層 `#母/`
        const nextQ = completeTab(res.items[idx], res.browse);
        applyReplacement(`#${nextQ}`, true);
        return;
      }
      const name = suggestPick(res, idx);
      if (!name) return;
      applyReplacement(`#${name} `);
    },
    [applyReplacement],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>): boolean => {
      if (e.nativeEvent.isComposing || e.keyCode === 229 || isComposing) return false;
      if (!open || !trigger) return false;

      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        dismissCurrent();
        return true;
      }

      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (count <= 0) return false;
        e.preventDefault();
        e.stopPropagation();
        setAct((prev) => moveAct(Math.min(prev, count - 1), e.key === "ArrowDown" ? 1 : -1, count));
        return true;
      }

      if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (count <= 0) return false;
        e.preventDefault();
        e.stopPropagation();
        if (trigger.kind === "dest") {
          pickDestAt(curAct);
        } else {
          pickTagAt(curAct, e.key === "Tab");
        }
        return true;
      }

      return false;
    },
    [isComposing, open, trigger, count, curAct, dismissCurrent, pickDestAt, pickTagAt],
  );

  const bind = useMemo(
    () => ({
      onSelect: syncTrigger,
      onKeyUp: syncTrigger,
      onClick: syncTrigger,
    }),
    [syncTrigger],
  );

  const compositionBind = useMemo(
    () => ({
      onCompositionStart() {
        composingLocalRef.current = true;
        setComposingLocal(true);
      },
      onCompositionEnd() {
        composingLocalRef.current = false;
        setComposingLocal(false);
      },
    }),
    [],
  );

  const nameOfTag = (k: string) => useTagStore.getState().nameOf(k);
  const vh = typeof window !== "undefined" ? (window.visualViewport?.height ?? window.innerHeight) : 800;

  const popup =
    open && pos && trigger && typeof document !== "undefined"
      ? createPortal(
          <div
            ref={popRef}
            className={`ns-qa-pop ns-qa-sug techo-card${pos.above ? " is-above" : ""}`}
            role="listbox"
            aria-label={trigger.kind === "dest" ? "路線與節點補完" : "荷札補完"}
            style={
              pos.above
                ? { left: pos.left, bottom: Math.max(8, vh - pos.top), width: POP_W }
                : { left: pos.left, top: pos.top, width: POP_W }
            }
            onMouseDown={(e) => e.preventDefault()}
          >
            {trigger.kind === "dest" && destRes ? (
              destRes.picks.length === 0 ? (
                <p className="ns-qa-sug-empty">
                  {routes.length === 0 ? "還沒有運行中的路線" : "找不到符合的路線或項目"}
                </p>
              ) : (
                <div className="ns-qa-sug-list">
                  {destRes.rows.map((row) => {
                    if (row.type === "header") {
                      return (
                        <div key={row.key} role="presentation" className="ns-qa-sug-head">
                          {row.label}
                        </div>
                      );
                    }
                    if (row.type === "route") {
                      const active = row.pickIndex === curAct;
                      const isScopeSelf = destRes.routeScope?.id === row.route.id;
                      return (
                        <div
                          key={row.key}
                          role="option"
                          aria-selected={active}
                          className={`ns-qa-sug-row${active ? " is-on" : ""}`}
                          onMouseEnter={() => setAct(row.pickIndex)}
                          onClick={() => pickDestAt(row.pickIndex)}
                        >
                          <span
                            aria-hidden
                            className="ns-qa-rd"
                            style={{ background: row.route.color ?? "var(--route-none)" }}
                          >
                            {row.route.code ?? ""}
                          </span>
                          <span className="nm">
                            {isScopeSelf ? `掛在「${row.route.name}」路線本身` : row.route.name}
                          </span>
                          {row.canDrill && (
                            <button
                              type="button"
                              tabIndex={-1}
                              className="ns-qa-sug-drill"
                              title={`挑「${row.route.name}」底下的支線或車票（/）`}
                              onMouseDown={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                              }}
                              onClick={(e) => {
                                e.stopPropagation();
                                drillRoute(row.route);
                              }}
                            >
                              / 子項 ›
                            </button>
                          )}
                        </div>
                      );
                    }
                    const active = row.pickIndex === curAct;
                    const routeColor = row.route.color ?? "var(--route-none)";
                    return (
                      <div
                        key={row.key}
                        role="option"
                        aria-selected={active}
                        className={`ns-qa-sug-row is-node${active ? " is-on" : ""}`}
                        style={
                          !row.cross && row.opt.depth > 0
                            ? ({ "--sug-indent": `${Math.min(row.opt.depth, 4) * 12}px` } as CSSProperties)
                            : undefined
                        }
                        onMouseEnter={() => setAct(row.pickIndex)}
                        onClick={() => pickDestAt(row.pickIndex)}
                      >
                        {row.cross && (
                          <span aria-hidden className="ns-qa-rd" style={{ background: routeColor }}>
                            {row.route.code ?? ""}
                          </span>
                        )}
                        <span
                          aria-hidden
                          className={`ns-qa-sug-kind${row.opt.kind === "ticket" ? "" : " is-dashed"}`}
                          style={{ color: routeColor }}
                        >
                          {KIND_GLYPH[row.opt.kind]}
                        </span>
                        <span className="nm">
                          {row.cross ? (
                            <>
                              <span className="rt">{row.route.name} › </span>
                              {row.opt.name}
                            </>
                          ) : (
                            row.opt.name
                          )}
                        </span>
                      </div>
                    );
                  })}
                  <div className="ns-qa-sug-foot" aria-hidden>
                    ↑↓ 選擇 · Enter / Tab 帶入{allowSubNode && !destRes.routeScope ? " · / 挑子項" : ""} · Esc 收起
                  </div>
                </div>
              )
            ) : trigger.kind === "tag" && tagRes ? (
              <div className="ns-qa-sug-tags">
                <TagSuggestRows
                  res={tagRes}
                  act={curAct}
                  onPick={(i) => pickTagAt(i, false)}
                  onHover={(i) => setAct(i)}
                  nameOf={nameOfTag}
                />
              </div>
            ) : null}
          </div>,
          document.body,
        )
      : null;

  return { open, popup, onKeyDown, bind, compositionBind, close };
}
