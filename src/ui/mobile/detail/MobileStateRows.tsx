/**
 * 手機詳情頁補齊桌機側板的那幾列（手機殼班反方評審 #3：D-主-69「全同等」的清單漏了現況、優先順序、検印、分量、完成於、轉種類）。
 * 跟桌機 `panel/TaskFields.tsx`／`RepeatRuleEditor.TeikiStampRow` 同一份（D-主-82）：判準在 panel/panelRules（純函式、有單測），
 *   寫入走 outline/nodeFlows 的面板流程（changeStatusFlow／panelStampFlow／panelSuspendFlow）與 nodeStore 同名動作。
 *   手機多一道連點守門（nodeStore.isSettling：上一下還在寫就不理，免得照舊畫面再蓋一次）——桌機側板沒有，所以守在這裡、不進共用流程；
 *   撤済時收完成卡也只有手機（流程的 retractCard 旗子，見下方 RETRACT）。
 * 版面沿詳情頁的列（.m-dt-row：標籤 64px｜值），検印章沿手機路線圖列上那顆（.m2-stamp／.m2-slot／SealDone／運休角印），不另起一套。
 *
 *   StatusRows  列車／車廂：現況（定期券不給「已完成」＋指路句）・優先順序
 *   StampRows   車票＝検印（済⇄未済）；定期券（任何種類）＝本班検印＋運休＋本班時刻（開 run 模式的時刻 sheet）；退役的印指路句
 *   AmountRows  列車／車廂：花費（別線登記了分量段欄位就讓位，同桌機）・進度（有子項＝自動彙總、沒有＝手動 %）
 *   DoneAt      列車／車廂已完成＝名稱下「完成於 MM/DD HH:mm」（桌機票頭同一個值；車票的在検印章旁）
 */
import { useState, type ReactNode } from "react";
import { isTaskKind, type NodeRow } from "../../../domain";
import { effectiveTime, isTimeOverridden } from "../../../domain/scheduledTime";
import { lineNodeFields } from "../../../lines/runtime";
import { autoProgress, descendantCount, isSettling, openDescendantCount, useNodeStore } from "../../../store/nodeStore";
import { NumberField } from "../../common/fields";
import { Segmented } from "../../common/Segmented";
import { changeStatusFlow, openKidsOf, panelStampFlow, panelSuspendFlow } from "../../outline/nodeFlows";
import { fmtDateKey, fmtDateTime } from "../../panel/format";
import { SealDone } from "../../stamps";
import { lenText } from "../MobileTimeSheet";
import { PRIORITY_OPTIONS, stampViewOf, statusChoices } from "../../panel/panelRules";
import "../routemap/routemap.css";

/**
 * 撤済（現況從已完成改走、定期券取消本班済）時把那張的完成卡一起收起——今日、行程表、路線圖撤済都收（D-主-73「章撤了卡就不成立」），
 * 詳情頁同一把尺（第三輪；不收的話回到列表卡還在，按「存入」會把心情／乘務記錄寫到已經不是完成的票上）。桌機側板不帶＝照舊。
 */
const RETRACT = { retractCard: true } as const;

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="m-dt-row">
      <span className="m-dt-label">{label}</span>
      <div className="m-dt-val">{children}</div>
    </div>
  );
}

/* ───────────── 現況・優先順序 ───────────── */

export function StatusRows({ node }: { node: NodeRow }) {
  const updateNode = useNodeStore((s) => s.updateNode);
  const { options, note } = statusChoices(node);
  return (
    <>
      <Row label="現況">
        <div className="m-dt-stack">
          <Segmented
            compact
            options={options}
            value={node.status}
            onChange={(v) => {
              if (!isSettling(node.id)) changeStatusFlow(node, v, openKidsOf(node), RETRACT);
            }}
            aria-label="現況"
          />
          {note && <span className="m-dt-sub">{note}</span>}
        </div>
      </Row>
      <Row label="優先順序">
        <Segmented
          compact
          options={PRIORITY_OPTIONS}
          value={node.priority}
          onChange={(v) => void updateNode(node.id, { priority: v })}
          aria-label="優先順序"
        />
      </Row>
    </>
  );
}

/* ───────────── 検印 ───────────── */

export function StampRows({ node, onRunTime }: { node: NodeRow; onRunTime: () => void }) {
  const occ = useNodeStore((s) => s.currentOccurrences[node.id]);
  const v = stampViewOf(node, occ);
  // 只有「剛蓋」才播蓋章動畫（同桌機 .fresh）；取消時不播
  const [fresh, setFresh] = useState(false);

  if (v.mode === "none") {
    return v.retiredNote ? (
      <Row label="検印">
        <span className="m-dt-sub">{v.retiredNote}</span>
      </Row>
    ) : null;
  }

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
        <span className="m-dt-stamp-meta">
          {v.meta}
          {v.mode === "plain" && v.done && node.completed_at && (
            <span className="m-dt-sub m-dt-latin"> {fmtDateTime(node.completed_at)}</span>
          )}
        </span>
        {v.mode === "teiki" && (
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
        )}
      </Row>
      {v.retiredNote && <p className="m-dt-hint">{v.retiredNote}</p>}
      {/* 本班時刻（同桌機 RunTimeRow）：班次日拿不到就不畫 */}
      {v.mode === "teiki" && v.railDate && <RunTimeRow node={node} railDate={v.railDate} onOpen={onRunTime} />}
    </>
  );
}

function RunTimeRow({ node, railDate, onOpen }: { node: NodeRow; railDate: string; onOpen: () => void }) {
  const time = effectiveTime(node, railDate);
  const overridden = isTimeOverridden(node, railDate);
  return (
    <Row label="本班時刻">
      <button type="button" className="m-dt-pick" onClick={onOpen}>
        {time ? <b className="m-dt-hm">{time}</b> : <span className="is-empty">不排時刻</span>}
        {/* 本班日印在這裡（桌機印在検印段頭「本班 MM/DD」）：検印那一列放了章＋一句＋運休鈕，再塞日期會折行 */}
        <span className="m-dt-sub">
          {fmtDateKey(railDate)}・{overridden ? "只改這一班" : "同每班"}
        </span>
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
  // 同桌機：列車／車廂印在票頭（TaskPanel NameBlock sub）；車票印在検印章旁（StampRows），這裡不重複
  if (!isTaskKind(node.kind) || node.status !== "done" || !node.completed_at) return null;
  return (
    <p className="m-dt-doneat">
      完成於 <b className="m-dt-latin">{fmtDateTime(node.completed_at)}</b>
    </p>
  );
}
