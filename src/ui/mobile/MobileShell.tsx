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
 * 頁面對照的順序刻意是「先判 status、再查表」：registry 裡的 planned 筆不需要各自的元件檔。
 *   並行地基（契約 2026-09-29 §7 M-2）起 switch 換成對照表 `MOBILE_VIEWS`：旅客筆記／時刻表兩格取各線
 *   `src/lines/<line>.mount.tsx` 的 `mobileView`，通車只改各線自己的登記檔（status 在 manifest、元件在 mount），本檔不必碰。
 *   取不到元件就落到今日（＝地基之前 switch 的 default）。
 *
 * 三條功能線的手機全域浮層／浮動鈕（增補 2026-10-05 增補二）：`lineOverlays("mobile")` 依三線固定順序掛在最後，
 *   只有手機入口通車（mobile.status＝open）且有填的線才掛——三線都沒登記時是空陣列，零 DOM 節點。
 *
 * 覆蓋層（<Toast/>／<ConfirmDialog/>）由 App 層兩殼共用掛載，本檔**不**再掛一份（契約 §2.3、§3）。
 *
 * v1.1.5（WP-C；契約 §6.1）：頂帶與頁面之間多一條 `<SyncBanner shell="mobile"/>`（同步告警）。
 *   同樣是 Fragment 的直接子節點、自己 `flex: none`——橫幅出現時擠的是 `.m-page` 的捲動區，頂帶與底部 tab 不動。
 *   放在頂帶**之後**而不是頁面裡：告警跟著 App 走、不跟著頁走，在哪一格 tab 都看得到；
 *   沒加入同步 ⇒ 元件回 null、DOM 零節點。復原碼對話框兩殼共用一份，掛在 App 層（不在這裡）。
 *
 * 售票口線車次①（D-票-20；契約 §2.6 #6）：第五格改售票口，`MOBILE_VIEWS` 多一筆 `ticket`（取售票口線 mount 檔的 `mobileView`）。
 *   `more: MobileMore` 留著——「更多」不在 tab bar 上了，但仍是合法的頁 key，由頂帶右上的 ⋯ 與 `openSyncPage("mobile")` 進。
 *
 * 磨光①（契約 `docs/research/2026-10-20-主線-磨光①手機殼-契約.md` §0-1、§9.1）：掛 Android 返回鍵橋接 `useAndroidBack`
 *   （tab 的派生規則在這裡給；各頁的子頁與面板在自己的檔裡 `useBackLayer`），同步告警之後加一列 `⚠ {error}`（A2）。
 */
import type { ComponentType } from "react";
import { useRef } from "react";
import { useUiStore } from "../../store/uiStore";
import { useNodeStore } from "../../store/nodeStore";
import { MOCK_MODE } from "../../data";
import { useAndroidBack } from "./backStack";
import { mobileTabByKey, type MobileTabKey } from "./tabs";
import { MobileTopBand } from "./MobileTopBand";
import { MobileTabBar } from "./MobileTabBar";
import { ComingSoon } from "./ComingSoon";
import MobileToday from "./MobileToday";
import MobileRouteMap from "./MobileRouteMap";
import MobileMore from "./MobileMore";
import { SyncBanner } from "../common/SyncBanner";
import { LINE_MOUNTS, lineOverlays } from "../../lines/mounts";

/** tab → 頁面元件（planned 的格子先被 ComingSoon 攔下，走不到這裡） */
const MOBILE_VIEWS: Record<MobileTabKey, ComponentType | null> = {
  today: MobileToday,
  routemap: MobileRouteMap,
  more: MobileMore,
  notes: LINE_MOUNTS.notes.mobileView,
  timetable: LINE_MOUNTS.timetable.mobileView,
  ticket: LINE_MOUNTS.ticket.mobileView,
};

function MobilePage({ tabKey }: { tabKey: MobileTabKey }) {
  const tab = mobileTabByKey(tabKey);
  // 未通車的格子一律走 ComingSoon（先判 status，才不必為 planned 筆各開一支空元件）
  if (tab.status === "planned") return <ComingSoon tab={tab} />;
  const View = MOBILE_VIEWS[tab.key] ?? MobileToday;
  return <View />;
}

export default function MobileShell() {
  const tabKey = useUiStore((s) => s.mobileTab);
  const tab = mobileTabByKey(tabKey);
  const error = useNodeStore((s) => s.error);

  // 磨光① A3（契約 §9.1 A-1）：tab 不登記成一層，交給 useAndroidBack 的派生規則——堆疊空時才看。
  //   在今日 ⇒ null（交還 Android）；在「更多」⇒ 回進來前那一格；其他 tab ⇒ 回今日（tab 之間不算歷史，§1.2）。
  //   「進來前那一格」記在本檔的 ref，不動 uiStore（§0-1）；直接開在「更多」（沒有前一格）就回今日。
  const lastTabRef = useRef<MobileTabKey>(tabKey);
  const beforeMoreRef = useRef<MobileTabKey>("today");
  if (lastTabRef.current !== tabKey) {
    if (tabKey === "more") beforeMoreRef.current = lastTabRef.current;
    lastTabRef.current = tabKey;
  }
  useAndroidBack(
    () => {
      // 讀 store 的現值：返回鍵事件可能比 re-render 早到
      const { mobileTab, setMobileTab } = useUiStore.getState();
      if (mobileTab === "today") return null;
      if (mobileTab === "more") return () => setMobileTab(beforeMoreRef.current);
      return () => setMobileTab("today");
    },
    tabKey,
    MOCK_MODE,
  );

  return (
    <>
      <MobileTopBand tab={tab} />
      <SyncBanner shell="mobile" />
      {/* 磨光① A2（契約 §2.2）：同桌機那列，同一個來源與文案；下一次成功載入自己清掉 */}
      {error && (
        <div className="m-error" role="alert">
          ⚠ {error}
        </div>
      )}
      <MobilePage tabKey={tabKey} />
      <MobileTabBar />
      {lineOverlays("mobile").map(({ id, Overlay }) => (
        <Overlay key={id} />
      ))}
    </>
  );
}
