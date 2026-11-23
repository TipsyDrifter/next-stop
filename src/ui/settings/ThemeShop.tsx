/**
 * ThemeShop——主題與手寫字型商店（第三梯 ⑩ D-主-435 ＋ v1.34 4A 代表主題配對 ＋ G7-2 霞鶩文楷 TC）。
 * 桌機在設定〈一般〉換頁、手機是「更多」的子頁，兩端同一份本體。
 * - 點擊卡片主體：立即穿戴該主題（水鏡鎌倉啟動全天候 24h 流轉）。
 * - 卡片下方代表徽章鈕：一鍵指定為「☀ 亮色代表」或「🌙 暗色代表」（水鏡鎌倉兩邊皆可指定），供頂欄日夜鈕與自動切換配對使用。
 * - 縮圖不是截圖：`.ns-shop-mini[data-skin]`／`[data-theme]` 就地掛真實 CSS token 繪製。
 */
import { useMemo, useState } from "react";
import { useUiStore } from "../../store/uiStore";
import { useHandFontStore } from "../../store/handFontStore";
import { SKINS, skinById, type SkinId } from "../../lib/themeShop";
import {
  DARK_THEME_OPTIONS,
  LIGHT_THEME_OPTIONS,
  darkThemeName,
  lightThemeName,
  type ConcreteThemeId,
  type DarkThemeId,
  type LightThemeId,
  type ThemeMode,
} from "../../lib/themeSystem";
import { DOWNLOADABLE_FONTS, type DownloadableFont } from "../../lib/handFonts";
import { clockForDay } from "../../domain/reminders";
import { MIN, fmtClock } from "../../domain/timetable";
import { clockInstant, dayWindow, todayKey } from "../../lib/date";
import { ClockInput } from "../common/ClockInput";
import { Segmented, type SegmentedOption } from "../common/Segmented";
import { openLink } from "../notes/openLink";
import chenyuSample from "../../assets/fonts/chenyu-sample.png";
import lxgwSample from "../../assets/fonts/lxgw-sample.png";
import "./themeShop.css";

const DEFAULT_SAMPLE = "今天也搭上下一班車";
const SAMPLE_IMAGE: Record<string, string> = {
  chenyu: chenyuSample,
  lxgw: lxgwSample,
};

interface ShelfCardSpec {
  id: ConcreteThemeId;
  name: string;
  latin: string;
  note: string;
  skinAttr?: SkinId;
  themeAttr: "light" | "dark";
  dynamic?: boolean;
  canBeLightRep?: LightThemeId;
  canBeDarkRep?: DarkThemeId;
}

const STATIC_SHELF: readonly ShelfCardSpec[] = [
  {
    id: "pastel",
    name: "粉彩星空",
    latin: "Pastel Starry",
    note: "內建預設・朧月的月台",
    themeAttr: "light",
    canBeLightRep: "pastel",
  },
  {
    id: "galaxy",
    name: "銀河鐵道",
    latin: "Galaxy Platform",
    note: "內建預設・深夜星河月台",
    themeAttr: "dark",
    canBeDarkRep: "galaxy",
  },
  ...SKINS.filter((s) => !s.dynamic).map(
    (s): ShelfCardSpec => ({
      id: s.id,
      name: s.name,
      latin: s.latin,
      note: s.note,
      skinAttr: s.id,
      themeAttr: s.base,
      canBeLightRep: s.base === "light" ? (s.id as LightThemeId) : undefined,
      canBeDarkRep: s.base === "dark" ? (s.id as DarkThemeId) : undefined,
    }),
  ),
];

function MiniPreview({ skinAttr, themeAttr }: { skinAttr?: SkinId; themeAttr: "light" | "dark" }) {
  return (
    <span className="ns-shop-mini" data-skin={skinAttr} data-theme={themeAttr} aria-hidden="true">
      <span className="ns-shop-mini-book" />
      <span className="ns-shop-mini-page">
        <span className="ns-shop-mini-ticket">
          <span className="ns-shop-mini-line" />
          <span className="ns-shop-mini-line is-short" />
          <span className="ns-shop-mini-seal">済</span>
        </span>
        <span className="ns-shop-mini-btn">到着</span>
      </span>
    </span>
  );
}

