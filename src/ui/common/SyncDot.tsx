/**
 * SyncDot——同步狀態的一顆小點（v1.1.1 WP8；兩殼共用）。
 *
 * 拍板依據：決策記錄〈v1.1 開工訪談拍板〉快問「設定『同步』分頁＋**側欄狀態點**＋總開關」
 *           ＋《2026-09-18-v1.1.1-同步地基契約.md》§9.3。
 *
 * 克制度（最重要的一條）：`phase === 'off'`（＝沒加入過同步，或狀態還沒讀到）**整顆不渲染**——
 *   沒加入同步的桌機，視覺上與 v1.1.0 逐像素相同（鐵則「桌機既有行為零改變」）。
 * `paused`（設定好、總開關關著）＝渲染但壓到很淡（評審 S1）：設定還在、修改還在排隊，
 *   點整顆消失會讓人以為同步沒設定過；亮著又像在跑。淡的那一顆剛好說「在這裡，但沒在動」。
 * 形狀：一顆 5px 圓點，沿側欄註記那一行「CTRL 1 · 2 · 3　? 指引」的淡度；色一律 token：
 *   運行中＝金（--color-gold）／停車中＝赭（--color-late）／
 *   信号待ち・改正待ち・**鍵違い**＝朱（--color-seal）。
 *   鍵違い（v1.1.3）＝雲端那份資料用別的密語重建過、這台的密語打不開它；與另外兩個朱點同一件事
 *   ——「停在這裡、等人處理」，所以不另發明第四種色（出路寫在同步籤，不寫在這顆點上）。
 *   **換鑰匙中（v1.1.4）＝金點慢閃**，不是朱：七步是這台自己在跑（中途關掉 App 也會自己接著做完），
 *   沒有任何事要主人做——朱是「等人處理」的語彙，借來說「我在忙」會把人叫到同步籤去找不存在的按鈕。
 *   有動作在飛時慢閃（`prefers-reduced-motion` 一律關掉動畫，換鑰匙那顆也是）。
 * 位置由呼叫端給 class（側欄 `gnav-sync-dot`／手機頂帶 `m-band-sync-dot`），本檔只管語義與色。
 */
import { useSyncStore, syncTitle } from "../../store/syncStore";
import "../../styles/sync.css";

export function SyncDot({ className }: { className?: string }) {
  const status = useSyncStore((s) => s.status);
  const working = useSyncStore((s) => s.working);
  // 未啟用＝不存在（不是變透明——留著會在 DOM 裡被讀屏念到）
  if (!status || status.phase === "off") return null;
  return (
    <span
      className={`ns-sync-dot${className ? ` ${className}` : ""}`}
      data-phase={status.phase}
      data-busy={working ? "1" : undefined}
      title={syncTitle(status)}
      role="img"
      aria-label={syncTitle(status)}
    />
  );
}
