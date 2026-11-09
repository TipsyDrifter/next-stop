/**
 * 手機詳情頁（手機殼班 D-主-69 全同等、D-主-75 全螢幕子頁、D-主-78 重複規則照現況；原型 `prototypes/主線-手機殼班.html` Q2 A 版）。
 * MobileShell 掛一份；`useMobileDetailStore.nodeId` 有值就用共用 `MFullPage` 畫「車票／列車／車廂詳情」——手機沒有側板，這頁就是它。
 *
 * 節點從哪來：同桌機 DetailPanel（tree ＞ today 切片，都沒有就問 repository；切片每次 reload 都換物件＝版本號，補撈的那份跟著刷新）。
 *   問到「沒有／已刪除」＝自己關（刪掉、同步收到別台刪除、復原前的那一刻都一樣）；還在問的那一下只畫空頁、不關。
 * 返回層：MFullPage 用 `core.detail` 登記 "full"（返回鍵＝‹ 返回）；疊在頁上的子 sheet（日期／時刻／移動到…／路線）一律 "dialog"，
 *   返回鍵一次關最上面那一層（backStack 檔頭的規矩）。MSheet 開的那一刻底下有 "full" 就自動當 "dialog"、z 抬到頁之上（.is-over），
 *   所以不收 backKind 的 MobileTimeSheet 也不必繞（第一輪的兄弟 SubLayer 先登記、detail.css 抬 z 兩處繞法已拿掉）。
 *
 * 欄位（由上而下＝原型 Q2 A）：票根列（路線徽章・路線名・票號・票種）→ 名稱（襯線大字，blur／Enter 存）→ 概要（多行，blur 存）
 *   → 路線（只有臨時車票；= 桌機「所屬路線」）→ 票種（乘車券⇄定期券；切定期券展開重複規則、切回清掉規則）
 *   → 時段組（回饋甲 D-主-129，同桌機側板）：乘車日 → 時段（開始 → 結束兩格，各開時刻 sheet）→ 長度（分段鈕＋自訂）→ 插槽 section "schedule" → 締切日
 *   → 重複（可收合段）→ 心情三燈（只給列車／車廂；收官磨光 Q1 起車票不畫，規格 §5）→ 各線 nodeFields 的 Mobile 列（荷札…）→ 乘務記錄清單＋記一句 → 競合 → 移動到… → 刪除。
 *   支線＝名稱・概要・各線欄位・移動到…・轉為列車・刪除（同桌機 BranchPanel）；其他種類只給名稱・移動到…・刪除。
 *   反方評審 #3 補齊桌機側板有、清單漏掉的（MobileStateRows）：名稱下「完成於」；重複段之後＝検印（車票済章／定期券本班済・運休・本班日期・本班時刻）；
 *   心情那一組前面加現況・優先順序（列車／車廂；車票＝検印之前一列優先順序，D-主-133）；之後分量（花費・進度）；移動到…之後「轉為支線」（列車）。
 * 寫入一律走既有動作、桌機同一支：
 *   名稱／概要／心情／締切日 → `updateNode`；乘車日 → `updateNode(…, { backfill: true })`（D-主-67：改到過去＝補記，同桌機 ScheduledChip）；
 *   時段開始 → `updateNode`（scheduled_time）並出手機的時刻收據（timeReceipt，同 useMobileToday.setTime）；時段結束／長度 → `updateNode`（estimate_min）；重複／票種 → `setRepeatRule`（MobileRepeatSection）；
 *   路線標籤 → `setRouteTag`；乘務記錄 → `addWorkLog`；移動到… → `moveNodeTo`（toast＋復原）；刪除 → `deleteTicket`（子項 ≥5／不知道就先問、toast＋復原；先關頁再刪）。
 * 定期券（parseRule 才算；退役的也一樣）：乘車日唯讀「依重複設定排班」；時段是「每班」（逐班改在検印下的「本班日期」「本班時刻」與票卡 ⋯「本班改時刻…」）。
 * 第四輪（D-主-85）：路線也從這頁開（路線圖第二層抬頭 ⋯「路線詳情…」）——路線不在 tree／today 切片，改從 nodeStore.routes 找；
 *   內容換畫 ./MobileRouteBody（桌機 RoutePanel＋StationList 的手機版），本檔只分流。
 */
