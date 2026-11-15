/**
 * 車窓・理想手札（手機扉頁視圖；第六本第四梯 v1.30；D-主-560～564）。
 *
 * 比照車庫／候車室：底部五格導航不動，從今日頁頂部方針區或「更多 → 站內」進入；
 * 頂帶左側顯示「‹」返回進入前的分頁，Android 實體返回鍵走同一條路。
 */
import { useMemo } from "react";
import { aliveIdealCards, aliveReflections } from "../../domain/idealTecho";
import { useIdealStore } from "../../store/idealStore";
import { IconPlus } from "../common/icons";
import { IdealTechoBody } from "./IdealTechoBody";

export default function MobileIdealTecho() {
  const cards = useIdealStore((s) => s.cards);
  const reflections = useIdealStore((s) => s.reflections);
  const openCreateCard = useIdealStore((s) => s.openCreateCard);

  const statsText = useMemo(() => {
    const cLen = aliveIdealCards(cards).length;
    const rLen = aliveReflections(reflections).length;
    return `風景 ${cLen} 幅 ・ 車窗拾光 ${rLen} 則`;
  }, [cards, reflections]);

  return (
    <div className="m-page ns-ideal-m">
      <div className="ns-ideal-m-toprow">
        <span className="ns-ideal-m-sub">{statsText}</span>
        <button
          type="button"
          className="ns-btn btn-ghost"
          onClick={() => openCreateCard()}
        >
          <IconPlus size={14} /> 風景卡
        </button>
      </div>
      <IdealTechoBody shell="mobile" />
    </div>
  );
}
