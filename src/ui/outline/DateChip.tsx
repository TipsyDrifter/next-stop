/**
 * DateChip——票面 .meta 內的帶框日期 chip（執行日／締切）＝件一 m3-ext-routemap.html 的 `.chip`／`.chip.late`：
 * 顯示「執行 M/D」「締切 M/D」，過期＝赭字赭框的「原定 M/D」（.chip.late）；
 * 點擊換成原生 <input type="date"> 直改（Enter／blur 提交、Esc 取消）。沒有日期時的「＋執行日」入口不是原型元素，
 * 由父層放進 hover 才現身的群組。對應 UI Flow 2.0b（日期直改）與決策 D6／D7。
 * 取捨：用原生日期選擇器（零依賴、鍵盤可用、跟系統語系）；把日期清空再提交＝移除日期。
 */
import { useRef, useState, type KeyboardEvent } from "react";

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
  const [editing, setEditing] = useState(false);
  const doneRef = useRef(false);

  if (!value && !placeholder) return null;

  const finish = (next: string | null | undefined, via: "key" | "blur") => {
    if (doneRef.current) return;
    doneRef.current = true;
    setEditing(false);
    if (next !== undefined && (next || null) !== value) onChange(next || null);
    onClose?.(via);
  };

  if (editing) {
    return (
      <input
        type="date"
        defaultValue={value ?? ""}
        autoFocus
        aria-label={ariaLabel}
        onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            finish(e.currentTarget.value, "key");
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            finish(undefined, "key");
          }
        }}
        onBlur={(e) => finish(e.currentTarget.value, "blur")}
        className="techo-input date-input"
      />
    );
  }

  const empty = !value;
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={ariaLabel}
      title={late ? "已過期——點擊改日期" : "點擊改日期"}
      onClick={(e) => {
        e.stopPropagation();
        doneRef.current = false;
        setEditing(true);
      }}
      className={"date" + (empty ? " empty" : " chip" + (late ? " late" : ""))}
    >
      {empty ? placeholder : `${prefix ? `${prefix} ` : ""}${mmdd(value)}`}
    </button>
  );
}
