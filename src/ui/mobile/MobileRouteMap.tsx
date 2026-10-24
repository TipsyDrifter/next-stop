/**
 * MobileRouteMap——路線圖唯讀手機版（v1.1.0「手機殼可用」；WP2 席）。
 *
 * 拍板依據：決策記錄〈v1.1 Plan 草案拍板〉D-1.1-2「路線圖手機版**唯讀**——看得到、點得開、改不了」
 *   ＋《2026-09-16-v1.1.0-手機殼契約.md》§2.8（資料來源與不可呼叫清單）。
 *
 * 兩層：
 *   第一層＝我的路線清單（nodeStore.lines／routes；每列＝色帶＋roundel＋路線名）。
 *     **不顯示每條路線的進度**：store 只持有「當前開啟那一條」的樹，逐條算要嘛得載完所有路線、
 *     要嘛得叫 `nodeRepo.routeProgress`（UI 不碰 repository 的紀律）——契約 §2.8 明寫「v1.1.0 不用，
 *     否則略」。進度改在第二層的路線抬頭給（那裡的樹已經在手上）。
 *   第二層＝該路線的樹（nodeStore.tree：byId／childrenOf／roots）以縮排清單呈現，
 *     可 zoom-in 到子樹、麵包屑回溯（「我的路線 › 路線名 › 祖先 › 目前」全段可點）。
 *
 * **找不到任何可編輯入口**（鐵則／D-1.1-2）：無 inline input、無長按選單、無拖曳；
 *   本檔一支 mutation 都不 import——只呼叫 `openRoute`（載入用，不改資料）。
 *   v1.1.2 補一段：唯讀詳情底下印該票的**競合**列（同步衝突的敗方值；D-1.1-5）——手機沒有側板，
 *   這裡是這張票唯一看得到事件簿的地方。只讀不寫，鐵則不破。
 *   接縫 #56：詳情欄位表之後渲染別線登記的 `nodeFields` 的 `Mobile` 列（旅客筆記的「荷札」可掛可摘，D-筆-42）；
 *   寫入在線自己的元件裡，本檔仍不 import mutation；沒有任何一線登記＝DOM 與文案照舊。
 *   接縫 #63：第一層每條路線列尾（`.m2-route-name` 之後、`.m2-route-go` 之前）渲染別線登記的 `routeListAside`（小字）；
 *   元件在 `button` 裡面，只能回 span／純文字、不得放可點的東西；沒有任何一線登記＝DOM 照舊。
 *   點車票也不開側板（手機 v1.1.0 無側板），改在該列下方展開一段**唯讀詳情**
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
import { useEffect, useMemo, useRef, useState } from "react";
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
import { Chevron } from "../common/Chevron";
import { lineNodeFields, lineRouteListAsides } from "../../lines/runtime";
// 票根徽章與票種的算法沿大綱（只讀 import，顯示端不手抄一份規則；OutlineRow 的這三支是純函式／常數）
import { KIND_GLYPH, badgeClass, fareClass } from "../outline/OutlineRow";
import { SealDone } from "../stamps";
import { useBackLayer } from "./backStack";
import { useRevealStore } from "./routeMapReveal";
import "./mobile-quickjump.css";

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

function RouteList({ onOpen }: { onOpen: (id: string) => void }) {
  const lines = useNodeStore((s) => s.lines);
  const routes = useNodeStore((s) => s.routes);
  // 接縫 #63：路線列尾的別線小字；沒有任何線填值＝空陣列＝DOM 不變
  const asides = lineRouteListAsides();

  if (!lines.length) {
    return (
      <div className="m2-empty">
        <p className="m2-empty-title">還沒有任何路線</p>
        <p className="m2-empty-body">請先到電腦版新增路線與幹線。</p>
      </div>
    );
  }

  return (
    <div className="m2-lines">
      {lines.map((line) => {
        const lineRoutes = routes.filter((r) => r.line_id === line.id);
        return (
          <section key={line.id} aria-label={`幹線 ${line.name}`}>
            <p className="m2-trunk">幹線・{line.name}</p>
            {lineRoutes.length === 0 ? (
              <p className="m2-note">這條幹線底下還沒有路線</p>
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
    </div>
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
   * 手機沒有側板，這段唯讀詳情就是這張票唯一的「事件簿」——不在這裡印，主人在手機上就永遠
   * 看不到「我打的字被另一台換掉了，舊值還在」。**只印競合列**：手記與発券／入鋏／済 是桌機側板的事，
   * 手機版路線圖是唯讀的摘要，不該變成第二個日誌畫面。
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
     * 手機沒有検印欄（唯讀），就把同一件事寫成一行字。
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
  // 別線登記的可寫欄位（例：旅客筆記的「荷札」，D-筆-42）；沒有任何一線登記＝空、文案與 DOM 照舊
  const lineFields = lineNodeFields("mobile").filter((f) => f.Mobile && f.kinds.includes(node.kind));
  const editable = lineFields.map((f) => f.label);

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
      <p className="m2-note">
        {editable.length > 0
          ? `手機版路線圖只能改${editable.join("、")}，其他請到電腦版修改。`
          : "手機版路線圖僅供檢視，要修改請到電腦版。"}
      </p>
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

  const route = openedId ? routes.find((r) => r.id === openedId) : undefined;
  const line = route ? lines.find((l) => l.id === route.line_id) : undefined;
  /** 樹是「store 目前開著的那條路線」的；換路線的載入完成前不能拿來畫（會畫到上一條的樹） */
  const treeReady = openedId !== null && storeRouteId === openedId;
  const showLoading = useDelayedFlag(openedId !== null && (loading || !treeReady), 200);

  // 路線被刪掉／側欄重載後不見了：退回第一層，不留在一個沒有主體的第二層
  useEffect(() => {
    if (openedId && routes.length && !routes.some((r) => r.id === openedId)) setOpenedId(null);
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

  // 等那一列真的畫出來再捲（展開祖先與詳情是同一批 state，下一次 commit 才有那一列）
  useEffect(() => {
    if (!scrollId || !rows.some((r) => r.id === scrollId)) return;
    const el = pageRef.current?.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(scrollId)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    setScrollId(null);
    setFlashId(scrollId);
  }, [scrollId, rows]);

  useEffect(() => {
    if (!flashId) return;
    const t = setTimeout(() => setFlashId(null), REVEAL_FLASH_MS);
    return () => clearTimeout(t);
  }, [flashId]);

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
        <header className="m2-head">
          <h2 className="m2-head-title">{route?.name ?? "路線"}</h2>
          <p className="m2-head-sub">
            {line ? `幹線・${line.name}` : ""}
            {stat && stat.ticketTotal > 0 ? `${line ? "・" : ""}${routeHeadTicketText(stat)}` : ""}
          </p>
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
          <p className="m2-empty-body">這一頁只能看，請到電腦版新增。</p>
        </div>
      ) : (
        <ul className="m2-tree">
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

                  {/* N9：済＝圓印（定案，同手機今日票卡）；運休＝方角印（運行狀態告示） */}
                  {suspended ? (
                    <span className="m2-seal is-suspended" aria-hidden>
                      運休
                    </span>
                  ) : done ? (
                    <SealDone small className="m2-seal-done" />
                  ) : null}
                </div>

                {detail && <RowDetail node={node} serial={serial} occurrence={occ} />}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
