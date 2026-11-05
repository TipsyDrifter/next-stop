/**
 * EstimateRow——「預估」一列（己 D-時-171、174；発車／換車面板與「改這一班」共用）。
 *   Row k="預估"：30 分｜1h｜1h30｜2h｜3h｜自訂…（再點一次選中的＝不選）＋ extra（発車面板的「收起／不預估」）
 * 值不在五顆裡＝自訂那顆亮、寫出長度。「自訂…」就地換成數字框（分），寫法同車票長度 `LengthField`：
 * 打字當下就算數（「改好了」運行中模式按下不搶焦點，等失焦來不及）、空白＝不預估、看不懂的不算；Enter／失焦收回；Esc 還原開框前的值並收回（不讓面板跟著關）。
 * 這一列是草稿的一部分：只呼叫 onChange，寫入由面板決定。
 */
import { useRef, useState, type ReactNode } from "react";
import { MIN, fmtDur } from "../../../domain/timetable";
import { parseLenInput } from "../../panel/panelRules";
import { ESTIMATE_OPTIONS, Opt, Opts, Row } from "./controls";

export function EstimateRow({ value, onChange, extra }: { value: number | null; onChange(next: number | null): void; extra?: ReactNode }) {
  const [draft, setDraft] = useState<string | null>(null);
  const opened = useRef<number | null>(null);
  const composing = useRef(false);
  /** Esc 收回時框會被拆掉、可能再吹一次 blur：這一次不用再收 */
  const dropped = useRef(false);
  const preset = value !== null && ESTIMATE_OPTIONS.some(([m]) => m === value);
  const custom = value !== null && !preset;

  const open = (): void => {
    opened.current = value;
    setDraft(value !== null ? String(value) : "");
  };

  return (
    <Row k="預估" top>
      <Opts>
        {ESTIMATE_OPTIONS.map(([m, t]) => (
          <Opt
            key={m}
            on={draft === null && value === m}
            onClick={() => {
              setDraft(null);
              onChange(value === m ? null : m);
            }}
          >
            {t}
          </Opt>
        ))}
        {draft !== null ? (
          <span className="ns-tt-est-custom">
            <input
              type="number"
              inputMode="numeric"
              min={1}
              autoFocus
              className="techo-input"
              value={draft}
              placeholder="45"
              aria-label="自訂預估（分）"
              onChange={(e) => {
                setDraft(e.target.value);
                const v = parseLenInput(e.target.value);
                if (v !== undefined) onChange(v);
              }}
              onCompositionStart={() => {
                composing.current = true;
              }}
              onCompositionEnd={() => {
                composing.current = false;
              }}
              onFocus={() => {
                dropped.current = false;
              }}
              onBlur={() => {
                if (!dropped.current) setDraft(null);
                dropped.current = false;
              }}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || e.keyCode === 229 || composing.current) return;
                if (e.key === "Enter") {
                  e.preventDefault();
                  e.currentTarget.blur();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  dropped.current = true;
                  setDraft(null);
                  onChange(opened.current);
                }
              }}
            />
            <span className="ns-tt-est-unit">分</span>
          </span>
        ) : (
          <Opt on={custom} onClick={open}>
            {custom ? fmtDur((value as number) * MIN) : "自訂…"}
          </Opt>
        )}
        {extra}
      </Opts>
    </Row>
  );
}
