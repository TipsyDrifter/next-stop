/**
 * LinkPanel——改一塊的連結（車次② 契約 §5.5；乙席）。sheet `{ kind: "link", blockId }`，從運行列分類名後的任務名
 * （沒連＝淡字「連到…」）打開；標題「連到…」由 host 給（`sheetTitle`）。
 *
 *   div.ns-tt-panel.ns-tt-panel-link
 *   ├ Sub「{分類}・HH:MM 発」（運行中）／「{分類}　HH:MM – HH:MM」（已結束）
 *   └ LinkPicker（選了即 `setLink(blockId, link)`、`onDone()`；選的跟現在一樣＝只關）
 *
 * 這一塊在面板開著時被別台刪掉 ⇒ 畫「這一塊已經不在了」；正好在選的那一下被刪 ⇒ `setLink` 丟 RangeError ⇒ store 的
 * failToast「找不到這一塊」。
 */
import { fmtClock, msOf } from "../../../domain/timetable";
import { linkOfRow } from "../../../domain/timetableLink";
import { useTimetableStore } from "../../../store/timetableStore";
import { LinkPicker } from "../parts/LinkPicker";
import { Actions, Sub, useBlock, type PanelProps } from "./controls";

export function LinkPanel({ onDone }: PanelProps) {
  const sheet = useTimetableStore((s) => s.sheet);
  const catById = useTimetableStore((s) => s.catById);
  const setLink = useTimetableStore((s) => s.setLink);
  const blockId = sheet?.kind === "link" ? sheet.blockId : "";
  const block = useBlock(blockId);

  if (!block) {
    return (
      <div className="ns-tt-panel">
        <Sub>這一塊已經不在了</Sub>
        <Actions>
          <button type="button" className="ns-btn btn-ghost" onClick={onDone}>
            關閉
          </button>
        </Actions>
      </div>
    );
  }

  const cur = linkOfRow(block);
  const name = catById[block.category_id]?.name ?? "？";
  const start = msOf(block.started_at);

  return (
    <div className="ns-tt-panel ns-tt-panel-link">
      <Sub num>
        {block.ended_at === null ? `${name}・${fmtClock(start)} 発` : `${name}　${fmtClock(start)} – ${fmtClock(msOf(block.ended_at))}`}
      </Sub>
      <LinkPicker
        value={cur}
        onPick={(l) => {
          const same = (l?.nodeId ?? null) === cur.nodeId && (l?.routeId ?? null) === cur.routeId;
          onDone();
          if (!same) void setLink(block.id, l);
        }}
      />
    </div>
  );
}
