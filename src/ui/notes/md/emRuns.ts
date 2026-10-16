/**
 * `*斜體*` 的著重號畫法（旅客筆記車次④ D-筆-54：中文沒有真斜體 ⇒ 字下加點；拉丁字仍斜）。
 *
 * CSS 的 `text-emphasis` 對拉丁字母也會逐字打點、`font-style: italic` 對中文只會合成歪斜——兩種都不好看，
 * 所以把 em 裡的字切成「拉丁段」與「其他」：拉丁段畫 `span.lat`（斜體、不打點），其他照 em 的著重號。
 * 拉丁段＝連續的 Basic Latin／Latin-1／Latin Extended 可見字元（中間可夾半形空白），頭尾不含空白。
 * 桌機 MdBody 與手機 MobileMdBody 共用。純函式、零 import。
 */
const RE_LATIN_RUN = /[!-~À-ɏ](?:[ -~ -ɏ]*[!-~À-ɏ])?/g;

export interface EmRun {
  latin: boolean;
  text: string;
}

export function emRuns(text: string): EmRun[] {
  const out: EmRun[] = [];
  let pos = 0;
  RE_LATIN_RUN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE_LATIN_RUN.exec(text))) {
    if (m.index > pos) out.push({ latin: false, text: text.slice(pos, m.index) });
    out.push({ latin: true, text: m[0] });
    pos = m.index + m[0].length;
  }
  if (pos < text.length) out.push({ latin: false, text: text.slice(pos) });
  return out;
}
