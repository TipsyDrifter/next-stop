/**
 * 售票口線的捕捉目的地（車次①契約 §3.10、§5.4、0-7、0-29；甲席）。
 * 解析在 domain 的 `parseQuickEntry`、存檔在 store 的 `addQuickEntry`；本檔只是登記那一枚票根。
 */
import type { CaptureTargetSpec } from "../../lines/types";
import { useTicketStore } from "../../store/ticketStore";

/** 捕捉框的「記一筆」票根（旅客筆記車次② D-筆-36 的 CaptureTargetSpec；兩殼同一枚） */
export const TICKET_CAPTURE: CaptureTargetSpec = {
  id: "ticket.record",
  label: "記一筆",
  hint: "80 午餐 @現金",
  acceptsRoute: true,
  destLabel: (route) => useTicketStore.getState().quickDestLabel(route),
  save: (input) => useTicketStore.getState().addQuickEntry(input),
};