function KamakuraHeroCard() {
  const kamakura = SKINS.find((s) => s.id === "kamakura")!;
  const activeTheme = useUiStore((s) => s.theme);
  const cfg = useUiStore((s) => s.themeConfig);
  const setTheme = useUiStore((s) => s.setTheme);
  const setLightPref = useUiStore((s) => s.setLightThemePref);
  const setDarkPref = useUiStore((s) => s.setDarkThemePref);

  const on = activeTheme === "kamakura";
  const isLightRep = cfg.lightPref === "kamakura";
  const isDarkRep = cfg.darkPref === "kamakura";

  return (
    <article className={"ns-shop-card is-wide" + (on ? " is-on" : "")}>
      <button
        type="button"
        className="ns-shop-card-hit"
        aria-pressed={on}
        onClick={() => void setTheme("kamakura")}
      >
        <span className="ns-shop-mini-split" aria-hidden="true">
          <MiniPreview skinAttr="kamakura" themeAttr="light" />
          <MiniPreview skinAttr="kamakura" themeAttr="dark" />
        </span>
        <span className="ns-shop-card-head">
          <span className="ns-shop-card-name">{kamakura.name}</span>
          <span className="ns-shop-card-latin">24H DYNAMIC · {kamakura.latin}</span>
        </span>
        <span className="ns-shop-card-note">
          {cfg.mode === "kamakura" ? "全天候流轉使用中" : on ? "使用中" : kamakura.note}
        </span>
      </button>
      <div className="ns-shop-card-reps">
        <button
          type="button"
          className={"chip ns-chip" + (isLightRep ? " is-on" : "")}
          aria-pressed={isLightRep}
          onClick={() => void setLightPref("kamakura")}
          title="將「水鏡鎌倉·晝」設為我的亮色代表主題"
        >
          {isLightRep ? "☀ 亮色代表" : "設為 ☀ 亮色代表"}
        </button>
        <button
          type="button"
          className={"chip ns-chip" + (isDarkRep ? " is-on" : "")}
          aria-pressed={isDarkRep}
          onClick={() => void setDarkPref("kamakura")}
          title="將「水鏡鎌倉·夜」設為我的暗色代表主題"
        >
          {isDarkRep ? "🌙 暗色代表" : "設為 🌙 暗色代表"}
        </button>
      </div>
    </article>
  );
}

function ShelfCard({ spec }: { spec: ShelfCardSpec }) {
  const activeTheme = useUiStore((s) => s.theme);
  const cfg = useUiStore((s) => s.themeConfig);
  const setTheme = useUiStore((s) => s.setTheme);
  const setLightPref = useUiStore((s) => s.setLightThemePref);
  const setDarkPref = useUiStore((s) => s.setDarkThemePref);

  const on = activeTheme === spec.id;
  const isLightRep = spec.canBeLightRep !== undefined && cfg.lightPref === spec.canBeLightRep;
  const isDarkRep = spec.canBeDarkRep !== undefined && cfg.darkPref === spec.canBeDarkRep;

  return (
    <article className={"ns-shop-card" + (on ? " is-on" : "")}>
      <button
        type="button"
        className="ns-shop-card-hit"
        aria-pressed={on}
        onClick={() => void setTheme(spec.id)}
      >
        <MiniPreview skinAttr={spec.skinAttr} themeAttr={spec.themeAttr} />
        <span className="ns-shop-card-head">
          <span className="ns-shop-card-name">{spec.name}</span>
          <span className="ns-shop-card-latin">{spec.latin}</span>
        </span>
        <span className="ns-shop-card-note">{on ? "使用中" : spec.note}</span>
      </button>
      <div className="ns-shop-card-reps">
        {spec.canBeLightRep && (
          <button
            type="button"
            className={"chip ns-chip" + (isLightRep ? " is-on" : "")}
            aria-pressed={isLightRep}
            onClick={() => void setLightPref(spec.canBeLightRep!)}
          >
            {isLightRep ? "☀ 亮色代表" : "設為 ☀ 亮色代表"}
          </button>
        )}
        {spec.canBeDarkRep && (
          <button
            type="button"
            className={"chip ns-chip" + (isDarkRep ? " is-on" : "")}
            aria-pressed={isDarkRep}
            onClick={() => void setDarkPref(spec.canBeDarkRep!)}
          >
            {isDarkRep ? "🌙 暗色代表" : "設為 🌙 暗色代表"}
          </button>
        )}
      </div>
    </article>
  );
}

