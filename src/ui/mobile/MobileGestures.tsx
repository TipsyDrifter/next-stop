/**
 * MobileGestures——「更多 › 手勢與長按」（⑧ 自訂快捷鍵的手機那一半；D-主-335）。
 *
 * 桌機在設定〈快捷鍵〉改鍵；手機沒有鍵盤，同一件事的答案是手勢，所以這一頁只回答「手機上有哪些手勢」、不能改。
 * 全集照實盤自程式（`docs/research/2026-11-04-主線-⑧自訂快捷鍵-契約.md` §同類全集）；新增手勢時順手補一列。
 * 形狀零發明：`.m2-page`＋`.m2-back`＋`.m2-sec`／`.m2-sec-title`＋`.m2-block-label`＋`.m2-note`（同備份與同步子頁）。
 */
interface Gesture {
  where: string;
  does: string;
}

const GROUPS: readonly { title: string; items: readonly Gesture[] }[] = [
  {
    title: "車票",
    items: [
      { where: "往右滑", does: "蓋済" },
      { where: "往左滑", does: "推到明天；定期券是本班運休" },
      { where: "長按後放開", does: "進多選，再點別張一起選" },
      { where: "長按後拖動", does: "排順序；行程表拖到別天就是改期" },
    ],
  },
  {
    title: "路線圖",
    items: [
      { where: "長按後拖動", does: "排順序、換層；停在收起來的列上會自動展開" },
      { where: "路線拖進別條幹線", does: "換幹線" },
    ],
  },
  {
    title: "換畫面",
    items: [
      { where: "今日、行程表左右滑", does: "在這兩頁之間換" },
      { where: "售票口左右滑", does: "換清單、月曆、統計、帳戶、願望" },
      { where: "週條左右滑", does: "換週" },
    ],
  },
  {
    title: "售票口與時刻表",
    items: [
      { where: "長按帳戶卡", does: "進帳戶頁" },
      { where: "長按帳戶、願望後拖動", does: "排順序" },
      { where: "時刻表方眼上拖動", does: "選格子，再點分類補記" },
      { where: "時刻表日程長按後拖動", does: "排進預定欄" },
      { where: "通知欄點分類", does: "換車，不用打開 App" },
    ],
  },
  {
    title: "視窗",
    items: [
      { where: "下方面板往下拉", does: "關閉；往上拉是展開" },
      { where: "返回鍵", does: "一層一層退回去" },
    ],
  },
];

export function MobileGestures({ onBack }: { onBack: () => void }) {
  return (
    <div className="m-page m2-page" aria-label="手勢與長按">
      <button type="button" className="m2-back" onClick={onBack}>
        ← 更多
      </button>
      <section className="m2-sec" aria-labelledby="m2-sec-gestures">
        <h2 id="m2-sec-gestures" className="m2-sec-title">
          手勢與長按
        </h2>
        <p className="m2-note">手機沒有鍵盤，這些手勢就是手機的快捷鍵，不用也都有按鈕能做到。桌機的快捷鍵在桌機的設定裡改。</p>
        {GROUPS.map((g) => (
          <div key={g.title} className="m2-block">
            <span className="m2-block-label">{g.title}</span>
            <dl className="m2-gestures">
              {g.items.map((it) => (
                <div key={it.where} className="m2-gesture">
                  <dt>{it.where}</dt>
                  <dd>{it.does}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </section>
    </div>
  );
}
