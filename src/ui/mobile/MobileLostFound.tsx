/**
 * MobileLostFound——手機「更多 › 最近刪除」子頁（第五本第二梯 ⑦；桌機是設定第六籤）。內容跟桌機同一份 `LostFoundList`，
 * 外殼同備份與還原子頁（`.m-page.m2-page`、「← 更多」）；從雲端備份撿回的全螢幕頁由 MobileMore 掛。
 */
import { LostFoundList } from "../settings/LostFoundList";

export default function MobileLostFound({ onBack }: { onBack: () => void }) {
  return (
    <div className="m-page m2-page" aria-label="最近刪除">
      <button type="button" className="m2-back" onClick={onBack}>
        ← 更多
      </button>
      <section className="m2-sec" aria-labelledby="m2-sec-lostfound">
        <h2 id="m2-sec-lostfound" className="m2-sec-title">
          最近刪除
        </h2>
        <div style={{ height: 10 }} />
        <LostFoundList mobile />
      </section>
    </div>
  );
}
