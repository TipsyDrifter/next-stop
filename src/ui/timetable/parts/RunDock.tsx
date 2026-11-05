/**
 * RunDock——運行列（車次①a 契約 §5.1；D-時-22 甲案；乙席）。兩殼共用 DOM（手機固定在頁面與 tab bar 之間、桌機在左欄頂端），
 * 差異只在 CSS。自己讀 store。
 *
 * 己（第五本第二梯，D-時-169、170；使用者 11-04「不要分散在最上層，容易誤觸，也不美觀」，前情 10-22「直接點正在跑的那班車彈出視窗
 * 編輯資料就好，不要在票面加一堆按鈕」；長相＝`prototypes/時刻表-運行列收攏.html`）：
 * 運行中：div.ns-tt-dock[.is-long]
 *   ├ button.ns-tt-dock-edit（整塊一顆，開「改這一班」）：Badge（live：右上肩呼吸赭點，UI 丙-7）＋ span.ns-tt-dock-main（
 *   │   span.ns-tt-dock-name：分類名＋「・任務名」（`linkLabelOf`；長的省略號，沒連就不寫）；
 *   │   span.ns-tt-dock-meta：「HH:MM 発」＋只讀狀態字＋b.ns-tt-dock-el（fmtHMS，每秒））＋尾端淡 ⋯
 *   ├ button.ns-btn.btn-ghost「換車」＋ button.ns-btn.btn-seal「到着」
 *   └ 待確認時 button.ns-tt-dock-ask：赭色窄條，一點直接開「其實到幾點」（這一題要回答，不隔一層）
 * 只讀狀態字（記號一律看 `blockMarker`：門檻＝預估 → 任務預計 → 分類預設 → 保險上限）：誤點已確認＝赭字「誤點 +X」；長時間運行已確認而且
 * 真的還超過門檻＝「長時間運行」；有預估＝淡字「預估 1h」；門檻來自任務＝淡字「預計 X」；都沒有就不寫。
 * 連到、荷札、備註、切開、改出發、預估一律在面板裡（RunDock 不再有小鈕）；快捷鍵 R、S 照舊。
 * 停車中：「目前沒有列車在跑」／「沒記到的時間，之後可以在時刻表補記」＋ button.btn-seal「発車」。
 * 桌機鈕上加 kbd.ns-tt-kbd（N／Enter）——鍵帽字一律 `formatChord(hotkeyById(id)!.chords[0])`（契約 §1-9，不手抄）。
 * 按下「開面板」的鈕就把焦點放掉：鈕若一直留著焦點，面板關掉後 Enter 會再按到它（鍵表 Enter＝到着，聚焦的 button 上的 Enter 放行）；
 * 放掉後焦點落 body，TimetableView 在面板關掉時把焦點還給根節點。
 */
import { MIN, fmtClock, fmtDur, fmtHMS, msOf } from "../../../domain/timetable";
import { useHotkeyRevision } from "../../shell/useHotkeyRevision";
import { linkLabelOf, linkOfRow, taskEstimateOf } from "../../../domain/timetableLink";
import { TT_TEXT, blockMarker, useTimetableStore } from "../../../store/timetableStore";
import { formatChord, hotkeyById } from "../../shell/hotkeys";
import { CategoryBadge } from "../CategoryBadge";
import { useNow } from "../useNow";

export interface RunDockProps {
  variant: "mobile" | "desktop";
}

/** 桌機鈕上的鍵帽（一顆鍵一枚 kbd）；視圖列的「分類與設定」也借用（磨光③ 2-3） */
export function Kbd({ id }: { id: string }) {
  useHotkeyRevision();
  const h = hotkeyById(id);
  if (!h) return null;
  return (
    <kbd className="ns-tt-kbd" aria-hidden="true">
      {formatChord(h.chords[0]).join("+")}
    </kbd>
  );
}

