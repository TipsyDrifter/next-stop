/**
 * QuickJump——UI Flow 2.4 快速跳轉（Ctrl+P／側欄搜尋鈕；讀 uiStore.quickJumpOpen）：置頂紙卡，150ms debounce 搜尋節點與臨時車票，
 * ↑↓ 移動、Enter 選取、Esc 關閉、點擊選取。選取：路線→開路線；樹內節點→開所屬路線後展開祖先並選中；臨時車票→有執行日就切到今日頁選中；沒執行日、沒路線、未完成的是收件匣票→切到旅客筆記選中（車次①）；掛了路線的→該路線大綱頂層；済票不導向（調度 10-08）。
 * 視覺：浮層紙卡 .techo-card（UI 丙-1；霧面玻璃、不透字）＋ overline ＋ 大號底線輸入 ＋ 結果列（路線＝roundel、
 *       其餘＝原型 .badge 小號版類型徽章）＋襯線名稱＋淡字路線名；選中列 --sel-line 左邊線（粉彩靛、銀河金）＋已使用票色。
 * 取捨：車站不在大綱樹裡——選取＝只開所屬路線；結果上限由 repository 決定（50）；組字中不處理任何快捷鍵。
 * 接縫 #56（旅客筆記車次③ 0-5／0-7）：別線以 `LineMount.quickJump` 登記結果提供者。打的字以某個提供者的 `prefix` 開頭 ⇒ 只問它
 *   （去掉前綴後的字；只打前綴＝空字串），節點不查；否則節點結果之後每個提供者 `search(term, 4)` 各成一組（組名＝`group`，空組不畫）。
 *   鍵盤環與點擊走同一份合併後的列。沒有任何一線登記＝畫面與行為照舊。`jumpToNode` export 給線用（邊界規則只有這一份）。
 * M3 ④：結果列的済看 `currentOccurrences`（定期券的済蓋在班次上，nodes.status 一路是 todo）；
 *        定期券的 scheduled_on ＝引擎排出來的下一班，跳轉提示因此講「下一班 M/D」。
 * 磨光①（手機搜尋）：搜尋本身（`searchQuickJump`）、結果列型別、徽章與淡字抽成 export 給 `mobile/MobileQuickJump` 共用；
 *   桌機這個面板的行為不變。手機選了節點走 `jumpToNodeMobile`（routeMapReveal.ts），不走這裡的 `jumpToNode`。
 * 完整搜尋班（D-主-111）：有字時結果區外常駐一列「在完整搜尋看全部「X」→」（↓ 走到底停在它；Ctrl+Enter 直達；
 *   名稱裡找不到時 Enter 也去），空白時說明下一顆「完整搜尋」。前綴模式（只問某一線）不給。進頁走 `openFullSearch`。
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { KIND_LABEL, parseRule, type NodeKind, type NodeRow } from "../../domain";
import { ancestorsOf, useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";
import { todayKey } from "../../lib/date";
import { roundelStyle } from "./roundel";
import { lineQuickJumpProviders } from "../../lines/runtime";
import type { QuickJumpHit, QuickJumpProviderSpec } from "../../lines/types";
import { formatChord, hotkeyById } from "../shell/hotkeys";
import { openFullSearch } from "../search/openFullSearch";
import "./overlay.css";

/** 完整搜尋入口列的鍵帽（registry 一份真相；Mac 換 ⌘） */
const FULL_SEARCH_CAPS = formatChord(hotkeyById("global.fullsearch")!.chords[0]).join("+");
const CTRL_ENTER_CAPS = formatChord({ key: "Enter", ctrl: true }).join("+");

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

/** 結果列：節點，或別線提供者的一列（`group` 只有組內第一列帶，畫組名小標用）。手機搜尋（MobileQuickJump）共用 */
export type QuickJumpRow =
  | { type: "node"; key: string; node: NodeRow }
  | { type: "hit"; key: string; hit: QuickJumpHit; group?: string };
type Row = QuickJumpRow;

/** 附加組模式每個提供者給幾列；前綴模式的上限 */
const EXTRA_LIMIT = 4;
const PREFIX_LIMIT = 50;

async function askProvider(p: QuickJumpProviderSpec, term: string, limit: number): Promise<QuickJumpHit[]> {
  try {
    return await p.search(term, limit);
  } catch {
    return [];
  }
}

function hitRows(p: QuickJumpProviderSpec, hits: QuickJumpHit[], withGroup: boolean): Row[] {
  return hits.map((hit, i) => ({ type: "hit", key: `${p.id}:${hit.id}`, hit, group: withGroup && i === 0 ? p.group : undefined }));
}

/**
 * 一次搜尋（`term` 已 trim、非空）：以某個提供者的 `prefix` 開頭 ⇒ 只問它、節點不查；否則節點結果＋每個提供者各一組。
 * 桌機與手機搜尋共用這一支（磨光①：手機搜尋重用同一套搜尋與結果模型；`providers` 由呼叫端依殼取）。
 */
