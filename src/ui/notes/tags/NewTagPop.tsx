/**
 * NewTagPop——荷札頁「＋ 新荷札」的錨定小浮層（桌機；UI 丙-6 T2，資料層 ☎-1 `tagStore.createTag`）。
 *
 * 長相：浮層一律 `.techo-card`（視覺規範 §1.5）＝眉標「新荷札 · New tag」＋`#` 輸入框（借併入浮層 MergePick 的
 *   `.ns-notes-taginput`）＋一行即時提示（`newTagHint`：normalizeName 的原因赭字／已經有就說會直接打開）＋右下一顆主鈕。
 *   定位照 PopMenu：anchor 下方、右緣對齊 anchor 右緣（頁首工具列在右側），放不下就翻到上方；portal 到 body。
 * 鍵盤：開了焦點進輸入框；Enter＝送出（不合法不動）；Esc＝收（stopPropagation，頁根鍵盤表不再收到）；
 *   點卡外＝收（點回 anchor 交給 anchor 自己 toggle）。收起後焦點交回呼叫端（`onClose(refocus)`）。
 * 送出：先收浮層、再 `createTag`——新的就選中＋toast「已建立 #X」＋復原；已經有就選中＋toast「已經有 #X 了」。
 * 手機入口不在這裡（MSheet 表單由手機 sheet 席做）；`newTagHint` 兩殼共用。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { normalizeName, type TagIndex } from "../../../domain/tags";
import { useTagStore } from "../../../store/tagStore";
import { OverlineText } from "../../common/PageHeader";

export interface NewTagHint {
  /** 能不能送出（合法；已經有也算——送出＝打開它） */
  ok: boolean;
  /** 已經有同 key 的真荷札 */
  exists: boolean;
  /** 提示字（空字串＝用預設提示） */
  text: string;
  /** 提示是錯誤（赭字） */
  err: boolean;
}

/** 即時提示（兩殼共用）：還沒打字＝不提示、不能送；不合法＝normalizeName 的原因；已經有＝說會直接打開 */
export function newTagHint(index: TagIndex | null, draft: string): NewTagHint {
  if (!draft.replace(/^[\s#]+|\s+$/g, "")) return { ok: false, exists: false, text: "", err: false };
  const n = normalizeName(draft);
  if (!n.ok) return { ok: false, exists: false, text: n.reason, err: true };
  const hit = index?.byKey[n.key];
  if (hit?.real) return { ok: true, exists: true, text: `已經有 #${hit.name} 了，會直接打開它`, err: false };
  return { ok: true, exists: false, text: "", err: false };
}

export function NewTagPop({ anchor, onClose }: { anchor: HTMLElement | null; onClose(refocus: boolean): void }) {
  const index = useTagStore((s) => s.index);
  const [draft, setDraft] = useState("");
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const inRef = useRef<HTMLInputElement>(null);
  const hint = useMemo(() => newTagHint(index, draft), [index, draft]);

  /* 定位（同 PopMenu）：anchor 下方、右緣對齊、clamp 進視窗；沒有 anchor＝視窗上方置中 */
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const { offsetWidth: w, offsetHeight: h } = el;
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = document.documentElement.clientHeight || window.innerHeight;
    const M = 12;
    if (!anchor) {
      setPos({ top: Math.round(vh * 0.24), left: Math.round((vw - w) / 2) });
      return;
    }
    const r = anchor.getBoundingClientRect();
    let top = r.bottom + 6;
    if (top + h > vh - M) top = Math.max(M, r.top - h - 6);
    const left = Math.max(M, Math.min(r.right - w, vw - w - M));
    setPos({ top: Math.round(top), left: Math.round(left) });
  }, [anchor]);

  /* 落位後才 focus（落位前 visibility:hidden，focus 是 no-op——PopMenu 同一個坑） */
  useEffect(() => {
    if (pos) inRef.current?.focus({ preventScroll: true });
  }, [pos]);

  /* 點卡外＝收（點回 anchor 交給 anchor 自己 toggle） */
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!t || boxRef.current?.contains(t) || anchor?.contains(t)) return;
      onClose(false);
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [anchor, onClose]);

  const submit = async () => {
    if (!hint.ok) return;
    const raw = draft;
    onClose(false);
    await useTagStore.getState().createTag(raw);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter") {
      e.preventDefault();
      void submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose(true);
    }
  };

  return createPortal(
    <div
      ref={boxRef}
      className="ns-notes-newtag techo-card"
      role="dialog"
      aria-label="新荷札"
      onMouseDown={(e) => e.stopPropagation()}
      style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? "visible" : "hidden" }}
    >
      <p className="techo-overline ns-notes-newtag-head">
        <OverlineText value={{ zh: "新荷札", latin: "New tag" }} />
      </p>
      <span className="ns-notes-taginput">
        <i aria-hidden>#</i>
        <input
          ref={inRef}
          value={draft}
          placeholder="荷札名稱"
          aria-label="新荷札的名稱"
          aria-describedby="ns-notes-newtag-hint"
          aria-invalid={hint.err || undefined}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </span>
      <p id="ns-notes-newtag-hint" className={`ns-notes-newtag-hint${hint.err ? " err" : ""}`} aria-live="polite">
        {hint.text || "用 / 可以分上下層"}
      </p>
      <div className="ns-notes-newtag-foot">
        <button type="button" className="ns-btn ns-btn--sm btn-seal" disabled={!hint.ok} onClick={() => void submit()}>
          {hint.exists ? "打開" : "建立"}
        </button>
      </div>
    </div>,
    document.body,
  );
}
