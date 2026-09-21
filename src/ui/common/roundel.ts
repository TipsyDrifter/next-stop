/**
 * 路線圓牌（.roundel）的填色換算——M3 ② 主題換裝收口。
 *
 * 為什麼要換算：路線色在畫面上有兩種身分。
 *   ① 當「字色／線色」用（大綱票根 .stub、側板 .panel-kind）＝飽和本色，壓在淺票紙上剛好。
 *   ② 當「填色圓牌」用（書封路線清單、快速跳轉結果列）＝原型的語彙是**亮盤深字**
 *      （m3-ext-routemap.html：`.roundel{color:#1d1f3a}`，底色吃 --roundel-e1/j/l2 這一組淺色階）。
 * DB 存的是 "var(--route-preset-N)"（＝①的飽和本色），直接拿去當②的圓底，就會變成深字壓深底：
 * 粉彩星空實測只有 2.4–2.6:1 對比，代碼近乎看不見（銀河版的預設盤本來就是淺色，所以只有亮色主題出事）。
 * 故：預設盤 → 換成同一支路線的淺色階 token；使用者自訂的 #hex 沒有淺色階，改用亮度判斷字色保底。
 */

const PRESET_RE = /^var\(--route-preset-([1-4])\)$/;
const HEX_RE = /^#([0-9a-f]{6})$/i;

/** 深色自訂盤上的字色（近白）——只有在自訂色偏暗時才蓋掉 CSS 的深字預設 */
const INK_ON_DARK = "#f1f0fa";

/** sRGB 相對亮度（WCAG 2.x） */
function luminance(hex: string): number {
  const n = parseInt(hex, 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

/**
 * 給 `.roundel` 用的 inline style：填色（＋必要時的字色）。
 * @param color 節點存的路線色："var(--route-preset-N)"／"#rrggbb"／null（＝預設第 4 色）
 */
export function roundelStyle(color: string | null | undefined): { background: string; color?: string } {
  const raw = color ?? "var(--route-preset-4)";
  const preset = raw.match(PRESET_RE);
  if (preset) return { background: `var(--roundel-preset-${preset[1]})` };

  const hex = raw.match(HEX_RE);
  if (hex && luminance(hex[1]) < 0.35) return { background: raw, color: INK_ON_DARK };
  return { background: raw };
}
