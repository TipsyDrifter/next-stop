/**
 * 手機詳情頁補齊桌機側板的那幾列（手機殼班反方評審 #3：D-主-69「全同等」的清單漏了現況、優先順序、検印、分量、完成於、轉種類）。
 * 跟桌機 `panel/TaskFields.tsx`／`RepeatRuleEditor.TeikiStampRow` 同一份（D-主-82）：判準在 panel/panelRules（純函式、有單測），
 *   寫入走 outline/nodeFlows 的面板流程（changeStatusFlow／panelStampFlow／panelSuspendFlow）與 nodeStore 同名動作。
 *   手機多一道連點守門（nodeStore.isSettling：上一下還在寫就不理，免得照舊畫面再蓋一次）——桌機側板沒有，所以守在這裡、不進共用流程；
 *   撤済時收完成卡也只有手機（流程的 retractCard 旗子，見下方 RETRACT）。
 * 版面沿詳情頁的列（.m-dt-row：標籤 64px｜值），検印章沿手機路線圖列上那顆（.m2-stamp／.m2-slot／SealDone／運休角印），不另起一套。
 *
 *   StatusRows  列車／車廂：現況（定期券不給「已完成」＋指路句）・優先順序
 *   PriorityRow 優先順序一列（StatusRows 裡那列；車票沒有現況，詳情頁把它單獨放在検印之前——D-主-133）
 *   StampRows   車票＝検印（済⇄未済）；定期券（任何種類）＝本班検印＋運休＋本班日期（開日期 sheet，⑥ D-主-295）＋本班時刻（開 run 模式的時刻 sheet）；退役的印指路句
 *   AmountRows  列車／車廂：花費（別線登記了分量段欄位就讓位，同桌機）・進度（有子項＝自動彙總、沒有＝手動 %）
 *   DoneAt      列車／車廂已完成＝名稱下「完成於 MM/DD HH:mm」（桌機票頭同一個值；車票的在検印章旁）
 */
import { useRef, useState, type ReactNode } from "react";
import { isTaskKind, parseRule, runOrigin, type NodeRow } from "../../../domain";
import { effectiveTime, isTimeOverridden } from "../../../domain/scheduledTime";
import { lineNodeFields } from "../../../lines/runtime";
import { autoProgress, descendantCount, isSettling, openDescendantCount, useNodeStore } from "../../../store/nodeStore";
import { shortDayKey } from "../../common/DatePicker";
import { CommitInput, NumberField } from "../../common/fields";
import { Segmented } from "../../common/Segmented";
import { releaseSeatedFlow } from "../../common/seating";
import "../../common/seating/flexible-seating.css";
import { changeStatusFlow, moveRunFlow, openKidsOf, panelStampFlow, panelSuspendFlow } from "../../outline/nodeFlows";
import { fmtDateTime } from "../../panel/format";
import { SealDone } from "../../stamps";
import { lenText } from "../MobileTimeSheet";
import {
  PRIORITY_OPTIONS,
  PROGRESS_OPTIONS,
  mdwText,
  settlementViewOf,
  stampViewOf,
  type ProgressStatus,
  type SettledSeal,
} from "../../panel/panelRules";
import "../routemap/routemap.css";

/**
 * 撤済（現況從已完成改走、定期券取消本班済）時把那張的完成卡一起收起——今日、行程表、路線圖撤済都收（D-主-73「章撤了卡就不成立」），
 * 詳情頁同一把尺（第三輪；不收的話回到列表卡還在，按「存入」會把心情／乘務記錄寫到已經不是完成的票上）。桌機側板不帶＝照舊。
 */
const RETRACT = { retractCard: true } as const;

/** 詳情頁的一列；`tall`＝值會折成兩行（長度：分段鈕＋下一行「自訂…」）⇒ 標籤靠上（原型 q3-A 手機 .nsq-tall） */
export function Row({ label, children, tall }: { label: string; children: ReactNode; tall?: boolean }) {
  return (
    <div className={"m-dt-row" + (tall ? " is-tall" : "")}>
      <span className="m-dt-label">{label}</span>
      <div className="m-dt-val">{children}</div>
    </div>
  );
}

/* ───────────── 現況・優先順序 ───────────── */

