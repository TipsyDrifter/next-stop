/**
 * 側板的「幾點」欄（主線階段②；契約 §4.1、§4.2）——UI 丙-3 C5 起換成共用 `ClockInput`（視覺規範 §2.5「時間」：
 * 全 App 一支；側板舊的 TimeField 是「三支 TimeField」之一，退役）。檔名沿用，元件改叫 `ClockField`。
 *
 * 兩態：
 *   沒排時刻  button.tf-show > span.ph「— 不排時刻」：點了才掛出 ClockInput（從「起點」開始：今天＝現在往後取整到 15 分、別天＝09:00）；
 *            起點不算數——按 Enter 才存；動了（打字、±15）就照動過的存；什麼都沒做就離開＝收回「不排時刻」。
 *   有時刻    span.pre 前綴（「本班」「每班」）＋ ClockInput（compact：只留 ±15；側板控制項欄約 220px 放不下四組微調）＋ × 清除。
 * 值的換算（`./clockValue.ts`）：資料是營業日表記 "HH:MM"（"25:00"＝隔天 01:00），ClockInput 吃毫秒；
 *   兩邊都以 `refDay`（這一天＝執行日；定期券本班＝那一班的日子）為基準，存回時算回 "25:00"，營業日語意不壞。
 *   ClockInput 下方的說明行寫這個值的日期，跨到隔天赭字（取代舊欄位的「＝隔天 01:00」小字）。
 * 寫回：ClockInput 每一步（±15、↑↓、打字確定）都叫 onChange；這裡先換畫面、400ms 去抖後才 onCommit（長按連跳不會每一格都寫庫），
 *   離開這一欄、卸載時立刻送出。清除＝×（ClockInput 清空框會還原，不能用來清除）。
 * 鍵盤：Enter＝確定（沒排時刻時＝就用起點）；Esc＝框裡有草稿先還原（ClockInput 自己攔）；沒草稿時——掛出來的輸入態
 *   （起點、或「只改這班…」）收回、不讓側板跟著關；本來就有時刻的那一欄照舊交給側板（Esc 關側板）。
 *
 * 另附只給側板用的小件（同檔）：
 *   TimeSpanField  時刻段的「時段」列「14:00 → 15:30 ×」（回饋甲 D-主-129：開始＋結束兩格 ClockField，結束＝開始＋長度算出來的；
 *                  取代舊的「幾點」列與預計欄右邊的「→ 15:30 着」）
 *   LengthField    「長度」列：分段鈕 15／30／60／90／120＋「自訂…」（取代「分量」段的「預計」數字框）
 *   RunTimeRow     定期券検印段的「本班」列（只改這班…／再改…／改回每班時刻）
 */
import { useEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from "react";
import type { NodeRow } from "../../domain";
import { effectiveTime, isTimeOverridden } from "../../domain/scheduledTime";
import { nextDayNote, todayKey } from "../../lib/date";
import { useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";
import { ClockInput } from "../common/ClockInput";
import { useDebouncedCommit } from "../common/fields";
import { IconClose } from "../common/icons";
import { Segmented } from "../common/Segmented";
import { clockBounds, clockSeed, clockToMs, msToClock, spanEnd, spanEndBounds, spanEndSeed, spanLen } from "./clockValue";
import { LEN_MAX, LEN_PRESETS, lenText, parseLenInput } from "./panelRules";

export interface ClockFieldProps {
  value: string | null;
  /** 值變了才叫；null＝清除 */
  onCommit(v: string | null): void;
  dayStartHour: number;
  /** 這一天（營業日 key）：換算與日期標籤的基準。一定要給——ClockInput 沒給會拿時刻表的檢視日來算 */
  refDay: string;
  ariaLabel: string;
  /** 預設「— 不排時刻」 */
  placeholder?: string;
  /** 前綴小字（.pre）：定期券本班欄「本班」、每班欄「每班」 */
  prefix?: string;
  /** 一掛上就是輸入態（RunTimeRow 按了「只改這班…」才掛出來的那一格） */
  startEditing?: boolean;
  /** 離開輸入態時叫（Enter、Esc、清除、點外面都算）。byKeyboard＝鍵盤離開（要把焦點交給接手的鈕）；點外面為 false */
  onClose?(byKeyboard: boolean): void;
  /** × 的說明（預設「清除時刻＝不排時刻」） */
  clearTitle?: string;
  /** 有沒有 ×（預設有）。時段的結束格不給：清時段＝清開始那一格的 ×，長度另在「長度」列 */
  clearable?: boolean;
  /** 範圍覆寫（毫秒）；不給＝這一天的日界線視窗（clockBounds）。時段的結束格＝開始後一分起 */
  bounds?: { lo: number; hi: number };
  /** 沒排時刻、點下去的起點覆寫（毫秒）；不給＝clockSeed（今天＝現在取整、別天＝09:00） */
  seedMs?: number;
  /** 拿掉 ±15（時段兩格並排，側板控制項欄塞不下四顆微調鈕） */
  noSteps?: boolean;
  /** ClockInput 說明行寫不寫日期（同 ClockInput.dateLabel；預設 true） */
  dateLabel?: boolean | "other";
  /** 接在時刻框之後、× 之前的東西（時段的「→ 結束」）；焦點移進去時先送出這一格去抖中的值 */
  tail?: ReactNode;
}

const DEBOUNCE_MS = 400;

export function ClockField({
  value,
  onCommit,
  dayStartHour,
  refDay,
  ariaLabel,
  placeholder = "— 不排時刻",
  prefix,
  startEditing = false,
  onClose,
  clearTitle = "清除時刻＝不排時刻",
  clearable = true,
  bounds,
  seedMs,
  noSteps = false,
  dateLabel = true,
  tail,
}: ClockFieldProps) {
  const dayBounds = useMemo(() => clockBounds(refDay, dayStartHour), [refDay, dayStartHour]);
  const { lo, hi } = bounds ?? dayBounds;
  const seedNow = () => seedMs ?? clockSeed(refDay, todayKey(dayStartHour), dayStartHour);
  const [editing, setEditing] = useState(startEditing);
  /** 畫面上的值（毫秒）；null＝跟著外面的值走 */
  const [draft, setDraft] = useState<number | null>(null);
  /** 掛出輸入態那一刻的起點（沒排時刻時才用） */
  const [seed, setSeed] = useState<number>(seedNow);
  /** 這一輪輸入態裡動過值沒（沒動過又沒按 Enter＝起點不算數） */
  const touched = useRef(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const tailRef = useRef<HTMLSpanElement>(null);
  const showRef = useRef<HTMLButtonElement>(null);
  const refocusShow = useRef(false);

  const live = useRef({ value, onCommit });
  live.current = { value, onCommit };
  /** 有值在去抖中、還沒送出 */
  const pending = useRef(false);
  const { schedule, flush, cancel } = useDebouncedCommit<string>((t) => {
    pending.current = false;
    if (t !== live.current.value) live.current.onCommit(t);
    else setDraft(null);
  }, DEBOUNCE_MS);

  // 外面的值換了（剛寫回的值回來了、別處改、同步、換一天）：沒有待送的草稿就跟著外面走
  useEffect(() => {
    if (!pending.current) setDraft(null);
  }, [value, refDay]);

  // 收回「不排時刻」之後，鍵盤離開的把焦點交給那顆鈕
  useEffect(() => {
    if (!refocusShow.current || editing || value !== null) return;
    refocusShow.current = false;
    showRef.current?.focus();
  });

  const propMs = value !== null ? clockToMs(value, refDay) : null;
  // 有草稿也算開著：剛寫回、外面的值還沒回來的那一拍，框不能先卸載再掛回（焦點會掉）
  const open = value !== null || editing || draft !== null;
  const shown = draft ?? propMs ?? seed;

  const begin = () => {
    touched.current = false;
    setSeed(seedNow());
    setEditing(true);
  };

  const leave = (byKeyboard: boolean) => {
    flush();
    touched.current = false;
    if (byKeyboard && value === null) refocusShow.current = true;
    setEditing(false);
    onClose?.(byKeyboard);
  };

  const change = (ms: number) => {
    const t = msToClock(ms, refDay);
    if (t === null) return;
    touched.current = true;
    pending.current = true;
    setDraft(ms);
    schedule(t);
  };

  const enter = () => {
    flush();
    // 沒排時刻、沒動過就按 Enter＝就用起點。先把起點留成草稿：寫回的值回來之前框不能卸載（焦點會掉到 body）
    if (live.current.value === null && !touched.current) {
      const t = msToClock(shown, refDay);
      if (t !== null) {
        setDraft(shown);
        onCommit(t);
      }
    }
    if (editing) leave(true);
  };

  const clear = () => {
    cancel();
    pending.current = false;
    setDraft(null);
    touched.current = false;
    if (value !== null) onCommit(null);
    refocusShow.current = true;
    setEditing(false);
    onClose?.(true);
  };

  // 焦點離開整欄（點到外面）：送出去抖中的值；掛出來的輸入態收回
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    const to = e.relatedTarget;
    if (to instanceof Node && wrapRef.current?.contains(to)) {
      // 移到接在後面的那一格（時段的結束）：先把這一格的值送出去，結束格才是照新的開始算
      if (tailRef.current?.contains(to) && !tailRef.current.contains(e.target as Node)) flush();
      return;
    }
    // 有的引擎點按鈕不給焦點（relatedTarget 為空）：下一拍再看焦點是不是還在欄裡
    setTimeout(() => {
      const a = document.activeElement;
      if (a && wrapRef.current?.contains(a)) return;
      if (editing) leave(false);
      else flush();
    }, 0);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    // 接在後面那一格（時段的結束）的鍵自己管，不當成這一格的
    if (tailRef.current?.contains(e.target as Node)) return;
    // ClockInput 有草稿時自己攔 Esc（還原＋stopPropagation），走到這裡＝沒草稿
    if (e.key === "Escape" && editing) {
      e.preventDefault();
      e.stopPropagation();
      leave(true);
    }
  };

  const tailEl = tail !== undefined && (
    <span className="clockf-tail" ref={tailRef}>
      {tail}
    </span>
  );
  const cls = "tf clockf" + (noSteps ? " is-nostep" : "");

  return (
    <div className={cls} ref={wrapRef} onBlur={onBlur} onKeyDown={onKeyDown}>
      {open ? (
        <div className="clockf-row">
          {prefix && <span className="pre">{prefix}</span>}
          <ClockInput
            variant="compact"
            value={shown}
            lo={lo}
            hi={hi}
            onChange={change}
            onEnter={enter}
            label={ariaLabel}
            refDay={refDay}
            autoFocus={editing}
            dateLabel={dateLabel}
            {...(noSteps ? { left: false, right: false } : {})}
          />
          {tailEl}
          {clearable && (
            <button
              type="button"
              className="ns-iconbtn clockf-clear"
              aria-label={value === null ? `取消${ariaLabel}` : `清除${ariaLabel}`}
              title={value === null ? "不排時刻" : clearTitle}
              onClick={clear}
            >
              <IconClose />
            </button>
          )}
        </div>
      ) : (
        (() => {
          const show = (
            <button
              ref={showRef}
              type="button"
              className="tf-show"
              aria-label={`${ariaLabel}：${placeholder.replace(/^—\s*/, "") || "沒有"}（點了就能排）`}
              onClick={begin}
            >
              {prefix && <span className="pre">{prefix}</span>}
              <span className="ph">{placeholder}</span>
            </button>
          );
          // 有接在後面的東西才包一列（不包＝既有 DOM 不動）
          return tailEl ? (
            <div className="clockf-row is-closed">
              {show}
              {tailEl}
            </div>
          ) : (
            show
          );
        })()
      )}
    </div>
  );
}

/**
 * 時段（D-主-129；原型 q3-A）：「14:00 → 15:30 ×」兩格都能打字。資料只有 scheduled_time（開始）＋estimate_min（長度）：
 *   改開始＝整段平移（長度不動，結束跟著走）；改結束＝重算長度；結束等於或早於開始＝ClockInput 打錯規則擋下（範圍從開始後一分起，
 *   說明行寫「要在 …–… 之間」）；× 清開始＝不排時刻（長度保留，「長度」列照舊亮著）。
 *   沒排開始時結束格停用（淡「—」，沒有東西可以算）；有開始、沒長度＝結束格是「—」，點了從開始後 60 分起（同開始格的起點規則：
 *   Enter 才存、動過就存、什麼都沒做就離開＝不存）。
 * 定期券：開始格前綴「每班」（每班時刻；逐班改在検印段「本班」）。兩格都拿掉 ±15、說明行只在跨天時寫日期（側板 220px 放兩格）。
 */
export function TimeSpanField({
  start,
  estimateMin,
  onStart,
  onLen,
  dayStartHour,
  refDay,
  prefix,
}: {
  start: string | null;
  estimateMin: number | null;
  /** 開始改了（null＝清除＝不排時刻） */
  onStart(v: string | null): void;
  /** 結束改了 → 新長度（分） */
  onLen(min: number): void;
  dayStartHour: number;
  refDay: string;
  prefix?: string;
}) {
  const end = spanEnd(start, estimateMin);
  const endBounds = start ? spanEndBounds(start, end, refDay, dayStartHour) : null;
  const tail = (
    <>
      <span className="span-arr" aria-hidden>
        →
      </span>
      {start && endBounds ? (
        <ClockField
          value={end}
          onCommit={(v) => {
            if (v === null) return; // 結束格沒有 ×；清長度在「長度」列
            const len = spanLen(start, v);
            if (len !== null && len !== estimateMin) onLen(len);
          }}
          dayStartHour={dayStartHour}
          refDay={refDay}
          ariaLabel="結束時刻"
          placeholder="—"
          clearable={false}
          bounds={endBounds}
          seedMs={spanEndSeed(endBounds)}
          noSteps
          dateLabel="other"
        />
      ) : (
        <span className="tf-show is-off" title="先排開始時刻">
          <span className="ph">—</span>
        </span>
      )}
    </>
  );
  return (
    <div className="span-field">
      <ClockField
        value={start}
        onCommit={onStart}
        dayStartHour={dayStartHour}
        refDay={refDay}
        ariaLabel="開始時刻"
        placeholder="— 不排"
        prefix={prefix}
        clearTitle="清除時段＝不排時刻（長度保留）"
        noSteps
        dateLabel="other"
        tail={tail}
      />
    </div>
  );
}

/**
 * 長度（D-主-129；原型 q3-A）：分段鈕 15／30／60／90／120（分）＋「自訂…」。值不在分段裡＝分段都不亮、自訂鈕寫「1h30」並亮著。
 * 自訂＝就地換成數字框（分）：Enter／離開就存、Esc 收回不存；空白＝清掉長度；看不懂或 ≤0 不存。上限 panelRules.LEN_MAX。
 * 分段鈕再點選中的那一段不會清掉（Segmented 慣例）；清長度走「自訂…」清空。
 * 手機詳情頁也用這一支（雙端同一份；`compact={false}`，版面在 detail.css）。
 */
export function LengthField({
  value,
  onCommit,
  compact = true,
}: {
  value: number | null;
  onCommit(v: number | null): void;
  /** 緊湊分段鈕（側板）；手機詳情頁傳 false＝44 高、撐滿一列（樣式在 mobile/detail/detail.css 的 .m-dt .len-field） */
  compact?: boolean;
}) {
  const [custom, setCustom] = useState<string | null>(null);
  const composing = useRef(false);
  /** Esc 收回時框會被拆掉、可能再吹一次 blur：這一次不存 */
  const dropped = useRef(false);
  const est = value !== null && value > 0 ? value : null;
  const seg = est !== null && LEN_PRESETS.includes(est) ? String(est) : null;
  const customOn = est !== null && seg === null;

  const done = (raw: string | null) => {
    setCustom(null);
    if (raw === null) return;
    const v = parseLenInput(raw);
    if (v === undefined || v === est) return;
    onCommit(v);
  };

  return (
    <div className="len-field">
      <Segmented
        compact={compact}
        className={compact ? "panel-seg len-seg" : "len-seg"}
        options={LEN_OPTS}
        value={custom === null ? seg : null}
        onChange={(v) => {
          setCustom(null);
          if (Number(v) !== est) onCommit(Number(v));
        }}
        aria-label="長度"
      />
      {custom !== null ? (
        <span className="len-custom-in">
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={LEN_MAX}
            autoFocus
            className="techo-input"
            value={custom}
            placeholder="45"
            aria-label="自訂長度（分）"
            onChange={(e) => setCustom(e.target.value)}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onFocus={() => {
              dropped.current = false;
            }}
            onBlur={(e) => {
              if (dropped.current) {
                dropped.current = false;
                return;
              }
              done(e.currentTarget.value);
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229 || composing.current) return;
              if (e.key === "Enter") {
                e.preventDefault();
                e.currentTarget.blur();
              } else if (e.key === "Escape") {
                // 收回不存（不讓側板跟著關）
                e.preventDefault();
                e.stopPropagation();
                dropped.current = true;
                setCustom(null);
              }
            }}
          />
          <span className="meta">分</span>
        </span>
      ) : (
        <button
          type="button"
          className="len-custom"
          aria-pressed={customOn}
          title={customOn ? "改自訂長度（清空＝不設長度）" : "自訂長度（分）"}
          onClick={() => setCustom(est !== null ? String(est) : "")}
        >
          {customOn && est !== null ? lenText(est) : "自訂…"}
        </button>
      )}
    </div>
  );
}

const LEN_OPTS = LEN_PRESETS.map((n) => ({ value: String(n), label: String(n), title: lenText(n) }));

/**
 * 定期券検印段的「本班」列（契約 §4.2 TeikiStampRow；原型 `:1038-1043`）。
 *   沒覆寫  07:00 照每班　只改這班…
 *   有覆寫  09:30〔＝隔天 …〕只改這班　再改…　改回每班時刻 07:00（覆寫是 null ⇒ 印「不排時刻」）
 * 寫入一律經 store：setRunTime（清除＝null＝本班無時刻，Q4 自決）／clearRunTime（改回每班）。
 */
export function RunTimeRow({ node, date }: { node: NodeRow; date: string }) {
  const setRunTime = useNodeStore((s) => s.setRunTime);
  const clearRunTime = useNodeStore((s) => s.clearRunTime);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const [editing, setEditing] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  /**
   * 鍵盤離開輸入格、或按下「改回每班時刻」（那顆鈕會被換掉）之後，焦點要交給這一列的第一顆連結鈕，鍵盤流才不掉到 body。
   * 用 render 後的 effect 做（不用 rAF：卸載與寫入重畫都在 React 這邊，effect 跑的時候 DOM 已經是新的）。
   */
  const pendingFocus = useRef(false);
  useEffect(() => {
    if (!pendingFocus.current || editing) return;
    const a = document.activeElement;
    const inside = !!a && !!wrapRef.current?.contains(a);
    if (a && a !== document.body && !inside) {
      pendingFocus.current = false; // 焦點已經在別處（例如點了別的欄位）就不搶
      return;
    }
    if (inside && a?.tagName === "BUTTON" && (a as HTMLElement).dataset.keep === "1") return; // 要被換掉的那顆還在，等下一輪
    pendingFocus.current = false;
    wrapRef.current?.querySelector<HTMLElement>("button.linkbtn")?.focus();
  });

  const ruleTime = node.scheduled_time;
  const overridden = isTimeOverridden(node, date);
  const runTime = effectiveTime(node, date);
  const shown = overridden ? runTime : ruleTime;
  const nx = shown ? nextDayNote(shown) : null;

  return (
    <div className="occ">
      <span className="lbl">本班</span>
      <div className="ov-wrap" ref={wrapRef}>
        {editing ? (
          <ClockField
            value={shown}
            onCommit={(v) => {
              // 打回跟每班一樣的時刻＝不必留覆寫：有就刪（之後每班改時刻，這一班跟著走）、沒有就什麼都不做（手機 MobileTimeSheet 同一條）
              if (v === ruleTime) {
                if (overridden) void clearRunTime(node.id, date);
                return;
              }
              void setRunTime(node.id, date, v);
            }}
            dayStartHour={dayStartHour}
            refDay={date}
            ariaLabel="本班時刻"
            prefix="本班"
            startEditing
            onClose={(byKeyboard) => {
              pendingFocus.current = byKeyboard;
              setEditing(false);
            }}
            clearTitle="這班不排時刻（每班時刻不動）"
          />
        ) : (
          <div className="ov">
            <b className={"hm" + (shown ? "" : " none")}>{shown ?? "不排時刻"}</b>
            {nx && <span className="why">＝{nx}</span>}
            <span className={"why" + (overridden ? " on" : "")}>{overridden ? "只改這班" : "照每班"}</span>
            {/* 第一顆連結鈕在「照每班／只改這班」兩態同一個位置、同一個元素（焦點跟著它走，不會因為寫入後換了顆鈕就掉到 body） */}
            <button type="button" className="linkbtn" onClick={() => setEditing(true)}>
              {overridden ? "再改…" : "只改這班…"}
            </button>
            {overridden && (
              <button
                type="button"
                className="linkbtn"
                data-keep="1"
                onClick={() => {
                  pendingFocus.current = true; // 這顆按下去就消失：寫完之後焦點交回第一顆
                  void clearRunTime(node.id, date).then((r) => {
                    if (r && !r.ok) pendingFocus.current = false;
                  });
                }}
              >
                改回每班時刻{ruleTime ? ` ${ruleTime}` : ""}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