import { useEffect, useMemo, useState } from "react";
import { KIND_LABEL, WORK_LOG_EVENT_LABEL, describeConflict, isTaskKind, parseRule, type NodeKind, type NodeRow } from "../../../domain";
import { REPEATABLE_KINDS, nodeRepo } from "../../../data";
import { effectiveTime, isTimeOverridden } from "../../../domain/scheduledTime";
import { currentDest, moveTargetRule } from "../../../domain/moveTo";
import type { AttachTarget } from "../../../domain/notes";
import { todayKey } from "../../../lib/date";
import { lineNodeFields } from "../../../lines/runtime";
import { conflictNameOf, isSettling, serialOf, useNodeStore } from "../../../store/nodeStore";
import { useUiStore } from "../../../store/uiStore";
import { CommitInput, CommitTextarea } from "../../common/fields";
import { MFullPage } from "../../common/MFullPage";
import { MobileAttachPicker } from "../../common/MobileAttachPicker";
import { MobileDatePicker, type DateQuick } from "../../common/MobileDatePicker";
import { dateQuickSet } from "../../common/DateChip";
import { IconClose } from "../../common/icons";
import { Segmented } from "../../common/Segmented";
import { moveNodeTo } from "../../common/moveTo";
import "../../common/moveTo.css";
import { MOODS } from "../../complete/moods";
import { fareClass } from "../../outline/OutlineRow";
import { convertKindFlow, moveRunFlow, resetRunTimeFlow } from "../../outline/nodeFlows";
import { useMinuteTick } from "../../schedule/useMinuteTick";
import { MobileTimeSheet, timeReceipt } from "../MobileTimeSheet";
import { confirmAndDeleteNode } from "../../common/deleteNodeFlow";
import { mdwText, runDateBounds, switchFare } from "../../panel/panelRules";
import { spanEnd } from "../../panel/clockValue";
import { LengthField } from "../../panel/TimeField";
import { useRepeatDraft } from "../../panel/useRepeatDraft";
import { fmtLogStamp, splitLogs, timeCardOf } from "./detailModel";
import { MobileRepeatSection } from "./MobileRepeatSection";
import { MobileRouteBody } from "./MobileRouteBody";
import { useMobileDetailStore } from "./mobileDetailStore";
import { AmountRows, DoneAt, PriorityRow, Row, StampRows, StatusRows } from "./MobileStateRows";
import { MobileStationRow } from "./MobileStationRow";
import "./detail.css";

/** 全螢幕頁那一層的返回層 id */
const PAGE_LAYER = "core.detail";
/** 疊在頁上的日期／時刻 sheet 那一層（同一時間只開一張；種類由 MSheet 自己認成 "dialog"） */
const SUB_LAYER = "core.detail.sub";

export function MobileDetailHost() {
  const nodeId = useMobileDetailStore((s) => s.nodeId);
  if (!nodeId) return null;
  return <DetailPage key={nodeId} nodeId={nodeId} />;
}

/* ───────────── 找節點＋外框 ───────────── */

function DetailPage({ nodeId }: { nodeId: string }) {
  const close = useMobileDetailStore((s) => s.close);
  // 路線不在 tree／today 切片裡（tree 是它底下的節點）：從書封的路線清單找（第四輪）
  const sliced = useNodeStore((s) => s.tree.byId[nodeId] ?? s.today.byId[nodeId] ?? s.routes.find((r) => r.id === nodeId));
  const tree = useNodeStore((s) => s.tree);
  const today = useNodeStore((s) => s.today);
  const occ = useNodeStore((s) => s.currentOccurrences);
  const calendar = useNodeStore((s) => s.calendar);
  /** 問 repository 的結果；null＝還在問。切片都換過一次就重問（刪除／同步／搬走都會換切片） */
  const [fetched, setFetched] = useState<{ row: NodeRow | null } | null>(null);
  useEffect(() => {
    let alive = true;
    void nodeRepo
      .getNode(nodeId)
      .then((n) => {
        if (alive) setFetched({ row: n && !n.deleted_at ? n : null });
      })
      .catch(() => {
        if (alive) setFetched({ row: null });
      });
    return () => {
      alive = false;
    };
  }, [nodeId, tree, today, occ, calendar]);

  const gone = !sliced && fetched !== null && fetched.row === null;
  useEffect(() => {
    if (gone) close();
  }, [gone, close]);

  const node = sliced ?? fetched?.row ?? undefined;

  // 換 tab＝離開這頁（手機殼班反方評審 #6）：頁裡掛的別線欄位會把人帶去別的 tab（筆記列點一則／「還有 N 則」、荷札點牌子），
  // 頁不關就蓋在那個 tab 上面，看起來像點了沒反應。在這裡統一收，不必每個跳轉入口各記得關。
  useEffect(
    () =>
      useUiStore.subscribe((s, prev) => {
        if (s.mobileTab !== prev.mobileTab) close();
      }),
    [close],
  );

  return (
    <MFullPage title={node ? `${KIND_LABEL[node.kind]}詳情` : "詳情"} left={{ label: "返回", back: true, onClick: close }} backId={PAGE_LAYER}>
      {node && (node.kind === "route" ? <MobileRouteBody route={node} onClose={close} /> : <DetailBody node={node} onClose={close} />)}
    </MFullPage>
  );
}

