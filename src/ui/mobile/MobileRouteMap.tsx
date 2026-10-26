/**
 * MobileRouteMap——路線圖手機版（v1.1.0「手機殼可用」WP2 席起；手機殼班起可編輯）。
 *
 * 沿革：v1.1.0 依 D-1.1-2「路線圖手機版唯讀」＋《2026-09-16-v1.1.0-手機殼契約.md》§2.8 做成唯讀版；
 *   D-1.1-2 已作廢（使用者 10-20 更正：手機要做得到桌機做得到的事）。手機殼班（契約 2026-10-25 §一A）改成可編輯：
 *   - **D-主-71**：第二層每列右側常駐**検印鈕**（済／取消済；運休班次點印＝取消運休；口徑見本註解最後一段）＋ **⋯ 鈕**開
 *     MobileTicketSheet 分組版（D-主-76；今日、行程表同一支）。蓋済的若是列車／車廂 ⇒ 開完成卡（uiStore.completeCardFor）。
 *   - **D-主-72**：⋯ 內「同層新增…／新增車票…」，命名走 MobileTextSheet；空路線／空縮放層的空狀態有「新增第一班…」。
 *   - 寫入一律接到桌機大綱同一套（routemap/routeMapActions.ts 檔頭有逐條對照）：蓋済與運休＝outline/nodeFlows、
 *     停用理由＝outline/rowGuards（桌機 menuFor 同一支）、升降層／上移下移／新增＝nodeStore 同名動作、刪除＝今日頁 deleteTicket（toast＋復原）。
 *   - 返回層：⋯ sheet（含子面板、空狀態的新增面板）＝一層 `core.routemapSheet`。
 *   - 點列中間＝原地展開唯讀詳情（快看，照舊保留）；完整詳情走 ⋯ →「詳情…」（手機詳情頁，D-主-75）。
 *   - 樹掛 `data-no-fab`：右側常駐按鈕會被「記一句」浮鈕蓋住，看樹時收起浮鈕（第二輪；第一層路線清單照舊有）。
 * 第四輪（D-主-84／85：手機補齊路線／幹線管理，桌機全集對照在決策記錄）：
 *   - 第一層每段幹線抬頭右側 ⋯（MSheet list：改名…／新增路線…／刪除幹線）、清單最底「＋ 新增幹線」；
 *     改名與新增幹線走 MobileTextSheet，新增路線走 routemap/MobileRouteForm（建好就進那條路線的第二層）。
 *   - 空狀態換共用 EmptyState（同桌機大綱 NoRouteEmpty 的兩種）：沒幹線＝「新增幹線」、有幹線沒路線＝「新增路線」（第一條幹線底下）。
 *   - 第二層路線抬頭右側 ⋯ →「路線詳情…」＝開手機詳情頁（MobileDetailHost 認得路線種類，畫 detail/MobileRouteBody）。
 *   - 寫入一律走 panel/routeFlows（桌機 RouteDialog／RoutePanel 同一支）；返回層：第一層的 ⋯ 流程＝一層 `core.routemapLines`，
 *     第二層抬頭的 ⋯ 併進既有的 `core.routemapSheet`。
 *
 * 兩層：
 *   第一層＝我的路線清單（nodeStore.lines／routes；每列＝色帶＋roundel＋路線名）。
 *     **不顯示每條路線的進度**：store 只持有「當前開啟那一條」的樹，逐條算要嘛得載完所有路線、
 *     要嘛得叫 `nodeRepo.routeProgress`（UI 不碰 repository 的紀律）——契約 §2.8 明寫「v1.1.0 不用，
 *     否則略」。進度改在第二層的路線抬頭給（那裡的樹已經在手上）。
 *   第二層＝該路線的樹（nodeStore.tree：byId／childrenOf／roots）以縮排清單呈現，
 *     可 zoom-in 到子樹、麵包屑回溯（「我的路線 › 路線名 › 祖先 › 目前」全段可點）。
 *
 * 唯讀詳情（點列中間展開）：無 inline input、無長按選單、無拖曳（桌機大綱也沒有拖曳，排序＝⋯ 內上移／下移，雙端對等）。
 *   v1.1.2 補一段：唯讀詳情底下印該票的**競合**列（同步衝突的敗方值；D-1.1-5）——手機詳情頁之外，這裡也看得到。
 *   接縫 #56：詳情欄位表之後渲染別線登記的 `nodeFields` 的 `Mobile` 列（旅客筆記的「荷札」可掛可摘，D-筆-42）；
 *   寫入在線自己的元件裡；沒有任何一線登記＝DOM 與文案照舊。
 *   接縫 #63：第一層每條路線列尾（`.m2-route-name` 之後、`.m2-route-go` 之前）渲染別線登記的 `routeListAside`（小字）；
 *   元件在 `button` 裡面，只能回 span／純文字、不得放可點的東西；沒有任何一線登記＝DOM 照舊。
 *   點列中間不開詳情頁，改在該列下方展開一段**唯讀詳情**
 *   （票種／票號／現況／執行日／締切日／重複／預計／概要，欄位與稱謂沿 panel 的 format）。
 *
 * 狀態刻意全放本地 useState，不借桌機的 uiStore.zoomId／collapsed（契約 §2.8）：
 *   那兩個是桌機鍵盤流（Esc 退一層、←→ 收合）的狀態，兩殼共用會互相污染；
 *   麵包屑每一段都做成按鈕，並且 sticky 釘在內容區頂端——捲到樹深處時它仍在畫面上。
 *   磨光① A3（返回堆疊）：第二層登記成子頁層，Android 返回鍵＝麵包屑上一段（有縮放退一層祖先、沒縮放回路線清單）。
 *
 * 磨光① A7（接縫 #89；契約 §2.3、§9.4）：從別處「跳到某張票」走核心的請求槽 `useRevealStore`（routeMapReveal.ts）。
 *   本元件收 `target === "routemap"`（已經停在路線圖 tab 也接得到）：進那條路線；樹載好後把節點的祖先都展開、
 *   不縮放、展開它的唯讀詳情、捲到那一列並閃一下（D-主-48）。節點不在樹裡（被刪了）⇒ 停在那條路線第二層。
 * 磨光① N9：済列的印改用圓印 `SealDone small`（手機今日票卡同一枚）；運休照舊方角印（規格 §6：圓印＝定案、角印＝運行狀態告示）。
 *
 * 定期券口徑與大綱同一把尺（M3 ④）：是不是定期券＝`parseRule(repeat_rule) !== null`；
 *   済了沒＝`currentOccurrences[id] ? status === 'done' : node.status === 'done'`；運休＝`status === 'skipped'`。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  KIND_LABEL,
  canHaveChildren,
  describeConflict,
  describeRule,
  parseRule,
  type NodeRow,
  type NodeStatus,
} from "../../domain";
import type { CurrentOccurrence } from "../../data";
import { effectiveTime, isTimeOverridden } from "../../domain/scheduledTime";
import { flattenSubtrees, isRouteNodeDone, routeHeadStats, routeHeadTicketText } from "../../domain/routeHead";
import {
  ancestorsOf,
  descendantCount,
  openDescendantCount,
  serialOf,
  useNodeStore,
  type TreeIndex,
} from "../../store/nodeStore";
import { roundelStyle } from "../common/roundel";
import { EmptyState } from "../common/EmptyState";
import { IconPlus } from "../common/icons";
import { MSheet, MSheetItem } from "../common/MSheet";
import { createLine, renameLine, requestDeleteLine } from "../panel/routeFlows";
import { Chevron } from "../common/Chevron";
import { lineNodeFields, lineRouteListAsides } from "../../lines/runtime";
// 票根徽章與票種的算法沿大綱（只讀 import，顯示端不手抄一份規則；OutlineRow 的這三支是純函式／常數）
import { KIND_GLYPH, badgeClass, fareClass } from "../outline/OutlineRow";
import { completeNodeFlow, suspendNodeFlow } from "../outline/nodeFlows";
import { makeScheduleActions } from "../schedule/scheduleActions";
import { moveNodeTo } from "../common/moveTo";
import { useUiStore } from "../../store/uiStore";
import { todayKey } from "../../lib/date";
import { SealDone } from "../stamps";
import { useBackLayer } from "./backStack";
import { useRevealStore } from "./routeMapReveal";
import { MobileTicketSheet } from "./MobileTicketSheet";
import { MobileTextSheet } from "./MobileTextSheet";
import { useMobileDetailStore } from "./detail/mobileDetailStore";
import { MobileRouteForm } from "./routemap/MobileRouteForm";
import { logTicket, renameTicket } from "./useMobileToday";
import {
  addTitle,
  cardFromTreeNode,
  createAt,
  deleteRow,
  firstPlan,
  guardsFor,
  indentRow,
  outdentRow,
  reorderRow,
  siblingPlan,
  ticketPlan,
  type AddPlan,
} from "./routemap/routeMapActions";
import "./mobile-quickjump.css";
import "./routemap/routemap.css";
import "./routemap/route-manage.css";

/** ⋯ sheet 整個流程（含子面板、空狀態的新增面板）的返回層 id；MobileTicketSheet 的每張 MSheet 用同一個 id 合併成一層 */
const ROUTEMAP_SHEET_LAYER = "core.routemapSheet";
/** 第一層（路線清單）幹線 ⋯ 流程（含改名、新增路線、新增幹線面板）的返回層 id */
const LINES_SHEET_LAYER = "core.routemapLines";

