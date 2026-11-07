/**
 * MobileSelectionBar——手機的選取列（回饋乙 D-主-152；契約 §4；原型 prototypes/回饋乙-拖曳多選右鍵.html 第 6 段）。
 * 今日、行程表、路線圖第二層各掛一個（傳自己的 scope）；選了 ≥1 張才出現。
 *
 * 落點：tab bar 之上的一段（`.m-selbar-dock`，flex:none）——跟完成卡同一種做法：頁面元件回 Fragment，
 *   本元件是殼根節點的直接子節點、排在頁面之後、tab bar 之前；`.m-page` 自己縮，最後一張票捲得到。
 *   開著時今日的建票列收起、toast 與「記一句」浮鈕抬到它之上（mobile-select.css）。
 * 內容：「已選 N 張」＋常用三顆（蓋済、執行日、移動到…）＋「更多」（優先級、荷札、運休、刪除）＋「取消」。
 *   每顆圖示鈕下方有兩個字，另補 aria-label＋title（讀屏與長按提示）。
 * 動作全部呼叫 store/batchActions（桌機選取列同一份：逐張寫、一次 refresh、一則「已改 N 張」＋復原）；做完選取照舊留著
 *   （還可以接著改別的），只有刪除會清掉。做不到的動作淡掉、點了說為什麼（觸控看不到 title）。
 * 返回層：選取本身登記一層 "page"（返回＝取消多選；比子頁層晚登記＝先退它）；「更多」與它的子面板＝一層 sheet `core.selectionSheet`；
 *   日期面板用同一個 id；移動挑選器自己登記（MobileAttachPicker）。
 *
 * ⑫ 看板（scope "board"）：`lookup`＝選到的票從哪裡找（篩選清單跨路線，不在那三份切片裡）；「更多」多一項「車站…」——
 *   都同一條路線、那條路線有車站才出（同桌機選取列；列上放不下第五顆，同全選收在「更多」）。
 * 缺什麼就在這裡包一層（batchActions 不改）：
 *   - 移動到…：batchActions.batchMoveTo 只收 parentId；挑選器的種類規則（moveTargetRule）與「選到的種類不一樣」的停用在這裡判。
 *   - 荷札：只給能掛荷札的種類（TAG_ENTITY_NODE_KINDS：車票、列車、車廂）；掛哪個由這裡的小面板挑（打字＋常用＋已掛的可拿掉）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { NodeRow, Priority } from "../../domain/node";
import { moveTargetRule } from "../../domain/moveTo";
import type { TaskRow } from "../../domain/taskFilter";
import { stationItems } from "../board/boardMenu";
import { TAG_ENTITY_NODE_KINDS, keysOfEntity, suggest } from "../../domain/tags";
import { todayKey } from "../../lib/date";
import {
  batchAttachTag,
  batchComplete,
  batchDelete,
  batchDetachTag,
  batchMoveTo,
  batchSetDate,
  batchSetPriority,
  batchSkip,
} from "../../store/batchActions";
import { useNodeStore } from "../../store/nodeStore";
import { useSelectionStore, type SelectionScope, visibleIn } from "../../store/selectionStore";
import { useTagStore } from "../../store/tagStore";
import { useUiStore } from "../../store/uiStore";
import { dateQuickSet } from "../common/DateChip";
import { MSheet, MSheetItem } from "../common/MSheet";
import { MobileAttachPicker } from "../common/MobileAttachPicker";
import { MobileDatePicker } from "../common/MobileDatePicker";
import { PRIORITY_OPTIONS } from "../panel/panelRules";
import { useBackLayer } from "./backStack";
import { useScopeSelection } from "./mobileSelect";
import "./mobile-polish.css";
import "./routemap/ticket-sheet.css";
import "../common/moveTo.css";

const SHEET_LAYER = "core.selectionSheet";

type Sheet = "more" | "date" | "move" | "priority" | "tags" | "station" | null;

/** 選到的那幾張的節點：路線樹＞今日切片＞行程表切片（三頁各自載的那份） */
function nodeOf(id: string): NodeRow | undefined {
  const s = useNodeStore.getState();
  return s.tree.byId[id] ?? s.today.byId[id] ?? s.calendar.nodes[id];
}

