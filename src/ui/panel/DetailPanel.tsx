/**
 * 詳情側板容器（UI Flow 2.1 · D1）：uiStore.panelOpen 才掛載；右側 --panel-w（件一 340px）＝「攤開的一張大票」，
 * 從右滑入（@starting-style）；內容路由：selectedId 在 tree.byId → 節點面板；否則有 routeId → 路線面板；否則「選一個節點」
 * ——但只在今日／路線圖／行程表三頁畫空板與路線面板，其他頁（旅客筆記等）沒選到節點就收起（display:none）、panelOpen 不動（10-20 磨光② A12，D-主-38 乙）。
 * Esc（面板內聚焦、且欄位草稿乾淨）收回；關閉叉＝件一票頭的常駐控件（.panel-close，② 換裝後不再 hover 才現身）。
 * 視覺＝原型語彙 1:1（版面在 panel.css）。M3 ② 主題換裝移植後，側板語彙改吃「攤開的一張大票」
 * （prototypes/m3-ext-routemap.html 的側板區）：標題＝Noto Serif TC 襯線文件級（19px／.05em／1.4）、
 * 工作日誌區＝乘務記錄樣式（時刻戳＋手寫內文）——兩者的覆寫都在 src/styles/stamps.css（本席自己的檔＋權重），
 * 不動 techo.css／panel.css。側板「紙面／材質」本身屬 E2 視覺層，本席不碰。
 * import "../stamps" 一併帶進朱肉 defs（#inkbleed／#inkbleed-fine）與印章家族樣式。
 * 已知取捨：開啟時把焦點移進面板（鍵盤流 `.` 開板後 Tab 就能進欄位），關閉時若焦點無處可去則還給開板前的元素；
 * 以 flex 子項佔位（父層須為 flex row，例如緊接在大綱 <main> 之後）。
 */
import { useEffect, useState } from "react";
import type { NodeRow } from "../../domain";
import { nodeRepo } from "../../data";
import { useNodeStore } from "../../store/nodeStore";
import { useUiStore, type PageId } from "../../store/uiStore";
import { NodePanel } from "./TaskFields";
import { RoutePanel } from "./RoutePanel";
import "./panel.css";
import "../stamps";
// 外框（焦點進出、Esc、關閉叉）丙-5 搬到 common/SidePanelFrame（售票口大票同殼；panel.css 仍由本檔載入）
import { SidePanelFrame } from "../common/SidePanelFrame";

export function DetailPanel() {
  const panelOpen = useUiStore((s) => s.panelOpen);
  if (!panelOpen) return null;
  return <PanelShell />;
}

function PanelShell() {
  const setPanelOpen = useUiStore((s) => s.setPanelOpen);
  const selectedId = useUiStore((s) => s.selectedId);
  // 今日視圖的列多半不在當前路線樹裡：tree 找不到就找 today（M3 ③ WP1 接縫）
  const sliced = useNodeStore((s) => (selectedId ? (s.tree.byId[selectedId] ?? s.today.byId[selectedId]) : undefined));
  // 兩片切片都撈不到就直接問 repository（M3 ④ 整合席）：從今日開板的臨時車票一旦掛上規則、
  // 班次被推出今天，它就同時不在 today 切片也不在當前路線樹裡，側板不該當場變「選一個節點」。
  // tree／today／currentOccurrences 每次 reload 都換物件 → 當成版本號，補撈的那份跟著刷新，不會留舊值。
  const tree = useNodeStore((s) => s.tree);
  const today = useNodeStore((s) => s.today);
  const occ = useNodeStore((s) => s.currentOccurrences);
  const [fetched, setFetched] = useState<NodeRow | null>(null);
  useEffect(() => {
    if (!selectedId || sliced) {
      setFetched(null);
      return;
    }
    let alive = true;
    void nodeRepo
      .getNode(selectedId)
      .then((n) => {
        if (alive) setFetched(n && !n.deleted_at ? n : null);
      })
      .catch(() => {
        if (alive) setFetched(null);
      });
    return () => {
      alive = false;
    };
  }, [selectedId, sliced, tree, today, occ]);
  const node = sliced ?? (fetched && fetched.id === selectedId ? fetched : undefined);
  const route = useNodeStore((s) => (s.routeId ? s.routes.find((r) => r.id === s.routeId) : undefined));
  const page = useUiStore((s) => s.page);

  // 10-20 磨光② A12：panelOpen 是全域狀態；在沒有節點可選的頁（旅客筆記、時刻表、售票口——它們各有自己的側板）
  // 又沒有東西可攤開時，不畫那塊「選一個節點」空板。只收畫面、不改 panelOpen：回到今日／路線圖／行程表照舊開著。
  // 有節點（例如從筆記荷札跳過來）照畫；路線面板在這些頁也收（D-主-38 乙：路線跟這頁無關，選到節點才有東西可攤開）。
  // 用 display:none 收而不是 return null：外框保持掛載，回到今日頁時不會重掛、不會把焦點從頁面搶進側板。
  const hidden = !node && !NODE_PAGES.has(page);

  return (
    <SidePanelFrame hidden={hidden} onClose={() => setPanelOpen(false)}>
      {node ? (
        <NodePanel key={node.id} node={node} />
      ) : route ? (
        <RoutePanel key={route.id} route={route} />
      ) : (
        <EmptyHint />
      )}
    </SidePanelFrame>
  );
}

/** 有節點可選的頁（側板的 EmptyHint「在大綱裡選中…」只對這三頁有意義） */
const NODE_PAGES: ReadonlySet<PageId> = new Set<PageId>(["today", "routemap", "calendar"]);

function EmptyHint() {
  return (
    <div className="blank">
      <div>
        <h3>選一個項目</h3>
        <p>
          點選列車或車票，
          <br />
          這裡會顯示詳細內容。
        </p>
      </div>
    </div>
  );
}
