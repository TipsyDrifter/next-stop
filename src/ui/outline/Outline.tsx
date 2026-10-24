/**
 * Outline——丙式主視圖的主欄（路線大綱）＝攤開的紙頁。票的結構與 class 照抄 prototypes/m1-c-techo.html（CSS 在 styles/techo.css）：
 * .page > .sheet > 頁首 PageHeader ＋ .sec「列車」＋ .ticket-list（OutlineRow／DraftRow 完整車票）＋ .page-foot。
 * 頁首（UI 丙-3 B1，視覺規範 §2.1）＝身分式：眉標 {幹線名, 代碼 Line}（聚焦時換成麵包屑）・大標路線名（聚焦時＝節點名；點大標＝開它的詳情側板）・
 *   補述「路線」・stats「車票 n/N 済・進度 P%・項 M」〔件一 m3-ext-routemap.html 定稿口徑〕・
 *   日付印 76 ＋紀念章 92（下一站；10-24 甲案＝章比印稍大；頁首 <704 時退成 stats 列尾小章）・工具列「＋ 路線 ▾」與搜尋。
 * 已完成的列預設收起，清單底一列「済 N 張 ──── 顯示／收起」（10-24 修訂，取代頁首「隱藏已完成」）。
 * 誤點不再另列頁尾區（B4）：誤點票就在大綱原位蓋延着（OutlineRow），同一張票同一頁只列一次。
 * 鍵盤流掛在容器（tabIndex=0），狀態與流程在 useOutlineController。對應 UI Flow 2.0／2.0a／2.0b／2.0c／2.0d／2.0e。
 * 取捨：列不做虛擬捲動；拖曳排序之後實作（鍵盤 Alt+↑↓ 已有）。
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { KIND_LABEL, type NodeKind, type NodeRow } from "../../domain";
import { flattenSubtrees, routeHeadStats } from "../../domain/routeHead";
import { serialOf, useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";
import { DateSeal, SealDone, StationStamp } from "../stamps";
import { EmptyState } from "../common/EmptyState";
import { EmblemMini, PageHeader } from "../common/PageHeader";
import { PopMenu, hotkeyCaps, type PopMenuItem } from "../common/PopMenu";
import { IconPlus } from "../common/icons";
import { Breadcrumb } from "./Breadcrumb";
import { DraftRow, OutlineRow, type CarStats } from "./OutlineRow";
import { useOutlineController } from "./useOutlineController";
import { useOutlineKeyboard } from "./useOutlineKeyboard";
import "./outline.css";

/** 情境 5：載入 >200ms 才顯示安靜指示，避免閃爍 */
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

/** 頁尾「Day N / 365」 */
function dayOfYear(): { day: number; total: number } {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 1);
  const end = new Date(now.getFullYear() + 1, 0, 1);
  const day = Math.floor((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - start.getTime()) / 86_400_000) + 1;
  const total = Math.round((end.getTime() - start.getTime()) / 86_400_000);
  return { day, total };
}

/** 紀念章的站名：超過 6 字截成 5 字＋…（StationStamp 章內放得下的量） */
function stampName(name: string): string {
  return name.length > 6 ? `${name.slice(0, 5)}…` : name;
}

/** 新增入口的選單上限（視覺規範 §2.4：一層 ≤7 項）＝幹線最多 6 條＋「新增幹線」 */
const ADD_MENU_LINES = 6;

/**
 * 頁首工具列第二格「＋ 路線 ▾」的選單（UI 丙-3 B1）：每條幹線一項「新增路線到「X」」＋虛線＋「新增幹線」；
 * 都走 uiStore.openRouteDialog（＝書封「＋ 路線／＋ 幹線」同一個對話框）。目前路線所屬的幹線排第一；
 * 幹線超過 6 條時只列前 6 條（其餘從書封該幹線底下的「＋ 路線」進）。
 */
