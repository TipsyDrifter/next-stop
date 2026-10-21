/**
 * DateChip——票面 .meta 內的帶框日期 chip（執行日／締切）＝件一 m3-ext-routemap.html 的 `.chip`／`.chip.late`：
 * 顯示「執行 M/D」「締切 M/D」，過期＝赭字赭框的「原定 M/D」（.chip.late）；
 * 點擊在 chip 下方開共用 DatePicker（anchor 模式；磨光⑤ S8，D-主-54：日期挑選統一成 App 自畫，取代原生 date 欄）：
 * 點一天／Enter＝改日期、「清除」＝移除日期、Esc 或點外面＝不改。沒有日期時的「＋執行日」入口不是原型元素，
 * 由父層放進 hover 才現身的群組。對應 UI Flow 2.0b（日期直改）與決策 D6／D7。
 * 浮層掛 body（列 hover 會 transform 位移，fixed 放在列裡會跟著跑；同 PopMenu）。chip 在挑的時候不卸載，當 anchor。
 */
import { useCallback, useRef, useState } from "react";
import { useUiStore } from "../../store/uiStore";
import { todayKey } from "../../lib/date";
import { DatePicker } from "../common/DatePicker";

export interface DateChipProps {
  value: string | null;
  /** 前綴字（「執行」「締切」「原定」） */
  prefix?: string;
  late?: boolean;
  /** 無日期時的入口文字（不給＝無日期就不顯示） */
  placeholder?: string;
  ariaLabel: string;
  onChange: (value: string | null) => void;
  /** 日期輸入框收起後（鍵盤 Enter／Esc＝"key"，點別處＝"blur"）；父層用來把焦點還給大綱容器 */
  onClose?: (via: "key" | "blur") => void;
}

function mmdd(key: string): string {
  const p = key.split("-");
  return p.length === 3 ? `${Number(p[1])}/${Number(p[2])}` : key;
}

export function DateChip({ value, prefix, late, placeholder, ariaLabel, onChange, onClose }: DateChipProps) {
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const [editing, setEditing] = useState(false);
  const doneRef = useRef(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  /** next：undefined＝不改；null＝移除；via：鍵盤／在卡裡點選＝"key"（父層把焦點還給大綱），點外面＝"blur"（不搶焦點） */
  const finish = (next: string | null | undefined, via: "key" | "blur") => {
    if (doneRef.current) return;
    doneRef.current = true;
    setEditing(false);
    if (next !== undefined && (next || null) !== value) onChange(next || null);
    onClose?.(via);
  };
  const finishRef = useRef(finish);
  finishRef.current = finish;
  // DatePicker 的 onClose 有兩個來源：Esc（鍵盤）與點外面（mousedown）。用 Esc 的 keydown 先打旗標分辨
  const escRef = useRef(false);
  const onPickerClose = useCallback(() => {
    const via = escRef.current ? "key" : "blur";
    escRef.current = false;
    finishRef.current(undefined, via);
  }, []);

  if (!value && !placeholder) return null;

  const empty = !value;
  const today = todayKey(dayStartHour);
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        tabIndex={-1}
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={editing}
        title={late ? "已過期——點擊改日期" : "點擊改日期"}
        onClick={(e) => {
          e.stopPropagation();
          if (editing) {
            finish(undefined, "blur");
            return;
          }
          doneRef.current = false;
          setEditing(true);
        }}
        className={"date" + (empty ? " empty" : " chip" + (late ? " late" : ""))}
      >
        {empty ? placeholder : `${prefix ? `${prefix} ` : ""}${mmdd(value)}`}
      </button>
      {editing && (
        <span
          className="contents"
          onKeyDownCapture={(e) => {
            if (e.key === "Escape" && !e.nativeEvent.isComposing && e.keyCode !== 229) escRef.current = true;
          }}
          // 卡掛在 body，但點擊仍照 React 樹冒泡到列上（列的 onClick 會選取／開側板）——在這裡擋掉
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <DatePicker
            anchor={btnRef.current}
            label={ariaLabel}
            value={value}
            markValue
            quick={[{ label: "今天", day: today }]}
            onPick={(d) => finish(d, "key")}
            onClear={value ? () => finish(null, "key") : undefined}
            onClose={onPickerClose}
          />
        </span>
      )}
    </>
  );
}
