/**
 * TodayRowDepart——桌機今日列 `.meta` 尾端的「発車」鈕／「正在跑」標記（車次② 契約 §5.1、0-11、〈原型拍板〉1、2；丙）。
 * 段一只寫好、不登記；段二填值 commit 才掛進 `todayRowActions`（`Desktop`，§6.1 #S3／#F1）。
 *
 *   運行中那班連到這一列：button.ns-tt-todaydep-run（常駐）＝脈動點＋分類圓牌＋「正在跑」＋經過時間（每秒）；
 *     點了到時刻表頁看運行列（原型 runMark 的 gotoTT）。這時**不畫**発車鈕。
 *   已交代（済／運休）：什麼都不畫（〈原型拍板〉2；鍵 n 只跳提示＝本檔 `departFromTodayKey`，段二掛進 hotkeys）。
 *   其餘：span.meta-hover > button.ns-tt-todaydep「▶ 発車 [N]」——滑過或選中才現身（借核心 `.meta-hover` 的規則，
 *     〈原型拍板〉1）；點了 `departFromTask(nodeId)`。列的 onMouseDown 碰到 button 會選中這一列（TodayRow 既有）。
 *
 * 鍵帽字一律 `formatChord(hotkeyById(id).chords[0])`（契約 §1-8，不手抄）；段二之前鍵還沒登記 ⇒ 不畫鍵帽、title 只寫「発車」。
 */
import type { MouseEvent } from "react";
import { fmtDur, fmtHMS, msOf, type TimeBlockRow } from "../../../domain/timetable";
import { useNodeStore } from "../../../store/nodeStore";
import { TT_TEXT, useTimetableStore } from "../../../store/timetableStore";
import { useUiStore } from "../../../store/uiStore";
import { formatChord, hotkeyById } from "../../shell/hotkeys";
import { CategoryBadge } from "../CategoryBadge";
import { useNow } from "../useNow";
import { TODAY_DEPART_HOTKEY, isTaskSettled } from "./taskState";
import "../timetable.css";

/** 「正在跑」標記（兩殼共用）：mobile＝經過時間只到分（每分鐘），desktop＝時分秒（每秒） */
export function RunMark({ block, shell }: { block: TimeBlockRow; shell: "desktop" | "mobile" }) {
  const cat = useTimetableStore((s) => s.catById[block.category_id] ?? null);
  const now = useNow(shell === "desktop" ? 1000 : 60_000);
  const el = now - msOf(block.started_at);
  const go = (e: MouseEvent): void => {
    e.stopPropagation();
    const ui = useUiStore.getState();
    if (shell === "desktop") ui.setPage("timetable");
    else ui.setMobileTab("timetable");
  };
  return (
    <button
      type="button"
      tabIndex={-1}
      className={"ns-tt-todaydep-run" + (shell === "mobile" ? " is-m" : "")}
      title={`${TT_TEXT.TODAY_RUNNING}——到時刻表看運行列`}
      onClick={go}
    >
      <span className="ns-tt-live-dot" aria-hidden="true" />
      <CategoryBadge cat={cat} size="sm" />
      <span>{TT_TEXT.TODAY_RUNNING}</span>
      <b className="ns-tt-num">{shell === "desktop" ? fmtHMS(el) : fmtDur(el)}</b>
    </button>
  );
}

/** 契約 0-11 的原句：已交代的列按 n 只跳這句（〈原型拍板〉2） */
const SETTLED_KEY_HINT = "已蓋済——要補記時間請點「連到…」";

/**
 * 今日鍵 n（`timetable.today.depart`，段二填值 commit 掛進 `todayRowActions[].hotkeys`）：
 * 已交代（済／運休）而且不是正在跑的那張 ⇒ 只跳提示，不発車；其餘交給 store 的 `departFromTask`
 * （正在跑 ⇒ 它自己吐「已經在跑了」；面板開著 ⇒ 它自己不動）。
 */
export function departFromTodayKey(nodeId: string): void {
  const tt = useTimetableStore.getState();
  if (tt.running?.node_id !== nodeId && isTaskSettled(useNodeStore.getState(), nodeId)) {
    useUiStore.getState().showToast({ message: SETTLED_KEY_HINT });
    return;
  }
  void tt.departFromTask(nodeId);
}

export function TodayRowDepart({ nodeId, name }: { nodeId: string; name: string; selected: boolean }) {
  const running = useTimetableStore((s) => (s.running !== null && s.running.node_id === nodeId ? s.running : null));
  const settled = useNodeStore((s) => isTaskSettled(s, nodeId));

  if (running) return <RunMark block={running} shell="desktop" />;
  if (settled) return null;

  const h = hotkeyById(TODAY_DEPART_HOTKEY);
  const keys = h ? formatChord(h.chords[0]).join("+") : null;
  return (
    <span className="meta-hover">
      <button
        type="button"
        tabIndex={-1}
        className="ns-tt-todaydep"
        title={keys ? `${TT_TEXT.TODAY_DEPART}（${keys}）` : TT_TEXT.TODAY_DEPART}
        aria-label={`${TT_TEXT.TODAY_DEPART}：${name}`}
        onClick={(e) => {
          e.stopPropagation();
          void useTimetableStore.getState().departFromTask(nodeId);
        }}
      >
        <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2 1.2v7.6L8.6 5z" fill="currentColor" />
        </svg>
        {TT_TEXT.TODAY_DEPART}
        {keys && (
          <kbd className="ns-tt-kbd" aria-hidden="true">
            {keys}
          </kbd>
        )}
      </button>
    </span>
  );
}
