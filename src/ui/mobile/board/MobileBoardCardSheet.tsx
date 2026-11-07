/**
 * 看板卡與篩選結果的 ⋯（⑫；契約 §1、§4；原型 x03-底部面板）。路線看板與篩選清單（跨路線）共用；桌機對照 board/boardMenu.ts。
 *
 * 就是 MobileTicketSheet（今日、行程表、路線圖同一支）＋上面多一段「現況」四顆＋「車站…｜選取」：
 *   現況走 boardActions.moveCardToStatus（同看板換欄，附復原）、車站走 stationItems（同桌機選單與選取列）；
 *   改期、時刻、改名、移動、刪除都是既有的跨路線動作（scheduleActions、moveNodeTo、deleteNodeFlow），不碰只認目前路線樹的 nodeFlows。
 * 車庫裡的路線唯讀（同桌機選單把改東西的項目淡掉）：只留一句理由、詳情、刪除。
 * 返回層：呼叫端用 `backId` 登記整個流程那一層，每一張 MSheet 同一個 id（MobileTicketSheet 檔頭）。
 */
import { useMemo, useState } from "react";
import { STATUS_COLUMNS, STATUS_COLUMN_LABEL, cardStatus } from "../../../domain/board";
import type { TaskRow } from "../../../domain/taskFilter";
import { useNodeStore } from "../../../store/nodeStore";
import { moveCardToStatus } from "../../board/boardActions";
import { stationItems } from "../../board/boardMenu";
import { routeStations } from "../../board/useRouteBoard";
import { confirmAndDeleteNode } from "../../common/deleteNodeFlow";
import { moveNodeTo } from "../../common/moveTo";
import { MSheet, MSheetItem } from "../../common/MSheet";
import { useUiStore } from "../../../store/uiStore";
import { makeScheduleActions } from "../../schedule/scheduleActions";
import { useMobileDetailStore } from "../detail/mobileDetailStore";
import { pressSelect } from "../mobileSelect";
import { MobileTicketSheet } from "../MobileTicketSheet";
import { cardFromTreeNode } from "../routemap/routeMapActions";
import { logTicket, renameTicket } from "../useMobileToday";

export interface MobileBoardCardSheetProps {
  node: TaskRow;
  today: string;
  parked: boolean;
  /** 畫面順序（「選取」加進多選要排順序） */
  order: readonly string[];
  backId: string;
  onClose(): void;
}

export function MobileBoardCardSheet({ node, today, parked, order, backId, onClose }: MobileBoardCardSheetProps) {
  const occ = useNodeStore((s) => s.currentOccurrences[node.id]);
  // 有子項的列車不是卡，不掛車站
  const hasStations = useNodeStore((s) => !node.has_kids && !!node.route_id && routeStations(s.stations, node.route_id).length > 0);
  const [stationOpen, setStationOpen] = useState(false);
  const actions = useMemo(() => makeScheduleActions("mobile"), []);

  const openDetail = () => {
    onClose();
    useMobileDetailStore.getState().open(node.id);
  };
  const remove = () => {
    onClose();
    void confirmAndDeleteNode(node.id);
  };

  if (parked) {
    return (
      <MSheet list title={node.name} backId={backId} onClose={onClose}>
        <p className="m-tks-note">已收進車庫——要改先回到運行</p>
        <MSheetItem onClick={openDetail}>詳情…</MSheetItem>
        <MSheetItem danger cut onClick={remove}>
          刪除
        </MSheetItem>
      </MSheet>
    );
  }

  if (stationOpen && node.route_id) {
    return (
      <MSheet list title="車站" overline={node.name} backId={backId} onClose={onClose}>
        {stationItems([node], node.route_id).map((it) => (
          <MSheetItem
            key={it.key}
            onClick={() => {
              onClose();
              it.onSelect?.();
            }}
          >
            {it.label}
            {it.caps && <span className="m-tks-aside m-bd-check">{it.caps}</span>}
          </MSheetItem>
        ))}
      </MSheet>
    );
  }

  const card = cardFromTreeNode(node, occ, null);
  const current = cardStatus(node, occ);
  const head = (
    <div className="m-bd-sheetchips" role="group" aria-label="現況">
      {STATUS_COLUMNS.map((s) => (
        <button
          key={s}
          type="button"
          className={"m-bd-chip" + (s === "done" ? " is-seal" : "")}
          aria-pressed={s === current}
          onClick={() => {
            onClose();
            // 選原欄也要走：運休中選「未開始」＝取消運休
            void moveCardToStatus(node, s);
          }}
        >
          {STATUS_COLUMN_LABEL[s]}
        </button>
      ))}
    </div>
  );
  const below = (
    <div className={hasStations ? "m-tks-pair" : undefined}>
      {hasStations && <MSheetItem onClick={() => setStationOpen(true)}>車站…</MSheetItem>}
      <MSheetItem
        onClick={() => {
          onClose();
          pressSelect("board", node.id, order);
        }}
      >
        選取
      </MSheetItem>
    </div>
  );

  return (
    <MobileTicketSheet
      card={card}
      today={today}
      head={head}
      belowSchedule={below}
      flatArrange
      onDefer={(d) => actions.defer({ kind: "due", node }, d)}
      onSkip={(s) =>
        void useNodeStore
          .getState()
          .skipOccurrence(node.id, s)
          .then((r) => {
            if (!r.ok && r.reason) useUiStore.getState().showToast({ message: r.reason }, 3600);
          })
      }
      onSetTime={(time, est) => actions.setTime(node.id, time, est)}
      onSetRunTime={(time) => {
        if (card.railDate) actions.setRunTime(node.id, card.railDate, time);
      }}
      onClearRunTime={() => {
        if (card.railDate) actions.clearRunTime(node.id, card.railDate);
      }}
      onRename={(name) => renameTicket(node.id, name, node.name)}
      onLog={(body) => logTicket(node.id, body)}
      onMove={(dest) => void moveNodeTo(node.id, dest)}
      onDelete={() => void confirmAndDeleteNode(node.id)}
      backId={backId}
      onClose={onClose}
    />
  );
}
