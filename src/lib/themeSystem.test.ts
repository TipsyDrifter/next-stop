/**
 * themeSystem.test.ts——v1.34 4A「時光主題配對與依時自動切換」＋ G7「16 色與 #RRGGBB 自訂分類色 ＆ 霞鶩文楷 TC」單元測試。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { SKINS, isSkinId, skinById } from "./themeShop.ts";
import {
  DARK_THEME_OPTIONS,
  DEFAULT_THEME_SYSTEM_CONFIG,
  KAMAKURA_TIME_CACHE_KEY,
  LIGHT_THEME_OPTIONS,
  concreteThemeName,
  darkThemeName,
  hmToMinutes,
  isDaytimeAt,
  isKamakuraDarkAt,
  legacyThemeValueOf,
  lightThemeName,
  nextConfigOnPickTheme,
  nextConfigOnSetDarkPref,
  nextConfigOnSetLightPref,
  nextConfigOnSetMode,
  nextConfigOnTogglePair,
  normalizeThemeHm,
  parseThemeSystemSettings,
  resolveThemeSystem,
  serializeThemeCache,
} from "./themeSystem.ts";
import {
  CATEGORY_COLOR_COUNT,
  CUSTOM_CAT_COLOR_BASE,
  adaptCustomCategoryHex,
  categoryColorCss,
  categoryPickerValue,
  colorSlot,
  decodeCategoryCustomHex,
  encodeCategoryColor,
  normalizeCategoryHex,
  toDayBlockSegments,
  type TimeCategoryRow,
} from "../domain/timetable.ts";
import { buildNoticeState } from "../domain/timetableNotice.ts";
import { buildPinSnapshot } from "../domain/pinSnapshot.ts";
import { buildCsvFiles } from "../domain/dataExport.ts";
import { DOWNLOADABLE_FONTS, downloadableFont, normalizeHandFont } from "./handFonts.ts";

function relLuminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const ch = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255].map((s) =>
    s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

function contrastHex(fg: string, bg: string): number {
  const l1 = relLuminance(fg);
  const l2 = relLuminance(bg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

describe("4A-1 · 自由指定「我的亮色代表主題」與「我的暗色代表主題」", () => {
  test("亮底四選與暗底四選皆完整涵蓋（含水鏡鎌倉·晝／夜），共 16 組配對皆可解析且帶正確 kamakuraRole", () => {
    assert.deepEqual(
      LIGHT_THEME_OPTIONS.map((o) => o.id),
      ["pastel", "techo", "yumemi", "kamakura"],
    );
    assert.deepEqual(
      DARK_THEME_OPTIONS.map((o) => o.id),
      ["galaxy", "sleeper", "moonlight", "kamakura"],
    );
    assert.ok(isSkinId("kamakura"));
    assert.equal(skinById("kamakura")?.dynamic, true);

    for (const l of LIGHT_THEME_OPTIONS) {
      for (const d of DARK_THEME_OPTIONS) {
        const cfg = {
          ...DEFAULT_THEME_SYSTEM_CONFIG,
          mode: "manual" as const,
          lightPref: l.id,
          darkPref: d.id,
          manualPolarity: "light" as const,
        };
        const resLight = resolveThemeSystem(cfg, { systemDark: false, nowMinutes: 1320, kamakuraTime: "night" });
        assert.equal(resLight.dataTheme, "light");
        assert.equal(resLight.activeThemeId, l.id);
        assert.equal(resLight.dataSkin, l.id === "pastel" ? null : l.id);
        assert.equal(resLight.kamakuraRole, l.id === "kamakura" ? "light" : null);

        const toggled = nextConfigOnTogglePair(cfg, false);
        const resDark = resolveThemeSystem(toggled, { systemDark: false, nowMinutes: 600, kamakuraTime: "day" });
        assert.equal(resDark.dataTheme, "dark");
        assert.equal(resDark.activeThemeId, d.id);
        assert.equal(resDark.dataSkin, d.id === "galaxy" ? null : d.id);
        assert.equal(resDark.kamakuraRole, d.id === "kamakura" ? "dark" : null);
      }
    }
  });

  test("旅の手帖 ⇄ 月白 配對一鍵秒切與標籤名稱", () => {
    let cfg = parseThemeSystemSettings({
      mode: "manual",
      lightPref: "techo",
      darkPref: "moonlight",
      manualPolarity: "light",
    });
    assert.equal(lightThemeName(cfg.lightPref), "旅の手帖");
    assert.equal(darkThemeName(cfg.darkPref), "月白");

    let res = resolveThemeSystem(cfg, { systemDark: true, nowMinutes: 1320 });
    assert.deepEqual(res, {
      dataTheme: "light",
      dataSkin: "techo",
      kamakuraRole: null,
      activeThemeId: "techo",
      windowTheme: "light",
    });

    cfg = nextConfigOnTogglePair(cfg, res.dataTheme === "dark");
    res = resolveThemeSystem(cfg, { systemDark: false, nowMinutes: 600 });
    assert.deepEqual(res, {
      dataTheme: "dark",
      dataSkin: "moonlight",
      kamakuraRole: null,
      activeThemeId: "moonlight",
      windowTheme: "dark",
    });

    cfg = nextConfigOnTogglePair(cfg, res.dataTheme === "dark");
    res = resolveThemeSystem(cfg, { systemDark: true, nowMinutes: 1320 });
    assert.equal(res.activeThemeId, "techo");
  });

  test("舊版 v1.33 單一 settings.theme 升級自動保留使用者原選商店主題為代表", () => {
    const fromTecho = parseThemeSystemSettings({ theme: "techo" });
    assert.equal(fromTecho.mode, "manual");
    assert.equal(fromTecho.lightPref, "techo");
    assert.equal(fromTecho.darkPref, "galaxy");
    assert.equal(fromTecho.manualPolarity, "light");

    const fromSleeper = parseThemeSystemSettings({ theme: "sleeper" });
    assert.equal(fromSleeper.mode, "manual");
    assert.equal(fromSleeper.lightPref, "pastel");
    assert.equal(fromSleeper.darkPref, "sleeper");
    assert.equal(fromSleeper.manualPolarity, "dark");

    const fromSys = parseThemeSystemSettings({ theme: "system" });
    assert.equal(fromSys.mode, "system");
    assert.equal(fromSys.lightPref, "pastel");
    assert.equal(fromSys.darkPref, "galaxy");
  });

  test("商店試穿非代表靜態主題後，點日夜切換或更新代表主題即自動回到配對軌道", () => {
    let cfg = parseThemeSystemSettings({
      mode: "manual",
      lightPref: "techo",
      darkPref: "moonlight",
      manualPolarity: "light",
    });
    cfg = nextConfigOnPickTheme(cfg, "yumemi", false);
    assert.equal(cfg.manualOverride, "yumemi");
    assert.equal(resolveThemeSystem(cfg, { systemDark: false, nowMinutes: 600 }).activeThemeId, "yumemi");

    cfg = nextConfigOnTogglePair(cfg, false);
    assert.equal(cfg.manualOverride, null);
    assert.equal(resolveThemeSystem(cfg, { systemDark: false, nowMinutes: 600 }).activeThemeId, "moonlight");

    cfg = nextConfigOnPickTheme(cfg, "yumemi", false);
    cfg = nextConfigOnSetLightPref(cfg, "kamakura");
    assert.equal(cfg.manualOverride, null);
    cfg = nextConfigOnSetDarkPref(cfg, "sleeper");
    assert.equal(cfg.darkPref, "sleeper");
  });
});

describe("4A-2 ＆ 4A×4B 契約 · 四模式自動切換、水鏡駐足時段與 index.html 零閃屏快取", () => {
  test("標準時段（預設 06:30 / 18:30）邊界分秒不差", () => {
    assert.equal(normalizeThemeHm("6:30", "07:00"), "06:30");
    assert.equal(normalizeThemeHm("25:00", "06:30"), "06:30");
    assert.equal(hmToMinutes("06:30"), 390);
    assert.equal(hmToMinutes("18:30"), 1110);

    assert.equal(isDaytimeAt(6 * 60 + 29, "06:30", "18:30"), false);
    assert.equal(isDaytimeAt(6 * 60 + 30, "06:30", "18:30"), true);
    assert.equal(isDaytimeAt(12 * 60, "06:30", "18:30"), true);
    assert.equal(isDaytimeAt(18 * 60 + 29, "06:30", "18:30"), true);
    assert.equal(isDaytimeAt(18 * 60 + 30, "06:30", "18:30"), false);
    assert.equal(isDaytimeAt(0, "06:30", "18:30"), false);
  });

  test("熬夜跨午夜設定（例 08:00 起白晝、01:30 才入夜）正確判定", () => {
    assert.equal(isDaytimeAt(8 * 60, "08:00", "01:30"), true);
    assert.equal(isDaytimeAt(23 * 60 + 45, "08:00", "01:30"), true);
    assert.equal(isDaytimeAt(1 * 60 + 29, "08:00", "01:30"), true);
    assert.equal(isDaytimeAt(1 * 60 + 30, "08:00", "01:30"), false);
    assert.equal(isDaytimeAt(7 * 60 + 59, "08:00", "01:30"), false);
  });

  test("水鏡鎌倉全天候（mode=kamakura）對齊 05:10–18:30 與 kamakuraTime 鎖定時段、代表配對掛載正確 kamakuraRole", () => {
    assert.equal(KAMAKURA_TIME_CACHE_KEY, "ns-kamakura-time");
    // auto 區間 05:10 (310) ～ 18:30 (1110)
    assert.equal(isKamakuraDarkAt(5 * 60 + 9, "auto"), true);
    assert.equal(isKamakuraDarkAt(5 * 60 + 10, "auto"), false);
    assert.equal(isKamakuraDarkAt(6 * 60, null), false); // 06:00 朝霧不與 06:30 互搶
    assert.equal(isKamakuraDarkAt(18 * 60 + 29, "auto"), false);
    assert.equal(isKamakuraDarkAt(18 * 60 + 30, "auto"), true);
    // 手動駐足時段覆寫
    assert.equal(isKamakuraDarkAt(12 * 60, "night"), true);
    assert.equal(isKamakuraDarkAt(23 * 60, "dawn"), false);
    assert.equal(isKamakuraDarkAt(23 * 60, "day"), false);
    assert.equal(isKamakuraDarkAt(23 * 60, "dusk"), false);

    const base = parseThemeSystemSettings({
      mode: "system",
      lightPref: "kamakura",
      darkPref: "sleeper",
      dayStartHm: "07:00",
      nightStartHm: "19:00",
    });

    // system 配對水鏡鎌倉·晝（即使深夜且 kamakuraTime=night，仍維持 light + role="light"）
    const sysLight = resolveThemeSystem(base, { systemDark: false, nowMinutes: 1300, kamakuraTime: "night" });
    assert.deepEqual(sysLight, {
      dataTheme: "light",
      dataSkin: "kamakura",
      kamakuraRole: "light",
      activeThemeId: "kamakura",
      windowTheme: null,
    });
    const sysDark = resolveThemeSystem(base, { systemDark: true, nowMinutes: 600 });
    assert.equal(sysDark.activeThemeId, "sleeper");
    assert.equal(sysDark.kamakuraRole, null);
    assert.equal(legacyThemeValueOf(base, sysDark), "system");

    // schedule 配對
    const sched = nextConfigOnSetMode(base, "schedule", true);
    const schedDay = resolveThemeSystem(sched, { systemDark: true, nowMinutes: 7 * 60, kamakuraTime: "night" });
    assert.equal(schedDay.activeThemeId, "kamakura");
    assert.equal(schedDay.dataTheme, "light");
    assert.equal(schedDay.kamakuraRole, "light");
    assert.equal(resolveThemeSystem(sched, { systemDark: false, nowMinutes: 19 * 60 }).activeThemeId, "sleeper");

    // kamakura 全天候（白天鎖定 night 不被整分打回 light；夜晚鎖定 dusk 維持 light）
    const kama = nextConfigOnSetMode(base, "kamakura", false);
    const kamaLockedNight = resolveThemeSystem(kama, { systemDark: false, nowMinutes: 12 * 60, kamakuraTime: "night" });
    assert.deepEqual(kamaLockedNight, {
      dataTheme: "dark",
      dataSkin: "kamakura",
      kamakuraRole: "full",
      activeThemeId: "kamakura",
      windowTheme: "dark",
    });
    const kamaLockedDusk = resolveThemeSystem(kama, { systemDark: true, nowMinutes: 22 * 60, kamakuraTime: "dusk" });
    assert.deepEqual(kamaLockedDusk, {
      dataTheme: "light",
      dataSkin: "kamakura",
      kamakuraRole: "full",
      activeThemeId: "kamakura",
      windowTheme: "light",
    });
    const kamaAutoDawn = resolveThemeSystem(kama, { systemDark: true, nowMinutes: 5 * 60 + 30, kamakuraTime: "auto" });
    assert.equal(kamaAutoDawn.dataTheme, "light");
    assert.equal(kamaAutoDawn.kamakuraRole, "full");

    assert.equal(concreteThemeName("kamakura", "light"), "水鏡鎌倉·晝");
    assert.equal(concreteThemeName("kamakura", "dark"), "水鏡鎌倉·夜");
  });

  test("index.html 同步啟動腳本真實執行驗證：支援 ns-kamakura-time 鎖定時段與 data-kamakura-role 掛載", () => {
    const html = readFileSync("index.html", "utf8");
    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(scriptMatch, "index.html 應包含開頁同步腳本");
    const inlineScript = scriptMatch[1];

    const runBoot = (storage: Record<string, string>, hour: number, minute: number, prefersDark = false) => {
      const attrs = new Map<string, string>();
      class FakeDate {
        getHours() {
          return hour;
        }
        getMinutes() {
          return minute;
        }
      }
      const ctx = {
        localStorage: {
          getItem: (k: string) => (k in storage ? storage[k] : null),
        },
        Date: FakeDate,
        window: {
          matchMedia: () => ({ matches: prefersDark }),
        },
        document: {
          documentElement: {
            setAttribute: (k: string, v: string) => attrs.set(k, v),
            removeAttribute: (k: string) => attrs.delete(k),
          },
        },
      };
      vm.runInNewContext(inlineScript, ctx);
      return attrs;
    };

    // 1. 白天 12:00 開啟全天候水鏡鎌倉但鎖定「星夜」⇒ 開機直接 dark + full，零閃白
    const lockedNightAttrs = runBoot(
      {
        "ns-theme-config": serializeThemeCache(
          parseThemeSystemSettings({ mode: "kamakura", lightPref: "pastel", darkPref: "galaxy" }),
        ),
        "ns-kamakura-time": "night",
      },
      12,
      0,
    );
    assert.equal(lockedNightAttrs.get("data-theme"), "dark");
    assert.equal(lockedNightAttrs.get("data-skin"), "kamakura");
    assert.equal(lockedNightAttrs.get("data-kamakura-role"), "full");

    // 2. 晚間 21:00 手動亮色配對「水鏡鎌倉·晝」⇒ 開機 light + data-kamakura-role="light"
    const pairedDayAttrs = runBoot(
      {
        "ns-theme-config": serializeThemeCache(
          parseThemeSystemSettings({
            mode: "manual",
            lightPref: "kamakura",
            darkPref: "moonlight",
            manualPolarity: "light",
          }),
        ),
        "ns-kamakura-time": "night",
      },
      21,
      0,
    );
    assert.equal(pairedDayAttrs.get("data-theme"), "light");
    assert.equal(pairedDayAttrs.get("data-skin"), "kamakura");
    assert.equal(pairedDayAttrs.get("data-kamakura-role"), "light");

    // 3. 非水鏡主題不殘留 data-kamakura-role
    const techoAttrs = runBoot(
      {
        "ns-theme-config": serializeThemeCache(
          parseThemeSystemSettings({
            mode: "manual",
            lightPref: "techo",
            darkPref: "moonlight",
            manualPolarity: "light",
          }),
        ),
      },
      10,
      0,
    );
    assert.equal(techoAttrs.get("data-theme"), "light");
    assert.equal(techoAttrs.get("data-skin"), "techo");
    assert.equal(techoAttrs.has("data-kamakura-role"), false);
  });
});

describe("G7-1 · 時刻表 16 色鋼筆墨水色盤、#RRGGBB 自訂色無損編解碼與雙底對比守門", () => {
  test("16 色槽與自訂色碼整數無損編解碼零碰撞，categoryColorCss 回傳 light-dark()", () => {
    assert.equal(CATEGORY_COLOR_COUNT, 16);
    assert.equal(colorSlot(1), 1);
    assert.equal(colorSlot(16), 16);
    assert.equal(colorSlot(17), 1);
    assert.equal(colorSlot(0), 16);

    assert.equal(normalizeCategoryHex("#3A6B8C"), "#3a6b8c");
    assert.equal(normalizeCategoryHex("#abc"), "#aabbcc");
    assert.equal(normalizeCategoryHex("not-a-hex"), null);

    const encBlack = encodeCategoryColor("#000000");
    assert.equal(encBlack, CUSTOM_CAT_COLOR_BASE);
    assert.equal(decodeCategoryCustomHex(encBlack), "#000000");

    const encCustom = encodeCategoryColor("#2e6f7c");
    assert.equal(decodeCategoryCustomHex(encCustom), "#2e6f7c");
    assert.equal(categoryPickerValue(encCustom), "#2e6f7c");
    assert.equal(
      categoryColorCss(encCustom),
      `light-dark(${adaptCustomCategoryHex("#2e6f7c", "light")}, ${adaptCustomCategoryHex("#2e6f7c", "dark")})`,
    );

    assert.equal(decodeCategoryCustomHex(12), null);
    assert.equal(categoryPickerValue(12), 12);
    assert.equal(categoryColorCss(12), "var(--cat-12)");
    assert.equal(categoryColorCss(null, 8), "var(--cat-8)");

    assert.throws(() => encodeCategoryColor("#12345"), RangeError);
  });

  test("極端與常見自訂色在亮／暗雙底對全部主題票紙與 --ns-tt-on-cat 皆通過 WCAG AA 對比守門", () => {
    const samples = [
      "#000000",
      "#ffffff",
      "#ffeb3b",
      "#1a237e",
      "#2b4c7e",
      "#f5dc84",
      "#94b8f0",
      "#ff0000",
      "#00ff00",
      "#0000ff",
    ];
    // 四套亮色主題票紙（含粉彩半透白疊底 #ebe8f5）與實心白字 --ns-tt-on-cat (#ffffff)
    const lightPapers = ["#ebe8f5", "#fbf7ec", "#fff8f9", "#f4f9fd"];
    const lightOnCat = "#ffffff";
    // 四套暗色主題票紙與深字 --ns-tt-on-cat
    const darkPapers = ["#212a40", "#2a2318", "#2b2f35", "#18263f"];
    const darkOnCats = ["#101217", "#1e1913", "#1b1d21", "#0c1423"];

    for (const raw of samples) {
      const lightHex = adaptCustomCategoryHex(raw, "light");
      const darkHex = adaptCustomCategoryHex(raw, "dark");
      const lumL = relLuminance(lightHex);
      const lumD = relLuminance(darkHex);

      assert.ok(lumL >= 0.075 && lumL <= 0.16, `${raw} light ${lightHex} lum=${lumL.toFixed(3)} 超出 [0.075, 0.160]`);
      assert.ok(lumD >= 0.4 && lumD <= 0.6, `${raw} dark ${darkHex} lum=${lumD.toFixed(3)} 超出 [0.400, 0.600]`);

      for (const bg of lightPapers) {
        const cr = contrastHex(lightHex, bg);
        assert.ok(cr >= 4.5, `${raw} light ${lightHex} 對紙 ${bg} 對比 ${cr.toFixed(2)} < 4.5`);
      }
      assert.ok(
        contrastHex(lightHex, lightOnCat) >= 4.5,
        `${raw} light ${lightHex} 對 --ns-tt-on-cat 白字對比不足`,
      );

      for (const bg of darkPapers) {
        const cr = contrastHex(darkHex, bg);
        assert.ok(cr >= 4.5, `${raw} dark ${darkHex} 對暗紙 ${bg} 對比 ${cr.toFixed(2)} < 4.5`);
      }
      for (const fg of darkOnCats) {
        const cr = contrastHex(darkHex, fg);
        assert.ok(cr >= 4.5, `${raw} dark ${darkHex} 對暗底 --ns-tt-on-cat ${fg} 對比 ${cr.toFixed(2)} < 4.5`);
      }
    }
  });

  test("日誌足跡、Android 通知、桌面置頂小窗分取亮暗調適色，且 CSV 匯出保留無損原色碼", () => {
    const rawHex = "#2b4c7e";
    const customIdx = encodeCategoryColor(rawHex);
    const cat: TimeCategoryRow = {
      id: "cat-custom",
      parent_id: "grp-1",
      name: "速寫",
      glyph: "繪",
      color_idx: customIdx,
      position: 0,
      default_min: null,
      archived_at: null,
      account_id: null,
      device_id: null,
      created_at: "2026-11-20T00:00:00.000Z",
      updated_at: "2026-11-20T00:00:00.000Z",
      synced_at: null,
      deleted_at: null,
    };

    const segs = toDayBlockSegments(
      [
        {
          kind: "block",
          span: { id: "b1", categoryId: cat.id, start: 1_000, end: 61_000, ack: false },
          from: 1_000,
          to: 61_000,
          running: false,
          contFromPrev: false,
          contToNext: false,
          zero: false,
        },
      ],
      { [cat.id]: cat },
      {},
    );
    assert.equal(segs[0].colorIdx, customIdx);
    const expectedLight = adaptCustomCategoryHex(rawHex, "light");
    const expectedDark = adaptCustomCategoryHex(rawHex, "dark");
    assert.equal(categoryColorCss(segs[0].colorIdx), `light-dark(${expectedLight}, ${expectedDark})`);

    const notice = buildNoticeState({
      enabled: true,
      tilesEnabled: true,
      longRunEnabled: false,
      running: null,
      catById: { [cat.id]: cat },
      categories: [
        { ...cat, id: "grp-1", parent_id: null, glyph: null },
        cat,
      ],
      recentIds: [cat.id],
      pins: [cat.id],
      globalMaxMin: 0,
    });
    assert.equal(notice.tiles[0].colorLight, expectedLight);
    assert.equal(notice.tiles[0].colorDark, expectedDark);

    const pin = buildPinSnapshot({
      theme: "light",
      left: 2,
      running: null,
      linkLabel: null,
      catById: { [cat.id]: cat },
      categories: [
        { ...cat, id: "grp-1", parent_id: null, glyph: null },
        cat,
      ],
      recentIds: [cat.id],
      pins: [cat.id],
    });
    assert.equal(pin.tiles[0].colorLight, expectedLight);
    assert.equal(pin.tiles[0].colorDark, expectedDark);

    // CSV 匯出維持無損原色碼 #2b4c7e
    const csvFiles = buildCsvFiles(
      "timetable",
      {
        time_categories: [
          { ...cat, id: "grp-1", parent_id: null, name: "生活", glyph: null },
          { ...cat },
        ],
        time_blocks: [],
        time_goals: [],
        time_routines: [],
        time_plans: [],
        time_stat_topics: [],
        tags: [],
        taggings: [],
      },
      { dayStartHour: 6, nodes: [] },
    );
    const catSheet = csvFiles.find((f) => f.path === "分類.csv");
    assert.ok(catSheet, "應產出分類.csv");
    const catCsvText = new TextDecoder().decode(catSheet.bytes);
    assert.ok(catCsvText.includes("#2b4c7e"), "CSV 匯出應保留使用者輸入的無損原色碼 #2b4c7e");
  });
});

describe("G7-2 · 主題商店字型架「霞鶩文楷 TC（lxgw）」規格核對", () => {
  test("DOWNLOADABLE_FONTS 收錄 lxgw 且具備雙來源固定 SHA、SIL OFL 1.1 聲明與正規化支援", () => {
    const lxgw = downloadableFont("lxgw");
    assert.ok(lxgw);
    assert.equal(lxgw.name, "霞鶩文楷 TC");
    assert.equal(lxgw.family, "LXGW WenKai TC");
    assert.equal(lxgw.bytes, 15341148);
    assert.equal(lxgw.sha256, "6662480a3f95b4a90c80b189c679617a48adce3a505118a6af63ce5a482b83fa");
    assert.equal(lxgw.urls.length, 2);
    assert.ok(lxgw.urls[0].includes("raw.githubusercontent.com/lxgw/LxgwWenKaiTC/"));
    assert.ok(lxgw.urls[1].includes("cdn.jsdelivr.net/gh/lxgw/LxgwWenKaiTC@"));
    assert.ok(lxgw.credit.includes("SIL OFL 1.1"));
    assert.equal(normalizeHandFont("lxgw"), "lxgw");
    assert.equal(DOWNLOADABLE_FONTS.length, 2);
    assert.equal(SKINS.length, 5);
  });
});