type Sub =
  | { kind: "date"; title: string; value: string | null; quick: readonly DateQuick[]; min?: string; max?: string; onPick(day: string): void }
  | { kind: "time" }
  /** 時段的結束（MobileTimeSheet end 模式；改結束＝重算長度） */
  | { kind: "end" }
  /** 定期券本班時刻（MobileTimeSheet run 模式） */
  | { kind: "run"; railDate: string }
  | { kind: "move"; from: AttachTarget }
  | { kind: "route" };

/* ───────────── 內容 ───────────── */

function DetailBody({ node, onClose }: { node: NodeRow; onClose: () => void }) {
  const updateNode = useNodeStore((s) => s.updateNode);
  const showToast = useUiStore((s) => s.showToast);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const today = todayKey(dayStartHour);
  const [sub, setSub] = useState<Sub | null>(null);
  const closeSub = () => setSub(null);

  const task = isTaskKind(node.kind) || node.kind === "ticket";
  const moveRule = moveTargetRule(node.kind);

  /** 先問到父節點的種類才開挑選器（要標「目前位置」；同 MobileTicketSheet.startMove） */
  const startMove = async () => {
    let parentKind: NodeKind | null = null;
    if (node.parent_id) {
      const s = useNodeStore.getState();
      parentKind = s.routes.some((r) => r.id === node.parent_id)
        ? "route"
        : ((s.tree.byId[node.parent_id] ?? s.today.byId[node.parent_id])?.kind ??
          (await nodeRepo.getNode(node.parent_id))?.kind ??
          null);
    }
    setSub({ kind: "move", from: currentDest(node.parent_id, parentKind, node.route_id) });
  };

  const remove = () => {
    // 先關頁再刪（同票卡 ⋯ 的 D-2）：確認框與 toast＋復原都在共用流程（今日／行程表同一支）
    onClose();
    void confirmAndDeleteNode(node.id);
  };

  return (
    <div className="m-dt">
      <Stub node={node} />
      <CommitInput
        value={node.name}
        onCommit={(name) => void updateNode(node.id, { name })}
        required
        wrap
        ariaLabel="名稱"
        className="m-dt-name"
      />
      <DoneAt node={node} />
      {node.kind !== "station" && (
        <div className="m-dt-note">
          <CommitTextarea
            value={node.description ?? ""}
            onCommit={(v) => void updateNode(node.id, { description: v || null })}
            ariaLabel="概要"
            placeholder="概要：補一句要做到什麼程度…"
          />
        </div>
      )}

      {task ? (
        <TaskFields node={node} today={today} setSub={setSub} />
      ) : (
        <LineFieldRows node={node} />
      )}

      {moveRule && (
        <button type="button" className="m-dt-link" onClick={() => void startMove()}>
          <span>移動到…</span>
          <span className="m-dt-link-aside">
            <RouteLabel routeId={node.route_id} empty={node.parent_id === null ? "臨時車票" : "—"} />
          </span>
          <span className="m-dt-chev" aria-hidden="true">
            ›
          </span>
        </button>
      )}

      {/* 轉種類（同桌機：列車→支線、支線→列車；車廂不給，setKind 也會擋） */}
      {(node.kind === "train" || node.kind === "branch") && (
        <button type="button" className="m-dt-link" onClick={() => void convertKindFlow(node, node.kind === "train" ? "branch" : "train")}>
          <span>{node.kind === "train" ? "轉為支線" : "轉為列車"}</span>
          <span className="m-dt-link-aside">{node.kind === "train" ? "把這班列車改成支線" : "把這條支線改成一班列車"}</span>
          <span className="m-dt-chev" aria-hidden="true">
            ›
          </span>
        </button>
      )}

      <button type="button" className="ns-btn btn-ghost ns-btn-danger m-dt-delete" onClick={remove}>
        刪除{KIND_LABEL[node.kind]}
      </button>

      {/* ── 疊在頁上的子 sheet（同一時間一張；返回鍵＝關這一張） ── */}
      {sub?.kind === "date" && (
        <MobileDatePicker
          title={sub.title}
          value={sub.value}
          min={sub.min}
          max={sub.max}
          today={today}
          quick={sub.quick}
          onPick={(d) => {
            closeSub();
            if (d !== sub.value) sub.onPick(d);
          }}
          onClose={closeSub}
          backId={SUB_LAYER}
          backKind="dialog"
        />
      )}
      {sub?.kind === "time" && <TimeSub node={node} today={today} onClose={closeSub} />}
      {sub?.kind === "end" && <EndSub node={node} today={today} onClose={closeSub} />}
      {sub?.kind === "run" && <RunTimeSub node={node} railDate={sub.railDate} today={today} onClose={closeSub} />}
      {sub?.kind === "move" && moveRule && (
        <MobileAttachPicker
          title={moveRule.label}
          depth={moveRule.depth}
          kinds={moveRule.depth === "node" ? moveRule.kinds : undefined}
          routeSelectable={moveRule.routeSelectable}
          value={sub.from}
          excludeId={node.id}
          currentNote="目前位置"
          backKind="dialog"
          onPick={(t) => {
            closeSub();
            void moveNodeTo(node.id, { routeId: t.routeId, nodeId: t.nodeId });
          }}
          onClose={closeSub}
        />
      )}
      {sub?.kind === "route" && (
        <MobileAttachPicker
          title="所屬路線"
          depth="route"
          value={{ routeId: node.route_id, nodeId: null, nodeKind: node.route_id ? "route" : null }}
          backKind="dialog"
          onPick={(t) => {
            closeSub();
            if (t.routeId !== node.route_id) void tagRoute(node.id, t.routeId, showToast);
          }}
          onClear={
            node.route_id
              ? () => {
                  closeSub();
                  void tagRoute(node.id, null, showToast);
                }
              : undefined
          }
          clearLabel="改成無路線"
          onClose={closeSub}
        />
      )}
    </div>
  );
}

