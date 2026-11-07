/**
 * 主題商店貨架（`src/styles/theme-library.css`）的 token 對帳與文字對比（第三梯 ⑩，D-主-433）。
 * 跑法：`node --test scripts/tests/theme-library.test.ts`（零依賴）。
 *
 * 磨光⑤ 新增 `--color-on-ink` 時庫存三套沒人補，因為庫存沒接線、壞了也看不到。這支把「同類」封起來：
 * 以後 theme.css 暗色區多一個值，四套沒寫齊就會紅。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SKINS } from "../../src/lib/themeShop.ts";

const themeCss = readFileSync("src/styles/theme.css", "utf8");
const libraryCss = readFileSync("src/styles/theme-library.css", "utf8");

/** 去註解後，取出「選擇器含 selector」的每個區塊裡的 --token: value */
function tokensIn(css: string, selector: string): Map<string, string> {
  const out = new Map<string, string>();
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!m[1].split(",").some((s) => s.trim() === selector)) continue;
    for (const d of m[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out.set(d[1], d[2].trim());
  }
  return out;
}

/** 分類盤與荷札牌是資料色、由亮暗底推導，四套直接繼承底的值（D-主-432） */
const INHERITED = /^--(cat-\d|tag-)/;

type Rgba = [number, number, number, number];

function parseColor(raw: string): Rgba {
  const hex = raw.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const rgb = raw.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
  if (rgb) return [+rgb[1], +rgb[2], +rgb[3], rgb[4] === undefined ? 1 : +rgb[4]];
  throw new Error(`解析不了的顏色：${raw}`);
}

function over(fg: Rgba, bg: Rgba): Rgba {
  const a = fg[3];
  return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a), 1];
}

function luminance([r, g, b]: Rgba): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(fg: Rgba, bg: Rgba): number {
  const c = over(fg, bg);
  const [a, b] = [luminance(c), luminance(bg)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

/** [字, 底, 下限]。文字走 AA 4.5；極淡注記與章面（大字）走 3～4 */
const PAIRS: readonly [string, string, number][] = [
  ["--color-ink", "--color-paper", 7],
  ["--color-ink", "--color-paper-high", 7],
  ["--color-ink-soft", "--color-paper", 4.5],
  ["--color-ink-soft", "--color-paper-high", 4.5],
  ["--color-ink-soft", "--color-paper-used", 4.5],
  ["--ink-mid", "--color-paper-high", 4.5],
  ["--color-ink-faint", "--color-paper", 4.5],
  ["--color-ink-faint", "--color-paper-high", 4],
  ["--color-on-ink", "--stamp-ink", 4.5],
  ["--color-on-seal", "--color-seal", 4.5],
  ["--color-seal", "--color-paper-high", 3],
  ["--color-late", "--color-paper-high", 4],
  ["--color-gold-ink", "--color-paper", 4.5],
  ["--color-gold-ink", "--color-paper-high", 4.5],
  ["--accent", "--color-paper-high", 4.5],
  ["--accent-sky", "--color-paper", 4.5],
  ["--color-book-ink", "--color-book", 7],
  ["--cover-muted", "--color-book", 4.5],
  ["--color-gold", "--color-book", 3],
];

const galaxy = tokensIn(themeCss, '[data-theme="dark"]');

describe("theme.css 暗色區的每個值，四套都要寫", () => {
  test("抓得到清單（防 parser 壞掉變成全過）", () => {
    assert.ok(galaxy.has("--color-on-ink"));
    assert.ok(galaxy.has("--stamp-ink"));
    assert.ok(galaxy.size > 40, `只抓到 ${galaxy.size} 條`);
  });
  for (const skin of SKINS) {
    test(skin.name, () => {
      const own = tokensIn(libraryCss, `:root[data-skin="${skin.id}"]`);
      const missing = [...galaxy.keys()].filter((k) => !INHERITED.test(k) && !own.has(k));
      assert.deepEqual(missing, []);
    });
  }
});

describe("文字對比", () => {
  for (const skin of SKINS) {
    const own = tokensIn(libraryCss, `:root[data-skin="${skin.id}"]`);
    test(skin.name, () => {
      const low: string[] = [];
      for (const [fg, bg, min] of PAIRS) {
        const ratio = contrast(parseColor(own.get(fg)!), parseColor(own.get(bg)!));
        if (ratio < min) low.push(`${fg} 對 ${bg}＝${ratio.toFixed(2)}（要 ${min}）`);
      }
      assert.deepEqual(low, []);
    });
  }
});

describe("亮暗底與貨架一致", () => {
  for (const skin of SKINS) {
    test(skin.name, () => {
      const own = tokensIn(libraryCss, `:root[data-skin="${skin.id}"]`);
      const lum = luminance(parseColor(own.get("--color-paper")!));
      assert.equal(lum < 0.2 ? "dark" : "light", skin.base);
    });
  }
  test("每套都有商店縮圖的選擇器", () => {
    for (const skin of SKINS) assert.ok(libraryCss.includes(`.ns-shop-mini[data-skin="${skin.id}"]`), skin.id);
  });
});