/** 空狀態的印章輪廓：空的検印框（同桌機大綱 Outline.tsx EMPTY_STAMP） */
const EMPTY_STAMP = (
  <span className="stamp">
    <span className="hint">検印</span>
  </span>
);

/** 跳轉落點閃一下的長度（D-主-48；CSS 動畫 1s，class 多留一點再拿掉） */
const REVEAL_FLASH_MS = 1100;

const EMPTY: string[] = [];

/** 縮排每層 13px、第 5 層起不再往右（手機只有 ~360px 可用寬，縮排吃掉的都是票名的字） */
const INDENT_STEP = 13;
const INDENT_MAX_DEPTH = 4;

/** 現況字樣沿 OutlineRow 的 STATUS_LABEL（那份是模組內常數、沒 export，這裡照抄一份並註明來源） */
const STATUS_TEXT: Record<NodeStatus, string> = {
  todo: "未開始",
  doing: "進行中",
  paused: "途中下車",
  done: "已完成",
};

/** 載入 >200ms 才顯示安靜指示，避免閃爍（沿 Outline.tsx 的 useDelayedFlag，該支未 export） */
function useDelayedFlag(flag: boolean, ms: number): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!flag) {
      setOn(false);
      return;
    }
    const t = setTimeout(() => setOn(true), ms);
    return () => clearTimeout(t);
  }, [flag, ms]);
  return on;
}

interface VisibleRow {
  id: string;
  depth: number;
}

/** 可見列：深度優先展開，收合的節點不遞迴（手機預設全展開，收合狀態存本地） */
function buildRows(tree: TreeIndex, rootChildren: string[], collapsed: Record<string, boolean>): VisibleRow[] {
  const out: VisibleRow[] = [];
  const walk = (ids: string[], depth: number) => {
    for (const id of ids) {
      if (!tree.byId[id]) continue;
      out.push({ id, depth });
      if (!collapsed[id]) walk(tree.childrenOf[id] ?? EMPTY, depth + 1);
    }
  };
  walk(rootChildren, 0);
  return out;
}

