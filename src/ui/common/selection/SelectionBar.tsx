/**
 * SelectionBar——桌機多選的選取列（回饋乙 D-主-152；契約 §4；原型 prototypes/回饋乙-拖曳多選右鍵.html 第 02 段）。
 *
 * 選了 ≥1 張就在內容區（App 的 <main>）底部浮出一條 `.techo-card`：
 *   「已選 N 張」｜［蓋済］［執行日］［移動到…］［更多 ▾］｜［× 取消］
 *   己-2 A4（D-主-413）：原本八顆攤開，比照手機收成「常用三顆＋更多」；更多＝PopMenu：優先級 ▾（高中低）、荷札…、本班運休、刪除 N 張（赭）。
 * 規範：一個區域一顆主鈕（法則 03）——這一條沒有實心主鈕，全是次鈕／危險鈕／文字鈕；材質＝浮（§1.5）；
 *   小卡＝錨定 popover（§2.4：執行日用共用 DatePicker、更多用 PopMenu、荷札一張小卡、移動到…用 AttachPicker）。
 * 動作一律呼叫 store/batchActions（一批寫完、一則 toast、一次復原）；做不到的停用並說原因（title）。
 * 掛在大綱、今日、行程表串流三頁；`lookup` 交「這一頁的節點表」（運休要看定期券、移動到…要看種類）。
 * 位置：portal 進 <main>（相對定位、不捲）——頁面本身（.page）會捲，放在頁裡就跟著內容跑了。
 * 選取列開著時 toast 往上讓（selection.css：`html[data-selbar]`），兩條不互蓋。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { capsOfHotkey } from "../../shell/hotkeys";
import { createPortal } from "react-dom";
import { nodeRepo } from "../../../data";
import { parseRule, type NodeRow, type Priority } from "../../../domain";
import { moveTargetRule } from "../../../domain/moveTo";
import { todayKey } from "../../../lib/date";
import {
  batchAttachTag,
  batchComplete,
  batchDelete,
  batchDetachTag,
  batchMoveTo,
  batchSetDate,
  batchSetPriority,
  batchSkip,
} from "../../../store/batchActions";
import { useNodeStore } from "../../../store/nodeStore";
import { useSelectionStore, type SelectionScope, visibleIn } from "../../../store/selectionStore";
import { useTagStore } from "../../../store/tagStore";
import { useUiStore } from "../../../store/uiStore";
import { AttachPicker } from "../AttachPicker";
import { dateQuickSet } from "../DateChip";
import { DatePicker } from "../DatePicker";
import { PopMenu } from "../PopMenu";
import { OverlineText } from "../PageHeader";
import { usePopDismiss } from "../../notes/notesBits";
import "../../notes/notes.css";
import "../moveTo.css";
import "./selection.css";

export interface SelectionBarProps {
  scope: SelectionScope;
  /** 這一頁的節點（選到的 id → 節點）；查不到的不算 */
  lookup(id: string): NodeRow | undefined;
}

type Pop = "date" | "more" | "tag" | "move" | null;

const PRIORITY: { value: Priority; label: string }[] = [
  { value: "high", label: "高" },
  { value: "mid", label: "中" },
  { value: "low", label: "低" },
];

/** 移動到…：選到的種類能不能放進同一種父節點（車票、車廂一組；列車、支線一組） */
function moveRuleOf(nodes: NodeRow[]): { rule: ReturnType<typeof moveTargetRule>; why: string | null } {
  const rules = nodes.map((n) => moveTargetRule(n.kind));
  if (!nodes.length) return { rule: null, why: "沒有選到可以搬的項目" };
  if (rules.some((r) => r === null)) return { rule: null, why: "選到的項目裡有不能搬的種類" };
  const first = rules[0]!;
  if (rules.some((r) => r!.label !== first.label)) return { rule: null, why: "選到的種類不同（車票、車廂要放進列車；列車、支線要放進路線），放不進同一個地方" };
  return { rule: first, why: null };
}

const SELECT_ALL_HOTKEY: Record<SelectionScope, string> = {
  today: "today.select.all",
  outline: "outline.select.all",
  schedule: "daylist.select.all",
};

