/**
 * TimeField——側板的「幾點」欄（主線階段②；契約 §4.1、§4.2）。視覺依據＝原型 `prototypes/主線-預定時刻.html`
 * `:381-400`（.tf 一族）、`:1008-1012`（tfHTML）、`:1504-1550`（openTF 的行為）。
 *
 * 兩態：
 *   顯示態  button.tf-show（點了就變輸入態）：span.pre 前綴（「本班」「每班」）＋span.hm 時刻＋span.nx「＝隔天 01:00」；空值 span.ph
 *   輸入態  input.tf-in（文字框，不是 <input type="time">——原生時間框打不出 25:00）＋下方 p.tf-hint **即時**顯示會存成什麼
 *
 * 規則（照契約 §4.1）：
 *   Enter／點外面（blur）＝確定；空字串＝清除（onCommit(null)）；值沒變不叫 onCommit
 *   打錯：Enter ⇒ 還原成上一個已提交的值、整欄抖一下、留在輸入態；blur ⇒ 還原、回顯示態、抖一下
 *   Esc＝取消回顯示態（stopPropagation：不讓側板跟著關）
 *   IME：keydown 先判 isComposing／keyCode 229（三道護欄的第一道；側板鍵盤表遇 editable 整張停用是既有的）
 *   焦點中不吃外部 value（同 fields.tsx NumberField 的 focused 寫法）：打到一半同步進來，輸入框不被洗掉（契約 §7 #10）
 *
 * 另附兩個只給側板用的小件（同檔，免得 TaskFields／RepeatRuleEditor 為了它們多長一段）：
 *   ArrivalNote  「→ 15:30 着（隔天 01:30）」（D-主-12；預計欄右邊）
 *   RunTimeRow   定期券検印段的「本班」列（只改這班…／再改…／改回每班時刻）
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { NodeRow } from "../../domain";
import { effectiveTime, isTimeOverridden, TIME_FORMAT_MSG } from "../../domain/scheduledTime";
import { arrivalClock, clockRange, clockText, nextDayNote, parseClockInput } from "../../lib/date";
import { useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";

export interface TimeFieldProps {
  value: string | null;
  /** 值變了才叫；null＝清除 */
  onCommit(v: string | null): void;
  dayStartHour: number;
  ariaLabel: string;
  /** 預設「— 不排時刻」 */
  placeholder?: string;
  /** 顯示態前綴小字（.pre）：定期券本班欄「本班」、每班欄「每班」 */
  prefix?: string;

  // ── 契約 §4.1 之外、只加不改的選填項（給 RunTimeRow 的「只改這班…」用） ──
  /** 一掛上就是輸入態（按了「只改這班…」才掛出來的那一格） */
  startEditing?: boolean;
  /** 離開輸入態時叫（確定、Esc、blur 都算）；RunTimeRow 用來收回輸入格。byKeyboard＝Enter／Esc 離開（要把焦點交給接手的鈕）；點外面為 false（焦點已經去別處，不搶） */
  onClose?(byKeyboard: boolean): void;
  /** 清空時的提示字（預設「清空＝不排時刻」） */
  clearHint?: string;
}

const pad2 = (n: number) => (n < 10 ? `0${n}` : String(n));

type Verdict =
  | { kind: "clear" }
  | { kind: "ok"; value: string }
  | { kind: "late"; max: string } // 格式對、但超過這一天的最後一分（日界線 06 ⇒ 29:59）
  | { kind: "err" };

/**
 * 判讀草稿。parseClockInput 對「看不懂」與「超出範圍」都回 null；兩者的提示不同（契約 §4.1），
 * 這裡用兩個極端的日界線再問一次來分辨：日界線 0 收 00:00–23:59、日界線 23 收 23:00–46:59（含 0–22 點進位），
 * 只要任一個認得就是「格式對、只是太晚」。不另抄一份解析規則。
 */
function judge(raw: string, dayStartHour: number): Verdict {
  if (raw.trim() === "") return { kind: "clear" };
  const v = parseClockInput(raw, dayStartHour);
  if (v !== null) return { kind: "ok", value: v };
  if (parseClockInput(raw, 0) !== null || parseClockInput(raw, 23) !== null) {
    return { kind: "late", max: clockText(clockRange(dayStartHour).max) ?? "" };
  }
  return { kind: "err" };
}

