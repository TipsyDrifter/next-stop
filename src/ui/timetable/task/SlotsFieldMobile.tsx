/**
 * SlotsFieldMobile——手機車票詳情（`MobileDetailHost` 的 `LineFieldRows`）與路線圖詳情的「其他時段」一列
 * （時刻表⑦ 契約 §4 入口①；`nodeFields` 插槽的 `Mobile`：自己畫 `dt`／`dd`，外觀對齊同區的 `TimeFieldMobile`——52px 標籤欄）。
 * 內容＝桌機同一個 `SlotsBody`（一段一行＋×、過去淡字、「＋加一段」展開成一行、定期券一行灰字）；觸控尺寸在 `slots.css` 的手機段。
 *
 *   dl.ns-tt-tplans-m > dt「其他時段」＋dd > SlotsBody
 */
import type { NodeRow } from "../../../domain/node";
import { SLOTS_TEXT, SlotsBody } from "./SlotsField";
import "./slots.css";

export function SlotsFieldMobile({ node }: { node: NodeRow }) {
  return (
    <dl className="ns-tt-tplans-m">
      <dt>{SLOTS_TEXT.label}</dt>
      <dd>
        <SlotsBody node={node} />
      </dd>
    </dl>
  );
}