function addMenuItems(lines: NodeRow[], currentLineId: string | null): PopMenuItem[] {
  const open = useUiStore.getState().openRouteDialog;
  const ordered = [...lines.filter((l) => l.id === currentLineId), ...lines.filter((l) => l.id !== currentLineId)];
  return [
    ...ordered.slice(0, ADD_MENU_LINES).map(
      (l): PopMenuItem => ({ key: `route:${l.id}`, label: `新增路線到「${l.name}」`, onSelect: () => open({ lineId: l.id, editId: null }) }),
    ),
    { key: "line", label: "新增幹線", cut: lines.length > 0, onSelect: () => open({ lineId: null, editId: null }) },
  ];
}

/** 空狀態的印章輪廓：空的検印框（同樣本頁 EmptyState first） */
const EMPTY_STAMP = (
  <span className="stamp">
    <span className="hint">検印</span>
  </span>
);

/**
 * 沒開路線時的空狀態（磨光⑤ N6；UI 丙-3 B2 換 EmptyState）。App 會自動開第一條路線，所以實際上只在「一條路線都沒有」時看得到——
 * 那時叫人「從左側選一條」是指不到東西的。依側欄資料教第一步：
 *   沒有幹線 ⇒ 先建幹線（＝側欄「＋ 幹線」同一個對話框）；有幹線沒路線 ⇒ 在第一條幹線底下開路線（＝「＋ 路線」）；
 *   有路線但沒選（理論上不會）⇒ 原句。這時沒有頁首（沒有路線可當大標），頁首的「＋ 路線」自然不在——同頁一個入口（§2.7）。
 */
function NoRouteEmpty() {
  const lines = useNodeStore((s) => s.lines);
  const routes = useNodeStore((s) => s.routes);
  const openRouteDialog = useUiStore((s) => s.openRouteDialog);
  if (!lines.length) {
    return (
      <EmptyState
        tone="first"
        stamp={EMPTY_STAMP}
        title="還沒有任何路線"
        desc="先建一條幹線（大方向，例如「學習」），再在底下開路線。"
        action={{ label: "新增幹線", icon: <IconPlus />, onClick: () => openRouteDialog({ lineId: null, editId: null }) }}
      />
    );
  }
  if (!routes.length) {
    const first = lines[0];
    return (
      <EmptyState
        tone="first"
        stamp={EMPTY_STAMP}
        title={lines.length === 1 ? "這條幹線還沒有路線" : "幹線底下還沒有路線"}
        desc={`在「${first.name}」底下開一條路線，就能開始鋪軌。`}
        action={{ label: "新增路線", icon: <IconPlus />, onClick: () => openRouteDialog({ lineId: first.id, editId: null }) }}
      />
    );
  }
  return <EmptyState tone="first" stamp={null} title="選一條路線開始鋪軌" desc="從左側選一條路線，這裡會顯示它的內容。" />;
}

/**
 * 聚焦時麵包屑取代眉標（§5 P2）：PageHeader 的眉標只收 `{zh, latin}`，沒有放節點的插槽——
 * 這裡把 Breadcrumb portal 進它畫好的 `.ns-pagehead-overline`，原本的兩段字由 outline.css 在 `.is-zoomed` 時收掉。
 * 眉標那個 <p> 在 PageHeader 每次重畫時是同一個節點（結構固定），所以只在聚焦開關時重抓。
 */
function useOverlineSlot(on: boolean) {
  const headRef = useRef<HTMLDivElement>(null);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    setSlot(on ? (headRef.current?.querySelector<HTMLElement>(".ns-pagehead-overline") ?? null) : null);
  }, [on]);
  return { headRef, slot };
}

