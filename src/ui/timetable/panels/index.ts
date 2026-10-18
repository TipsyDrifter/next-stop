/**
 * panels——sheet.kind → 面板元件與標題（車次①a 契約 §5.4；丙席）。
 * 兩個 host（桌機 DesktopSheetHost／手機 MobileSheetHost）共用這張對照表：`sheetTitle` 給標題字串、`SheetPanel` 畫表單本體。
 * 標題規則：depart 依運行中與否；longRun「{分類}已經跑了 {fmtDur}」（live dot 由 host 自己擺）；其餘固定。
 * 車次②（Stage 0-②，甲）：taskCategory「『{任務}』算哪一類？」、link「連到…」（② 契約 §5.13）；兩個面板先是樁。
 */
import { createElement, type ReactElement } from "react";
import { durOf, fmtDur, toSpan } from "../../../domain/timetable";
import { TT_TEXT, useTimetableStore, type TimetableSheet, type TimetableStore } from "../../../store/timetableStore";
import { BlockPanel } from "./BlockPanel";
import { CategoryManagerPanel } from "./CategoryManagerPanel";
import { DepartPanel } from "./DepartPanel";
import { EstimatePanel } from "./EstimatePanel";
import { LinkPanel } from "./LinkPanel";
import { LongRunPanel } from "./LongRunPanel";
import { RestartPanel } from "./RestartPanel";
import { SplitPanel } from "./SplitPanel";
import { TaskCategoryPanel } from "./TaskCategoryPanel";

export type { PanelProps } from "./controls";
export { BlockPanel, CategoryManagerPanel, DepartPanel, EstimatePanel, LinkPanel, LongRunPanel, RestartPanel, SplitPanel, TaskCategoryPanel };

/** ②：linkInfo 選填（host 沒傳就讀 store 現值；taskCategory 的任務名在開面板前已放進 linkInfo） */
type TitleState = Pick<TimetableStore, "running" | "catById" | "dayBlocks" | "todayBlocks" | "weekBlocks"> &
  Partial<Pick<TimetableStore, "linkInfo">>;

/** 面板標題（桌機 DialogShell `title`／手機 `.m-sheet-title`） */
export function sheetTitle(sheet: TimetableSheet, s: TitleState, now: number): string {
  switch (sheet.kind) {
    case "depart":
      return s.running ? "換車——接下來做什麼？" : "発車——接下來做什麼？";
    case "longRun": {
      const b =
        (s.running?.id === sheet.blockId ? s.running : null) ??
        s.dayBlocks.find((x) => x.id === sheet.blockId) ??
        s.todayBlocks.find((x) => x.id === sheet.blockId) ??
        s.weekBlocks.find((x) => x.id === sheet.blockId) ??
        null;
      if (!b) return "其實到幾點？";
      const name = s.catById[b.category_id]?.name ?? "？";
      return `${name}已經跑了 ${fmtDur(durOf(toSpan(b), now))}`;
    }
    case "restart":
      return "改出發時間";
    case "fill":
      return "補記這段時間";
    case "edit":
      return "改這一塊";
    case "split":
      return "切開這一塊";
    case "categories":
      return "分類與設定";
    case "estimate":
      return "這一班的預估";
    case "taskCategory": {
      const info = (s.linkInfo ?? useTimetableStore.getState().linkInfo)[sheet.nodeId];
      return info && !info.missing ? TT_TEXT.TASK_CATEGORY_TITLE(info.name) : "算哪一類？";
    }
    case "link":
      return TT_TEXT.LINK_TITLE;
    default:
      return "";
  }
}

/** sheet.kind → 表單本體 */
export function SheetPanel({ sheet, onDone }: { sheet: TimetableSheet; onDone(): void }): ReactElement {
  switch (sheet.kind) {
    case "depart":
      return createElement(DepartPanel, { onDone });
    case "longRun":
      return createElement(LongRunPanel, { onDone });
    case "restart":
      return createElement(RestartPanel, { onDone });
    case "fill":
    case "edit":
      return createElement(BlockPanel, { onDone });
    case "split":
      return createElement(SplitPanel, { onDone });
    case "categories":
      return createElement(CategoryManagerPanel, { onDone });
    case "estimate":
      return createElement(EstimatePanel, { onDone });
    case "taskCategory":
      return createElement(TaskCategoryPanel, { onDone });
    case "link":
      return createElement(LinkPanel, { onDone });
    default:
      return createElement(DepartPanel, { onDone });
  }
}
