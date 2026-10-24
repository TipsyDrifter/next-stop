/**
 * TicketSheetDepart——手機票卡 ⋯ 底部面板的「発車」一項（車次② 契約 §5.1 手機、〈原型拍板〉2；丙）。
 * 既有插槽 `ticketSheetItems` 的 `Item`（`MobileTicketSheet` 在「取消」之前、卡片不是唯讀時渲染；段一由整合席填進 mount）。
 *
 *   可發車：MSheetItem.ns-tt-todaydep-sheet.is-go「発車」——點了先 `close()` 再 `departFromTask(nodeId)`
 *   這張正在跑：MSheetItem disabled.ns-tt-todaydep-sheet「発車 ……● 正在跑」（不可點；契約：改畫不可點的一行）
 *   已交代（済／運休）：MSheetItem disabled.ns-tt-todaydep-sheet「発車 ……已蓋済——先取消済章」（〈原型拍板〉2：変灰）
 *
 * UI 丙-7 T5：從借核心 `.m-sheet-item` 換成共用 `MSheetItem`（核心 ⋯ 已是 MSheet list；↑↓ 走得到這一列）。
 * 不可點的兩種從 <p> 改成 disabled 的鈕，`title` 寫為什麼不能（§1.8）；長相照舊——淡字、右側小字不跟著變淡
 * （timetable.css §I 那兩行蓋掉殼的 disabled 透明度），右側小字 `.ns-tt-todaydep-aside` 是自己的。
 */
import { MSheetItem } from "../../common/MSheet";
import { useNodeStore } from "../../../store/nodeStore";
import { TT_TEXT, useTimetableStore } from "../../../store/timetableStore";
import { isTaskSettled } from "./taskState";
import "../timetable.css";

/** 〈原型拍板〉2 的原句（已蓋済的票不能発車） */
const SETTLED_ASIDE = "已蓋済——請先取消済章";

const noop = () => {};

export function TicketSheetDepart({ nodeId, close }: { nodeId: string; name: string; close(): void }) {
  const running = useTimetableStore((s) => s.running !== null && s.running.node_id === nodeId);
  const settled = useNodeStore((s) => isTaskSettled(s, nodeId));

  if (running) {
    return (
      <MSheetItem disabled className="ns-tt-todaydep-sheet" title={TT_TEXT.TODAY_RUNNING} onClick={noop}>
        {TT_TEXT.TODAY_DEPART}
        <span className="ns-tt-todaydep-aside is-live">
          <span className="ns-tt-live-dot" aria-hidden="true" />
          {TT_TEXT.TODAY_RUNNING}
        </span>
      </MSheetItem>
    );
  }
  if (settled) {
    return (
      <MSheetItem disabled className="ns-tt-todaydep-sheet" title={SETTLED_ASIDE} onClick={noop}>
        {TT_TEXT.TODAY_DEPART}
        <span className="ns-tt-todaydep-aside">{SETTLED_ASIDE}</span>
      </MSheetItem>
    );
  }
  return (
    <MSheetItem
      className="ns-tt-todaydep-sheet is-go"
      onClick={() => {
        close();
        void useTimetableStore.getState().departFromTask(nodeId);
      }}
    >
      {TT_TEXT.TODAY_DEPART}
    </MSheetItem>
  );
}
