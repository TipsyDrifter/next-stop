/**
 * MobileSheetHost——手機的面板殼（車次①a 契約 §5.3；丙席）。
 * `store.sheet` → 對應 panel，包進 `div.m-sheet-veil.techo-veil > div.m-sheet.ns-card.ns-tt-sheet`（沿用既有 .m-sheet 骨架）。
 * 關閉＝點暗幕／×／Esc ⇒ `store.closeSheet()`（longRun 面板被這樣關＝「略過」，契約 0-10）。
 * 標題由 `sheetTitle` 給；longRun 前置 live dot。
 */
import { useEffect, useId } from "react";
import { useTimetableStore } from "../../../store/timetableStore";
import { useTagStore } from "../../../store/tagStore";
import { SheetPanel, sheetTitle } from "../panels";
import { useNow } from "../useNow";

export function MobileSheetHost() {
  const sheet = useTimetableStore((s) => s.sheet);
  const running = useTimetableStore((s) => s.running);
  const catById = useTimetableStore((s) => s.catById);
  const dayBlocks = useTimetableStore((s) => s.dayBlocks);
  const todayBlocks = useTimetableStore((s) => s.todayBlocks);
  const weekBlocks = useTimetableStore((s) => s.weekBlocks);
  const closeSheet = useTimetableStore((s) => s.closeSheet);
  const titleId = useId();
  const now = useNow(60_000); // longRun 標題「已經跑了 X」跟著跳（分鐘級；與桌機一致）

  useEffect(() => {
    if (!sheet) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.isComposing || e.keyCode === 229) return;
      // ⑥ 評審後：荷札點選器（旅客筆記的，蓋在面板上）開著時 Esc 不關底下的面板——關了草稿就丟，點選器「完成」交回的名稱也沒人收
      if (useTagStore.getState().picker !== null) return;
      if (e.key === "Escape") {
        e.preventDefault();
        closeSheet();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sheet, closeSheet]);

  if (!sheet) return null;
  const title = sheetTitle(sheet, { running, catById, dayBlocks, todayBlocks, weekBlocks }, now);

  return (
    <div className="m-sheet-veil techo-veil ns-tt-veil" role="presentation" onClick={closeSheet}>
      <div
        className="m-sheet ns-card ns-tt-sheet"
        data-kind={sheet.kind}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ns-tt-sheet-head">
          <p className="m-sheet-title ns-tt-sheet-title" id={titleId}>
            {sheet.kind === "longRun" && <span className="ns-tt-sheet-dot" aria-hidden="true" />}
            {title}
          </p>
          <button type="button" className="ns-close ns-close--sm" aria-label="關閉" onClick={closeSheet}>
            ×
          </button>
        </div>
        <div className="ns-tt-sheet-body">
          <SheetPanel sheet={sheet} onDone={closeSheet} />
        </div>
      </div>
    </div>
  );
}
