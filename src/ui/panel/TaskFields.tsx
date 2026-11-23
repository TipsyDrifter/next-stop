/**
 * 節點面板（UI Flow 2.1 · D1）：列車／車廂＝完整任務欄位＋工作日誌＋操作列；車票＝名稱・（臨時車票才有的）路線標籤・乘車日・検印蓋章・工作日誌；支線＝名稱・描述・轉為列車。
 * 列車／車廂／車票的票頭下也有「概要」（D-主-79，同支線那段；手機詳情頁同一個欄位）。
 * M3 ③ WP3 補到車票面板的兩段：**路線標籤選擇器**（a18–a21；只對 parent_id 為 null 的臨時車票顯示，
 * 走 nodeStore.setRouteTag，票根立刻換成該路線的色）與**工作日誌**（D-③-4 甲，直接掛既有 WorkLogList）。
 * 欄位 blur／Enter 才寫回（updateNode）；狀態改 done 走 setCompleted（父鏈重算；有未完成子項先問一次「連同 N 個子項？」），
 * 刪除＝子孫 ≥5 二次確認 → soft delete → 復原 toast（與大綱 F3 同語彙）。
 * 視覺＝原型語彙 1:1（class 定義在 techo.css 原型逐字移植段、側板版面在 panel.css）：
 * 票頭＝.panel-head（件一 m3-ext-routemap.html：票種＋票根徽章／類型／票號＋襯線標題）、區段＝.sec、狀態／優先級＝.status 小方標（選中 ink 邊）、
 * 心情＝三個 .badge 小圓、子項進度＝.cars 車廂格、手動進度＝純鍵盤數字、車票検印＝.stamp／.seal 蓋「済」（stampIn 動畫）。
 * UI 丙-3 C5：現況／優先順序／所屬路線換新 `Segmented`（放不下就換下拉，`./Choice`）；乘車日、締切日換共用 `DateChip`
 *   （乘車日一定 allowPast＋flag="backfill"，補記不能壞）；「幾點」換共用 `ClockInput`（`./TimeField` 的 ClockField）；
 *   心情字統一「順暢／還行／吃力」（G1，與完成卡同一份 complete/moods.ts）。
 * 回饋甲（D-主-129、133）：「時刻」段兩種面板同一支 ScheduleSection——票種 → 時段組〔乘車日 → 時段（開始 → 結束兩格）→ 長度（分段鈕）
 *   → 插槽 section "schedule" → 締切日〕；列車／車廂的「預計」搬上來成「長度」。車票加「状態」段＝優先順序＋別線狀態段欄位。
 * 已知取捨：面板內改 done 不彈完成卡（心情／日誌就在同一面板）；車廂不給「轉為支線」（支線只能掛路線／支線下，setKind 必擋）。
 */
