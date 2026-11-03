/**
 * 清單尾的常駐入口與區段標題的「済」開關（回饋甲 D-主-128、131；原型 q2-A `.nsq-addrow`、q4a-A `.nsq-done-chip`）。
 *
 *   QuickAddLauncher  一列淡色「＋ 新增車票…」：點了變成建票列（QuickAddRow），收起後變回來。
 *                     今日（掛到＝無路線、執行日今天）、路線圖（掛到＝這條路線、建成列車）都用它。
 *   DoneToggleChip    區段標題右側一顆選項 chip「済 N・隱藏」／「済 N・顯示」（今日、路線圖兩殼同款）。
 */
import { IconPlus } from "../icons";
import "./quickadd.css";

export interface QuickAddLauncherProps {
  label: string;
  onOpen(): void;
  /** 快捷鍵鍵帽（右側淡字；沒有就不畫） */
  caps?: string;
  /** 加在 li 上 */
  className?: string;
}

/** 清單尾常駐列（收起時的長相）；開著的時候呼叫端改畫 QuickAddRow */
export function QuickAddLauncher({ label, onOpen, caps, className }: QuickAddLauncherProps) {
  return (
    <li className={`ticket-li ns-qa-launch-li${className ? " " + className : ""}`}>
      <button type="button" className="ns-qa-launch" onClick={onOpen}>
        <IconPlus size={15} />
        <span>{label}</span>
        {caps && <span className="k">{caps}</span>}
      </button>
    </li>
  );
}

export interface DoneToggleChipProps {
  /** 已完成幾張（隱藏時＝藏起來的、顯示時＝看得到的） */
  count: number;
  /** 現在已完成是不是顯示著 */
  showing: boolean;
  onToggle(): void;
  /** 加在鈕上（頁面自己的位置微調） */
  className?: string;
}

export function DoneToggleChip({ count, showing, onToggle, className }: DoneToggleChipProps) {
  return (
    <button
      type="button"
      className={`ns-qa-donechip${showing ? " is-on" : ""}${className ? " " + className : ""}`}
      aria-pressed={showing}
      title={showing ? "隱藏已完成" : "顯示已完成"}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onToggle}
    >
      <span className="seal-mini" aria-hidden>
        済
      </span>
      {count}
      <span className="sep" aria-hidden>
        ・
      </span>
      <span className="act">{showing ? "隱藏" : "顯示"}</span>
    </button>
  );
}
