/**
 * 朱肉質感 SVG filter defs（#inkbleed／#inkbleed-fine）——印章家族的共用資源。
 *
 * 逐字取自 prototypes/m3-ext-routemap.html（該檔自述「原件 6a1b98c 逐字」）：
 *   #inkbleed      ＝ 済與角印（延着含退位態）——極小邊緣毛邊＋大尺度淡斑
 *   #inkbleed-fine ＝ 日付印、時刻戳、雙圈事務章等細字細線——毛邊與淡斑各收斂一半，保住可讀
 * 拍板依據：決策記錄〈① 比稿拍板〉2.「朱肉質感＝有」（filter 套済與角印，移植時全頁統一）。
 *
 * 掛載方式：`ensureStampDefs()` 冪等，把 defs 掛在 <body> 尾端一次（id=ns-stamp-defs）。
 * 之所以走命令式而非 React 元件——`filter:url(#inkbleed)` 需要 defs 在文件裡「隨時存在」，
 * 而消費者（大綱的済章、誤點區的延着角印）不一定與任何印章元件同時掛載；
 * 本模組被 DetailPanel 靜態 import ⇒ App 啟動即備妥。整合席若要改成 App.tsx 顯式掛載，
 * 呼叫一次 ensureStampDefs() 即可（重複呼叫無副作用）。
 */

const DEFS_ID = "ns-stamp-defs";

/** 逐字＝m3-ext-routemap.html 的兩檔朱肉 filter（勿改數值，改了就不是原型） */
const DEFS_MARKUP = `
<svg width="0" height="0" aria-hidden="true" focusable="false">
  <filter id="inkbleed" x="-8%" y="-8%" width="116%" height="116%" color-interpolation-filters="sRGB">
    <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="11" result="grain"/>
    <feDisplacementMap in="SourceGraphic" in2="grain" scale="1.3" xChannelSelector="R" yChannelSelector="G" result="rough"/>
    <feTurbulence type="fractalNoise" baseFrequency="0.05" numOctaves="3" seed="4" result="blot"/>
    <feColorMatrix in="blot" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  1.1 0 0 0 0.42" result="blotA"/>
    <feComposite in="rough" in2="blotA" operator="in"/>
  </filter>
  <filter id="inkbleed-fine" x="-8%" y="-8%" width="116%" height="116%" color-interpolation-filters="sRGB">
    <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="11" result="grain"/>
    <feDisplacementMap in="SourceGraphic" in2="grain" scale=".7" xChannelSelector="R" yChannelSelector="G" result="rough"/>
    <feTurbulence type="fractalNoise" baseFrequency="0.05" numOctaves="3" seed="4" result="blot"/>
    <feColorMatrix in="blot" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0.6 0 0 0 0.72" result="blotA"/>
    <feComposite in="rough" in2="blotA" operator="in"/>
  </filter>
</svg>`;

/** 把朱肉 defs 掛進文件（冪等；SSR／無 document 時直接跳過）。 */
export function ensureStampDefs(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(DEFS_ID)) return;
  const host = document.createElement("div");
  host.id = DEFS_ID;
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
  host.innerHTML = DEFS_MARKUP;
  (document.body ?? document.documentElement).appendChild(host);
}

// 模組載入即備妥（本模組由 DetailPanel 靜態 import；App.tsx 啟動就吃到）
ensureStampDefs();