/** 優先順序一列（列車／車廂在 StatusRows 裡；車票獨立一列放在検印之前，D-主-133；桌機同一份 PRIORITY_OPTIONS） */
export function PriorityRow({ node }: { node: NodeRow }) {
  const updateNode = useNodeStore((s) => s.updateNode);
  return (
    <Row label="優先順序">
      <Segmented
        compact
        options={PRIORITY_OPTIONS}
        value={node.priority}
        onChange={(v) => void updateNode(node.id, { priority: v })}
        aria-label="優先順序"
      />
    </Row>
  );
}

export function StatusRows({ node }: { node: NodeRow }) {
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
    changeStatusFlow(node, next, openKidsOf(node), RETRACT);
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
      <Row label="推進狀態">
        <Segmented
          compact
          options={PROGRESS_OPTIONS}
          value={sv.progressValue}
          onChange={(v) => applyStatus(v)}
          aria-label="推進狀態"
        />
      </Row>

      <PriorityRow node={node} />

      <Row label="結案印記" tall>
        <div className="m-dt-seals-wrap">
          <div role="group" aria-label="結案印記" className="m-dt-seals-row">
            <button
              type="button"
              className={
                "m-dt-seal-btn is-sumi" +
                (sv.settled === "done" && !sv.noSeal ? " is-on" : "") +
                (freshSeal === "done" && sv.settled === "done" ? " is-fresh" : "")
              }
              aria-pressed={sv.settled === "done" && !sv.noSeal}
              disabled={!sv.canStampDone}
              title={sv.doneDisabledWhy ?? undefined}
              onClick={() => toggleSeal("done")}
              onAnimationEnd={() => setFreshSeal(null)}
            >
              <span className="m-dt-seal-mark is-sumi" aria-hidden>
                済
              </span>
              <span>蓋済</span>
            </button>

            <button
              type="button"
              className={
                "m-dt-seal-btn is-geshya" +
                (sv.settled === "paused" ? " is-on" : "") +
                (freshSeal === "paused" && sv.settled === "paused" ? " is-fresh" : "")
              }
              aria-pressed={sv.settled === "paused"}
              onClick={() => toggleSeal("paused")}
              onAnimationEnd={() => setFreshSeal(null)}
            >
              <span className="m-dt-seal-mark is-geshya" aria-hidden>
                下車
              </span>
              <span>途中下車</span>
            </button>
          </div>

          {(sv.sealNote || sv.settled !== null || sv.retiredNote) && (
            <div className="m-dt-seals-foot">
              {sv.sealNote && (
                <span className="m-dt-sub">
                  {sv.sealNote}
                  {sv.settled === "done" && !sv.noSeal && node.completed_at && (
                    <span className="m-dt-latin"> · {fmtDateTime(node.completed_at)}</span>
                  )}
                </span>
              )}
              {sv.settled !== null && (
                <button
                  type="button"
                  className="m-dt-seal-restore"
                  onClick={() => applyStatus(restoreTarget)}
                >
                  {restoreLabel}
                </button>
              )}
              {sv.retiredNote && <span className="m-dt-sub">{sv.retiredNote}</span>}
            </div>
          )}
        </div>
      </Row>
    </>
  );
}

/* ───────────── 検印（定期券本班專用） ───────────── */