const toast = (message: string) => useUiStore.getState().showToast({ message }, 3600);

/* ── 圖示（1.3px 細線，同 tab bar 筆觸） ── */
function IconCal() {
  return (
    <svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2.4" y="3.4" width="11.2" height="10" rx="1" />
      <path d="M2.4 6.6h11.2M5.4 2v2.6M10.6 2v2.6" />
    </svg>
  );
}
function IconMove() {
  return (
    <svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2.5 5.5V3.4c0-.5.4-.9.9-.9h3l1.4 1.6h4.8c.5 0 .9.4.9.9v1.5" />
      <path d="M2.5 7.5v5.1c0 .5.4.9.9.9h9.2c.5 0 .9-.4.9-.9V8.4" />
      <path d="M6 10.4h4.6M9 8.8l1.6 1.6L9 12" />
    </svg>
  );
}
function IconDots() {
  return (
    <svg width="17" height="17" viewBox="0 0 16 16" aria-hidden>
      <g fill="currentColor">
        <circle cx="3.2" cy="8" r="1.3" />
        <circle cx="8" cy="8" r="1.3" />
        <circle cx="12.8" cy="8" r="1.3" />
      </g>
    </svg>
  );
}

export function MobileSelectionBar({ scope, lookup = nodeOf }: { scope: SelectionScope; lookup?: (id: string) => NodeRow | undefined }) {
  const ids = useScopeSelection(scope);
  const [sheet, setSheet] = useState<Sheet>(null);
  const close = () => setSheet(null);
  const active = ids.length > 0;
  useBackLayer(`core.selection.${scope}`, active, () => useSelectionStore.getState().clear(), "page");
  useBackLayer(SHEET_LAYER, active && sheet !== null && sheet !== "move", close);
  // 選取被清光（取消、刪除、清單換了）時，開著的面板一起收
  useEffect(() => {
    if (!active) setSheet(null);
  }, [active]);
  const dayStartHour = useUiStore((s) => s.dayStartHour);

  /** 選到的種類能不能一起「移動到…」：同一套挑選規則才行 */
  const move = useMemo(() => {
    if (!active) return null;
    const rules = ids.map((id) => {
      const n = lookup(id);
      return n ? moveTargetRule(n.kind) : null;
    });
    if (rules.some((r) => r === null)) return { why: "選到的項目裡有不能移動的", rule: null };
    if (new Set(rules.map((r) => r!.label)).size > 1) return { why: "選到的種類放不進同一個地方", rule: null };
    return { why: null, rule: rules[0]! };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, ids]);

  const picks = ids.map(lookup).filter((n): n is NodeRow => !!n);
  const stationRoute = scope === "board" && picks.length && picks.every((n) => n.route_id && n.route_id === picks[0].route_id && !(n as TaskRow).has_kids) ? picks[0].route_id : null;
  const hasStations = useNodeStore((s) => !!stationRoute && s.stations.some((st) => st.parent_id === stationRoute));

  if (!active) return null;
  const today = todayKey(dayStartHour);
  const count = ids.length;
  const nodes = picks;
  const anyRepeat = nodes.some((n) => !!n.repeat_rule);
  const taggable = nodes.every((n) => TAG_ENTITY_NODE_KINDS.includes(n.kind));
  /** 全部同一天＝日期面板標出那天；不一樣就不標 */
  const sameDay = nodes.length && nodes.every((n) => n.scheduled_on === nodes[0].scheduled_on) ? nodes[0].scheduled_on : null;
  const snapshot = () => [...useSelectionStore.getState().ids];

  const run = (fn: (ids: string[]) => unknown) => () => {
    const cur = snapshot();
    close();
    void fn(cur);
  };
  const explain = (why: string) => () => toast(why);

  return (
    <>
      <div className="m-selbar-dock">
        <div className="m-selbar techo-card" role="toolbar" aria-label="選取列">
          <span className="m-selbar-cnt" aria-live="polite">
            已選<b>{count}</b>張
          </span>
          <button type="button" className="m-selbar-ib" aria-label={`蓋済——${count} 張`} title="蓋済" onClick={() => void batchComplete(snapshot())}>
            <span className="m-selbar-seal" aria-hidden>
              済
            </span>
            蓋済
          </button>
          <button type="button" className="m-selbar-ib" aria-label="改執行日…" title="改執行日" onClick={() => setSheet("date")}>
            <IconCal />
            執行日
          </button>
          <button
            type="button"
            className={"m-selbar-ib" + (move?.why ? " is-off" : "")}
            aria-label="移動到…"
            aria-disabled={move?.why ? true : undefined}
            title={move?.why ?? "移動到…"}
            onClick={move?.why ? explain(move.why) : () => setSheet("move")}
          >
            <IconMove />
            移動
          </button>
          <button type="button" className="m-selbar-ib" aria-label="更多動作" aria-haspopup="dialog" title="更多" onClick={() => setSheet("more")}>
            <IconDots />
            更多
          </button>
          <button type="button" className="m-selbar-x" onClick={() => useSelectionStore.getState().clear()}>
            取消
          </button>
        </div>
      </div>

      {sheet === "more" && (
        <MSheet list title={`已選 ${count} 張`} backId={SHEET_LAYER} onClose={close}>
          {/* ⑧ 同類：桌機的全選在選取列；手機選取列放不下第五顆，收在「更多」第一項 */}
          {visibleIn(scope).length > count && (
            <MSheetItem
              onClick={() => {
                useSelectionStore.getState().set(scope, visibleIn(scope));
                close();
              }}
            >
              全選這一頁
            </MSheetItem>
          )}
          {hasStations && <MSheetItem onClick={() => setSheet("station")}>車站…</MSheetItem>}
          <MSheetItem onClick={() => setSheet("priority")}>優先級…</MSheetItem>
          <MSheetItem
            off={!taggable}
            onClick={taggable ? () => setSheet("tags") : explain("荷札只能掛在車票、列車、車廂上")}
          >
            荷札…
          </MSheetItem>
          <MSheetItem off={!anyRepeat} onClick={anyRepeat ? run(batchSkip) : explain("只有定期券能運休")}>
            本班運休
          </MSheetItem>
          <MSheetItem cut danger onClick={run(batchDelete)}>
            刪除 {count} 張
          </MSheetItem>
        </MSheet>
      )}

      {sheet === "priority" && (
        <MSheet list title="優先級" backId={SHEET_LAYER} onClose={close}>
          {[...PRIORITY_OPTIONS].reverse().map((o) => (
            <MSheetItem key={o.value} onClick={run((cur) => batchSetPriority(cur, o.value as Priority))}>
              {o.label}
            </MSheetItem>
          ))}
        </MSheet>
      )}

      {sheet === "station" && stationRoute && (
        <MSheet list title="車站" overline={`已選 ${count} 張`} backId={SHEET_LAYER} onClose={close}>
          {stationItems(nodes, stationRoute).map((it) => (
            <MSheetItem
              key={it.key}
              onClick={() => {
                close();
                it.onSelect?.();
              }}
            >
              {it.label}
            </MSheetItem>
          ))}
        </MSheet>
      )}

      {sheet === "date" && (
        <MobileDatePicker
          title={`改執行日・${count} 張`}
          value={sameDay}
          today={today}
          quick={dateQuickSet("forward", today)}
          onPick={(d) => run((cur) => batchSetDate(cur, d))()}
          onClear={run((cur) => batchSetDate(cur, null))}
          clearLabel="清除執行日"
          onClose={close}
          backId={SHEET_LAYER}
        />
      )}

      {sheet === "move" && move?.rule && (
        <MobileAttachPicker
          title={move.rule.label}
          depth={move.rule.depth}
          kinds={move.rule.depth === "node" ? move.rule.kinds : undefined}
          routeSelectable={move.rule.routeSelectable}
          value={null}
          excludeId={count === 1 ? ids[0] : undefined}
          onPick={(t) => {
            const parentId = t.nodeId ?? t.routeId;
            const cur = snapshot();
            close();
            if (parentId) void batchMoveTo(cur, parentId);
          }}
          onClose={close}
        />
      )}

      {sheet === "tags" && <TagSheet ids={ids} onClose={close} />}
    </>
  );
}

