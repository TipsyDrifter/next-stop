/**
 * QuickJump——UI Flow 2.4 快速跳轉（Ctrl+P／側欄搜尋鈕；讀 uiStore.quickJumpOpen）：置頂紙卡，150ms debounce 搜尋節點與臨時車票，
 * ↑↓ 移動、Enter 選取、Esc 關閉、點擊選取。選取：路線→開路線；樹內節點→開所屬路線後展開祖先並選中；臨時車票→有執行日就切到今日頁選中、沒有就提示它還在收件匣（M3 ③ WP3）。
 * 視覺：票面紙卡 .ns-card（paper-high、1px line、3px radius、原型陰影）＋燙金 overline ＋ 大號底線輸入 ＋ 結果列（路線＝roundel、
 *       其餘＝原型 .badge 小號版類型徽章）＋襯線名稱＋淡字路線名；選中列燙金左邊線＋已使用票色。
 * 取捨：車站不在大綱樹裡——選取＝只開所屬路線；結果上限由 repository 決定（50）；組字中不處理任何快捷鍵。
 * M3 ④：結果列的済看 `currentOccurrences`（定期券的済蓋在班次上，nodes.status 一路是 todo）；
 *        定期券的 scheduled_on ＝引擎排出來的下一班，跳轉提示因此講「下一班 M/D」。
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { KIND_LABEL, parseRule, type NodeKind, type NodeRow } from "../../domain";
import { ancestorsOf, useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";
import { todayKey } from "../../lib/date";
import { roundelStyle } from "./roundel";
import "./overlay.css";

/** 類型徽章上的單字（票根 badge 風格；臨時車票另用「臨」） */
const KIND_GLYPH: Record<NodeKind, string> = {
  line: "幹",
  route: "路",
  branch: "支",
  train: "列",
  car: "廂",
  ticket: "票",
  station: "站",
};

export function QuickJump() {
  const open = useUiStore((s) => s.quickJumpOpen);
  if (!open) return null;
  return <QuickJumpPanel />;
}

async function jumpTo(node: NodeRow) {
  const ui = useUiStore.getState();
  const ns = useNodeStore.getState();
  ui.setQuickJumpOpen(false);

  if (node.kind === "route") {
    await ns.openRoute(node.id);
    ui.setPage("routemap"); // 樹裡的東西家在路線圖頁；從今日頁跳過來要跟著換頁（整合席）
    ui.setZoom(null);
    ui.select(null);
    return;
  }
  // 臨時車票（parent_id 為 null）不在任何一棵路線樹裡 → 它的家是今日視圖（M3 ③ WP3）。
  //   有執行日 → 切到今日頁並選中（排在未來的那幾張今天看不到，補一句 toast 說它排在哪天）
  //   沒有執行日 → 還在收件匣資料態（UI 留 M4），只吐一句提示，不做無效跳轉
  if (node.kind === "ticket" && !node.parent_id) {
    if (!node.scheduled_on) {
      ui.showToast({ message: `『${node.name}』還沒有執行日，先待在收件匣（M4 開張）` });
      return;
    }
    ui.setPage("today");
    ui.select(node.id);
    if (node.scheduled_on > todayKey(ui.dayStartHour)) {
      const [, m, d] = node.scheduled_on.split("-");
      // 定期券的 scheduled_on ＝引擎排出來的**下一班**（這一班済／運休之後就推走了），講法要跟著換
      const when = parseRule(node.repeat_rule) ? `的下一班是 ${Number(m)}/${Number(d)}` : `排在 ${Number(m)}/${Number(d)}`;
      ui.showToast({ message: `『${node.name}』${when}，今天的清單還看不到` });
    }
    return;
  }
  if (!node.route_id) {
    ui.showToast({ message: `「${node.name}」沒有所屬路線，暫時無法跳轉` });
    return;
  }
  await ns.openRoute(node.route_id);
  // openRoute 之後才拿最新的樹
  const { tree, routeId } = useNodeStore.getState();
  ui.setPage("routemap"); // 同上：跳樹內節點必定回路線圖頁，否則選了卻看不到（整合席）
  ui.setZoom(null);
  if (node.kind === "station") {
    ui.select(null);
    return;
  }
  ui.expand(ancestorsOf(tree, routeId, node.id));
  ui.select(node.id);
}

/** 結果列左側徽章：路線＝roundel（路線色圓底＋代碼／圓點）；其餘＝類型徽章（臨時車票虛線「臨」） */
function ResultBadge({ node, done }: { node: NodeRow; done: boolean }) {
  if (node.kind === "route") {
    // 填色圓牌走淺色階（亮盤深字；換算與理由見 ./roundel）
    const disc = roundelStyle(node.color);
    return node.code ? (
      <span aria-hidden className="roundel" style={disc}>
        {node.code}
      </span>
    ) : (
      <span aria-hidden className="roundel">
        <i className="dot" style={{ background: disc.background }} />
      </span>
    );
  }
  const temp = node.kind === "ticket" && !node.parent_id;
  return (
    <span
      role="img"
      aria-label={temp ? "臨時車票" : KIND_LABEL[node.kind]}
      className={`ns-kind-badge${temp ? " is-dashed" : ""}${done ? " is-done" : ""}`}
    >
      {temp ? "臨" : KIND_GLYPH[node.kind]}
    </span>
  );
}