function FontRow({ font }: { font: DownloadableFont }) {
  const active = useHandFontStore((s) => s.active === font.id);
  const ready = useHandFontStore((s) => s.downloaded.includes(font.id));
  const progress = useHandFontStore((s) => (s.progress?.id === font.id ? s.progress.ratio : null));
  const error = useHandFontStore((s) => (s.error?.id === font.id ? s.error.kind : null));
  const use = useHandFontStore((s) => s.use);
  const remove = useHandFontStore((s) => s.remove);
  const busy = progress !== null;
  const sampleText = font.sample ?? DEFAULT_SAMPLE;

  return (
    <div className={"ns-shop-font" + (active ? " is-on" : "")}>
      <div className="ns-shop-font-main">
        <span className="ns-shop-font-name">{font.name}</span>
        {ready ? (
          <span className="ns-shop-font-sample" style={{ fontFamily: `"${font.family}", var(--font-hand)` }}>
            {sampleText}
          </span>
        ) : (
          <img className="ns-shop-font-img" src={SAMPLE_IMAGE[font.id]} alt={sampleText} />
        )}
        {font.note && <span className="ns-shop-font-note">{font.note}</span>}
        <span className="ns-shop-font-credit">
          {font.credit}
          <button type="button" className="ns-shop-font-link" onClick={() => void openLink(font.licenseUrl)}>
            授權
          </button>
        </span>
        {error && (
          <span className="ns-shop-font-error" role="alert">
            {error === "network" ? "下載失敗，請確認網路後再試一次" : "下載到的檔案不對，沒有存下來"}
          </span>
        )}
      </div>
      <div className="ns-shop-font-acts">
        {active ? (
          <span className="ns-shop-font-state">使用中</span>
        ) : (
          <button type="button" className="btn-ghost ns-btn" disabled={busy} onClick={() => void use(font.id)}>
            {busy ? `正在下載 ${Math.round((progress ?? 0) * 100)}%` : ready ? "使用" : "下載並使用"}
          </button>
        )}
        {ready ? (
          <button type="button" className="ns-shop-font-link" onClick={() => void remove(font.id)}>
            刪除檔案
          </button>
        ) : (
          !busy && <span className="ns-shop-font-size">{(font.bytes / 1e6).toFixed(1)} MB</span>
        )}
      </div>
    </div>
  );
}

export function ThemeShop({ backLabel, backClassName, onBack }: { backLabel: string; backClassName: string; onBack: () => void }) {
  const cfg = useUiStore((s) => s.themeConfig);
  const togglePair = useUiStore((s) => s.toggleThemePair);
  const resolvedDark = useUiStore((s) => s.resolvedDark);
  const iansuiActive = useHandFontStore((s) => s.active === "iansui");
  const useFont = useHandFontStore((s) => s.use);

  return (
    <div className="ns-shop">
      <button type="button" className={backClassName} onClick={onBack}>
        ← {backLabel}
      </button>

      <section>
        <span className="techo-label block mb-2.5">主題與日夜配對</span>
        <div className="ns-shop-pairbar mb-3">
          <div className="ns-shop-pairbar-items">
            <span className="ns-shop-pairbar-item">
              ☀ 亮色代表：<b>{lightThemeName(cfg.lightPref)}</b>
            </span>
            <span className="ns-shop-pairbar-item">
              🌙 暗色代表：<b>{darkThemeName(cfg.darkPref)}</b>
            </span>
          </div>
          <button
            type="button"
            className="btn-ghost ns-btn ns-btn--sm"
            onClick={() => void togglePair()}
          >
            {resolvedDark ? `切至 ☀ ${lightThemeName(cfg.lightPref)}` : `切至 🌙 ${darkThemeName(cfg.darkPref)}`}
          </button>
        </div>

        <div className="ns-shop-grid" aria-label="主題貨架">
          <KamakuraHeroCard />
          {STATIC_SHELF.map((spec) => (
            <ShelfCard key={spec.id} spec={spec} />
          ))}
        </div>
      </section>

      <section>
        <span className="techo-label block mb-2.5">手寫字型</span>
        <div className={"ns-shop-font" + (iansuiActive ? " is-on" : "")}>
          <div className="ns-shop-font-main">
            <span className="ns-shop-font-name">芫荽</span>
            <span className="ns-shop-font-sample" style={{ fontFamily: '"Iansui"' }}>
              {DEFAULT_SAMPLE}
            </span>
            <span className="ns-shop-font-credit">內建</span>
          </div>
          <div className="ns-shop-font-acts">
            {iansuiActive ? (
              <span className="ns-shop-font-state">使用中</span>
            ) : (
              <button type="button" className="btn-ghost ns-btn" onClick={() => void useFont("iansui")}>
                使用
              </button>
            )}
          </div>
        </div>
        {DOWNLOADABLE_FONTS.map((f) => (
          <FontRow key={f.id} font={f} />
        ))}
      </section>
    </div>
  );
}