/** 臨時車票的路線標籤（桌機 TicketPanel.tag 同一支動作與失敗句） */
async function tagRoute(
  id: string,
  routeId: string | null,
  showToast: ReturnType<typeof useUiStore.getState>["showToast"],
): Promise<void> {
  const r = await useNodeStore.getState().setRouteTag(id, routeId);
  if (!r.ok) showToast({ message: r.reason ?? "無法加上路線" }, 4000);
}

/* ───────────── 票根列 ───────────── */

function Stub({ node }: { node: NodeRow }) {
  const route = useNodeStore((s) => (node.route_id ? s.routes.find((r) => r.id === node.route_id) : undefined));
  const todaySerial = useNodeStore((s) => s.today.byId[node.id]?.serial);
  const serials = useNodeStore((s) => s.serials);
  // 票號單一真相同桌機 NameBlock：今日索引有算過就用它，否則查 store 的票號表
  const serial = todaySerial ?? serialOf(serials, node.id);
  // 票種：定期券只認 parseRule；其餘走大綱那支共用的 fareClass（臨時券／支線／乘車券）
  const fare = parseRule(node.repeat_rule) ? { label: "定期券", teiki: true } : fareClass({ ...node, repeat_rule: null });
  const color = route?.color ?? "var(--route-none)";
  return (
    <div className="m-dt-stub">
      <span className={"m-dt-route" + (route ? "" : " is-none")} style={{ ["--c" as string]: color }} aria-hidden="true">
        {route ? (route.code ?? route.name.slice(0, 1)) : "臨"}
      </span>
      <span className="m-dt-route-name">{route ? route.name : "無路線"}</span>
      {serial && <span className="m-dt-serial">No.{serial}</span>}
      <span className={"m-dt-fare" + (fare.teiki ? " is-teiki" : "")}>{fare.label}</span>
    </div>
  );
}

function RouteLabel({ routeId, empty }: { routeId: string | null; empty: string }) {
  const route = useNodeStore((s) => (routeId ? s.routes.find((r) => r.id === routeId) : undefined));
  if (!route) return <>{empty}</>;
  return <>{route.code ? `${route.code}・${route.name}` : route.name}</>;
}

/* ───────────── 列車／車廂／車票的欄位 ───────────── */