export function SelectionBar({ scope, lookup }: SelectionBarProps) {
  const ids = useSelectionStore((s) => (s.scope === scope ? s.ids : null));
  const clear = useSelectionStore((s) => s.clear);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  // 節點表換了（寫入後重載）要重算停用狀態：訂閱 store 的版本當依賴
  const treeVer = useNodeStore((s) => s.tree);
  const todayVer = useNodeStore((s) => s.today);
  const tagIndex = useTagStore((s) => s.index);
  const [pop, setPop] = useState<Pop>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const probe = useRef<HTMLSpanElement>(null);
  const btns = useRef<Partial<Record<Exclude<Pop, null>, HTMLButtonElement | null>>>({});

  useLayoutEffect(() => {
    setHost(probe.current?.closest("main") ?? document.body);
  }, []);

  const count = ids?.length ?? 0;
  const open = count > 0;
  useEffect(() => {
    if (!open) {
      setPop(null);
      return;
    }
    document.documentElement.setAttribute("data-selbar", "desktop");
    return () => document.documentElement.removeAttribute("data-selbar");
  }, [open]);

  // 換頁、換路線時頁面會清選取；這裡另外保險：元件卸載（離開這一頁）就清
  useEffect(() => () => useSelectionStore.getState().clear(), []);

  const nodes = useMemo(
    () => (ids ?? []).map((id) => lookup(id)).filter((n): n is NodeRow => !!n),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ids, lookup, treeVer, todayVer],
  );
  const teikiCount = nodes.filter((n) => parseRule(n.repeat_rule)).length;
  const move = moveRuleOf(nodes);
  const datable = nodes.filter((n) => !parseRule(n.repeat_rule)).length;

  if (!open) return <span ref={probe} hidden />;

  const sel = ids!;
  const toggle = (p: Exclude<Pop, null>) => setPop((cur) => (cur === p ? null : p));
  const closePop = () => setPop(null);
  const today = todayKey(dayStartHour);

  const visible = visibleIn(scope);
  const bar = (
    <div className="ns-selbar techo-card" role="toolbar" aria-label="選取列" onKeyDown={(e) => onBarKey(e, closePop, clear, pop)}>
      <span className="cnt" aria-live="polite">
        已選 <b>{count}</b> 張
      </span>
      {/* ⑧ 同類：全選原本只有快捷鍵；還沒選滿才出現 */}
      {visible.length > count && (
        <button
          type="button"
          className="ns-btn ns-btn--sm btn-text"
          title={`全選這一頁（${capsOfHotkey(SELECT_ALL_HOTKEY[scope])}）`}
          onClick={() => useSelectionStore.getState().set(scope, visibleIn(scope))}
        >
          全選
        </button>
      )}
      <span className="sep" aria-hidden />
      <button type="button" className="ns-btn ns-btn--sm btn-ghost" onClick={() => void batchComplete(sel)} title="全部蓋上済章">
        蓋済
      </button>
      <button
        type="button"
        ref={(el) => void (btns.current.date = el)}
        className="ns-btn ns-btn--sm btn-ghost"
        aria-haspopup="dialog"
        aria-expanded={pop === "date"}
        data-pop-toggle
        disabled={datable === 0}
        title={datable === 0 ? "定期券的執行日照規則排，不能直接改" : "改執行日"}
        onClick={() => toggle("date")}
      >
        執行日
      </button>
      <button
        type="button"
        ref={(el) => void (btns.current.move = el)}
        className="ns-btn ns-btn--sm btn-ghost"
        aria-haspopup="dialog"
        aria-expanded={pop === "move"}
        data-pop-toggle
        disabled={!move.rule}
        title={move.why ?? "搬到別的列車、車廂或路線"}
        onClick={() => toggle("move")}
      >
        移動到…
      </button>
      {/* 己-2 A4（D-主-413）：比照手機「常用三顆＋更多」——優先級、荷札、運休、刪除收進「更多」 */}
      <button
        type="button"
        ref={(el) => void (btns.current.more = el)}
        className="ns-btn ns-btn--sm btn-ghost"
        aria-haspopup="menu"
        aria-expanded={pop === "more"}
        title="優先級、荷札、本班運休、刪除"
        onClick={() => toggle("more")}
      >
        更多 ▾
      </button>
      <span className="sep" aria-hidden />
      <button type="button" className="ns-btn ns-btn--sm btn-text x" title="取消選取（Esc）" onClick={clear}>
        × 取消
      </button>

      {pop === "date" && (
        <DatePicker
          label={`改 ${datable} 張的執行日`}
          anchor={btns.current.date ?? null}
          quick={dateQuickSet("forward", today)}
          today={today}
          onPick={(d) => {
            closePop();
            void batchSetDate(sel, d);
          }}
          onClear={() => {
            closePop();
            void batchSetDate(sel, null);
          }}
          onClose={closePop}
        />
      )}
      {pop === "more" && (
        <PopMenu
          anchor={btns.current.more ?? null}
          overline={{ zh: `已選 ${count} 張`, latin: "More" }}
          label={`${count} 張的其他動作`}
          items={[
            // 優先級＝可展開的一組（PopMenu group，同大綱 ⋯ 的「編排 ▾」），點開才列出高中低
            ...PRIORITY.map((p) => ({ key: `prio-${p.value}`, label: p.label, group: "優先級", onSelect: () => void batchSetPriority(sel, p.value) })),
            { key: "tag", label: "荷札…", onSelect: () => setPop("tag") },
            {
              key: "skip",
              label: "本班運休",
              disabled: teikiCount === 0,
              why: "運休只給定期券——選到的都不是",
              onSelect: () => void batchSkip(sel),
            },
            { key: "delete", label: `刪除 ${count} 張`, cut: true, danger: true, onSelect: () => batchDelete(sel) },
          ]}
          onClose={closePop}
        />
      )}
      {pop === "tag" && <TagPop ids={sel} onClose={closePop} hasIndex={!!tagIndex} />}
      {pop === "move" && move.rule && (
        <div className="ns-moveto ns-selbar-pop is-move">
          <AttachPicker
            depth={move.rule.depth}
            kinds={move.rule.depth === "node" ? move.rule.kinds : undefined}
            routeSelectable={move.rule.routeSelectable}
            value={{ routeId: nodes[0]?.route_id ?? null, nodeId: null, nodeKind: null }}
            label={`${move.rule.label}（${count} 張）`}
            float
            excludeId={sel.length === 1 ? sel[0] : undefined}
            onPick={(t) => {
              closePop();
              const parentId = t.nodeId ?? t.routeId;
              if (!parentId) return;
              void (async () => {
                const p = await nodeRepo.getNode(parentId);
                await batchMoveTo(sel, parentId, p?.name);
              })();
            }}
            onClose={closePop}
          />
        </div>
      )}
    </div>
  );

  return (
    <>
      <span ref={probe} hidden />
      {host && createPortal(<div className="ns-selbar-dock">{bar}</div>, host)}
    </>
  );
}

