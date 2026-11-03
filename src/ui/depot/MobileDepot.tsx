/**
 * 車庫頁（手機；車庫與回顧 D-主-215～219；原型 `renderPhone`）。
 *
 *   div.m-page.ns-depot.ns-depot-m
 *     ├ 頁首一行摘要（同桌機補述：車庫裡 N 條幹線、M 條路線・済章 K 枚）
 *     ├ DepotBody（同一份內容：書架橫捲、印譜帳一頁一張卡左右滑；年鑑）
 *     └ 記錄簿＝MFullPage 子頁（左上「‹ 車庫」、標題「乘車記錄簿」）＋ RideBook
 * 分頁籤列在頂帶下一列（MobileTopBand 畫 DEPOT_TABS；記錄簿開著時不畫），本頁不再畫一次；搜尋鈕也在頂帶。
 * 返回層："core.depot-book"——MFullPage 先以 kind "full" 推進同一個 id，這裡的 "page" 併進同一層（refcount），返回＝回車庫。
 */
import { useEffect, useLayoutEffect, useRef } from "react";
import { useDepotStore } from "../../store/depotStore";
import { useNodeStore } from "../../store/nodeStore";
import { MFullPage } from "../common/MFullPage";
import { useBackLayer } from "../mobile/backStack";
import { ensureStampDefs } from "../stamps/defs";
import { DepotBody } from "./DepotBody";
import { DepotSummary } from "./depotParts";
import { RideBook } from "./RideBook";
import "./depot.css";

export default function MobileDepot() {
  const bookId = useDepotStore((s) => s.bookId);
  const tab = useDepotStore((s) => s.tab);
  const openBook = useDepotStore((s) => s.openBook);
  const routes = useNodeStore((s) => s.routes);
  const stations = useNodeStore((s) => s.stations);
  const pageRef = useRef<HTMLDivElement>(null);
  const close = () => openBook(null);

  useEffect(() => {
    ensureStampDefs();
  }, []);
  useEffect(() => {
    void useDepotStore.getState().load();
  }, [routes, stations]);
  useBackLayer("core.depot-book", !!bookId, close, "page");

  // 換籤捲回頂
  useLayoutEffect(() => {
    if (pageRef.current) pageRef.current.scrollTop = 0;
  }, [tab]);

  return (
    <div ref={pageRef} className="m-page ns-depot ns-depot-m" aria-label="車庫">
      <p className="ns-depot-sum">
        <DepotSummary className="" />
      </p>
      <DepotBody />
      {bookId && (
        <MFullPage title="乘車記錄簿" left={{ label: "車庫", back: true, onClick: close }} backId="core.depot-book">
          <RideBook routeId={bookId} shell="mobile" onBack={close} />
        </MFullPage>
      )}
    </div>
  );
}