import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import { KIND_LABEL, isTaskKind, parseRule, type Mood, type NodeRow } from "../../domain";
import { autoProgress, descendantCount, isSettling, openDescendantCount, serialOf, useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";
import { KIND_GLYPH, badgeClass, fareClass } from "../outline/OutlineRow";
import {
  ActionButton,
  ActionsRow,
  CommitInput,
  CommitTextarea,
  FieldRow,
  NumberField,
  SectionRule,
} from "./fields";
import { FareRow, RepeatSection, TeikiStampRow, usePanelRepeat } from "./RepeatRuleEditor";
import { LengthField, TimeSpanField } from "./TimeField";
import { StationFieldRow, useStationField } from "../board/StationField";
import { Choice } from "./Choice";
import { DateChip } from "../common/DateChip";
import {
  DesktopSeatPicker,
  canActAsSeatSlot,
  releaseSeatedFlow,
} from "../common/seating";
import "../common/seating/flexible-seating.css";
import { MOODS } from "../complete/moods";
import { todayKey } from "../../lib/date";
import { fmtDateTime } from "./format";
import { WorkLogList } from "./WorkLogList";
import { LocationFieldRow, useMoveTo, useNodeLocationInfo } from "./MoveTo";
import { lineNodeFields } from "../../lines/runtime";
import type { NodeFieldSpec } from "../../lines/types";
import { confirmAndDeleteNode } from "../common/deleteNodeFlow";
import { changeStatusFlow, convertKindFlow, openKidsOf } from "../outline/nodeFlows";
import {
  PRIORITY_OPTIONS,
  PROGRESS_OPTIONS,
  mdwText,
  settlementViewOf,
  teikiState,
  type ProgressStatus,
  type SettledSeal,
} from "./panelRules";
import "./taskStatusSeals.css";

/* 現況／優先順序的選項、定期券三態、検印怎麼畫：手機詳情頁同一份（./panelRules）；寫入流程在 outline/nodeFlows（D-主-82） */

/* 心情三燈的字與色：UI 丙-3 G1 起跟完成卡同一份（complete/moods.ts；§4 定案字＝順暢／還行／吃力，
   舊字「順利／普通／卡關」退役；存進資料庫的值 green／yellow／red 不變） */

/* ───────────── 入口：依 kind 分派 ───────────── */

export function NodePanel({ node }: { node: NodeRow }) {
  if (isTaskKind(node.kind)) return <TaskPanel node={node} />;
  if (node.kind === "ticket") return <TicketPanel node={node} />;
  if (node.kind === "branch") return <BranchPanel node={node} />;
  return <FallbackPanel node={node} />;
}

/* ───────────── 共用：標題塊、操作 ───────────── */

/**
 * 票頭＝件一 m3-ext-routemap.html 的 .panel-head（「攤開的一張大票」的票頭）：
 * .fare-class 票種（右上、讓開關閉叉）＋ .panel-kind（票根徽章〔字色＝路線色〕・類型・票號 No.MMDD-NN）
 * ＋ 襯線標題（本專案的標題可編輯，故沿用 .date-line .d；19px 襯線由 stamps.css 釘死）＋ .day-stats 副注。
 * M2 的「列車詳情 — TRAIN」overline 隨 ② 換裝退場（件一沒有這一行）。
 */
function NameBlock({
  node,
  onRename,
  sub,
  stub,
}: {
  node: NodeRow;
  onRename: (name: string) => void;
  sub?: ReactNode;
  /**
   * 覆寫票根三格（徽章字／虛線／類型名／字色）。給了就照給的畫，沒給＝原本的「kind 徽章＋當前開啟路線的色」。
   * M3 ③ WP3 的臨時車票用它：票根跟著**這張票自己的路線標籤**換色，而不是側欄現在開著哪條路線
   * （今日視圖的票多半不屬於當前開啟的那棵樹，用 routeId 的顏色會說謊）。
   */
  stub?: { glyph: string; dashed: boolean; label: string; color: string | null };
}) {
  const done = node.status === "done";
  const routeColor = useNodeStore((s) => s.routes.find((r) => r.id === s.routeId)?.color ?? null);
  // 票號單一真相：今日索引有算過就用它（repository 的 serial），否則查 store 的票號表。
  // 兩張表都出自 buildSerialMap 的當日全域發券序，故同一張票在今日列與側板票頭號碼一致。
  const todaySerial = useNodeStore((s) => s.today.byId[node.id]?.serial);
  const serials = useNodeStore((s) => s.serials);
  const serial = todaySerial ?? serialOf(serials, node.id);
  // 票種：定期券只認 parseRule 的結果（欄位裡塞著 legacy 自由文字的票＝乘車券，M3 ④ WP3）；
  // 其餘（支線／臨時券／乘車券）仍走大綱那支共用的 fareClass，口徑只留一份。
  const tree = useNodeStore((s) => s.tree);
  const routeId = useNodeStore((s) => s.routeId);
  const parentKind =
    node.parent_id && node.parent_id !== routeId
      ? tree.byId[node.parent_id]?.kind
      : node.parent_id === routeId || (node.parent_id === null && node.route_id != null)
        ? "route"
        : undefined;
  const fare = parseRule(node.repeat_rule)
    ? { label: "定期券", teiki: true }
    : fareClass({ ...node, repeat_rule: null }, parentKind);
  const accent = (stub ? stub.color : routeColor) ?? "var(--color-ink-soft)";

  return (
    <header className="panel-head">
      <span className={`fare-class${fare.teiki ? " teiki" : ""}`}>{fare.label}</span>
      <div className="panel-kind" style={{ color: accent }}>
        <span aria-hidden className={stub ? (stub.dashed ? "badge dashed" : "badge") : badgeClass(node.kind)}>
          {stub ? stub.glyph : KIND_GLYPH[node.kind]}
        </span>
        <span className="line-name">{stub ? stub.label : KIND_LABEL[node.kind]}</span>
        {serial && <span className="serial">No.{serial}</span>}
      </div>
      <div className="date-line">
        <CommitInput
          value={node.name}
          onCommit={onRename}
          required
          wrap
          ariaLabel="名稱"
          className={`d ${done ? "done" : ""}`}
        />
      </div>
      {sub && <p className="day-stats">{sub}</p>}
    </header>
  );
}

/** 插槽 `nodeFields` 的段（lines/types NodeFieldSpec.section；不填＝status） */
type FieldSection = NonNullable<NodeFieldSpec["section"]>;

/**
 * 別線登記的節點欄位列（插槽 `nodeFields`，接縫 #56）：依 kind 與段（`section`，接縫 #66；不填＝status）過濾；
 * 三線都沒登記＝空陣列、DOM 零變。amount 段只有列車／車廂面板的「分量」段會問；schedule 段＝時段組（長度之後、締切日之前，
 * 列車／車廂與車票面板都問；D-主-129）。
 */
function lineFieldsFor(node: NodeRow, section: FieldSection = "status") {
  return lineNodeFields("desktop").filter((f) => f.kinds.includes(node.kind) && (f.section ?? "status") === section);
}

/** 也給 RoutePanel 用（路線面板的 `.fields` 尾端渲染點，同一個插槽）；`section` 不給＝status */
export function LineRows({ node, section }: { node: NodeRow; section?: FieldSection }) {
  return (
    <>
      {lineFieldsFor(node, section).map((f) => (
        <FieldRow key={f.id} label={f.label} top={f.top}>
          <f.Desktop node={node} />
        </FieldRow>
      ))}
    </>
  );
}

/**
 * 定期券的乘車日在這裡唯讀（M3 ④ 評審 must）：班次由規則排定，這裡只是**印出來**給人看——值照印、旁邊一句灰注、沒有清除叉；
 * 要改班次就改規則（上面的「重複」區段）；只動這一班到検印區的本班日期（⑥ D-主-295），跳過按 U。
 * 版位沿用 panel.css 的 `.date`（flex 一列）與 `.latin`／`.empty`，不新增 class。
 */
function LockedDate({ value }: { value: string | null }) {
  // 日期字照 panelRules.mdwText「10/26（週一）」（同検印段頭的本班日、手機詳情頁；第三輪——原本印原始的 2026-10-26）
  return (
    <div className="date">
      <span className="latin">{value ? mdwText(value) : "—"}</span>
      <span className="empty" style={{ marginTop: 0 }}>
        依重複設定排班</span>
    </div>
  );
}

/**
 * 乘車日＝共用 DateChip（UI 丙-3 C5；視覺規範 §2.5「日期」觸發統一成日期 chip）。列車／車廂與車票面板共用。
 * **一定 `allowPast`＋`flag="backfill"`**：DateChip 預設挑不到今天以前，少了 allowPast 桌機補記（磨光⑦ D-主-67：
 * 親手把乘車日改到過去＝補記）會靜默壞掉（契約 §7-1）。onPick 照舊帶 `{ backfill: true }`——蓋不蓋済由 repository 判斷
 * （未済、非定期券、沒有未完成子票才蓋），收據 toast「已補記到 M/D」＋復原在 nodeStore。
 */
function ScheduledChip({ node }: { node: NodeRow }) {
  const updateNode = useNodeStore((s) => s.updateNode);
  return (
    <DateChip
      date={node.scheduled_on}
      endDate={node.scheduled_end}
      allowRange
      onPick={(v) => {
        const syncDue = Boolean(node.scheduled_on && node.due_on === (node.scheduled_end ?? node.scheduled_on));
        void updateNode(
          node.id,
          syncDue && v ? { scheduled_on: v, scheduled_end: null, due_on: v } : { scheduled_on: v, scheduled_end: null },
          { backfill: true },
        );
      }}
      onPickRange={(s, e) => {
        const syncDue = Boolean(node.scheduled_on && node.due_on === (node.scheduled_end ?? node.scheduled_on));
        void updateNode(
          node.id,
          syncDue && s
            ? { scheduled_on: s, scheduled_end: e, due_on: e ?? s }
            : { scheduled_on: s, scheduled_end: e },
          { backfill: !e },
        );
      }}
      allowPast
      flag="backfill"
      clearable
      label="乘車日"
    />
  );
}

/**
 * 「時刻」段（回饋甲 D-主-129；原型 q3-A）——列車／車廂與車票面板同一支：
 *   票種 → 〔時段組：乘車日 → 時段 → 長度 → 插槽 section "schedule"（時刻表⑦「其他時段」）→ 締切日〕。
 *   時段組左側一條淡線（.sched-group）把「排時段」這件事的幾格圈成一組；列車／車廂的「預計」從「分量」段搬上來成「長度」。
 * 定期券（lockedDate＝掛著規則，含退役）：乘車日唯讀；時段是「每班」時刻（逐班改在検印段「本班」，不動）。
 * 手機詳情頁同順序（MobileDetailHost TaskFields）。
 */
function ScheduleSection({
  node,
  repeat,
  lockedDate,
}: {
  node: NodeRow;
  repeat: ReturnType<typeof usePanelRepeat>;
  lockedDate: boolean;
}) {
  const updateNode = useNodeStore((s) => s.updateNode);
  const runOverrides = useNodeStore((s) => s.runOverrides);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const [seatAnchor, setSeatAnchor] = useState<HTMLElement | null>(null);
  const syncDueTarget = node.scheduled_end ?? node.scheduled_on;
  const isDueSynced = Boolean(syncDueTarget && node.due_on === syncDueTarget);

  // Mode B：這張單發票是否正入座於某個預留席，或本身是單發預留席
  const seatedOvr = !lockedDate && node.scheduled_on
    ? runOverrides.find((o) => !o.deleted_at && o.seated_node_id === node.id && o.due_on === node.scheduled_on)
    : undefined;
  const hostOvr = !lockedDate && node.is_placeholder && node.scheduled_on
    ? runOverrides.find((o) => !o.deleted_at && o.node_id === node.id && o.due_on === node.scheduled_on && o.seated_node_id)
    : undefined;
  const canHostSeat = !lockedDate && canActAsSeatSlot(node, node.status === "done") && Boolean(node.scheduled_on);

  return (
    <>
      <SectionRule title="時刻" />
      <div className="fields">
        {/* 票種（收官磨光 Q1）：留在乘車日之前（手機詳情頁同位置） */}
        <FareRow node={node} repeat={repeat} />

        <FieldRow label="預留席">
          <button
            type="button"
            className={"ns-qa-chip" + (node.is_placeholder ? " is-on" : "")}
            aria-pressed={Boolean(node.is_placeholder)}
            title={
              node.is_placeholder
                ? "目前為預留席（虛線框）——點擊轉為一般車票，或直接修改上方標題自動轉正"
                : "將這張票標為預留空位，可讓其他待辦車票拖入頂替"
            }
            onClick={() => void updateNode(node.id, { is_placeholder: node.is_placeholder ? null : 1 })}
          >
            <span className="k">{node.is_placeholder ? "預留席（點擊轉正式車票）" : "設為預留席"}</span>
          </button>
        </FieldRow>

        {seatedOvr && (
          <FieldRow label="入座席次">
            <span className="ns-range-row-acts">
              <span className="ns-seat-badge">已入座（{seatedOvr.due_on.slice(5).replace("-", "/")}）</span>
              <button
                type="button"
                className="ns-seat-release"
                onClick={() => void releaseSeatedFlow(seatedOvr.node_id, seatedOvr.due_on, node.id)}
              >
                釋出預留席
              </button>
            </span>
          </FieldRow>
        )}

        {canHostSeat && node.scheduled_on && (
          <FieldRow label="待辦入座">
            {hostOvr?.seated_node_id ? (
              <span className="ns-range-row-acts">
                <span className="ns-seat-badge">已有車票入座</span>
                <button
                  type="button"
                  className="ns-seat-release"
                  onClick={() => void releaseSeatedFlow(node.id, node.scheduled_on!, hostOvr.seated_node_id ?? undefined)}
                >
                  釋出預留席
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="ns-seat-dropbtn"
                aria-expanded={seatAnchor !== null}
                onClick={(e) => setSeatAnchor(seatAnchor ? null : e.currentTarget)}
              >
                ⇄ 配對待辦入座…
              </button>
            )}
          </FieldRow>
        )}

        <div className="sched-group">
          <FieldRow label="乘車日">
            {lockedDate ? <LockedDate value={node.scheduled_on} /> : <ScheduledChip node={node} />}
          </FieldRow>

          <FieldRow label="時段">
            <TimeSpanField
              start={node.scheduled_time}
              estimateMin={node.estimate_min}
              onStart={(v) => void updateNode(node.id, { scheduled_time: v })}
              onLen={(min) => void updateNode(node.id, { estimate_min: min })}
              dayStartHour={dayStartHour}
              refDay={node.scheduled_on ?? todayKey(dayStartHour)}
              prefix={lockedDate ? "每班" : undefined}
            />
          </FieldRow>

          <FieldRow label="長度" top>
            <LengthField value={node.estimate_min} onCommit={(v) => void updateNode(node.id, { estimate_min: v })} />
          </FieldRow>

          {/* 別線的時段組欄位（插槽 nodeFields 的 section "schedule"）：長度之後、締切日之前；沒登記＝不出 DOM */}
          <LineRows node={node} section="schedule" />

          <FieldRow label="締切日">
            <div style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <DateChip
                date={node.due_on}
                onPick={(v) => void updateNode(node.id, { due_on: v })}
                allowPast
                clearable
                label="締切日"
              />
              {syncDueTarget && (
                <button
                  type="button"
                  className={"ns-qa-chip" + (isDueSynced ? " is-on" : "")}
                  aria-pressed={isDueSynced}
                  title="將締切日設為與乘車日（或期間訖日）同一天"
                  onClick={() =>
                    void updateNode(node.id, {
                      due_on: isDueSynced ? null : syncDueTarget,
                    })
                  }
                >
                  <span className="k">＝同乘車日</span>
                </button>
              )}
            </div>
          </FieldRow>
        </div>
      </div>
      {seatAnchor && node.scheduled_on && (
        <DesktopSeatPicker
          slotId={node.id}
          slotName={node.name}
          dueOn={node.scheduled_on}
          anchor={seatAnchor}
          onClose={() => setSeatAnchor(null)}
        />
      )}
    </>
  );
}

/**
 * 「概要」段（description；blur 寫回、清空＝null）：支線起家，D-主-79 補到列車／車廂／車票——手機詳情頁一直都能看能改，
 * 桌機缺的是編輯入口（雙端同等）。版位一律在票頭正下方。
 */
function SummarySection({ node, ariaLabel, placeholder }: { node: NodeRow; ariaLabel: string; placeholder: string }) {
  const updateNode = useNodeStore((s) => s.updateNode);
  return (
    <>
      <SectionRule title="概要" />
      <CommitTextarea
        value={node.description ?? ""}
        onCommit={(v) => void updateNode(node.id, { description: v || null })}
        ariaLabel={ariaLabel}
        placeholder={placeholder}
      />
    </>
  );
}

/** 改名／刪除（F3 語彙）／轉型（setKind；nodeFlows.convertKindFlow，手機詳情頁同一支）——三個面板共用 */
function useNodeActions() {
  const updateNode = useNodeStore((s) => s.updateNode);
  const select = useUiStore((s) => s.select);

  // 確認與 toast 在共用流程（失物招領 §5-6）；側板自己的事：刪了收起、復原選回那張
  const remove = (node: NodeRow) => {
    void confirmAndDeleteNode(node.id, {
      around: async (del) => {
        if (await del()) select(null);
      },
      onRestored: () => select(node.id),
    });
  };

  return { updateNode, remove, convert: convertKindFlow };
}

/**
 * v1.31 D-1.31-4：「推進狀態（未開始｜進行中）」與「結案印記（蓋済｜途中下車）」語義分區——
 * 列車／車廂（`TaskPanel`）與車票（`TicketPanel`）共用同一組，消除原本 4 態擠同一排分段鈕的語義混淆，
 * 同時讓新建葉節點（`ticket`）在側板也能操作推進狀態與途中下車封存印記。
 * 記住進入結案前的推進狀態（預設 `todo`），結案態下可清楚辨識目前印記並一鍵復原。
 */
function StatusAndSealFields({ node }: { node: NodeRow }) {
  const sv = settlementViewOf(node);
  const lastProgressRef = useRef<{ id: string; status: ProgressStatus }>({
    id: node.id,
    status: node.status === "doing" ? "doing" : "todo",
  });
  if (lastProgressRef.current.id !== node.id) {
    lastProgressRef.current = { id: node.id, status: node.status === "doing" ? "doing" : "todo" };
  } else if (sv.progressValue) {
    lastProgressRef.current.status = sv.progressValue;
  }

  const [freshSeal, setFreshSeal] = useState<SettledSeal | null>(null);
  const restoreTarget = lastProgressRef.current.status;
  const restoreLabel = restoreTarget === "doing" ? "退回進行中" : "退回未開始";

  const applyStatus = (next: NodeRow["status"], seal?: SettledSeal) => {
    if (isSettling(node.id)) return;
    if (seal) setFreshSeal(seal);
    else setFreshSeal(null);
    changeStatusFlow(node, next, openKidsOf(node));
  };

  const toggleSeal = (seal: SettledSeal) => {
    if (seal === "done" && !sv.canStampDone) return;
    if (sv.settled === seal) {
      applyStatus(restoreTarget);
    } else {
      applyStatus(seal, seal);
    }
  };

  return (
    <>
      <FieldRow label="推進狀態">
        <Choice
          value={sv.progressValue}
          options={PROGRESS_OPTIONS}
          onChange={(next) => applyStatus(next)}
          ariaLabel="推進狀態"
        />
      </FieldRow>

      <FieldRow label="結案印記" top>
        <div className="ns-seals-wrap">
          <div role="group" aria-label="結案印記" className="ns-seals-row">
            <button
              type="button"
              className={
                "ns-seal-btn is-sumi" +
                (sv.settled === "done" && !sv.noSeal ? " is-on" : "") +
                (freshSeal === "done" && sv.settled === "done" ? " is-fresh" : "")
              }
              aria-pressed={sv.settled === "done" && !sv.noSeal}
              disabled={!sv.canStampDone}
              title={
                sv.doneDisabledWhy ??
                (sv.settled === "done" ? `取消蓋済（${restoreLabel}）` : "蓋済結案（完成）")
              }
              onClick={() => toggleSeal("done")}
              onAnimationEnd={() => setFreshSeal(null)}
            >
              <span className="ns-seal-mark is-sumi" aria-hidden>
                済
              </span>
              <span>蓋済</span>
            </button>

            <button
              type="button"
              className={
                "ns-seal-btn is-geshya" +
                (sv.settled === "paused" ? " is-on" : "") +
                (freshSeal === "paused" && sv.settled === "paused" ? " is-fresh" : "")
              }
              aria-pressed={sv.settled === "paused"}
              title={
                sv.settled === "paused"
                  ? `解除途中下車（${restoreLabel}）`
                  : "蓋途中下車印記（暫時封存，退出誤點與待辦）"
              }
              onClick={() => toggleSeal("paused")}
              onAnimationEnd={() => setFreshSeal(null)}
            >
              <span className="ns-seal-mark is-geshya" aria-hidden>
                下車
              </span>
              <span>途中下車</span>
            </button>
          </div>

          {(sv.sealNote || sv.settled !== null || sv.retiredNote) && (
            <div className="ns-seals-foot">
              {sv.sealNote && (
                <span>
                  {sv.sealNote}
                  {sv.settled === "done" && !sv.noSeal && node.completed_at && (
                    <span className="ns-seals-note-time"> · {fmtDateTime(node.completed_at)}</span>
                  )}
                </span>
              )}
              {sv.settled !== null && (
                <button
                  type="button"
                  className="ns-seals-restore"
                  onClick={() => applyStatus(restoreTarget)}
                >
                  {restoreLabel}
                </button>
              )}
              {sv.retiredNote && <span>{sv.retiredNote}</span>}
            </div>
          )}
        </div>
      </FieldRow>
    </>
  );
}

/* ───────────── 列車／車廂 ───────────── */

function TaskPanel({ node }: { node: NodeRow }) {
  const tree = useNodeStore((s) => s.tree);
  // 只數主人手寫的那幾則；系統事件（発券／入鋏／済）不算「記録」（整合席：WP4 開的接口）
  const logCount = useNodeStore(
    (s) => s.workLogs[node.id]?.filter((l) => l.event === null).length ?? 0,
  );
  const { updateNode, remove, convert } = useNodeActions();
  // 票種列與重複段共用一份草稿（收官磨光 Q1）
  const repeat = usePanelRepeat(node);

  const done = node.status === "done";
  const { teiki, retired } = teikiState(node);
  /** 掛著規則就不給直改乘車日——退役的也一樣（repository 的 reschedule 只看 parseRule，改了照樣被擋） */
  const lockedDate = teiki || retired;
  const auto = autoProgress(tree, node.id);
  const total = descendantCount(tree, node.id);
  const doneCount = total - openDescendantCount(tree, node.id);
  // 子項全是車票 → 原型 .cars 的「車票 2/3」；夾雜車廂 → 「子項」
  const carsWord =
    total && (tree.childrenOf[node.id] ?? []).every((id) => tree.byId[id]?.kind === "ticket") ? "車票" : "子項";

  return (
    <div>
      <NameBlock
        node={node}
        onRename={(name) => void updateNode(node.id, { name, ...(node.is_placeholder ? { is_placeholder: null } : {}) })}
        sub={
          done && node.completed_at ? (
            <>
              完成於 <b>{fmtDateTime(node.completed_at)}</b>
            </>
          ) : undefined
        }
      />

      <SummarySection node={node} ariaLabel={`${KIND_LABEL[node.kind]}概要`} placeholder="補一句要做到什麼程度……" />

      <LocationFieldRow node={node} />

      <SectionRule title="状態" />
      <div className="fields">
        <StatusAndSealFields node={node} />

        <FieldRow label="優先順序">
          <Choice
            value={node.priority}
            options={PRIORITY_OPTIONS}
            onChange={(v) => void updateNode(node.id, { priority: v })}
            ariaLabel="優先順序"
          />
        </FieldRow>

        {/* ⑫：沒有子項、路線上有車站才出 */}
        <StationFieldRow node={node} />

        <LineRows node={node} />

        <FieldRow label="心情">
          <MoodLights value={node.mood} onChange={(m) => void updateNode(node.id, { mood: m })} />
        </FieldRow>
      </div>

      {/* 時刻段＝票種＋時段組（D-主-129；預定時刻定期券也可編＝每班時刻，逐班改在下面検印段的「本班」） */}
      <ScheduleSection node={node} repeat={repeat} lockedDate={lockedDate} />

      {/* 重複＝獨立區段（M3 ④ WP3）；舊的自由文字 CommitInput 退場 */}
      <RepeatSection node={node} repeat={repeat} />

      {teiki && <TeikiStampRow node={node} />}

      {/* 分量段：「預計」已搬上時刻段的時段組成「長度」（D-主-129） */}
      <SectionRule title="分量" />
      <div className="fields">
        {/* 別線的分量段欄位（插槽 nodeFields 的 section "amount"，接縫 #66）有登記 ⇒ 取代「花費」這一列；沒有＝照舊 */}
        {lineFieldsFor(node, "amount").length ? (
          <LineRows node={node} section="amount" />
        ) : (
          <FieldRow label="花費">
            <NumberField
              value={node.time_spent_min}
              onCommit={(v) => void updateNode(node.id, { time_spent_min: v })}
              ariaLabel="花費時間（分）"
              unit="分"
              placeholder="—"
            />
          </FieldRow>
        )}

        <FieldRow label="進度">
          {auto !== null ? (
            /* 自動彙總（依子項完成數）＝原型 .cars 車廂格；子項太多只留數字 */
            <div className="meta" style={{ marginTop: 0 }}>
              {total <= 6 && (
                <span className="cars" role="img" aria-label={`${carsWord} ${doneCount}/${total}`}>
                  {Array.from({ length: total }, (_, i) => (
                    <i key={i} className={i < doneCount ? "full" : undefined} />
                  ))}
                  <em>
                    {carsWord} {doneCount}/{total}
                  </em>
                </span>
              )}
              {total > 6 && (
                <span>
                  {carsWord} {doneCount}/{total}
                </span>
              )}
              <span className="sep">・</span>
              <span>{auto}%</span>
            </div>
          ) : (
            /* 手動進度：純鍵盤數字（blur／Enter 寫回），0–100 */
            <NumberField
              value={node.progress}
              onCommit={(v) => void updateNode(node.id, { progress: v ?? 0 })}
              ariaLabel="進度（%）"
              unit="%"
              min={0}
              max={100}
              step={5}
              placeholder="0"
            />
          )}
        </FieldRow>
      </div>

      <SectionRule title="工作日誌" aside={logCount ? `${logCount} 則` : undefined} />
      <WorkLogList nodeId={node.id} />

      <ActionsRow
        left={
          node.kind === "train" ? (
            <ActionButton ariaLabel="轉為支線" title="把這班列車改成支線" onClick={() => void convert(node, "branch")}>
              轉為支線
            </ActionButton>
          ) : undefined
        }
        right={
          <ActionButton ariaLabel={`刪除${KIND_LABEL[node.kind]}`} tone="danger" onClick={() => remove(node)}>
            刪除
          </ActionButton>
        }
      />
    </div>
  );
}

/** 心情三燈：三個 .badge 小圓，點亮一盞；再按同一盞＝熄掉（null） */
function MoodLights({ value, onChange }: { value: Mood | null; onChange: (m: Mood | null) => void }) {
  return (
    <div role="group" aria-label="心情" className="mood">
      {MOODS.map((m) => {
        const active = value === m.value;
        const style: CSSProperties = { color: m.color };
        return (
          <button
            key={m.value}
            type="button"
            aria-label={`心情：${m.label}`}
            aria-pressed={active}
            title={active ? `${m.label}（再按一次清除）` : m.label}
            onClick={() => onChange(active ? null : m.value)}
            className={`badge ${active ? "on" : ""}`}
            style={style}
          >
            <span>{m.glyph}</span>
          </button>
        );
      })}
    </div>
  );
}

/* ───────────── 車票 ───────────── */

function TicketPanel({ node }: { node: NodeRow }) {
  const routes = useNodeStore((s) => s.routes);
  // 只數主人手寫的那幾則；系統事件（発券／入鋏／済）不算「記録」（整合席：WP4 開的接口）
  const logCount = useNodeStore(
    (s) => s.workLogs[node.id]?.filter((l) => l.event === null).length ?? 0,
  );
  const { updateNode, remove, convert } = useNodeActions();
  const locInfo = useNodeLocationInfo(node);
  // 票種列與重複段共用一份草稿（收官磨光 Q1）
  const repeat = usePanelRepeat(node);
  /**
   * 定期券只認 parseRule（legacy 自由文字票＝乘車券）；検印區換成「本班：済／運休」。
   * 退役的定期券（status='done'，cascade 帶下來的）走**一般車票**那一套：済章蓋著、再點一次＝取消完成
   * ＝解除退役重新排班（沿既有反悔路徑），否則検印讀不到班次、按下去是空更新（M3 ④ 評審 should-5）。
   */
  const { teiki, retired } = teikiState(node);
  /** 掛著規則就不給直改乘車日——退役的也一樣（repository 的 reschedule 只看 parseRule，改了照樣被擋） */
  const lockedDate = teiki || retired;
  const done = node.status === "done";

  const isTemp = node.parent_id === null;
  const tagRoute = node.route_id ? routes.find((r) => r.id === node.route_id) : undefined;
  const canConvertToBranch =
    node.route_id !== null && !tagRoute?.arrived_on && locInfo.parentKind !== "train" && locInfo.parentKind !== "car";

  return (
    <div>
      <NameBlock
        node={node}
        onRename={(name) => void updateNode(node.id, { name, ...(node.is_placeholder ? { is_placeholder: null } : {}) })}
        sub={
          done && node.completed_at ? (
            <>
              完成於 <b>{fmtDateTime(node.completed_at)}</b>
            </>
          ) : undefined
        }
        // 臨時車票的票根跟著自己的路線標籤走（無標籤＝虛線「臨」／「無路線」，與今日列同一套語彙）
        stub={
          isTemp
            ? {
                glyph: tagRoute?.code ?? (tagRoute ? tagRoute.name.slice(0, 1) : "臨"),
                dashed: !tagRoute,
                label: tagRoute?.name ?? "無路線",
                color: tagRoute?.color ?? "var(--route-none)",
              }
            : undefined
        }
      />

      <SummarySection node={node} ariaLabel="車票概要" placeholder="補一句要做到什麼程度……" />

      {/* Bug 5：統一「掛在」路徑欄（取代舊版只給臨時票的平鋪所屬路線） */}
      <LocationFieldRow node={node} info={locInfo} />

      {/* 状態段（v1.31 D-1.31-4 ＋ Bug 4 補齊車票心情欄與旅客筆記插槽） */}
      <SectionRule title="状態" />
      <div className="fields">
        <StatusAndSealFields node={node} />
        <FieldRow label="優先順序">
          <Choice
            value={node.priority}
            options={PRIORITY_OPTIONS}
            onChange={(v) => void updateNode(node.id, { priority: v })}
            ariaLabel="優先順序"
          />
        </FieldRow>
        {/* ⑫：路線上有車站才出；臨時車票沒掛路線時不出 */}
        <StationFieldRow node={node} />
        <LineRows node={node} />
        <FieldRow label="心情">
          <MoodLights value={node.mood} onChange={(m) => void updateNode(node.id, { mood: m })} />
        </FieldRow>
      </div>

      {/* 時刻段＝票種＋時段組（D-主-129；同列車／車廂面板）。票種、締切日＝收官磨光 Q1 雙端同等補上的；定期券＝每班時刻，逐班改在検印段的「本班」 */}
      <ScheduleSection node={node} repeat={repeat} lockedDate={lockedDate} />

      {/* 重複＝獨立區段（M3 ④ WP3；畫面 2：一般票隱藏，切定期券才展開） */}
      <RepeatSection node={node} repeat={repeat} />

      {teiki && <TeikiStampRow node={node} />}

      {/* 工作日誌（D-③-4 甲：`L` 全列可用，車票面板補這一段） */}
      <SectionRule title="工作日誌" aside={logCount ? `${logCount} 則` : undefined} />
      <WorkLogList nodeId={node.id} />

      <ActionsRow
        left={
          <>
            {canConvertToBranch && (
              <ActionButton
                ariaLabel="轉為支線"
                title="把這張車票改成支線（主題）"
                onClick={() => void convert(node, "branch")}
              >
                轉為支線
              </ActionButton>
            )}
            {node.route_id !== null && !tagRoute?.arrived_on && (
              <ActionButton
                ariaLabel="新增子車票"
                title="在此車票底下新增子車票，此車票將自動升格為列車或車廂"
                onClick={() => {
                  void (async () => {
                    useUiStore.getState().setCollapsed(node.id, false);
                    const child = await useNodeStore.getState().createNode({
                      kind: "ticket",
                      name: "新車票",
                      parentId: node.id,
                    });
                    if (child) useUiStore.getState().select(child.id);
                  })();
                }}
              >
                ＋子車票
              </ActionButton>
            )}
          </>
        }
        right={
          <ActionButton ariaLabel="刪除車票" tone="danger" onClick={() => remove(node)}>
            刪除
          </ActionButton>
        }
      />
    </div>
  );
}

/* ───────────── 支線 ───────────── */

function BranchPanel({ node }: { node: NodeRow }) {
  const tree = useNodeStore((s) => s.tree);
  const { updateNode, remove, convert } = useNodeActions();
  const locInfo = useNodeLocationInfo(node);
  const n = descendantCount(tree, node.id);

  return (
    <div>
      <NameBlock
        node={node}
        onRename={(name) => void updateNode(node.id, { name, ...(node.is_placeholder ? { is_placeholder: null } : {}) })}
        sub={
          n > 0 ? (
            <>
              含 <b>{n}</b> 個節點
            </>
          ) : undefined
        }
      />

      <SummarySection node={node} ariaLabel="支線概要" placeholder="這條支線負責什麼……" />

      <LocationFieldRow node={node} info={locInfo} />

      {/* 第三梯 Bug 3：支線亦可掛載車站（底下子樹自動繼承）＋別線欄位列 */}
      <BranchExtraFields node={node} />

      <ActionsRow
        left={
          <>
            <ActionButton ariaLabel="轉為列車" title="把這條支線改成一班列車（任務）" onClick={() => void convert(node, "train")}>
              轉為列車
            </ActionButton>
            {!locInfo.hasKids && (
              <ActionButton ariaLabel="轉為車票" title="把這條空支線改成一張車票" onClick={() => void convert(node, "ticket")}>
                轉為車票
              </ActionButton>
            )}
          </>
        }
        right={
          <ActionButton ariaLabel="刪除支線" tone="danger" onClick={() => remove(node)}>
            刪除
          </ActionButton>
        }
      />
    </div>
  );
}

function BranchExtraFields({ node }: { node: NodeRow }) {
  const hasStation = useStationField(node) !== null;
  const hasLineFields = lineFieldsFor(node).length > 0;
  if (!hasStation && !hasLineFields) return null;
  return (
    <div className="fields">
      <StationFieldRow node={node} />
      {hasLineFields && <LineRows node={node} />}
    </div>
  );
}

/* ───────────── 其他 kind（理論上不會進樹；保底只給改名＋刪除） ───────────── */

function FallbackPanel({ node }: { node: NodeRow }) {
  const { updateNode, remove } = useNodeActions();
  // 站（從別處選到時才會落到這裡）也能換路線；幹線／路線不給（moveTargetRule 回 null ⇒ 不出鈕）
  const move = useMoveTo(node);
  return (
    <div>
      <NameBlock node={node} onRename={(name) => void updateNode(node.id, { name })} />
      <ActionsRow
        left={move.button}
        right={
          <ActionButton ariaLabel={`刪除${KIND_LABEL[node.kind]}`} tone="danger" onClick={() => remove(node)}>
            刪除
          </ActionButton>
        }
      />
      {move.picker}
    </div>
  );
}
