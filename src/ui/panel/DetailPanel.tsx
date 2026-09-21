/**
 * 詳情側板容器（UI Flow 2.1 · D1）：uiStore.panelOpen 才掛載；右側 --panel-w（件一 340px）＝「攤開的一張大票」，
 * 從右滑入（@starting-style）；內容路由：selectedId 在 tree.byId → 節點面板；否則有 routeId → 路線面板；否則「選一個節點」。
 * Esc（面板內聚焦、且欄位草稿乾淨）收回；關閉叉＝件一票頭的常駐控件（.panel-close，② 換裝後不再 hover 才現身）。
 * 視覺＝原型語彙 1:1（版面在 panel.css）。M3 ② 主題換裝移植後，側板語彙改吃「攤開的一張大票」
 * （prototypes/m3-ext-routemap.html 的側板區）：標題＝Noto Serif TC 襯線文件級（19px／.05em／1.4）、
 * 工作日誌區＝乘務記錄樣式（時刻戳＋手寫內文）——兩者的覆寫都在 src/styles/stamps.css（本席自己的檔＋權重），
 * 不動 techo.css／panel.css。側板「紙面／材質」本身屬 E2 視覺層，本席不碰。
 * import "../stamps" 一併帶進朱肉 defs（#inkbleed／#inkbleed-fine）與印章家族樣式。
 * 已知取捨：開啟時把焦點移進面板（鍵盤流 `.` 開板後 Tab 就能進欄位），關閉時若焦點無處可去則還給開板前的元素；
 * 以 flex 子項佔位（父層須為 flex row，例如緊接在大綱 <main> 之後）。
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { NodeRow } from "../../domain";
import { nodeRepo } from "../../data";
import { useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";
import { XIcon } from "./fields";
import { NodePanel } from "./TaskFields";
import { RoutePanel } from "./RoutePanel";
import "./panel.css";
import "../stamps";

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

  const ref = useRef<HTMLElement>(null);
  const prevFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!prevFocus.current && document.activeElement instanceof HTMLElement) prevFocus.current = document.activeElement;
    ref.current?.focus({ preventScroll: true });
    return () => {
      const prev = prevFocus.current;
      const active = document.activeElement;
      if (prev && prev.isConnected && (active === null || active === document.body)) prev.focus({ preventScroll: true });
    };
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setPanelOpen(false);
    }
  };

  return (
    <aside ref={ref} tabIndex={-1} role="complementary" aria-label="詳情側板" onKeyDown={onKeyDown} className="panel">
      <div className="panel-sheet">
        <button
          type="button"
          aria-label="關閉詳情側板"
          title="關閉（Esc）"
          onClick={() => setPanelOpen(false)}
          className="panel-close"
        >
          <XIcon size={14} />
        </button>
        <div className="panel-scroll">
          {node ? (
            <NodePanel key={node.id} node={node} />
          ) : route ? (
            <RoutePanel key={route.id} route={route} />
          ) : (
            <EmptyHint />
          )}
        </div>
      </div>
    </aside>
  );
}

function EmptyHint() {
  return (
    <div className="blank">
      <div>
        <h3>選一個節點</h3>
        <p>
          在大綱裡選中列車或車票，
          <br />
          這裡會攤開它的欄位。
        </p>
      </div>
    </div>
  );
}
