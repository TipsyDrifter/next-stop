/**
 * MoodSettings.tsx — 設定裡的「今日天象與動態氛圍」一區（⑪；v1.31 畫面 1 收攏；v1.34 4B 水鏡鎌倉時光與晴雨控制）。
 * 桌機〈一般〉與手機「更多」共用同一支元件、同一份字。
 *
 * 當目前主題為「水鏡鎌倉（data-skin="kamakura"）」時，展開專屬控制列：
 *   - 時光模式：跟隨真實時間（24h 流轉）｜ 手動駐足喜愛時段（朝霧 · 白晝 · 暮色 · 星夜）
 *   - 天氣模式：自然天象（隨時間緩慢晴雨交替）｜ 晴朗 ｜ 微雨山嵐
 * 本機持久化於 moodStore（螢幕偏好不同步）。
 */
import { useEffect, useState } from "react";
import { Segmented, type SegmentedOption } from "../common/Segmented";
import { Toggle } from "../common/Toggle";
import { useUiStore } from "../../store/uiStore";
import type { MoodMode, MoodParts } from "./moodDirector";
import { useMoodStore, type MoodLevel } from "./moodStore";
import {
  KAMAKURA_PHASE_LABELS,
  kamakuraPhaseAt,
  parseKamakuraRole,
  type KamakuraRole,
  type KamakuraTimeMode,
  type KamakuraWeatherMode,
} from "./kamakuraPalette";

const MODES: SegmentedOption<MoodMode>[] = [
  { value: "both", label: "循環＋儀式", title: "平時有列車與飛鳥偶爾經過，蓋下済章與全部完成時也有慶祝儀式" },
  { value: "ambient", label: "環境循環", title: "列車、候鳥、流星偶爾經過，天色隨時間流轉" },
  { value: "ritual", label: "完成儀式", title: "平時安靜，蓋一枚済開出一班列車，全部完成時放雁行或流星雨" },
  { value: "off", label: "關閉", title: "天空完全不動，星星也定住" },
];

/** 主開關下面那句話：選了什麼就直接說會看到什麼（觸控沒有 hover，title 裡的字等於不存在） */
const MODE_NOTE: Record<MoodMode, string> = {
  both: "平時有景物偶爾經過；蓋下済章、全部完成時，天空也會跟著慶祝。",
  ambient: "列車、候鳥、流星偶爾經過，天色隨時間流轉。",
  ritual: "平時安靜；蓋一枚済開出一班列車，全部完成時放雁行或流星雨。",
  off: "天空完全不動，星星也定住——下面的細項先收著。",
};

const LEVELS: SegmentedOption<MoodLevel>[] = [
  { value: "lite", label: "淡" },
  { value: "mid", label: "中" },
];

const KAMAKURA_TIMES: SegmentedOption<KamakuraTimeMode>[] = [
  { value: "auto", label: "24h 流轉", title: "跟隨真實 24 小時天色與水鏡倒影連續流轉" },
  { value: "dawn", label: "朝霧", title: "駐足 05:00–07:00 淡霧青紫與柔金朝霞" },
  { value: "day", label: "白晝", title: "駐足 07:00–16:00 通透鎌倉海空與碧水" },
  { value: "dusk", label: "暮色", title: "駐足 16:00–18:45 青檸琥珀至珊瑚晚霞" },
  { value: "night", label: "星夜", title: "駐足 18:45–05:00 深邃群青星月與對岸燈火" },
];

const KAMAKURA_TIME_NOTE: Record<Exclude<KamakuraTimeMode, "auto">, string> = {
  dawn: "已駐足「朝霧黎明」——淡霧薰衣草藍透出柔金朝霞，對岸山腰浮著薄霧，石板泛著晨光。",
  day: "已駐足「晴空碧水」——通透鎌倉夏空與柔軟海雲，碧藍水鏡倒映遠山與微縮列車。",
  dusk: "已駐足「黃昏暮色」——天頂鈷藍漸染薰衣草與玫瑰晚霞，對岸山腳亮起星點燈火與微縮列車。",
  night: "已駐足「星月夜行」——深邃群青夜空升起弦月與銀白水路，對岸山腳微縮列車與燈火靜靜流轉。",
};

