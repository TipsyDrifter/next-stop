/**
 * StationCard——車站小卡（方針擴充 辛 §3 #6～#7、§7；原型場景 shared-station）。桌機＝錨在入口旁的不透明浮層，手機＝底部面板；內容兩殼同一份：
 *   眉標「車站」・站名・「路線名・預定 12/6（日）・還有 32 天」→ 方針句（蓋済、排成車票、已排數字）→ 底部「帶到下一站」「回顧」「改方針」「蓋到站章／取消到站」。
 * 沒方針＝一行「還沒寫這一站的方針」＋「寫方針」。最後一站（或沒句子要帶）「帶到下一站」灰掉，底下一行說明（觸控沒有 hover，不能只靠 title）。
 *
 * 入口各自用 `useStationCard()` 掛（本地 state，不開全域 host、不動集中檔）。回顧畫在小卡裡（`ReviewList`），
 *   store 記 `inCard`，同頁的告示不會跟著換成回顧表。寫方針框：小卡自己也掛一個 host（路線頁沒有告示要靠它），
 *   同頁有好幾個 host 時只有排第一的畫（WeekAimsEditorHost）；框開著時小卡收起來、host 留著，框關了小卡回來，看得到剛改的。
 * 車站被刪（§3 #16）＝小卡自己關；方針列還在資料庫，復原就回來。
 * 桌機關法：Esc、點小卡外面（toast、日期挑選器、入口本身不算外面）；手機走 MSheet（返回鍵、下滑、暗幕）。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { aimNumeral, aimsBrief, aimsOfKey, nextStationsOfRoutes, stationCardSub, stationKeyOf, type WeekAimRow } from "../../domain/weekAims";
import { compareSiblings } from "../../domain/nodeOrder";
import type { NodeRow } from "../../domain";
import { useNodeStore } from "../../store/nodeStore";
import { useWeekAimStore } from "../../store/weekAimStore";
import { useDialogFocus } from "../common/DialogShell";
import { IconBack } from "../common/icons";
import { MSheet } from "../common/MSheet";
import { useShell } from "../mobile/useShell";
import { toggleStationArrived } from "../panel/routeFlows";
import { PlanSheet } from "./MobileAimsLine";
import { AimStamp, PlanLine, RouteTag, aimPlacePath } from "./parts";
import { PlanTicketPop } from "./PlanTicketPop";
import { useAimView } from "./useWeekAims";
import { NO_NEXT_HINT, ReviewList, useReviewData } from "./WeekAimsReview";
import { WeekAimsEditorHost } from "./WeekAimsEditor";
import "./weekAims.css";

export interface StationCardProps {
  stationId: string;
  /** 桌機浮層錨在這個元素旁；省略＝靠頁面上方置中 */
  anchor?: HTMLElement | null;
  onClose(): void;
  /** >0＝切到回顧；每次要開就換一個數字（到站提示按了「回顧」） */
  reviewTick?: number;
  /** 小卡裡蓋到站章的提示按了「回顧」：回到入口，連小卡已經關了也打得開 */
  onAskReview?: () => void;
}

const CARD_W = 430;
const EDGE = 12;
const GAP = 8;
const EMPTY: WeekAimRow[] = [];

