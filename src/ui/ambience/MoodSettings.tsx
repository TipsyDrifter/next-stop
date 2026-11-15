/**
 * MoodSettings.tsx — 設定裡的「今日天象與動態氛圍」一區（⑪；v1.31 畫面 1 收攏）。桌機〈一般〉與手機「更多」共用同一支元件、同一份字。
 *
 * v1.31 畫面 1：原本是一排無標題的分段鈕＋一排無標題的「淡／中」＋四顆混在一起的 chip（晨昏和列車、候鳥、流星擠同一排），
 * 讀起來像散落的開關。收成一張有標題的區塊，上下分兩層：
 *   ① 主開關「天象節律」（模式單選 Segmented）——整區的總閘，下面一句話說明現在這個模式會發生什麼；
 *   ② 細項（主開關之下、虛線隔開、標籤左齊）：
 *        天色流轉＝晨昏／入夜染光（Toggle：它是天空本身的光，不是「經過的東西」，所以獨立一列）
 *        經過的景物＝列車／候鳥／流星（選項 chip 多選）
 *        濃淡＝淡／中（Segmented 緊湊）
 *   模式「關閉」時細項不藏（看得到有哪些東西），整層淡出、不可點，title 寫為什麼（§1.8）。
 * 這個主題用不到的那顆（銀河沒有候鳥、沒有星的商店亮色主題沒有流星）照舊灰掉＋title。
 * 樣式在 ambience/mood.css「設定裡的一區」（mood.css 由 index.css 全域載入，兩殼都吃得到）。
 */
import { Segmented, type SegmentedOption } from "../common/Segmented";
import { Toggle } from "../common/Toggle";
import { useUiStore } from "../../store/uiStore";
import type { MoodMode, MoodParts } from "./moodDirector";
import { useMoodStore, type MoodLevel } from "./moodStore";

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

/** 「經過的景物」三顆；晨昏不在這裡（它是天空的光，獨立一列 Toggle） */
const PASSERS: { key: Exclude<keyof MoodParts, "dusk">; label: string }[] = [
  { key: "train", label: "列車" },
  { key: "birds", label: "候鳥" },
  { key: "meteor", label: "流星" },
];

const OFF_WHY = "天象節律關閉時不出現";

export function MoodSettings({ shell = "desktop" }: { shell?: "desktop" | "mobile" }) {
  const mode = useMoodStore((s) => s.mode);
  const level = useMoodStore((s) => s.level);
  const parts = useMoodStore((s) => s.parts);
  const setMode = useMoodStore((s) => s.setMode);
  const setLevel = useMoodStore((s) => s.setLevel);
  const setPart = useMoodStore((s) => s.setPart);
  useUiStore((s) => s.theme); // 換主題時重畫，灰掉的那顆才跟得上

  const root = document.documentElement;
  const dark = root.getAttribute("data-theme") === "dark";
  const skin = root.hasAttribute("data-skin");
  const unavailable = (k: keyof MoodParts): string | null => {
    if (k === "birds" && dark) return "候鳥只在亮色主題出現";
    if (k === "meteor" && !dark && skin) return "這個主題的天空沒有星";
    return null;
  };
  const off = mode === "off";

  return (
    <section className={"ns-sky-set is-" + shell} aria-label="今日天象與動態氛圍">
      <header className="ns-sky-set-h">
        <h3 className="ns-sky-set-t">今日天象與動態氛圍</h3>
        <span className="ns-sky-set-latin" aria-hidden="true">
          Sky &amp; Ambience
        </span>
      </header>

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
            <span className="ns-sky-desc">晨昏與入夜時，天空染上霞光與夜色</span>
            <Toggle
              on={parts.dusk && !off}
              onFlip={() => setPart("dusk", !parts.dusk)}
              label="天色流轉：晨昏／入夜染光"
              disabled={off}
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
