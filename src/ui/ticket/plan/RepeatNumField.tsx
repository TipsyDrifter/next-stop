/**
 * RepeatNumField——定期規則表單的數字格（間隔「每 [N] 週」、筆數「[12] 筆」；桌機 RepeatEditor、手機 MobileRepeatForm 共用，D-票-80／81）。
 * 本體＝共用 NumberField（blur／Enter 提交、超界夾回、打錯還原）；這兩格一定有值，清空＝不算數、還原——
 * NumberField 清空後外面的值沒變就不會跟回來，所以換一個 key 重掛（同一個值；車票的間隔格同款）。
 * 樣式 .ns-tk-re-num 在 ticket.css §N（兩殼共用），手機的觸控高與 16px 字在 ticket-mobile.css。
 */
import { useState } from "react";
import { NumberField } from "../../common/fields";

export function RepeatNumField({
  value,
  min,
  max,
  unit,
  label,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  unit: string;
  label: string;
  onChange(v: number): void;
}) {
  const [rev, setRev] = useState(0);
  return (
    <div className="ns-tk-re-num">
      <NumberField
        key={rev}
        value={value}
        min={min}
        max={max}
        unit={unit}
        ariaLabel={label}
        onCommit={(v) => {
          if (v === null) setRev((r) => r + 1);
          else onChange(v);
        }}
      />
    </div>
  );
}
