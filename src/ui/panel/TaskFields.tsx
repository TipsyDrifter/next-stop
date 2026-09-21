/**
 * 節點面板（UI Flow 2.1 · D1）：列車／車廂＝完整任務欄位＋工作日誌＋操作列；車票＝名稱・（臨時車票才有的）路線標籤・執行日・検印蓋章・工作日誌；支線＝名稱・描述・轉為列車。
 * M3 ③ WP3 補到車票面板的兩段：**路線標籤選擇器**（a18–a21；只對 parent_id 為 null 的臨時車票顯示，
 * 走 nodeStore.setRouteTag，票根立刻換成該路線的色）與**工作日誌**（D-③-4 甲，直接掛既有 WorkLogList）。
 * 欄位 blur／Enter 才寫回（updateNode）；狀態改 done 走 setCompleted（父鏈重算；有未完成子項先問一次「連同 N 個子項？」），
 * 刪除＝子孫 ≥5 二次確認 → soft delete → 復原 toast（與大綱 F3 同語彙）。
 * 視覺＝原型語彙 1:1（class 定義在 techo.css 原型逐字移植段、側板版面在 panel.css）：
 * 票頭＝.panel-head（件一 m3-ext-routemap.html：票種＋票根徽章／類型／票號＋襯線標題）、區段＝.sec、狀態／優先級＝.status 小方標（選中 ink 邊）、
 * 心情＝三個 .badge 小圓、子項進度＝.cars 車廂格、手動進度＝純鍵盤數字、車票検印＝.stamp／.seal 蓋「済」（stampIn 動畫）。
 * 已知取捨：面板內改 done 不彈完成卡（心情／日誌就在同一面板）；車廂不給「轉為支線」（支線只能掛路線／支線下，setKind 必擋）。
 */