export function StampRows({
  node,
  onRunTime,
  onRunDate,
  onRunSeat,
}: {
  node: NodeRow;
  onRunTime: () => void;
  onRunDate: (railDate: string) => void;
  onRunSeat?: (railDate: string, slotName: string) => void;
}) {
  const occ = useNodeStore((s) => s.currentOccurrences[node.id]);
  const v = stampViewOf(node, occ);
  // 只有「剛蓋」才播蓋章動畫（同桌機 .fresh）；取消時不播
  const [fresh, setFresh] = useState(false);

  // v1.31 D-1.31-4：單發車票與退役定期券的蓋済／途中下車統一由 StatusRows「結案印記」負責；這裡只畫活著的定期券本班検印與運休
  if (v.mode !== "teiki") return null;

  const stamp = () => {
    if (isSettling(node.id)) return;
    const r = panelStampFlow(node, occ, RETRACT);
    if (r !== null) setFresh(r);
  };

  return (
    <>
      <Row label="検印">
        <button type="button" className="m2-stamp" aria-label={v.action} aria-pressed={v.done} onClick={stamp}>
          {v.suspended ? (
            <span className="m2-seal is-suspended" aria-hidden>
              運休
            </span>
          ) : v.done ? (
            <SealDone small fresh={fresh} className="m2-seal-done" />
          ) : (
            <span className="m2-slot" aria-hidden>
              検印
            </span>
          )}
        </button>
        <span className="m-dt-stamp-meta">{v.meta}</span>
        <button
          type="button"
          className={"m-dt-susp" + (v.suspended ? " is-on" : "")}
          aria-pressed={v.suspended}
          title={v.suspended ? "這一班改回照常開" : "這一班不開（不影響下一班）"}
          onClick={() => {
            if (!isSettling(node.id)) panelSuspendFlow(node.id, !v.suspended);
          }}
        >
          {v.suspended ? "取消運休" : "運休"}
        </button>
      </Row>
      {/* 本班日期＋本班時刻＋本班填空與入座（第四梯 4C）：班次日拿不到就不畫 */}
      {v.railDate && <RunDateRow node={node} railDate={v.railDate} locked={v.done || v.suspended} onOpen={onRunDate} />}
      {v.railDate && <RunTimeRow node={node} railDate={v.railDate} onOpen={onRunTime} />}
      {v.railDate && (
        <RunContentAndSeatMobileRows
          node={node}
          railDate={v.railDate}
          locked={v.done || v.suspended}
          onRunSeat={onRunSeat}
        />
      )}
    </>
  );
}

function RunContentAndSeatMobileRows({
  node,
  railDate,
  locked,
  onRunSeat,
}: {
  node: NodeRow;
  railDate: string;
  locked: boolean;
  onRunSeat?: (railDate: string, slotName: string) => void;
}) {
  const runOverrides = useNodeStore((s) => s.runOverrides);
  const setRunCustomTitle = useNodeStore((s) => s.setRunCustomTitle);
  const ovr = runOverrides.find((o) => !o.deleted_at && o.node_id === node.id && o.due_on === railDate);
  const customTitle = ovr?.custom_title ?? "";
  const seatedId = ovr?.seated_node_id ?? null;

  return (
    <>
      <Row label="本班內容">
        <div style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, minWidth: 0 }}>
          <CommitInput
            key={`${node.id}-${railDate}-${customTitle}`}
            value={customTitle}
            onCommit={(val) => void setRunCustomTitle(node.id, railDate, val.trim() || null)}
            ariaLabel="本班填空內容"
            placeholder={`只填 ${shortDayKey(railDate)} 本班內容…`}
          />
          {customTitle && !locked && (
            <button
              type="button"
              className="ns-seat-release"
              onClick={() => void setRunCustomTitle(node.id, railDate, null)}
            >
              還原
            </button>
          )}
        </div>
      </Row>
      <Row label="本班入座">
        {seatedId ? (
          <div className="ns-range-row-acts">
            <span className="ns-seat-badge">已有待辦車票入座</span>
            {!locked && (
              <button
                type="button"
                className="ns-seat-release"
                onClick={() => void releaseSeatedFlow(node.id, railDate, seatedId)}
              >
                釋出預留席
              </button>
            )}
          </div>
        ) : locked ? (
          <span className="m-dt-sub">本班已結案</span>
        ) : (
          <button
            type="button"
            className="ns-seat-dropbtn"
            onClick={() => onRunSeat?.(railDate, customTitle || node.name)}
          >
            ⇄ 配對待辦入座…
          </button>
        )}
      </Row>
    </>
  );
}

/**
 * 本班日期（⑥ D-主-295；桌機 RepeatRuleEditor.RunDateRow 同一套）：整列開日期 sheet＝只改這一班；改過的標「原定 M/D」並給「改回原日」。
 * 已済、運休的班不給改（locked；repository 也會擋）：要改先取消。
 */