/* ───────── 設定〈一般〉與手機〈更多〉共用的四模式＋亮暗代表配對＋時刻設定 ───────── */

const THEME_MODES_DESKTOP: readonly SegmentedOption<ThemeMode>[] = [
  { value: "manual", label: "手動固定", title: "固定停在亮色或暗色，點頂欄日夜鈕秒切" },
  { value: "system", label: "跟隨系統", title: "依系統深淺色自動套用你的亮／暗代表主題" },
  { value: "schedule", label: "依時間切換", title: "依自訂白晝與入夜時刻自動平滑切換" },
  { value: "kamakura", label: "水鏡鎌倉", title: "24h 隨真實時光與晴雨流轉的湖上列車" },
];

const THEME_MODES_MOBILE: readonly { value: ThemeMode; label: string; note: string }[] = [
  { value: "manual", label: "手動固定", note: "白晝／入夜一鍵秒切" },
  { value: "system", label: "跟隨系統", note: "依手機深淺色自動套用" },
  { value: "schedule", label: "依時間切換", note: "早晚指定時刻自動換裝" },
  { value: "kamakura", label: "水鏡鎌倉", note: "24h 時光與晴雨流轉" },
];

function ThemeHmClock({
  label,
  hm,
  onChangeHm,
}: {
  label: string;
  hm: string;
  onChangeHm: (nextHm: string) => void;
}) {
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const [day] = useState(() => todayKey(dayStartHour));
  const { lo, hi } = useMemo(() => {
    const w = dayWindow(day, dayStartHour);
    return { lo: Date.parse(w.start), hi: Date.parse(w.end) - MIN };
  }, [day, dayStartHour]);
  const ms = clockInstant(day, clockForDay(hm, dayStartHour)) ?? lo;

  return (
    <span className="ns-theme-sched-item">
      <span className="ns-theme-sched-k">{label}</span>
      <ClockInput
        variant="compact"
        dateLabel={false}
        refDay={day}
        label={label}
        value={ms}
        lo={lo}
        hi={hi}
        onChange={(nextMs) => {
          const nextHm = fmtClock(nextMs);
          if (nextHm !== hm) onChangeHm(nextHm);
        }}
      />
    </span>
  );
}