import { useState, type CSSProperties, type ReactNode } from "react";
import {
  KIND_LABEL,
  isTaskKind,
  parseRule,
  type Mood,
  type NodeKind,
  type NodeRow,
  type NodeStatus,
  type Priority,
} from "../../domain";
import { autoProgress, descendantCount, openDescendantCount, serialOf, useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";
import { KIND_GLYPH, badgeClass, fareClass } from "../outline/OutlineRow";
import {
  ActionButton,
  ActionsRow,
  CommitInput,
  CommitTextarea,
  DateField,
  FieldRow,
  NumberField,
  SectionRule,
  Segmented,
} from "./fields";
import { RepeatSection, TeikiStampRow } from "./RepeatRuleEditor";
import { fmtDateTime } from "./format";
import { WorkLogList } from "./WorkLogList";

const STATUS_OPTIONS: { value: NodeStatus; label: string }[] = [
  { value: "todo", label: "未開始" },
  { value: "doing", label: "進行中" },
  { value: "done", label: "已完成" },
  { value: "paused", label: "擱置" },
];

const PRIORITY_OPTIONS: { value: Priority; label: string }[] = [
  { value: "low", label: "低" },
  { value: "mid", label: "中" },
  { value: "high", label: "高" },
];

/** 路線標籤選擇器的「無路線」哨兵值（Segmented 的 value 必須是 string，不能用 null 當選項） */
const NO_ROUTE = "__none__";

/** 心情三燈＝三個 .badge 小圓：綠 route-preset-3（松葉）／黃 gold（燙金）／紅 seal（朱）——都跟著主題換色 */
const MOODS: { value: Mood; label: string; glyph: string; color: string }[] = [
  { value: "green", label: "順利", glyph: "順", color: "var(--route-preset-3)" },
  { value: "yellow", label: "普通", glyph: "普", color: "var(--color-gold)" },
  { value: "red", label: "卡關", glyph: "卡", color: "var(--color-seal)" },
];

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
  const fare = parseRule(node.repeat_rule)
    ? { label: "定期券", teiki: true }
    : fareClass({ ...node, repeat_rule: null });
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

/**
 * 定期券的執行日＝唯讀（M3 ④ 評審 must）：班次由規則排定，這裡只是**印出來**給人看。
 * 沿大綱 `.date.locked` 的語彙（OutlineRow :289-302）——值照印、旁邊一句灰注、沒有清除叉；
 * 要改班次就改規則（上面的「重複」區段）或按 U 跳過本班。
 * 版位沿用 panel.css 的 `.date`（flex 一列）與 `.latin`／`.empty`，不新增 class。
 */
function LockedDate({ value }: { value: string | null }) {
  return (
    <div className="date">
      <span className="latin">{value ?? "—"}</span>
      <span className="empty" style={{ marginTop: 0 }}>
        由規則排定
      </span>
    </div>
  );
}

/** 改名／刪除（F3 語彙）／轉型（setKind）——三個面板共用 */
function useNodeActions() {
  const tree = useNodeStore((s) => s.tree);
  const updateNode = useNodeStore((s) => s.updateNode);
  const deleteNode = useNodeStore((s) => s.deleteNode);
  const undoDelete = useNodeStore((s) => s.undoDelete);
  const setKind = useNodeStore((s) => s.setKind);
  const askConfirm = useUiStore((s) => s.askConfirm);
  const showToast = useUiStore((s) => s.showToast);
  const select = useUiStore((s) => s.select);

  const remove = (node: NodeRow) => {
    const n = descendantCount(tree, node.id);
    const run = async () => {
      const ids = await deleteNode(node.id);
      if (!ids.length) return;
      select(null);
      showToast({
        message: n ? `已刪除「${node.name}」與 ${n} 個子項` : `已刪除「${node.name}」`,
        actionLabel: "復原",
        onAction: () => {
          select(node.id);
          void undoDelete();
        },
      });
    };
    if (n >= 5) {
      askConfirm({
        title: `將連同 ${n} 個子項一起刪除？`,
        body: `「${node.name}」底下的 ${n} 個節點會一起移除；刪除後 10 秒內可從提示列復原。`,
        confirmLabel: "一起刪除",
        danger: true,
        onConfirm: () => void run(),
      });
    } else {
      void run();
    }
  };

  const convert = async (node: NodeRow, kind: NodeKind) => {
    const r = await setKind(node.id, kind);
    if (!r.ok) showToast({ message: r.reason ?? `無法轉為${KIND_LABEL[kind]}` }, 4000);
  };

  return { updateNode, remove, convert };
}

/* ───────────── 列車／車廂 ───────────── */

function TaskPanel({ node }: { node: NodeRow }) {
  const tree = useNodeStore((s) => s.tree);
  const setCompleted = useNodeStore((s) => s.setCompleted);
  const askConfirm = useUiStore((s) => s.askConfirm);
  // 只數主人手寫的那幾則；系統事件（発券／入鋏／済）不算「記録」（整合席：WP4 開的接口）
  const logCount = useNodeStore(
    (s) => s.workLogs[node.id]?.filter((l) => l.event === null).length ?? 0,
  );
  const { updateNode, remove, convert } = useNodeActions();

  const done = node.status === "done";
  /**
   * 定期券的唯一判定（M3 ④）：済蓋在班次上，「現況」就不給「已完成」那一格。
   * **退役的定期券（status='done'）不算**——它已經不發車了，再藏起「已完成」那一格會讓 Segmented 一格都不亮、
   * 検印區也讀不到班次（listCurrentOccurrences 跳過 done 節點），整個側板變死區（M3 ④ 評審 should-5）。
   */
  const retired = parseRule(node.repeat_rule) !== null && done;
  const teiki = parseRule(node.repeat_rule) !== null && !done;
  /** 掛著規則就不給直改執行日——退役的也一樣（repository 的 reschedule 只看 parseRule，改了照樣被擋） */
  const lockedDate = teiki || retired;
  const auto = autoProgress(tree, node.id);
  const total = descendantCount(tree, node.id);
  const doneCount = total - openDescendantCount(tree, node.id);
  // 子項全是車票 → 原型 .cars 的「車票 2/3」；夾雜車廂 → 「子項」
  const carsWord =
    total && (tree.childrenOf[node.id] ?? []).every((id) => tree.byId[id]?.kind === "ticket") ? "車票" : "子項";

  const changeStatus = (next: NodeStatus) => {
    if (next === node.status) return;
    if (next === "done") {
      const open = openDescendantCount(tree, node.id);
      if (open > 0) {
        askConfirm({
          title: `連同 ${open} 個未完成子項一起完成？`,
          body: "連帶完成的子項不會觸發重複生成。",
          confirmLabel: "一起完成",
          onConfirm: () => void setCompleted(node.id, true, true),
        });
      } else {
        void setCompleted(node.id, true);
      }
      return;
    }
    if (done) {
      void (async () => {
        await setCompleted(node.id, false);
        if (next !== "todo") await updateNode(node.id, { status: next });
      })();
      return;
    }
    void updateNode(node.id, { status: next });
  };

  return (
    <div>
      <NameBlock
        node={node}
        onRename={(name) => void updateNode(node.id, { name })}
        sub={
          done && node.completed_at ? (
            <>
              完成於 <b>{fmtDateTime(node.completed_at)}</b>
            </>
          ) : undefined
        }
      />

      <SectionRule title="状態" />
      <div className="fields">
        <FieldRow label="現況">
          {/* 定期券：「已完成」＝退役（v1 不從這裡做），済要蓋在下面検印欄的那一班上 */}
          <Segmented
            value={node.status}
            options={teiki ? STATUS_OPTIONS.filter((o) => o.value !== "done") : STATUS_OPTIONS}
            onChange={(v) => {
              if (v) changeStatus(v);
            }}
            ariaLabel="狀態"
            twoColumns
          />
          {teiki && <p className="empty">定期券：在検印欄蓋班次</p>}
        </FieldRow>

        <FieldRow label="優先級">
          <Segmented
            value={node.priority}
            options={PRIORITY_OPTIONS}
            onChange={(v) => {
              if (v) void updateNode(node.id, { priority: v });
            }}
            ariaLabel="優先級"
          />
        </FieldRow>

        <FieldRow label="心情">
          <MoodLights value={node.mood} onChange={(m) => void updateNode(node.id, { mood: m })} />
        </FieldRow>
      </div>

      <SectionRule title="時刻" />
      <div className="fields">
        <FieldRow label="執行日">
          {lockedDate ? <LockedDate value={node.scheduled_on} /> : (
            <DateField
              value={node.scheduled_on}
              onCommit={(v) => void updateNode(node.id, { scheduled_on: v })}
              ariaLabel="執行日"
            />
          )}
        </FieldRow>

        <FieldRow label="締切日">
          <DateField value={node.due_on} onCommit={(v) => void updateNode(node.id, { due_on: v })} ariaLabel="締切日" />
        </FieldRow>
      </div>

      {/* 重複＝獨立區段（M3 ④ WP3）；舊的自由文字 CommitInput 退場 */}
      <RepeatSection node={node} />

      {teiki && <TeikiStampRow node={node} />}
      {retired && (
        <>
          <SectionRule title="検印" />
          <p className="empty">系列已退役——改狀態即重新排班</p>
        </>
      )}

      <SectionRule title="分量" />
      <div className="fields">
        <FieldRow label="預計">
          <NumberField
            value={node.estimate_min}
            onCommit={(v) => void updateNode(node.id, { estimate_min: v })}
            ariaLabel="預計時間（分）"
            unit="分"
            placeholder="—"
          />
        </FieldRow>

        <FieldRow label="花費">
          <NumberField
            value={node.time_spent_min}
            onCommit={(v) => void updateNode(node.id, { time_spent_min: v })}
            ariaLabel="花費時間（分）"
            unit="分"
            placeholder="—"
          />
        </FieldRow>

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

      <SectionRule title="乘務記錄" aside={logCount ? `${logCount} 則` : undefined} />
      <WorkLogList nodeId={node.id} />

      <ActionsRow
        left={
          node.kind === "train" ? (
            <ActionButton ariaLabel="轉為支線" title="把這班列車改成支線（子專案）" onClick={() => void convert(node, "branch")}>
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
  const setCompleted = useNodeStore((s) => s.setCompleted);
  const routes = useNodeStore((s) => s.routes);
  const setRouteTag = useNodeStore((s) => s.setRouteTag);
  // 只數主人手寫的那幾則；系統事件（発券／入鋏／済）不算「記録」（整合席：WP4 開的接口）
  const logCount = useNodeStore(
    (s) => s.workLogs[node.id]?.filter((l) => l.event === null).length ?? 0,
  );
  const showToast = useUiStore((s) => s.showToast);
  const { updateNode, remove } = useNodeActions();
  const done = node.status === "done";
  /**
   * 定期券只認 parseRule（legacy 自由文字票＝乘車券）；検印區換成「本班：済／運休」。
   * 退役的定期券（status='done'，cascade 帶下來的）走**一般車票**那一套：済章蓋著、再點一次＝取消完成
   * ＝解除退役重新排班（沿既有反悔路徑），否則検印讀不到班次、按下去是空更新（M3 ④ 評審 should-5）。
   */
  const retired = parseRule(node.repeat_rule) !== null && done;
  const teiki = parseRule(node.repeat_rule) !== null && !done;
  /** 掛著規則就不給直改執行日——退役的也一樣（repository 的 reschedule 只看 parseRule，改了照樣被擋） */
  const lockedDate = teiki || retired;
  // 只有「剛蓋」才播蓋章動畫（原型 .fresh）；取消完成時不播
  const [fresh, setFresh] = useState(false);
  const stamp = () => {
    const next = !done;
    setFresh(next);
    void setCompleted(node.id, next);
  };

  /**
   * 臨時車票＝parent_id 為 null 的車票（a18–a21）。只有它能掛路線標籤（repository 會擋掉其他情形），
   * 也只有它需要——樹裡的車票路線由祖先決定。
   */
  const isTemp = node.parent_id === null;
  const tagRoute = node.route_id ? routes.find((r) => r.id === node.route_id) : undefined;

  const tag = async (routeId: string | null) => {
    const r = await setRouteTag(node.id, routeId);
    if (!r.ok) showToast({ message: r.reason ?? "無法掛路線標籤" }, 4000);
  };

  return (
    <div>
      <NameBlock
        node={node}
        onRename={(name) => void updateNode(node.id, { name })}
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

      {isTemp && (
        <>
          <SectionRule title="路線" />
          <div className="fields">
            <FieldRow label="路線標籤">
              {/* 選一條＝寫 route_id（line_id 由 repository 同步）；「無路線」＝清成 null。
                  票根（上方 .panel-kind）與今日列的票根會立刻換成該路線的色。 */}
              <Segmented
                value={node.route_id ?? NO_ROUTE}
                options={[
                  { value: NO_ROUTE, label: "無路線" },
                  ...routes.map((r) => ({ value: r.id, label: r.code ? `${r.code}・${r.name}` : r.name })),
                ]}
                onChange={(v) => void tag(!v || v === NO_ROUTE ? null : v)}
                ariaLabel="路線標籤"
              />
            </FieldRow>
          </div>
        </>
      )}

      <SectionRule title="時刻" />
      <div className="fields">
        <FieldRow label="執行日">
          {lockedDate ? <LockedDate value={node.scheduled_on} /> : (
            <DateField
              value={node.scheduled_on}
              onCommit={(v) => void updateNode(node.id, { scheduled_on: v })}
              ariaLabel="執行日"
            />
          )}
        </FieldRow>
      </div>

      {/* 重複＝獨立區段（M3 ④ WP3）；掛上規則票頭立刻變「定期券」，検印欄改蓋班次 */}
      <RepeatSection node={node} />

      {teiki ? (
        <TeikiStampRow node={node} />
      ) : (
        <>
          <SectionRule title="検印" />
          {/* 車票＝純蓋章零打斷（D4）：再按一次＝取消完成；検印欄與「済」印＝原型 .stamp／.seal（.stamped／.fresh 對應 .ticket.done／.fresh） */}
          <div className={`stamp-row ${done ? "stamped" : ""} ${fresh ? "fresh" : ""}`}>
            <button
              type="button"
              aria-label={done ? "取消完成" : "蓋章完成"}
              aria-pressed={done}
              title={done ? "再按一次取消完成" : "蓋章：完成／取消"}
              onClick={stamp}
              className="stamp"
            >
              <span className="hint">検印</span>
              <span className="seal">済</span>
            </button>
            <span className="meta">
              {done ? (
                <>
                  已完成
                  {node.completed_at && <span className="latin" style={{ display: "block" }}>{fmtDateTime(node.completed_at)}</span>}
                </>
              ) : (
                "點一下蓋章"
              )}
            </span>
          </div>
          {/* 退役的定期券：済章就在上面，取消它＝解除退役、引擎重新排班（M3 ④ 評審 should-5）。
              車票面板沒有狀態 Segmented，指路就指到這裡唯一那個動作上。 */}
          {retired && <p className="empty">系列已退役——取消済章即重新排班</p>}
        </>
      )}

      {/* 工作日誌（D-③-4 甲：`L` 全列可用，車票面板補這一段）——直接掛既有 WorkLogList，
          時刻戳＋手寫內文的樣式（＝「乘務記錄」那套版式）在 stamps.css，今日視圖按 `L` 記的那一句就落在這裡。
          標題與列車／車廂面板同一個字：同一個側板位置只能有一個名字（件一 :1340 的 <h4>工作日誌</h4>）。 */}
      <SectionRule title="乘務記錄" aside={logCount ? `${logCount} 則` : undefined} />
      <WorkLogList nodeId={node.id} />

      <ActionsRow
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
  const n = descendantCount(tree, node.id);

  return (
    <div>
      <NameBlock
        node={node}
        onRename={(name) => void updateNode(node.id, { name })}
        sub={
          n > 0 ? (
            <>
              含 <b>{n}</b> 個節點
            </>
          ) : undefined
        }
      />

      <SectionRule title="概要" />
      <CommitTextarea
        value={node.description ?? ""}
        onCommit={(v) => void updateNode(node.id, { description: v || null })}
        ariaLabel="支線描述"
        placeholder="這條支線負責什麼……"
      />

      <ActionsRow
        left={
          <ActionButton ariaLabel="轉為列車" title="把這條支線改成一班列車（任務）" onClick={() => void convert(node, "train")}>
            轉為列車
          </ActionButton>
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

/* ───────────── 其他 kind（理論上不會進樹；保底只給改名＋刪除） ───────────── */

function FallbackPanel({ node }: { node: NodeRow }) {
  const { updateNode, remove } = useNodeActions();
  return (
    <div>
      <NameBlock node={node} onRename={(name) => void updateNode(node.id, { name })} />
      <ActionsRow
        right={
          <ActionButton ariaLabel={`刪除${KIND_LABEL[node.kind]}`} tone="danger" onClick={() => remove(node)}>
            刪除
          </ActionButton>
        }
      />
    </div>
  );
}