function TaskFields({ node, today, setSub }: { node: NodeRow; today: string; setSub: (s: Sub) => void }) {
  const updateNode = useNodeStore((s) => s.updateNode);
  const repeatable = REPEATABLE_KINDS.includes(node.kind);
  const { draft, push } = useRepeatDraft(node);
  const [repOpen, setRepOpen] = useState(false);
  /** 定期券（含退役的）：掛著規則就不給直改乘車日（repository 的 reschedule 只看 parseRule） */
  const ruled = parseRule(node.repeat_rule) !== null;
  const isTemp = node.kind === "ticket" && node.parent_id === null;
  const plainFare = fareClass({ ...node, repeat_rule: null }).label;

  const pickDate = (
    title: string,
    value: string | null,
    quick: readonly DateQuick[],
    onPick: (d: string) => void,
    range?: { min?: string; max?: string },
  ) => setSub({ kind: "date", title, value, quick, onPick, ...range });

  return (
    <>
      <div className="m-dt-group">
        {isTemp && (
          <Row label="路線">
            <button type="button" className="m-dt-pick" onClick={() => setSub({ kind: "route" })}>
              <RouteLabel routeId={node.route_id} empty="無路線" />
              <span className="m-dt-chev" aria-hidden="true">
                ›
              </span>
            </button>
          </Row>
        )}

        {repeatable && (
          <Row label="票種">
            <Segmented
              options={[
                { value: "plain", label: plainFare },
                { value: "teiki", label: "定期券" },
              ]}
              value={draft.mode === "none" ? "plain" : "teiki"}
              onChange={(v) => {
                const teiki = v === "teiki";
                push(switchFare(draft, teiki));
                // 切定期券＝展開重複規則給人看；切回＝規則已清，段落照舊（段頭寫「不重複」）
                if (teiki) setRepOpen(true);
              }}
              aria-label="票種"
            />
          </Row>
        )}

        <Row label="乘車日">
          {ruled ? (
            <span className="m-dt-locked">
              {node.scheduled_on ? mdwText(node.scheduled_on) : "—"}
              <span className="m-dt-sub">・依重複設定排班</span>
            </span>
          ) : (
            <DatePick
              value={node.scheduled_on}
              empty="沒排日期"
              label="乘車日"
              // 選日期 sheet 的快選＝「今天／昨天／前天」（E20 手機補記；票卡 ⋯ 選日期… 同一套）
              onOpen={() =>
                pickDate("乘車日", node.scheduled_on, dateQuickSet("backward", today), (d) => {
                  const syncDue = Boolean(node.scheduled_on && node.due_on === node.scheduled_on);
                  void updateNode(
                    node.id,
                    syncDue ? { scheduled_on: d, due_on: d } : { scheduled_on: d },
                    { backfill: true },
                  );
                })
              }
              // D-主-67：日期欄親手選＝帶 backfill（選到今天以前＝補記；清除時 repository 不當補記）
              onClear={() => void updateNode(node.id, { scheduled_on: null }, { backfill: true })}
            />
          )}
        </Row>

        {/* 時段組（回饋甲 D-主-129；原型 q3-A 手機）：乘車日 → 時段 → 長度 → 〔插槽 section "schedule"〕→ 締切日，同桌機側板 */}
        <Row label="時段">
          <SpanButtons node={node} ruled={ruled} onStart={() => setSub({ kind: "time" })} onEnd={() => setSub({ kind: "end" })} />
        </Row>

        <Row label="長度" tall>
          <LengthField value={node.estimate_min} onCommit={(v) => void updateNode(node.id, { estimate_min: v })} compact={false} />
        </Row>

        <ScheduleLineRows node={node} />

        <Row label="締切日">
          <div style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, minWidth: 0 }}>
            <DatePick
              value={node.due_on}
              empty="未設定"
              label="締切日"
              onOpen={() =>
                pickDate(
                  "締切日",
                  node.due_on,
                  node.scheduled_on
                    ? [{ label: "＝同乘車日", day: node.scheduled_on }, ...dateQuickSet("forward", today)]
                    : dateQuickSet("forward", today),
                  (d) => void updateNode(node.id, { due_on: d }),
                )
              }
              onClear={() => void updateNode(node.id, { due_on: null })}
            />
            {node.scheduled_on && (
              <button
                type="button"
                className={"ns-qa-chip" + (node.due_on === node.scheduled_on ? " is-on" : "")}
                aria-pressed={node.due_on === node.scheduled_on}
                title="將締切日設為與乘車日同一天"
                onClick={() =>
                  void updateNode(node.id, {
                    due_on: node.due_on === node.scheduled_on ? null : node.scheduled_on,
                  })
                }
              >
                <span className="k">＝同乘車日</span>
              </button>
            )}
          </div>
        </Row>

        {/* ⑫：車站（規則同桌機側板 useStationField：沒有子項、路線上有車站才出） */}
        <MobileStationRow node={node} />
      </div>

      {repeatable && (
        <MobileRepeatSection
          node={node}
          draft={draft}
          push={push}
          open={repOpen}
          onToggle={() => setRepOpen((o) => !o)}
          onPickDate={(title, cur, done, min) => pickDate(title, cur, [], done, { min })}
        />
      )}

      <div className="m-dt-group is-after-sec">
        {/* 車票的優先順序（D-主-133）：車票沒有現況列，獨立一列放在検印之前（列車／車廂的在 StatusRows 裡） */}
        {node.kind === "ticket" && <PriorityRow node={node} />}
        <StampRows
          node={node}
          onRunTime={() => {
            const day = useNodeStore.getState().currentOccurrences[node.id]?.due_on ?? node.scheduled_on;
            if (day) setSub({ kind: "run", railDate: day });
          }}
          onRunDate={(railDate) => {
            // 範圍同 runMoveBlock（今天起、不早於起算日、不晚於結束日）；快選也只留範圍內的
            const { min, max } = runDateBounds(parseRule(node.repeat_rule), today);
            const quick = dateQuickSet("forward", today).filter((q) => q.day >= min && (!max || q.day <= max));
            pickDate(
              "本班日期",
              railDate,
              quick,
              (d) => {
                if (!isSettling(node.id)) void moveRunFlow(node.id, railDate, d);
              },
              { min, max },
            );
          }}
        />
        {isTaskKind(node.kind) && <StatusRows node={node} />}
        {/* 收官磨光 Q1（規格 §5：心情只在列車／車廂的完成卡選填、跟著済章；車票沒有心情欄）——車票不畫，同桌機車票側板 */}
        {node.kind !== "ticket" && (
          <Row label="心情">
            <MoodLights value={node.mood} onChange={(m) => void updateNode(node.id, { mood: m })} />
          </Row>
        )}
        <AmountRows node={node} />
      </div>

      <LineFieldRows node={node} />
      <WorkLogs node={node} />
    </>
  );
}

