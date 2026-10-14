/**
 * TicketSeal——検印位的印（車次①契約 §2.5-4、0-3、§5.5；乙席）。
 *   income   ＝既有 `SealReceipt`「領収」（朱、圓印；與備份回執同一枚，不另造；朱紅只出現在這裡）
 *   transfer ＝角印「振替」（墨，`.ns-tk-kakuin`：橫長方、1.4px 墨框、固定 -6°、`--stamp-ink`；朱肉 filter 不套）
 *   adjust   ＝角印「精算」（同款）
 *   expense  ＝虛線空欄（「還沒結清」的語感，與任務票一致）
 * `size`：圓印與空欄的邊長（預設 46／空欄 52，原型 P-5）；`fresh`：剛蓋下（stampIn 曲線；減量動態直接出現，CSS 管）。
 */
import { SealReceipt } from "../../stamps/Stamps";
import type { EntryKind } from "../../../domain/ticket";

export interface TicketSealProps {
  kind: EntryKind;
  size?: number;
  fresh?: boolean;
}

export function TicketSeal(props: TicketSealProps) {
  const fresh = props.fresh ? " is-fresh" : "";
  switch (props.kind) {
    case "income":
      return <SealReceipt size={props.size ?? 46} fresh={props.fresh} rotate={-5} title="領収" />;
    case "transfer":
      return (
        <span className={`ns-tk-kakuin${fresh}`} aria-label="振替">
          振替
        </span>
      );
    case "adjust":
      return (
        <span className={`ns-tk-kakuin${fresh}`} aria-label="精算">
          精算
        </span>
      );
    default: {
      const s = props.size ? Math.round(props.size * 1.13) : 52;
      return <span className="ns-tk-blankseal" style={{ width: s, height: s }} aria-label="検印欄（空）" />;
    }
  }
}