/* ── 小圖示（1.3px 細線幾何，與 gnav／tabs.ts 同筆觸；stroke 走 currentColor）── */

// 展開／收合箭頭 Chevron 在磨光⑤ K5 抽到 ui/common/Chevron（桌機大綱同一枚）

function CaretRight() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" aria-hidden>
      <path d="M6 3.5 10.5 8 6 12.5" />
    </svg>
  );
}

/** 路線圓牌（沿 Sidebar 的 RouteRoundel：亮盤深字；無代碼時只留圓點，仍佔位不跳行） */
function RouteRoundel({ route }: { route: NodeRow }) {
  const disc = roundelStyle(route.color);
  if (route.code) {
    return (
      <span aria-hidden className="roundel" style={disc}>
        {route.code}
      </span>
    );
  }
  return (
    <span aria-hidden className="roundel">
      <i className="dot" style={{ background: disc.background }} />
    </span>
  );
}

/* ═══════════════ 第一層：我的路線 ═══════════════ */

/** 第一層的面板：哪一條幹線的 ⋯、改名、新增路線、新增幹線（同一時間一張） */
type ListSheet =
  | { kind: "menu"; line: NodeRow }
  | { kind: "rename"; line: NodeRow }
  | { kind: "route"; line: NodeRow }
  | { kind: "line" };

