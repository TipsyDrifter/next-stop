/**
 * MobileRouteNotes——手機路線圖「路線抬頭之下、樹之上」的筆記區（旅客筆記車次④契約 §5.5-1、§5.7-1；D-筆-49）。
 *
 * 路線本身在手機沒有唯讀詳情（第一層是清單、第二層抬頭只有名字與済數），所以路線的筆記區另放一塊：
 *   預設收合成一行「筆記 N ›」（0 則＝「筆記 ›」），點開才列 5 則——路線上的筆記可能多，別把樹推下去。
 * 渲染點在核心 `MobileRouteMap.tsx`（插槽 `nodeFields`、kinds 含 route，接縫 #62）；
 *   那裡畫的是同一筆 spec 的 `Mobile`＝`MobileNoteField`，它看到 `node.kind === "route"` 就交給本元件，
 *   列與資料仍由 `MobileNoteField` 給（`children`），本元件只管外框與收合——免得兩份列的寫法。
 * 收合狀態是本地 state：換一條路線（元件以 route id 重掛）或切 tab 回來＝回到收合。
 */
import { useId, useState, type ReactNode } from "react";
import { IconRight } from "./mobileDiaryBits";
import "../notes-mobile.css";

export interface MobileRouteNotesProps {
  /** 含底下節點的筆記總數；null＝還沒載到（只顯示「筆記」） */
  total: number | null;
  /** 展開後的內容（列＋「還有 N 則 →」＋「＋ 記一則」；MobileNoteField 畫） */
  children: ReactNode;
}

export function MobileRouteNotes({ total, children }: MobileRouteNotesProps) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  return (
    <section className={"ns-notes-mroutenotes" + (open ? " open" : "")} aria-label="這條路線的筆記">
      <button
        type="button"
        className="hd"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="l">筆記</span>
        {total ? <span className="n">{total}</span> : null}
        <span className="car" aria-hidden>
          <IconRight size={14} />
        </span>
      </button>
      {open && (
        <div className="bd" id={bodyId}>
          {children}
        </div>
      )}
    </section>
  );
}
