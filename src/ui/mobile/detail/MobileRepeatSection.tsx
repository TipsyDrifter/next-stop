/**
 * 手機詳情頁的「重複」段（手機殼班 D-主-69／78）——桌機 `panel/RepeatRuleEditor.tsx` RepeatSection 的手機版。
 *
 * 欄位照桌機現況：模式（不重複／固定排程／完成後間隔）→ 頻率（每日／每週／每月）→ 星期（七格）／每月幾日／完成後幾天 → 起算日；
 *   沒有「終止」（現行編輯器沒有，手機不另發明；終止條件在加分項「重複任務的 backlog」）。
 * 規則、草稿與寫回跟桌機**同一份**（D-主-82）：純規則在 panel/panelRules、草稿的去抖寫回在 panel/useRepeatDraft（被擋＝原句 toast＋還原、
 *   清成不重複＝「已改回乘車券——過去的班次會保留」都在那裡）；草稿的主人是詳情頁（票種轉換也推同一份草稿）。
 * 手機的差別只在手感：段頭可收合（aside＝describeRule 那一句收據，收著也看得到）；每月／完成後是「− 數字 ＋」步進（數字也能直接打）；
 *   起算日開共用日期 sheet（由詳情頁開、疊在頁上）；最後一顆星期熄不掉＝點了 toast 說為什麼（觸控看不到 title；同 MSheetItem off 那套）。
 */
import { useEffect, useState } from "react";
import { WEEKDAY_LABEL, WEEKDAY_ORDER, type NodeRow } from "../../../domain";
import { useUiStore } from "../../../store/uiStore";
import { Segmented } from "../../common/Segmented";
import {
  FREQ_OPTIONS,
  LAST_WEEKDAY_WHY,
  MODE_OPTIONS,
  buildRule,
  fillFixed,
  mdwText,
  repeatAside,
  repeatKidsWhy,
  switchMode,
  toggleWeekday,
  type RepeatDraft,
} from "../../panel/panelRules";
import { clampInt } from "./detailModel";

export interface MobileRepeatSectionProps {
  node: NodeRow;
  draft: RepeatDraft;
  push(next: RepeatDraft): void;
  kidCount: number;
  open: boolean;
  onToggle(): void;
  /** 起算日：詳情頁開日期 sheet（疊在頁上），挑到回呼 */
  onPickStart(current: string, done: (day: string) => void): void;
}