function RunDateRow({
  node,
  railDate,
  locked,
  onOpen,
}: {
  node: NodeRow;
  railDate: string;
  locked: boolean;
  onOpen: (railDate: string) => void;
}) {
  const rule = parseRule(node.repeat_rule);
  const origin = rule ? runOrigin(rule, railDate) : null;
  const originNote = origin && <span className="m-dt-sub">原定 {shortDayKey(origin)}</span>;
  return (
    <Row label="本班日期">
      {locked ? (
        <span className="m-dt-locked">
          {mdwText(railDate)} {originNote}
        </span>
      ) : (
        <>
          <button type="button" className="m-dt-pick" aria-label={`本班日期：${mdwText(railDate)}`} onClick={() => onOpen(railDate)}>
            {/* 兩行：改過日期時這一列還有「改回原日」，排一行在手機寬度會折斷日期 */}
            <span className="m-dt-2l">
              <span>{mdwText(railDate)}</span>
              {originNote}
            </span>
            <span className="m-dt-chev" aria-hidden="true">
              ›
            </span>
          </button>
          {origin && (
            <button
              type="button"
              className="m-dt-susp"
              onClick={() => {
                if (!isSettling(node.id)) void moveRunFlow(node.id, railDate, origin);
              }}
            >
              改回原日
            </button>
          )}
        </>
      )}
    </Row>
  );
}

function RunTimeRow({ node, railDate, onOpen }: { node: NodeRow; railDate: string; onOpen: () => void }) {
  const time = effectiveTime(node, railDate);
  const overridden = isTimeOverridden(node, railDate);
  return (
    <Row label="本班時刻">
      <button type="button" className="m-dt-pick" onClick={onOpen}>
        {time ? <b className="m-dt-hm">{time}</b> : <span className="is-empty">不排時刻</span>}
        <span className="m-dt-sub">{overridden ? "只改這一班" : "同每班"}</span>
        <span className="m-dt-chev" aria-hidden="true">
          ›
        </span>
      </button>
    </Row>
  );
}

/* ───────────── 分量 ───────────── */

export function AmountRows({ node }: { node: NodeRow }) {
  const tree = useNodeStore((s) => s.tree);
  const today = useNodeStore((s) => s.today.byId[node.id]);
  const updateNode = useNodeStore((s) => s.updateNode);
  if (!isTaskKind(node.kind)) return null;
  // 別線登記了「分量」段欄位（時刻表的「時間」）＝它取代花費列，同桌機；那一列由 LineFieldRows 畫
  const lineAmount = lineNodeFields("mobile").some(
    (f) => f.Mobile && f.kinds.includes(node.kind) && (f.section ?? "status") === "amount",
  );
  // 進度：路線樹有這張＝桌機同一支 autoProgress（子孫完成比）；只在今日切片＝直屬子項的完成比；都沒有子項＝手動
  const inTree = tree.byId[node.id] !== undefined;
  const total = inTree ? descendantCount(tree, node.id) : (today?.child_total ?? 0);
  const doneCount = inTree ? total - openDescendantCount(tree, node.id) : (today?.child_done ?? 0);
  const auto = inTree ? autoProgress(tree, node.id) : total > 0 ? Math.round((doneCount / total) * 100) : null;
  // 子項全是車票＝「車票 2/3」，夾雜車廂＝「子項」（同桌機 carsWord）；只在今日切片時不知道種類，一律「子項」
  const carsWord = inTree && (tree.childrenOf[node.id] ?? []).every((id) => tree.byId[id]?.kind === "ticket") ? "車票" : "子項";
  return (
    <>
      {!lineAmount && (
        <Row label="花費">
          <NumberField
            value={node.time_spent_min}
            onCommit={(v) => void updateNode(node.id, { time_spent_min: v })}
            ariaLabel="花費時間（分）"
            unit="分"
            placeholder="—"
          />
          {node.time_spent_min !== null && node.time_spent_min >= 60 && (
            <span className="m-dt-sub">{lenText(node.time_spent_min)}</span>
          )}
        </Row>
      )}
      <Row label="進度">
        {auto !== null ? (
          <span className="m-dt-locked">
            {carsWord} {doneCount}/{total}
            <span className="m-dt-sub">・{auto}%</span>
          </span>
        ) : (
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
      </Row>
    </>
  );
}

/* ───────────── 完成於 ───────────── */

export function DoneAt({ node }: { node: NodeRow }) {
  // 同桌機票頭 NameBlock sub：列車／車廂／車票結案時都在標題下方印「完成於 …」
  if ((!isTaskKind(node.kind) && node.kind !== "ticket") || node.status !== "done" || !node.completed_at) return null;
  return (
    <p className="m-dt-doneat">
      完成於 <b className="m-dt-latin">{fmtDateTime(node.completed_at)}</b>
    </p>
  );
}