/** 日期列：整列可點開日期 sheet；有值時右邊一顆 ×（清除；同 DateChip clearable 的位置） */
function DatePick({
  value,
  empty,
  label,
  onOpen,
  onClear,
}: {
  value: string | null;
  empty: string;
  label: string;
  onOpen(): void;
  onClear(): void;
}) {
  // × 疊在整列鈕的 › 左邊（不擠在 › 右邊：› 永遠貼列尾，跟沒有值的列對齊）
  return (
    <div className={"m-dt-datepick" + (value ? " has-clear" : "")}>
      <button type="button" className="m-dt-pick" aria-label={`${label}：${value ? mdwText(value) : empty}`} onClick={onOpen}>
        {value ? <span>{mdwText(value)}</span> : <span className="is-empty">{empty}</span>}
        <span className="m-dt-chev" aria-hidden="true">
          ›
        </span>
      </button>
      {value && (
        <button type="button" className="ns-iconbtn m-dt-clear" aria-label={`清除${label}`} title="清除" onClick={onClear}>
          <IconClose />
        </button>
      )}
    </div>
  );
}

/**
 * 時段兩格（D-主-129；原型 q3-A 手機「兩格各點一下開時間 sheet」）：開始 → 結束，各 44 高。
 *   開始＝開 rule 模式的時刻 sheet（不帶「預計多久」：只改開始＝整段平移，長度不動；「不排時刻」＝清開始、長度保留）；
 *   結束＝開 end 模式（改結束＝重算長度；等於或早於開始由框的範圍擋下）。沒排開始＝結束格停用（淡「—」）。
 *   定期券＝每班時刻，開始格前印「每班」。
 */
function SpanButtons({ node, ruled, onStart, onEnd }: { node: NodeRow; ruled: boolean; onStart(): void; onEnd(): void }) {
  const start = node.scheduled_time;
  const end = spanEnd(start, node.estimate_min);
  return (
    <div className="m-dt-span">
      {ruled && <span className="m-dt-sub">每班</span>}
      <button type="button" className="m-dt-hmbtn" aria-label={`開始時刻：${start ?? "不排時刻"}`} onClick={onStart}>
        {start ? <b className="m-dt-hm">{start}</b> : <span className="is-empty">不排</span>}
      </button>
      <span className="m-dt-span-arr" aria-hidden="true">
        →
      </span>
      <button
        type="button"
        className="m-dt-hmbtn"
        aria-label={start ? `結束時刻：${end ?? "沒有"}` : "結束時刻：先排開始"}
        disabled={!start}
        onClick={onEnd}
      >
        {end ? <b className="m-dt-hm">{end}</b> : <span className="is-empty">—</span>}
      </button>
    </div>
  );
}