export function ThemeSettingsControl({
  shell,
  onOpenShop,
}: {
  shell: "desktop" | "mobile";
  onOpenShop: () => void;
}) {
  const activeTheme = useUiStore((s) => s.theme);
  const cfg = useUiStore((s) => s.themeConfig);
  const resolvedDark = useUiStore((s) => s.resolvedDark);
  const setThemeMode = useUiStore((s) => s.setThemeMode);
  const setLightPref = useUiStore((s) => s.setLightThemePref);
  const setDarkPref = useUiStore((s) => s.setDarkThemePref);
  const setThemeSchedule = useUiStore((s) => s.setThemeSchedule);
  const togglePair = useUiStore((s) => s.toggleThemePair);

  const skin = skinById(activeTheme);
  const lightLabel = lightThemeName(cfg.lightPref);
  const darkLabel = darkThemeName(cfg.darkPref);

  return (
    <div className="ns-theme-cfg">
      {shell === "desktop" ? (
        <div className="ns-theme-cfg-top">
          <Segmented
            options={THEME_MODES_DESKTOP}
            value={cfg.mode}
            onChange={(m) => void setThemeMode(m)}
            aria-label="主題切換模式"
          />
          <button
            type="button"
            className={"btn-ghost ns-btn ns-shop-open" + (skin ? " is-on" : "")}
            onClick={onOpenShop}
          >
            {skin ? `商店・${skin.name}` : "商店"}
          </button>
          <button
            type="button"
            className="btn-ghost ns-btn ns-btn--sm"
            onClick={() => void togglePair()}
            title={`在「${lightLabel}」與「${darkLabel}」之間秒切`}
          >
            {resolvedDark ? `☀ 切至${lightLabel}` : `🌙 切至${darkLabel}`}
          </button>
        </div>
      ) : (
        <>
          <div role="radiogroup" aria-label="主題切換模式" className="m2-choices">
            {THEME_MODES_MOBILE.map((m) => {
              const checked = cfg.mode === m.value;
              return (
                <button
                  key={m.value}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  onClick={() => void setThemeMode(m.value)}
                  className={"m2-choice" + (checked ? " is-on" : "")}
                >
                  <span className="m2-choice-label">{m.label}</span>
                  <span className="m2-choice-note">{m.note}</span>
                </button>
              );
            })}
          </div>
          <div className="ns-theme-quickpair">
            <button
              type="button"
              className="btn-ghost ns-btn"
              onClick={() => void togglePair()}
            >
              {resolvedDark ? `☀ 切換至亮色：${lightLabel}` : `🌙 切換至暗色：${darkLabel}`}
            </button>
          </div>
        </>
      )}

      {cfg.mode === "schedule" && (
        <div className="ns-theme-sched-row" role="group" aria-label="依時間自動切換時刻">
          <ThemeHmClock
            label="☀ 白晝時刻"
            hm={cfg.dayStartHm}
            onChangeHm={(dayStartHm) => void setThemeSchedule({ dayStartHm })}
          />
          <ThemeHmClock
            label="🌙 入夜時刻"
            hm={cfg.nightStartHm}
            onChangeHm={(nightStartHm) => void setThemeSchedule({ nightStartHm })}
          />
        </div>
      )}

      <div className="ns-theme-pair-grid" role="group" aria-label="亮暗代表主題配對">
        <div className="ns-theme-pair-col">
          <span className="ns-theme-pair-k">☀ 我的亮色主題</span>
          <div className="ns-theme-pair-chips" role="radiogroup" aria-label="我的亮色主題">
            {LIGHT_THEME_OPTIONS.map((o) => {
              const checked = cfg.lightPref === o.id;
              return (
                <button
                  key={o.id}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  className={"chip ns-chip" + (checked ? " is-on" : "")}
                  title={o.note}
                  onClick={() => void setLightPref(o.id)}
                >
                  {o.name}
                </button>
              );
            })}
          </div>
        </div>

        <div className="ns-theme-pair-col">
          <span className="ns-theme-pair-k">🌙 我的暗色主題</span>
          <div className="ns-theme-pair-chips" role="radiogroup" aria-label="我的暗色主題">
            {DARK_THEME_OPTIONS.map((o) => {
              const checked = cfg.darkPref === o.id;
              return (
                <button
                  key={o.id}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  className={"chip ns-chip" + (checked ? " is-on" : "")}
                  title={o.note}
                  onClick={() => void setDarkPref(o.id)}
                >
                  {o.name}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {shell === "mobile" && (
        <button
          type="button"
          className={"m2-choice ns-shop-entry" + (skin ? " is-on" : "")}
          onClick={onOpenShop}
        >
          <span className="m2-choice-label">商店</span>
          <span className="m2-choice-note">{skin ? `使用中・${skin.name}` : "主題預覽・霞鶩文楷手寫字型"}</span>
        </button>
      )}
    </div>
  );
}