const KAMAKURA_WEATHERS: SegmentedOption<KamakuraWeatherMode>[] = [
  { value: "auto", label: "自然天象", title: "隨時間緩慢在晴朗水鏡與微雨山嵐之間自然交替" },
  { value: "clear", label: "晴朗", title: "通透遠山、清澈水鏡倒影與微光漣漪" },
  { value: "rain", label: "微雨山嵐", title: "煙雨青灰調、遠山流動雲霧帶、柔和斜雨絲與湖面雨滴漣漪" },
];

const KAMAKURA_WEATHER_NOTE: Record<KamakuraWeatherMode, string> = {
  auto: "隨時間緩慢晴雨交替——多數時刻通透晴朗，偶爾起霧飄落柔和微雨。",
  clear: "晴朗水鏡——遠方海灣山巒清晰通透，湖面如鏡映照列車與霞光。",
  rain: "微雨山嵐——空氣轉為煙雨青灰調，山腰流動薄霧，湖面浮現輕柔雨滴漣漪。",
};

/** 「經過的景物」三顆；晨昏不在這裡（它是天空的光，獨立一列 Toggle） */
const PASSERS: { key: Exclude<keyof MoodParts, "dusk">; label: string }[] = [
  { key: "train", label: "列車" },
  { key: "birds", label: "候鳥" },
  { key: "meteor", label: "流星" },
];

const OFF_WHY = "天象節律關閉時不出現";

function readDomSkinState(): { dark: boolean; skin: boolean; kamakura: boolean; role: KamakuraRole } {
  if (typeof document === "undefined") return { dark: false, skin: false, kamakura: false, role: "full" };
  const root = document.documentElement;
  const skinAttr = root.getAttribute("data-skin");
  return {
    dark: root.getAttribute("data-theme") === "dark",
    skin: skinAttr !== null,
    kamakura: skinAttr === "kamakura",
    role: parseKamakuraRole(root.getAttribute("data-kamakura-role")),
  };
}

