/**
 * kamakuraPalette.test.ts — 水鏡鎌倉 24h 連續天色與水鏡倒影調色盤引擎單元測試
 * 跑法：`node --test src/ui/ambience/kamakuraPalette.test.ts`
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { MoodClock } from "./moodDirector.ts";
import {
  ALL_KAMAKURA_CSS_VARS,
  KAMAKURA_PRESET_MINUTES,
  KamakuraDirector,
  contrastRatio,
  kamakuraCssVarsOf,
  kamakuraPaletteAt,
  kamakuraPhaseAt,
  kamakuraPhaseWeightsAt,
  naturalRainAt,
  parseColorRgba,
  parseKamakuraRole,
  parseKamakuraTime,
  parseKamakuraWeather,
  relativeLuminance,
  resolveKamakuraMinute,
  resolveKamakuraRain,
  type KamakuraActorEvent,
} from "./kamakuraPalette.ts";

/** 與 scripts/tests/theme-library.test.ts 完全對齊的 19 組文字與元件對比度守門 */
const CONTRAST_PAIRS: readonly [string, string, number][] = [
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

const SCENE_COLOR_KEYS = [
  "--km-sky-1",
  "--km-sky-2",
  "--km-sky-3",
  "--km-sky-4",
  "--km-water-1",
  "--km-water-2",
  "--km-water-3",
  "--km-hill-far",
  "--km-hill-mid",
  "--km-hill-near",
  "--km-train-body",
  "--km-train-cream",
  "--km-train-win",
] as const;

const SCENE_NUM_KEYS = [
  "--km-glow-alpha",
  "--km-shimmer-alpha",
  "--km-moon-road",
  "--km-cloud-alpha",
  "--km-mist-alpha",
  "--km-rain-alpha",
  "--km-star-alpha",
  "--km-moon-alpha",
  "--km-town-alpha",
  "--km-train-halo",
  "--km-train-headlight",
] as const;

describe("時段相位判定與 moodStore 設定解析", () => {
  test("四大時段邊界精準對應（朝霧 05:00–07:00、白晝 07:00–16:00、暮色 16:00–18:45、星夜 18:45–05:00）", () => {
    assert.equal(kamakuraPhaseAt(4 * 60 + 59), "night");
    assert.equal(kamakuraPhaseAt(5 * 60), "dawn");
    assert.equal(kamakuraPhaseAt(6 * 60 + 59), "dawn");
    assert.equal(kamakuraPhaseAt(7 * 60), "day");
    assert.equal(kamakuraPhaseAt(15 * 60 + 59), "day");
    assert.equal(kamakuraPhaseAt(16 * 60), "dusk");
    assert.equal(kamakuraPhaseAt(18 * 60 + 44), "dusk");
    assert.equal(kamakuraPhaseAt(18 * 60 + 45), "night");
    assert.equal(kamakuraPhaseAt(23 * 60 + 59), "night");
    assert.equal(kamakuraPhaseAt(0), "night");
    // 跨日與負數正規化
    assert.equal(kamakuraPhaseAt(1440 + 360), "dawn");
    assert.equal(kamakuraPhaseAt(-60), "night");

    // 四幅手繪母圖疊化權重：總和恆為 1、駐足預設精準為 1、相鄰分鐘無跳變
    assert.equal(kamakuraPhaseWeightsAt(KAMAKURA_PRESET_MINUTES.dawn).dawn, 1);
    assert.equal(kamakuraPhaseWeightsAt(KAMAKURA_PRESET_MINUTES.day).day, 1);
    assert.equal(kamakuraPhaseWeightsAt(KAMAKURA_PRESET_MINUTES.dusk).dusk, 1);
    assert.equal(kamakuraPhaseWeightsAt(KAMAKURA_PRESET_MINUTES.night).night, 1);
    for (let m = 0; m < 1440; m++) {
      const w = kamakuraPhaseWeightsAt(m);
      const nw = kamakuraPhaseWeightsAt((m + 1) % 1440);
      const sum = w.dawn + w.day + w.dusk + w.night;
      assert.ok(Math.abs(sum - 1) < 1e-6, `${m}m 權重總和=${sum}`);
      assert.ok(Math.abs(w.dusk - nw.dusk) < 0.04, `${m}m 暮色權重跳變`);
      assert.ok(Math.abs(w.night - nw.night) < 0.04, `${m}m 星夜權重跳變`);
    }
  });

  test("parseKamakuraTime 與 parseKamakuraWeather 容錯解析", () => {
    assert.equal(parseKamakuraTime("auto"), "auto");
    assert.equal(parseKamakuraTime("dawn"), "dawn");
    assert.equal(parseKamakuraTime("day"), "day");
    assert.equal(parseKamakuraTime("dusk"), "dusk");
    assert.equal(parseKamakuraTime("night"), "night");
    assert.equal(parseKamakuraTime(null), "auto");
    assert.equal(parseKamakuraTime(""), "auto");
    assert.equal(parseKamakuraTime("invalid"), "auto");

    assert.equal(parseKamakuraWeather("auto"), "auto");
    assert.equal(parseKamakuraWeather("clear"), "clear");
    assert.equal(parseKamakuraWeather("rain"), "rain");
    assert.equal(parseKamakuraWeather(null), "auto");
    assert.equal(parseKamakuraWeather("storm"), "auto");
  });

  test("parseKamakuraRole ＆ resolveKamakuraMinute 精準對齊 4A×4B data-kamakura-role 契約", () => {
    assert.equal(parseKamakuraRole("light"), "light");
    assert.equal(parseKamakuraRole("dark"), "dark");
    assert.equal(parseKamakuraRole("full"), "full");
    assert.equal(parseKamakuraRole(null), "full");
    assert.equal(parseKamakuraRole("unknown"), "full");

    // role="full"（全天候或未指定）：完整支援 24h 流轉與四段鎖定（含白天鎖定星夜）
    assert.equal(resolveKamakuraMinute("auto", 815, "full"), 815);
    assert.equal(resolveKamakuraMinute("auto", 1380), 1380);
    assert.equal(resolveKamakuraMinute("dawn", 120, "full"), KAMAKURA_PRESET_MINUTES.dawn);
    assert.equal(resolveKamakuraMinute("day", 120, "full"), KAMAKURA_PRESET_MINUTES.day);
    assert.equal(resolveKamakuraMinute("dusk", 120, "full"), KAMAKURA_PRESET_MINUTES.dusk);
    assert.equal(resolveKamakuraMinute("night", 720, "full"), KAMAKURA_PRESET_MINUTES.night);

    // role="light"（水鏡鎌倉·晝代表）：即使在 21:00 或 kamakuraTime="night" 亦絕不落入暗色象限
    assert.equal(resolveKamakuraMinute("auto", 21 * 60, "light"), KAMAKURA_PRESET_MINUTES.day);
    assert.equal(resolveKamakuraMinute("auto", 4 * 60, "light"), KAMAKURA_PRESET_MINUTES.day);
    assert.equal(resolveKamakuraMinute("auto", 5 * 60 + 30, "light"), 5 * 60 + 30);
    assert.equal(resolveKamakuraMinute("auto", 14 * 60, "light"), 14 * 60);
    assert.equal(resolveKamakuraMinute("dawn", 22 * 60, "light"), KAMAKURA_PRESET_MINUTES.dawn);
    assert.equal(resolveKamakuraMinute("dusk", 22 * 60, "light"), KAMAKURA_PRESET_MINUTES.dusk);
    assert.equal(resolveKamakuraMinute("night", 22 * 60, "light"), KAMAKURA_PRESET_MINUTES.day);
    for (let m = 0; m < 1440; m += 15) {
      for (const tm of ["auto", "dawn", "day", "dusk", "night"] as const) {
        const p = kamakuraPaletteAt(resolveKamakuraMinute(tm, m, "light"), 0);
        assert.equal(p.isDark, false, `role=light (${tm}, ${m}m) 必須維持 isDark=false`);
      }
    }

    // role="dark"（水鏡鎌倉·夜代表）：即使在 14:00 或 kamakuraTime="day" 亦一律維持星夜象限
    assert.equal(resolveKamakuraMinute("auto", 14 * 60, "dark"), KAMAKURA_PRESET_MINUTES.night);
    assert.equal(resolveKamakuraMinute("auto", 23 * 60, "dark"), 23 * 60);
    assert.equal(resolveKamakuraMinute("auto", 2 * 60, "dark"), 2 * 60);
    assert.equal(resolveKamakuraMinute("day", 14 * 60, "dark"), KAMAKURA_PRESET_MINUTES.night);
    assert.equal(resolveKamakuraMinute("dusk", 14 * 60, "dark"), KAMAKURA_PRESET_MINUTES.night);
    for (let m = 0; m < 1440; m += 15) {
      for (const tm of ["auto", "dawn", "day", "dusk", "night"] as const) {
        const p = kamakuraPaletteAt(resolveKamakuraMinute(tm, m, "dark"), 0);
        assert.equal(p.isDark, true, `role=dark (${tm}, ${m}m) 必須維持 isDark=true`);
      }
    }
  });

  test("夜間與手機端 --float-blur 低功耗守門", () => {
    const deskDay = kamakuraPaletteAt(12 * 60, 0, { mobile: false });
    const deskNight = kamakuraPaletteAt(22 * 60, 0, { mobile: false });
    const mobDay = kamakuraPaletteAt(12 * 60, 0, { mobile: true });
    const mobNight = kamakuraPaletteAt(22 * 60, 0, { mobile: true });

    assert.notEqual(deskDay.tokens["--float-blur"], "none", "桌機白晝保留溫潤霧面玻璃");
    assert.equal(deskNight.tokens["--float-blur"], "none", "桌機夜間月光票紙停用 backdrop-filter");
    assert.equal(mobDay.tokens["--float-blur"], "none", "手機白晝停用多卡 backdrop-filter");
    assert.equal(mobNight.tokens["--float-blur"], "none", "手機夜間停用多卡 backdrop-filter");
  });
});

describe("24 小時連續插值無 NaN、無越界、無跨午夜跳變", () => {
  test("0..1439 每一分鐘皆無 NaN/undefined，數值皆在 [0, 1] 範圍內且相鄰分鐘平滑連續", () => {
    for (let m = 0; m < 1440; m++) {
      const cur = kamakuraPaletteAt(m, 0);
      const next = kamakuraPaletteAt((m + 1) % 1440, 0);
      const vars = kamakuraCssVarsOf(cur);

      assert.equal(Object.keys(vars).length, ALL_KAMAKURA_CSS_VARS.length);
      for (const [k, v] of Object.entries(vars)) {
        assert.ok(!v.includes("NaN") && !v.includes("undefined"), `${m}m ${k} 出現非法值: ${v}`);
      }

      for (const nk of SCENE_NUM_KEYS) {
        const val = Number(cur.sceneVars[nk]);
        const nextVal = Number(next.sceneVars[nk]);
        assert.ok(Number.isFinite(val) && val >= 0 && val <= 1, `${m}m ${nk}=${val} 越界`);
        assert.ok(Math.abs(val - nextVal) < 0.06, `${m}m→${m + 1}m ${nk} 跳變過大: ${val} -> ${nextVal}`);
      }

      for (const ck of SCENE_COLOR_KEYS) {
        const [r1, g1, b1] = parseColorRgba(cur.sceneVars[ck]);
        const [r2, g2, b2] = parseColorRgba(next.sceneVars[ck]);
        const maxDiff = Math.max(Math.abs(r1 - r2), Math.abs(g1 - g2), Math.abs(b1 - b2));
        assert.ok(maxDiff <= 14, `${m}m→${m + 1}m ${ck} 單分鐘色階跳變過大 (${maxDiff}): ${cur.sceneVars[ck]} -> ${next.sceneVars[ck]}`);
      }
    }
  });

  test("黃昏魔幻暮色（17:35）呈現青檸淡藍→琥珀蛋黃→珊瑚橙紅→晚霞紫紅，星夜呈現群青星月與萬家燈火", () => {
    const dusk = kamakuraPaletteAt(17 * 60 + 35, 0);
    assert.equal(dusk.phase, "dusk");
    const [topR, topG, topB] = parseColorRgba(dusk.sceneVars["--km-sky-1"]);
    const [midR, midG, midB] = parseColorRgba(dusk.sceneVars["--km-sky-2"]);
    const [lowR, lowG, lowB] = parseColorRgba(dusk.sceneVars["--km-sky-3"]);
    const [horR, , horB] = parseColorRgba(dusk.sceneVars["--km-sky-4"]);
    assert.ok(topB > topR && topG > topR, "暮色天頂為青檸淡藍調");
    assert.ok(midR > 210 && midG > 175 && midR > midB, "暮色中上為琥珀蛋黃調");
    assert.ok(lowR > 220 && lowR > lowG && lowG > lowB, "暮色中下為珊瑚橙紅調");
    assert.ok(horR > 160 && horB > 100, "暮色地平線帶晚霞紫紅調");
    assert.ok(Number(dusk.sceneVars["--km-shimmer-alpha"]) >= 0.8, "暮色水面碎金強烈");

    const night = kamakuraPaletteAt(22 * 60, 0);
    assert.equal(night.phase, "night");
    assert.equal(night.isDark, true);
    assert.ok(Number(night.sceneVars["--km-star-alpha"]) > 0.85);
    assert.ok(Number(night.sceneVars["--km-moon-alpha"]) > 0.85);
    assert.ok(Number(night.sceneVars["--km-town-alpha"]) > 0.80);
    assert.ok(Number(night.sceneVars["--km-train-halo"]) > 0.80);
  });
});

describe("晴雨山嵐轉換與自然天象週期", () => {
  test("微雨山嵐模式提高山嵐霧氣、柔和降低星月並轉換為煙雨青灰調", () => {
    const clearDay = kamakuraPaletteAt(12 * 60, 0);
    const rainDay = kamakuraPaletteAt(12 * 60, 1);
    assert.equal(clearDay.weatherLabel, "晴朗水鏡");
    assert.equal(rainDay.weatherLabel, "微雨山嵐");
    assert.ok(Number(rainDay.sceneVars["--km-mist-alpha"]) > Number(clearDay.sceneVars["--km-mist-alpha"]) + 0.4);
    assert.equal(Number(rainDay.sceneVars["--km-rain-alpha"]), 1);

    const clearNight = kamakuraPaletteAt(23 * 60, 0);
    const rainNight = kamakuraPaletteAt(23 * 60, 1);
    assert.ok(Number(rainNight.sceneVars["--km-star-alpha"]) < Number(clearNight.sceneVars["--km-star-alpha"]) * 0.3);
  });

  test("naturalRainAt 隨時間平滑交替晴雨，無越界或劇烈跳動", () => {
    let sawClear = false;
    let sawRain = false;
    for (let t = 0; t < 720; t++) {
      const r = resolveKamakuraRain("auto", t);
      const next = resolveKamakuraRain("auto", t + 1);
      assert.ok(r >= 0 && r <= 1);
      assert.ok(Math.abs(r - next) < 0.08, `t=${t} 晴雨過渡過陡: ${r} -> ${next}`);
      if (r === 0) sawClear = true;
      if (r === 1) sawRain = true;
    }
    assert.ok(sawClear && sawRain, "自然天象週期內同時涵蓋晴朗與微雨山嵐");
    assert.equal(naturalRainAt(Number.NaN), 0);
  });
});

describe("24 小時全時段紙卡與文字 WCAG AA 對比度守門（晴朗／半雨／微雨全覆蓋）", () => {
  test("0..1439 每一分鐘 × 晴雨三態 × 桌機／手機（共 8,640 組）19 對 Token 對比度 100% 達標", () => {
    for (const mobile of [false, true]) {
      for (const rain of [0, 0.5, 1]) {
        for (let m = 0; m < 1440; m++) {
          const p = kamakuraPaletteAt(m, rain, { mobile });
          const t = p.tokens;
          const paperBackdrop = t["--color-paper"];

          if (p.isDark || mobile) {
            assert.equal(t["--float-blur"], "none");
          }

          // 亮暗底極性與紙面明度一致
          const lumPaper = relativeLuminance(parseColorRgba(paperBackdrop));
          assert.equal(lumPaper < 0.2, p.isDark, `${m}m rain=${rain} 紙面明度(${lumPaper.toFixed(3)})與 isDark 不一致`);

          for (const [fgKey, bgKey, minRatio] of CONTRAST_PAIRS) {
            const ratio = contrastRatio(t[fgKey], t[bgKey], paperBackdrop);
            assert.ok(
              ratio >= minRatio,
              `${m}m (${p.phase}, rain=${rain}, mobile=${mobile}) ${fgKey} 對 ${bgKey} 對比度 ${ratio.toFixed(2)} 低於門檻 ${minRatio}`,
            );
          }

          // 透明頁首（PageHeader / TitleBar）壓在天頂 + 頂欄柔霧襯底上亦須清晰易讀（>= 5.0）
          const skyHeadRatio = contrastRatio(
            t["--color-ink"],
            p.sceneVars["--km-head-veil"],
            p.sceneVars["--km-sky-1"],
          );
          assert.ok(
            skyHeadRatio >= 5.0,
            `${m}m (${p.phase}, rain=${rain}) 頁首文字對天頂背景對比度 ${skyHeadRatio.toFixed(2)} 低於 5.0`,
          );
        }
      }
    }
  });
});

describe("KamakuraDirector 低功耗睡眠與儀式觸發", () => {
  function makeClock(rnd = 0.4) {
    let now = 0;
    let idSeq = 0;
    const timers = new Map<number, { due: number; fn: () => void }>();
    const clock: MoodClock = {
      now: () => now,
      setTimeout(fn, ms) {
        idSeq += 1;
        timers.set(idSeq, { due: now + ms, fn });
        return idSeq;
      },
      clearTimeout(id) {
        timers.delete(id as number);
      },
      random: () => rnd,
    };
    const advance = (ms: number) => {
      const target = now + ms;
      for (;;) {
        const next = [...timers.entries()]
          .filter(([, v]) => v.due <= target)
          .sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].due;
        next[1].fn();
      }
      now = target;
    };
    return { clock, advance, pending: () => timers.size };
  }

  const baseParts = { train: true, birds: true, meteor: true, dusk: true };

  test("視窗隱藏／睡眠（setAwake(false)）立即清空所有計時器（armedTimers === 0），喚醒後恢復", () => {
    const c = makeClock(0.3);
    const events: KamakuraActorEvent[] = [];
    const dir = new KamakuraDirector((e) => events.push(e), c.clock);
    dir.configure({
      mode: "both",
      level: "lite",
      parts: baseParts,
      phase: "dusk",
      rainAmount: 0,
      reduced: false,
    });
    assert.ok(dir.armedTimers > 0);

    dir.setAwake(false);
    assert.equal(dir.armedTimers, 0);
    assert.equal(c.pending(), 0);

    c.advance(600_000);
    assert.equal(events.length, 0, "睡眠期間零事件觸發");

    dir.setAwake(true);
    assert.ok(dir.armedTimers > 0);
    c.advance(3_000);
    assert.ok(events.some((e) => e.kind === "train"), "喚醒後開出湖上列車");
  });

  test("prefers-reduced-motion 或 mode=off 時零計時器；蓋済儀式觸發雙節／三節列車與白鷺", () => {
    const cOff = makeClock();
    const dirOff = new KamakuraDirector(() => undefined, cOff.clock);
    dirOff.configure({ mode: "off", level: "lite", parts: baseParts, phase: "day", rainAmount: 0, reduced: false });
    assert.equal(dirOff.armedTimers, 0);

    const cRed = makeClock();
    const dirRed = new KamakuraDirector(() => undefined, cRed.clock);
    dirRed.configure({ mode: "both", level: "mid", parts: baseParts, phase: "day", rainAmount: 0, reduced: true });
    assert.equal(dirRed.armedTimers, 0);

    const cRit = makeClock(0.8);
    const ritEvents: KamakuraActorEvent[] = [];
    const dirRit = new KamakuraDirector((e) => ritEvents.push(e), cRit.clock);
    dirRit.configure({ mode: "ritual", level: "lite", parts: baseParts, phase: "dusk", rainAmount: 0, reduced: false });
    assert.equal(dirRit.armedTimers, 0);
    dirRit.stamped(true);
    assert.equal(ritEvents[0]?.kind, "train");
    if (ritEvents[0]?.kind === "train") assert.equal(ritEvents[0].long, true);
    cRit.advance(700);
    assert.ok(ritEvents.some((e) => e.kind === "life" && e.life === "egret"));
  });
});
