/**
 * MobileShell——手機殼的組裝層（v1.1.0；WP1）。
 *
 * 拍板依據：D-1.1-2＋《2026-09-16-v1.1.0-手機殼契約.md》§2.3。
 * 三段直欄（由 App 根 div 的 `[data-shell="mobile"]` flex column 撐開，見 mobile.css WP0 二、四節）：
 *   <MobileTopBand/>（書封色帶，吃 safe-area-inset-top）
 *   ＋ 當前頁（各頁自己畫 `.m-page`＝唯一的捲動容器；今日頁另外在 .m-page 之後掛一條固定輸入列）
 *   ＋ <MobileTabBar/>（5 格 registry，吃 safe-area-inset-bottom）
 *
 * 回 Fragment 不包 wrapper：三段要當根 div 的**直接**子節點，flex column 才分得到高度
 *   （WP0 備了 `.m-shell` 可選 wrapper，這裡用不到就不多一層 DOM）。
 *
 * 頁面對照的順序刻意是「先判 status、再 switch key」：registry 裡的 planned 筆不需要各自的元件檔，
 *   日後 notes／timetable 通車只要改 registry 的 status 並在 switch 補一行（契約 §2.2）。
 *
 * 覆蓋層（<Toast/>／<ConfirmDialog/>）由 App 層兩殼共用掛載，本檔**不**再掛一份（契約 §2.3、§3）。
 *
 * v1.1.5（WP-C；契約 §6.1）：頂帶與頁面之間多一條 `<SyncBanner shell="mobile"/>`（同步告警）。
 *   同樣是 Fragment 的直接子節點、自己 `flex: none`——橫幅出現時擠的是 `.m-page` 的捲動區，頂帶與底部 tab 不動。
 *   放在頂帶**之後**而不是頁面裡：告警跟著 App 走、不跟著頁走，在哪一格 tab 都看得到；
 *   沒加入同步 ⇒ 元件回 null、DOM 零節點。復原碼對話框兩殼共用一份，掛在 App 層（不在這裡）。
 */
import { useUiStore } from "../../store/uiStore";
import { mobileTabByKey, type MobileTabKey } from "./tabs";
import { MobileTopBand } from "./MobileTopBand";
import { MobileTabBar } from "./MobileTabBar";
import { ComingSoon } from "./ComingSoon";
import MobileToday from "./MobileToday";
import MobileRouteMap from "./MobileRouteMap";
import MobileMore from "./MobileMore";
import { SyncBanner } from "../common/SyncBanner";

function MobilePage({ tabKey }: { tabKey: MobileTabKey }) {
  const tab = mobileTabByKey(tabKey);
  // 未通車的格子一律走 ComingSoon（先判 status，才不必為 planned 筆各開一支空元件）
  if (tab.status === "planned") return <ComingSoon tab={tab} />;
  switch (tab.key) {
    case "routemap":
      return <MobileRouteMap />;
    case "more":
      return <MobileMore />;
    default:
      return <MobileToday />;
  }
}

export default function MobileShell() {
  const tabKey = useUiStore((s) => s.mobileTab);
  const tab = mobileTabByKey(tabKey);

  return (
    <>
      <MobileTopBand tab={tab} />
      <SyncBanner shell="mobile" />
      <MobilePage tabKey={tabKey} />
      <MobileTabBar />
    </>
  );
}
