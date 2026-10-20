/**
 * RunDock——運行列（車次①a 契約 §5.1；D-時-22 甲案；乙席）。兩殼共用 DOM（手機固定在頁面與 tab bar 之間、桌機在左欄頂端），
 * 差異只在 CSS。＝原型 `mountDock`（shared.js:607-648）。自己讀 store。
 *
 * 運行中：div.ns-tt-dock[.is-long] > Badge ＋ div.ns-tt-dock-main（
 *   div.ns-tt-dock-name：分類名＋長時間運行未確認時 button.ns-tt-chip.is-late「⚠ 其實到幾點？」／已確認時 span.ns-tt-chip「長時間運行」；
 *   div.ns-tt-dock-meta：span.ns-tt-live-dot＋button.ns-tt-dock-start「HH:MM 発」（點了開改出發時間）＋b.ns-tt-dock-el（fmtHMS，每秒））
 *   ＋ button.ns-btn.btn-ghost「換車」＋ button.ns-btn.btn-seal「到着」。
 * 停車中：分類圓牌位置空、「目前沒有列車在跑」／「沒記到的時間，之後可以在軸上補」＋ button.btn-seal「発車」。
 * 桌機鈕上加 kbd.ns-tt-kbd（N／Enter）——鍵帽字一律 `formatChord(hotkeyById(id)!.chords[0])`（契約 §1-9，不手抄）。
 *
 * 車次①b（①b①c 契約 §5.5；長相＝原型 `v-e.js` dockHtml）：記號一律看 `blockMarker`（門檻＝預估 → 分類預設 → 保險上限）。
 * - 整列赭 `.is-long`＝待確認（kind ≠ none 且 pending）。
 * - 名稱列：長時間運行待確認 ⇒「⚠ 其實到幾點？」；已確認、而且**真的還超過門檻** ⇒「長時間運行」（F3：取代 ①a「ack 就畫」）。
 * - 時刻列「HH:MM 発」之後一顆 button.ns-tt-dock-est：誤點 ⇒ `.is-late`「誤點 +X」（待確認點了問「其實到幾點」，已確認點了改預估）；
 *   有預估 ⇒「預估 1h」；沒有 ⇒ `.is-empty`「＋預估」。後兩者點了開預估面板。
 *   誤點時名稱列不另畫「⚠ 其實到幾點？」（＝原型：同一件事只放一顆赭 chip）。
 *
 * 車次②（② 契約 §5.5、§5.9；乙席；長相＝原型 `v-f.js` dockHtml `.vf-dn`）：分類名後接 button.ns-tt-link-dn
 * 「・任務名」（`linkLabelOf`；長的 CSS 省略號）；沒連 ⇒ 淡字「連到…」（`.is-none`）。點了 `openSheet({ kind: "link" })`。
 * 門檻來自任務的預計時間、這一班沒預估 ⇒ 時刻列那一顆是實線「預計 X」（點了一樣開預估面板，＝原型的「預計」chip）；
 * 超過 ⇒ 「誤點 +X」自動成立（runMarker 對 task 來源回 late）。
 *
 * 車次⑥（⑥ 契約 §5.2；D-時-116、126、129；乙席；長相＝原型 `v-tags.js` dockHtml）：
 * - 桌機：「連到」後面淡字 span.ns-tt-dock-tags「・#高效 #podcast …」（順序：分類自己的 → 手動的 → 組帶的，最多 2 個；滑過看全部），
 *   計時後面一顆 button.ns-tt-chip.ns-tt-dock-tag「荷札 N」（N＝這一班的全部荷札，含分類帶的）⇒ 開 `{kind:"tags", blockId}`。
 * - 手機：只放「荷札 N」個數鈕（圖示＋數字；0 個寫「荷札」），保留「HH:MM 発」；點了直接開點選器 entity 模式（標題「荷札・創作 14:35 起」）。
 *   N 只算手動加的（D-時-133，評審後）：點選器只列手動的，數字要對得上；分類帶的在塊面板看。
 *   位置在名稱列尾端（原型在時刻列；正式版的時刻列多了預估 chip，375 寬放不下、會多一行）。
 *
 * 磨光③ 2-2（D-時-138；原型定案桌機 B1、手機 B3）：一顆「切開」開 `{kind:"split", blockId}`（SplitPanel 支援運行中；不到兩分鐘
 * 時面板自己說切不開——不藏、不灰）。
 * - 桌機：div.ns-tt-dock-aux 包一顆淡色小鈕「切開 S」，左欄（會折行）在換車／到着那排之上靠右；寬版同一列、排在換車前面。
 * - 手機：名稱列尾端、緊跟「荷札」鈕的小 chip（button.ns-tt-chip.ns-tt-dock-cut）——運行列不變高。
 * - 按下就把焦點放掉：鈕若一直留著焦點，面板關掉後 Enter 會再按到它（鍵表 Enter＝到着，聚焦的 button 上的 Enter 放行）；
 *   放掉後焦點落 body，TimetableView 在面板關掉時把焦點還給根節點。
 * 運行列淡字也扣這一塊排除的預設荷札（`runTagKeys`，磨光③ 2-1）。
 */
