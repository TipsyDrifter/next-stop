/**
 * DateNavTitle——時刻表各視圖給共用 DateNav 的標題（UI 丙-4 D9；T5 席）。
 *   span.ns-tt-dn-text「10/20（一）」＋（有的話）em.ns-tt-dn-tag「今天／昨天／本週／上月…」
 * 期名的小籤原本四個視圖各畫一份（`.ns-tt-{grid,week,stats,sched}-pname em`）；DateNav 換上後收成這一個，
 * 長相在 timetable.css 檔尾〈丙-4 T5〉。字跟著 DateNav 標題（襯線 700），數字等寬——翻頁時 › 與「今天」不跳。
 * 「今天／本週／本月」這種「就是這一期」的小籤不畫：DateNav 自己的「今天」chip 已經說了，兩顆並排像重複（T8 代驗 §3-1）；
 * 「昨天／上週／上月」照畫，那是 chip 說不出的資訊。
 */
const CURRENT_TAGS = new Set(["今天", "本週", "本月", "今年"]);
export function DnTitle({ text, tag }: { text: string; tag?: string | null }) {
  return (
    <>
      <span className="ns-tt-dn-text">{text}</span>
      {tag && !CURRENT_TAGS.has(tag) ? <em className="ns-tt-dn-tag">{tag}</em> : null}
    </>
  );
}
