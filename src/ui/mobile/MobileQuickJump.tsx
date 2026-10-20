/**
 * MobileQuickJump——手機搜尋（磨光①加工單 global.quickjump；契約 §0-4、§2.4、§9.5 D-3／D-4）。
 *
 * 入口只有頂帶的放大鏡（MobileTopBand 持有開關、把本元件掛在自己底下）；手機殼不掛全域快捷鍵，外接鍵盤的 Ctrl+P 照舊沒反應（D-4）。
 * 全螢幕（portal 到 body：頂帶自己是一個 z-index 3 的疊層，掛在它裡面會被底部 tab 蓋住）：
 *   頂：書封色的一條，放搜尋框＋「取消」——看起來就是頂帶變成了搜尋列
 *   身：結果清單；空字時印說明（同桌機的句子）
 * 搜尋與結果模型跟桌機 QuickJump 同一套（`searchQuickJump`）：150ms 去抖、前綴模式只問那一個提供者、節點結果之後各線一組。
 * 各線提供者用 `lineQuickJumpProviders("mobile")`：只收手機通車、而且 `shells` 含 "mobile" 的（go() 自己分好殼的才登記）。
 * 點節點 ⇒ `jumpToNodeMobile`（今日／路線圖展開到它／收件匣；邊界規則同桌機 `jumpToNode`）；點別線的一列 ⇒ 它的 `go()`。
 * 返回層：開著就登記 full 層，返回＝關（同按「取消」）。
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { NodeRow } from "../../domain";
import { useNodeStore } from "../../store/nodeStore";
import { lineQuickJumpProviders } from "../../lines/runtime";
import { ResultBadge, quickJumpContext, searchQuickJump, type QuickJumpRow } from "../common/QuickJump";
import { useBackLayer } from "./backStack";
import { jumpToNodeMobile } from "./routeMapReveal";
import "./mobile-quickjump.css";

/** 放大鏡（16 viewBox／1.3 筆觸，同頂帶與底部 tab 的圖示語彙） */
function IconSearch({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" aria-hidden>
      <circle cx="7" cy="7" r="4.4" />
      <path d="M10.3 10.3 13.6 13.6" />
    </svg>
  );
}

export function MobileQuickJump({ onClose }: { onClose(): void }) {
  useBackLayer("core.quickjump", true, onClose, "full");

  const routes = useNodeStore((s) => s.routes);
  const lines = useNodeStore((s) => s.lines);
  /** 定期券的済看「目前班次」的結局（同桌機） */
  const currentOccurrences = useNodeStore((s) => s.currentOccurrences);

  const [q, setQ] = useState("");
  const [results, setResults] = useState<QuickJumpRow[]>([]);
  const [pending, setPending] = useState(false);
  const reqRef = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const term = q.trim();
  /** 手機可用的提供者（開著期間通車狀態不變） */
  const providers = useMemo(() => lineQuickJumpProviders("mobile"), []);
  const prefixed = providers.filter((p) => p.prefix);

  useEffect(() => {
    if (!term) {
      setResults([]);
      setPending(false);
      return;
    }
    setPending(true);
    const id = ++reqRef.current;
    const timer = setTimeout(() => {
      void searchQuickJump(term, providers).then((rows) => {
        if (id !== reqRef.current) return; // 過期的回應
        setResults(rows);
        setPending(false);
      });
    }, 150);
    return () => clearTimeout(timer);
  }, [term, providers]);

  const choose = (r: QuickJumpRow) => {
    onClose();
    if (r.type === "node") void jumpToNodeMobile(r.node);
    else void r.hit.go();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "Enter") {
      // 軟鍵盤的「搜尋」鍵：結果到了＝選第一列；還在查或沒有結果＝只收鍵盤（不選到上一次的舊結果）
      e.preventDefault();
      if (!pending && results[0]) choose(results[0]);
      else inputRef.current?.blur();
    }
  };

  const clear = () => {
    setQ("");
    inputRef.current?.focus();
  };

  return createPortal(
    <div className="m-qj" role="dialog" aria-modal="true" aria-label="搜尋">
      <div className="m-qj-top">
        <label className="m-qj-field">
          <IconSearch />
          <input
            ref={inputRef}
            autoFocus
            type="text"
            inputMode="search"
            enterKeyHint="search"
            aria-label="搜尋"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="跳到路線、列車、車廂、車票…"
            spellCheck={false}
            autoComplete="off"
            className="m-qj-input"
          />
          {q && (
            <button type="button" className="m-qj-clear" aria-label="清除" onClick={clear}>
              ×
            </button>
          )}
        </label>
        <button type="button" className="m-qj-cancel" onClick={onClose}>
          取消
        </button>
      </div>

      <div className="m-qj-body">
        {!term ? (
          <p className="m-qj-note">
            輸入名稱，跳到路線、支線、列車、車廂或車票（含臨時車票）。
            {prefixed.map((p) => (
              <span key={p.id}>
                <br />
                第一個字打 {p.prefix} 只找{p.group}。
              </span>
            ))}
          </p>
        ) : results.length === 0 ? (
          <p className="m-qj-note">{pending ? "搜尋中…" : `找不到『${term}』`}</p>
        ) : (
          <ul aria-label="搜尋結果" className="m-qj-list">
            {results.map((r) =>
              r.type === "hit" ? (
                <HitRow key={r.key} row={r} onPick={() => choose(r)} />
              ) : (
                <NodeResult
                  key={r.key}
                  node={r.node}
                  done={currentOccurrences[r.node.id] ? currentOccurrences[r.node.id].status === "done" : r.node.status === "done"}
                  context={quickJumpContext(r.node, routes, lines)}
                  onPick={() => choose(r)}
                />
              ),
            )}
          </ul>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** 節點一列（同桌機：徽章、名稱、済、淡字的所屬） */
function NodeResult({ node, done, context, onPick }: { node: NodeRow; done: boolean; context: string; onPick(): void }) {
  return (
    <li>
      <button type="button" className="m-qj-row" onClick={onPick}>
        <ResultBadge node={node} done={done} />
        <span className={"m-qj-name" + (done ? " is-done" : "")}>{node.name}</span>
        {done && (
          <span className="m-qj-done" aria-label="已完成">
            済
          </span>
        )}
        {context && <span className="m-qj-aside">{context}</span>}
      </button>
    </li>
  );
}

/** 別線提供者的一列（組的第一列前面畫組名小標；徽章借 `.ns-kind-badge`、縮排用 padding-left） */
function HitRow({ row, onPick }: { row: Extract<QuickJumpRow, { type: "hit" }>; onPick(): void }) {
  const { hit, group } = row;
  return (
    <>
      {group && (
        <li className="m-qj-group">
          {group}
        </li>
      )}
      <li>
        <button
          type="button"
          className="m-qj-row"
          onClick={onPick}
          style={hit.indent ? { paddingLeft: `calc(var(--m-gutter) + ${hit.indent * 14}px)` } : undefined}
        >
          {hit.glyph && (
            <span aria-hidden className={`ns-kind-badge${hit.glyph.dashed ? " is-dashed" : ""}`}>
              {hit.glyph.text}
            </span>
          )}
          <span className="m-qj-name">{hit.label}</span>
          {hit.aside && <span className="m-qj-aside">{hit.aside}</span>}
        </button>
      </li>
    </>
  );
}