/** 時刻 sheet（MobileTimeSheet rule 模式＝單發票的時刻／定期券的每班時刻；長度另有一列 ⇒ withLen=false）；寫入與收據同 useMobileToday.setTime */
function TimeSub({ node, today, onClose }: { node: NodeRow; today: string; onClose(): void }) {
  const occ = useNodeStore((s) => s.currentOccurrences[node.id]);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const now = useMinuteTick();
  const card = useMemo(() => timeCardOf(node, occ), [node, occ]);
  const setTime = (time: string | null, estimateMin?: number | null) => {
    const patch: { scheduled_time: string | null; estimate_min?: number | null } = { scheduled_time: time };
    if (estimateMin !== undefined) patch.estimate_min = estimateMin;
    void useNodeStore
      .getState()
      .updateNode(node.id, patch)
      .then((r) => {
        if (r.ok) useUiStore.getState().showToast({ message: timeReceipt("rule", time) }, 2400);
      });
  };
  return (
    <MobileTimeSheet
      card={card}
      mode="rule"
      withLen={false}
      today={today}
      dayStartHour={dayStartHour}
      now={now}
      backId={SUB_LAYER}
      onCommit={(time, est) => {
        setTime(time, est);
        onClose();
      }}
      onClear={() => {
        if (card.ruleTime !== null) setTime(null);
        onClose();
      }}
      onClose={onClose}
    />
  );
}

/** 時段的結束（MobileTimeSheet end 模式）：確定＝新長度寫回 estimate_min（同桌機時段結束格；值就在列上，不另出收據） */
function EndSub({ node, today, onClose }: { node: NodeRow; today: string; onClose(): void }) {
  const occ = useNodeStore((s) => s.currentOccurrences[node.id]);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const now = useMinuteTick();
  const card = useMemo(() => timeCardOf(node, occ), [node, occ]);
  return (
    <MobileTimeSheet
      card={card}
      mode="end"
      today={today}
      dayStartHour={dayStartHour}
      now={now}
      backId={SUB_LAYER}
      onCommit={(_end, len) => {
        if (typeof len === "number" && len > 0) void useNodeStore.getState().updateNode(node.id, { estimate_min: len });
        onClose();
      }}
      onClear={onClose}
      onClose={onClose}
    />
  );
}

/** 定期券本班時刻（MobileTimeSheet run 模式；寫入與收據同 useMobileToday.setRunTime／clearRunTime、桌機 RunTimeRow 同一支 store 動作） */
function RunTimeSub({ node, railDate, today, onClose }: { node: NodeRow; railDate: string; today: string; onClose(): void }) {
  const occ = useNodeStore((s) => s.currentOccurrences[node.id]);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const now = useMinuteTick();
  const card = useMemo(
    () => ({
      ...timeCardOf(node, occ),
      railDate,
      time: effectiveTime(node, railDate),
      timeOverridden: isTimeOverridden(node, railDate),
    }),
    [node, occ, railDate],
  );
  const setRun = (time: string | null) =>
    void useNodeStore
      .getState()
      .setRunTime(node.id, railDate, time)
      .then((r) => {
        if (r.ok) useUiStore.getState().showToast({ message: timeReceipt("run", time) }, 2400);
      });
  return (
    <MobileTimeSheet
      card={card}
      mode="run"
      today={today}
      dayStartHour={dayStartHour}
      now={now}
      backId={SUB_LAYER}
      onCommit={(time) => {
        setRun(time);
        onClose();
      }}
      onClear={() => {
        setRun(null);
        onClose();
      }}
      onReset={() => {
        void resetRunTimeFlow(node.id, railDate);
        onClose();
      }}
      onClose={onClose}
    />
  );
}

/** 心情三燈（字與色＝complete/moods.ts，完成卡與桌機側板同一份）；再按同一盞＝熄掉 */
function MoodLights({ value, onChange }: { value: NodeRow["mood"]; onChange: (m: NodeRow["mood"]) => void }) {
  const cur = MOODS.find((m) => m.value === value);
  return (
    <div className="m-dt-moods" role="group" aria-label="心情">
      {MOODS.map((m) => {
        const on = value === m.value;
        return (
          <button
            key={m.value}
            type="button"
            className="m-dt-mood"
            style={{ color: m.color }}
            aria-label={`心情：${m.label}`}
            aria-pressed={on}
            title={on ? `${m.label}（再按一次清除）` : m.label}
            onClick={() => onChange(on ? null : m.value)}
          >
            <span>{m.glyph}</span>
          </button>
        );
      })}
      <span className="m-dt-mood-word">{cur ? cur.label : "還沒選"}</span>
    </div>
  );
}