function QuickJumpPanel() {
  const routes = useNodeStore((s) => s.routes);
  const lines = useNodeStore((s) => s.lines);
  /** 定期券的済看「目前班次」的結局（M3 ④ 全站口徑），不看 nodes.status；退役定期券表裡無值，退回 status */
  const currentOccurrences = useNodeStore((s) => s.currentOccurrences);
  const close = useUiStore((s) => s.setQuickJumpOpen);

  const [q, setQ] = useState("");
  const [results, setResults] = useState<NodeRow[]>([]);
  const [active, setActive] = useState(0);
  const [pending, setPending] = useState(false);
  const reqRef = useRef(0);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();

  const term = q.trim();

  useEffect(() => {
    if (!term) {
      setResults([]);
      setPending(false);
      return;
    }
    setPending(true);
    const id = ++reqRef.current;
    const timer = setTimeout(() => {
      void useNodeStore
        .getState()
        .searchNodes(term)
        .then((rows) => {
          if (id !== reqRef.current) return; // 過期的回應
          setResults(rows);
          setActive(0);
          setPending(false);
        });
    }, 150);
    return () => clearTimeout(timer);
  }, [term]);

  useEffect(() => {
    const el = listRef.current?.children[active] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [active, results]);

  const contextOf = (node: NodeRow): string => {
    if (node.kind === "route") return lines.find((l) => l.id === node.line_id)?.name ?? "";
    if (node.kind === "ticket" && !node.parent_id) return "臨時車票";
    return routes.find((r) => r.id === node.route_id)?.name ?? "";
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Escape") {
      e.preventDefault();
      close(false);
      return;
    }
    if (!results.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const n = results[active];
      if (n) void jumpTo(n);
    }
  };

  const activeId = results[active] ? `${listId}-${results[active].id}` : undefined;

  return (
    <div
      className="techo-veil fixed inset-0 z-50 flex items-start justify-center pt-[10vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close(false);
      }}
    >
      <div className="ns-qj ns-card w-[540px] max-w-[92vw] overflow-hidden transition duration-150 ease-out starting:opacity-0 starting:translate-y-1">
        <p className="techo-overline px-5 pt-4">搜尋・跳轉 — QUICK JUMP</p>
        <input
          autoFocus
          role="combobox"
          aria-expanded={results.length > 0}
          aria-controls={listId}
          aria-activedescendant={activeId}
          aria-label="搜尋・跳轉"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="跳到路線、列車、車廂、車票…"
          spellCheck={false}
          className="techo-input ns-qj-input font-display"
        />

        <div className="techo-scroll max-h-[52vh] overflow-y-auto">
          {!term ? (
            <p className="px-5 py-4 text-[12px] leading-6 text-ink-soft">輸入名稱，跳到路線、支線、列車、車廂或車票（含臨時車票）。</p>
          ) : results.length === 0 ? (
            <p className="px-5 py-4 text-[12.5px] text-ink-soft">{pending ? "搜尋中…" : `找不到『${term}』`}</p>
          ) : (
            <ul ref={listRef} id={listId} role="listbox" aria-label="搜尋結果" className="py-1.5">
              {results.map((node, i) => {
                const isActive = i === active;
                const occ = currentOccurrences[node.id];
                const done = occ ? occ.status === "done" : node.status === "done";
                const ctx = contextOf(node);
                return (
                  <li
                    key={node.id}
                    id={`${listId}-${node.id}`}
                    role="option"
                    aria-selected={isActive}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => void jumpTo(node)}
                    className={`ns-qj-row flex items-center gap-3 pl-4 pr-5 py-[7px] cursor-pointer${isActive ? " is-active" : ""}`}
                  >
                    <ResultBadge node={node} done={done} />
                    <span
                      className={`min-w-0 flex-1 truncate font-display text-[14px] tracking-[0.02em] ${
                        done ? "text-ink-faint line-through decoration-ink/35" : ""
                      }`}
                    >
                      {node.name}
                    </span>
                    {done && (
                      <span className="shrink-0 font-display font-semibold text-[12px] text-seal" aria-label="已完成">
                        済
                      </span>
                    )}
                    {ctx && <span className="shrink-0 max-w-[38%] truncate text-[11px] tracking-[0.06em] text-ink-faint">{ctx}</span>}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="techo-foot flex gap-4 px-5 py-2">
          <span>↑↓ 移動</span>
          <span>Enter 前往</span>
          <span>Esc 關閉</span>
        </div>
      </div>
    </div>
  );
}