export function TimeField({
  value,
  onCommit,
  dayStartHour,
  ariaLabel,
  placeholder = "— 不排時刻",
  prefix,
  startEditing = false,
  onClose,
  clearHint = "清空＝不排時刻",
}: TimeFieldProps) {
  const [editing, setEditing] = useState(startEditing);
  const [draft, setDraft] = useState(value ?? "");
  const [shake, setShake] = useState(0);
  const committed = useRef<string | null>(value);
  /** 這一輪輸入已經結束（Enter／Esc 先收掉，緊接著的 blur 不再處理第二次） */
  const settled = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const showRef = useRef<HTMLButtonElement>(null);
  /** 離開輸入態後要不要把焦點還給顯示鈕（鍵盤離開＝要；點外面＝焦點已經去別處了，不搶） */
  const refocus = useRef(false);
  const hintId = useId();

  // 焦點中不吃外部 value：只有顯示態才跟著外部值走
  useEffect(() => {
    if (!editing) committed.current = value;
  }, [value, editing]);

  // 進輸入態：聚焦＋全選（原型 inp.focus(); inp.select()）
  useEffect(() => {
    if (!editing) return;
    settled.current = false;
    const el = inputRef.current;
    if (el) {
      el.focus();
      el.select();
    }
  }, [editing]);

  // 離開輸入態：鍵盤離開的把焦點還給顯示鈕，鍵盤流不斷
  useEffect(() => {
    if (editing || !refocus.current) return;
    refocus.current = false;
    showRef.current?.focus();
  }, [editing]);

  // 抖一下（.3s）：class 掛 320ms 就拿掉，下一次打錯再掛
  useEffect(() => {
    if (!shake) return;
    const t = setTimeout(() => setShake(0), 320);
    return () => clearTimeout(t);
  }, [shake]);

  const open = () => {
    committed.current = value;
    setDraft(value ?? "");
    setEditing(true);
  };

  const leave = (byKeyboard: boolean) => {
    settled.current = true;
    refocus.current = byKeyboard;
    setEditing(false);
    onClose?.(byKeyboard);
  };

  /** 確定；打錯回 false（呼叫端決定要留在輸入態還是離開） */
  const commit = (byKeyboard: boolean): boolean => {
    const r = judge(draft, dayStartHour);
    if (r.kind === "late" || r.kind === "err") return false;
    const next = r.kind === "clear" ? null : r.value;
    leave(byKeyboard);
    if (next !== committed.current) {
      committed.current = next;
      onCommit(next);
    }
    return true;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter") {
      e.preventDefault();
      if (!commit(true)) {
        setDraft(committed.current ?? "");
        setShake((n) => n + 1);
        requestAnimationFrame(() => inputRef.current?.select());
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      leave(true);
    }
  };

  const onBlur = () => {
    if (settled.current) return;
    if (!commit(false)) {
      leave(false);
      setShake((n) => n + 1);
    }
  };

  const nx = value ? nextDayNote(value) : null;

  let hint: ReactNode = null;
  let hintErr = false;
  if (editing) {
    const r = judge(draft, dayStartHour);
    if (r.kind === "clear") hint = clearHint;
    else if (r.kind === "ok") {
      const n = nextDayNote(r.value);
      hint = (
        <>
          會存成 <b className="hm">{r.value}</b>
          {n && `＝${n}`}
        </>
      );
    } else if (r.kind === "late") {
      hintErr = true;
      hint = `最晚到 ${r.max}——再晚就算隔天的班了（日界線 ${pad2(dayStartHour)}:00）`;
    } else {
      hintErr = true;
      hint = TIME_FORMAT_MSG;
    }
  }

  return (
    <div className={"tf" + (shake ? " shake" : "")}>
      {editing ? (
        <input
          ref={inputRef}
          className="tf-in"
          type="text"
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          aria-label={ariaLabel}
          aria-describedby={hintId}
          placeholder="14、1400、14:00…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={onBlur}
        />
      ) : (
        <button
          ref={showRef}
          type="button"
          className="tf-show"
          aria-label={`${ariaLabel}：${value ?? "不排時刻"}（點了就能打字）`}
          onClick={open}
        >
          {value === null ? (
            <span className="ph">{placeholder}</span>
          ) : (
            <>
              {prefix && <span className="pre">{prefix}</span>}
              <span className="hm">{value}</span>
              {nx && <span className="nx">＝{nx}</span>}
            </>
          )}
        </button>
      )}
      <p id={hintId} className={"tf-hint" + (hintErr ? " err" : "")} aria-live="polite">
        {hint}
      </p>
    </div>
  );
}

/**
 * 預計欄右邊的到站時刻（D-主-12）：時刻與預計兩格都有值才出「→ 15:30 着」；跨過 24:00 加「（隔天 01:30）」。
 * 原型 `:1025-1026`。
 */
export function ArrivalNote({ time, estimateMin }: { time: string | null; estimateMin: number | null }) {
  if (!time) return null;
  const at = arrivalClock(time, estimateMin);
  if (!at) return null;
  const nx = nextDayNote(at);
  return (
    <span className="arr">
      → <b className="hm">{at}</b> 着{nx && `（${nx}）`}
    </span>
  );
}

/**
 * 定期券検印段的「本班」列（契約 §4.2 TeikiStampRow；原型 `:1038-1043`）。
 *   沒覆寫  07:00 照每班　只改這班…
 *   有覆寫  09:30〔＝隔天 …〕只改這班　再改…　改回每班時刻 07:00（覆寫是 null ⇒ 印「不排時刻」）
 * 寫入一律經 store：setRunTime（清空＝null＝本班無時刻，Q4 自決）／clearRunTime（改回每班）。
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
          <TimeField
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
            ariaLabel="本班時刻"
            prefix="本班"
            startEditing
            onClose={(byKeyboard) => {
              pendingFocus.current = byKeyboard;
              setEditing(false);
            }}
            clearHint="清空＝這一班不排時刻（每班時刻不動）"
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