/**
 * 各線登記的節點欄位的手機列（插槽 nodeFields 的 Mobile；接法同 MobileRouteMap 唯讀詳情）；沒有任何一線登記＝不出 DOM。
 * section "schedule" 的不在這裡：畫在時段組裡（ScheduleLineRows，長度之後、締切日之前，同桌機側板）。
 */
function LineFieldRows({ node }: { node: NodeRow }) {
  const fields = lineNodeFields("mobile").filter((f) => f.Mobile && f.kinds.includes(node.kind) && f.section !== "schedule");
  if (!fields.length) return null;
  return <div className="m-dt-lines">{fields.map((f) => (f.Mobile ? <f.Mobile key={f.id} node={node} /> : null))}</div>;
}

/** 時段組裡的別線欄位（插槽 nodeFields 的 section "schedule"，例：時刻表⑦「其他時段」）；沒登記＝不出 DOM */
function ScheduleLineRows({ node }: { node: NodeRow }) {
  const fields = lineNodeFields("mobile").filter((f) => f.Mobile && f.kinds.includes(node.kind) && f.section === "schedule");
  if (!fields.length) return null;
  return (
    <div className="m-dt-lines is-in-group">{fields.map((f) => (f.Mobile ? <f.Mobile key={f.id} node={node} /> : null))}</div>
  );
}

/* ───────────── 乘務記錄＋競合 ───────────── */

function WorkLogs({ node }: { node: NodeRow }) {
  const logs = useNodeStore((s) => s.workLogs[node.id]);
  const loadWorkLogs = useNodeStore((s) => s.loadWorkLogs);
  const addWorkLog = useNodeStore((s) => s.addWorkLog);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  // 系統事件（発券／入鋏／済）是 store 順手寫的、不會回頭通知：拿 updated_at 當重載訊號（同桌機 WorkLogList）
  useEffect(() => {
    void loadWorkLogs(node.id);
  }, [node.id, node.updated_at, loadWorkLogs]);
  const { entries, conflicts, manual } = useMemo(() => splitLogs(logs), [logs]);

  const submit = async () => {
    const body = draft.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      // 寫進去才清框（失敗由 store 寫 error 列；字留著可以再按一次）
      if (await addWorkLog(node.id, body)) setDraft("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section className="m-dt-sec">
        <h3 className="m-dt-sec-title">
          {/* 計數只算主人手記（桌機段頭同一把尺）；一則都沒有就不印，免得旁邊掛著発券列還寫「還沒有」 */}
          乘務記錄{manual > 0 && <span className="m-dt-sec-aside">{manual} 則</span>}
        </h3>
        {logs === undefined ? (
          <p className="m-dt-empty">讀取中…</p>
        ) : (
          entries.length > 0 && (
            <ul className="m-dt-logs">
              {entries.map((l) => (
                <li key={l.id} className={l.event ? "is-evt" : undefined}>
                  <span className="m-dt-tm">{fmtLogStamp(l.logged_at)}</span>
                  {/* 事件列（発券／入鋏／済）印事件名；手記走主人筆跡 */}
                  <span className={l.event ? "m-dt-evt" : "m-dt-hw"}>{l.event ? WORK_LOG_EVENT_LABEL[l.event] : l.body}</span>
                </li>
              ))}
            </ul>
          )
        )}
        <div className="m-dt-logadd">
          <input
            type="text"
            className="m-dt-loginput"
            placeholder="記一句…"
            aria-label="記一句乘務記錄"
            enterKeyHint="done"
            autoComplete="off"
            value={draft}
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === "Enter") {
                e.preventDefault();
                void submit();
              }
            }}
          />
          <button type="button" className="ns-btn btn-seal" disabled={busy || !draft.trim()} onClick={() => void submit()}>
            記入
          </button>
        </div>
      </section>

      {/* 競合（同步衝突的敗方值；D-1.1-5）：系統講的話走印刷體，同 MobileRouteMap 唯讀詳情那段 */}
      {conflicts.length > 0 && (
        <div className="m-dt-conflict">
          <span className="m-dt-label">競合</span>
          <ul>
            {conflicts.map((l) => (
              <li key={l.id}>
                <span className="m-dt-tm">{fmtLogStamp(l.logged_at)}</span>
                {describeConflict(l.body, conflictNameOf)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