export function searchQuickJump(term: string, providers: readonly QuickJumpProviderSpec[]): Promise<QuickJumpRow[]> {
  const only = providers.find((p) => p.prefix && term.startsWith(p.prefix));
  return only
    ? // 前綴模式：只問那一個提供者，節點不查
      askProvider(only, term.slice(only.prefix!.length).trim(), PREFIX_LIMIT).then((hits) => hitRows(only, hits, false))
    : Promise.all([
        useNodeStore.getState().searchNodes(term),
        ...providers.map((p) => askProvider(p, term, EXTRA_LIMIT)),
      ]).then(([nodes, ...groups]) => [
        ...(nodes as NodeRow[]).map((node): Row => ({ type: "node", key: node.id, node })),
        ...groups.flatMap((hits, i) => hitRows(providers[i], hits as QuickJumpHit[], true)),
      ]);
}

/** 結果列右側的淡字：路線＝所屬幹線名；臨時車票＝「臨時車票」；其餘＝所屬路線名 */
export function quickJumpContext(node: NodeRow, routes: readonly NodeRow[], lines: readonly NodeRow[]): string {
  if (node.kind === "route") return lines.find((l) => l.id === node.line_id)?.name ?? "";
  if (node.kind === "ticket" && !node.parent_id) return "臨時車票";
  return routes.find((r) => r.id === node.route_id)?.name ?? "";
}