/** 選取列上的 Esc：有小卡先收小卡；沒有就取消選取（焦點不在頁面容器上時，頁面的 Esc 收不到） */
function onBarKey(e: KeyboardEvent, closePop: () => void, clear: () => void, pop: Pop) {
  if (e.key !== "Escape" || e.nativeEvent.isComposing) return;
  e.preventDefault();
  e.stopPropagation();
  if (pop) closePop();
  else clear();
}

/** 荷札小卡：上面列出這批共同掛著的（點 × 摘下）；下面輸入名字（Enter 掛上，沒有就建），打字時給幾個現成的荷札 */
function TagPop({ ids, onClose, hasIndex }: { ids: readonly string[]; onClose: () => void; hasIndex: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  usePopDismiss(ref, onClose);
  useEffect(() => {
    void useTagStore.getState().loadIndex();
    input.current?.focus();
  }, []);
  const ts = useTagStore.getState();
  const common = hasIndex
    ? ids
        .map((id) => new Set(ts.keysOf("node", id)))
        .reduce<Set<string> | null>((acc, s) => (acc ? new Set([...acc].filter((k) => s.has(k))) : s), null) ?? new Set<string>()
    : new Set<string>();
  const sug = hasIndex && q.trim() ? ts.suggest(q, { limit: 5 }) : null;
  const attach = (name: string) => {
    if (!name.trim()) return;
    onClose();
    void batchAttachTag(ids, name.trim());
  };
  return (
    <div ref={ref} className="ns-selbar-pop is-tag techo-card" role="dialog" aria-label={`替 ${ids.length} 張掛荷札`}>
      <p className="techo-overline">
        <OverlineText value={{ zh: "荷札", latin: "Tags" }} />
      </p>
      {common.size > 0 && (
        <div className="row">
          {[...common].map((k) => (
            <button
              key={k}
              type="button"
              className="ns-selbar-tag"
              title={`從這 ${ids.length} 張摘下 #${ts.nameOf(k)}`}
              onClick={() => {
                onClose();
                void batchDetachTag(ids, k);
              }}
            >
              #{ts.nameOf(k)} <span aria-hidden>×</span>
            </button>
          ))}
        </div>
      )}
      <input
        ref={input}
        className="techo-input"
        type="text"
        placeholder="荷札名稱，Enter 掛上"
        aria-label="要掛上的荷札名稱"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === "Enter") {
            e.preventDefault();
            attach(q);
          }
        }}
      />
      {sug && (sug.items.length > 0 || sug.create) && (
        <div className="row">
          {sug.items.map((it) => (
            <button key={it.key} type="button" className="ns-selbar-tag is-add" onClick={() => attach(it.name)}>
              #{it.name}
            </button>
          ))}
          {sug.create && (
            <button type="button" className="ns-selbar-tag is-add" onClick={() => attach(sug.create!.name)}>
              ＋ 新荷札 #{sug.create.name}
            </button>
          )}
        </div>
      )}
      <p className="hint">{common.size ? "點上面的荷札＝從這幾張一起摘下。" : "掛上的荷札，這幾張都會有。"}</p>
    </div>
  );
}