export function MoodSettings({ shell = "desktop" }: { shell?: "desktop" | "mobile" }) {
  const mode = useMoodStore((s) => s.mode);
  const level = useMoodStore((s) => s.level);
  const parts = useMoodStore((s) => s.parts);
  const kamakuraTime = useMoodStore((s) => s.kamakuraTime);
  const kamakuraWeather = useMoodStore((s) => s.kamakuraWeather);
  const setMode = useMoodStore((s) => s.setMode);
  const setLevel = useMoodStore((s) => s.setLevel);
  const setPart = useMoodStore((s) => s.setPart);
  const setKamakuraTime = useMoodStore((s) => s.setKamakuraTime);
  const setKamakuraWeather = useMoodStore((s) => s.setKamakuraWeather);
  useUiStore((s) => s.theme);

  const [domState, setDomState] = useState(readDomSkinState);
  useEffect(() => {
    const root = document.documentElement;
    const sync = () => setDomState(readDomSkinState());
    const ob = new MutationObserver(sync);
    ob.observe(root, { attributes: true, attributeFilter: ["data-theme", "data-skin", "data-kamakura-role"] });
    sync();
    return () => ob.disconnect();
  }, []);

  const { dark, skin, kamakura, role } = domState;
  const unavailable = (k: keyof MoodParts): string | null => {
    if (kamakura) {
      if (k === "meteor" && !dark) return "星夜時段才會出現流星";
      return null;
    }
    if (k === "birds" && dark) return "候鳥只在亮色主題出現";
    if (k === "meteor" && !dark && skin) return "這個主題的天空沒有星";
    return null;
  };
  const off = mode === "off";

  const now = new Date();
  const livePhaseLabel = KAMAKURA_PHASE_LABELS[kamakuraPhaseAt(now.getHours() * 60 + now.getMinutes())];
  const kamakuraTimeDesc =
    role === "dark"
      ? "目前為暗色代表「水鏡鎌倉·夜」，固定呈現星月夜行；切換至「水鏡鎌倉」全天候模式即可流轉白晝與晨昏。"
      : role === "light" && kamakuraTime === "night"
        ? "目前為亮色代表「水鏡鎌倉·晝」，維持晴空碧水；切換至「水鏡鎌倉」全天候模式即套用星夜駐足。"
        : kamakuraTime === "auto"
          ? `跟隨真實時間（目前：${livePhaseLabel}）——24 小時天色、水鏡倒影與萬家燈火連續流轉。`
          : KAMAKURA_TIME_NOTE[kamakuraTime];

  return (
    <section className={"ns-sky-set is-" + shell} aria-label="今日天象與動態氛圍">
      <header className="ns-sky-set-h">
        <h3 className="ns-sky-set-t">今日天象與動態氛圍</h3>
        <span className="ns-sky-set-latin" aria-hidden="true">
          Sky &amp; Ambience
        </span>
        {kamakura && <span className="ns-sky-km-badge">水鏡鎌倉</span>}
      </header>

      {/* 水鏡鎌倉專屬：24h 時光駐足與晴雨山嵐控制列 */}
      {kamakura && (
        <div className="ns-sky-kamakura">
          <div className="ns-sky-row">
            <span className="ns-sky-k">時光模式</span>
            <div className="ns-sky-v">
              <Segmented
                options={KAMAKURA_TIMES}
                value={kamakuraTime}
                onChange={setKamakuraTime}
                aria-label="水鏡鎌倉時光模式"
                compact
              />
              <p className="ns-sky-note">{kamakuraTimeDesc}</p>
            </div>
          </div>

          <div className="ns-sky-row">
            <span className="ns-sky-k">天氣模式</span>
            <div className="ns-sky-v">
              <Segmented
                options={KAMAKURA_WEATHERS}
                value={kamakuraWeather}
                onChange={setKamakuraWeather}
                aria-label="水鏡鎌倉天氣模式"
                compact
              />
              <p className="ns-sky-note">{KAMAKURA_WEATHER_NOTE[kamakuraWeather]}</p>
            </div>
          </div>
        </div>
      )}

      {/* ① 主開關：天象節律 */}
      <div className="ns-sky-master">
        <span className="ns-sky-k">天象節律</span>
        <div className="ns-sky-v">
          <Segmented options={MODES} value={mode} onChange={setMode} aria-label="天象節律" />
          <p className="ns-sky-note">{MODE_NOTE[mode]}</p>
        </div>
      </div>

      {/* ② 細項：天色在上（天空本身的光），景物在中，濃淡在下 */}
      <div className={"ns-sky-detail" + (off ? " is-off" : "")} title={off ? OFF_WHY : undefined}>
        <div className="ns-sky-row">
          <span className="ns-sky-k">天色流轉</span>
          <div className="ns-sky-v ns-sky-v-inline">
            <span className="ns-sky-desc">
              {kamakura
                ? "水鏡鎌倉已由上方「時光模式」連續驅動 24 小時天色與水鏡光影"
                : "晨昏與入夜時，天空染上霞光與夜色"}
            </span>
            <Toggle
              on={parts.dusk && !off}
              onFlip={() => setPart("dusk", !parts.dusk)}
              label="天色流轉：晨昏／入夜染光"
              disabled={off || kamakura}
            />
          </div>
        </div>

        <div className="ns-sky-row">
          <span className="ns-sky-k">經過的景物</span>
          <div className="ns-sky-v">
            <div className="ns-sky-parts" role="group" aria-label="經過的景物">
              {PASSERS.map((p) => {
                const why = off ? OFF_WHY : unavailable(p.key);
                const on = parts[p.key] && why === null;
                return (
                  <button
                    key={p.key}
                    type="button"
                    className={"chip ns-chip" + (on ? " is-on" : "")}
                    aria-pressed={on}
                    disabled={why !== null}
                    title={why ?? undefined}
                    onClick={() => setPart(p.key, !parts[p.key])}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="ns-sky-row">
          <span className="ns-sky-k">濃淡</span>
          <div className="ns-sky-v ns-sky-v-inline">
            <span className="ns-sky-desc">景物出現的頻率與天色的濃度</span>
            <Segmented
              options={off ? LEVELS.map((o) => ({ ...o, disabled: true, title: OFF_WHY })) : LEVELS}
              value={level}
              onChange={setLevel}
              aria-label="濃淡"
              compact
            />
          </div>
        </div>
      </div>
    </section>
  );
}