export function RunDock({ variant }: RunDockProps) {
  const running = useTimetableStore((s) => s.running);
  const catById = useTimetableStore((s) => s.catById);
  const longRunMaxMin = useTimetableStore((s) => s.longRunMaxMin);
  const linkInfo = useTimetableStore((s) => s.linkInfo);
  const requestDepart = useTimetableStore((s) => s.requestDepart);
  const requestArrive = useTimetableStore((s) => s.requestArrive);
  const openSheet = useTimetableStore((s) => s.openSheet);
  const now = useNow(1000);
  const desk = variant === "desktop";

  if (!running) {
    return (
      <div className={"ns-tt-dock is-idle is-" + variant}>
        <div className="ns-tt-dock-main">
          <div className="ns-tt-dock-name">目前沒有列車在跑</div>
          <div className="ns-tt-dock-meta">沒記到的時間，之後可以在時刻表補記</div>
        </div>
        <button type="button" className="ns-btn btn-seal ns-tt-dock-go" onClick={requestDepart}>
          発車{desk && <Kbd id="timetable.depart" />}
        </button>
      </div>
    );
  }

  const cat = catById[running.category_id] ?? null;
  const start = msOf(running.started_at);
  const marker = blockMarker(running, catById, longRunMaxMin, now, linkInfo);
  const pending = marker.kind !== "none" && marker.pending;
  const blockId = running.id;
  const est = running.estimate_min;
  const label = linkLabelOf(running, linkInfo);
  const lk = linkOfRow(running);
  const lkInfo = linkInfo[lk.nodeId ?? lk.routeId ?? ""];
  const linkGone = !!lkInfo && (lkInfo.deleted || lkInfo.missing);
  const taskEst = est === null ? taskEstimateOf(running, linkInfo) : null;
  const blurThen = (e: { currentTarget: HTMLElement }, go: () => void): void => {
    e.currentTarget.blur();
    go();
  };
  const status =
    marker.kind === "late" ? (
      pending ? null : (
        <span className="ns-tt-dock-st is-late">{TT_TEXT.late(marker.overMs)}</span>
      )
    ) : marker.kind === "long" ? (
      pending ? null : (
        <span className="ns-tt-dock-st">{TT_TEXT.dockLong}</span>
      )
    ) : est !== null ? (
      <span className="ns-tt-dock-st">{TT_TEXT.estimateChip(est)}</span>
    ) : taskEst !== null ? (
      <span className="ns-tt-dock-st">預計 {fmtDur(taskEst * MIN)}</span>
    ) : null;

  return (
    <div className={"ns-tt-dock is-" + variant + (pending ? " is-long" : "")}>
      <button
        type="button"
        className="ns-tt-dock-edit"
        title={TT_TEXT.dockEditTitle}
        onClick={(e) => blurThen(e, () => openSheet({ kind: "edit", blockId }))}
      >
        <CategoryBadge cat={cat} live />
        <span className="ns-tt-dock-main">
          <span className="ns-tt-dock-name">
            <span className="ns-tt-dock-cat">{cat?.name ?? "？"}</span>
            {label !== null && (
              <span className={"ns-tt-dock-link" + (linkGone ? " is-gone" : "")}>
                <span className="ns-tt-dock-link-dot">・</span>
                {label}
              </span>
            )}
          </span>
          <span className="ns-tt-dock-meta ns-tt-num">
            {/* 畫面上由右排到左（CSS row-reverse）：放不下時最後的「HH:MM 発」先讓位 */}
            <b className="ns-tt-dock-el">{fmtHMS(now - start)}</b>
            {status}
            <span>{fmtClock(start)} 発</span>
          </span>
        </span>
        <span className="ns-tt-dock-more" aria-hidden="true">
          ⋯
        </span>
      </button>
      <button type="button" className="ns-btn btn-ghost" onClick={requestDepart}>
        換車{desk && <Kbd id="timetable.depart" />}
      </button>
      <button type="button" className="ns-btn btn-seal" onClick={requestArrive}>
        到着{desk && <Kbd id="timetable.arrive" />}
      </button>
      {pending && (
        <button
          type="button"
          className="ns-tt-dock-ask"
          onClick={(e) => blurThen(e, () => openSheet({ kind: "longRun", blockId, then: null }))}
        >
          <span className="ns-tt-dock-ask-t">{marker.kind === "late" ? TT_TEXT.dockAskLate(marker.overMs) : TT_TEXT.dockAsk}</span>
          <span className="ns-tt-dock-ask-chev" aria-hidden="true">
            ›
          </span>
        </button>
      )}
    </div>
  );
}
