/**
 * QuickAddRow——桌機建票列＝票形草稿列（回饋甲 D-主-127；原型 q1-A `.ticket.draft.nsq-cmp`）。
 *
 * 長相：票皮（.ticket.draft 虛線框；聚焦時虛線轉作用中色）
 *   .stub   徽章＋小字＝即時寫「會建成什麼」（臨／列／票…＋路線名）
 *   .body   票種小字（右上）＋輸入框（認出的片段反白）＋下一排 chips
 *   .stamp-zone  「発券」主鈕＋淡字「Esc 取消」（草稿還不能蓋章）
 *
 * 兩種用法：
 *   - 一般（今日、路線圖清單尾、行程表串流／當日浮層）：自己建票（useQuickAdd.submit）；Enter 建好清空、焦點留著連打。
 *   - `positional`（大綱 Enter／Tab 的位置型草稿列）：掛到由位置決定、不出掛到 chip；Enter／Tab／失焦交給大綱 controller
 *     （呼叫端的回呼多收一個 QuickExtra，帶進 createNode）。
 * 失焦：焦點去了建票列與它的挑選器以外的地方——有名字就建（同以前的草稿列「點去別處就提交」）、沒名字就收；
 *   整個視窗失焦（切去別的 App）不算。
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type LiHTMLAttributes,
  type MutableRefObject,
} from "react";
import type { NodeKind, NodeRow } from "../../../domain";
import type { CommitVia } from "../InlineInput";
import { QuickChips, QuickField, intoLabel } from "./QuickAddParts";
import { QuickPickers } from "./QuickAddPickers";
import { stubLook, type QuickChipKey, type QuickDefaults, type QuickHere, type RouteKind } from "./quickAddModel";
import { useQuickAdd, type QuickExtra } from "./useQuickAdd";
import "./quickadd.css";

export interface QuickPositional {
  /** 位置決定的種類（列車／車廂／車票…） */
  kind: NodeKind;
  /** 票根色（路線色） */
  accent?: string;
  /** Enter／失焦：交給大綱 controller（名字已拿掉語法片段） */
  onCommit(name: string, via: CommitVia, extra: QuickExtra): void;
  /** Tab／Shift+Tab：改層級（照舊） */
  onTab(name: string, shift: boolean, extra: QuickExtra): void;
  onCancel(): void;
  /** 變動時重新聚焦（草稿列在樹裡換位置） */
  focusKey?: string | number;
}

export interface QuickAddRowProps {
  defaults: QuickDefaults;
  here: QuickHere;
  /** 掛到路線時預設建成什麼（省略＝路線圖列車、其他頁車票；頁首「新增車票」＝車票） */
  routeKind?: RouteKind;
  afterId?: string | null;
  positional?: QuickPositional;
  placeholder?: string;
  /** Esc（byKeyboard）或點去別處收起（一般用法） */
  onClose?(byKeyboard: boolean): void;
  /** 建好了（stays＝還在眼前、使用者還在建票列上，呼叫端可選中它；點去別處送出＝false） */
  onCreated?(row: NodeRow, stays: boolean): void;
  /** 外層 li 的屬性（大綱 treeitem 的 aria 與縮排） */
  liProps?: LiHTMLAttributes<HTMLLIElement>;
  /** 加在根上 */
  className?: string;
  /**
   * compact＝窄處用的緊湊版（行程表當日浮層 332px 寬放不下整張票）：一行輸入框＋下一排 chips，沒有票根與検印欄、根是 div。
   * 省略＝票形（li）。
   */
  variant?: "ticket" | "compact";
  /** 呼叫端要在建票列卸載前把打到一半的字建掉（當日浮層點外面就整個關掉）：這裡放一支「有名字就建」 */
  submitRef?: MutableRefObject<(() => void) | null>;
}