export function Outline() {
  const containerRef = useRef<HTMLDivElement>(null);
  const c = useOutlineController(containerRef);
  const outlineKeys = useOutlineKeyboard(c.keys);
  /** 頁首（PageHeader）裡的鈕現在可以 Tab 到——在它們身上按的鍵不算大綱的導航鍵（例：聚焦在搜尋鈕上按 Delete 不該刪選中的票） */
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.target instanceof Element && e.target.closest(".ns-pagehead")) return;
    outlineKeys(e);
  };
  const toggleHideDone = useUiStore((s) => s.toggleHideDone);
  const setQuickJumpOpen = useUiStore((s) => s.setQuickJumpOpen);
  const stations = useNodeStore((s) => s.stations);
  const serials = useNodeStore((s) => s.serials);
  const lines = useNodeStore((s) => s.lines);
  const showLoading = useDelayedFlag(c.loading, 200);
  const doy = dayOfYear();
  const { headRef, slot: crumbSlot } = useOverlineSlot(!!c.zoom && !!c.routeId);
  const [addAnchor, setAddAnchor] = useState<HTMLElement | null>(null);

  if (!c.routeId) {
    return (
      <section className="page ns-outline" aria-label="路線大綱">
        <div className="sheet">
          <NoRouteEmpty />
          <footer className="page-foot">
            <span>私鐵手帳・路線大綱</span>
            <span className="fr">
              Day {doy.day} / {doy.total}
            </span>
          </footer>
        </div>
      </section>
    );
  }

  const title = c.zoom ? c.zoom.name : (c.route?.name ?? "…");
  const code = c.route?.code ?? null;
  const draft = c.edit?.mode === "draft" ? c.edit : null;
  const hasAnyNode = c.rootChildren.length > 0;
  const accent = c.route?.color ?? undefined;

  /** 路線詳情（10-20 磨光②；global.panel.toggle 的路線版）：清掉選取＋開側板＝DetailPanel 落到路線面板（沒選到節點且有 routeId） */
  // 點大標＝看它的詳情（UI 丙-3 修訂：頁首 ⋯ 拿掉，路線詳情的入口改成點路線名；書封 ✎ 是第二個入口；Ctrl+. 照舊）。
  // 聚焦在某一節時大標是那一節，點了開那一節的側板。
  const openTitlePanel = () => {
    const ui = useUiStore.getState();
    ui.select(c.zoom ? c.zoom.id : null);
    ui.setPanelOpen(true);
    containerRef.current?.focus();
  };

  // 頁首統計＝件一定稿口徑（m3-ext-routemap.html：車票 n/N 済・進度 P%・節點 M）：
  // 進度＝子樹「車票済／總車票」自動彙總；節點＝範圍內全部節點（列車＋車廂＋車票，車站不在樹裡）。
  // 磨光⑤ N12：數字走 domain/routeHead（手機路線圖抬頭同一支）。
  // 定期券的済蓋在「目前班次」上（nodes.status 一路是 todo）——票面看得到済章，頁首就得跟著算（isDoneNode）
  const head = routeHeadStats(flattenSubtrees(c.tree, c.rootChildren), c.isDoneNode);
  const { ticketTotal, ticketDone, items: total } = head;
  const ticketPct = head.pct;
  // 整條路線的進度（車站紀念章的進度弧）
  let routeTotal = 0;
  let routeOpen = 0;
  for (const id of c.tree.roots) {
    const cc = c.counts[id];
    const n = c.tree.byId[id];
    routeTotal += 1 + (cc?.total ?? 0);
    routeOpen += (n?.status === "done" ? 0 : 1) + (cc?.open ?? 0);
  }
  const routePct = Math.round((routeTotal > 0 ? (routeTotal - routeOpen) / routeTotal : 0) * 100);
  // 下一站：這條路線尚未到站的第一個車站
  const nextStation = stations
    .filter((s) => s.parent_id === c.routeId && !s.arrived_on)
    .sort((a, b) => a.position - b.position)[0];

  /** 票號＝store 的 serials 表（當日全域發券序；大綱票根／側板票頭／今日列同一枚號碼） */
  const serial = (node: NodeRow): string => serialOf(serials, node.id);
  /** 車廂格＝直屬子項進度；格子名稱依子項種類（全是車票→車票；有車廂→車廂；支線底下→列車） */
  const carsOf = (id: string, kind: NodeKind): CarStats | null => {
    const kids = c.tree.childrenOf[id] ?? [];
    if (!kids.length) return null;
    let done = 0;
    let hasCar = false;
    let allTicket = true;
    for (const k of kids) {
      const n = c.tree.byId[k];
      if (!n) continue;
      if (n.status === "done") done++;
      if (n.kind === "car") hasCar = true;
      if (n.kind !== "ticket") allTicket = false;
    }
    const label = allTicket ? "車票" : hasCar ? "車廂" : kind === "branch" ? "列車" : "車廂";
    return { total: kids.length, done, label };
  };

  // 空狀態（B2：EmptyState 三種；載入中不判斷，§1.8）。這裡頁首的「＋ 路線」照留：空的是列車不是路線，同頁沒有兩個同一動作的入口
  let empty: ReactNode = null;
  if (c.rows.length === 0 && !draft && !c.loading) {
    if (!hasAnyNode && c.zoom) {
      empty = (
        <EmptyState
          tone="first"
          stamp={EMPTY_STAMP}
          title={`「${c.zoom.name}」底下還沒有內容`}
          desc={`按 Enter 在這${KIND_LABEL[c.zoom.kind]}底下新增第一筆；Esc 回上一層。`}
          action={{ label: "新增第一筆", icon: <IconPlus />, onClick: c.startFirstDraft }}
        />
      );
    } else if (!hasAnyNode) {
      empty = (
        <EmptyState
          tone="first"
          stamp={EMPTY_STAMP}
          title="這條路線還沒有列車"
          desc="按 Enter 新增第一班列車，底下可再細分車廂與車票。"
          action={{ label: "新增列車", icon: <IconPlus />, onClick: c.startFirstDraft }}
        />
      );
    } else {
      empty = (
        <EmptyState
          tone="done"
          stamp={<SealDone />}
          title="已完成的班次都收起來了"
          desc="打開就能看到它們。"
          secondary={{ label: "顯示已完成", onClick: toggleHideDone }}
        />
      );
    }
  }

  // ── 頁首（UI 丙-3 B1：PageHeader 身分式；§5 P1＝A 紀念章、P2＝大標旁 ⋯ 與聚焦麵包屑） ──
  const [ty, tm, td] = c.today.split("-").map(Number);
  const todayDate = new Date(ty, tm - 1, td);
  const stats =
    total > 0 ? (
      <>
        {/* 每段不在段內折行（窄頁首時只在段與段之間換行，例「項 15」不會斷開） */}
        {ticketTotal > 0 && (
          <>
            <span className="stat-part">車票 <b>{ticketDone}/{ticketTotal}</b> 済</span>
            <span className="dot">・</span>
            <span className="stat-part">進度 <b>{ticketPct}%</b></span>
            <span className="dot">・</span>
          </>
        )}
        <span className="stat-part">項 <b>{total}</b></span>
      </>
    ) : undefined;
  const emblem = nextStation ? (
    <StationStamp
      size={92}
      arcLabel={`${code ? `${code} LINE · ` : ""}NEXT STATION`}
      caption="下一站"
      name={stampName(nextStation.name)}
      percent={routePct}
      statusText="進行中"
      title={`下一站 ${nextStation.name}，進度 ${routePct}%`}
    />
  ) : undefined;
  const emblemCompact = nextStation ? (
    <span title={`下一站 ${nextStation.name}，進度 ${routePct}%`}>
      <EmblemMini percent={routePct} />
      下一站 <b>{stampName(nextStation.name)}</b> {routePct}%
    </span>
  ) : undefined;

  return (
    <section ref={containerRef} tabIndex={0} onKeyDown={onKeyDown} aria-label="路線大綱" className="page ns-outline">
      <div className="sheet">
        <div ref={headRef} className="ns-outline-head">
          <PageHeader
            variant="identity"
            className={c.zoom ? "is-zoomed" : undefined}
            overline={{ zh: c.line?.name ?? "路線圖", latin: code ? `${code} Line` : "Route Map" }}
            title={
              <button
                type="button"
                className="ns-outline-titlebtn"
                title={`${c.zoom ? `${KIND_LABEL[c.zoom.kind]}詳情` : "路線詳情"}（${hotkeyCaps("global.panel.toggle")}）`}
                onClick={openTitlePanel}
              >
                {title}
              </button>
            }
            aside={<span>{c.zoom ? KIND_LABEL[c.zoom.kind] : "路線"}</span>}
            stats={stats}
            stamp={<DateSeal date={todayDate} size={76} title={`日付印 ${c.today}`} />}
            emblem={emblem}
            emblemCompact={emblemCompact}
            add={{
              label: "路線",
              haspopup: true,
              title: "新增路線或幹線",
              onClick: (e) => {
                const el = e.currentTarget;
                setAddAnchor((cur) => (cur ? null : el));
              },
            }}
            search={{ onOpen: () => setQuickJumpOpen(true), title: `搜尋・跳轉（${hotkeyCaps("global.quickjump")}）` }}
          />
        </div>
        {crumbSlot && createPortal(<Breadcrumb items={c.crumbs} onJump={c.zoomTo} />, crumbSlot)}
        {addAnchor && (
          <PopMenu
            anchor={addAnchor}
            overline={{ zh: "新增", latin: "New" }}
            label="新增路線或幹線"
            items={addMenuItems(lines, c.route?.line_id ?? null)}
            onClose={() => setAddAnchor(null)}
          />
        )}

        {showLoading && c.rows.length === 0 && (
          <div className="sec">
            <span className="rule" />
            <span className="note">讀取中…</span>
          </div>
        )}

        {empty ?? (
          <>
            <div className="sec">
              <h3>列車</h3>
              <span className="rule" />
              <span className="note">發券 {total} 張</span>
            </div>
            <ul role="tree" aria-label={`${title} 的大綱`} className="ticket-list">
              {c.rows.map((r) => {
                if (r.type === "draft") {
                  if (!draft || !c.draftHandlers) return null;
                  return (
                    <DraftRow key={`draft:${draft.parentId}:${draft.afterId ?? "$end"}`} depth={r.depth} kind={draft.kind} accent={accent} handlers={c.draftHandlers} />
                  );
                }
                const node = c.tree.byId[r.id];
                if (!node) return null;
                const renaming = c.edit?.mode === "rename" && c.edit.id === r.id ? c.renameHandlers : null;
                return (
                  <OutlineRow
                    key={r.id}
                    node={node}
                    depth={r.depth}
                    hasChildren={(c.tree.childrenOf[r.id]?.length ?? 0) > 0}
                    collapsed={!!c.collapsed[r.id]}
                    selected={c.selectedId === r.id}
                    fresh={c.freshId === r.id}
                    today={c.today}
                    cars={carsOf(r.id, node.kind)}
                    accent={accent}
                    serial={serial(node)}
                    occurrence={c.currentOccurrences[r.id] ?? null}
                    rename={renaming}
                    actions={c.row}
                    onFreshEnd={c.clearFresh}
                    menu={() => c.menuFor(r.id)}
                  />
                );
              })}
            </ul>
            {c.doneHidden + c.doneShown > 0 && (
              <button
                type="button"
                className="ns-outline-fold"
                aria-expanded={!c.hideDone}
                onClick={() => {
                  toggleHideDone();
                  containerRef.current?.focus();
                }}
              >
                <span>済 {c.hideDone ? c.doneHidden : c.doneShown} 張</span>
                <span className="rule" aria-hidden="true" />
                <span className="act">{c.hideDone ? "顯示" : "收起"}</span>
              </button>
            )}
          </>
        )}

        <footer className="page-foot">
          <span>私鐵手帳・{c.route?.name ?? "路線大綱"}</span>
          <span className="fr">
            Day {doy.day} / {doy.total}
          </span>
        </footer>
      </div>
    </section>
  );
}