function RouteList({ onOpen }: { onOpen: (id: string) => void }) {
  const lines = useNodeStore((s) => s.lines);
  const routes = useNodeStore((s) => s.routes);
  // 接縫 #63：路線列尾的別線小字；沒有任何線填值＝空陣列＝DOM 不變
  const asides = lineRouteListAsides();
  const [sheet, setSheet] = useState<ListSheet | null>(null);
  const close = () => setSheet(null);
  useBackLayer(LINES_SHEET_LAYER, sheet !== null, close);

  // 面板開著的那條幹線不見了（刪了、同步收到刪除）：收掉
  useEffect(() => {
    if (sheet && sheet.kind !== "line" && !lines.some((l) => l.id === sheet.line.id)) setSheet(null);
  }, [sheet, lines]);

  /** 空狀態（D-主-85；同桌機大綱 NoRouteEmpty 兩種）：沒幹線＝先建幹線；有幹線沒路線＝在第一條幹線底下開路線 */
  let empty: ReactNode = null;
  if (!lines.length) {
    empty = (
      <EmptyState
        tone="first"
        stamp={EMPTY_STAMP}
        title="還沒有任何路線"
        desc="先建一條幹線（大方向，例如「學習」），再在底下開路線。"
        action={{ label: "新增幹線", icon: <IconPlus />, onClick: () => setSheet({ kind: "line" }) }}
        className="m2-empty-state"
      />
    );
  } else if (!routes.length) {
    const first = lines[0];
    empty = (
      <EmptyState
        tone="first"
        stamp={EMPTY_STAMP}
        title={lines.length === 1 ? "這條幹線還沒有路線" : "幹線底下還沒有路線"}
        desc={`在「${first.name}」底下開一條路線，就能開始鋪軌。`}
        action={{ label: "新增路線", icon: <IconPlus />, onClick: () => setSheet({ kind: "route", line: first }) }}
        className="m2-empty-state"
      />
    );
  }

  return (
    <>
      {empty}
      {lines.length > 0 && (
        <div className="m2-lines">
          {lines.map((line) => {
            const lineRoutes = routes.filter((r) => r.line_id === line.id);
            return (
              <section key={line.id} aria-label={`幹線 ${line.name}`}>
                <div className="m2-trunk-row">
                  <p className="m2-trunk">幹線・{line.name}</p>
                  <button
                    type="button"
                    className="m2-more"
                    aria-label={`更多動作——幹線${line.name}`}
                    aria-haspopup="dialog"
                    onClick={() => setSheet({ kind: "menu", line })}
                  >
                    <span aria-hidden>⋯</span>
                  </button>
                </div>
                {lineRoutes.length === 0 ? (
                  // 整頁空狀態已經在講「沒有路線」：各幹線不再重複這一句
                  routes.length > 0 && <p className="m2-note">這條幹線底下還沒有路線</p>
                ) : (
                  <ul className="m2-route-list">
                    {lineRoutes.map((route) => (
                      <li key={route.id}>
                        <button type="button" className="m2-route" onClick={() => onOpen(route.id)}>
                          <span aria-hidden className="m2-band" style={{ background: route.color ?? "var(--route-preset-4)" }} />
                          <RouteRoundel route={route} />
                          <span className="m2-route-name">{route.name}</span>
                          {asides.map((A, i) => (
                            <A key={i} route={route} />
                          ))}
                          <span aria-hidden className="m2-route-go">
                            <CaretRight />
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
          {/* 新增幹線（同桌機書封最底「＋ 幹線」）；沒有幹線時改由空狀態的鈕當唯一入口（同頁一個入口） */}
          <button type="button" className="m2-add-line" onClick={() => setSheet({ kind: "line" })}>
            <IconPlus />
            新增幹線
          </button>
        </div>
      )}

      {/* 幹線 ⋯（D-主-85）：改名…／新增路線…／刪除幹線 */}
      {sheet?.kind === "menu" && (
        <MSheet list title={`幹線・${sheet.line.name}`} backId={LINES_SHEET_LAYER} onClose={close}>
          <MSheetItem onClick={() => setSheet({ kind: "rename", line: sheet.line })}>改名…</MSheetItem>
          <MSheetItem onClick={() => setSheet({ kind: "route", line: sheet.line })}>新增路線…</MSheetItem>
          <MSheetItem
            cut
            danger
            onClick={() => {
              const line = sheet.line;
              close();
              // 確認框＋別線附加句＋切走目前路線＋復原都在 routeFlows（桌機編輯幹線同一支）
              void requestDeleteLine(line);
            }}
          >
            刪除幹線
          </MSheetItem>
        </MSheet>
      )}
      {sheet?.kind === "rename" && (
        <MobileTextSheet
          title="改名"
          name={sheet.line.name}
          initial={sheet.line.name}
          placeholder="幹線名稱"
          submitLabel="改好了"
          inputLabel="幹線的新名稱"
          backId={LINES_SHEET_LAYER}
          onSubmit={(name) => {
            const line = sheet.line;
            close();
            if (name !== line.name) void renameLine(line.id, name);
          }}
          onClose={close}
        />
      )}
      {sheet?.kind === "line" && (
        <MobileTextSheet
          title="新增幹線"
          initial=""
          placeholder="例：工作、學習、健康"
          submitLabel="建立"
          inputLabel="新幹線的名稱"
          backId={LINES_SHEET_LAYER}
          onSubmit={(name) => {
            close();
            void createLine(name);
          }}
          onClose={close}
        />
      )}
      {sheet?.kind === "route" && (
        <MobileRouteForm
          lineId={sheet.line.id}
          lineName={sheet.line.name}
          backId={LINES_SHEET_LAYER}
          onCreated={(id) => {
            close();
            onOpen(id);
          }}
          onClose={close}
        />
      )}
    </>
  );
}

/* ═══════════════ 第二層：一條路線的樹 ═══════════════ */

/** UTC ISO → 本地 "M/D HH:mm"（競合列的時刻淡字；沿 WorkLogList 的兩支小工，手機只要一支） */
function fmtLogHm(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 一列的唯讀詳情（沿 panel 的欄位稱謂：現況／執行日／締切日／預計／概要；定期券的執行日印「由規則排定」） */
function RowDetail({ node, serial, occurrence }: { node: NodeRow; serial: string; occurrence?: CurrentOccurrence }) {
  const rule = parseRule(node.repeat_rule);
  /**
   * v1.1.2（D-1.1-5）：同步衝突的敗方值寫在該節點的乘務記錄（`event='conflict'`）。
   * 這段唯讀詳情是快看的入口，印競合列讓主人不必進詳情頁也看得到「我打的字被另一台換掉了，舊值還在」。
   * **只印競合列**：手記與発券／入鋏／済 在詳情頁（手機殼班 D-主-69）與桌機側板，這裡是摘要，不該變成第二個日誌畫面。
   */
  const loadWorkLogs = useNodeStore((s) => s.loadWorkLogs);
  const logs = useNodeStore((s) => s.workLogs[node.id]);
  useEffect(() => {
    void loadWorkLogs(node.id);
  }, [node.id, node.updated_at, loadWorkLogs]);
  const conflicts = useMemo(
    () =>
      (logs ?? [])
        .filter((l) => l.event === "conflict")
        .sort((a, b) => (a.logged_at < b.logged_at ? 1 : a.logged_at > b.logged_at ? -1 : 0)),
    [logs],
  );
  const fare = fareClass(node);
  const runDate = occurrence?.due_on ?? node.scheduled_on;
  const fields: { label: string; value: string; latin?: boolean; wrap?: boolean }[] = [
    { label: "票種", value: fare.label },
    ...(serial ? [{ label: "票號", value: `No.${serial}`, latin: true }] : []),
    { label: "現況", value: STATUS_TEXT[node.status] },
    /**
     * 定期券多一列「本班」：済／運休蓋在**班次**上，`nodes.status` 一路是 todo（M3 ④ 口徑）。
     * 少了這一列，主人會看到「現況 未開始」旁邊掛著一枚済章——桌機側板是用獨立的検印欄講這件事，
     * 手機的検印鈕在列上（只畫章、不寫字），展開的詳情裡就把同一件事寫成一行字。
     */
    ...(rule
      ? [
          {
            label: "本班",
            value: occurrence?.status === "done" ? "済" : occurrence?.status === "skipped" ? "運休（本班暫停）" : "未交代",
          },
        ]
      : []),
    {
      label: "執行日",
      value: node.scheduled_on ?? "—",
      latin: true,
    },
    { label: "締切日", value: node.due_on ?? "—", latin: true },
    /**
     * 主線②（契約 §4.6）：預定時刻（D-主-12 寫法「14:00 発・90 分」）；定期券這一列是「每班」的時刻。
     * 本班有逐班覆寫時再多一列「本班幾點」。班次日＝`occurrence?.due_on ?? scheduled_on`（桌機 TeikiStampRow
     * 的 railDate 同一把尺）——`currentOccurrences` 只收有結局的班，沒交代的目前班次要退到 scheduled_on 才找得到。
     */
    {
      label: "幾點",
      value: node.scheduled_time
        ? `${node.scheduled_time} 発${node.estimate_min ? `・${node.estimate_min} 分` : ""}`
        : "—",
      latin: true,
    },
    ...(rule && runDate && isTimeOverridden(node, runDate)
      ? [{ label: "本班幾點", value: effectiveTime(node, runDate) ?? "不排時刻", latin: true }]
      : []),
    ...(rule ? [{ label: "重複", value: describeRule(rule) }] : []),
    ...(node.estimate_min ? [{ label: "預計", value: `${node.estimate_min} 分` }] : []),
    { label: "概要", value: node.description?.trim() || "—", wrap: true },
  ];
  // 別線登記的可寫欄位（例：旅客筆記的「荷札」，D-筆-42）；沒有任何一線登記＝空、DOM 照舊
  const lineFields = lineNodeFields("mobile").filter((f) => f.Mobile && f.kinds.includes(node.kind));

  return (
    <div className="m2-detail">
      <dl className="m2-fields">
        {fields.map((f) => (
          <div key={f.label} className={"m2-field" + (f.wrap ? " is-wrap" : "")}>
            <dt className="m2-field-label">{f.label}</dt>
            <dd className={"m2-field-value" + (f.latin ? " is-latin" : "")}>{f.value}</dd>
          </div>
        ))}
      </dl>
      {/* 別線登記的欄位列（插槽 `nodeFields` 的 `Mobile`，接縫 #56；本檔仍零 mutation import，寫入在線的元件裡） */}
      {lineFields.map((f) => (f.Mobile ? <f.Mobile key={f.id} node={node} /> : null))}
      {/* 定期券的執行日由規則排定（D-④-3）——桌機側板印「由規則排定」，手機沿同一句話 */}
      {rule && <p className="m2-note">執行日由定期券自動排定</p>}
      {conflicts.length > 0 && (
        <div className="m2-detail-conflicts">
          <span className="m2-field-label">競合</span>
          <ul className="m2-conflict-list">
            {conflicts.map((l) => (
              <li key={l.id}>
                <span className="m2-conflict-tm">{fmtLogHm(l.logged_at)}</span>
                <span>{describeConflict(l.body)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {/* 手機殼班：原本這裡的「僅供檢視，要修改請到電腦版」拿掉——改在右側 ⋯，完整欄位在「詳情…」 */}
    </div>
  );
}

export default function MobileRouteMap() {
  const lines = useNodeStore((s) => s.lines);
  const routes = useNodeStore((s) => s.routes);
  const tree = useNodeStore((s) => s.tree);
  const serials = useNodeStore((s) => s.serials);
  const currentOccurrences = useNodeStore((s) => s.currentOccurrences);
  const storeRouteId = useNodeStore((s) => s.routeId);
  const loading = useNodeStore((s) => s.loading);
  const openRoute = useNodeStore((s) => s.openRoute);

  /** null＝停在第一層（路線清單）。與 store 的 routeId 分開記：App 啟動就自動開了第一條路線，
   *  拿 routeId 當「使用者進了第二層」會讓手機一進頁就跳進樹裡。 */
  const [openedId, setOpenedId] = useState<string | null>(null);
  const [zoomId, setZoomId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [detailId, setDetailId] = useState<string | null>(null);
  /** A7：進了路線、等樹載好才落點的那張票 */
  const [landing, setLanding] = useState<{ routeId: string; nodeId: string } | null>(null);
  /** A7：已展開、等那一列畫出來再捲過去的票；捲到之後換成閃一下的那一列 */
  const [scrollId, setScrollId] = useState<string | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  /* ── 手機殼班：編輯（D-主-71／72） ── */
  /** ⋯ sheet 開著的那一列 */
  const [sheetId, setSheetId] = useState<string | null>(null);
  /** 空狀態「新增第一班…」的命名面板（落點與種類） */
  const [firstAdd, setFirstAdd] = useState<AddPlan | null>(null);
  /** 第四輪：路線抬頭的 ⋯（路線詳情…） */
  const [headMenu, setHeadMenu] = useState(false);
  const openDetail = useMobileDetailStore((s) => s.open);
  /** 剛蓋章的那一列（SealDone fresh 動畫） */
  const [freshId, setFreshId] = useState<string | null>(null);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  /** 改期／時刻跟行程表手機版同一組動作（scheduleActions；節點本身以 `{ kind: "due", node }` 傳入） */
  const schedActions = useMemo(() => makeScheduleActions("mobile"), []);
  useBackLayer(ROUTEMAP_SHEET_LAYER, sheetId !== null || firstAdd !== null || headMenu, () => {
    setSheetId(null);
    setFirstAdd(null);
    setHeadMenu(false);
  });

  const route = openedId ? routes.find((r) => r.id === openedId) : undefined;
  const line = route ? lines.find((l) => l.id === route.line_id) : undefined;
  /** 樹是「store 目前開著的那條路線」的；換路線的載入完成前不能拿來畫（會畫到上一條的樹） */
  const treeReady = openedId !== null && storeRouteId === openedId;
  const showLoading = useDelayedFlag(openedId !== null && (loading || !treeReady), 200);

  // 路線被刪掉／側欄重載後不見了：退回第一層，不留在一個沒有主體的第二層
  // （第四輪：拿掉「routes 有東西才判」——手機刪掉最後一條路線時 routes 是空的，原本會停在空的第二層）
  useEffect(() => {
    if (openedId && !routes.some((r) => r.id === openedId)) setOpenedId(null);
  }, [openedId, routes]);

  const zoom: NodeRow | null = zoomId && treeReady ? (tree.byId[zoomId] ?? null) : null;
  const rootChildren = zoom ? (tree.childrenOf[zoom.id] ?? EMPTY) : tree.roots;
  const rows = useMemo(
    () => (treeReady ? buildRows(tree, rootChildren, collapsed) : []),
    [treeReady, tree, rootChildren, collapsed],
  );

  /**
   * 路線抬頭的統計（磨光⑤ N12）：與桌機大綱頁首同一支 domain/routeHead——分母只數車票，
   * 済＝定期券看目前班次的結局、其餘看 status（同桌機 isDoneNode）。
   */
  const stat = useMemo(() => {
    if (!treeReady) return null;
    return routeHeadStats(flattenSubtrees(tree, tree.roots), (n) => isRouteNodeDone(n, currentOccurrences));
  }, [treeReady, tree, currentOccurrences]);

  const enterRoute = (id: string) => {
    setZoomId(null);
    setCollapsed({});
    setDetailId(null);
    setSheetId(null);
    setFirstAdd(null);
    setHeadMenu(false);
    setOpenedId(id);
    // 已經是當前路線就不重載（App 啟動已開第一條）——重載只是多一趟查詢，畫面不會變
    if (useNodeStore.getState().routeId !== id) void openRoute(id);
  };

  const backToList = () => {
    setOpenedId(null);
    setZoomId(null);
    setDetailId(null);
    setLanding(null);
  };

  const zoomTo = (id: string | null) => {
    setZoomId(id);
    setDetailId(null);
  };

  /** 返回鍵（A3）＝麵包屑上一段：有縮放退到上一層祖先（父就是路線本身＝回路線頂層），沒縮放回路線清單 */
  const goUp = () => {
    if (openedId && zoom) zoomTo(ancestorsOf(tree, openedId, zoom.id)[0] ?? null);
    else backToList();
  };
  useBackLayer("core.routemap", openedId !== null, goUp, "page");

  /* ── A7：跳到某張票（請求槽 → 進路線 → 樹載好後展開、捲到、閃一下） ── */
  const req = useRevealStore((s) => s.req);

  useEffect(() => {
    if (!req || req.target !== "routemap" || !req.routeId) return;
    // 收下就銷帳，落點改記在本地：切走 tab 再回來不會把舊請求重播一次
    useRevealStore.getState().consume(req.nonce);
    enterRoute(req.routeId);
    setLanding(req.nodeId ? { routeId: req.routeId, nodeId: req.nodeId } : null);
    // enterRoute 每次 render 都是新閉包、只碰 setter 與 store，不列進依賴（列了會每次 render 重跑）
  }, [req]);

  // 樹載好（換路線的載入結束）才落點：openRoute 一開始就把 routeId 換掉、樹清空，treeReady 先成立、樹還是空的
  useEffect(() => {
    if (!landing || !treeReady || loading || openedId !== landing.routeId) return;
    const id = landing.nodeId;
    setLanding(null);
    if (!tree.byId[id]) return; // 被刪了／不在這棵樹（例：車站）：停在路線第二層
    const anc = ancestorsOf(tree, openedId, id);
    setCollapsed((c) => {
      if (!anc.some((a) => c[a])) return c;
      const next = { ...c };
      for (const a of anc) delete next[a];
      return next;
    });
    setZoomId(null);
    setDetailId(id);
    setScrollId(id);
  }, [landing, treeReady, loading, tree, openedId]);

  /** 捲過去的對齊法：跳轉落點置中（A7）；編輯落點（新增、升降層、上移下移）只捲到看得見就好，不讓畫面大跳 */
  const scrollBlockRef = useRef<ScrollLogicalPosition>("center");

  // 等那一列真的畫出來再捲（展開祖先與詳情是同一批 state，下一次 commit 才有那一列）
  useEffect(() => {
    if (!scrollId || !rows.some((r) => r.id === scrollId)) return;
    const el = pageRef.current?.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(scrollId)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: scrollBlockRef.current });
    scrollBlockRef.current = "center";
    setScrollId(null);
    setFlashId(scrollId);
  }, [scrollId, rows]);

  // ⋯ sheet 那一列不見了（刪了、搬到別條路線、同步收到刪除）：收掉 sheet，返回層跟著放掉
  useEffect(() => {
    if (sheetId && treeReady && !loading && !tree.byId[sheetId]) setSheetId(null);
  }, [sheetId, treeReady, loading, tree]);

  useEffect(() => {
    if (!flashId) return;
    const t = setTimeout(() => setFlashId(null), REVEAL_FLASH_MS);
    return () => clearTimeout(t);
  }, [flashId]);

  /* ── 手機殼班：編輯動作（寫入本體在 routemap/routeMapActions.ts、outline/nodeFlows.ts） ── */

  /** 編輯落點：展開祖先、捲到看得見、閃一下（看得出「是這一列動了／新增在這」）。樹讀 store 即時值（動作剛寫完） */
  const revealRow = (id: string) => {
    if (!openedId) return;
    const anc = ancestorsOf(useNodeStore.getState().tree, openedId, id);
    setCollapsed((c) => {
      if (!anc.some((a) => c[a])) return c;
      const next = { ...c };
      for (const a of anc) delete next[a];
      return next;
    });
    scrollBlockRef.current = "nearest";
    setScrollId(id);
  };

  /** 検印鈕：済／取消済／取消運休（桌機大綱同一支；列車／車廂蓋下去開完成卡、取消済收起——同今日／行程表） */
  const stamp = (id: string) =>
    void completeNodeFlow(
      id,
      (fid) => {
        setFreshId(fid);
        // 印章動畫 .4s；0.8s 後清旗標（reduced-motion 不發 animationend，一律用計時器兜底）
        return () => setTimeout(() => setFreshId((cur) => (cur === fid ? null : cur)), 800);
      },
      { retractCard: true },
    );

  const create = async (plan: AddPlan, name: string) => {
    const row = await createAt(plan, name);
    if (row) revealRow(row.id);
  };

  /** ⋯ sheet：一列的動作接到 MobileTicketSheet（今日、行程表同一支；新 props＝升降層、新增） */
  const renderSheet = () => {
    const n = sheetId && openedId && treeReady ? tree.byId[sheetId] : undefined;
    if (!n || !openedId) return null;
    const rid = openedId;
    const occ = currentOccurrences[n.id];
    const card = cardFromTreeNode(n, occ, serialOf(serials, n.id));
    const g = guardsFor(tree, rid, zoom?.id ?? null, n.id);
    const t = tree;
    return (
      <MobileTicketSheet
        card={card}
        today={todayKey(dayStartHour)}
        onDefer={(d) => schedActions.defer({ kind: "due", node: n }, d)}
        onSkip={(s) => void suspendNodeFlow(n.id, s)}
        onSetTime={(time, est) => schedActions.setTime(n.id, time, est)}
        onSetRunTime={(time) => {
          if (card.railDate) schedActions.setRunTime(n.id, card.railDate, time);
        }}
        onClearRunTime={() => {
          if (card.railDate) schedActions.clearRunTime(n.id, card.railDate);
        }}
        onRename={(name) => renameTicket(n.id, name, n.name)}
        onLog={(body) => logTicket(n.id, body)}
        onMove={(dest) => void moveNodeTo(n.id, dest)}
        onDelete={() => deleteRow(t, n.id)}
        reorder={
          g && {
            up: g.upWhy === null,
            down: g.downWhy === null,
            upWhy: g.upWhy ?? undefined,
            downWhy: g.downWhy ?? undefined,
            onMove: (d) => void reorderRow(n.id, d).then((ok) => ok && revealRow(n.id)),
          }
        }
        level={
          g && {
            indentWhy: g.indentWhy,
            outdentWhy: g.outdentWhy,
            onIndent: () => void indentRow(n.id).then((p) => p && revealRow(n.id)),
            onOutdent: () => void outdentRow(n.id).then((ok) => ok && revealRow(n.id)),
          }
        }
        add={{
          siblingKind: n.kind,
          onSibling: (name) => void create(siblingPlan(t, rid, n), name),
          // 車票／車站列不出「新增車票…」（跟「同層新增車票…」重複；原型 Q1）；支線出但淡掉、點了說原因
          ticket: canHaveChildren(n.kind)
            ? { why: g?.ticketWhy ?? null, onTicket: (name) => void create(ticketPlan(t, rid, n), name) }
            : null,
        }}
        backId={ROUTEMAP_SHEET_LAYER}
        onClose={() => setSheetId(null)}
      />
    );
  };

  /* ── 第一層 ── */
  if (!openedId) {
    return (
      <div className="m-page m2-page" aria-label="我的路線">
        <RouteList onOpen={enterRoute} />
      </div>
    );
  }

  /* ── 第二層 ── */
  const crumbs: { key: string; label: string; onClick?: () => void }[] = [
    { key: "__list__", label: "我的路線", onClick: backToList },
    { key: "__route__", label: route?.name ?? "路線", onClick: zoom ? () => zoomTo(null) : undefined },
    ...(zoom
      ? ancestorsOf(tree, openedId, zoom.id)
          .reverse()
          .map((id) => ({ key: id, label: tree.byId[id]?.name ?? "…", onClick: () => zoomTo(id) }))
      : []),
    ...(zoom ? [{ key: zoom.id, label: zoom.name }] : []),
  ];

  return (
    <div ref={pageRef} className="m-page m2-page" aria-label={`路線 ${route?.name ?? ""}`}>
      {/* 麵包屑：sticky 釘在內容區頂端——捲到樹深處時仍看得到；Android 返回鍵也走同一條路（上面的 goUp） */}
      <nav className="m2-crumbs" aria-label="路線位置">
        {crumbs.map((c, i) => (
          <span key={c.key} className="m2-crumb-item">
            {i > 0 && (
              <span aria-hidden className="m2-crumb-sep">
                ›
              </span>
            )}
            {c.onClick ? (
              <button type="button" className="m2-crumb" onClick={c.onClick}>
                {c.label}
              </button>
            ) : (
              <span className="m2-crumb is-here" aria-current="page">
                {c.label}
              </span>
            )}
          </span>
        ))}
      </nav>

      {!zoom && (
        <header className="m2-head m2-head-row">
          <div className="m2-head-text">
            <h2 className="m2-head-title">{route?.name ?? "路線"}</h2>
            <p className="m2-head-sub">
              {line ? `幹線・${line.name}` : ""}
              {stat && stat.ticketTotal > 0 ? `${line ? "・" : ""}${routeHeadTicketText(stat)}` : ""}
            </p>
          </div>
          {/* 第四輪（D-主-85）：路線的編輯入口＝⋯ →「路線詳情…」（全螢幕詳情頁的路線版） */}
          {route && (
            <button
              type="button"
              className="m2-more"
              aria-label={`更多動作——路線${route.name}`}
              aria-haspopup="dialog"
              onClick={() => setHeadMenu(true)}
            >
              <span aria-hidden>⋯</span>
            </button>
          )}
        </header>
      )}

      {/* 別線登記的「路線」欄位列（插槽 `nodeFields`，kinds 含 route；接縫 #62）：路線在手機沒有 RowDetail，放在抬頭之下、樹之上；沒有線填＝什麼都不畫 */}
      {!zoom &&
        route &&
        lineNodeFields("mobile")
          .filter((f) => f.Mobile && f.kinds.includes("route"))
          .map((f) => (f.Mobile ? <f.Mobile key={f.id} node={route} /> : null))}

      {!treeReady ? (
        showLoading ? (
          <p className="m2-note">載入中……</p>
        ) : null
      ) : rows.length === 0 ? (
        <div className="m2-empty">
          <p className="m2-empty-title">{zoom ? "這裡底下還沒有東西" : "這條路線還沒有車票"}</p>
          {/* D-主-72：空狀態的新增鈕（路線頂層＝第一班列車；縮放進去＝那一層的預設子種類） */}
          <button type="button" className="ns-btn btn-ghost m2-empty-add" onClick={() => setFirstAdd(firstPlan(openedId, zoom))}>
            {zoom ? `新增${KIND_LABEL[firstPlan(openedId, zoom).kind]}…` : "新增第一班…"}
          </button>
        </div>
      ) : (
        // data-no-fab：每一列右側都是常駐検印／⋯，「記一句」浮鈕停在哪都蓋住某一列的按鈕（第二輪；同時刻表方眼的取捨，
        //   notes-mobile.css〈浮動鈕〉的通用約定）。只掛在樹上：第一層路線清單、空狀態沒有右側按鈕，浮鈕照舊
        <ul className="m2-tree" data-no-fab>
          {rows.map(({ id, depth }) => {
            const node = tree.byId[id];
            const kids = tree.childrenOf[id] ?? EMPTY;
            const hasKids = kids.length > 0;
            const occ = currentOccurrences[id];
            const done = occ ? occ.status === "done" : node.status === "done";
            const suspended = occ?.status === "skipped";
            const open = !collapsed[id];
            const detail = detailId === id;
            const serial = serialOf(serials, id);
            const rule = parseRule(node.repeat_rule);
            const total = descendantCount(tree, id);
            const childDone = total - openDescendantCount(tree, id);

            return (
              <li key={id} className="m2-item">
                <div
                  data-node-id={id}
                  className={
                    "m2-row" + (done ? " is-done" : "") + (suspended ? " is-suspended" : "") + (flashId === id ? " is-reveal" : "")
                  }
                  style={{ paddingLeft: Math.min(depth, INDENT_MAX_DEPTH) * INDENT_STEP }}
                >
                  {hasKids ? (
                    <button
                      type="button"
                      className="m2-caret"
                      aria-expanded={open}
                      aria-label={`${open ? "收合" : "展開"}「${node.name}」`}
                      onClick={() => setCollapsed((c) => ({ ...c, [id]: open }))}
                    >
                      <Chevron open={open} />
                    </button>
                  ) : (
                    <span aria-hidden className="m2-caret is-empty" />
                  )}

                  {/**
                   * 票根徽章＝聚焦（zoom-in）；葉節點沒有下層，徽章就只是徽章。
                   * 觸控目標撐在**外層**那顆 44px 的 .m2-zoom 上，圓圈自己維持 26px——
                   * `.badge` 是 border-radius:50%，把 padding 加在它身上會把圓撐成橢圓。
                   */}
                  {canHaveChildren(node.kind) && hasKids ? (
                    <button
                      type="button"
                      className="m2-zoom"
                      aria-label={`聚焦「${node.name}」（${KIND_LABEL[node.kind]}）`}
                      onClick={() => zoomTo(id)}
                    >
                      <span aria-hidden className={"m2-badge " + badgeClass(node.kind)}>
                        {KIND_GLYPH[node.kind]}
                      </span>
                    </button>
                  ) : (
                    <span aria-hidden className="m2-zoom">
                      <span className={"m2-badge " + badgeClass(node.kind)}>{KIND_GLYPH[node.kind]}</span>
                    </span>
                  )}

                  <button
                    type="button"
                    className="m2-row-body"
                    aria-expanded={detail}
                    onClick={() => setDetailId((cur) => (cur === id ? null : id))}
                  >
                    <span className="m2-name">{node.name}</span>
                    <span className="m2-meta">
                      {KIND_LABEL[node.kind]}
                      {total > 0 ? `・${childDone}/${total}` : ""}
                      {rule ? "・定期券" : ""}
                      {node.scheduled_on ? `・${node.scheduled_on.slice(5)}` : ""}
                    </span>
                    {/* 済／運休在視覺上是右邊那枚角印（aria-hidden）；語意補在這裡，
                        讀屏使用者不必展開詳情才知道這張票交代過了。畫面上不重複印字。 */}
                    {(done || suspended) && <span className="sr-only">{suspended ? "運休" : "済"}</span>}
                  </button>

                  {/**
                   * 検印鈕（D-主-71；常駐）：単擊＝済／取消済／運休中＝取消運休（桌機大綱同一支 completeNodeFlow）。
                   * N9：済＝圓印（定案，同手機今日票卡）；運休＝方角印（運行狀態告示）；未交代＝虛線圓「検印」。
                   */}
                  <button
                    type="button"
                    className="m2-stamp"
                    aria-label={`${suspended ? "取消本班運休" : done ? "取消完成" : "蓋章完成"}——${node.name}`}
                    aria-pressed={done}
                    onClick={() => stamp(id)}
                  >
                    {suspended ? (
                      <span className="m2-seal is-suspended" aria-hidden>
                        運休
                      </span>
                    ) : done ? (
                      <SealDone small fresh={freshId === id} className="m2-seal-done" />
                    ) : (
                      <span className="m2-slot" aria-hidden>
                        検印
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    className="m2-more"
                    aria-label={`更多動作——${node.name}`}
                    aria-haspopup="dialog"
                    onClick={() => setSheetId(id)}
                  >
                    <span aria-hidden>⋯</span>
                  </button>
                </div>

                {detail && <RowDetail node={node} serial={serial} occurrence={occ} />}
              </li>
            );
          })}
        </ul>
      )}

      {/* ⋯ sheet 與空狀態的命名面板（MSheet 自己 portal 到 body；返回層同一個 id） */}
      {renderSheet()}
      {headMenu && route && (
        <MSheet list title={route.name} backId={ROUTEMAP_SHEET_LAYER} onClose={() => setHeadMenu(false)}>
          <MSheetItem
            onClick={() => {
              setHeadMenu(false);
              openDetail(route.id);
            }}
          >
            路線詳情…
          </MSheetItem>
        </MSheet>
      )}
      {firstAdd && (
        <MobileTextSheet
          title={addTitle(firstAdd, false)}
          name={zoom?.name ?? route?.name ?? "路線"}
          initial=""
          placeholder={`${KIND_LABEL[firstAdd.kind]}名稱`}
          submitLabel="新增"
          inputLabel={`新${KIND_LABEL[firstAdd.kind]}的名稱`}
          backId={ROUTEMAP_SHEET_LAYER}
          onSubmit={(name) => {
            const plan = firstAdd;
            setFirstAdd(null);
            void create(plan, name);
          }}
          onClose={() => setFirstAdd(null)}
        />
      )}
    </div>
  );
}