export function StationCard({ stationId, anchor, onClose, reviewTick = 0, onAskReview }: StationCardProps) {
  const mobile = useShell() === "mobile";
  const key = stationKeyOf(stationId);
  const v = useAimView(key);
  const station = useNodeStore((s) => s.stations.find((x) => x.id === stationId) ?? null);
  const route = useNodeStore((s) => (station ? (s.routes.find((r) => r.id === station.parent_id) ?? null) : null));
  const editing = useWeekAimStore((s) => s.editor !== null);
  const [review, setReview] = useState(reviewTick > 0);
  const [planFor, setPlanFor] = useState<string | null>(null);
  const d = useReviewData(key);
  const st = useWeekAimStore.getState;

  useEffect(() => {
    if (reviewTick > 0) setReview(true);
  }, [reviewTick]);

  // 回顧的數字走 store；只收小卡自己開的那張
  useEffect(() => {
    if (!review) return;
    void st().openReview(key, { inCard: true });
    return () => {
      const cur = st().review;
      if (cur?.inCard && cur.weekOn === key) void st().closeReview();
    };
  }, [review, key, st]);

  // 車站不見了（刪掉、同步收到刪除）：關（§3 #16）
  useEffect(() => {
    if (!station) onClose();
  }, [station, onClose]);

  if (!station) return null;

  const host = <WeekAimsEditorHost today={v.today} weekStart={v.weekStart} />;
  if (v.loading || editing) return host;

  const planAim = planFor ? v.aims.find((a) => a.id === planFor) : undefined;
  if (mobile && planAim) {
    return (
      <>
        <PlanSheet aim={planAim} aimKey={key} today={v.today} onClose={() => setPlanFor(null)} />
        {host}
      </>
    );
  }

  const arrived = station.arrived_on !== null;
  const empty = v.aims.length === 0;
  const sub = stationCardSub(station, route?.name, v.today);
  const carry = () => {
    if (d.next) st().openEditor(d.next, d.toCarry);
  };
  const carryWhy = d.next === null ? NO_NEXT_HINT : d.toCarry.length === 0 ? "都済了或帶過了，沒有句子要帶" : undefined;
  const sm = mobile ? "ns-btn" : "ns-btn ns-btn--sm";

  const rows = mobile ? (
    <div className="wa-sc-mlist">
      {v.aims.map((a, i) => {
        const place = v.placeOf(a.node_id);
        return (
          <div key={a.id} className={"wa-mrow" + (a.done_at ? " is-done" : "")}>
            <span className="wa-num">{aimNumeral(i)}</span>
            <div>
              <p className="wa-text">
                <span className="t">{a.text}</span>
                {place && <RouteTag place={place} shell="mobile" onGo={onClose} />}
              </p>
              <PlanLine aim={a} count={v.countOf(a)} />
              {a.done_at === null && (
                <div className="act">
                  <button type="button" className="ns-btn btn-ghost ns-btn--sm" onClick={() => setPlanFor(a.id)}>
                    排成車票
                  </button>
                </div>
              )}
            </div>
            <AimStamp aim={a} />
          </div>
        );
      })}
    </div>
  ) : (
    <ol className="wa-list">
      {v.aims.map((a, i) => {
        const place = v.placeOf(a.node_id) ?? null;
        return (
          <li key={a.id} className={"wa-row" + (a.done_at ? " is-done" : "")}>
            <span className="wa-num" aria-hidden>
              {aimNumeral(i)}
            </span>
            <div className="wa-main">
              <p className="wa-text">
                <span className="t" title={a.text}>
                  {a.text}
                </span>
                {place && <RouteTag place={place} shell="desktop" onGo={onClose} />}
              </p>
              <PlanLine aim={a} count={v.countOf(a)} />
            </div>
            {a.done_at === null ? (
              <button
                type="button"
                className={"ns-btn btn-text ns-btn--sm wa-plan" + (planFor === a.id ? " is-open" : "")}
                aria-haspopup="dialog"
                aria-expanded={planFor === a.id}
                title={place ? `在「${aimPlacePath(place)}」建一張這一站的車票` : route ? `在「${route.name}」建一張這一站的車票` : "建一張這一站的臨時車票"}
                onClick={() => setPlanFor(planFor === a.id ? null : a.id)}
              >
                排成車票
              </button>
            ) : (
              <span />
            )}
            <AimStamp aim={a} />
            {planFor === a.id && <PlanTicketPop aim={a} weekOn={key} today={v.today} onClose={() => setPlanFor(null)} />}
          </li>
        );
      })}
    </ol>
  );

  const arriveBtn = (
    <button
      type="button"
      className={sm + " btn-ghost"}
      aria-pressed={arrived}
      onClick={() => toggleStationArrived(station, { onReview: onAskReview ?? (() => setReview(true)) })}
    >
      {arrived ? "取消到站" : "蓋到站章"}
    </button>
  );

  const foot = empty ? (
    <>
      <button type="button" className={sm + " btn-ghost"} aria-haspopup="dialog" onClick={() => st().openEditor(key)}>
        寫方針
      </button>
      {arriveBtn}
    </>
  ) : (
    <>
      <button type="button" className={sm + " btn-text"} aria-haspopup="dialog" disabled={carryWhy !== undefined} title={carryWhy} onClick={carry}>
        帶到下一站
      </button>
      <button type="button" className={sm + " btn-text"} onClick={() => setReview(true)}>
        回顧
      </button>
      <button type="button" className={sm + " btn-ghost"} aria-haspopup="dialog" onClick={() => st().openEditor(key)}>
        改方針
      </button>
      {arriveBtn}
    </>
  );

  const reviewBody = (
    <ReviewList
      aimKey={key}
      today={v.today}
      weekStart={v.weekStart}
      placeOf={v.placeOf}
      shell={mobile ? "mobile" : "desktop"}
      onGo={onClose}
      onCarry={(next, toCarry) => {
        setReview(false);
        st().openEditor(next, toCarry);
      }}
    />
  );

  const body = (
    <>
      {empty ? <p className="wa-sc-empty">還沒寫這一站的方針</p> : rows}
      {!empty && carryWhy && <p className="wa-sc-hint">{carryWhy}</p>}
    </>
  );

  if (mobile) {
    return (
      <>
        <MSheet
          title={review ? `回顧 ${station.name}` : station.name}
          overline="車站"
          className="wa-ms wa-sc-ms"
          height="auto"
          onClose={review ? () => setReview(false) : onClose}
          foot={
            review ? (
              <button type="button" className="ns-btn btn-ghost" onClick={() => setReview(false)}>
                回到車站
              </button>
            ) : (
              foot
            )
          }
        >
          <p className="wa-sc-sub">{sub}</p>
          {review ? reviewBody : body}
        </MSheet>
        {host}
      </>
    );
  }

  return (
    <>
      <DesktopShell anchor={anchor} planOpen={planFor !== null} onClose={onClose} label={`車站 ${station.name}`} isReview={review}>
        <div className="wa-sc-eyebrow">車站</div>
        <h4 className="wa-sc-name">{station.name}</h4>
        <p className="wa-sc-sub">{sub}</p>
        {review ? (
          <>
            <div className="wa-sc-back">
              <button type="button" className="ns-btn btn-text ns-btn--sm" onClick={() => setReview(false)}>
                <IconBack />
                回到車站
              </button>
              <span className="wa-sc-backt">回顧</span>
            </div>
            {reviewBody}
          </>
        ) : (
          <>
            {body}
            <div className="wa-sc-foot">{foot}</div>
          </>
        )}
      </DesktopShell>
      {host}
    </>
  );
}