export function MobileRepeatSection({ node, draft, push, kidCount, open, onToggle, onPickStart }: MobileRepeatSectionProps) {
  if (kidCount > 0) {
    return (
      <section className="m-dt-sec">
        <div className="m-dt-sec-head is-static">
          <span className="m-dt-sec-name">重複</span>
          <span className="m-dt-sec-aside">{repeatKidsWhy(node.kind)}</span>
        </div>
      </section>
    );
  }

  const aside = repeatAside(draft, node.repeat_rule);
  const teiki = buildRule(draft) !== null;

  return (
    <section className="m-dt-sec">
      <button type="button" className="m-dt-sec-head" aria-expanded={open} onClick={onToggle}>
        <span className="m-dt-sec-name">重複</span>
        <span className={"m-dt-sec-aside" + (teiki ? " is-teiki" : "")}>{aside}</span>
        <span className="m-dt-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div className="m-dt-sec-body">
          <div className="m-dt-row">
            <span className="m-dt-label">模式</span>
            <div className="m-dt-val">
              <Segmented options={MODE_OPTIONS} value={draft.mode} onChange={(v) => push(switchMode(draft, v))} aria-label="重複方式" />
            </div>
          </div>

          {draft.mode === "fixed" && (
            <div className="m-dt-row">
              <span className="m-dt-label">頻率</span>
              <div className="m-dt-val">
                <Segmented
                  options={FREQ_OPTIONS}
                  value={draft.freq}
                  // 每週／每月都預帶起算日的星期／號數：一選就是一條完整規則，馬上生效
                  onChange={(v) => push(fillFixed({ ...draft, freq: v }))}
                  aria-label="重複頻率"
                />
              </div>
            </div>
          )}

          {draft.mode === "fixed" && draft.freq === "weekly" && (
            <div className="m-dt-row">
              <span className="m-dt-label">星期</span>
              <div className="m-dt-val">
                <div className="m-dt-wk7" role="group" aria-label="星期">
                  {WEEKDAY_ORDER.map((d) => {
                    const on = draft.byweekday.includes(d);
                    return (
                      <button
                        key={d}
                        type="button"
                        aria-label={`每週${WEEKDAY_LABEL[d]}`}
                        aria-pressed={on}
                        // 最後一顆熄不掉（toggleWeekday 原樣回傳）：照樣亮著（「選中」要讀得到，所以不淡掉），點了 toast 說為什麼
                        onClick={() => {
                          const next = toggleWeekday(draft.byweekday, d);
                          if (next === draft.byweekday) useUiStore.getState().showToast({ message: LAST_WEEKDAY_WHY }, 3600);
                          else push({ ...draft, byweekday: next });
                        }}
                      >
                        {WEEKDAY_LABEL[d]}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {draft.mode === "fixed" && draft.freq === "monthly" && (
            <div className="m-dt-row">
              <span className="m-dt-label">每月</span>
              <div className="m-dt-val">
                <Stepper value={draft.monthday} min={1} max={31} unit="日" label="每月幾日" onChange={(v) => push({ ...draft, monthday: v })} />
              </div>
            </div>
          )}

          {draft.mode === "after" && (
            <div className="m-dt-row">
              <span className="m-dt-label">完成後</span>
              <div className="m-dt-val">
                <Stepper value={draft.days} min={1} max={365} unit="天" label="完成後幾天" onChange={(v) => push({ ...draft, days: v })} />
              </div>
            </div>
          )}

          {draft.mode !== "none" && (
            <div className="m-dt-row">
              <span className="m-dt-label">起算日</span>
              <div className="m-dt-val">
                {/* 起算日一定有值，不給清除；過去日照舊可挑（桌機同） */}
                <button
                  type="button"
                  className="m-dt-pick"
                  aria-label={`起算日：${mdwText(draft.start)}`}
                  onClick={() => onPickStart(draft.start, (day) => push({ ...draft, start: day }))}
                >
                  <span>{mdwText(draft.start)}</span>
                  <span className="m-dt-chev" aria-hidden="true">
                    ›
                  </span>
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** − 數字 ＋：按鈕步進一格；數字也能直接打（blur／Enter 套用，超界夾回、打錯還原）。IME 組字中不攔 Enter */
function Stepper({
  value,
  min,
  max,
  unit,
  label,
  onChange,
}: {
  value: number | null;
  min: number;
  max: number;
  unit: string;
  label: string;
  onChange(v: number): void;
}) {
  const shown = value === null ? "" : String(value);
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);

  const apply = () => {
    const v = clampInt(text, min, max);
    if (v === null || v === value) {
      setText(shown);
      return;
    }
    onChange(v);
  };
  const step = (delta: 1 | -1) => {
    const v = clampInt((value ?? (delta > 0 ? min - 1 : min + 1)) + delta, min, max);
    if (v !== null && v !== value) onChange(v);
  };

  return (
    <div className="m-dt-step">
      <button type="button" aria-label={`${label}減一`} disabled={value !== null && value <= min} onClick={() => step(-1)}>
        −
      </button>
      <input
        type="text"
        inputMode="numeric"
        enterKeyHint="done"
        aria-label={label}
        value={text}
        onChange={(e) => setText(e.target.value.replace(/[^\d]/g, ""))}
        onBlur={apply}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
      />
      <span className="m-dt-unit">{unit}</span>
      <button type="button" aria-label={`${label}加一`} disabled={value !== null && value >= max} onClick={() => step(1)}>
        ＋
      </button>
    </div>
  );
}