import { MIN, fmtClock, fmtDur, fmtHMS, msOf } from "../../../domain/timetable";
import { linkLabelOf, linkOfRow, taskEstimateOf } from "../../../domain/timetableLink";
import { TT_TEXT, blockMarker, useTimetableStore } from "../../../store/timetableStore";
import { formatChord, hotkeyById } from "../../shell/hotkeys";
import { CategoryBadge } from "../CategoryBadge";
import { useNow } from "../useNow";
import { openRunPicker, runTagKeys, tagNameOf, useTimetableTagMaps } from "./TimetableTagChips";

export interface RunDockProps {
  variant: "mobile" | "desktop";
}

/** 桌機鈕上的鍵帽（一顆鍵一枚 kbd）；視圖列的「分類與設定」也借用（磨光③ 2-3） */
export function Kbd({ id }: { id: string }) {
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
  const categories = useTimetableStore((s) => s.categories);
  const tagMaps = useTimetableTagMaps();
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
  const long = marker.kind !== "none" && marker.pending;
  const blockId = running.id;
  const est = running.estimate_min;
  const label = linkLabelOf(running, linkInfo);
  const lk = linkOfRow(running);
  const lkInfo = linkInfo[lk.nodeId ?? lk.routeId ?? ""];
  const linkGone = !!lkInfo && (lkInfo.deleted || lkInfo.missing);
  const taskEst = est === null ? taskEstimateOf(running, linkInfo) : null;
  const askLongRun = (): void => openSheet({ kind: "longRun", blockId, then: null });
  // 磨光③ 2-2：切開（不到兩分鐘也開，SplitPanel 會交代）；焦點放掉，免得面板關掉後 Enter 又按到它
  const openSplit = (e: { currentTarget: HTMLElement }): void => {
    e.currentTarget.blur();
    openSheet({ kind: "split", blockId });
  };
  const openEstimate = (): void => openSheet({ kind: "estimate", blockId });
  // ⑥：這一班的荷札（推導＋手動）；名稱不含 #
  const tagNames = runTagKeys(running, categories, tagMaps).map(tagNameOf);
  // D-時-133：手機的「荷札 N」只算手動加的（點開的點選器只列手動的，數字要對得上）；分類帶的在塊面板看
  const manualNames = (tagMaps.block[blockId] ?? []).slice().sort().map(tagNameOf);
  const btnNames = desk ? tagNames : manualNames;
  const tagAll = btnNames.map(TT_TEXT.tags.chip).join(" ");
  const openTags = (): void => {
    if (desk) openSheet({ kind: "tags", blockId });
    else openRunPicker(blockId, cat?.name ?? "？", start);
  };
  // 桌機在計時後面；手機時刻列已經被「HH:MM 発＋預估 chip＋跳秒」排滿（375 寬只剩約 20px），放名稱列尾端，運行列才不會多一行
  const tagBtn = (
    <button
      type="button"
      className={"ns-tt-chip ns-tt-dock-tag" + (desk ? "" : " is-m")}
      title={tagAll || TT_TEXT.tags.runBtnTitle}
      aria-label={btnNames.length > 0 ? TT_TEXT.tags.runCount(btnNames.length) : TT_TEXT.tags.row}
      onClick={openTags}
    >
      <i className="ns-tt-tglyph" aria-hidden="true" />
      {desk ? (
        <>
          {TT_TEXT.tags.row}
          {tagNames.length > 0 && <b>{tagNames.length}</b>}
        </>
      ) : manualNames.length > 0 ? (
        <b>{manualNames.length}</b>
      ) : (
        TT_TEXT.tags.row
      )}
    </button>
  );

  return (
    <div className={"ns-tt-dock is-" + variant + (long ? " is-long" : "")}>
      <CategoryBadge cat={cat} />
      <div className="ns-tt-dock-main">
        <div className="ns-tt-dock-name">
          <span className="ns-tt-link-dock">
            <span className="ns-tt-dock-cat">{cat?.name ?? "？"}</span>
            <button
              type="button"
              className={"ns-tt-link-dn" + (label === null ? " is-none" : "") + (linkGone ? " is-gone" : "")}
              title={label === null ? "為這一班指定任務" : "改這一班連到的任務"}
              onClick={() => openSheet({ kind: "link", blockId })}
            >
              {label === null ? (
                TT_TEXT.LINK_NONE
              ) : (
                <>
                  <span className="ns-tt-link-dn-dot">・</span>
                  <span className="ns-tt-link-dn-t">{label}</span>
                </>
              )}
            </button>
            {desk && tagNames.length > 0 && (
              <span className="ns-tt-dock-tags" title={tagAll}>
                {TT_TEXT.tags.runList(tagNames)}
              </span>
            )}
          </span>
          {marker.kind === "long" && marker.pending && (
            <button type="button" className="ns-tt-chip is-late" onClick={askLongRun}>
              ⚠ 實際到幾點？</button>
          )}
          {marker.kind === "long" && !marker.pending && <span className="ns-tt-chip">長時間運行</span>}
          {!desk && tagBtn}
          {!desk && (
            <button type="button" className="ns-tt-chip ns-tt-dock-cut" title={TT_TEXT.dockSplitTitle} onClick={openSplit}>
              {TT_TEXT.dockSplit}
            </button>
          )}
        </div>
        <div className="ns-tt-dock-meta ns-tt-num">
          <span className="ns-tt-live-dot" aria-hidden="true" />
          <button
            type="button"
            className="ns-tt-dock-start"
            title="改出發時間"
            onClick={() => openSheet({ kind: "restart", blockId })}
          >
            {fmtClock(start)} 発
          </button>
          {marker.kind === "late" ? (
            <button
              type="button"
              className="ns-tt-chip ns-tt-dock-est is-late"
              title={marker.pending ? "其實到幾點？" : "改這一班的預計時間"}
              onClick={marker.pending ? askLongRun : openEstimate}
            >
              {TT_TEXT.late(marker.overMs)}
            </button>
          ) : est !== null ? (
            <button type="button" className="ns-tt-chip ns-tt-dock-est" title="改這一班的預計時間" onClick={openEstimate}>
              {TT_TEXT.estimateChip(est)}
            </button>
          ) : taskEst !== null ? (
            <button
              type="button"
              className="ns-tt-chip ns-tt-dock-est"
              title="任務的預計時間，超過就算誤點（點擊可單獨修改這一班）"
              onClick={openEstimate}
            >
              預計 {fmtDur(taskEst * MIN)}
            </button>
          ) : (
            <button type="button" className="ns-tt-chip ns-tt-dock-est is-empty" onClick={openEstimate}>
              {TT_TEXT.estimateAdd}
            </button>
          )}
          <b className="ns-tt-dock-el">{fmtHMS(now - start)}</b>
          {desk && tagBtn}
        </div>
      </div>
      {desk && (
        <div className="ns-tt-dock-aux">
          <button type="button" className="ns-btn btn-ghost" title={TT_TEXT.dockSplitTitle} onClick={openSplit}>
            {TT_TEXT.dockSplit}
            <Kbd id="timetable.split" />
          </button>
        </div>
      )}
      <button type="button" className="ns-btn btn-ghost" onClick={requestDepart}>
        換車{desk && <Kbd id="timetable.depart" />}
      </button>
      <button type="button" className="ns-btn btn-seal" onClick={requestArrive}>
        到着{desk && <Kbd id="timetable.arrive" />}
      </button>
    </div>
  );
}
