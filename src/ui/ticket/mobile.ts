/**
 * 售票口線・手機入口（車次①契約 §2.0／§2.3；丙席）。
 * mount 檔只 import 本檔；手機頁的真身在 `./mobile/MobileTicketOffice`（與今日頁的 `MobileTicket` 同名不同物，0-32）。
 * 全螢幕表單、帳戶頁、對話框 sheet 都由 MobileTicketOffice 依 store 的 `panel`／`dialog` 自己掛，不另經 mount。
 */
export { MobileTicketOffice } from "./mobile/MobileTicketOffice";