/** 跳到一個節點（Ctrl+P 選中、別線清單點車票共用；車次①偏差記錄的邊界全在這一支） */
export async function jumpToNode(node: NodeRow) {
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
  //   沒有執行日、沒掛路線標籤 → 家是旅客筆記的收件匣：切過去並選中（旅客筆記頁讀 selectedId 接手；車次①契約 0-2 甲）
  //   沒有執行日、掛了路線標籤 → 不算收件匣（D-筆-17），家在該路線大綱頂層（D-筆-26）：落到下面「開所屬路線」那段
  //   沒有執行日、沒路線、但已蓋済 → 收件匣濾掉 done，它的家是日後的 Logbook：不導向旅客筆記，走改前原路（調度 10-08 裁示）
  if (
    node.kind === "ticket" &&
    !node.parent_id &&
    !(node.route_id && !node.scheduled_on) &&
    !(node.status === "done" && !node.scheduled_on)
  ) {
    if (!node.scheduled_on) {
      ui.setPage("notes");
      ui.select(node.id);
      return;
    }
    ui.setPage("today");
    ui.select(node.id);
    if (node.scheduled_on > todayKey(ui.dayStartHour)) {
      const [, m, d] = node.scheduled_on.split("-");
      // 定期券的 scheduled_on ＝引擎排出來的**下一班**（這一班済／運休之後就推走了），講法要跟著換
      const when = parseRule(node.repeat_rule) ? `的下一班是 ${Number(m)}/${Number(d)}` : `排在 ${Number(m)}/${Number(d)}`;
      ui.showToast({ message: `「${node.name}」${when}，今天還不會出現在清單裡` });
    }
    return;
  }
  if (!node.route_id) {
    ui.showToast({ message: `「${node.name}」不屬於任何路線，無法跳轉` });
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

/** 結果列左側徽章：路線＝roundel（路線色圓底＋代碼／圓點）；其餘＝類型徽章（臨時車票虛線「臨」）。手機搜尋共用 */
export function ResultBadge({ node, done }: { node: NodeRow; done: boolean }) {
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
  const [results, setResults] = useState<Row[]>([]);
  const [active, setActive] = useState(0);
  const [pending, setPending] = useState(false);
  const reqRef = useRef(0);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();

  const term = q.trim();
  /** 已登記的提供者（已攤平：一條線可有多組；通車狀態在開啟期間不變） */
  const providers = useMemo(() => lineQuickJumpProviders(), []);
  const prefixed = providers.filter((p) => p.prefix);
  /** 打的字走某個提供者的前綴（只問那一線）＝不是節點搜尋，不給完整搜尋入口 */
  const prefixMode = prefixed.some((p) => term.startsWith(p.prefix!));
  /** 「在完整搜尋看全部」那一列在不在（D-主-111） */
  const moreOn = !!term && !prefixMode;

  useEffect(() => {
    if (!term) {
      setResults([]);
      setPending(false);
      return;
    }
    setPending(true);
    const id = ++reqRef.current;
    const timer = setTimeout(() => {
      const work: Promise<Row[]> = searchQuickJump(term, providers);
      void work.then((rows) => {
        if (id !== reqRef.current) return; // 過期的回應
        setResults(rows);
        setActive(0);
        setPending(false);
      });
    }, 150);
    return () => clearTimeout(timer);
  }, [term, providers]);

  useEffect(() => {
    const r = results[active];
    if (r) document.getElementById(`${listId}-${r.key}`)?.scrollIntoView({ block: "nearest" });
  }, [active, results, listId]);

  const choose = (r: Row) => {
    if (r.type === "node") {
      void jumpToNode(r.node);
      return;
    }
    close(false);
    void r.hit.go();
  };

  const contextOf = (node: NodeRow): string => quickJumpContext(node, routes, lines);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Escape") {
      e.preventDefault();
      close(false);
      return;
    }
    // 完整搜尋班 D-主-111：Ctrl+Enter＝帶著這個字到完整搜尋；找不到時 Enter 也去（完整搜尋還會查概要與乘務記錄）
    if (e.key === "Enter" && term && !prefixMode && (e.ctrlKey || e.metaKey || (!results.length && !pending))) {
      e.preventDefault();
      openFullSearch(term);
      return;
    }
    if (!results.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      // 「看全部」那一列也在鍵盤環裡（索引＝results.length）
      setActive((a) => Math.min(a + 1, results.length - (moreOn ? 0 : 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (moreOn && active === results.length) {
        openFullSearch(term);
        return;
      }
      const r = results[active];
      if (r) choose(r);
    }
  };

  const moreActive = moreOn && results.length > 0 && active === results.length;
  const activeId = moreActive ? `${listId}-more` : results[active] ? `${listId}-${results[active].key}` : undefined;

  return (
    <div
      className="techo-veil fixed inset-0 z-50 flex items-start justify-center pt-[10vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close(false);
      }}
    >
      <div className="ns-qj techo-card w-[540px] max-w-[92vw] overflow-hidden transition duration-150 ease-out starting:opacity-0 starting:translate-y-1">
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
          placeholder={`跳到路線、列車、車廂、車票…${prefixed.map((p) => `（打 ${p.prefix} 找${p.group}）`).join("")}`}
          spellCheck={false}
          className="techo-input ns-qj-input font-display"
        />

        <div className="techo-scroll max-h-[52vh] overflow-y-auto">
          {!term ? (
            <p className="px-5 py-4 text-[12px] leading-6 text-ink-soft">
              輸入名稱，跳到路線、支線、列車、車廂或車票（含臨時車票）。
              {prefixed.map((p) => (
                <span key={p.id}>
                  <br />
                  開頭輸入 {p.prefix} 只找{p.group}。
                </span>
              ))}
              <br />
              <button type="button" className="ns-qj-more is-inline" onClick={() => openFullSearch()}>
                完整搜尋<span className="kbd">{FULL_SEARCH_CAPS}</span>
              </button>
            </p>
          ) : results.length === 0 ? (
            <p className="px-5 py-4 text-[12.5px] text-ink-soft">{pending ? "搜尋中…" : `名稱裡找不到「${term}」`}</p>
          ) : (
            <ul ref={listRef} id={listId} role="listbox" aria-label="搜尋結果" className="py-1.5">
              {results.map((r, i) => {
                const isActive = i === active;
                if (r.type === "hit")
                  return (
                    <HitRow
                      key={r.key}
                      row={r}
                      id={`${listId}-${r.key}`}
                      active={isActive}
                      onHover={() => setActive(i)}
                      onPick={() => choose(r)}
                    />
                  );
                const node = r.node;
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
                    onClick={() => choose(r)}
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
        {/* 完整搜尋的入口（D-主-111）：有字就常駐在結果區外、不跟著捲——完整搜尋不限列數、還查概要與乘務記錄。
            ↓ 走到底會停在這一列（鍵盤環的最後一格） */}
        {moreOn && (
          <button
            type="button"
            id={`${listId}-more`}
            tabIndex={-1}
            className={`ns-qj-more${moreActive ? " is-active" : ""}`}
            onMouseEnter={() => results.length && setActive(results.length)}
            onClick={() => openFullSearch(term)}
          >
            <span className="min-w-0 truncate">在完整搜尋看全部「{term}」→</span>
            <span className="kbd">{CTRL_ENTER_CAPS}</span>
          </button>
        )}

        <div className="techo-foot flex gap-4 px-5 py-2">
          <span>↑↓ 移動</span>
          <span>Enter 前往</span>
          <span>Esc 關閉</span>
        </div>
      </div>
    </div>
  );
}

/** 別線提供者的一列（組的第一列前面畫組名小標；徽章借 `.ns-kind-badge`、縮排用 padding-left） */
function HitRow({
  row,
  id,
  active,
  onHover,
  onPick,
}: {
  row: Extract<Row, { type: "hit" }>;
  id: string;
  active: boolean;
  onHover(): void;
  onPick(): void;
}) {
  const { hit, group } = row;
  return (
    <>
      {group && (
        <li role="presentation" className="px-5 pt-2.5 pb-1 text-[11px] tracking-[0.12em] text-ink-faint">
          {group}
        </li>
      )}
      <li
        id={id}
        role="option"
        aria-selected={active}
        onMouseEnter={onHover}
        onClick={onPick}
        style={hit.indent ? { paddingLeft: 16 + hit.indent * 14 } : undefined}
        className={`ns-qj-row flex items-center gap-3 pl-4 pr-5 py-[7px] cursor-pointer${active ? " is-active" : ""}`}
      >
        {hit.glyph && (
          <span aria-hidden className={`ns-kind-badge${hit.glyph.dashed ? " is-dashed" : ""}`}>
            {hit.glyph.text}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate font-display text-[14px] tracking-[0.02em]">{hit.label}</span>
        {hit.aside && <span className="shrink-0 max-w-[38%] truncate text-[11px] tracking-[0.06em] text-ink-faint">{hit.aside}</span>}
      </li>
    </>
  );
}