export function QuickAddRow({
  defaults,
  here,
  routeKind,
  afterId,
  positional,
  placeholder,
  onClose,
  onCreated,
  liProps,
  className,
  variant = "ticket",
  submitRef,
}: QuickAddRowProps) {
  const api = useQuickAdd({ defaults, here, routeKind, afterId, positional: positional ? { kind: positional.kind } : undefined, onCreated });
  const rootRef = useRef<HTMLElement | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState<{ key: QuickChipKey; anchor: HTMLElement } | null>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const [focus, setFocus] = useState(true);

  const live = useRef({ api, positional, onClose });
  live.current = { api, positional, onClose };

  const refocus = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  // 掛上（與位置型草稿列換位置）就聚焦。排進下一拍：開浮層／換列的那一個 commit 裡，外層控制器的 effect 可能把焦點交給別人
  useEffect(() => {
    refocus();
    const id = window.setTimeout(() => {
      refocus();
      // 聚焦用 preventScroll（不讓頁面亂跳），所以自己把整張建票列（含 chips 與発券）捲進畫面：清單長時它在最底下、會被切掉
      rootRef.current?.scrollIntoView({ block: "nearest" });
    }, 0);
    return () => window.clearTimeout(id);
  }, [refocus, positional?.focusKey]);

  // 給呼叫端的「有名字就建」（卸載前叫；submit 讀 store 與最新值，卸載後也跑得完）
  useEffect(() => {
    if (!submitRef) return;
    submitRef.current = () => {
      if (live.current.api.canSubmit) void live.current.api.submit({ away: true });
    };
    return () => {
      submitRef.current = null;
    };
  }, [submitRef]);

  const commit = async (via: CommitVia) => {
    const { api: a, positional: p, onClose: close } = live.current;
    if (p) {
      p.onCommit(a.values.name, via, a.extra());
      return;
    }
    if (!a.canSubmit) {
      if (via === "blur") close?.(false);
      return;
    }
    // 點去別處送出：選取留給使用者剛點的那一列（away＝不叫呼叫端選新票）
    const row = await a.submit(via === "blur" ? { away: true } : undefined);
    if (via === "blur" && row) close?.(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229 || api.composing) return;
    if (api.isSubmitKey(e)) {
      e.preventDefault();
      e.stopPropagation();
      if (!positional && !api.values.name.trim() && !api.text.trim()) {
        onClose?.(true); // 空白 Enter＝收掉（同以前的草稿列）
        return;
      }
      void commit("enter");
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (positional) positional.onCancel();
      else onClose?.(true);
    } else if (e.key === "Tab" && positional) {
      e.preventDefault();
      e.stopPropagation();
      positional.onTab(api.values.name, e.shiftKey, api.extra());
    }
  };

  /** 焦點離開建票列（含它的挑選器）＝點去別處 */
  const onBlur = (e: FocusEvent<HTMLElement>) => {
    const to = e.relatedTarget;
    if (to instanceof Element && isInside(to, rootRef.current)) return;
    setTimeout(() => {
      const root = rootRef.current;
      if (!root?.isConnected) return;
      if (!document.hasFocus()) return; // 切去別的 App：保留
      if (openRef.current) return; // 挑選器開著（點到挑選器裡不能聚焦的地方）
      const a = document.activeElement;
      if (a instanceof Element && isInside(a, root)) return;
      setFocus(false);
      void commit("blur");
    }, 60);
  };

  const look = stubLook(positional ? { kind: positional.kind, parentId: "x", routeTagId: null } : api.target);
  const destRoute = api.values.dest.routeId ? api.routes.find((r) => r.id === api.values.dest.routeId) : null;
  const stubColor = positional ? (positional.accent ?? "var(--color-ink-soft)") : (destRoute?.color ?? "var(--route-none)");
  const into = positional ? "" : intoLabel(api);
  const ph =
    placeholder ??
    (positional ? `新的${look.lineName}…` : api.target.kind === "train" ? "新增列車…" : "新增車票…");
  const noDateLabel = !!defaults.noDateLabel;

  const field = (
    <QuickField api={api} inputRef={inputRef} placeholder={ph} ariaLabel="建票列：名稱與設定" onKeyDown={onKeyDown} />
  );
  const chips = (
    <QuickChips
      api={api}
      hideDest={!!positional}
      noDateLabel={noDateLabel}
      open={open?.key ?? null}
      keepFocus
      onOpen={(key, anchor) => setOpen((cur) => (cur?.key === key ? null : { key, anchor }))}
    />
  );
  const pickers = (
    <QuickPickers api={api} open={open?.key ?? null} anchor={open?.anchor ?? null} onClose={() => setOpen(null)} refocus={refocus} />
  );

  if (variant === "compact") {
    return (
      <div
        ref={(el) => {
          rootRef.current = el;
        }}
        className={`ns-qa-compact${focus ? " is-focus" : ""}${className ? " " + className : ""}`}
        onBlur={onBlur}
        onFocus={() => setFocus(true)}
      >
        <div className="ns-qa-crow">
          <span className={`ns-qa-cbadge${look.dashed ? " dashed" : ""}`} style={{ color: stubColor }} aria-hidden title={look.lineName}>
            {look.badge}
          </span>
          {field}
          <span className="k" aria-hidden>
            Esc
          </span>
        </div>
        {chips}
        {pickers}
      </div>
    );
  }

  return (
    <li
      ref={(el) => {
        rootRef.current = el;
      }}
      {...liProps}
      className={`ticket-li ns-qa-li${className ? " " + className : ""}`}
      onBlur={onBlur}
      onFocus={() => setFocus(true)}
    >
      <article className={`ticket draft ns-qa${focus ? " is-focus" : ""}`}>
        <div className="stub" style={{ color: stubColor } as CSSProperties}>
          <span aria-hidden className={`badge${look.dashed ? " dashed" : ""}`}>
            {look.badge}
          </span>
          <span className="line-name">{look.lineName}</span>
          {into && (
            <span className="ns-qa-into" title={into}>
              {into}
            </span>
          )}
        </div>

        <div className="body">
          <span className="fare-class" aria-hidden>
            {look.fare}
          </span>
          {field}
          {chips}
        </div>

        <div className="stamp-zone">
          <button
            type="button"
            className="ns-btn btn-seal ns-qa-go"
            title="発券（Enter）"
            disabled={!api.canSubmit}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void commit("enter")}
          >
            発券
          </button>
          <span className="ns-qa-esc" aria-hidden>
            Esc 取消
          </span>
        </div>
      </article>
      {pickers}
    </li>
  );
}

/** 建票列自己、或它開出去的挑選器（portal 在 body：.ns-qa-pop；優先的 PopMenu：.ns-popmenu） */
function isInside(el: Element, root: HTMLElement | null): boolean {
  return !!root?.contains(el) || !!el.closest(".ns-qa-pop, .ns-popmenu");
}