/** 桌機的殼：畫到 body、錨在入口旁、放不下就往上開；排成車票的小浮層伸出卡外時整張往上讓 */
function DesktopShell({
  anchor,
  planOpen,
  isReview,
  label,
  onClose,
  children,
}: {
  anchor?: HTMLElement | null;
  planOpen: boolean;
  isReview: boolean;
  label: string;
  onClose(): void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref as RefObject<HTMLElement | null>);
  useAnchoredPlacement(ref, anchor, planOpen);

  // 點外面＝關；Esc 焦點不在卡上時也要關得掉（點過 toast、焦點掉回頁面）
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (!t || ref.current?.contains(t) || anchor?.contains(t)) return;
      if (t.closest?.(".ns-toast, .ns-datepick, .ns-datepicker, .ns-msheet-layer, .techo-veil")) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
      if (document.querySelector(".techo-veil")) return; // 確認框這類疊在上面的先收
      e.preventDefault();
      onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div
      ref={ref}
      className={"techo-card wa-sc" + (isReview ? " is-review" : "")}
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      // 畫到 body 了，React 事件還是會冒回入口所在的頁面（路線卡的點擊、今日與大綱的鍵盤表）：這裡截住；
      // mousedown 不截，window 上的「點外面」（排成車票小浮層、這張卡）要聽得到
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape" && !e.defaultPrevented && !e.nativeEvent.isComposing && e.keyCode !== 229) {
          e.preventDefault();
          onClose();
        }
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

/** 擺位：優先貼入口正下方；入口在右半邊就右緣對齊；下面放不下就翻到上面；內容、視窗、捲動一變就重算 */
function useAnchoredPlacement(ref: RefObject<HTMLDivElement | null>, anchor: HTMLElement | null | undefined, planOpen: boolean) {
  const place = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = Math.min(CARD_W, vw - EDGE * 2);
    const box = el.getBoundingClientRect();
    const pop = el.querySelector(".wa-pop");
    const h = Math.max(box.height, pop ? pop.getBoundingClientRect().bottom - box.top : 0);
    let left: number;
    let top: number;
    if (anchor?.isConnected) {
      const a = anchor.getBoundingClientRect();
      left = a.left + w > vw - EDGE ? a.right - w : a.left;
      top = a.bottom + GAP;
      if (top + h > vh - EDGE) top = a.top - GAP - h >= EDGE ? a.top - GAP - h : vh - EDGE - h;
    } else {
      left = (vw - w) / 2;
      top = Math.min(120, vh - EDGE - h);
    }
    el.style.left = `${Math.round(Math.max(EDGE, Math.min(left, vw - w - EDGE)))}px`;
    el.style.top = `${Math.round(Math.max(EDGE, top))}px`;
    el.style.visibility = "visible";
  }, [ref, anchor]);

  useLayoutEffect(() => {
    place();
  }, [place, planOpen]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(place);
    ro.observe(el);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [ref, place]);
}

