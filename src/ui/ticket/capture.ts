/**
 * 售票口線的捕捉目的地（車次①契約 §3.10、§5.4、0-7、0-29；甲席）。
 * 解析在 domain 的 `parseQuickEntry`、存檔在 store 的 `addQuickEntry`；本檔只是登記那一枚票根。
 * 售票口④（D-票-74；雜項席）：一行裡的 `#名稱` 由 store 抽成荷札（`splitQuickTags`，不進備註）；本檔在 toast 尾巴補
 * 「 · #京都 #大阪」，讓人看得到掛了哪些荷札。
 */
import type { CaptureTargetSpec } from "../../lines/types";
import { splitQuickTags } from "../../domain/ticketTags";
import { useTicketStore } from "../../store/ticketStore";

/** 捕捉框的「記一筆」票根（旅客筆記車次② D-筆-36 的 CaptureTargetSpec；兩殼同一枚） */
export const TICKET_CAPTURE: CaptureTargetSpec = {
  id: "ticket.record",
  label: "記一筆",
  hint: "80 午餐", // ②契約 0-20（N1）：手機票根小字放不下「@現金」
  acceptsRoute: true,
  destLabel: (route) => useTicketStore.getState().quickDestLabel(route),
  save: async (input) => {
    const res = await useTicketStore.getState().addQuickEntry(input);
    const names = splitQuickTags(input.body).names; // 同 store 的抽法（同一支純函式），名稱照第一次出現的寫法
    return names.length ? { ...res, toast: `${res.toast} · ${names.map((n) => `#${n}`).join(" ")}` } : res;
  },
};
