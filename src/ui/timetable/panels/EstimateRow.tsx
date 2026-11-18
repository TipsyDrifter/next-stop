/**
 * EstimateRow——「預估」一列（v1.32 2A-2；発車／換車面板與「改這一班」共用）。
 *   Row k="預估"：統一改用全站共用的「時 × 分雙排時長挑選器」`DurationPicker`（點兩下秒組時長＋智慧輸入框）＋ extra（発車面板的「收起／不預估」）。
 *   傳入 `liveCommit` 確保打字當下即同步更新父面板草稿，按 Esc 還原開啟焦點前的值並攔截冒泡（不讓外層面板跟著關）。
 */
import type { ReactNode } from "react";
import { DurationPicker } from "../../common/DurationPicker";
import { Row } from "./controls";

export function EstimateRow({ value, onChange, extra }: { value: number | null; onChange(next: number | null): void; extra?: ReactNode }) {
  return (
    <Row k="預估" top>
      <DurationPicker value={value} onChange={onChange} liveCommit extra={extra} showClear={!extra} ariaLabel="預估" />
    </Row>
  );
}
