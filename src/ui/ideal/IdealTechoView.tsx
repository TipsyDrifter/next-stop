/**
 * 車窓・理想手札（桌機扉頁視圖；第六本第四梯 v1.30；D-主-560～564）。
 *
 *   section.page.ns-ideal-page > .sheet（清單型 848px 置中扉頁寬度）
 *     ├─ PageHeader B 頁名式：眉標 車窓・理想手札／Frontispiece、大標「理想手札」、工具列［＋ 風景卡］［搜尋］
 *     └─ IdealTechoBody
 */
import { useMemo } from "react";
import { aliveIdealCards, aliveReflections } from "../../domain/idealTecho";
import { useIdealStore } from "../../store/idealStore";
import { PageHeader } from "../common/PageHeader";
import { openFullSearch } from "../search/openFullSearch";
import { capsOfHotkey } from "../shell/hotkeys";
import { useHotkeyRevision } from "../shell/useHotkeyRevision";
import { IdealTechoBody } from "./IdealTechoBody";

export function IdealTechoView() {
  useHotkeyRevision();
  const cards = useIdealStore((s) => s.cards);
  const reflections = useIdealStore((s) => s.reflections);
  const openCreateCard = useIdealStore((s) => s.openCreateCard);

  const statsText = useMemo(() => {
    const cLen = aliveIdealCards(cards).length;
    const rLen = aliveReflections(reflections).length;
    return `風景 ${cLen} 幅 ・ 車窗拾光 ${rLen} 則`;
  }, [cards, reflections]);

  return (
    <section className="page ns-ideal-page" tabIndex={-1} aria-label="車窓・理想手札">
      <div className="sheet">
        <PageHeader
          variant="name"
          overline={{ zh: "車窓・理想手札", latin: "Frontispiece" }}
          title="理想手札"
          stats={<span>{statsText}</span>}
          add={{
            label: "風景卡",
            title: "新增一幅終點站的風景",
            onClick: () => openCreateCard(),
          }}
          search={{
            onOpen: () => openFullSearch(),
            title: `搜尋（${capsOfHotkey("global.fullsearch")}）`,
          }}
        />
        <IdealTechoBody shell="desktop" />
      </div>
    </section>
  );
}