/* ───────────── 入口共用 ───────────── */

interface CardState {
  id: string;
  anchor: HTMLElement | null;
  reviewTick: number;
}

/** 入口的本地 state：`open(車站 id, 錨)` 開小卡、`openReview` 開到回顧；`node` 放在入口的畫面裡（不要放進可點的卡片裡，事件會冒上去） */
export function useStationCard() {
  const [card, setCard] = useState<CardState | null>(null);
  const tick = useRef(0);
  const close = useCallback(() => setCard(null), []);
  const open = useCallback((id: string, anchor?: HTMLElement | null) => setCard({ id, anchor: anchor ?? null, reviewTick: 0 }), []);
  const openReview = useCallback((id: string, anchor?: HTMLElement | null) => {
    tick.current += 1;
    const reviewTick = tick.current;
    setCard((cur) => ({ id, anchor: anchor ?? (cur?.id === id ? cur.anchor : null), reviewTick }));
  }, []);
  const node = card ? (
    <StationCard
      key={card.id}
      stationId={card.id}
      anchor={card.anchor}
      reviewTick={card.reviewTick}
      onClose={close}
      onAskReview={() => openReview(card.id, card.anchor)}
    />
  ) : null;
  return { open, openReview, close, node };
}

/** 一批車站的方針（整批載一次；清單、路線一覽、記錄簿用）。回 車站 id → 活著的句子；還沒載到＝空 */
export function useStationAimLists(stationIds: readonly string[]): (stationId: string) => WeekAimRow[] {
  const joined = stationIds.join("|");
  useEffect(() => {
    if (!joined) return;
    const st = useWeekAimStore.getState();
    const missing = joined
      .split("|")
      .map(stationKeyOf)
      .filter((k) => st.weeks[k] === undefined);
    void st.loadKeys(missing);
  }, [joined]);
  const weeks = useWeekAimStore((s) => s.weeks);
  return useCallback(
    (stationId: string) => {
      const key = stationKeyOf(stationId);
      return aimsOfKey(weeks[key] ?? EMPTY, key);
    },
    [weeks],
  );
}

export interface RouteNextAims {
  station: NodeRow;
  aims: WeekAimRow[];
  /** 句子接成一行；沒句子＝空字串 */
  brief: string;
}

/** 每條路線的下一站與它的方針（路線一覽卡、手機第一層；整批載一次）。回 路線 id → 那一份；全到站或沒車站＝沒有這個鍵 */
export function useRouteNextAims(routes: readonly NodeRow[]): Record<string, RouteNextAims> {
  const stations = useNodeStore((s) => s.stations);
  const nexts = useMemo(() => nextStationsOfRoutes(routes, [...stations].sort(compareSiblings)), [routes, stations]);
  const aimsOf = useStationAimLists(useMemo(() => nexts.map((n) => n.station.id), [nexts]));
  return useMemo(() => {
    const out: Record<string, RouteNextAims> = {};
    for (const { route, station } of nexts) {
      const aims = aimsOf(station.id);
      out[route.id] = { station, aims, brief: aimsBrief(aims) };
    }
    return out;
  }, [nexts, aimsOf]);
}

/** 車站列上的鈕：「方針 2」／沒寫＝淡淡的「方針」（桌機車站清單、手機路線詳情的車站段） */
export function StationAimButton({ station, count, onOpen }: { station: NodeRow; count: number; onOpen(anchor: HTMLElement): void }) {
  return (
    <button
      type="button"
      className={"wa-st-aim" + (count > 0 ? " has-aims" : "")}
      aria-haspopup="dialog"
      aria-label={count > 0 ? `「${station.name}」的方針 ${count} 句` : `「${station.name}」的方針，還沒寫`}
      title={count > 0 ? `這一站的方針 ${count} 句` : "這一站還沒寫方針"}
      onClick={(e) => onOpen(e.currentTarget)}
    >
      方針{count > 0 && <b>{count}</b>}
    </button>
  );
}

/** 記錄簿「經過的車站」每站底下當時的方針（只讀，済的有小章）；沒寫不佔位 */
export function BookStationAims({ aims }: { aims: readonly WeekAimRow[] }) {
  if (!aims.length) return null;
  return (
    <div className="wa-bk-aims">
      {aims.map((a) => (
        <p key={a.id} className={a.done_at ? "is-done" : undefined}>
          <span className="t">{a.text}</span>
          {a.done_at && (
            <span className="ns-imp wa-bk-seal" aria-label="済">
              済
            </span>
          )}
        </p>
      ))}
    </div>
  );
}