/** 荷札：打字掛上（沒有就建）、點常用的掛上、點已掛的拿掉 */
function TagSheet({ ids, onClose }: { ids: string[]; onClose(): void }) {
  const index = useTagStore((s) => s.index);
  const [q, setQ] = useState("");
  const composing = useRef(false);
  useEffect(() => {
    if (!useTagStore.getState().index) void useTagStore.getState().loadIndex();
  }, []);
  const attached = useMemo(() => {
    if (!index) return [];
    const keys = new Set<string>();
    for (const id of ids) for (const k of keysOfEntity(index, "node", id)) keys.add(k);
    return [...keys].map((k) => ({ key: k, name: index.byKey[k]?.name ?? k })).sort((a, b) => (a.name < b.name ? -1 : 1));
  }, [index, ids]);
  const items = index ? suggest(index, q, { limit: 10 }).items : [];
  const attach = (name: string) => {
    const n = name.trim().replace(/^#/, "");
    if (!n) return;
    onClose();
    void batchAttachTag([...ids], n);
  };
  return (
    <MSheet
      title="荷札"
      overline={`已選 ${ids.length} 張`}
      backId={SHEET_LAYER}
      onClose={onClose}
      foot={
        <>
          <button type="button" className="ns-btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button type="button" className="ns-btn btn-seal" disabled={!q.trim()} onClick={() => attach(q)}>
            掛上
          </button>
        </>
      }
    >
      <div className="m-seltag-row">
        <input
          className="m-nt-input m-txs-input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onKeyDown={(e) => {
            // IME 三道護欄（同建票列）：isComposing／229／composition 旗標
            if (e.nativeEvent.isComposing || e.keyCode === 229 || composing.current) return;
            if (e.key === "Enter") {
              e.preventDefault();
              attach(q);
            }
          }}
          placeholder="荷札名稱（沒有就新建）"
          aria-label="要掛上的荷札名稱"
          enterKeyHint="done"
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      <p className="m-seltag-h">{q.trim() ? "符合的荷札" : "常用"}</p>
      {items.length ? (
        <div className="m-seltag-chips">
          {items.map((it) => (
            <button key={it.key} type="button" className="m-seltag-chip" onClick={() => attach(it.name)}>
              #{it.name}
            </button>
          ))}
        </div>
      ) : (
        <p className="m-seltag-empty">{index ? "還沒有荷札——打字後按「掛上」新建一個" : "荷札載入中…"}</p>
      )}
      {attached.length > 0 && (
        <>
          <p className="m-seltag-h">已掛的（點一下從選到的票上拿掉）</p>
          <div className="m-seltag-chips">
            {attached.map((t) => (
              <button
                key={t.key}
                type="button"
                className="m-seltag-chip is-rm"
                aria-label={`拿掉荷札 ${t.name}`}
                onClick={() => {
                  onClose();
                  void batchDetachTag([...ids], t.key);
                }}
              >
                #{t.name} <span aria-hidden>×</span>
              </button>
            ))}
          </div>
        </>
      )}
    </MSheet>
  );
}
