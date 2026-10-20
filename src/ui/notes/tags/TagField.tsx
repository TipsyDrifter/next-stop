/**
 * TagField——任務側板的「荷札」欄（桌機；旅客筆記車次③契約 0-2 的 `NodeFieldSpec.Desktop`、§5.3；原型 app.js tagFieldHtml／onFieldKey）。
 *
 * 渲染在核心 `FieldRow label="荷札"` 裡（插槽 `nodeFields`；渲染點在 `TaskFields.tsx`，整合席接）。本元件不 import 側板任何東西。
 *
 *   `div.ns-notes-tagfield`＝牌子一排（點牌＝進荷札頁並記「回到剛才」；hover 出 × 摘）
 *     ＋ 末尾 `button.ns-notes-tagadd`「＋ 掛荷札」⇒ 就地變 `span.ns-notes-taginput`（`i`「#」＋ input）＋ 下方建議清單
 *   輸入框鍵（先判 IME，契約 §1-8）：
 *     ↑↓ 選列・Enter 掛選中列（沒有列＝照打的字）・Tab 補完到下一個 /・**空白鍵＝照打的字掛上**（組字中不攔）・
 *     Esc 收起（不漏給側板，否則側板也關）・輸入框空著按 Backspace：第一下最後一個牌 `.is-armed`、第二下摘掉
 *   掛上後輸入框清空、保持開著；新建的才跳 toast（store 做）；摘下 toast＋復原（store 做）。
 * 資料：`tagStore.index` 的 ents 找這張票的 keys（不另查）；index 還沒載就載一次。
 * 實作在 `EntityTagField`（時刻表⑥ 契約 0-7 抽出，行為逐字相同）；這支只把「這張票」與「回到剛才、收起側板」接上。
 */
import type { NodeRow } from "../../../domain";
import { useUiStore } from "../../../store/uiStore";
import { EntityTagField } from "./EntityTagField";
import { panelBackRef } from "./backRefs";

export function TagField({ node }: { node: NodeRow }) {
  return (
    <EntityTagField
      entityType="node"
      entityId={node.id}
      backRef={() => panelBackRef(node.id)}
      afterOpen={() => useUiStore.getState().setPanelOpen(false)}
    />
  );
}
